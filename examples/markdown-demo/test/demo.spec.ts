import * as path from "node:path";
import { test, expect } from "@playwright/test";

// screenshots for a look (not compared): test-out/markdown-demo/
const shot = (name: string) => path.join(path.dirname(new URL(import.meta.url).pathname), "../../../test-out/markdown-demo", `${name}.png`);

test("markdownDemo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // every script the page fetches, with its body: the editor chunk is the one with the editor's own class names in it
  const scripts: { url: string; body: Promise<string> }[] = [];
  page.on("response", (r) => { if (r.request().resourceType() === "script") scripts.push({ url: r.url(), body: r.text().catch(() => "") }); });
  const editorChunks = async () => {
    const hit: string[] = [];
    for (const s of scripts) { const b = await s.body; if (b.includes("md-bubble") || b.includes("cbcm")) hit.push(s.url); }
    return hit;
  };
  await page.goto("./");
  const note = page.locator("#note");

  await expect(note.locator(".katex").first()).toBeVisible();
  await expect(note.locator(".math .katex-display")).toHaveCount(1);
  await expect(note.locator(".mmd svg")).toHaveCount(1);
  await expect(note.locator("pre.md-code[data-lang=python] code span.kw").first()).toHaveText("def");
  const kw = await note.locator("pre.md-code span.kw").first().evaluate((e) => getComputedStyle(e).color);
  const plain = await note.locator("pre.md-code code").first().evaluate((e) => getComputedStyle(e).color);
  expect(kw).not.toBe(plain);
  await expect(note.locator(".cref:not(.missing)")).toHaveText("Paging");
  await expect(note.locator(".cref.missing")).toHaveText("Nowhere");
  await expect(note.locator("img")).toHaveAttribute("src", "./assets/pages.svg");
  await expect(note.locator("input[type=checkbox]")).toHaveCount(2);
  await expect(note.locator(".md-toc .l2")).toHaveCount(7);
  await expect(note.locator("sup.fnref")).toHaveText("1");
  await expect(note.locator(".md-emoji")).toHaveText("🚀");
  await page.screenshot({ path: shot("static-light"), fullPage: true });

  // clicks the page handles: a ref, a task box (changes the saved Markdown, no editor)
  await note.locator(".cref:not(.missing)").click();
  await expect(page.locator("#opened")).toHaveText("Opened page: paging");
  await note.locator("input[type=checkbox]").nth(1).click();
  await expect(page.locator("#source")).toContainText("- [x] evict the least recently used");
  await expect(note.locator(".md-pm")).toHaveCount(0);
  expect(await editorChunks(), "no editor or code editor chunk before the first click").toEqual([]);

  await note.locator("p", { hasText: "A short note" }).click();
  const pm = note.locator(".md-pm");
  await expect(pm).toBeVisible();
  await expect(pm).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Edited **here** now");
  await expect(pm.locator("strong", { hasText: "here" })).toHaveCount(1);
  expect(await editorChunks(), "the editor chunk came with the first click").toHaveLength(1);

  // the selection bar, drawn with the borrowed .pill / .tbtn styles
  await page.keyboard.press("Shift+Home");
  const bubble = page.locator(".md-bubble.pill");
  await expect(bubble).toBeVisible();
  await expect(bubble.locator(".tbtn").first()).toBeVisible();
  expect(await bubble.evaluate((e) => getComputedStyle(e).borderRadius), "the page's .pill style").toBe("10px");
  await page.screenshot({ path: shot("editing-light") });
  await page.keyboard.press("End");
  await expect(bubble).toHaveCount(0);

  // / menu → Code Block: the code goes into CodeMirror, Esc in it ends the whole edit
  await page.keyboard.press("Enter");
  await page.keyboard.type("/code");
  await expect(page.locator(".md-menu button").first()).toContainText("Code Block");
  await page.keyboard.press("Enter");
  // the package's classes survive CodeMirror's focus change (it rewrites the editor's class attribute)
  const cm = pm.locator(".cbcm.cbcm-md.cm-focused .cm-content:focus");
  await expect(cm).toHaveCount(1);
  await expect(cm).toHaveText("");
  await page.keyboard.type("x = 1");
  await expect(cm).toHaveText("x = 1");
  await page.keyboard.press("Escape");

  await expect(note.locator(".md-pm")).toHaveCount(0);
  await expect(page.locator("#source")).toContainText("Edited **here** now");
  await expect(page.locator("#source")).toContainText("```\nx = 1\n```");
  await expect(note.locator("strong", { hasText: "here" })).toHaveCount(1);
  await expect(note.locator(".mmd svg")).toHaveCount(1);
  await expect(page.locator("#mode")).toHaveText("Static · click to edit");

  // the theme toggle switches the variables the package's stylesheet reads
  const ink = () => note.evaluate((e) => getComputedStyle(e).getPropertyValue("--ink").trim());
  const before = await ink();
  await page.locator("#theme").click();
  expect(await ink()).not.toBe(before);
  await page.screenshot({ path: shot("static-dark"), fullPage: true });
  expect(errors).toEqual([]);
});
