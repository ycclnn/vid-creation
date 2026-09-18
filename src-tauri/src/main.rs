// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod senseaudio;

use senseaudio::{image_to_data_url, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const DEFAULT_LLM_MODEL: &str = "glm-5.3-flash";
const DEFAULT_VIDEO_MODEL: &str = "doubao-seedance-2-0-260128";
// 实测可用图片尺寸：竖=1024x1536、方=1024x1024、横=1536x1024（seedream 1:1 用 2048x2048）
const DEFAULT_IMAGE_SIZE: &str = "1024x1536";

#[derive(Serialize, Deserialize, Clone)]
struct Character {
    name: String,
    description: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    reference_images: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Project {
    title: String,
    synopsis: String,
    #[serde(default = "default_ratio")]
    ratio: String,
    #[serde(default = "default_resolution")]
    resolution: String,
    /// 动态选择的模型（留空则用上游默认；上游换模型时不需改代码）
    #[serde(default)]
    image_model: Option<String>,
    /// 实测可用：竖 1024x1536 / 方 1024x1024 / 横 1536x1024（seedream 1:1 用 2048x2048）
    #[serde(default = "default_image_size")]
    image_size: String,
    #[serde(default)]
    video_model: Option<String>,
    #[serde(default)]
    llm_model: Option<String>,
    #[serde(default)]
    generate_audio: bool,
    #[serde(default)]
    music_prompt: Option<String>,
    characters: Vec<Character>,
    /// 分镜由 LLM 生成后回填/人工编辑
    #[serde(default)]
    shots: Vec<Shot>,
}

fn default_ratio() -> String {
    "16:9".into()
}
fn default_resolution() -> String {
    "720p".into()
}
fn default_image_size() -> String {
    "1024x1536".into()
}

#[derive(Serialize, Deserialize, Clone)]
struct Shot {
    /// 画面提示词
    prompt: String,
    /// 台词（角色名 + 文本）
    #[serde(default)]
    line_character: Option<String>,
    #[serde(default)]
    line_text: Option<String>,
    /// 时长（秒），4-15
    duration: i64,
    /// 该镜分镜图路径（生成或用户指定）
    #[serde(default)]
    image: Option<String>,
    /// 该镜生成的视频路径
    #[serde(default)]
    video: Option<String>,
    /// 参考图（多张，data URL 或路径）
    #[serde(default)]
    reference_images: Vec<String>,
    /// 运行状态：pending|running|image_ready|done|failed
    #[serde(default = "default_pending")]
    status: String,
    #[serde(default)]
    error: Option<String>,
}

fn default_pending() -> String {
    "pending".into()
}

#[allow(dead_code)]
struct AppState {
    project: Mutex<Option<Project>>,
    work_dir: Mutex<Option<PathBuf>>,
}

fn client_from_env_or_config(app: &AppHandle) -> Result<Client, anyhow::Error> {
    // 优先环境变量，其次 appDataDir/config.json
    if let Ok(key) = std::env::var("SENSEAUDIO_API_KEY") {
        if !key.is_empty() {
            let base = std::env::var("SENSEAUDIO_BASE_URL").ok();
            return Ok(Client::new(key, base));
        }
    }
    let dir = app.path().app_data_dir()?;
    let cfg = dir.join("config.json");
    if cfg.exists() {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&cfg)?)?;
        if let Some(key) = v["apiKey"].as_str() {
            if !key.is_empty() {
                return Ok(Client::new(
                    key.to_string(),
                    v["baseUrl"].as_str().map(|s| s.to_string()),
                ));
            }
        }
    }
    Err(anyhow::anyhow!("未配置 SenseAudio API Key"))
}

fn save_config(app: &AppHandle, api_key: &str, base_url: Option<&str>) -> Result<(), anyhow::Error> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let mut v = json!({"apiKey": api_key});
    if let Some(b) = base_url {
        v["baseUrl"] = json!(b);
    }
    std::fs::write(dir.join("config.json"), serde_json::to_string_pretty(&v)?)?;
    Ok(())
}

fn emit(app: &AppHandle, event: &str, payload: String) {
    let _ = app.emit(event, payload);
}

// ---------- 命令 ----------

