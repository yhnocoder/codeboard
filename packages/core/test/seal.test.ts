// Board Marks (seal.ts): the default text and colour, the limits on what the user writes, which seal a ref gets, clashes
import { describe, expect, it } from "vitest";
import {
  SEAL_COLORS,
  bookOf,
  bookPath,
  checkBoard,
  cleanSealText,
  defaultSealColor,
  defaultSealText,
  emptyBoard,
  putSeal,
  refSeal,
  sealClash,
  sealOf,
  sealTextOk,
  sealToKeep,
  type Board,
  type BoardMeta,
} from "../src";
import { setBoardSeal, type CommandEnv } from "../src/commands";

describe("default mark text", () => {
  it("takes the initials of the content words", () => {
    expect(defaultSealText("Compute architecture and scheduling")).toBe("CAS");
    expect(defaultSealText("Graph traversal")).toBe("GT");
    expect(defaultSealText("The memory hierarchy")).toBe("MH");
    expect(defaultSealText("Memory architecture and data locality")).toBe("MADL");
    expect(defaultSealText("Machine-level representation of programs")).toBe("MLRP");
  });
  it("keeps an all-caps word whole", () => {
    expect(defaultSealText("Large LLM inference")).toBe("LLLMI");
    expect(defaultSealText("CUDA streams")).toBe("CUDAS");
  });
  it("uses a single word whole", () => {
    expect(defaultSealText("Reduction")).toBe("Reduction");
    expect(defaultSealText("pmpp")).toBe("pmpp");
    expect(defaultSealText("  Scan  ")).toBe("Scan");
  });
  it("keeps to the limits", () => {
    expect(defaultSealText("Internationalization")).toBe("Internationa");
    expect(defaultSealText("並行プログラミングの基礎")).toBe("並行プログ");
  });
});

describe("mark text limits", () => {
  it("strips whitespace and drops what is over 5 CJK and 12 other characters", () => {
    expect(cleanSealText(" Mem & Data ")).toBe("Mem&Data");
    expect(cleanSealText("abcdefghijklmnop")).toBe("abcdefghijkl");
    expect(cleanSealText("内存层次结构概述")).toBe("内存层次结");
    expect(cleanSealText("CUDA内存层次结构x")).toBe("CUDA内存层次结x");
  });
  it("accepts only clean, non-empty text", () => {
    expect(sealTextOk("CNN")).toBe(true);
    expect(sealTextOk("Mem&Data")).toBe(true);
    expect(sealTextOk("")).toBe(false);
    expect(sealTextOk("a b")).toBe(false);
    expect(sealTextOk("abcdefghijklm")).toBe(false);
  });
  it("is checked when a board is read", () => {
    const b = emptyBoard("b1", "Convolution");
    expect(() => checkBoard({ ...b, seal: { text: "CNN", color: "teal" } })).not.toThrow();
    expect(() => checkBoard({ ...b, seal: { text: "far too long text" } })).toThrow(/seal\.text/);
    expect(() => checkBoard({ ...b, seal: { color: "chartreuse" } })).toThrow(/seal\.color/);
  });
});

