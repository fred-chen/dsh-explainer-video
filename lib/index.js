// dsh-explainer-video — DeepSeek Harness 宿主插件
//
// 提示词 + 素材 → 可选联网补资料 → 当前会话主模型生成分镜 →
// TTS 预置音色配音 → 程序化 SVG 动画 → ffmpeg 合成 MP4。
//
// LLM 默认延续当前 Agent 的 provider/model；设置页可覆盖。
// TTS 默认对齐 dsh-tts：http://ai4090:8080/v1/audio + Qwen3-TTS CustomVoice + uncle_fu。

import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";

import {
  DEFAULT_CONFIG,
  publicConfig,
  normalizeConfig,
  resolveConfig,
  aspectToSize,
  computeTimeline,
  estimateTimeline,
  outputFileName,
  sceneDurationFromAudio,
  validateStoryboard,
  buildSrt,
} from "./core.js";
import { ingestMaterials } from "./materials.js";
import { runWebResearch } from "./web.js";
import {
  resolveRoute,
  extractEvidence,
  planResearch,
  generateStoryboard,
  generateScriptMarkdown,
} from "./llm.js";
import {
  synthesizeScenes,
  checkTtsEndpoint,
  VOICE_LIST,
  VOICE_PRESETS,
} from "./tts.js";
import {
  FORMATS,
  normalizeEndpoint,
  normalizeFormat,
  normalizeSampleRate,
  normalizeVoice,
  isVoiceDesignModel,
  parseExtraParams,
  formatApiError,
} from "./tts-core.js";
import { buildNarrationAudio } from "./audio.js";
import { renderVideo, renderPreview } from "./render.js";
import { ffmpegVersion, ffprobeVersion } from "./media.js";
import { STYLE_PRESETS, styleList } from "./style.js";

const PLUGIN_VERSION = "0.1.0";
const NS = "explainer-video";
const BRIDGE_PREFIX = "/api/dsh-explainer-video";
const ARTIFACT_PREFIX = "/api/dsh-explainer-video/artifacts";
const DEFAULT_OUTPUT_DIR = ".dsh-explainer-video";
const MAX_PROMPT_CHARS = 6000;

//#region 配置

const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  llmProvider: z.string().default("").volatile(),
  llmModel: z.string().default("").volatile(),
  llmMaxTokens: z.number().default(8192).volatile(),
  language: z.string().default("zh").volatile(),
  ttsEndpoint: z.string().default(DEFAULT_CONFIG.ttsEndpoint).volatile(),
  ttsApiKey: z.string().role("secret").volatile(),
  ttsModel: z.string().default(DEFAULT_CONFIG.ttsModel).volatile(),
  ttsVoice: z.string().default(DEFAULT_CONFIG.ttsVoice).volatile(),
  ttsLanguage: z.string().default("").volatile(),
  ttsInstructions: z.string().default("").volatile(),
  ttsFormat: z.string().default("wav").volatile(),
  ttsSampleRate: z.number().default(0).volatile(),
  ttsTimeoutSec: z.number().default(300).volatile(),
  ttsExtraParams: z.string().default("").volatile(),
  webMode: z.string().default("auto").volatile(),
  webMaxQueries: z.number().default(6).volatile(),
  webMaxSources: z.number().default(8).volatile(),
  webMaxChars: z.number().default(40000).volatile(),
  webTimeoutSec: z.number().default(60).volatile(),
  asrEndpoint: z.string().default("").volatile(),
  asrModel: z.string().default("").volatile(),
  asrApiKey: z.string().role("secret").volatile(),
  stylePreset: z.string().default("dark-neon").volatile(),
  width: z.number().default(1920).volatile(),
  height: z.number().default(1080).volatile(),
  fps: z.number().default(30).volatile(),
  targetDurationSec: z.number().default(300).volatile(),
  sceneGapSec: z.number().default(0.3).volatile(),
  fontFamily: z.string().default(DEFAULT_CONFIG.fontFamily).volatile(),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR).volatile(),
  maxSourceChars: z.number().default(120000).volatile(),
  subtitleMode: z.string().default("none").volatile(),
  bgmPath: z.string().default("").volatile(),
  bgmVolume: z.number().default(0.12).volatile(),
  timeoutSec: z.number().default(1800).volatile(),
  keepWorkDir: z.boolean().default(true).volatile(),
});

//#endregion
//#region HTTP helpers

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
}

