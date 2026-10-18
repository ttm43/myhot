"""归组召回用的向量模型对比：Gemini（库里存好的）对本地模型。

MyHOT 归组时向量只管召回：新报道拿「中文标题。摘要前 300 字」去和 14 天内的旧报道比余弦，
取前 10 个且余弦 ≥ 0.6 的候选交给 LLM 判断是不是同一件事。所以比的是召回：真正同一件事的旧报道
能不能排进前几名。

用法（按顺序跑，每步都有缓存，可单独重跑）：
  python embed_compare.py embed            # 各模型算向量（Gemini 直接读库）
  python embed_compare.py pool --k 3       # 每个模型每篇取前 k 个旧报道，合并成待标注的对
  python embed_compare.py label            # LLM 标注每一对：same / develop / none
  python embed_compare.py eval             # 出对比表，写 out/embed/report.md

标注是「池化」的：只有至少一个模型排进前 k 的对才会被标，所以召回率是相对这几个模型的并集而言。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge  # noqa: E402  复用库查询、JSON 读写和 Gemini 封装
from student import model_path  # noqa: E402

OUT = judge.ROOT / "out" / "embed"
POOL_FILE = OUT / "pool.json"
PAIRS_FILE = OUT / "pairs.json"
LABELS_FILE = OUT / "labels.json"
WINDOW_DAYS = 14          # 和 recall.ts 的召回窗口一致
PROD_MIN_COSINE = 0.6     # group.ts RECALL_MIN_COSINE
PROD_TOP = 10             # group.ts RECALL_TOP_FACTS
OLLAMA = "http://127.0.0.1:11434"
LABEL_MODEL = "gemini-3.8-flash"
BATCH = 15
log = logging.getLogger("embed")

# key → (后端, 模型名)。gemini 不重算，读库里 MyHOT 实际在用的向量。
MODELS: dict[str, tuple[str, str]] = {
    "gemini-embedding-2": ("db", "gemini-embedding-2"),
    "qwen3-embedding-0.6b": ("ollama", "qwen3-embedding:0.6b"),
    "embeddinggemma": ("ollama", "embeddinggemma:latest"),
    "harrier-oss-v1-270m": ("st", "harrier-oss-v1-270m"),
    "harrier-oss-v1-0.6b": ("st", "harrier-oss-v1-0.6b"),
}


def report_text(title: str, summary: str | None) -> str:
    """和 relate.ts reportText 一致：标题。摘要前 300 字。"""
    return f"{title}。{(summary or '')[:300]}"


# ---------- 向量 ----------

def load_pool() -> list[dict]:
    rows = judge.psql_json("""
        SELECT a.id, coalesce(an.title_zh, a.title) AS title, an.summary_zh AS summary,
               coalesce(a.published_at, a.discovered_at) AS at, e.text_hash, e.vector::text AS vec
        FROM embeddings e
        JOIN articles a ON a.id = e.ref_id
        JOIN analyses an ON an.article_id = a.id
        WHERE e.kind = 'article' AND e.model = 'gemini-embedding-2' AND an.summary_zh IS NOT NULL""")
    pool = []
    for r in rows:
        text = report_text(r["title"], r["summary"])
        pool.append({"id": r["id"], "text": text, "at": r["at"],
                     "hash_ok": hashlib.sha256(text.encode("utf-8")).hexdigest() == r["text_hash"],
                     "gemini": [float(x) for x in r["vec"].strip("{}").split(",")]})
    return pool


def embed_ollama(name: str, texts: list[str]) -> list[list[float]]:
    out = []
    for k in range(0, len(texts), 16):
        body = json.dumps({"model": name, "input": texts[k:k + 16], "options": {"num_gpu": 0}}).encode()
        req = urllib.request.Request(f"{OLLAMA}/api/embed", data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as resp:
            out += json.loads(resp.read())["embeddings"]
    return out


def embed_st(key: str, texts: list[str]) -> list[list[float]]:
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(str(model_path(key)), device="cpu")
    model.max_seq_length = 512
    return model.encode(texts, batch_size=8, normalize_embeddings=True, show_progress_bar=False).tolist()


def cmd_embed(args) -> None:
    pool = load_pool()
    log.info("池子 %d 篇，文本哈希与库里一致 %d 篇", len(pool), sum(p["hash_ok"] for p in pool))
    judge.write_json(POOL_FILE, [{k: p[k] for k in ("id", "text", "at", "hash_ok")} for p in pool])
    texts = [p["text"] for p in pool]
    timing = judge.read_json(OUT / "timing.json", {})
    for key, (backend, name) in MODELS.items():
        path = OUT / f"vec-{key}.npy"
        if path.exists() and not args.force:
            continue
        started = time.time()
        if backend == "db":
            vecs = [p["gemini"] for p in pool]
        elif backend == "ollama":
            vecs = embed_ollama(name, texts)
        else:
            vecs = embed_st(name, texts)
        elapsed = time.time() - started
        arr = np.asarray(vecs, dtype=np.float32)
        arr /= np.linalg.norm(arr, axis=1, keepdims=True)
        np.save(path, arr)
        if backend != "db":
            timing[key] = {"seconds": round(elapsed, 1), "per_article_ms": round(1000 * elapsed / len(texts)), "dims": arr.shape[1]}
        log.info("%s：%d 维，%.0f 秒", key, arr.shape[1], elapsed)
    judge.write_json(OUT / "timing.json", timing)


# ---------- 召回 ----------

def load_vectors() -> tuple[list[dict], dict[str, np.ndarray], np.ndarray]:
    pool = judge.read_json(POOL_FILE, [])
    vecs = {key: np.load(OUT / f"vec-{key}.npy") for key in MODELS}
    at = np.array([datetime.fromisoformat(p["at"]).timestamp() for p in pool])
    return pool, vecs, at


def earlier_mask(at: np.ndarray) -> np.ndarray:
    """mask[i, j]：j 在 i 之前且相隔不超过 14 天，也就是 i 归组时 j 在召回范围里。"""
    delta = at[:, None] - at[None, :]
    return (delta > 0) & (delta <= WINDOW_DAYS * 86400)


def ranked(sims: np.ndarray, mask: np.ndarray, top: int) -> list[list[int]]:
    masked = np.where(mask, sims, -np.inf)
    order = np.argsort(-masked, axis=1)[:, :top]
    return [[int(j) for j in row if np.isfinite(masked[i, j])] for i, row in enumerate(order)]


def cmd_pool(args) -> None:
    pool, vecs, at = load_vectors()
    mask = earlier_mask(at)
    pairs: dict[str, dict] = {}
    for key, v in vecs.items():
        for i, row in enumerate(ranked(v @ v.T, mask, args.k)):
            for j in row:
                pairs.setdefault(f"{pool[i]['id']}|{pool[j]['id']}", {"q": pool[i]["id"], "c": pool[j]["id"], "by": []})["by"].append(key)
    judge.write_json(PAIRS_FILE, list(pairs.values()))
    labelled = judge.read_json(LABELS_FILE, {})
    todo = sum(1 for k in pairs if k not in labelled)
    log.info("前 %d 名合并后 %d 对，其中待标注 %d 对（约 %d 次调用）", args.k, len(pairs), todo, -(-todo // BATCH))


# ---------- 标注 ----------

LABEL_PROMPT = """下面每一组是两篇 AI 行业资讯的「标题。摘要」。判断每组 A 和 B 的关系，只能三选一：
- same：报道的是同一件事（同一次发布、同一个事件、同一项研究结果），只是来源或写法不同
- develop：B 是 A 那件事的直接后续，或反过来（官方回应、补丁、跟进实测、同一事件的新进展）
- none：其他，包括同一家公司或同一主题下的不同事情

