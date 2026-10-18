"""LLM Judge：给定用户画像、历史反馈和文章全文，预测用户读完的反应。设计见 docs/research/recommender-experiment-design.md。

子命令：
    python scripts/judge.py score --all | --days N | --ids a,b     打分（缓存 out/judge/preds.json）
    python scripts/judge.py daily [--days 7]                       整批选择，出 out/<日期>/judge.md
    python scripts/judge.py sheet dev | sheet test                 生成标注表 out/judge/labels/*-sheet.md
    python scripts/judge.py labels import                          标注表 → dev.json / test.json（绝不写 marks 表）
    python scripts/judge.py eval                                   指标报告 out/judge/eval-<日期>.md
    python scripts/judge.py stats                                  覆盖、分布、token

评测标签只存 out/judge/labels/，不进 marks 表。训练反馈 = marks 表现有内容。
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import logging
import os
import random
import re
import subprocess
import sys
import threading
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AIHOT_DIR = ROOT.parent  # recommender/ 放在 MyHOT 仓库根目录下
OUT = ROOT / "out" / "judge"
PREDS = OUT / "preds.json"
RUNS = OUT / "runs"
LABELS_DIR = OUT / "labels"
RECOMMENDED = OUT / "recommended.jsonl"
PROFILE = ROOT / "configs" / "profile.md"

PROMPT_VERSION = "v1.4"  # 牛逼定义放宽（画像 v5）。v1.3 是收窄版，v1.1/v1.2 只留作对照
BODY_CAP = 40_000
BATCH_CHARS = 120_000
MIN_BODY = 500
DEV_RANDOM = 70  # 分层随机部分；按池子比例定（2026-10-16 池子 512 篇，约 13%）
DEV_SEED = 20261016
FUZZY_THRESHOLD = 0.6
LABELS = ("niubi", "received", "boring")
LABEL_ZH = {"niubi": "牛逼", "received": "收到", "boring": "无聊"}
ZH_TO_LABEL = {v: k for k, v in LABEL_ZH.items()} | {"keep": "received", "留": "received", "not_boring": "received"}  # 二分类门的「留」记成收到
# 六条金标准，按标题模式在库里找（不计指标，单独报名次）
GOLDEN = {
    "Google 律师实验": ["Does better work always mean better workers"],
    "GitHub Git 基础设施": ["Building Git infrastructure for agent-scale"],
    # "Simon 语音开发" 2026-10-16 拿掉：用户自己标了收到，GPT 当初选它是口味不是有用
    "Mitchell OSC 7501": ["Terminal Protocol for Program Status"],
    "Cloudflare 安全 agent harness": ["agentic security operations harness"],
    "GitHub ReviewBench": ["ReviewBench"],
}
log = logging.getLogger("judge")
LOCK = threading.Lock()


# ---------- 库与文件 ----------

def psql_json(sql: str) -> list[dict]:
    cmd = ["docker", "compose", "exec", "-T", "db", "psql", "-U", "aihot", "-d", "aihot", "-At", "-c",
           f"select coalesce(json_agg(t), '[]'::json) from ({sql}) t;"]
    proc = subprocess.run(cmd, cwd=AIHOT_DIR, capture_output=True, text=True, encoding="utf-8", timeout=600)
    if proc.returncode != 0:
        raise SystemExit(f"psql 失败: {proc.stderr[:300]}")
    return json.loads(proc.stdout.strip() or "[]")


def ingest_token() -> str:
    """MyHOT 的 INGEST_TOKEN（写 /api/mark/judgments 要带），从 MyHOT 的 .env 读，不打印。"""
    for line in (AIHOT_DIR / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("INGEST_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{AIHOT_DIR / '.env'} 里没有 INGEST_TOKEN")


def sql_list(values) -> str:
    return ",".join("'" + str(v).replace("'", "''") + "'" for v in values) or "''"


POOL_COLUMNS = """a.id, a.url, a.title, a.published_at, s.name as source, a.source_id,
                  date_trunc('week', coalesce(a.published_at, a.discovered_at))::date::text as week"""
POOL_WHERE = f"length(coalesce(a.body_text, '')) > {MIN_BODY} and s.enabled and s.participation_mode = 'editorial'"  # 只看启用的编辑源


def load_pool(ids: list[str] | None = None, days: int | None = None, with_body: bool = True) -> list[dict]:
    body = ", a.body_text as body" if with_body else ", left(a.body_text, 600) as excerpt"
    where = [POOL_WHERE]
    if ids:
        where.append(f"a.id in ({sql_list(ids)})")
    if days:
        where.append(f"a.published_at > now() - interval '{int(days)} days'")
    return psql_json(f"""select {POOL_COLUMNS}{body} from articles a join sources s on s.id = a.source_id
                         where {' and '.join(where)} order by a.published_at desc""")


def load_marks() -> list[dict]:
    return psql_json("""select m.article_id as id, m.label, m.note, m.created_at, a.title, s.name as source,
                               left(coalesce(a.body_text, a.excerpt, ''), 800) as body
                        from marks m join articles a on a.id = m.article_id join sources s on s.id = a.source_id
                        order by m.created_at""")


def resolve_golden() -> dict[str, dict]:
    """金标准名 → 文章（标题模式匹配，找到几条算几条）。"""
    found = {}
    for name, patterns in GOLDEN.items():
        cond = " or ".join(f"a.title ilike '%{p.replace(chr(39), chr(39) * 2)}%'" for p in patterns)
        rows = psql_json(f"select a.id, a.title, a.url from articles a join sources s on s.id = a.source_id where ({cond}) and {POOL_WHERE} order by a.published_at desc limit 1")
        if rows:
            found[name] = rows[0]
    return found


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")


def short_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def feedback_hash(marks: list[dict]) -> str:
    return short_hash(json.dumps(sorted((m["id"], m["label"], m.get("note") or "") for m in marks)))


# ---------- 提示词 ----------

OLD_DEFS_V12 = """- niubi 牛逼：对他有用。读完会改变他的做法、给他一个能拿来用的机制或证据、或者是他下周就会亲手验证的东西。
- received 收到：了解了。有信息，但目前没有很喜欢，也算不上反感；知道有这事即可。这是默认档，大多数正经文章落在这里。
- boring 无聊：不关心。和他的工作与兴趣没有连接，或者他明确反感的那类内容。"""
OLD_DEFS_V11 = """- niubi 牛逼：有意思，想深入读。质量信号，正。
- received 收到：早知道了，没新意，知道有这事即可。质量信号，负。
- boring 无聊：可能有价值，但他不关心。口味信号。"""
RULE7_V12 = "7. 读者已经知道的东西（用户模型 L4）和入门级内容是 received，不是 boring。写得好、有数字、有机制，但读者不会拿它做任何事的文章，也是 received，不是 niubi。"
RULE7_V11 = "7. 读者已经知道的东西（用户模型 L4）和入门级内容是 received，不是 boring。"

JUDGE_PROMPT = """你是一个只为一位读者服务的个性化评价器。你的任务不是评价文章客观上好不好，而是预测这位读者读完之后的反应。

## 读者的用户模型

{profile}

## 读者的历史反馈（他亲手点的，带原因）

{feedback}

## 三档反应的定义

- niubi 牛逼：对他有用。读完会改变他的做法、给他一个能拿来用的机制或证据、或者是他下周就会亲手验证的东西。
- received 收到：了解了。有信息，但目前没有很喜欢，也算不上反感；知道有这事即可。这是默认档，大多数正经文章落在这里。
- boring 无聊：不关心。和他的工作与兴趣没有连接，或者他明确反感的那类内容。

## 规则

