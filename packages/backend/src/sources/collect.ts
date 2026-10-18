// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql, type Db } from "../db.ts";
import { identityKeyFor, reuseExternalMaterialIdentities, STALE_ON_DISCOVERY_MS, upsertMaterial } from "../content/materials.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { sha256 } from "../lib/ids.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { fetchRss } from "./rss.ts";
import { fetchDetail, fetchWebList, isCallToActionTitle, needsTitle, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { admitListing, filterPublicationWindow } from "./filters.ts";
import { fetchJsonList } from "./json-list.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

interface StoredDetail {
  identity_key: string;
  title: string;
  published_at: Date | null;
  excerpt: string | null;
  body_status: string;
  rules: string | null;
}

async function storedDetails(identities: string[]): Promise<Map<string, StoredDetail>> {
  if (identities.length === 0) return new Map();
  // One array parameter: a long listing would exceed the query's parameter limit.
  const rows = await sql<StoredDetail[]>`SELECT identity_key, title, published_at, excerpt, body_status,
    raw->'collectionDetail'->>'rules' AS rules
    FROM articles WHERE identity_key = ANY(${identities}::text[])`;
  return new Map(rows.map((r) => [r.identity_key, r]));
}

const DAY_MS = 86_400_000;

type CollectionCandidate = Candidate & { detailRules?: string };

async function store(sourceId: string, candidates: CollectionCandidate[], backfill: string | null): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    const res = await upsertMaterial(material);
    // A successful page with no matching field is complete too. Otherwise an undated article at
    // the front of a listing would consume the detail budget forever and strand the remaining ones.
    if (c.detailRules) await sql`UPDATE articles SET raw = jsonb_set(
      CASE WHEN jsonb_typeof(raw) = 'object' THEN raw ELSE '{}'::jsonb END,
      '{collectionDetail}', ${sql.json({ rules: c.detailRules })}) WHERE id = ${res.articleId} AND source_id = ${sourceId}`;
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  return { created, revised };
}

/**
 * The end of a fetch run, on the run and on its source. Success marks the source healthy and due again
 * one interval later. A failure counts toward "failing" (5 in a row) and waits longer after each one,
 * up to six hours.
 */
async function recordFetch(db: Db, sourceId: string, runId: number, run: { found: number; created: number; detail: object | null } & ({ cursor: Record<string, unknown> } | { error: string })): Promise<void> {
  const detail = run.detail ? db.json(run.detail as never) : null;
  if ("cursor" in run) {
    await db`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
        health = 'ok', cursor = ${db.json(run.cursor as never)}, updated_at = now(),
        next_fetch_at = now() + make_interval(mins => interval_minutes)
      WHERE id = ${sourceId}`;
    await db`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${run.found}, new_count = ${run.created}, detail = ${detail} WHERE id = ${runId}`;
    return;
  }
  await db`
    UPDATE sources SET last_fetch_at = now(),
      fail_count = fail_count + 1,
      last_error = ${run.error},
      health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
      next_fetch_at = now() + make_interval(mins => LEAST(interval_minutes * (fail_count + 2), 360)),
      updated_at = now()
    WHERE id = ${sourceId}`;
  await db`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${run.found}, new_count = ${run.created},
              error = ${run.error}, detail = ${detail} WHERE id = ${runId}`;
}

