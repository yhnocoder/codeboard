// 通用界面断言：在白板页面里查"不看具体功能也能判断的错"，对回放的每一步都跑。
// 对应 Review 检查清单：K1 可点元素重叠、L1 弹层越出视口、L2 文字被截断、L4 元素被容器裁掉、L8 卡片互相重叠、
// L10 弹层丢了锚点跑到左上角（C4）、L11 子菜单压住父菜单（C5）。
// 用法：const { audit } = require("tools/review/audit.cjs"); const r = await audit(frameOrPage, "步骤名");
// 返回 { step, issues: [{ rule, what }] }；AUDIT_STRICT=1 时调用方应把有问题的步骤算作失败。

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
  const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const issues = [];

  // K1：两个可点元素互相压住（都在最上层能被点到、互不包含、重叠超过较小者的 25%）
  const hits = [...document.querySelectorAll(SEL.hit)].map((el) => ({ el, r: shown(el) })).filter((x) => {
    if (!x.r || x.r.right < 0 || x.r.bottom < 0 || x.r.left > vw || x.r.top > vh) return false;
    const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, x.r.left + x.r.width / 2)), Math.min(vh - 1, Math.max(0, x.r.top + x.r.height / 2)));
    return !!top && (top === x.el || x.el.contains(top) || top.contains(x.el));
  });
  for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
    const a = hits[i], b = hits[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (!!a.el.closest(".world") !== !!b.el.closest(".world")) continue; // 画布上的卡片滚到固定工具条下面是正常的
    const ov = area(a.r, b.r), small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
    if (ov > 0.25 * small) issues.push({ rule: "K1 可点元素重叠", what: `${label(a.el)} ↔ ${label(b.el)}` });
  }

  // L1：弹层、菜单要完整留在视口里
  for (const el of document.querySelectorAll(SEL.pop)) {
    const r = shown(el); if (!r) continue;
    if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
      issues.push({ rule: "L1 弹层越出视口", what: `${label(el)} [${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}] 视口 ${vw}×${vh}` });
  }

  // L10：弹层贴在视口左上角，多半是锚点没了、位置退回了 (0,0)
  for (const el of document.querySelectorAll(".pop, .diffpop, .srcpop")) { // 右键菜单本来就开在点击处，可能就在角上，不查
    const r = shown(el); if (!r) continue;
    if (r.left <= 10 && r.top <= 10) issues.push({ rule: "L10 弹层跑到左上角", what: label(el) });
  }

  // L11：子菜单不能压住父菜单（靠边时应翻到另一侧）
  const menus = [...document.querySelectorAll(".ctx, [role=menu]")].map((el) => ({ el, r: shown(el) })).filter((x) => x.r);
  for (let i = 0; i < menus.length; i++) for (let j = i + 1; j < menus.length; j++) {
    const a = menus[i], b = menus[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (area(a.r, b.r) > 0.08 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) issues.push({ rule: "L11 子菜单压住父菜单", what: `${label(a.el)} ↔ ${label(b.el)}` });
  }

  // L2：文字被截断（单行省略或被裁）
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL.text)) {
    if (seen.has(el) || !el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    seen.add(el);
    const r = shown(el); if (!r) continue;
    const cs = getComputedStyle(el);
    if ((cs.textOverflow === "ellipsis" || cs.overflow !== "visible") && el.scrollWidth > el.clientWidth + 1)
      issues.push({ rule: "L2 文字被截断", what: label(el) });
  }

  // L4：可点元素被裁掉一部分（祖先 overflow 不是 visible，露出的不到 90%）
  for (const { el, r } of hits) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflow === "visible" && cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      if (p.matches("#board, .board, .world")) break; // 卡片滚到画布边缘外是正常的，只查卡片 / 弹层自己的裁切
      const pr = p.getBoundingClientRect();
      if (area(r, pr) < 0.9 * r.width * r.height && !(p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) {
        issues.push({ rule: "L4 元素被容器裁掉", what: `${label(el)} 被 ${label(p)} 裁掉` }); 
      }
      break;
    }
  }

  // L8：卡片两两不重叠（相交面积超过 16px²）
  const cards = [...document.querySelectorAll(SEL.card)].map((el) => ({ el, r: shown(el) })).filter((x) => x.r);
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (area(a.r, b.r) > 16) issues.push({ rule: "L8 卡片重叠", what: `${label(a.el.querySelector(".ctitle") || a.el)} ↔ ${label(b.el.querySelector(".ctitle") || b.el)}` });
  }
  return issues;
}

async function audit(target, step) {
  const issues = await target.evaluate(inPage, SEL);
  return { step, issues };
}
module.exports = { audit, SEL };
