"""Stateful services for the Atlas server.

Each service owns its state + lock + behavior and is built once at boot by
AppContext (server/context.py). During the migration some modules also hold the
plain white-box functions the test suite reaches into (re-exported by the package
facade as server.<name>).
"""
