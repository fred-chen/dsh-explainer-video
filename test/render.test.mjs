import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { estimateTimeline } from "../lib/core.js";
import { buildFrame, renderPreview, renderVideo } from "../lib/render.js";
import { runCommand, probeMedia } from "../lib/media.js";

const storyboard = {
  version: 1,
  title: "Render Test",
  language: "zh",
  style: "dark-neon",
  width: 1920,
  height: 1080,
  fps: 30,
  targetDurationSec: 15,
  references: [{ id: "src1", kind: "file", label: "test source" }],
  chapters: [{ id: "ch1", title: "章节一" }],
  scenes: [
    {
      id: "s01",
      chapterId: "ch1",
      layout: "hero",
      kicker: "TEST",
      headline: "矢量科普视频渲染测试",
      subhead: "SVG → sharp → raw RGBA → ffmpeg",
      accent: "#ff5c6c",
      narration: "这是一段用于渲染测试的中文旁白。",
      sourceIds: ["src1"],
      transition: "fade",
      elements: [
        { type: "icon", name: "chip", size: 180, color: "#3dd6e7" },
        { type: "pill", text: "READY", color: "#6fd3a3" },
      ],
    },
    {
      id: "s02",
      chapterId: "ch1",
      layout: "chart",
      headline: "柱状图动效",
      narration: "第二段旁白用于测试图表渲染。",
      sourceIds: ["src1"],
      elements: [
        {
          type: "chart",
          kind: "bar",
          yLabel: "value",
          series: [
            { label: "Q2", value: 16500 },
            { label: "Q3", value: 15500 },
          ],
        },
      ],
    },
  ],
};

const timeline = estimateTimeline(storyboard);
const style = { ...storyboard, style: "dark-neon" };
const resolvedStyle = { ...Object.fromEntries([]) };
const actualStyle = {
  bgTop: "#05070b",
  bgBottom: "#0d1218",
  bgGrid: "#6f8398",
  text: "#f2f5fa",
  muted: "#8e9aac",
  panel: "#101820",
  edge: "#2d4053",
  accent: "#ff5c6c",
  accent2: "#3dd6e7",
  accent3: "#f2b84b",
  accent4: "#6fd3a3",
  accent5: "#b38cff",
  font: "PingFang SC, Helvetica Neue, Arial",
};

test("buildFrame returns a valid SVG with content", () => {
  const svg = buildFrame({
    storyboard,
    timeline,
    style: actualStyle,
    assets: new Map(),
    frame: 20,
    subtitleMode: "none",
    width: storyboard.width,
    height: storyboard.height,
  });
  assert.match(svg, /^<svg/);
  assert.match(svg, /矢量科普视频渲染测试/);
  assert.match(svg, /<rect width="1920"/);
});

test("preview renders PNGs at target dimensions", async () => {
  const dir = path.join("/tmp", "dsh-explainer-render-test");
  await mkdir(dir, { recursive: true });
  const previews = await renderPreview({
    storyboard,
    timeline,
    assets: [],
    outputDir: dir,
    width: storyboard.width,
    height: storyboard.height,
    fontFamily: actualStyle.font,
    count: 2,
  });
  assert.equal(previews.length, 2);
  for (const filePath of previews) {
    const info = await stat(filePath);
    assert.ok(info.size > 1000);
    const meta = await sharp(filePath).metadata();
    assert.equal(meta.width, storyboard.width);
    assert.equal(meta.height, storyboard.height);
  }
});

test("renderVideo muxes raw frames with audio", async () => {
  const dir = path.join("/tmp", "dsh-explainer-render-test");
  await mkdir(dir, { recursive: true });
  const audioPath = path.join(dir, "silence.wav");
  await runCommand("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", String(timeline.totalDuration),
    "-c:a", "pcm_s16le",
    audioPath,
  ], { timeoutMs: 30_000 });
  const outputPath = path.join(dir, "test.mp4");
  const result = await renderVideo({
    storyboard,
    timeline,
    assets: [],
    audioPath,
    outputPath,
    width: storyboard.width,
    height: storyboard.height,
    fps: storyboard.fps,
    subtitleMode: "none",
    fontFamily: actualStyle.font,
  });
  assert.equal(result.path, outputPath);
  assert.ok(result.bytes > 1000);
  assert.equal(result.videoCodec, "h264");
  assert.equal(result.audioCodec, "aac");
  const probe = await probeMedia(outputPath);
  assert.ok(Number(probe.format.duration) > 1);
});
