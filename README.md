# ShortFilm Web · SenseAudio 短片工作台

输入故事梗概+人物 → AI 分镜 → **逐镜确认**（三要素：AI 按秒级 prompt / 分镜图 / 声音）→ 合并成片。

零依赖 Node.js Web 应用：`node server.js` 即可运行，无需构建、无需安装任何包。

## 启动

```bash
node server.js          # 默认 http://localhost:5199，自动打开浏览器
```

API Key：环境变量 `SENSEAUDIO_API_KEY`，或 UI 右上角设置（存 config.json，已 gitignore）。

## 工作流

```
① 新建项目：梗概 + 人物 → LLM 生成整个分镜表
② 每个镜头节点三要素：
   📝 画面提示词（AI 按秒级建议字数，一键优化）
   🖼 分镜图（上传原始人物图作参考 → AI 生成 first_frame）
   🔊 声音（角色绑定音色，全片一致，台词 TTS 配音）
③ 生成本镜视频（分镜图作首帧）→ 预览 → 满意点「通过」→ 下一镜（自动继承）
   不满意 → 改提示词/参考图/角色 → 「重试本镜」
④ 全部通过后「合并成片」（ffmpeg concat + 台词混音 + BGM）
```

## 实测参数（SenseAudio API）

| 能力 | 接口 | 关键参数 |
|---|---|---|
| LLM | `POST /v1/chat/completions` | |
| 图片 | `POST /v1/image/async` + `/v1/image/pending` | model 必带；size 按模型（image-2.0: 1024x1536/1024x1024/1536x1024；seedream/u1: 2048x2048）；多参考图用 `references` 数组 |
| 视频 | `POST /v1/video/create` + `GET /v1/video/status?id=` | content[] first_frame；duration 4-15 |
| TTS | `POST /v1/t2a_v2` | voice_setting.voice_id 必带（默认 female_0033_b）；响应 data.audio 为 hex |
| 音色 | `POST /v1/get_voice` | voice_type:"system" |
| 音乐 | `POST /v1/music/song/create` + pending | |

## 结构

```
shortfilm-web/
├── server.js      # 零依赖 Node 服务器：静态 UI + API 代理 + ffmpeg 拼接
├── public/        # 前端（index.html + app.js）
├── bin/ffmpeg.exe # ffmpeg（拼接用，自动查找 PATH/bin）
├── data/          # 项目与素材（gitignore）
└── config.json    # API Key（gitignore）
```
