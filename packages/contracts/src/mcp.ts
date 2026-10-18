// The MCP tool names, from the site's prefix (site/site.ts).
import { SITE } from "@aihot/site";

/** A tool's full name: the site's prefix, then what it does ("get_latest"). */
export const mcpToolName = (tool: string): string => `${SITE.mcpPrefix}_${tool}`;

export const MCP_TOOL_NAMES = {
  latest: mcpToolName("get_latest"),
  search: mcpToolName("search"),
} as const;

/** The engine's tools, in the order the server lists them. */
export const MCP_TOOLS = Object.values(MCP_TOOL_NAMES).map((name) => ({ name }));
