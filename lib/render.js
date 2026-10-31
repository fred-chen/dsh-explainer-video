// 矢量渲染：storyboard + 时间 → SVG 帧 → sharp raw RGBA → ffmpeg。
//
// 不使用大模型生成的逐帧 SVG；所有元素由内置布局/图标/图表/动效引擎解释。

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { layoutFor, slotFor } from "./layout.js";
import { ICON_PATHS } from "./icons.js";
import { resolveStyle } from "./style.js";
import { chapterTimeline } from "./core.js";
import { probeMedia } from "./media.js";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function easeOut(t) {
  return 1 - Math.pow(1 - clamp(t), 3);
}

function easeInOut(t) {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function shapeScaleFor(width, height) {
  return Math.max(0.3, Math.min(width / 1920, height / 1080));
}

function textScaleFor(width, height) {
  return Math.max(0.55, Math.min(width / 1920, height / 1080));
}

function charWidth(char, fontSize) {
  const code = char.codePointAt(0) || 0;
  if (code >= 0x4e00 && code <= 0x9fff) return fontSize * 1.0;
  if (code >= 0x3040 && code <= 0x30ff) return fontSize * 1.0;
  if (code >= 0xac00 && code <= 0xd7af) return fontSize * 1.0;
  if (char === " ") return fontSize * 0.32;
  if (/[0-9]/.test(char)) return fontSize * 0.58;
  if (/[A-Z]/.test(char)) return fontSize * 0.62;
  if (/[a-z]/.test(char)) return fontSize * 0.54;
  return fontSize * 0.45;
}

function textWidth(text, fontSize) {
  let width = 0;
  for (const char of String(text || "")) width += charWidth(char, fontSize);
  return width;
}

function tokenize(text) {
  const tokens = [];
  const raw = String(text || "").trim();
  if (!raw) return tokens;
  const matches = raw.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g);
  for (const token of matches || []) tokens.push(token);
  return tokens;
}

function wrapText(text, maxWidth, fontSize, maxLines = 3) {
  const tokens = tokenize(text);
  const lines = [];
  let current = "";
  const push = () => {
    if (current.trim()) lines.push(current.trim());
    current = "";
  };
  const isCjkToken = (token) => /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(token)
    || /^[，。！？；：、…—（）《》“”‘’]$/u.test(token);
  for (const token of tokens) {
    const lastChar = current.slice(-1);
    const needsSpace = Boolean(current) && !(isCjkToken(token) && isCjkToken(lastChar));
    const candidate = current ? (needsSpace ? `${current} ${token}` : `${current}${token}`) : token;
    if (textWidth(candidate, fontSize) <= maxWidth) current = candidate;
    else {
      push();
      current = token;
    }
    if (lines.length >= maxLines) break;
  }
  push();
  if (lines.length > maxLines) lines.length = maxLines;
  return lines;
}

function renderText({
  x,
  y,
  text,
  size,
  color,
  align = "center",
  fontFamily,
  bold = false,
  width = 1400,
  maxLines = 3,
  lineHeight = 1.24,
  letterSpacing = 0,
  opacity = 1,
}) {
  const lines = wrapText(text, width, size, maxLines);
  if (lines.length === 0) return "";
  const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
  const startY = y - ((lines.length - 1) * size * lineHeight) / 2;
  const tspans = lines.map((line, index) => {
    const dy = index === 0 ? 0 : size * lineHeight;
    return `<tspan x="${x}" dy="${index === 0 ? 0 : dy}">${escapeXml(line)}</tspan>`;
  }).join("");
  return `<text x="${x}" y="${startY}" font-family="${escapeXml(fontFamily)}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${escapeXml(color)}" text-anchor="${anchor}" letter-spacing="${letterSpacing}" opacity="${clamp(opacity)}">${tspans}</text>`;
}

