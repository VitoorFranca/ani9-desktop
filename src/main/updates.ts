// New versions: without an Apple signature the app cannot update itself, so it
// only looks up the latest release on GitHub and tells the person.

export const REPOSITORY = "VitoorFranca/ani9-desktop";
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;

export interface Release {
  version: string;
  url: string;
}

type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `latest` is newer than `current` (both like "1.2.3" or "v1.2.3"). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

type Fetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The latest published release, or null when there is none yet. Throws when GitHub cannot be reached. */
export async function latestRelease(fetchImpl: Fetch): Promise<Release | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ani9-desktop" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub respondeu ${response.status}`);
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  const url = typeof body.html_url === "string" ? body.html_url : "";
  const version = parseVersion(tag);
  // Only a page of this repository's releases is ever opened.
  if (!version || !url.startsWith(`${RELEASES_URL}/`)) return null;
  return { version: version.join("."), url };
}

/** The release to offer, when it is newer than the running app. */
export async function checkForUpdate(current: string, fetchImpl: Fetch): Promise<Release | null> {
  const latest = await latestRelease(fetchImpl);
  return latest && isNewer(latest.version, current) ? latest : null;
}
