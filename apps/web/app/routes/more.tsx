import type { ReactNode } from "react";
import { Link } from "react-router";
import { SITE } from "@aihot/site";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { edgeTtl } from "../lib/api.server";
import { webModules } from "../site-modules";
import { pageMeta } from "../lib/seo";
import { setFontPreference, useFontPreference } from "../lib/local-state";
import { Select } from "../components/ui/Controls";
import { ThemeSwitch } from "../components/shell/ThemeSwitch";
import { IconChevronRight, IconMoon } from "../components/icons";

export const handle: Screen = { tab: "me", name: "我的" };

export function headers() {
  return edgeTtl(300);
}

export function meta() {
  return pageMeta({ title: "我的", path: "/more", noindex: true });
}

/**
 * "我的", the phone's last tab (the address stays /more): this browser's appearance first, then the tools.
 */
type Row = { to: string; label: string; icon: ReactNode; detail?: ReactNode };

/** The modules' tools (the engine has none of its own). */
const tools = (): Row[] => webModules().flatMap((m) => m.tools ?? []);

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="px-4 pb-2 pt-6 text-[13px] font-semibold text-ink-3">{title}</h2>}
      <ul className="card divide-y divide-line-soft overflow-hidden">{children}</ul>
    </section>
  );
}

function RowLink({ row }: { row: Row }) {
  return (
    <li>
      <Link viewTransition to={row.to} className="flex min-h-[52px] items-center gap-3 px-4 text-[16px] font-medium text-ink transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk">
        <span className="text-ink-3">{row.icon}</span>
        <span className="flex flex-1 items-center gap-2">{row.label}</span>
        {row.detail && <span className="text-[14px] font-normal text-ink-4">{row.detail}</span>}
        <IconChevronRight size={16} className="text-ink-4" />
      </Link>
    </li>
  );
}

export default function MorePage() {
  const font = useFontPreference();
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      <PhoneBar title="我的" large />
      <h1 className="hidden pb-4 pt-1 text-[22px] font-bold text-ink lg:block">我的</h1>
      <div className="lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-4 2xl:grid-cols-3">
        <Group>
          <li className="flex min-h-[56px] items-center gap-3 px-4 text-[16px] font-medium text-ink">
            <span className="text-ink-3">
              <IconMoon size={20} />
            </span>
            <span className="flex-1">外观</span>
            <ThemeSwitch className="w-[126px]" />
          </li>
          <li className="flex min-h-[56px] items-center gap-3 px-4 text-[16px] font-medium text-ink">
            <span className="w-5 text-center text-ink-3" aria-hidden="true">Aa</span>
            <span className="flex-1">字体</span>
            <Select aria-label="字体" value={font ?? "system"} onChange={(e) => setFontPreference(e.target.value === "browser" ? "browser" : null)}>
              <option value="system">默认字体</option>
              <option value="browser">浏览器默认字体</option>
            </Select>
          </li>
        </Group>
        <Group title="工具与入口">
          {tools().map((r) => (
            <RowLink key={r.to} row={r} />
          ))}
        </Group>
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12px] leading-[2] text-ink-4">
        {SITE.github && <a href={SITE.github} target="_blank" rel="noopener noreferrer" className="hover:text-ink-2">GitHub 开源</a>}
        {SITE.icp && <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className="hover:text-ink-2">{SITE.icp}</a>}
      </div>
    </div>
  );
}
