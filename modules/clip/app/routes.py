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


def get_encoder(request: Request) -> Encoder:
    encoder = request.app.state.encoder
    if encoder is None:
        raise HTTPException(503, "no model loaded: PUT /v1/model first")
    return encoder


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
        except InvalidImageError as error:
            raise HTTPException(400, f"{f.filename}: {error}") from error
    return images


def _http_error(error: Exception) -> HTTPException:
    return HTTPException(404 if isinstance(error, LookupError) else 400, str(error))


@router.get("/health", tags=["ops"])
def health() -> dict:
    return {"status": "ok"}


@router.get("/v1/info", tags=["ops"])
def info(request: Request) -> dict:
    encoder = request.app.state.encoder
    return {
        "name": "clip",
        "kind": "embedding",
        "title": "CLIP image-text embeddings",
        "version": "0.1.0",
        "model": encoder.model_id if encoder else None,
        "device": getattr(encoder, "device", None) if encoder else None,
        "capabilities": ["embed", "similarity", "zero-shot", "retrieval", "linear-probe", "finetune"],
        "ui": "/ui/",
        "docs": "/docs",
    }


@router.get("/v1/presets", tags=["model"])
def presets() -> dict:
    return ballet.presets()


@router.get("/v1/models", tags=["model"])
def models(request: Request) -> dict:
    encoder = request.app.state.encoder
    return {
        "active": encoder.model_id if encoder else None,
        "catalog": CATALOG,
        "local": local_models(Path(request.app.state.settings.data_dir)),
    }


@router.get("/v1/model", tags=["model"])
def model_info(request: Request) -> dict:
    return get_encoder(request).info()


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
        encoder = await run_in_threadpool(
            HFEncoder.load, model_id, body.get("device") or settings.device,
            body.get("dtype") or settings.dtype,
        )  # fmt: skip
    except Exception as error:  # noqa: BLE001
        raise HTTPException(400, f"could not load {model_id}: {error}") from error
    request.app.state.encoder = encoder
    return encoder.info()


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
    return get_encoder(request).tokenize(body.get("texts") or [])


@router.post("/v1/embed/texts", tags=["embed"])
async def embed_texts(request: Request, body: Annotated[dict, Body()]) -> dict:
    embeddings = await run_in_threadpool(get_encoder(request).embed_texts, body.get("texts") or [])
    return {"dim": int(embeddings.shape[1]), "embeddings": embeddings.round(6).tolist()}


@router.post("/v1/embed/images", tags=["embed"])
async def embed_images(request: Request, images: Annotated[list[UploadFile], File()]) -> dict:
    pictures = await read_images(request, images)
    embeddings = await run_in_threadpool(get_encoder(request).embed_images, pictures)
    return {"dim": int(embeddings.shape[1]), "embeddings": embeddings.round(6).tolist()}


