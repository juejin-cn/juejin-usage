import { canConvertProtocol } from './protocol/index.js';
import { SessionAffinity } from './affinity.js';
import { effectiveGroups } from './groups.js';
import { exposedModels, RouterError, type AgentRouterConfig, type RouterProvider, type Protocol } from './config.js';
import { verifiedFailureCode } from './failure-codes.js';

export type FailureKind = 'rate-limit' | 'unavailable' | 'authentication' | 'request' | 'transport' | 'first-response' | 'cancelled' | 'admission';
export class AttemptFailure extends RouterError {
  constructor(code: string, status: number, readonly kind: FailureKind, readonly retryable: boolean, retryAfterMs?: number) { super(code, status, retryAfterMs); }
}
export function responseFailure(status: number, retryAfter?: string | null, now = Date.now(), diagnostic?: unknown): AttemptFailure {
  const code = verifiedFailureCode(diagnostic, status) ?? `UPSTREAM_HTTP_${status}`;
  if (status === 401) return new AttemptFailure(code, status, 'authentication', false);
  if (status === 429) {
    const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
    const date = retryAfter ? Date.parse(retryAfter) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 30000;
    return new AttemptFailure(code, status, 'rate-limit', true, Math.max(1000, Math.min(300000, delay)));
  }
  if ([500, 502, 503, 504].includes(status)) return new AttemptFailure(code, status, 'unavailable', true);
  return new AttemptFailure(code, status >= 400 && status <= 599 ? status : 502, 'request', false);
}
interface Health { failures: number; until: number; probing: boolean; kind: FailureKind }
export interface CandidateDecision { target: string; eligible: boolean; reason: string; retryAt?: number }
export interface RouteCandidate { provider: RouterProvider; model: string; target: string; generation: string }
export interface RoutePlan { affinity: boolean; strategy: string; candidates: RouteCandidate[]; decisions: CandidateDecision[] }

/** Runtime-only health. Identity is a provider entry/model, never a raw key or token. */
export class RoutingState {
  private models = new Map<string, Health>();
  private blocked = new Set<string>();
  private turns = new Map<string, number>();
  private revision = 0;
  private generations = new Map<string, number>();
  private affinity: SessionAffinity;
  constructor(private now = Date.now) { this.affinity = new SessionAffinity(now); }
  clear(): void { this.affinity.clear(); this.revision++; this.models.clear(); this.blocked.clear(); this.turns.clear(); this.generations.clear(); }
  private generation(providerId: string): string { return `${this.revision}:${this.generations.get(providerId) ?? 0}`; }
  reset(providerId: string): void { this.affinity.reset(providerId); this.generations.set(providerId, (this.generations.get(providerId) ?? 0) + 1); this.blocked.delete(providerId); for (const key of this.models.keys()) if (key.startsWith(providerId + '/')) this.models.delete(key); }
  health(providerId: string, model: string): { reason: string; retryAt?: number } {
    if (this.blocked.has(providerId)) return { reason: 'authentication' };
    const state = this.models.get(`${providerId}/${model}`);
    if (state?.probing) return { reason: 'probe-inflight' };
    if (state && state.until > this.now()) return { reason: 'cooldown', retryAt: state.until };
    return { reason: state ? 'recovery-probe' : 'ready' };
  }
  enter(candidate: RouteCandidate): boolean {
    if (candidate.generation !== this.generation(candidate.provider.id)) return false;
    const status = this.health(candidate.provider.id, candidate.model);
    if (!['ready', 'recovery-probe'].includes(status.reason)) return false;
    const state = this.models.get(candidate.target); if (state) state.probing = true;
    return true;
  }
  leave(candidate: RouteCandidate): void { if (candidate.generation !== this.generation(candidate.provider.id)) return; const state = this.models.get(candidate.target); if (state) state.probing = false; }
  success(candidate: RouteCandidate): void { if (candidate.generation === this.generation(candidate.provider.id)) this.models.delete(candidate.target); }
  failure(candidate: RouteCandidate, failure: AttemptFailure): void {
    if (candidate.generation !== this.generation(candidate.provider.id)) return;
    if (failure.kind === 'authentication') { this.blocked.add(candidate.provider.id); return; }
    if (!['rate-limit', 'unavailable', 'transport', 'first-response'].includes(failure.kind)) return;
    const failures = Math.min(8, (this.models.get(candidate.target)?.failures ?? 0) + 1);
    const delay = failure.retryAfterMs ?? Math.min(120000, 30000 * 2 ** (failures - 1));
    this.models.set(candidate.target, { failures, until: this.now() + delay, probing: false, kind: failure.kind });
  }
  snapshot() { return { blocked: [...this.blocked], models: [...this.models].map(([target, value]) => ({ target, ...value })) }; }
  remember(candidate: RouteCandidate, route: string, session?: string, protocol: Protocol = candidate.provider.protocol): void {
    if (session && candidate.generation === this.generation(candidate.provider.id)) this.affinity.remember(route, protocol, session, candidate.target);
  }
  plan(config: AgentRouterConfig, model: string, protocol: Protocol, ready: (p: RouterProvider) => boolean, session?: string): RoutePlan {
    const group = effectiveGroups(config).find(g => `auto/${g.id}` === model);
    const ids = group ? [...group.members] : [model]; const strategy = group?.strategy ?? 'ordered';
    if (strategy === 'round-robin' && group) {
      const offset = this.turns.get(group.id) ?? 0; this.turns.set(group.id, (offset + 1) % ids.length);
      ids.push(...ids.splice(0, offset % ids.length));
    }
    const pinned = config.sessionAffinity && group && session ? this.affinity.get(model, protocol, session) : undefined;
    const pinnedIndex = pinned ? ids.indexOf(pinned) : -1;
    if (pinnedIndex > 0) ids.unshift(...ids.splice(pinnedIndex, 1));
    const candidates: RouteCandidate[] = []; const decisions: CandidateDecision[] = [];
    for (const target of ids) {
      const provider = config.providers.find(p => exposedModels(p).some(m => `${p.id}/${m}` === target));
      const native = provider ? target.slice(provider.id.length + 1) : '';
      const health = provider ? this.health(provider.id, native) : { reason: 'unknown-model' };
      const reason = !provider ? 'unknown-model' : !provider.enabled ? 'disabled' : !canConvertProtocol(protocol, provider.protocol) ? 'protocol' : !ready(provider) ? 'credential' : health.reason;
      const eligible = ['ready', 'recovery-probe'].includes(reason);
      decisions.push({ target: provider ? target : '(unconfigured)', eligible, reason, ...(health.retryAt ? { retryAt: health.retryAt } : {}) });
      if (eligible && provider) candidates.push({ provider, model: native, target, generation: this.generation(provider.id) });
    }
    for (const decision of decisions.filter(d => d.eligible).slice(3)) { decision.eligible = false; decision.reason = 'attempt-limit'; }
    return { affinity: !!pinned && candidates[0]?.target === pinned, strategy, candidates: candidates.slice(0, 3), decisions };
  }
}
