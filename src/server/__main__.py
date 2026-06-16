"""Boot the Atlas server for the current mind.

Two entry points run this same module, and server/__init__.py self-bootstraps for
both (puts its package dir on sys.path + aliases itself as the flat `server`):
  • prod (pip-installed): `python -m atlas_mind.server`;
  • dev / tests / the COPY-src image: `python -m server` (engine src on PYTHONPATH).
The boot logic lives in server/__init__.py:run() — a plain `import server`
(e.g. from a test) imports the module without booting it.
"""
from server import run

if __name__ == "__main__":
    run()
