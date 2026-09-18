# ShortFilm · SenseAudio 短片生成工具

输入**故事梗概 + 人物**，自动完成：分镜表 → 人物一致分镜图（本地参考图或 API 生成）→ Seedance 2.0 首尾帧逐镜视频 → 台词配音 → BGM → 拼接成片。

跨系统自包含分发（Tauri）：Windows / macOS / Linux 一键出包，内置 ffmpeg，对方开箱即用，只需填一个 SenseAudio API Key。

## 功能

- **模型全部动态选择**：从 `/v1/models` 实时拉取 LLM / 图片 / 视频模型，上游换模型点「刷新」即可，应用不用升级
- **分镜图两种来源**：本地图片（Midjourney/手绘等）或用图片模型按人物描述 API 生成
- **人物一致性**：分镜图生成时以角色参考图作 `reference`；视频以分镜图为 `first_frame`
- **台词配音**：每镜台词经 `/v1/t2a_v2` 合成，角色可指定音色；混入对应镜头
- **断点续跑**：每镜状态落盘，失败可单独重试，已完成的自动跳过
- **自动重试**：429/5xx 指数退避；轮询超时可重试
- **拼接**：内置 ffmpeg concat + BGM 混音（音量 0.25、循环、淡出）

## 开发

```bash
# 前置：Rust、Node.js（或纯静态 ui/ 时仅 Rust）
cargo tauri dev
```

API Key 两种配置方式：启动前设 `SENSEAUDIO_API_KEY` 环境变量，或应用内右上角「API Key」（存 appDataDir/config.json）。

## 打包与分发（手动）

> 平台硬约束：Tauri **无法在一台机器上交叉构建其他系统的安装包**（macOS 包必须在 macOS 上构建；Linux 包在 Linux/WSL）。三平台的 ffmpeg sidecar 已全部预置在 `src-tauri/binaries/`，任何一台对应系统的机器拿到仓库后可直接 build，无需再下载。

**Windows 本机（当前）：**

```powershell
.\build.ps1              # 默认出 msi + nsis
.\build.ps1 -Target msi  # 只出 msi
```

产物：`src-tauri/target/release/bundle/msi/*.msi`、`nsis/*.exe`

**macOS / Linux 机器：**

```bash
bash build.sh            # macOS 默认出 dmg/app，Linux 出 appimage/deb
```

产物：`bundle/dmg/*.dmg`（macOS）、`bundle/appimage/*.AppImage`、`deb/*.deb`（Linux）

产物自包含 ffmpeg，发给对方装完即用，只需在应用内填自己的 SenseAudio API Key。

### 各平台 ffmpeg sidecar（已全部预置）

| 平台 | 文件 |
|---|---|
| Windows x64 | `ffmpeg-x86_64-pc-windows-msvc.exe`（及 gnu 版） |
| macOS Apple Silicon | `ffmpeg-aarch64-apple-darwin` |
| macOS Intel | `ffmpeg-x86_64-apple-darwin` |
| Linux x64 | `ffmpeg-x86_64-unknown-linux-gnu` |

上游 ffmpeg 有新版本时可手动更新（下载源见 build.ps1 注释）：Windows 用 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases)，macOS 用 [evermeet.cx](https://evermeet.cx/ffmpeg/)，Linux 用 [johnvansickle static](https://johnvansickle.com/ffmpeg/)。

> 注意：分发给别人时，每人使用自己的 SenseAudio API Key（应用内配置），Key 不打包进应用。

## 短片管线的 API 对应

| 步骤 | 接口 |
|---|---|
| 分镜表 | `POST /v1/chat/completions` |
| 参考图/分镜图 | `POST /v1/image/sync`（reference 人物一致性） |
| 镜头视频 | `POST /v1/video/create`（first_frame 模式）+ `GET /v1/video/{task_id}` 轮询 |
| 台词语音 | `POST /v1/t2a_v2` |
| 背景音乐 | `POST /v1/music/song/create` + 轮询 |

约束（来自 SenseAudio 文档）：单镜 4-15s；分辨率 480p/720p/1080p；ratio 16:9/9:16/4:3/3:4/1:1；参考图 ≤30MB（支持 data URL）。

## 目录结构

```
shortfilm/
├── src-tauri/            # Rust 后端：API、轮询、重试、ffmpeg 拼接
│   ├── src/main.rs       # Tauri 命令与管线编排
│   ├── src/senseaudio.rs # SenseAudio API 封装
│   ├── binaries/         # ffmpeg sidecar（按平台手动放置）
│   └── tauri.conf.json   # externalBin: ffmpeg sidecar
└── ui/                   # 前端（纯静态，无框架）
```
