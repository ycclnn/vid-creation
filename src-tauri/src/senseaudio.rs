// SenseAudio 开放平台 API 封装（Rust 侧）。
// 覆盖：LLM 分镜 / 参考图生图 / Seedance 视频（异步任务+轮询）/ TTS / 音乐。
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub struct Client {
    http: reqwest::blocking::Client,
    pub api_key: String,
    pub base_url: String,
}

impl Client {
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        Self {
            http: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(300))
                .build()
                .expect("http client"),
            api_key,
            base_url: base_url.unwrap_or_else(|| "https://api.senseaudio.cn".into()),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let max_retries = 3u32;
        let mut last_err = String::new();
        for attempt in 0..max_retries {
            if attempt > 0 {
                std::thread::sleep(Duration::from_secs(2u64.pow(attempt)));
            }
            let mut req = self
                .http
                .request(method.clone(), format!("{}{}", self.base_url, path))
                .header("Authorization", format!("Bearer {}", self.api_key))
                .header("Content-Type", "application/json");
            if let Some(b) = body {
                req = req.json(b);
            }
            match req.send() {
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().unwrap_or_default();
                    if status.is_success() {
                        return serde_json::from_str(&text)
                            .context(format!("响应解析失败: {}", &text[..text.len().min(200)]));
                    }
                    // 429/5xx 退避重试，其余直接失败
                    let retryable = status.as_u16() == 429 || status.is_server_error();
                    last_err = format!("HTTP {status}: {}", &text[..text.len().min(300)]);
                    if !retryable {
                        bail!("{method} {path} 失败: {last_err}", method = method, path = path);
                    }
                }
                Err(e) => {
                    last_err = format!("{e}");
                    if !e.is_timeout() && !e.is_connect() {
                        bail!("{method} {path} 网络失败: {e}");
                    }
                }
            }
        }
        bail!("{method} {path} 重试耗尽: {last_err}")
    }

    // ---------- 模型列表（动态，上游可能更换） ----------

    pub fn list_models(&self) -> Result<Value> {
        self.request(reqwest::Method::GET, "/v1/models", None)
    }

    // ---------- LLM 分镜 ----------

    pub fn chat(&self, prompt: &str, system: Option<&str>, model: &str) -> Result<String> {
        let mut messages = Vec::new();
        if let Some(s) = system {
            messages.push(json!({"role": "system", "content": s}));
        }
        messages.push(json!({"role": "user", "content": prompt}));
        let data = self.request(
            reqwest::Method::POST,
            "/v1/chat/completions",
            Some(&json!({"model": model, "messages": messages, "temperature": 0.7})),
        )?;
        data["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("chat 响应结构异常: {}", truncate(&data.to_string(), 300)))
    }

    // ---------- 图片生成（人物一致性分镜图） ----------

pub fn image_sync(
        &self,
        prompt: &str,
        reference: Option<&str>,
        size: &str,
        model: Option<&str>,
        out_path: &Path,
    ) -> Result<()> {
        let mut body = json!({"prompt": prompt, "size": size});
        if let Some(m) = model {
            body["model"] = json!(m);
        }
        if let Some(r) = reference {
            body["reference"] = json!(r);
        }
        let data = self.request(reqwest::Method::POST, "/v1/image/sync", Some(&body))?;
        let url = data["url"]
            .as_str()
            .ok_or_else(|| anyhow!("image/sync 未返回 url: {}", truncate(&data.to_string(), 300)))?;
        save_url_or_data_url(&self.http, url, out_path)
    }

    // ---------- Seedance 视频生成（异步） ----------

    #[allow(clippy::too_many_arguments)]
    pub fn video_create(
        &self,
        content: &Value,
        duration: i64,
        resolution: &str,
        ratio: &str,
        watermark: bool,
        generate_audio: bool,
        model: &str,
    ) -> Result<String> {
        if !(4..=15).contains(&duration) {
            bail!("duration 必须为 4-15 的整数，收到 {duration}");
        }
        let body = json!({
            "model": model,
            "content": content,
            "duration": duration,
            "resolution": resolution,
            "ratio": ratio,
            "watermark": watermark,
            "provider_specific": {"generate_audio": generate_audio},
        });
        let data = self.request(reqwest::Method::POST, "/v1/video/create", Some(&body))?;
        data["task_id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("video/create 未返回 task_id: {}", truncate(&data.to_string(), 300)))
    }

    pub fn video_query(&self, task_id: &str) -> Result<Value> {
        self.request(
            reqwest::Method::GET,
            &format!("/v1/video/{task_id}"),
            None,
        )
    }

    /// 轮询直到完成，返回视频 URL。
    pub fn video_wait(
        &self,
        task_id: &str,
        poll_seconds: u64,
        timeout_seconds: u64,
        progress: &dyn Fn(String),
    ) -> Result<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_seconds);
        let fail_words = ["failed", "fail", "error", "cancelled", "canceled"];
        loop {
            if std::time::Instant::now() > deadline {
                bail!("视频任务轮询超时 {task_id}");
            }
            let data = self.video_query(task_id)?;
            let status = data["status"].as_str().unwrap_or("").to_lowercase();
            let url = extract_url(&data);
            if url.is_some()
                && (status.is_empty()
                    || ["success", "succeeded", "completed", "done"]
                        .iter()
                        .any(|s| status.contains(s)))
            {
                return Ok(url.unwrap());
            }
            if fail_words.iter().any(|w| status.contains(w)) {
                bail!("视频任务失败 {task_id}: {}", truncate(&data.to_string(), 400));
            }
            progress(format!("任务 {task_id} 状态: {status}"));
            std::thread::sleep(Duration::from_secs(poll_seconds));
        }
    }

    // ---------- TTS ----------

    pub fn tts(
        &self,
        text: &str,
        voice: Option<&str>,
        format: &str,
        out_path: &Path,
    ) -> Result<()> {
        let mut body = json!({"text": text, "format": format});
        if let Some(v) = voice {
            body["voice"] = json!(v);
        }
        let data = self.request(reqwest::Method::POST, "/v1/t2a_v2", Some(&body))?;
        let audio = data["audio"]
            .as_str()
            .or_else(|| data["data"].as_str())
            .or_else(|| data["result"]["audio"].as_str());
        if let Some(b64) = audio {
            let raw = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .context("TTS audio base64 解码失败")?;
            std::fs::write(out_path, raw)?;
            return Ok(());
        }
        if let Some(url) = extract_url(&data) {
            return save_url_or_data_url(&self.http, &url, out_path);
        }
        bail!("t2a_v2 未返回音频: {}", truncate(&data.to_string(), 400))
    }

    // ---------- 音乐 ----------

    pub fn music_create(&self, prompt: &str) -> Result<String> {
        let data = self.request(
            reqwest::Method::POST,
            "/v1/music/song/create",
            Some(&json!({"prompt": prompt})),
        )?;
        data["task_id"]
            .as_str()
            .or_else(|| data["id"].as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("music/song/create 未返回 task_id"))
    }

    pub fn music_wait(&self, task_id: &str, poll_seconds: u64, timeout_seconds: u64) -> Result<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_seconds);
        let fail_words = ["failed", "fail", "error", "cancelled", "canceled"];
        loop {
            if std::time::Instant::now() > deadline {
                bail!("音乐任务轮询超时 {task_id}");
            }
            let data = self.request(
                reqwest::Method::GET,
                &format!("/v1/music/song/pending/{task_id}"),
                None,
            )?;
            let status = data["status"].as_str().unwrap_or("").to_lowercase();
            let url = extract_url(&data);
            if url.is_some()
                && (status.is_empty()
                    || ["success", "succeeded", "completed", "done"]
                        .iter()
                        .any(|s| status.contains(s)))
            {
                return Ok(url.unwrap());
            }
            if fail_words.iter().any(|w| status.contains(w)) {
                bail!("音乐任务失败 {task_id}: {}", truncate(&data.to_string(), 400));
            }
            std::thread::sleep(Duration::from_secs(poll_seconds));
        }
    }
}

fn extract_url(data: &Value) -> Option<String> {
    data["video_url"]
        .as_str()
        .or_else(|| data["url"].as_str())
        .or_else(|| data["result"]["video_url"].as_str())
        .or_else(|| data["result"]["url"].as_str())
        .map(|s| s.to_string())
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn save_url_or_data_url(
    http: &reqwest::blocking::Client,
    url: &str,
    out_path: &Path,
) -> Result<()> {
    if let Some(b64) = url.strip_prefix("data:") {
        let b64 = b64.split(',').nth(1).unwrap_or(b64);
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .context("data URL base64 解码失败")?;
        std::fs::write(out_path, raw)?;
        return Ok(());
    }
    let resp = http.get(url).send().context("下载失败")?;
    let bytes = resp.bytes().context("下载读取失败")?;
    std::fs::write(out_path, bytes)?;
    Ok(())
}

/// 本地图片转 data URL（单张 ≤ 30MB）。
pub fn image_to_data_url(path: &Path) -> Result<String> {
    let raw = std::fs::read(path).with_context(|| format!("读取参考图失败: {}", path.display()))?;
    if raw.len() > 30 * 1024 * 1024 {
        bail!("参考图过大(>30MB): {}", path.display());
    }
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("jpeg") {
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    ))
}
