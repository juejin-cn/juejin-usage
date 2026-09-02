export type OsFamily = 'macos' | 'windows' | 'other';
export type MacArch = 'arm' | 'x64' | 'unknown';
export type DownloadTargetId = 'macos-arm' | 'macos-intel' | 'windows';
export type ReleaseSource = 'gitee' | 'github';

export interface DownloadTarget {
  id: DownloadTargetId;
  os: 'macos' | 'windows';
  /** Primary button label. */
  label: string;
  /** Dropdown row label. */
  menuLabel: string;
  badgePlatform: 'macOS' | 'Windows';
  requirement: string;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface PublishedRelease {
  draft?: boolean;
  prerelease?: boolean;
  tag_name: string;
  created_at?: string;
  assets?: ReleaseAsset[] | null;
}

export interface DesktopReleaseAssets {
  source: ReleaseSource;
  tagName: string;
  assets: ReleaseAsset[];
}

export const GITEE_REPO_URL = 'https://gitee.com/juejin-cn/juejin-usage';
export const GITEE_RELEASES_URL = `${GITEE_REPO_URL}/releases`;
export const GITEE_RELEASES_API =
  'https://gitee.com/api/v5/repos/juejin-cn/juejin-usage/releases?per_page=20&direction=desc';

export const GITHUB_REPO_URL = 'https://github.com/juejin-cn/juejin-usage';
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_RELEASES_API =
  'https://api.github.com/repos/juejin-cn/juejin-usage/releases?per_page=20';

export const CLI_INSTALL_COMMAND = 'npm i -g @juejin-opensource/jusage';
export const CLI_INSTALL_HINT = `$ ${CLI_INSTALL_COMMAND}`;

const RELEASE_FETCH_TIMEOUT_MS = 8_000;

export const DOWNLOAD_TARGETS: readonly DownloadTarget[] = [
  {
    id: 'macos-arm',
    os: 'macos',
    label: '下载 macOS',
    menuLabel: 'macOS（Apple Silicon）',
    badgePlatform: 'macOS',
    requirement: 'macOS 14+',
  },
  {
    id: 'macos-intel',
    os: 'macos',
    label: '下载 macOS（Intel）',
    menuLabel: 'macOS（Intel）',
    badgePlatform: 'macOS',
    requirement: 'macOS 14+',
  },
  {
    id: 'windows',
    os: 'windows',
    label: '下载 Windows',
    menuLabel: 'Windows',
    badgePlatform: 'Windows',
    requirement: 'Windows 10+',
  },
] as const;

const TARGET_BY_ID = new Map(
  DOWNLOAD_TARGETS.map((target) => [target.id, target]),
);

export function getDownloadTarget(id: DownloadTargetId): DownloadTarget {
  return TARGET_BY_ID.get(id) ?? DOWNLOAD_TARGETS[0];
}

export function detectOsFamily(
  userAgent: string,
  platform = '',
  uaDataPlatform = '',
): OsFamily {
  const haystack = `${uaDataPlatform} ${platform} ${userAgent}`.toLowerCase();
  if (/\bwin(?:dows|32|64|ce)?\b/.test(haystack) || haystack.includes('windows')) {
    return 'windows';
  }
  if (
    haystack.includes('mac') ||
    haystack.includes('darwin') ||
    haystack.includes('iphone') ||
    haystack.includes('ipad') ||
    haystack.includes('ipod')
  ) {
    return 'macos';
  }
  return 'other';
}

export function detectMacArch(userAgent: string, architecture = ''): MacArch {
  const arch = architecture.toLowerCase();
  if (arch.includes('arm')) return 'arm';
  if (
    arch.includes('x86') ||
    arch.includes('x64') ||
    arch.includes('amd64')
  ) {
    return 'x64';
  }
  if (/\bintel\b/i.test(userAgent)) return 'x64';
  return 'unknown';
}

export function resolveDefaultTarget(
  os: OsFamily,
  macArch: MacArch = 'unknown',
): DownloadTargetId {
  if (os === 'windows') return 'windows';
  if (os === 'macos' && macArch === 'x64') return 'macos-intel';
  return 'macos-arm';
}

function parseReleaseTag(tag: string): {
  parts: number[];
  prerelease: string | null;
} {
  const raw = tag.trim().replace(/^v/i, '');
  const dash = raw.indexOf('-');
  const core = dash === -1 ? raw : raw.slice(0, dash);
  const prerelease = dash === -1 ? null : raw.slice(dash + 1);
  const parts = core.split('.').map((piece) => {
    const value = Number.parseInt(piece, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return { parts, prerelease };
}

/** Newest tag wins: `v0.1.6` > `v0.1.5` > `v0.1.1` > `v0.1.1-beta.12`. */
function compareReleaseTags(a: string, b: string): number {
  const left = parseReleaseTag(a);
  const right = parseReleaseTag(b);
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.prerelease == null && right.prerelease != null) return 1;
  if (left.prerelease != null && right.prerelease == null) return -1;
  if (left.prerelease != null && right.prerelease != null) {
    return left.prerelease.localeCompare(right.prerelease, 'en', {
      numeric: true,
    });
  }
  return 0;
}

function createdAtMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pick the newest published release by tag semver, then `created_at`.
 * API list order is ignored — Gitee may surface an edited older release first.
 */
export function pickLatestPublishedRelease<
  T extends { draft?: boolean; tag_name?: string; created_at?: string },
>(releases: readonly T[]): T | null {
  const published = releases.filter((release) => !release.draft);
  if (published.length === 0) return null;

  return published.reduce((latest, current) => {
    const tagCmp = compareReleaseTags(
      current.tag_name ?? '',
      latest.tag_name ?? '',
    );
    if (tagCmp > 0) return current;
    if (tagCmp < 0) return latest;
    return createdAtMs(current.created_at) > createdAtMs(latest.created_at)
      ? current
      : latest;
  });
}

function isInstallerName(name: string): boolean {
  return !/\.(blockmap|yml|yaml|zip|tar\.gz)$/i.test(name);
}

export function hasInstallerAssets(assets: readonly ReleaseAsset[]): boolean {
  return assets.some(
    (asset) => isInstallerName(asset.name) && /\.(dmg|exe)$/i.test(asset.name),
  );
}

export function matchReleaseAsset(
  assets: readonly ReleaseAsset[],
  target: DownloadTargetId,
): string | null {
  const files = assets.filter((asset) => isInstallerName(asset.name));

  if (target === 'windows') {
    const setup = files.find(
      (asset) =>
        /\.exe$/i.test(asset.name) &&
        /setup/i.test(asset.name) &&
        !/portable/i.test(asset.name),
    );
    if (setup) return setup.browser_download_url;
    return (
      files.find(
        (asset) => /\.exe$/i.test(asset.name) && !/portable/i.test(asset.name),
      )?.browser_download_url ?? null
    );
  }

  if (target === 'macos-arm') {
    return (
      files.find((asset) => /arm64\.dmg$/i.test(asset.name))
        ?.browser_download_url ?? null
    );
  }

  return (
    files.find((asset) => /x64\.dmg$/i.test(asset.name))
      ?.browser_download_url ??
    files.find(
      (asset) => /\.dmg$/i.test(asset.name) && !/arm64/i.test(asset.name),
    )?.browser_download_url ??
    null
  );
}

export function fallbackReleasePage(source?: ReleaseSource): string {
  return source === 'github' ? GITHUB_RELEASES_URL : GITEE_RELEASES_URL;
}

export function toDesktopReleaseAssets(
  source: ReleaseSource,
  release: PublishedRelease,
): DesktopReleaseAssets {
  return {
    source,
    tagName: release.tag_name,
    assets: release.assets ?? [],
  };
}

export function selectReleaseSource(
  gitee: DesktopReleaseAssets | null,
  github: DesktopReleaseAssets | null,
): DesktopReleaseAssets {
  if (gitee && hasInstallerAssets(gitee.assets)) return gitee;
  if (github && hasInstallerAssets(github.assets)) return github;
  throw new Error('No published desktop release');
}

async function fetchPublishedRelease(
  url: string,
  source: ReleaseSource,
): Promise<DesktopReleaseAssets> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    RELEASE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      headers: {
        Accept:
          source === 'github'
            ? 'application/vnd.github+json'
            : 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${source} releases ${response.status}`);
    }
    const releases = (await response.json()) as PublishedRelease[];
    const release = pickLatestPublishedRelease(releases);
    if (!release) {
      throw new Error(`No published ${source} release`);
    }
    return toDesktopReleaseAssets(source, release);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDesktopReleaseAssets(): Promise<DesktopReleaseAssets> {
  let gitee: DesktopReleaseAssets | null = null;
  try {
    gitee = await fetchPublishedRelease(GITEE_RELEASES_API, 'gitee');
  } catch {
    gitee = null;
  }

  if (gitee && hasInstallerAssets(gitee.assets)) return gitee;

  const github = await fetchPublishedRelease(GITHUB_RELEASES_API, 'github');
  return selectReleaseSource(gitee, github);
}

export function detectDownloadTargetFromNavigator(
  nav: Pick<Navigator, 'userAgent' | 'platform'> & {
    userAgentData?: { platform?: string };
  },
): DownloadTargetId {
  return resolveDefaultTarget(
    detectOsFamily(
      nav.userAgent,
      nav.platform,
      nav.userAgentData?.platform ?? '',
    ),
    detectMacArch(nav.userAgent),
  );
}
