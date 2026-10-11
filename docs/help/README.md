# Desktop offline Help

The only canonical content is `docs/desktop/USER_GUIDE.md` and
`docs/desktop/USER_GUIDE.zh-TW.md`. `template.html` and `help.css` in this
directory are presentation sources for the page layout and styling.
Help includes neither engineering documentation nor Search.

`scripts/generate_help.py` renders those sources into
`apps/desktop/public/help/desktop.html`, `desktop.zh-TW.html`, and `help.css`.
These generated runtime files are tracked in Git. Do not edit them directly.
Regenerate after changing either guide, the template, or the stylesheet.
Run the following commands from the repository root.

On Windows PowerShell, a virtual environment is recommended but optional.
Create it and install the pinned Help dependency once:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements-help.txt
```

Use its Python executable directly to generate and validate Help; activating
the virtual environment in PowerShell is not required:

```powershell
.\.venv\Scripts\python.exe scripts/generate_help.py
.\.venv\Scripts\python.exe -B scripts/test_generate_help.py
.\.venv\Scripts\python.exe scripts/generate_help.py --check
```

Developers with a suitable existing Python environment can use the original
commands:

```sh
python -m pip install -r scripts/requirements-help.txt
python scripts/generate_help.py
python -B scripts/test_generate_help.py
python scripts/generate_help.py --check
```

The sync check generates into a temporary directory and compares all three
outputs with the tracked bundle. It also validates language links, template
expansion, and the absence of repository-local Markdown links. Local Markdown
links are rejected, not rewritten; public URLs are retained.

Python and Markdown are used only for Help development and CI validation.
Normal Desktop builds and the released EXE do not require Python. Vite and Tauri
builds consume the tracked bundle without running the generator. Vite copies
it to `dist/help/`; Tauri serves it as application assets in an on-demand
internal Help window.

Desktop passes its theme preference in the Help URL. Language links preserve
that query. Help has no persistent theme setting or live connection to the
main window. Close and reopen Help to use a changed Desktop preference.
