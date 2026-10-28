// @vitest-environment happy-dom
// A call arrow's grey alternatives: an implementation already expanded from the same call site is not offered again, and that is
// decided by its file as well as its qual (a DispatchStub's CUDA and CPU kernels are often both at::native::add_kernel)
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, emptyBoard, type BoardToHost, type Card, type HostInfo, type Link } from "@codeboard/core";
import { onHost } from "../../src/hostio";
import { state } from "../../src/state/store";
import { altsOf, pickImpl } from "../../src/actions/chains";

const HOST: HostInfo = { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS };
const CUDA = "build/aten/src/ATen/UfuncCUDA_add.cu", CPU = "build/aten/src/ATen/UfuncCPUKernel_add.cpp";
const code = (id: string, qual: string, path: string): Card => ({
  id, kind: "code",
  segments: [{ id: `s${id}`, src: { kind: "repo", repo: "" }, path, lang: "cpp", start: 1, end: 3, text: ["a", "b", "c"], version: { kind: "git", commit: "bb823b3" }, symbol: { qual, kind: "function" } }],
});
const cpuAlt = { label: "CPU · at::native::add_kernel", detail: `${CPU}:16`, path: CPU, line: 16, qual: "at::native::add_kernel" };
const arrow = (id: string, to: string, alts = [cpuAlt]): Link => ({ id, from: { card: "caller", seg: "scaller", line: 2 }, to: { card: to }, call: { name: "add_stub", col: 2, alts } });

function load(links: Link[], cards: Card[]) {
  const board = emptyBoard("alts", "alts");
  for (const [i, c] of [code("caller", "at::native::index_add_cpu_", "aten/src/ATen/native/TensorAdvancedIndexing.cpp"), ...cards].entries()) { board.cards.push(c); board.place[c.id] = { x: i * 500, y: 0, w: 400 }; board.born![c.id] = i; }
  board.seq = cards.length + 1;
  board.links.push(...links);
  onHost({ type: "init", board, boards: [{ id: "alts", name: "alts", cards: board.cards.length }], views: {}, stale: {}, host: HOST });
}
const link = (id: string) => state.board.links.find((l) => l.id === id)!;
const sent = () => (window.__cbSent ?? []) as BoardToHost[];

// the swap's request to the host is never answered here: switching boards drops it
afterAll(() => load([], []));

describe("altsOf", () => {
  it("offers the CPU kernel while the CUDA kernel of the same qual is expanded", () => {
    load([arrow("l", "cuda")], [code("cuda", "at::native::add_kernel", CUDA)]);
    expect(altsOf(link("l")).map((a) => a.alt.path)).toEqual([CPU]);
  });
  it("leaves out an alternative whose card is already expanded from the same call site", () => {
    load([arrow("l", "cuda"), arrow("l2", "cpu", [])], [code("cuda", "at::native::add_kernel", CUDA), code("cpu", "at::native::add_kernel", CPU)]);
    expect(altsOf(link("l"))).toEqual([]);
  });
});

describe("pickImpl", () => {
  it("swaps in the picked implementation by its file when another one with its qual is on the arrow", () => {
    const mps = { label: "MPS · at::native::add_kernel", detail: "aten/src/ATen/native/mps/Add.mm:3", path: "aten/src/ATen/native/mps/Add.mm", line: 3, qual: "at::native::add_kernel" };
    load([arrow("l", "cuda", [mps, cpuAlt])], [code("cuda", "at::native::add_kernel", CUDA)]);
    const before = sent().length;
    const impls = [{ ...cpuAlt, label: "CPU" }, { label: "CUDA", detail: `${CUDA}:66`, path: CUDA, line: 66, qual: "at::native::add_kernel" }];
    expect(pickImpl({ card: "caller", seg: "scaller", call: { name: "add_stub", line: 2, col: 2 } as never, impls, base: "", again: false, link: "l" }, 0, "", false)).toBe(true);
    const req = sent().slice(before).find((m) => m.type === "expand") as Extract<BoardToHost, { type: "expand" }> | undefined;
    expect(req?.pick).toEqual({ path: CPU, line: 16, qual: "at::native::add_kernel" });
  });
});