function serviceOf(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

//#endregion
//#region artifact 路由

function registerArtifact(artifacts, filePath, mime, name) {
  const token = randomBytes(18).toString("base64url");
  artifacts.set(token, { path: path.resolve(filePath), mime, name });
  while (artifacts.size > 200) {
    const oldest = artifacts.keys().next().value;
    artifacts.delete(oldest);
  }
  return token;
}

function handleArtifactRequest(req, res, artifacts) {
  (async () => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { ok: false, code: "method-not-allowed", message: "use GET or HEAD" });
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!url.pathname.startsWith(`${ARTIFACT_PREFIX}/`)) {
        writeJson(res, 404, { ok: false, code: "not-found", message: "artifact not found" });
        return;
      }
      const token = url.pathname.slice(ARTIFACT_PREFIX.length + 1);
      if (!token || token.includes("/")) {
        writeJson(res, 404, { ok: false, code: "not-found", message: "artifact not found" });
        return;
      }
      const entry = artifacts.get(token);
      if (!entry) {
        writeJson(res, 404, { ok: false, code: "not-found", message: "artifact not found" });
        return;
      }
      const info = await stat(entry.path);
      if (!info.isFile()) {
        writeJson(res, 404, { ok: false, code: "not-found", message: "artifact file not found" });
        return;
      }
      const total = info.size;
      const range = req.headers.range;
      let start = 0;
      let end = total - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/u.exec(String(range).trim());
        if (!match) {
          res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
          res.end(JSON.stringify({ ok: false, code: "invalid-range", message: "invalid Range header" }));
          return;
        }
        if (match[1] === "") {
          const suffix = Number(match[2]);
          if (!Number.isInteger(suffix) || suffix <= 0) {
            res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
            res.end(JSON.stringify({ ok: false, code: "invalid-range", message: "invalid suffix Range" }));
            return;
          }
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === "" ? total - 1 : Number(match[2]);
        }
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
          res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
          res.end(JSON.stringify({ ok: false, code: "invalid-range", message: "invalid range" }));
          return;
        }
        if (start >= total) {
          res.writeHead(416, { "content-type": "application/json", "content-range": `bytes */${total}` });
          res.end(JSON.stringify({ ok: false, code: "invalid-range", message: "range starts past end" }));
          return;
        }
        end = Math.min(end, total - 1);
        status = 206;
      }
      const headers = {
        "content-type": entry.mime || "application/octet-stream",
        "content-length": String(end - start + 1),
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=86400",
        "content-disposition": `inline; filename="${String(entry.name || "artifact").replace(/["\\]/gu, "-")}"`,
      };
      if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${total}`;
      res.writeHead(status, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(entry.path, { start, end }).pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy();
      }
    }
  })().catch(() => {});
}

//#endregion
//#region 引用与结果

function ensureReferences(storyboard, materialsData, webResearch) {
  const refs = Array.isArray(storyboard.references) ? storyboard.references.slice() : [];
  const ids = new Set(refs.map((ref) => String(ref.id)));
  for (const scene of storyboard.scenes || []) {
    for (const sourceId of scene.sourceIds || []) {
      const id = String(sourceId);
      if (ids.has(id)) continue;
      const material = (materialsData.sources || []).find((source) => source.id === id);
      if (material) {
        refs.push({ id, kind: "file", label: material.title || path.basename(material.path || id) });
        ids.add(id);
        continue;
      }
      const web = (webResearch.sources || []).find((source) => source.id === id);
      if (web) {
        refs.push({
          id,
          kind: web.url ? "web" : "search",
          label: web.title || web.url || id,
          url: web.url || "",
          title: web.title || "",
          publishedAt: web.publishedAt || "",
        });
        ids.add(id);
      }
    }
  }
  storyboard.references = refs;
  return storyboard;
}

function buildWebSources(storyboard, webResearch) {
  const refs = new Map((storyboard.references || []).map((ref) => [String(ref.id), ref]));
  const usedIn = new Map();
  for (const scene of storyboard.scenes || []) {
    for (const sourceId of scene.sourceIds || []) {
      const ref = refs.get(String(sourceId));
      const key = ref?.url || String(sourceId);
      if (!usedIn.has(key)) usedIn.set(key, []);
      usedIn.get(key).push(scene.id);
    }
  }
  return (webResearch.sources || []).map((source) => ({
    url: source.url || "",
    title: source.title || "",
    publishedAt: source.publishedAt || "",
    usedIn: [...new Set(usedIn.get(source.url || source.id) || [])],
  }));
}

function summarizeWarnings(warnings) {
  return [...new Set((warnings || []).filter(Boolean))];
}

function buildOutput({
  jobId,
  planOnly,
  filePath,
  videoUrl,
  storyboardPath,
  scriptPath,
  materialsPath,
  webResearchPath,
  subtitlePath,
  previewUrls,
  durationSec,
  sceneCount,
  width,
  height,
  fps,
  style,
  voice,
  ttsModel,
  ttsLanguage,
  ttsInstructions,
  webMode,
  webQueries,
  webSources,
  warnings,
  elapsedSeconds,
  bytes,
}) {
  return {
    jobId,
    planOnly,
    ...(filePath ? { filePath } : {}),
    ...(videoUrl ? { videoUrl } : {}),
    storyboardPath,
    scriptPath,
    materialsPath,
    webResearchPath,
    ...(subtitlePath ? { subtitlePath } : {}),
    previewUrls: previewUrls || [],
    durationSec: Math.round(durationSec * 100) / 100,
    sceneCount,
    width,
    height,
    fps,
    style,
    voice,
    ttsModel,
    ttsLanguage,
    ttsInstructions,
    webMode,
    webQueries,
    webSources,
    warnings: summarizeWarnings(warnings),
    elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
    ...(Number.isFinite(bytes) ? { bytes } : {}),
  };
}

function outputSchema() {
  return {
    type: "object",
    properties: {
      jobId: { type: "string" },
      planOnly: { type: "boolean" },
      filePath: { type: "string" },
      videoUrl: { type: "string" },
      storyboardPath: { type: "string" },
      scriptPath: { type: "string" },
      materialsPath: { type: "string" },
      webResearchPath: { type: "string" },
      subtitlePath: { type: "string" },
      previewUrls: { type: "array", items: { type: "string" } },
      durationSec: { type: "number" },
      sceneCount: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
      fps: { type: "number" },
      style: { type: "string" },
      voice: { type: "string" },
      ttsModel: { type: "string" },
      ttsLanguage: { type: "string" },
      ttsInstructions: { type: "string" },
      webMode: { type: "string" },
      webQueries: { type: "number" },
      webSources: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            publishedAt: { type: "string" },
            usedIn: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      warnings: { type: "array", items: { type: "string" } },
      elapsedSeconds: { type: "number" },
      bytes: { type: "number" },
    },
    additionalProperties: false,
  };
}

function renderOutput(args, value) {
  const lines = [];
  if (value.planOnly) {
    lines.push(`分镜生成完成：${value.storyboardPath}`);
    lines.push(`预览图：${value.previewUrls.length} 张 · 场景 ${value.sceneCount} · 估算 ${value.durationSec}s`);
  } else {
    lines.push(`视频生成完成：${value.filePath}`);
    lines.push(`时长 ${value.durationSec}s · 场景 ${value.sceneCount} · ${value.width}x${value.height} @ ${value.fps}fps`);
    lines.push(`旁白：${value.voice} · 模型 ${value.ttsModel} · 语言 ${value.ttsLanguage}`);
    if (value.videoUrl) lines.push(`浏览器预览：${value.videoUrl}`);
  }
  lines.push(`分镜：${value.storyboardPath}`);
  lines.push(`脚本：${value.scriptPath}`);
  lines.push(`素材记录：${value.materialsPath}`);
  if (value.webQueries) lines.push(`联网查询：${value.webQueries} 条 · 来源 ${value.webSources.length}`);
  if (value.warnings.length) {
    lines.push("注意：");
    for (const warning of value.warnings) lines.push(`- ${warning}`);
  }
  const meta = {
    jobId: value.jobId,
    planOnly: value.planOnly,
    filePath: value.filePath,
    videoUrl: value.videoUrl,
    storyboardPath: value.storyboardPath,
    scriptPath: value.scriptPath,
    subtitlePath: value.subtitlePath,
    durationSec: value.durationSec,
    sceneCount: value.sceneCount,
    width: value.width,
    height: value.height,
    fps: value.fps,
    style: value.style,
    voice: value.voice,
    ttsModel: value.ttsModel,
    ttsLanguage: value.ttsLanguage,
    ttsInstructions: value.ttsInstructions,
    webMode: value.webMode,
    webQueries: value.webQueries,
    webSources: value.webSources,
    warnings: value.warnings,
    previewUrls: value.previewUrls,
  };
  lines.push(`结果 JSON：${JSON.stringify(meta)}`);
  return [{ type: "text", text: lines.join("\n") }];
}

//#endregion
//#region 生成/渲染流程

async function resolveMaterialsForRender(storyboardPath, materialsPath) {
  let resolved = materialsPath;
  if (!resolved) {
    const candidate = path.join(path.dirname(storyboardPath), "materials.json");
    try {
      await stat(candidate);
      resolved = candidate;
    } catch {
      resolved = "";
    }
  }
  if (!resolved) return { assets: [], sources: [], notes: [], warnings: [], materialsPath: "" };
  try {
    const data = JSON.parse(await readFile(resolved, "utf8"));
    return {
      assets: Array.isArray(data.assets) ? data.assets : [],
      sources: Array.isArray(data.sources) ? data.sources : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      materialsPath: resolved,
    };
  } catch (error) {
    throw new Error(`读取 materials.json 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function renderFromStoryboard({
  ctx,
  exec,
  cfg,
  storyboard,
  storyboardPath,
  scriptPath,
  materialsData,
  webResearch,
  webResearchPath,
  args,
  publicBase,
  artifacts,
  logger,
}) {
  const started = Date.now();
  const cwd = exec.agent?.session?.header?.cwd || process.cwd();
  const width = storyboard.width;
  const height = storyboard.height;
  const fps = storyboard.fps;
  const warnings = [...(materialsData.warnings || []), ...(webResearch.warnings || [])];

  const ttsResult = await synthesizeScenes({
    storyboard,
    config: cfg,
    args,
    workDir: path.dirname(storyboardPath),
    signal: exec.signal,
    logger,
  });
  warnings.push(...ttsResult.warnings);

  const durations = [];
  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    const scene = storyboard.scenes[index];
    const ttsScene = ttsResult.scenes[index];
    const duration = sceneDurationFromAudio(ttsScene.durationSeconds, fps, 5, 30, cfg.sceneGapSec);
    if (duration.exceededMax) warnings.push(`scene ${scene.id} 旁白超过 30 秒，已按 30 秒上限处理。`);
    durations.push(duration.duration);
  }
  const timeline = computeTimeline(storyboard.scenes, durations, fps);
  if (storyboard.targetDurationSec && timeline.totalDuration > storyboard.targetDurationSec * 1.35) {
    warnings.push(`成片 ${timeline.totalDuration.toFixed(1)}s 明显超过目标 ${storyboard.targetDurationSec}s；旁白长度决定了实际时长。`);
  }

  let bgmPath = cfg.bgmPath ? (path.isAbsolute(cfg.bgmPath) ? cfg.bgmPath : path.resolve(cwd, cfg.bgmPath)) : "";
  if (bgmPath) {
    try {
      await stat(bgmPath);
    } catch {
      warnings.push(`BGM 文件不可读，忽略：${bgmPath}`);
      bgmPath = "";
    }
  }

  const audio = await buildNarrationAudio({
    storyboard,
    ttsResult,
    timeline,
    workDir: path.dirname(storyboardPath),
    bgmPath,
    bgmVolume: cfg.bgmVolume,
    signal: exec.signal,
    logger,
  });

  let subtitlePath = "";
  if (cfg.subtitleMode === "srt") {
    subtitlePath = path.join(path.dirname(storyboardPath), "subtitles.srt");
    await writeFile(subtitlePath, buildSrt(storyboard, timeline));
  }

  const fileName = outputFileName({ title: storyboard.title, outputName: args.outputName });
  const finalPath = path.join(path.dirname(storyboardPath), fileName);
  const video = await renderVideo({
    storyboard,
    timeline,
    assets: materialsData.assets,
    audioPath: audio.path,
    outputPath: finalPath,
    width,
    height,
    fps,
    subtitleMode: cfg.subtitleMode,
    fontFamily: cfg.fontFamily,
    signal: exec.signal,
    logger,
  });

  if (video.videoCodec !== "h264") warnings.push(`视频编码不是 h264：${video.videoCodec || "unknown"}`);
  if (video.audioCodec !== "aac") warnings.push(`音频编码不是 aac：${video.audioCodec || "unknown"}`);
  if (Math.abs(video.duration - timeline.totalDuration) > 1) {
    warnings.push(`成片时长 ${video.duration.toFixed(2)}s 与分镜 ${timeline.totalDuration.toFixed(2)}s 不一致。`);
  }

  const videoToken = registerArtifact(artifacts, finalPath, "video/mp4", path.basename(finalPath));
  const videoUrl = `${publicBase}${ARTIFACT_PREFIX}/${videoToken}`;

  return buildOutput({
    jobId: args.jobId || path.basename(path.dirname(storyboardPath)),
    planOnly: false,
    filePath: finalPath,
    videoUrl,
    storyboardPath,
    scriptPath,
    materialsPath: materialsData.materialsPath || "",
    webResearchPath,
    subtitlePath,
    previewUrls: [],
    durationSec: timeline.totalDuration,
    sceneCount: storyboard.scenes.length,
    width,
    height,
    fps,
    style: storyboard.style,
    voice: ttsResult.voice,
    ttsModel: ttsResult.model,
    ttsLanguage: ttsResult.language,
    ttsInstructions: ttsResult.instructions,
    webMode: String(args.webMode || cfg.webMode),
    webQueries: (webResearch.queries || []).length,
    webSources: buildWebSources(storyboard, webResearch),
    warnings,
    elapsedSeconds: (Date.now() - started) / 1000,
    bytes: video.bytes,
  });
}

