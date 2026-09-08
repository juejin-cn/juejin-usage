import type { ComponentProps } from 'react';

type BrandIconProps = Omit<ComponentProps<'svg'>, 'children' | 'viewBox'>;

/** Inline Lobe Kimi mark: semantic text color keeps its vector edges crisp. */
export function KimiSubscriptionBrandIcon({ className, ...props }: BrandIconProps) {
  return (
    <svg
      aria-hidden
      className={`shrink-0 text-foreground ${className ?? ''}`}
      fill="currentColor"
      viewBox="0 0 24 24"
      {...props}
    >
      <path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" />
      <path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
    </svg>
  );
}

/** Inline Lobe Z.ai mark: semantic text color adapts to both tray themes. */
export function ZcodeSubscriptionBrandIcon({ className, ...props }: BrandIconProps) {
  return (
    <svg
      aria-hidden
      className={`shrink-0 text-foreground ${className ?? ''}`}
      fill="currentColor"
      viewBox="0 0 24 24"
      {...props}
    >
      <path d="M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244zM24 2L9.264 22H0L14.736 2H24z" />
    </svg>
  );
}
