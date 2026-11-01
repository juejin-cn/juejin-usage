import { RouterError, type QueueLimits } from './config.js';

interface Waiter { grant(): void; reject(error: Error): void }
/** Slots cover the entire response, including SSE. Each queued waiter owns cleanup. */
export class AdmissionQueue {
  private busy = 0;
  private queue: Waiter[] = [];
  private closed = false;
  constructor(readonly limits: QueueLimits) {}
  status() { return { active: this.busy, queued: this.queue.length, ...this.limits }; }
  acquire(signal: AbortSignal, onQueued?: () => void): Promise<{ release(): void; queuedMs: number }> {
    if (signal.aborted) return Promise.reject(new RouterError('REQUEST_CANCELLED', 499));
    if (this.closed) return Promise.reject(new RouterError('GATEWAY_DRAINING', 503));
    if (this.busy < this.limits.maxConcurrent && !this.queue.length) { this.busy++; return Promise.resolve({ release: this.releaser(), queuedMs: 0 }); }
    if (this.queue.length >= this.limits.maxQueued) return Promise.reject(new RouterError('QUEUE_FULL', 429));
    onQueued?.(); const began = Date.now();
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); };
      const cancel = () => waiter.reject(new RouterError('REQUEST_CANCELLED', 499));
      const waiter: Waiter = {
        grant: () => { clean(); if (signal.aborted) { reject(new RouterError('REQUEST_CANCELLED', 499)); return; } this.busy++; resolve({ release: this.releaser(), queuedMs: Date.now() - began }); },
        reject: error => { clean(); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new RouterError('QUEUE_TIMEOUT', 429)), this.limits.queueTimeoutMs); timer.unref();
      this.queue.push(waiter);
      if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private releaser(): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.busy--;
      while (!this.closed && this.busy < this.limits.maxConcurrent && this.queue.length) this.queue[0].grant();
    };
  }
  close(): void { this.closed = true; for (const waiter of [...this.queue]) waiter.reject(new RouterError('GATEWAY_DRAINING', 503)); }
}
