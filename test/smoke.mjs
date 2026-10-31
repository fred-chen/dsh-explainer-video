import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { computeTimeline, sceneDurationFromAudio } from "../lib/core.js";
import { synthesizeScenes } from "../lib/tts.js";
import { buildNarrationAudio } from "../lib/audio.js";
import { renderVideo } from "../lib/render.js";
import { probeMedia } from "../lib/media.js";

const storyboard = {
  version: 1,
  title: "Smoke Test",
  language: "zh",
  style: "dark-neon",
  width: 1280,
  height: 720,
  fps: 24,
  targetDurationSec: 15,
  references: [{ id: "src1", kind: "file", label: "smoke source" }],
  chapters: [{ id: "ch1", title: "测试" }],
  scenes: [
    {
      id: "s01",
      chapterId: "ch1",
      layout: "hero",
      kicker: "SMOKE",
      headline: "配音与合成测试",
      subhead: "Qwen3-TTS 预置音色 uncle_fu",
      narration: "这是一段用于端到端测试的中文旁白，声音应当沉稳清晰。",
      sourceIds: ["src1"],
      transition: "fade",
      elements: [
        { type: "icon", name: "gpu", size: 150, color: "#3dd6e7" },
        { type: "pill", text: "END-TO-END", color: "#6fd3a3" },
      ],
    },
    {
      id: "s02",
      chapterId: "ch1",
      layout: "chart",
      headline: "时间轴与图表",
      narration: "第二段旁白用于验证图表和音频对齐。",
      sourceIds: ["src1"],
      elements: [
        {
          type: "chart",
          kind: "line",
          yLabel: "value",
          series: [
            { label: "trend", points: [{ y: 20 }, { y: 45 }, { y: 30 }, { y: 65 }] },
          ],
        },
      ],
    },
  ],
};

const config = {
  ttsEndpoint: "http://ai4090:8080/v1/audio",
  ttsApiKey: "",
  ttsModel: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
  ttsVoice: "uncle_fu",
  ttsLanguage: "",
  ttsInstructions: "沉稳、清晰、纪录片式旁白，语速适中",
  ttsFormat: "wav",
  ttsSampleRate: 0,
  ttsTimeoutSec: 300,
  ttsExtraParams: "",
  sceneGapSec: 0.3,
  bgmPath: "",
  bgmVolume: 0.12,
  subtitleMode: "burn",
  fontFamily: "PingFang SC, Helvetica Neue, Arial",
};

const workDir = path.join("/tmp", "dsh-explainer-smoke");
await mkdir(workDir, { recursive: true });

const tts = await synthesizeScenes({
  storyboard,
  config,
  args: {},
  workDir,
  signal: undefined,
  logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
});
console.log("TTS:", tts.voice, tts.language, tts.scenes.map((scene) => scene.durationSeconds.toFixed(2)));
assert.equal(tts.voice, "uncle_fu");
assert.ok(tts.scenes.every((scene) => scene.durationSeconds > 0));

const durations = tts.scenes.map((scene) => sceneDurationFromAudio(scene.durationSeconds, storyboard.fps, 5, 30, config.sceneGapSec).duration);
const timeline = computeTimeline(storyboard.scenes, durations, storyboard.fps);
const audio = await buildNarrationAudio({
  storyboard,
  ttsResult: tts,
  timeline,
  workDir,
  bgmPath: "",
  bgmVolume: 0,
  signal: undefined,
  logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
});
console.log("audio", audio.path, audio.duration.toFixed(2));

const outputPath = path.join(workDir, "smoke.mp4");
const video = await renderVideo({
  storyboard,
  timeline,
  assets: [],
  audioPath: audio.path,
  outputPath,
  width: storyboard.width,
  height: storyboard.height,
  fps: storyboard.fps,
  subtitleMode: config.subtitleMode,
  fontFamily: config.fontFamily,
  signal: undefined,
  logger: { info: (message) => console.log(message) },
});
console.log("video", video);
assert.equal(video.videoCodec, "h264");
assert.equal(video.audioCodec, "aac");
const probe = await probeMedia(outputPath);
assert.ok(Number(probe.format.duration) > 5);
console.log("SMOKE OK:", outputPath);
