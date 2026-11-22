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


def exact_match(prediction: str, reference: str) -> float:
    return float(normalize(prediction) == normalize(reference))


def contains(prediction: str, reference: str) -> float:
    """The reference (e.g. a step name) appears in the answer."""
    normalized_reference = normalize(reference)
    return float(bool(normalized_reference) and normalized_reference in normalize(prediction))


def token_f1(prediction: str, reference: str) -> float:
    """Harmonic mean of precision and recall over the words (SQuAD-style)."""
    predicted_words, reference_words = normalize(prediction).split(), normalize(reference).split()
    if not predicted_words or not reference_words:
        return float(predicted_words == reference_words)
    shared = sum((Counter(predicted_words) & Counter(reference_words)).values())
    if shared == 0:
        return 0.0
    precision, recall = shared / len(predicted_words), shared / len(reference_words)
    return 2 * precision * recall / (precision + recall)


def rouge_l(prediction: str, reference: str) -> float:
    """F-measure of the longest common subsequence of words."""
    predicted_words, reference_words = normalize(prediction).split(), normalize(reference).split()
    if not predicted_words or not reference_words:
        return 0.0
    lcs_length = _longest_common_subsequence(predicted_words, reference_words)
    if lcs_length == 0:
        return 0.0
    precision, recall = lcs_length / len(predicted_words), lcs_length / len(reference_words)
    return 2 * precision * recall / (precision + recall)


def _longest_common_subsequence(first: list[str], second: list[str]) -> int:
    """Classic dynamic programming, one row at a time."""
    previous_row = [0] * (len(second) + 1)
    for word in first:
        current_row = [0]
        for index, other_word in enumerate(second):
            if word == other_word:
                current_row.append(previous_row[index] + 1)
            else:
                current_row.append(max(previous_row[index + 1], current_row[-1]))
        previous_row = current_row
    return previous_row[-1]


def keyword_recall(prediction: str, reference: str, vocabulary: list[str]) -> float | None:
    """Share of the domain terms (e.g. ballet steps) in the reference that the answer
    also uses. ``None`` when the reference contains none."""
    normalized_prediction, normalized_reference = normalize(prediction), normalize(reference)
    expected_terms = [normalize(term) for term in vocabulary if normalize(term) in normalized_reference]
    if not expected_terms:
        return None
    return sum(term in normalized_prediction for term in expected_terms) / len(expected_terms)


def score(prediction: str, reference: str, vocabulary: list[str] | None = None) -> dict:
    result = {
        "exact_match": exact_match(prediction, reference),
        "contains_reference": contains(prediction, reference),
        "token_f1": round(token_f1(prediction, reference), 4),
        "rouge_l": round(rouge_l(prediction, reference), 4),
    }
    if vocabulary:
        result["keyword_recall"] = keyword_recall(prediction, reference, vocabulary)
    return result


def _is_number(value) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def aggregate(rows: list[dict]) -> dict:
    """Mean of every numeric field over the rows (missing values are skipped)."""
    numeric_fields = {name for row in rows for name, value in row.items() if _is_number(value)}
    means = {}
    for name in sorted(numeric_fields):
        values = [row[name] for row in rows if _is_number(row.get(name))]
        means[name] = round(sum(values) / len(values), 4) if values else None
    return means
