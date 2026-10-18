// Static files: the site's web manifest and its icons.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SITE } from "@aihot/site";
import { REPO_ROOT, config } from "@aihot/backend/config";

const PUBLIC = path.join(REPO_ROOT, "site/public");
/** The site's brand files (site/brand/), and how long its icons are cached. */
const BRAND = path.join(REPO_ROOT, "site/brand");
const ICON_CACHE = "public, max-age=2592000, stale-while-revalidate=604800";

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=UTF-8",
  ".txt": "text/plain; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** A public file's `{{…}}` placeholders: the site's name, address, description, tagline and locale (JSON-escaped in JSON files). */
function fillPlaceholders(text: string, json: boolean): string {
  const values: Record<string, string> = {
    siteName: SITE.name,
    siteUrl: config.siteUrl,
    description: SITE.description,
    tagline: SITE.tagline,
    locale: SITE.locale,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => {
    const value = values[key];
    if (value === undefined) return all;
    return json ? JSON.stringify(value).slice(1, -1) : value;
  });
}

interface Entry {
  body: Buffer;
  etag: string;
}

const etagOf = (body: Buffer) => `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

const fileCache = new Map<string, Entry & { mtime: number }>();

/** A file's bytes and ETag, read again when it changes; `fill` fills in a public file's placeholders. */
async function loadFile(file: string, fill = false): Promise<Entry> {
  const s = await stat(file);
  const cached = fileCache.get(file);
  if (cached && cached.mtime === s.mtimeMs) return cached;
  let body = await readFile(file);
  if (fill && body.includes("{{")) body = Buffer.from(fillPlaceholders(body.toString("utf8"), /\.(json|webmanifest)$/.test(file)));
  const entry = { body, etag: etagOf(body), mtime: s.mtimeMs };
  fileCache.set(file, entry);
  return entry;
}

function sendEntry(req: FastifyRequest, reply: FastifyReply, entry: Entry, opts: { type: string; cacheControl: string }) {
  reply.header("Content-Type", opts.type);
  reply.header("Cache-Control", opts.cacheControl);
  reply.header("ETag", entry.etag);
  if (req.headers["if-none-match"] === entry.etag) return reply.code(304).send();
  return reply.send(entry.body);
}

/** A file's bytes with an ETag (304 when it matches), its type from the extension unless given; a missing one is a 404. Modules serve their own files with it. */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, opts: { type?: string; cacheControl: string; fill?: boolean }) {
  let entry;
  try {
    entry = await loadFile(file, opts.fill);
  } catch {
    return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
  }
  return sendEntry(req, reply, entry, { type: opts.type ?? TYPES[path.extname(file)] ?? "application/octet-stream", cacheControl: opts.cacheControl });
}

export function registerStatic(app: FastifyInstance) {
  // The site's web manifest (site/public/), placeholders filled in.
  app.get("/manifest.webmanifest", (req, reply) => sendFile(req, reply, path.join(PUBLIC, "manifest.webmanifest"), { cacheControl: "public, max-age=86400, stale-while-revalidate=604800", fill: true }));
  // The site's icons (site/brand/): the standard ones, then any others it keeps at the root.
  for (const icon of ["favicon.ico", "icon.png", "icon-192.png", "apple-icon.png", "logo.svg", ...SITE.rootIcons]) {
    app.get(`/${icon}`, (req, reply) => sendFile(req, reply, path.join(BRAND, icon), { cacheControl: ICON_CACHE }));
  }
}
