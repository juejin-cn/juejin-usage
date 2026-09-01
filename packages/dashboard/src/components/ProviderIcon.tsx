import type { CSSProperties, ReactNode } from 'react';
import antigravityIcon from '@lobehub/icons-static-svg/icons/antigravity-color.svg';
import ampIcon from '@lobehub/icons-static-svg/icons/amp-color.svg';
import claudeCodeIcon from '@lobehub/icons-static-svg/icons/claudecode-color.svg';
import clineIcon from '@lobehub/icons-static-svg/icons/cline.svg';
import codeBuddyIcon from '@lobehub/icons-static-svg/icons/codebuddy-color.svg';
import codexIcon from '@lobehub/icons-static-svg/icons/codex.svg';
import copilotIcon from '@lobehub/icons-static-svg/icons/copilot-color.svg';
import cursorIcon from '@lobehub/icons-static-svg/icons/cursor.svg';
import devinIcon from '@lobehub/icons-static-svg/icons/devin-color.svg';
import geminiIcon from '@lobehub/icons-static-svg/icons/gemini-color.svg';
import geminiCliIcon from '@lobehub/icons-static-svg/icons/geminicli-color.svg';
import gooseIcon from '@lobehub/icons-static-svg/icons/goose.svg';
import grokIcon from '@lobehub/icons-static-svg/icons/grok.svg';
import hermesIcon from '@lobehub/icons-static-svg/icons/hermesagent.svg';
import kimiIcon from '@lobehub/icons-static-svg/icons/kimi-color.svg';
import kilocodeIcon from '@lobehub/icons-static-svg/icons/kilocode.svg';
import kiroIcon from '@lobehub/icons-static-svg/icons/kiro-color.svg';
import openClawIcon from '@lobehub/icons-static-svg/icons/openclaw-color.svg';
import openCodeIcon from '@lobehub/icons-static-svg/icons/opencode.svg';
import piIcon from '@lobehub/icons-static-svg/icons/pi.svg';
import qoderIcon from '@lobehub/icons-static-svg/icons/qoder-color.svg';
import qwenIcon from '@lobehub/icons-static-svg/icons/qwen-color.svg';
import roocodeIcon from '@lobehub/icons-static-svg/icons/roocode.svg';
import traeIcon from '@lobehub/icons-static-svg/icons/trae-color.svg';
import windsurfIcon from '@lobehub/icons-static-svg/icons/windsurf.svg';
import xiaomiMimoIcon from '@lobehub/icons-static-svg/icons/xiaomimimo.svg';
import zaiIcon from '@lobehub/icons-static-svg/icons/zai.svg';

interface ProviderIconAsset {
  monochrome?: boolean;
  src: string;
}

const PROVIDER_ICON_MAP: Record<string, ProviderIconAsset> = {
  amp: { src: ampIcon },
  antigravity: { src: antigravityIcon },
  'claude-code': { src: claudeCodeIcon },
  cline: { monochrome: true, src: clineIcon },
  codebuddy: { src: codeBuddyIcon },
  codex: { monochrome: true, src: codexIcon },
  'every-code': { monochrome: true, src: codexIcon },
  copilot: { src: copilotIcon },
  cursor: { monochrome: true, src: cursorIcon },
  devin: { src: devinIcon },
  gemini: { src: geminiIcon },
  'gemini-cli': { src: geminiCliIcon },
  grok: { monochrome: true, src: grokIcon },
  goose: { monochrome: true, src: gooseIcon },
  hermes: { monochrome: true, src: hermesIcon },
  kimi: { src: kimiIcon },
  'kilo-cli': { monochrome: true, src: kilocodeIcon },
  kilocode: { monochrome: true, src: kilocodeIcon },
  kiro: { src: kiroIcon },
  mimo: { monochrome: true, src: xiaomiMimoIcon },
  openclaw: { src: openClawIcon },
  opencode: { monochrome: true, src: openCodeIcon },
  pi: { monochrome: true, src: piIcon },
  qoder: { src: qoderIcon },
  qwen: { src: qwenIcon },
  'qwen-code': { src: qwenIcon },
  roocode: { monochrome: true, src: roocodeIcon },
  trae: { src: traeIcon },
  windsurf: { monochrome: true, src: windsurfIcon },
  workbuddy: { src: codeBuddyIcon },
  zcode: { monochrome: true, src: zaiIcon },
};

