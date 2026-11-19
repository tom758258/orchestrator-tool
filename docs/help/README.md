# Desktop and CLI offline Help

Desktop operator content is maintained in the two `docs/desktop/USER_GUIDE*.md` entry pages plus the bilingual `docs/desktop/guide/` and `docs/desktop/steps/` chapters. CLI content is maintained in `docs/cli/USER_GUIDE*.md`. These sources are operator-facing, distinct from the engineering READMEs.

`scripts/generate_help.py` produces the tracked Desktop landing pages `desktop.html` and `desktop.zh-TW.html` and one local HTML page for each translated guide chapter under `apps/desktop/public/help/`. It also produces `src/cli_help/cli.html`, `cli.zh-TW.html`, and `help.css` for embedding in the CLI EXE. Do not manually edit generated files. The existing `docs/help/template.html` and `help.css` are shared presentation sources. Neither Help requires an online service or a documentation server.

Use the existing pinned Python Help requirements, then from the repository root:

```powershell
python -m pip install -r scripts/requirements-help.txt
python scripts/generate_help.py
python -B scripts/test_generate_help.py
python scripts/generate_help.py --check
```

The generator verifies locale, local navigation and chapter links, and exact output synchronization. The Desktop's Help window derives its locale and theme from the application; each page carries its theme to other local pages, and a second Help click keeps the current chapter when its locale and appearance have not changed. The CLI command `orchestrator-tool user-guide [--lang en|zh-TW]` opens the embedded guide in the default browser using a content-identified user cache. The CLI guide uses the system/browser theme, not the Desktop preference. Normal builds do not require Python; they consume the tracked generated HTML and CSS.
