// First-party site API (/api/site/*). Not public, not versioned, never called /api/v2.
// Reads through the same public read layer as MCP; no cookies are read or set.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isCategoryKey, isChannelKey, type CategoryKey, type ChannelKey } from "@aihot/contracts/taxonomy";
import { InvalidCursorError } from "@aihot/backend/lib/cursor";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { loadPool, SearchBusyError } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { loadRadar } from "@aihot/backend/publication/radar";
import { RADAR_DAYS } from "@aihot/contracts/site";
import { looseQuery, sendJsonWithEtag, sendProblem } from "../http/respond.ts";

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

class BadRequest extends Error {}

export function siteHandler(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof BadRequest) return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.message });
      if (error instanceof InvalidCursorError) return sendProblem(req, reply, { status: 400, code: "invalid_cursor", detail: error.message });
      if (error instanceof SearchBusyError) {
        req.log = req.log.child({ reason: "search_capacity_exhausted" });
        return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "search busy", retryAfter: error.retryAfter });
      }
      req.log.error({ err: error, path: req.url.split("?")[0] }, "site api error");
      return sendProblem(req, reply, { status: 503, code: "temporarily_unavailable", detail: "temporarily unavailable", retryAfter: 10 });
    }
  };
}

export interface FilterParams {
  channel: ChannelKey;
  category: CategoryKey | null;
  tag: string | null;
}

export function parseFilters(q: Record<string, string>): FilterParams {
  const channel = q.channel ?? "all";
  if (!isChannelKey(channel)) throw new BadRequest("invalid channel");
  const category = q.category ?? null;
  if (category !== null && !isCategoryKey(category)) throw new BadRequest("invalid category");
  const tag = q.tag?.trim() ? q.tag.trim().slice(0, 60) : null;
  return { channel, category: category as CategoryKey | null, tag };
}

export function registerSite(app: FastifyInstance) {
  app.get("/api/site/timeline", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = parseFilters(q);
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 40);
    const data = await loadTimeline({ ...filters, cursor: q.cursor || null, limit });
    // Any cache in front and the home page built from this answer share one absolute deadline.
    reply.header("X-Accel-Expires", `@${Math.floor(Date.now() / 1000) + 60}`);
    return sendJsonWithEtag(req, reply, data, { etagPrefix: "tl", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/pool", siteHandler(async (req, reply) => {
    const q = looseQuery(req);
    const filters = parseFilters(q);
    const page = Math.min(Math.max(Number(q.page) || 1, 1), 50);
    const search = q.q?.trim() ? q.q.trim().slice(0, 200) : null;
    const tab = q.tab === "relevance" ? "relevance" : "time";
    return sendJsonWithEtag(req, reply, await loadPool({ ...filters, q: search, tab, page }), { etagPrefix: "pool", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/items/:id", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found" });
    const result = await loadItemDetail(id);
    if (result.kind === "not_found") return sendProblem(req, reply, { status: 404, code: "not_found", detail: "item not found", cacheControl: "public, max-age=60" });
    return sendJsonWithEtag(req, reply, result.item, { etagPrefix: "item", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/radar", siteHandler(async (req, reply) => {
    const raw = looseQuery(req).days ?? "3";
    const days = RADAR_DAYS.find((d) => String(d) === raw);
    if (!days) throw new BadRequest("invalid days");
    return sendJsonWithEtag(req, reply, await loadRadar(days), { etagPrefix: "radar", cacheControl: "public, max-age=60, s-maxage=60" });
  }));

  app.get("/api/site/groups/:factId/reports", siteHandler(async (req, reply) => {
    const data = await loadGroupReports({ factPublicId: (req.params as { factId: string }).factId, ...parseFilters(looseQuery(req)) });
    if (!data) return sendProblem(req, reply, { status: 404, code: "not_found", detail: "reading group unavailable" });
    return reply.header("Cache-Control", "no-store").send(data);
  }));

  // Markdown export: attachment, 404 when there is nothing to export (same predicate as the button).
  app.get("/items/:id/markdown", siteHandler(async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    const md = await exportMarkdown(id);
    if (!md) return reply.code(404).header("Cache-Control", "public, max-age=60").type("text/plain; charset=utf-8").send("Not found");
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${md.filename}"`)
      .header("Cache-Control", "public, max-age=300, s-maxage=300")
      .header("X-Robots-Tag", "noindex")
      .send(md.body);
  }));
}
