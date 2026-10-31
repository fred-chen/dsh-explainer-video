// Host-plugin integration test with mock LLM/web services and real TTS/render.
// Run: node test/host.test.mjs

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";

import { apply } from "../lib/index.js";

const workRoot = path.join("/tmp", "dsh-explainer-host-test");
await mkdir(workRoot, { recursive: true });
const materialPath = path.join(workRoot, "source.txt");
await writeFile(materialPath, "测试报告：GPU 租金从 16500 元降到 15500 元每月。需求没有消失。\n");

const storyboardMock = {
  version: 1,
  title: "Host Test",
  language: "zh",
  style: "dark-neon",
  width: 640,
  height: 360,
  fps: 24,
  targetDurationSec: 10,
  references: [{ id: "src1", kind: "file", label: "source.txt" }],
  chapters: [{ id: "ch1", title: "测试" }],
  scenes: [
    {
      id: "s01",
      chapterId: "ch1",
      layout: "hero",
      kicker: "HOST",
      headline: "宿主工具集成测试",
      subhead: "mock LLM + real TTS + real SVG render",
      narration: "这是宿主集成测试的第一段旁白。",
      ttsText: "这是宿主集成测试的第一段旁白。",
      sourceIds: ["src1"],
      transition: "fade",
      elements: [
        { type: "icon", name: "gpu", size: 100, color: "#3dd6e7" },
        { type: "pill", text: "OK", color: "#6fd3a3" },
      ],
    },
    {
      id: "s02",
      chapterId: "ch1",
      layout: "chart",
      headline: "图表测试",
      narration: "这是宿主集成测试的第二段旁白。",
      sourceIds: ["src1", "web1"],
      elements: [
        {
          type: "chart",
          kind: "bar",
          series: [
            { label: "Q2", value: 16500 },
            { label: "Q3", value: 15500 },
          ],
        },
      ],
    },
  ],
};

function mockStream(request) {
  return (async function* generate() {
    const system = String(request.system || "");
    let text;
    if (system.includes("evidence extractor")) {
      text = JSON.stringify({
        facts: [
          {
            claim: "GPU 租金从 16500 元降到 15500 元每月",
            value: "16500→15500",
            unit: "元/月",
            sourceId: "src1",
            locator: "text",
            confidence: "high",
          },
        ],
        themes: ["租金小幅下降"],
        visualMetaphors: ["柱状图"],
      });
    } else if (system.includes("research planner")) {
      text = JSON.stringify({ queries: ["GPU rental price 2025"], reason: "current context" });
    } else {
      text = JSON.stringify(storyboardMock);
    }
    yield { type: "text-delta", text };
    yield { type: "finish", reason: { kind: "stop" } };
  })();
}

const routes = [];
const toolsList = [];
const settingsDescriptor = {
  ns: "explainer-video",
  revision: 1,
  value: {
    enabled: true,
    ttsEndpoint: "http://ai4090:8080/v1/audio",
    ttsModel: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
    ttsVoice: "uncle_fu",
    ttsInstructions: "沉稳清晰",
    webMode: "auto",
    stylePreset: "dark-neon",
    width: 640,
    height: 360,
    fps: 24,
    targetDurationSec: 10,
    outputDir: workRoot,
    fontFamily: "PingFang SC, Helvetica Neue, Arial",
    subtitleMode: "burn",
    timeoutSec: 1800,
  },
  secrets: [],
};

const settings = {
  describe() { return [settingsDescriptor]; },
  configure() { return () => {}; },
  async mutate() { return settingsDescriptor; },
};
const server = {
  port: 52680,
  register(route) { routes.push(route); return () => {}; },
};
const tools = {
  register(tool) { toolsList.push(tool); return () => {}; },
  schemas() { return toolsList.map((tool) => ({ name: tool.name })); },
};
const llm = { stream: mockStream };
const web = {
  async search({ query }) {
    return {
      sources: [{
        url: "https://example.com/gpu-rents",
        title: "GPU rental prices in 2025",
        snippet: "Cloud GPU rental rates remained elevated in 2025.",
        publishedAt: "2025-10-01",
        query,
      }],
    };
  },
  async fetch({ url }) {
    return {
      url,
      body: { kind: "html", content: "<html><body>Cloud GPU rental rates remained elevated in 2025.</body></html>" },
    };
  },
};

const ctx = new Context();
ctx.provide("settings", settings);
ctx.provide("webServer", server);
ctx.provide("tools", tools);
ctx.provide("llm", llm);
ctx.provide("web", web);

await ctx.plugin(apply, {
  enabled: true,
  ttsEndpoint: "http://ai4090:8080/v1/audio",
  ttsModel: "Qwen3-TTS-12Hz-1.7B-CustomVoice",
  ttsVoice: "uncle_fu",
  ttsInstructions: "沉稳清晰",
  webMode: "auto",
  stylePreset: "dark-neon",
  width: 640,
  height: 360,
  fps: 24,
  targetDurationSec: 10,
  outputDir: workRoot,
  fontFamily: "PingFang SC, Helvetica Neue, Arial",
  subtitleMode: "burn",
  timeoutSec: 1800,
  llmProvider: "",
  llmModel: "",
});
await new Promise((resolve) => setTimeout(resolve, 50));

assert.deepEqual(toolsList.map((tool) => tool.name), ["explainer_video_generate", "explainer_video_render"]);
assert.equal(routes.length, 4);

const generate = toolsList[0];
const controller = new AbortController();
const exec = {
  signal: controller.signal,
  agent: {
    options: { provider: "ai4090", model: "DeepSeek-V4.1-Flash" },
    session: { header: { cwd: workRoot } },
  },
};
const result = await generate.execute({
  prompt: "生成 10 秒中文测试视频，说明 GPU 租金小幅下降。",
  materials: [materialPath],
  durationSec: 10,
  webMode: "auto",
  planOnly: false,
}, exec);
assert.equal(result.planOnly, false);
assert.equal(result.sceneCount, 2);
assert.equal(result.voice, "uncle_fu");
assert.ok(result.videoUrl.includes("/api/dsh-explainer-video/artifacts/"));
assert.ok(result.filePath.includes("Host-Test"));
assert.equal(result.webQueries, 1);
assert.equal(result.webSources.length, 1);
assert.ok(result.webSources[0].usedIn.includes("s02"));

const plan = await generate.execute({
  prompt: "生成 10 秒中文测试视频的分镜与预览。",
  materials: [materialPath],
  durationSec: 10,
  webMode: "auto",
  planOnly: true,
}, exec);
assert.equal(plan.planOnly, true);
assert.equal(plan.sceneCount, 2);
assert.equal(plan.previewUrls.length, 2);
assert.ok(plan.videoUrl === undefined);

const render = toolsList[1];
const rerender = await render.execute({ storyboardPath: result.storyboardPath, voice: "uncle_fu" }, exec);
assert.ok(rerender.videoUrl.includes("/api/dsh-explainer-video/artifacts/"));
assert.ok(rerender.filePath.endsWith(".mp4"));
assert.equal(rerender.materialsPath, result.materialsPath);
console.log("HOST TEST OK", result.filePath, result.durationSec, result.bytes);
console.log("RENDER TOOL OK", rerender.filePath);