function renderBackground(style, width, height, scale = 1) {
  const grid = Math.max(24, 80 * scale);
  const lines = [];
  for (let x = 0; x <= width; x += grid) lines.push(`M${x} 0 V${height}`);
  for (let y = 0; y <= height; y += grid) lines.push(`M0 ${y} H${width}`);
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${style.bgTop}"/>
      <stop offset="1" stop-color="${style.bgBottom}"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.48" r="0.72">
      <stop offset="0" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.42"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <path d="${lines.join(" ")}" stroke="${style.bgGrid}" stroke-opacity="0.055" stroke-width="1" fill="none"/>
  <rect width="${width}" height="${height}" fill="url(#vignette)"/>
  `;
}

function renderChapterProgress({ style, chapters, timeline, currentChapterId, width, height, fontFamily, opacity = 1, scale = 1, textScale = 1 }) {
  if (!chapters || chapters.length === 0) return "";
  const list = chapters.slice(0, 10);
  const y = 52;
  const left = 105;
  const right = width - 105;
  const step = list.length > 1 ? (right - left) / (list.length - 1) : 0;
  const parts = [];
  parts.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${style.edge}" stroke-width="${2 * scale}" stroke-dasharray="${3 * scale} ${7 * scale}" opacity="0.8"/>`);
  for (let index = 0; index < list.length; index += 1) {
    const chapter = list[index];
    const x = left + step * index;
    const active = chapter.id === currentChapterId;
    parts.push(`<circle cx="${x}" cy="${y}" r="${active ? 7 * scale : 4 * scale}" fill="${active ? style.accent2 : style.edge}" opacity="${active ? 1 : 0.7}"/>`);
    if (index === 0 || index === list.length - 1 || list.length <= 7) {
      const label = renderText({
        x,
        y: y + 26,
        text: chapter.title,
        size: 14 * textScale,
        color: active ? style.text : style.muted,
        align: "center",
        fontFamily,
        bold: active,
        width: Math.max(120, step * 0.95),
        maxLines: 1,
        lineHeight: 1,
      });
      parts.push(label);
    }
  }
  parts.push(`<circle cx="${left}" cy="${y}" r="${2 * scale}" fill="${style.accent}"/>`);
  return `<g opacity="${clamp(opacity)}">${parts.join("")}</g>`;
}

function renderIcon({ style, name, x, y, size, color, progress, strokeWidth = 4 }) {
  const pathData = ICON_PATHS[name];
  if (!pathData) return "";
  const scale = size / 100;
  const dash = progress < 1 ? `stroke-dasharray="2200" stroke-dashoffset="${2200 * (1 - progress)}"` : "";
  return `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${scale})" opacity="${clamp(progress)}">
    <path d="${pathData}" fill="none" stroke="${escapeXml(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ${dash}/>
  </g>`;
}

function renderPill({ style, text, x, y, color, progress, fontFamily, fontSize = 22, scale = 1 }) {
  const width = Math.max(120 * scale, textWidth(text, fontSize) + 42 * scale);
  const height = 46 * scale;
  return `<g opacity="${clamp(progress)}" transform="translate(${x - width / 2} ${y - height / 2})">
    <rect width="${width}" height="${height}" rx="${23 * scale}" fill="${escapeXml(color)}" opacity="0.22" stroke="${escapeXml(color)}" stroke-width="${2 * scale}"/>
    <text x="${width / 2}" y="${height / 2 + fontSize * 0.35}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}" font-weight="700" fill="${escapeXml(color)}" text-anchor="middle">${escapeXml(text)}</text>
  </g>`;
}