1. 只有主题相关不能给 niubi。「读者做过 OCR，所以会喜欢这篇新 OCR 模型」这种理由不成立。必须是文章里的某个具体事实，和用户模型里的某条偏好或历史反馈里的某个原因相连。
2. trigger_fact 必须是文章正文里逐字引用的一句原话（不超过 200 字，不要改写）。指不出具体事实就不能给 niubi。
3. reason 一句话，写清「文章里的哪个事实」连到「读者的哪条偏好」。
4. score 0 到 10 只用于排序：niubi 通常 7 到 10，received 通常 3 到 7，boring 通常 0 到 4，但以你对读者反应的判断为准。
5. confidence：high / mid / low。历史反馈里有直接可比的案例给 high，只能靠用户模型推断给 mid，用户模型也没覆盖的领域给 low。
6. 不同领域一视同仁：一篇 AI 文章可能无聊，一篇非 AI 文章可能牛逼。不要因为作者有名、公司大、技术复杂、Agent 数量多就加分。
7. 读者已经知道的东西（用户模型 L4）和入门级内容是 received，不是 boring。写得好、有数字、有机制，但读者不会拿它做任何事的文章，也是 received，不是 niubi。

只输出 JSON 数组，不要其他文字，不要代码块。每个元素：
{{"n": 编号, "label": "niubi|received|boring", "score": 0-10, "reason": "...", "trigger_fact": "原文原话", "confidence": "high|mid|low"}}

## 本批文章

{items}"""

# v1.1：旧三档定义（想深入 / 早知道 / 有价值但不关心），其余相同。留着做对照。
JUDGE_PROMPT_V11 = JUDGE_PROMPT.replace(OLD_DEFS_V12, OLD_DEFS_V11).replace(RULE7_V12, RULE7_V11)
# v1.3：新三档定义（和画像一致）+ v1.1 的短规则 7。v1.2 规则 7 的第二句压召回，去掉。
JUDGE_PROMPT_V13 = JUDGE_PROMPT.replace(RULE7_V12, RULE7_V11)
# v1.4：牛逼定义放宽到「明显的个人价值」（和画像 v5 一致），其余同 v1.3。
DEFS_V14 = """- niubi 牛逼：这篇文章让他获得明显的个人价值。价值可以是直接改变做法、获得可迁移的工程机制、发现重要的新能力或实验证据、或者形成新的认知和判断。不要求下周就能用，但必须有具体且足够强的信息增量。仅仅相关、复杂、或来自知名机构不够。
- received 收到：了解了。有信息，但目前没有很喜欢，也算不上反感；知道有这事即可。这是默认档，大多数正经文章落在这里。
- boring 无聊：不关心。和他的工作与兴趣没有连接，或者他明确反感的那类内容。"""
JUDGE_PROMPT_V14 = JUDGE_PROMPT_V13.replace(OLD_DEFS_V12, DEFS_V14)
PROMPTS = {"v1.1": JUDGE_PROMPT_V11, "v1.2": JUDGE_PROMPT, "v1.3": JUDGE_PROMPT_V13, "v1.4": JUDGE_PROMPT_V14}

# 二分类门：只判「无聊 / 留」。精选 = 去掉无聊之后，三档评价器的无聊召回只有 0.38；试试把任务收窄成一个问题。
# gate-v1 中性问法；gate-v2 明说错杀比漏放贵，拿不准就留。「留」在预测文件里记成 received，分数 = 值得留的程度，便于复用评测。
GATE_PROMPT_V1 = """你是一个只为一位读者服务的过滤器。你只回答一个问题：这位读者会不会对这篇文章说「无聊」。不评价文章好不好，不分牛逼和收到。

## 读者的用户模型

{profile}

## 读者的历史反馈（他亲手点的，带原因）

{feedback}

## 「无聊」的定义

无聊 = 不关心。和他的工作与兴趣没有连接，或者他明确反感的那类内容（营销稿、功能罗列、公关式复盘、和他的规模和问题无关的超大规模基础设施复盘、纯消费和生活类内容）。
不是无聊 = 他读了至少会说「了解了」，哪怕没有很喜欢。有信息、和他的工作或兴趣有连接、或者是他明确列为爱看的类型，就不是无聊。

## 规则

1. 判断依据是正文里的具体内容，不是标题和来源。
2. reason 一句话，写清文章里的哪个事实让你判它无聊或不无聊，和用户模型里的哪一条相连。
3. score 0 到 10 是「值得留下」的程度：无聊通常 0 到 3，留通常 5 到 10。
4. confidence：high / mid / low。历史反馈里有直接可比的案例给 high，只能靠用户模型推断给 mid，用户模型没覆盖的领域给 low。
5. 不要因为作者有名、公司大、技术复杂就留；也不要因为是 AI 话题就留。领域一视同仁。

只输出 JSON 数组，不要其他文字，不要代码块。每个元素：
{{"n": 编号, "label": "boring|keep", "score": 0-10, "reason": "...", "confidence": "high|mid|low"}}

## 本批文章

{items}"""
GATE_PROMPT_V2 = GATE_PROMPT_V1.replace(
    "5. 不要因为作者有名、公司大、技术复杂就留；也不要因为是 AI 话题就留。领域一视同仁。",
    "5. 不要因为作者有名、公司大、技术复杂就留；也不要因为是 AI 话题就留。领域一视同仁。\n6. 这个过滤器的输出直接决定文章会不会从他的精选里消失。错杀一篇他想看的，比漏放一篇无聊的代价大得多。拿不准就留，只有确定他不关心才判无聊。")
# gate-v3：定义里不把超大规模复盘列为无聊。TEST 上这类文章用户一半无聊一半不无聊，gate-v1 的 7 篇错杀里 5 篇是它；错杀比漏放贵，所以不默认杀。
GATE_PROMPT_V3 = GATE_PROMPT_V1.replace(
    "（营销稿、功能罗列、公关式复盘、和他的规模和问题无关的超大规模基础设施复盘、纯消费和生活类内容）",
    "（营销稿、功能罗列、公关式复盘、纯消费和生活类内容）").replace(
    "5. 不要因为作者有名、公司大、技术复杂就留；也不要因为是 AI 话题就留。领域一视同仁。",
    "5. 不要因为作者有名、公司大、技术复杂就留；也不要因为是 AI 话题就留。领域一视同仁。" + "\n" +
    "6. 超大规模基础设施的复盘（大厂的 serving、存储、调度、监控系统）不因为规模不是他的就判无聊：这类文章他一半会说了解了。只有当文章既没有可迁移的机制、也没有他爱看的特征（反直觉实测、失败复盘、有立场的经验）时才判无聊。")
PROMPTS |= {"gate-v1": GATE_PROMPT_V1, "gate-v2": GATE_PROMPT_V2, "gate-v3": GATE_PROMPT_V3}

DAILY_PROMPT = """下面是最近 {days} 天里评价器判为值得看的候选，每条有编号、档位、分数、标题、来源和理由。另外列出了最近 14 天已经推荐过的标题。

请挑出最多 {k} 条「先看」。要求：
- 不凑数，当天好东西少就少挑。
- 同一件事、同一个主题不要连续多条；已经推荐过的同一事件不要再推。
- 留 1 到 3 条读者可能没想到自己会喜欢的探索项（领域不同、但理由站得住）。
- 每条给一句选中理由，二十字以内。

只输出 JSON 数组，不要其他文字：[{{"n": 编号, "why": "..."}}]

## 最近 14 天已推荐
{recent}

