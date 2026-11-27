/** A view's place on screen, in window coordinates (what `measureInWindow` reports). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

const n = (v: number) => Math.round(v * 10) / 10;

/**
 * The dimmed scrim as one SVG path: the whole screen, plus (with `fillRule="evenodd"`) a rounded
 * hole `pad` around the target, so the target shows through.
 */
export function spotlightPath(screen: Size, hole: Rect | null, pad = 6, radius = 16): string {
  const outer = `M0 0H${n(screen.w)}V${n(screen.h)}H0Z`;
  if (!hole) return outer;
  const x = hole.x - pad;
  const y = hole.y - pad;
  const w = hole.w + pad * 2;
  const h = hole.h + pad * 2;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const inner =
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
  return outer + inner;
}

/**
 * Where the coach card goes: below the hole if it fits, else above, else centred. `pad` is the
 * hole's padding, `margin` the gap between hole and card and to the screen edges.
 */
export function placeCard(
  screen: Size,
  hole: Rect | null,
  cardH: number,
  margin = 16,
  pad = 6,
): { top: number } {
  const centred = { top: Math.max(margin, (screen.h - cardH) / 2) };
  if (!hole) return centred;
  const below = hole.y + hole.h + pad + margin;
  if (below + cardH <= screen.h - margin) return { top: below };
  const above = hole.y - pad - margin - cardH;
  if (above >= margin) return { top: above };
  return centred;
}