function renderChart({ style, element, layout, progress, fontFamily, scale = 1, textScale = 1 }) {
  const area = layout.visual || { x: layout.width * 0.1, y: layout.height * 0.3, w: layout.width * 0.8, h: layout.height * 0.55 };
  const x = area.x;
  const y = area.y;
  const w = area.w;
  const h = area.h;
  const pad = 46 * scale;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const baseY = y + h - pad;
  const parts = [];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${16 * scale}" fill="${style.panel}" opacity="0.55" stroke="${style.edge}" stroke-width="${1.5 * scale}"/>`);
  // grid
  for (let i = 0; i <= 4; i += 1) {
    const gy = y + pad + (innerH * i) / 4;
    parts.push(`<line x1="${x + pad}" y1="${gy}" x2="${x + w - pad}" y2="${gy}" stroke="${style.edge}" stroke-width="${1 * scale}" stroke-dasharray="${4 * scale} ${7 * scale}" opacity="0.55"/>`);
  }
  parts.push(`<line x1="${x + pad}" y1="${y + pad}" x2="${x + pad}" y2="${baseY}" stroke="${style.edge}" stroke-width="${2 * scale}"/>`);
  parts.push(`<line x1="${x + pad}" y1="${baseY}" x2="${x + w - pad}" y2="${baseY}" stroke="${style.edge}" stroke-width="${2 * scale}"/>`);

  const series = element.series || [];
  const reveal = clamp(progress);
  if (element.kind === "bar") {
    const values = series.map((s) => Number(s.value) || 0);
    const max = Math.max(...values, 1);
    const barW = Math.min(80 * scale, innerW / Math.max(values.length, 1) * 0.55);
    const gap = innerW / Math.max(values.length, 1);
    series.forEach((s, index) => {
      const value = Number(s.value) || 0;
      const barH = (value / max) * innerH * reveal;
      const bx = x + pad + gap * index + gap / 2 - barW / 2;
      const by = baseY - barH;
      parts.push(`<rect x="${bx}" y="${by}" width="${barW}" height="${barH}" rx="${6 * scale}" fill="${style.accent2}" opacity="0.22" stroke="${style.accent2}" stroke-width="${2 * scale}"/>`);
      parts.push(`<text x="${bx + barW / 2}" y="${by - 12}" font-family="${fontFamily}" font-size="${22 * textScale}" font-weight="700" fill="${style.text}" text-anchor="middle">${escapeXml(String(value))}</text>`);
      parts.push(`<text x="${bx + barW / 2}" y="${baseY + 24}" font-family="${fontFamily}" font-size="${18 * textScale}" fill="${style.muted}" text-anchor="middle">${escapeXml(String(s.label || ""))}</text>`);
    });
  } else {
    const seriesValues = series.map((s) => (s.points || []).map((p) => Number(p.y) || 0));
    const all = seriesValues.flat();
    const max = Math.max(...all, 1);
    const min = Math.min(...all, 0);
    const range = Math.max(1, max - min);
    for (const s of series) {
      const points = s.points || [];
      if (points.length < 2) continue;
      const pct = reveal;
      const count = Math.max(1, Math.floor((points.length - 1) * pct));
      const coords = [];
      for (let i = 0; i <= count; i += 1) {
        const px = x + pad + (innerW * i) / (points.length - 1);
        const py = baseY - ((Number(points[i].y) - min) / range) * innerH;
        coords.push([px, py]);
      }
      if (element.kind === "area") {
        const poly = `${coords.map(([px, py]) => `${px},${py}`).join(" ")} ${coords[coords.length - 1][0]},${baseY} ${coords[0][0]},${baseY}`;
        parts.push(`<polygon points="${poly}" fill="${style.accent2}" opacity="0.16"/>`);
      }
      parts.push(`<polyline points="${coords.map(([px, py]) => `${px},${py}`).join(" ")}" fill="none" stroke="${style.accent}" stroke-width="${4 * scale}" stroke-linecap="round" stroke-linejoin="round"/>`);
      for (let i = 0; i <= count; i += 1) {
        const px = x + pad + (innerW * i) / (points.length - 1);
        const py = baseY - ((Number(points[i].y) - min) / range) * innerH;
        parts.push(`<circle cx="${px}" cy="${py}" r="${5 * scale}" fill="${style.bgTop}" stroke="${style.accent}" stroke-width="${2 * scale}"/>`);
      }
      const last = coords[coords.length - 1];
      parts.push(`<text x="${last[0]}" y="${last[1] - 16}" font-family="${fontFamily}" font-size="${19 * textScale}" font-weight="700" fill="${style.accent}" text-anchor="middle">${escapeXml(String(s.label || ""))}</text>`);
    }
  }
  if (element.yLabel) {
    parts.push(`<text x="${x + 18}" y="${y + 26}" font-family="${fontFamily}" font-size="${14 * textScale}" fill="${style.muted}" text-anchor="start">${escapeXml(String(element.yLabel))}</text>`);
  }
  return parts.join("");
}

