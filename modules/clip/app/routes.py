from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, Body, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app import analysis, ballet, training
from app.engine import CATALOG, Encoder, HFEncoder, local_models
from app.gallery import GalleryError
from app.imaging import InvalidImageError, decode_image
from app.jobs import JobBusy

router = APIRouter()


def encoder(request: Request) -> Encoder:
    enc = request.app.state.encoder
    if enc is None:
        raise HTTPException(503, "no model loaded: PUT /v1/model first")
    return enc


def parse_list(value: str | None) -> list[str]:
    """A JSON array, or one item per line, or comma separated."""
    if not value:
        return []
    value = value.strip()
    if value.startswith("["):
        return [str(v) for v in json.loads(value)]
    sep = "\n" if "\n" in value else ","
    return [v.strip() for v in value.split(sep) if v.strip()]


async def read_images(request: Request, files: list[UploadFile]):
    settings = request.app.state.settings
    images = []
    for f in files:
        data = await f.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise HTTPException(413, f"{f.filename} is too large")
        try:
            images.append(decode_image(data, settings.max_image_pixels))
        except InvalidImageError as exc:
            raise HTTPException(400, f"{f.filename}: {exc}") from exc
    return images


def _404(exc: Exception) -> HTTPException:
    return HTTPException(404 if isinstance(exc, LookupError) else 400, str(exc))


@router.get("/health", tags=["ops"])
def health() -> dict:
    return {"status": "ok"}


@router.get("/v1/info", tags=["ops"])
def info(request: Request) -> dict:
    enc = request.app.state.encoder
    return {
        "name": "clip",
        "kind": "embedding",
        "title": "CLIP image-text embeddings",
        "version": "0.1.0",
        "model": enc.model_id if enc else None,
        "device": getattr(enc, "device", None) if enc else None,
        "capabilities": ["embed", "similarity", "zero-shot", "retrieval", "linear-probe", "finetune"],
        "ui": "/ui/",
        "docs": "/docs",
    }


@router.get("/v1/presets", tags=["model"])
def presets() -> dict:
    return ballet.presets()


@router.get("/v1/models", tags=["model"])
def models(request: Request) -> dict:
    enc = request.app.state.encoder
    return {
        "active": enc.model_id if enc else None,
        "catalog": CATALOG,
        "local": local_models(Path(request.app.state.settings.data_dir)),
    }


@router.get("/v1/model", tags=["model"])
def model_info(request: Request) -> dict:
    return encoder(request).info()


@router.put("/v1/model", tags=["model"])
async def load_model(request: Request, body: Annotated[dict, Body()]) -> dict:
    settings = request.app.state.settings
    model_id = body.get("model_id")
    if not model_id:
        raise HTTPException(422, "model_id is required")
    old = request.app.state.encoder
    request.app.state.encoder = None  # free memory before loading the next one
    del old
    _free_gpu()
    try:
        enc = await run_in_threadpool(
            HFEncoder.load, model_id, body.get("device") or settings.device,
            body.get("dtype") or settings.dtype,
        )  # fmt: skip
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"could not load {model_id}: {exc}") from exc
    request.app.state.encoder = enc
    return enc.info()


def _free_gpu() -> None:
    try:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


@router.post("/v1/tokenize", tags=["text"])
def tokenize(request: Request, body: Annotated[dict, Body()]) -> list[dict]:
    return encoder(request).tokenize(body.get("texts") or [])


@router.post("/v1/embed/texts", tags=["embed"])
async def embed_texts(request: Request, body: Annotated[dict, Body()]) -> dict:
    emb = await run_in_threadpool(encoder(request).embed_texts, body.get("texts") or [])
    return {"dim": int(emb.shape[1]), "embeddings": emb.round(6).tolist()}


@router.post("/v1/embed/images", tags=["embed"])
async def embed_images(request: Request, images: Annotated[list[UploadFile], File()]) -> dict:
    pics = await read_images(request, images)
    emb = await run_in_threadpool(encoder(request).embed_images, pics)
    return {"dim": int(emb.shape[1]), "embeddings": emb.round(6).tolist()}


@router.post("/v1/similarity", tags=["analysis"])
async def similarity(
    request: Request,
    images: Annotated[list[UploadFile], File()],
    texts: Annotated[str, Form()],
    temperature: Annotated[float | None, Form(gt=0)] = None,
) -> dict:
    enc = encoder(request)
    pics = await read_images(request, images)
    text_list = parse_list(texts)
    if not text_list:
        raise HTTPException(422, "texts is empty")

    def run():
        return analysis.similarity(enc, enc.embed_images(pics), text_list, temperature)

    return await run_in_threadpool(run)


