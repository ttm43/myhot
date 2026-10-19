# MyHOT

> A personal AI-news site built on [AIHOT](https://github.com/KKKKhazix/AIHOT) (MIT). Two changes: embedding models take over part of the LLM's work, and the front page follows one reader's likes and dislikes instead of heat.

一个人用的 AI 资讯站，**在 [AIHOT](https://github.com/KKKKhazix/AIHOT)（数字生命卡兹克，MIT 协议）的基础上改的硬分叉**。采集、正文抽取、中文摘要、事件归组、网站和 MCP 是 AIHOT 原有的，用不上的功能已经删掉；「选什么给我看」这一层换成了自己的。部署见 [docs/deploy.md](docs/deploy.md)。

## 留下来的功能

- **采集**：RSS、网页列表、JSON 接口三种信源按各自的间隔抓，外部脚本也可以推送进来（`POST /api/ingest/items`）；同一篇只留一份，缺正文时抓原网页。
- **分析**：预筛（是不是 AI 的事）、结构化（分类、标签、主体公司、新闻事实）、中文标题和摘要。不打分，不判断入选。
- **事件归组**：不同来源报道的同一件事归成一个事件，人工可以拆开、移动、合并。
- **网站**：精选首页、全部动态和搜索、「雷达」页（`/radar`：只收不分析的信源最近三天或七天的原始条目）、文章页（含 Markdown 导出），卡片上有反馈按钮。
- **MCP**：`<前缀>_get_latest`、`<前缀>_search` 两个工具。
- **后台**：内容诊断与人工覆盖、信源、运行、模型、审计、付费请求上限。

## 和 AIHOT 的主要区别

### 1. 向量模型接手一部分 LLM 的活

AIHOT 原本每一步判断都调 LLM。这里能用向量做的就换成向量，LLM 只留在需要读懂全文的地方：

| 原来由 LLM 做 | 现在 | 在哪 |
|---|---|---|
| 每篇文章打分、决定进不进精选 | 本地向量模型（Harrier OSS v1 270M，只用 CPU）+ 线性头。LLM 退成老师，每天只标小模型最拿不准的约 20 篇 | `recommender/scripts/student.py` |
| 判断几篇报道是不是同一件事 | 事件归组用 Gemini `gemini-embedding-2` 向量（`.env` 的 `EMBEDDING_*`，加一处容错补丁）；每日清单再按正文向量余弦 ≥ 0.9 合并 | `packages/backend/src/providers/embeddings.ts`、`recommender/scripts/judge.py daily` |
| 给评价器挑相关的历史反馈 | 按向量相似度检索（`--feedback retrieved:K`） | `recommender/scripts/judge.py` |

LLM 仍然做的事：预筛、结构化和中文摘要，老师标注，同事件二手稿判断。

### 2. 按个人喜恶选，不按热度选

AIHOT 的精选按热度、五个维度加权和来源分级门槛打分，个人博客的门槛比官方来源高，结果个人作者几乎进不了精选。这里把它的评分整个删掉了，精选只看人工覆盖（见 [docs/selection.md](docs/selection.md)）：

- **反馈按钮**（`modules/mark/`）：每张卡片下面有 **牛逼**（对我有用）/ **收到**（了解了，不喜欢也不反感）/ **无聊**（不关心）。卡片上同时显示 AI 的判断和理由，AI 建议的那个按钮虚线高亮，点了就以你为准。
- **评价器**（`recommender/scripts/judge.py`）：读一份用户画像（身份、长期兴趣、评价标准、当前状态、反馈原因五层）、最近的点击和文章全文，预测「这位读者读完会是什么反应」，理由必须指出文章里的具体事实。
- **改写精选**（`judge.py select`）：通过管理覆盖接口设 `selected`：无聊踢出，牛逼和收到留下。同一事件里后来的那篇如果只是转述或引用先来的，也踢出（`recommender/scripts/secondhand.py`）。
- **评测**：用读者盲标的 TEST 集看 precision@20，不看点击率。

细节和实验记录见 [recommender/README.md](recommender/README.md)。

### 3. 画像怎么来：让你最常聊的 AI 来写

评价器读的画像 `recommender/configs/profile.md` 试过好几种来源，最后效果最好、也最省事的，是让你平时聊得最多的那个 AI（作者用的是 ChatGPT）根据它对你的了解写一份，再裁剪。

试过、放弃了的：

- **手写一页关注方向**（「我是谁、什么算增量、什么是噪声」）：太短。模型只能按主题去猜，结果是「做过 OCR 就把所有 OCR 都推给你」。
- **从点击反推画像**（照着 [newscope](https://github.com/umputun/newscope) 的做法：攒够反馈就让模型重写一段偏好总结）：反馈少的时候没东西可总结；反馈多了会写成主题清单，又回到按主题推。它也没有任何防止过度泛化的机制。
- **先定一套评价维度再打分**（内容价值引擎、两层路径加三个打分器）：评价理论发明得太早，对一个人、几百篇候选的场景来说太重，整个推翻了。

最后的做法：

1. **让 AI 写**：请那个和你聊过最多的 AI 写一份完整画像。它见过你问什么、跳过什么、反驳过什么，比你自己写得全，也比从几十次点击里反推出来的准。
2. **按五层裁剪**：身份与现实条件、长期兴趣、评价标准、当前已知、反馈原因。裁剪标准只有一条：不能改变「这篇对我值不值得看」的判断的，就删掉。家庭、财务、作息、沟通偏好这些都删了，一是对判断没用，二是敏感，删掉的内容不进仓库。
3. **按错判再改**：盲标一批文章，看评价器错在哪，一次只改一处。v2 是 GPT 写的画像裁剪后的第一版，v3 到 v5 都是照着错判改的。

量出来的结论：画像是影响最大的一个因素。画像从 v2 改到 v4，TEST 上 precision@20 从 12 升到 14；换反馈例子、改提示词措辞，差别都在噪声以内。模板见 `recommender/configs/profile.example.md`，里面附了一段让 AI 写画像用的提示词。

### 4. 信源怎么挑

信源以数据库为准（后台 `/admin/sources`）。现在开着 49 个参与精选的信源（RSS 35、外部推送 11、网页列表 3），另有 19 个雷达信源；X 和 B 站的 26 个作者由外部脚本经 catbus 推进来。取舍：

- **按实际收进来的标题判断信源，不看名字和简介。** 第一版信源单是 AI 生成的，里面有营销号、厂商产品更新、科普视频和早就不更新的源。每个源看过它真实收进来的标题以后，停了 48 个，降级了 17 个。
- **标准是「对我有用」，不是「重要」或「有名」。** 读论文、学 AI、研究评论类的源停掉了；研究机构的新闻稿降成雷达。剩下的是一手工程经验、实测、独立开发者和真正落地的东西。
- **个人作者和官方来源同一个门槛。** AIHOT 原来按来源分级设门槛（个人博客要 76 分，官方 60 分），结果个人作者一篇都没进过精选。这套评分整个删掉了，精选只看评价器和你的点击。
- **论文不主动扫。** arXiv 的源关掉了，只有别的可信来源指过来的论文才读。Hugging Face Daily Papers 留在雷达里，只收标题。
- **雷达只收不分析。** 想扫一眼但不值得花模型钱的源（GitHub Trending、HF 论文、研究机构新闻）设成 `hot_signal`：不抽正文，不进模型，在 `/radar` 原样列出。
- **去重复和去短内容。** YouTube 源都屏蔽 `/shorts/`；同一个作者的视频和帖子要是在两个源里重复、又都没有正文，只留一个。
- **首次导入不要设得太小。** 信源第一次只导入 N 条，之后只收比加入时间更新的内容。为了省钱设成 3 的那次，有几篇好文章就永远丢了。首次导入至少设 20。

## 和 AIHOT 的关系

2026-10-18 起是硬分叉，不再跟进上游，起点是 AIHOT 2026-10 中旬的版本（提交 `652bd6b`）。删掉的功能（评分、翻译、日报周报月报、热榜和事件页、主题页、公开 API 和 RSS、分享图、飞书、内置备份、X 搜索、公众号、Jina 等）和每项对数据库的影响，见 [docs/deploy.md](docs/deploy.md) 的「硬分叉精简」。

框架代码里还留着的本地改动都标了 `local patch`：

| 改动 | 文件 |
|---|---|
| 反馈模块：`marks`、`mark_events`、`ai_judgments` 三张表，`/api/mark` 接口，卡片上的按钮和 AI 判断 | `modules/mark/`，在 `site/modules/*.ts`、`site/package.json`、`Dockerfile` 里注册 |
| 向量接口容忍缺 `index` 字段（Gemini 的 OpenAI 兼容接口不返回它） | `packages/backend/src/providers/embeddings.ts` |
| 管理覆盖接口多一个 `relevance` 字段，让外部评价器能把预筛挡住的文章放进候选池 | `packages/backend/src/admin/content.ts` |
| 推送接口的条目多一个 `body` 字段，作为正文存下（catbus 拿得到 X 帖子全文，x.com 页面抓不了） | `packages/backend/src/ingest/items.ts` |
| `GET /api/ingest/text?url=`：按原文链接取库里存的正文，带推送接口同一个 token，给自己的外部工具用，免得再抓一遍 | `packages/backend/src/ingest/text.ts`、`apps/api/src/routes/ingest.ts` |
| 推荐层脚本 | `recommender/` |

## 跑起来

1. 按 [docs/deploy.md](docs/deploy.md) 部署：`.env` 里配好 `LLM_*` 和 `EMBEDDING_*`，`MODEL_CALLS_ENABLED=true`（文章要被分析、归组完才能进精选）。
2. `docker compose build api && docker compose up -d`。
3. 推荐层：`cd recommender`，装 `requirements.txt`，把 `configs/profile.example.md` 复制成 `configs/profile.md` 填好，然后按 `recommender/README.md` 跑；定时任务入口是 `recommender/cron.bat`。

## 许可

MIT，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。AIHOT 的代码版权归原作者；「AIHOT」这个名字和 Logo 不在 MIT 授权范围内，这里不使用。
