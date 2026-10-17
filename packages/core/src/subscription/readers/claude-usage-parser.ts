import type { ClaudeRateLimitWindow } from '../shared/claude-subscription.js';

const HOUR_MS = 3_600_000;
const MONTH_NAMES = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const ACCOUNT_ERRORS = [
  'unauthorized', 'forbidden', 'signed out', 'not signed in', 'not logged in',
  'sign-in expired', 'sign-in has expired', 'authentication failed',
  'authentication required', 'invalid token', 'invalid access token',
  'session limit', 'usage limit', 'hit your limit', 'using your overages',
];

function refused(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(?:401|403)\b/.test(lower) || ACCOUNT_ERRORS.some(message => lower.includes(message));
}

function calendarFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
  });
}

function calendarStamp(formatter: Intl.DateTimeFormat, instant: number): number {
  const fields = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day),
    Number(fields.hour), Number(fields.minute), Number(fields.second));
}

/** Find real instants for a provider's local clock, including both DST-fold offsets. */
function resolveClock(formatter: Intl.DateTimeFormat, clock: number): number[] {
  const found = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = clock + hours * HOUR_MS;
    const offset = calendarStamp(formatter, probe) - probe;
    const instant = clock - offset;
    if (calendarStamp(formatter, instant) === clock) found.add(instant);
  }
  return [...found];
}

export function parseClaudeResetTime(input: string, now: Date, spanHours: number): number | null {
  if (!Number.isFinite(now.getTime())) return null;
  let text = input.trim();
  let formatter = calendarFormatter(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const zoneStart = text.lastIndexOf('(');
  if (zoneStart >= 0 && text.endsWith(')')) {
    try { formatter = calendarFormatter(text.slice(zoneStart + 1, -1)); }
    catch { /* Keep the system zone when the provider names an unknown zone. */ }
    text = text.slice(0, zoneStart).trim();
  }

  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const hour24 = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
  const dateText = text.slice(0, clock.index).replace(/(?:\s+at|,)\s*$/, '').trim();
  const localToday = new Date(calendarStamp(formatter, now.getTime()));
  const candidates: number[] = [];
  let explicitYear = false;

  if (dateText) {
    const date = /^(\w{3})\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(dateText);
    if (!date) return null;
    const month = MONTH_NAMES.indexOf(date[1].toLowerCase());
    const day = Number(date[2]);
    if (month < 0 || day < 1) return null;
    explicitYear = Boolean(date[3]);
    const year = localToday.getUTCFullYear();
    for (const candidateYear of explicitYear ? [Number(date[3])] : [year - 1, year, year + 1]) {
      const stamp = Date.UTC(candidateYear, month, day, hour24, minute);
      const calendar = new Date(stamp);
      if (calendar.getUTCMonth() === month && calendar.getUTCDate() === day) {
        candidates.push(...resolveClock(formatter, stamp));
      }
    }
  } else {
    for (let dayOffset = -2; dayOffset <= 2; dayOffset++) {
      candidates.push(...resolveClock(formatter, Date.UTC(localToday.getUTCFullYear(),
        localToday.getUTCMonth(), localToday.getUTCDate() + dayOffset, hour24, minute)));
    }
  }

  candidates.sort((left, right) => left - right);
  const reference = now.getTime();
  const horizon = reference + (spanHours + 2) * HOUR_MS;
  const upcoming = candidates.find(instant => instant >= reference && instant <= horizon);
  const recentDate = dateText ? candidates.find(instant => instant >= reference - 24 * HOUR_MS && instant <= horizon) : undefined;
  const previous = candidates.filter(instant => instant < reference).at(-1);
  const chosen = explicitYear ? candidates[0] : upcoming ?? recentDate ?? previous;
  return chosen === undefined ? null : Math.floor(chosen / 1000);
}

export function parseClaudeUsageResult(output: string, now = new Date()): {
  fiveHour: ClaudeRateLimitWindow | null;
  sevenDay: ClaudeRateLimitWindow | null;
  denied: boolean;
  isError: boolean;
} {
  const empty = { fiveHour: null, sevenDay: null, denied: false, isError: true };
  let decoded: unknown;
  try { decoded = JSON.parse(output); }
  catch { return { ...empty, denied: refused(output) }; }
  if (Array.isArray(decoded)) {
    decoded = decoded.filter(item => item && typeof item === 'object' && item.type === 'result').at(-1);
  }
  if (!decoded || typeof decoded !== 'object') return empty;
  const envelope = decoded as Record<string, unknown>;
  if (typeof envelope.result !== 'string') return empty;
  const text = envelope.result.replace(/\u001b\[[\d;?]*[A-Za-z]/g, '');
  const denied = refused(text);
  const windows = new Map<string, ClaudeRateLimitWindow>();

  if (!denied) {
    for (const line of text.split('\n')) {
      const separator = line.indexOf(':');
      const label = line.slice(0, separator).trim();
      if (separator < 0 || !['Current session', 'Current week', 'Current week (all models)'].includes(label)) continue;
      const fragments = line.slice(separator + 1).split('·').map(fragment => fragment.trim());
      const percent = /^(\d+(?:\.\d+)?)%\s+used$/.exec(fragments[0]);
      if (!percent) continue;
      const value = Number(percent[1]);
      if (!Number.isFinite(value)) continue;
      const session = label === 'Current session';
      const key = session ? 'fiveHour' : 'sevenDay';
      if (windows.has(key)) continue;
      const reset = fragments.find(fragment => fragment.startsWith('resets '));
      windows.set(key, {
        usedPercent: Math.max(0, Math.min(100, value)),
        resetsAt: reset ? parseClaudeResetTime(reset.slice(7), now, session ? 5 : 168) : null,
      });
    }
  }
  return {
    fiveHour: windows.get('fiveHour') ?? null,
    sevenDay: windows.get('sevenDay') ?? null,
    denied,
    isError: envelope.is_error === true,
  };
}
