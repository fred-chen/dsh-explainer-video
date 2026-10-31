// 本机媒体命令封装：ffmpeg / ffprobe，统一超时与取消。

import { spawn } from "node:child_process";

export function runCommand(command, args, { signal, timeoutMs = 120_000, captureStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [ "ignore", captureStdout ? "pipe" : "ignore", "pipe" ],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      aborted = true;
      child.kill("SIGTERM");
    }, timeoutMs) : null;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    if (child.stdout) child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(signal.reason || new Error("aborted"));
        return;
      }
      if (aborted) {
        reject(new Error(`命令超时或中止：${command} ${args.join(" ")}`));
        return;
      }
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(-1200) || "no stderr"}`));
    });
  });
}

export async function ffmpegVersion(signal) {
  const result = await runCommand("ffmpeg", ["-version"], { signal, timeoutMs: 15_000 });
  return result.stdout.split("\n")[0] || "ffmpeg";
}

export async function ffprobeVersion(signal) {
  const result = await runCommand("ffprobe", ["-version"], { signal, timeoutMs: 15_000 });
  return result.stdout.split("\n")[0] || "ffprobe";
}

export async function ffprobeJson(filePath, signal) {
  const result = await runCommand(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
      "-of", "json",
      filePath,
    ],
    { signal, timeoutMs: 30_000 }
  );
  return JSON.parse(result.stdout || "{}");
}

export async function probeDuration(filePath, signal) {
  const data = await ffprobeJson(filePath, signal);
  const duration = Number(data?.format?.duration);
  return Number.isFinite(duration) ? duration : 0;
}

export async function probeAudio(filePath, signal) {
  const data = await ffprobeJson(filePath, signal);
  const stream = (data.streams || []).find((entry) => entry.codec_type === "audio");
  return {
    duration: Number(data?.format?.duration) || 0,
    sampleRate: Number(stream?.sample_rate) || 0,
    channels: Number(stream?.channels) || 0,
    codec: stream?.codec_name || "",
  };
}

export async function probeMedia(filePath, signal) {
  const data = await ffprobeJson(filePath, signal);
  return {
    format: data.format || {},
    streams: data.streams || [],
    video: (data.streams || []).find((entry) => entry.codec_type === "video") || null,
    audio: (data.streams || []).find((entry) => entry.codec_type === "audio") || null,
  };
}

export async function convertToWav(inputPath, outputPath, { signal, sampleRate = 48000, channels = 2 } = {}) {
  await runCommand(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-i", inputPath,
      "-vn",
      "-ar", String(sampleRate),
      "-ac", String(channels),
      "-c:a", "pcm_s16le",
      outputPath,
    ],
    { signal, timeoutMs: 120_000 }
  );
  return outputPath;
}
