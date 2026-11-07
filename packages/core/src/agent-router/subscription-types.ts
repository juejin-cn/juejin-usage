import type { MessagePort } from 'node:worker_threads';
import type { SubscriptionId, SubscriptionMethod } from './presets.js';
import type { Protocol } from './config.js';
import type { ModelMetadata } from './model-metadata.js';

export interface SubscriptionState { phase: 'signed-out' | 'authorizing' | 'ready' | 'error'; error: string | null; authType?: 'oauth' | 'api' }
export interface SubscriptionWorkerData { provider: SubscriptionId; method: SubscriptionMethod; protocol: Protocol; secret?: string; auth?: SubscriptionAuth; persist?: boolean }
export interface LoginPrompt { key: string; type: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string; hint?: string }> }
export interface LoginMethod { index: number; type: 'oauth' | 'api'; label: string; prompts: LoginPrompt[] }
export interface LoginOptions { methodIndex?: number; inputs?: Record<string, string> }
export interface LoginResult { url: string; instructions?: string; opened?: boolean; method?: 'auto' | 'code'; completed?: boolean }
export interface SubscriptionCommand extends LoginOptions {
  id: string; kind: 'login' | 'methods' | 'complete' | 'models' | 'usage' | 'request'; code?: string;
  body?: Record<string, unknown>; features?: Record<string, string>; session?: string; fallback?: boolean; port?: MessagePort;
}
export type SubscriptionAuth = Record<string, unknown>;
export type SubscriptionModel = ModelMetadata;
/** Internal channels are statically linked; no external modules or lifecycle hooks. */
export interface SubscriptionChannel {
  models(auth: SubscriptionAuth): Promise<Record<string, SubscriptionModel>>;
  auth: {
    account?: (getAuth: () => Promise<SubscriptionAuth>) => Promise<{ accountName?: string; accountId?: string; email?: string; plan?: string }>;
    refreshLead?: number;
    refresh?: (auth: SubscriptionAuth) => Promise<SubscriptionAuth | undefined>;
    usage?: (getAuth: () => Promise<SubscriptionAuth>) => Promise<unknown>;
    transport(getAuth: () => Promise<SubscriptionAuth>): Promise<{ fetch?: typeof fetch; baseURL?: string; apiKey?: string; headers?: Record<string, string> }>;
    methods: Array<{ type?: string; label?: string; prompts?: Array<LoginPrompt & { condition?: (inputs: Record<string, string>) => boolean; validate?: (value: string) => string | undefined }>; authorize?: (inputs?: Record<string, string>) => Promise<LoginFlow | Record<string, unknown>> | LoginFlow | Record<string, unknown> }>;
  };
}
export interface LoginFlow { url?: string; instructions?: string; opened?: boolean; method?: 'auto' | 'code'; callback(code?: string): Promise<Record<string, unknown>> }
