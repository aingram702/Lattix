# Lattix relay — production container.
#
# Single-instance ASGI app (FastAPI + uvicorn) serving the API, WebSocket, and
# the bundled web client. Mount a volume at /data to persist the SQLite database
# (which also holds the encrypted file blobs).
#
# Build (from this directory):   docker build -t lattix .
# Run:                           docker run -p 8000:8000 -v lattix-data:/data lattix

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LATTIX_DB=/data/lattix.db

WORKDIR /app

# Install dependencies first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Application code + bundled client.
COPY server ./server
COPY client ./client

# Non-root user; writable data dir for the database.
RUN mkdir -p /data \
 && useradd --create-home --uid 10001 lattix \
 && chown -R lattix:lattix /app /data
USER lattix

EXPOSE 8000

# $PORT is honored for platforms that inject it (Render, Railway, Cloud Run…).
# --proxy-headers + --forwarded-allow-ips make per-IP rate limiting see the real
# client IP when running behind a trusted reverse proxy (see DEPLOYMENT.md).
CMD ["sh", "-c", "exec uvicorn server.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=${LATTIX_FORWARDED_ALLOW_IPS:-127.0.0.1}"]