function renderDiagram({ style, element, layout, progress, fontFamily, scale = 1, textScale = 1 }) {
  const area = layout.visual || { x: layout.width * 0.1, y: layout.height * 0.3, w: layout.width * 0.8, h: layout.height * 0.55 };
  const nodes = element.nodes || [];
  const n = nodes.length;
  const cols = n <= 4 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gapX = area.w / Math.max(cols, 1);
  const gapY = area.h / Math.max(rows, 1);
  const positions = new Map();
  nodes.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = area.x + gapX * (col + 0.5);
    const cy = area.y + gapY * (row + 0.55);
    positions.set(String(node.id), { x: cx, y: cy });
  });
  const parts = [];
  const reveal = clamp(progress);
  for (const edge of element.edges || []) {
    const a = positions.get(String(edge.from));
    const b = positions.get(String(edge.to));
    if (!a || !b) continue;
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${style.accent2}" stroke-width="${2 * scale}" stroke-dasharray="${8 * scale} ${7 * scale}" opacity="${reveal * 0.8}"/>`);
    if (edge.label) {
      parts.push(`<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 8}" font-family="${fontFamily}" font-size="${14 * textScale}" fill="${style.muted}" text-anchor="middle">${escapeXml(String(edge.label))}</text>`);
    }
  }
  nodes.forEach((node, index) => {
    const pos = positions.get(String(node.id));
    const size = 58 * scale;
    const labelY = pos.y + size / 2 + 22;
    parts.push(`<g opacity="${reveal}">
      <rect x="${pos.x - size}" y="${pos.y - size}" width="${size * 2}" height="${size * 2}" rx="14" fill="${style.panel}" stroke="${style.edge}" stroke-width="${2 * scale}"/>
      ${node.icon ? renderIcon({ style, name: node.icon, x: pos.x, y: pos.y - 4 * scale, size: 42 * scale, color: style.accent2, progress: reveal, strokeWidth: 3 }) : ""}
      <text x="${pos.x}" y="${labelY}" font-family="${fontFamily}" font-size="${18 * textScale}" font-weight="600" fill="${style.text}" text-anchor="middle">${escapeXml(String(node.label || ""))}</text>
    </g>`);
  });
  return parts.join("");
}

function renderTimeline({ style, element, layout, progress, fontFamily, scale = 1, textScale = 1 }) {
  const area = layout.visual || { x: layout.width * 0.1, y: layout.height * 0.52, w: layout.width * 0.8, h: layout.height * 0.28 };
  const items = element.items || [];
  const y = area.y + area.h * 0.45;
  const left = area.x + 40;
  const right = area.x + area.w - 40;
  const step = items.length > 1 ? (right - left) / (items.length - 1) : 0;
  const reveal = clamp(progress);
  const parts = [];
  parts.push(`<line x1="${left}" y1="${y}" x2="${left + (right - left) * reveal}" y2="${y}" stroke="${style.edge}" stroke-width="${3 * scale}" stroke-dasharray="${4 * scale} ${8 * scale}"/>`);
  items.forEach((item, index) => {
    const x = left + step * index;
    const active = reveal >= index / Math.max(items.length - 1, 1);
    parts.push(`<circle cx="${x}" cy="${y}" r="${active ? 8 * scale : 5 * scale}" fill="${active ? style.accent3 : style.edge}"/>`);
    parts.push(`<text x="${x}" y="${y - 24}" font-family="${fontFamily}" font-size="${18 * textScale}" font-weight="700" fill="${active ? style.text : style.muted}" text-anchor="middle">${escapeXml(String(item.value || ""))}</text>`);
    parts.push(`<text x="${x}" y="${y + 34}" font-family="${fontFamily}" font-size="${16 * textScale}" fill="${style.muted}" text-anchor="middle">${escapeXml(String(item.label || ""))}</text>`);
  });
  return parts.join("");
}

function renderImage({ style, element, layout, assetMap, progress, scale = 1 }) {
  const asset = assetMap.get(String(element.assetId));
  if (!asset) return "";
  const area = layout.visual || { x: layout.width * 0.2, y: layout.height * 0.3, w: layout.width * 0.6, h: layout.height * 0.5 };
  const x = area.x;
  const y = area.y;
  const w = area.w;
  const h = area.h;
  const clipId = `clip-${element.assetId}-${Math.round(progress * 100)}`;
  return `<g opacity="${clamp(progress) * clamp(Number(element.opacity) || 1)}">
    <defs><clipPath id="${clipId}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${18 * scale}"/></clipPath></defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${style.panel}" stroke="${style.edge}" stroke-width="${2 * scale}"/>
    <image href="data:${asset.mime};base64,${asset.base64}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>
  </g>`;
}

