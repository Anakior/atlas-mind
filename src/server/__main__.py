"""`python -m server`: boot the Atlas server for the current mind.

Prod runs `python -m atlas_mind.server` (the Fly image); cli.py (`atlas serve`,
via execve) and the test harness run `python -m server` with the engine src on
PYTHONPATH. The boot logic lives in server/__init__.py:run() — a plain
`import server` (e.g. from a test) imports the module without booting it.
"""
from server import run

if __name__ == "__main__":
    run()
