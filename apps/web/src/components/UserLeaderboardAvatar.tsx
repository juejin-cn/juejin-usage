import { useEffect, useRef, useState } from 'react';
import { cn } from '@web/lib/utils';

const AVATAR_ROOT_MARGIN = '240px 0px';

export function UserLeaderboardAvatar({
  src,
  name,
  lazy = true,
  className,
  fallbackClassName,
}: {
  src?: string | null;
  name: string;
  lazy?: boolean;
  className?: string;
  fallbackClassName?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(!lazy || !src);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    if (!lazy || !src) {
      setShouldLoad(true);
      return;
    }

    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: AVATAR_ROOT_MARGIN, threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy, src]);

  const initial = (name.trim().slice(0, 1) || 'U').toUpperCase();
  const showImage = Boolean(shouldLoad && src && !failed);

  return (
    <span
      ref={rootRef}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#eef6ff] text-primary select-none dark:bg-primary/15 dark:text-[#66adff]',
        className,
      )}
    >
      {showImage ? (
        <img
          alt=""
          className="size-full object-cover"
          decoding="async"
          loading={lazy ? 'lazy' : 'eager'}
          onError={() => setFailed(true)}
          src={src!}
        />
      ) : (
        <span aria-hidden="true" className={cn('leading-none', fallbackClassName)}>
          {initial}
        </span>
      )}
    </span>
  );
}
