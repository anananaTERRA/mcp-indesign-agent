/** Geometry helpers in InDesign space: bounds as {y1,x1,y2,x2} (ruler units / points). */

export interface IdBounds {
  y1: number;
  x1: number;
  y2: number;
  x2: number;
}

/** Axis-aligned box as x/y/width/height (top-left origin). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AlignMode =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom";

export function toBox(b: IdBounds): Box {
  return {
    x: b.x1,
    y: b.y1,
    width: b.x2 - b.x1,
    height: b.y2 - b.y1,
  };
}

export function fromBox(box: Box): IdBounds {
  return {
    y1: box.y,
    x1: box.x,
    y2: box.y + box.height,
    x2: box.x + box.width,
  };
}

export function computeAlignedBox(
  box: Box,
  page: { width: number; height: number },
  align: AlignMode,
): Box {
  let x = box.x;
  let y = box.y;
  switch (align) {
    case "left":
      x = 0;
      break;
    case "center":
      x = (page.width - box.width) / 2;
      break;
    case "right":
      x = page.width - box.width;
      break;
    case "top":
      y = 0;
      break;
    case "middle":
      y = (page.height - box.height) / 2;
      break;
    case "bottom":
      y = page.height - box.height;
      break;
  }
  return { ...box, x, y };
}

export function centerBoxOnPage(
  box: Box,
  page: { width: number; height: number },
): Box {
  return {
    ...box,
    x: (page.width - box.width) / 2,
    y: (page.height - box.height) / 2,
  };
}

export function clampBoxToPage(
  box: Box,
  page: { width: number; height: number },
  margin: number,
): Box {
  const maxW = Math.max(1, page.width - 2 * margin);
  const maxH = Math.max(1, page.height - 2 * margin);
  let width = Math.min(box.width, maxW);
  let height = Math.min(box.height, maxH);
  let x = Math.min(Math.max(box.x, margin), page.width - margin - width);
  let y = Math.min(Math.max(box.y, margin), page.height - margin - height);
  return { x, y, width, height };
}

export function planDistribute(
  boxes: Box[],
  axis: "horizontal" | "vertical",
): Box[] {
  if (boxes.length < 2) return boxes.map((b) => ({ ...b }));
  const indexed = boxes.map((b, i) => ({ b, i }));
  indexed.sort((a, c) =>
    axis === "horizontal" ? a.b.x - c.b.x : a.b.y - c.b.y,
  );
  const first = indexed[0]!.b;
  const last = indexed[indexed.length - 1]!.b;
  const result = boxes.map((b) => ({ ...b }));

  if (axis === "horizontal") {
    const span =
      last.x + last.width - first.x - indexed.reduce((s, x) => s + x.b.width, 0);
    const gap = span / (indexed.length - 1);
    let cursor = first.x;
    for (const { b, i } of indexed) {
      result[i] = { ...b, x: cursor };
      cursor += b.width + gap;
    }
  } else {
    const span =
      last.y +
      last.height -
      first.y -
      indexed.reduce((s, x) => s + x.b.height, 0);
    const gap = span / (indexed.length - 1);
    let cursor = first.y;
    for (const { b, i } of indexed) {
      result[i] = { ...b, y: cursor };
      cursor += b.height + gap;
    }
  }
  return result;
}

export function planStack(
  boxes: Box[],
  opts: {
    axis?: "horizontal" | "vertical";
    gapPt?: number;
    startPt?: number;
  } = {},
): Box[] {
  const axis = opts.axis ?? "vertical";
  const gap = opts.gapPt ?? 16;
  const indexed = boxes.map((b, i) => ({ b, i }));
  indexed.sort((a, c) =>
    axis === "horizontal" ? a.b.x - c.b.x : a.b.y - c.b.y,
  );
  const result = boxes.map((b) => ({ ...b }));
  let cursor =
    opts.startPt ??
    (axis === "horizontal" ? indexed[0]?.b.x ?? 0 : indexed[0]?.b.y ?? 0);

  for (const { b, i } of indexed) {
    if (axis === "horizontal") {
      result[i] = { ...b, x: cursor };
      cursor += b.width + gap;
    } else {
      result[i] = { ...b, y: cursor };
      cursor += b.height + gap;
    }
  }
  return result;
}

export function moveBox(
  box: Box,
  delta: { dx?: number; dy?: number; x?: number; y?: number },
): Box {
  let x = box.x;
  let y = box.y;
  if (delta.x !== undefined) x = delta.x;
  else if (delta.dx !== undefined) x = box.x + delta.dx;
  if (delta.y !== undefined) y = delta.y;
  else if (delta.dy !== undefined) y = box.y + delta.dy;
  return { ...box, x, y };
}

export function resizeBox(
  box: Box,
  size: { width?: number; height?: number },
): Box {
  return {
    ...box,
    width: size.width ?? box.width,
    height: size.height ?? box.height,
  };
}
