// 风格预设：调色板、字体栈、背景、强调色。
// dark-neon 对应参考视频的暗色霓虹/手绘信息图语言。

export const STYLE_PRESETS = {
  "dark-neon": {
    id: "dark-neon",
    label: "暗色霓虹 · 手绘信息图",
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
    danger: "#ff5c6c",
    success: "#6fd3a3",
    font: "PingFang SC, Helvetica Neue, Arial",
    handDrawn: true,
  },
  "tech-blue": {
    id: "tech-blue",
    label: "科技蓝 · 冷静图表",
    bgTop: "#071018",
    bgBottom: "#0c1a24",
    bgGrid: "#5b7b8f",
    text: "#eef6ff",
    muted: "#8fa6b8",
    panel: "#0e1d28",
    edge: "#27455b",
    accent: "#5cc8ff",
    accent2: "#80e1c1",
    accent3: "#ffc857",
    accent4: "#ff7a90",
    accent5: "#b9a7ff",
    danger: "#ff7a90",
    success: "#80e1c1",
    font: "PingFang SC, Helvetica Neue, Arial",
    handDrawn: false,
  },
  "paper-editorial": {
    id: "paper-editorial",
    label: "纸面编辑部 · 高对比",
    bgTop: "#f4f0e8",
    bgBottom: "#e9e2d6",
    bgGrid: "#9c9285",
    text: "#171513",
    muted: "#6d6458",
    panel: "#fbf8f1",
    edge: "#c9bfae",
    accent: "#c94a3d",
    accent2: "#2b6f6a",
    accent3: "#b7812f",
    accent4: "#435a7a",
    accent5: "#7b4f8a",
    danger: "#c94a3d",
    success: "#2b6f6a",
    font: "Helvetica Neue, Arial, PingFang SC",
    handDrawn: true,
  },
};

export function resolveStyle(id) {
  return STYLE_PRESETS[id] || STYLE_PRESETS["dark-neon"];
}

export function styleList() {
  return Object.values(STYLE_PRESETS).map((style) => ({ id: style.id, label: style.label }));
}
