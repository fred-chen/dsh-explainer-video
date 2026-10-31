import test from "node:test";
import assert from "node:assert/strict";

import {
  validateStoryboard,
  estimateTimeline,
  computeTimeline,
  estimateSceneDuration,
  sceneDurationFromAudio,
  extractJson,
  normalizeConfig,
  aspectToSize,
} from "../lib/core.js";

import {
  normalizeEndpoint,
  deriveSpeechUrl,
  deriveVoicesUrl,
  deriveModelsUrl,
  normalizeVoice,
  buildSpeechPayload,
  buildTtsCacheKey,
  defaultVoiceForLanguage,
  normalizeLanguageForTts,
} from "../lib/tts-core.js";

const sample = {
  version: 1,
  title: "Test Explainer",
  language: "zh",
  style: "dark-neon",
  width: 1920,
  height: 1080,
  fps: 30,
  targetDurationSec: 30,
  references: [{ id: "src1", kind: "file", label: "报告.pdf p.3" }],
  chapters: [{ id: "ch1", title: "What crashed" }],
  scenes: [
    {
      id: "s01",
      chapterId: "ch1",
      layout: "hero",
      kicker: "STAR 50",
      headline: "中国 AI 泡沫刚刚破裂",
      subhead: "估值修正，不是算力需求消失",
      accent: "#ff5c6c",
      narration: "先把结论说清楚：这次崩的是估值，不是 GPU 需求本身。",
      ttsText: "先把结论说清楚：这次崩的是估值，不是 G P U 需求本身。",
      sourceIds: ["src1"],
      transition: "fade",
      elements: [
        { type: "icon", name: "chart-down", size: 180, color: "#ff5c6c", animate: { in: "draw", delay: 0.2, duration: 0.8 } },
        { type: "pill", text: "STAR 50 ↓ 45%", color: "#ff5c6c", animate: { in: "pop", delay: 0.8 } },
      ],
    },
    {
      id: "s02",
      chapterId: "ch1",
      layout: "chart",
      headline: "GPU 租金真的降了吗？",
      narration: "租金从一万五千五降到一万六千五一个月，幅度并不大。",
      sourceIds: ["src1"],
      elements: [
        {
          type: "chart",
          kind: "bar",
          yLabel: "¥ / month",
          series: [
            { label: "Q2", value: 16500 },
            { label: "Q3", value: 15500 },
          ],
          animate: { reveal: 0.6, delay: 0.4 },
        },
      ],
    },
  ],
};

test("storyboard validates", () => {
  const result = validateStoryboard(sample, new Set());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("storyboard rejects unknown icon and bad chart", () => {
  const bad = JSON.parse(JSON.stringify(sample));
  bad.scenes[0].elements[0].name = "not-an-icon";
  bad.scenes[1].elements[0].series = [{ label: "Q2", value: "nope" }];
  const result = validateStoryboard(bad, new Set());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("未知 icon")));
  assert.ok(result.errors.some((error) => error.includes("value 必须是数字")));
});

test("storyboard accepts allowed source ids without references", () => {
  const candidate = JSON.parse(JSON.stringify(sample));
  candidate.references = [];
  candidate.scenes[0].sourceIds = ["src1"];
  candidate.scenes[1].sourceIds = ["web1"];
  const result = validateStoryboard(candidate, new Set(), new Set(["src1", "web1"]));
  assert.equal(result.ok, true);
});

test("scene timing and timeline", () => {
  const durations = sample.scenes.map((scene) => estimateSceneDuration(scene, "zh"));
  assert.ok(durations[0] >= 5);
  assert.ok(durations[1] >= 5);
  const timeline = computeTimeline(sample.scenes, durations, sample.fps);
  assert.equal(timeline.scenes.length, 2);
  assert.equal(timeline.scenes[0].startFrame, 0);
  assert.equal(timeline.scenes[1].startFrame, timeline.scenes[0].frames);
  assert.equal(timeline.totalFrames, timeline.scenes[0].frames + timeline.scenes[1].frames);
  const estimated = estimateTimeline(sample);
  assert.equal(estimated.totalFrames, timeline.totalFrames);
});

