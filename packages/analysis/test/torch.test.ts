import { describe, expect, it } from "vitest";
import { cppNameSites, isCppCommentLine, topMacroCalls } from "../src/torch";

const defined = (text: string) => [...cppNameSites(text)].filter((s) => s.defines()).map((s) => s.name);

describe("PyTorch C++ recognition", () => {
  it("finds definitions, not calls or declarations", () => {
    const text = [
      "Tensor& at::native::add_out(const Tensor& a, Tensor& out) {",
      "  at::native::mul_out(a, out);",
      "  return sub_out(a, out);",
      "}",
      "template <> void fill_kernel<float>(TensorIterator& it) const noexcept {}",
      "static PyObject * THPVariable_add(PyObject* self) {",
      "void declared_only(int x);",
      "auto trailing(int x) -> int { return x; }",
      "Foo::Foo(int x) : x_(x) {}",
      "TORCH_IMPL_FUNC(softmax_out) {}",
    ].join("\n");
    expect(defined(text)).toEqual([
      "add_out",
      "fill_kernel",
      "THPVariable_add",
      "trailing",
      "Foo",
      "TORCH_IMPL_FUNC",
      "softmax_out",
    ]);
  });

  it("lists top-level macro calls with their identifier arguments", () => {
    const calls = [...topMacroCalls("CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)\n  x = F(1);\nREG(a, f(b))\n")];
    expect(calls.map((c) => [c.macro, c.ids, c.sig])).toEqual([
      ["CREATE_UNARY_TORCH_IMPL_FUNC", ["acos_out", "acos_stub"], "CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)"],
    ]);
    expect(calls[0].index).toBe(0);
  });

  it("tells comment lines", () => {
    expect(["/// m.def(x)", " * m.def(x)", "/* a */", "  // b"].every(isCppCommentLine)).toBe(true);
    expect(isCppCommentLine('  m.def("add", add_fn);')).toBe(false);
  });
});
