import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconLock,
  IconMoon,
  IconPlus,
  IconRefresh,
  IconSun,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import {
  createEmbedCard,
  deleteEmbedCard,
  fetchEmbedCards,
  fetchEmbedCatalog,
  getApiBearer,
  getEmbedApiBase,
  updateEmbedCard,
  type EmbedCardView,
} from '@/lib/api';
import {
  buildEmbedSnippets,
  defaultShowFieldsForTemplate,
  EMBED_STYLE_OPTIONS,
  fieldLabel,
  hasLocalEmbedTemplate,
  mergeEmbedCatalog,
  renderLocalEmbedPreviewSvg,
  sameFieldSet,
  type EmbedCopyFormat,
  type EmbedStyle,
  type EmbedStyleOption,
} from '@/lib/embed-usage';
import { JUEJIN_HOME } from '@/lib/juejin-client-link';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { JUEJIN_LINK_CHANGED_EVENT } from '@/lib/shell-events';
import { cn } from '@web/lib/utils';
import { Button } from './ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const MAX_CARDS = 10;
const formatError = (error: unknown) => (error instanceof Error ? error.message : '请求失败，请稍后重试');

type CardDraft = {
  shareId: string;
  templateId: string;
  showFields: string[];
  label: string;
};

function draftFromCard(card: EmbedCardView, catalog: readonly EmbedStyleOption[]): CardDraft {
  const meta = catalog.find(c => c.id === card.templateId);
  const allowed = new Set(meta?.fields.map(f => f.key) ?? []);
  const showFields = card.showFields.filter(key => allowed.has(key));
  return {
    shareId: card.shareId,
    templateId: card.templateId,
    showFields: allowed.size ? showFields : [...card.showFields],
    label: card.label ?? '',
  };
}

function TemplateSwatch({ templateId }: { templateId: string }) {
  if (templateId === 'classic-dark') {
    return (
      <span
        aria-hidden="true"
        className="relative flex h-4.5 w-6 shrink-0 flex-col justify-center gap-0.5 overflow-hidden rounded-[4px] border border-white/15 bg-[#141b1a] pl-1.5 pr-1"
      >
        <span className="absolute inset-y-0 left-0 w-[2.5px] bg-[#087FFA]" />
        <span className="h-[2px] w-2.5 rounded-full bg-white/85" />
        <span className="h-[1.5px] w-3 rounded-full bg-[#38bdf8]/80" />
      </span>
    );
  }
  if (templateId === 'compact') {
    return (
      <span
        aria-hidden="true"
        className="flex h-4.5 w-6 shrink-0 items-center justify-between gap-0.5 overflow-hidden rounded-[4px] border border-black/12 bg-white px-1 dark:border-white/15"
      >
        <span className="size-1.5 rounded-full bg-[#1f80ff]" />
        <span className="h-[2px] flex-1 rounded-full bg-neutral-700/75" />
      </span>
    );
  }
  if (templateId === 'tokens-only') {
    return (
      <span
        aria-hidden="true"
        className="flex h-4.5 w-6 shrink-0 flex-col justify-center gap-0.5 overflow-hidden rounded-[4px] border border-black/12 bg-white px-1 dark:border-white/15"
      >
        <span className="h-[2px] w-3.5 rounded-full bg-neutral-800/80" />
        <span className="h-[1.5px] w-2 rounded-full bg-neutral-400/75" />
      </span>
    );
  }
  if (templateId === 'stats-row') {
    return (
      <span
        aria-hidden="true"
        className="grid h-4.5 w-6 shrink-0 grid-cols-3 items-center gap-[2px] overflow-hidden rounded-[4px] border border-black/12 bg-white px-[3px] dark:border-white/15"
      >
        <span className="h-2 rounded-[1.5px] bg-[#e8f1ff]" />
        <span className="h-2 rounded-[1.5px] bg-[#e8f1ff]" />
        <span className="h-2 rounded-[1.5px] bg-[#e8f1ff]" />
      </span>
    );
  }
  if (templateId === 'badge') {
    return (
      <span
        aria-hidden="true"
        className="flex h-4.5 w-6 shrink-0 items-center justify-center"
      >
        <span className="flex h-2.5 w-6 overflow-hidden rounded-[2px]">
          <span className="w-2.5 bg-[#555555]" />
          <span className="flex-1 bg-[#007ec6]" />
        </span>
      </span>
    );
  }
  // classic-light & default
  return (
    <span
      aria-hidden="true"
      className="relative flex h-4.5 w-6 shrink-0 flex-col justify-center gap-0.5 overflow-hidden rounded-[4px] border border-black/12 bg-white pl-1.5 pr-1 dark:border-white/15"
    >
      <span className="absolute inset-y-0 left-0 w-[2.5px] bg-[#087FFA]" />
      <span className="h-[2px] w-2.5 rounded-full bg-neutral-800/80" />
      <span className="h-[1.5px] w-3 rounded-full bg-[#1f80ff]/80" />
    </span>
  );
}

