FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The engine (src/) bundles its own assets: src/web (viewer + vendored libs/fonts
# + sw.js + icon.svg) and src/templates (new-document skeletons). The image is
# SELF-CONTAINED — web_dir = PACKAGE_DIR/web (see config.py) — and the cloned mind
# carries no engine code, only content.
COPY src/ ./src/

# Non-root user: in case of an RCE, no root access to the GitHub PAT (embedded
# in the clone URL). `app` owns /app to clone/write the
# repo (KB_REPO_PATH=/app/repo) and commit at runtime.
RUN useradd --create-home --uid 10001 app && chown -R app:app /app

# PYTHONPATH puts the engine src on the path so `python -m server` resolves the
# server package (src/server/) — the same invocation cli.py and the test harness
# use. run() (server/__init__.py) chdir's to the mind itself, so the launch cwd
# does not matter.
ENV KB_AUTH_ENABLED=1 \
    KB_REPO_PATH=/app/repo \
    PORT=8765 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

USER app

EXPOSE 8765

CMD ["python", "-m", "server"]