@router.post("/v1/zero-shot", tags=["analysis"])
async def zero_shot(
    request: Request,
    images: Annotated[list[UploadFile], File()],
    labels: Annotated[str | None, Form()] = None,
    templates: Annotated[str | None, Form()] = None,
    temperature: Annotated[float | None, Form(gt=0)] = None,
    mode: Annotated[str, Form()] = "auto",
    use_descriptions: Annotated[bool, Form()] = False,
) -> dict:
    """Zero-shot classification. Defaults to the ballet steps and templates."""
    enc = encoder(request)
    pics = await read_images(request, images)
    label_list = parse_list(labels) or ballet.STEPS
    template_list = parse_list(templates) or ballet.TEMPLATES
    if mode not in {"auto", "softmax", "sigmoid"}:
        raise HTTPException(422, "mode must be auto, softmax or sigmoid")

    def run():
        return analysis.zero_shot(
            enc, enc.embed_images(pics), label_list, template_list,
            temperature=temperature, mode=mode,
            descriptions=ballet.DESCRIPTIONS if use_descriptions else None,
        )  # fmt: skip

    return await run_in_threadpool(run)


# --- galleries (retrieval collections) -----------------------------------------
@router.get("/v1/galleries", tags=["retrieval"])
def galleries(request: Request) -> list[dict]:
    return request.app.state.galleries.names()


@router.get("/v1/galleries/{name}", tags=["retrieval"])
def gallery(request: Request, name: str) -> dict:
    try:
        return {"name": name, "items": request.app.state.galleries.items(name)}
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


@router.delete("/v1/galleries/{name}", status_code=204, tags=["retrieval"])
def delete_gallery(request: Request, name: str) -> Response:
    try:
        request.app.state.galleries.delete(name)
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc
    return Response(status_code=204)


@router.post("/v1/galleries/{name}/images", status_code=201, tags=["retrieval"])
async def add_images(
    request: Request,
    name: str,
    images: Annotated[list[UploadFile], File()],
    label: Annotated[str | None, Form()] = None,
    caption: Annotated[str | None, Form()] = None,
) -> dict:
    pics = await read_images(request, images)
    store = request.app.state.galleries
    try:
        added = [
            store.add(name, pic, f.filename or "image", label, caption) for pic, f in zip(pics, images, strict=True)
        ]
    except GalleryError as exc:
        raise _404(exc) from exc
    return {"added": added}


@router.patch("/v1/galleries/{name}/items/{item_id}", tags=["retrieval"])
def update_item(request: Request, name: str, item_id: str, body: Annotated[dict, Body()]) -> dict:
    try:
        return request.app.state.galleries.update(name, item_id, body.get("label"), body.get("caption"))
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


@router.delete("/v1/galleries/{name}/items/{item_id}", status_code=204, tags=["retrieval"])
def delete_item(request: Request, name: str, item_id: str) -> Response:
    try:
        request.app.state.galleries.remove(name, item_id)
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc
    return Response(status_code=204)


@router.get("/v1/galleries/{name}/items/{item_id}/image", tags=["retrieval"])
def item_image(request: Request, name: str, item_id: str):
    try:
        return FileResponse(request.app.state.galleries.image_path(name, item_id))
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


@router.post("/v1/galleries/{name}/search", tags=["retrieval"])
async def search(
    request: Request,
    name: str,
    text: Annotated[str | None, Form()] = None,
    image: Annotated[UploadFile | None, File()] = None,
    k: Annotated[int, Form(ge=1, le=200)] = 12,
) -> dict:
    """Semantic retrieval: text -> images or image -> images."""
    enc = encoder(request)
    store = request.app.state.galleries
    query_image = (await read_images(request, [image]))[0] if image is not None else None
    if not text and query_image is None:
        raise HTTPException(422, "give a text or an image")

    def run():
        items, emb = store.embeddings(name, enc)
        if not items:
            return {"results": []}
        q = enc.embed_texts([text])[0] if text else enc.embed_images([query_image])[0]
        scores = emb @ q
        order = np.argsort(-scores)[:k]
        return {
            "query": text or "image",
            "results": [{**items[i], "score": round(float(scores[i]), 4)} for i in order],
        }

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


@router.post("/v1/galleries/{name}/projection", tags=["analysis"])
async def projection(request: Request, name: str, body: Annotated[dict, Body()] = None) -> dict:
    """2-D PCA map of the gallery images and some texts (default: its labels)."""
    body = body or {}
    enc = encoder(request)
    store = request.app.state.galleries

    def run():
        items, emb = store.embeddings(name, enc)
        texts = body.get("texts") or sorted({i["label"] for i in items if i.get("label")})
        template = body.get("template") or "a photo of a ballet dancer doing a {}."
        prompts = [template.format(t) if "{}" in template else t for t in texts]
        text_emb = enc.embed_texts(prompts) if prompts else np.zeros((0, emb.shape[1]))
        result = analysis.projection(emb, text_emb)
        result["items"] = [{"id": i["id"], "label": i.get("label")} for i in items]
        result["text_labels"] = texts
        return result

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


