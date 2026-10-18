import type { ReactNode } from "react";

/**
 * Long reads (articles): no sheet, the text sits on the page in a column of at most
 * 760px, the width Chinese magazines and news sites use (680–730px at 16–17px, about 42 characters a
 * line). From 2xl a rail on each side (the piece's facts left, notes right) keeps the page filling a
 * 16:9 screen with the column in the middle; from lg only the right rail shows, beside the centred
 * column; phones read one column.
 */
export function ArticleLayout({ children, left, right }: { children: ReactNode; left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[var(--page-max-reading)] grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-x-12 2xl:grid-cols-[minmax(200px,1fr)_minmax(0,760px)_minmax(200px,1fr)] 2xl:gap-x-12">
      <aside className="hidden 2xl:block">
        <div className="sticky top-6 max-w-[260px] space-y-8">{left}</div>
      </aside>
      <div className="min-w-0">
        <div className="mx-auto max-w-[760px]">{children}</div>
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-6 ml-auto max-w-[260px] space-y-8">{right}</div>
      </aside>
    </div>
  );
}

/** A block in an article rail: a hairline, a small grey title (none when the content names itself), then the content; no card. */
export function RailSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-3.5">
      {title && <h2 className="text-[12px] font-semibold text-ink-3">{title}</h2>}
      <div className={title ? "mt-2.5" : undefined}>{children}</div>
    </section>
  );
}

/** Quiet empty / unavailable state inside a card or list. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="text-[15px] font-semibold text-ink-2">{title}</div>
      {children && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-4">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
