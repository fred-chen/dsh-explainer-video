// dsh-explainer-video — 纯逻辑层（无宿主依赖，可独立测试）
//
// 配置默认值、storyboard 校验、场景时长/时间轴、JSON 提取、文件名与哈希。

import { createHash } from "node:crypto";
import path from "node:path";

import { ICON_NAMES } from "./icons.js";

export const LAYOUTS = ["hero", "split", "chart", "diagram", "timeline", "comparison", "quote"];
export const ANIMATIONS = ["fade", "slide", "scale", "draw", "pop"];
export const TRANSITIONS = ["cut", "fade"];
export const SUBTITLE_MODES = ["none", "burn", "srt"];
export const WEB_MODES = ["auto", "off", "always"];
export const TTS_FORMATS = ["wav", "mp3", "flac", "pcm", "aac", "opus"];

export const DEFAULT_CONFIG = {
  enabled: true,
  llmProvider: "",
  llmModel: "",
  llmMaxTokens: 8192,
  language: "zh",
  ttsEndpoint: "http://ai4090:8080/v1/audio",
  ttsModel: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
  ttsVoice: "uncle_fu",
  ttsLanguage: "",
  ttsInstructions: "",
  ttsFormat: "wav",
  ttsSampleRate: 0,
  ttsTimeoutSec: 300,
  webMode: "auto",
  webMaxQueries: 6,
  webMaxSources: 8,
  webMaxChars: 40000,
  webTimeoutSec: 60,
  asrEndpoint: "",
  asrModel: "",
  stylePreset: "dark-neon",
  width: 1920,
  height: 1080,
  fps: 30,
  targetDurationSec: 300,
  sceneGapSec: 0.3,
  fontFamily: "PingFang SC, Helvetica Neue, Arial",
  outputDir: ".dsh-explainer-video",
  maxSourceChars: 120000,
  subtitleMode: "none",
  bgmPath: "",
  bgmVolume: 0.12,
  timeoutSec: 1800,
  keepWorkDir: true,
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value, fallback = "") {
  return value === null || value === undefined ? fallback : String(value).trim();
}

export function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  }
  return out;
}

