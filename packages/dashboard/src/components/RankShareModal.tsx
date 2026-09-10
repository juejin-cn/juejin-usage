import { ArrowDownToLine } from '@gravity-ui/icons';
import { Avatar, Button, Chip, Modal, Skeleton } from '@heroui/react';
import { CircleDollarSign, Coins, Copy } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardRow,
  LeaderboardUserProfile,
} from '@/lib/api';
import { formatTokens, formatUsd } from '@/lib/format';
import {
  formatRankPosition,
  rankShareFallbackLabel,
  resolveRankShareViewer,
  type RankShareFallbackKind,
} from '@/lib/leaderboard';
import {
  copyShareCardPng,
  downloadShareCardPng,
  renderSharePosterPng,
} from '@/lib/share-card-image';
import juejinQrLogoUrl from '../assets/juejin-qr-logo.svg?url&inline';

const RANK_PAGE_URL = 'https://juejin.cn/aiusage/rank';
const SHARE_TOP_RANK_LIMIT = 5;

type DetailedLeaderboardRow = LeaderboardRow & {
  avatarUrl?: string | null;
  uid?: string;
};

/** A poster-like preview of the active Token leaderboard. */
export function RankShareModal({
  board,
  hideFromLeaderboard = false,
  isSignedIn = false,
  loading,
  metric,
  modelLabel,
  onOpenChange,
  open,
  profiles,
  toolLabel,
}: {
  board: LeaderboardBoard | null;
  hideFromLeaderboard?: boolean;
  isSignedIn?: boolean;
  loading: boolean;
  metric: LeaderboardMetric;
  modelLabel: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  profiles: Record<string, LeaderboardUserProfile>;
  toolLabel: string;
}) {
  const shareViewer = resolveRankShareViewer(board, {
    hideFromLeaderboard,
    isSignedIn,
  });
  const currentUser = shareViewer.kind === 'row' ? shareViewer.row : null;
  const fallbackKind =
    shareViewer.kind === 'anonymous' || shareViewer.kind === 'off_board'
      ? shareViewer.kind
      : null;
  const posterRef = useRef<HTMLElement>(null);
  const [activeAction, setActiveAction] = useState<ShareAction | null>(null);
  const [result, setResult] = useState<{
    action: ShareAction;
    state: 'error' | 'success';
  } | null>(null);

  useEffect(() => {
    if (open) {
      setActiveAction(null);
      setResult(null);
    }
  }, [open]);

  const getActionLabel = (action: ShareAction) => {
    if (activeAction === action) {
      return action === 'download' ? '生成中…' : '复制中…';
    }
    if (result?.action === action) {
      if (result.state === 'success') {
        return action === 'download' ? '已下载' : '已复制';
      }
      return action === 'download' ? '下载失败' : '复制失败';
    }
    return action === 'download' ? '下载到本地' : '复制分享图';
  };

  const finishAction = (action: ShareAction, state: 'error' | 'success') => {
    setActiveAction(null);
    setResult({ action, state });
  };

  const renderPoster = () => {
    if (!posterRef.current) {
      return Promise.reject(new Error('分享海报尚未准备完成'));
    }
    return renderSharePosterPng(posterRef.current);
  };

  const handleDownload = async () => {
    if (activeAction || loading) return;
    setActiveAction('download');
    setResult(null);
    try {
      downloadShareCardPng(await renderPoster());
      finishAction('download', 'success');
    } catch (error) {
      console.error('[rank-share] download failed', error);
      finishAction('download', 'error');
    }
  };

  const handleCopy = async () => {
    if (activeAction || loading) return;
    setActiveAction('copy');
    setResult(null);
    try {
      await copyShareCardPng(renderPoster());
      finishAction('copy', 'success');
    } catch (error) {
      console.error('[rank-share] clipboard write failed', error);
      finishAction('copy', 'error');
    }
  };

  return (
    <Modal>
      <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange} variant="blur">
        <Modal.Container
          className="px-3 py-8 sm:px-4"
          scroll="inside"
          size="sm"
        >
          <Modal.Dialog
            aria-label="分享排行榜"
            className="!w-full !max-w-[420px] !overflow-visible !border-0 !bg-transparent !p-0 !shadow-none"
          >
            <Modal.Body className="space-y-3 p-0">
              <section
                aria-label={`${metric === 'tokens' ? 'Token' : '消费'} 排行榜分享预览`}
                className="relative isolate overflow-hidden rounded-[22px] border border-white/85 bg-[#edf7ff] px-4 pb-4 pt-5 text-[#18283a] shadow-[0_18px_36px_rgb(56_121_188_/0.18)] dark:border-white/10 dark:bg-[#0d1b2d] dark:text-[#eaf4ff] dark:shadow-[0_18px_36px_rgb(0_0_0_/0.38)] sm:px-5 sm:pb-5 sm:pt-6"
                ref={posterRef}
              >
                <RankShareBackground />

                <div className="relative z-10">
                  <header className="flex items-start justify-between gap-3">
                    <h2 className="inline-flex whitespace-nowrap pt-0.5 text-[28px] font-black italic leading-none tracking-[-0.055em] text-[#14243a] dark:text-[#f1f8ff] sm:text-[32px]">
                      <span>Token</span>
                      <span className="ml-2">排行榜</span>
                    </h2>
                    <div aria-label="排行榜指标" className="-mr-1.5 -mt-1 shrink-0">
                      <MetricGlassChip>
                        {metric === 'tokens' ? '按 Token' : '按消费'}
                      </MetricGlassChip>
                    </div>
                  </header>

                  <section className="mt-5" aria-label="排行榜">
                    <div className="flex flex-wrap gap-1.5 text-[10px] font-medium text-[#5c7d9c] dark:text-[#a8c1da]">
                      <span className="max-w-32 truncate rounded-full border border-white/80 bg-white/[0.5] px-2 py-1 shadow-[inset_0_1px_0_rgb(255_255_255_/0.9)] backdrop-blur-sm dark:border-white/10 dark:bg-white/[0.08] dark:shadow-none">
                        {toolLabel}
                      </span>
                      <span className="max-w-44 truncate rounded-full border border-white/80 bg-white/[0.5] px-2 py-1 shadow-[inset_0_1px_0_rgb(255_255_255_/0.9)] backdrop-blur-sm dark:border-white/10 dark:bg-white/[0.08] dark:shadow-none">
                        {modelLabel}
                      </span>
                    </div>

                    {loading ? (
                      <ShareLeaderboardSkeleton />
                    ) : (
                      <ShareLeaderboard
                        currentUser={currentUser}
                        fallbackKind={fallbackKind}
                        profiles={profiles}
                        rows={board?.rows ?? []}
                      />
                    )}
                  </section>

                  <RankShareQrCode />
                </div>
              </section>

              <div className="flex items-center justify-center gap-2 pb-1">
                <Button
                  isDisabled={loading || activeAction === 'copy'}
                  isPending={activeAction === 'download'}
                  onPress={() => void handleDownload()}
                  size="sm"
                >
                  <ArrowDownToLine className="size-3.5" />
                  {getActionLabel('download')}
                </Button>
                <Button
                  isDisabled={loading || activeAction === 'download'}
                  isPending={activeAction === 'copy'}
                  onPress={() => void handleCopy()}
                  size="sm"
                  variant="tertiary"
                >
                  <Copy className="size-3.5" />
                  {getActionLabel('copy')}
                </Button>
                <Button size="sm" slot="close" variant="tertiary">
                  关闭
                </Button>
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function ShareLeaderboard({
  currentUser,
  fallbackKind,
  profiles,
  rows,
}: {
  currentUser: LeaderboardRow | null;
  fallbackKind: RankShareFallbackKind | null;
  profiles: Record<string, LeaderboardUserProfile>;
  rows: LeaderboardRow[];
}) {
  const topRows = rows.slice(0, SHARE_TOP_RANK_LIMIT);
  const currentUserInTopRows = currentUser
    ? topRows.some((row) => isSameLeaderboardUser(row, currentUser))
    : false;

  return (
    <div className="mt-5" aria-label="排行榜列表">
      {topRows.length > 0 ? (
        <ol className="space-y-1.5">
          {topRows.map((row) => (
            <ShareLeaderboardRow
              isCurrentUser={Boolean(currentUser && isSameLeaderboardUser(row, currentUser))}
              key={`${row.userHash}-${row.rank}`}
              profiles={profiles}
              row={row}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-3 px-2 text-[11px] text-[#7892ac] dark:text-[#9bb7d2]">
          暂无排行榜数据
        </p>
      )}

      {currentUser && !currentUserInTopRows ? (
        <>
          {topRows.length > 0 && (
            <div aria-hidden className="py-2 text-center text-sm font-black tracking-[0.3em] text-[#7892ac] dark:text-[#9bb7d2]">
              · · ·
            </div>
          )}
          <ol className="my-1.5 py-1.5">
            <ShareLeaderboardRow
              isCurrentUser
              profiles={profiles}
              row={currentUser}
            />
          </ol>
        </>
      ) : null}

      {fallbackKind && (
        <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-[#b9d8ff] bg-white/[0.32] px-3 py-2.5 text-[11px] dark:border-white/15 dark:bg-white/[0.05]">
          <span className="font-semibold text-[#5c7d9c] dark:text-[#a8c1da]">我的排名</span>
          <span className="font-bold text-[#334e69] dark:text-[#f1f8ff]">
            {rankShareFallbackLabel(fallbackKind)}
          </span>
        </div>
      )}
    </div>
  );
}

function ShareLeaderboardRow({
  isCurrentUser,
  profiles,
  row,
}: {
  isCurrentUser: boolean;
  profiles: Record<string, LeaderboardUserProfile>;
  row: LeaderboardRow;
}) {
  const details = getRowDetails(row, profiles);
  const tokens = formatTokens(row.totalTokens ?? row.tokens);
  const cost = formatUsd(row.costUsd);
  const rankLabel = formatRankPosition(row.rank);

  return (
    <li
      className={
        isCurrentUser
          ? 'relative mx-5 my-4 origin-center scale-110 py-1.5'
          : 'relative'
      }
      data-current-user={isCurrentUser ? 'true' : undefined}
    >
      {isCurrentUser && (
        <p className="mb-3 text-[10px] font-semibold tracking-[0.04em] text-[#1e80ff] dark:text-[#79b7ff]">
          @{details.displayName} · 排名
        </p>
      )}
      <div
        className={`grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-1 rounded-xl px-2 py-2.5 ${
          isCurrentUser
            ? 'border border-[#8ec0ff]/80 bg-[#dcedff]/90 shadow-[0_8px_18px_rgb(30_128_255_/0.16),inset_0_1px_0_rgb(255_255_255_/0.9)] dark:border-[#4b91d1] dark:bg-[#173b5f]/90 dark:shadow-[0_8px_18px_rgb(0_0_0_/0.25)]'
            : 'border border-white/55 bg-white/[0.38] shadow-[inset_0_1px_0_rgb(255_255_255_/0.72)] dark:border-white/[0.07] dark:bg-white/[0.045] dark:shadow-none'
        }`}
      >
        <span
          className={`min-w-0 text-center font-black leading-none tabular-nums ${
            isCurrentUser
              ? 'text-[#1e80ff] dark:text-[#79b7ff]'
              : rankColorClass(row.rank)
          } ${
            rankLabel === '—' || rankLabel.length >= 3
              ? 'text-[12px]'
              : 'text-[17px]'
          }`}
        >
          {rankLabel === '—' ? '未上榜' : `#${rankLabel}`}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="size-7 shrink-0 border border-white/80 shadow-sm dark:border-white/15" size="sm">
            {details.avatarUrl ? (
              <Avatar.Image alt="" loading="eager" src={details.avatarUrl} />
            ) : null}
            <Avatar.Fallback color="accent" delayMs={0}>
              {details.displayName.slice(0, 1).toUpperCase() || 'J'}
            </Avatar.Fallback>
          </Avatar>
          <span className="min-w-0 truncate text-[12px] font-semibold text-[#294560] dark:text-[#dceeff]">
            {details.displayName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-right text-[10px] font-bold tabular-nums">
          <span
            className="inline-flex w-auto shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#b9d8ff]/85 bg-[#e4f1ff]/80 px-2 py-1 text-[#1e80ff] shadow-[inset_0_1px_0_rgb(255_255_255_/0.82)] dark:border-[#356796] dark:bg-[#193755]/80 dark:text-[#79b7ff] dark:shadow-none"
            title={`Token：${tokens}`}
          >
            <Coins aria-hidden className="size-3 shrink-0" />
            <span>{tokens}</span>
          </span>
          <span
            className="inline-flex w-auto shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[#a8d9ba]/85 bg-[#e6f8ec]/80 px-2 py-1 text-[#22a05a] shadow-[inset_0_1px_0_rgb(255_255_255_/0.82)] dark:border-[#377b55] dark:bg-[#153d29]/80 dark:text-[#63d98a] dark:shadow-none"
            title={`消费：${cost}`}
          >
            <CircleDollarSign aria-hidden className="size-3 shrink-0" />
            <span>{cost}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

function isSameLeaderboardUser(left: LeaderboardRow, right: LeaderboardRow) {
  return (
    left.userHash === right.userHash ||
    (Boolean(left.uid) && left.uid === right.uid) ||
    (left.isCurrentUser && right.isCurrentUser)
  );
}

function rankColorClass(rank: number) {
  if (rank === 1) return 'text-[#f26b42] dark:text-[#ff9b74]';
  if (rank === 2) return 'text-[#e39a3a] dark:text-[#ffc36b]';
  if (rank === 3) return 'text-[#8f79d8] dark:text-[#b9a7ff]';
  return 'text-[#5c7d9c] dark:text-[#a8c1da]';
}

function ShareLeaderboardSkeleton() {
  return (
    <div className="mt-5" aria-label="排行榜加载中">
      <div className="space-y-1.5">
        {Array.from({ length: SHARE_TOP_RANK_LIMIT }, (_, index) => (
          <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-1 rounded-xl border border-white/55 bg-white/[0.38] px-2 py-2.5 dark:border-white/[0.07] dark:bg-white/[0.045]" key={index}>
            <Skeleton className="mx-auto h-5 w-7 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-3 w-24 rounded" />
            </div>
            <div className="ml-auto flex items-center gap-3">
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-6 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </div>
      <div className="my-4 py-1.5">
        <Skeleton className="mb-1.5 ml-3 h-3 w-24 rounded" />
        <Skeleton className="h-11 w-full rounded-xl" />
      </div>
    </div>
  );
}

function RankShareQrCode() {
  return (
    <footer className="mt-8 flex items-center justify-between gap-3 rounded-2xl border border-white/75 bg-white/[0.52] px-3 py-2.5 shadow-[inset_0_1px_0_rgb(255_255_255_/0.9)] backdrop-blur-sm dark:border-white/10 dark:bg-white/[0.06] dark:shadow-none">
      <div className="min-w-0 pl-1">
        <p className="text-[13px] font-semibold text-[#385775] dark:text-[#d6e8fa]">扫码查看排行榜</p>
        <p className="mt-1 truncate text-[11px] text-[#7892ac] dark:text-[#9bb7d2]">Juejin Usage · Token 排行榜</p>
      </div>
      <QRCodeSVG
        bgColor="#ffffff"
        className="size-[58px] shrink-0 rounded-lg bg-white p-1 shadow-sm"
        fgColor="#14243a"
        imageSettings={{
          excavate: true,
          height: 12,
          src: juejinQrLogoUrl,
          width: 12,
        }}
        level="H"
        marginSize={1}
        size={58}
        title="扫码查看 Juejin Usage 排行榜"
        value={RANK_PAGE_URL}
      />
    </footer>
  );
}

type ShareAction = 'copy' | 'download';

function MetricGlassChip({ children }: { children: React.ReactNode }) {
  return (
    <Chip
      className="h-6 min-h-6 border border-[#b9d8ff] bg-[#e4f1ff]/90 px-2.5 text-[#1e80ff] shadow-[inset_0_1px_0_rgb(255_255_255_/0.9),0_2px_8px_rgb(56_121_188_/0.08)] backdrop-blur-md dark:border-[#356796] dark:bg-[#193755]/90 dark:text-[#79b7ff] dark:shadow-none"
      size="sm"
      variant="secondary"
    >
      <Chip.Label className="text-[10px] font-semibold leading-none">
        {children}
      </Chip.Label>
    </Chip>
  );
}

function RankShareBackground() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -right-16 -top-20 size-72 rounded-full bg-[#cfe8ff]/75 blur-3xl dark:bg-[#1e80ff]/20" />
      <div className="absolute right-12 top-5 size-24 rounded-full bg-white/70 blur-2xl dark:bg-[#4b9cff]/15" />
      <div className="absolute -left-12 bottom-24 size-40 rounded-full bg-[#dbeeff]/80 blur-3xl dark:bg-[#347ff0]/15" />
      <span className="absolute right-9 top-12 size-2.5 rounded-full bg-[#7eb6ff]/75" />
      <span className="absolute right-28 top-20 size-1.5 rounded-full bg-[#5aa2ff]/60" />
      <span className="absolute right-5 top-40 size-2 rounded-full border-2 border-[#8ec0ff]/80" />

      <svg
        className="absolute -right-1 top-9 h-32 w-24 rotate-[16deg] opacity-60 dark:opacity-15"
        fill="none"
        viewBox="0 0 112 148"
      >
        <rect fill="#f5f9ff" height="132" rx="14" stroke="#c5dcff" strokeWidth="2" width="96" x="8" y="8" />
        <path d="M28 40H84M28 56H72M28 72H78M28 88H64" stroke="#c5dcff" strokeLinecap="round" strokeWidth="6" />
      </svg>
      <svg
        className="absolute right-6 top-20 h-36 w-28 rotate-[7deg] opacity-70 drop-shadow-[0_10px_18px_rgb(30_128_255_/0.12)] dark:opacity-25"
        fill="none"
        viewBox="0 0 128 168"
      >
        <rect fill="#eef6ff" height="148" rx="16" stroke="#7eb6ff" strokeWidth="2.5" width="108" x="10" y="10" />
        <path d="M34 46H94M34 66H82M34 86H88M34 106H70" stroke="#8ec0ff" strokeLinecap="round" strokeWidth="7" />
      </svg>
      <svg
        className="absolute -bottom-4 -right-2 size-20 rotate-[14deg] opacity-65 dark:opacity-25"
        fill="none"
        viewBox="0 0 64 64"
      >
        <path d="M20 14h24v12c0 8-5.5 14-12 14s-12-6-12-14V14z" fill="#e8f3ff" stroke="#7eb6ff" strokeLinejoin="round" strokeWidth="2" />
        <path d="M20 18H14c0 8 4 12 8 13M44 18h6c0 8-4 12-8 13" stroke="#5aa2ff" strokeLinecap="round" strokeWidth="2" />
        <path d="M28 40v6h8v-6M24 50h16" stroke="#8ec0ff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
        <circle cx="32" cy="24" fill="#1e80ff" r="3" />
      </svg>
    </div>
  );
}

function getRowDetails(
  row: LeaderboardRow,
  profiles: Record<string, LeaderboardUserProfile>,
): {
  avatarUrl: string | null;
  displayName: string;
} {
  const detailedRow = row as DetailedLeaderboardRow;
  const uid = detailedRow.uid ?? row.userHash;
  const profile = profiles[uid];

  return {
    avatarUrl: profile?.avatarUrl ?? detailedRow.avatarUrl ?? null,
    displayName: profile?.userName ?? row.displayName,
  };
}
