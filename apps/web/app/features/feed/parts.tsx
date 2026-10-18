// Small building blocks shared by feed items, detail pages and lists.
import type { FeedItemSummary } from "@aihot/contracts/site";

/** The source's name. */
export function SourceLine({ item, className = "" }: { item: Pick<FeedItemSummary, "source">; className?: string }) {
  return <span className={`min-w-0 truncate ${className}`}>{item.source.name}</span>;
}
