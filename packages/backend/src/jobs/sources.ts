// Collection jobs: per-source fetch runs and body extraction before analysis.
import type { PgBoss } from "pg-boss";
import { collectSource } from "../sources/collect.ts";
import { QUEUES, work } from "./queue.ts";
import { registerExtractionJobs } from "./content.ts";

export async function registerSourceJobs(boss: PgBoss) {
  await work(boss, QUEUES.fetchSource, { localConcurrency: 8, pollingIntervalSeconds: 2 }, ({ sourceId, force }) => collectSource(sourceId, { force }));
  await registerExtractionJobs(boss);
}