#[tauri::command]
fn set_api_key(app: AppHandle, api_key: String, base_url: Option<String>) -> Result<(), String> {
    save_config(&app, &api_key, base_url.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn has_api_key(app: AppHandle) -> Result<bool, String> {
    Ok(client_from_env_or_config(&app).is_ok())
}

#[tauri::command]
fn load_project(path: String) -> Result<Project, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_project(app: AppHandle, project: Project, path: Option<String>) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = path.unwrap_or_else(|| {
        let safe = project.title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
        dir.join(format!("projects/{safe}.json")).to_string_lossy().to_string()
    });
    if let Some(parent) = Path::new(&p).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(p)
}

/// 生成完整项目工程目录（shots/ audio/ output/）并保存 project.json
#[tauri::command]
fn create_workspace(app: AppHandle, project: Project) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let safe = project.title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let work = dir.join(format!("workspaces/{safe}"));
    for sub in ["shots", "audio", "videos", "output"] {
        std::fs::create_dir_all(work.join(sub)).map_err(|e| e.to_string())?;
    }
    let pj = work.join("project.json");
    std::fs::write(&pj, serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(work.to_string_lossy().to_string())
}

/// 动态拉取可用模型列表（上游可能经常更换，前端动态选择不写死）
#[tauri::command]
fn list_models(app: AppHandle) -> Result<Value, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    client.list_models().map_err(|e| e.to_string())
}

/// API 生成参考图（分镜图来源之一：本地文件 / AI 参考生成；prompt 可以基于上传图片的描述）
#[tauri::command]
fn generate_reference_image(
    app: AppHandle,
    prompt: String,
    model: Option<String>,
    size: Option<String>,
    out_path: String,
) -> Result<String, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let app2 = app.clone();
    client
        .image_generate(
            &prompt,
            &[],
            size.as_deref().unwrap_or("1024x1536"),
            model.as_deref(),
            Path::new(&out_path),
            &move |msg| emit(&app2, "progress", msg),
        )
        .map_err(|e| e.to_string())?;
    Ok(out_path)
}

/// 上传图片 + 描述 → AI 参考上传图生成分镜图（图片转 data URL 作为 references）
#[tauri::command]
fn generate_image_from_upload(
    app: AppHandle,
    image_paths: Vec<String>,
    prompt: String,
    model: Option<String>,
    size: Option<String>,
    out_path: String,
) -> Result<String, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let mut refs = Vec::new();
    for p in &image_paths {
        refs.push(image_to_data_url(Path::new(p)).map_err(|e| e.to_string())?);
    }
    let app2 = app.clone();
    client
        .image_generate(
            &prompt,
            &refs,
            size.as_deref().unwrap_or("1024x1536"),
            model.as_deref(),
            Path::new(&out_path),
            &move |msg| emit(&app2, "progress", msg),
        )
        .map_err(|e| e.to_string())?;
    Ok(out_path)
}

/// LLM 依据梗概与人物表生成分镜表
#[tauri::command]
fn generate_storyboard(
    app: AppHandle,
    project: Project,
    target_shots: i64,
    seconds_per_shot: i64,
) -> Result<Project, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let chars: Vec<String> = project
        .characters
        .iter()
        .map(|c| {
            format!(
                "- {}: {}（台词声音: {}）",
                c.name,
                c.description,
                c.voice.clone().unwrap_or_else(|| "默认".into())
            )
        })
        .collect();

    let system = "你是专业短片导演。根据故事梗概和人物设定输出分镜表。只输出 JSON，不要任何其他文字。";
    let prompt = format!(
        r#"故事梗概：{}
人物：
{}

请输出恰好 {} 个分镜的 JSON 数组，每个分镜对象字段：
- "prompt": 画面提示词（中文，详细描述场景、人物动作、表情、运镜、光线风格；需与前后镜头衔接）
- "line_character": 该镜台词角色名（无台词填 null）
- "line_text": 台词文本（无台词填 null；台词要口语化、简短，适合 {} 秒内的镜头）
- "duration": 时长整数秒（{} 到 15 之间）

约束：画面必须是连续叙事；人物外观严格符合人物设定；首尾帧将用于镜头衔接。输出形如 [{{...}},{{...}}]"#,
        project.synopsis,
        chars.join("\n"),
        target_shots,
        seconds_per_shot,
        seconds_per_shot
    );
    let raw = client
        .chat(
            &prompt,
            Some(system),
            project.llm_model.as_deref().unwrap_or(DEFAULT_LLM_MODEL),
        )
        .map_err(|e| e.to_string())?;
    // 从响应中提取 JSON 数组
    let start = raw.find('[').ok_or("LLM 未返回 JSON 数组")?;
    let end = raw.rfind(']').ok_or("LLM 未返回 JSON 数组结束")?;
    let shots: Vec<Shot> =
        serde_json::from_str(&raw[start..=end]).map_err(|e| format!("分镜 JSON 解析失败: {e}\n{raw}"))?;
    let mut p = project;
    p.shots = shots;
    Ok(p)
}

