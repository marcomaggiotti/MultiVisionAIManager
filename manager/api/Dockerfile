FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MANAGER_DATA_DIR=/data PORT=8080
WORKDIR /srv
# ffmpeg cuts videos (Live studio → Cut video).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
# PIP_EXTRAS=azure adds the Azure Blob Storage picture store
ARG PIP_EXTRAS=""
RUN if [ -n "$PIP_EXTRAS" ]; then pip install ".[$PIP_EXTRAS]"; else pip install .; fi
RUN useradd --system --uid 10001 --create-home app && mkdir -p /data && chown app /data
USER app
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"$PORT\""]
