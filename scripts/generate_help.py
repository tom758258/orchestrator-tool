"""Generate and check the tracked Desktop offline Help bundle."""

import argparse
import html
import re
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit

import markdown
from markdown.extensions.toc import TocExtension, slugify_unicode


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps/desktop/public/help"
SOURCES = (
    ("USER_GUIDE.md", "desktop.html", "en"),
    ("USER_GUIDE.zh-TW.md", "desktop.zh-TW.html", "zh-TW"),
)
FILES = ("desktop.html", "desktop.zh-TW.html", "help.css")
TOKENS = ("{{lang}}", "{{title}}", "{{content}}")
HTML_WARNING = "<!-- Generated file. Do not edit directly. -->"


class HelpLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lang = None
        self.ids = set()
        self.fragments = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.lang = attrs.get("lang")
        if "id" in attrs:
            if attrs["id"] in self.ids:
                raise ValueError("Duplicate Help element ID")
            self.ids.add(attrs["id"])
        if "hreflang" in attrs or "help-languages" in attrs.get("class", "").split():
            raise ValueError("Help language is selected by the Desktop application")
        if tag != "a" or "href" not in attrs:
            return
        href = attrs["href"]
        url = urlsplit(href)
        if not url.netloc and url.scheme not in ("https", "http"):
            if unquote(url.path).lower().endswith(".md"):
                raise ValueError(f"Repository-local Markdown link is not allowed: {href}")
        if href.startswith("#"):
            self.fragments.append(unquote(href[1:]))
        elif not url.netloc and not url.scheme and url.path and url.path not in FILES:
            raise ValueError(f"Unknown local Help link: {href}")


def render(source, lang, template):
    if any(template.count(token) != 1 for token in TOKENS):
        raise ValueError("Template must contain lang, title, and content tokens exactly once")
    title = re.search(r"^# (.+)$", source, re.MULTILINE)
    if title is None:
        raise ValueError("Help source needs an H1 title")
    content = markdown.markdown(source, extensions=[
        "fenced_code", "tables", "sane_lists",
        TocExtension(slugify=slugify_unicode),
    ])
    values = dict(zip(TOKENS, (html.escape(lang), html.escape(title[1]), content)))
    result = re.sub(r"\{\{\w+\}\}", lambda match: values.get(match[0], match[0]), template)
    result = result.replace("<!DOCTYPE html>\n", f"<!DOCTYPE html>\n{HTML_WARNING}\n", 1)
    if re.search(r"\{\{\w+\}\}", result):
        raise ValueError("Unexpanded template placeholder in Help output")
    links = HelpLinks()
    links.feed(result)
    if lang not in {locale for _, _, locale in SOURCES} or links.lang != lang:
        raise ValueError("Help HTML language must match its source locale")
    if not all(fragment in links.ids for fragment in links.fragments):
        raise ValueError("Help contains an unresolved chapter link")
    if not {"toc", "toc-title", "help-content"}.issubset(links.ids):
        raise ValueError("Help must retain its chapter navigation and content")
    return result


def generate(output):
    template = (ROOT / "docs/help/template.html").read_text(encoding="utf-8")
    output.mkdir(parents=True, exist_ok=True)
    for source, name, lang in SOURCES:
        text = (ROOT / "docs/desktop" / source).read_text(encoding="utf-8")
        (output / name).write_text(render(text, lang, template), encoding="utf-8", newline="\n")
    css = (ROOT / "docs/help/help.css").read_text(encoding="utf-8")
    (output / "help.css").write_text(
        "/* Generated file. Do not edit directly. */\n" + css,
        encoding="utf-8", newline="\n",
    )


def check():
    with TemporaryDirectory(prefix="orchestrator-help-") as temporary:
        generated = Path(temporary)
        generate(generated)
        for name in FILES:
            tracked = OUTPUT / name
            # Git may check text out with CRLF on Windows.
            if not tracked.is_file() or tracked.read_text(encoding="utf-8") != (
                generated / name
            ).read_text(encoding="utf-8"):
                raise ValueError(f"Help bundle is out of sync: {name}; run python scripts/generate_help.py")
    print("Help bundle is synchronized; pages, locales, chapter links, placeholders, and CSS verified.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify tracked output without changing it")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        if args.check:
            check()
        else:
            generate(args.output_dir)
    except ValueError as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
