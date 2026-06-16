"""Pure module constants: cookie names, request bounds, identity/role/regex
patterns, URLs, protocol versions. Stdlib-only (re); re-exported via the server
facade so the call sites and routes/ resolve them as server.* unchanged."""
import re

COOKIE_NAME = "kb_session"
# Readable CSRF cookie (NOT HttpOnly): the logged-in page reads it to set the
# X-CSRF-Token header on mutating requests (session-bound double-submit).
# Distinct from the HttpOnly session cookie.
CSRF_COOKIE_NAME = "kb_csrf"

# Bounds the request body: a huge Content-Length would inflate the in-memory
# read (DoS on the 256 MB VM). 25 MB = generous for a .md, tight for abuse.
MAX_BODY_BYTES = 25 * 1024 * 1024

# Identities (admin/viewer email, token identity email): basic email form +
# hardened bounds. RFC 5321 caps the address at 254 bytes; we also reject any
# C0/C1 control character (the \s in the pattern let NUL and DEL through, which
# would pollute the durable registry).
_EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+")
MAX_EMAIL_LEN = 254
MAX_TOKEN_LABEL_LEN = 100

# API role = read + create only, never via a session cookie. (The admin UI's
# creatable roles — admin / viewer — are validated inline in routes/admin.py.)
API_ROLE = "api"

# Federation: the atlas-node share-link prefix, the read-only mirror root under
# content_root, and the per-fetch byte cap (manifest or file).
NODE_LINK_PREFIX = "atlas-node:"
REMOTES_DIR = "remotes"
MAX_NODE_FILE_BYTES = 25 * 1024 * 1024

# PyPI project page, shown in the admin update banner.
PROJECT_URL = "https://pypi.org/project/atlas-mind/"

# Git revision accepted by the read-only history endpoints: a full/abbreviated SHA
# or HEAD/HEAD~N. A flag-looking ("--output=…") or path-looking value must never
# slip through to git's argument parser.
_GIT_REV_RE = re.compile(r"^(?:[0-9a-fA-F]{4,40}|HEAD(?:~\d+)?)$")

# Share-link id in /api/share/<id> (DELETE revoke, PATCH reactivate): an EXACT
# 24-hex legacy id OR a uuid4 8-4-4-4-12 (FileStore). Strict alternation — any
# other format (e.g. 25 hex) does not match, so it falls through to the todos
# route (historical bare 404). Used by the DELETE/PATCH route tables and re-matched
# by routes.share.revoke / routes.share.repoint.
_SHARE_ID_PATTERN = (
    r"^/api/share/([a-fA-F0-9]{24}|"
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
)

# MCP JSON-RPC protocol version advertised on initialize.
MCP_PROTOCOL_VERSION = "2025-03-26"
