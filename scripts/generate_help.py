"""Generate offline Desktop chapters and embedded CLI Help; verify tracked outputs."""

import argparse
import html
import re
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory

import markdown
from markdown.extensions.toc import TocExtension, slugify_unicode

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps/desktop/public/help"
CLI = ROOT / "src/cli_help"
TOPICS = (
    ("guide/getting-started", "Getting Started", "快速開始"),
    ("guide/external-tools", "Configure External Tools", "設定外部工具"),
    ("guide/tool-setup", "Tool Setup and Instances", "Tool Setup 與 Instance"),
    ("guide/workflow-editor", "Workflow Editor", "Workflow 編輯器"),
    ("steps/input-values", "Input Values and Data Flow", "輸入值與資料流"),
    ("steps/powers", "Powers Steps", "Powers 步驟"),
    ("steps/workflow", "Workflow Steps", "Workflow 步驟"),
    ("steps/scopes", "Scopes Actions", "Scopes 動作"),
    ("steps/background", "Background Interaction Steps", "Background 互動步驟"),
    ("guide/execution", "Run Simulation and Live", "Simulation 與 Live 執行"),
    ("guide/background-streaming", "Background Streaming and Streaming CSV", "Background Streaming 與 CSV"),
    ("guide/results", "Run Results", "執行結果"),
    ("guide/charts", "Charts", "圖表"),
    ("guide/results-and-export", "Output Data and Export", "輸出資料與匯出"),
    ("guide/templates-and-settings", "Templates and Preferences", "範本與偏好設定"),
    ("guide/troubleshooting", "Troubleshooting and Safety", "常見問題與安全"),
    ("steps/serial", "Serial Background RX and Actions", "Serial Background RX 與動作"),
)
LOCALES = ("en", "zh-TW")
WARNING = "<!-- Generated file. Do not edit directly. -->"
INTRO_MARK = "<!-- help-navigation -->\n\n"
CHAPTER_MARK = "<!-- help-source -->\n\n"


def suffix(lang):
    return ".zh-TW.md" if lang == "zh-TW" else ".md"


def filename(stem, lang):
    return stem.replace("/", "-") + (".zh-TW" if lang == "zh-TW" else "") + ".html"


def escape(value):
    return html.escape(value, quote=True)


def source_parts(lang):
    index = (ROOT / "docs/desktop" / ("USER_GUIDE" + suffix(lang))).read_text(encoding="utf-8")
    if index.count(INTRO_MARK) != 1:
        raise ValueError("Missing Desktop guide navigation marker")
    intro, guide = index.split(INTRO_MARK)
    chapters = []
    for stem, _, _ in TOPICS:
        source = (ROOT / "docs/desktop" / (stem + suffix(lang))).read_text(encoding="utf-8")
        if source.count(CHAPTER_MARK) != 1 or not source.startswith("# "):
            raise ValueError("Invalid chapter source: " + stem)
        chapters.append(source.split(CHAPTER_MARK)[1])
    return intro, guide, chapters


def markdown_html(source):
    return markdown.markdown(source, extensions=[
        "fenced_code", "tables", "sane_lists",
        TocExtension(slugify=slugify_unicode),
    ])


def slice_chapters(intro, chapters):
    # Rendering the old complete document before splitting preserves its anchors.
    rendered = markdown_html(intro + "".join(chapters))
    heads = list(re.finditer(r'<h([1-6]) id="[^"]+">(.+?)</h\1>', rendered, re.S))
    positions = []
    cursor = 0
    for chapter in chapters:
        line = chapter.splitlines()[0]
        match = re.fullmatch(r'(#{2,4}) (.+)', line)
        if match is None:
            raise ValueError("Chapter does not start with a subheading")
        level, title = len(match[1]), match[2]
        for index in range(cursor, len(heads)):
            heading = heads[index]
            actual = html.unescape(re.sub(r"<[^>]+>", "", heading[2]))
            if int(heading[1]) == level and actual == title:
                positions.append(heading.start())
                cursor = index + 1
                break
        else:
            raise ValueError("Rendered chapter heading not found: " + title)
    return rendered[:positions[0]].strip(), [
        rendered[left:right].strip()
        for left, right in zip(positions, positions[1:] + [len(rendered)])
    ]


