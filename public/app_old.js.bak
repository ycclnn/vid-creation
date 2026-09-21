// ShortFilm Web · 渐进式逐镜工作台
let project = null;
let workName = null;
let voices = [];
let currentShot = 0;
let busy = false; // 防并发：生成中禁止其它操作

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function log(msg) {
  const el = $("log");
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function setBusy(b) {
  busy = b;
  ["btnImage", "btnGenerate", "btnApprove", "btnRetry", "btnAssemble", "btnCreate"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = b || el.dataset.baseDisabled === "1";
  });
  renderQueue();
}

// ---------- 初始化 ----------
(async () => {
  const cfg = await api("GET", "/api/config");
  if (!cfg.hasApiKey) {
    const key = prompt("请输入 SenseAudio API Key:");
    if (key) await api("POST", "/api/config", { apiKey: key });
  }
  await refreshModels();
  refreshVoices();
  await refreshProjectList();
})();

$("btnKey").onclick = async () => {
  const key = prompt("请输入 SenseAudio API Key:");
  if (!key) return;
  await api("POST", "/api/config", { apiKey: key });
  log("API Key 已保存");
  refreshModels(); refreshVoices();
};

// ---------- 模型/音色/尺寸（实测矩阵联动） ----------
let models = [];
const SIZE_MATRIX = {
  seedream: ["2048x2048"],
  u1: ["2048x2048"],
  default: ["1024x1536", "1024x1024", "1536x1024"], // 竖屏优先
};
function sizesFor(model) {
  return model.includes("seedream") || model.includes("u1") ? SIZE_MATRIX.seedream : SIZE_MATRIX.default;
}
async function refreshModels() {
  try {
    const data = await api("GET", "/api/models");
    models = data.data || [];
    const by = (mode) => [...new Set(models.filter((m) => m.mode === mode).map((m) => m.id))];
    fillSelect("llmModel", by("llm"), "glm-5.3-flash");
    fillSelect("imageModel", by("image"), "senseaudio-image-2.0-260319");
    fillSelect("videoModel", by("video"), "doubao-seedance-2-0-260128");
    syncSizes();
    log(`模型：LLM ${by("llm").length} / 图 ${by("image").length} / 视频 ${by("video").length}`);
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
  const sizes = sizesFor($("imageModel").value);
  el.innerHTML = "";
  sizes.forEach((s) => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s === "1024x1536" ? s + " 竖" : s === "1536x1024" ? s + " 横" : s;
    el.appendChild(o);
  });
  el.value = sizes[0];
}
$("imageModel").addEventListener("change", syncSizes);

async function refreshVoices() {
  try {
    voices = await api("POST", "/api/voices");
    renderCharPanel();
  } catch (e) { log("音色失败: " + e.message); }
}

// ---------- 项目创建 ----------
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
    ratio: $("ratio").value,
    resolution: $("resolution").value,
    image_model: $("imageModel").value,
    image_size: $("imageSize").value,
    video_model: $("videoModel").value,
    llm_model: $("llmModel").value,
    music_prompt: $("music").value || null,
    shots: [],
  };
  setBusy(true);
  log("生成分镜表……");
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
    log(`分镜表 ${project.shots.length} 镜已生成，项目「${workName}」`);
    $("projName").textContent = "📁 " + workName;
    currentShot = 0;
    renderAll();
    await refreshProjectList();
  } catch (err) {
    log("分镜失败: " + err.message);
    alert("分镜失败: " + err.message);
  }
  setBusy(false);
};