function renderArrow({ style, element, layout, progress, fontFamily, scale = 1 }) {
  const a = layout.slots.left;
  const b = layout.slots.right;
  const x1 = a.x;
  const y1 = a.y;
  const x2 = b.x;
  const y2 = b.y;
  const reveal = clamp(progress);
  const endX = x1 + (x2 - x1) * reveal;
  const endY = y1 + (y2 - y1) * reveal;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 18 * scale;
  const p1 = [endX - head * Math.cos(angle - 0.5), endY - head * Math.sin(angle - 0.5)];
  const p2 = [endX - head * Math.cos(angle + 0.5), endY - head * Math.sin(angle + 0.5)];
  return `<g opacity="${reveal}">
    <line x1="${x1}" y1="${y1}" x2="${endX}" y2="${endY}" stroke="${escapeXml(element.color || style.accent)}" stroke-width="${4 * scale}" stroke-linecap="round"/>
    <polygon points="${endX},${endY} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}" fill="${escapeXml(element.color || style.accent)}"/>
  </g>`;
}

function renderElement({ scene, element, layout, style, localTime, progress, assetMap, fontFamily, width, height, scale = 1, textScale = 1 }) {
  const slot = slotFor(scene, element, layout);
  const animate = element.animate || {};
  const delay = Number(animate.delay) || 0;
  const duration = Number(animate.duration) || 0.5;
  const raw = clamp((localTime - delay) / Math.max(0.1, duration));
  const p = easeOut(raw);
  if (p <= 0.001) return "";
  const animation = String(animate.in || "fade");
  const opacity = animation === "draw" ? clamp(raw) : p;
  const translateY = animation === "slide" ? (1 - p) * 24 * scale : 0;
  const popScale = animation === "pop" ? 0.82 + p * 0.18 : 1;
  const accent = element.color || scene.accent || style.accent;

  if (element.type === "icon") {
    return `<g transform="translate(0 ${translateY})" opacity="${opacity}">${renderIcon({
      style,
      name: element.name,
      x: slot.x,
      y: slot.y,
      size: (Number(element.size) || 160) * scale,
      color: accent,
      progress: animation === "draw" ? raw : p,
      strokeWidth: (Number(element.strokeWidth) || 4) * scale,
    })}</g>`;
  }

  if (element.type === "pill") {
    return `<g transform="translate(0 ${translateY}) scale(${popScale})" opacity="${opacity}">${renderPill({
      style,
      text: element.text,
      x: slot.x,
      y: slot.y,
      color: accent,
      progress: p,
      fontFamily,
      fontSize: (Number(element.size) || 22) * textScale,
      scale,
    })}</g>`;
  }

  if (element.type === "text") {
    const size = (Number(element.size) || 26) * textScale;
    const maxWidth = element.slot === "left" || element.slot === "right" ? Math.min(620, width * 0.32) : Math.min(1100, width * 0.6);
    return `<g opacity="${opacity}" transform="translate(0 ${translateY})">
      ${renderText({
        x: slot.x,
        y: slot.y,
        text: element.text,
        size,
        color: element.color || style.text,
        align: element.align || "center",
        fontFamily,
        bold: element.role === "number" || element.role === "label",
        width: maxWidth,
        maxLines: element.role === "number" ? 1 : 3,
      })}
    </g>`;
  }

  if (element.type === "chart") {
    return `<g opacity="${p}">${renderChart({ style, element, layout, progress: clamp((localTime - delay) / Math.max(0.4, duration)), fontFamily, scale, textScale })}</g>`;
  }
  if (element.type === "diagram") {
    return `<g opacity="${p}">${renderDiagram({ style, element, layout, progress: p, fontFamily, scale, textScale })}</g>`;
  }
  if (element.type === "timeline") {
    return `<g opacity="${p}">${renderTimeline({ style, element, layout, progress: p, fontFamily, scale, textScale })}</g>`;
  }
  if (element.type === "image") {
    return `<g opacity="${p}">${renderImage({ style, element, layout, assetMap, progress: p, scale })}</g>`;
  }
  if (element.type === "arrow") {
    return `<g opacity="${p}">${renderArrow({ style, element, layout, progress: p, fontFamily, scale })}</g>`;
  }
  return "";
}

