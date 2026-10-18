// What a module's web.tsx (modules/<name>/web.tsx) may add to the engine's pages: navigation entries, admin
// entries and the parts of a few pages that leave room for them. Its own pages come from its module.ts
// (routes.ts). The site's list is read through site-modules.ts.
//
// Every page loads web.tsx. A part only one page draws is given as its loader (`Part`), so it ships with that
// page's code: the page waits for its parts while its own code loads (site-modules.ts `loadParts`) and then
// renders them like any import.
import type { ComponentType, ReactNode } from "react";
import type { TopicSummary } from "@aihot/contracts/site";
import type { NavItem, Tab } from "./components/shell/nav";

export interface AdminNavEntry {
  to: string;
  label: string;
  /** The badge: a key of the admin's navigation counts (its server module's admin.counts). */
  count?: string;
  tone?: "bad" | "accent";
}

export type Part<T> = () => Promise<{ default: T }>;

/** A module's part of a topic page (routes/topic.tsx), from what its server module's topics.page returned for it. */
export interface TopicPagePart {
  /** What it is called: after "最新动态与" in the page's title, and in the name of its structured-data list. */
  name: string;
  /** Whether it has anything on this page; without, the page leaves it out of its body and its head. */
  shows: (data: unknown, topic: TopicSummary) => boolean;
  /** Drawn between the page's header and its list. */
  Block: ComponentType<{ data: unknown; topic: TopicSummary }>;
  /** Its entries for the page's structured data, newest first; one with an event page links to it. */
  entries: (data: unknown) => Array<{ title: string; href: string | null }>;
  /** The headlines of its most important recent events: the search snippet leads with the first two. */
  news: (data: unknown) => string[];
}

export interface WebModule {
  /** Its folder under modules/. */
  name: string;
  /** Desktop sidebar: entries in a section after the engine's 内容; modules naming the same section share it. */
  sidebar?: { section: string; items: NavItem[] };
  /** Phone tab bar: tabs before 我的. */
  tabs?: Tab[];
  /** The 我的 page: rows ahead of the engine's tools. */
  tools?: Array<{ to: string; label: string; icon: ReactNode }>;
  admin?: {
    /** Navigation groups of its own, ahead of the engine's. */
    groups?: Array<{ group: string; items: AdminNavEntry[] }>;
    /** Entries in the 内容 group, after the engine's 信源. */
    content?: AdminNavEntry[];
    /** Its part of the runs page, drawn from what its server module's admin.runs returns. */
    runs?: Part<ComponentType<{ data: unknown }>>;
    /** The page the admin opens on instead of the sources (routes/admin/index.tsx); the first module's wins. */
    landing?: string;
    /** Where the model prices are kept: the models page links its 未定价 there (routes/admin/models.tsx). */
    prices?: string;
  };
  /** Parts of every public page (root.tsx); the admin has its own chrome and gets none of them. */
  root?: {
    /** An inline script in <head>, after the theme's: it runs before the page paints. */
    bootScript?: string;
    /** Above the page's content. */
    Top?: ComponentType;
    /** After the page. */
    Bottom?: ComponentType;
  };
  topicPage?: Part<TopicPagePart>;
  /** Paths of the marks it serves that are drawn in white, for a dark tile (components/BrandMark.tsx). */
  darkMarks?: string[];
}

export function defineWebModule(module: WebModule): WebModule {
  return module;
}