export async function collectSource(sourceId: string, opts: { force?: boolean } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "external") {
    // External sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  let created = 0;
  let revised = 0;
  let found = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: CollectionCandidate[];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let detail: Record<string, unknown> | null = null;
    const d = source.config.detail;
    const detailRules = d ? sha256(JSON.stringify(d)) : null;
    if (source.kind === "rss") {
      // Changed detail rules require the listing again even when its bytes did not change.
      const rss = await fetchRss(source, { force: opts.force || !!detailRules && source.cursor?.detailRules !== detailRules });
      candidates = rss.candidates;
      // The first import keeps only part of the listing: the next run reads all of it once before
      // accepting 304s, for the recent entries the import left out. Persist validators only after store succeeds.
      if (!firstImport) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else candidates = await fetchJsonList(source);
    found = candidates.length;
    candidates = admitListing(candidates, source);
    if (source.kind === "json_list" && source.config.externalIdPath) candidates = await reuseExternalMaterialIdentities(sourceId, candidates);
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    // Deduplicate before enrichment and limits: URL aliases must neither buy duplicate detail reads
    // nor crowd other articles out of the window. Use exactly the identity the material will store; a
    // source whose entries are sections of one page (#september-24-2026 …) keeps their fragments in it.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const identityKey = c.identityKey
        ?? (source.config.preserveUrlFragment === true ? identityKeyForUrl(c.url, { keepFragment: true }) : null)
        ?? identityKeyFor({ ...c, sourceId, via: "fetch" });
      if (!unique.has(identityKey)) unique.set(identityKey, { ...c, identityKey });
    }
    candidates = [...unique.values()];
    // Listing dates marked unreliable are dropped before archive admission; the detail page's rule decides.
    if (d?.publishedAtAuthoritative === true) for (const c of candidates) c.publishedAt = null;
    // Admission of old archive entries and detail recovery both need the same stored identities.
    // A later date correction must still reach material that was already admitted without a date.
    const known = d || !firstImport
      ? await storedDetails(candidates.map((c) => c.identityKey!)) : new Map<string, StoredDetail>();
    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    } else {
      // Later runs admit new identities only when published since the source was added, less the stale-on-discovery
      // window: a long listing's archive comes in through the bounded first import alone. Existing identities
      // still accept corrections. The listing's date decides; an undated entry passes and waits for a date as material (dropping one a detail page
      // dates would buy the same read again on every run). Nothing is cut by count: the cursor (an RSS validator) moves past the whole listing, so a recent entry cut
      // here would never be offered again.
      const floor = Date.parse(String(source.cursor!.initializedAt)) - STALE_ON_DISCOVERY_MS;
      candidates = candidates.filter((c) => known.has(c.identityKey!) || !(c.publishedAt && c.publishedAt.getTime() < floor));
    }

    // Detail pages fill missing fields within the per-run budget. Material stored before that budget
    // ran out, or during a failed detail read, can finish on a later listing run.
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    let detailPending = 0;
    const detailErrors: Array<{ url: string; error: string }> = [];
    for (const c of candidates) {
      const stored = known.get(c.identityKey!);
      const storedHeadline = !!stored && isCallToActionTitle(c.title) && !isCallToActionTitle(stored.title);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored.title;
        if (stored.rules === detailRules) {
          c.publishedAt ??= stored.published_at;
          continue;
        }
        if (d?.publishedAtAuthoritative !== true) c.publishedAt ??= stored.published_at;
      }
      if (!d) continue;
      const need: DetailNeed = {
        date: d.publishedAtAuthoritative === true || !(stored?.published_at || c.publishedAt) || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || (!storedHeadline && needsTitle(c.title))),
        summary: !!d.summarySelector && !(stored?.excerpt || c.excerpt),
        body: source.participation_mode === "editorial" && stored?.body_status !== "ok" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      if (detailUsed >= detailBudget) { detailPending += 1; continue; }
      detailUsed += 1;
      try {
        const got = await fetchDetail(c.url, source, need);
        c.detailRules = detailRules!;
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
          if (!d.publishedAtAuthoritative && !c.publishedAt && got.body.publishedAt) c.publishedAt = got.body.publishedAt;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch (error) {
        if (shutdownSignal.signal.aborted) throw error;
        detailPending += 1;
        detailErrors.push({ url: c.url, error: String(error instanceof Error ? error.message : error).slice(0, 300) });
      }
    }
    if (d) {
      detail = { ...detail, detailAttempts: detailUsed, detailFailures: detailErrors.length, detailPending, detailErrors };
      nextCursor.detailRules = detailRules;
      // A validator covers the whole listing: accept 304 only after its detail work is complete.
      if (source.kind === "rss" && detailPending > 0) delete nextCursor.rss;
    } else delete nextCursor.detailRules;

    candidates = filterPublicationWindow(candidates, source.config.publishedAfter);
    ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null));

    if (firstImport) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    await recordFetch(sql, sourceId, run!.id, { found, created, detail, cursor: nextCursor });
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    await recordFetch(sql, sourceId, run!.id, { found, created, detail: null, error: message });
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** Every minute: enqueue due sources (enabled, not external), oldest due first. */
export async function scheduleDueSources(): Promise<{ enqueued: number }> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ('rss', 'web_list', 'json_list') AND (next_fetch_at IS NULL OR next_fetch_at <= now())
    ORDER BY next_fetch_at NULLS FIRST LIMIT 40`;
  let enqueued = 0;
  for (const r of rows) {
    if (await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id })) enqueued += 1;
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  return { enqueued };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode"> & { per_day: number }>>`
    SELECT s.id, s.participation_mode,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list')`;
  let updated = 0;
  for (const r of rows) {
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing); hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : 60;
    const target = perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(15, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
