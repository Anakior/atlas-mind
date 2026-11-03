"""The French interface speaks to people who are not developers: no git or protocol
jargon in its strings. The advanced token block (for clients that can't sign in), the
copy on a computer (commands typed in a terminal), the read-only demo and two build
errors are the only places allowed to name them."""
import re
import unittest
from pathlib import Path

I18N = Path(__file__).resolve().parent.parent / "src" / "viewer" / "lib" / "core" / "i18n.ts"
JARGON = re.compile(r"\b(markdown|commit|frontmatter|wikilinks?|MCP|OAuth|tokens?|repo|"
                    r"push|pull|SHA|slug|Bearer|build)\b", re.I)
ALLOWED = re.compile(r"^(settings(Create|Revoke|No)?Tokens?\w*|settingsMcpUrl|pc\w+|demo\w+|"
                     r"offlineMissing|sanitizerMissing)$")


def _french_strings():
    src = I18N.read_text(encoding="utf-8")
    block = src[src.index("  fr: {"):src.index("  en: {")]
    block = re.sub(r"^\s*//.*$", "", block, flags=re.M)  # comments are not shown
    for m in re.finditer(r"^    (\w+):\s*([\s\S]*?)(?=^    \w+:|\Z)", block, re.M):
        yield m.group(1), m.group(2)


class TestFrenchJargon(unittest.TestCase):
    def test_no_jargon_outside_the_advanced_corners(self):
        offenders = [f"{key}: {', '.join(sorted({w.lower() for w in JARGON.findall(val)}))}"
                     for key, val in _french_strings()
                     if JARGON.search(val) and not ALLOWED.match(key)]
        self.assertEqual(offenders, [], "jargon in French UI strings")


if __name__ == "__main__":
    unittest.main()
