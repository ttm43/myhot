# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/ttm43/myhot.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动前检查 `.env` 的 `SITE_URL`：本机试用保留 `http://localhost:3000`；部署到服务器时改成读者实际访问的地址。例如通过服务器 IP 访问时（把示例 IP 换成自己的）：

```dotenv
SITE_URL=http://192.0.2.10:3000
```

分享链接、Markdown 导出和 MCP 中的绝对链接都使用这个值，不会随浏览器访问的地址自动改变。使用域名和 HTTPS 时按下方「配域名和 HTTPS」设置。

配置完成后启动：

```bash
docker compose up -d --build
```

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、结构化、写标题摘要，再归组）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。`web` 只接收网站地址、API 地址等网页配置，通过 HTTP 读取 API；数据库、模型和管理员密钥，以及数据卷，只交给后端容器。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源和图片时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `site/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接和 MCP 都用它。

MCP 默认接受 `SITE_URL` 的主机以及 `localhost`、`127.0.0.1`、`[::1]`。额外主机用 `MCP_ALLOWED_HOSTS` 配置，以逗号分隔，例如 `extra.example:8443,[2001:db8::1]`。主机名不区分大小写，IPv6 必须加方括号；可带 0–65535 的十进制端口，匹配时忽略端口。包含路径、用户信息或非法端口的配置不会生效。`127.1` 等别名需要明确列入；此配置只影响 Host 校验，不扩大浏览器 Origin 许可。

前面有 Nginx、CDN 这类缓存时，要遵循应用返回的缓存期限（`Cache-Control`）：公开网页、导航数据、API、条目 Markdown，都不要另加更长的缓存期，不要在到期后离线返回旧内容，也不要在转发旧响应时重新起算它的寿命；不要让代理和 CDN 叠加缓存动态内容。框架不代管自建站的 CDN，也不替它清缓存。

### 更新

先按下方 [备份](#备份) 一节备份。构建完成后停止旧服务，再运行迁移和新版服务：

```bash
git pull
docker compose build
docker compose stop api worker web
docker compose run --rm setup && docker compose up -d
```

迁移成功后再启动服务；迁移失败时先查看错误，不要继续启动。使用 HTTPS 配置的站点继续保留 `--profile https`。旧的 API 和 worker 要在迁移前停下：迁移可能删表删列，旧代码还在跑会出错；正常关闭 worker 会等进行中的付费调用收尾（最长三分多钟）。非 Docker 部署也按“备份、构建、停止 API/worker/web、迁移（`scripts/migrate.ts`）、种子数据（`scripts/seed.ts`）、启动”的顺序更新。

新迁移遇到长期占锁会报出文件名和等待超时，先处理占锁事务，再重跑 setup，不要跳过迁移或改写迁移账本。并发索引创建中断可能留下无效索引：核实报错中的对象后，用 `DROP INDEX CONCURRENTLY <索引名>` 清理该失败索引再重跑；有效但定义不同的同名索引须先核对差异。这些保护不改变上述 Docker 更新顺序，跨旧版本升级仍可能执行历史上的破坏性迁移。

下面按时间从新到旧列出每次更新要注意的事。硬分叉之前 AIHOT 自己的更新说明已经删掉，需要时看 AIHOT 仓库。

#### 精简后的清理（2026 年 10 月 18 日）

精简留下的几样没人再写、也没人再读的数据和代码一并删掉。迁移只删列和改约束，不调用模型；删掉的列里的数据找不回来，要留的先用下方 [备份](#备份) 导出。

- **分析结果里的入选和分数**：迁移 `0119`、`0120` 删掉 `analyses` 的 `score`、`selected` 两列。精选和分数只看人工覆盖（`editorial_overrides`），没有覆盖的资料不入选、没有分数；后台“内容诊断”的模型判断里不再显示“入选”和“分数”。删之前先确认每条精选都有覆盖：`SELECT count(*) FROM publications p WHERE p.selected AND NOT EXISTS (SELECT 1 FROM editorial_overrides o WHERE o.article_id = p.article_id AND o.fields ? 'selected');` 应为 0，不为 0 的那些更新后会掉出精选。硬分叉前按 AIHOT 评分打过分、没有覆盖的未入选资料，公开投影里的分数先留着，这条资料下次重新发布时变成没有分数。归组时模型给出的“有没有新信息”（`articles.selection_adds_value`）照旧记下，但覆盖设了入选的资料本来就不受它影响，所以它现在不改变精选。
- **信源类型**：迁移 `0121`–`0123` 把 `sources.kind` 的约束收窄到 `rss`、`web_list`、`json_list`、`external`（先删旧约束，再以 `NOT VALID` 加新约束，最后单独验证）。库里还有 `x_search`、`mp_account` 信源时验证会失败，更新前先查：`SELECT id, kind FROM sources WHERE kind NOT IN ('rss', 'web_list', 'json_list', 'external');`，有的话先删掉或改成别的类型。
- **X 帖子的数据和样式**：硬分叉以后没有采集再写 `articles.x_post`、`articles.x_article`，迁移 `0124`、`0125` 删掉这两列。卡片和文章页上的 X 帖子样式（头像、@账号、配图、引用帖）、Markdown 导出里的帖子部分、只给帖子用的四份提示词 `industry/prompts/summarize-short-post*.md` 和 `summarize-long-post*.md`、`site/site.ts` 的 `POLICY`，以及频道 `x`（`?channel=x` 现在是无效参数）都去掉了；`/api/site/*` 的条目不再带 `channel` 和 `x` 两个字段。catbus 推来的 X 帖子带 `body`，一直按普通文章处理，不受影响。写标题摘要这一步的提示词版本因此变了：已有分析不重算，之后重新分析的资料不复用旧的写作回执。更新前可以先查库里有没有帖子数据：`SELECT count(*) FROM articles WHERE x_post IS NOT NULL OR x_article IS NOT NULL;`，有的话删列后只剩标题和正文。`publications.channel` 列留着，现在都是 `news`。

#### 硬分叉精简（2026 年 10 月 18 日）

MyHOT 不再跟进上游，只留采集、预筛、摘要、归组和自己读的页面。下面每条是一项删掉的功能；迁移只删表，不调用模型，删掉的表里的数据找不回来，要留的先用下方 [备份](#备份) 导出。

- **AIHOT 评分和 SelectBench**：程序不再给资料打分、不再判断入选（模型步骤“精选评分”`SCORE_MODEL`、“内容理解”`UNDERSTAND_MODEL`、“改用词”`WORDING_MODEL` 和它们的提示词 `selection-score.md`、`understand.md`、`content-understanding.md`、`mend-wording.md` 都去掉了），分析只剩预筛、结构化和标题摘要；精选和卡片上的分数只由人工覆盖决定（后台“内容诊断”或外部评价器写覆盖），见 [精选](selection.md)。`industry/selection.ts`、`industry/wording.ts`、`industry/gold.example.jsonl`、`industry/taxonomy.ts` 的 `ITEM_TYPES`、模型预设 `glm-5.3-flash-selection` 和 `site/site.ts` 的 `DEPLOYMENT.selectionGold` 删除；后台 SelectBench 页、`scripts/eval-selection.ts` 也去掉了，“模型与评测”页改名“模型”。迁移 `0117`、`0118` 删掉 `selectbench_results`、`selectbench_runs`。`analyses` 表的 `score`、`selected` 两列留着：硬分叉前按 AIHOT 评分选上的资料没有覆盖时还靠它们保持入选，之后的新分析不再写这两列。`.env` 里的 `SCORE_MODEL`、`UNDERSTAND_MODEL`、`WORDING_MODEL` 不再读；`settings` 表里的 `models.score`、`models.understand`、`models.wording`（如果设过）不再读。
- **全文翻译**：精选全文和被引用帖子的中文翻译（`content.translate` 定时任务、模型步骤“精选全文翻译”和 `TRANSLATE_MODEL`、`industry/prompts/translate-*.md`）、文章页的“中文 / 原文”切换和 `/items/:id/original`（连同 `/api/site/items/:id/original`）都去掉了；文章页和 Markdown 导出只给原文。迁移 `0114`–`0116` 删掉 `translation_attempts`、`quote_translations`、`translations` 三张表，已有的译文找不回来。`.env` 里的 `TRANSLATE_MODEL` 不再读；`settings` 表里的 `models.translate`（如果设过）不再读。
- **自建 RSSHub**：`docker-compose.yml` 里的 `rsshub` 服务和只为它开的内网放行名单（`PRIVATE_FETCH_ALLOW_HOSTS`）都去掉了，所有抓取重新一律经过内网地址防护。已经跑着的 `rsshub` 容器不会被 `docker compose up` 删掉，要手动删：`docker compose up -d --remove-orphans`，或 `docker rm -f <项目名>-rsshub-1`；`.env.rsshub` 和 `.env` 里的 `PRIVATE_FETCH_ALLOW_HOSTS` 可以删掉。指向 `http://rsshub:1200/...` 的信源会抓取失败，先在后台停用。
- **X 搜索、公众号和 Jina**：`x_search`（SocialData）和 `mp_account`（极致了）两种信源、`sources.fetch-x` 和 `sources.mp` 队列、`sources.mp-reconcile` 定时任务、X Article 正文抓取，以及 Jina Reader（`r.jina.ai` 网页列表、正文抓不到时的兜底）都去掉了；采集只剩 `rss`、`web_list`、`json_list`、`external`，正文只读原网页，读不到就标“未确认”。后台新建信源不再有这两种类型，信源页不再显示 X 的续读标记。`.env` 里的 `SOCIALDATA_*`、`DAJIALA_*`、`JINA_*` 不再读，可以删掉。数据库里还有这两种类型的信源的，先在后台停用或改成别的类型。`budgets` 表里这三家的上限不再用，回执记录保留；要清掉上限：`DELETE FROM budgets WHERE service IN ('socialdata', 'dajiala', 'jina');`。没有迁移。
- **主题页**：`/topics`、`/topics/:slug`、`/api/site/topics*`、手机搜索里的“按主题找”（`/api/site/search/suggestions`）和文章页上的主题标签都去掉了；导航里不再有“主题”，`site/site.ts` 去掉 `topicsTitle` 和 `NAV`（它只剩隐藏主题这一个用处）。`industry/topics.json` 只留搜索认得的公司（`slug`、`name`、`entityId`、`aliases`），方向和内容形态两组、分组说明和 `definition` 删掉了；自己改过这个文件的，合并时只保留公司那几项。模块接口里给主题页的部件（`topics`、`topicPage`、`darkMarks`）也去掉了。没有迁移。
- **热榜和事件页**：热榜（`/hot`、首页的当前热点、手机搜索里的“正在热议”、`/api/site/hot`，`hot.rank`、`hot.snapshot` 定时任务）、事件页（`/story/:id`、`/api/site/stories/*`，文章页的“事件后续”和“相关事件”）、事件综述（`events.digest` 队列、模型步骤“事件综述”和 `DIGEST_MODEL`、`industry/prompts/story-digest.md`、综述评测脚本）、事件之间的“相关”关联（`stories.links` 定时任务）和讨论帖挂到事件上算热度（`industry/prompts/group-signal.md`）都去掉了。事件、事实、归组判断、合并、旧事件 id 的别名和后台的事件更正都留着。`hot_signal` 信源照常采集入库，但不再分析、不归组、不公开；后台信源页去掉“讨论分组 ID”。迁移 `0101`–`0105` 删掉 `story_signals`、`story_heat_hourly`、`hot_rankings`、`story_links`、`story_digests`，`0106` 删掉 `sources.signal_group_id`，`0107`–`0112` 删掉 `stories` 的 `digest`、`digest_updated_at`、`latest`、`summary`、`first_report_at`、`latest_at`。`0113` 删掉只有热榜读的 `grouping_overrides.mode`。`site/site.ts` 去掉 `COMMUNITY_FEEDS`。`.env` 里的 `DIGEST_MODEL` 不再读；`settings` 表里的 `models.digest`（如果设过）不再读。pg-boss 里还没跑的 `events.digest` 任务不会再有人处理，可以手动删：`DELETE FROM pgboss.job WHERE name = 'events.digest';`
- **分享图和海报**：`/og/*`（页面、文章、事件、主题的分享图）和文章页的“生成分享海报”都去掉了，页面的分享预览改用站点图标 `icon.png`；`site/site.ts` 去掉 `CARDS`，`assets/og-fonts/` 删除，后端不再依赖 `satori`、`uqr`。数据卷里的 `ogcache/` 目录可以删掉。
- **日报、周报、月报**：`reports.compose` 定时任务、`/daily`、`/weekly`、`/monthly` 和往期页、报头字（`site/brand/nameplates/`、`scripts/nameplates.ts`）、报告分享图、`/api/site/reports/*`，以及模型步骤“周报月报的总述”（`REPORT_MODEL`）都去掉了；`site/site.ts` 去掉 `EDITION_TIMES`、`EDITION_WHEN`、`REPORTS`，`industry/taxonomy.ts` 去掉 `section`、`commentary`、`RELEASE`、`PLAIN_TERMS`，`industry/prompts/report-period*.md` 删除。迁移 `0099`、`0100` 删掉 `report_revisions`、`reports`。`settings` 表里的 `models.report`（如果设过）不再读。
- **对外出口**：公开 API（`/api/v1/*`，含精选同步 `selected/snapshot`、`selected/changes`）、给 Agent 的 Markdown（`/api/v1/agent*`）、`/agent` 页、`/llms.txt`、`/openapi-v1.json`、全部 RSS（`/feed*`）、`/sitemap.xml`、`/robots.txt`、`security.txt`、IndexNow（`seo.indexnow` 定时任务）和后台“标记收录”都去掉了。MCP（`/api/mcp`）留着，只剩 `<前缀>_get_latest`、`<前缀>_search` 两个工具，接口版本升到 5.0.0。迁移 `0092`、`0093` 删掉 `selected_state`、`selected_ledger`，`0094`–`0096` 删掉 `publications` 的 `indexable`、`seo_indexed_at`、`seo_excluded_at`，`0097`、`0098` 删掉只给全文 RSS 用的 `publications.syndicate`、`sources.syndicate_fulltext`。`.env` 里的 `INDEXNOW_SUBMIT_ENABLED`、`INDEXNOW_KEY` 不再读；`site/site.ts` 去掉了 `ACCESS`、`AGENT`、`FEED_COPY`、`POLICY.terms`、`SITE.llmsIntro`、`SITE.contactEmail` 和 `PUBLIC_CATEGORIES.feedLabels`。`settings` 表里的 `selected_ledger_epoch`、`indexnow.watermark` 不再读；数据卷里的 `sitemap-last.xml` 可以删掉。
- **飞书和告警**：飞书内容群推送（`notify.selected` 队列）、内部群告警（`ops.alerts`、`ops.digest`、`reports.source-health`、api 里的 worker 看门狗）和飞书登录后台都去掉了，后台“设置”只剩付费请求上限，“运行”页不再有投递。迁移 `0088`–`0090` 删掉 `delivery_leases`、`deliveries`、`notify_targets` 三张表，`0091` 删掉 `admin_users.feishu_union_id`；飞书登录的旧会话失效，用管理员密码登录。`.env` 里的 `FEISHU_*`、`ADMIN_FEISHU_UNION_IDS`、`ADMIN_EMAILS`、`ALERT_QUIET_MINUTES` 不再读，可以删掉；`site/site.ts` 去掉了 `ALERTS`。`settings` 表里的 `alerts.state`、`watchdog.worker`、`egress.imgproxy` 不再读。
- **读者反馈和几张公开站点的页面**：`/feedback`（连同后台“反馈”页、`feedback.forward` 定时任务）、`/about`（连同 `/contact/*` 二维码和后台的二维码设置）、`/terms`、`/privacy`、`/changelog`（连同红点）和 `/starred`（卡片和文章页上的收藏按钮）都去掉了；`site/pages/`、`site/changelog.json` 删除，`site/site.ts` 去掉 `ABOUT`、`feedback*`、`footerNote`、`POLICY.privacy`。迁移 `0086`、`0087` 删掉 `feedback_bans`、`feedback` 两张表；数据卷里的 `uploads/`、`feedback-screenshots/` 目录不再使用，可以删掉。`settings` 表里的 `contact_qr` 不再读。
- **内置备份**：`ops.backup` 定时任务和 `DB_BACKUP_STORE_*` 都去掉了，`.env` 里的这几项可以删掉；镜像不再带 `pg_dump`。备份改用下方的手动导出或自己的脚本。`settings` 表里的 `backup.last` 不再读，可以手动删：`DELETE FROM settings WHERE key = 'backup.last';`

### 备份

程序不自带备份。数据库用 `pg_dump` 从 db 容器里导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（图片缓存）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

### 管理员会话与配置变更

会话绑定登录时的管理员密码。修改管理员密码或会话密钥后，应重启所有 API 进程，使它们加载相同的新配置；只编辑配置文件不代表正在运行的进程已生效，混用旧代码或旧配置的进程不能提供统一撤权。

有效配置改变后，会话不再接受旧密码的授权；轮换或移除 `SESSION_SECRET` 也会使会话失效。

鉴权时确认失效的会话会被删除，恢复旧配置也不会让它复活。系统不记录全局凭据变更历史：某次配置变化若从未被进程加载，或在恢复前从未被会话检查观察到，不能据此追溯撤销会话。

## 花多少钱

- **模型**：每条新资料先预筛一次；过了预筛的再做一次结构化、写一次标题摘要，然后归组（有相近的报道时才调用）。每天用多少，取决于你的信源每天更新多少条。后台“模型”页能看到每一步的调用次数和输入输出 token 数。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 付费请求上限”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17，系统用 Linux 或 macOS；Windows 上请在 WSL2 里运行，或者用上面的 Docker 方式。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

NODE_ENV=production node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
NODE_ENV=production node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程都要带 `NODE_ENV=production`。api 和 worker 不带它就按开发环境运行：启动时不检查生产密钥和管理员密码，`DEV_AUTH_ROLE` 免登录也会生效。

三个进程要一直运行，生产环境用 systemd 或 pm2 守护（守护配置里同样设 `NODE_ENV=production`）。停止 worker 时至少给它 210 秒（systemd 的 `TimeoutStopSec`、pm2 的 `kill_timeout`），让进行中的付费调用收尾；被提前杀掉的调用结果不明，要等至少半小时自动放行后才会重试。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
