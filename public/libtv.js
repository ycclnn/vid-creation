// LibTV · 一站式 AI 视频创作平台
// 流水线：① 剧本 → ② 声音选角（音色一致性）→ ③ 逐镜创作（提示词/分镜图/声音/视频）→ ④ 合并成片
let project = null;
let workName = null;
let voices = [];
let models = [];
let currentShot = 0;
let busy = false;
let cast = []; // 角色声音档案 [{name, voice_id, speed, vol, pitch}]

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function log(msg) {
  const el = $("log");
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---------- 流水线导航 ----------
function goStage(n) {
  if (n >= 2 && !project) { alert("先在「剧本」步创建项目"); return; }
  document.querySelectorAll(".stage").forEach((s) => s.classList.remove("active"));
  $("stage" + n).classList.add("active");
  document.querySelectorAll(".pstep").forEach((p) => {
    const s = +p.dataset.stage;
    p.classList.toggle("active", s === n);
    p.classList.toggle("done", s < n);
  });
  document.querySelectorAll(".pline").forEach((p) => {
    const i = +p.dataset.pl;
    p.classList.toggle("done", i < n);
  });
  if (n === 2) renderCastPanel();
  if (n === 3) { renderQueue(); renderEditor(); renderPreview(); }
  if (n === 4) renderFinal();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll(".pstep").forEach((p) => (p.onclick = () => goStage(+p.dataset.stage)));

// ---------- 初始化 ----------
(async () => {
  const cfg = await api("GET", "/api/config");
  const st = $("apiState");
  st.textContent = cfg.hasApiKey ? "✅ Key 已配置" : "⚠ 未配置 Key";
  st.className = cfg.hasApiKey ? "ok" : "warn";
  if (!cfg.hasApiKey) setKey();
  await refreshModels();
  await refreshVoices();
  await refreshProjectList();
})();

function setKey() {
  const key = prompt("请输入 SenseAudio API Key:");
  if (!key) return;
  api("POST", "/api/config", { apiKey: key }).then(() => {
    log("API Key 已保存");
    location.reload();
  });
}
$("btnKey").onclick = setKey;

// ---------- 模型 ----------
const SIZE_MATRIX = { seedream: ["2048x2048"], u1: ["2048x2048"], default: ["1024x1536", "1024x1024", "1536x1024"] };
const sizesFor = (m) => (m.includes("seedream") || m.includes("u1") ? SIZE_MATRIX.seedream : SIZE_MATRIX.default);
async function refreshModels() {
  try {
    const data = await api("GET", "/api/models");
    models = data.data || [];
    const by = (mode) => [...new Set(models.filter((m) => m.mode === mode).map((m) => m.id))];
    fillSelect("llmModel", by("llm"), "glm-5.3-flash");
    fillSelect("imageModel", by("image"), "senseaudio-image-2.0-260319");
    fillSelect("videoModel", by("video"), "doubao-seedance-2-0-260128");
    syncSizes();
  } catch (e) { log("模型列表失败: " + e.message); }
}
function fillSelect(id, list, preferred) {
  const el = $(id);
  el.innerHTML = "";
  [...new Set([preferred, ...list])].filter(Boolean).forEach((v) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = v + (v === preferred ? "（默认）" : "");
    el.appendChild(o);
  });
  el.value = preferred || "";
}
function syncSizes() {
  const el = $("imageSize");
  el.innerHTML = sizesFor($("imageModel").value).map((s) => `<option value="${s}">${s}</option>`).join("");
}
$("imageModel").addEventListener("change", syncSizes);

// ---------- 音色 ----------
async function refreshVoices() {
  try {
    voices = await api("POST", "/api/voices", {});
    fillSelect("fVoice", voices.map((v) => v.voice_id), "female_0033_b");
    voices.forEach((v) => { const o = $("fVoice").querySelector(`option[value="${CSS.escape(v.voice_id)}"]`); if (o) o.textContent = `${v.voice_name}（${v.voice_id}）`; });
  } catch (e) { log("音色库失败: " + e.message); }
}

// ---------- ① 剧本：创建项目 ----------
$("btnCreate").onclick = async () => {
  if (busy) return;
  const synopsis = $("synopsis").value.trim();
  if (!synopsis) return alert("请填写故事梗概");
  const characters = $("characters").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, description] = l.split("|").map((s) => s.trim());
    return { name: name || "角色", description: description || "", voice: null, reference_images: [], image: null };
  });
  if (!characters.length) return alert("请至少填写一个人物");
  const shotCount = parseInt($("shotCount").value) || 6;
  const perShot = parseInt($("shotSeconds").value) || 6;
  project = {
    title: $("title").value || "我的短片",
    synopsis, characters,
    ratio: $("ratio").value, resolution: $("resolution").value,
    image_model: $("imageModel").value, image_size: $("imageSize").value,
    video_model: $("videoModel").value, llm_model: $("llmModel").value,
    music_prompt: $("music").value || null,
    shots: [],
  };
  busy = true; $("btnCreate").disabled = true;
  log("AI 生成分镜剧本……");
  try {
    const out = await api("POST", "/api/chat", {
      model: project.llm_model,
      messages: [
        { role: "system", content: "你是专业短片导演。只输出 JSON 数组，不要其他文字。" },
        { role: "user", content: `梗概：${synopsis}\n人物：\n${characters.map((c) => `- ${c.name}: ${c.description}`).join("\n")}\n\n输出 ${shotCount} 个分镜，每镜字段：prompt（中文画面提示词，含人物外观/场景/动作/运镜/光线，与前后镜衔接）、line_character（角色名或 null）、line_text（台词或 null，口语化，适合 ${perShot} 秒）、duration（${perShot}-15 整数秒）。输出 [{...},...]` },
      ],
    });
    const s = out.content.indexOf("["), e = out.content.lastIndexOf("]");
    if (s < 0) throw new Error("LLM 未返回 JSON: " + out.content.slice(0, 150));
    project.shots = JSON.parse(out.content.slice(s, e + 1));
    project.shots.forEach((sh) => { sh.status = "pending"; sh.reference_images = []; });
    workName = project.title.replace(/[\\/:*?"<>|]/g, "_");
    await api("POST", "/api/workspace", { title: workName, project });
    $("projName").textContent = "📁 " + workName;
    currentShot = 0;
    log(`✅ 分镜剧本 ${project.shots.length} 镜已生成，进入「选角」`);
    await refreshProjectList();
    goStage(2);
  } catch (err) {
    log("分镜失败: " + err.message);
    alert("分镜失败: " + err.message);
  }
  busy = false; $("btnCreate").disabled = false;
};

async function refreshProjectList() {
  try {
    const list = await api("GET", "/api/projects");
    const el = $("projectList");
    if (!list.length) { el.innerHTML = '<div class="empty">暂无项目</div>'; return; }
    el.innerHTML = "";
    list.forEach((p) => {
      const div = document.createElement("div");
      div.className = "proj-item";
      div.innerHTML = `<span style="flex:1; font-size:13px; font-weight:600">📁 ${esc(p.title)}<span class="tag" style="margin-left:8px">${p.shots} 镜</span></span>`;
      const btn = document.createElement("button");
      btn.className = "ghost sm"; btn.textContent = "打开";
      btn.onclick = () => openProject(p.name);
      div.appendChild(btn);
      el.appendChild(div);
    });
  } catch {}
}

async function openProject(name) {
  if (busy) return;
  try {
    project = await api("GET", "/api/project?name=" + encodeURIComponent(name));
    workName = name;
    $("projName").textContent = "📁 " + name;
    currentShot = 0;
    log(`已打开项目「${name}」`);
    goStage(2);
  } catch (e) { alert("打开失败: " + e.message); }
}

// ---------- ② 声音选角（音色一致性核心） ----------
function renderCastPanel() {
  const el = $("castList");
  if (!project) return;
  cast = project.characters.map((c) => {
    const found = cast.find((x) => x.name === c.name);
    return found || { name: c.name, voice_id: c.voice || "", speed: 1, vol: 1, pitch: 0, description: c.description, image: c.image };
  });
  el.innerHTML = cast
    .map(
      (c, i) => `
    <div class="cast-item">
      <div class="avatar c${i % 5}">${c.image ? `<img src="${esc(c.image)}">` : esc((c.name || "?")[0])}</div>
      <div class="info">
        <div class="name">${esc(c.name)}</div>
        <div class="voice">${voiceLabel(c.voice_id)} · 语速${c.speed} · 音调${c.pitch}${c.description ? " · " + esc(c.description) : ""}</div>
      </div>
      ${c.image ? `<img src="${esc(c.image)}" style="width:44px;height:44px;border-radius:12px;object-fit:cover" />` : `<button class="ghost sm" onclick="genCharImage(${i})">生成人物图</button>`}
      <button class="soft sm" onclick="openCastDlg(${i})">🎙 选声音</button>
    </div>`
    )
    .join("");
}

function voiceLabel(vid) {
  if (!vid) return "⚠ 未选音色";
  const v = voices.find((x) => x.voice_id === vid);
  return v ? `${v.voice_name}` : vid;
}

function openCastDlg(i) {
  const c = cast[i];
  $("castDlgTitle").textContent = `🎙 ${c.name} 的声音档案`;
  $("fName").value = c.name;
  if (c.voice_id) $("fVoice").value = c.voice_id;
  $("fSpeed").value = c.speed; $("fVol").value = c.vol; $("fPitch").value = c.pitch;
  $("fDesc").value = c.description || "";
  $("castDlg").dataset.idx = i;
  $("castDlg").showModal();
}

async function saveCast() {
  const i = +$("castDlg").dataset.idx;
  const c = cast[i];
  c.voice_id = $("fVoice").value;
  c.speed = Number($("fSpeed").value) || 1;
  c.vol = Number($("fVol").value) || 1;
  c.pitch = Number($("fPitch").value) || 0;
  c.description = $("fDesc").value.trim();
  // 同步回 project
  const pc = project.characters.find((x) => x.name === c.name);
  if (pc) { pc.voice = c.voice_id; pc.description = c.description; }
  $("castDlg").close();
  renderCastPanel();
  await saveProject();
  log(`🎙 ${c.name} → ${voiceLabel(c.voice_id)}（全片一致）`);
}

async function audition() {
  const c = cast[+$("castDlg").dataset.idx];
  $("btnAudition").disabled = true;
  try {
    const out = await api("POST", "/api/cast/audition", { voice_id: c.voice_id || "female_0033_b", speed: c.speed, vol: c.vol, pitch: c.pitch });
    $("auditionPlayer").src = out.url;
    $("auditionPlayer").play();
  } catch (e) { alert("试听失败: " + e.message); }
  $("btnAudition").disabled = false;
}

async function genCharImage(i) {
  if (busy) return;
  const c = cast[i];
  busy = true;
  log(`生成「${c.name}」人物图……`);
  try {
    const desc = c.description || "";
    const data = await api("POST", "/api/image", {
      prompt: `${desc}，单人全身立绘，干净纯色背景，写实电影风格，正面视角，细节丰富`,
      model: project.image_model, size: project.image_size,
    });
    const url = await pollImage(data.task_id);
    const saved = await api("POST", "/api/save-asset", { url, relPath: `${workName}/shots/char_${encodeURIComponent(c.name)}.png` });
    c.image = saved.url;
    const pc = project.characters.find((x) => x.name === c.name);
    if (pc) pc.image = saved.url;
    // 人物图自动加入该角色所有未生成镜头的参考图
    project.shots.forEach((sh) => {
      if (sh.status === "pending" && sh.line_character === c.name) {
        sh.reference_images = sh.reference_images || [];
        if (!sh.reference_images.includes(saved.url)) sh.reference_images.push(saved.url);
      }
    });
    renderCastPanel();
    log(`✅「${c.name}」人物图完成，已加入相关镜头参考`);
    await saveProject();
  } catch (e) { log("人物图失败: " + e.message); alert("人物图失败: " + e.message); }
  busy = false;
}

// ---------- ③ 逐镜创作 ----------
function renderQueue() {
  if (!project) return;
  const el = $("queue");
  const done = project.shots.filter((s) => s.status === "approved").length;
  $("queueStat").textContent = `${done}/${project.shots.length} 已通过`;
  el.innerHTML = project.shots
    .map((shot, i) => {
      const cls = "shotcard" + (i === currentShot ? " current" : "") + (shot.status === "approved" ? " approved" : "");
      return `
      <div class="${cls}" onclick="pickShot(${i})">
        <div class="thumb">${shot.image ? `<img src="${esc(shot.image)}">` : shot.video ? "🎬" : "🖼"}</div>
        <div class="meta">
          <strong>#${i + 1}</strong>
          <span class="badge b-${esc(shot.status)}">${statusLabel(shot.status)}</span>
          <span>${shot.duration}s</span>
          ${shot.line_character ? `<span>🎭${esc(shot.line_character)}</span>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

function statusLabel(s) {
  return { pending: "待生成", running: "生成中", image_ready: "待确认", approved: "已通过 ✓", failed: "失败" }[s] || s;
}

function pickShot(i) {
  if (busy) return;
  currentShot = i;
  renderQueue(); renderEditor(); renderPreview();
}

function renderEditor() {
  if (!project) return;
  const shot = project.shots[currentShot];
  if (!shot) return;
  const stepEl = $("shotStep");
  stepEl.className = "badge b-" + shot.status;
  stepEl.textContent = `#${currentShot + 1}/${project.shots.length} · ${statusLabel(shot.status)}`;
  const prev = currentShot > 0 ? project.shots[currentShot - 1] : null;
  const isApproved = shot.status === "approved";
  const boundCast = cast.find((c) => c.name === shot.line_character);
  const charOpts = project.characters.map((c) => `<option value="${esc(c.name)}" ${shot.line_character === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const secHint = shot.duration <= 5 ? "约 40-60 字" : shot.duration <= 9 ? "约 70-110 字" : "约 110-160 字";
  $("editor").innerHTML = `
    <div class="tri">
      <div class="element">
        <div class="el-title">📝 画面提示词 <span class="hint">秒级建议：${secHint}</span></div>
        <textarea id="edPrompt" rows="5">${esc(shot.prompt || "")}</textarea>
        <div class="row" style="margin-top:8px; flex-wrap:wrap">
          <button class="ghost sm" id="btnOpt">✨ AI 优化</button>
          <button class="ghost sm" id="btnAddRef">+ 上传参考图</button>
          ${prev?.image ? `<button class="ghost sm" id="btnInherit">↳ 引用上一镜</button>` : ""}
        </div>
        <div class="ref-tags">
          ${(shot.reference_images || []).map((r, i) => `<span class="rtag" data-del="${i}">参考${i + 1}${r.startsWith("data:") ? "（上传）" : ""} ✕</span>`).join("")}
          ${(shot.reference_images || []).length === 0 ? '<span style="font-size:11px;color:var(--muted)">无参考图 → 文生图</span>' : ""}
        </div>
      </div>
      <div class="element">
        <div class="el-title">🖼 分镜图（first_frame）</div>
        ${shot.image ? `<img class="media" src="${esc(shot.image)}">` : `<div class="placeholder">未生成分镜图</div>`}
        <div style="margin-top:8px"><button class="primary sm" id="btnImage" ${isApproved ? "disabled" : ""}>${shot.image ? "🔄 重新生成" : "🖼 生成分镜图"}</button></div>
      </div>
      <div class="element">
        <div class="el-title">🔊 声音 <span class="hint">按声音档案锁定</span></div>
        <label class="fl" style="margin-top:0">台词角色</label>
        <select id="edChar"><option value="">（无台词）</option>${charOpts}</select>
        <label class="fl">台词</label>
        <input type="text" id="edLine" value="${esc(shot.line_text || "")}" placeholder="本镜台词" />
        <label class="fl">音色（档案锁定）</label>
        <input type="text" value="${boundCast && boundCast.voice_id ? esc(voiceLabel(boundCast.voice_id)) : "⚠ 未选音色，去选角台"}" disabled />
        ${shot.audio_url ? `<audio controls style="width:100%;margin-top:8px" src="${esc(shot.audio_url)}"></audio>` : ""}
        <label class="fl">时长 4-15s</label>
        <input type="text" id="edDur" value="${shot.duration}" />
      </div>
    </div>
    <div class="row" style="margin-top:16px; flex-wrap:wrap">
      <button class="green" id="btnGenerate" ${isApproved || !shot.image ? "disabled" : ""}>🎬 生成视频</button>
      <button class="green" id="btnApprove" ${shot.video && !isApproved ? "" : "disabled"}>✓ 通过 → 下一镜</button>
      <button class="warnb" id="btnRetry" ${shot.status === "pending" ? "disabled" : ""}>🔄 重试本镜</button>
      ${shot.video ? `<button class="ghost sm" id="btnPlayFull">▶ 大屏预览</button>` : ""}
    </div>
    ${shot.error ? `<div style="color:var(--red);font-size:12px;margin-top:8px">✗ ${esc(shot.error)}</div>` : ""}
  `;
  $("edChar").onchange = () => { shot.line_character = $("edChar").value || null; renderEditor(); renderQueue(); saveProject(); };
  $("edLine").onchange = () => { shot.line_text = $("edLine").value || null; saveProject(); };
  $("edDur").onchange = () => { const v = parseInt($("edDur").value); if (v >= 4 && v <= 15) { shot.duration = v; renderQueue(); saveProject(); } else alert("时长 4-15 整数"); };
  $("edPrompt").onchange = () => { shot.prompt = $("edPrompt").value; saveProject(); };
  $("btnOpt").onclick = optimizePrompt;
  $("btnAddRef").onclick = addRef;
  $("btnImage").onclick = generateShotImage;
  $("btnGenerate").onclick = generateShotVideo;
  $("btnApprove").onclick = approveShot;
  $("btnRetry").onclick = retryShot;
  const play = $("btnPlayFull");
  if (play) play.onclick = () => { $("preview").innerHTML = `<video class="media" controls autoplay src="${esc(shot.video)}">`; };
  const inh = $("btnInherit");
  if (inh) inh.onclick = () => {
    shot.reference_images = shot.reference_images || [];
    if (!shot.reference_images.includes(prev.image)) shot.reference_images.push(prev.image);
    renderEditor(); saveProject(); log("已引用上一镜画面作参考");
  };
  document.querySelectorAll("[data-del]").forEach((t) => {
    t.onclick = () => { shot.reference_images.splice(+t.dataset.del, 1); renderEditor(); };
  });
}

async function addRef() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/jpeg,image/png,image/webp"; input.multiple = true;
  input.onchange = async () => {
    const shot = project.shots[currentShot];
    shot.reference_images = shot.reference_images || [];
    for (const f of input.files) {
      const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      shot.reference_images.push(b64);
    }
    renderEditor(); saveProject();
    log(`+${input.files.length} 张参考图`);
  };
  input.click();
}

async function pollImage(taskId) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await api("GET", "/api/image/status?task_id=" + taskId);
    if (["completed", "success", "succeeded"].includes(st.status)) return st.url;
    if (["failed", "fail", "error"].includes(st.status)) throw new Error(st.error_message || "图片任务失败");
    if (i % 5 === 0) log("  图片: " + st.status);
  }
  throw new Error("图片任务超时");
}

async function generateShotImage() {
  if (busy) return;
  const shot = project.shots[currentShot];
  if (!shot.prompt) return alert("先填写/优化提示词");
  busy = true;
  shot.status = "running"; renderQueue();
  log(`镜头 ${currentShot + 1} 生成分镜图……`);
  try {
    const data = await api("POST", "/api/image", { prompt: shot.prompt, model: project.image_model, size: project.image_size, references: shot.reference_images || [] });
    const url = await pollImage(data.task_id);
    const saved = await api("POST", "/api/save-asset", { url, relPath: `${workName}/shots/shot_${String(currentShot + 1).padStart(3, "0")}.png` });
    shot.image = saved.url;
    shot.status = "image_ready";
    renderQueue(); renderEditor(); renderPreview();
    log(`✅ 镜头 ${currentShot + 1} 分镜图完成`);
    await saveProject();
  } catch (e) {
    shot.status = "failed"; shot.error = e.message;
    renderQueue(); renderEditor(); log("分镜图失败: " + e.message);
  }
  busy = false;
}

async function generateShotVideo() {
  if (busy) return;
  const shot = project.shots[currentShot];
  if (!shot.image) return alert("请先生成分镜图");
  busy = true;
  shot.status = "running"; shot.error = null; renderQueue();
  try {
    // 1) 台词语音：强制按声音档案（音色一致性）
    if (shot.line_text && shot.line_character) {
      const c = cast.find((c) => c.name === shot.line_character);
      if (c && c.voice_id) {
        log(`台词配音：${shot.line_character} → ${voiceLabel(c.voice_id)}（档案锁定）`);
        const tts = await api("POST", "/api/dub", { lines: [{ character: shot.line_character, text: shot.line_text }] });
        const r = tts.results[0];
        if (r.error) throw new Error(r.error);
        shot.audio_url = r.url;
      } else {
        log(`⚠「${shot.line_character}」未选音色，跳过配音（去选角台补）`);
      }
    }
    // 2) 分镜图转 first_frame → 视频
    log("生成视频……");
    const imgBlob = await (await fetch(shot.image)).blob();
    const firstFrame = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(imgBlob); });
    const data = await api("POST", "/api/video", {
      model: project.video_model,
      content: [{ type: "text", text: shot.prompt }, { type: "image", url: firstFrame, role: "first_frame" }],
      duration: shot.duration, resolution: project.resolution, ratio: project.ratio,
    });
    let videoUrl = null;
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const st = await api("GET", "/api/video/status?id=" + data.task_id);
      if (["completed", "success", "succeeded"].includes(st.status)) { videoUrl = st.video_url; break; }
      if (["failed", "fail", "error", "cancelled"].includes(st.status)) throw new Error(st.error_message || "视频任务失败");
      log(`  视频: ${st.status} ${st.progress ?? 0}%`);
    }
    if (!videoUrl) throw new Error("视频任务超时");
    const saved = await api("POST", "/api/save-asset", { url: videoUrl, relPath: `${workName}/videos/shot_${String(currentShot + 1).padStart(3, "0")}.mp4` });
    shot.video = saved.url;
    shot.status = "image_ready";
    renderQueue(); renderEditor(); renderPreview();
    $("preview").innerHTML = `<video class="media" controls autoplay src="${esc(shot.video)}">`;
    log(`✅ 镜头 ${currentShot + 1} 视频完成，预览确认`);
    await saveProject();
  } catch (e) {
    shot.status = "failed"; shot.error = e.message;
    renderQueue(); renderEditor(); log("视频失败: " + e.message); alert("视频失败: " + e.message);
  }
  busy = false;
}

async function approveShot() {
  if (busy) return;
  const shot = project.shots[currentShot];
  if (!shot.video) return alert("本镜还没有视频");
  shot.status = "approved";
  await saveProject();
  if (currentShot < project.shots.length - 1) {
    currentShot++;
    const next = project.shots[currentShot];
    const prev = project.shots[currentShot - 1];
    if (!next.line_character) next.line_character = prev.line_character;
    next.reference_images = next.reference_images?.length ? next.reference_images : [...(prev.reference_images || [])];
    log(`✅ 镜头 ${currentShot} 通过，进入镜头 ${currentShot + 1}（已继承）`);
  } else {
    log("🎉 最后一镜通过！点「去合成」");
  }
  renderQueue(); renderEditor(); renderPreview();
  $("btnAssemble").disabled = !project.shots.every((s) => s.status === "approved");
}

async function retryShot() {
  if (busy) return;
  const shot = project.shots[currentShot];
  shot.status = "pending"; shot.image = null; shot.video = null; shot.error = null; shot.audio_url = null;
  renderQueue(); renderEditor(); renderPreview();
  $("btnAssemble").disabled = true;
  log(`镜头 ${currentShot + 1} 已重置`);
  saveProject();
}

async function optimizePrompt() {
  const shot = project.shots[currentShot];
  const rough = $("edPrompt").value.trim();
  if (!rough) return alert("先输入大概方向");
  busy = true;
  log("优化提示词……");
  try {
    const prev = currentShot > 0 ? project.shots[currentShot - 1].prompt : null;
    const next = currentShot < project.shots.length - 1 ? project.shots[currentShot + 1].prompt : null;
    const out = await api("POST", "/api/chat", {
      model: project.llm_model,
      messages: [
        { role: "system", content: "你是专业分镜师。把大概方向优化为详细的图生视频中文提示词。只输出提示词本身。" },
        { role: "user", content: `方向：${rough}\n时长：${shot.duration}秒\n上一镜：${prev || "（第一镜）"}\n下一镜：${next || "（最后一镜）"}\n要求：细化场景/动作/表情/运镜/光线；衔接前后镜；100-200字。` },
      ],
    });
    shot.prompt = out.content.trim();
    renderEditor(); renderQueue(); saveProject();
    log("✅ 提示词已优化");
  } catch (e) { log("优化失败: " + e.message); }
  busy = false;
}

// ---------- ④ 合并成片 ----------
$("btnAssemble").onclick = () => goStage(4);
$("btnAssemble2").onclick = assemble;

function renderFinal() {
  const box = $("finalBox");
  if (!project || !project.shots.length) return;
  const done = project.shots.filter((s) => s.status === "approved").length;
  box.innerHTML = `<div class="row" style="flex-wrap:wrap; gap:10px">
    ${project.shots.map((s, i) => `<div style="width:100px"><div class="thumb" style="width:100px;height:60px;border-radius:10px;background:var(--bg);display:flex;align-items:center;justify-content:center;overflow:hidden">${s.image ? `<img src="${esc(s.image)}" style="width:100%;height:100%;object-fit:cover">` : "-"}</div><div style="font-size:11px;color:var(--muted);margin-top:4px">#${i + 1} ${statusLabel(s.status)}</div></div>`).join("")}
  </div><div class="progress-bar"><div style="width:${(done / project.shots.length) * 100}%"></div></div>
  <div style="font-size:12px;color:var(--muted);margin-top:6px">${done}/${project.shots.length} 镜已通过</div>`;
}

async function assemble() {
  if (busy) return;
  if (!project) return;
  const notDone = project.shots.filter((s) => s.status !== "approved");
  if (notDone.length) return alert(`还有 ${notDone.length} 镜未通过`);
  busy = true; $("btnAssemble2").disabled = true;
  log("合并成片……");
  try {
    let bgm = null;
    if (project.music_prompt) {
      log("生成 BGM……");
      try {
        const data = await api("POST", "/api/music", { prompt: project.music_prompt });
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 10000));
          const st = await api("GET", "/api/music/status?task_id=" + (data.task_id || data.id));
          if (["completed", "success", "succeeded"].includes(st.status)) { bgm = st.url; log("✅ BGM 完成"); break; }
          if (["failed", "fail", "error"].includes(st.status)) { log("BGM 失败，跳过"); break; }
        }
      } catch (e) { log("BGM 失败跳过: " + e.message); }
    }
    const out = await api("POST", "/api/assemble", { project, workDir: workName, bgmUrl: bgm, dialogueAudio: true });
    log(`🎉 成片: ${out.url}`);
    $("finalBox").innerHTML += `<video class="media" controls autoplay src="${esc(out.url)}" style="margin-top:14px"></video>`;
  } catch (e) {
    log("合并失败: " + e.message); alert("合并失败: " + e.message);
  }
  busy = false; $("btnAssemble2").disabled = false;
}

// ---------- 预览 ----------
function renderPreview() {
  if (!project) return;
  const shot = project.shots[currentShot];
  const el = $("preview");
  if (!shot) { el.innerHTML = '<div class="empty">-</div>'; return; }
  el.innerHTML = "";
  if (shot.image) el.innerHTML += `<img class="media" src="${esc(shot.image)}">`;
  if (shot.video) el.innerHTML += `<video class="media" controls src="${esc(shot.video)}">`;
  if (shot.audio_url && !shot.video) el.innerHTML += `<audio controls style="width:100%;margin-top:8px" src="${esc(shot.audio_url)}">`;
  if (!shot.image && !shot.video && !shot.audio_url) el.innerHTML = '<div class="empty">-</div>';
}

async function saveProject() {
  if (!project || !workName) return;
  try { await api("POST", "/api/workspace", { title: workName, project }); } catch {}
}
