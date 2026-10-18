import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { sanitizeBody } from "./sanitize.ts";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Markdown has no equivalent for these structures; the HTML has already been sanitised.
turndown.keep(["sup", "sub", "u", "mark", "dl", "video"]);
turndown.addRule("strikethrough", { filter: ["del", "s"], replacement: (content) => `~~${content}~~` });
turndown.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const html = (node as unknown as { outerHTML: string }).outerHTML;
    const $ = cheerio.load(html, null, false);
    const table = $("table").first();
    const rows = table.find("tr").toArray();
    if (!rows.length) return `\n\n${html}\n\n`;
    const width = $(rows[0]!).children("th, td").length;
    // GFM cannot express merged cells, missing headings or blocks inside a cell faithfully.
    const complex = table.find("table, [rowspan], [colspan], pre, ul, ol, dl").length > 0 ||
      !width || $(rows[0]!).children("th").length !== width ||
      rows.some((row) => $(row).children("th, td").length !== width);
    if (complex) return `\n\n${html}\n\n`;
    const cells = (row: (typeof rows)[number]) => $(row).children("th, td").toArray().map((cell) =>
      turndown.turndown($(cell).html() ?? "").trim().replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>"));
    const line = (values: string[]) => `| ${values.join(" | ")} |`;
    const align = $(rows[0]!).children("th").toArray().map((cell) => {
      const value = $(cell).attr("align");
      return value === "right" ? "---:" : value === "center" ? ":---:" : value === "left" ? ":---" : "---";
    });
    const caption = table.children("caption").html();
    return `\n\n${caption ? `${turndown.turndown(caption)}\n\n` : ""}${[line(cells(rows[0]!)), line(align), ...rows.slice(1).map((row) => line(cells(row)))].join("\n")}\n\n`;
  },
});

/** Export the same safe body as the web page without flattening its structure. */
export function bodyToMarkdown(html: string, baseUrl?: string): string {
  return turndown.turndown(sanitizeBody(html, baseUrl)).trim();
}

