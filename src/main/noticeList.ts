// The notices waiting in the app's own panel: a notice with the same tag
// replaces the old one, and only the latest few are kept on screen.

export const MAX_NOTICES = 3;

export function addNotice<T extends { tag: string }>(list: readonly T[], notice: T): T[] {
  return [...list.filter((item) => item.tag !== notice.tag), notice].slice(-MAX_NOTICES);
}

export function removeNotice<T extends { tag: string }>(
  list: readonly T[],
  tag: string,
): { list: T[]; removed: T | null } {
  const removed = list.find((item) => item.tag === tag) ?? null;
  return { list: list.filter((item) => item.tag !== tag), removed };
}
