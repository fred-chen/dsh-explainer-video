// 素材解析：文本/PDF/PPTX/DOCX/视频 → source notes + asset manifest。
//
// 文档解析交给 scripts/extract_materials.py（PyMuPDF / python-pptx / python-docx，
// 并在库缺失时用 stdlib zip+XML fallback）。视频走 ffprobe/ffmpeg，可选 ASR 转写。

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { runCommand, probeMedia, ffprobeJson, convertToWav } from "./media.js";

const EXTRACT_SCRIPT = fileURLToPath(new URL("../scripts/extract_materials.py", import.meta.url));
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log"]);
const DOC_EXTENSIONS = new Set([".pdf", ".pptx", ".ppsx", ".docx"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".flv"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function resolveMaterialPath(cwd, raw) {
  const value = String(raw || "").trim();
  if (!value) throw new Error("素材路径不能为空");
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function textTitle(filePath, text) {
  const first = String(text || "").split(/\n+/).map((line) => line.trim()).find(Boolean);
  return first ? first.slice(0, 120) : path.basename(filePath);
}

function normalizeHex(buffer) {
  if (!buffer || buffer.length < 3) return "#000000";
  return `#${buffer[0].toString(16).padStart(2, "0")}${buffer[1].toString(16).padStart(2, "0")}${buffer[2].toString(16).padStart(2, "0")}`;
}

async function averageFrameColor(filePath) {
  try {
    const raw = await sharp(filePath).resize(1, 1, { fit: "fill" }).raw().toBuffer();
    return normalizeHex(raw);
  } catch {
    return "#000000";
  }
}

async function analyzeReferenceVideo(filePath, workDir, signal, logger) {
  const media = await probeMedia(filePath, signal);
  const duration = Number(media.format?.duration) || 0;
  const width = Number(media.video?.width) || 0;
  const height = Number(media.video?.height) || 0;
  const times = [];
  for (let i = 1; i <= 10; i += 1) times.push(Math.max(0.1, (duration * i) / 11));
  const palette = [];
  let brightness = 0;
  const tempDir = path.join(workDir, "reference");
  await mkdir(tempDir, { recursive: true });
  for (let i = 0; i < times.length; i += 1) {
    const framePath = path.join(tempDir, `ref-${String(i + 1).padStart(2, "0")}.png`);
    try {
      await runCommand(
        "ffmpeg",
        [
          "-y", "-v", "error",
          "-ss", String(times[i]),
          "-i", filePath,
          "-frames:v", "1",
          "-vf", "scale=320:-2",
          framePath,
        ],
        { signal, timeoutMs: 30_000 }
      );
      const stats = await sharp(framePath).stats();
      const mean = stats.channels.slice(0, 3).map((c) => Math.round(c.mean));
      palette.push(normalizeHex(mean));
      brightness += stats.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3;
    } catch {
      // 单帧失败不影响整体
    }
  }
  const paletteUnique = [...new Set(palette)].slice(0, 6);
  const avgBrightness = palette.length ? brightness / palette.length : 0;
  logger?.info?.(`explainer: reference video ${width}x${height}, ${duration.toFixed(1)}s, palette ${paletteUnique.join(", ")}`);
  return {
    duration,
    width,
    height,
    fps: media.video?.r_frame_rate || "",
    palette: paletteUnique,
    brightness: Math.round(avgBrightness),
    aspect: width && height ? `${width}:${height}` : "",
    hint:
      `参考视频风格：${width}x${height}，${duration.toFixed(1)}s；主色 ${paletteUnique.join(", ")}；` +
      `平均亮度 ${Math.round(avgBrightness)}；适合近黑背景、霓虹强调色、粗体字和稀疏构图。`,
  };
}

function deriveTranscriptionUrl(endpoint) {
  const raw = String(endpoint || "").trim().replace(/\/+$/u, "");
  if (!raw) return "";
  if (/\/v1\/audio\/transcriptions$/i.test(raw)) return raw;
  if (/\/v1\/audio$/i.test(raw)) return `${raw}/transcriptions`;
  if (/\/v1$/i.test(raw)) return `${raw}/audio/transcriptions`;
  return raw;
}

async function transcribeAudio(audioPath, asr, signal, logger) {
  if (!asr || !asr.endpoint) return { text: "", warning: "未配置 ASR 端点，视频只做元数据/风格参考。" };
  const url = deriveTranscriptionUrl(asr.endpoint);
  const buffer = await readFile(audioPath);
  const form = new FormData();
  form.append("model", asr.model || "whisper-1");
  form.append("file", new Blob([buffer], { type: "audio/wav" }), path.basename(audioPath));
  if (asr.language) form.append("language", asr.language);
  const headers = {};
  if (asr.apiKey) headers.Authorization = `Bearer ${asr.apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ASR timeout")), Math.max(20, asr.timeoutSec || 120) * 1000);
  const onAbort = () => controller.abort(signal.reason || new Error("aborted"));
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ASR HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return { text: String(data.text || data.transcript || ""), warning: "" };
    }
    return { text: await response.text(), warning: "" };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    logger?.warn?.(`explainer: ASR failed: ${error instanceof Error ? error.message : String(error)}`);
    return { text: "", warning: `ASR 转写失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function extractVideo(filePath, workDir, sourceId, asr, signal, logger) {
  const media = await probeMedia(filePath, signal);
  const source = {
    id: sourceId,
    kind: "video",
    path: filePath,
    title: path.basename(filePath),
    chars: 0,
    pages: 0,
    duration: Number(media.format?.duration) || 0,
    width: Number(media.video?.width) || 0,
    height: Number(media.video?.height) || 0,
  };
  const notes = [];
  const warnings = [];
  if (!media.audio) {
    warnings.push("视频没有音轨，无法转写。");
    return { source, notes, assets: [], warnings };
  }
  const audioPath = path.join(workDir, "media", `${sourceId}.wav`);
  await mkdir(path.dirname(audioPath), { recursive: true });
  await convertToWav(filePath, audioPath, { signal, sampleRate: 16000, channels: 1 });
  const transcript = await transcribeAudio(audioPath, asr, signal, logger);
  if (transcript.warning) warnings.push(transcript.warning);
  if (transcript.text.trim()) {
    notes.push({ sourceId, locator: "transcript", text: transcript.text.trim() });
    source.chars = transcript.text.length;
  }
  return { source, notes, assets: [], warnings };
}

async function extractDocument(filePath, workDir, sourceId, signal) {
  const assetDir = path.join(workDir, "assets", sourceId);
  await mkdir(assetDir, { recursive: true });
  const result = await runCommand("python3", [EXTRACT_SCRIPT, filePath, assetDir], {
    signal,
    timeoutMs: 120_000,
    captureStdout: true,
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`文档解析脚本返回非 JSON：${result.stdout.slice(0, 800)}`);
  }
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

function chunkText(text, maxLen = 6000) {
  const cleaned = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];
  const chunks = [];
  let cursor = 0;
  while (cursor < cleaned.length) {
    let end = Math.min(cleaned.length, cursor + maxLen);
    if (end < cleaned.length) {
      const breakAt = cleaned.lastIndexOf("\n", end);
      if (breakAt > cursor + maxLen * 0.6) end = breakAt;
    }
    chunks.push(cleaned.slice(cursor, end).trim());
    cursor = end;
  }
  return chunks.filter(Boolean);
}

export async function ingestMaterials({
  materials,
  referenceVideo,
  cwd,
  workDir,
  maxSourceChars,
  asr,
  signal,
  logger,
}) {
  await mkdir(workDir, { recursive: true });
  const sources = [];
  const notes = [];
  const assets = [];
  const warnings = [];
  let totalChars = 0;
  let sourceIndex = 0;
  let assetIndex = 0;

  for (const rawPath of materials || []) {
    const filePath = resolveMaterialPath(cwd, rawPath);
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile()) {
        warnings.push(`跳过非文件路径：${filePath}`);
        continue;
      }
    } catch (error) {
      warnings.push(`素材不存在或不可读：${filePath}（${error.message}）`);
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    sourceIndex += 1;
    const sourceId = `src${sourceIndex}`;
    const source = {
      id: sourceId,
      kind: "file",
      path: filePath,
      title: path.basename(filePath),
      chars: 0,
      pages: 0,
    };

    try {
      if (TEXT_EXTENSIONS.has(ext)) {
        const text = await readFile(filePath, "utf8");
        source.title = textTitle(filePath, text);
        source.chars = text.length;
        for (const chunk of chunkText(text, 6000)) {
          notes.push({ sourceId, locator: "text", text: chunk });
        }
      } else if (DOC_EXTENSIONS.has(ext)) {
        const parsed = await extractDocument(filePath, workDir, sourceId, signal);
        source.title = parsed.title || path.basename(filePath);
        source.pages = Number(parsed.pages) || 0;
        source.chars = (parsed.notes || []).reduce((sum, note) => sum + String(note.text || "").length, 0);
        for (const note of parsed.notes || []) {
          notes.push({ sourceId, locator: String(note.locator || ext.replace(".", "")), text: String(note.text || "") });
        }
        for (const asset of parsed.assets || []) {
          assetIndex += 1;
          assets.push({
            id: `${sourceId}-a${assetIndex}`,
            sourceId,
            path: asset.path,
            locator: asset.locator || "",
            width: Number(asset.width) || 0,
            height: Number(asset.height) || 0,
            mime: asset.mime || "",
          });
        }
        for (const warning of parsed.warnings || []) warnings.push(`${path.basename(filePath)}: ${warning}`);
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        const extracted = await extractVideo(filePath, workDir, sourceId, asr, signal, logger);
        source.kind = "video";
        source.title = extracted.source.title;
        source.chars = extracted.source.chars;
        source.duration = extracted.source.duration;
        source.width = extracted.source.width;
        source.height = extracted.source.height;
        for (const note of extracted.notes) notes.push(note);
        for (const warning of extracted.warnings) warnings.push(`${path.basename(filePath)}: ${warning}`);
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        source.kind = "audio";
        const transcript = await transcribeAudio(filePath, asr, signal, logger);
        source.chars = transcript.text.length;
        if (transcript.text.trim()) notes.push({ sourceId, locator: "transcript", text: transcript.text.trim() });
        if (transcript.warning) warnings.push(`${path.basename(filePath)}: ${transcript.warning}`);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        source.kind = "image";
        let meta = null;
        try {
          meta = await sharp(filePath).metadata();
        } catch {
          warnings.push(`图片无法读取：${path.basename(filePath)}`);
          continue;
        }
        assetIndex += 1;
        assets.push({
          id: `${sourceId}-a${assetIndex}`,
          sourceId,
          path: filePath,
          locator: "",
          width: Number(meta.width) || 0,
          height: Number(meta.height) || 0,
          mime: meta.format ? `image/${meta.format}` : "",
        });
      } else {
        warnings.push(`不支持的文件类型：${ext || "无扩展名"}（${path.basename(filePath)}）`);
        sourceIndex -= 1;
        continue;
      }
    } catch (error) {
      warnings.push(`解析失败：${path.basename(filePath)}（${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }

    totalChars += source.chars;
    sources.push(source);
  }

  if (totalChars > maxSourceChars) {
    let budget = maxSourceChars;
    const trimmedNotes = [];
    for (const note of notes) {
      if (budget <= 0) break;
      const text = String(note.text || "");
      const take = Math.min(text.length, budget);
      if (take > 0) trimmedNotes.push({ ...note, text: text.slice(0, take) });
      budget -= take;
    }
    notes.length = 0;
    notes.push(...trimmedNotes);
    warnings.push(`素材总字符超过 ${maxSourceChars}，已截断到预算内。`);
  }

  let reference = null;
  if (referenceVideo) {
    try {
      reference = await analyzeReferenceVideo(resolveMaterialPath(cwd, referenceVideo), workDir, signal, logger);
    } catch (error) {
      warnings.push(`参考视频分析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const materialJson = {
    sources,
    notes,
    assets,
    warnings,
    reference,
    totalChars: notes.reduce((sum, note) => sum + note.text.length, 0),
  };
  await writeFile(path.join(workDir, "materials.json"), JSON.stringify(materialJson, null, 2));
  return materialJson;
}
