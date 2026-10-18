// Feishu delivery. Two separate apps: the login app (admin OAuth) and the message app (operations
// alert chat). Content groups use custom bot webhooks.
// Alerts never go to content groups, and content never goes to internal chats.
// Everything outward is off unless explicitly enabled (development and tests stay silent).
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { config, credential } from "../config.ts";

const API = "https://open.feishu.cn/open-apis";

export const feishuInternalEnabled = () => process.env.FEISHU_INTERNAL_ENABLED === "true";

let tokenCache: { token: string; expires: number } | null = null;

async function tenantToken(): Promise<string> {
  if (tokenCache && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const appId = credential("integrations", "FEISHU_APP_ID");
  const appSecret = credential("integrations", "FEISHU_APP_SECRET");
  if (!appId || !appSecret) throw new Error("Feishu message app is not configured");
  const res = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { code: number; tenant_access_token?: string; expire?: number; msg?: string };
  if (json.code !== 0 || !json.tenant_access_token) throw new Error(`feishu token: ${json.msg}`);
  tokenCache = { token: json.tenant_access_token, expires: Date.now() + (json.expire ?? 3600) * 1000 };
  return tokenCache.token;
}

async function sendToChat(chatId: string, msgType: "text" | "post" | "interactive", content: unknown): Promise<string> {
  const res = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await tenantToken()}` },
    body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { code: number; data?: { message_id: string }; msg?: string };
  if (json.code !== 0) throw new Error(`feishu send: ${json.msg}`);
  return json.data?.message_id ?? "";
}

// Operations alerts
// Read by the site owner, not an engineer (operations/alerts.ts): what readers see, whether it heals,
// and what the owner must do.

/** How urgent: readers affected now, money or the owner's hands today, or a follow-up that can wait. */
export type Level = "now" | "today" | "later";

export interface Finding {
  key: string;
  level: Level;
  /** Plain words: no queue, unit or table names. */
  title: string;
  /** What readers see, or what it costs. */
  impact?: string;
  /** Whether it heals by itself. */
  heals?: string;
  /** What has to be done. */
  action?: string;
  /** Facts for whoever looks into it: the 09:00 digest lists them, an alert to the owner never carries them. */
  detail?: string;
  /** When the problem began, when known; otherwise when it was first seen. */
  since?: Date;
  /**
   * The owner hears of it at once, even where a site's responder (modules.ts) hands problems to someone else
   * first: only the owner can act (paying, renewing, a device beside them, a judgement on content), or
   * everything has stopped (the whole site, or the worker that runs the checks).
   */
  owner?: true;
}

const MARK: Record<Exclude<Level, "later">, string> = { now: "🔴", today: "🟠" };

/** "9月29日" in Beijing time. */
export function beijingDay(at: Date | string | number): string {
  const [, m, d] = beijingDate(at).split("-").map(Number);
  return `${m}月${d}日`;
}

/** "9月29日 13:40" in Beijing time. */
export const beijingStamp = (at: Date | string | number) => `${beijingDay(at)} ${beijingTime(at)}`;

export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ""}`;
  return `${Math.floor(min / 1440)} 天`;
}

/** The message for an open problem: first notice or a repeat. */
export function formatAlert(f: Finding, since: Date, now: number, repeat = false): { title: string; lines: string[] } {
  const level = f.level === "later" ? "today" : f.level;
  const lasting = now - since.getTime() >= 60_000 ? `（已持续 ${duration(now - since.getTime())}）` : "";
  const lines = [f.impact && `影响：${f.impact}`, f.heals && `会自己好吗：${f.heals}`, f.action && `你需要：${f.action}`];
  return { title: `${MARK[level]} ${repeat ? "仍未恢复：" : ""}${f.title}${lasting}`, lines: lines.filter((l): l is string => !!l) };
}

export function formatRecovery(title: string, since: Date, now: number): { title: string; lines: string[] } {
  return { title: `✅ 已恢复：${title}`, lines: [`持续 ${duration(now - since.getTime())}（${beijingStamp(since)} 起）`] };
}

/** Operations alert: the alert chat, falling back to the internal feedback chat — never a content group. */
export async function sendAlert(title: string, lines: string[]): Promise<"sent" | "disabled"> {
  // Production needs no label; any other environment that has sending on says which one it is.
  const text = `${config.environmentName === "production" ? "" : `【${config.environmentName}】`}${title}\n${lines.join("\n")}`;
  if (!feishuInternalEnabled()) {
    console.log(JSON.stringify({ level: "warn", msg: "alert (not sent: FEISHU_INTERNAL_ENABLED is off)", title, lines }));
    return "disabled";
  }
  const chat = credential("integrations", "FEISHU_ALERT_CHAT_ID") ?? credential("integrations", "FEISHU_INTERNAL_CHAT_ID");
  if (!chat) return "disabled";
  await sendToChat(chat, "text", { text });
  return "sent";
}

/** Custom-bot webhook for content groups (selected cards and other pushes). */
export async function postWebhook(url: string, card: unknown): Promise<{ status: "sent" | "failed" | "unknown"; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  // A successful HTTP transport is not an acknowledgement: proxies can return HTML or empty JSON.
  let status: "sent" | "failed" | "unknown" = res.status >= 400 && res.status < 500 ? "failed" : "unknown";
  try {
    const json = JSON.parse(body) as { code?: number; StatusCode?: number } | null;
    const code = json?.code ?? json?.StatusCode;
    if (res.ok && typeof code === "number") status = code === 0 ? "sent" : "failed";
  } catch {
    // non-JSON body
  }
  return { status, body: body.slice(0, 500) };
}
