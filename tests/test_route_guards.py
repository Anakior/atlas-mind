"""T3 — anti-footgun: no mutating or admin route may be PUBLIC.

POST/PUT/PATCH/DELETE routes carry per-route Guards (do_<VERB> just dispatches),
so a route accidentally left PUBLIC would be reachable with NO auth and NO CSRF.
This locks the route table: PUT/PATCH/DELETE are never PUBLIC, and the only PUBLIC
POST routes are the unauthenticated entry points (login / setup / invite / webhook),
which protect themselves (credentials / single-use token / HMAC signature).
"""
import sys
import unittest
from pathlib import Path

REPO_SRC = Path(__file__).resolve().parent.parent / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

from server.app import routes_table  # noqa: E402
from server.app.router import Guard  # noqa: E402

# POST routes that are PUBLIC BY DESIGN: unauthenticated entry points with their
# own protection (no session exists yet to bind a synchronizer CSRF token to).
ALLOWED_PUBLIC_POST = {
    "/login",           # credentials
    "/api/setup",       # constant-time setup token (first admin)
    "/api/invite",      # single-use invite token (C1)
    "/webhook/github",  # HMAC signature
}


class TestRouteGuards(unittest.TestCase):

    def test_no_public_put_patch_delete(self):
        for table in ("PUT_ROUTES", "PATCH_ROUTES", "DELETE_ROUTES"):
            for r in getattr(routes_table, table):
                self.assertIsNot(
                    r.guard, Guard.PUBLIC,
                    f"{table} {r.pattern!r} is PUBLIC — a mutating route with no "
                    "auth/CSRF guard (anti-footgun T3)")

    def test_public_post_only_for_known_entry_points(self):
        for r in routes_table.POST_ROUTES:
            if r.guard is Guard.PUBLIC:
                self.assertIn(
                    r.pattern, ALLOWED_PUBLIC_POST,
                    f"POST {r.pattern!r} is PUBLIC but is not a known "
                    "self-protecting entry point — give it an explicit Guard")

    def test_admin_get_listings_are_admin_guarded(self):
        # /api/admin/* GET endpoints must be ADMIN (no anonymous enumeration).
        for r in routes_table.GET_ROUTES:
            if isinstance(r.pattern, str) and r.pattern.startswith("/api/admin/"):
                self.assertIn(
                    r.guard, (Guard.ADMIN, Guard.ADMIN_CSRF),
                    f"GET {r.pattern!r} under /api/admin/ is not admin-guarded")


if __name__ == "__main__":
    unittest.main()
