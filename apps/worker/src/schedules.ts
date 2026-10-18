// Cron-style schedules (Asia/Shanghai), the engine's and then the site's modules'. Each run is recorded in
// job_runs; missed slots run once.
import type { PgBoss } from "pg-boss";
import { ensureQueue, recordRun } from "@aihot/backend/jobs/queue";
import { serverModules, type Scheduled } from "@aihot/backend/modules";
import { sweepUnprocessed } from "@aihot/backend/jobs/content";
import { translatePending } from "@aihot/backend/editorial/translate";
import { adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { refreshSourceIcons } from "@aihot/backend/sources/icons";
import { dailyRetention } from "@aihot/backend/operations/retention";
import { recoverStaleWork } from "@aihot/backend/operations/recover";

const collecting = process.env.COLLECT_ENABLED === "true";

const ENGINE_SCHEDULES: Scheduled[] = [
  { name: "content.sweep", cron: "*/5 * * * *", run: sweepUnprocessed },
  // Full-text translations of newly selected items (model calls; off with MODEL_CALLS_ENABLED=false).
  { name: "content.translate", cron: "*/5 * * * *", run: () => translatePending() },
  // Old run history and derived caches.
  { name: "ops.retention", cron: "30 3 * * *", missed: "once", run: () => dailyRetention() },
  // Work a stopped process left half way becomes visible, and unknown paid requests get their one
  // automatic release.
  { name: "ops.recover", cron: "*/10 * * * *", run: () => recoverStaleWork() },
  ...(collecting
    ? [
        { name: "sources.schedule", cron: "* * * * *", run: () => scheduleDueSources() },
        { name: "sources.adapt-intervals", cron: "20 4 * * *", run: adaptIntervals },
        // Icons are read from the sources' own sites, so they stop with collection.
        { name: "sources.icons", cron: "40 4 * * *", missed: "once" as const, run: () => refreshSourceIcons() },
      ]
    : []),
];

export async function registerSchedules(boss: PgBoss) {
  const schedules = [...ENGINE_SCHEDULES, ...serverModules().flatMap((m) => m.schedules ?? [])].filter((s) => s.when?.() ?? true);
  for (const s of schedules) {
    const queue = `cron.${s.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 1, expireInSeconds: 3600 });
    await boss.schedule(queue, s.cron, {}, { tz: "Asia/Shanghai", missed: s.missed ?? "skip" });
    // Schedules fire at minute boundaries; a 15 s pickup keeps them on time with a third of the polling.
    await boss.work(queue, { pollingIntervalSeconds: 15 }, async () => recordRun(s.name, s.run));
  }
  // Retired or disabled timers must leave no queued work behind, including queues an earlier release
  // already unscheduled. pg-boss deletes the queue's jobs and schedules; job_runs retains its audit.
  const current = new Set(schedules.map((s) => `cron.${s.name}`));
  for (const old of await boss.getQueues()) {
    if (old.name.startsWith("cron.") && !current.has(old.name)) await boss.deleteQueue(old.name);
  }
}
