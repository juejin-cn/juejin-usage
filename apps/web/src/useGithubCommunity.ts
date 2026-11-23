import { useEffect, useState } from 'react';

export interface GithubContributor {
  id: number;
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  contributions: number;
}

export interface GithubCommunityData {
  contributors: GithubContributor[];
  status: 'loading' | 'ready' | 'fallback';
}

export const GITHUB_REPO_SLUG = 'juejin-cn/juejin-usage';
const CONTRIBUTORS_API = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/contributors?per_page=100`;
const CACHE_KEY = 'jusage:web:github-contributors:v1';
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedContributors {
  timestamp: number;
  contributors: GithubContributor[];
}

let memoryCache: CachedContributors | null = null;

export function withAvatarSize(url: string, size: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('s', String(size));
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}s=${size}`;
  }
}

function readCache(): CachedContributors | null {
  const now = Date.now();
  if (memoryCache && now - memoryCache.timestamp < CACHE_TTL_MS) {
    return memoryCache;
  }
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedContributors>;
    if (
      typeof parsed.timestamp !== 'number' ||
      now - parsed.timestamp >= CACHE_TTL_MS ||
      !Array.isArray(parsed.contributors)
    ) {
      return null;
    }
    const valid: CachedContributors = {
      timestamp: parsed.timestamp,
      contributors: parsed.contributors,
    };
    memoryCache = valid;
    return valid;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedContributors): void {
  memoryCache = entry;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

interface RawContributor {
  id?: number;
  login?: string;
  avatar_url?: string;
  html_url?: string;
  contributions?: number;
  type?: string;
}

function normalizeContributors(payload: unknown): GithubContributor[] {
  if (!Array.isArray(payload)) return [];
  const list: GithubContributor[] = [];
  for (const item of payload as RawContributor[]) {
    if (
      typeof item?.id !== 'number' ||
      typeof item.login !== 'string' ||
      typeof item.avatar_url !== 'string' ||
      typeof item.html_url !== 'string'
    ) {
      continue;
    }
    if (item.type && item.type !== 'User') continue;
    if (item.login.endsWith('[bot]')) continue;
    list.push({
      id: item.id,
      login: item.login,
      avatarUrl: item.avatar_url,
      htmlUrl: item.html_url,
      contributions: typeof item.contributions === 'number' ? item.contributions : 0,
    });
  }
  return list;
}

export function useGithubCommunity(): GithubCommunityData {
  const [data, setData] = useState<GithubCommunityData>(() => {
    const cached = readCache();
    if (!cached) {
      return { contributors: [], status: 'loading' };
    }
    return {
      contributors: cached.contributors,
      status: cached.contributors.length > 0 ? 'ready' : 'fallback',
    };
  });

  useEffect(() => {
    if (readCache()) return;

    const controller = new AbortController();
    void fetch(CONTRIBUTORS_API, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(normalizeContributors)
      .catch(() => [] as GithubContributor[])
      .then((contributors) => {
        if (controller.signal.aborted) return;
        if (contributors.length > 0) {
          writeCache({ timestamp: Date.now(), contributors });
        }
        setData({
          contributors,
          status: contributors.length > 0 ? 'ready' : 'fallback',
        });
      });

    return () => {
      controller.abort();
    };
  }, []);

  return data;
}
