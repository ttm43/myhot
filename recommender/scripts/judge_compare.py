"""并排比较多个 judge 预测文件：python scripts/judge_compare.py v1.1 v1.2 v1.3 p12-v4 ...

每个名字对应 out/judge/preds-<名字>.json（"live" 对应 preds.json）。指标：TEST p@10/p@20、TEST 牛逼 P/R、
DEV 牛逼 P/R（只在该版本没把 DEV 当例子时有意义，表里按 run-meta 的 feedback_mode 标注）、池子牛逼率、金标准名次。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import judge  # noqa: E402

OUT = judge.OUT
LABELS = judge.LABELS_DIR


def load(tag: str) -> dict:
    return judge.read_json(OUT / ("preds.json" if tag == "live" else f"preds-{tag}.json"), {})


def pr(labels: dict, preds: dict, ids) -> tuple[float, float, int]:
    ids = [i for i in ids if i in preds]
    tp = sum(1 for i in ids if labels[i]["label"] == "niubi" and preds[i]["label"] == "niubi")
    fp = sum(1 for i in ids if labels[i]["label"] != "niubi" and preds[i]["label"] == "niubi")
    fn = sum(1 for i in ids if labels[i]["label"] == "niubi" and preds[i]["label"] != "niubi")
    return (tp / (tp + fp) if tp + fp else 0.0, tp / (tp + fn) if tp + fn else 0.0, len(ids))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    tags = sys.argv[1:] or ["v1.1", "v1.2", "b", "v1.3", "live"]
    dev, test = judge.read_json(LABELS / "dev.json", {}), judge.read_json(LABELS / "test.json", {})
    marks = {m["id"] for m in judge.load_marks()}
    golden = judge.resolve_golden()
    pool_ids = {a["id"] for a in judge.load_pool(with_body=False)}
    excluded = marks | {g["id"] for g in golden.values()}
    dev_ids = [i for i in dev if i not in excluded]
    runs = sorted(judge.RUNS.glob("*.json")) if judge.RUNS.exists() else []
    meta_by_file = {}
    for f in runs:
        m = judge.read_json(f, {})
        meta_by_file[m.get("preds_file", "preds.json")] = m
    rows = []
    for tag in tags:
        preds = load(tag)
        if not preds:
            print(f"{tag}: 没有预测文件")
            continue
        fname = "preds.json" if tag == "live" else f"preds-{tag}.json"
        meta = meta_by_file.get(fname, {})
        ranked = sorted(preds, key=lambda i: preds[i]["score"], reverse=True)
        test_ranked = [i for i in sorted(test, key=lambda i: preds.get(i, {}).get("score", -1), reverse=True) if i in preds]
        p10 = sum(1 for i in test_ranked[:10] if test[i]["label"] == "niubi")
        p20 = sum(1 for i in test_ranked[:20] if test[i]["label"] == "niubi")
        tp, tr, tn = pr(test, preds, list(test))
        dp, dr, dn = pr(dev, preds, dev_ids)
        in_pool = [i for i in preds if i in pool_ids]
        rate = sum(1 for i in in_pool if preds[i]["label"] == "niubi") / max(1, len(in_pool))
        pos = {i: n + 1 for n, i in enumerate(i for i in ranked if i in pool_ids)}
        gr = " / ".join(str(pos.get(g["id"], "-")) for g in golden.values())
        fb = meta.get("feedback_mode", "?")
        dev_note = "泄漏" if (fb not in ("none",) and meta.get("feedback_count", 0) > 11) else ""
        rows.append((tag, meta.get("prompt_version", "?"), fb, meta.get("feedback_count", "?"), f"{p10}/10", f"{p20}/20",
                     f"{tp:.2f}/{tr:.2f}", f"{dp:.2f}/{dr:.2f} {dev_note}".strip(), f"{rate:.0%}", gr))
    head = ("版本", "提示词", "反馈模式", "反馈数", "TEST p@10", "TEST p@20", "TEST 牛逼 P/R", "DEV 牛逼 P/R", "池子牛逼率", "金标准名次 " + " / ".join(golden))
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for r in rows:
        print("| " + " | ".join(str(x) for x in r) + " |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
