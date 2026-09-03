import type { SyncResult } from '@juejin-opensource/jusage-core';

export type SyncWorkerRequest =
  | { type: 'init'; dataDir: string }
  | { type: 'runSync'; id: number; reason: string; source?: string }
  | { type: 'stop' };

export type SyncWorkerResponse =
  | { type: 'ready'; pid?: number }
  | { type: 'syncDone'; id: number; results: SyncResult[] }
  | { type: 'syncError'; id: number; error: string };
