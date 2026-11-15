// The window opens where it was left, as long as that place is still on a
// screen (a monitor may have been unplugged since).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: { width: number; height: number; x?: number; y?: number };
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 840 };
export const MIN_SIZE = { width: 720, height: 520 };

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A saved state made safe to use: default size when missing or broken, position kept only if visible. */
export function sanitizeState(saved: unknown, workAreas: Rect[]): WindowState {
  const fallback: WindowState = { bounds: { ...DEFAULT_SIZE }, maximized: false };
  if (!saved || typeof saved !== "object") return fallback;
  const { bounds, maximized } = saved as { bounds?: Partial<Rect>; maximized?: unknown };
  if (!bounds || !isNumber(bounds.width) || !isNumber(bounds.height)) return fallback;
  const width = Math.max(MIN_SIZE.width, Math.round(bounds.width));
  const height = Math.max(MIN_SIZE.height, Math.round(bounds.height));
  const state: WindowState = { bounds: { width, height }, maximized: maximized === true };
  if (isNumber(bounds.x) && isNumber(bounds.y)) {
    const rect = { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height };
    // At least the title bar region must be on a screen to be reachable.
    const reachable = workAreas.some(
      (area) =>
        rect.x + 100 <= area.x + area.width &&
        rect.x + rect.width - 100 >= area.x &&
        rect.y >= area.y - 10 &&
        rect.y + 40 <= area.y + area.height,
    );
    if (reachable) Object.assign(state.bounds, { x: rect.x, y: rect.y });
  }
  return state;
}
