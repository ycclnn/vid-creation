// ShortFilm 前端逻辑（通过 withGlobalTauri 使用 window.__TAURI__）
const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { convertFileSrc } = window.__TAURI__.core;

let project = null;
let workDir = null;
let refImages = []; // [{name, path}]
let models = [];    // 动态模型列表 [{id, mode}]

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
};

(async () => {
  const ok = await invoke("has_api_key");
  if (!ok) {
    log("未配置 API Key，请点击右上角「API Key」配置");
  }
})();

// ---------- 模型动态选择 ----------
async function refreshModels() {
  try {
    const data = await invoke("list_models");
    models = (data.data || []).map((m) => ({ id: m.id, mode: m.mode || "", desc: m.desc || "" }));
    fillModelSelect("llmModel", ["llm"], "glm-5.3-flash");
    fillModelSelect("imageModel", ["image"], null);
    fillModelSelect("videoModel", ["video"], "doubao-seedance-2-0-260128");
    log(`模型列表已刷新：共 ${models.length} 个（LLM ${models.filter((m) => m.mode === "llm").length} / 图 ${models.filter((m) => m.mode === "image").length} / 视频 ${models.filter((m) => m.mode === "video").length}）`);
  } catch (e) {
    log("模型列表拉取失败（可稍后重试，不影响用上游默认模型）: " + e);
  }
}

function fillModelSelect(selectId, modes, preferredId) {
  const el = $(selectId);
  const pool = models.filter((m) => modes.includes(m.mode));
  // 兼容 mode 缺失时按 id 关键字匹配
  const extra = models.filter(
    (m) => !pool.includes(m) && modes.some((mode) => m.id.toLowerCase().includes(mode === "llm" ? "glm" : mode))
  );
  const all = [...pool, ...extra];
  el.innerHTML = "";
  if (!all.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "（留空 = 上游默认）";
    el.appendChild(opt);
    return;
  }
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "（上游默认）";
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
refreshModels();

// ---------- 参考图：本地 + API 生成两种方式 ----------
$("btnGenRef").onclick = () => {
  $("genRefPanel").style.display = $("genRefPanel").style.display === "none" ? "block" : "none";
};

$("btnDoGenRef").onclick = async () => {
  const prompt = $("genRefPrompt").value.trim();
  const name = $("genRefName").value.trim() || (project?.characters?.[0]?.name ?? "");
  if (!prompt) return alert("请填写人物描述");
  if (!workDir) return alert("请先点击「生成分镜」创建工作目录");
  $("btnDoGenRef").disabled = true;
  log(`API 生成 ${name} 的参考图……`);
  try {
    const out = workDir.replace(/[\\/]$/, "") + "/shots/ref_" + name.replace(/[^\\w\u4e00-\u9fa5]/g, "_") + ".png";
    await invoke("generate_reference_image", {
      prompt,
      model: $("imageModel").value || null,
      size: $("imageSize").value,
      outPath: out,
    });
    refImages.push({ name, path: out });
    renderRefImages();
    log(`参考图已生成: ${out}`);
    $("genRefPanel").style.display = "none";
  } catch (e) {
    log("参考图生成失败: " + e);
    alert("参考图生成失败: " + e);
  }
  $("btnDoGenRef").disabled = false;
};
$("btnAddRef").onclick = async () => {
  const file = await open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp"] }],
  });
  if (!file) return;
  const name = prompt("这张参考图对应哪个角色名？（需与人物表中的名字一致）", project?.characters?.[0]?.name || "");
  if (!name) return;
  refImages.push({ name, path: file });
  renderRefImages();
  log(`已添加 ${name} 的参考图: ${file}`);
};

function renderRefImages() {
  const el = $("refImages");
  el.innerHTML = "";
  refImages.forEach((r, i) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `${r.name}: ${r.path.split(/[\\/]/).pop()} ✕`;
    tag.onclick = () => { refImages.splice(i, 1); renderRefImages(); };
    el.appendChild(tag);
  });
}

// ---------- 分镜 ----------
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
        reference_images: refImages.filter((r) => r.name === name).map((r) => r.path),
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
    log(`分镜表已生成，共 ${project.shots.length} 个镜头`);
    workDir = await invoke("create_workspace", { project });
    log(`工作目录: ${workDir}`);
    renderShots();
    $("btnImages").disabled = false;
  } catch (e) {
    log("分镜生成失败: " + e);
    alert("分镜生成失败: " + e);
  }
  $("btnStoryboard").disabled = false;
};

