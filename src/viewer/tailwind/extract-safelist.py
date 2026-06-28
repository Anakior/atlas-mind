#!/usr/bin/env python3
"""Extrait une safelist Tailwind des classes générées dynamiquement par le JS.

Le compilateur Tailwind (CLI) scanne les fichiers de `content` comme du texte
brut : les classes écrites en entier dans le HTML ou dans une chaîne JS sont
trouvées. Mais une classe construite dynamiquement (concaténation, ternaire
dans un template literal…) peut lui échapper. Ce script récupère donc TOUTES
les chaînes littérales ('…', "…", `…`) des blocs <script> de viewer.html (et
des JS d'extensions passés en plus), les découpe en tokens et les écrit dans
safelist.txt — consommé par tailwind.config.cjs.

Générosité voulue : un token qui n'est pas une vraie utilité Tailwind est
ignoré silencieusement par le compilateur ; du CSS en trop ne casse rien,
une classe manquante si.

Usage : python3 viewer/tailwind/extract-safelist.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
SOURCES = [
    REPO_ROOT / "viewer" / "viewer.html",
    # Demonolithified viewer: the dynamically-built classes now live in the JS
    # modules under viewer/lib/ (not viewer.html's old inline <script>) — scan them
    # too, otherwise the safelist comes out empty.
    *sorted((REPO_ROOT / "viewer" / "lib").rglob("*.js")),
    *sorted((REPO_ROOT / "viewer" / "lib").rglob("*.ts")),
    *sorted((REPO_ROOT / "examples" / "extensions").rglob("*.js")),
]
OUT = HERE / "safelist.txt"

# Chaînes littérales JS : '…', "…" et `…` (template literals, multi-lignes).
_STRING_RE = re.compile(
    r"'((?:[^'\\\n]|\\.)*)'"
    r'|"((?:[^"\\\n]|\\.)*)"'
    r"|`((?:[^`\\]|\\.)*)`", re.S)

# Token plausible de classe (inclut variantes `hover:`, fractions, valeurs
# arbitraires `text-[11px]`, opacités `bg-white/5`, négatifs `-mt-1`).
_TOKEN_RE = re.compile(r"^-?!?[a-z][a-zA-Z0-9:/\[\]().%#,_-]*$")


def _script_blocks(text: str) -> str:
    return "\n".join(re.findall(r"<script[^>]*>(.*?)</script>", text, re.S | re.I))


def main() -> int:
    tokens: set[str] = set()
    for source in SOURCES:
        if not source.is_file():
            continue
        text = source.read_text(encoding="utf-8")
        if source.suffix == ".html":
            text = _script_blocks(text)
        for match in _STRING_RE.finditer(text):
            literal = next(g for g in match.groups() if g is not None)
            for token in re.split(r"[\s]+", literal):
                if 1 < len(token) <= 80 and _TOKEN_RE.match(token):
                    tokens.add(token)
    OUT.write_text("\n".join(sorted(tokens)) + "\n", encoding="utf-8")
    print(f"{len(tokens)} tokens -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