export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const format = str(cfg.ttsFormat, DEFAULT_CONFIG.ttsFormat).toLowerCase();
  return {
    enabled: cfg.enabled !== false,
    llmProvider: str(cfg.llmProvider),
    llmModel: str(cfg.llmModel),
    llmMaxTokens: clampInt(cfg.llmMaxTokens, DEFAULT_CONFIG.llmMaxTokens, 1024, 32768),
    language: str(cfg.language, DEFAULT_CONFIG.language) || DEFAULT_CONFIG.language,
    ttsEndpoint: str(cfg.ttsEndpoint, DEFAULT_CONFIG.ttsEndpoint) || DEFAULT_CONFIG.ttsEndpoint,
    ttsModel: str(cfg.ttsModel, DEFAULT_CONFIG.ttsModel) || DEFAULT_CONFIG.ttsModel,
    ttsVoice: str(cfg.ttsVoice, DEFAULT_CONFIG.ttsVoice),
    ttsLanguage: str(cfg.ttsLanguage),
    ttsInstructions: str(cfg.ttsInstructions),
    ttsFormat: TTS_FORMATS.includes(format) ? format : DEFAULT_CONFIG.ttsFormat,
    ttsSampleRate: [0, 8000, 24000].includes(Number(cfg.ttsSampleRate)) ? Number(cfg.ttsSampleRate) : 0,
    ttsApiKey: typeof cfg.ttsApiKey === "string" ? cfg.ttsApiKey : "",
    ttsTimeoutSec: clampInt(cfg.ttsTimeoutSec, DEFAULT_CONFIG.ttsTimeoutSec, 10, 3600),
    ttsExtraParams: typeof cfg.ttsExtraParams === "string" ? cfg.ttsExtraParams : "",
    webMode: WEB_MODES.includes(str(cfg.webMode)) ? str(cfg.webMode) : DEFAULT_CONFIG.webMode,
    webMaxQueries: clampInt(cfg.webMaxQueries, DEFAULT_CONFIG.webMaxQueries, 0, 12),
    webMaxSources: clampInt(cfg.webMaxSources, DEFAULT_CONFIG.webMaxSources, 0, 20),
    webMaxChars: clampInt(cfg.webMaxChars, DEFAULT_CONFIG.webMaxChars, 0, 200000),
    webTimeoutSec: clampInt(cfg.webTimeoutSec, DEFAULT_CONFIG.webTimeoutSec, 5, 300),
    asrEndpoint: str(cfg.asrEndpoint),
    asrModel: str(cfg.asrModel),
    asrApiKey: typeof cfg.asrApiKey === "string" ? cfg.asrApiKey : "",
    stylePreset: str(cfg.stylePreset, DEFAULT_CONFIG.stylePreset) || DEFAULT_CONFIG.stylePreset,
    width: clampInt(cfg.width, DEFAULT_CONFIG.width, 320, 3840),
    height: clampInt(cfg.height, DEFAULT_CONFIG.height, 240, 2160),
    fps: clampInt(cfg.fps, DEFAULT_CONFIG.fps, 12, 60),
    targetDurationSec: clampInt(cfg.targetDurationSec, DEFAULT_CONFIG.targetDurationSec, 20, 1200),
    sceneGapSec: clampNumber(cfg.sceneGapSec, DEFAULT_CONFIG.sceneGapSec, 0, 2),
    fontFamily: str(cfg.fontFamily, DEFAULT_CONFIG.fontFamily) || DEFAULT_CONFIG.fontFamily,
    outputDir: str(cfg.outputDir, DEFAULT_CONFIG.outputDir) || DEFAULT_CONFIG.outputDir,
    maxSourceChars: clampInt(cfg.maxSourceChars, DEFAULT_CONFIG.maxSourceChars, 1000, 500000),
    subtitleMode: SUBTITLE_MODES.includes(str(cfg.subtitleMode)) ? str(cfg.subtitleMode) : DEFAULT_CONFIG.subtitleMode,
    bgmPath: str(cfg.bgmPath),
    bgmVolume: clampNumber(cfg.bgmVolume, DEFAULT_CONFIG.bgmVolume, 0, 1),
    timeoutSec: clampInt(cfg.timeoutSec, DEFAULT_CONFIG.timeoutSec, 60, 3600),
    keepWorkDir: cfg.keepWorkDir !== false,
  };
}

export function publicConfig(cfg) {
  const { ttsApiKey, asrApiKey, ...rest } = cfg;
  return rest;
}

export function aspectToSize(aspect, fallbackWidth, fallbackHeight) {
  if (!aspect) return { width: fallbackWidth, height: fallbackHeight };
  const key = String(aspect).trim().toLowerCase();
  if (key === "16:9" || key === "16x9") return { width: fallbackWidth, height: Math.round((fallbackWidth * 9) / 16) };
  if (key === "9:16" || key === "9x16") return { width: fallbackWidth, height: Math.round((fallbackWidth * 16) / 9) };
  if (key === "1:1" || key === "1x1") return { width: fallbackWidth, height: fallbackWidth };
  return { width: fallbackWidth, height: fallbackHeight };
}

