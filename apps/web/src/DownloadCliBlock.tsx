import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@web/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@web/components/ui/tabs';

const copyIcon = 'absolute size-[15px] motion-safe:transition-[opacity,scale,filter] motion-safe:duration-200';

const PKG = '@juejin-opensource/jusage';

type PackageManagerId = 'npm' | 'yarn' | 'pnpm' | 'bun';

const PACKAGE_MANAGERS: readonly { id: PackageManagerId; code: string }[] = [
  {
    id: 'npm',
    code: `npm i -g ${PKG}\njusage service start`,
  },
  {
    id: 'yarn',
    code: `yarn global add ${PKG}\njusage service start`,
  },
  {
    id: 'pnpm',
    code: `pnpm add -g ${PKG}\njusage service start`,
  },
  {
    id: 'bun',
    code: `bun add -g ${PKG}\njusage service start`,
  },
] as const;

type Kind = 'com' | 'str' | 'kw' | 'fn' | 'var';
const tokenColor: Record<Kind, string> = {
  com: 'text-(--ui-codec-com)',
  str: 'text-(--ui-codec-str)',
  kw: 'text-(--ui-codec-kw)',
  fn: 'text-(--ui-codec-fn)',
  var: 'text-(--ui-codec-var)',
};
type Token = [Kind | null, string];

const BASH_RULES: readonly [Kind, string][] = [
  ['com', `(?<![^\\s;|&(])#[^\\n]*`],
  ['str', `"(?:[^"\\\\]|\\\\[\\s\\S])*"?|'[^']*'?`],
  ['var', `\\$\\{[^}\\n]*\\}?|\\$[A-Za-z_]\\w*|\\$[0-9@#?*$!-]`],
  [
    'kw',
    `\\b(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|export|local|readonly|unset|exit)\\b`,
  ],
  ['fn', `(?<=^[ \\t]*|[|;&(][ \\t]*)[A-Za-z_.\\/~][\\w.\\/~+-]*(?![\\w=])`],
];

const BASH_RE = new RegExp(BASH_RULES.map(([, p]) => `(${p})`).join('|'), 'gm');
const BASH_KINDS: Kind[] = BASH_RULES.map(([k]) => k);

function tokenizeBash(text: string): Token[][] {
  if (!text) return [[]];
  BASH_RE.lastIndex = 0;
  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BASH_RE.exec(text))) {
    if (!m[0]) {
      BASH_RE.lastIndex++;
      continue;
    }
    if (m.index > last) tokens.push([null, text.slice(last, m.index)]);
    const group = m.findIndex((g, i) => i > 0 && g !== undefined);
    tokens.push([BASH_KINDS[group - 1] ?? null, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push([null, text.slice(last)]);

  const lines: Token[][] = [[]];
  for (const [kind, chunk] of tokens) {
    chunk.split('\n').forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines[lines.length - 1].push([kind, part]);
    });
  }
  return lines;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function DownloadCliBlock() {
  const [manager, setManager] = useState<PackageManagerId>('npm');
  const [copied, setCopied] = useState(false);
  const [scrolls, setScrolls] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const active =
    PACKAGE_MANAGERS.find((item) => item.id === manager) ?? PACKAGE_MANAGERS[0];
  const lines = useMemo(() => tokenizeBash(active.code), [active.code]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () =>
      setScrolls(
        el.scrollWidth > el.clientWidth + 1 ||
          el.scrollHeight > el.clientHeight + 1,
      );
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [active.code]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  const handleCopy = () => {
    void copyText(active.code).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  return (
    <div className="w-[26rem] max-w-full px-px pt-4 pb-px">
      <Tabs
        onValueChange={(value) => {
          setManager(value as PackageManagerId);
          setCopied(false);
        }}
        value={manager}
      >
        <figure className="ui-codec relative m-0 flex min-w-0 max-w-[540px] flex-col overflow-hidden rounded-[6px] border border-(--ui-codec-line) bg-(--ui-codec-bg) text-(--ui-codec-ink) antialiased">
          <figcaption className="relative flex h-10 flex-none items-stretch justify-between gap-2 border-b border-(--ui-codec-line) pr-2 pl-1.5">
            <TabsList variant="line" aria-label="选择包管理器" className="relative flex h-full min-w-0 items-stretch gap-0.5 p-0 group-data-[orientation=horizontal]/tabs:h-full [&_[data-slot=tabs-indicator]]:-bottom-px">
              {PACKAGE_MANAGERS.map((item) => (
                <TabsTrigger key={item.id} className="h-full px-2 py-0 focus-visible:-outline-offset-2" value={item.id}>
                  {item.id}
                </TabsTrigger>
              ))}
            </TabsList>

            <Button variant="ghost"
              aria-label={copied ? '已复制' : '复制命令'}
              className="group relative grid size-6 flex-none self-center cursor-pointer place-items-center rounded-md bg-transparent p-0 text-(--ui-codec-icon) active:bg-(--ui-codec-wash) hover:bg-(--ui-codec-wash) hover:text-(--ui-codec-ink) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-codec-focus) data-copied:text-(--ui-codec-ink) motion-safe:transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5"
              data-copied={copied || undefined}
              onClick={handleCopy}
              title={copied ? '已复制' : '复制命令'}
              type="button"
            >
              <IconCopy aria-hidden="true"
                className={`${copyIcon} group-data-copied:scale-60 group-data-copied:opacity-0 group-data-copied:blur-[2px]`}
              />
              <IconCheck aria-hidden="true"
                className={`${copyIcon} scale-60 opacity-0 blur-[2px] group-data-copied:scale-100 group-data-copied:opacity-100 group-data-copied:blur-none`}
              />
            </Button>
          </figcaption>

          <span className="sr-only" role="status">
            {copied ? '已复制' : ''}
          </span>

          <TabsContent className="outline-none" value={active.id}>
            <div
              ref={scroller}
              aria-label={scrolls ? `${active.id} 命令` : undefined}
              className="relative min-h-0 min-w-0 flex-auto overflow-auto overscroll-x-contain [scrollbar-width:thin] [scrollbar-color:var(--ui-codec-scroll)_transparent] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-codec-focus)"
              role={scrolls ? 'region' : undefined}
              tabIndex={scrolls ? 0 : undefined}
            >
              <pre className="m-0 py-3 text-left font-code text-[14px] leading-[1.6] text-(--ui-codec-ink) [tab-size:2]" dir="ltr">
                <code className="block w-max min-w-full [font:inherit]">
                  {lines.map((line, i) => (
                    <span key={i} className="flex min-h-[1.6em] px-3.5">
                      <span className="flex-[1_0_auto] whitespace-pre">
                        {line.map(([kind, text], j) =>
                          kind ? (
                            <span key={j} className={tokenColor[kind]}>
                              {text}
                            </span>
                          ) : (
                            text
                          ),
                        )}
                      </span>
                    </span>
                  ))}
                </code>
              </pre>
            </div>
          </TabsContent>
        </figure>
      </Tabs>
    </div>
  );
}
