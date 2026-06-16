"""HTTP route handlers, grouped by domain.

Each module exposes plain functions `def <name>(handler)` that take the live
Handler and self-guard NOTHING — the auth `Guard` is declared in the route table
(see server/router.py) and applied by the dispatcher. Module-level helpers and the
config/context are reached through the `server` package facade (imported as `_s`);
the Handler's plumbing (`_send_json`, `_read_json`, `_session`, …) through the
passed `handler`.
"""
