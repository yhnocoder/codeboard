// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMd } from "../src/render";
import { staticTextRange, staticDomRange } from "../src/selmap";
import { toggleStaticMark, staticMarkActive } from "../src/marks";

function rangeOf(md: string, word: string, i = 0) {
  const root = document.createElement("div");
  root.innerHTML = renderMd(md);
  document.body.append(root);
  const text = root.textContent!;
  let at = -1;
  for (let k = 0; k <= i; k++) at = text.indexOf(word, at + 1);
  const dom = staticDomRange(root, at, at + word.length)!;
  return { root, dom, r: staticTextRange(root, dom)! };
}
const toggle = (md: string, word: string, mark: "bold" | "highlight", i = 0) => toggleStaticMark(md, rangeOf(md, word, i).r, mark);

describe("marks on a static selection", () => {
  it("bolds and highlights a phrase, and toggles each off again", () => {
    const md = "alpha brave charlie delta";
    const b = toggle(md, "brave charlie", "bold")!;
    expect(b).toBe("alpha **brave charlie** delta");
    const bh = toggle(b, "brave charlie", "highlight")!;
    expect(bh).toMatch(/^alpha (==\*\*brave charlie\*\*==|\*\*==brave charlie==\*\*) delta$/);
    expect(toggle(bh, "brave charlie", "bold")).toBe("alpha ==brave charlie== delta");
    expect(toggle("alpha ==brave charlie== delta", "brave charlie", "highlight")).toBe(md);
  });
  it("adds the mark when only part of the selection has it", () => {
    const md = "alpha **brave** charlie";
    expect(staticMarkActive(md, rangeOf(md, "brave charlie").r, "bold")).toBe(false);
    expect(staticMarkActive(md, rangeOf(md, "brave").r, "bold")).toBe(true);
    expect(toggle(md, "brave charlie", "bold")).toBe("alpha **brave charlie**");
  });
  it("leaves the spaces at either end outside the marks", () => {
    expect(toggle("alpha brave charlie", " brave ", "highlight")).toBe("alpha ==brave== charlie");
  });
  it("rewrites only the blocks it changed", () => {
    const md = "* one\n* two\n\nalpha brave\n\n__keep__ this";
    expect(toggle(md, "brave", "bold")).toBe("* one\n* two\n\nalpha **brave**\n\n__keep__ this");
  });
  it("spans blocks", () => {
    expect(toggle("# Head\n\nbody text", "Headbody", "highlight")).toBe("# ==Head==\n\n==body== text");
  });
  it("gives null for nothing but spaces", () => {
    expect(toggle("a b", " ", "bold")).toBeNull();
  });
  it("maps the counted range back onto the same text after a re-render", () => {
    const md = "alpha brave $x^2$ charlie";
    const { r } = rangeOf(md, "brave", 0);
    const next = toggleStaticMark(md, r, "bold")!;
    const root = document.createElement("div");
    root.innerHTML = renderMd(next);
    const dom = staticDomRange(root, r.from, r.to)!;
    expect(dom.toString()).toBe("brave");
    expect(staticTextRange(root, dom)).toEqual(r);
  });
});
