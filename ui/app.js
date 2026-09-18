// ShortFilm 前端逻辑（渐进式逐镜工作流）
const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { convertFileSrc } = window.__TAURI__.core;

let project = null;
let workDir = null;
let models = [];        // 动态模型列表
let currentShot = 0;    // 渐进式：当前编辑/生成的镜头索引

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $("log");
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
};

window.__TAURI__.event.listen("progress", (e) => log(e.payload));

// ---------- API Key ----------
$("btnKey").onclick = async () => {
  const key = prompt("请输入 SenseAudio API Key:");
  if (!key) return;
  await invoke("set_api_key", { apiKey: key, baseUrl: null });
  log("API Key 已保存");
  refreshModels();
};

(async () => {
  const ok = await invoke("has_api_key");
  if (ok) refreshModels();
  else log("未配置 API Key，请点击右上角「API Key」配置");
})();

// ---------- 模型动态选择 ----------
async function refreshModels() {
  try {
    const data = await invoke("list_models");
    models = (data.data || []).map((m) => ({ id: m.id, mode: m.mode || "" }));
    fillModelSelect("llmModel", ["llm"], "glm-5.3-flash");
    fillModelSelect("imageModel", ["image"], null);
    fillModelSelect("videoModel", ["video"], "doubao-seedance-2-0-260128");
    log(`模型列表已刷新：LLM ${models.filter((m) => m.mode === "llm").length} / 图 ${models.filter((m) => m.mode === "image").length} / 视频 ${models.filter((m) => m.mode === "video").length}`);
  } catch (e) {
    log("模型列表拉取失败（不影响用上游默认模型）: " + e);
  }
}

function fillModelSelect(selectId, modes, preferredId) {
  const el = $(selectId);
  const pool = models.filter((m) => modes.includes(m.mode));
  const extra = models.filter(
    (m) => !pool.includes(m) && modes.some((mode) => m.id.toLowerCase().includes(mode === "llm" ? "glm" : mode))
  );
  const all = [...pool, ...extra];
  el.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = all.length ? "（上游默认）" : "（留空 = 上游默认）";
  el.appendChild(def);
  all.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.id;
    el.appendChild(opt);
  });
  if (preferredId) el.value = preferredId;
}

$("btnRefreshModels").onclick = refreshModels;

// ---------- 分镜表 ----------
$("btnStoryboard").onclick = async () => {
  const characters = $("characters").value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, description, voice] = l.split("|").map((s) => s.trim());
      return {
        name: name || "角色",
        description: description || "",
        voice: voice || null,
        reference_images: [],
      };
    });

  project = {
    title: $("title").value || "我的短片",
    synopsis: $("synopsis").value,
    ratio: $("ratio").value,
    resolution: $("resolution").value,
    image_model: $("imageModel").value || null,
    image_size: $("imageSize").value,
    video_model: $("videoModel").value || null,
    llm_model: $("llmModel").value || null,
    generate_audio: false,
    music_prompt: $("music").value || null,
    characters,
    shots: [],
  };
  if (!project.synopsis) return alert("请填写故事梗概");
  if (!characters.length) return alert("请至少填写一个人物");

  $("btnStoryboard").disabled = true;
  log("正在生成分镜表……");
  try {
    project = await invoke("generate_storyboard", {
      project,
      targetShots: parseInt($("shotCount").value) || 10,
      secondsPerShot: parseInt($("shotSeconds").value) || 6,
    });
    // 每镜初始状态 pending，无分镜图
    project.shots.forEach((s) => { s.status = "pending"; });
    log(`分镜表已生成，共 ${project.shots.length} 个镜头，开始逐镜工作流`);
    workDir = await invoke("create_workspace", { project });
    log(`工作目录: ${workDir}`);
    currentShot = 0;
    renderShots();
    renderEditor();
    $("btnGenerateNext").disabled = false;
  } catch (e) {
    log("分镜生成失败: " + e);
    alert("分镜生成失败: " + e);
  }
  $("btnStoryboard").disabled = false;
};

// ---------- 镜头进度列表 ----------
function renderShots() {
  const el = $("shots");
  el.innerHTML = "";
  project.shots.forEach((shot, i) => {
    const div = document.createElement("div");
    div.className = "shot" + (i === currentShot ? " current" : "") + (i < currentShot ? " locked" : "");
    div.innerHTML = `
      <div class="head">
        <strong>#${i + 1}</strong>
        <span>${shot.duration}s</span>
        <span>${shot.line_character || "无台词"}</span>
        <span class="badge ${shot.status}">${shot.status}</span>
        <div style="flex:1"></div>
        ${i !== currentShot ? `<button class="ghost" data-goto="${i}" style="padding:2px 8px;font-size:11px">查看</button>` : ""}
      </div>
      <div class="muted" style="margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${shot.prompt || ""}</div>
    `;
    el.appendChild(div);
  });
  el.querySelectorAll("[data-goto]").forEach((b) => {
    b.onclick = () => { currentShot = +b.dataset.goto; renderShots(); renderEditor(); };
  });
}

