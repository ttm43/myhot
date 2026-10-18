// Merging stories: facts move into the surviving story, and the old
// public id keeps answering as an alias. Editors merge from the admin; grouping merges when two
// stories turn out to be one (consolidate in group.ts).
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import { publishArticle } from "../publication/publish.ts";

/** Null when missing/already merged, or when grouping would change an editor-confirmed identity. */
export async function mergeStoryInto(fromId: number, intoId: number, reason: string, actor: string): Promise<{ moved: number } | null> {
  if (fromId === intoId) throw new Error("cannot merge a story into itself");
  const articles = await sql.begin(async (tx) => {
    const [from] = await tx<{ public_id: string; merged_into: number | null; origin: string }[]>`SELECT public_id, merged_into, origin FROM stories WHERE id = ${fromId} FOR UPDATE`;
    const [into] = await tx<{ merged_into: number | null; origin: string }[]>`SELECT merged_into, origin FROM stories WHERE id = ${intoId} FOR UPDATE`;
    if (!from || !into || from.merged_into || into.merged_into) return null;
    if (actor === "grouping" && (from.origin === "manual" || into.origin === "manual")) return null;
    await tx`UPDATE facts SET story_id = ${intoId}, updated_at = now() WHERE story_id = ${fromId}`;
    await tx`UPDATE stories SET merged_into = ${intoId}, version = version + 1, updated_at = now() WHERE id = ${fromId}`;
    await tx`UPDATE stories SET version = version + 1, updated_at = now() WHERE id = ${intoId}`;
    await tx`INSERT INTO story_aliases (public_id, story_id) VALUES (${from.public_id}, ${intoId}) ON CONFLICT DO NOTHING`;
    return tx<{ article_id: string }[]>`SELECT DISTINCT fa.article_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id WHERE f.story_id = ${intoId}`;
  });
  if (!articles) return null;
  for (const a of articles) await publishArticle(a.article_id);
  await audit(actor, "story.merge", `story:${fromId}`, reason, null, { into: intoId });
  return { moved: articles.length };
}
