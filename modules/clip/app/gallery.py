"""Image collections with cached embeddings, for retrieval, probes and fine-tuning.

<data_dir>/galleries/<name>/items.json   [{"id", "file", "label", "caption"}]
<data_dir>/galleries/<name>/images/<file>
<data_dir>/galleries/<name>/index.npz    embeddings + the model they came from
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

from app.engine import Encoder

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


class GalleryError(ValueError):
    pass


def safe(name: str) -> str:
    cleaned = _SAFE.sub("_", name).strip("._").lower()
    if not cleaned:
        raise GalleryError(f"invalid name {name!r}")
    return cleaned


class Galleries:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.RLock()

    def _dir(self, name: str, create: bool = False) -> Path:
        path = self.root / safe(name)
        if create:
            (path / "images").mkdir(parents=True, exist_ok=True)
            if not (path / "items.json").exists():
                (path / "items.json").write_text("[]")
        elif not (path / "items.json").exists():
            raise LookupError(f"gallery {name!r} not found")
        return path

    def names(self) -> list[dict]:
        if not self.root.is_dir():
            return []
        out = []
        for p in sorted(self.root.iterdir()):
            if (p / "items.json").exists():
                items = json.loads((p / "items.json").read_text())
                labels = sorted({i["label"] for i in items if i.get("label")})
                out.append({"name": p.name, "items": len(items), "labels": labels})
        return out

    def items(self, name: str) -> list[dict]:
        return json.loads((self._dir(name) / "items.json").read_text())

    def add(self, name: str, image: Image.Image, filename: str, label=None, caption=None) -> dict:
        with self._lock:
            path = self._dir(name, create=True)
            item_id = uuid.uuid4().hex[:10]
            file = f"{item_id}.jpg"
            im = image.copy()
            im.thumbnail((1024, 1024))
            im.save(path / "images" / file, quality=92)
            item = {
                "id": item_id,
                "file": file,
                "source": filename,
                "label": (label or "").strip() or None,
                "caption": (caption or "").strip() or None,
            }
            items = self.items(name)
            items.append(item)
            (path / "items.json").write_text(json.dumps(items, indent=1))
            (path / "index.npz").unlink(missing_ok=True)  # stale
            return item

    def update(self, name: str, item_id: str, label=None, caption=None) -> dict:
        with self._lock:
            items = self.items(name)
            for item in items:
                if item["id"] == item_id:
                    if label is not None:
                        item["label"] = label.strip() or None
                    if caption is not None:
                        item["caption"] = caption.strip() or None
                    (self._dir(name) / "items.json").write_text(json.dumps(items, indent=1))
                    return item
        raise LookupError(f"item {item_id!r} not found")

    def remove(self, name: str, item_id: str) -> None:
        with self._lock:
            path = self._dir(name)
            items = [i for i in self.items(name) if i["id"] != item_id]
            (path / "images" / f"{item_id}.jpg").unlink(missing_ok=True)
            (path / "items.json").write_text(json.dumps(items, indent=1))
            (path / "index.npz").unlink(missing_ok=True)

    def delete(self, name: str) -> None:
        shutil.rmtree(self._dir(name))

    def image_path(self, name: str, item_id: str) -> Path:
        path = self._dir(name) / "images" / f"{safe(item_id)}.jpg"
        if not path.exists():
            raise LookupError(item_id)
        return path

    def load_images(self, name: str, items: list[dict] | None = None) -> list[Image.Image]:
        path = self._dir(name)
        result = []
        for item in items if items is not None else self.items(name):
            with Image.open(path / "images" / item["file"]) as im:
                result.append(im.convert("RGB"))
        return result

    def embeddings(self, name: str, encoder: Encoder) -> tuple[list[dict], np.ndarray]:
        """Items and their embeddings, recomputed when the model changed."""
        with self._lock:
            path = self._dir(name)
            items = self.items(name)
            index = path / "index.npz"
            item_ids = [item["id"] for item in items]
            if index.exists():
                cached = np.load(index, allow_pickle=False)
                # Older cache files (another key name) are simply recomputed.
                if (
                    "embeddings" in cached.files
                    and str(cached["model"]) == encoder.model_id
                    and list(cached["ids"]) == item_ids
                ):
                    return items, cached["embeddings"]
            embeddings = encoder.embed_images(self.load_images(name, items)) if items else np.zeros((0, 1))
            np.savez(
                index, embeddings=embeddings, ids=np.array(item_ids),
                model=np.array(encoder.model_id),
            )  # fmt: skip
            return items, embeddings
