# dsh-explainer-video

DeepSeek Harness（DSH）的**矢量科普视频**插件。

输入一个提示词和素材（PDF / PPTX / DOCX / 文本 / 视频 / 图片），插件会：

1. 解析素材，提取文字、页码/段落定位、图片资产；
2. 按需联网补充资料（引用以素材为主，联网为辅助）；
3. 默认使用**当前会话主模型**生成受约束的 `storyboard.json`；
4. 从可配置的 OpenAI 兼容 `/v1/audio/speech` 端点合成旁白，音色从 **Qwen3-TTS CustomVoice 的 9 个预置角色**中选择；
5. 用程序化 SVG 渲染矢量画面（图表、图标、时间轴、图片）；
6. 用 ffmpeg 合成 H.264 + AAC 的 MP4。

它**不是**文生视频模型：画面由内置布局/图标/图表/动效引擎确定性地生成，因此可复现、可编辑、可重渲染。

---

## 安装

```bash
pnpm add github:fred-chen/dsh-explainer-video#v0.1.0
```

或在 DSH 的插件市场中安装。

插件包会通过 `cordis.patch.yml` 注册：

- 设置页：`Plugins → dsh-explainer-video`
- 工具：`explainer_video_generate`、`explainer_video_render`
- 设置桥：`/api/dsh-explainer-video/{config,save,test}`
- 视频/预览流：`/api/dsh-explainer-video/artifacts/<token>`

> `sharp` 是唯一运行时 npm 依赖。ffmpeg/ffprobe 需要在本机可用；PDF/Office 解析还需要 `python3` 及 PyMuPDF / python-pptx / python-docx（缺失时会尝试 stdlib zip+XML fallback）。

---

## 快速使用

```text
生成一个 3 分钟的中文矢量科普视频，主题是“中国 AI 泡沫破裂后 GPU 租金为什么没有大跌”，
面向普通科技观众，风格接近暗色霓虹信息图，引用我提供的 PDF 和 PPT。
```

工具调用示例：

```json
{
  "prompt": "生成 3 分钟中文科普视频：GPU 租金为什么没有大跌？面向普通科技观众。",
  "materials": [
    "/path/to/report.pdf",
    "/path/to/deck.pptx"
  ],
  "durationSec": 180,
  "style": "dark-neon",
  "voice": "uncle_fu",
  "webMode": "auto"
}
```

先只看分镜和预览图：

```json
{
  "prompt": "同上",
  "materials": ["/path/to/report.pdf"],
  "planOnly": true
}
```

编辑 `storyboard.json` 后重渲染（不重新生成脚本、不重新配音）：

```json
{
  "storyboardPath": ".dsh-explainer-video/job-.../storyboard.json",
  "voice": "dylan"
}
```

---

## LLM 路由

默认行为：

- `llmProvider`、`llmModel` **留空** → 使用当前 Agent 会话主模型（`exec.agent.options.provider/model`）。
- 设置页可以覆盖 provider/model，适合把“写脚本”交给更便宜或更擅长中文的模型。

生成过程分两步：

1. `extractEvidence`：把素材笔记压缩成事实卡（带 `sourceId`，不编造引用）；
2. `generateStoryboard`：输出严格 JSON 的分镜，含 `narration`、`ttsText`、`elements`、`sourceIds`。

`storyboard.json` 会经过校验：布局、图标名、图表值、图片 `assetId`、引用 ID、时长/帧率等。校验失败会中止并保留原始响应，便于排查。

---

## TTS：端点可配置 + 预置角色

默认对齐 `dsh-tts`：

| 项 | 默认 |
|---|---|
| 端点 | `http://ai4090:8080/v1/audio` |
| 模型 | `Qwen3-TTS-12Hz-1.7B-CustomVoice` |
| 音色 | `uncle_fu` |
| 格式 | `wav` |
| 采样率 | 0（服务端原生） |

端点支持这些写法，插件会归一化到 `/v1/audio`：

- `http://host:8080`
- `http://host:8080/v1`
- `http://host:8080/v1/audio`
- `http://host:8080/v1/audio/speech`

CustomVoice 的 9 个预置角色：

| id | 描述 |
|---|---|
| `uncle_fu` | 低沉醇厚成熟男声（中文） |
| `dylan` | 清亮北京年轻男声（中文·北京） |
| `eric` | 沙哑明亮成都男声（中文·四川） |
| `vivian` | 明亮微锋锐年轻女声（中文） |
| `serena` | 温暖柔和年轻女声（中文） |
| `ryan` | 节奏感动态男声（英文） |
| `aiden` | 阳光美式男声（英文） |
| `ono_anna` | 轻快俏皮女声（日语） |
| `sohee` | 温暖情感丰富女声（韩语） |

运行时会读取 `/v1/audio/voices?model=...`，把服务端实际可用音色与预置列表合并校验；如果传了 `Cherry` 这类不存在角色，会返回明确错误并列出可用值，而不是静默失败。

使用 `Qwen3-TTS-12Hz-1.7B-VoiceDesign` 时，`voice` 可以填自由音色描述，例如“一位低沉沙哑的中年男声，语速偏慢”。

配音参数：

- `ttsLanguage`：留空自动；也可指定 `Chinese` / `English` / `Japanese` / `Korean`；
- `ttsInstructions`：情绪、语速、风格，例如“沉稳、清晰、纪录片式旁白，语速适中”；
- `ttsApiKey`：secret 字段，只存设置，不回传明文；
- `ttsFormat`、`ttsSampleRate`、`ttsTimeoutSec`、`ttsExtraParams` 均可在设置页调整。