/// 为每镜生成人物一致的分镜图（用该镜角色的全部参考图作 references）
#[tauri::command]
fn generate_shot_images(
    app: AppHandle,
    project: Project,
    work_dir: String,
) -> Result<Project, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let work = PathBuf::from(&work_dir);
    let mut p = project.clone();
    let total = p.shots.len();
    for (i, shot) in p.shots.iter_mut().enumerate() {
        if shot.image.is_some() {
            continue; // 已有分镜图，跳过（断点续跑）
        }
        emit(&app, "progress", format!("生成分镜图 {}/{}", i + 1, total));
        // 该镜台词角色（或第一个角色）的全部参考图 → data URL
        let references: Vec<String> = p
            .characters
            .iter()
            .find(|c| Some(&c.name) == shot.line_character.as_ref())
            .or_else(|| p.characters.first())
            .map(|c| {
                c.reference_images
                    .iter()
                    .filter_map(|path| image_to_data_url(Path::new(path)).ok())
                    .collect()
            })
            .unwrap_or_default();
        let out = work.join("shots").join(format!("shot_{:03}.png", i + 1));
        let app2 = app.clone();
        client
            .image_generate(
                &shot.prompt,
                &references,
                p.image_size.as_str(),
                p.image_model.as_deref(),
                &out,
                &move |msg| emit(&app2, "progress", msg),
            )
            .map_err(|e| format!("分镜图 {}/{} 生成失败: {e}", i + 1, total))?;
        shot.image = Some(out.to_string_lossy().to_string());
    }
    Ok(p)
}

/// 合成某镜台词语音
#[tauri::command]
fn generate_dialogue_audio(
    app: AppHandle,
    project: Project,
    work_dir: String,
    shot_index: i64,
) -> Result<Option<String>, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let shot = &project.shots[shot_index as usize];
    let Some(text) = shot.line_text.clone() else {
        return Ok(None);
    };
    let voice = project
        .characters
        .iter()
        .find(|c| Some(&c.name) == shot.line_character.as_ref())
        .and_then(|c| c.voice.clone());
    let work = PathBuf::from(&work_dir);
    let out = work.join("audio").join(format!("line_{:03}.wav", shot_index + 1));
    if !out.exists() {
        client
            .tts(&text, voice.as_deref(), "wav", &out)
            .map_err(|e| format!("台词语音合成失败: {e}"))?;
    }
    Ok(Some(out.to_string_lossy().to_string()))
}

/// AI 依据大概方向 + 秒数 + 前后镜头衔接生成优化后的提示词
#[tauri::command]
fn optimize_prompt(
    app: AppHandle,
    project: Project,
    rough_prompt: String,
    duration: i64,
    shot_index: i64,
    prev_prompt: Option<String>,
    next_prompt: Option<String>,
) -> Result<String, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let model = project.llm_model.as_deref().unwrap_or(DEFAULT_LLM_MODEL);
    let system = "你是专业短片分镜师。把用户的大概画面方向优化为一段详细、可直接用于图生视频的中文提示词。只输出优化后的提示词文本，不要任何解释。";
    let prompt = format!(
        "大概画面方向：{}\n镜头时长：{} 秒\n上一镜画面：{}\n下一镜画面：{}\n\n要求：\n1. 细化场景、人物动作、表情、运镜（推/拉/摇/移）、光线风格，适配 {} 秒时长\n2. 人物外观严格符合角色设定\n3. 与上一镜/下一镜画面自然衔接\n4. 中文，100-200 字",
        rough_prompt,
        duration,
        prev_prompt.as_deref().unwrap_or("（第一镜）"),
        next_prompt.as_deref().unwrap_or("（最后一镜）"),
        duration,
    );
    client.chat(&prompt, Some(system), model).map_err(|e| e.to_string())
}