## 候选
{items}"""


def render_feedback(marks: list[dict]) -> str:
    if not marks:
        return "（还没有反馈）"
    return "\n\n".join(
        f"- [{LABEL_ZH[m['label']]}] {m['title']} · {m['source']}" + (f"\n  读者备注：{m['note']}" if m.get("note") else "")
        + f"\n  正文开头：{(m.get('body') or '').strip()[:800]}"
        for m in marks
    )


def article_block(i: int, a: dict, related: str = "") -> str:
    body = (a.get("body") or "").strip()
    note = ""
    if len(body) > BODY_CAP:
        note = f"\n（正文已截断，原文 {len(body)} 字，下面是前 {BODY_CAP} 字）"
        body = body[:BODY_CAP]
    rel = f"\n和这篇最相关的历史反馈：\n{related}\n" if related else ""
    return f"[{i}] {a['title']}\n来源：{a['source']}  日期：{str(a.get('published_at'))[:10]}{note}{rel}\n正文：\n{body}"


def parse_json(text: str):
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.S)
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < 0:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


# ---------- 模型 ----------

class Gemini:
    def __init__(self, model: str) -> None:
        from google import genai

        self.client = genai.Client()
        self.model = model
        self.calls = 0
        self.tokens = Counter()

    def ask(self, prompt: str, temperature: float = 0.0):
        from google.genai import types

        for attempt in range(3):
            self.calls += 1
            try:
                # 关思考：短结构化任务不需要，思考 token 按输出计费（和 DeepSeek 关思考同理）
                resp = self.client.models.generate_content(
                    model=self.model, contents=prompt,
                    config=types.GenerateContentConfig(temperature=temperature, thinking_config=types.ThinkingConfig(thinking_budget=0)),
                )
            except Exception as exc:  # 429 限流、5xx 等：退避重试
                log.warning("Gemini 调用失败（%s），重试 %d", str(exc)[:120], attempt + 1)
                time.sleep(5 * (attempt + 1))
                continue
            usage = resp.usage_metadata
            with LOCK:
                self.tokens["prompt"] += getattr(usage, "prompt_token_count", 0) or 0
                self.tokens["cached"] += getattr(usage, "cached_content_token_count", 0) or 0
                self.tokens["output"] += (getattr(usage, "candidates_token_count", 0) or 0) + (getattr(usage, "thoughts_token_count", 0) or 0)
                self.tokens["total"] += getattr(usage, "total_token_count", 0) or 0
            rows = parse_json(resp.text or "")
            if rows is not None:
                return rows
            log.warning("解析失败，重试 %d", attempt + 1)
            time.sleep(2)
        return None


class OpenAICompat:
    """OpenAI 兼容接口（DeepSeek 等），只用标准库。环境变量 DEEPSEEK_API_KEY。"""

    def __init__(self, model: str, base_url: str = "https://api.deepseek.com/v1", key_env: str = "DEEPSEEK_API_KEY") -> None:
        import urllib.request

        self.key = os.environ.get(key_env) or ""
        if not self.key:
            raise SystemExit(f"环境变量 {key_env} 未设置")
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.model = model
        self.calls = 0
        self.tokens = Counter()
        self._request = urllib.request

    def ask(self, prompt: str, temperature: float = 0.0):
        import urllib.error

        payload = {"model": self.model, "temperature": temperature, "max_tokens": 8000,
                   "messages": [{"role": "user", "content": prompt}],
                   # DeepSeek 默认开思考，短结构化任务要关掉（和 AIHOT 的 LLM_EXTRA_JSON 一致）
                   "thinking": {"type": "disabled"}}
        for attempt in range(4):
            self.calls += 1
            req = self._request.Request(self.url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                        headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
            try:
                with self._request.urlopen(req, timeout=600) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                body = exc.read().decode("utf-8", "ignore")[:300]
                if exc.code in (429, 500, 502, 503) and attempt < 3:
                    wait = 5 * (attempt + 1)
                    log.warning("HTTP %d，%d 秒后重试：%s", exc.code, wait, body)
                    time.sleep(wait)
                    continue
                raise SystemExit(f"模型调用失败 HTTP {exc.code}: {body}")
            usage = data.get("usage") or {}
            with LOCK:
                self.tokens["prompt"] += usage.get("prompt_tokens", 0)
                self.tokens["output"] += usage.get("completion_tokens", 0)
                self.tokens["total"] += usage.get("total_tokens", 0)
                self.tokens["cache_hit"] += usage.get("prompt_cache_hit_tokens", 0)
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            rows = parse_json(text)
            if rows is not None:
                return rows
            log.warning("解析失败，重试 %d", attempt + 1)
            time.sleep(2)
        return None


def make_llm(model: str):
    return Gemini(model) if model.startswith("gemini") else OpenAICompat(model)


# ---------- 触发事实核验 ----------

def normalize(text: str) -> str:
    return re.sub(r"[\s\"'“”‘’`*_\-—–·,，。.;；:：!！?？()（）\[\]【】]", "", text).lower()


def split_sentences(body: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[。.!?！？\n])\s*", body) if len(s.strip()) > 10]


def verify_fact(fact: str, body: str) -> tuple[bool, float]:
    """trigger_fact 能否在正文里找到：先规范化子串，再逐句模糊匹配。"""
    if not fact or not body:
        return False, 0.0
    nf, nb = normalize(fact), normalize(body)
    if len(nf) >= 8 and nf in nb:
        return True, 1.0
    best = 0.0
    for sent in split_sentences(body):
        ns = normalize(sent)
        if not ns or abs(len(ns) - len(nf)) > max(len(nf), 40) * 3:
            continue
        m = difflib.SequenceMatcher(None, nf, ns)
        if m.quick_ratio() < FUZZY_THRESHOLD:
            continue
        best = max(best, m.ratio())
        if best >= 0.95:
            break
    return best >= FUZZY_THRESHOLD, round(best, 3)


# ---------- 向量检索（实验 C：按相关性挑反馈例子） ----------

EMB_PATH = OUT / "embeddings.json"
EMB_MODEL = "gemini-embedding-2"
EMB_DIMS = 768


def emb_text(a: dict) -> str:
    return f"{a.get('title') or ''}\n\n{(a.get('body') or '')[:3000]}"


def embed_texts(texts: list[str]) -> list[list[float]]:
    from google import genai
    from google.genai import types

    client = genai.Client()
    resp = client.models.embed_content(model=EMB_MODEL, contents=[types.Content(parts=[types.Part(text=t)]) for t in texts],
                                       config=types.EmbedContentConfig(output_dimensionality=EMB_DIMS))
    vecs = [list(e.values) for e in resp.embeddings]
    if len(vecs) != len(texts):
        raise SystemExit(f"embedding 返回 {len(vecs)} 条，期望 {len(texts)}")
    return vecs


def ensure_embeddings(articles: list[dict]) -> dict[str, list[float]]:
    """缓存在 out/judge/embeddings.json，按 标题+正文前 3000 字 的哈希判断是否要重算。"""
    store = read_json(EMB_PATH, {})
    todo = [a for a in articles if store.get(a["id"], {}).get("hash") != short_hash(emb_text(a))]
    for i in range(0, len(todo), 40):
        chunk = todo[i:i + 40]
        for a, v in zip(chunk, embed_texts([emb_text(a) for a in chunk])):
            store[a["id"]] = {"hash": short_hash(emb_text(a)), "vec": [round(x, 6) for x in v]}
        write_json(EMB_PATH, store)
        log.info("embedding %d/%d", min(i + 40, len(todo)), len(todo))
    return {a["id"]: store[a["id"]]["vec"] for a in articles if a["id"] in store}


def cosine(u: list[float], v: list[float]) -> float:
    dot = sum(x * y for x, y in zip(u, v))
    nu = sum(x * x for x in u) ** 0.5 or 1.0
    nv = sum(x * x for x in v) ** 0.5 or 1.0
    return dot / (nu * nv)


def retrieve_related(pool: list[dict], marks: list[dict], k: int) -> dict[str, str]:
    """每篇候选 → 最相似的 k 条反馈，渲染成文字。"""
    vecs = ensure_embeddings(pool + marks)
    fb = [m for m in marks if m["id"] in vecs]
    out = {}
    for a in pool:
        if a["id"] not in vecs:
            continue
        scored = sorted(((cosine(vecs[a["id"]], vecs[m["id"]]), m) for m in fb if m["id"] != a["id"]), key=lambda t: -t[0])[:k]
        out[a["id"]] = "\n".join(f"- [{LABEL_ZH[m['label']]}] {m['title']} · {m['source']}（相似度 {sim:.2f}）" + (f"  备注：{m['note']}" if m.get("note") else "")
                                 for sim, m in scored)
    return out


def select_feedback(marks: list[dict], mode: str) -> list[dict]:
    """all | none | recent:N。recent 按时间倒序，标签文件里的例子算 2026-10-16。"""
    if mode == "none":
        return []
    if mode.startswith("recent:"):
        n = int(mode.split(":", 1)[1])
        return sorted(marks, key=lambda m: str(m.get("created_at") or ""), reverse=True)[:n]
    return marks


# ---------- score ----------

def make_batches(articles: list[dict]) -> list[list[dict]]:
    batches, cur, size = [], [], 0
    for a in articles:
        n = min(len(a.get("body") or ""), BODY_CAP) + len(a.get("title") or "")
        if cur and size + n > BATCH_CHARS:
            batches.append(cur)
            cur, size = [], 0
        cur.append(a)
        size += n
    if cur:
        batches.append(cur)
    return batches


def judge_batch(llm, profile: str, feedback: str, batch: list[dict], prompt: str = JUDGE_PROMPT, related: dict[str, str] | None = None) -> dict[str, dict]:
    related = related or {}
    items = "\n\n".join(article_block(i + 1, a, related.get(a["id"], "")) for i, a in enumerate(batch))
    rows = llm.ask(prompt.format(profile=profile, feedback=feedback, items=items))
    if rows is None:
        if len(batch) == 1:
            log.error("单篇也解析失败：%s", batch[0]["title"][:60])
            return {}
        half = len(batch) // 2
        return {**judge_batch(llm, profile, feedback, batch[:half], prompt, related), **judge_batch(llm, profile, feedback, batch[half:], prompt, related)}
    out = {}
    by_n = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        try:
            by_n[int(r.get("n", 0))] = r
        except (TypeError, ValueError):
            continue
    for i, a in enumerate(batch):
        r = by_n.get(i + 1)
        if not r:
            log.warning("模型没返回 #%d %s", i + 1, a["title"][:50])
            continue
        label = str(r.get("label") or "").strip().lower()
        label = ZH_TO_LABEL.get(label, label)
        if label not in LABELS:
            label = "received"
        try:
            score = max(0.0, min(10.0, float(r.get("score", 0))))
        except (TypeError, ValueError):
            score = 0.0
        fact = str(r.get("trigger_fact") or "").strip()[:300]
        verified, sim = verify_fact(fact, a.get("body") or "")
        original = label
        if not verified and label == "niubi":
            label, score = "received", max(0.0, score - 2)
        out[a["id"]] = {
            "title": a["title"], "source": a["source"], "url": a["url"], "published_at": str(a.get("published_at"))[:10],
            "label": label, "original_label": original, "score": score,
            "reason": str(r.get("reason") or "").strip(), "trigger_fact": fact, "confidence": str(r.get("confidence") or "mid"),
            "verified": verified, "fact_similarity": sim,
        }
    return out


def extra_examples(path: str) -> list[dict]:
    """把一份标签文件（如 out/judge/labels/dev.json）变成反馈例子，格式同 marks。实验 B 用。"""
    labels = read_json(Path(path), {})
    if not labels:
        return []
    rows = psql_json(f"""select a.id, a.title, s.name as source, left(coalesce(a.body_text, a.excerpt, ''), 800) as body
                        from articles a join sources s on s.id = a.source_id where a.id in ({sql_list(labels)})""")
    return [{**r, "label": labels[r["id"]]["label"], "note": labels[r["id"]].get("note"), "created_at": "label"} for r in rows]


def cmd_score(args) -> int:
    profile_path = Path(args.profile) if args.profile else PROFILE
    profile = profile_path.read_text(encoding="utf-8")
    prompt = PROMPTS[args.prompt_version]
    marks = load_marks()
    if args.examples:
        extra = extra_examples(args.examples)
        seen = {m["id"] for m in marks}
        marks = marks + [{**e, "created_at": "2026-10-16T23:59:59"} for e in extra if e["id"] not in seen]
        log.info("反馈池：marks %d + 标签 %d", len(seen), len(marks) - len(seen))
    mode = args.feedback
    shown = select_feedback(marks, mode)
    ph = short_hash(profile)
    fh = feedback_hash(marks if mode.startswith("retrieved") else shown)
    ids = [x for x in (args.ids or "").split(",") if x.strip()] or None
    pool = load_pool(ids=ids, days=None if args.all or ids else args.days)
    preds = read_json(PREDS, {})
    stamp = {"profile_hash": ph, "feedback_hash": fh, "feedback_mode": mode, "prompt_version": args.prompt_version,
             "model": args.model, "body_cap": BODY_CAP}

    def cached(a: dict) -> bool:
        p = preds.get(a["id"])
        return bool(p) and not args.refresh and p.get("content_hash") == short_hash(a.get("body") or "") \
            and all(p.get(k) == v for k, v in stamp.items())

    todo = [a for a in pool if not cached(a)]
    log.info("候选 %d 篇，已缓存 %d，待打 %d | 画像 %s 提示词 %s 反馈 %s", len(pool), len(pool) - len(todo), len(todo), profile_path.name, args.prompt_version, mode)
    if not todo:
        return 0
    related: dict[str, str] = {}
    if mode.startswith("retrieved:"):
        related = retrieve_related(todo, marks, int(mode.split(":", 1)[1]))
        feedback = "（每篇文章下方单独列出和它最相关的历史反馈）"
    else:
        feedback = render_feedback(shown)
    llm = make_llm(args.model)
    started = datetime.now(timezone.utc)
    batches = make_batches(todo)
    judged = 0
    from concurrent.futures import ThreadPoolExecutor, as_completed

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool_exec:
        futures = {pool_exec.submit(judge_batch, llm, profile, feedback, batch, prompt, related): batch for batch in batches}
        for bi, fut in enumerate(as_completed(futures), 1):
            batch = futures[fut]
            try:
                results = fut.result()
            except SystemExit as exc:
                log.error("批失败：%s", exc)
                results = {}
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            for a in batch:
                r = results.get(a["id"])
                if r:
                    preds[a["id"]] = {**r, **stamp, "content_hash": short_hash(a.get("body") or ""), "judged_at": now}
                    judged += 1
            write_json(PREDS, preds)
            log.info("批 %d/%d：%d 篇 → %d 条 | 累计 token %d", bi, len(batches), len(batch), len(results), llm.tokens["total"])
    meta = {**stamp, "profile": str(profile_path), "articles": len(todo), "judged": judged, "calls": llm.calls, "tokens": dict(llm.tokens),
            "feedback_count": len(marks) if mode.startswith("retrieved") else len(shown), "started": started.isoformat(timespec="seconds"),
            "finished": datetime.now(timezone.utc).isoformat(timespec="seconds"), "preds_file": PREDS.name}
    write_json(RUNS / f"{started.strftime('%Y%m%dT%H%M%S')}.json", meta)
    log.info("完成：%d 篇，%d 次调用，%d token", judged, llm.calls, llm.tokens["total"])
    return 0


# ---------- daily ----------

def recent_recommended(days: int = 14) -> list[dict]:
    if not RECOMMENDED.exists():
        return []
    floor = (date.today() - timedelta(days=days)).isoformat()
    rows = [json.loads(line) for line in RECOMMENDED.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [r for r in rows if r.get("date", "") >= floor]


def dedupe_events(candidates: list[tuple[str, dict]], threshold: float = 0.9) -> tuple[list[tuple[str, dict]], dict[str, list[str]]]:
    """同一件事只留分最高的一篇：标题归一化相同，或正文向量余弦 ≥ threshold。返回 (去重后的候选, 被合并的 id→标题列表)。"""
    if not candidates:
        return candidates, {}
    rows = load_pool(ids=[i for i, _ in candidates])
    by_id = {a["id"]: a for a in rows}
    vecs = ensure_embeddings([by_id[i] for i, _ in candidates if i in by_id])
    kept: list[tuple[str, dict]] = []
    merged: dict[str, list[str]] = {}
    for i, p in sorted(candidates, key=lambda kv: kv[1]["score"], reverse=True):
        dup_of = None
        for j, q in kept:
            same_title = normalize(p["title"]) == normalize(q["title"])
            sim = cosine(vecs[i], vecs[j]) if i in vecs and j in vecs else 0.0
            if same_title or sim >= threshold:
                dup_of = j
                break
        if dup_of:
            merged.setdefault(dup_of, []).append(f"{p['title']} · {p['source']}")
        else:
            kept.append((i, p))
    if merged:
        log.info("事件去重：%d 篇并入 %d 组", sum(len(v) for v in merged.values()), len(merged))
    return kept, merged


def cmd_daily(args) -> int:
    preds = read_json(PREDS, {})
    pool_ids = {a["id"] for a in load_pool(with_body=False)}  # 只看启用的编辑源
    day = args.date or date.today().isoformat()
    floor = (date.fromisoformat(day) - timedelta(days=args.days)).isoformat()
    window = {i: p for i, p in preds.items() if p.get("published_at", "") >= floor and i in pool_ids}
    pool = sorted(window.items(), key=lambda kv: (-kv[1]["score"], kv[1]["published_at"]), reverse=False)
    pool = sorted(pool, key=lambda kv: kv[1]["score"], reverse=True)
    candidates = [(i, p) for i, p in pool if p["label"] == "niubi" or (p["label"] == "received" and p["score"] >= 7)]
    candidates, merged = dedupe_events(candidates)
    recent = recent_recommended()
    picks: dict[int, str] = {}
    if candidates and args.no_rerank:
        picks = {n: "按分数直接取" for n in range(1, min(args.k, len(candidates)) + 1)}
    elif candidates:
        llm = make_llm(args.model)
        listing = "\n".join(f"[{n}] {LABEL_ZH[p['label']]} {p['score']:.0f} | {p['title']} · {p['source']} | {p['reason']}"
                            for n, (_, p) in enumerate(candidates, 1))
        rows = llm.ask(DAILY_PROMPT.format(days=args.days, k=args.k, items=listing,
                                           recent="\n".join(f"- {r['title']}" for r in recent) or "（无）"), temperature=0.2) or []
        for r in rows:
            try:
                n = int(r.get("n", 0))
            except (TypeError, ValueError):
                continue
            if 1 <= n <= len(candidates):
                picks[n] = str(r.get("why") or "")
        log.info("候选 %d，选出 %d，token %d", len(candidates), len(picks), llm.tokens["total"])
    out_dir = ROOT / "out" / day
    out_dir.mkdir(parents=True, exist_ok=True)
    marks_n = len(load_marks())
    labels = {**read_json(LABELS_DIR / "dev.json", {}), **read_json(LABELS_DIR / "test.json", {})}
    pick_items = [candidates[n - 1] for n in sorted(picks)]
    srcs = Counter(p["source"] for _, p in pick_items)
    labeled = [(i, p) for i, p in pick_items if i in labels]
    hit = sum(1 for i, _ in labeled if labels[i]["label"] == "niubi")
    diversity = f"来源 {len(srcs)} 个，最多一家 {max(srcs.values()) if srcs else 0} 条；事件去重并掉 {sum(len(v) for v in merged.values())} 篇；选中项里已标注 {len(labeled)} 篇，其中牛逼 {hit}"
    log.info("先看 %d：%s", len(picks), diversity)
    lines = [f"# Judge {day} · 最近 {args.days} 天 {len(pool)} 篇 · 候选 {len(candidates)} · 先看 {len(picks)}（{'按分数' if args.no_rerank else '整批重排'}）", "", diversity, ""]
    if picks:
        lines += [f"## 先看（{len(picks)}）", ""]
        for n in sorted(picks):
            i, p = candidates[n - 1]
            lines.append(f"- **[{LABEL_ZH[p['label']]} {p['score']:.0f}] {p['title']}** · {p['source']} · {p['published_at']}")
            lines.append(f"  - 为什么先看：{picks[n]}")
            lines.append(f"  - 理由：{p['reason']}")
            lines.append(f"  - 触发事实：{p['trigger_fact'][:160]}{'' if p['verified'] else '（未在原文核实）'}")
            if merged.get(i):
                lines.append(f"  - 同一事件已合并：{'；'.join(merged[i])}")
            lines.append(f"  - {p['url']}")
        lines.append("")
    lines += [f"## 完整池（{len(pool)}，按分数）", ""]
    for n, (i, p) in enumerate(pool, 1):
        lines.append(f"- #{n} [{LABEL_ZH[p['label']]} {p['score']:.0f}] {p['title'][:80]} · {p['source']} · {p['reason'][:100]}")
    lines += ["", "---", f"画像 {preds and next(iter(preds.values())).get('profile_hash')} · 反馈 {marks_n} 条 · 提示词 {PROMPT_VERSION}", ""]
    (out_dir / "judge.md").write_text("\n".join(lines), encoding="utf-8")
    if picks:
        with RECOMMENDED.open("a", encoding="utf-8") as f:
            for n in sorted(picks):
                i, p = candidates[n - 1]
                f.write(json.dumps({"date": day, "id": i, "title": p["title"], "why": picks[n]}, ensure_ascii=False) + "\n")
    print(out_dir / "judge.md")
    return 0


# ---------- sheets ----------

def allocate(sizes: dict[str, int], total: int) -> dict[str, int]:
    """按 sqrt(篇数) 分名额，最大余数法凑整，每个来源不超过它的篇数。"""
    import math

    weights = {s: math.sqrt(n) for s, n in sizes.items()}
    wsum = sum(weights.values())
    raw = {s: total * w / wsum for s, w in weights.items()}
    quota = {s: min(sizes[s], int(raw[s])) for s in sizes}
    rest = total - sum(quota.values())
    for s in sorted(sizes, key=lambda s: raw[s] - int(raw[s]), reverse=True):
        if rest <= 0:
            break
        if quota[s] < sizes[s]:
            quota[s] += 1
            rest -= 1
    return quota


def stratified(pool: list[dict], total: int, rng: random.Random) -> list[dict]:
    by_source: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for a in pool:
        by_source[a["source_id"]][a.get("week") or "?"].append(a)
    quota = allocate({s: sum(len(v) for v in weeks.values()) for s, weeks in by_source.items()}, total)
    chosen = []
    for src in sorted(by_source):
        weeks = by_source[src]
        buckets = {w: rng.sample(weeks[w], len(weeks[w])) for w in sorted(weeks)}
        n = quota[src]
        while n > 0:
            for w in sorted(buckets):
                if buckets[w] and n > 0:
                    chosen.append(buckets[w].pop())
                    n -= 1
    return chosen


def clean(text: str, n: int) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:n]


def render_sheet(title: str, rows: list[dict], blind: bool) -> str:
    lines = [f"# {title} · {len(rows)} 篇", "",
             "每篇最后一行 `标签：` 后填一个：牛逼 / 收到 / 无聊（或 niubi / received / boring）。牛逼 = 对我有用；收到 = 了解了，目前没有很喜欢，也算不上反感；无聊 = 不关心。拿不准留空。可以在标签后面空一格写备注。", ""]
    for r in rows:
        flags = []
        if r.get("golden"):
            flags.append(f"金标准：{r['golden']}，不计指标")
        if r.get("mark_label"):
            flags.append("训练反馈，不计指标")
        lines += [f"## [{r['n']}] {r['title']}", f"{r['source']} · {str(r.get('published_at'))[:10]} · {r['url']}"]
        if flags:
            lines.append("（" + "；".join(flags) + "）")
        lines += [f"摘要：{clean(r.get('excerpt'), 300)}", "", f"标签：{LABEL_ZH.get(r.get('mark_label'), '') if r.get('mark_label') else ''}", ""]
    return "\n".join(lines) + "\n"


def cmd_sheet(args) -> int:
    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    if args.which == "dev":
        sheet, sample = LABELS_DIR / "dev-sheet.md", LABELS_DIR / "dev-sample.json"
        if sheet.exists() and not args.force:
            raise SystemExit(f"{sheet} 已存在，重抽加 --force（会覆盖已填的标签）")
        pool = load_pool(with_body=False)
        golden = resolve_golden()
        marks = {m["id"]: m for m in load_marks()}
        must = {a["id"] for a in golden.values()} | set(marks)
        rng = random.Random(DEV_SEED)
        rows = {a["id"]: a for a in stratified([a for a in pool if a["id"] not in must], args.n, rng)}
        by_id = {a["id"]: a for a in pool}
        for name, g in golden.items():
            if g["id"] in by_id:
                rows[g["id"]] = {**by_id[g["id"]], "golden": name}
        for i, m in marks.items():
            if i in by_id:
                rows[i] = {**by_id[i], **rows.get(i, {}), "mark_label": m["label"], "mark_note": m.get("note")}
        ordered = sorted(rows.values(), key=lambda r: (r.get("week") or "", r["source"], r["id"]))
        final = [{**r, "n": i + 1} for i, r in enumerate(ordered)]
        sheet.write_text(render_sheet("DEV 标注表", final, blind=False), encoding="utf-8")
        write_json(sample, [{k: r.get(k) for k in ("n", "id", "url", "title", "source", "source_id", "week", "published_at", "golden", "mark_label")} for r in final])
        print(f"{sheet}：{len(final)} 篇，{len({r['source'] for r in final})} 个来源，金标准 {len(golden)}/{len(GOLDEN)}，训练反馈 {len(marks)}")
        return 0
    # test：全量 Top 20 + 最近一次 daily 的选中项，去掉 DEV 里的，盲标
    preds = read_json(PREDS, {})
    if not preds:
        raise SystemExit("先跑 score")
    pool_ids = {a["id"] for a in load_pool(with_body=False)}
    ranked = sorted(((i, p) for i, p in preds.items() if i in pool_ids), key=lambda kv: kv[1]["score"], reverse=True)
    ids = [i for i, _ in ranked[: args.k]]
    recent = recent_recommended(days=1000)
    if recent:
        last_day = max(r["date"] for r in recent)
        ids += [r["id"] for r in recent if r["date"] == last_day]
    dev_ids = {r["id"] for r in read_json(LABELS_DIR / "dev-sample.json", [])}
    for f in LABELS_DIR.glob("test*-sample.json"):
        dev_ids |= {r["id"] for r in read_json(f, [])}
    dev_ids |= set(read_json(LABELS_DIR / "test.json", {})) | set(read_json(LABELS_DIR / "dev.json", {}))
    if args.extra:
        full = [a for a in load_pool(with_body=False) if a["id"] not in dev_ids and a["id"] not in set(ids)]
        ids += [a["id"] for a in stratified(full, args.extra, random.Random(DEV_SEED + 7))]
    seen, keep = set(), []
    for i in ids:
        if i in preds and i not in dev_ids and i not in seen:
            seen.add(i)
            keep.append(i)
    pool = {a["id"]: a for a in load_pool(ids=keep, with_body=False)}
    rng = random.Random(DEV_SEED + 1)
    rng.shuffle(keep)
    final = [{**pool[i], "n": n + 1} for n, i in enumerate(keep) if i in pool]
    name = args.name
    if not name:
        n = 1
        while (LABELS_DIR / f"{'test' if n == 1 else f'test{n}'}-sheet.md").exists():
            n += 1
        name = "test" if n == 1 else f"test{n}"
    sheet, sample = LABELS_DIR / f"{name}-sheet.md", LABELS_DIR / f"{name}-sample.json"
    if sheet.exists() and not args.force:
        raise SystemExit(f"{sheet} 已存在，换 --name 或加 --force")
    sheet.write_text(render_sheet(f"{name.upper()} 标注表（盲标：不显示分数和名次）", final, blind=True), encoding="utf-8")
    write_json(sample, [{k: r.get(k) for k in ("n", "id", "url", "title", "source", "published_at")} for r in final])
    print(f"{sheet}：{len(final)} 篇（Top {args.k} 加当天选中，去掉 DEV 重叠）。标完 labels import 会并入 test.json")
    return 0


# ---------- labels ----------

def parse_sheet(text: str) -> dict[int, dict]:
    out, n = {}, None
    for line in text.splitlines():
        m = re.match(r"## \[(\d+)\]", line)
        if m:
            n = int(m.group(1))
            continue
        m = re.match(r"标签[：:]\s*(\S+)?\s*(.*)$", line)
        if m and n is not None and m.group(1):
            raw = m.group(1).strip().lower()
            label = ZH_TO_LABEL.get(m.group(1).strip(), raw)
            if label in LABELS:
                out[n] = {"label": label, "note": m.group(2).strip() or None}
    return out


def cmd_labels(args) -> int:
    """每张 <name>-sheet.md 读一遍：dev 写 dev.json；test、test2… 合并进 test.json（只增不删，同一篇以最新表为准）。"""
    total = 0
    merged_test = read_json(LABELS_DIR / "test.json", {})
    for sheet in sorted(LABELS_DIR.glob("*-sheet.md")):
        which = sheet.name[: -len("-sheet.md")]
        sample = LABELS_DIR / f"{which}-sample.json"
        by_n = {r["n"]: r for r in read_json(sample, [])}
        labels = {}
        for n, v in parse_sheet(sheet.read_text(encoding="utf-8")).items():
            if n in by_n:
                labels[by_n[n]["id"]] = {**v, "title": by_n[n]["title"], "sheet": which}
        if which == "dev":
            write_json(LABELS_DIR / "dev.json", labels)
        else:
            merged_test.update(labels)
        print(f"{which}: {len(labels)} 条标签")
        total += len(labels)
    write_json(LABELS_DIR / "test.json", merged_test)
    print(f"test.json 合计 {len(merged_test)} 条（所有 TEST 表合并）")
    if total == 0:
        print("两张表都还没填")
    return 0


# ---------- eval ----------

def prf(cm: dict[tuple[str, str], int]) -> dict[str, dict[str, float]]:
    out = {}
    for c in LABELS:
        tp = cm.get((c, c), 0)
        fp = sum(v for (t, p), v in cm.items() if p == c and t != c)
        fn = sum(v for (t, p), v in cm.items() if t == c and p != c)
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
        out[c] = {"precision": prec, "recall": rec, "f1": f1, "support": tp + fn}
    return out


def cmd_eval(args) -> int:
    preds = read_json(PREDS, {})
    dev, test = read_json(LABELS_DIR / "dev.json", {}), read_json(LABELS_DIR / "test.json", {})
    marks = {m["id"] for m in load_marks()}
    golden = resolve_golden()
    excluded = marks | {g["id"] for g in golden.values()}
    day = date.today().isoformat()
    lines = [f"# Judge 评测 {day}", ""]
    for name, labels in (("DEV", dev), ("TEST", test)):
        usable = {i: v for i, v in labels.items() if i in preds and i not in excluded}
        lines += [f"## {name}：{len(labels)} 条标签，计指标 {len(usable)} 条（排除训练反馈和金标准）", ""]
        if len(usable) < 30:
            lines += ["（标签不足 30 条，数字只作参考）", ""]
        if not usable:
            continue
        cm = Counter((v["label"], preds[i]["label"]) for i, v in usable.items())
        lines += ["真实 \\ 预测 | " + " | ".join(LABEL_ZH[p] for p in LABELS), "---|---|---|---"]
        for t in LABELS:
            lines.append(f"{LABEL_ZH[t]} | " + " | ".join(str(cm.get((t, p), 0)) for p in LABELS))
        lines.append("")
        stats = prf(cm)
        lines += ["类别 | precision | recall | f1 | n", "---|---|---|---|---"]
        for c in LABELS:
            s = stats[c]
            lines.append(f"{LABEL_ZH[c]} | {s['precision']:.2f} | {s['recall']:.2f} | {s['f1']:.2f} | {s['support']}")
        macro = sum(s["f1"] for s in stats.values()) / len(LABELS)
        lines += ["", f"macro F1 {macro:.2f}", ""]
        if name == "TEST":
            ranked = sorted(usable, key=lambda i: preds[i]["score"], reverse=True)
            for k in (10, 20):
                top = ranked[:k]
                hits = sum(1 for i in top if usable[i]["label"] == "niubi")
                lines.append(f"precision@{k}：{hits}/{len(top)}")
            lines.append("")
    # 金标准名次（全量排序）
    pool_ids = {a["id"] for a in load_pool(with_body=False)}
    ranked_all = sorted((i for i in preds if i in pool_ids), key=lambda i: preds[i]["score"], reverse=True)
    pos = {i: n + 1 for n, i in enumerate(ranked_all)}
    lines += [f"## 金标准在候选池排序里的名次（共 {len(ranked_all)} 篇）", ""]
    for name, g in golden.items():
        p = preds.get(g["id"])
        lines.append(f"- {name}：" + (f"第 {pos[g['id']]} 名 · {LABEL_ZH[p['label']]} {p['score']:.0f} · {p['reason'][:80]}" if p else "未打分"))
    lines.append("")
    niubi = [p for p in preds.values() if p["original_label"] == "niubi"]
    if niubi:
        ok = sum(1 for p in niubi if p["verified"])
        lines += [f"## 事实支持率", "", f"模型给 niubi 的 {len(niubi)} 篇里，触发事实在原文核实通过 {ok} 篇（{ok / len(niubi):.0%}）；未通过的已降为收到。", ""]
    path = OUT / (f"eval-{day}-{args.tag}.md" if args.tag else f"eval-{day}.md")
    lines.insert(1, f"预测文件：{PREDS.name}")
    path.write_text("\n".join(lines), encoding="utf-8")
    print(path)
    return 0


# ---------- sync：把 AI 判断写进 MyHOT（mark 模块的 ai_judgments 表） ----------

AIHOT_URL = os.environ.get("AIHOT_URL", "http://localhost:3000")


def cmd_sync(args) -> int:
    import urllib.request

    preds = read_json(PREDS, {})
    if not preds:
        print("还没有预测")
        return 0
    pool_ids = {a["id"] for a in load_pool(with_body=False)}
    floor = (date.today() - timedelta(days=args.days)).isoformat() if args.days else ""
    items = [{"id": i, "label": p["label"], "score": p["score"], "reason": p.get("reason"), "trigger_fact": p.get("trigger_fact"),
              "version": f"{p.get('prompt_version')}+{p.get('profile_hash', '')[:6]}"}
             for i, p in preds.items() if i in pool_ids and p.get("published_at", "") >= floor]
    written = 0
    for i in range(0, len(items), 400):
        body = json.dumps({"items": items[i:i + 400]}).encode("utf-8")
        req = urllib.request.Request(f"{AIHOT_URL}/api/mark/judgments", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {ingest_token()}"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            written += json.loads(resp.read().decode("utf-8")).get("written", 0)
    print(f"同步 {len(items)} 条 AI 判断到 MyHOT，写入 {written}")
    return 0


# ---------- select：让 MyHOT 的「精选」跟 judge 走（走 AIHOT 的人工覆盖接口）。默认去掉无聊：只留牛逼会让精选趋于大同 ----------

SELECT_STATE = OUT / "select-state.json"
SECONDHAND_CACHE = OUT / "secondhand.json"


def find_secondhand_drops(want: dict[str, bool], model: str) -> dict[str, dict]:
    """要留的文章里，同一 AIHOT 事件有两篇以上的，查后来的是不是先来那篇的二手稿（见 scripts/secondhand.py）。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from secondhand import cached_verdict, find_secondhand

    keep_ids = [i for i, v in want.items() if v]
    rows = psql_json(f"select article_id as id, story_id from publications where story_id is not null and article_id in ({sql_list(keep_ids)})")
    sizes = Counter(r["story_id"] for r in rows)
    story_of = {r["id"]: r["story_id"] for r in rows if sizes[r["story_id"]] > 1}
    if not story_of:
        return {}
    members = [{**a, "story_id": story_of[a["id"]]} for a in load_pool(ids=list(story_of))]
    cache = read_json(SECONDHAND_CACHE, {})
    llm = make_llm(model)
    dropped = find_secondhand(members, cached_verdict(llm, cache, short_hash))
    write_json(SECONDHAND_CACHE, cache)
    titles = {a["id"]: f"{a['title'][:40]} · {a['source']}" for a in members}
    log.info("同事件二手稿：%d 个事件 %d 篇里踢出 %d 篇（模型调用 %d 次）", len(set(story_of.values())), len(members), len(dropped), llm.calls)
    for i, d in dropped.items():
        log.info("  二手 %s ← 原稿 %s：%s", titles[i], titles.get(d["of"], d["of"]), d["reason"][:80])
    return dropped


