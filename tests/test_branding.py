"""Tests for the engine branding: fixed "Atlas" mark, configurable prefix.

Product decision: "Atlas" is THE MARK -- fixed, always present, styled with
the identity fonts (prefix in Corinthia cursive, "Atlas" wordmark in serif Lora
deep-gold, "Mind" as the nebula pill). The user only configures an optional PREFIX via the root `prefix`
key of atlas.toml ("Acme's" -> "Acme's Atlas"; empty -> "Atlas"). The full name
(site_name) is DERIVED and stays plain text everywhere it surfaces in the clear:
<title>, PWA manifest, OpenAPI, MCP serverInfo, share footer, boot banner.

Without atlas.toml the engine stays neutral: no personal branding ("Acme",
"example corp"...) anywhere -- only the "Atlas" mark is shown. The prefix goes
through the same escaping as the rest of the identity (html.escape on the HTML
side, JSON constant on the viewer's JS side -- never raw text in a template
literal).

Also covers the NUL-bytes fix (graph dedup key: separator "\\x00" -> "\\n"):
viewer/viewer.html and dist/index.html must be NUL-free so grep audits stay
reliable (grep treats a file with NUL as binary).
"""
from __future__ import annotations

import contextlib
import html
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

from harness import AtlasServer

REPO_ROOT = Path(__file__).resolve().parent.parent
REPO_SRC = REPO_ROOT / "src"
if str(REPO_SRC) not in sys.path:
    sys.path.insert(0, str(REPO_SRC))

import build  # noqa: E402
from config import AtlasConfig, AtlasConfigError  # noqa: E402

# Reproduces the historical personal identity -- it must become possible again
# IDENTICALLY through the prefix alone, never hardcoded anymore.
BRANDED_TOML = """\
prefix = "Acme's"
tagline = "Cours, bilans, cahiers des charges et notes."
lang = "fr"
"""

# html.escape(..., quote=True): the apostrophe comes out as an entity.
BRANDED_NAME_ESCAPED = "Acme&#x27;s Atlas Mind"
BRANDED_PREFIX_ESCAPED = "Acme&#x27;s"


class BrandedAtlasServer(AtlasServer):
    """AtlasServer whose mind embeds an atlas.toml (written BEFORE the git init
    and the build, like a real configured mind)."""

    def __init__(self, toml_text: str, **kwargs):
        super().__init__(**kwargs)
        self._toml_text = toml_text

    def _populate(self) -> None:
        super()._populate()
        (self.root / "atlas.toml").write_text(self._toml_text, encoding="utf-8")


