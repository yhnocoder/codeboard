// Measures how the web board draws each kind of Markdown element (the reference page, page/: the Markdown package's
// editor with the board's stylesheets), in each theme, light and dark: computed font, size, weight, line height,
// colours, margins, paddings, borders, and each element's box. The native renderer's MarkdownTheme defaults and the
// board's theme mapping are read off this. Build the Markdown package first (npm run build -w @yhnocoder/markdown; the
// reference page is built here), then:
//   node apps/macos/tools/markdown/styles.mjs [--theme warm-ink] [--dark] > styles.json
import { pathToFileURL } from "node:url";
import { launch } from "../../../../tools/test/chromium.mjs";
import { buildPage } from "./page/build.mjs";

const SAMPLE = [
  "# Heading one",
  "## Heading two",
  "### Heading three",
  "#### Heading four",
  "Body text with **strong**, *emphasis*, `inline code`, [a link](https://example.com), ==highlight==, ~~strike~~ and <kbd>K</kbd>. 中文正文混排，看行高。",
  "Second paragraph right after the first.",
  "- bullet one\n- bullet two",
  "1. ordered one\n2. ordered two",
  "- [ ] task open\n- [x] task done",
  "> a quote line",
  "```py\nx = 1\n```",
  "| head a | head b |\n|---|---|\n| cell 1 | cell 2 |",
  "---",
  "After the rule.",
].join("\n\n");

/** what is measured: a name and a selector inside the editor root (the first match) */
const PROBES = {
  root: ".md-pm",
  body: ".nbody",
  card: "#root .card",
  head: "#root .card .chead",
  h1: ".md-pm > h1",
  h2: ".md-pm > h2",
  h3: ".md-pm > h3",
  h4: ".md-pm > h4",
  p: ".md-pm > p",
  p2: ".md-pm > p:nth-of-type(2)",
  strong: ".md-pm strong",
  em: ".md-pm em",
  code: ".md-pm p code",
  link: ".md-pm a.md-link",
  mark: ".md-pm mark",
  strike: ".md-pm s",
  kbd: ".md-pm kbd",
  marker: ".md-pm .md-mk",
  ul: ".md-pm > ul:not([data-type])",
  li: ".md-pm > ul:not([data-type]) > li",
  ol: ".md-pm > ol",
  task: ".md-pm li[data-type=taskItem]",
  checkbox: ".md-pm li[data-type=taskItem] input",
  quote: ".md-pm > blockquote",
  pre: ".md-pm > pre.md-code",
  codeLine: ".md-pm > pre.md-code .cm-line",
  table: ".md-pm table",
  th: ".md-pm table th, .md-pm table tr:first-child > *",
  td: ".md-pm table tr:last-child > td",
  hr: ".md-pm > hr",
};
const PROPS = [
  "font-family", "font-size", "font-weight", "font-style", "line-height", "color", "background-color",
  "margin-top", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-top-color", "border-left-width", "border-left-color", "border-bottom-width",
  "border-radius", "text-decoration-line", "text-decoration-color", "letter-spacing", "list-style-type",
];

const args = process.argv.slice(2);
const only = args.includes("--theme") ? args[args.indexOf("--theme") + 1] : null;
const themes = ["warm-ink", "ink-wash"].filter((t) => !only || t === only);
const darks = args.includes("--dark") ? [true] : [false, true];

const pageHtml = await buildPage();
const browser = await launch();
const out = {};
for (const look of themes)
  for (const dark of darks) {
    const page = await browser.newPage({ viewport: { width: 800, height: 1400 } });
    await page.goto(pathToFileURL(pageHtml).href);
    await page.waitForFunction(() => window.note);
    await page.evaluate(
      ([text, look, dark]) =>
        window.note.mount([
          { id: "n", note: { text, layout: null, style: { note: {} }, width: 360, height: null, look, dark, refs: [] }, images: "" },
        ]),
      [SAMPLE, look, dark],
    );
    out[`${look}${dark ? "-dark" : ""}`] = await page.evaluate(
      ([probes, props]) => {
        const root = document.querySelector(".md-pm").getBoundingClientRect();
        const res = {};
        for (const [name, sel] of Object.entries(probes)) {
          const e = document.querySelector(sel);
          if (!e) continue;
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          const o = { rect: [r.x - root.x, r.y - root.y, r.width, r.height].map((v) => Math.round(v * 100) / 100) };
          for (const p of props) o[p] = cs.getPropertyValue(p);
          // the line boxes of a text block: where each line's text sits
          if (["p", "h1", "h2", "li"].includes(name)) {
            const range = document.createRange();
            range.selectNodeContents(e);
            o.lines = [...range.getClientRects()].map((q) => [q.y - root.y, q.height].map((v) => Math.round(v * 100) / 100));
          }
          res[name] = o;
        }
        // where each text block's first baseline is, below its top: a zero-size inline-block sits on the baseline
        const baselines = {};
        for (const [name, sel] of Object.entries(probes)) {
          if (!["h1", "h2", "h3", "h4", "p", "li", "th", "td", "codeLine", "quote"].includes(name)) continue;
          const e = document.querySelector(sel);
          if (!e) continue;
          const host = e.matches("li, blockquote") ? e.querySelector("p") ?? e : e.matches("th, td") ? e.querySelector("p") ?? e : e;
          const z = document.createElement("span");
          z.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
          host.prepend(z);
          baselines[name] = Math.round((z.getBoundingClientRect().top - host.getBoundingClientRect().top) * 1000) / 1000;
          z.remove();
        }
        res.baselines = baselines;
        const vars = {};
        const rs = getComputedStyle(document.querySelector(".md-pm"));
        for (const v of ["--ink", "--ink-2", "--ink-3", "--surface", "--hlrow", "--hair", "--line", "--accent", "--accent-ink",
          "--warn", "--k-fn", "--md-hl", "--sys", "--mono", "--md-heading-font", "--md-fs", "--md-radius",
          "--md-annot-blue", "--md-annot-purple", "--md-annot-orange", "--md-annot-green"])
          vars[v] = rs.getPropertyValue(v).trim();
        res.vars = vars;
        return res;
      },
      [PROBES, PROPS],
    );
    await page.close();
  }
await browser.close();
console.log(JSON.stringify(out, null, 1));
