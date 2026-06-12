FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
# Viewer + vendored assets (web/vendor: marked, DOMPurify, highlight, MiniSearch,
# pako, precompiled tailwind.css, fonts) + sw.js + icon.svg. The engine is
# SELF-CONTAINED: web_dir = ENGINE_ROOT/web (see config.py) → the image serves its own
# viewer, the cloned mind no longer carries any code (no web/). Essential to
# break the clone↔image coupling and allow removing web/ on the mind side.
COPY web/ ./web/
# Engine's new-document skeletons (merged at build time with those from the
# cloned mind — see build.py load_doc_templates).
COPY templates/ ./templates/

# Non-root user: in case of an RCE, no root access to the GitHub PAT (embedded
# in the clone URL). `app` owns /app to clone/write the
# repo (KB_REPO_PATH=/app/repo) and commit at runtime.
RUN useradd --create-home --uid 10001 app && chown -R app:app /app

ENV KB_AUTH_ENABLED=1 \
    KB_REPO_PATH=/app/repo \
    PORT=8765 \
    PYTHONUNBUFFERED=1

USER app

EXPOSE 8765

CMD ["python", "src/server.py"]
