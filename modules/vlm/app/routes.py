from __future__ import annotations

import gc
import json
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app import ballet, training
from app.engine import CATALOG, DEFAULT_PARAMS, HFVLM, EngineError, VLMEngine, local_adapters
from app.imaging import InvalidImageError, decode_image
from app.jobs import JobBusy

router = APIRouter()


def get_engine(request: Request) -> VLMEngine:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(503, "no model loaded: PUT /v1/model first")
    return engine


async def read_images(request: Request, files: list[UploadFile] | None):
    settings = request.app.state.settings
    files = files or []
    if len(files) > settings.max_images:
        raise HTTPException(413, f"at most {settings.max_images} pictures per request")
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


def parse_params(params: str | None) -> dict:
    if not params:
        return {}
    try:
        value = json.loads(params)
    except json.JSONDecodeError as error:
        raise HTTPException(422, f"params must be JSON: {error}") from error
    unknown = set(value) - set(DEFAULT_PARAMS)
    if unknown:
        raise HTTPException(422, f"unknown decoding parameter(s): {', '.join(sorted(unknown))}")
    return value


def _http_error(error: Exception) -> HTTPException:
    return HTTPException(404 if isinstance(error, LookupError) else 400, str(error))


def free_gpu() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


@router.get("/health", tags=["ops"])
def health() -> dict:
    return {"status": "ok"}


@router.get("/v1/info", tags=["ops"])
def info(request: Request) -> dict:
    engine = request.app.state.engine
    return {
        "name": "vlm",
        "kind": "vision-language",
        "title": "Vision-language models",
        "version": "0.1.0",
        "model": engine.model_id if engine else None,
        "adapter": engine.adapter if engine else None,
        "device": str(getattr(engine, "device", "")) if engine else None,
        "capabilities": ["generate", "multi-image", "tokenize", "attention", "lora", "evaluate"],
        "ui": "/ui/",
        "docs": "/docs",
    }


@router.get("/v1/presets", tags=["model"])
def presets() -> dict:
    return {**ballet.presets(), "decoding": DEFAULT_PARAMS, "vocabulary": training.VOCABULARY}


@router.get("/v1/models", tags=["model"])
def models(request: Request) -> dict:
    engine = request.app.state.engine
    return {
        "active": engine.model_id if engine else None,
        "adapter": engine.adapter if engine else None,
        "catalog": CATALOG,
        "adapters": local_adapters(Path(request.app.state.settings.data_dir)),
    }


@router.get("/v1/model", tags=["model"])
def model_info(request: Request) -> dict:
    return get_engine(request).info()


@router.put("/v1/model", tags=["model"])
async def load_model(request: Request, body: Annotated[dict, Body()]) -> dict:
    """Load a model: ``{"model_id", "quantization": none|8bit|4bit, "dtype", "attn_implementation"}``."""
    s = request.app.state.settings
    if not body.get("model_id"):
        raise HTTPException(422, "model_id is required")
    if request.app.state.jobs.running():
        raise HTTPException(409, "a job is running; wait for it before switching models")
    request.app.state.engine = None
    free_gpu()
    try:
        engine = await run_in_threadpool(
            HFVLM.load,
            body["model_id"],
            body.get("device") or s.device,
            body.get("dtype") or s.dtype,
            body.get("quantization") or s.quantization,
            body.get("attn_implementation") or s.attn_implementation,
        )
    except Exception as error:  # noqa: BLE001
        raise HTTPException(400, f"could not load {body['model_id']}: {error}") from error
    request.app.state.engine = engine
    return engine.info()


@router.delete("/v1/model", status_code=204, tags=["model"])
def unload_model(request: Request) -> Response:
    """Free the GPU memory (e.g. to train YOLO or CLIP)."""
    request.app.state.engine = None
    free_gpu()
    return Response(status_code=204)


@router.put("/v1/adapter", tags=["model"])
async def load_adapter(request: Request, body: Annotated[dict, Body()]) -> dict:
    """Attach a LoRA adapter (``{"name": ...}``) or detach it (``{"name": null}``)."""
    engine = get_engine(request)
    if not isinstance(engine, HFVLM):
        raise HTTPException(400, "adapters need a Hugging Face model")
    name = body.get("name")

    def run():
        from peft import PeftModel

        if engine.adapter:
            engine.model = engine.model.unload()
            engine.adapter = None
        if name:
            path = Path(request.app.state.settings.data_dir) / "adapters" / Path(name).name
            if not (path / "adapter_config.json").exists():
                raise HTTPException(404, f"adapter {name!r} not found")
            engine.model = PeftModel.from_pretrained(engine.model, str(path)).eval()
            engine.adapter = Path(name).name
        return {"adapter": engine.adapter}

    return await run_in_threadpool(run)


@router.post("/v1/generate", tags=["generate"])
async def generate(
    request: Request,
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    system: Annotated[str | None, Form()] = None,
    params: Annotated[str | None, Form(description="JSON decoding parameters")] = None,
    sequence: Annotated[bool, Form(description="Pictures are consecutive moments")] = False,
) -> dict:
    engine = get_engine(request)
    pictures = await read_images(request, images)
    try:
        return await run_in_threadpool(
            engine.generate, pictures, prompt, system or None, parse_params(params), sequence
        )
    except (EngineError, ValueError) as error:
        raise _http_error(error) from error