function TemplateGrid({
  ariaLabel,
  catalog,
  value,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  catalog: readonly EmbedStyleOption[];
  value: string;
  disabled?: boolean;
  onChange: (templateId: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid grid-cols-2 gap-1.5"
    >
      {catalog.map(option => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={option.description ? `${option.label} · ${option.description}` : option.label}
            onClick={() => onChange(option.id)}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              active
                ? 'border-primary bg-(--web-primary-soft) text-primary'
                : 'border-border/80 bg-surface text-foreground hover:border-foreground/20 hover:bg-surface-secondary/70',
            )}
          >
            <TemplateSwatch templateId={option.id} />
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function EmbedUsageBody() {
  const { userName, avatarLarge } = useJuejinAuth();
  const [identity, setIdentity] = useState(getApiBearer);
  const [cards, setCards] = useState<EmbedCardView[]>([]);
  const [catalog, setCatalog] = useState<readonly EmbedStyleOption[]>(EMBED_STYLE_OPTIONS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [format, setFormat] = useState<EmbedCopyFormat>('markdown-page');
  const [copiedFormat, setCopiedFormat] = useState<EmbedCopyFormat | null>(null);
  const [copiedShareId, setCopiedShareId] = useState(false);
  const [previewDarkBg, setPreviewDarkBg] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<EmbedStyle>('classic-light');
  const [createLabel, setCreateLabel] = useState('');

  const requestVersion = useRef(0);
  const writing = useRef(false);
  const noticeTimer = useRef<number | null>(null);
  const copyTimer = useRef<number | null>(null);
  const shareIdCopyTimer = useRef<number | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    if (shareIdCopyTimer.current) window.clearTimeout(shareIdCopyTimer.current);
  }, []);

  const selected = useMemo(
    () => cards.find(c => c.shareId === selectedId) ?? cards[0] ?? null,
    [cards, selectedId],
  );

  useEffect(() => {
    setCopiedFormat(null);
    setCopiedShareId(false);
    if (!selected) {
      setDraft(null);
      return;
    }
    setDraft(prev => {
      if (prev?.shareId === selected.shareId) return prev;
      return draftFromCard(selected, catalog);
    });
  }, [selected, catalog]);

  const refresh = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet === true;
    const version = quiet ? requestVersion.current : ++requestVersion.current;
    const user = getApiBearer();
    setIdentity(user);
    setError(null);
    if (!quiet) {
      setRotateOpen(false);
      setDeleteOpen(false);
      setLoading(Boolean(user));
      setBusy(false);
      writing.current = false;
    }
    if (!user) {
      setCards([]);
      setCatalog(EMBED_STYLE_OPTIONS);
      setSelectedId(null);
      setDraft(null);
      if (!quiet) setLoading(false);
      return;
    }
    try {
      const [result, remoteCatalog] = await Promise.all([
        fetchEmbedCards(),
        fetchEmbedCatalog().catch(() => null),
      ]);
      if (version !== requestVersion.current || user !== getApiBearer()) return;
      setCatalog(mergeEmbedCatalog(remoteCatalog ?? undefined));
      setCards(result);
      setSelectedId(prev => {
        if (prev && result.some(c => c.shareId === prev)) return prev;
        return result[0]?.shareId ?? null;
      });
    } catch (cause) {
      if (version === requestVersion.current && user === getApiBearer()) {
        const detail = formatError(cause);
        if (/UNAUTHENTICATED|unauthorized|401/i.test(detail)) setIdentity(null);
        setError(detail);
      }
    } finally {
      if (!quiet && version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const changed = () => { void refresh(); };
    window.addEventListener('tud:api-identity-changed', changed);
    window.addEventListener(JUEJIN_LINK_CHANGED_EVENT, changed);
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'tud.apiBearer' || event.key === null) changed();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      requestVersion.current++;
      window.removeEventListener('tud:api-identity-changed', changed);
      window.removeEventListener(JUEJIN_LINK_CHANGED_EVENT, changed);
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  const mutate = async <T,>(
    action: () => Promise<T>,
    successText: string,
    after?: (result: T) => void,
    opts?: { refreshMode?: 'quiet' | 'full' | 'none' },
  ) => {
    if (writing.current) return;
    writing.current = true;
    const version = ++requestVersion.current;
    const user = getApiBearer();
    setBusy(true);
    setError(null);
    const refreshMode = opts?.refreshMode ?? 'quiet';
    try {
      const result = await action();
      if (version !== requestVersion.current || user !== getApiBearer()) return;
      after?.(result);
      setRotateOpen(false);
      setDeleteOpen(false);
      setCreateOpen(false);
      showNotice(successText);
      if (refreshMode === 'full') await refresh();
      else if (refreshMode === 'quiet') await refresh({ quiet: true });
    } catch (cause) {
      if (version === requestVersion.current && user === getApiBearer()) {
        setError(formatError(cause));
      }
    } finally {
      if (version === requestVersion.current) {
        setBusy(false);
        writing.current = false;
      }
    }
  };

  const dirty = Boolean(
    selected
    && draft
    && draft.shareId === selected.shareId
    && (
      draft.templateId !== selected.templateId
      || !sameFieldSet(draft.showFields, selected.showFields)
      || draft.label !== (selected.label ?? '')
    ),
  );

  const templateMeta = draft
    ? catalog.find(c => c.id === draft.templateId) ?? null
    : selected
      ? catalog.find(c => c.id === selected.templateId) ?? null
      : null;

  const selectedMeta = selected
    ? catalog.find(c => c.id === selected.templateId) ?? null
    : null;

  const snippets = useMemo(() => {
    if (!selected) return null;
    try {
      return buildEmbedSnippets(
        getEmbedApiBase(),
        selected.shareId,
        templateMeta ? { width: templateMeta.width, height: templateMeta.height } : undefined,
      );
    } catch {
      return null;
    }
  }, [selected, templateMeta]);

  const previewProfile = useMemo(
    () => ({
      userName: userName || undefined,
      avatarUrl: avatarLarge || undefined,
    }),
    [userName, avatarLarge],
  );

  const previewSvg = useMemo(
    () => (draft ? renderLocalEmbedPreviewSvg(draft.templateId, draft.showFields, previewProfile) : null),
    [draft, previewProfile],
  );

  const copy = async (id: EmbedCopyFormat, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFormat(id);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedFormat(null), 1800);
    } catch {
      setError('复制失败，请选中下方文本手动复制。');
    }
  };

  const copyShareId = async (shareId: string) => {
    try {
      await navigator.clipboard.writeText(shareId);
      setCopiedShareId(true);
      if (shareIdCopyTimer.current) window.clearTimeout(shareIdCopyTimer.current);
      shareIdCopyTimer.current = window.setTimeout(() => setCopiedShareId(false), 1600);
    } catch {
      setError('复制 shareId 失败。');
    }
  };

  const toggleField = (key: string, checked: boolean) => {
    if (!draft) return;
    const meta = catalog.find(c => c.id === draft.templateId);
    const field = meta?.fields.find(f => f.key === key);
    if (!field || field.required) return;
    setDraft(prev => {
      if (!prev) return prev;
      const next = checked
        ? [...new Set([...prev.showFields, key])]
        : prev.showFields.filter(f => f !== key);
      return { ...prev, showFields: next };
    });
  };

  const changeTemplate = (templateId: string) => {
    if (!draft || templateId === draft.templateId) return;
    setDraft(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        templateId,
        showFields: defaultShowFieldsForTemplate(templateId, catalog),
      };
    });
  };

  const saveDraft = () => {
    if (!selected || !draft || !dirty) return;
    const label = draft.label.trim() || null;
    const shareId = selected.shareId;
    void mutate(
      () => updateEmbedCard(shareId, {
        templateId: draft.templateId,
        showFields: draft.showFields,
        label,
      }),
      '已保存',
      (card) => {
        setCards(prev => prev.map(c => (c.shareId === card.shareId ? card : c)));
        setDraft(draftFromCard(card, catalog));
      },
      { refreshMode: 'none' },
    );
  };

  const activeCardDisplayName = selected
    ? (selected.label || selectedMeta?.label || selected.templateId)
    : '';

  return (
    <div className="flex max-h-[calc(100svh-2rem)] flex-col overflow-hidden font-sans text-sm text-foreground">
      {/* Studio Top Bar: Title + Card Switcher + Create + Close */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-popover px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <DialogTitle className="shrink-0 text-base font-semibold text-foreground">
            用量卡片
          </DialogTitle>

          {identity && !loading && cards.length > 0 && selected && (
            <>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  aria-label="切换卡片"
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="h-8 max-w-[210px] gap-2 rounded-lg border-border/80 bg-surface-secondary/70 px-2.5 text-xs font-medium text-foreground shadow-none hover:bg-surface-secondary sm:max-w-[260px]"
                    />
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      selected.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/50',
                    )}
                  />
                  <span className="truncate">{activeCardDisplayName}</span>
                  <IconChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuRadioGroup
                    value={selected.shareId}
                    onValueChange={next => setSelectedId(String(next))}
                  >
                    {cards.map(card => {
                      const meta = catalog.find(c => c.id === card.templateId);
                      const title = card.label || meta?.label || card.templateId;
                      return (
                        <DropdownMenuRadioItem
                          key={card.shareId}
                          value={card.shareId}
                          className="focus:bg-secondary focus:text-secondary-foreground focus:**:text-secondary-foreground data-highlighted:bg-secondary"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                card.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/45',
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-foreground">{title}</div>
                              <div className="truncate font-code text-[10px] text-muted-foreground">
                                {meta?.label ?? card.templateId} · {card.shareId.slice(0, 14)}…
                              </div>
                            </div>
                          </div>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
                {cards.length} / {MAX_CARDS}
                {dirty ? ' · 未保存' : ''}
              </span>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {identity && !loading && (
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1 px-2.5 text-xs"
              disabled={busy || cards.length >= MAX_CARDS}
              onClick={() => {
                setCreateTemplate('classic-light');
                setCreateLabel('');
                setCreateOpen(true);
              }}
            >
              <IconPlus aria-hidden="true" className="size-3.5" />
              <span>新建卡片</span>
            </Button>
          )}
          <DialogClose
            render={<Button type="button" variant="ghost" size="icon-sm" className="size-8" />}
          >
            <IconX aria-hidden="true" className="size-4" />
            <span className="sr-only">关闭</span>
          </DialogClose>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-5 py-2 text-xs text-destructive"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <IconAlertCircle aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{error}</span>
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0 text-destructive hover:bg-destructive/15 hover:text-destructive"
            onClick={() => void refresh()}
          >
            重试
          </Button>
        </div>
      )}

      {!identity ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
          <p className="text-sm text-foreground">登录掘金后即可生成用量卡片</p>
          <Button type="button" size="sm" onClick={() => window.location.assign(JUEJIN_HOME)}>
            登录掘金
          </Button>
        </div>
      ) : loading ? (
        <p role="status" className="py-16 text-center text-sm text-muted-foreground">
          正在读取卡片…
        </p>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
          <h3 className="text-sm font-semibold text-foreground">还没有用量卡片</h3>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            选择模板与展示字段，生成可嵌入 GitHub README 或博客的实时用量卡片。
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              setCreateTemplate('classic-light');
              setCreateLabel('');
              setCreateOpen(true);
            }}
          >
            <IconPlus aria-hidden="true" className="size-3.5" />
            创建第一张卡片
          </Button>
        </div>
      ) : selected && draft && draft.shareId === selected.shareId && templateMeta ? (
        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[296px_minmax(0,1fr)] lg:overflow-hidden [scrollbar-width:thin]">
          {/* Left Column: Clean Flat Controls */}
          <aside className="flex flex-col gap-5 bg-popover p-5 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-border/80 [scrollbar-width:thin]">
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">卡片模板</div>
              <TemplateGrid
                ariaLabel="卡片模板"
                catalog={catalog}
                value={draft.templateId}
                disabled={busy}
                onChange={changeTemplate}
              />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">展示字段</legend>
              <div className="flex flex-wrap gap-1.5">
                {templateMeta.fields.map(field => {
                  const checked = draft.showFields.includes(field.key);
                  const disabled = busy || field.required;
                  return (
                    <button
                      key={field.key}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={disabled}
                      onClick={() => toggleField(field.key, !checked)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        checked
                          ? 'border-primary/45 bg-(--web-primary-soft) font-medium text-primary'
                          : 'border-border/80 bg-surface text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                        disabled && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      {field.required ? (
                        <IconLock aria-hidden="true" className="size-3 shrink-0" />
                      ) : checked ? (
                        <IconCheck aria-hidden="true" className="size-3.5 shrink-0" />
                      ) : null}
                      <span>{fieldLabel(field.key)}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <label htmlFor="embed-card-label" className="block text-xs font-medium text-muted-foreground">
                备注名（仅自己可见）
              </label>
              <Input
                id="embed-card-label"
                name="embed-card-label"
                placeholder="例如：GitHub README"
                className="h-9 bg-surface text-sm shadow-none dark:bg-surface"
                disabled={busy}
                value={draft.label}
                onChange={e => {
                  const value = e.target.value;
                  setDraft(prev => (prev ? { ...prev, label: value } : prev));
                }}
              />
            </div>

            {/* Sticky Bottom Action Row: Primary Save + Secondary More Menu */}
            <div className="mt-auto flex items-center gap-2 border-t border-border/80 pt-4">
              <Button
                type="button"
                className="flex-1"
                disabled={busy || !dirty}
                onClick={saveDraft}
              >
                {busy && dirty && <IconLoader2 aria-hidden="true" className="motion-safe:animate-spin" />}
                {dirty ? '保存更改' : '已保存'}
              </Button>

              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  aria-label="更多操作"
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={busy}
                      className="shrink-0 bg-surface shadow-none dark:bg-surface"
                    />
                  )}
                >
                  <IconDots aria-hidden="true" className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="w-44">
                  <DropdownMenuItem
                    onClick={() => void mutate(
                      () => updateEmbedCard(selected.shareId, { enabled: !selected.enabled }),
                      selected.enabled ? '已停用展示' : '已重新启用',
                    )}
                  >
                    {selected.enabled ? (
                      <IconEyeOff aria-hidden="true" />
                    ) : (
                      <IconEye aria-hidden="true" />
                    )}
                    <span>{selected.enabled ? '停用展示' : '重新启用'}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRotateOpen(true)}>
                    <IconRefresh aria-hidden="true" />
                    <span>重新生成 shareId</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <IconTrash aria-hidden="true" />
                    <span>删除卡片</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </aside>

          {/* Right Column: Live Preview Stage + Embed Code Bar */}
          <div className="flex min-h-0 min-w-0 flex-col gap-4 bg-surface-secondary/45 p-5 lg:overflow-y-auto dark:bg-white/[0.025] [scrollbar-width:thin]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
                  selected.enabled
                    ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted/20 text-muted-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 rounded-full',
                    selected.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/60',
                  )}
                />
                {selected.enabled ? '公开展示中' : '已停用展示'}
              </span>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  title="点击复制 shareId"
                  onClick={() => void copyShareId(selected.shareId)}
                  className="inline-flex max-w-[190px] items-center gap-1.5 rounded-md border border-border/70 bg-surface/80 px-2 py-1 font-code text-[11px] text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
                >
                  <span className="truncate">{selected.shareId}</span>
                  {copiedShareId ? (
                    <IconCheck aria-hidden="true" className="size-3 shrink-0 text-emerald-500" />
                  ) : (
                    <IconCopy aria-hidden="true" className="size-3 shrink-0 opacity-70" />
                  )}
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  title={previewDarkBg ? '切换到浅色预览底色' : '切换到深色预览底色'}
                  aria-label={previewDarkBg ? '切换到浅色预览底色' : '切换到深色预览底色'}
                  className="size-7 bg-surface shadow-none dark:bg-surface"
                  onClick={() => setPreviewDarkBg(v => !v)}
                >
                  {previewDarkBg ? (
                    <IconSun aria-hidden="true" className="size-3.5" />
                  ) : (
                    <IconMoon aria-hidden="true" className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>

            {/* Preview Stage */}
            <section
              aria-label="用量卡片预览"
              className={cn(
                'relative flex min-h-[212px] flex-1 items-center justify-center overflow-hidden rounded-xl border p-5 transition-colors',
                previewDarkBg
                  ? 'border-white/10 bg-[#0d1117]'
                  : 'border-border/80 bg-surface',
              )}
              style={{
                backgroundImage: previewDarkBg
                  ? 'radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)'
                  : 'radial-gradient(color-mix(in srgb, var(--foreground) 9%, transparent) 1px, transparent 1px)',
                backgroundSize: '14px 14px',
              }}
            >
              {previewSvg ? (
                <div
                  key={`${draft.shareId}:${draft.templateId}:${draft.showFields.join(',')}:${avatarLarge}`}
                  className={cn(
                    'flex w-full items-center justify-center [&_svg]:h-auto [&_svg]:max-h-56 [&_svg]:max-w-full',
                    !selected.enabled && 'opacity-65',
                  )}
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              ) : (
                <p role="status" className="text-center text-sm text-muted-foreground">
                  {hasLocalEmbedTemplate(draft.templateId)
                    ? '无法生成本地预览'
                    : '该模板仅服务端有资源，本机无 SVG，无法本地预览'}
                </p>
              )}
            </section>

            {/* Unified Embed Code Box */}
            {snippets && (
              <div className="overflow-hidden rounded-xl border border-border/80 bg-surface">
                <Tabs
                  value={format}
                  onValueChange={value => setFormat(String(value) as EmbedCopyFormat)}
                  className="flex min-w-0 flex-col gap-0"
                >
                  <div className="border-b border-border/80 bg-surface-secondary/60 p-1.5 dark:bg-white/[0.03]">
                    <TabsList
                      aria-label="嵌入格式"
                      className="h-8 w-full overflow-x-auto bg-transparent p-0 [scrollbar-width:none]"
                    >
                      {snippets.formats.map(item => (
                        <TabsTrigger
                          key={item.id}
                          value={item.id}
                          className="h-7 flex-1 rounded-md px-2.5 text-xs whitespace-nowrap"
                        >
                          {item.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </div>

                  {snippets.formats.map(item => {
                    const copied = copiedFormat === item.id;
                    return (
                      <TabsContent key={item.id} value={item.id} className="m-0">
                        <pre
                          role="region"
                          tabIndex={0}
                          aria-label={item.label}
                          className="max-h-28 min-h-[72px] overflow-y-auto whitespace-pre-wrap break-all px-3.5 py-3 font-code text-xs leading-5 select-all text-foreground [scrollbar-width:thin]"
                        >
                          {item.value}
                        </pre>
                        <div className="flex items-center justify-between gap-2 border-t border-border/80 bg-surface-secondary/40 px-3.5 py-2 dark:bg-white/[0.02]">
                          <span className="truncate text-xs text-muted-foreground">
                            {selected.enabled ? '贴到 GitHub README、博客或掘金主页' : '已停用 · 公开链接暂不展示用量'}
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            className="h-7 shrink-0 gap-1.5 px-3 text-xs"
                            onClick={() => void copy(item.id, item.value)}
                          >
                            {copied ? (
                              <IconCheck aria-hidden="true" className="size-3.5" />
                            ) : (
                              <IconCopy aria-hidden="true" className="size-3.5" />
                            )}
                            {copied ? '已复制' : '复制代码'}
                          </Button>
                        </div>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-6 left-1/2 z-60 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background shadow-web-popover"
        >
          <IconCheck aria-hidden="true" className="size-3.5 text-emerald-400" />
          <span>{notice}</span>
        </div>
      )}

      {/* Create Card Sub-Dialog */}
      <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open); }}>
        <DialogContent className="gap-4 p-5 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">新建用量卡片</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <span className="block text-xs font-medium text-muted-foreground">选择模板</span>
              <TemplateGrid
                ariaLabel="选择模板"
                catalog={catalog}
                value={createTemplate}
                disabled={busy}
                onChange={next => setCreateTemplate(next as EmbedStyle)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="embed-create-label" className="block text-xs font-medium text-muted-foreground">
                备注名（可选）
              </label>
              <Input
                id="embed-create-label"
                name="embed-create-label"
                placeholder="例如：GitHub README"
                className="h-9 text-sm"
                disabled={busy}
                value={createLabel}
                onChange={e => setCreateLabel(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void mutate(
                () => createEmbedCard({
                  templateId: createTemplate,
                  label: createLabel.trim() || null,
                  showFields: defaultShowFieldsForTemplate(createTemplate, catalog),
                }),
                '已创建卡片',
                (card) => setSelectedId(card.shareId),
              )}
            >
              {busy && <IconLoader2 aria-hidden="true" className="motion-safe:animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate shareId Confirm Dialog */}
      <Dialog open={rotateOpen} onOpenChange={open => { if (!busy) setRotateOpen(open); }}>
        <DialogContent className="gap-4 p-5 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">重新生成 shareId？</DialogTitle>
            <DialogDescription>
              旧链接会立即失效。生成后请重新复制并更新已嵌入的页面。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setRotateOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90"
              disabled={busy || !selected}
              onClick={() => selected && void mutate(
                () => updateEmbedCard(selected.shareId, { regenerate: true }),
                '已生成新 shareId',
                (card) => setSelectedId(card.shareId),
              )}
            >
              {busy && <IconLoader2 aria-hidden="true" className="motion-safe:animate-spin" />}
              重新生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteOpen} onOpenChange={open => { if (!busy) setDeleteOpen(open); }}>
        <DialogContent className="gap-4 p-5 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">删除这张卡片？</DialogTitle>
            <DialogDescription>
              删除后公开链接失效，且不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive dark:hover:bg-destructive/90"
              disabled={busy || !selected}
              onClick={() => selected && void mutate(
                () => deleteEmbedCard(selected.shareId),
                '已删除卡片',
              )}
            >
              {busy && <IconLoader2 aria-hidden="true" className="motion-safe:animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Dedicated Web modal for embeddable usage cards using shadcn/ui + Base UI primitives. */
export function EmbedUsageModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="用量卡片"
        showCloseButton={false}
        className="flex max-h-[calc(100svh-2rem)] w-[calc(100%-1.5rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[540px] lg:max-w-[880px]"
      >
        {isOpen ? <EmbedUsageBody /> : null}
      </DialogContent>
    </Dialog>
  );
}
