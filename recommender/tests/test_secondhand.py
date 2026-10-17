import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from secondhand import cached_verdict, find_secondhand  # noqa: E402


def art(i, story, day, title="t", body="body"):
    return {"id": i, "story_id": story, "published_at": f"2026-10-{day:02d}", "title": title, "source": "s", "body": body}


def by_pairs(secondhand_pairs):
    calls = []

    def verdict(a, b):
        calls.append((a["id"], b["id"]))
        return {"secondhand": (a["id"], b["id"]) in secondhand_pairs, "reason": "r"}

    return verdict, calls


def test_later_quote_of_earlier_original_is_dropped():
    verdict, _ = by_pairs({("orig", "quote")})
    dropped = find_secondhand([art("quote", 1, 16), art("orig", 1, 15)], verdict)
    assert dropped == {"quote": {"of": "orig", "reason": "r"}}


def test_firsthand_followup_in_same_story_is_kept():
    verdict, _ = by_pairs(set())
    assert find_secondhand([art("launch", 1, 13), art("plugin", 1, 13)], verdict) == {}


def test_articles_in_different_stories_are_never_compared():
    verdict, calls = by_pairs({("a", "b")})
    assert find_secondhand([art("a", 1, 1), art("b", 2, 2), art("c", None, 3)], verdict) == {}
    assert calls == []


def test_dropped_article_is_not_used_as_an_original():
    # c 只和还留着的 a 比，不和已经踢出的 b 比
    verdict, calls = by_pairs({("a", "b")})
    find_secondhand([art("a", 1, 1), art("b", 1, 2), art("c", 1, 3)], verdict)
    assert ("b", "c") not in calls and ("a", "c") in calls


def test_failed_verdict_keeps_the_article():
    assert find_secondhand([art("a", 1, 1), art("b", 1, 2)], lambda a, b: None) == {}


class FakeLLM:
    def __init__(self, reply):
        self.reply = reply
        self.calls = 0

    def ask(self, prompt):
        self.calls += 1
        return self.reply


def test_cached_verdict_reuses_cache_until_body_changes():
    llm = FakeLLM([{"secondhand": True, "reason": "只是引用"}])
    cache: dict = {}
    verdict = cached_verdict(llm, cache, lambda s: str(hash(s)))
    a, b = art("a", 1, 1, body="原文"), art("b", 1, 2, body="引用")
    assert verdict(a, b)["secondhand"] is True
    assert verdict(a, b)["secondhand"] is True
    assert llm.calls == 1
    verdict(a, {**b, "body": "改过的引用"})
    assert llm.calls == 2


def test_cached_verdict_returns_none_on_unparseable_reply():
    verdict = cached_verdict(FakeLLM(None), {}, lambda s: s)
    assert verdict(art("a", 1, 1), art("b", 1, 2)) is None