/// 生成单镜分镜图（该镜角色的全部参考图作 references；实测 async+pending 轮询链路）
#[tauri::command]
fn generate_shot_image(
    app: AppHandle,
    project: Project,
    work_dir: String,
    shot_index: i64,
    out_path: String,
) -> Result<String, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let shot = &project.shots[shot_index as usize];
    // 该镜台词角色（或第一个角色）的全部参考图 → data URL；无则直接文生图
    let references: Vec<String> = project
        .characters
        .iter()
        .find(|c| Some(&c.name) == shot.line_character.as_ref())
        .or_else(|| project.characters.first())
        .map(|c| {
            c.reference_images
                .iter()
                .filter_map(|path| image_to_data_url(Path::new(path)).ok())
                .collect()
        })
        .unwrap_or_default();
    let app2 = app.clone();
    client
        .image_generate(
            &shot.prompt,
            &references,
            project.image_size.as_str(),
            project.image_model.as_deref(),
            Path::new(&out_path),
            &move |msg| emit(&app2, "progress", msg),
        )
        .map_err(|e| e.to_string())?;
    Ok(out_path)
}

/// 生成单镜视频（首帧 = 该镜分镜图）
#[tauri::command]
fn generate_shot_video(
    app: AppHandle,
    project: Project,
    work_dir: String,
    shot_index: i64,
) -> Result<Shot, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let mut shot = project.shots[shot_index as usize].clone();
    if shot.status == "done" {
        return Ok(shot); // 断点续跑：已完成直接跳过
    }
    shot.status = "running".into();
    shot.error = None;

    let work = PathBuf::from(&work_dir);
    let image = shot
        .image
        .clone()
        .ok_or("该镜缺少分镜图，请先生成分镜图")?;
    let data_url = image_to_data_url(Path::new(&image)).map_err(|e| e.to_string())?;
    let mut content = vec![json!({"type": "text", "text": shot.prompt})];
    content.push(json!({"type": "image", "url": data_url, "role": "first_frame"}));

    emit(&app, "progress", format!("镜头 {}/{} 提交生成任务", shot_index + 1, project.shots.len()));
    let task_id = client
        .video_create(
            &json!(content),
            shot.duration,
            &project.resolution,
            &project.ratio,
            false,
            project.generate_audio,
            project.video_model.as_deref().unwrap_or(DEFAULT_VIDEO_MODEL),
        )
        .map_err(|e| format!("视频任务创建失败: {e}"))?;

    let app2 = app.clone();
    let url = client
        .video_wait(&task_id, 20, 1800, &move |msg| {
            emit(&app2, "progress", format!("镜头 {}/{}: {}", shot_index + 1, project.shots.len(), msg));
        })
        .map_err(|e| {
            shot.status = "failed".into();
            shot.error = Some(e.to_string());
            serde_json::to_string(&shot).unwrap_or_else(|_| e.to_string())
        })
        .map_err(|e| {
            // 返回带状态的 shot JSON 字符串作为错误
            e.to_string()
        })?;

    let out = work.join("videos").join(format!("shot_{:03}.mp4", shot_index + 1));
    std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = http.get(&url).send().map_err(|e| e.to_string())?.bytes().map_err(|e| e.to_string())?;
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    shot.video = Some(out.to_string_lossy().to_string());
    shot.status = "done".into();
    Ok(shot)
}

