"""The application context: the single config + (as the migration progresses) the
service objects, built once at boot and CARRIED BY the HTTP server so handlers
reach app state via `self.server.context` — the idiomatic http.server way, which
lets us kill the module-level globals one concern at a time. See plan-appcontext.
"""
from dataclasses import dataclass
from http.server import ThreadingHTTPServer

from server.services.git_sync import GitSync
from server.services.lockout import LockoutTracker
from server.services.rate_limit import RateLimiter
from server.services.reload_hub import ReloadHub
from server.services.remote_sync import RemoteSync
from server.services.setup_token import SetupToken
from server.services.update_check import UpdateChecker


@dataclass
class AppContext:
    config: object  # AtlasConfig — the single resolved configuration
    store: object   # store.FileStore — identity/share registry (built by run())
    rate_limiter: RateLimiter
    update_checker: UpdateChecker
    reload_hub: ReloadHub
    setup_token: SetupToken
    lockout: LockoutTracker
    git_sync: GitSync
    remote_sync: RemoteSync
    extension_routes: list  # [(method, compiled regex, handler, role)] — filled at boot

    @classmethod
    def build(cls, config, store) -> "AppContext":
        """Construct the context (config + store + services). Called ONLY from
        run() (after AtlasConfig.load + the eager store build), never at import
        time — a plain `import server` must not need a built config. The route list
        starts empty; load_server_extensions() populates it right after."""
        return cls(config=config, store=store, rate_limiter=RateLimiter(),
                   update_checker=UpdateChecker(), reload_hub=ReloadHub(),
                   setup_token=SetupToken(config=config, store=store),
                   lockout=LockoutTracker(config=config, store=store),
                   git_sync=GitSync(config=config),
                   remote_sync=RemoteSync(store=store),
                   extension_routes=[])


class AtlasHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that carries the AppContext. The Handler reads it via
    `self.server.context` (no module globals). The handler class is passed in to
    avoid importing Handler here (it lives in server/__init__)."""

    def __init__(self, server_address, context, handler_class):
        self.context = context  # set BEFORE super().__init__ binds the socket
        super().__init__(server_address, handler_class)
