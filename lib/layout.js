// 语义布局：把 storyboard 场景映射到安全边距内的文本/视觉槽位。
// 大模型只给内容，不给绝对坐标。

export function layoutFor(scene, width, height) {
  const marginX = width * 0.08;
  const marginTop = height * 0.13;
  const marginBottom = height * 0.09;
  const contentW = width - marginX * 2;
  const contentH = height - marginTop - marginBottom;

  const base = {
    width,
    height,
    marginX,
    marginTop,
    marginBottom,
    contentW,
    contentH,
    kind: scene.layout,
    text: null,
    visual: null,
    slots: {},
  };

  if (scene.layout === "hero") {
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.88,
      kickerY: marginTop + contentH * 0.16,
      headlineY: marginTop + contentH * 0.34,
      subheadY: marginTop + contentH * 0.48,
    };
    base.slots = {
      left: { x: width * 0.24, y: height * 0.76 },
      right: { x: width * 0.76, y: height * 0.78 },
      center: { x: width / 2, y: height * 0.63 },
      top: { x: width / 2, y: height * 0.58 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  } else if (scene.layout === "split") {
    base.text = {
      x: marginX,
      align: "left",
      width: contentW * 0.48,
      kickerY: marginTop + contentH * 0.16,
      headlineY: marginTop + contentH * 0.34,
      subheadY: marginTop + contentH * 0.52,
    };
    base.visual = {
      x: width * 0.56,
      y: height * 0.24,
      w: width * 0.36,
      h: height * 0.48,
    };
    base.slots = {
      left: { x: width * 0.28, y: height * 0.70 },
      right: { x: width * 0.74, y: height * 0.54 },
      center: { x: width * 0.74, y: height * 0.54 },
      top: { x: width * 0.74, y: height * 0.22 },
      bottom: { x: width * 0.28, y: height * 0.78 },
    };
  } else if (scene.layout === "chart") {
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.82,
      kickerY: marginTop + contentH * 0.10,
      headlineY: marginTop + contentH * 0.20,
      subheadY: marginTop + contentH * 0.28,
    };
    base.visual = {
      x: width * 0.10,
      y: height * 0.31,
      w: width * 0.80,
      h: height * 0.48,
    };
    base.slots = {
      left: { x: width * 0.18, y: height * 0.80 },
      right: { x: width * 0.82, y: height * 0.80 },
      center: { x: width / 2, y: height * 0.80 },
      top: { x: width / 2, y: height * 0.27 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  } else if (scene.layout === "diagram") {
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.82,
      kickerY: marginTop + contentH * 0.10,
      headlineY: marginTop + contentH * 0.20,
      subheadY: marginTop + contentH * 0.28,
    };
    base.visual = {
      x: width * 0.10,
      y: height * 0.29,
      w: width * 0.80,
      h: height * 0.48,
    };
    base.slots = {
      left: { x: width * 0.16, y: height * 0.80 },
      right: { x: width * 0.84, y: height * 0.80 },
      center: { x: width / 2, y: height * 0.80 },
      top: { x: width / 2, y: height * 0.25 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  } else if (scene.layout === "timeline") {
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.86,
      kickerY: marginTop + contentH * 0.14,
      headlineY: marginTop + contentH * 0.28,
      subheadY: marginTop + contentH * 0.40,
    };
    base.visual = {
      x: width * 0.10,
      y: height * 0.52,
      w: width * 0.80,
      h: height * 0.22,
    };
    base.slots = {
      left: { x: width * 0.18, y: height * 0.80 },
      right: { x: width * 0.82, y: height * 0.80 },
      center: { x: width / 2, y: height * 0.80 },
      top: { x: width / 2, y: height * 0.45 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  } else if (scene.layout === "comparison") {
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.86,
      kickerY: marginTop + contentH * 0.10,
      headlineY: marginTop + contentH * 0.20,
      subheadY: marginTop + contentH * 0.28,
    };
    base.visual = {
      x: width * 0.10,
      y: height * 0.32,
      w: width * 0.80,
      h: height * 0.46,
    };
    base.slots = {
      left: { x: width * 0.28, y: height * 0.60 },
      right: { x: width * 0.72, y: height * 0.60 },
      center: { x: width / 2, y: height * 0.60 },
      top: { x: width / 2, y: height * 0.30 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  } else {
    // quote
    base.text = {
      x: width / 2,
      align: "center",
      width: contentW * 0.78,
      kickerY: marginTop + contentH * 0.22,
      headlineY: marginTop + contentH * 0.42,
      subheadY: marginTop + contentH * 0.58,
    };
    base.slots = {
      left: { x: width * 0.22, y: height * 0.78 },
      right: { x: width * 0.78, y: height * 0.78 },
      center: { x: width / 2, y: height * 0.78 },
      top: { x: width / 2, y: height * 0.30 },
      bottom: { x: width / 2, y: height * 0.78 },
    };
  }

  return base;
}

export function slotFor(scene, element, layout) {
  const slot = String(element?.slot || "").trim();
  if (slot && layout.slots[slot]) return layout.slots[slot];
  if (element?.type === "pill") return layout.slots.bottom;
  if (element?.type === "text") return layout.slots.top;
  if (element?.type === "arrow") return layout.slots.center;
  if (scene.layout === "split") return layout.slots.right;
  return layout.slots.center;
}
