// Where the keyboard goes when VS Code hands it to the board's webview. VS Code focuses the webview's host page first and then, in a
// message of its own, has the host page focus the board's frame; when VS Code skips that message (it no longer counts the webview as
// focused), the keyboard stays on the host page. A key pressed then is the board's.
// Usage: npm run harness -- <scenario…>   (the test names below)
import { test, open, check, until, idle, light } from "../fixtures";

test("hostPageKeysReachBoard", async () => {
  const h = await open({ light });
  await idle(h);
  // A second copy of the board in an iframe of this page: the page plays the webview's host page, the iframe the board's frame
  const page = await h.page.evaluate(() => ({
    js: document.querySelector<HTMLScriptElement>("script[type=module]")!.src,
    css: document.querySelector<HTMLLinkElement>("link[rel=stylesheet]")!.href,
    theme: document.body.className,
  }));
  await h.page.evaluate(
    (p) =>
      new Promise<void>((loaded) => {
        const f = document.createElement("iframe");
        f.style.cssText = "position:fixed;left:0;top:0;width:700px;height:500px;z-index:9;border:0";
        f.srcdoc =
          `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${p.css}"></head><body class="${p.theme}"><div id="root"></div>` +
          `<script>window.acquireVsCodeApi = () => ({ postMessage() {} });</script><script type="module" src="${p.js}"></script></body></html>`;
        f.onload = () => loaded();
        document.body.appendChild(f);
      }),
    page,
  );
  const board = h.page.frames().find((f) => f.parentFrame() === h.page.mainFrame())!;
  const boardHasKeyboard = () => board.evaluate(() => document.hasFocus());
  await board.evaluate(() => {
    (window as any).__keys = [];
    window.addEventListener("keydown", (e) => (window as any).__keys.push(e.key));
  });
  await board.evaluate(() => window.focus());
  await until(h, "the board's frame has the keyboard", boardHasKeyboard);
  // VS Code's first step (WebviewElement._doFocus focuses the host page) with the board's frame focused, and no second step
  await h.page.evaluate(() => window.focus());
  check("hostPageKeysReachBoard: the host page has the keyboard", !(await boardHasKeyboard()));
  await h.page.keyboard.press("x");
  check(
    "hostPageKeysReachBoard: a key pressed on the host page reaches the board",
    (await board.evaluate(() => (window as any).__keys.join())) === "x",
    await board.evaluate(() => (window as any).__keys),
  );
  check("hostPageKeysReachBoard: and the board's frame has the keyboard for the next ones", await boardHasKeyboard());
  await h.page.keyboard.press("y");
  check(
    "hostPageKeysReachBoard: the next key reaches the board once",
    (await board.evaluate(() => (window as any).__keys.join())) === "x,y",
    await board.evaluate(() => (window as any).__keys),
  );
});