class TestBrandingConfig(unittest.TestCase):
    """AtlasConfig: neutral defaults, prefix -> site_name derivation, validation."""

    def _config(self, toml_data: dict) -> AtlasConfig:
        with tempfile.TemporaryDirectory(prefix="atlas-branding-") as tmp:
            return AtlasConfig(tmp, toml_data=toml_data, env={})

    def test_defaults_are_neutral(self):
        cfg = self._config({})
        self.assertEqual(cfg.prefix, "")
        self.assertEqual(cfg.site_name, "Atlas Mind")
        self.assertEqual(cfg.site_short_name, "Atlas Mind")
        self.assertEqual(cfg.lang, "en")
        self.assertEqual(cfg.site_slug, "atlas-mind")
        # Neutral baseline: short, non-empty, without the historical personal
        # branding.
        self.assertTrue(cfg.tagline)
        self.assertNotIn("Acme", cfg.tagline)
        self.assertNotIn("Cours, bilans", cfg.tagline)

    def test_branding_read_from_toml_and_slugified(self):
        cfg = self._config({"prefix": "Acme's",
                            "tagline": "Cours, bilans, cahiers des charges et notes.",
                            "lang": "en"})
        self.assertEqual(cfg.prefix, "Acme's")
        # The full name is DERIVED: "<prefix> Atlas", fixed mark.
        self.assertEqual(cfg.site_name, "Acme's Atlas Mind")
        self.assertEqual(cfg.site_short_name, "Atlas Mind")
        self.assertEqual(cfg.tagline,
                         "Cours, bilans, cahiers des charges et notes.")
        self.assertEqual(cfg.lang, "en")
        # Machine slug (MCP serverInfo): lowercase, non-alphanumeric -> '-'.
        self.assertEqual(cfg.site_slug, "acme-s-atlas-mind")

    def test_empty_or_blank_prefix_derives_bare_wordmark(self):
        # Empty or blank prefix = no prefix: the mark alone, never an empty
        # <title>/manifest nor a stray space before "Atlas".
        for raw in ("", "   "):
            cfg = self._config({"prefix": raw})
            self.assertEqual(cfg.prefix, "")
            self.assertEqual(cfg.site_name, "Atlas Mind")
            self.assertEqual(cfg.site_slug, "atlas-mind")

    def test_filled_prefix_is_stripped_and_derives_site_name(self):
        cfg = self._config({"prefix": "  Zoé  "})
        self.assertEqual(cfg.prefix, "Zoé")
        self.assertEqual(cfg.site_name, "Zoé Atlas Mind")
        # Even when short (< 12 characters), the short_name stays the mark alone.
        self.assertEqual(cfg.site_short_name, "Atlas Mind")

    def test_legacy_site_name_key_warns_and_suggests_prefix(self):
        # site_name no longer exists: the key is ignored (backward compat) with a
        # stderr warning that points to its replacement -- difflib alone would
        # never relate "site_name" to "prefix".
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            cfg = self._config({"site_name": "Acme's Atlas"})
        warning = stderr.getvalue()
        self.assertIn("site_name", warning)
        self.assertIn("ignored", warning)
        self.assertIn("'prefix'", warning)
        # The ignored key does not bleed into the identity: neutral default.
        self.assertEqual(cfg.site_name, "Atlas Mind")

    def test_invalid_lang_raises_actionable_error(self):
        with self.assertRaises(AtlasConfigError) as ctx:
            self._config({"lang": "de"})
        self.assertIn("lang", str(ctx.exception))

    def test_site_section_parsed(self):
        cfg = self._config({"site": {
            "url": "https://atlas-mind.anakior.app/demo/",
            "description": "Demo description.",
            "og_image": "https://atlas-mind.anakior.app/assets/card.jpg"}})
        self.assertEqual(cfg.site_url, "https://atlas-mind.anakior.app/demo/")
        self.assertEqual(cfg.site_description, "Demo description.")
        self.assertEqual(cfg.og_image,
                         "https://atlas-mind.anakior.app/assets/card.jpg")

    def test_site_defaults_empty(self):
        # No [site] → a private instance: empty url/description/og_image, so the
        # build emits no canonical/OG.
        cfg = self._config({})
        self.assertEqual(cfg.site_url, "")
        self.assertEqual(cfg.site_description, "")
        self.assertEqual(cfg.og_image, "")


HOSTILE_PREFIX = "`${alert(1)}\"'</script><svg onload=evil()>"


class TestBrandingHostilePrefix(unittest.TestCase):
    """The prefix goes through the SAME escaping as the rest of the identity:
    html.escape in an HTML context, JSON encoding (with </script> protection) for
    the viewer's JS constant. A hostile prefix (backtick, ${...}, quotes,
    </script>) must neither break the script nor inject a tag."""

    @classmethod
    def setUpClass(cls):
        cls.rendered = build.render_template(
            tree={"name": "content", "path": "", "dirs": [], "files": []},
            embed_content=None, embed_backlinks=None, embed_notes=None,
            build_ts="2026-01-01T00:00:00Z",
            site_prefix=HOSTILE_PREFIX,
            tagline="Test tagline.", lang="fr")

    def test_placeholders_consumed(self):
        self.assertNotIn("__SITE_PREFIX__", self.rendered)
        self.assertNotIn("__SITE_PREFIX_JSON__", self.rendered)

    def test_hostile_prefix_never_lands_raw_in_html(self):
        # The raw sequence would close the viewer's <script> and inject an
        # executable <svg onload=...>: it must only exist escaped.
        self.assertNotIn("</script><svg", self.rendered)
        self.assertIn("&lt;/script&gt;&lt;svg onload=evil()&gt;", self.rendered)

    def test_prefix_is_a_json_constant_in_js(self):
        # On the JS side: a JSON constant (backtick and ${...} inert inside a JSON
        # string), with the </ -> <\/ protection against tag closing.
        expected = (json.dumps(HOSTILE_PREFIX, ensure_ascii=False)
                    .replace("</", "<\\/"))
        # esbuild chains the bundled symbol into a comma-separated top-level `var`
        # (name preserved, terminated by `,` not `;`); what matters is the exact
        # JSON-encoded value of the constant.
        self.assertRegex(
            self.rendered,
            r"SITE_PREFIX\s*=\s*" + re.escape(expected) + r"\s*[,;]")

    def test_title_is_derived_site_name_escaped(self):
        expected = html.escape(f"{HOSTILE_PREFIX} Atlas Mind", quote=True)
        self.assertIn(f"<title>{expected}</title>", self.rendered)

    def test_manifest_short_name_is_always_the_wordmark(self):
        # name = derived, short_name = the mark alone -- even when the full name
        # would fit within a homescreen's 12 characters.
        manifest = build.render_manifest(site_prefix="Zo")
        self.assertEqual(manifest["name"], "Zo Atlas Mind")
        self.assertEqual(manifest["short_name"], "Atlas Mind")
        bare = build.render_manifest()
        self.assertEqual(bare["name"], "Atlas Mind")
        self.assertEqual(bare["short_name"], "Atlas Mind")


