//! Daily read pilot. Node publishes an atomic, versioned snapshot with Core's
//! pricing/legacy normalization and sealed history. Live-day aggregation and
//! window filtering execute here without a Node HTTP request.
use chrono::{DateTime, Duration, FixedOffset, NaiveDate};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    uncached_input_tokens: f64,
    cache_read_tokens: Option<f64>,
    cache_write_tokens: Option<f64>,
    output_tokens: f64,
    reasoning_output_tokens: f64,
    request_count: Option<f64>,
    known_request_count: f64,
    missing_reasons: Vec<String>,
}
impl Metrics {
    fn empty() -> Self {
        Self {
            cache_read_tokens: Some(0.0),
            cache_write_tokens: Some(0.0),
            request_count: Some(0.0),
            ..Self::default()
        }
    }
    fn merge(&mut self, other: &Self) {
        self.uncached_input_tokens += other.uncached_input_tokens;
        self.output_tokens += other.output_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
        self.known_request_count += other.known_request_count;
        self.cache_read_tokens = self
            .cache_read_tokens
            .zip(other.cache_read_tokens)
            .map(|(a, b)| a + b);
        self.cache_write_tokens = self
            .cache_write_tokens
            .zip(other.cache_write_tokens)
            .map(|(a, b)| a + b);
        self.request_count = self
            .request_count
            .zip(other.request_count)
            .map(|(a, b)| a + b);
        self.missing_reasons.extend(other.missing_reasons.clone());
    }
    fn value(&self) -> Value {
        let rate = self
            .cache_read_tokens
            .zip(self.cache_write_tokens)
            .and_then(|(read, write)| {
                let total = self.uncached_input_tokens + read + write;
                (total > 0.0).then_some(read / total)
            });
        json!({"version":1,"uncachedInputTokens":self.uncached_input_tokens,
            "cacheReadTokens":self.cache_read_tokens,"cacheWriteTokens":self.cache_write_tokens,
            "outputTokens":self.output_tokens,"reasoningOutputTokens":self.reasoning_output_tokens,
            "requestCount":self.request_count,"knownRequestCount":self.known_request_count,
            "cacheHitRate":rate,"missingReasons":self.missing_reasons.iter().collect::<BTreeSet<_>>()})
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    source: String,
    model: String,
    project: String,
    tokens: f64,
    cost_usd: f64,
    input_tokens: f64,
    output_tokens: f64,
    cached_input_tokens: f64,
    cache_creation_input_tokens: f64,
    local_metrics: Metrics,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    schema_version: u32,
    session: String,
    created_at: i64,
    today: String,
    stats_since_date: String,
    closed_days: Vec<Value>,
    rows: Vec<Row>,
}

#[derive(Default)]
struct Amount {
    tokens: f64,
    cost: f64,
}
fn rounded(cost: f64) -> f64 {
    // JS Math.round rounds negative halves toward +Infinity too.
    let scaled = cost * 1e8;
    let floor = scaled.floor();
    let result = (if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }) / 1e8;
    if result == 0.0 {
        0.0
    } else {
        result
    }
}
fn js_number(raw: &str) -> f64 {
    let raw = raw.trim();
    if raw.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if raw.to_ascii_lowercase().starts_with(prefix) {
            if raw.len() == 2 {
                return f64::NAN;
            }
            return raw[2..]
                .chars()
                .try_fold(0.0, |sum, digit| {
                    digit
                        .to_digit(radix)
                        .map(|value| sum * radix as f64 + value as f64)
                })
                .unwrap_or(f64::NAN);
        }
    }
    match raw {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if raw
            .bytes()
            .all(|c| c.is_ascii_digit() || b"+-.eE".contains(&c)) =>
        {
            raw.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}
fn window_days(path: &str) -> i64 {
    let url =
        url::Url::parse(&format!("http://tauri.localhost{path}")).expect("validated API path");
    let number = url
        .query_pairs()
        .find(|(key, _)| key == "days")
        .map(|(_, v)| js_number(&v))
        .unwrap_or(90.0);
    let number = if number.is_nan() || number == 0.0 {
        90.0
    } else {
        number
    };
    // Date.UTC truncates the fractional day in Core's addLocalDays.
    number.clamp(1.0, 365.0).ceil() as i64
}
pub fn today_at(now: i64) -> Result<String, String> {
    DateTime::from_timestamp_millis(now)
        .map(|date| {
            date.with_timezone(&FixedOffset::east_opt(8 * 3600).unwrap())
                .format("%Y-%m-%d")
                .to_string()
        })
        .ok_or_else(|| "Invalid snapshot clock".into())
}
pub fn read(snapshot: &str, path: &str, session: &str, now: i64) -> Result<Value, String> {
    let snapshot: Snapshot = serde_json::from_str(snapshot).map_err(|_| "Invalid read snapshot")?;
    let today = today_at(now)?;
    if snapshot.schema_version != 1
        || snapshot.session != session
        || snapshot.today != today
        || snapshot.created_at > now + 5_000
        || snapshot.created_at < now - 90_000
    {
        return Err("Read snapshot is stale or belongs to another runtime".into());
    }
    let date =
        NaiveDate::parse_from_str(&today, "%Y-%m-%d").map_err(|_| "Invalid snapshot date")?;
    let from = (date - Duration::days(window_days(path) - 1))
        .format("%Y-%m-%d")
        .to_string();
    let mut days: Vec<Value> = snapshot
        .closed_days
        .into_iter()
        .filter(|day| {
            let date = day["date"].as_str().unwrap_or_default();
            date >= from.as_str()
                && date >= snapshot.stats_since_date.as_str()
                && date < today.as_str()
        })
        .collect();
    if today >= from && today >= snapshot.stats_since_date && !snapshot.rows.is_empty() {
        let mut total = Amount::default();
        let (mut input, mut output, mut cached, mut creation) = (0.0, 0.0, 0.0, 0.0);
        let mut metrics = Metrics::empty();
        let mut sources: Vec<(String, Amount, Metrics)> = vec![];
        let mut models: BTreeMap<String, f64> = BTreeMap::new();
        let mut projects: Vec<(String, f64, BTreeMap<String, f64>)> = vec![];
        for row in snapshot.rows {
            total.tokens += row.tokens;
            total.cost += row.cost_usd;
            input += row.input_tokens;
            output += row.output_tokens;
            cached += row.cached_input_tokens;
            creation += row.cache_creation_input_tokens;
            metrics.merge(&row.local_metrics);
            let source = match sources.iter().position(|(name, _, _)| name == &row.source) {
                Some(index) => index,
                None => {
                    sources.push((row.source.clone(), Amount::default(), Metrics::empty()));
                    sources.len() - 1
                }
            };
            sources[source].1.tokens += row.tokens;
            sources[source].1.cost += row.cost_usd;
            sources[source].2.merge(&row.local_metrics);
            let model = format!("{}\u{1f}{}", row.source, row.model);
            *models.entry(model.clone()).or_default() += row.tokens;
            let project = match projects
                .iter()
                .position(|(name, _, _)| name == &row.project)
            {
                Some(index) => index,
                None => {
                    projects.push((row.project, 0.0, BTreeMap::new()));
                    projects.len() - 1
                }
            };
            projects[project].1 += row.tokens;
            *projects[project].2.entry(model).or_default() += row.tokens;
        }
        // Stable sorting retains first-seen order when amounts tie, as JS does.
        projects.sort_by(|a, b| b.1.total_cmp(&a.1));
        let sources:Vec<_>=sources.into_iter().map(|(source,value,metrics)| json!({"source":source,"tokens":value.tokens,"costUsd":rounded(value.cost),"localMetrics":metrics.value()})).collect();
        let projects:Vec<_>=projects.into_iter().map(|(project,tokens,models)| json!({"project":project,"tokens":tokens,"models":models})).collect();
        days.push(
            json!({"date":today,"tokens":total.tokens,"costUsd":rounded(total.cost),
            "inputTokens":input,"outputTokens":output,"cachedInputTokens":cached,
            "cacheCreationInputTokens":creation,"localMetrics":metrics.value(),
            "sources":sources,"models":models,"projects":projects}),
        );
    }
    days.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));
    Ok(json!({"success":true,"message":"ok","data":{"days":days}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_follow_the_existing_days_coercion() {
        for (query, want) in [
            ("", 90),
            ("0", 90),
            ("-1", 1),
            ("999", 365),
            ("1.5", 2),
            ("0x10", 16),
            ("Infinity", 365),
            ("nope", 90),
        ] {
            assert_eq!(
                window_days(&format!("/functions/tud-usage-daily?days={query}")),
                want
            );
        }
    }
    #[test]
    fn stale_foreign_and_wrong_schema_snapshots_are_rejected() {
        let clock = 1_793_116_800_000;
        let base = json!({"schemaVersion":1,"session":"a","createdAt":clock,"today":today_at(clock).unwrap(),"statsSinceDate":"2020-01-01","closedDays":[],"rows":[]});
        assert!(read(&base.to_string(), "/functions/tud-usage-daily", "a", clock).is_ok());
        assert!(read(&base.to_string(), "/functions/tud-usage-daily", "b", clock).is_err());
        assert!(read(
            &base.to_string(),
            "/functions/tud-usage-daily",
            "a",
            clock + 91_000
        )
        .is_err());
        let mut bad = base.clone();
        bad["schemaVersion"] = json!(2);
        assert!(read(&bad.to_string(), "/functions/tud-usage-daily", "a", clock).is_err());
    }
}
