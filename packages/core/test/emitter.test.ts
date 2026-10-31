import { describe, expect, it } from "vitest";
import { Emitter } from "../src";

describe("Emitter", () => {
  it("calls listeners in order, survives a throwing listener, and stops after dispose", () => {
    const e = new Emitter<number>();
    const got: string[] = [];
    const a = e.event((n) => got.push(`a${n}`));
    e.event(() => {
      throw new Error("boom");
    });
    e.event((n) => got.push(`c${n}`));
    const err = console.error;
    console.error = () => {};
    e.fire(1);
    a.dispose();
    e.fire(2);
    console.error = err;
    expect(got).toEqual(["a1", "c1", "c2"]);
  });
});
