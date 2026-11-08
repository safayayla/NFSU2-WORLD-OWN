//! Password-token protected web administration. The existing Unix control socket remains private.
use super::{App, Cache, Fail, Hdrs, Request, Res, Response, finish, send};
use crate::options::js_to_number;
use serde_json::{Value, json};

const MAX_BODY: usize = 16 << 10;

impl App {
    pub(super) async fn admin_route(&self, q: &mut Request, s: &mut Response, path: &str) -> Res {
        const CLOSE: &[(&str, &str)] = &[("connection", "close")];
        if !self.own_page(q) {
            return self.plain(q, s, 403, "Forbidden", CLOSE, Cache::Store, true).await;
        }
        if path == "/admin" {
            if q.method != "GET" && q.method != "HEAD" {
                return self.plain(q, s, 405, "Method not allowed", &[("allow", "GET, HEAD")], Cache::Store, true).await;
            }
            let body = include_str!("../../../admin.html");
            let mut h = self.headers(q, Cache::Store, true);
            h.set("content-type", "text/html; charset=utf-8");
            h.set("content-length", body.len().to_string());
            s.head(200, h.0);
            if q.method != "HEAD" { send(s, body.as_bytes()).await?; }
            return finish(s).await;
        }
        if q.method != "POST" {
            return self.plain(q, s, 405, "Method not allowed", &[("allow", "POST"), ("connection", "close")], Cache::Store, true).await;
        }
        // The admin surface is never served over clear-text public HTTP. Loopback remains usable for local setup.
        let local = q.conn.peer.ip().is_loopback();
        if !local && !nfsu2_headers::via_https(q, &self.o.trust) {
            return self.plain(q, s, 403, "HTTPS required", CLOSE, Cache::Store, true).await;
        }
        let configured = std::env::var("NFSU2_ADMIN_TOKEN").unwrap_or_default();
        if configured.len() < 32 {
            return self.plain(q, s, 503, "Admin is not configured", CLOSE, Cache::Store, true).await;
        }
        let supplied = q.headers.get("authorization").unwrap_or("");
        let supplied = supplied.strip_prefix("Bearer ").unwrap_or("").as_bytes();
        if !constant_time_eq(configured.as_bytes(), supplied) {
            return self.plain(q, s, 401, "Unauthorized", CLOSE, Cache::Store, true).await;
        }
        if js_to_number(q.headers.get("content-length").unwrap_or("0")) > MAX_BODY as f64 {
            return self.plain(q, s, 413, "Too large", CLOSE, Cache::Store, true).await;
        }
        let body = match q.read_body(MAX_BODY).await {
            Ok(b) => b,
            Err(nfsu2_http::BodyError::TooLarge) => return self.plain(q, s, 413, "Too large", CLOSE, Cache::Store, true).await,
            Err(nfsu2_http::BodyError::Broken) => { s.destroy(); return Err(Fail::Gone); }
        };
        let request: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return self.plain(q, s, 400, "Bad request", CLOSE, Cache::Store, true).await,
        };
        let Some(words) = request.get("command").and_then(Value::as_array) else {
            return self.plain(q, s, 400, "Bad request", CLOSE, Cache::Store, true).await;
        };
        if words.is_empty() || words.len() > 8 || words.iter().any(|w| !w.is_string() || w.as_str().unwrap_or("").len() > 256) {
            return self.plain(q, s, 400, "Bad request", CLOSE, Cache::Store, true).await;
        }
        let words: Vec<String> = words.iter().filter_map(|w| w.as_str().map(str::to_owned)).collect();
        let allowed = ["who", "kick", "ban", "raceban", "unban", "bans", "history"];
        if !allowed.contains(&words[0].as_str()) {
            return self.plain(q, s, 400, "Unsupported command", CLOSE, Cache::Store, true).await;
        }
        let result = self.control(&words).await;
        let (ok, text) = match result { Ok(t) => (true, t), Err(e) => (false, e) };
        let body = json!({"ok":ok,"text":text}).to_string();
        let mut h = self.headers(q, Cache::Store, true);
        h.set("content-type", "application/json; charset=utf-8");
        h.set("cache-control", "no-store");
        h.set("content-length", body.len().to_string());
        s.head(if ok { 200 } else { 400 }, h.0);
        send(s, body.as_bytes()).await?;
        finish(s).await
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    let n = a.len().max(b.len());
    for i in 0..n {
        diff |= (a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}
