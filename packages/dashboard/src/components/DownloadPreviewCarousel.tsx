import { useEffect, useRef, useState, type ReactNode } from 'react';
import clickIdle from '@/assets/share-pets/click-idle.png';
import hawkingIdle from '@/assets/share-pets/hawking-idle.png';
import yoyoIdle from '@/assets/share-pets/yoyo-idle.png';
import { cn, formatCompactTokenCount } from '@/lib/utils';

const PREVIEW_INTERVAL_MS = 5200;
const PET_BUBBLE_MS = 1600;

export type PreviewSlide = {
  id: string;
  label: string;
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Narrow screenshots stay at their own size instead of filling the wide frame. */
  compact: boolean;
  headline: [string, string, string];
  description: string;
};

const PREVIEW_SRC_USAGE = `${import.meta.env.BASE_URL}e2.png`;
const PREVIEW_SRC = `${import.meta.env.BASE_URL}e3.png`;
const PREVIEW_SRC_MENU_BAR1 = `${import.meta.env.BASE_URL}e4.png`;
const PREVIEW_SRC_MENU_BAR2 = `${import.meta.env.BASE_URL}e5.png`;
export const PREVIEW_SLIDES: readonly PreviewSlide[] = [
  {
    id: 'overview',
    label: '用量看板与订阅额度',
    src: PREVIEW_SRC_USAGE,
    alt: 'Juejin Usage 用量看板：费用、Token、请求数、订阅额度与热力图',
    width: 2048,
    height: 1560,
    compact: false,
    headline: ['订阅还剩多少额度', '费用、Token 和请求数', '打开看板就能看到。'],
    description:
      'Codex、Claude、Cursor 的剩余额度，Token 消耗与费用，都可以分开看。',
  },
  {
    id: 'usage',
    label: '趋势、工具与项目',
    src: PREVIEW_SRC,
    alt: 'Juejin Usage 用量趋势：按天的 Token 与费用，以及工具、模型和项目分布',
    width: 2048,
    height: 1560,
    compact: false,
    headline: ['Token 和费用的变化', '工具、模型和项目的占比', '都可以分开看。'],
    description: '按天看用量怎么走，再看到具体是哪个工具、模型和项目。',
  },
  {
    id: 'menu-bar-quota',
    label: '菜单栏里的订阅额度',
    src: PREVIEW_SRC_MENU_BAR1,
    alt: 'Juejin Usage 菜单栏：Codex、Claude、Cursor 的剩余额度',
    width: 850,
    height: 1460,
    compact: true,
    headline: ['不用打开主窗口', '订阅还剩多少额度', '菜单栏里就能看到。'],
    description: '点一下菜单栏，就能看到 Codex、Claude、Cursor 还剩多少额度。',
  },
  {
    id: 'menu-bar-trend',
    label: '菜单栏里的今日趋势',
    src: PREVIEW_SRC_MENU_BAR2,
    alt: 'Juejin Usage 菜单栏：今天的费用、Token，以及工具和模型分布',
    width: 860,
    height: 1460,
    compact: true,
    headline: ['今天每小时用了多少', '哪些工具和模型在消耗', '菜单栏里就能看到。'],
    description: '点开菜单栏，就能看到今天的费用、Token，以及工具和模型分布。',
  },
];

const DEMO_PETS = [
  {
    id: 'hawking',
    name: 'Hawking',
    image: hawkingIdle,
    glow: '#ff7a1a',
    accent: '#ffd21f',
    tokens: '128.4万',
    cost: '$18.60',
  },
  {
    id: 'yoyo',
    name: 'Yoyo',
    image: yoyoIdle,
    glow: '#2f7df6',
    accent: '#ffd84a',
    tokens: '86.2万',
    cost: '$9.40',
  },
  {
    id: 'click',
    name: 'Click',
    image: clickIdle,
    glow: '#51d6a2',
    accent: '#ff7b8d',
    tokens: '42.8万',
    cost: '$4.15',
  },
] as const;

type DemoPetId = (typeof DEMO_PETS)[number]['id'];

