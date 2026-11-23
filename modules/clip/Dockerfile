# CLIP module. GPU by default (PyTorch 2.8, CUDA 12.6: NVIDIA driver 560 or newer).
# RTX 50-series (Blackwell) GPUs need CUDA 12.8:
#   --build-arg BASE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
# CPU only:
#   --build-arg BASE=python:3.12-slim --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cpu
# Recent transformers releases refuse PyTorch older than 2.6 ("AutoModel requires PyTorch >= 2.6").
ARG BASE=pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime
FROM ${BASE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/hf CLIP_DATA_DIR=/data PORT=8000

ARG TORCH_INDEX=""
RUN if [ -n "$TORCH_INDEX" ]; then pip install torch --index-url "$TORCH_INDEX"; fi

WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
RUN pip install .

# Fixed uid so that the shared Hugging Face cache volume (/hf) is writable by every module.
RUN useradd --system --uid 10001 --create-home app && mkdir -p /data /hf && chown app /data /hf
USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"$PORT\""]