{items}

只输出 JSON 数组，不要其他文字：[{{"i": 组号, "rel": "same|develop|none"}}, ...]"""


def cmd_label(args) -> None:
    pool = {p["id"]: p for p in judge.read_json(POOL_FILE, [])}
    pairs = judge.read_json(PAIRS_FILE, [])
    labelled: dict[str, str] = judge.read_json(LABELS_FILE, {})
    todo = [p for p in pairs if f"{p['q']}|{p['c']}" not in labelled][: args.limit or None]
    batches = [todo[k:k + BATCH] for k in range(0, len(todo), BATCH)]
    llm = judge.make_llm(args.model)

    def run(batch: list[dict]) -> dict[str, str]:
        items = "\n\n".join(f"[{n}]\nA：{pool[p['q']]['text'][:220]}\nB：{pool[p['c']]['text'][:220]}" for n, p in enumerate(batch))
        rows = llm.ask(LABEL_PROMPT.format(items=items)) or []
        got = {}
        for row in rows if isinstance(rows, list) else []:
            n, rel = row.get("i"), row.get("rel")
            if isinstance(n, int) and 0 <= n < len(batch) and rel in ("same", "develop", "none"):
                got[f"{batch[n]['q']}|{batch[n]['c']}"] = rel
        return got

    with ThreadPoolExecutor(max_workers=4) as ex:
        for done, got in enumerate(ex.map(run, batches), 1):
            labelled.update(got)
            if done % 20 == 0:
                judge.write_json(LABELS_FILE, labelled)
                log.info("已标 %d/%d 批", done, len(batches))
    judge.write_json(LABELS_FILE, labelled)
    log.info("标注完：共 %d 对，tokens %s", len(labelled), dict(llm.tokens))


# ---------- 评估 ----------

def auc(pos: list[float], neg: list[float]) -> float:
    if not pos or not neg:
        return float("nan")
    p, n = np.asarray(pos)[:, None], np.asarray(neg)[None, :]
    return float(((p > n).sum() + 0.5 * (p == n).sum()) / (p.size * n.size))


def cmd_eval(args) -> None:
    pool, vecs, at = load_vectors()
    idx = {p["id"]: i for i, p in enumerate(pool)}
    labels: dict[str, str] = judge.read_json(LABELS_FILE, {})
    positives = [(idx[q], idx[c]) for key, rel in labels.items() if rel != "none" for q, c in [key.split("|")]]
    negatives = [(idx[q], idx[c]) for key, rel in labels.items() if rel == "none" for q, c in [key.split("|")]]
    mask = earlier_mask(at)
    timing = judge.read_json(OUT / "timing.json", {})
    sims_all = {key: v @ v.T for key, v in vecs.items()}
    gem = sims_all["gemini-embedding-2"]
    prod_budget = int(sum(((np.where(mask, gem, -np.inf) >= PROD_MIN_COSINE).sum(axis=1).clip(max=PROD_TOP))))
    by_query: dict[int, set[int]] = {}
    for q, c in positives:
        by_query.setdefault(q, set()).add(c)

    rows = []
    for key, sims in sims_all.items():
        top = ranked(sims, mask, PROD_TOP)
        rank = {}
        for i, row in enumerate(top):
            for r, j in enumerate(row, 1):
                rank[(i, j)] = r
        found = lambda k: sum(1 for pr in positives if rank.get(pr, 99) <= k) / max(len(positives), 1)  # noqa: E731
        # 按篇算：线上召回的是事件，同一事件里有一篇排进前几名就够了
        hit = lambda k: sum(1 for q, cs in by_query.items() if set(top[q][:k]) & cs) / max(len(by_query), 1)  # noqa: E731
        rows.append({
            "model": key, "hit@1": hit(1), "hit@3": hit(3), "R@10": found(10),
            "AUC": auc([float(sims[i, j]) for i, j in positives], [float(sims[i, j]) for i, j in negatives]),
            "ms": timing.get(key, {}).get("per_article_ms"), "dims": int(vecs[key].shape[1]),
        })

    lines = [f"# 归组召回：向量模型对比（{datetime.now():%Y-%m-%d}）", "",
             f"- 池子 {len(pool)} 篇（MyHOT 里已有 Gemini 向量、有中文摘要的报道），文本 = 中文标题。摘要前 300 字，和线上一致",
             f"- 召回范围：每篇只和它之前 14 天内的报道比；标注 {len(labels)} 对，其中同一件事或直接后续 {len(positives)} 对",
             f"- 有同一件事旧报道的新报道 {len(by_query)} 篇；Gemini 线上的阈值（余弦 ≥ {PROD_MIN_COSINE}）几乎不卡人，前 {PROD_TOP} 名里 {prod_budget} 个候选都过线", "",
             "| 模型 | 维度 | 按篇 hit@1 | 按篇 hit@3 | 按对 R@10 | AUC | CPU 每篇毫秒 |",
             "|---|--:|--:|--:|--:|--:|--:|"]
    for r in sorted(rows, key=lambda r: (-r["hit@3"], -r["hit@1"])):
        lines.append(f"| {r['model']} | {r['dims']} | {r['hit@1']:.3f} | {r['hit@3']:.3f} | {r['R@10']:.3f} | "
                     f"{r['AUC']:.3f} | {r['ms'] if r['ms'] is not None else '—'} |")
    lines += ["", "按篇 hit@k：有同一件事旧报道的新报道里，前 k 名至少命中一篇的比例（线上召回的是事件，命中一篇就够）。",
              "按对 R@10：每一对同一件事排进前 10 的比例；漏掉的大多是一个十几篇的大事件挤满了前 10。AUC：正负样本余弦能分开的程度，和余弦刻度无关。",
              "召回率相对于五个模型前几名的并集：谁都没排进前几名的同一件事，这里看不到。"]
    judge.write_json(OUT / "eval.json", {"rows": rows, "positives": len(positives), "negatives": len(negatives), "budget": prod_budget})
    (OUT / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("embed")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("pool")
    p.add_argument("--k", type=int, default=3)
    p = sub.add_parser("label")
    p.add_argument("--model", default=LABEL_MODEL)
    p.add_argument("--limit", type=int, default=0, help="只标前 N 对，先试水")
    sub.add_parser("eval")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    OUT.mkdir(parents=True, exist_ok=True)
    {"embed": cmd_embed, "pool": cmd_pool, "label": cmd_label, "eval": cmd_eval}[args.cmd](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
