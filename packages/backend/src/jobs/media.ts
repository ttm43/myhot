// The images newly selected items need prepared.
import type { PgBoss } from "pg-boss";
import { prepareArticleMedia } from "../media/prepare.ts";
import { convertAnimated } from "../media/images.ts";
import { QUEUES, work } from "./queue.ts";

export async function registerMediaJobs(boss: PgBoss) {
  await work(boss, QUEUES.prepareMedia, { localConcurrency: 1, pollingIntervalSeconds: 5 }, async (data) =>
    "articleId" in data ? prepareArticleMedia(data.articleId) : { animatedSaved: await convertAnimated(data.url, data.mode) });
}
