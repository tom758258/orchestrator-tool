"""Focused checks for Help rendering and validation boundaries."""

import unittest

from generate_help import ROOT, render


class HelpGenerationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = (ROOT / "docs/help/template.html").read_text(encoding="utf-8")

    def test_markdown_features_and_deterministic_unicode_ids(self):
        source = "# Guide\n\n## 章節\n\n### 章節\n\n~~~text\nexample\n~~~\n\n| A | B |\n| - | - |\n| 1 | 2 |\n"
        rendered = render(source, "zh-TW", self.template)
        self.assertEqual(rendered, render(source, "zh-TW", self.template))
        self.assertIn('<h2 id="章節">', rendered)
        self.assertIn('<h3 id="章節_1">', rendered)
        self.assertIn('<pre><code class="language-text">', rendered)
        self.assertIn("<table>", rendered)

    def test_local_markdown_links_are_rejected_but_public_urls_are_retained(self):
        for link in (
            "[local](../README.md)",
            "[local](../README%2Emd#section)",
            '<a href="../README.md">local</a>',
            "[local][reference]\n\n[reference]: ../README.md",
        ):
            with self.subTest(link=link), self.assertRaises(ValueError):
                render("# Guide\n\n" + link, "en", self.template)
        url = "https://example.com/README.md"
        self.assertIn(url, render(f"# Guide\n\n[Public]({url})", "en", self.template))

    def test_template_and_language_link_errors_are_rejected(self):
        for template in (
            self.template.replace("{{content}}", ""),
            self.template + "{{title}}",
            self.template + "{{unknown}}",
            self.template.replace('href="desktop.zh-TW.html"', 'href="missing.html"'),
        ):
            with self.subTest(template=template), self.assertRaises(ValueError):
                render("# Guide", "en", template)


if __name__ == "__main__":
    unittest.main()