type PetBubbleState =
  | { kind: 'usage'; id: DemoPetId }
  | { kind: 'sync'; id: DemoPetId; added: string };

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A plausible sync delta, then the same K/M/B compact format as the desktop pet. */
function randomAddedTokens(): string {
  const roll = Math.random();
  const tokens = roll < 0.3
    ? 80 + Math.random() * 900
    : roll < 0.75
      ? 1_000 + Math.random() * 180_000
      : 200_000 + Math.random() * 4_000_000;
  return formatCompactTokenCount(tokens);
}

function PetBubbleFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'absolute bottom-[calc(100%+0.75rem)] left-1/2 z-20 -translate-x-1/2 rounded-xl bg-white px-3 py-2 text-[#171717] shadow-[0_10px_28px_rgb(0_0_0/0.18)]',
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-white shadow-[2px_2px_3px_rgb(0_0_0/0.06)]"
      />
    </div>
  );
}

function PetSyncBubble({ added }: { added: string }) {
  return (
    <PetBubbleFrame className="w-max">
      <p className="flex items-center gap-1.5 text-[13px] leading-[1.2] font-semibold whitespace-nowrap text-[#171717]">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[#0485f7]" />
        <span className="inline-flex items-baseline gap-0.5">
          <span className="tabular-nums">+</span>
          <span className="text-[#0485f7] tabular-nums">{added}</span>
        </span>
        <span className="ms-1 text-[11px] font-medium text-[#737373]">Token</span>
      </p>
    </PetBubbleFrame>
  );
}

function PetBubble({ tokens, cost }: { tokens: string; cost: string }) {
  return (
    <PetBubbleFrame className="w-[136px]">
      <p className="mb-1.5 text-center text-[10px] leading-[1.2] tracking-[0.02em] text-[#737373]">
        近 7 天
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-[1.2] text-[#737373]">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[#0485f7]" />
          Token
        </span>
        <span className="truncate text-[13px] leading-[1.2] font-semibold tabular-nums">{tokens}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-[1.2] text-[#737373]">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[#4fbd91]" />
          费用
        </span>
        <span className="truncate text-[13px] leading-[1.2] font-semibold tabular-nums">{cost}</span>
      </div>
    </PetBubbleFrame>
  );
}

function DownloadPetStage() {
  const [bubble, setBubble] = useState<PetBubbleState | null>(null);
  const [hopId, setHopId] = useState<DemoPetId | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastPetId = useRef<DemoPetId | null>(null);
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;

  const clearBubbleTimer = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };

  const showBubble = (id: DemoPetId) => {
    setHopId(id);
    if (bubble?.kind === 'usage' && bubble.id === id) {
      clearBubbleTimer();
      setBubble(null);
      return;
    }
    setBubble({ kind: 'usage', id });
    clearBubbleTimer();
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setBubble((current) => (current?.kind === 'usage' && current.id === id ? null : current));
    }, PET_BUBBLE_MS);
    window.setTimeout(() => {
      setHopId((current) => (current === id ? null : current));
    }, 420);
  };

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let cancelled = false;
    let timer = 0;
    const wait = (delay: number) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        const current = bubbleRef.current;
        if (current?.kind === 'usage') {
          wait(600);
          return;
        }
        if (current?.kind === 'sync') {
          setBubble((next) => (next?.kind === 'sync' ? null : next));
          wait(1400 + Math.random() * 1600);
          return;
        }
        const candidates = DEMO_PETS.filter((pet) => pet.id !== 'yoyo' && pet.id !== lastPetId.current);
        const pet = candidates[Math.floor(Math.random() * candidates.length)] ?? DEMO_PETS[0]!;
        lastPetId.current = pet.id;
        setBubble({ kind: 'sync', id: pet.id, added: randomAddedTokens() });
        wait(PET_BUBBLE_MS);
      }, delay);
    };
    wait(900 + Math.random() * 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      clearBubbleTimer();
    };
  }, []);

  return (
    <div className="mt-6 flex w-full items-end justify-center gap-2 sm:mt-8 sm:gap-8">
      {DEMO_PETS.map((pet, index) => {
        const usageOpen = bubble?.kind === 'usage' && bubble.id === pet.id;
        const syncAdded = bubble?.kind === 'sync' && bubble.id === pet.id ? bubble.added : null;
        return (
          <div
            className={cn(
              'relative flex w-24 flex-col items-center sm:w-28',
              (usageOpen || syncAdded) && 'z-20',
            )}
            key={pet.id}
          >
            {usageOpen ? <PetBubble cost={pet.cost} tokens={pet.tokens} /> : null}
            {syncAdded ? <PetSyncBubble added={syncAdded} /> : null}
            <button
              aria-label={`${pet.name}，点击查看用量`}
              aria-pressed={usageOpen}
              className="group flex cursor-pointer flex-col items-center border-0 bg-transparent p-0 outline-offset-4"
              type="button"
              onClick={() => showBubble(pet.id)}
            >
              <span className="block transition-transform duration-200 ease-out group-hover:-translate-y-1.5 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:transform-none">
                <img
                  alt=""
                  className={cn(
                    'h-20 w-auto max-w-full object-contain sm:h-24',
                    hopId === pet.id && 'motion-safe:animate-[download-pet-hop_420ms_ease-out]',
                    hopId !== pet.id &&
                      'motion-safe:animate-[download-pet-float_2.8s_ease-in-out_infinite]',
                  )}
                  draggable={false}
                  height={208}
                  src={pet.image}
                  style={{
                    animationDelay: hopId === pet.id ? undefined : `${index * 180}ms`,
                    filter: `drop-shadow(0 8px 12px ${pet.glow}55) drop-shadow(0 0 14px ${pet.accent}44)`,
                  }}
                  width={192}
                />
              </span>
              <span
                className={cn(
                  'mt-1 text-xs font-medium',
                  usageOpen ? 'text-foreground' : 'text-muted',
                )}
              >
                {pet.name}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Screenshot carousel with the three desktop pets underneath. */
export function DownloadPreviewCarousel({
  index,
  onIndexChange,
}: {
  index: number;
  onIndexChange: (index: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  const count = PREVIEW_SLIDES.length;

  useEffect(() => {
    if (paused || count < 2 || prefersReducedMotion()) return;
    const timer = window.setInterval(() => {
      onIndexChange((index + 1) % count);
    }, PREVIEW_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, count, index, onIndexChange]);

  const active = PREVIEW_SLIDES[index] ?? PREVIEW_SLIDES[0]!;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center">
      <figure
        aria-label="产品预览"
        aria-roledescription="carousel"
        className={cn(
          'mx-auto overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-[0_24px_48px_-28px_rgb(15_23_42/0.45)] motion-safe:transition-[width] motion-safe:duration-500 dark:shadow-[0_24px_48px_-24px_rgb(0_0_0/0.65)]',
          active.compact ? 'w-[min(100%,18rem)]' : 'w-full',
        )}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
        }}
        onFocus={() => setPaused(true)}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div
          className="relative w-full motion-safe:transition-[aspect-ratio] motion-safe:duration-500"
          style={{ aspectRatio: `${active.width} / ${active.height}` }}
        >
          {PREVIEW_SLIDES.map((slide) => (
            <img
              alt={slide.alt}
              aria-hidden={slide.id !== active.id}
              className={cn(
                'absolute inset-0 h-full w-full object-contain motion-safe:transition-opacity motion-safe:duration-500',
                slide.id === active.id ? 'opacity-100' : 'pointer-events-none opacity-0',
              )}
              decoding="async"
              height={slide.height}
              inert={slide.id !== active.id}
              key={slide.id}
              src={slide.src}
              width={slide.width}
            />
          ))}
        </div>
      </figure>
      <p className="mt-3 text-center text-sm font-normal text-foreground">{active.label}</p>
      {count > 1 ? (
        <div
          aria-label="切换预览"
          className="mt-2 flex items-center justify-center gap-1.5"
          role="tablist"
        >
          {PREVIEW_SLIDES.map((slide, slideIndex) => {
            const selected = slideIndex === index;
            return (
              <button
                aria-label={slide.label}
                aria-selected={selected}
                className={cn(
                  'h-1.5 cursor-pointer rounded-full transition-[width,background-color] duration-200',
                  selected ? 'w-6 bg-foreground' : 'w-1.5 bg-foreground/25 hover:bg-foreground/45',
                )}
                key={slide.id}
                role="tab"
                type="button"
                onClick={() => onIndexChange(slideIndex)}
              />
            );
          })}
        </div>
      ) : null}
      <DownloadPetStage />
    </div>
  );
}