const PROVIDER_ALIASES: Record<string, string> = {
  'code-buddy': 'codebuddy',
  everycode: 'every-code',
  'github-copilot': 'copilot',
  'grok-build': 'grok',
  'kilo-code': 'kilocode',
  kilo: 'kilo-cli',
  mimocode: 'mimo',
  'oh-my-pi': 'omp',
  'open-claw': 'openclaw',
  'open-code': 'opencode',
  'openai-codex': 'codex',
  'roo-code': 'roocode',
  zai: 'zcode',
  'hermes-agent': 'hermes',
  'kimi-code': 'kimi',
  'kimi-legacy': 'kimi',
  'pi-coding-agent': 'pi',
  factory: 'droid',
};

/** Collapse local collector names and server integration slugs to one icon key. */
function normalizeProviderKey(provider: string): string {
  const key = provider.trim().toLowerCase().replace(/[\s_]+/g, '-');

  if (key === 'claude-code' || key.startsWith('claude')) return 'claude-code';
  if (key === 'codex' || key.startsWith('codex-')) return 'codex';
  if (key === 'cursor' || key.startsWith('cursor-')) return 'cursor';
  if (key === 'gemini' || key === 'gemini-cli' || key.startsWith('gemini-')) {
    return 'gemini-cli';
  }
  if (key === 'copilot' || key === 'copilot-cli' || key.startsWith('copilot-')) {
    return 'copilot';
  }
  if (key === 'opencode' || key.startsWith('opencode-')) return 'opencode';
  if (key.startsWith('antigravity')) return 'antigravity';
  if (key.startsWith('openclaw')) return 'openclaw';
  if (key.startsWith('hermes')) return 'hermes';
  if (key.startsWith('kimi')) return 'kimi';
  if (key.startsWith('kiro')) return 'kiro';
  if (key === 'roo-code' || key.startsWith('roocode') || key.startsWith('roo-')) {
    return 'roocode';
  }
  if (key.startsWith('zcode') || key === 'zai') return 'zcode';
  if (key === 'pi-coding-agent' || key.startsWith('pi-') || key === 'pi') return 'pi';
  if (key.startsWith('droid') || key.startsWith('factory')) return 'droid';
  if (key.startsWith('qoder')) return 'qoder';
  if (key.startsWith('trae')) return 'trae';
  if (key.startsWith('amp')) return 'amp';
  if (key.startsWith('qwen')) return 'qwen-code';
  if (key.startsWith('codebuddy') || key === 'code-buddy') return 'codebuddy';
  if (key.startsWith('workbuddy')) return 'workbuddy';
  if (key.startsWith('grok')) return 'grok';
  if (key.startsWith('goose')) return 'goose';
  if (key.startsWith('mimo') || key === 'mimocode' || key.startsWith('xiaomi')) return 'mimo';
  if (key === 'everycode' || key.startsWith('every-code')) return 'every-code';
  if (key.startsWith('omp') || key === 'oh-my-pi') return 'omp';
  if (key.startsWith('kilo-cli') || key === 'kilo') return 'kilo-cli';
  if (key.startsWith('kilocode') || key === 'kilo-code') return 'kilocode';
  if (key.startsWith('zed')) return 'zed';
  if (key.startsWith('warp')) return 'warp';
  if (key.startsWith('deepseek') || key.startsWith('harness') || key.startsWith('dsh')) {
    return 'deepseek';
  }

  return PROVIDER_ALIASES[key] ?? key;
}

interface ProviderIconProps {
  provider: string;
  size?: number;
  className?: string;
  /** Keep monochrome brand marks dark when the caller provides a light badge. */
  onLightBackground?: boolean;
  /** Render a high-contrast variant for a selected colored background. */
  isSelected?: boolean;
  /** Used by the neutral fallback icon. */
  color?: string;
}

