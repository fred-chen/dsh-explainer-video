// dsh-explainer-video — TTS 纯逻辑层
//
// 以 dsh-tts v0.1.3 的约定为蓝本：OpenAI 兼容 /v1/audio/speech、
// Qwen3-TTS CustomVoice 9 个预置音色、端点归一化、payload、错误格式化。
// 本插件不直接调用 dsh-tts 的 tts_generate 工具，避免插件间工具调度耦合。

export const FORMATS = ["wav", "mp3", "flac", "pcm", "aac", "opus"];

export const MIME_BY_FORMAT = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  pcm: "application/octet-stream",
  aac: "audio/aac",
  opus: "audio/ogg",
};

export const VOICE_PRESETS = {
  vivian: { desc: "明亮、略带锋锐的年轻女声", lang: "Chinese", gender: "female" },
  serena: { desc: "温暖柔和的年轻女声", lang: "Chinese", gender: "female" },
  uncle_fu: { desc: "低沉醇厚的成熟男声", lang: "Chinese", gender: "male" },
  dylan: { desc: "清亮自然的北京年轻男声", lang: "Chinese", gender: "male", dialect: "Beijing" },
  eric: { desc: "略带沙哑明亮感的成都男声", lang: "Chinese", gender: "male", dialect: "Sichuan" },
  ryan: { desc: "节奏感强的动态男声", lang: "English", gender: "male" },
  aiden: { desc: "中频清晰的阳光美式男声", lang: "English", gender: "male" },
  ono_anna: { desc: "轻快俏皮的日语女声", lang: "Japanese", gender: "female" },
  sohee: { desc: "情感丰富的温暖韩语女声", lang: "Korean", gender: "female" },
};

export const VOICE_LIST = Object.entries(VOICE_PRESETS).map(([id, preset]) => ({
  id,
  label: `${id} · ${preset.desc}（${preset.lang}）`,
  ...preset,
}));

export function isVoiceDesignModel(model) {
  return /voicedesign/i.test(String(model || ""));
}

export function normalizeVoice(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { voice: "", preset: false, inferredLanguage: "" };
  const key = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (VOICE_PRESETS[key]) {
    return { voice: key, preset: true, inferredLanguage: VOICE_PRESETS[key].lang };
  }
  return { voice: value, preset: false, inferredLanguage: "" };
}

export function voiceLanguage(voice) {
  const normalized = normalizeVoice(voice);
  return normalized.inferredLanguage;
}

export function defaultVoiceForLanguage(model, language) {
  if (isVoiceDesignModel(model)) return "一位沉稳清晰的中文男声，语速适中";
  const key = String(language || "").toLowerCase();
  if (key.startsWith("en")) return "aiden";
  if (key.startsWith("ja")) return "ono_anna";
  if (key.startsWith("ko")) return "sohee";
  return "uncle_fu";
}

export function normalizeLanguageForTts(language) {
  const key = String(language || "").trim().toLowerCase();
  if (!key) return "";
  if (key === "zh" || key.startsWith("zh-") || key === "chinese") return "Chinese";
  if (key === "en" || key.startsWith("en-") || key === "english") return "English";
  if (key === "ja" || key.startsWith("ja-") || key === "japanese") return "Japanese";
  if (key === "ko" || key.startsWith("ko-") || key === "korean") return "Korean";
  return String(language);
}

export function normalizeEndpoint(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("endpoint 不能为空");
  if (!/^https?:\/\//i.test(value)) throw new Error(`endpoint 必须以 http:// 或 https:// 开头: ${value}`);
  value = value.replace(/\/+$/u, "");
  if (/\/speech$/i.test(value)) value = value.replace(/\/speech$/i, "");
  if (/\/v1$/i.test(value)) value = `${value}/audio`;
  else if (!/\/v1\/audio$/i.test(value)) {
    const url = new URL(value);
    if (url.pathname === "" || url.pathname === "/") value = `${value}/v1/audio`;
  }
  return value;
}

export function deriveSpeechUrl(audioBase) {
  return `${audioBase}/speech`;
}

export function deriveVoicesUrl(audioBase) {
  return `${audioBase}/voices`;
}

export function deriveModelsUrl(audioBase) {
  const url = new URL(audioBase);
  return `${url.protocol}//${url.host}/v1/models`;
}

export function normalizeFormat(raw, fallback = "wav") {
  const format = String(raw || fallback).toLowerCase().trim();
  if (!FORMATS.includes(format)) {
    throw new Error(`不支持的格式 "${raw}"，可选：${FORMATS.join(" / ")}`);
  }
  return format;
}

export function normalizeSampleRate(raw, fallback = 0) {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (n !== 0 && n !== 8000 && n !== 24000) {
    throw new Error(`sampleRate 只能是 0（原生）/ 8000 / 24000，收到 ${raw}`);
  }
  return n;
}

export function parseExtraParams(raw) {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw === "object") return raw;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`ttsExtraParams 必须是合法 JSON 对象: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ttsExtraParams 必须是非数组的 JSON 对象");
  }
  return parsed;
}

export function buildSpeechPayload({ model, input, voice, language, instructions, format, sampleRate, extra }) {
  const payload = { model, input, voice, response_format: format };
  if (language) payload.language = language;
  if (instructions) payload.instructions = instructions;
  if (sampleRate) payload.sample_rate = sampleRate;
  if (extra && typeof extra === "object") Object.assign(payload, extra);
  return payload;
}

export function formatApiError(status, body) {
  let detail = "";
  if (typeof body === "string") detail = body;
  else if (body && typeof body === "object") {
    detail = body.error?.message || body.message || body.error || body.detail || "";
    if (typeof detail !== "string") detail = JSON.stringify(detail);
    if (body.src) detail = `${detail} (src=${body.src})`;
  }
  detail = String(detail).slice(0, 700);
  return `HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

export function pickAudioModels(modelsData) {
  const out = [];
  for (const model of modelsData?.data || []) {
    const caps = model.capabilities || {};
    const arch = model.architecture || {};
    const isAudio = caps.audio_speech || (arch.output_modalities || []).includes("audio");
    if (isAudio || /tts/i.test(model.id || "")) {
      out.push({ id: model.id, status: model.status?.value || model.status || "?" });
    }
  }
  return out;
}

export function parseVoiceList(payload) {
  if (!payload || typeof payload !== "object") return [];
  const list = payload.voices || payload.data || [];
  if (!Array.isArray(list)) return [];
  return list.map((voice) => {
    if (typeof voice === "string") return voice;
    if (voice && typeof voice === "object") return String(voice.id || voice.name || voice.voice || "");
    return "";
  }).filter(Boolean);
}

export function buildTtsCacheKey({ endpoint, model, voice, language, instructions, format, sampleRate, extraParams, input }) {
  return [
    "tts",
    endpoint,
    model,
    voice,
    language || "",
    instructions || "",
    format,
    sampleRate || 0,
    JSON.stringify(extraParams || {}),
    input,
  ].join("|");
}
