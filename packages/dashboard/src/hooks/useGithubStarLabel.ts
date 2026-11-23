import { useEffect, useState } from 'react';

export function useGithubStarLabel() {
  const [starLabel, setStarLabel] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('https://api.github.com/repos/juejin-cn/juejin-usage', {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { stargazers_count?: number } | null) => {
        const count = payload?.stargazers_count;
        if (controller.signal.aborted || typeof count !== 'number' || !Number.isFinite(count)) {
          return;
        }
        setStarLabel(formatStarCount(count));
      })
      .catch(() => {
        // Star count is decorative; the GitHub link still works without it.
      });
    return () => {
      controller.abort();
    };
  }, []);

  return starLabel;
}

function formatStarCount(count: number): string {
  if (count < 1000) return String(Math.floor(count));
  const thousands = count / 1000;
  const digits = count >= 10_000 ? 0 : 1;
  return `${thousands.toFixed(digits).replace(/\.0$/, '')}k`;
}