test("audio duration aligns to frames", () => {
  const result = sceneDurationFromAudio(8.05, 30, 5, 30, 0.3);
  assert.equal(result.frames, Math.round(8.35 * 30));
  assert.ok(Math.abs(result.duration - result.frames / 30) < 1e-9);
});

test("json extraction handles code fences and preamble", () => {
  const parsed = extractJson("Here is JSON:\n```json\n{\"a\":1}\n```\nThanks");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.a, 1);
  assert.equal(extractJson("not json").ok, false);
});

test("config normalization", () => {
  const cfg = normalizeConfig({ width: 100, height: 100, fps: 1, webMode: "bad", ttsFormat: "bad", ttsSampleRate: 5 });
  assert.equal(cfg.width, 320);
  assert.equal(cfg.height, 240);
  assert.equal(cfg.fps, 12);
  assert.equal(cfg.webMode, "auto");
  assert.equal(cfg.ttsFormat, "wav");
  assert.equal(cfg.ttsSampleRate, 0);
});

test("aspect to size", () => {
  assert.deepEqual(aspectToSize("16:9", 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(aspectToSize("9:16", 1920, 1080), { width: 1920, height: 3413 });
  assert.deepEqual(aspectToSize("1:1", 1920, 1080), { width: 1920, height: 1920 });
  const portrait = { ...sample, width: 1920, height: 3413 };
  assert.equal(validateStoryboard(portrait, new Set()).ok, true);
});

test("tts endpoint normalization", () => {
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1/audio/speech"), "http://ai4090:8080/v1/audio");
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1/audio"), "http://ai4090:8080/v1/audio");
  assert.equal(normalizeEndpoint("http://ai4090:8080/v1"), "http://ai4090:8080/v1/audio");
  assert.equal(normalizeEndpoint("http://ai4090:8080"), "http://ai4090:8080/v1/audio");
  assert.equal(deriveSpeechUrl("http://ai4090:8080/v1/audio"), "http://ai4090:8080/v1/audio/speech");
  assert.equal(deriveVoicesUrl("http://ai4090:8080/v1/audio"), "http://ai4090:8080/v1/audio/voices");
  assert.equal(deriveModelsUrl("http://ai4090:8080/v1/audio"), "http://ai4090:8080/v1/models");
});

test("tts voice presets", () => {
  assert.equal(normalizeVoice("Uncle_Fu").voice, "uncle_fu");
  assert.equal(normalizeVoice("ONO-ANNA").voice, "ono_anna");
  assert.equal(normalizeVoice("uncle_fu").preset, true);
  assert.equal(normalizeVoice("custom voice").preset, false);
  assert.equal(defaultVoiceForLanguage("Qwen3-TTS-12Hz-1.7B-CustomVoice", "en"), "aiden");
  assert.equal(defaultVoiceForLanguage("Qwen3-TTS-12Hz-1.7B-CustomVoice", "zh"), "uncle_fu");
  assert.equal(normalizeLanguageForTts("zh"), "Chinese");
  assert.equal(normalizeLanguageForTts("en"), "English");
});

test("tts payload", () => {
  const payload = buildSpeechPayload({
    model: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
    input: "测试",
    voice: "uncle_fu",
    language: "Chinese",
    instructions: "沉稳",
    format: "wav",
    sampleRate: 0,
    extra: {},
  });
  assert.deepEqual(payload, {
    model: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
    input: "测试",
    voice: "uncle_fu",
    response_format: "wav",
    language: "Chinese",
    instructions: "沉稳",
  });
});

test("tts cache key changes with voice/instructions", () => {
  const base = {
    endpoint: "http://ai4090:8080/v1/audio",
    model: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
    voice: "uncle_fu",
    language: "Chinese",
    instructions: "沉稳",
    format: "wav",
    sampleRate: 0,
    extraParams: {},
    input: "测试",
  };
  const a = buildTtsCacheKey(base);
  const b = buildTtsCacheKey({ ...base, voice: "aiden" });
  const c = buildTtsCacheKey({ ...base, instructions: "活泼" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});