def cmd_select(args) -> int:
    """对候选池里最近 N 天的文章设 selected 覆盖。--keep not-boring（默认）：无聊踢出、其余进精选；--keep niubi：只留牛逼。
    只对变化的篇目调接口，状态记在 select-state.json。
    AIHOT 仍要求文章被它自己分析过（relevance=pass、有摘要）且归组完成，否则即使 selected=true 也进不了精选；这些会在结果里报出来。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from aihot_admin import Admin  # 登录 + csrf

    preds = read_json(PREDS, {})
    pool_ids = {a["id"] for a in load_pool(with_body=False)}
    floor = (date.today() - timedelta(days=args.days)).isoformat()
    keep = (lambda l: l == "niubi") if args.keep == "niubi" else (lambda l: l != "boring")
    want = {i: keep(p["label"]) for i, p in preds.items() if i in pool_ids and p.get("published_at", "") >= floor}
    # AIHOT 自己选中、但 judge 没留的，也踢出精选（包括不在候选池的文章）
    for row in psql_json(f"select article_id from publications where selected and published_at > now() - interval '{int(args.days)} days'"):
        want.setdefault(row["article_id"], False)
    secondhand = {} if args.no_secondhand else find_secondhand_drops(want, args.model)
    want = {i: v and i not in secondhand for i, v in want.items()}
    state = read_json(SELECT_STATE, {})
    if args.force:
        state = {}
    todo = {i: v for i, v in want.items() if state.get(i) != v}
    log.info("精选同步（%s）：%d 篇在窗口内，留 %d，%d 篇需要改", args.keep, len(want), sum(want.values()), len(todo))
    if not todo:
        return 0
    admin = Admin()
    admin.login()
    changed, blocked, failed = 0, [], []
    for i, selected in todo.items():
        chain = admin.get(f"/api/admin/content/{i}")
        version = (chain.get("override") or {}).get("version") or 0
        fields: dict = {"selected": selected}
        if selected:
            # 被 AIHOT 预筛挡住（非 AI 相关）或还没中文摘要的，用 judge 的理由顶上，让它够得上入池条件
            fields["relevance"] = "pass"
            if not (chain.get("publication") or {}).get("summary"):
                # 小模型的预测文件带 summary_fallback（老师的理由或正文开头），它的 reason 是概率，不适合当摘要
                fields["summary"] = (preds[i].get("summary_fallback") or preds[i].get("reason") or "")[:600]
        label = preds.get(i, {}).get("label", "-")
        score = preds.get(i, {}).get("score", 0)
        reason = f"judge 二手稿，原稿 {secondhand[i]['of']}" if i in secondhand else f"judge {label} {score:.0f}"
        res = admin.post(f"/api/admin/content/{i}/override", {"fields": fields, "reason": reason, "version": version})
        if "_error" in res:
            failed.append((i, res.get("_body", "")[:80]))
            continue
        state[i] = selected
        changed += 1
        pub = res if isinstance(res, dict) else {}
        if selected and pub.get("selected") is False:
            blocked.append(preds[i]["title"][:60])
        time.sleep(0.05)
    write_json(SELECT_STATE, state)
    print(f"改了 {changed} 篇；该留但 AIHOT 侧还进不了精选（未分析或未归组）{len(blocked)} 篇；失败 {len(failed)}")
    for t in blocked[:10]:
        print("  等分析：", t)
    for i, e in failed[:5]:
        print("  失败：", i, e)
    return 0


# ---------- stats ----------

def cmd_stats(args) -> int:
    preds = read_json(PREDS, {})
    if not preds:
        print("还没有预测")
        return 0
    print(f"已打分 {len(preds)} 篇")
    print("三档：", {LABEL_ZH[k]: v for k, v in Counter(p["label"] for p in preds.values()).items()})
    print("模型原判：", {LABEL_ZH[k]: v for k, v in Counter(p["original_label"] for p in preds.values()).items()})
    unv = sum(1 for p in preds.values() if not p["verified"])
    print(f"触发事实未核实 {unv} 篇（{unv / len(preds):.0%}）")
    print("置信度：", dict(Counter(p.get("confidence") for p in preds.values())))
    src = Counter()
    for p in preds.values():
        if p["label"] == "niubi":
            src[p["source"]] += 1
    print("牛逼最多的来源：", src.most_common(10))
    tokens = Counter()
    for f in sorted(RUNS.glob("*.json")) if RUNS.exists() else []:
        tokens.update(read_json(f, {}).get("tokens", {}))
    print("累计 token：", dict(tokens))
    return 0


# ---------- main ----------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("JUDGE_MODEL", "gemini-3.8-flash"), help="gemini-3.8-flash（默认，2026-10-17 起；Gemini 每月有赠送额度）、deepseek-flash 或其他 gemini-*。3.1 Flash-Lite 在 TEST 上明显差（p@10 6/10、无聊几乎抓不到），不要用来做判断")
    parser.add_argument("--tag", default="", help="预测文件后缀：out/judge/preds-<tag>.json，用来并排跑多个版本")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("score")
    p.add_argument("--all", action="store_true")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--ids", default="")
    p.add_argument("--refresh", action="store_true", help="忽略缓存重打")
    p.add_argument("--workers", type=int, default=4, help="并发批数")
    p.add_argument("--examples", default=str(LABELS_DIR / "dev.json"), help="反馈池补充：一份标签 json。默认 DEV 标签；TEST 标签永远不进来。传空串关闭")
    p.add_argument("--feedback", default="recent:20", help="反馈模式：all | none | recent:N | retrieved:K（按向量相似度每篇挑 K 条）。消融里 B/C 和 A 差距在噪声内，默认取最便宜的 recent:20")
    p.add_argument("--profile", default="", help="画像文件，默认 configs/profile.md")
    p.add_argument("--prompt-version", default=PROMPT_VERSION, choices=["v1.1", "v1.2", "v1.3", "v1.4", "gate-v1", "gate-v2", "gate-v3"], help="v1.1 旧定义 / v1.2 新定义+长规则7 / v1.3 新定义+短规则7 / v1.4 牛逼放宽（默认）/ gate-v1、gate-v2 只判无聊的二分类门")
    p.set_defaults(fn=cmd_score)
    p = sub.add_parser("daily")
    p.add_argument("--date", default="")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--k", type=int, default=15)
    p.add_argument("--no-rerank", action="store_true", help="不做整批重排，按分数直接取前 k（实验 D 的对照）")
    p.set_defaults(fn=cmd_daily)
    p = sub.add_parser("sheet")
    p.add_argument("which", choices=["dev", "test"])
    p.add_argument("--force", action="store_true")
    p.add_argument("--k", type=int, default=20)
    p.add_argument("--n", type=int, default=DEV_RANDOM, help="DEV 分层随机篇数")
    p.add_argument("--name", default="", help="TEST 表的名字（test、test2…），默认自动取下一个未用的")
    p.add_argument("--extra", type=int, default=0, help="TEST 表再加 N 篇分层随机、没标过的文章")
    p.set_defaults(fn=cmd_sheet)
    p = sub.add_parser("labels")
    p.add_argument("action", choices=["import"])
    p.set_defaults(fn=cmd_labels)
    sub.add_parser("eval").set_defaults(fn=cmd_eval)
    p = sub.add_parser("select", help="让 MyHOT 精选跟 judge 走（AIHOT 人工覆盖接口）：默认去掉无聊，--keep niubi 只留牛逼")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--keep", choices=["not-boring", "niubi"], default="not-boring", help="not-boring：无聊踢出、其余进精选（默认）；niubi：只留牛逼")
    p.add_argument("--force", action="store_true", help="忽略 select-state.json，全部重设")
    p.add_argument("--no-secondhand", action="store_true", help="不查同事件二手稿（默认查：同一事件里后来那篇只是转述/引用先来那篇的，踢出精选）")
    p.set_defaults(fn=cmd_select)
    p = sub.add_parser("sync", help="把预测写进 MyHOT 的 ai_judgments 表，卡片上显示")
    p.add_argument("--days", type=int, default=0, help="只同步最近 N 天发布的（0 = 全部）")
    p.set_defaults(fn=cmd_sync)
    sub.add_parser("stats").set_defaults(fn=cmd_stats)
    args = parser.parse_args()
    if args.tag:
        global PREDS
        PREDS = OUT / f"preds-{args.tag}.json"
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    for name in ("httpx", "google_genai"):
        logging.getLogger(name).setLevel(logging.WARNING)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
