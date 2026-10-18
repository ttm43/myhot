// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、MCP、后台都用它。 */
  name: "MyHOT",
  /**
   * 行业词：拼进默认说法里，比如“AI 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律动态”。
   */
  subject: "AI",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "MyHOT — AI 行业动态与每日精选",
  /** 一句话介绍：搜索引擎、分享卡片、PWA 清单会用。 */
  description: "从一批 AI 信源里挑出值得看的动态，把同一件事的多篇报道归到一起。",
  /** 一行小字：PWA 清单里的名字后面。 */
  tagline: "值得关注的 AI 动态",
  /** 搜索引擎读到的关键词（首页结构化数据）。 */
  keywords: ["AI 资讯", "AI 新闻", "AI 行业动态"] as string[],
  /** 网站开始收录的年份（结构化数据的时间范围，选填）。 */
  since: null as string | null,
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /** 标准图标（favicon.ico、icon.png、icon-192.png、apple-icon.png、logo.svg）以外也放在网站根目录的图标，site/brand/ 里的文件名（选填）；manifest.webmanifest 或外站引用了它们时用。 */
  rootIcons: [] as string[],
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 myhot_get_latest、myhot_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "myhot",
  /**
   * MCP 接口的版本号，只升不降。
   * 改了接口里已有的字段或含义时升主版本，并在部署说明里写清。
   */
  interfaceVersion: "5.0.0",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在侧栏底部和“我的”页底部，并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 源码的 GitHub 仓库地址（选填），填了就在侧栏底部和“我的”页底部显示“GitHub 开源”。 */
  github: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "MyHOT",
    /** 创始人（选填）。 */
    founder: null as null | { name: string; alternateName?: string; jobTitle?: string; description?: string; url?: string },
  },
  /** 抓取信源时报上的名字和版本（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "MyHOTBot/1.0",
} as const;

/** X 帖子的全文规则。 */
export const POLICY = {
  /**
   * X 帖子本身的文字和图片算不算全文：算的话，只在这篇允许站内全文时显示（信源允许全文、正文也取到了）；
   * 不算的话总是显示，和标题、摘要一样。
   */
  xPostIsFullText: true,
} as const;

/** 条目卡片和详情页上的几处说法和显示。 */
export const ITEM_COPY = {
  /** 模型写的那句理由叫什么：卡片、详情页、Markdown 导出和 MCP 的回答都用它。 */
  reasonLabel: "推荐理由",
  /** 读者在网页上看不看得到 AI 评分。只管显示：MCP 的数据照样带 score，后台照常显示。 */
  showScore: true,
};

/** 后台页面上给管理员的提示（选填）。 */
export const ADMIN = {
  /** 确认框里补的一句本站规定：调整付费服务的请求上限时。 */
  budgetNote: null as string | null,
};

/** 后台新建信源时的默认设置。 */
export const SOURCE_DEFAULTS = {
  /** 站内展示全文；false 时只显示摘要和原文链接。 */
  siteFulltext: false,
};

/** 这个部署自己的几处安排（选填）。 */
export const DEPLOYMENT = {
  /** 凭据分组文件（models.env、collectors.env……）默认放在哪个目录，相对仓库根目录；环境变量 AIHOT_CREDENTIALS_DIR 优先，都没有就只读环境变量。 */
  credentialsDir: null as string | null,
  /** 凭据分组的文件名（放在凭据目录下，选填）：没写的分组用“分组名.env”，比如 models.env。 */
  credentialFiles: {} as Partial<Record<string, string>>,
  /** 这个部署额外要求的凭据（[分组, 环境变量名]）；生产 API 启动时检查，默认没有额外要求。 */
  requiredSecrets: [] as const,
  /** 线上 api 收到的 Host（CDN 回源用的域名，选填）；本地开发时，网页开发服务器转给 api 的请求也换成它，和线上一致。 */
  originHost: null as string | null,
  /** 反向代理把没登录的后台访问转去登录时，用哪个请求头带上原来的地址（选填，登录后回到那里）。 */
  loginReturnHeader: null as string | null,
  /**
   * 图片代理从原站取图的流量上限：超过后没缓存的图先返回 503，等这一分钟或这一天过去，当天额度用完会进运营日报；
   * null 就不设上限。环境变量 IMGPROXY_UPSTREAM_MB_PER_MINUTE、IMGPROXY_UPSTREAM_GB_PER_DAY 优先。
   */
  imageUpstreamBudget: null as null | { mbPerMinute: number; gbPerDay: number },
  /**
   * 已实测应由服务器直接连接、不走出网代理（EGRESS_PROXY_URL）的域名，采集和图片共用（选填）。
   * 每次重定向重新按目标域名选路，直连仍检查实际连接地址。
   */
  directFetchHosts: [] as string[],
  /**
   * 精选评测（scripts/eval-selection.ts）不带参数时用的金标集：文件（相对仓库根目录）、抽样条数、只抽哪一份、门槛扫描范围。
   * null 就用 .data/gold.jsonl 的全部样本（最多 200 条），在 40–90 之间扫描。
   */
  selectionGold: null as null | { file: string; sample: number; split: string; sweep: [number, number] },
};

/**
 * MCP 里和网页不同的类别（选填）。上线后不要改：工具参数里有类别的 key。
 * merge：并进另一类发布的类别，key 是行业包里的类别，值是它并进的类别（MCP 比网页少一类时用）。
 */
export const PUBLIC_CATEGORIES = {
  merge: {},
} as const;

/** “AI 动态”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “全部 AI 动态”这类说法：行业词接在中文后面，英文词前加空格，中文词不加；noun 照 withSubject 接上。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}