export function ProviderIcon({
  provider,
  size = 16,
  className = '',
  onLightBackground = false,
  isSelected = false,
  color,
}: ProviderIconProps) {
  const key = normalizeProviderKey(provider);
  const asset = PROVIDER_ICON_MAP[key];

  if (asset) {
    return (
      <img
        alt=""
        aria-hidden
        className={`shrink-0 object-contain ${
          asset.monochrome
            ? isSelected
              ? 'invert'
              : !onLightBackground
                ? 'dark:invert'
                : ''
            : ''
        } ${className}`}
        height={size}
        src={asset.src}
        style={{ height: size, width: size }}
        width={size}
      />
    );
  }

  if (key === 'droid') {
    return (
      <DroidIcon
        className={className}
        size={size}
        style={{ color }}
      />
    );
  }

  if (key === 'omp') {
    return (
      <OmpIcon
        className={className}
        size={size}
        style={{ color }}
      />
    );
  }

  if (key === 'zed') {
    return (
      <ZedIcon
        className={className}
        size={size}
        style={{ color }}
      />
    );
  }

  if (key === 'warp') {
    return (
      <WarpIcon
        className={className}
        size={size}
        style={{ color }}
      />
    );
  }

  if (key === 'deepseek') {
    return (
      <DeepseekIcon
        className={className}
        size={size}
        style={{ color }}
      />
    );
  }

  return <PlaceholderIcon className={className} size={size} style={{ color }} />;
}

function OmpIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="currentColor"
      height={size}
      style={style}
      viewBox="0 0 120 90"
      width={size}
    >
      <rect height="12" rx="2" width="100" x="10" y="8" />
      <rect height="62" rx="2" width="12" x="25" y="20" />
      <rect height="45" rx="2" width="12" x="75" y="20" />
      <rect height="16" rx="3" width="20" x="71" y="55" />
      <rect height="8" rx="1" width="3" x="76" y="71" />
      <rect height="8" rx="1" width="3" x="82" y="71" />
    </svg>
  );
}

function ZedIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="currentColor"
      height={size}
      style={style}
      viewBox="0 0 16 16"
      width={size}
    >
      <path
        clipRule="evenodd"
        d="M3.125 2.75C2.9179 2.75 2.75 2.9179 2.75 3.125V11.375H2V3.125C2 2.50368 2.50368 2 3.125 2H13.1723C13.6735 2 13.9244 2.6059 13.5701 2.96025L7.38189 9.14843H9.125V8.375H9.875V9.33593C9.875 9.6466 9.6232 9.8984 9.3125 9.8984H6.63189L5.34282 11.1875H11.1875V6.5H11.9375V11.1875C11.9375 11.6017 11.6017 11.9375 11.1875 11.9375H4.59282L3.28032 13.25H12.875C13.0821 13.25 13.25 13.0821 13.25 12.875V4.625H14V12.875C14 13.4963 13.4963 14 12.875 14H2.82767C2.32653 14 2.07557 13.3941 2.42992 13.0397L8.59468 6.875H6.875V7.625H6.125V6.6875C6.125 6.37684 6.37684 6.125 6.6875 6.125H9.34468L10.6571 4.8125H4.8125V9.5H4.0625V4.8125C4.0625 4.39829 4.39829 4.0625 4.8125 4.0625H11.4071L12.7197 2.75H3.125Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function WarpIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="currentColor"
      height={size}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4.2 5.5h3.1l2.05 8.2 2.15-8.2h2.9l2.15 8.2 2.05-8.2h3.1L17.3 18.5h-3.05L12 10.2l-2.25 8.3H6.7L4.2 5.5Z" />
    </svg>
  );
}

function DeepseekIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="currentColor"
      height={size}
      style={style}
      viewBox="0 0 23.16 17.04"
      width={size}
    >
      <path d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z" />
    </svg>
  );
}

function DroidIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style?: CSSProperties;
}): ReactNode {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="none"
      height={size}
      style={style}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M9 3v2" />
      <path d="M15 3v2" />
      <rect height="13" rx="3" width="16" x="4" y="6" />
      <circle cx="9" cy="13" fill="currentColor" r="1.4" stroke="none" />
      <circle cx="15" cy="13" fill="currentColor" r="1.4" stroke="none" />
      <path d="M9 16h6" />
    </svg>
  );
}

function PlaceholderIcon({
  className,
  size,
  style,
}: {
  className: string;
  size: number;
  style: CSSProperties;
}) {
  return (
    <svg
      aria-hidden
      className={`shrink-0 ${className}`}
      fill="none"
      height={size}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <circle
        cx="12"
        cy="12"
        r="7.5"
        stroke="currentColor"
        strokeDasharray="3 3"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
