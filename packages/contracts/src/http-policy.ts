// Outward HTTP behaviour, defined once: the public interface version, redirects and which process
// owns a path, the engine's and then those of the site's modules. The API server and the web server both
// read this module.
import { SITE } from "@aihot/site";
import { MODULES } from "@aihot/site/modules";

/** MCP carries one public version, the site's (site/site.ts); it only goes up. */
export const PUBLIC_INTERFACE_VERSION = SITE.interfaceVersion;

export const NO_STORE = "no-store";

export interface RedirectRule {
  match: "exact" | "regex" | "prefix";
  path: string;
  status: 301 | 302 | 307 | 308 | 404 | 410;
  /** Relative Location. `$1`… refer to regex groups; `*` appends the remainder for prefix rules. */
  location?: string;
  keepQuery?: boolean;
  /** Appended after the query, as `#fragment`. */
  fragment?: string;
  headers?: Record<string, string>;
  why?: string;
}

/** Redirects. Locations are always relative, so they stay right behind any proxy. */
const ENGINE_REDIRECTS: RedirectRule[] = [
  {
    match: "regex",
    path: "^/(all|more)/+$",
    status: 301,
    location: "/$1",
    keepQuery: true,
  },
  { match: "prefix", path: "/sources", status: 302, location: "/admin/sources*", why: "admin bookmarks" },
];


export interface RedirectDecision {
  status: number;
  location: string | null;
  headers: Record<string, string>;
}

export function resolveRedirect(pathname: string, search: string): RedirectDecision | null {
  for (const rule of tables().redirects) {
    let location: string | null = null;
    if (rule.match === "exact") {
      if (pathname !== rule.path) continue;
      location = rule.location ?? null;
    } else if (rule.match === "prefix") {
      const inTree = rule.path.endsWith("/")
        ? pathname.startsWith(rule.path)
        : pathname === rule.path || pathname.startsWith(`${rule.path}/`);
      if (!inTree) continue;
      location = rule.location ? rule.location.replace("*", pathname.slice(rule.path.length)) : null;
    } else {
      const m = new RegExp(rule.path).exec(pathname);
      if (!m) continue;
      location = rule.location ? rule.location.replace(/\$(\d)/g, (_s, i: string) => m[Number(i)] ?? "") : null;
    }
    if (location && rule.keepQuery && search) location += search;
    if (location && rule.fragment) location += `#${rule.fragment}`;
    return { status: rule.status, location, headers: rule.headers ?? {} };
  }
  return null;
}

/** OAuth discovery probes from MCP clients: a cheap 404, never a rendered page. */
export const OAUTH_PROBE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/mcp",
  "/.well-known/openid-configuration",
  "/.well-known/openid-configuration/api/mcp",
  "/api/mcp/.well-known/oauth-protected-resource",
  "/api/mcp/.well-known/oauth-authorization-server",
  "/api/mcp/.well-known/openid-configuration",
];

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Paths served by the api process; everything else is the web process. The web server proxies these to
 * the api (a reverse proxy in front may also route them straight to it).
 */
const ENGINE_API_PATHS: RegExp[] = [
  /^\/api\//,
  /^\/manifest\.webmanifest$/,
  /^\/(favicon\.ico|icon\.png|icon-192\.png|apple-icon\.png|logo\.svg)$/,
  ...(SITE.rootIcons.length ? [new RegExp(`^\\/(${SITE.rootIcons.map(literal).join("|")})$`)] : []),
  /^\/items\/[^/]+\/markdown$/,
];

/** Read on first use, so a browser bundle that only needs this module's constants leaves the modules' tables out. */
let built: { redirects: RedirectRule[]; apiPaths: RegExp[] } | null = null;
function tables() {
  built ??= {
    redirects: [...ENGINE_REDIRECTS, ...MODULES.flatMap((m) => m.redirects ?? [])],
    apiPaths: [...ENGINE_API_PATHS, ...MODULES.flatMap((m) => m.apiPaths ?? [])],
  };
  return built;
}

export function isApiOwned(pathname: string): boolean {
  return tables().apiPaths.some((re) => re.test(pathname));
}
