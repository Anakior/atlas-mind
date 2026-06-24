"""Atlas Mind — self-hostable, AI-native knowledge base engine.

Installed as the `atlas_mind` package; the console entry point is `atlas`
(see pyproject.toml → atlas_mind.cli:main). The modules are also runnable as
scripts (python3 src/cli.py …) — cli/server/build bootstrap their own directory
onto sys.path so the flat intra-package imports resolve in both modes.
"""
__version__ = "0.8.5"
