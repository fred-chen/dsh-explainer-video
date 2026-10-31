// 音频：逐场景对齐、补白/裁切、拼接、可选 BGM 与响度归一。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { probeAudio, runCommand } from "./media.js";

async function buildSceneAudio({ inputPath, outputPath, durationSec, signal }) {
  await runCommand(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-i", inputPath,
      "-af", "aformat=sample_rates=48000:channel_layouts=stereo,adelay=200:all=1,apad",
      "-t", String(durationSec),
      "-c:a", "pcm_s16le",
      outputPath,
    ],
    { signal, timeoutMs: 120_000 }
  );
  return outputPath;
}

export async function buildNarrationAudio({
  storyboard,
  ttsResult,
  timeline,
  workDir,
  bgmPath,
  bgmVolume,
  signal,
  logger,
}) {
  const partsDir = path.join(workDir, "audio");
  await mkdir(partsDir, { recursive: true });
  const parts = [];
  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    const scene = storyboard.scenes[index];
    const ttsScene = ttsResult.scenes[index];
    const timelineScene = timeline.scenes[index];
    if (!ttsScene || !timelineScene) throw new Error(`音频/时间轴缺少 scene ${scene.id}`);
    const partPath = path.join(partsDir, `${scene.id}.wav`);
    await buildSceneAudio({
      inputPath: ttsScene.wavPath,
      outputPath: partPath,
      durationSec: timelineScene.durationSec,
      signal,
    });
    parts.push(partPath);
  }

  const concatList = path.join(partsDir, "concat.txt");
  await writeFile(concatList, parts.map((part) => `file '${part.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const narrationPath = path.join(workDir, "narration.wav");
  await runCommand(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "concat", "-safe", "0", "-i", concatList,
      "-c:a", "pcm_s16le",
      narrationPath,
    ],
    { signal, timeoutMs: 120_000 }
  );

  let finalPath = narrationPath;
  if (bgmPath) {
    const mixedPath = path.join(workDir, "narration-bgm.wav");
    const volume = Math.max(0, Math.min(1, Number(bgmVolume) || 0.12));
    await runCommand(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-stream_loop", "-1", "-i", bgmPath,
        "-i", narrationPath,
        "-filter_complex", `[0:a]volume=${volume}[bg];[1:a][bg]amix=inputs=2:duration=longest:dropout_transition=2`,
        "-t", String(timeline.totalDuration),
        "-c:a", "pcm_s16le",
        mixedPath,
      ],
      { signal, timeoutMs: 180_000 }
    );
    finalPath = mixedPath;
  }

  const info = await probeAudio(finalPath, signal);
  if (Math.abs(info.duration - timeline.totalDuration) > 0.15) {
    logger?.warn?.(`explainer: audio duration ${info.duration.toFixed(3)}s vs timeline ${timeline.totalDuration.toFixed(3)}s`);
  }
  return { path: finalPath, duration: info.duration };
}
