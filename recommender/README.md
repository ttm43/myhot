# 推荐层（recommender/）

MyHOT 和 AIHOT 的区别都在这里：精选不按热度和来源权威选，按一位读者的画像和点击选；日常打分交给本地向量模型，LLM 只当老师。

目录（命令都在这个目录下跑）：

```
recommender/
├── scripts/judge.py        LLM Judge：打分、每日清单、标注表、评测、同步到网站、改写精选
├── scripts/student.py      本地小模型：向量 + 线性头，学老师和你的点击
├── scripts/secondhand.py   同事件二手稿判断（select 时用）
├── scripts/aihot_admin.py  管理接口客户端（登录 + csrf）
├── scripts/judge_compare.py 多个版本的预测并排比
├── config/models.yaml      用哪些向量模型（只写注册表 key）
├── configs/profile.example.md  画像模板，复制成 profile.md 再填（profile*.md 不进 git）
├── docs/                   实验设计、开源方案调研
├── tests/
├── cron.bat                定时任务入口
└── out/                    预测、标注、缓存、日志（不进 git）
```

依赖：MyHOT 在上一级目录跑着（`docker compose up -d`），本机有 Python 3.11+ 和 `requirements.txt` 里的包（Windows 上用 `schtasks /run /tn AutoredInstallDeps` 跑 `install_deps.bat` 来装：在 Claude 里 pip 装的包落在 MSIX 虚拟化目录，计划任务看不到）；小模型的权重通过公共模型库 `models/registry.yaml` 解析（`$MODEL_STORE`，否则往上找第一个 `models/registry.yaml`）。

## LLM Judge（个人推荐第一版）

给定用户画像、历史反馈和文章全文，预测你读完的反应。设计见 `docs/research/recommender-experiment-design.md`。不预设评价维度，但理由必须指出文章里的具体事实，指不出不能给牛逼；触发事实在原文里找不到的自动降一档并标 unverified。

- 用户画像 `configs/profile.md`（v4），反馈 = marks 表 + `out/judge/labels/dev.json`，默认取最近 20 条（`--feedback all|none|recent:N|retrieved:K`）；提示词默认 v1.4（牛逼 = 明显的个人价值，短规则 7；`--prompt-version` 可选 v1.1 / v1.2 / v1.3 做对照）；`--tag` 把预测存成单独文件做对照，`scripts/judge_compare.py v1 v2 ...` 并排比。模型默认 `gemini-3.8-flash`（2026-10-17 起，关思考；环境变量 `JUDGE_MODEL` 或 `--model` 可换，`deepseek-flash` 仍可用）。TEST 73 条上 3.8 Flash 和 DeepSeek 打平（牛逼 P 0.79 / 0.81，p@20 18 / 17），3.1 Flash-Lite 明显差（p@10 6/10，无聊几乎抓不到），不要用来做判断。
- 候选池 = 正文超过 500 字的文章，全文，单篇上限 4 万字，按总字数分批，默认 4 路并发。
- 缓存 `out/judge/preds.json`，键含正文哈希、画像哈希、反馈快照哈希、提示词版本、模型；任一变了就重打。每次运行记在 `out/judge/runs/`。

```bash
python scripts/judge.py score --all            # 全量打分（缓存，重复跑只补新文章）
python scripts/judge.py score --days 7         # 最近 7 天
python scripts/judge.py daily                  # 事件去重 + 整批选择 → out/<日期>/judge.md（先看 ≤15 条 + 完整池；--no-rerank 按分数直接取）
python scripts/judge.py sheet dev              # DEV 标注表 out/judge/labels/dev-sheet.md（分层随机 70 + 金标准 + 已有反馈；--n 改篇数）
python scripts/judge.py sheet test --extra 40  # TEST 标注表（Top 20 + 当天选中 + 40 篇随机未标，盲标；自动编号 test、test2…，import 合并进 test.json）
python scripts/judge.py labels import          # 标注表 → dev.json / test.json（绝不写 marks 表）
python scripts/judge.py eval                   # 指标 → out/judge/eval-<日期>.md
python scripts/judge.py stats                  # 覆盖、三档分布、未核实比例、token
python scripts/judge.py sync --days 30         # 把 AI 判断写进 MyHOT（mark 模块的 ai_judgments 表），卡片上显示
python scripts/judge.py select --days 30       # 让 MyHOT「精选」跟 judge 走：默认把无聊踢出、其余进精选；--keep niubi 只留牛逼
```

