// Tests press the PC caret keys; on a Mac, Chromium's text fields (a Note's ProseMirror) move the caret with others: Home / End
// scroll there, the line ends are ⌘← ⌘→, the document's ⌘↑ ⌘↓, a word ⌥. Shortcuts are written ControlOrMeta already.
// macKeys(page) turns them into the Mac's on page.keyboard.press; elsewhere it does nothing. The harness and the e2e drivers use it
const MAC_KEY = [
  [/^(?:Control|ControlOrMeta)\+(Shift\+)?Home$/, "Meta+$1ArrowUp"],
  [/^(?:Control|ControlOrMeta)\+(Shift\+)?End$/, "Meta+$1ArrowDown"],
  [/^(Shift\+)?Home$/, "Meta+$1ArrowLeft"],
  [/^(Shift\+)?End$/, "Meta+$1ArrowRight"],
  [/^Control\+(Shift\+)?(Backspace|Delete|ArrowLeft|ArrowRight)$/, "Alt+$1$2"],
];

/** @param {import("playwright-core").Page} page */
export function macKeys(page) {
  if (process.platform !== "darwin") return;
  const press = page.keyboard.press.bind(page.keyboard);
  page.keyboard.press = (key, o) =>
    press(
      MAC_KEY.reduce((k, [re, to]) => (re.test(k) ? k.replace(re, to) : k), key),
      o,
    );
}
