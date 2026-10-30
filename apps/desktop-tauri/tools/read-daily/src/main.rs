//! Headless contract runner, used only by golden validation. Not a sidecar and
//! not included in the Tauri bundle's externalBin/resources.
#[path = "../../../src-tauri/src/native_daily.rs"]
mod native_daily;
use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let request: serde_json::Value = serde_json::from_str(&input).unwrap();
    let snapshot = &request["snapshot"];
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--benchmark") {
        let samples: usize = args[3].parse().unwrap();
        let mut timings = Vec::new();
        for index in 0..samples + 20 {
            let start = std::time::Instant::now();
            let raw = std::fs::read_to_string(&args[2]).unwrap();
            std::hint::black_box(
                native_daily::read(
                    &raw,
                    request["path"].as_str().unwrap(),
                    snapshot["session"].as_str().unwrap(),
                    snapshot["createdAt"].as_i64().unwrap(),
                )
                .unwrap()
                .to_string(),
            );
            if index >= 20 {
                timings.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"samples":samples,"medianMs":timings[samples/2],"p95Ms":timings[samples*95/100]})
        );
        return;
    }
    let result = native_daily::read(
        &snapshot.to_string(),
        request["path"].as_str().unwrap(),
        snapshot["session"].as_str().unwrap(),
        snapshot["createdAt"].as_i64().unwrap(),
    )
    .unwrap();
    println!("{}", serde_json::json!({"status":200,"body":result}));
}
