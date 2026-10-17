"""小模型打分：本地向量（只用 CPU）+ 线性头，学老师（judge.py 的 LLM 判断）和你在站上点的反馈。

为什么：Gemini 只有每月约 10 刀赠送额度，这台电脑平时还要干别的，打分要本地、不占显卡。
2026-10-17 在 TEST 73 条上，学老师几百条判断的小模型已经追平老师本身（out/judge/error-analysis-2026-10-16.md 第六轮）。

用法：
    python scripts/student.py run      # 算新文章的向量（有缓存）→ 训练 → 预测全池 → 写 out/judge/preds-student-<key>.json
    python scripts/student.py teach    # 每天一次：挑小模型最拿不准的 N 篇新文章交给老师（judge.py score --ids）
    python scripts/student.py eval     # 各学生和老师对比：只看你在它们首次预测之后才点的反馈，外加 TEST

用哪些向量模型写在 config/models.yaml（student_display 的结果进 MyHOT，student_shadow 只在后台攒数据）。
预测文件的格式和 judge 的一样，所以 `judge.py --tag student-<key> sync|select|daily` 直接用。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge  # noqa: E402  复用库查询、路径和预测文件格式

ROOT = judge.ROOT
OUT = judge.OUT
SDIR = OUT / "student"
TEACHER_PREDS = OUT / "preds.json"
def find_model_store() -> Path:
    """公共模型库：$MODEL_STORE，否则往上找第一个带 models/registry.yaml 的目录。"""
    if os.environ.get("MODEL_STORE"):
        return Path(os.environ["MODEL_STORE"])
    for parent in ROOT.parents:
        if (parent / "models" / "registry.yaml").exists():
            return parent / "models"
    raise SystemExit("找不到模型库：设 MODEL_STORE，或把 models/registry.yaml 放在上级目录")


MODEL_STORE = find_model_store()

THREADS = int(os.environ.get("STUDENT_THREADS", "4"))  # 只用 4 个线程，后台跑不影响前台
MAX_TOKENS = 1024
USER_WEIGHT = 3.0  # 你点的反馈比老师的标签重
WINDOW_DAYS = 30  # 阈值按最近 30 天的候选池定，和 select 的窗口一致
EVAL_SINCE = "2026-10-17"  # 这天起的点击才拿来比较学生
SHORT = {"harrier-oss-v1-270m": "Harrier 270M", "harrier-oss-v1-0.6b": "Harrier 0.6B"}
# 实验时算过的向量（同一套文本、同样 1024 token 截断），第一次跑直接拿来当缓存
SEED = {"harrier-oss-v1-270m": OUT / "emb-harrier-270m.json", "harrier-oss-v1-0.6b": OUT / "emb-harrier-0.6b.json"}

log = logging.getLogger("student")


# ---------- 配置 ----------

def student_keys() -> dict[str, str]:
    """role → 注册表 key，读 config/models.yaml。"""
    import yaml

    spec = yaml.safe_load((ROOT / "config" / "models.yaml").read_text(encoding="utf-8"))
    return {role: key for role, key in (spec.get("uses") or {}).items() if role.startswith("student_")}


def model_path(key: str) -> Path:
    sys.path.insert(0, str(MODEL_STORE))
    from model_registry import path_of

    return Path(path_of(key))


def tag_of(key: str) -> str:
    return f"student-{key}"


# ---------- 数据 ----------

def psql_stdin(sql: str) -> list[dict]:
    """同 judge.psql_json，但 SQL 走标准输入：id 列表会越来越长，命令行在 Windows 上有 32K 字符上限。"""
    cmd = ["docker", "compose", "exec", "-T", "db", "psql", "-U", "aihot", "-d", "aihot", "-At", "-v", "ON_ERROR_STOP=1"]
    wrapped = f"select coalesce(json_agg(t), '[]'::json) from ({sql}) t;"
    proc = subprocess.run(cmd, cwd=judge.AIHOT_DIR, input=wrapped, capture_output=True, text=True, encoding="utf-8", timeout=600)
    if proc.returncode != 0:
        raise SystemExit(f"psql 失败: {proc.stderr[:300]}")
    return json.loads(proc.stdout.strip() or "[]")


def load_articles() -> dict[str, dict]:
    """候选池全部文章 + 所有带标签的文章（老师、你的点击、DEV、TEST），正文只取前 3000 字。"""
    labeled = set(judge.read_json(TEACHER_PREDS, {})) | set(judge.read_json(judge.LABELS_DIR / "dev.json", {})) \
        | set(judge.read_json(judge.LABELS_DIR / "test.json", {})) | {m["id"] for m in judge.load_marks()}
    rows = psql_stdin(f"""select a.id, a.title, a.url, a.published_at, s.name as source,
                                      left(coalesce(a.body_text, a.excerpt, ''), 3000) as body, ({judge.POOL_WHERE}) as in_pool
                               from articles a join sources s on s.id = a.source_id
                               where ({judge.POOL_WHERE}) or a.id in ({judge.sql_list(labeled)})""")
    return {r["id"]: r for r in rows}


def user_labels(test_ids: set[str]) -> dict[str, dict]:
    """你的标签：DEV + 站上的点击（点击覆盖 DEV）。TEST 永远不进训练。"""
    out = {i: {"label": v["label"], "at": "2026-10-16T00:00:00"} for i, v in judge.read_json(judge.LABELS_DIR / "dev.json", {}).items()}
    for m in judge.load_marks():
        out[m["id"]] = {"label": m["label"], "at": str(m["created_at"])}
    return {i: v for i, v in out.items() if i not in test_ids}


# ---------- 向量 ----------

class Embedder:
    def __init__(self, key: str) -> None:
        self.key = key
        self.path = SDIR / f"emb-{key}.json"
        self.cache: dict[str, dict] = judge.read_json(self.path, {})
        self.model = None

    def _load(self):
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(THREADS)
        self.model = SentenceTransformer(str(model_path(self.key)), device="cpu")
        self.model.max_seq_length = MAX_TOKENS

    def ensure(self, texts: dict[str, str]) -> tuple[dict[str, np.ndarray], int]:
        if not self.cache and SEED.get(self.key, Path("-")).exists():
            seed = judge.read_json(SEED[self.key], {})
            self.cache = {i: {"h": judge.short_hash(texts[i]), "v": v} for i, v in seed.items() if i in texts}
            log.info("%s：从实验向量导入 %d 篇", self.key, len(self.cache))
        todo = [i for i, t in texts.items() if self.cache.get(i, {}).get("h") != judge.short_hash(t)]
        if todo:
            started = time.time()
            if self.model is None:
                self._load()
            for k in range(0, len(todo), 16):
                chunk = todo[k:k + 16]
                vecs = self.model.encode([texts[i] for i in chunk], batch_size=8, normalize_embeddings=True, show_progress_bar=False)
                for i, v in zip(chunk, vecs):
                    self.cache[i] = {"h": judge.short_hash(texts[i]), "v": [round(float(x), 6) for x in v]}
            judge.write_json(self.path, self.cache)
            log.info("%s：新算 %d 篇，%.0f 秒（%d 线程）", self.key, len(todo), time.time() - started, THREADS)
        vecs = {i: np.asarray(c["v"], dtype=float) for i, c in self.cache.items() if i in texts}
        return vecs, len(todo)


# ---------- 训练与预测 ----------

def train_heads(vecs: dict[str, np.ndarray], teacher: dict, users: dict, test_ids: set[str]):
    from sklearn.linear_model import LogisticRegression

    ids = [i for i in set(teacher) | set(users) if i in vecs and i not in test_ids]
    label = {i: (users[i]["label"] if i in users else teacher[i]["label"]) for i in ids}
    weight = np.array([USER_WEIGHT if i in users else 1.0 for i in ids])
    X = np.stack([vecs[i] for i in ids])
    heads = {}
    for target in ("boring", "niubi"):
        y = np.array([1 if label[i] == target else 0 for i in ids])
        clf = LogisticRegression(C=1.0, class_weight="balanced", max_iter=3000)
        clf.fit(X, y, sample_weight=weight)
        heads[target] = clf
    return heads, {"n_train": len(ids), "n_user": sum(1 for i in ids if i in users)}


def auc(scores: list[float], positive: list[bool]) -> float | None:
    pos = [s for s, p in zip(scores, positive) if p]
    neg = [s for s, p in zip(scores, positive) if not p]
    if len(pos) < 2 or len(neg) < 2:
        return None
    return sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))


def test_metrics(pb: dict, pn: dict, test: dict) -> dict:
    ids = [i for i in test if i in pb]
    if not ids:
        return {}
    truth = [test[i]["label"] for i in ids]
    order = sorted(ids, key=lambda i: -pb[i])[: round(len(ids) * 0.3)]
    top = sorted(ids, key=lambda i: -pn[i])[:20]
    return {"n": len(ids), "boring_auc": auc([pb[i] for i in ids], [t == "boring" for t in truth]),
            "niubi_auc": auc([pn[i] for i in ids], [t == "niubi" for t in truth]),
            "cut30": {lab: sum(1 for i in order if test[i]["label"] == lab) for lab in judge.LABELS},
            "niubi_p20": sum(1 for i in top if test[i]["label"] == "niubi")}


def decide(pb: float, pn: float, tb: float, tn: float) -> str:
    over_b, over_n = pb - tb, pn - tn
    if over_b >= 0 and over_b >= over_n:
        return "boring"
    if over_n >= 0:
        return "niubi"
    return "received"


def view_entry(key: str, a: dict, pb: float, pn: float, lab: str, teacher: dict) -> dict:
    t = teacher.get(a["id"])
    reason = f"{SHORT.get(key, key)}：牛逼 {pn:.0%}，无聊 {pb:.0%}"
    if t:
        reason += f" · 老师判{judge.LABEL_ZH[t['label']]}：{t.get('reason', '')}"
    return {"title": a["title"], "source": a["source"], "url": a["url"], "published_at": str(a.get("published_at"))[:10],
            "label": lab, "original_label": lab, "score": round(min(10.0, max(0.0, 5 + 5 * (pn - pb))), 2),
            "reason": reason, "trigger_fact": (t or {}).get("trigger_fact", ""), "confidence": "mid", "verified": True,
            "p_boring": round(pb, 4), "p_niubi": round(pn, 4), "prompt_version": tag_of(key), "profile_hash": "",
            "summary_fallback": (t or {}).get("reason") or (a.get("body") or "")[:200]}


def freeze_first(key: str, preds: dict[str, dict], now: str) -> None:
    """每篇第一次被预测时的结果冻结下来，评测只拿你在这之后才点的反馈比，避免拿训练过的点击当考题。"""
    path = SDIR / f"first-{key}.json"
    first = judge.read_json(path, {})
    added = 0
    for i, p in preds.items():
        if i not in first:
            first[i] = {"pb": p["p_boring"], "pn": p["p_niubi"], "label": p["label"], "at": now}
            added += 1
    judge.write_json(path, first)
    log.info("%s：冻结首次预测 %d 篇（累计 %d）", key, added, len(first))


def freeze_teacher(teacher: dict) -> None:
    path = SDIR / "first-teacher.json"
    first = judge.read_json(path, {})
    for i, p in teacher.items():
        first.setdefault(i, {"label": p["label"], "score": p["score"], "at": p.get("judged_at") or "2026-10-16T00:00:00", "model": p.get("model")})
    judge.write_json(path, first)


def cmd_run(args) -> int:
    SDIR.mkdir(parents=True, exist_ok=True)
    arts = load_articles()
    texts = {i: judge.emb_text(a) for i, a in arts.items()}
    teacher = judge.read_json(TEACHER_PREDS, {})
    test = judge.read_json(judge.LABELS_DIR / "test.json", {})
    users = user_labels(set(test))
    freeze_teacher(teacher)
    floor = (date.today() - timedelta(days=WINDOW_DAYS)).isoformat()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for role, key in student_keys().items():
        started = time.time()
        vecs, new = Embedder(key).ensure(texts)
        heads, info = train_heads(vecs, teacher, users, set(test))
        ids = list(vecs)
        X = np.stack([vecs[i] for i in ids])
        pb = dict(zip(ids, heads["boring"].predict_proba(X)[:, 1]))
        pn = dict(zip(ids, heads["niubi"].predict_proba(X)[:, 1]))
        window = [i for i in ids if arts[i]["in_pool"] and str(arts[i].get("published_at") or "")[:10] >= floor] or ids
        tb = float(np.quantile([pb[i] for i in window], 1 - args.cut))
        tn = float(np.quantile([pn[i] for i in window], 1 - args.niubi_frac))
        preds = {i: view_entry(key, arts[i], float(pb[i]), float(pn[i]), decide(pb[i], pn[i], tb, tn), teacher)
                 for i in ids if arts[i]["in_pool"]}
        judge.write_json(OUT / f"preds-{tag_of(key)}.json", preds)
        freeze_first(key, preds, now)
        tm = test_metrics(pb, pn, test)
        meta = {"key": key, "role": role, "trained_at": now, **info, "embedded_new": new, "threshold_boring": round(tb, 4),
                "threshold_niubi": round(tn, 4), "cut": args.cut, "niubi_frac": args.niubi_frac, "window_articles": len(window),
                "labels": {lab: sum(1 for p in preds.values() if p["label"] == lab) for lab in judge.LABELS}, "test": tm,
                "seconds": round(time.time() - started, 1), "threads": THREADS}
        judge.write_json(SDIR / f"meta-{key}.json", meta)
        log.info("%s（%s）：训练 %d 篇（你的 %d），候选池 %d 篇 %s；TEST 无聊 AUC %s，牛逼 p@20 %s/20；%.0f 秒",
                 key, role, info["n_train"], info["n_user"], len(preds), meta["labels"],
                 f"{tm.get('boring_auc'):.2f}" if tm.get("boring_auc") is not None else "-", tm.get("niubi_p20", "-"), meta["seconds"])
    return 0


# ---------- 老师：每天只标少量拿不准的 ----------

def cmd_teach(args) -> int:
    state_path = SDIR / "teach-state.json"
    state = judge.read_json(state_path, {})
    today = date.today().isoformat()
    if state.get("last") == today and not args.force:
        log.info("今天已经请老师标过（%s），跳过", state.get("ids_count"))
        return 0
    display = student_keys().get("student_display")
    preds = judge.read_json(OUT / f"preds-{tag_of(display)}.json", {})
    meta = judge.read_json(SDIR / f"meta-{display}.json", {})
    if not preds or not meta:
        log.info("还没有学生预测，先跑 run")
        return 0
    teacher = judge.read_json(TEACHER_PREDS, {})
    marked = {m["id"] for m in judge.load_marks()}
    floor = (date.today() - timedelta(days=args.days)).isoformat()
    fresh = {i: p for i, p in preds.items() if p["published_at"] >= floor and i not in teacher and i not in marked}
    tb, tn = meta["threshold_boring"], meta["threshold_niubi"]
    near_b = sorted(fresh, key=lambda i: abs(fresh[i]["p_boring"] - tb))
    near_n = sorted(fresh, key=lambda i: abs(fresh[i]["p_niubi"] - tn))
    picks: list[str] = []
    for a, b in zip(near_b, near_n):  # 两条边界轮流取，凑够 N 篇
        for i in (a, b):
            if i not in picks and len(picks) < args.n:
                picks.append(i)
    if not picks:
        log.info("最近 %d 天没有需要老师标的新文章", args.days)
    else:
        log.info("请老师标 %d 篇（最近 %d 天、老师没标过的 %d 篇里最拿不准的）", len(picks), args.days, len(fresh))
        cmd = [sys.executable, str(ROOT / "scripts" / "judge.py"), "score", "--ids", ",".join(picks)]
        proc = subprocess.run(cmd, cwd=ROOT, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        if proc.returncode != 0:
            log.error("老师打分失败，明天再试")
            return proc.returncode
    judge.write_json(state_path, {"last": today, "ids_count": len(picks), "ids": picks})
    return 0


# ---------- 评测：你之后点的反馈 ----------

def score_block(name: str, pairs: list[tuple[str, float, float, str]]) -> list[str]:
    """pairs：(你的标签, 无聊分, 牛逼分, 模型标签)。"""
    if not pairs:
        return [f"| {name} | 0 | - | - | - | - | - |"]
    n = len(pairs)
    nb = sum(1 for t, *_ in pairs if t == "boring")
    caught = sum(1 for t, _, _, lab in pairs if t == "boring" and lab == "boring")
    killed = sum(1 for t, _, _, lab in pairs if t != "boring" and lab == "boring")
    killed_n = sum(1 for t, _, _, lab in pairs if t == "niubi" and lab == "boring")
    ba = auc([b for _, b, _, _ in pairs], [t == "boring" for t, *_ in pairs])
    na = auc([v for _, _, v, _ in pairs], [t == "niubi" for t, *_ in pairs])
    fmt = lambda x: f"{x:.2f}" if x is not None else "-"
    return [f"| {name} | {n} | {caught}/{nb} | {killed}（牛逼 {killed_n}） | {fmt(ba)} | {fmt(na)} | {sum(1 for t, _, _, lab in pairs if t == lab)}/{n} |"]


def cmd_eval(args) -> int:
    marks = [m for m in judge.load_marks() if str(m["created_at"])[:10] >= args.since]
    lines = [f"# 学生 vs 老师（{date.today().isoformat()}）", "",
             f"考题 = 你 {args.since} 起在站上点的反馈，只和模型在你点之前就冻结的首次预测比。", "",
             "| 模型 | 篇数 | 无聊抓到 | 误判无聊 | 无聊 AUC | 牛逼 AUC | 三档全对 |", "|---|---|---|---|---|---|---|"]
    for role, key in student_keys().items():
        first = judge.read_json(SDIR / f"first-{key}.json", {})
        pairs = [(m["label"], first[m["id"]]["pb"], first[m["id"]]["pn"], first[m["id"]]["label"])
                 for m in marks if m["id"] in first and first[m["id"]]["at"] < str(m["created_at"])]
        lines += score_block(f"{SHORT.get(key, key)}（{'展示' if role == 'student_display' else '后台'}）", pairs)
    tfirst = judge.read_json(SDIR / "first-teacher.json", {})
    pairs = [(m["label"], 10 - tfirst[m["id"]]["score"], tfirst[m["id"]]["score"], tfirst[m["id"]]["label"])
             for m in marks if m["id"] in tfirst and str(tfirst[m["id"]]["at"]) < str(m["created_at"])]
    lines += score_block("老师（LLM，只标了一部分）", pairs)
    lines += ["", "## TEST 73 条（每次训练后重算，训练从不含 TEST）", "", "| 模型 | 无聊 AUC | 砍 30%：无/收/牛 | 牛逼 AUC | 牛逼 p@20 | 训练篇数（你的） |", "|---|---|---|---|---|---|"]
    for role, key in student_keys().items():
        meta = judge.read_json(SDIR / f"meta-{key}.json", {})
        tm = meta.get("test") or {}
        if tm:
            c = tm["cut30"]
            lines.append(f"| {SHORT.get(key, key)} | {tm['boring_auc']:.2f} | {c['boring']}/{c['received']}/{c['niubi']} | {tm['niubi_auc']:.2f} | {tm['niubi_p20']}/20 | {meta['n_train']}（{meta['n_user']}） |")
    lines += ["", "篇数少于 30、无聊少于 5 篇时，数字只看方向。"]
    path = OUT / f"student-eval-{date.today().isoformat()}.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(path)
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run", help="算向量 → 训练 → 预测全池，写 preds-student-<key>.json")
    p.add_argument("--cut", type=float, default=0.30, help="最近 30 天候选池里判无聊（精选踢出）的比例")
    p.add_argument("--niubi-frac", type=float, default=0.25, help="判牛逼的比例（只影响卡片显示和先看清单）")
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("teach", help="每天一次，请老师标小模型最拿不准的 N 篇")
    p.add_argument("--n", type=int, default=20)
    p.add_argument("--days", type=int, default=3)
    p.add_argument("--force", action="store_true", help="今天已经标过也再标一次")
    p.set_defaults(fn=cmd_teach)
    p = sub.add_parser("eval", help="学生 vs 老师：你之后点的反馈 + TEST")
    p.add_argument("--since", default=EVAL_SINCE)
    p.set_defaults(fn=cmd_eval)
    args = parser.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
