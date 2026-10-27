"""MCP prompts: requests the person starts by name (a slash command in Claude Code), filled
in by the server at call time. Two sources:

- the mind's own, one Markdown file per prompt under content/agents/prompts/ (editable
  from the viewer, versioned with the mind): a `description:` and `arguments:` in the
  frontmatter, the first heading as title, the rest as the text sent. `{{argument}}`
  takes the value given, `{{include path/doc.md}}` the text of that doc (if readable);
- the engine's built-ins, which compute live context: the week's changes, the open
  contradictions, a document template; or hand the model the tool to call (resume).

A mind prompt overrides a built-in of the same name."""
import datetime
import re

import server as _s
from store import slugify_token_label
from server.pure import contradictions, provenance
from server.pure.git_history import _attributed_log, _scrub_commits
from server.pure.queries import _visible, _api_stale

PROMPTS_DIR = "agents/prompts"
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)
_ARGUMENT_RE = re.compile(r"\{\{\s*([A-Za-z0-9_-]+)\s*\}\}")
_INCLUDE_RE = re.compile(r"\{\{\s*include\s+([^}]+?)\s*\}\}")


class PromptError(ValueError):
    """Unknown prompt or missing argument; the message says which."""


def _arguments(raw: str) -> list:
    """`subject, folder?` (or `[subject, folder?]`) → MCP arguments; `?` marks optional."""
    names = [n.strip() for n in raw.strip().strip("[]").split(",") if n.strip()]
    return [{"name": n.rstrip("?"), "required": not n.endswith("?")} for n in names]


def _mind_prompts(ctx) -> dict:
    """{name: prompt} from content/agents/prompts/, the ones ctx can read."""
    root = _s.CONFIG.content_root / PROMPTS_DIR
    if not root.is_dir():
        return {}
    found = {}
    for path in sorted(root.glob("*.md")):
        rel = f"{PROMPTS_DIR}/{path.name}"
        try:
            name = slugify_token_label(path.stem)
            text = path.read_text(encoding="utf-8-sig") if _visible(rel, ctx) else None
        except (ValueError, OSError, UnicodeDecodeError):
            continue
        if text is None:
            continue
        meta = {}
        m = _FRONTMATTER_RE.match(text)
        if m:
            for line in m.group(1).splitlines():
                key, sep, value = line.partition(":")
                if sep:
                    meta[key.strip().lower()] = value.strip().strip("'\"")
            text = text[m.end():]
        body = text.strip()
        title = name
        if body.startswith("# "):
            first, _, body = body.partition("\n")
            title, body = first[2:].strip(), body.strip()
        found[name] = {"title": title, "description": meta.get("description", ""),
                       "arguments": _arguments(meta.get("arguments", "")),
                       "render": lambda args, ctx, body=body: _fill(body, args, ctx)}
    return found


def _fill(body: str, args: dict, ctx) -> str:
    """Arguments first, then includes, so an included doc arrives verbatim."""
    body = _ARGUMENT_RE.sub(lambda m: args.get(m.group(1), m.group(0)), body)

    def include(m):
        rel = m.group(1).strip()
        target = _s._validate_doc_path(rel)
        if not (target and target.exists() and _visible(rel, ctx)):
            return f"({_s._t('prompt_include_missing')}: {rel})"
        return provenance.fence(target.read_text(encoding="utf-8-sig").strip(), rel)

    return _INCLUDE_RE.sub(include, body)


# ── built-ins ────────────────────────────────────────────────────────────────

def _bullets(lines) -> str:
    return "\n".join(f"- {line}" for line in lines) or f"- ({_s._t('prompt_none')})"


def _change_line(d: dict) -> str:
    who = d["last_editor"] + (f", AI {d['ai']}" if d.get("ai") else "")
    return f"{d['path']} ({d['change']}, {who})"