async function refreshProjectList() {
  try {
    const list = await api("GET", "/api/projects");
    const el = $("projectList");
    el.innerHTML = "";
    if (!list.length) { el.textContent = "暂无项目"; return; }
    list.forEach((p) => {
      const div = document.createElement("div");
      div.className = "charline";
      div.innerHTML = `<span style="flex:1">📁 ${esc(p.title)}（${p.shots}镜）</span>`;
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
    renderAll();
    log(`已打开项目「${name}」`);
  } catch (e) { alert("打开失败: " + e.message); }
}

// ---------- 人物与声音 ----------
function renderCharPanel() {
  const el = $("charPanel");
  if (!project) { el.innerHTML = '<div class="muted">-</div>'; return; }
  el.innerHTML = "";
  project.characters.forEach((c, i) => {
    const div = document.createElement("div");
    div.className = "shotcard";
    div.innerHTML = `
      <div class="head"><strong>🎭 ${esc(c.name)}</strong>
        <span class="badge ${c.image ? "b-approved" : "b-pending"}">${c.image ? "人物图 ✓" : "无人物图"}</span>
        <div style="flex:1"></div>
        <button class="ghost sm" data-genchar="${i}">生成人物图</button>
      </div>
      <div class="muted" style="margin-top:4px">${esc(c.description)}</div>
      <label style="margin-top:6px">声音（全片一致）</label>
      <select data-voice="${i}">
        <option value="">female_0033_b（默认）</option>
        ${voices.map((v) => `<option value="${esc(v.voice_id)}" ${c.voice === v.voice_id ? "selected" : ""}>${esc(v.voice_name)}（${esc(v.voice_id)}）</option>`).join("")}
      </select>
      ${c.image ? `<img class="media" src="${esc(c.image)}">` : ""}
    `;
    el.appendChild(div);
  });
  el.querySelectorAll("[data-voice]").forEach((s) => {
    s.onchange = async () => { project.characters[+s.dataset.voice].voice = s.value || null; await saveProject(); };
  });
  el.querySelectorAll("[data-genchar]").forEach((b) => {
    b.onclick = () => genCharImage(+b.dataset.genchar);
  });
}

async function genCharImage(i) {
  if (busy) return;
  const c = project.characters[i];
  setBusy(true);
  log(`生成「${c.name}」人物图……`);
  try {
    const data = await api("POST", "/api/image", {
      prompt: `${c.description}，单人全身立绘，干净纯色背景，写实电影风格，正面视角，细节丰富`,
      model: project.image_model, size: project.image_size,
    });
    const url = await pollImage(data.task_id);
    const saved = await api("POST", "/api/save-asset", { url, relPath: `${workName}/shots/char_${encodeURIComponent(c.name)}.png` });
    c.image = saved.url;
    // 人物图自动加入该角色所有未生成的镜头参考图
    project.shots.forEach((sh) => {
      if (sh.status === "pending" && sh.line_character === c.name) {
        sh.reference_images = sh.reference_images || [];
        if (!sh.reference_images.includes(saved.url)) sh.reference_images.push(saved.url);
      }
    });
    renderCharPanel(); renderEditor(); renderPreview();
    log(`「${c.name}」人物图已生成`);
    await saveProject();
  } catch (e) {
    log("人物图失败: " + e.message); alert("人物图失败: " + e.message);
  }
  setBusy(false);
}

// ---------- 镜头队列 ----------
function renderQueue() {
  const el = $("queue");
  if (!project) { el.innerHTML = '<div class="muted">-</div>'; return; }
  el.innerHTML = "";
  const done = project.shots.filter((s) => s.status === "approved").length;
  $("queueStat").textContent = `${done}/${project.shots.length} 已通过`;
  project.shots.forEach((shot, i) => {
    const div = document.createElement("div");
    div.className = "shotcard" + (i === currentShot ? " current" : "") + (shot.status === "approved" ? " approved" : "");
    div.innerHTML = `
      <div class="head"><strong>#${i + 1}</strong>
        <span class="badge b-${esc(shot.status)}">${shot.status === "approved" ? "已通过 ✓" : esc(shot.status)}</span>
        <span>${shot.duration}s</span>
        <span>${esc(shot.line_character || "")}</span>
        <div style="flex:1"></div>
        ${shot.video ? '<span class="muted">🎬</span>' : ""}
        ${shot.image ? '<span class="muted">🖼</span>' : ""}
      </div>
      <div class="muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shot.prompt || "")}</div>`;
    div.onclick = () => { if (!busy) { currentShot = i; renderAll(); } };
    el.appendChild(div);
  });
}

// ---------- 编辑器：每个镜头节点三要素（prompt / 分镜图 / 声音） ----------
function renderEditor() {
  const shot = project.shots[currentShot];
  if (!shot) { $("editor").innerHTML = '<div class="muted">-</div>'; return; }
  const stepEl = $("shotStep");
  stepEl.className = "badge b-" + shot.status;
  stepEl.textContent = `#${currentShot + 1}/${project.shots.length} · ${shot.status}`;
  const charOpts = project.characters.map((c) => `<option value="${esc(c.name)}" ${shot.line_character === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const prev = currentShot > 0 ? project.shots[currentShot - 1] : null;
  const isApproved = shot.status === "approved";
  const boundChar = project.characters.find((c) => c.name === shot.line_character);
  const charVoice = boundChar?.voice;
  const voiceName = charVoice ? (voices.find((v) => v.voice_id === charVoice)?.voice_name || charVoice) : "female_0033_b（默认）";
  const charImage = boundChar?.image;
  // AI 按秒数建议的文本量
  const secHint = shot.duration <= 5 ? "约 40-60 字（短镜聚焦单一动作）" : shot.duration <= 9 ? "约 70-110 字（含运镜与表情）" : "约 110-160 字（完整动作+氛围）";
  $("editor").innerHTML = `
    <div class="tri">
      <div class="element">
        <div class="el-title">📝 要素 1 · 画面提示词 <span class="muted">秒级建议：${secHint}</span></div>
        <textarea id="edPrompt" rows="4">${esc(shot.prompt || "")}</textarea>
        <div style="margin-top:6px">
          <button class="ghost sm" id="btnOpt">✨ AI 按秒数优化</button>
          <button class="ghost sm" id="btnAddRef">+ 上传原始人物图</button>
          ${prev?.image ? `<button class="ghost sm" id="btnInherit">↳ 引用上一镜画面</button>` : ""}
        </div>
        <div class="ref-tags" id="edRefs">
          ${(shot.reference_images || []).map((r, i) => `<span class="tag" data-del="${i}">参考${i + 1}${r.startsWith("data:") ? "（上传）" : ""} ✕</span>`).join("")}
          ${(shot.reference_images || []).length === 0 ? '<span class="muted">无参考图 → 直接文生图</span>' : ""}
        </div>
      </div>
      <div class="element">
        <div class="el-title">🖼 要素 2 · 分镜图（first_frame）</div>
        ${shot.image
          ? `<img class="media" src="${esc(shot.image)}">`
          : `<div class="placeholder">未生成分镜图</div>`}
        <div style="margin-top:8px">
          <button id="btnImage" class="sm" ${isApproved ? "disabled" : ""}>${shot.image ? "🔄 重新生成分镜图" : "🖼 生成本镜分镜图"}</button>
        </div>
        ${charImage && !(shot.reference_images || []).length ? `<div class="muted" style="margin-top:6px">💡 角色「${esc(shot.line_character || "")}」已有人物图，建议先上传或引用以保持人物一致</div>` : ""}
      </div>
      <div class="element">
        <div class="el-title">🔊 要素 3 · 声音</div>
        <label>台词角色</label>
        <select id="edChar"><option value="">（无台词）</option>${charOpts}</select>
        <label>台词</label>
        <input type="text" id="edLine" value="${esc(shot.line_text || "")}" placeholder="本镜台词">
        <label>角色声音 <span class="muted">全片一致</span></label>
        <input type="text" value="${esc(voiceName)}" disabled>
        ${shot.audio_url ? '<audio controls style="width:100%;margin-top:6px" src="' + esc(shot.audio_url) + '"></audio>' : ""}
        <div class="row" style="margin-top:8px">
          <div><label>时长 4-15s</label><input type="text" id="edDur" value="${shot.duration}"></div>
          <div><label>状态</label><input type="text" value="${esc(shot.status)}" disabled></div>
        </div>
      </div>
    </div>
    <hr class="sep">
    <div>
      <button id="btnGenerate" class="success" ${isApproved || !shot.image ? "disabled" : ""}>🎬 生成视频（分镜图作首帧）</button>
      <button id="btnApprove" class="success" ${shot.video ? "" : "disabled"}>✓ 通过 → 下一镜</button>
      <button id="btnRetry" class="warn" ${shot.status === "pending" ? "disabled" : ""}>🔄 重试本镜</button>
      ${shot.video ? `<button class="ghost sm" id="btnPlayFull">▶ 大屏预览</button>` : ""}
    </div>
    ${shot.error ? `<div class="muted" style="color:var(--red);margin-top:6px">✗ ${esc(shot.error)}</div>` : ""}
  `;
  $("edChar").onchange = () => { shot.line_character = $("edChar").value || null; renderEditor(); renderQueue(); renderCharPanel(); saveProject(); };
  $("edLine").onchange = () => { shot.line_text = $("edLine").value || null; saveProject(); };
  $("edDur").onchange = () => {
    const v = parseInt($("edDur").value);
    if (v >= 4 && v <= 15) { shot.duration = v; renderQueue(); saveProject(); }
    else alert("时长 4-15 整数");
  };
  $("edPrompt").onchange = () => { shot.prompt = $("edPrompt").value; saveProject(); };
  $("btnOpt").onclick = optimizePrompt;
  $("btnAddRef").onclick = addRef;
  $("btnImage").onclick = generateShotImage;
  $("btnGenerate").onclick = generateShotVideo;
  $("btnApprove").onclick = approveShot;
  $("btnRetry").onclick = retryShot;
  const play = $("btnPlayFull");
  if (play) play.onclick = () => { $("preview").innerHTML = `<video class="media" controls src="${esc(shot.video)}">`; };
  const inh = $("btnInherit");
  if (inh) inh.onclick = () => {
    shot.reference_images = shot.reference_images || [];
    if (!shot.reference_images.includes(prev.image)) shot.reference_images.push(prev.image);
    renderEditor(); saveProject();
    log("已引用上一镜画面作参考");
  };
  $("editor").querySelectorAll("[data-del]").forEach((t) => {
    t.onclick = () => { shot.reference_images.splice(+t.dataset.del, 1); renderEditor(); };
  });
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
    log(`✅ 镜头 ${currentShot} 已通过，进入镜头 ${currentShot + 1}（已继承）`);
  } else {
    log("✅ 最后一镜已通过！可点「合并成片」");
  }
  renderAll();
  $("btnAssemble").disabled = !project.shots.every((s) => s.status === "approved");
}

async function retryShot() {
  if (busy) return;
  const shot = project.shots[currentShot];
  shot.status = "pending"; shot.image = null; shot.video = null; shot.error = null; shot.audio_url = null;
  renderAll();
  $("btnAssemble").disabled = true;
  log(`镜头 ${currentShot + 1} 已重置`);
  saveProject();
}

async function optimizePrompt() {
  const shot = project.shots[currentShot];
  const rough = $("edPrompt").value.trim();
  if (!rough) return alert("先输入大概方向");
  setBusy(true);
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
    log("提示词已优化");
  } catch (e) { log("优化失败: " + e.message); alert("优化失败: " + e.message); }
  setBusy(false);
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

// 轮询图片任务
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
  setBusy(true);
  shot.status = "running"; renderQueue(); renderEditor();
  log(`镜头 ${currentShot + 1} 生成分镜图……`);
  try {
    const data = await api("POST", "/api/image", {
      prompt: shot.prompt, model: project.image_model, size: project.image_size,
      references: shot.reference_images || [],
    });
    const url = await pollImage(data.task_id);
    const saved = await api("POST", "/api/save-asset", { url, relPath: `${workName}/shots/shot_${String(currentShot + 1).padStart(3, "0")}.png` });
    shot.image = saved.url;
    shot.status = "image_ready";
    renderAll();
    $("btnGenerate").dataset.baseDisabled = "0";
    $("btnGenerate").disabled = false;
    log(`镜头 ${currentShot + 1} 分镜图完成`);
    await saveProject();
  } catch (e) {
    shot.status = "failed"; shot.error = e.message;
    renderAll(); log("分镜图失败: " + e.message); alert("分镜图失败: " + e.message);
  }
  setBusy(false);
}

async function generateShotVideo() {
  if (busy) return;
  const shot = project.shots[currentShot];
  if (!shot.image) return alert("请先生成分镜图");
  setBusy(true);
  shot.status = "running"; shot.error = null; renderQueue(); renderEditor();
  try {
    // 1) 台词语音
    if (shot.line_text && shot.line_character) {
      const c = project.characters.find((c) => c.name === shot.line_character);
      log("合成台词语音……");
      const tts = await api("POST", "/api/tts", { text: shot.line_text, voice_id: c?.voice });
      shot.audio_url = tts.url;
    }
    // 2) 分镜图转 data URL 作 first_frame
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
    shot.status = "image_ready"; // 等待用户确认
    renderAll(); renderPreview();
    $("preview").innerHTML = `<video class="media" controls autoplay src="${esc(shot.video)}">`;
    log(`镜头 ${currentShot + 1} 视频完成，请预览确认`);
    await saveProject();
  } catch (e) {
    shot.status = "failed"; shot.error = e.message;
    renderAll(); log("视频失败: " + e.message); alert("视频失败: " + e.message);
  }
  setBusy(false);
}

// ---------- 合并 ----------
$("btnAssemble").onclick = async () => {
  if (busy) return;
  const notDone = project.shots.filter((s) => s.status !== "approved");
  if (notDone.length) return alert(`还有 ${notDone.length} 镜未通过`);
  setBusy(true);
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
          if (["completed", "success", "succeeded"].includes(st.status)) { bgm = st.url; log("BGM 完成"); break; }
          if (["failed", "fail", "error"].includes(st.status)) { log("BGM 失败，跳过"); break; }
        }
      } catch (e) { log("BGM 失败跳过: " + e.message); }
    }
    const out = await api("POST", "/api/assemble", { project, workDir: workName, bgmUrl: bgm, dialogueAudio: true });
    log(`🎉 成片: ${out.url}`);
    $("preview").innerHTML = `<video class="media" controls autoplay src="${esc(out.url)}">`;
  } catch (e) {
    log("合并失败: " + e.message); alert("合并失败: " + e.message);
  }
  setBusy(false);
};

// ---------- 预览 ----------
function renderPreview() {
  const shot = project.shots[currentShot];
  const el = $("preview");
  if (!shot) { el.innerHTML = '<div class="muted">-</div>'; return; }
  el.innerHTML = "";
  if (shot.image) { const i = document.createElement("img"); i.className = "media"; i.src = shot.image; el.appendChild(i); }
  if (shot.video) { const v = document.createElement("video"); v.className = "media"; v.controls = true; v.src = shot.video; el.appendChild(v); }
  if (shot.audio_url && !shot.video) { const a = document.createElement("audio"); a.controls = true; a.src = shot.audio_url; el.appendChild(a); }
  if (!shot.image && !shot.video && !shot.audio_url) el.innerHTML = '<div class="muted">-</div>';
}

function renderAll() {
  renderQueue(); renderEditor(); renderPreview(); renderCharPanel();
  // 按钮状态
  const shot = project?.shots?.[currentShot];
  if (shot) {
    $("btnImage").disabled = busy || shot.status === "approved";
    $("btnGenerate").disabled = busy || !shot.image || shot.status === "approved";
    $("btnApprove").disabled = busy || !shot.video || shot.status === "approved";
    const allApproved = project.shots.every((s) => s.status === "approved");
    $("btnAssemble").disabled = busy || !allApproved;
  }
}

async function saveProject() {
  if (!project || !workName) return;
  try { await api("POST", "/api/workspace", { title: workName, project }); } catch {}
}