def inline(text, lang="en"):
    text = html.escape(text, quote=False)
    text = re.sub(r'\x60([^\x60]+)\x60', lambda m: "<code>" + m[1] + "</code>", text)
    def link(m):
        name, url = m[1], m[2]
        if url.endswith(".md") and not url.startswith(("http:", "https:")):
            without_locale = url[:-9] if url.endswith(".zh-TW.md") else url[:-3]
            url = filename(without_locale, lang)
        return '<a href="' + escape(url) + '">' + name + "</a>"
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', text)
    return text


def lightweight_markdown(source, lang):
    # Only the small CLI and Desktop landing guides need this subset.
    lines = source.strip().splitlines()
    out = []
    paragraphs = []
    fence = chr(96) * 3

    def flush():
        if paragraphs:
            out.append("<p>" + inline("\n".join(paragraphs), lang) + "</p>")
            paragraphs.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            flush()
            index += 1
            continue
        heading = re.match(r'^(#{1,6}) (.+)$', line)
        if heading:
            flush()
            level, title = len(heading[1]), heading[2]
            anchor = re.sub(r'[^\w\s-]', "", title.lower())
            anchor = re.sub(r'\s+', "-", anchor).strip("-")
            out.append(f'<h{level} id="{escape(anchor)}">{inline(title, lang)}</h{level}>')
            index += 1
            continue
        if line.startswith(fence):
            flush()
            language = line[3:].strip()
            body = []
            index += 1
            while index < len(lines) and not lines[index].startswith(fence):
                body.append(lines[index])
                index += 1
            if index == len(lines):
                raise ValueError("Unclosed guide code block")
            klass = ' class="language-' + escape(language) + '"' if language else ""
            out.append("<pre><code" + klass + ">" + html.escape("\n".join(body) + "\n") + "</code></pre>")
            index += 1
            continue
        if line.startswith("|") and index + 1 < len(lines) and re.fullmatch(r'[\s|:\-]+', lines[index + 1]):
            flush()
            def cells(value):
                return [x.strip() for x in value.strip().strip("|").split("|")]
            columns = cells(line)
            index += 2
            rows = []
            while index < len(lines) and lines[index].startswith("|"):
                rows.append(cells(lines[index]))
                index += 1
            out.append("<table>\n<thead>\n<tr>" +
                "".join("<th>" + inline(x, lang) + "</th>" for x in columns) +
                "</tr>\n</thead>\n<tbody>\n" +
                "".join("<tr>" + "".join("<td>" + inline(x, lang) + "</td>" for x in row) + "</tr>\n" for row in rows) +
                "</tbody>\n</table>")
            continue
        if re.match(r'^[-*] ', line):
            flush()
            items = []
            while index < len(lines) and re.match(r'^[-*] ', lines[index]):
                items.append(lines[index][2:])
                index += 1
            out.append("<ul>\n" + "".join("<li>" + inline(x, lang) + "</li>\n" for x in items) + "</ul>")
            continue
        paragraphs.append(line)
        index += 1
    flush()
    return "\n".join(out)


def sidebar(lang, active):
    pages = [("index", "Home", "首頁", "desktop")] + list(TOPICS)
    parts = []
    for stem, en, zh, *extra in pages:
        ident = extra[0] if extra else stem
        name = filename(ident, lang)
        label = zh if lang == "zh-TW" else en
        selected = ' aria-current="page"' if stem == active else ""
        parts.append('<a class="help-page" href="' + name + '"' + selected + ">" + escape(label) + "</a>")
    return "\n".join(parts)


def render(template, lang, title, content, nav):
    values = {
        "{{lang}}": lang,
        "{{title}}": escape(title),
        "{{content}}": content,
        "{{navigation}}": nav,
    }
    if any(template.count(token) != 1 for token in values):
        raise ValueError("Help template placeholder missing or duplicated")
    for token, value in values.items():
        template = template.replace(token, value)
    return template.replace("<!DOCTYPE html>\n", "<!DOCTYPE html>\n" + WARNING + "\n", 1)


