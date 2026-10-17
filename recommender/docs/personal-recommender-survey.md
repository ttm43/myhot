# 开源「个人推荐引擎」调研（2026-10-16）

## 结论

1. 没有人做出「通用个人推荐引擎」这个产品。开源里要么是大阅读器加关键词过滤，要么是 0 到 50 星的单人管线。
2. 小项目的设计高度趋同：硬过滤 → 向量相似 → LLM 只对短名单打分并给理由；用户模型 = 一段文字画像 + 若干正负例。
3. 几乎没人做评测。只有两个例外，见下。评测集是整个领域最稀缺的东西。

## 候选项目

| 项目 | 星 | 活跃 | 偏好信号 | 打分方式 | 学习 | 评测 |
|---|---|---|---|---|---|---|
| [TideDra/zotero-arxiv-daily](https://github.com/TideDra/zotero-arxiv-daily) | 6.1k / 5.3k fork | 2026-10 | 你的 Zotero 库 | 摘要向量加权余弦，新收藏权重高 | 无 | 无。作者自称算法很简单，可能不反映兴趣 |
| [karpathy/arxiv-sanity-lite](https://github.com/karpathy/arxiv-sanity-lite) | 1.7k | 2023 停更 | 手工打标签 | 每标签一个 SVM over TF-IDF | 标签即标注 | 无 |
| [sansan0/TrendRadar](https://github.com/sansan0/TrendRadar) | 63k | 2026-10 | 关键词/正则 + 兴趣文本 | 热榜词频；AI 过滤 1-10 分 | 无 | 无。本质是热点监控，不是推荐 |
| [Tiendil/feeds.fun](https://github.com/Tiendil/feeds.fun) | 395 | 2026-09，66 open issues | 手写规则 `books+sci-fi -> +5` | LLM 打标签，规则算分 | 无 | 无。作者称过滤掉 80% |
| [umputun/newscope](https://github.com/umputun/newscope) | 55 | 2026-09 | 喜欢/不喜欢按钮 + 主题偏好 | LLM 0-10 分并给解释 | 每 10 条反馈重生成文字画像，50 条反馈例子进提示词 | 无 |
| [m0wer/rssfilter](https://github.com/m0wer/rssfilter) | 46 | 2026-02 | 已读文章 | 向量聚类取相似，混入随机探索 | 隐式 | 无 |
| [koljapluemer/news](https://github.com/koljapluemer/news) | 0 | 2026 | YAML 兴趣句子 | 向量 → 本地 LLM 重排 1-10 + 理由 | 无 | 无 |
| [ghurault/llm-curated-rss-engine](https://github.com/ghurault/llm-curated-rss-engine) | 0 | 2026-10 | 手写编辑方针 | LLM 评 consequence，合并重复报道，每日上限 + 1 条 serendipity | 无 | 无，自称 vibe-coding |
| [CR7SMS/News-Digest](https://github.com/CR7SMS/News-Digest) | 0 | 2026-10 | 提示词里写死读者 | 两段式：标题粗筛 20 → 全文 5 轴打分 | 无 | 有：100 条人工标注，50/50 切分，MAE |
| [PaperFlow](https://arxiv.org/abs/2606.07454)（[代码](https://github.com/OpenRaiser/PaperFlow)） | 学术 | 2026-06 | 研究描述、主页、代表论文 | 四项加权：语义 0.35、主题 0.25、作者机构 0.20、质量 0.20 | 反馈分级 + 漂移状态机 | 24 个模拟用户；5 人真实试点 |

## 值得借的设计

- newscope：反馈 → 重生成文字画像；画像含禁用短语则重生成。这正是防止「做过 OCR 就推所有 OCR」的那种过度泛化。
- PaperFlow：反馈分级（选择/纠正/编辑画像 = 强证据，跳过 = 弱负证据，「不感兴趣」= 显式降权）；漂移需连续两天、至少两次、占比 30% 才切换。
- PaperFlow 消融：固定画像在部分指标上反而比自适应版本高。自适应没有明显收益，先别急着做在线学习。
- CR7SMS：提示词调优把 MAE 从 2.10 降到 1.61；三个前沿模型差距在噪声内（±0.08）。模型不是瓶颈，标注和提示词才是。
- ArXivTok 作者在 [HN](https://news.ycombinator.com/item?id=42947875) 说 LLM 版本成本上不可持续，所以所有人都收敛到漏斗结构。

## 其他看过但不相关

[RSSNext/Folo](https://github.com/RSSNext/Folo)（阅读器，AI 摘要）、[fabriziosalmi/UglyFeed](https://github.com/fabriziosalmi/UglyFeed)（改写聚合）、[leozqin/precis](https://github.com/leozqin/precis)（2024 停更）、[Jian-Lang/personalized-research-paper-claw](https://github.com/Jian-Lang/personalized-research-paper-claw)（纯词法匹配）、[Anish2602/ai-personalized-news-feed](https://github.com/Anish2602/ai-personalized-news-feed)（兴趣向量，0 星）。
