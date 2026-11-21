# VLM module. GPU by default (CUDA 12.4 PyTorch); for CPU only build with
#   --build-arg BASE=python:3.12-slim --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cpu
ARG BASE=pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
FROM ${BASE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/hf VLM_DATA_DIR=/data PORT=8000

ARG TORCH_INDEX=""
RUN if [ -n "$TORCH_INDEX" ]; then pip install torch --index-url "$TORCH_INDEX"; fi

WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
RUN pip install . && (pip install "bitsandbytes>=0.44" || echo "bitsandbytes unavailable: no 4/8-bit")

# Fixed uid so that the shared Hugging Face cache volume (/hf) is writable by every module.
RUN useradd --system --uid 10001 --create-home app && mkdir -p /data /hf && chown app /data /hf
USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"$PORT\""]