// ---------- 当前镜头编辑器 ----------
function renderEditor() {
  const shot = project.shots[currentShot];
  if (!shot) { $("shotEditor").innerHTML = ""; return; }
  const step = $("shotStep");
  step.textContent = `#${currentShot + 1} / ${project.shots.length} · ${shot.status}`;
  const el = $("shotEditor");
  const charOptions = project.characters.map((c) => `<option value="${c.name}" ${shot.line_character === c.name ? "selected" : ""}>${c.name}</option>`).join("");
  const prevChar = currentShot > 0 ? project.shots[currentShot - 1].line_character : null;
  el.innerHTML = `
    <label>画面提示词（大概方向，点「优化提示词」由 AI 按秒数细化）</label>
    <textarea id="edPrompt" rows="3">${shot.prompt || ""}</textarea>
    <div style="margin-top:4px">
      <button class="ghost" id="btnOptimizePrompt">✨ 优化提示词</button>
      <button class="ghost" id="btnGenImage">🖼 生成本镜分镜图</button>
    </div>
    <label>分镜图 ${shot.image ? "（已生成 ✓ 可点重生成）" : "（未生成，生成视频前必须先有分镜图）"}</label>
    <div class="ref-imgs" id="edRefs">
      ${(shot.reference_images || []).map((r, i) => `<span class="tag" data-delref="${i}">${r.split(/[\\\\/]/).pop()} ✕</span>`).join("")}
      <span class="tag" id="edAddRef">+ 上传参考图</span>
    </div>
    <div class="row" style="margin-top:8px">
      <div><label>台词角色 ${prevChar ? `<span class="inherit">上一镜: ${prevChar}（默认继承）</span>` : ""}</label>
        <select id="edChar"><option value="">（无台词）</option>${charOptions}</select></div>
      <div><label>台词</label><input type="text" id="edLine" value="${shot.line_text || ""}"></div>
    </div>
    <div class="row">
      <div><label>时长（4-15s）</label><input type="text" id="edDuration" value="${shot.duration}"></div>
      <div><label>状态</label><input type="text" id="edStatus" value="${shot.status}" disabled></div>
    </div>
  `;

  $("edChar").onchange = () => { shot.line_character = $("edChar").value || null; renderShots(); };
  $("edLine").onchange = () => { shot.line_text = $("edLine").value || null; };
  $("edDuration").onchange = () => {
    const v = parseInt($("edDuration").value);
    if (v >= 4 && v <= 15) { shot.duration = v; renderShots(); }
    else alert("时长必须为 4-15 的整数");
  };
  $("edAddRef").onclick = async () => {
    const files = await open({
      multiple: true,
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }],
    });
    if (!files) return;
    const list = Array.isArray(files) ? files : [files];
    shot.reference_images = shot.reference_images || [];
    list.forEach((f) => shot.reference_images.push(f));
    renderEditor();
    log(`已添加 ${list.length} 张参考图到本镜`);
  };
  el.querySelectorAll("[data-delref]").forEach((t) => {
    t.onclick = () => { shot.reference_images.splice(+t.dataset.delref, 1); renderEditor(); };
  });
  $("btnOptimizePrompt").onclick = optimizePrompt;
  $("btnGenImage").onclick = generateShotImage;
}

// AI 依据大概方向 + 秒数优化提示词
async function optimizePrompt() {
  const shot = project.shots[currentShot];
  const rough = $("edPrompt").value.trim();
  if (!rough) return alert("请先输入大概的画面方向");
  log(`优化镜头 ${currentShot + 1} 提示词……`);
  try {
    const prev = currentShot > 0 ? project.shots[currentShot - 1].prompt : null;
    const next = currentShot < project.shots.length - 1 ? project.shots[currentShot + 1].prompt : null;
    const optimized = await invoke("optimize_prompt", {
      project,
      roughPrompt: rough,
      duration: shot.duration,
      shotIndex: currentShot,
      prevPrompt: prev,
      nextPrompt: next,
    });
    shot.prompt = optimized;
    renderEditor(); renderShots();
    log("提示词已优化");
  } catch (e) {
    log("提示词优化失败: " + e);
    alert("提示词优化失败: " + e);
  }
}

// 生成本镜分镜图（角色全部参考图作 references；继承上一镜）
async function generateShotImage() {
  const shot = project.shots[currentShot];
  if (!shot.prompt) return alert("请先填写/优化提示词");
  shot.status = "running";
  renderEditor(); renderShots();
  log(`镜头 ${currentShot + 1} 生成分镜图……`);
  try {
    const out = workDir.replace(/[\\/]$/, "") + "/shots/shot_" + String(currentShot + 1).padStart(3, "0") + ".png";
    await invoke("generate_shot_image", {
      project, workDir, shotIndex: currentShot, outPath: out,
    });
    shot.image = out;
    shot.status = "image_ready";
    renderEditor(); renderShots(); renderPreview();
    log(`镜头 ${currentShot + 1} 分镜图已生成`);
  } catch (e) {
    shot.status = "failed";
    shot.error = String(e);
    renderEditor(); renderShots();
    log(`分镜图生成失败: ${e}`);
    alert("分镜图生成失败: " + e);
  }
}