**精选 = 去掉无聊**：`select` 对窗口内每篇设 `selected` 覆盖（无聊 false，牛逼和收到 true，AIHOT 自己选的但 judge 判无聊的也踢出）。只留牛逼会让精选趋于大同，2026-10-17 改成去无聊；`--keep niubi` 可切回。被 AIHOT 预筛判成非 AI 的留下文章顺带覆盖 `relevance=pass`，没中文摘要的用 judge 的理由顶上。TEST 73 条上无聊这档 precision 0.71、recall 0.38：错杀少（2 篇收到、0 篇牛逼），漏放多，漏的集中在超大规模基础设施复盘（画像写的是收到，用户实际多标无聊）；把这类改成默认无聊试过（`configs/profile-v6-scale-boring.md`），无聊 recall 升到 0.62 但错杀 2 篇牛逼、牛逼 R 掉到 0.61，弃用。只判无聊的二分类门（`--prompt-version gate-v1/v2/v3`）也试过：召回只能靠杀大规模复盘换，而这类文章用户标签五五开，同样弃用。前提是 AIHOT 的模型调用开着（`MODEL_CALLS_ENABLED=true`，2026-10-17 已重新打开）：文章要被它分析并归组完成才进得了精选，新文章有几小时延迟。状态在 `out/judge/select-state.json`，`--force` 全部重设。

**MyHOT 上的样子**：每张卡片下面一行「AI：牛逼 9 · 理由」（鼠标悬停看触发事实和版本），三个按钮里 AI 选的那个虚线高亮当建议，你点任何一个就是最终反馈（写 marks 表，judge 下次把它当例子）。卡片亮度跟档位走：无聊 0.4、收到 0.72、牛逼全亮加绿色左边。

**一直跑着**：Windows 计划任务 `AutoredJudge` 每 2 小时跑 `cron.bat`（autored 的计划任务 AutoredJudge 转调它），日志在 `out/judge/runs/cron.log`。

## 小模型打分（2026-10-17 起，scripts/student.py）

Gemini 只有每月约 10 刀赠送额度，这台电脑平时还要干别的，所以日常打分交给本地小模型：本地向量（只用 CPU、4 线程）+ 线性头，学老师（上面的 LLM Judge）的判断和你在站上点的反馈（你的权重 ×3）。TEST 73 条上它已经追平老师（实验见 `out/judge/error-analysis-2026-10-16.md` 第六轮）。

```bash
python scripts/student.py run      # 新文章算向量（有缓存）→ 训练 → 预测全池 → out/judge/preds-student-<key>.json
python scripts/student.py teach    # 每天一次：最近 3 天老师没标过的新文章里，挑小模型最拿不准的 20 篇给老师标
python scripts/student.py eval     # 270M vs 0.6B vs 老师：只用你在它们首次预测之后才点的反馈，外加 TEST
```

- 向量模型写在 `config/models.yaml`，权重在公共模型库 `../models/embedding/`，按注册表 key 解析：`student_display` = Harrier OSS v1 270M（结果进 MyHOT），`student_shadow` = Harrier OSS v1 0.6B（只在后台跑，攒够你的点击再比谁好）。
- 判档：最近 30 天候选池里无聊概率最高的 30% 判无聊（`--cut`，精选踢出），牛逼概率最高的 25% 判牛逼（`--niubi-frac`，只影响卡片和先看清单），其余收到。分数 = 5 + 5 ×（牛逼概率 − 无聊概率）。
- 卡片上的「AI」一行写的是两个概率，老师标过的附老师的档位和理由。
- 每篇第一次被预测的结果冻结在 `out/judge/student/first-<key>.json`，评测只拿你在这之后点的反馈比，避免拿训练用过的点击当考题。
- 计划任务的顺序：`student run` → `student teach` → `judge.py --tag student-harrier-oss-v1-270m sync / select / daily`。老师默认 Gemini 3.8 Flash，每天约几万 token。
- 想换回纯 LLM：cron 里去掉 `--tag` 并恢复 `judge.py score --days 3`。

标注表每篇末尾 `标签：` 后填 牛逼 / 收到 / 无聊（牛逼 = 对我有用；收到 = 了解了，不喜欢也不反感；无聊 = 不关心），拿不准留空。评测标签只进 `out/judge/labels/`，实验结束选定方案后才并入 marks。DEV 用来做错误分析，TEST 的 precision@20 才是推荐效果。

