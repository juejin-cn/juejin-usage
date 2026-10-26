//! Process lifecycle without a WebView dependency; the same monitor is exercised
//! by real subprocess tests. No API request is replayed when a child restarts.
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: String,
    pub attempt: u32,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigNotice {
    pub id: u64,
    pub token_salvaged: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Status(Snapshot),
    Synced,
    Linked,
    ConfigReset(bool),
}
#[derive(Debug, PartialEq)]
pub enum Marker {
    Port(u16),
    Synced,
    Linked,
    ConfigReset(bool),
    Blocked,
}
pub fn parse_marker(line: &str) -> Option<Marker> {
    match line {
        "SYNCED" => Some(Marker::Synced),
        "JUEJIN_LINKED" => Some(Marker::Linked),
        "RUNTIME_BLOCKED" => Some(Marker::Blocked),
        "RUNTIME_NOTICE=CONFIG_RESET:true" => Some(Marker::ConfigReset(true)),
        "RUNTIME_NOTICE=CONFIG_RESET:false" => Some(Marker::ConfigReset(false)),
        _ => line
            .strip_prefix("PORT=")
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|p| *p > 0)
            .map(Marker::Port),
    }
}
#[derive(Default)]
pub struct RestartBudget {
    failures: u32,
}
impl RestartBudget {
    pub fn next_delay(&mut self, uptime: Duration) -> Option<Duration> {
        if uptime >= Duration::from_secs(60) {
            self.failures = 0;
        }
        if self.failures >= 5 {
            return None;
        }
        let delay = Duration::from_secs(1 << self.failures);
        self.failures += 1;
        Some(delay)
    }
    pub fn attempt(&self) -> u32 {
        self.failures
    }
}
pub struct ProcessSpec {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub host_key: String,
}
pub type Emit = Arc<dyn Fn(Event) + Send + Sync>;
pub struct Supervisor {
    child: Mutex<Option<Child>>,
    pub endpoint: Mutex<Option<u16>>,
    pub status: Mutex<Snapshot>,
    pub notice: Mutex<Option<ConfigNotice>>,
    stopping: AtomicBool,
    blocked: AtomicBool,
    generation: AtomicU64,
}
impl Default for Supervisor {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            endpoint: Mutex::new(None),
            status: Mutex::new(Snapshot {
                phase: "starting".into(),
                attempt: 0,
                reason: None,
            }),
            notice: Mutex::new(None),
            stopping: AtomicBool::new(false),
            blocked: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }
}
impl Supervisor {
    fn publish(&self, phase: &str, attempt: u32, reason: Option<&str>, emit: &Emit) {
        let snapshot = Snapshot {
            phase: phase.into(),
            attempt,
            reason: reason.map(String::from),
        };
        let mut status = self.status.lock().unwrap();
        if phase != "stopped" && self.stopping.load(Ordering::SeqCst) {
            return;
        }
        *status = snapshot.clone();
        emit(Event::Status(snapshot));
    }
    fn publish_ready(&self, generation: u64, attempt: u32, emit: &Emit) {
        let mut status = self.status.lock().unwrap();
        if self.stopping.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != generation
        {
            return;
        }
        let snapshot = Snapshot {
            phase: "ready".into(),
            attempt,
            reason: None,
        };
        *status = snapshot.clone();
        emit(Event::Status(snapshot));
    }
    pub fn notice(&self) -> Option<ConfigNotice> {
        self.notice.lock().unwrap().clone()
    }
    pub fn acknowledge_notice(&self, id: u64) {
        let mut notice = self.notice.lock().unwrap();
        if notice.as_ref().is_some_and(|n| n.id == id) {
            notice.take();
        }
    }
    pub fn prepare(&self) {
        *self.status.lock().unwrap() = Snapshot {
            phase: "starting".into(),
            attempt: 0,
            reason: None,
        };
        self.stopping.store(false, Ordering::SeqCst);
        self.blocked.store(false, Ordering::SeqCst);
        *self.endpoint.lock().unwrap() = None;
    }
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.endpoint.lock().unwrap() = None;
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                _ if Instant::now() >= deadline => break,
                _ => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    fn pause(&self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        while Instant::now() < deadline {
            if self.stopping.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !self.stopping.load(Ordering::SeqCst)
    }
    pub fn run(self: Arc<Self>, spec: ProcessSpec, emit: Emit) {
        let mut budget = RestartBudget::default();
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            *self.endpoint.lock().unwrap() = None;
            let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            self.publish(
                if budget.attempt() == 0 {
                    "starting"
                } else {
                    "recovering"
                },
                budget.attempt(),
                None,
                &emit,
            );
            let started = Instant::now();
            let ready_since = Arc::new(Mutex::new(None::<Instant>));
            let mut command = Command::new(&spec.binary);
            command
                .args(&spec.args)
                .env("TUD_HOST_KEY", &spec.host_key)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            // Serialize spawn with stop: once stopping is set, a newly spawned
            // child is either handed to stop() or reaped here before return.
            let mut slot = self.child.lock().unwrap();
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            let launched = command.spawn();
            if let Ok(mut child) = launched {
                let stdout = child.stdout.take().expect("piped stdout");
                *slot = Some(child);
                drop(slot);
                let drained = Arc::new(AtomicBool::new(false));
                let reader_done = Arc::clone(&drained);
                let ready_clock = Arc::clone(&ready_since);
                let state = Arc::clone(&self);
                let on_event = Arc::clone(&emit);
                let attempt = budget.attempt();
                std::thread::spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        if state.stopping.load(Ordering::SeqCst)
                            || state.generation.load(Ordering::SeqCst) != generation
                        {
                            break;
                        }
                        match parse_marker(&line) {
                            Some(Marker::Port(port)) => {
                                let mut endpoint = state.endpoint.lock().unwrap();
                                if state.stopping.load(Ordering::SeqCst)
                                    || state.generation.load(Ordering::SeqCst) != generation
                                {
                                    break;
                                }
                                *endpoint = Some(port);
                                drop(endpoint);
                                ready_clock.lock().unwrap().get_or_insert_with(Instant::now);
                                state.publish_ready(generation, attempt, &on_event);
                            }
                            Some(Marker::Synced) => on_event(Event::Synced),
                            Some(Marker::Linked) => on_event(Event::Linked),
                            Some(Marker::ConfigReset(salvaged)) => {
                                *state.notice.lock().unwrap() = Some(ConfigNotice {
                                    id: generation,
                                    token_salvaged: salvaged,
                                });
                                on_event(Event::ConfigReset(salvaged));
                            }
                            Some(Marker::Blocked) => state.blocked.store(true, Ordering::SeqCst),
                            None => {} // Never reflect arbitrary process output into the UI.
                        }
                    }
                    reader_done.store(true, Ordering::SeqCst);
                });
                let mut next_probe = Instant::now() + Duration::from_secs(15);
                let mut missed_probes = 0;
                loop {
                    if self.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    if Instant::now() >= next_probe {
                        // A sleeping computer should not consume the failure budget.
                        if Instant::now().duration_since(next_probe) > Duration::from_secs(30) {
                            missed_probes = 0;
                        }
                        let port = *self.endpoint.lock().unwrap();
                        if let Some(port) = port {
                            if probe_health(port) {
                                missed_probes = 0;
                            } else {
                                missed_probes += 1;
                            }
                        }
                        next_probe = Instant::now() + Duration::from_secs(15);
                    }
                    let mut child = self.child.lock().unwrap();
                    let ended = match child.as_mut().map(Child::try_wait) {
                        Some(Ok(None)) => false,
                        _ => true,
                    };
                    let timed_out = started.elapsed() > Duration::from_secs(60)
                        && self.endpoint.lock().unwrap().is_none();
                    if ended || timed_out || missed_probes >= 3 {
                        if let Some(mut old) = child.take() {
                            let _ = old.kill();
                            let _ = old.wait();
                        }
                        drop(child);
                        let flush = Instant::now() + Duration::from_millis(250);
                        while !drained.load(Ordering::SeqCst) && Instant::now() < flush {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        break;
                    }
                    drop(child);
                    std::thread::sleep(Duration::from_millis(100));
                }
            } else {
                drop(slot);
            }
            self.generation.fetch_add(1, Ordering::SeqCst);
            *self.endpoint.lock().unwrap() = None;
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }
            if self.blocked.load(Ordering::SeqCst) {
                self.publish("failed", budget.attempt(), Some("ownership"), &emit);
                return;
            }
            let healthy_uptime = ready_since
                .lock()
                .unwrap()
                .map(|ready| ready.elapsed())
                .unwrap_or(Duration::ZERO);
            let Some(delay) = budget.next_delay(healthy_uptime) else {
                self.publish("failed", budget.attempt(), Some("crash"), &emit);
                return;
            };
            self.publish("recovering", budget.attempt(), None, &emit);
            if !self.pause(delay) {
                break;
            }
        }
        self.publish("stopped", budget.attempt(), None, &emit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_budget_is_bounded_and_resets_after_stable_uptime() {
        let mut b = RestartBudget::default();
        for n in [1, 2, 4, 8, 16] {
            assert_eq!(b.next_delay(Duration::ZERO), Some(Duration::from_secs(n)));
        }
        assert_eq!(b.next_delay(Duration::ZERO), None);
        assert_eq!(
            b.next_delay(Duration::from_secs(60)),
            Some(Duration::from_secs(1))
        );
    }
    #[test]
    fn stale_generation_cannot_overwrite_recovery_or_stop() {
        let state = Supervisor::default();
        let emit: Emit = Arc::new(|_| {});
        state.generation.store(2, Ordering::SeqCst);
        state.publish_ready(1, 0, &emit);
        assert_ne!(state.status.lock().unwrap().phase, "ready");
        state.stop();
        state.publish_ready(2, 0, &emit);
        assert_ne!(state.status.lock().unwrap().phase, "ready");
    }
    #[test]
    fn stale_acknowledgement_cannot_clear_a_new_config_notice() {
        let state = Supervisor::default();
        *state.notice.lock().unwrap() = Some(ConfigNotice {
            id: 2,
            token_salvaged: false,
        });
        state.acknowledge_notice(1);
        assert!(state.notice().is_some());
        state.acknowledge_notice(2);
        assert!(state.notice().is_none());
    }
    #[test]
    fn protocol_rejects_bad_ports_and_arbitrary_notices() {
        assert_eq!(parse_marker("PORT=1234"), Some(Marker::Port(1234)));
        assert_eq!(parse_marker("PORT=0"), None);
        assert_eq!(parse_marker("PORT=65536"), None);
        assert_eq!(
            parse_marker("RUNTIME_NOTICE=CONFIG_RESET:false"),
            Some(Marker::ConfigReset(false))
        );
        assert_eq!(parse_marker("RUNTIME_NOTICE=SECRET"), None);
    }
    #[cfg(unix)]
    #[test]
    fn real_child_crash_retries_and_stop_cancels_backoff() {
        let state = Arc::new(Supervisor::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let out = Arc::clone(&events);
        let emit: Emit = Arc::new(move |e| out.lock().unwrap().push(e));
        let monitor = Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            monitor.run(
                ProcessSpec {
                    binary: "/bin/sh".into(),
                    args: vec!["-c".into(), "echo PORT=1234; sleep 0.1; exit 1".into()],
                    host_key: "test".into(),
                },
                emit,
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e,Event::Status(s) if s.phase=="ready" && s.attempt==1))
        {
            assert!(Instant::now() < deadline, "child was not restarted");
            std::thread::sleep(Duration::from_millis(20));
        }
        state.stop();
        thread.join().unwrap();
        assert!(state.endpoint.lock().unwrap().is_none());
        assert!(state.child.lock().unwrap().is_none());
    }
    #[cfg(unix)]
    #[test]
    fn ownership_marker_prevents_respawn() {
        let state = Arc::new(Supervisor::default());
        let emit: Emit = Arc::new(|_| {});
        Arc::clone(&state).run(
            ProcessSpec {
                binary: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    "echo RUNTIME_BLOCKED; sleep 0.1; exit 1".into(),
                ],
                host_key: "test".into(),
            },
            emit,
        );
        let status = state.status.lock().unwrap();
        assert_eq!(status.phase, "failed");
        assert_eq!(status.reason.as_deref(), Some("ownership"));
        assert_eq!(status.attempt, 0);
    }
}

fn probe_health(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    let mut status = String::new();
    if BufReader::new(stream.take(4096))
        .read_line(&mut status)
        .is_err()
    {
        return false;
    }
    status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ")
}
#[cfg(test)]
mod health_tests {
    use super::*;
    #[test]
    fn probes_http_health_rather_than_accepting_any_open_port() {
        for (response, expected) in [
            ("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", true),
            (
                "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n",
                false,
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut input = [0; 1024];
                let _ = stream.read(&mut input);
                stream.write_all(response.as_bytes()).unwrap();
            });
            assert_eq!(probe_health(port), expected);
            worker.join().unwrap();
        }
    }
}