//#endregion
//#region 工具

function buildGenerateTool({ ctx, current, publicBase, artifacts, logger }) {
  return defineTool({
    name: "explainer_video_generate",
    description:
      "Generate a vector explainer video from a prompt and source files. " +
      "The LLM defaults to the current session's main model (agent provider/model); settings can override llmProvider/llmModel. " +
      "Materials may be PDF/PPTX/DOCX/TXT/MD or video; web research is optional (webMode auto/off/always). " +
      "The plugin builds a constrained storyboard JSON, selects a TTS preset voice (uncle_fu, dylan, eric, vivian, serena, ryan, aiden, ono_anna, sohee) from a configurable OpenAI-compatible /v1/audio/speech endpoint, renders deterministic SVG frames, and muxes an MP4. " +
      "Use planOnly=true to get storyboard + preview images first. Use explainer_video_render to re-render an edited storyboard without regenerating the script.",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "Topic, audience, tone, duration, language, and style. Up to 6000 characters.",
      },
      materials: {
        type: "array",
        items: { type: "string" },
        description: "Source file paths: PDF/PPTX/DOCX/TXT/MD or video/audio. Relative paths resolve from the session cwd.",
      },
      referenceVideo: {
        type: "string",
        description: "Optional reference video used only for palette/style hints, not content.",
      },
      durationSec: {
        type: "number",
        description: "Target duration in seconds. Defaults to the plugin setting (300).",
      },
      aspect: {
        type: "string",
        enum: ["16:9", "9:16", "1:1"],
        description: "Output aspect. Defaults to settings width/height.",
      },
      style: {
        type: "string",
        description: "Style preset: dark-neon, tech-blue, paper-editorial. Defaults to settings.",
      },
      language: {
        type: "string",
        description: "Narration language, e.g. zh / en. Defaults to settings (zh) or storyboard language.",
      },
      voice: {
        type: "string",
        description: "TTS preset voice id (uncle_fu, dylan, eric, vivian, serena, ryan, aiden, ono_anna, sohee) or a free-form description for VoiceDesign models. Defaults to settings ttsVoice.",
      },
      ttsModel: {
        type: "string",
        description: "Override TTS model; use ...-VoiceDesign for free-form voice descriptions.",
      },
      ttsInstructions: {
        type: "string",
        description: "Override TTS style/emotion/pace instructions.",
      },
      webMode: {
        type: "string",
        enum: ["auto", "off", "always"],
        description: "Web supplementation mode. auto = only when needed; off = materials only; always = force research.",
      },
      planOnly: {
        type: "boolean",
        description: "Only generate storyboard + preview images; no TTS and no MP4.",
      },
      outputName: {
        type: "string",
        description: "Optional MP4 basename.",
      },
    },
    output: {
      schema: outputSchema(),
      render: renderOutput,
      presentationMeta(args, value) {
        return {
          url: value.videoUrl || "",
          filePath: value.filePath || "",
          planOnly: value.planOnly,
          previewUrls: value.previewUrls || [],
          storyboardPath: value.storyboardPath,
          scriptPath: value.scriptPath,
          subtitlePath: value.subtitlePath,
          durationSec: value.durationSec,
          sceneCount: value.sceneCount,
          width: value.width,
          height: value.height,
          fps: value.fps,
          style: value.style,
          voice: value.voice,
          ttsModel: value.ttsModel,
          warnings: value.warnings,
        };
      },
    },
    presentCall(args) {
      return {
        card: "generic",
        kind: "other",
        title: "生成科普视频",
        rawInput: {
          prompt: args.prompt,
          materials: args.materials,
          durationSec: args.durationSec,
          voice: args.voice,
          planOnly: args.planOnly,
        },
      };
    },
    async execute(args, exec) {
      const cfg = current();
      if (!cfg.enabled) throw new Error("explainer_video_generate 已在插件设置中禁用");

      const prompt = String(args.prompt || "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt 不能超过 ${MAX_PROMPT_CHARS} 字符`);
      if (args.materials !== undefined && !Array.isArray(args.materials)) throw new Error("materials 必须是字符串数组");

      const started = Date.now();
      const cwd = exec.agent?.session?.header?.cwd || process.cwd();
      const outputDir = path.resolve(cwd, cfg.outputDir || DEFAULT_OUTPUT_DIR);
      const jobId = `explainer-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
      const workDir = path.join(outputDir, jobId);
      await mkdir(workDir, { recursive: true });

      await ffmpegVersion(exec.signal);
      await ffprobeVersion(exec.signal);

      const size = args.aspect ? aspectToSize(args.aspect, cfg.width, cfg.height) : { width: cfg.width, height: cfg.height };
      const durationSec = Math.min(1200, Math.max(20, Number(args.durationSec ?? cfg.targetDurationSec) || cfg.targetDurationSec));
      const language = String(args.language || cfg.language || "zh").trim();
      const style = String(args.style || cfg.stylePreset).trim();
      if (!STYLE_PRESETS[style]) throw new Error(`未知 stylePreset：${style}`);
      const webMode = String(args.webMode || cfg.webMode).trim();
      if (!["auto", "off", "always"].includes(webMode)) throw new Error(`未知 webMode：${webMode}`);

      const materialsData = await ingestMaterials({
        materials: args.materials || [],
        referenceVideo: args.referenceVideo,
        cwd,
        workDir,
        maxSourceChars: cfg.maxSourceChars,
        asr: {
          endpoint: cfg.asrEndpoint,
          model: cfg.asrModel,
          apiKey: cfg.asrApiKey,
          timeoutSec: 120,
        },
        signal: exec.signal,
        logger,
      });
      const warnings = [...(materialsData.warnings || [])];

      const route = resolveRoute(ctx, exec.agent, cfg);
      const evidence = await extractEvidence({
        route,
        notes: materialsData.notes,
        maxTokens: cfg.llmMaxTokens,
        signal: exec.signal,
        workDir,
        logger,
      });

      let researchPlan = { queries: [], reason: "" };
      let webResearch = { queries: [], sources: [], notes: [], warnings: [] };
      if (webMode !== "off") {
        researchPlan = await planResearch({
          route,
          prompt,
          evidence,
          mode: webMode,
          maxQueries: cfg.webMaxQueries,
          maxTokens: cfg.llmMaxTokens,
          signal: exec.signal,
          workDir,
          logger,
        });
        if (researchPlan.queries.length > 0) {
          const web = serviceOf(ctx, "web");
          webResearch = await runWebResearch({
            queries: researchPlan.queries,
            maxResults: 5,
            maxSources: cfg.webMaxSources,
            maxChars: cfg.webMaxChars,
            timeoutSec: cfg.webTimeoutSec,
            signal: exec.signal,
            web,
            logger,
          });
          warnings.push(...(webResearch.warnings || []));
        }
      }
      await writeFile(path.join(workDir, "web-research.json"), JSON.stringify({
        mode: webMode,
        reason: researchPlan.reason || "",
        queries: webResearch.queries || [],
        sources: webResearch.sources || [],
        notes: webResearch.notes || [],
        warnings: webResearch.warnings || [],
      }, null, 2));

      const materialSourceIds = (materialsData.sources || []).map((source) => source.id);
      const storyboard = await generateStoryboard({
        route,
        prompt,
        evidence,
        webResearch,
        assets: materialsData.assets,
        style,
        language,
        width: size.width,
        height: size.height,
        fps: cfg.fps,
        targetDurationSec: durationSec,
        referenceHint: materialsData.reference?.hint || "",
        allowedSourceIds: materialSourceIds,
        maxTokens: cfg.llmMaxTokens,
        signal: exec.signal,
        workDir,
        logger,
      });
      ensureReferences(storyboard, materialsData, webResearch);
      const assetIds = new Set((materialsData.assets || []).map((asset) => asset.id));
      const validation = validateStoryboard(storyboard, assetIds);
      if (!validation.ok) throw new Error(`generated storyboard 校验失败：${validation.errors.join("；")}`);

      const storyboardPath = path.join(workDir, "storyboard.json");
      const scriptPath = path.join(workDir, "script.md");
      await writeFile(storyboardPath, JSON.stringify(storyboard, null, 2));
      await writeFile(scriptPath, await generateScriptMarkdown(storyboard));

      if (args.planOnly === true) {
        const timeline = estimateTimeline(storyboard);
        const previewDir = path.join(workDir, "preview");
        const previewPaths = await renderPreview({
          storyboard,
          timeline,
          assets: materialsData.assets,
          outputDir: previewDir,
          width: size.width,
          height: size.height,
          fontFamily: cfg.fontFamily,
          signal: exec.signal,
          logger,
        });
        const previewUrls = previewPaths.map((filePath) => {
          const token = registerArtifact(artifacts, filePath, "image/png", path.basename(filePath));
          return `${publicBase}${ARTIFACT_PREFIX}/${token}`;
        });
        return buildOutput({
          jobId,
          planOnly: true,
          filePath: "",
          videoUrl: "",
          storyboardPath,
          scriptPath,
          materialsPath: path.join(workDir, "materials.json"),
          webResearchPath: path.join(workDir, "web-research.json"),
          previewUrls,
          durationSec: timeline.totalDuration,
          sceneCount: storyboard.scenes.length,
          width: size.width,
          height: size.height,
          fps: cfg.fps,
          style: storyboard.style,
          voice: String(args.voice || cfg.ttsVoice),
          ttsModel: String(args.ttsModel || cfg.ttsModel),
          ttsLanguage: String(args.language || cfg.ttsLanguage || storyboard.language),
          ttsInstructions: String(args.ttsInstructions ?? cfg.ttsInstructions),
          webMode,
          webQueries: webResearch.queries.length,
          webSources: buildWebSources(storyboard, webResearch),
          warnings,
          elapsedSeconds: (Date.now() - started) / 1000,
          bytes: 0,
        });
      }

      return renderFromStoryboard({
        ctx,
        exec,
        cfg,
        storyboard,
        storyboardPath,
        scriptPath,
        materialsData: { ...materialsData, materialsPath: path.join(workDir, "materials.json") },
        webResearch,
        webResearchPath: path.join(workDir, "web-research.json"),
        args: args,
        publicBase,
        artifacts,
        logger,
      });
    },
  });
}

function buildRenderTool({ ctx, current, publicBase, artifacts, logger }) {
  return defineTool({
    name: "explainer_video_render",
    description:
      "Re-render an existing storyboard JSON into an MP4 without regenerating the script. " +
      "Loads materials.json next to the storyboard (or materialsPath) for image assets, synthesizes narration with the configured TTS preset voice, and renders vector frames. " +
      "Use this after editing storyboard.json; TTS audio is cached.",
    parameters: {
      storyboardPath: {
        type: "string",
        required: true,
        description: "Path to a validated storyboard.json.",
      },
      materialsPath: {
        type: "string",
        description: "Optional materials.json path. Defaults to the sibling materials.json.",
      },
      voice: {
        type: "string",
        description: "TTS preset voice override.",
      },
      ttsModel: {
        type: "string",
        description: "TTS model override.",
      },
      ttsInstructions: {
        type: "string",
        description: "TTS style instructions override.",
      },
      outputName: {
        type: "string",
        description: "Optional MP4 basename.",
      },
    },
    output: {
      schema: outputSchema(),
      render: renderOutput,
      presentationMeta(args, value) {
        return {
          url: value.videoUrl || "",
          filePath: value.filePath || "",
          planOnly: false,
          previewUrls: [],
          storyboardPath: value.storyboardPath,
          scriptPath: value.scriptPath,
          subtitlePath: value.subtitlePath,
          durationSec: value.durationSec,
          sceneCount: value.sceneCount,
          width: value.width,
          height: value.height,
          fps: value.fps,
          style: value.style,
          voice: value.voice,
          ttsModel: value.ttsModel,
          warnings: value.warnings,
        };
      },
    },
    presentCall(args) {
      return {
        card: "generic",
        kind: "other",
        title: "重渲染科普视频",
        rawInput: {
          storyboardPath: args.storyboardPath,
          voice: args.voice,
        },
      };
    },
    async execute(args, exec) {
      const cfg = current();
      if (!cfg.enabled) throw new Error("explainer_video_render 已在插件设置中禁用");
      const cwd = exec.agent?.session?.header?.cwd || process.cwd();
      const storyboardPath = path.isAbsolute(args.storyboardPath) ? args.storyboardPath : path.resolve(cwd, args.storyboardPath);
      const storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
      const materialsData = await resolveMaterialsForRender(storyboardPath, args.materialsPath);
      const assetIds = new Set((materialsData.assets || []).map((asset) => asset.id));
      const validation = validateStoryboard(storyboard, assetIds);
      if (!validation.ok) throw new Error(`storyboard 校验失败：${validation.errors.join("；")}`);

      await ffmpegVersion(exec.signal);
      await ffprobeVersion(exec.signal);

      let webResearch = { queries: [], sources: [], notes: [], warnings: [] };
      let webResearchPath = "";
      try {
        const candidate = path.join(path.dirname(storyboardPath), "web-research.json");
        await stat(candidate);
        webResearchPath = candidate;
        const parsed = JSON.parse(await readFile(candidate, "utf8"));
        webResearch = {
          queries: parsed.queries || [],
          sources: parsed.sources || [],
          notes: parsed.notes || [],
          warnings: parsed.warnings || [],
        };
      } catch {
        webResearchPath = "";
      }
      let scriptPath = path.join(path.dirname(storyboardPath), "script.md");
      try {
        await stat(scriptPath);
      } catch {
        scriptPath = "";
      }
      const materialsPath = materialsData.materialsPath
        || (args.materialsPath ? (path.isAbsolute(args.materialsPath) ? args.materialsPath : path.resolve(cwd, args.materialsPath)) : "");

      const result = await renderFromStoryboard({
        ctx,
        exec,
        cfg,
        storyboard,
        storyboardPath,
        scriptPath,
        materialsData: { ...materialsData, materialsPath },
        webResearch,
        webResearchPath,
        args: { ...args, jobId: path.basename(path.dirname(storyboardPath)) },
        publicBase,
        artifacts,
        logger,
      });
      return result;
    },
  });
}

//#endregion
//#region 设置桥

function makeBridgeRoutes({ ctx, describe, save, test }) {
  const wrap = (handler, method = "POST") => async (req, res) => {
    if (String(req.method).toUpperCase() !== method) {
      writeJson(res, 405, { ok: false, code: "method-not-allowed", message: `use ${method}` });
      return;
    }
    try {
      let body = {};
      if (method !== "GET") {
        body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "bad-request", message: "malformed JSON body" });
          return;
        }
      }
      writeJson(res, 200, await handler(body));
    } catch (error) {
      writeJson(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return [
    { kind: "exact", method: "GET", path: `${BRIDGE_PREFIX}/config`, handler: wrap(describe, "GET") },
    { kind: "exact", method: "POST", path: `${BRIDGE_PREFIX}/save`, handler: wrap(save, "POST") },
    { kind: "exact", method: "POST", path: `${BRIDGE_PREFIX}/test`, handler: wrap(test, "POST") },
  ];
}

//#endregion
//#region 插件

function apply(ctx, config) {
  const logger = ctx.logger;
  const current = () => normalizeConfig(resolveConfig(config));
  const artifacts = new Map();

  const getDescriptor = () => {
    const settings = serviceOf(ctx, "settings");
    if (!settings || typeof settings.describe !== "function") return undefined;
    try {
      return settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === NS);
    } catch {
      return undefined;
    }
  };

  const describe = async () => {
    const descriptor = getDescriptor();
    let toolNames = [];
    let toolError = "";
    try {
      const tools = serviceOf(ctx, "tools");
      toolNames = tools && typeof tools.schemas === "function" ? tools.schemas().map((schema) => schema.name) : [];
    } catch (error) {
      toolError = error instanceof Error ? error.message : String(error);
    }
    return {
      ok: true,
      value: {
        ns: NS,
        version: PLUGIN_VERSION,
        revision: descriptor ? descriptor.revision : 0,
        config: descriptor ? descriptor.value : publicConfig(current()),
        secrets: descriptor && Array.isArray(descriptor.secrets) ? descriptor.secrets : [],
        presets: VOICE_LIST,
        voicePresets: VOICE_PRESETS,
        formats: FORMATS,
        styles: styleList(),
        defaults: DEFAULT_CONFIG,
        defaultEndpoint: DEFAULT_CONFIG.ttsEndpoint,
        defaultModel: DEFAULT_CONFIG.ttsModel,
        toolNames,
        toolRegistered: toolNames.includes("explainer_video_generate"),
        toolError,
        services: {
          llm: Boolean(serviceOf(ctx, "llm")),
          web: Boolean(serviceOf(ctx, "web")),
        },
        sharpVersion: sharp.versions?.sharp || sharp.versions?.vips || "unknown",
      },
    };
  };

  const save = async (body) => {
    if (body === null || typeof body !== "object") {
      return { ok: false, code: "bad-request", message: "malformed save request" };
    }
    const cfg = current();
    let endpoint;
    let format;
    let sampleRate;
    let extraParams;
    try {
      endpoint = normalizeEndpoint(body.ttsEndpoint ?? cfg.ttsEndpoint);
      format = normalizeFormat(body.ttsFormat ?? cfg.ttsFormat);
      sampleRate = normalizeSampleRate(body.ttsSampleRate ?? cfg.ttsSampleRate);
      extraParams = parseExtraParams(body.ttsExtraParams ?? cfg.ttsExtraParams);
    } catch (error) {
      return { ok: false, code: "invalid-config", message: error instanceof Error ? error.message : String(error) };
    }
    const model = String(body.ttsModel ?? cfg.ttsModel).trim();
    if (!model) return { ok: false, code: "invalid-config", message: "ttsModel 不能为空" };
    const voice = String(body.ttsVoice ?? cfg.ttsVoice).trim();
    if (voice && voice !== "__custom__" && !isVoiceDesignModel(model) && !normalizeVoice(voice).preset) {
      return {
        ok: false,
        code: "invalid-config",
        message: `ttsVoice「${voice}」不是 CustomVoice 预置音色。可用：${Object.keys(VOICE_PRESETS).join(", ")}；自由描述请使用 VoiceDesign 模型。`,
      };
    }
    const ttsTimeoutSec = Number(body.ttsTimeoutSec ?? cfg.ttsTimeoutSec);
    if (!Number.isInteger(ttsTimeoutSec) || ttsTimeoutSec < 10 || ttsTimeoutSec > 3600) {
      return { ok: false, code: "invalid-config", message: "ttsTimeoutSec 必须是 10–3600 的整数" };
    }
    const webMode = String(body.webMode ?? cfg.webMode);
    if (!["auto", "off", "always"].includes(webMode)) {
      return { ok: false, code: "invalid-config", message: "webMode 必须是 auto / off / always" };
    }
    const webMaxQueries = Number(body.webMaxQueries ?? cfg.webMaxQueries);
    const webMaxSources = Number(body.webMaxSources ?? cfg.webMaxSources);
    const webMaxChars = Number(body.webMaxChars ?? cfg.webMaxChars);
    const webTimeoutSec = Number(body.webTimeoutSec ?? cfg.webTimeoutSec);
    if (!Number.isInteger(webMaxQueries) || webMaxQueries < 0 || webMaxQueries > 12) {
      return { ok: false, code: "invalid-config", message: "webMaxQueries 必须是 0–12 的整数" };
    }
    if (!Number.isInteger(webMaxSources) || webMaxSources < 0 || webMaxSources > 20) {
      return { ok: false, code: "invalid-config", message: "webMaxSources 必须是 0–20 的整数" };
    }
    if (!Number.isInteger(webMaxChars) || webMaxChars < 0 || webMaxChars > 200000) {
      return { ok: false, code: "invalid-config", message: "webMaxChars 必须是 0–200000 的整数" };
    }
    if (!Number.isInteger(webTimeoutSec) || webTimeoutSec < 5 || webTimeoutSec > 300) {
      return { ok: false, code: "invalid-config", message: "webTimeoutSec 必须是 5–300 的整数" };
    }
    const width = Number(body.width ?? cfg.width);
    const height = Number(body.height ?? cfg.height);
    const fps = Number(body.fps ?? cfg.fps);
    const targetDurationSec = Number(body.targetDurationSec ?? cfg.targetDurationSec);
    if (!Number.isInteger(width) || width < 320 || width > 3840) return { ok: false, code: "invalid-config", message: "width 必须是 320–3840 的整数" };
    if (!Number.isInteger(height) || height < 240 || height > 3840) return { ok: false, code: "invalid-config", message: "height 必须是 240–3840 的整数" };
    if (!Number.isInteger(fps) || fps < 12 || fps > 60) return { ok: false, code: "invalid-config", message: "fps 必须是 12–60 的整数" };
    if (!Number.isInteger(targetDurationSec) || targetDurationSec < 20 || targetDurationSec > 1200) return { ok: false, code: "invalid-config", message: "targetDurationSec 必须是 20–1200 的整数" };
    const sceneGapSec = Number(body.sceneGapSec ?? cfg.sceneGapSec);
    if (!Number.isFinite(sceneGapSec) || sceneGapSec < 0 || sceneGapSec > 2) return { ok: false, code: "invalid-config", message: "sceneGapSec 必须是 0–2" };
    const stylePreset = String(body.stylePreset ?? cfg.stylePreset);
    if (!STYLE_PRESETS[stylePreset]) return { ok: false, code: "invalid-config", message: `未知 stylePreset：${stylePreset}` };
    const subtitleMode = String(body.subtitleMode ?? cfg.subtitleMode);
    if (!["none", "burn", "srt"].includes(subtitleMode)) return { ok: false, code: "invalid-config", message: "subtitleMode 必须是 none / burn / srt" };
    const outputDir = String(body.outputDir ?? cfg.outputDir).trim();
    if (!outputDir) return { ok: false, code: "invalid-config", message: "outputDir 不能为空" };
    const maxSourceChars = Number(body.maxSourceChars ?? cfg.maxSourceChars);
    if (!Number.isInteger(maxSourceChars) || maxSourceChars < 1000 || maxSourceChars > 500000) return { ok: false, code: "invalid-config", message: "maxSourceChars 必须是 1000–500000 的整数" };
    const bgmVolume = Number(body.bgmVolume ?? cfg.bgmVolume);
    if (!Number.isFinite(bgmVolume) || bgmVolume < 0 || bgmVolume > 1) return { ok: false, code: "invalid-config", message: "bgmVolume 必须是 0–1" };
    const timeoutSec = Number(body.timeoutSec ?? cfg.timeoutSec);
    if (!Number.isInteger(timeoutSec) || timeoutSec < 60 || timeoutSec > 3600) return { ok: false, code: "invalid-config", message: "timeoutSec 必须是 60–3600 的整数" };
    const asrEndpoint = String(body.asrEndpoint ?? cfg.asrEndpoint).trim();
    if (asrEndpoint) {
      try {
        const url = new URL(asrEndpoint);
        if (!/^https?:$/i.test(url.protocol)) throw new Error("必须是 http/https");
      } catch {
        return { ok: false, code: "invalid-config", message: "asrEndpoint 必须是合法的 http/https URL" };
      }
    }
    const llmMaxTokens = Number(body.llmMaxTokens ?? cfg.llmMaxTokens);
    if (!Number.isInteger(llmMaxTokens) || llmMaxTokens < 1024 || llmMaxTokens > 32768) {
      return { ok: false, code: "invalid-config", message: "llmMaxTokens 必须是 1024–32768 的整数" };
    }

    const ops = [
      { op: "set", path: ["enabled"], value: body.enabled !== false },
      { op: "set", path: ["llmProvider"], value: String(body.llmProvider ?? cfg.llmProvider).trim() },
      { op: "set", path: ["llmModel"], value: String(body.llmModel ?? cfg.llmModel).trim() },
      { op: "set", path: ["llmMaxTokens"], value: llmMaxTokens },
      { op: "set", path: ["language"], value: String(body.language ?? cfg.language).trim() || "zh" },
      { op: "set", path: ["ttsEndpoint"], value: endpoint },
      { op: "set", path: ["ttsModel"], value: model },
      { op: "set", path: ["ttsVoice"], value: voice === "__custom__" ? "" : voice },
      { op: "set", path: ["ttsLanguage"], value: String(body.ttsLanguage ?? cfg.ttsLanguage).trim() },
      { op: "set", path: ["ttsInstructions"], value: String(body.ttsInstructions ?? cfg.ttsInstructions).trim() },
      { op: "set", path: ["ttsFormat"], value: format },
      { op: "set", path: ["ttsSampleRate"], value: sampleRate },
      { op: "set", path: ["ttsTimeoutSec"], value: ttsTimeoutSec },
      { op: "set", path: ["ttsExtraParams"], value: extraParams && Object.keys(extraParams).length ? JSON.stringify(extraParams) : "" },
      { op: "set", path: ["webMode"], value: webMode },
      { op: "set", path: ["webMaxQueries"], value: webMaxQueries },
      { op: "set", path: ["webMaxSources"], value: webMaxSources },
      { op: "set", path: ["webMaxChars"], value: webMaxChars },
      { op: "set", path: ["webTimeoutSec"], value: webTimeoutSec },
      { op: "set", path: ["asrEndpoint"], value: asrEndpoint },
      { op: "set", path: ["asrModel"], value: String(body.asrModel ?? cfg.asrModel).trim() },
      { op: "set", path: ["stylePreset"], value: stylePreset },
      { op: "set", path: ["width"], value: width },
      { op: "set", path: ["height"], value: height },
      { op: "set", path: ["fps"], value: fps },
      { op: "set", path: ["targetDurationSec"], value: targetDurationSec },
      { op: "set", path: ["sceneGapSec"], value: sceneGapSec },
      { op: "set", path: ["fontFamily"], value: String(body.fontFamily ?? cfg.fontFamily).trim() || DEFAULT_CONFIG.fontFamily },
      { op: "set", path: ["outputDir"], value: outputDir },
      { op: "set", path: ["maxSourceChars"], value: maxSourceChars },
      { op: "set", path: ["subtitleMode"], value: subtitleMode },
      { op: "set", path: ["bgmPath"], value: String(body.bgmPath ?? cfg.bgmPath).trim() },
      { op: "set", path: ["bgmVolume"], value: bgmVolume },
      { op: "set", path: ["timeoutSec"], value: timeoutSec },
      { op: "set", path: ["keepWorkDir"], value: body.keepWorkDir !== false },
    ];

    if (typeof body.ttsApiKey === "string" && body.ttsApiKey.trim()) {
      ops.push({ op: "set", path: ["ttsApiKey"], value: body.ttsApiKey.trim() });
    } else if (body.clearTtsApiKey === true) {
      ops.push({ op: "unset", path: ["ttsApiKey"] });
    }
    if (typeof body.asrApiKey === "string" && body.asrApiKey.trim()) {
      ops.push({ op: "set", path: ["asrApiKey"], value: body.asrApiKey.trim() });
    } else if (body.clearAsrApiKey === true) {
      ops.push({ op: "unset", path: ["asrApiKey"] });
    }

    const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
    try {
      await serviceOf(ctx, "settings").mutate(NS, ops, expectedRevision);
    } catch (error) {
      if (error instanceof SettingsConflictError) {
        return { ok: false, code: "settings-conflict", message: error.message };
      }
      return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
    }
    return describe();
  };

  const test = async (body) => {
    const cfg = current();
    let endpoint;
    try {
      endpoint = normalizeEndpoint((body && body.ttsEndpoint) || cfg.ttsEndpoint);
    } catch (error) {
      return { ok: false, code: "invalid-endpoint", message: error instanceof Error ? error.message : String(error) };
    }
    const model = String((body && body.ttsModel) || cfg.ttsModel || DEFAULT_CONFIG.ttsModel).trim();
    const apiKey = body && typeof body.ttsApiKey === "string" && body.ttsApiKey.trim()
      ? body.ttsApiKey.trim()
      : cfg.ttsApiKey;
    const tts = await checkTtsEndpoint({
      endpoint,
      model,
      apiKey,
      timeoutSec: 10,
      signal: undefined,
    });
    let ffmpeg = "";
    let ffmpegError = "";
    let ffprobe = "";
    let ffprobeError = "";
    try { ffmpeg = await ffmpegVersion(); } catch (error) { ffmpegError = error instanceof Error ? error.message : String(error); }
    try { ffprobe = await ffprobeVersion(); } catch (error) { ffprobeError = error instanceof Error ? error.message : String(error); }
    return {
      ok: true,
      value: {
        endpoint: tts.endpoint,
        model,
        models: tts.models,
        modelsError: tts.modelsError,
        voices: tts.voices,
        voicesError: tts.voicesError,
        ffmpeg,
        ffmpegError,
        ffprobe,
        ffprobeError,
        sharpVersion: sharp.versions?.sharp || sharp.versions?.vips || "unknown",
        llmAvailable: Boolean(serviceOf(ctx, "llm")),
        webAvailable: Boolean(serviceOf(ctx, "web")),
      },
    };
  };

  // 设置页、测试桥、artifact 流
  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), "explainer-video: settings page policy");
    sctx.effect(() => {
      const disposers = makeBridgeRoutes({ ctx, describe, save, test }).map((route) => sctx.webServer.register(route));
      disposers.push(
        sctx.webServer.register({
          kind: "prefix",
          path: ARTIFACT_PREFIX,
          handler: (req, res) => handleArtifactRequest(req, res, artifacts),
        })
      );
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "explainer-video: bridge and artifact routes");
    logger.info(`explainer-video: bridge ready at ${BRIDGE_PREFIX} (${PLUGIN_VERSION})`);
  });

  // 工具注册
  ctx.inject(["tools", "webServer", "settings"], (sctx) => {
    let disposeGenerate = null;
    let disposeRender = null;
    const refresh = () => {
      if (disposeGenerate) {
        disposeGenerate();
        disposeGenerate = null;
      }
      if (disposeRender) {
        disposeRender();
        disposeRender = null;
      }
      if (!current().enabled) return;
      const publicBase = `http://127.0.0.1:${sctx.webServer.port}`;
      disposeGenerate = sctx.tools.register(buildGenerateTool({ ctx, current, publicBase, artifacts, logger }));
      disposeRender = sctx.tools.register(buildRenderTool({ ctx, current, publicBase, artifacts, logger }));
    };
    sctx.effect(() => {
      refresh();
      return () => {
        if (disposeGenerate) disposeGenerate();
        if (disposeRender) disposeRender();
      };
    }, "explainer-video: tools");
    sctx.on("settings/document-updated", (ns) => {
      if (String(ns) === NS) refresh();
    });
  });

  logger.info(
    `explainer-video: ready (${PLUGIN_VERSION}) — configure at Plugins → dsh-explainer-video → ${NS}; tools: explainer_video_generate, explainer_video_render`
  );
}

export {
  Config,
  apply,
  PLUGIN_VERSION,
  NS,
  BRIDGE_PREFIX,
  ARTIFACT_PREFIX,
  outputSchema,
};