function renderShots() {
  const el = $("shots");
  el.innerHTML = "";
  project.shots.forEach((shot, i) => {
    const div = document.createElement("div");
    div.className = "shot";
    div.innerHTML = `
      <div class="head">
        <strong>#${i + 1}</strong>
        <span>${shot.duration}s</span>
        <span class="badge ${shot.status || "pending"}">${shot.status || "pending"}</span>
        <div style="flex:1"></div>
        <button class="ghost" data-retry="${i}" style="padding:2px 8px;font-size:11px">重试</button>
      </div>
      <label>画面提示词</label>
      <textarea data-prompt="${i}" rows="2">${shot.prompt || ""}</textarea>
      <div class="row">
        <div><label>台词角色</label><input type="text" data-char="${i}" value="${shot.line_character || ""}"></div>
        <div><label>台词</label><input type="text" data-line="${i}" value="${shot.line_text || ""}"></div>
      </div>
      ${shot.error ? `<div class="muted" style="color:#d64545;margin-top:4px">${shot.error}</div>` : ""}
    `;
    el.appendChild(div);
  });
  el.querySelectorAll("[data-prompt]").forEach((t) => {
    t.onchange = () => { project.shots[+t.dataset.prompt].prompt = t.value; };
  });
  el.querySelectorAll("[data-char]").forEach((t) => {
    t.onchange = () => { project.shots[+t.dataset.char].line_character = t.value || null; };
  });
  el.querySelectorAll("[data-line]").forEach((t) => {
    t.onchange = () => { project.shots[+t.dataset.line].line_text = t.value || null; };
  });
  el.querySelectorAll("[data-retry]").forEach((b) => {
    b.onclick = () => retryShot(+b.dataset.retry);
  });
}

async function saveProject() {
  if (!project) return;
  await invoke("save_project", { project, path: null });
}

// ---------- 分镜图 ----------
$("btnImages").onclick = async () => {
  $("btnImages").disabled = true;
  log("开始生成分镜图……");
  try {
    project = await invoke("generate_shot_images", { project, workDir });
    log("全部分镜图已生成");
    renderShots();
    $("btnVideos").disabled = false;
  } catch (e) {
    log("分镜图生成失败: " + e);
    alert("分镜图生成失败: " + e);
  }
  $("btnImages").disabled = false;
};

// ---------- 镜头视频（逐镜，含台词音频） ----------
$("btnVideos").onclick = async () => {
  $("btnVideos").disabled = true;
  try {
    for (let i = 0; i < project.shots.length; i++) {
      if (project.shots[i].status === "done") continue;
      // 台词语音
      const audio = await invoke("generate_dialogue_audio", { project, workDir, shotIndex: i });
      if (audio) log(`镜头 ${i + 1} 台词语音已生成`);
      // 视频
      log(`镜头 ${i + 1}/${project.shots.length} 开始生成视频……`);
      try {
        const shot = await invoke("generate_shot_video", { project, workDir, shotIndex: i });
        project.shots[i] = shot;
        renderShots();
      } catch (e) {
        // 失败时后端返回带状态的 shot JSON
        try {
          const shot = JSON.parse(e);
          if (shot.status) { project.shots[i] = shot; renderShots(); }
        } catch (_) {}
        log(`镜头 ${i + 1} 生成失败: ${e}`);
      }
      await saveProject();
    }
    log("全部镜头生成结束（失败镜头可点重试）");
    $("btnAssemble").disabled = false;
  } finally {
    $("btnVideos").disabled = false;
  }
};

async function retryShot(i) {
  log(`重试镜头 ${i + 1}……`);
  try {
    const audio = await invoke("generate_dialogue_audio", { project, workDir, shotIndex: i });
    if (audio) log(`镜头 ${i + 1} 台词语音已生成`);
    const shot = await invoke("generate_shot_video", { project, workDir, shotIndex: i });
    project.shots[i] = shot;
    renderShots();
    log(`镜头 ${i + 1} 生成成功`);
  } catch (e) {
    log(`镜头 ${i + 1} 重试失败: ${e}`);
    alert("重试失败: " + e);
  }
}

// ---------- 拼接 ----------
$("btnAssemble").onclick = async () => {
  $("btnAssemble").disabled = true;
  log("拼接成片中……");
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
    const video = document.createElement("video");
    video.controls = true;
    video.src = convertFileSrc(out);
    const result = $("result");
    result.querySelector("video")?.remove();
    result.appendChild(video);
  } catch (e) {
    log("拼接失败: " + e);
    alert("拼接失败: " + e);
  }
  $("btnAssemble").disabled = false;
};
