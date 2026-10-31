// CodeBoard's questions asked on the board (HostToBoard "ask"): a line of text (Rename Board, Capture Run, the DeepSeek key) or one of a
// list (Apply Run, Relocate, Locate Repo, Copy Diagnostics). The dialog has the keyboard: what is typed goes into it, not to the board's
// shortcuts; ↵ answers, Esc cancels (null).
// Usage: npm run harness -- <scenario…>   (the test names below)
import { emptyBoard, type BoardAsk, type BoardToHost } from "@codeboard/core";
import { put, findSym, symCard, shot, type Host } from "../harness";
import { test, open, check, until, idle, light } from "../fixtures";

type Answer = Extract<BoardToHost, { type: "answer" }>;
const board = () => {
  const b = emptyBoard("bD", "Dialogs");
  const s = findSym("LLMEngine.step");
  put(b, symCard(s.f, s.s), 80, 80, 560);
  return b;
};
let n = 0;
async function ask(h: Host, a: BoardAsk) {
  const id = ++n;
  await h.post({ type: "ask", id, ask: a });
  await h.page.locator(".dialog").waitFor();
  return id;
}
const answer = (h: Host, id: number) =>
  until(h, `the board answers ask ${id}`, () => h.sent.find((m): m is Answer => m.type === "answer" && m.id === id));
const inDialog = (h: Host) =>
  h.page.evaluate(
    () => !!document.activeElement?.closest(".dialog") && document.activeElement instanceof HTMLInputElement,
  );
const cards = (h: Host) => h.board().cards.length;

const RUN: BoardAsk = {
  kind: "text",
  title: "Capture Run",
  text: "Run a Python entry once and record the calls into Study Scope",
  value: "example.py",
  placeholder: "example.py --steps 2",
  ok: "Run",
};

test("askTextDialog", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const before = cards(h);
  const id = await ask(h, RUN);
  check("askTextDialog: the field has the keyboard", await inDialog(h));
  check(
    "askTextDialog: it shows the title, the prompt and the Run button",
    (await h.page.locator(".dialog .dt").textContent()) === "Capture Run" &&
      (await h.page.locator(".dialog .dx").textContent())?.includes("Study Scope") &&
      (await h.page.locator(".dialog .db button.def").textContent()) === "Run",
  );
  check(
    "askTextDialog: the last entry is there, selected",
    await h.page
      .locator(".dialog input")
      .evaluate(
        (i: HTMLInputElement) =>
          i.value === "example.py" && i.selectionStart === 0 && i.selectionEnd === i.value.length,
      ),
  );
  await shot(h, "dialogs-01-text");
  // t on the board makes a Text card: in the dialog it is just a letter
  await h.page.keyboard.type("tests/run.py --steps 2");
  await h.page.keyboard.press("Enter");
  const a = await answer(h, id);
  check("askTextDialog: Enter answers with the text typed", a.value === "tests/run.py --steps 2", a);
  await h.page.locator(".dialog").waitFor({ state: "detached" });
  await idle(h);
  check("askTextDialog: the keys typed made no card", cards(h) === before, { before, after: cards(h) });
  check("askTextDialog: the board keeps the keyboard", await h.page.evaluate(() => document.hasFocus()));
});

test("askTextEscape", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const id = await ask(h, { kind: "text", title: "Rename Board", value: "Dialogs", ok: "Rename" });
  await h.page.keyboard.type("Other");
  await h.page.keyboard.press("Escape");
  const a = await answer(h, id);
  check("askTextEscape: Esc answers null", a.value === null, a);
  await h.page.locator(".dialog").waitFor({ state: "detached" });
  // the Esc went to the dialog: the board did not also clear its selection or leave a mode on it
  check("askTextEscape: one answer only", h.sent.filter((m) => m.type === "answer" && m.id === id).length === 1);
  const id2 = await ask(h, { kind: "text", title: "Rename Board", value: "Dialogs", ok: "Rename" });
  await h.page.locator(".dialog .db button", { hasText: "Cancel" }).click();
  check("askTextEscape: Cancel answers null", (await answer(h, id2)).value === null);
});

