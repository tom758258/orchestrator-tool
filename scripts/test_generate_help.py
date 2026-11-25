"""Focused checks for the generated Desktop and CLI offline Help."""

import tempfile
import unittest
from pathlib import Path

from generate_help import (
    LOCALES, TOPICS, Links, filename, generate,
    lightweight_markdown, render, sidebar, slice_chapters, source_parts,
)


class HelpGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from generate_help import ROOT
        cls.template = (ROOT / "docs/help/template.html").read_text(encoding="utf-8")

    def test_bilingual_chapters_are_complete_and_renderable(self):
        for lang in LOCALES:
            with self.subTest(lang=lang):
                intro, landing, chapters = source_parts(lang)
                self.assertEqual(len(chapters), len(TOPICS))
                self.assertTrue(intro.startswith("# "))
                self.assertIn("Guide Chapters" if lang == "en" else "使用指南章節", landing)
                for stem in ("steps/serial", "guide/background-streaming"):
                    chapter = next(i for i, topic in enumerate(TOPICS) if topic[0] == stem)
                    self.assertIn(f"]({filename('steps/background', lang)})", chapters[chapter])
                main, fragments = slice_chapters(intro, chapters)
                self.assertIn("<h1 ", main)
                self.assertEqual(len(fragments), len(chapters))
                self.assertTrue(all("<h" in fragment for fragment in fragments))

    def test_local_links_and_language_are_validated(self):
        for lang in LOCALES:
            with self.subTest(lang=lang):
                navigation = sidebar(lang, "index")
                self.assertIn(filename("desktop", lang), navigation)
                self.assertNotIn("hreflang", navigation)
                self.assertNotIn("help-languages", navigation)
                sample = render(self.template, lang, "Guide", '<h1 id="topic">Topic</h1>', navigation)
                links = Links({filename("desktop", lang)})
                # Topic navigation intentionally points to more pages; test the isolated page.
                isolated = render(self.template, lang, "Guide", '<h1 id="topic">Topic</h1>', "")
                links.feed(isolated)
                links.verify(lang)
                self.assertIn('id="toc"', sample)

        for bad in (
            '<a href="missing.html">Bad</a>',
            '<a href="../README.md">Local Markdown</a>',
            '<a href="file:///tmp/private">File</a>',
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                links = Links({"desktop.html"})
                links.feed(render(self.template, "en", "Guide", bad, ""))

    def test_landing_and_cli_markdown_features(self):
        tick = chr(96) * 3
        sample = (
            "# Guide\n\n"
            "| Program | Purpose |\n| --- | --- |\n| tool.exe | CLI |\n\n"
            "- [Details](guide/getting-started.md)\n\n"
            + tick + "powershell\n.\\tool.exe --help\n" + tick
        )
        html = lightweight_markdown(sample, "en")
        self.assertIn("<table>", html)
        self.assertIn('href="guide-getting-started.html"', html)
        self.assertIn('class="language-powershell"', html)

    def test_offline_bundle_is_complete_for_both_locales(self):
        with tempfile.TemporaryDirectory(prefix="orchestrator-help-test-") as tmp:
            base = Path(tmp)
            desktop, cli = base / "desktop", base / "cli"
            generate(desktop, cli)
            self.assertEqual(len(list(desktop.glob("*.html"))), 2 * (1 + len(TOPICS)))
            self.assertEqual(len(list(cli.glob("*.html"))), 2)
            self.assertTrue((desktop / "help.css").is_file())
            self.assertTrue((cli / "help.css").is_file())
            for lang in LOCALES:
                name = filename("desktop", lang)
                page = (desktop / name).read_text(encoding="utf-8")
                self.assertIn('<html lang="' + lang + '">', page)
                self.assertNotIn("help-languages", page)
                self.assertIn("help-page", page)
                self.assertIn("theme", page)


if __name__ == "__main__":
    unittest.main()