@router.post("/v1/galleries/{name}/evaluate", tags=["analysis"])
async def evaluate(request: Request, name: str, body: Annotated[dict, Body()] = None) -> dict:
    """Zero-shot accuracy on the labelled gallery images, per prompt template
    (prompt sensitivity at dataset level) and for the template ensemble."""
    body = body or {}
    enc = encoder(request)
    store = request.app.state.galleries

    def run():
        items, emb = store.embeddings(name, enc)
        idx = [i for i, it in enumerate(items) if it.get("label")]
        if not idx:
            raise HTTPException(400, "no labelled images in this gallery")
        classes = sorted({items[i]["label"] for i in idx})
        y = [classes.index(items[i]["label"]) for i in idx]
        templates = body.get("templates") or ballet.TEMPLATES
        desc = ballet.DESCRIPTIONS if body.get("use_descriptions") else None
        per_t = analysis.label_embeddings(enc, classes, templates, desc)
        x = emb[idx]
        rows = []
        for t, template in enumerate(templates):
            pred = (x @ per_t[t].T).argmax(1).tolist()
            rows.append({"template": template, "accuracy": training.accuracy(y, pred)})
        ens = analysis.normalize(per_t.mean(0))
        pred = (x @ ens.T).argmax(1).tolist()
        return {
            "classes": classes,
            "images": len(idx),
            "per_template": rows,
            "ensemble_accuracy": training.accuracy(y, pred),
            "confusion": training.confusion(y, pred, len(classes)),
        }

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc


# --- jobs: linear probe and fine-tuning ------------------------------------------
@router.get("/v1/jobs", tags=["training"])
def jobs(request: Request) -> list[dict]:
    return request.app.state.jobs.list()


@router.get("/v1/jobs/{job_id}", tags=["training"])
def job(request: Request, job_id: str) -> dict:
    try:
        return request.app.state.jobs.get(job_id).as_dict()
    except LookupError as exc:
        raise _404(exc) from exc


@router.post("/v1/jobs/{job_id}/cancel", tags=["training"])
def cancel(request: Request, job_id: str) -> dict:
    try:
        j = request.app.state.jobs.get(job_id)
    except LookupError as exc:
        raise _404(exc) from exc
    j.cancelled.set()
    return j.as_dict(full=False)


@router.post("/v1/jobs", status_code=201, tags=["training"])
def start_job(request: Request, body: Annotated[dict, Body()]) -> dict:
    """``{"kind": "linear_probe" | "contrastive", "gallery": "...", "name": "...", ...}``"""
    enc = encoder(request)
    state = request.app.state
    kind = body.get("kind")
    name = (body.get("name") or f"{body.get('gallery')}-{kind}").replace("/", "_")
    gallery_name = body.get("gallery")
    data_dir = Path(state.settings.data_dir)
    try:
        state.galleries.items(gallery_name or "")
    except (LookupError, GalleryError) as exc:
        raise _404(exc) from exc

    if kind == "linear_probe":

        def fn(job):
            items, emb = state.galleries.embeddings(gallery_name, enc)
            return training.train_linear_probe(job, enc, items, emb, body, data_dir / "probes" / name)

    elif kind == "contrastive":
        if not isinstance(enc, HFEncoder):
            raise HTTPException(400, "fine-tuning needs a Hugging Face model")

        def fn(job):
            items = state.galleries.items(gallery_name)
            images = state.galleries.load_images(gallery_name, items)
            return training.contrastive_finetune(job, enc, items, images, body, data_dir / "models" / name)

    else:
        raise HTTPException(422, "kind must be linear_probe or contrastive")
    try:
        return state.jobs.start(kind, name, body, fn).as_dict(full=False)
    except JobBusy as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/v1/probes", tags=["training"])
def probes(request: Request) -> list[dict]:
    root = Path(request.app.state.settings.data_dir) / "probes"
    out = []
    if root.is_dir():
        for p in sorted(root.iterdir()):
            if (p / "probe.npz").exists():
                probe = training.load_probe(p)
                out.append({"name": p.name, "classes": [str(c) for c in probe["classes"]],
                            "model": str(probe["model"])})  # fmt: skip
    return out


@router.post("/v1/probes/{name}/classify", tags=["training"])
async def classify(request: Request, name: str, images: Annotated[list[UploadFile], File()]) -> dict:
    enc = encoder(request)
    path = Path(request.app.state.settings.data_dir) / "probes" / Path(name).name
    if not (path / "probe.npz").exists():
        raise HTTPException(404, f"probe {name!r} not found")
    probe = training.load_probe(path)
    if str(probe["model"]) != enc.model_id:
        raise HTTPException(409, f"probe was trained on {probe['model']}; load that model first")
    pics = await read_images(request, images)
    emb = await run_in_threadpool(enc.embed_images, pics)
    return {"results": [[{"label": c, "probability": p} for c, p in row] for row in training.apply_probe(probe, emb)]}
