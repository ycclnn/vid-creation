// ShortFilm Web 服务器：零依赖（Node 内置模块），本地起服务，托管 UI + 转发 SenseAudio API。
// 启动：node server.js  （或 npm start）→ 打开 http://localhost:5178
// API Key 配置：环境变量 SENSEAUDIO_API_KEY 或 UI 右上角设置（存 config.json，已 gitignore）。
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { URL, URLSearchParams } = require("url");

const VERSION = "v2-20260921";
const PORT = process.env.PORT || 5178;
const BASE_URL = "https://api.senseaudio.cn";
const CONFIG_FILE = path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
for (const d of [DATA_DIR, path.join(DATA_DIR, "workspaces")]) {
  fs.mkdirSync(d, { recursive: true });
}

// ---------- 工具 ----------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function getApiKey() {
  return process.env.SENSEAUDIO_API_KEY || readConfig().apiKey || "";
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}

function readBody(req, limitMB = 100) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// HTTPS 请求（带重试：429/5xx 指数退避）
function senseaudioRequest(method, apiPath, body, { timeoutMs = 300000, retries = 3 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return Promise.reject(new Error("未配置 SenseAudio API Key"));
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const payload = body ? Buffer.from(JSON.stringify(body), "utf-8") : null;
      const u = new URL(BASE_URL + apiPath);
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      };
      if (payload) options.headers["Content-Length"] = payload.length;
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve({ raw: text });
            }
            return;
          }
          const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`);
          err.status = res.statusCode;
          // 429/5xx 退避重试
          if ((res.statusCode === 429 || res.statusCode >= 500) && n < retries) {
            setTimeout(() => attempt(n + 1), Math.pow(2, n + 1) * 1000);
            return;
          }
          reject(err);
        });
      });
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", (e) => {
        if (n < retries && (e.message.includes("超时") || e.message.includes("timeout") || e.code === "ECONNRESET")) {
          setTimeout(() => attempt(n + 1), Math.pow(2, n + 1) * 1000);
          return;
        }
        reject(e);
      });
      if (payload) req.write(payload);
      req.end();
    };
    attempt(0);
  });
}

// 下载文件（带重试）
function downloadTo(url, outPath, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const getter = url.startsWith("https:") ? https : http;
      const req = getter.get(url, (res) => {
        if (res.statusCode !== 200) {
          if (n < retries) return setTimeout(() => attempt(n + 1), Math.pow(2, n + 1) * 1000);
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const tmp = outPath + ".part";
        const file = fs.createWriteStream(tmp);
        res.pipe(file);
        file.on("finish", () => file.close(() => fs.renameSync(tmp, outPath)));
        file.on("close", () => resolve(outPath));
        file.on("error", reject);
      });
      req.on("error", (e) => {
        if (n < retries) return setTimeout(() => attempt(n + 1), Math.pow(2, n + 1) * 1000);
        reject(e);
      });
    };
    attempt(0);
  });
}

// data URL 保存
function saveDataUrl(dataUrl, outPath) {
  const b64 = dataUrl.split(",")[1];
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
}

// ffmpeg 可执行文件查找
function findFfmpeg() {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // 1. PATH
  try {
    const { execFileSync } = require("child_process");
    execFileSync(name === "ffmpeg.exe" ? "ffmpeg" : name, ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {}
  // 2. 项目 bin/ 目录
  const local = path.join(__dirname, "bin", name);
  if (fs.existsSync(local)) return local;
  // 3. 复用 Tauri 版下载好的
  const tauriBin = path.join(__dirname, "..", "shortfilm", "src-tauri", "binaries", name);
  if (fs.existsSync(tauriBin)) return tauriBin;
  return null;
}

function runFfmpeg(args) {
  const { execFileSync } = require("child_process");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("未找到 ffmpeg，请安装或放到项目 bin/ 目录");
  const out = execFileSync(ffmpeg, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return out;
}

// ---------- API 路由 ----------

const ROUTES = [];

function route(method, pattern, handler) {
  ROUTES.push({ method, pattern, handler });
}

// 配置
route("POST", /^\/api\/config$/, async (req, res, m, body) => {
  const cfg = readConfig();
  if (body.apiKey !== undefined) cfg.apiKey = body.apiKey;
  writeConfig(cfg);
  send(res, 200, { ok: true });
});
route("GET", /^\/api\/config$/, async (req, res) => {
  const cfg = readConfig();
  send(res, 200, { hasApiKey: !!(process.env.SENSEAUDIO_API_KEY || cfg.apiKey) });
});

// 模型列表
route("GET", /^\/api\/models$/, async (req, res) => {
  const data = await senseaudioRequest("GET", "/v1/models");
  send(res, 200, data);
});

// 音色列表
route("POST", /^\/api\/voices$/, async (req, res) => {
  const data = await senseaudioRequest("POST", "/v1/get_voice", { voice_type: "system" });
  const voices = (data.system_voice || [])
    .filter((v) => v.voice_id)
    .map((v) => ({ voice_id: v.voice_id, voice_name: v.voice_name }));
  send(res, 200, voices);
});

// LLM 对话（分镜表 / 优化提示词）
route("POST", /^\/api\/chat$/, async (req, res, m, body) => {
  const data = await senseaudioRequest("POST", "/v1/chat/completions", {
    model: body.model || "glm-5.3-flash",
    messages: body.messages,
    temperature: 0.7,
  });
  send(res, 200, { content: data.choices?.[0]?.message?.content || "" });
});

// 图片生成（实测：model 必带；size 按模型；多参考图 references）
route("POST", /^\/api\/image$/, async (req, res, m, body) => {
  const model = body.model || "senseaudio-image-2.0-260319";
  const size =
    model.includes("seedream") || model.includes("u1")
      ? "2048x2048"
      : ["1024x1536", "1024x1024", "1536x1024"].includes(body.size)
        ? body.size
        : "1024x1536";
  const apiBody = { prompt: body.prompt, model, size };
  if (body.references?.length) apiBody.references = body.references;
  const data = await senseaudioRequest("POST", "/v1/image/async", apiBody);
  send(res, 200, data);
});

// 图片任务轮询
route("GET", /^\/api\/image\/status\?/, async (req, res, m, body, query) => {
  const data = await senseaudioRequest("GET", `/v1/image/pending?task_id=${query.get("task_id")}`);
  send(res, 200, data);
});

// 视频生成
route("POST", /^\/api\/video$/, async (req, res, m, body) => {
  if (!(body.duration >= 4 && body.duration <= 15)) {
    return send(res, 400, { error: "duration 必须为 4-15 的整数" });
  }
  const apiBody = {
    model: body.model || "doubao-seedance-2-0-260128",
    content: body.content,
    duration: body.duration,
    resolution: body.resolution || "720p",
    ratio: body.ratio || "9:16",
    watermark: false,
    provider_specific: { generate_audio: !!body.generate_audio },
  };
  const data = await senseaudioRequest("POST", "/v1/video/create", apiBody);
  send(res, 200, data);
});

// 视频任务轮询（实测：/v1/video/status?id=）
route("GET", /^\/api\/video\/status\?/, async (req, res, m, body, query) => {
  const data = await senseaudioRequest("GET", `/v1/video/status?id=${query.get("id")}`);
  send(res, 200, data);
});

// TTS（实测：voice_setting 嵌套 + stream:false + hex 音频；必须带 voice_id）
route("POST", /^\/api\/tts$/, async (req, res, m, body) => {
  const apiBody = {
    model: "sensenova-tts-2.0",
    text: body.text,
    stream: false,
    voice_setting: {
      voice_id: body.voice_id || "female_0033_b",
      speed: 1, vol: 1, pitch: 0,
    },
    audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 2 },
  };
  const data = await senseaudioRequest("POST", "/v1/t2a_v2", apiBody);
  const code = data.base_resp?.status_code ?? 0;
  if (code !== 0) return send(res, 400, { error: data.base_resp?.status_msg || "TTS 失败" });
  const audioHex = data.data?.audio || "";
  const buf = Buffer.from(audioHex, "hex");
  const id = "tts_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const p = path.join(DATA_DIR, id + ".mp3");
  fs.writeFileSync(p, buf);
  send(res, 200, { url: `/files/${id}.mp3` });
});

// 音乐生成
route("POST", /^\/api\/music$/, async (req, res, m, body) => {
  const data = await senseaudioRequest("POST", "/v1/music/song/create", { prompt: body.prompt });
  send(res, 200, data);
});
route("GET", /^\/api\/music\/status\?/, async (req, res, m, body, query) => {
  const data = await senseaudioRequest("GET", `/v1/music/song/pending/${query.get("task_id")}`);
  send(res, 200, data);
});

// 工作区：项目保存/读取/素材落盘
route("POST", /^\/api\/workspace$/, async (req, res, m, body) => {
  const safe = (body.title || "project").replace(/[\\/:*?"<>|]/g, "_");
  const dir = path.join(DATA_DIR, "workspaces", safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(body.project, null, 2));
  send(res, 200, { dir });
});

// 素材保存（下载 URL 或 data URL 到工作区）
route("POST", /^\/api\/save-asset$/, async (req, res, m, body) => {
  const { url, relPath } = body; // relPath 如 "ws名/shots/shot_001.png"
  const out = path.join(DATA_DIR, relPath);
  if (relPath.includes("..")) return send(res, 400, { error: "非法路径" });
  if (url.startsWith("data:")) {
    saveDataUrl(url, out);
  } else {
    await downloadTo(url, out);
  }
  send(res, 200, { url: `/files/${relPath}` });
});

// 项目列表
route("GET", /^\/api\/projects$/, async (req, res) => {
  const dir = path.join(DATA_DIR, "workspaces");
  const list = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const pj = path.join(dir, d.name, "project.json");
      if (!fs.existsSync(pj)) return null;
      try {
        const p = JSON.parse(fs.readFileSync(pj, "utf-8"));
        return { name: d.name, title: p.title, shots: p.shots?.length || 0 };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  send(res, 200, list);
});

route("GET", /^\/api\/project\/$/, async (req, res, m, body, query) => {
  const name = query.get("name") || "";
  if (name.includes("..")) return send(res, 400, { error: "非法路径" });
  const pj = path.join(DATA_DIR, "workspaces", name, "project.json");
  if (!fs.existsSync(pj)) return send(res, 404, { error: "不存在" });
  send(res, 200, JSON.parse(fs.readFileSync(pj, "utf-8")));
});

// 素材静态文件
route("GET", /^\/files\//, async (req, res, m, body, query, pathname) => {
  const rel = decodeURIComponent(pathname.replace(/^\/files\//, ""));
  if (rel.includes("..")) return send(res, 400, { error: "非法路径" });
  const p = path.join(DATA_DIR, rel);
  if (!fs.existsSync(p)) return send(res, 404, "not found");
  const ext = path.extname(p).toLowerCase();
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".gif": "image/gif" };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

// ffmpeg 拼接
route("POST", /^\/api\/assemble$/, async (req, res, m, body) => {
  const { project, workDir, bgmUrl, dialogueAudio } = body;
  const safe = (project.title || "project").replace(/[\\/:*?"<>|]/g, "_");
  const work = path.join(DATA_DIR, "workspaces", safe);
  const videosDir = path.join(work, "videos");
  const parts = [];
  for (let i = 0; i < project.shots.length; i++) {
    const v = path.join(videosDir, `shot_${String(i + 1).padStart(3, "0")}.mp4`);
    if (!fs.existsSync(v)) return send(res, 400, { error: `缺少镜头视频: shot_${i + 1}` });
    parts.push(v);
  }
  // 1) 台词混入
  const processed = [];
  for (let i = 0; i < parts.length; i++) {
    const audio = path.join(work, "audio", `line_${String(i + 1).padStart(3, "0")}.mp3`);
    if (dialogueAudio && fs.existsSync(audio)) {
      const withAudio = path.join(videosDir, `shot_${String(i + 1).padStart(3, "0")}_a.mp4`);
      runFfmpeg([
        "-y", "-i", parts[i], "-i", audio,
        "-filter_complex", "[1:a]apad=pad_dur=10[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
        withAudio,
      ]);
      processed.push(withAudio);
    } else {
      processed.push(parts[i]);
    }
  }
  // 2) concat
  const listFile = path.join(videosDir, "concat.txt");
  fs.writeFileSync(listFile, processed.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const concatOut = path.join(work, "output", "concat.mp4");
  fs.mkdirSync(path.dirname(concatOut), { recursive: true });
  runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", concatOut]);
  // 3) BGM
  let outPath = concatOut;
  const finalOut = path.join(work, "output", "final.mp4");
  if (bgmUrl) {
    // 下载 bgm
    const bgm = path.join(work, "audio", "bgm.mp3");
    if (!fs.existsSync(bgm)) {
      const u = bgmUrl.startsWith("/files/") ? "http://127.0.0.1" + bgmUrl : bgmUrl;
      if (u.startsWith("http://127.0.0.1")) {
        const rel = decodeURIComponent(bgmUrl.replace("/files/", ""));
        fs.copyFileSync(path.join(DATA_DIR, rel), bgm);
      } else {
        await downloadTo(bgmUrl, bgm);
      }
    }
    runFfmpeg([
      "-y", "-i", concatOut, "-stream_loop", "-1", "-i", bgm,
      "-filter_complex", "[1:a]volume=0.25[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=3[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest", finalOut,
    ]);
    outPath = finalOut;
  } else {
    fs.copyFileSync(concatOut, finalOut);
    outPath = finalOut;
  }
  const rel = path.relative(DATA_DIR, outPath).replace(/\\/g, "/");
  send(res, 200, { url: `/files/${rel}` });
});

// ---------- 静态 UI ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

function serveStatic(res, pathname) {
  let p = pathname === "/" ? "/index.html" : pathname;
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found");
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = u.pathname;
  try {
    for (const r of ROUTES) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      const body = req.method === "POST" ? JSON.parse((await readBody(req)).toString("utf-8") || "{}") : null;
      await r.handler(req, res, m, body, u.searchParams, pathname);
      return;
    }
    serveStatic(res, pathname);
  } catch (e) {
    console.error("[error]", e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`ShortFilm Web ${VERSION} 已启动: ${url}`);
  console.log("API Key: 环境变量 SENSEAUDIO_API_KEY 或 UI 设置（存 config.json）");
  const { exec } = require("child_process");
  const cmd = process.platform === "win32" ? `start ${url}` : process.platform === "darwin" ? "open " + url : "xdg-open " + url;
  exec(cmd);
});
