// Generic UI audit: checks in the board page for mistakes you can spot without knowing the feature; runs on every replay step.
// Usage: const { audit } = require("tools/review/audit.cjs"); const r = await audit(frameOrPage, "step name");
// Returns { step, issues: [{ rule, what }] }; with AUDIT_STRICT=1 the caller should fail any step with issues.
// Report: report(audits, "UI audit") gives Markdown lines for the PR description, one per unique warning (rule + element)
// with the steps it shows up in, so an element that stays on screen for ten steps is one warning, not ten.

const SEL = {
  hit: "button, [role=button], [role=menuitem], a[href], input, select, textarea, .call, .mk, .step, .handle, [data-hit]",
  pop: ".pop, .menu, .ctx, .dialog, .diffpop, .srcpop, .stkpick, [role=menu], [role=dialog], .palette",
  text: "button, [role=menuitem], .ctitle, .pop *, .menu *, .ctx *, .bbar *, .chead *",
  card: ".card",
};

function inPage(SEL) {
  const vw = innerWidth, vh = innerHeight;
  const label = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls}${t ? ` "${t}"` : ""}`;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity < 0.05 || cs.pointerEvents === "none") return null;
    return r;
  };
  // Wholly clipped away by an ancestor (e.g. a header chip's label folded onto a hidden second line): not on screen, so not truncated text
  const clippedOut = (el, r) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      const x = cs.overflowX !== "visible" && (r.right <= pr.left || r.left >= pr.right), y = cs.overflowY !== "visible" && (r.bottom <= pr.top || r.top >= pr.bottom);
      if (x || y) return true;
    }
    return false;
  };
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const issues = [];

  // K1: two clickable elements cover each other (both topmost at their centers, neither contains the other, overlap > 25% of the smaller)
  const hits = [...document.querySelectorAll(SEL.hit)].map((el) => ({ el, r: shown(el) })).filter((x) => {
    if (!x.r || x.r.right < 0 || x.r.bottom < 0 || x.r.left > vw || x.r.top > vh) return false;
    const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, x.r.left + x.r.width / 2)), Math.min(vh - 1, Math.max(0, x.r.top + x.r.height / 2)));
    return !!top && (top === x.el || x.el.contains(top) || top.contains(x.el));
  });
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    const a = hits[i], b = hits[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (!!a.el.closest(".world") !== !!b.el.closest(".world")) continue; // canvas content scrolling under fixed chrome is normal
    const ov = area(a.r, b.r), small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
    if (ov > 0.25 * small) issues.push({ rule: "K1 overlapping hit targets", what: `${label(a.el)} ↔ ${label(b.el)}` });
  }

  // L1: popups and menus stay fully inside the viewport
  for (const el of document.querySelectorAll(SEL.pop)) {
    const r = shown(el); if (!r) continue;
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
      issues.push({ rule: "L1 popup outside viewport", what: `${label(el)} [${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}] viewport ${vw}×${vh}` });
  }

  // L10: an anchored popup at the viewport's top-left corner usually lost its anchor and fell back to (0,0)
  for (const el of document.querySelectorAll(".pop, .diffpop, .srcpop")) { // context menus open at the click point and may legitimately sit in a corner
    const r = shown(el); if (!r) continue;
    if (r.left <= 10 && r.top <= 10) issues.push({ rule: "L10 popup jumped to top-left", what: label(el) });
  }

  // L11: a submenu must not cover its parent menu (flip to the other side near the edge)
  const menus = [...document.querySelectorAll(".ctx, [role=menu]")].map((el) => ({ el, r: shown(el) })).filter((x) => x.r);
  for (let i = 0; i < menus.length; i++) for (let j = i + 1; j < menus.length; j++) {
    const a = menus[i], b = menus[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (area(a.r, b.r) > 0.08 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) issues.push({ rule: "L11 submenu covers parent menu", what: `${label(a.el)} ↔ ${label(b.el)}` });
  }

  // L2: truncated text (single-line ellipsis or clipped)
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL.text)) {
    if (seen.has(el) || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    seen.add(el);
    const r = shown(el); if (!r || clippedOut(el, r)) continue;
    const cs = getComputedStyle(el);
    if ((cs.textOverflow === "ellipsis" || cs.overflow !== "visible") && el.scrollWidth > el.clientWidth + 1)
      issues.push({ rule: "L2 truncated text", what: label(el) });
  }

  // L4: a clickable element is partly clipped (an ancestor with overflow other than visible shows less than 90% of it)
  for (const { el, r } of hits) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow === "visible" && cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      if (p.matches("#board, .board, .world")) break; // cards running off the canvas edge are normal; only check clipping inside cards / popups
      const pr = p.getBoundingClientRect();
      if (area(r, pr) < 0.9 * r.width * r.height && !(p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) {
        issues.push({ rule: "L4 clipped by container", what: `${label(el)} clipped by ${label(p)}` });
      }
      break;
    }
  }

  // L8: cards must not overlap each other (intersection over 16px²)
  const cards = [...document.querySelectorAll(SEL.card)].map((el) => ({ el, r: shown(el) })).filter((x) => x.r);
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (area(a.r, b.r) > 16) issues.push({ rule: "L8 overlapping cards", what: `${label(a.el.querySelector(".ctitle") || a.el)} ↔ ${label(b.el.querySelector(".ctitle") || b.el)}` });
  }
  return issues;
}

async function audit(target, step) {
  const issues = await target.evaluate(inPage, SEL);
  return { step, issues };
}

/** Unique warnings across steps, in the order they first appear: [{ rule, what, steps }] */
function dedupe(audits) {
  const m = new Map();
  for (const a of audits) for (const i of a.issues) {
    const k = `${i.rule}\u0000${i.what}`;
    const u = m.get(k) ?? m.set(k, { rule: i.rule, what: i.what, steps: [] }).get(k);
    if (!u.steps.includes(a.step)) u.steps.push(a.step);
  }
  return [...m.values()];
}

/** Markdown for the PR description: "**UI audit**: N warnings" (N unique), then one line per warning with its steps:
 *  - L2 truncated text — div.ctitle "pick_tokens" (10-pick-impl, 11-capture-run, +3 more) */
function report(audits, title = "UI audit", max = 30) {
  const u = dedupe(audits);
  const steps = (s) => `${s.slice(0, 2).join(", ")}${s.length > 2 ? `, +${s.length - 2} more` : ""}`;
  return [
    `**${title}**: ${u.length ? `${u.length} warning${u.length > 1 ? "s" : ""}` : "no issues"}`,
    ...u.slice(0, max).map((i) => `- ${i.rule} — ${i.what} (${steps(i.steps)})`),
    ...(u.length > max ? [`- …and ${u.length - max} more (audit.json in the run's artifacts)`] : []),
  ];
}
module.exports = { audit, dedupe, report, SEL };