describe("default mark colour and saving", () => {
  it("is the same for the same board id, from the palette", () => {
    expect(defaultSealColor("b-123")).toBe(defaultSealColor("b-123"));
    expect(SEAL_COLORS).toContain(defaultSealColor("b-123"));
    const seen = new Set(Array.from({ length: 64 }, (_, i) => defaultSealColor(`b${i}`)));
    expect(seen.size).toBeGreaterThan(4);
  });
  it("keeps only the fields that differ from the defaults", () => {
    const b = { id: "b1", name: "Convolution" };
    const dc = defaultSealColor("b1"),
      other = SEAL_COLORS.find((c) => c !== dc)!;
    expect(sealToKeep(b, "Convolution", dc)).toBeUndefined();
    expect(sealToKeep(b, "", dc)).toBeUndefined();
    expect(sealToKeep(b, "CNN", dc)).toEqual({ text: "CNN" });
    expect(sealToKeep(b, "Convolution", other)).toEqual({ color: other });
    expect(sealOf({ ...b, seal: { text: "CNN" } })).toEqual({ text: "CNN", color: dc });
  });
  it("drops bad fields when put on a board", () => {
    const b: Pick<Board, "seal"> = {};
    putSeal(b, { text: "a b c", color: "teal" });
    expect(b.seal).toEqual({ color: "teal" });
    putSeal(b, null);
    expect(b.seal).toBeUndefined();
  });
  it("is set by its command", () => {
    const board = emptyBoard("b1", "Convolution");
    const env = { edit: (f: (b: Board) => void) => f(board) } as unknown as CommandEnv;
    setBoardSeal(env, { text: "CNN", color: "olive" });
    expect(board.seal).toEqual({ text: "CNN", color: "olive" });
    setBoardSeal(env, undefined);
    expect("seal" in board).toBe(false);
  });
});

// pmpp ⊃ Convolution, Compute (⊃ Warps); csapp ⊃ Memory hierarchy
const metas: BoardMeta[] = [
  { id: "pmpp", name: "pmpp", cards: 3, subs: ["conv", "comp"] },
  { id: "conv", name: "Convolution", cards: 3, seal: { text: "CNN", color: "olive" } },
  { id: "comp", name: "Compute architecture and scheduling", cards: 3, subs: ["warps"], seal: { text: "CompArch" } },
  { id: "warps", name: "Warps", cards: 1 },
  { id: "csapp", name: "csapp", cards: 1, subs: ["mh"], seal: { color: "vermilion" } },
  { id: "mh", name: "The memory hierarchy", cards: 2 },
];

describe("which seal a ref gets", () => {
  it("finds the book and the path down to a board", () => {
    expect(bookOf("warps", metas)).toBe("pmpp");
    expect(bookPath("warps", metas)).toEqual(["pmpp", "comp", "warps"]);
    expect(bookOf("csapp", metas)).toBe("csapp");
    expect(bookOf("unknown", metas)).toBe("unknown");
  });
  it("stops in a cycle", () => {
    const loop: BoardMeta[] = [
      { id: "a", name: "A", cards: 0, subs: ["b"] },
      { id: "b", name: "B", cards: 0, subs: ["a"] },
    ];
    expect(bookPath("a", loop)).toEqual(["b", "a"]);
  });
  it("draws nothing for this board's own cards", () => {
    expect(refSeal("conv", "conv", metas)).toBeUndefined();
  });
  it("draws only the target board's seal in the same book", () => {
    expect(refSeal("conv", "pmpp", metas)).toEqual({ text: "CNN", color: "olive" });
    expect(refSeal("warps", "conv", metas)).toEqual({ text: "Warps", color: defaultSealColor("warps") });
    expect(refSeal("pmpp", "warps", metas)).toEqual({ text: "pmpp", color: defaultSealColor("pmpp") });
  });
  it("puts the other book's seal first across books", () => {
    expect(refSeal("mh", "warps", metas)).toEqual({
      text: "MH",
      color: defaultSealColor("mh"),
      book: { text: "csapp", color: "vermilion" },
    });
    expect(refSeal("warps", "mh", metas)?.book).toEqual({ text: "pmpp", color: defaultSealColor("pmpp") });
  });
  it("draws a book itself without the book part", () => {
    expect(refSeal("csapp", "conv", metas)).toEqual({ text: "csapp", color: "vermilion" });
  });
});

describe("mark clashes", () => {
  it("finds another board in the same book with the same text, ignoring case", () => {
    expect(sealClash("warps", "cnn", metas)?.id).toBe("conv");
    expect(sealClash("conv", "CNN", metas)).toBeUndefined();
    expect(sealClash("mh", "CNN", metas)).toBeUndefined();
    expect(sealClash("warps", "", metas)).toBeUndefined();
  });
});
