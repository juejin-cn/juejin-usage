import type { ModelCatalog, RouterProvider } from '@juejin-opensource/jusage-core/agent-router';

/** Account and connection scoped. Refreshes never block tray interaction. */
export class IntegrationModelCatalogs {
  private entries = new Map<string, { catalog?: ModelCatalog; retryAt: number; pending?: Promise<void> }>();
  constructor(private fetchCatalog: (provider: RouterProvider) => Promise<ModelCatalog>, private now = Date.now) {}
  private key(provider: RouterProvider) {
    return JSON.stringify([provider.id, provider.preset, provider.baseUrl, provider.protocol, provider.auth]);
  }
  get(provider: RouterProvider): ModelCatalog | undefined { return this.entries.get(this.key(provider))?.catalog; }
  remember(provider: RouterProvider, catalog: ModelCatalog): void {
    this.entries.set(this.key(provider), { catalog, retryAt: this.now() + 5 * 60_000 });
  }
  clear(): void { this.entries.clear(); }
  refresh(providers: RouterProvider[]): Promise<void> {
    const keys = new Set(providers.map(provider => this.key(provider)));
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
    return Promise.all(providers.map(provider => {
      const key = this.key(provider);
      let entry = this.entries.get(key);
      if (entry?.pending) return entry.pending;
      if (entry && entry.retryAt > this.now()) return Promise.resolve();
      if (!entry) { entry = { retryAt: 0 }; this.entries.set(key, entry); }
      const current = entry;
      current.pending = this.fetchCatalog(provider).then(catalog => {
        current.catalog = catalog; current.retryAt = this.now() + 5 * 60_000;
      }).catch(() => { current.retryAt = this.now() + 60_000; }).finally(() => { current.pending = undefined; });
      return current.pending;
    })).then(() => {});
  }
}
