import { createHash } from 'node:crypto';

/** Bounded runtime-only preferences; raw session IDs never enter snapshots or keys. */
export class SessionAffinity {
  private entries = new Map<string, { target: string; expires: number }>();
  constructor(private now = Date.now) {}
  private key(route: string, protocol: string, session: string): string {
    return createHash('sha256').update(JSON.stringify([route, protocol, session])).digest('hex');
  }
  get(route: string, protocol: string, session: string): string | undefined {
    const key = this.key(route, protocol, session); const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) { this.entries.delete(key); return; }
    return entry.target;
  }
  remember(route: string, protocol: string, session: string, target: string): void {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(key);
    const key = this.key(route, protocol, session); this.entries.delete(key);
    this.entries.set(key, { target, expires: this.now() + 30 * 60_000 });
    while (this.entries.size > 1024) this.entries.delete(this.entries.keys().next().value!);
  }
  reset(providerId: string): void { for (const [key, entry] of this.entries) if (entry.target.startsWith(providerId + '/')) this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}