@router.post("/v1/compare-decoding", tags=["generate"])
async def compare_decoding(
    request: Request,
    prompt: Annotated[str, Form()],
    configs: Annotated[str, Form(description="JSON list of decoding parameter sets")],
    images: Annotated[list[UploadFile] | None, File()] = None,
    system: Annotated[str | None, Form()] = None,
    sequence: Annotated[bool, Form()] = False,
) -> list[dict]:
    """Same picture and prompt, several decoding strategies side by side."""
    engine = get_engine(request)
    pictures = await read_images(request, images)
    sets = json.loads(configs)
    if not isinstance(sets, list) or not 1 <= len(sets) <= 6:
        raise HTTPException(422, "configs must be a list of 1 to 6 parameter sets")

    def run():
        out = []
        for p in sets:
            result = engine.generate(pictures, prompt, system or None, parse_params(json.dumps(p)), sequence)
            out.append({"config": p, **{k: result[k] for k in ("text", "new_tokens", "latency_ms", "tokens_per_s")}})
        return out

    return await run_in_threadpool(run)


@router.post("/v1/tokenize", tags=["inspect"])
async def tokenize(
    request: Request,
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    system: Annotated[str | None, Form()] = None,
    sequence: Annotated[bool, Form()] = False,
) -> dict:
    engine = get_engine(request)
    pictures = await read_images(request, images)
    return await run_in_threadpool(engine.tokenize, pictures, prompt, system or None, sequence)


@router.post("/v1/attention", tags=["inspect"])
async def attention(
    request: Request,
    prompt: Annotated[str, Form()],
    images: Annotated[list[UploadFile] | None, File()] = None,
    answer: Annotated[str | None, Form()] = None,
    system: Annotated[str | None, Form()] = None,
    sequence: Annotated[bool, Form()] = False,
) -> dict:
    """Where the answer looks: attention mass on image vs text tokens per layer
    and head, and a heat map over the image tokens."""
    engine = get_engine(request)
    pictures = await read_images(request, images)
    try:
        return await run_in_threadpool(engine.attention, pictures, prompt, answer or None, system or None, sequence)
    except (EngineError, ValueError) as error:
        raise _http_error(error) from error


# --- instruction datasets ---------------------------------------------------------
@router.get("/v1/datasets", tags=["datasets"])
def datasets(request: Request) -> list[dict]:
    return request.app.state.datasets.names()


@router.get("/v1/datasets/{name}", tags=["datasets"])
def dataset(request: Request, name: str) -> dict:
    try:
        return {"name": name, "items": request.app.state.datasets.items(name)}
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error


@router.delete("/v1/datasets/{name}", status_code=204, tags=["datasets"])
def delete_dataset(request: Request, name: str) -> Response:
    try:
        request.app.state.datasets.delete(name)
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error
    return Response(status_code=204)


@router.post("/v1/datasets/{name}/items", status_code=201, tags=["datasets"])
async def add_item(
    request: Request,
    name: str,
    instruction: Annotated[str, Form()],
    response: Annotated[str, Form()] = "",
    system: Annotated[str | None, Form()] = None,
    images: Annotated[list[UploadFile] | None, File()] = None,
) -> dict:
    pictures = await read_images(request, images)
    try:
        return request.app.state.datasets.add(name, pictures, instruction, response, system)
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error


@router.patch("/v1/datasets/{name}/items/{item_id}", tags=["datasets"])
def update_item(request: Request, name: str, item_id: str, body: Annotated[dict, Body()]) -> dict:
    try:
        return request.app.state.datasets.update(name, item_id, body)
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error


@router.delete("/v1/datasets/{name}/items/{item_id}", status_code=204, tags=["datasets"])
def delete_item(request: Request, name: str, item_id: str) -> Response:
    try:
        request.app.state.datasets.remove(name, item_id)
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error
    return Response(status_code=204)


@router.get("/v1/datasets/{name}/images/{file}", tags=["datasets"])
def dataset_image(request: Request, name: str, file: str):
    try:
        return FileResponse(request.app.state.datasets.image_path(name, file))
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error


# --- jobs ------------------------------------------------------------------------------
@router.get("/v1/jobs", tags=["jobs"])
def jobs(request: Request) -> list[dict]:
    return request.app.state.jobs.list()


@router.get("/v1/jobs/{job_id}", tags=["jobs"])
def job(request: Request, job_id: str) -> dict:
    try:
        return request.app.state.jobs.get(job_id).as_dict()
    except LookupError as error:
        raise _http_error(error) from error


@router.post("/v1/jobs/{job_id}/cancel", tags=["jobs"])
def cancel(request: Request, job_id: str) -> dict:
    try:
        j = request.app.state.jobs.get(job_id)
    except LookupError as error:
        raise _http_error(error) from error
    j.cancelled.set()
    return j.as_dict(full=False)


@router.post("/v1/jobs", status_code=201, tags=["jobs"])
def start_job(request: Request, body: Annotated[dict, Body()]) -> dict:
    """``{"kind": "lora" | "evaluate", "dataset": "...", ...options}``"""
    engine = get_engine(request)
    state = request.app.state
    kind, name = body.get("kind"), body.get("dataset")
    try:
        state.datasets.items(name or "")
    except (LookupError, ValueError) as error:
        raise _http_error(error) from error
    run_name = (body.get("name") or f"{name}-{kind}").replace("/", "_")
    if kind == "lora":
        if not isinstance(engine, HFVLM):
            raise HTTPException(400, "LoRA needs a Hugging Face model")
        out = Path(state.settings.data_dir) / "adapters" / run_name

        def run_job(job):
            return training.lora_finetune(job, engine, state.datasets, name, body, out, state.settings)

    elif kind == "evaluate":

        def run_job(job):
            return training.evaluate(job, engine, state.datasets, name, body)

    else:
        raise HTTPException(422, "kind must be lora or evaluate")
    try:
        return state.jobs.start(kind, run_name, body, run_job).as_dict(full=False)
    except JobBusy as error:
        raise HTTPException(409, str(error)) from error