class TestBrandingNeutralDefaults(unittest.TestCase):
    """Without atlas.toml: everything served is neutral, and the engine (viewer/)
    no longer contains any personal marker nor NUL byte."""

    @classmethod
    def setUpClass(cls):
        cls.srv = AtlasServer()
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_viewer_defaults_are_neutral(self):
        text = self.srv.get("/").text
        self.assertIn("<title>Atlas Mind</title>", text)
        self.assertIn('<html lang="en">', text)
        self.assertIn("Personal knowledge base.", text)
        self.assertNotIn("Acme", text)
        # Without a prefix, the styled wordmark stays alone in the H1 (the prefix
        # span is empty) and the viewer's JS constant is the empty string.
        # (esbuild chains the symbol into a comma-separated `var`; the name + value
        # are preserved, terminated by `,` not `;`.)
        self.assertRegex(text, r'SITE_PREFIX\s*=\s*""[,;]')
        # The default mind has no [site].url → only a <meta description> from
        # the tagline, no canonical/OG it has no public URL to back.
        self.assertIn(
            '<meta name="description" content="Personal knowledge base.">', text)
        self.assertNotIn('property="og:', text)
        self.assertNotIn('rel="canonical"', text)
        # All identity placeholders were consumed by build.py.
        for placeholder in ("__SITE_NAME__", "__SITE_SHORT_NAME__",
                            "__SITE_PREFIX__", "__TAGLINE__", "__LANG__",
                            "__HEAD_META__"):
            self.assertNotIn(placeholder, text)
        # The engine itself (template + service worker) is de-personalized: no
        # proper name nor a PWA cache under a personal name anymore.
        template = (REPO_ROOT / "src" / "viewer" / "viewer.html").read_bytes()
        sw = (REPO_ROOT / "src" / "viewer" / "sw.js").read_bytes()
        for marker in (b"Acme", b"acme", b"example corp"):
            self.assertEqual(template.count(marker), 0, marker)
            self.assertEqual(sw.count(marker), 0, marker)
        self.assertIn(b"'atlas-cache-", sw)
        self.assertNotIn(b"kb-cache-v1'", sw.split(b"*/")[1])  # outside the comment

    def test_manifest_generated_with_neutral_defaults(self):
        # Generated by build.py in dist/ (the static web/manifest.json is gone),
        # served by the server at /manifest.json.
        self.assertTrue((self.srv.root / "dist" / "manifest.json").is_file())
        self.assertFalse((self.srv.root / "web" / "manifest.json").exists())
        manifest = self.srv.get("/manifest.json").json()
        self.assertEqual(manifest["name"], "Atlas Mind")
        self.assertEqual(manifest["short_name"], "Atlas Mind")
        self.assertEqual(manifest["lang"], "en")
        self.assertEqual(manifest["description"],
                         "Personal knowledge base.")

    def test_no_nul_bytes_in_template_nor_dist_index(self):
        # Fix agreed in the spec: the graph dedup key uses "\n" (impossible in a
        # path) instead of "\x00" -- zero NUL = reliable grep audits.
        template = (REPO_ROOT / "src" / "viewer" / "viewer.html").read_bytes()
        self.assertEqual(template.count(b"\x00"), 0)
        dist_index = (self.srv.root / "dist" / "index.html").read_bytes()
        self.assertEqual(dist_index.count(b"\x00"), 0)


