// TTS：OpenAI 兼容 /v1/audio/speech，预置音色选择，端点可配置，缓存与时长探测。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  VOICE_PRESETS,
  VOICE_LIST,
  buildSpeechPayload,
  buildTtsCacheKey,
  defaultVoiceForLanguage,
  deriveModelsUrl,
  deriveSpeechUrl,
  deriveVoicesUrl,
  formatApiError,
  isVoiceDesignModel,
  normalizeEndpoint,
  normalizeFormat,
  normalizeLanguageForTts,
  normalizeSampleRate,
  normalizeVoice,
  parseExtraParams,
  parseVoiceList,
} from "./tts-core.js";
import { convertToWav, probeAudio } from "./media.js";
import { hashKey } from "./core.js";

const voiceCache = new Map();

async function fetchWithTimeout(url, init, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal.reason || new Error("aborted"));
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    if (controller.signal.aborted) throw new Error(`TTS 请求超时（${timeoutMs}ms）：${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function authHeaders(apiKey, json) {
  const headers = {};
  if (json) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function listVoices({ endpoint, model, apiKey, timeoutSec = 10, signal, logger }) {
  let base;
  try {
    base = normalizeEndpoint(endpoint);
  } catch (error) {
    return { voices: null, error: error instanceof Error ? error.message : String(error) };
  }
  const cacheKey = `${base}|${model}`;
  const cached = voiceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const url = `${deriveVoicesUrl(base)}?model=${encodeURIComponent(model)}`;
  try {
    const response = await fetchWithTimeout(url, { headers: authHeaders(apiKey, false) }, Math.max(3, timeoutSec) * 1000, signal);
    const text = await response.text();
    if (response.status === 404) {
      const value = { voices: null, error: "" };
      voiceCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const value = { voices: null, error: formatApiError(response.status, payload) };
      voiceCache.set(cacheKey, { at: Date.now(), value });
      return value;
    }
    const value = { voices: parseVoiceList(payload), error: "" };
    voiceCache.set(cacheKey, { at: Date.now(), value });
    logger?.info?.(`explainer: /voices ${model} -> ${value.voices.join(", ") || "(empty)"}`);
    return value;
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    return { voices: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkTtsEndpoint({ endpoint, model, apiKey, timeoutSec = 10, signal }) {
  let base;
  try {
    base = normalizeEndpoint(endpoint);
  } catch (error) {
    return { ok: false, endpoint: String(endpoint || ""), error: error instanceof Error ? error.message : String(error) };
  }
  const result = { ok: true, endpoint: base, model, models: [], modelsError: "", voices: [], voicesError: "" };
  try {
    const response = await fetchWithTimeout(deriveModelsUrl(base), { headers: authHeaders(apiKey, false) }, Math.max(3, timeoutSec) * 1000, signal);
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = text; }
    if (!response.ok) result.modelsError = formatApiError(response.status, payload);
    else result.models = (payload?.data || []).filter((entry) => {
      const caps = entry.capabilities || {};
      const arch = entry.architecture || {};
      return caps.audio_speech || (arch.output_modalities || []).includes("audio") || /tts/i.test(entry.id || "");
    }).map((entry) => ({ id: entry.id, status: entry.status?.value || entry.status || "?" }));
  } catch (error) {
    result.modelsError = error instanceof Error ? error.message : String(error);
  }
  const voices = await listVoices({ endpoint: base, model, apiKey, timeoutSec, signal });
  result.voices = voices.voices || [];
  result.voicesError = voices.error || "";
  return result;
}

export function resolveVoiceSelection({ model, requestedVoice, language, availableVoices }) {
  const warnings = [];
  if (isVoiceDesignModel(model)) {
    const raw = String(requestedVoice || "").trim();
    const preset = normalizeVoice(raw);
    if (preset.preset) warnings.push(`VoiceDesign 模型收到预置音色 id "${raw}"，将按自由音色描述发送。`);
    const voice = raw || defaultVoiceForLanguage(model, language);
    return {
      voice,
      preset: false,
      language: normalizeLanguageForTts(language) || "",
      warnings,
    };
  }
  const raw = String(requestedVoice || "").trim() || defaultVoiceForLanguage(model, language);
  const normalized = normalizeVoice(raw);
  if (!normalized.preset) {
    const available = Array.isArray(availableVoices) && availableVoices.length > 0
      ? availableVoices
      : Object.keys(VOICE_PRESETS);
    throw new Error(
      `音色「${raw}」不是 CustomVoice 预置音色。可用音色：${available.join(", ")}。` +
      "如果要使用自由音色描述，请把 ttsModel 切到 Qwen3-TTS-...-VoiceDesign。"
    );
  }
  if (Array.isArray(availableVoices) && availableVoices.length > 0 && !availableVoices.includes(normalized.voice)) {
    throw new Error(
      `音色「${normalized.voice}」不在服务端当前可用列表。可用音色：${availableVoices.join(", ")}。`
    );
  }
  return {
    voice: normalized.voice,
    preset: true,
    language: normalizeLanguageForTts(language) || normalized.inferredLanguage,
    warnings,
  };
}

async function readCache(wavPath, metaPath) {
  try {
    const buffer = await readFile(wavPath);
    let meta = null;
    try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch { meta = null; }
    if (!meta) {
      const audio = await probeAudio(wavPath);
      meta = { durationSeconds: audio.duration, sampleRate: audio.sampleRate };
    }
    return { buffer, meta };
  } catch {
    return null;
  }
}

export async function synthesizeSpeech({
  endpoint,
  apiKey,
  model,
  text,
  voice,
  language,
  instructions,
  format,
  sampleRate,
  extraParams,
  timeoutSec = 300,
  signal,
  cacheDir,
  logger,
}) {
  const base = normalizeEndpoint(endpoint);
  const normalizedFormat = normalizeFormat(format);
  const normalizedSampleRate = normalizeSampleRate(sampleRate);
  const extra = parseExtraParams(extraParams);
  const payload = buildSpeechPayload({
    model,
    input: text,
    voice,
    language,
    instructions,
    format: normalizedFormat,
    sampleRate: normalizedSampleRate,
    extra,
  });
  const cacheKey = buildTtsCacheKey({
    endpoint: base,
    model,
    voice,
    language,
    instructions,
    format: normalizedFormat,
    sampleRate: normalizedSampleRate,
    extraParams: extra,
    input: text,
  });
  const hash = hashKey(cacheKey);
  await mkdir(cacheDir, { recursive: true });
  const wavPath = path.join(cacheDir, `${hash}.wav`);
  const metaPath = path.join(cacheDir, `${hash}.json`);
  const cached = await readCache(wavPath, metaPath);
  if (cached) {
    logger?.info?.(`explainer: TTS cache hit ${hash.slice(0, 10)}`);
    return {
      wavPath,
      durationSeconds: Number(cached.meta.durationSeconds) || 0,
      sampleRate: Number(cached.meta.sampleRate) || 0,
      cached: true,
      bytes: cached.buffer.length,
      voice,
      model,
      language,
      instructions,
      format: "wav",
    };
  }

  const url = deriveSpeechUrl(base);
  const timeoutMs = Math.max(10, timeoutSec) * 1000;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { method: "POST", headers: authHeaders(apiKey, true), body: JSON.stringify(payload) },
        timeoutMs,
        signal
      );
      if (!response.ok) {
        let body = "";
        try { body = await response.text(); } catch { body = ""; }
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        const message = formatApiError(response.status, parsed);
        if ((response.status === 429 || response.status >= 500) && attempt === 1) {
          lastError = new Error(message);
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        throw new Error(`TTS 合成失败 — ${message}`);
      }
      const contentType = response.headers.get("content-type") || "";
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error("TTS 服务返回了空音频");
      if (contentType.includes("application/json") || contentType.includes("text/")) {
        throw new Error(`TTS 服务返回了非音频内容：${buffer.toString("utf8").slice(0, 300)}`);
      }
      const durationHeader = Number(response.headers.get("x-audio-duration-seconds"));
      const sampleRateHeader = Number(response.headers.get("x-audio-sample-rate"));

      if (normalizedFormat === "wav") {
        await writeFile(wavPath, buffer);
      } else {
        const originalPath = path.join(cacheDir, `${hash}.${normalizedFormat}`);
        await writeFile(originalPath, buffer);
        await convertToWav(originalPath, wavPath, { signal });
      }
      let durationSeconds = Number.isFinite(durationHeader) ? durationHeader : 0;
      let outSampleRate = Number.isFinite(sampleRateHeader) ? sampleRateHeader : 0;
      if (!durationSeconds || !outSampleRate) {
        const audio = await probeAudio(wavPath, signal);
        if (!durationSeconds) durationSeconds = audio.duration;
        if (!outSampleRate) outSampleRate = audio.sampleRate;
      }
      const meta = {
        cacheKey,
        model,
        voice,
        language: language || "",
        instructions: instructions || "",
        format: "wav",
        sampleRate: outSampleRate,
        durationSeconds,
        bytes: buffer.length,
        createdAt: new Date().toISOString(),
      };
      await writeFile(metaPath, JSON.stringify(meta, null, 2));
      logger?.info?.(`explainer: TTS ${model}/${voice} ${durationSeconds.toFixed(2)}s cached`);
      return {
        wavPath,
        durationSeconds,
        sampleRate: outSampleRate,
        cached: false,
        bytes: buffer.length,
        voice,
        model,
        language: language || "",
        instructions: instructions || "",
        format: "wav",
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || new Error("aborted");
      lastError = error;
      if (attempt === 2) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function synthesizeScenes({
  storyboard,
  config,
  args,
  workDir,
  signal,
  logger,
}) {
  const model = String(args.ttsModel || config.ttsModel || "").trim();
  const requestedVoice = String(args.voice ?? config.ttsVoice ?? "").trim();
  const language = String(args.language || config.ttsLanguage || storyboard.language || "").trim();
  const instructions = String(args.ttsInstructions ?? config.ttsInstructions ?? "").trim();
  const voices = await listVoices({
    endpoint: config.ttsEndpoint,
    model,
    apiKey: config.ttsApiKey,
    timeoutSec: 10,
    signal,
    logger,
  });
  const selection = resolveVoiceSelection({
    model,
    requestedVoice,
    language,
    availableVoices: voices.voices,
  });
  const warnings = [...selection.warnings];
  if (voices.error) warnings.push(`音色列表读取失败，使用内置预置表：${voices.error}`);
  await mkdir(path.join(workDir, "tts"), { recursive: true });
  const scenes = [];
  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    const scene = storyboard.scenes[index];
    const text = String(scene.ttsText || scene.narration || "").trim();
    if (!text) throw new Error(`scene ${scene.id} 没有旁白文本`);
    const result = await synthesizeSpeech({
      endpoint: config.ttsEndpoint,
      apiKey: config.ttsApiKey,
      model,
      text,
      voice: selection.voice,
      language: selection.language,
      instructions,
      format: config.ttsFormat,
      sampleRate: config.ttsSampleRate,
      extraParams: config.ttsExtraParams,
      timeoutSec: config.ttsTimeoutSec,
      signal,
      cacheDir: path.join(workDir, "tts-cache"),
      logger,
    });
    const scenePath = path.join(workDir, "tts", `${scene.id}.wav`);
    await writeFile(scenePath, await readFile(result.wavPath));
    scenes.push({
      id: scene.id,
      wavPath: scenePath,
      durationSeconds: result.durationSeconds,
      cached: result.cached,
    });
    logger?.info?.(`explainer: TTS scene ${scene.id} ${result.durationSeconds.toFixed(2)}s`);
  }
  return {
    model,
    voice: selection.voice,
    language: selection.language,
    instructions,
    scenes,
    warnings,
  };
}

export { VOICE_LIST, VOICE_PRESETS };