export function sanitizeFileName(raw) {
  const name = String(raw || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return name.slice(0, 120);
}

export function outputFileName({ title, outputName }) {
  if (outputName) {
    const safe = sanitizeFileName(outputName);
    return /\.[a-z0-9]+$/i.test(safe) ? safe : `${safe}.mp4`;
  }
  const slug = String(title || "explainer")
    .replace(/[^0-9A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "explainer";
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${slug}-${ts}.mp4`;
}

export function hashKey(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function extractJson(text) {
  const raw = String(text || "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1].trim() : raw.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "JSON 根必须是对象" };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

function validateElement(element, assetIds, index) {
  const errors = [];
  const label = `scene element[${index}]`;
  if (!element || typeof element !== "object") {
    errors.push(`${label} 必须是对象`);
    return errors;
  }
  const type = String(element.type || "");
  if (!["text", "icon", "pill", "chart", "diagram", "timeline", "image", "arrow"].includes(type)) {
    errors.push(`${label} 未知类型 "${type}"`);
    return errors;
  }
  if (element.color && !isHexColor(element.color)) errors.push(`${label} color 必须是 #RRGGBB`);
  if (element.animate && typeof element.animate === "object") {
    if (element.animate.in && !ANIMATIONS.includes(element.animate.in)) {
      errors.push(`${label} animate.in 不支持 "${element.animate.in}"`);
    }
    if (element.animate.delay !== undefined && !Number.isFinite(Number(element.animate.delay))) {
      errors.push(`${label} animate.delay 必须是数字`);
    }
    if (element.animate.duration !== undefined && !Number.isFinite(Number(element.animate.duration))) {
      errors.push(`${label} animate.duration 必须是数字`);
    }
  }
  if (type === "text") {
    if (!String(element.text || "").trim()) errors.push(`${label} text.text 不能为空`);
    if (element.size !== undefined && !Number.isFinite(Number(element.size))) errors.push(`${label} text.size 必须是数字`);
    if (element.align && !["left", "center", "right"].includes(element.align)) errors.push(`${label} text.align 不支持`);
  }
  if (type === "icon") {
    if (!ICON_NAMES.includes(String(element.name))) errors.push(`${label} 未知 icon "${element.name}"`);
    if (element.size !== undefined && !Number.isFinite(Number(element.size))) errors.push(`${label} icon.size 必须是数字`);
  }
  if (type === "pill") {
    if (!String(element.text || "").trim()) errors.push(`${label} pill.text 不能为空`);
  }
  if (type === "chart") {
    if (!["line", "bar", "area"].includes(String(element.kind || ""))) errors.push(`${label} chart.kind 不支持`);
    if (!Array.isArray(element.series) || element.series.length === 0) {
      errors.push(`${label} chart.series 不能为空`);
    } else {
      for (const [seriesIndex, series] of element.series.entries()) {
        if (!series || typeof series !== "object") {
          errors.push(`${label} chart.series[${seriesIndex}] 必须是对象`);
          continue;
        }
        if (!String(series.label || "").trim()) errors.push(`${label} chart.series[${seriesIndex}].label 不能为空`);
        if (element.kind === "bar") {
          if (!Number.isFinite(Number(series.value))) errors.push(`${label} chart.series[${seriesIndex}].value 必须是数字`);
        } else if (!Array.isArray(series.points) || series.points.length < 2) {
          errors.push(`${label} chart.series[${seriesIndex}].points 至少 2 个点`);
        } else {
          for (const [pointIndex, point] of series.points.entries()) {
            if (!point || !Number.isFinite(Number(point.y))) {
              errors.push(`${label} chart.series[${seriesIndex}].points[${pointIndex}].y 必须是数字`);
            }
          }
        }
      }
    }
  }
  if (type === "diagram") {
    if (!Array.isArray(element.nodes) || element.nodes.length === 0) errors.push(`${label} diagram.nodes 不能为空`);
    else {
      const ids = new Set();
      for (const node of element.nodes) {
        if (!node || !String(node.id || "").trim()) errors.push(`${label} diagram node.id 不能为空`);
        else if (ids.has(String(node.id))) errors.push(`${label} diagram node.id 重复`);
        else ids.add(String(node.id));
        if (node.icon && !ICON_NAMES.includes(String(node.icon))) errors.push(`${label} diagram node.icon 未知`);
      }
      for (const edge of element.edges || []) {
        if (!edge || !ids.has(String(edge.from)) || !ids.has(String(edge.to))) {
          errors.push(`${label} diagram edge 必须引用已有 node.id`);
        }
      }
    }
  }
  if (type === "timeline") {
    if (!Array.isArray(element.items) || element.items.length < 2) errors.push(`${label} timeline.items 至少 2 个`);
  }
  if (type === "image") {
    if (!String(element.assetId || "").trim()) errors.push(`${label} image.assetId 不能为空`);
    else if (!assetIds.has(String(element.assetId))) errors.push(`${label} image.assetId 不存在`);
  }
  if (type === "arrow") {
    if (!String(element.from || "").trim() || !String(element.to || "").trim()) {
      errors.push(`${label} arrow.from/to 不能为空`);
    }
  }
  return errors;
}

export function validateStoryboard(storyboard, assetIds = new Set(), allowedSourceIds = new Set()) {
  const errors = [];
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) {
    return { ok: false, errors: ["storyboard 必须是对象"] };
  }
  if (Number(storyboard.version) !== 1) errors.push("version 必须是 1");
  if (!String(storyboard.title || "").trim()) errors.push("title 不能为空");
  if (!String(storyboard.language || "").trim()) errors.push("language 不能为空");
  if (!String(storyboard.style || "").trim()) errors.push("style 不能为空");
  const width = Number(storyboard.width);
  const height = Number(storyboard.height);
  const fps = Number(storyboard.fps);
  if (!Number.isInteger(width) || width < 320 || width > 3840) errors.push("width 不合法");
  if (!Number.isInteger(height) || height < 240 || height > 3840) errors.push("height 不合法");
  if (!Number.isInteger(fps) || fps < 12 || fps > 60) errors.push("fps 不合法");

  const chapters = Array.isArray(storyboard.chapters) ? storyboard.chapters : [];
  const chapterIds = new Set();
  for (const [index, chapter] of chapters.entries()) {
    if (!chapter || !String(chapter.id || "").trim()) errors.push(`chapters[${index}].id 不能为空`);
    else if (chapterIds.has(String(chapter.id))) errors.push(`chapters[${index}].id 重复`);
    else chapterIds.add(String(chapter.id));
    if (!String(chapter.title || "").trim()) errors.push(`chapters[${index}].title 不能为空`);
  }

  const references = Array.isArray(storyboard.references) ? storyboard.references : [];
  const referenceIds = new Set();
  for (const [index, reference] of references.entries()) {
    if (!reference || !String(reference.id || "").trim()) {
      errors.push(`references[${index}].id 不能为空`);
      continue;
    }
    if (referenceIds.has(String(reference.id))) errors.push(`references[${index}].id 重复`);
    referenceIds.add(String(reference.id));
    if (reference.kind === "web" && !String(reference.url || "").trim()) {
      errors.push(`references[${index}] web 来源必须有 url`);
    }
    if (!reference.label && !reference.url) errors.push(`references[${index}] 必须有 label 或 url`);
  }

  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) errors.push("scenes 不能为空");
  if (scenes.length > 80) errors.push("scenes 不能超过 80 个");
  const sceneIds = new Set();

  for (const [sceneIndex, scene] of scenes.entries()) {
    if (!scene || typeof scene !== "object") {
      errors.push(`scenes[${sceneIndex}] 必须是对象`);
      continue;
    }
    const sceneLabel = `scenes[${sceneIndex}]`;
    if (!String(scene.id || "").trim()) errors.push(`${sceneLabel}.id 不能为空`);
    else if (sceneIds.has(String(scene.id))) errors.push(`${sceneLabel}.id 重复`);
    else sceneIds.add(String(scene.id));
    if (scene.chapterId && !chapterIds.has(String(scene.chapterId))) errors.push(`${sceneLabel}.chapterId 不存在`);
    if (!LAYOUTS.includes(String(scene.layout))) errors.push(`${sceneLabel}.layout 不支持`);
    if (!String(scene.headline || "").trim()) errors.push(`${sceneLabel}.headline 不能为空`);
    if (String(scene.headline || "").length > 180) errors.push(`${sceneLabel}.headline 过长`);
    if (String(scene.kicker || "").length > 80) errors.push(`${sceneLabel}.kicker 过长`);
    if (String(scene.subhead || "").length > 160) errors.push(`${sceneLabel}.subhead 过长`);
    if (!String(scene.narration || "").trim()) errors.push(`${sceneLabel}.narration 不能为空`);
    if (String(scene.narration || "").length > 900) errors.push(`${sceneLabel}.narration 过长`);
    if (String(scene.ttsText || "").length > 900) errors.push(`${sceneLabel}.ttsText 过长`);
    if (scene.accent && !isHexColor(scene.accent)) errors.push(`${sceneLabel}.accent 必须是 #RRGGBB`);
    if (scene.transition && !TRANSITIONS.includes(String(scene.transition))) errors.push(`${sceneLabel}.transition 不支持`);
    if (scene.sourceIds !== undefined && !Array.isArray(scene.sourceIds)) errors.push(`${sceneLabel}.sourceIds 必须是数组`);
    for (const sourceId of scene.sourceIds || []) {
      if (!referenceIds.has(String(sourceId)) && !allowedSourceIds.has(String(sourceId))) errors.push(`${sceneLabel}.sourceIds 引用不存在`);
    }
    const elements = Array.isArray(scene.elements) ? scene.elements : [];
    if (elements.length > 12) errors.push(`${sceneLabel}.elements 不能超过 12 个`);
    for (const [elementIndex, element] of elements.entries()) {
      errors.push(...validateElement(element, assetIds, elementIndex));
    }
  }

  return { ok: errors.length === 0, errors };
}

export function estimateSceneDuration(scene, language = "zh") {
  const text = String(scene.ttsText || scene.narration || "");
  const zh = String(language).toLowerCase().startsWith("zh") || /[\u4e00-\u9fff]/.test(text);
  const duration = zh
    ? text.replace(/\s+/g, "").length / 4.2 + 0.9
    : text.split(/\s+/).filter(Boolean).length / 2.5 + 0.9;
  return Math.min(30, Math.max(5, duration));
}

export function sceneDurationFromAudio(audioDuration, fps, minSec = 5, maxSec = 30, gapSec = 0.3) {
  const raw = Math.max(minSec, Number(audioDuration) + gapSec);
  const frames = Math.max(1, Math.round(raw * fps));
  return { frames, duration: frames / fps, exceededMax: raw > maxSec };
}

export function computeTimeline(scenes, durations, fps) {
  let startFrame = 0;
  const timeline = [];
  const chapterStart = new Map();
  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const frames = Math.max(1, Math.round(Number(durations[index] || 0) * fps));
    const entry = {
      id: scene.id,
      index,
      startFrame,
      frames,
      startSec: startFrame / fps,
      durationSec: frames / fps,
      chapterId: scene.chapterId || "",
      narration: scene.narration || "",
      ttsText: scene.ttsText || scene.narration || "",
    };
    if (entry.chapterId && !chapterStart.has(entry.chapterId)) chapterStart.set(entry.chapterId, startFrame);
    timeline.push(entry);
    startFrame += frames;
  }
  return {
    scenes: timeline,
    totalFrames: startFrame,
    totalDuration: startFrame / fps,
    chapterStart,
  };
}

export function estimateTimeline(storyboard) {
  const durations = storyboard.scenes.map((scene) => estimateSceneDuration(scene, storyboard.language));
  return computeTimeline(storyboard.scenes, durations, storyboard.fps);
}

export function chapterTimeline(storyboard, timeline) {
  const chapters = Array.isArray(storyboard.chapters) ? storyboard.chapters : [];
  return chapters.map((chapter, index) => {
    const startFrame = timeline.chapterStart.get(chapter.id) ?? 0;
    return {
      id: chapter.id,
      title: chapter.title,
      startFrame,
      startSec: startFrame / storyboard.fps,
      index,
    };
  });
}

export function uniquePath(dir, fileName) {
  return path.join(dir, fileName);
}