@router.post("/v1/similarity", tags=["analysis"])
async def similarity(
    request: Request,
    images: Annotated[list[UploadFile], File()],
    texts: Annotated[str, Form()],
    temperature: Annotated[float | None, Form(gt=0)] = None,
) -> dict:
    encoder = get_encoder(request)
    pictures = await read_images(request, images)
    text_list = parse_list(texts)
    if not text_list:
        raise HTTPException(422, "texts is empty")

    def run():
        return analysis.similarity(encoder, encoder.embed_images(pictures), text_list, temperature)

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
    encoder = get_encoder(request)
    pictures = await read_images(request, images)
    label_list = parse_list(labels) or ballet.STEPS
    template_list = parse_list(templates) or ballet.TEMPLATES
    if mode not in {"auto", "softmax", "sigmoid"}:
        raise HTTPException(422, "mode must be auto, softmax or sigmoid")

    def run():
        return analysis.zero_shot(
            encoder, encoder.embed_images(pictures), label_list, template_list,
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
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


@router.delete("/v1/galleries/{name}", status_code=204, tags=["retrieval"])
def delete_gallery(request: Request, name: str) -> Response:
    try:
        request.app.state.galleries.delete(name)
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error
    return Response(status_code=204)


@router.post("/v1/galleries/{name}/images", status_code=201, tags=["retrieval"])
async def add_images(
    request: Request,
    name: str,
    images: Annotated[list[UploadFile], File()],
    label: Annotated[str | None, Form()] = None,
    caption: Annotated[str | None, Form()] = None,
) -> dict:
    pictures = await read_images(request, images)
    store = request.app.state.galleries
    try:
        added = [
            store.add(name, pic, f.filename or "image", label, caption) for pic, f in zip(pictures, images, strict=True)
        ]
    except GalleryError as error:
        raise _http_error(error) from error
    return {"added": added}


@router.patch("/v1/galleries/{name}/items/{item_id}", tags=["retrieval"])
def update_item(request: Request, name: str, item_id: str, body: Annotated[dict, Body()]) -> dict:
    try:
        return request.app.state.galleries.update(name, item_id, body.get("label"), body.get("caption"))
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


@router.delete("/v1/galleries/{name}/items/{item_id}", status_code=204, tags=["retrieval"])
def delete_item(request: Request, name: str, item_id: str) -> Response:
    try:
        request.app.state.galleries.remove(name, item_id)
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error
    return Response(status_code=204)


@router.get("/v1/galleries/{name}/items/{item_id}/image", tags=["retrieval"])
def item_image(request: Request, name: str, item_id: str):
    try:
        return FileResponse(request.app.state.galleries.image_path(name, item_id))
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


@router.post("/v1/galleries/{name}/search", tags=["retrieval"])
async def search(
    request: Request,
    name: str,
    text: Annotated[str | None, Form()] = None,
    image: Annotated[UploadFile | None, File()] = None,
    k: Annotated[int, Form(ge=1, le=200)] = 12,
) -> dict:
    """Semantic retrieval: text -> images or image -> images."""
    encoder = get_encoder(request)
    store = request.app.state.galleries
    query_image = (await read_images(request, [image]))[0] if image is not None else None
    if not text and query_image is None:
        raise HTTPException(422, "give a text or an image")

    def run():
        items, embeddings = store.embeddings(name, encoder)
        if not items:
            return {"results": []}
        q = encoder.embed_texts([text])[0] if text else encoder.embed_images([query_image])[0]
        scores = embeddings @ q
        order = np.argsort(-scores)[:k]
        return {
            "query": text or "image",
            "results": [{**items[i], "score": round(float(scores[i]), 4)} for i in order],
        }

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


@router.post("/v1/galleries/{name}/projection", tags=["analysis"])
async def projection(request: Request, name: str, body: Annotated[dict, Body()] = None) -> dict:
    """2-D PCA map of the gallery images and some texts (default: its labels)."""
    body = body or {}
    encoder = get_encoder(request)
    store = request.app.state.galleries

    def run():
        items, embeddings = store.embeddings(name, encoder)
        texts = body.get("texts") or sorted({i["label"] for i in items if i.get("label")})
        template = body.get("template") or "a photo of a ballet dancer doing a {}."
        prompts = [template.format(t) if "{}" in template else t for t in texts]
        text_emb = encoder.embed_texts(prompts) if prompts else np.zeros((0, embeddings.shape[1]))
        result = analysis.projection(embeddings, text_emb)
        result["items"] = [{"id": i["id"], "label": i.get("label")} for i in items]
        result["text_labels"] = texts
        return result

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


@router.post("/v1/galleries/{name}/evaluate", tags=["analysis"])
async def evaluate(request: Request, name: str, body: Annotated[dict, Body()] = None) -> dict:
    """Zero-shot accuracy on the labelled gallery images, per prompt template
    (prompt sensitivity at dataset level) and for the template ensemble."""
    body = body or {}
    encoder = get_encoder(request)
    store = request.app.state.galleries

    def run():
        items, embeddings = store.embeddings(name, encoder)
        labelled = [index for index, item in enumerate(items) if item.get("label")]
        if not labelled:
            raise HTTPException(400, "no labelled images in this gallery")
        classes = sorted({items[index]["label"] for index in labelled})
        true_labels = [classes.index(items[index]["label"]) for index in labelled]
        templates = body.get("templates") or ballet.TEMPLATES
        descriptions = ballet.DESCRIPTIONS if body.get("use_descriptions") else None
        text_embeddings = analysis.label_embeddings(encoder, classes, templates, descriptions)  # (T, L, d)
        image_embeddings = embeddings[labelled]
        rows = []
        for template_index, template in enumerate(templates):
            predicted = (image_embeddings @ text_embeddings[template_index].T).argmax(1).tolist()
            rows.append({"template": template, "accuracy": training.accuracy(true_labels, predicted)})
        ensemble = analysis.normalize(text_embeddings.mean(0))
        predicted = (image_embeddings @ ensemble.T).argmax(1).tolist()
        return {
            "classes": classes,
            "images": len(labelled),
            "per_template": rows,
            "ensemble_accuracy": training.accuracy(true_labels, predicted),
            "confusion": training.confusion(true_labels, predicted, len(classes)),
        }

    try:
        return await run_in_threadpool(run)
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error


# --- jobs: linear probe and fine-tuning ------------------------------------------
@router.get("/v1/jobs", tags=["training"])
def jobs(request: Request) -> list[dict]:
    return request.app.state.jobs.list()


@router.get("/v1/jobs/{job_id}", tags=["training"])
def job(request: Request, job_id: str) -> dict:
    try:
        return request.app.state.jobs.get(job_id).as_dict()
    except LookupError as error:
        raise _http_error(error) from error


@router.post("/v1/jobs/{job_id}/cancel", tags=["training"])
def cancel(request: Request, job_id: str) -> dict:
    try:
        j = request.app.state.jobs.get(job_id)
    except LookupError as error:
        raise _http_error(error) from error
    j.cancelled.set()
    return j.as_dict(full=False)


@router.post("/v1/jobs", status_code=201, tags=["training"])
def start_job(request: Request, body: Annotated[dict, Body()]) -> dict:
    """``{"kind": "linear_probe" | "contrastive", "gallery": "...", "name": "...", ...}``"""
    encoder = get_encoder(request)
    state = request.app.state
    kind = body.get("kind")
    name = (body.get("name") or f"{body.get('gallery')}-{kind}").replace("/", "_")
    gallery_name = body.get("gallery")
    data_dir = Path(state.settings.data_dir)
    try:
        state.galleries.items(gallery_name or "")
    except (LookupError, GalleryError) as error:
        raise _http_error(error) from error

    if kind == "linear_probe":

        def run_job(job):
            items, embeddings = state.galleries.embeddings(gallery_name, encoder)
            return training.train_linear_probe(job, encoder, items, embeddings, body, data_dir / "probes" / name)

    elif kind == "contrastive":
        if not isinstance(encoder, HFEncoder):
            raise HTTPException(400, "fine-tuning needs a Hugging Face model")

        def run_job(job):
            items = state.galleries.items(gallery_name)
            images = state.galleries.load_images(gallery_name, items)
            return training.contrastive_finetune(job, encoder, items, images, body, data_dir / "models" / name)

    else:
        raise HTTPException(422, "kind must be linear_probe or contrastive")
    try:
        return state.jobs.start(kind, name, body, run_job).as_dict(full=False)
    except JobBusy as error:
        raise HTTPException(409, str(error)) from error


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
    encoder = get_encoder(request)
    path = Path(request.app.state.settings.data_dir) / "probes" / Path(name).name
    if not (path / "probe.npz").exists():
        raise HTTPException(404, f"probe {name!r} not found")
    probe = training.load_probe(path)
    if str(probe["model"]) != encoder.model_id:
        raise HTTPException(409, f"probe was trained on {probe['model']}; load that model first")
    pictures = await read_images(request, images)
    embeddings = await run_in_threadpool(encoder.embed_images, pictures)
    return {
        "results": [[{"label": c, "probability": p} for c, p in row] for row in training.apply_probe(probe, embeddings)]
    }
