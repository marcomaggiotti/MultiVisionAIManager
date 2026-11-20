"""Instruction datasets: (pictures, instruction, response) examples.

    <data_dir>/vlm_datasets/<name>/items.jsonl
    <data_dir>/vlm_datasets/<name>/images/<file>

The same examples are used for instruction tuning (the response is the
target) and for evaluation (the response is the reference answer).
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from pathlib import Path

from PIL import Image

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe(name: str) -> str:
    cleaned = _SAFE.sub("_", name).strip("._").lower()
    if not cleaned:
        raise ValueError(f"invalid name {name!r}")
    return cleaned


class InstructionDatasets:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.Lock()

    def _dir(self, name: str, create=False) -> Path:
        path = self.root / safe(name)
        if create:
            (path / "images").mkdir(parents=True, exist_ok=True)
            (path / "items.jsonl").touch()
        elif not (path / "items.jsonl").exists():
            raise LookupError(f"dataset {name!r} not found")
        return path

    def names(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        return [
            {"name": p.name, "items": len(self.items(p.name))}
            for p in sorted(self.root.iterdir())
            if (p / "items.jsonl").exists()
        ]

    def items(self, name: str) -> list[dict]:
        text = (self._dir(name) / "items.jsonl").read_text()
        return [json.loads(line) for line in text.splitlines() if line.strip()]

    def _write(self, name: str, items: list[dict]) -> None:
        (self._dir(name) / "items.jsonl").write_text("".join(json.dumps(i) + "\n" for i in items))

    def add(self, name: str, images: list[Image.Image], instruction: str, response: str, system=None) -> dict:
        if not instruction.strip():
            raise ValueError("instruction is required")
        with self._lock:
            path = self._dir(name, create=True)
            item_id = uuid.uuid4().hex[:10]
            files = []
            for k, im in enumerate(images):
                copy = im.copy()
                copy.thumbnail((1536, 1536))
                file = f"{item_id}_{k}.jpg"
                copy.save(path / "images" / file, quality=92)
                files.append(file)
            item = {
                "id": item_id,
                "images": files,
                "instruction": instruction.strip(),
                "response": response.strip(),
                "system": (system or "").strip() or None,
            }
            items = self.items(name)
            items.append(item)
            self._write(name, items)
            return item

    def update(self, name: str, item_id: str, fields: dict) -> dict:
        with self._lock:
            items = self.items(name)
            for item in items:
                if item["id"] == item_id:
                    for key in ("instruction", "response", "system"):
                        if key in fields:
                            item[key] = fields[key]
                    self._write(name, items)
                    return item
        raise LookupError(item_id)

    def remove(self, name: str, item_id: str) -> None:
        with self._lock:
            items = self.items(name)
            keep = [i for i in items if i["id"] != item_id]
            for item in items:
                if item["id"] == item_id:
                    for f in item["images"]:
                        (self._dir(name) / "images" / f).unlink(missing_ok=True)
            self._write(name, keep)

    def delete(self, name: str) -> None:
        shutil.rmtree(self._dir(name))

    def image_path(self, name: str, file: str) -> Path:
        path = self._dir(name) / "images" / Path(file).name
        if not path.exists():
            raise LookupError(file)
        return path

    def load(self, name: str, item: dict) -> list[Image.Image]:
        out = []
        for f in item["images"]:
            with Image.open(self.image_path(name, f)) as im:
                out.append(im.convert("RGB"))
        return out
