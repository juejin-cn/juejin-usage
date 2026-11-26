import { useEffect, useRef, useState } from 'react';
import {
  DOWNLOAD_TARGETS,
  detectMacArch,
  detectOsFamily,
  fallbackReleasePage,
  fetchDesktopReleaseAssets,
  getDownloadTarget,
  matchReleaseAsset,
  resolveDefaultTarget,
  type DownloadTargetId,
  type DesktopReleaseAssets,
} from '@/lib/downloads';

const SESSION_TARGET_KEY = 'tud.downloadTarget';

function readSessionTarget(): DownloadTargetId | null {
  try {
    const raw = sessionStorage.getItem(SESSION_TARGET_KEY);
    if (raw && DOWNLOAD_TARGETS.some((t) => t.id === raw)) {
      return raw as DownloadTargetId;
    }
  } catch {
    // sessionStorage unavailable in some private browsing modes
  }
  return null;
}

function writeSessionTarget(id: DownloadTargetId): void {
  try {
    sessionStorage.setItem(SESSION_TARGET_KEY, id);
  } catch {
    // ignore
  }
}

export function useDesktopDownload() {
  const [targetId, setTargetId] = useState<DownloadTargetId>(() => {
    const saved = readSessionTarget();
    if (saved) return saved;
    if (typeof navigator === 'undefined') return 'macos-arm';
    return resolveDefaultTarget(
      detectOsFamily(navigator.userAgent, navigator.platform),
      detectMacArch(navigator.userAgent),
    );
  });
  const [targetConfirmed, setTargetConfirmed] = useState(() => readSessionTarget() !== null);
  const [assetUrls, setAssetUrls] = useState<
    Partial<Record<DownloadTargetId, string>>
  >({});
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [release, setRelease] = useState<DesktopReleaseAssets>();
  const userPickedRef = useRef(readSessionTarget() !== null);

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as Navigator & {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (
          hints: string[],
        ) => Promise<{ architecture?: string; platform?: string }>;
      };
    };

    const apply = (architecture?: string, uaPlatform?: string) => {
      if (cancelled || userPickedRef.current) return;
      const os = detectOsFamily(nav.userAgent, nav.platform, uaPlatform ?? nav.userAgentData?.platform ?? '');
      const mobile = /iphone|ipad|ipod|android|windows phone/i.test(nav.userAgent)
        || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
      // Apple Silicon browsers can report “Intel Mac OS X” in the UA.
      const chip = detectMacArch('', architecture);
      setTargetConfirmed(!mobile && (os === 'windows' || (os === 'macos' && chip !== 'unknown')));
      setTargetId(resolveDefaultTarget(os, detectMacArch(nav.userAgent, architecture)));
    };

    apply();
    void nav.userAgentData
      ?.getHighEntropyValues?.(['architecture', 'platform'])
      .then((highEntropy) => {
        apply(highEntropy.architecture, highEntropy.platform);
      })
      .catch(() => {
        // Sync UA detection is enough when Client Hints are blocked.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchDesktopReleaseAssets()
      .then((release) => {
        if (cancelled) return;
        const next: Partial<Record<DownloadTargetId, string>> = {};
        for (const item of DOWNLOAD_TARGETS) {
          const url = matchReleaseAsset(release.assets, item.id);
          if (url) next[item.id] = url;
        }
        setAssetUrls(next);
        setRelease(release);
      })
      .catch(() => {
        // Direct asset lookup is best-effort; Gitee/GitHub releases page remains the fallback.
      })
      .finally(() => {
        if (!cancelled) setLoadingAssets(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectTarget(id: DownloadTargetId) {
    userPickedRef.current = true;
    setTargetConfirmed(true);
    writeSessionTarget(id);
    setTargetId(id);
  }

  return { target: getDownloadTarget(targetId), targetConfirmed, selectTarget, assetUrls, loadingAssets, release, releasesFallback: fallbackReleasePage(release?.source) };
}
