"""`python -m server`: boot the Atlas server for the current mind.

Every launch path uses this same entrypoint with the engine src on PYTHONPATH:
the Fly image (deploy/Dockerfile, PYTHONPATH=/app/src), cli.py (`atlas serve`, via
execve) and the test harness. The boot logic lives in server/__init__.py:run() —
a plain `import server` (e.g. from a test) imports the module without booting it.
"""
from server import run

if __name__ == "__main__":
    run()