class TestBrandingFromToml(unittest.TestCase):
    """prefix/tagline from atlas.toml: styled prefix in dist/index.html, derived
    name in the generated manifest and the OpenAPI -- the historical "Acme's
    Atlas" look is reproduced through the prefix alone."""

    @classmethod
    def setUpClass(cls):
        cls.srv = BrandedAtlasServer(BRANDED_TOML)
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_dist_index_uses_derived_site_name_and_tagline(self):
        text = self.srv.get("/").text
        # HTML escaping: the prefix's apostrophe breaks neither HTML nor JS (the
        # tab title re-reads document.title, entities already decoded).
        self.assertIn(f"<title>{BRANDED_NAME_ESCAPED}</title>", text)
        self.assertIn("Cours, bilans, cahiers des charges et notes.", text)
        self.assertNotIn("__SITE_NAME__", text)
        self.assertNotIn("__SITE_PREFIX__", text)

    def test_dist_index_styles_prefix_and_fixed_wordmark(self):
        text = self.srv.get("/").text
        # Sidebar H1: escaped prefix in the Corinthia span, fixed "Atlas"
        # wordmark in serif (Lora) deep-gold, "Mind" as the animated nebula pill.
        self.assertIn(f">{BRANDED_PREFIX_ESCAPED}</span>", text)
        self.assertIn("'Corinthia',cursive", text)
        self.assertIn("'Lora',Georgia,serif", text)
        self.assertIn(">Atlas</span>", text)
        self.assertIn('class="nebula-pill"', text)
        # The product identity's decorative fonts are loaded locally (vendored:
        # /vendor/fonts.css, no more fonts.googleapis request).
        self.assertIn('href="/vendor/fonts.css"', text)
        self.assertNotIn("fonts.googleapis.com", text)
        # Home (JS): the prefix comes from the JSON constant, never raw.
        # (esbuild chains the symbol into a comma-separated `var`; the JSON value
        # is what matters.)
        self.assertRegex(text, r"SITE_PREFIX\s*=\s*\"Acme's\"[,;]")

    def test_manifest_uses_derived_name_and_fixed_short_name(self):
        manifest = self.srv.get("/manifest.json").json()
        self.assertEqual(manifest["name"], "Acme's Atlas Mind")
        # short_name = the mark alone, always (identical to the historical
        # manifest: name "Acme's Atlas" / short_name "Atlas").
        self.assertEqual(manifest["short_name"], "Atlas Mind")
        self.assertEqual(manifest["description"],
                         "Cours, bilans, cahiers des charges et notes.")

    def test_openapi_title_uses_site_name(self):
        spec = self.srv.get("/.well-known/openapi.json").json()
        self.assertEqual(spec["info"]["title"], "Acme's Atlas Mind")


class TestBrandingLoginPage(unittest.TestCase):
    """Login page (cloud mode): title = derived site_name as plain text,
    H1 = prefix in Corinthia + "Atlas" wordmark in 'Rubik 80s Fade' -- the
    original styling, restored by the "fixed mark" decision."""

    @classmethod
    def setUpClass(cls):
        cls.srv = BrandedAtlasServer(BRANDED_TOML, extra_env={
            "KB_AUTH_ENABLED": "1",
            "SESSION_SECRET": "branding-test-secret-0123456789abcdef",
            "KB_REPO_PATH": "{root}",   # bypasses the git clone at boot
            "ATLAS_STORE": "file",
            "GIT_PULL_INTERVAL": "3600",
        })
        cls.srv.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()

    def test_login_page_styles_prefix_and_fixed_wordmark(self):
        resp = self.srv.get("/login")
        self.assertEqual(resp.status, 200)
        # The <title> stays the derived name as plain text.
        self.assertIn(f"<title>{BRANDED_NAME_ESCAPED} — Login</title>",
                      resp.text)
        # H1: span.brand (Corinthia) for the escaped prefix, span.atlas (serif
        # Lora, deep-gold) for the fixed mark, span.mind = the nebula pill.
        self.assertIn(
            f'<h1><span class="brand">{BRANDED_PREFIX_ESCAPED}</span> '
            '<span class="wordmark"><span class="atlas">Atlas</span>'
            '<span class="mind">Mind</span></span></h1>', resp.text)
        self.assertIn("'Corinthia',cursive", resp.text)
        self.assertIn("'Lora',Georgia,serif", resp.text)
        # The product identity's fonts are loaded locally (vendored:
        # /vendor/fonts.css, no more fonts.googleapis request).
        self.assertIn('href="/vendor/fonts.css"', resp.text)
        self.assertNotIn("fonts.googleapis.com", resp.text)


