// What a whole search query may call a company (pool.ts): the industry pack's companies
// (industry/topics.json), read when the process starts. Each names a subject (industry/taxonomy.ts
// ENTITIES) by its slug, its name, each part of a name such as "OpenAI / ChatGPT", and further aliases.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

export interface Company {
  /** The subject id (industry/taxonomy.ts ENTITIES). */
  entityId: string;
  aliases: string[];
}

interface CompanyFile {
  companies: Array<{ slug: string; name: string; entityId: string; aliases?: string[] }>;
}

const nameParts = (name: string) => name.split("/").map((s) => s.trim()).filter(Boolean);

const file = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as CompanyFile;

export const COMPANIES: Company[] = file.companies.map((c) => ({
  entityId: c.entityId,
  aliases: [c.slug, c.name, ...nameParts(c.name), ...(c.aliases ?? [])],
}));