class Links(HTMLParser):
    def __init__(self, allowed):
        super().__init__()
        self.allowed = set(allowed)
        self.ids = set()
        self.fragments = []
        self.locale = None

    def handle_starttag(self, tag, pairs):
        attrs = dict(pairs)
        if tag == "html":
            self.locale = attrs.get("lang")
        if "id" in attrs:
            if attrs["id"] in self.ids:
                raise ValueError("Duplicate Help anchor: " + attrs["id"])
            self.ids.add(attrs["id"])
        if "hreflang" in attrs or "help-languages" in attrs.get("class", "").split():
            raise ValueError("Language must come from the opener")
        if tag == "a" and "href" in attrs:
            href = attrs["href"]
            if href.startswith("#"):
                self.fragments.append(href[1:])
            elif href.startswith("https://"):
                pass
            elif href not in self.allowed:
                raise ValueError("Invalid Help link: " + href)

    def verify(self, lang):
        if self.locale != lang or not {"toc", "toc-title", "help-content"}.issubset(self.ids):
            raise ValueError("Help language or navigation missing")
        if not all(f in self.ids for f in self.fragments):
            raise ValueError("Unresolved local Help anchor")


def write_page(out, name, page, lang, allowed):
    inspector = Links(allowed)
    inspector.feed(page)
    inspector.verify(lang)
    (out / name).write_text(page, encoding="utf-8", newline="\n")


def generate(desktop, cli):
    desktop.mkdir(parents=True, exist_ok=True)
    cli.mkdir(parents=True, exist_ok=True)
    template = (ROOT / "docs/help/template.html").read_text(encoding="utf-8")
    css = (ROOT / "docs/help/help.css").read_text(encoding="utf-8")
    desktop_files = {filename(x[0], lang) for x in TOPICS for lang in LOCALES}
    desktop_files.update({"desktop.html", "desktop.zh-TW.html", "help.css"})
    cli_files = {"cli.html", "cli.zh-TW.html", "help.css"}
    for lang in LOCALES:
        intro, landing, chapters = source_parts(lang)
        intro_html, fragments = slice_chapters(intro, chapters)
        title = "Orchestrator Tool Desktop 使用者指南" if lang == "zh-TW" else "Orchestrator Tool Desktop User Guide"
        main = intro_html + "\n" + lightweight_markdown(landing, lang)
        write_page(desktop, filename("desktop", lang),
                   render(template, lang, title, main, sidebar(lang, "index")),
                   lang, desktop_files)
        for (stem, en, zh), part in zip(TOPICS, fragments):
            title = zh if lang == "zh-TW" else en
            content = "<h1>" + escape(title) + "</h1>\n" + part
            write_page(desktop, filename(stem, lang),
                       render(template, lang, title, content, sidebar(lang, stem)),
                       lang, desktop_files)
        cli_md = (ROOT / "docs/cli" / ("USER_GUIDE" + suffix(lang))).read_text(encoding="utf-8")
        title = "Orchestrator Tool CLI 使用者指南" if lang == "zh-TW" else "Orchestrator Tool CLI User Guide"
        write_page(cli, filename("cli", lang),
                   render(template, lang, title, lightweight_markdown(cli_md, lang), ""),
                   lang, cli_files)
    css = "/* Generated file. Do not edit directly. */\n" + css
    for out in (desktop, cli):
        (out / "help.css").write_text(css, encoding="utf-8", newline="\n")


def check():
    with TemporaryDirectory(prefix="orchestrator-help-") as tmp:
        generated = Path(tmp)
        generate(generated / "desktop", generated / "cli")
        for source, expected in ((DESKTOP, generated / "desktop"), (CLI, generated / "cli")):
            names = {p.name for p in expected.iterdir()}
            existing = {p.name for p in source.iterdir() if p.suffix in (".html", ".css")}
            if names != existing:
                raise ValueError("Help file list is out of sync: " + str(source))
            for page in expected.iterdir():
                actual = source / page.name
                if actual.read_bytes().replace(b"\r\n", b"\n") != page.read_bytes():
                    raise ValueError("Help content differs: " + str(actual))
    print("CLI and Desktop offline Help bundles are synchronized.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if args.check:
            check()
        else:
            generate(DESKTOP, CLI)
    except (ValueError, OSError) as error:
        parser.exit(1, "Error: " + str(error) + "\n")


if __name__ == "__main__":
    main()