function renderPreview() {
  const shot = project.shots[currentShot];
  const el = $("shotPreview");
  el.innerHTML = "";
  if (shot.image) {
    const img = document.createElement("img");
    img.src = convertFileSrc(shot.image);
    el.appendChild(img);
  }
  if (shot.video) {
    const video = document.createElement("video");
    video.controls = true;
    video.src = convertFileSrc(shot.video);
    el.appendChild(video);
  }
  if (!shot.image && !shot.video) el.innerHTML = '<div class="muted">生成后预览分镜图 / 视频。</div>';
}

// ---------- 渐进式：生成下一镜（分镜图 → 台词语音 → 视频） ----------
$("btnGenerateNext").onclick = async () => {
  const shot = project.shots[currentShot];
  if (!shot.prompt) return alert("请先填写/优化提示词");
  if (!shot.image) return alert("请先生成本镜分镜图");
  shot.status = "running";
  renderEditor(); renderShots();
  $("btnGenerateNext").disabled = true;
  try {
    // 台词语音
    if (shot.line_text) {
      log(`镜头 ${currentShot + 1} 合成台词语音……`);
      await invoke("generate_dialogue_audio", { project, workDir, shotIndex: currentShot });
    }
    // 视频（4s 最短验证）
    log(`镜头 ${currentShot + 1} 生成视频……`);
    const out = await invoke("generate_shot_video", { project, workDir, shotIndex: currentShot });
    project.shots[currentShot] = out;
    project.shots[currentShot].video = out.image; // video 字段由后端返回
    shot.status = "done";
    renderEditor(); renderShots(); renderPreview();
    log(`镜头 ${currentShot + 1} 视频已生成，请预览确认`);
    $("btnApprove").disabled = false;
    $("btnRetry").disabled = false;
  } catch (e) {
    shot.status = "failed";
    shot.error = String(e);
    renderEditor(); renderShots();
    log(`镜头 ${currentShot + 1} 视频生成失败: ${e}`);
    alert("视频生成失败: " + e);
  }
  $("btnGenerateNext").disabled = false;
  saveProject();
};

// ---------- 通过，继续下一镜 ----------
$("btnApprove").onclick = async () => {
  if (currentShot >= project.shots.length - 1) {
    log("已是最后一镜，全部通过！可点「合并成片」");
    $("btnAssemble").disabled = false;
    $("btnApprove").disabled = true;
    $("btnGenerateNext").disabled = true;
    return;
  }
  currentShot++;
  // 默认继承上一镜的角色与参考图
  const shot = project.shots[currentShot];
  const prev = project.shots[currentShot - 1];
  if (!shot.line_character) shot.line_character = prev.line_character;
  shot.reference_images = shot.reference_images?.length ? shot.reference_images : [...(prev.reference_images || [])];
  renderEditor(); renderShots(); renderPreview();
  log(`进入镜头 ${currentShot + 1}（已继承上一镜角色与参考图）`);
  $("btnApprove").disabled = true;
  $("btnRetry").disabled = true;
};

// ---------- 重试本镜（可先改提示词/参考图/角色，重新走 分镜图→视频） ----------
$("btnRetry").onclick = async () => {
  const shot = project.shots[currentShot];
  shot.status = "pending";
  shot.image = null;
  shot.video = null;
  shot.error = null;
  renderEditor(); renderShots(); renderPreview();
  log(`镜头 ${currentShot + 1} 已重置，请修改后重新「生成下一镜」`);
  $("btnApprove").disabled = true;
  $("btnRetry").disabled = true;
  $("btnGenerateNext").disabled = false;
};

// ---------- 合并成片（全部通过后才开始 ffmpeg 汇总） ----------
$("btnAssemble").onclick = async () => {
  const notDone = project.shots.filter((s) => s.status !== "done");
  if (notDone.length) return alert(`还有 ${notDone.length} 个镜头未完成/未通过，不能合并`);
  $("btnAssemble").disabled = true;
  log("合并成片中（ffmpeg 汇总）……");
  try {
    let bgm = null;
    if (project.music_prompt) {
      log("生成背景音乐……");
      bgm = await invoke("generate_music", { prompt: project.music_prompt, workDir });
    }
    const out = await invoke("assemble_film", {
      workDir, project, bgmPath: bgm, dialogueAudio: true,
    });
    log(`成片已输出: ${out}`);
    const el = $("shotPreview");
    el.innerHTML = "";
    const video = document.createElement("video");
    video.controls = true;
    video.src = convertFileSrc(out);
    el.appendChild(video);
  } catch (e) {
    log("合并失败: " + e);
    alert("合并失败: " + e);
  }
  $("btnAssemble").disabled = false;
};

async function saveProject() {
  if (!project) return;
  await invoke("save_project", { project, path: null });
}
