"""Text metrics for evaluating VLM answers against reference answers."""

from __future__ import annotations

import re
import string
from collections import Counter

ARTICLES = re.compile(r"\b(a|an|the)\b")


def normalize(text: str) -> str:
    text = text.lower()
    text = "".join(ch for ch in text if ch not in string.punctuation)
    text = ARTICLES.sub(" ", text)
    return " ".join(text.split())


def exact_match(pred: str, ref: str) -> float:
    return float(normalize(pred) == normalize(ref))


def contains(pred: str, ref: str) -> float:
    """The reference (e.g. a step name) appears in the answer."""
    r = normalize(ref)
    return float(bool(r) and r in normalize(pred))


def token_f1(pred: str, ref: str) -> float:
    p, r = normalize(pred).split(), normalize(ref).split()
    if not p or not r:
        return float(p == r)
    common = Counter(p) & Counter(r)
    same = sum(common.values())
    if same == 0:
        return 0.0
    precision, recall = same / len(p), same / len(r)
    return 2 * precision * recall / (precision + recall)


def rouge_l(pred: str, ref: str) -> float:
    p, r = normalize(pred).split(), normalize(ref).split()
    if not p or not r:
        return 0.0
    prev = [0] * (len(r) + 1)
    for a in p:
        cur = [0]
        for j, b in enumerate(r):
            cur.append(prev[j] + 1 if a == b else max(prev[j + 1], cur[-1]))
        prev = cur
    lcs = prev[-1]
    if lcs == 0:
        return 0.0
    precision, recall = lcs / len(p), lcs / len(r)
    return 2 * precision * recall / (precision + recall)


def keyword_recall(pred: str, ref: str, vocabulary: list[str]) -> float | None:
    """Share of the domain terms (e.g. ballet steps) in the reference that the
    answer also uses. None when the reference has none."""
    p, r = normalize(pred), normalize(ref)
    terms = [normalize(t) for t in vocabulary if normalize(t) in r]
    if not terms:
        return None
    return sum(t in p for t in terms) / len(terms)


def score(pred: str, ref: str, vocabulary: list[str] | None = None) -> dict:
    result = {
        "exact_match": exact_match(pred, ref),
        "contains_reference": contains(pred, ref),
        "token_f1": round(token_f1(pred, ref), 4),
        "rouge_l": round(rouge_l(pred, ref), 4),
    }
    if vocabulary:
        result["keyword_recall"] = keyword_recall(pred, ref, vocabulary)
    return result


def aggregate(rows: list[dict]) -> dict:
    keys = {k for r in rows for k, v in r.items() if isinstance(v, int | float) and not isinstance(v, bool)}
    out = {}
    for k in sorted(keys):
        values = [r[k] for r in rows if isinstance(r.get(k), int | float)]
        out[k] = round(sum(values) / len(values), 4) if values else None
    return out