/// 生成背景音乐
#[tauri::command]
fn generate_music(app: AppHandle, prompt: String, work_dir: String) -> Result<String, String> {
    let client = client_from_env_or_config(&app).map_err(|e| e.to_string())?;
    let work = PathBuf::from(&work_dir);
    let out = work.join("audio").join("bgm.mp3");
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    let task_id = client.music_create(&prompt).map_err(|e| e.to_string())?;
    let url = client
        .music_wait(&task_id, 15, 1200)
        .map_err(|e| e.to_string())?;
    let http = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = http.get(&url).send().map_err(|e| e.to_string())?.bytes().map_err(|e| e.to_string())?;
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

/// ffmpeg 拼接：先逐镜压字幕区（可选贴台词音频），再 concat，再混 BGM。
/// 依赖打包的 ffmpeg sidecar。
#[tauri::command]
fn assemble_film(
    app: AppHandle,
    work_dir: String,
    project: Project,
    bgm_path: Option<String>,
    dialogue_audio: bool,
) -> Result<String, String> {
    let work = PathBuf::from(&work_dir);
    let ffmpeg = ffmpeg_path(&app).map_err(|e| e.to_string())?;
    let out_path = work.join("output").join("final.mp4");
    std::fs::create_dir_all(out_path.parent().unwrap()).map_err(|e| e.to_string())?;

    let videos_dir = work.join("videos");
    let mut parts: Vec<PathBuf> = Vec::new();
    for i in 0..project.shots.len() {
        let v = videos_dir.join(format!("shot_{:03}.mp4", i + 1));
        if !v.exists() {
            return Err(format!("缺少镜头视频: {}", v.display()));
        }
        parts.push(v);
    }

    // 1) 若开启台词音频：每镜若有台词音频，将音频混入该镜（视频不变，音频替换/混入）
    let mut processed: Vec<PathBuf> = Vec::new();
    for (i, v) in parts.iter().enumerate() {
        let audio = work.join("audio").join(format!("line_{:03}.wav", i + 1));
        if dialogue_audio && audio.exists() {
            let with_audio = work.join("videos").join(format!("shot_{:03}_with_audio.mp4", i + 1));
            run_ffmpeg(
                &ffmpeg,
                &[
                    "-y", "-i",
                    v.to_str().unwrap(),
                    "-i", audio.to_str().unwrap(),
                    "-filter_complex", "[1:a]apad=pad_dur=10[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
                    with_audio.to_str().unwrap(),
                ],
            )?;
            processed.push(with_audio);
        } else {
            processed.push(v.clone());
        }
    }

    // 2) concat
    let list_file = work.join("videos").join("concat.txt");
    let mut list = String::new();
    for p in &processed {
        list.push_str(&format!("file '{}'\n", p.to_str().unwrap().replace('\'', "'\\''")));
    }
    std::fs::write(&list_file, list).map_err(|e| e.to_string())?;
    let concat_out = work.join("output").join("concat.mp4");
    run_ffmpeg(
        &ffmpeg,
        &[
            "-y", "-f", "concat", "-safe", "0", "-i", list_file.to_str().unwrap(),
            "-c", "copy", concat_out.to_str().unwrap(),
        ],
    )?;

    // 3) 混 BGM（循环+淡出，压低音量）
    if let Some(bgm) = bgm_path {
        run_ffmpeg(
            &ffmpeg,
            &[
                "-y", "-i", concat_out.to_str().unwrap(), "-stream_loop", "-1", "-i", &bgm,
                "-filter_complex", "[1:a]volume=0.25[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=3[a]",
                "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-shortest",
                out_path.to_str().unwrap(),
            ],
        )?;
    } else {
        std::fs::copy(&concat_out, &out_path).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_file(&concat_out);
    Ok(out_path.to_string_lossy().to_string())
}

fn ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    // Tauri sidecar: binaries/ffmpeg[-target-triple]
    let exe = app.path().resource_dir().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    let name = "ffmpeg.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "ffmpeg";
    // sidecar 位于可执行文件同级
    let cur = std::env::current_exe().map_err(|e| e.to_string())?;
    let beside = cur.parent().unwrap().join(name);
    if beside.exists() {
        return Ok(beside);
    }
    let in_res = exe.join(name);
    if in_res.exists() {
        return Ok(in_res);
    }
    Err("未找到内置 ffmpeg sidecar".into())
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    use std::process::Command;
    let out = Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("启动 ffmpeg 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ffmpeg 失败: {}",
            String::from_utf8_lossy(&out.stderr).chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect::<String>()
        ));
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            project: Mutex::new(None),
            work_dir: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            has_api_key,
            load_project,
            save_project,
            create_workspace,
            list_models,
            generate_reference_image,
            generate_image_from_upload,
            generate_storyboard,
            optimize_prompt,
            generate_shot_image,
            generate_shot_images,
            generate_dialogue_audio,
            generate_shot_video,
            generate_music,
            assemble_film
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
