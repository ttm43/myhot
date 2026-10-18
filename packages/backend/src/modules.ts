// The backend's sockets for modules (modules/<name>/server.ts). The api and worker processes install the
// site's list when they start (site/modules/server.ts); the engine reads the sockets when it needs them and
// never imports a module, so it runs the same with none installed: the open-source edition, and the
// engine's own tests. Each socket names the engine file that reads it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkOptions } from "pg-boss";
import type { Db } from "./db.ts";
import type { QueueOptions } from "./jobs/queue.ts";

/** A cron schedule (Asia/Shanghai), recorded in job_runs like the engine's (apps/worker/src/schedules.ts). */
export interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  /** Read when the worker starts, after the modules are installed: false removes the schedule and its execution queue; run history remains. */
  when?: () => boolean;
}

/** A model step (editorial/models.ts); its default model comes from site/models.ts, else `default`. */
export interface ModelStep {
  label: string;
  env: string;
  /** Receipt purposes it produces (for the admin statistics). */
  purposes: string[];
  /** The step needs a model that reads images. */
  vision?: boolean;
}

/**
 * A job queue of its own, beside the engine's (jobs/queue.ts): created with its options on first use, worked
 * by the worker (workModuleQueues), and filled with `enqueueOn`, which types the data by the queue.
 */
export interface ModuleQueue<T = never> {
  /** "<module>.<what>". */
  name: string;
  /** Policy, retries and expiry (pg-boss createQueue). */
  options: QueueOptions;
  /** How the worker takes its jobs (pg-boss work). */
  worker: WorkOptions;
  /** All jobs taken together (batchSize); a failure retries the whole batch. */
  run: (data: T[]) => Promise<unknown>;
}

export function defineQueue<T>(queue: ModuleQueue<T>): ModuleQueue<T> {
  return queue;
}

/**
 * What happened in the engine, for modules that act on it (`emit` below). A handler runs in the process
 * that made the change and, given one, inside its transaction.
 */
export interface EngineHooks {
  /**
   * An article's public content changed; a former event is included when its membership moved.
   * `reduced`: something public is now shown less, as publication judged it (`PublishResult`).
   */
  articleChanged: (change: { id: string; kind: "detail" | "body" | "content"; reduced?: boolean; reason: string; previousStoryIds?: number[] }, tx: Db) => Promise<void>;
  /** A source's articles were published again after changing its public metadata or permissions. */
  sourceRepublished: (change: { sourceId: string }) => Promise<void>;
  /** The api answered a request. Never awaited and must not throw. */
  requestAnswered: (req: FastifyRequest, reply: FastifyReply, path: string) => void;
  /**
   * A public exit took a client's request: "mcp" (routes/mcp.ts, past its host and origin checks) or a
   * module's own. Never awaited and must not throw.
   */
  exitServed: (exit: string, req: FastifyRequest) => void;
}

export interface ServerModule {
  /** Its folder under modules/. */
  name: string;
  /** Sources whose selected articles keep independent cards/seats without changing admission or event identity (publication/rules.ts, scope.ts). */
  independentSelectedSources?: readonly string[];
  /** Its HTTP routes, and hooks on the app such as what to flush when it closes, registered after the engine's routes (apps/api/src/app.ts). */
  http?: (app: FastifyInstance) => void;
  admin?: {
    /** Current jobs scheduled outside the worker, by their job_runs name (admin/runs.ts). */
    currentJobs?: () => Promise<readonly string[]>;
    /** Badges on the admin navigation, by the key its web items name (admin/navigation.ts). */
    counts?: Record<string, () => Promise<number>>;
    /** Its part of the admin's runs page, under its name (admin/runs.ts); its web module draws it. */
    runs?: () => Promise<unknown>;
  };
  models?: Record<string, ModelStep>;
  /** Cron schedules (the worker). */
  schedules?: Scheduled[];
  /** Its share of the daily retention run (operations/retention.ts): what it deleted or aggregated. */
  retention?: (now: Date) => Promise<Record<string, unknown>>;
  on?: Partial<EngineHooks>;
  /**
   * Source kinds it collects in its own way (admin/sources.ts), by kind: `resumed` runs in the transaction
   * that enables a paused source of that kind, before its row is written; `fetchNow` takes over the admin's
   * manual fetch, and what it returns is recorded in the audit trail.
   */
  sourceKinds?: Record<string, {
    resumed?: (sourceId: string, tx: Db) => Promise<void>;
    fetchNow?: (source: { id: string; config: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  }>;
  /** Job queues of its own (jobs/queue.ts). */
  queues?: ModuleQueue[];
  /** Further hosts the site answers on, over https: MCP accepts them as Host and as a browser's Origin (routes/mcp.ts). */
  hosts?: string[];
}

export function defineServerModule(module: ServerModule): ServerModule {
  return module;
}

let installed: readonly ServerModule[] = [];

/** Called once by each process's entry point, and by a module's tests for that module. */
export function installModules(modules: readonly ServerModule[]): void {
  installed = modules;
}

export function serverModules(): readonly ServerModule[] {
  return installed;
}

/** Tells every installed module that handles it, one after another. */
export async function emit<K extends Exclude<keyof EngineHooks, "requestAnswered" | "exitServed">>(hook: K, ...args: Parameters<EngineHooks[K]>): Promise<void> {
  for (const m of installed) {
    const handler = m.on?.[hook] as ((...a: Parameters<EngineHooks[K]>) => Promise<void>) | undefined;
    if (handler) await handler(...args);
  }
}
