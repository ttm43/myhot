"""同事件二手稿：精选里同一个 AIHOT 事件（story）有多篇时，后来的那篇如果只是转述、引用或概括先来的那篇，就踢出精选。

用户 2026-10-18 的 review：Simon Willison 的「Quoting …」短帖和它引用的 claude.dev 原文同时进了精选，
原文页下面「事件后续」又把引用帖列出来，这种后续的二手信息不需要。

只看 judge 已经要留的文章；先来的那篇被踢出时，后来的不受影响。判断交给 LLM（每对一次，按正文哈希缓存）。
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Callable

log = logging.getLogger("judge")

BODY_CAP = 6000  # 二手判断只需要看得出 B 是不是在复述 A，不需要全文

PROMPT = """下面是同一个事件里的两篇文章，A 先发，B 后发。判断 B 相对 A 是不是「二手信息」。

二手：B 的主要内容是转述、引用、摘录、翻译、概括或简短点评 A（或 A 报道的同一份材料）。读过 A 的人从 B 拿不到新的一手事实。
一手：B 带来了 A 没有的一手信息，例如作者自己做的东西（发布、代码、实验、实测数据）、新的官方消息或数字、有实质内容的独立分析。

只看信息有没有新增，不看文章写得好不好、长不长。拿不准时判一手。

【A】{a_title}
来源：{a_source}  日期：{a_date}
{a_body}

【B】{b_title}
来源：{b_source}  日期：{b_date}
{b_body}

只输出一个 JSON 数组，里面一个对象：[{{"secondhand": true 或 false, "reason": "一句话，说 B 新增了什么或复述了什么"}}]"""


def render(a: dict, b: dict) -> str:
    def body(x: dict) -> str:
        text = (x.get("body") or "").strip()
        return text[:BODY_CAP] + (f"\n（后略，原文 {len(text)} 字）" if len(text) > BODY_CAP else "")

    return PROMPT.format(a_title=a["title"], a_source=a["source"], a_date=str(a.get("published_at"))[:10], a_body=body(a),
                         b_title=b["title"], b_source=b["source"], b_date=str(b.get("published_at"))[:10], b_body=body(b))


def find_secondhand(members: list[dict], verdict: Callable[[dict, dict], dict | None]) -> dict[str, dict]:
    """members：要留的文章，每条有 id、story_id、published_at。同一 story 里按发布时间排，
    后来的每篇和前面还留着的逐篇比，任何一篇判它二手就踢出。返回 被踢出 id → {"of": 先来那篇 id, "reason": …}。"""
    by_story: dict = defaultdict(list)
    for m in members:
        if m.get("story_id") is not None:
            by_story[m["story_id"]].append(m)
    dropped: dict[str, dict] = {}
    for rows in by_story.values():
        kept: list[dict] = []
        for b in sorted(rows, key=lambda r: (str(r["published_at"]), r["id"])):
            hit = next(((a, v) for a in kept if (v := verdict(a, b)) and v.get("secondhand")), None)
            if hit:
                dropped[b["id"]] = {"of": hit[0]["id"], "reason": hit[1].get("reason", "")}
            else:
                kept.append(b)
    return dropped


def cached_verdict(llm, cache: dict, short_hash: Callable[[str], str]) -> Callable[[dict, dict], dict | None]:
    """LLM 判断加缓存：键 = 两篇 id，正文变了就重判。调用失败返回 None（当作一手，不踢）。"""

    def verdict(a: dict, b: dict) -> dict | None:
        key = f"{a['id']}>{b['id']}"
        stamp = short_hash((a.get("body") or "") + "\0" + (b.get("body") or ""))
        hit = cache.get(key)
        if hit and hit.get("hash") == stamp:
            return hit
        rows = llm.ask(render(a, b))
        row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None
        if row is None:
            log.warning("二手判断失败，按一手处理：%s", b["title"][:40])
            return None
        result = {"secondhand": bool(row.get("secondhand")), "reason": str(row.get("reason") or ""), "hash": stamp,
                  "a": a["title"][:60], "b": b["title"][:60]}
        cache[key] = result
        return result

    return verdict