def _weekly_review(args, ctx) -> str:
    from server.pure.mcp_call import _doc_changes  # lazy: mcp_call imports this module
    days = int(args["days"]) if str(args.get("days", "")).isdigit() else 7
    commits = _scrub_commits(_attributed_log(f"--since={days}.days.ago") or [], ctx)
    changes = [_change_line(d) for d in _doc_changes(commits)[:30]]
    stale = [f"{s['path']} ({s['months_ago']} {_s._t('prompt_months')})" for s in _api_stale(6, 10, ctx)]
    pairs = [f"{c['a']} ⇄ {c['b']} — {c.get('subject', '')}"
             for c in contradictions.find_contradictions(ctx, 5, False)]
    return _s._t("prompt_weekly_body").format(days=days, changes=_bullets(changes),
                                              stale=_bullets(stale), contradictions=_bullets(pairs))


def _triage(args, ctx) -> str:
    pairs = []
    for c in contradictions.find_contradictions(ctx, 10, False):
        where = (f" ({_s._t('prompt_lines')} {c['a_line']} / {c['b_line']})"
                 if c.get("a_line") and c.get("b_line") else "")
        pairs.append(f"{c['a']} ⇄ {c['b']} — {c.get('subject', '')}{where}")
    return _s._t("prompt_triage_body").format(candidates=_bullets(pairs))


def _resume(args, ctx) -> str:
    topic = args.get("topic", "").strip()
    return _s._t("prompt_resume_body").format(topic=topic) if topic else _s._t("prompt_resume_list_body")


def _templates() -> dict:
    """The new-document skeletons: the engine's, overridden by the mind's templates/."""
    build = _s._import_build()
    from build.paths import TEMPLATES_DIR
    return build.load_doc_templates(TEMPLATES_DIR, _s.CONFIG.root / "templates")


def _new_doc(args, ctx) -> str:
    templates = _templates()
    name = args.get("template", "")
    if name not in templates:
        raise PromptError(f"unknown template '{name}': one of {', '.join(sorted(templates))}")
    skeleton = (templates[name].replace("{{title}}", args.get("subject", ""))
                .replace("{{date}}", datetime.date.today().isoformat()))
    return _s._t("prompt_new_doc_body").format(subject=args.get("subject", ""), template=name,
                                               skeleton=skeleton.strip())


def _builtins() -> dict:
    t = _s._t
    return {
        "weekly-review": {"title": t("prompt_weekly_title"), "description": t("prompt_weekly_description"),
                          "arguments": [{"name": "days", "description": t("prompt_arg_days"),
                                         "required": False}],
                          "render": _weekly_review},
        "triage-contradictions": {"title": t("prompt_triage_title"),
                                  "description": t("prompt_triage_description"),
                                  "arguments": [], "render": _triage},
        "resume": {"title": t("prompt_resume_title"), "description": t("prompt_resume_description"),
                   "arguments": [{"name": "topic", "description": t("prompt_arg_topic"), "required": False}],
                   "render": _resume},
        "new-doc": {"title": t("prompt_new_doc_title"), "description": t("prompt_new_doc_description"),
                    "arguments": [{"name": "template", "required": True,
                                   "description": t("prompt_arg_template").format(
                                       names=", ".join(sorted(_templates())))},
                                  {"name": "subject", "description": t("prompt_arg_subject"),
                                   "required": True}],
                    "render": _new_doc},
    }


def _all(ctx) -> dict:
    return {**_builtins(), **_mind_prompts(ctx)}


def list_prompts(ctx) -> list:
    """MCP prompt definitions, built-ins then the mind's (which win on a shared name)."""
    return [{"name": name, "title": p["title"], "description": p["description"],
             "arguments": p["arguments"]} for name, p in _all(ctx).items()]


def get_prompt(name: str, args: dict, ctx) -> dict:
    """The filled-in prompt as MCP messages. Raises PromptError."""
    prompt = _all(ctx).get(name)
    if prompt is None:
        raise PromptError(f"unknown prompt '{name}'")
    # An optional argument left out reads as empty, never as a raw {{placeholder}}.
    args = ({a["name"]: "" for a in prompt["arguments"]}
            | {k: str(v) for k, v in (args or {}).items()})
    missing = [a["name"] for a in prompt["arguments"] if a["required"] and not args.get(a["name"])]
    if missing:
        raise PromptError(f"missing argument(s): {', '.join(missing)}")
    text = prompt["render"](args, ctx)
    return {"description": prompt["description"],
            "messages": [{"role": "user", "content": {"type": "text", "text": text}}]}
