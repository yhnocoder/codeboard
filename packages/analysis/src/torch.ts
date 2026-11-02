// Plain-text recognition in PyTorch's C++ for the host's operator index: which names a file may define, the top-level
// macro calls that define kernels, comment lines. Regexes rather than tree-sitter: the index reads thousands of files,
// some of them megabytes of generated code, and only needs to know where to look closer.
import { matchClose } from "./bridge";

// A definition may be here: the name is followed by ( (or template arguments, then (), the line up to the name holds only
// types, qualifiers and decorations (Tensor& at::native::add_out(, template <> void f<float>(, static PyObject *
// THPVariable_add(), and after the matching ) (past words such as const, noexcept, __ubsan_ignore_undefined__) comes {,
// -> or : (a call at the start of a line, at::native::add_out(r, …);, and a declaration end in ;). Or the name is the
// only argument of a macro at the start of a line (TORCH_IMPL_FUNC(softmax_out)).
// Files that only mention the name (calls, comments) do not count: names such as add, sum, clone appear in hundreds of
// files, and each would be analysed on a click
const NAME_PAREN = /\b([A-Za-z_]\w*)\s*(?:<[^;(){}<>\n]*>\s*)?([()])/g;
const DECL_PREFIX = /^[\w:\s*&<>,[\]]*$/;
const DEF_AFTER = /^\s*(?:[A-Za-z_]\w*\b\s*(?:\([^()]*\)\s*)?)*(?:\{|->|:(?!:))/;
/** How far a parameter list is read (a file whose parentheses do not match is not read to its end) */
const PARAMS_MAX = 4096;
const NOT_DECL = /^\s*(?:return|else|case|throw|new|delete|co_return|co_yield|goto|sizeof|if|while|for|switch|do)\b/;
const MACRO_ARG = /^[ \t]*[A-Z][A-Z0-9_]*\s*\(\s*$/;

const defAfter = (text: string, open: number) => {
  const piece = text.slice(open, open + PARAMS_MAX),
    close = matchClose(piece, 0);
  return close >= 0 && DEF_AFTER.test(piece.slice(close + 1));
};

/**
 * Each name in C++ text followed by a parenthesis, in order. defines() tells whether the text may define it there; it is
 * the costly part, so callers ask it only for names they look for
 */
export function* cppNameSites(text: string): Generator<{ name: string; defines: () => boolean }> {
  const re = new RegExp(NAME_PAREN.source, NAME_PAREN.flags);
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const at = m;
    yield {
      name: at[1],
      defines: () => {
        const pre = text.slice(text.lastIndexOf("\n", at.index - 1) + 1, at.index);
        return at[2] === "("
          ? DECL_PREFIX.test(pre) && !NOT_DECL.test(pre) && defAfter(text, at.index + at[0].length - 1)
          : MACRO_ARG.test(pre);
      },
    };
  }
}

const MACRO_CALL = /^[ \t]*([A-Z][A-Z0-9_]*)\s*\(([^()]*)\)/gm;

/**
 * Calls of all-caps macros at the start of a line with no nested parentheses, which define kernels
 * (CREATE_UNARY_TORCH_IMPL_FUNC(acos_out, acos_stub)): the macro, the identifiers among its arguments and the call's text
 */
export function* topMacroCalls(text: string): Generator<{ index: number; macro: string; ids: string[]; sig: string }> {
  const re = new RegExp(MACRO_CALL.source, MACRO_CALL.flags);
  for (let m: RegExpExecArray | null; (m = re.exec(text)); )
    yield { index: m.index, macro: m[1], ids: m[2].match(/\b[A-Za-z_]\w*\b/g) ?? [], sig: m[0].trim() };
}

/** A line inside a // or /* comment (examples in header docs, such as torch/library.h's /// m.def("add", add_fn);) */
export const isCppCommentLine = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);