function renderScene({ scene, style, timelineScene, time, assetMap, fontFamily, width, height, subtitleMode }) {
  const scale = shapeScaleFor(width, height);
  const textScale = textScaleFor(width, height);
  const layout = layoutFor(scene, width, height);
  const localTime = Math.max(0, Math.min(timelineScene.durationSec, time - timelineScene.startSec));
  let sceneOpacity = 1;
  if (scene.transition === "fade") {
    sceneOpacity = Math.min(1, localTime / 0.22, (timelineScene.durationSec - localTime) / 0.22);
  }
  const parts = [];
  const text = layout.text;
  if (text) {
    if (scene.kicker) {
      parts.push(renderText({
        x: text.x,
        y: text.kickerY,
        text: scene.kicker,
        size: 20 * textScale,
        color: style.accent3,
        align: text.align,
        fontFamily,
        bold: true,
        width: text.width,
        maxLines: 1,
        letterSpacing: 2.5,
      }));
    }
    parts.push(renderText({
      x: text.x,
      y: text.headlineY,
      text: scene.headline,
      size: 54 * textScale,
      color: style.text,
      align: text.align,
      fontFamily,
      bold: true,
      width: text.width,
      maxLines: 3,
    }));
    if (scene.subhead) {
      parts.push(renderText({
        x: text.x,
        y: text.subheadY,
        text: scene.subhead,
        size: 26 * textScale,
        color: style.muted,
        align: text.align,
        fontFamily,
        bold: false,
        width: text.width,
        maxLines: 3,
      }));
    }
  }
  for (const element of scene.elements || []) {
    parts.push(renderElement({
      scene,
      element,
      layout,
      style,
      localTime,
      progress: 1,
      assetMap,
      fontFamily,
      width,
      height,
      scale,
      textScale,
    }));
  }
  if (scene.sourceIds?.length) {
    parts.push(`<text x="${width - 110 * scale}" y="${height - 18 * scale}" font-family="${fontFamily}" font-size="${14 * textScale}" fill="${style.muted}" text-anchor="end" opacity="0.8">source: ${escapeXml(scene.sourceIds.join(", "))}</text>`);
  }
  if (subtitleMode === "burn") {
    parts.push(renderSubtitles({ scene, style, fontFamily, width, height, scale, textScale }));
  }
  return `<g opacity="${clamp(sceneOpacity)}">${parts.join("")}</g>`;
}

function renderSubtitles({ scene, style, fontFamily, width, height, scale = 1, textScale = 1 }) {
  const text = String(scene.narration || "");
  if (!text) return "";
  const lines = wrapText(text, width * 0.76, 22 * textScale, 2);
  const boxH = (24 + lines.length * 30) * scale;
  const y = height - 82 * scale;
  const parts = [`<rect x="${width * 0.12}" y="${y - boxH / 2}" width="${width * 0.76}" height="${boxH}" rx="${12 * scale}" fill="${style.bgTop}" opacity="0.78"/>`];
  lines.forEach((line, index) => {
    parts.push(`<text x="${width / 2}" y="${y - boxH / 2 + (28 + index * 30) * scale}" font-family="${fontFamily}" font-size="${22 * textScale}" fill="${style.text}" text-anchor="middle">${escapeXml(line)}</text>`);
  });
  return parts.join("");
}

