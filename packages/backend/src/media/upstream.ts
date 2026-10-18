// The upstream budget of image fetches. The image proxy is the one path where the origin fetches
// third-party bytes on a reader's behalf (vision analysis shares it), so a site may cap them per minute
// and per Beijing day (site.ts DEPLOYMENT.imageUpstreamBudget; IMGPROXY_UPSTREAM_MB_PER_MINUTE and
// IMGPROXY_UPSTREAM_GB_PER_DAY win). Past it, uncached images get 503 until the window resets (cached ones
// are still served).
import { beijingDate } from "@aihot/contracts/time";
import { DEPLOYMENT } from "@aihot/site";

function budget(env: string | undefined, site: number | undefined, unit: number): number {
  const value = env ?? site;
  return value === undefined ? Infinity : Number(value) * unit;
}
const MINUTE_BUDGET = budget(process.env.IMGPROXY_UPSTREAM_MB_PER_MINUTE, DEPLOYMENT.imageUpstreamBudget?.mbPerMinute, 1e6);
const DAY_BUDGET = budget(process.env.IMGPROXY_UPSTREAM_GB_PER_DAY, DEPLOYMENT.imageUpstreamBudget?.gbPerDay, 1e9);

let minute = { at: 0, bytes: 0 };
let day = { key: "", bytes: 0 };

/** Whether another upstream image may be fetched now; the reason when it may not. */
export function upstreamAllowed(now = Date.now()): { ok: true } | { ok: false; reason: string } {
  const m = Math.floor(now / 60_000);
  if (minute.at !== m) minute = { at: m, bytes: 0 };
  const d = beijingDate(now);
  if (day.key !== d) day = { key: d, bytes: 0 };
  if (minute.bytes >= MINUTE_BUDGET) return trip("minute");
  if (day.bytes >= DAY_BUDGET) return trip("day");
  return { ok: true };
}

function trip(window: "minute" | "day"): { ok: false; reason: string } {
  const reason = window === "minute" ? `图片代理上游流量超过每分钟 ${MINUTE_BUDGET / 1e6} MB` : `图片代理上游流量超过当日 ${DAY_BUDGET / 1e9} GB`;
  return { ok: false, reason };
}

/** Counts fetched upstream bytes against both windows. */
export function recordUpstream(bytes: number, now = Date.now()): void {
  upstreamAllowed(now);
  minute.bytes += bytes;
  day.bytes += bytes;
}