// VS Code can take the focus out of the board's frame while a dialog that just focused its field is opening (it moves the keyboard to
// the webview's host page, then on to the board's frame): when the frame gets the keyboard back with nothing focused, the field takes it
test("askFocusReturns", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const before = cards(h);
  const id = await ask(h, RUN);
  await until(h, "the field has the keyboard", () => inDialog(h));
  // The focus leaves the board's frame for another one and its field is no longer focused, as when the host page takes the keyboard
  await h.page.evaluate(() => {
    const f = document.body.appendChild(document.createElement("iframe"));
    (document.activeElement as HTMLElement).blur();
    f.contentWindow!.focus();
    f.remove();
  });
  check("askFocusReturns: the field has lost the keyboard", !(await inDialog(h)));
  await h.page.evaluate(() => window.focus());
  await until(h, "the board's frame has the keyboard back", () => h.page.evaluate(() => document.hasFocus()));
  check("askFocusReturns: the field has the keyboard again", await inDialog(h));
  check(
    "askFocusReturns: its text is still selected",
    await h.page
      .locator(".dialog input")
      .evaluate((i: HTMLInputElement) => i.selectionStart === 0 && i.selectionEnd === i.value.length),
  );
  await h.page.keyboard.type("tests/run.py");
  await h.page.keyboard.press("Enter");
  check("askFocusReturns: what is typed then answers", (await answer(h, id)).value === "tests/run.py");
  await idle(h);
  check("askFocusReturns: the keys typed made no card", cards(h) === before, { before, after: cards(h) });
});

test("askPassword", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const id = await ask(h, {
    kind: "text",
    title: "DeepSeek API Key",
    text: "Stored in VS Code's secret storage.",
    placeholder: "sk-…",
    ok: "Save",
    password: true,
  });
  check(
    "askPassword: the key is typed into a password field",
    (await h.page.locator(".dialog input").getAttribute("type")) === "password" && (await inDialog(h)),
  );
  await shot(h, "dialogs-02-password");
  await h.page.keyboard.type("sk-test");
  await h.page.locator(".dialog .db button.def").click();
  check("askPassword: Save answers with the key", (await answer(h, id)).value === "sk-test");
});

test("askPickDialog", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const before = cards(h);
  const items = [
    { label: "example.py --steps 2", description: "6/3/2026 14:02 · a1b2c3d", detail: "41 call sites · 3,112 calls" },
    { label: "-m nanovllm.bench", description: "6/2/2026 09:40", detail: "28 call sites · 902 calls" },
    {
      label: "tests/test_engine.py",
      description: "6/1/2026 18:21 · 9f8e7d6",
      detail: "12 call sites · 77 calls · exit 1",
    },
  ];
  const id = await ask(h, { kind: "pick", title: "Apply which run to this board?", items });
  check("askPickDialog: the filter has the keyboard", await inDialog(h));
  check(
    "askPickDialog: every row is listed, the first highlighted",
    (await h.page.locator(".dialog .cand").count()) === 3 &&
      (await h.page.locator(".dialog .cand.on").textContent())?.includes("example.py"),
  );
  await shot(h, "dialogs-03-pick");
  // Typing filters (by label and description); ↓ moves; ↵ answers the row's index in the list asked
  await h.page.keyboard.type("py");
  await until(h, "typing py leaves the two scripts", async () => (await h.page.locator(".dialog .cand").count()) === 2);
  await h.page.keyboard.press("ArrowDown");
  await h.page.keyboard.press("Enter");
  const a = await answer(h, id);
  check("askPickDialog: Enter answers the highlighted row's index", a.value === 2, a);
  await h.page.locator(".dialog").waitFor({ state: "detached" });
  await idle(h);
  check("askPickDialog: the keys typed made no card", cards(h) === before, { before, after: cards(h) });

  const id2 = await ask(h, { kind: "pick", title: "Which repo do you want to locate?", items: items.slice(0, 2) });
  await h.page.locator(".dialog .cand").nth(1).click();
  check("askPickDialog: a click answers that row", (await answer(h, id2)).value === 1);
  const id3 = await ask(h, { kind: "pick", title: "Which repo do you want to locate?", items });
  await h.page.keyboard.press("Escape");
  check("askPickDialog: Esc answers null", (await answer(h, id3)).value === null);
});

// One dialog at a time: a new question cancels the open one, so the host is never left waiting
test("askReplacesOpen", async () => {
  const h = await open({ board: board(), light });
  await idle(h);
  const id1 = await ask(h, RUN);
  await h.post({
    type: "ask",
    id: ++n,
    ask: { kind: "pick", title: "Apply which run to this board?", items: [{ label: "a.py" }] },
  });
  check("askReplacesOpen: the open question is answered null", (await answer(h, id1)).value === null);
  await until(h, "the new question is shown", async () => (await h.page.locator(".dialog .cand").count()) === 1);
  await h.page.keyboard.press("Enter");
  check("askReplacesOpen: the new one answers", (await answer(h, n)).value === 0);
});