export function buildFrame({ storyboard, timeline, style, assets, frame, subtitleMode = "none", width, height, fontFamily }) {
  const fps = storyboard.fps;
  const time = frame / fps;
  const timelineScene = timeline.scenes.find((entry) => time >= entry.startSec && time < entry.startSec + entry.durationSec)
    || timeline.scenes[timeline.scenes.length - 1];
  const sceneIndex = timelineScene.index;
  const scene = storyboard.scenes[sceneIndex];
  const chapters = chapterTimeline(storyboard, timeline);
  const activeChapter = chapters.filter((chapter) => chapter.startSec <= time).pop()
    || chapters.find((chapter) => chapter.id === scene.chapterId)
    || chapters[0];
  const assetMap = assets;
  const scale = shapeScaleFor(width, height);
  const textScale = textScaleFor(width, height);
  const body = renderScene({
    scene,
    style,
    timelineScene,
    time,
    assetMap,
    fontFamily: fontFamily || style.font,
    width,
    height,
    subtitleMode,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    ${renderBackground(style, width, height, shapeScaleFor(width, height))}
    ${renderChapterProgress({
      style,
      chapters,
      timeline,
      currentChapterId: activeChapter?.id || "",
      width,
      height,
      fontFamily: fontFamily || style.font,
      scale,
      textScale,
    })}
    ${body}
  </svg>`;
}

export async function prepareAssets(assets, maxSize = 1600) {
  const map = new Map();
  for (const asset of assets || []) {
    try {
      const image = sharp(asset.path);
      const meta = await image.metadata();
      const width = meta.width || asset.width || 800;
      const height = meta.height || asset.height || 600;
      const resized = await image.resize({ width: Math.min(width, maxSize), height: Math.min(height, maxSize), fit: "inside" });
      const buffer = await resized.png().toBuffer();
      map.set(String(asset.id), {
        base64: buffer.toString("base64"),
        mime: "image/png",
        width,
        height,
      });
    } catch {
      // 坏图跳过
    }
  }
  return map;
}

function runFfmpegRaw({ args, width, height, fps, totalFrames, style, storyboard, timeline, assets, subtitleMode, fontFamily, signal, logger }) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: [ "pipe", "ignore", "pipe" ] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    const onAbort = () => child.kill("SIGTERM");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason || new Error("aborted"));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-1200)}`));
    });

    (async () => {
      try {
        for (let frame = 0; frame < totalFrames; frame += 1) {
          if (signal?.aborted) throw signal.reason || new Error("aborted");
          const svg = buildFrame({ storyboard, timeline, style, assets, frame, subtitleMode, width, height, fontFamily });
          const raw = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer();
          if (!child.stdin.write(raw)) {
            await new Promise((innerResolve) => child.stdin.once("drain", innerResolve));
          }
          if (frame % Math.max(1, Math.floor(totalFrames / 20)) === 0) {
            logger?.info?.(`explainer: render ${frame + 1}/${totalFrames} frames`);
          }
        }
        child.stdin.end();
      } catch (error) {
        child.kill("SIGTERM");
        reject(error);
      }
    })();
  });
}

export async function renderVideo({
  storyboard,
  timeline,
  assets,
  audioPath,
  outputPath,
  width,
  height,
  fps,
  subtitleMode,
  fontFamily,
  signal,
  logger,
}) {
  const style = { ...resolveStyle(storyboard.style), font: fontFamily || resolveStyle(storyboard.style).font };
  const assetMap = await prepareAssets(assets);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const totalFrames = timeline.totalFrames;
  const args = [
    "-y", "-v", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "-",
    "-i", audioPath,
    "-t", String(timeline.totalDuration),
    "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath,
  ];
  await runFfmpegRaw({
    args,
    width,
    height,
    fps,
    totalFrames,
    style,
    storyboard,
    timeline,
    assets: assetMap,
    subtitleMode,
    fontFamily,
    signal,
    logger,
  });
  const probe = await probeMedia(outputPath, signal);
  const duration = Number(probe.format?.duration) || 0;
  return {
    path: outputPath,
    bytes: Number(probe.format?.size) || 0,
    duration,
    width: Number(probe.video?.width) || width,
    height: Number(probe.video?.height) || height,
    videoCodec: probe.video?.codec_name || "",
    audioCodec: probe.audio?.codec_name || "",
  };
}

export async function renderPreview({
  storyboard,
  timeline,
  assets,
  outputDir,
  width,
  height,
  fontFamily,
  signal,
  logger,
  count = 4,
}) {
  const style = { ...resolveStyle(storyboard.style), font: fontFamily || resolveStyle(storyboard.style).font };
  const assetMap = await prepareAssets(assets);
  await mkdir(outputDir, { recursive: true });
  const paths = [];
  const step = Math.max(1, Math.floor(storyboard.scenes.length / count));
  for (let index = 0; index < storyboard.scenes.length && paths.length < count; index += step) {
    const scene = storyboard.scenes[index];
    const timelineScene = timeline.scenes[index];
    const frame = Math.min(timeline.totalFrames - 1, timelineScene.startFrame + Math.floor(timelineScene.frames / 2));
    const svg = buildFrame({ storyboard, timeline, style, assets: assetMap, frame, subtitleMode: "none", width, height, fontFamily: style.font });
    const buffer = await sharp(Buffer.from(svg), { density: 72 }).png().toBuffer();
    const filePath = path.join(outputDir, `preview-${String(paths.length + 1).padStart(2, "0")}.png`);
    await writeFile(filePath, buffer);
    paths.push(filePath);
    logger?.info?.(`explainer: preview ${filePath}`);
  }
  return paths;
}
