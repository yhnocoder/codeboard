// The web side's clipboard, this run's own (as the Mac app's is a pasteboard of the run's): the board never reaches the
// browser's clipboard, which may be the Mac's. navigator.clipboard is a store in the page; ⌘C ⌘X ⌘V are pressed by
// __clipKey (web.ts sends them here, not as keys the browser would carry out): the keydown first, as a press, then,
// when nothing took it, the copy, cut or paste event with a DataTransfer of the store's, and what a browser does when
// no handler takes that (the selected text copied, cut, typed in)
(() => {
  /** @type {{ type: string, data: string | Blob }[]} */
  let items = [];
  const blob = (i) => (typeof i.data === "string" ? new Blob([i.data], { type: i.type }) : i.data);
  const clip = {
    async writeText(t) { items = [{ type: "text/plain", data: String(t) }]; },
    async readText() { return items.find((i) => i.type === "text/plain")?.data ?? ""; },
    async write(list) {
      const out = [];
      for (const it of list) for (const t of it.types) {
        const b = await it.getType(t);
        out.push({ type: t, data: t.startsWith("text/") ? await b.text() : b });
      }
      items = out;
    },
    async read() { return items.length ? [new ClipboardItem(Object.fromEntries(items.map((i) => [i.type, blob(i)])))] : []; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
  Object.defineProperty(Navigator.prototype, "clipboard", { get: () => clip, configurable: true });
  const editable = (e) => e && (e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName));
  window.__clipKey = (kind, mods) => {
    const t = document.activeElement || document.body;
    const key = { copy: "c", cut: "x", paste: "v" }[kind];
    const o = { key, code: `Key${key.toUpperCase()}`, metaKey: true, shiftKey: mods.includes("shift"), bubbles: true, cancelable: true, composed: true };
    if (t.dispatchEvent(new KeyboardEvent("keydown", o))) {
      const dt = new DataTransfer();
      if (kind === "paste")
        for (const i of items)
          if (typeof i.data === "string") dt.setData(i.type, i.data);
          else dt.items.add(new File([i.data], `image.${i.type.split("/")[1] || "png"}`, { type: i.type }));
      const plain = t.dispatchEvent(new ClipboardEvent(kind, { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
      if (kind !== "paste") {
        if (!plain) items = [...dt.types.filter((x) => x !== "Files").map((x) => ({ type: x, data: dt.getData(x) })), ...[...dt.files].map((f) => ({ type: f.type, data: f }))];
        else {
          const s = String(getSelection() ?? "");
          if (s) items = [{ type: "text/plain", data: s }];
          if (s && kind === "cut" && editable(t)) document.execCommand("delete");
        }
      } else if (plain && editable(t)) {
        const s = items.find((i) => i.type === "text/plain")?.data;
        if (s) document.execCommand("insertText", false, s);
      }
    }
    t.dispatchEvent(new KeyboardEvent("keyup", o));
  };
  // clip text <s> / clip image: what the driver puts on it; __clipRead: what is on it
  window.__clipSet = (list) => { items = list.map((i) => (i.base64 ? { type: i.type, data: new Blob([Uint8Array.from(atob(i.base64), (c) => c.charCodeAt(0))], { type: i.type }) } : i)); };
  window.__clipRead = async () => {
    const out = [];
    for (const i of items) {
      if (typeof i.data === "string") out.push(`${i.type}: ${i.data.replace(/\s+/g, " ").slice(0, 80)}`);
      else if (i.type.startsWith("image/")) { const b = await createImageBitmap(i.data).catch(() => undefined); out.push(`${i.type} ${b ? `${b.width}x${b.height}` : `${i.data.size} bytes`}`); }
      else out.push(`${i.type} ${i.data.size} bytes`);
    }
    return out.join("\n") || "none";
  };
})();