class TestHeadMetaSEO(unittest.TestCase):
    """The viewer <head>'s description / canonical / Open Graph block, driven by
    the optional [site] config. The description is ALWAYS emitted (falls back to
    the tagline); canonical + OG/Twitter appear ONLY when [site].url is set, so a
    private, per-user instance never advertises a canonical URL it doesn't have."""

    def _render(self, **site) -> str:
        return build.render_template(
            tree={"name": "content", "path": "", "dirs": [], "files": []},
            embed_content=None, embed_backlinks=None, embed_notes=None,
            build_ts="2026-01-01T00:00:00Z", tagline="My tagline.", lang="en",
            **site)

    def test_description_always_emitted_from_tagline(self):
        html = self._render()
        self.assertIn('<meta name="description" content="My tagline.">', html)
        self.assertNotIn("__HEAD_META__", html)

    def test_no_canonical_or_og_without_url(self):
        html = self._render()
        self.assertNotIn('property="og:', html)
        self.assertNotIn('rel="canonical"', html)
        self.assertNotIn('name="twitter:', html)

    def test_explicit_description_overrides_tagline(self):
        html = self._render(site_description="Custom SEO description.")
        self.assertIn(
            '<meta name="description" content="Custom SEO description.">', html)

    def test_url_emits_canonical_and_large_og_card(self):
        html = self._render(site_url="https://example.com/demo/",
                            og_image="https://example.com/card.jpg")
        self.assertIn('<link rel="canonical" href="https://example.com/demo/">',
                      html)
        self.assertIn('<meta property="og:type" content="website">', html)
        self.assertIn(
            '<meta property="og:url" content="https://example.com/demo/">', html)
        self.assertIn(
            '<meta property="og:image" content="https://example.com/card.jpg">',
            html)
        self.assertIn(
            '<meta name="twitter:card" content="summary_large_image">', html)

    def test_url_without_image_is_a_summary_card(self):
        html = self._render(site_url="https://example.com/")
        self.assertIn('<meta name="twitter:card" content="summary">', html)
        self.assertNotIn("og:image", html)

    def test_og_locale_follows_lang(self):
        html = build.render_template(
            tree={"name": "content", "path": "", "dirs": [], "files": []},
            embed_content=None, embed_backlinks=None, embed_notes=None,
            build_ts="2026-01-01T00:00:00Z", tagline="x", lang="fr",
            site_url="https://example.com/")
        self.assertIn('<meta property="og:locale" content="fr_FR">', html)

    def test_hostile_site_values_are_escaped(self):
        # A description with quotes/markup would break out of the content
        # attribute and inject a tag: it must only exist escaped.
        html = self._render(site_url="https://example.com/",
                            site_description='"><script>alert(1)</script>')
        self.assertNotIn("<script>alert(1)", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", html)


class TestEmbedActivity(unittest.TestCase):
    """The offline activity-layer snapshot embed (__EMBED_ACTIVITY__): null online
    (the home fetches /api/activity), or the inlined {events, stale,
    contradictions} snapshot offline so the static demo shows the activity home."""

    def _render(self, embed_activity):
        return build.render_template(
            tree={"name": "content", "path": "", "dirs": [], "files": []},
            embed_content=None, embed_backlinks=None, embed_notes=None,
            embed_activity=embed_activity,
            build_ts="2026-01-01T00:00:00Z", tagline="x", lang="en")

    def test_null_when_not_embedded(self):
        # Online build (and any build without a snapshot): the JS constant is null
        # so the viewer falls back to the live /api/activity fetch.
        # (esbuild chains the symbol into a comma-separated `var`; the name + value
        # are preserved, terminated by `,` not `;`.)
        self.assertRegex(self._render(None),
                         r"EMBED_ACTIVITY\s*=\s*null[,;]")

    def test_snapshot_inlined_when_embedded(self):
        snap = {"events": [{"sha": "abc123", "type": "edit", "ai": "claude"}],
                "stale": [], "contradictions": []}
        html = self._render(snap)
        # Mirror of the null check above against the reshaped comma-chained `var`
        # form, so this stays a real assertion (not a tautology now that the symbol
        # is never emitted with a leading `var ` keyword).
        self.assertNotRegex(html, r"EMBED_ACTIVITY\s*=\s*null[,;]")
        self.assertIn('"events"', html)
        self.assertIn('"sha": "abc123"', html)


if __name__ == "__main__":
    unittest.main()
