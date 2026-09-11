//! Single-instance guard (port of Electron's `acquireDesktopInstanceLock`).
//!
//! Electron holds a single-instance lock; a second launch is told to quit and
//! instead signals the first instance to bring its window forward. Tauri has
//! no `requestSingleInstanceLock` in the offline crate set, so we approximate
//! the *guard* half with a `flock`-backed file lock under the app config dir:
//! the first instance holds it for the process lifetime, and a second
//! instance detects the held lock and exits immediately. The "signal the first
//! instance to focus" half is a release-time nicety (it needs a named pipe /
//! native hook) and is left as a documented gap; the data-core owner
//! collision the lock prevents is the substantive risk.
//!
//! Port of `acquireDesktopInstanceLock` in `apps/desktop/src/main/index.ts`.
//! (Stale-heartbeat eviction happens in the sidecar, not here.)
//!
//! Unix uses `flock` (in-transitive-dep `libc`, zero-download). Windows has
//! no `flock`; the full guard there uses a named mutex and is a release-time
//! concern, so this is a no-op on non-unix.

/// Acquire the single-instance lock.
///
/// On success the lock file is kept open (leaked) for the process lifetime and
/// `Ok(())` is returned. On failure — another instance already holds the lock
/// — `Err(message)` is returned and the caller should `process::exit`.
///
/// A transient "cannot open the lock file" error is *not* fatal: we log it and
/// proceed without a lock, matching Electron's fail-open posture (a broken
/// config dir must not block launch).
pub fn acquire(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;

        const LOCK_NAME: &str = "single-instance.lock";

        let Ok(path) = app
            .path()
            .resolve(LOCK_NAME, tauri::path::BaseDirectory::AppConfig)
        else {
            eprintln!("[tud-desktop] single-instance: cannot resolve lock path");
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        let Ok(file) = std::fs::OpenOptions::new().create(true).truncate(false).open(&path)
        else {
            eprintln!("[tud-desktop] single-instance: cannot open {path:?}");
            return Ok(());
        };

        let taken =
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;

        if !taken {
            return Err("另一个 Juejin Usage 实例正在运行，本次启动退出。".to_string());
        }

        // Hold the lock for the whole process life; the kernel releases it on
        // exit or crash. Leaking the `File` is intentional.
        std::mem::forget(file);
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = app;
        eprintln!("[tud-desktop] single-instance guard is a no-op on this platform");
        Ok(())
    }
}
