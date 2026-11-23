"""The tests written on workflow edges: which way to go after a node.

Texts are compared without regard to case or surrounding spaces and punctuation.
"""

from __future__ import annotations

import re
from enum import StrEnum

from pydantic import BaseModel

NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
FIRST_WORD = re.compile(r"[a-zA-Z]+")


class Operator(StrEnum):
    CONTAINS = "contains"
    NOT_CONTAINS = "not_contains"
    EQUALS = "equals"
    STARTS_WITH = "starts_with"
    YES = "yes"  # the answer starts with "yes"
    NO = "no"  # the answer starts with "no"
    GREATER_THAN = "greater_than"  # the first number in the answer
    LESS_THAN = "less_than"
    REGEX = "regex"
    ELSE = "else"  # when no other edge matches


VALUE_FREE = {Operator.YES, Operator.NO, Operator.ELSE}


class Condition(BaseModel):
    operator: Operator = Operator.ELSE
    value: str = ""

    def describe(self) -> str:
        if self.operator in VALUE_FREE:
            return self.operator.value
        return f"{self.operator.value.replace('_', ' ')} {self.value!r}"

    def problem(self) -> str | None:
        """Why the condition cannot be evaluated, if it cannot."""
        if self.operator not in VALUE_FREE and not self.value.strip():
            return f"'{self.operator.value}' needs a value"
        if self.operator in (Operator.GREATER_THAN, Operator.LESS_THAN) and first_number(self.value) is None:
            return f"'{self.operator.value}' needs a number"
        if self.operator is Operator.REGEX:
            try:
                re.compile(self.value)
            except re.error as error:
                return f"invalid regular expression: {error}"
        return None


def normalise(text: str) -> str:
    return " ".join(text.lower().split()).strip(" .,!?;:\"'")


def first_number(text: str) -> float | None:
    match = NUMBER.search(text)
    return float(match.group().replace(",", ".")) if match else None


def is_met(condition: Condition, text: str) -> bool:
    operator, value, subject = condition.operator, normalise(condition.value), normalise(text)
    first_word = (FIRST_WORD.findall(subject) or [""])[0]
    match operator:
        case Operator.CONTAINS:
            return value in subject
        case Operator.NOT_CONTAINS:
            return value not in subject
        case Operator.EQUALS:
            return subject == value
        case Operator.STARTS_WITH:
            return subject.startswith(value)
        case Operator.YES:
            return first_word == "yes"
        case Operator.NO:
            return first_word == "no"
        case Operator.GREATER_THAN | Operator.LESS_THAN:
            number, limit = first_number(text), first_number(condition.value)
            if number is None or limit is None:
                return False
            return number > limit if operator is Operator.GREATER_THAN else number < limit
        case Operator.REGEX:
            try:
                return re.search(condition.value, text, re.IGNORECASE) is not None
            except re.error:
                return False
        case Operator.ELSE:
            return True