每个场景独立合成，按场景边界对齐帧；音频缓存键包含端点、模型、音色、语言、指令、格式、采样率和文本，改参数不会误用旧缓存。

---

## 联网补资料

`webMode`：

- `auto`（默认）：素材足够时通常不搜；需要补充/对照时才搜；
- `off`：只用素材；
- `always`：强制检索。

流程：

1. LLM 先看素材事实卡，给出最多 6 条检索 query 和检索理由；
2. 插件调用宿主 `ctx.web` 搜索并抓取页面；
3. 清洗成笔记，记录 URL、标题、日期；
4. 生成分镜时把联网笔记作为辅助证据，并要求 `sourceIds` 引用已有 ID；
5. 输出 `web-research.json`；画面右下角标注 `source: src1, web2`，片尾 references 列出完整 URL。

**引用主要来自素材**；联网内容用于补充和核对，不做逐条事实审计。宿主没有配置 web provider 时，会给出 warning 并继续用素材生成。

---

## 画面与渲染

`storyboard.json` 是语义结构，不是逐帧 SVG：

```json
{
  "version": 1,
  "title": "GPU 租金为什么没有大跌",
  "language": "zh",
  "style": "dark-neon",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "references": [{ "id": "src1", "kind": "file", "label": "报告.pdf p.3" }],
  "chapters": [{ "id": "ch1", "title": "先看结论" }],
  "scenes": [
    {
      "id": "s01",
      "chapterId": "ch1",
      "layout": "hero",
      "kicker": "STAR 50",
      "headline": "中国 AI 泡沫刚刚破裂",
      "subhead": "估值修正，不是算力需求消失",
      "narration": "先把结论说清楚……",
      "ttsText": "先把结论说清楚……",
      "sourceIds": ["src1"],
      "transition": "fade",
      "elements": [
        { "type": "icon", "name": "chart-down", "size": 180, "color": "#ff5c6c" },
        { "type": "pill", "text": "STAR 50 ↓ 45%", "color": "#ff5c6c" }
      ]
    }
  ]
}
```

支持的布局：`hero`、`split`、`chart`、`diagram`、`timeline`、`comparison`、`quote`。

支持的元素：`icon`（23 个内置图标）、`pill`、`text`、`chart`（bar/line/area）、`diagram`（nodes/edges）、`timeline`、`image`、`arrow`。

渲染管线：

```text
storyboard.json
  → 布局/样式/章节进度
  → 每帧 SVG
  → sharp 栅格化为 RGBA
  → ffmpeg rawvideo 管道
  → H.264 (CRF 18) + AAC (192k) + faststart
  → ffprobe 校验
```

样式预设：

- `dark-neon`：近黑背景、霓虹强调色、粗体字、网格；
- `tech-blue`：科技蓝、冷静图表；
- `paper-editorial`：纸面编辑部、高对比。

字幕：

- `none`：不烧录；
- `burn`：字幕由 SVG 渲染进画面（因为 ffmpeg 没有 libass，不依赖 subtitles 滤镜）；
- `srt`：生成旁挂 SRT 文件。

---

## 输出

一次生成会在工作目录留下：

```text
.dsh-explainer-video/job-.../
  materials.json
  web-research.json
  storyboard.json
  script.md
  narration.wav
  scene-01.wav ...
  subtitles.srt (when subtitleMode=srt)
  <title>.mp4
  preview/ (planOnly 时)
```

工具返回：

- `filePath`、`videoUrl`
- `storyboardPath`、`scriptPath`、`materialsPath`、`webResearchPath`
- `previewUrls`
- `durationSec`、`sceneCount`、`width/height/fps`
- `style`、`voice`、`ttsModel`、`ttsLanguage`、`ttsInstructions`
- `webMode`、`webQueries`、`webSources`
- `warnings`

`videoUrl` 使用宿主实际端口：

```text
http://127.0.0.1:<webServer.port>/api/dsh-explainer-video/artifacts/<token>
```

---

## 设置页

`Plugins → dsh-explainer-video` 分组包含：

- LLM provider/model（留空 = 当前主模型）、最大 tokens、默认语言；
- TTS 端点、模型、音色、语言、指令、格式、采样率、超时、API key；
- 联网模式与预算；
- 风格、分辨率、帧率、目标时长、字幕模式、输出目录、BGM、总超时；
- “测试 TTS / 媒体工具”按钮：读取 `/v1/models`、`/v1/audio/voices`，检查 ffmpeg/ffprobe/sharp，并显示 LLM/web 服务是否可用。

---

## 依赖与限制

- Node.js >= 20；
- `ffmpeg` / `ffprobe`（H.264/AAC）；
- `sharp`（随包安装）；
- `python3` + PyMuPDF / python-pptx / python-docx（解析 PDF/Office；缺失时 fallback，效果可能下降）；
- ASR 是可选的：没有 whisper 时，视频素材只做元数据/风格参考；配置 `asrEndpoint` 后可转写；
- 视觉是确定性矢量渲染，不是生成式视频；复杂 3D、真实人物、实拍镜头不在范围内；
- 当前字幕 `burn` 由 SVG 绘制，不能依赖 ffmpeg libass；
- 联网引用需要宿主 `ctx.web` 可用；没有时自动降级。

---

## 开发

```bash
npm test            # core / TTS 纯逻辑
npm run test:render # SVG → PNG → MP4
npm run test:host   # mock LLM/web + 真实 TTS/render 的宿主集成
npm run test:smoke  # 真实 TTS 端点 + ffmpeg 端到端
```

---

## License

MIT © Chen Peng (fred-chen)

参考实现：`dsh-tts` 的端点/音色约定与设置桥模式。
