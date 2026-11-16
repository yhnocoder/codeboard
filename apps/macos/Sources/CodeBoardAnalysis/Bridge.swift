import Foundation

// Cross-language boundaries: what a call crosses (pybind, torch.ops, TORCH_LIBRARY, PyO3, kernel[grid], launch macros,
// JIT compilation, TileLang factories), and once across, which function actually runs and with which values. Text and
// syntax only, no file reads: finding files and symbols is the host's job. Macros and templates are expanded only as
// far as "which kernel runs, with which arguments", never fully preprocessed. As packages/analysis/src/bridge.ts.

/// Many line lookups in one text: the line starts are recorded once and searched by bisection. Offsets are UTF-16.
public func lineIndex(_ text: String) -> (Int) -> Int { lineIndex(JSText(text)) }

func lineIndex(_ t: JSText) -> (Int) -> Int {
  var starts = [0]
  for (i, u) in t.units.enumerated() where u == 0x0A { starts.append(i + 1) }
  return { i in
    var lo = 0
    var hi = starts.count - 1
    while lo < hi {
      let mid = (lo + hi + 1) >> 1
      if starts[mid] <= i { lo = mid } else { hi = mid - 1 }
    }
    return lo + 1
  }
}

/// One registration: its line, the C++ / Rust symbol it registers (`target`, maybe with namespaces), or `lambda` when
/// it registers a lambda written in place (whose target is that line)
public struct Registration: Hashable, Codable, Sendable {
  public var line: Int
  public var target: String?
  public var lambda: Bool?
  public var how: String

  public init(line: Int, target: String? = nil, lambda: Bool? = nil, how: String) {
    self.line = line
    self.target = target
    self.lambda = lambda
    self.how = how
  }
}

/// A registration with the name it registers (the whole-file scans, for indexes)
public struct NamedRegistration: Hashable, Codable, Sendable {
  public var name: String
  public var line: Int
  public var target: String?
  public var lambda: Bool?
  public var how: String

  public init(name: String, line: Int, target: String? = nil, lambda: Bool? = nil, how: String) {
    self.name = name
    self.line = line
    self.target = target
    self.lambda = lambda
    self.how = how
  }

  var unnamed: Registration { Registration(line: line, target: target, lambda: lambda, how: how) }
}

/// A DispatchStub registration: `name` is the stub, `macro` the macro that registers it
public struct DispatchRegistration: Hashable, Codable, Sendable {
  public var name: String
  public var line: Int
  public var target: String
  public var how: String
  public var macro: String

  public init(name: String, line: Int, target: String, how: String, macro: String) {
    self.name = name
    self.line = line
    self.target = target
    self.how = how
    self.macro = macro
  }
}

private let openOf: [UInt16: UInt16] = [unit("("): unit(")"), unit("["): unit("]"), unit("{"): unit("}")]

/// Bracket matching from `open` (a "(", "[" or "{") to its partner, inclusive; brackets in strings and comments do
/// not count. -1 when there is none.
public func matchClose(_ text: String, _ open: Int) -> Int { matchClose(JSText(text), open) }

func matchClose(_ t: JSText, _ open: Int) -> Int {
  let quote = unit("\"")
  let apos = unit("'")
  let slash = unit("/")
  let backslash = unit("\\")
  // the TypeScript returns -1 for an `open` of -1 (its undefined character "matches" the empty stack)
  if open < 0 { return -1 }
  var stack: [UInt16] = []
  var i = open
  while i < t.count {
    let ch = t.units[i]
    if ch == quote || ch == apos {
      // a raw string R"(...)": skip to its )"
      if ch == quote && t[i - 1] == unit("R") {
        let e = t.indexOf(")\"", from: i)
        if e < 0 { return -1 }
        i = e + 2
        continue
      }
      i += 1
      while i < t.count && t.units[i] != ch {
        if t.units[i] == backslash { i += 1 }
        i += 1
      }
      i += 1
      continue
    }
    if ch == slash && t[i + 1] == slash {
      let e = t.indexOf("\n", from: i)
      if e < 0 { return -1 }
      i = e + 1
      continue
    }
    if let close = openOf[ch] {
      stack.append(close)
    } else if ch == stack.last {
      stack.removeLast()
      if stack.isEmpty { return i }
    }
    i += 1
  }
  return -1
}

/// An argument list's text cut at its top-level commas
public func splitArgs(_ s: String) -> [String] {
  let u = Array(s.utf16)
  let opens = Set("([{<".utf16)
  let closes = Set(")]}>".utf16)
  let quote = unit("\"")
  let apos = unit("'")
  let comma = unit(",")
  let backslash = unit("\\")
  var out: [String] = []
  var depth = 0
  var cur: [UInt16] = []
  var q: UInt16?
  var i = 0
  func push() { out.append(jsTrim(String(decoding: cur, as: UTF16.self))) }
  while i < u.count {
    let ch = u[i]
    if let open = q {
      cur.append(ch)
      if ch == backslash {
        i += 1
        if i < u.count { cur.append(u[i]) }
        i += 1
        continue
      }
      if ch == open { q = nil }
      i += 1
      continue
    }
    if ch == quote || ch == apos {
      q = ch
      cur.append(ch)
      i += 1
      continue
    }
    if opens.contains(ch) { depth += 1 } else if closes.contains(ch) { depth -= 1 }
    if ch == comma && depth == 0 {
      push()
      cur = []
      i += 1
      continue
    }
    cur.append(ch)
    i += 1
  }
  if !jsTrim(String(decoding: cur, as: UTF16.self)).isEmpty { push() }
  return out
}

private let wrapRe = JSRegex(#"^(?:[\w:]*::)?wrap_pybind_function(?:_no_gil)?\s*\(\s*&?\s*([A-Za-z_][\w:]*)\s*\)"#)
private let ampRe = JSRegex(#"&\s*([A-Za-z_][\w:]*)"#)
private let torchFnRe = JSRegex(#"^(?:TORCH_FN|TORCH_FN_TYPE)\s*\(\s*([A-Za-z_][\w:]*)\s*\)"#)
private let qualRe = JSRegex(#"^[A-Za-z_][\w:]*$"#)

/// &deep_ep::Buffer::intranode_dispatch, py::overload_cast<…>(&X::f), TORCH_FN(f), wrap_pybind_function(f), f →
/// the symbol's name
private func targetOf(_ arg: String) -> String? {
  let a = jsTrim(arg)
  if let m = wrapRe.exec(a) { return m[1] }
  if let m = ampRe.exec(a) { return m[1] }
  if let m = torchFnRe.exec(a) { return m[1] }
  if qualRe.test(a) { return a }
  return nil
}

/// The argument list of the call whose name starts at `at`: from its first "(" to the matching ")", or to the end
func argsAt(_ t: JSText, _ at: Int) -> [String] {
  let open = t.indexOf("(", from: at)
  let close = matchClose(t, open)
  return splitArgs(t.slice(open + 1, close < 0 ? nil : close))
}

/// pybind11 / nanobind: m.def("name", &f), .def("name", &Cls::f), .def_static…; a lambda's target is its line
public func pybindDefs(_ text: String, _ name: String) -> [Registration] {
  pybindScan(text, escapeRegExp(name)).map(\.unnamed)
}

/// Every .def("x", …) of a file, in one pass (for indexes)
public func pybindAll(_ text: String) -> [NamedRegistration] { pybindScan(text, #"\w+"#) }

private let pybindFileRe = JSRegex("pybind|PYBIND11_MODULE|nanobind|NB_MODULE")
private let mDefRe = JSRegex(#"\bm\s*\.def"#)
private let lambdaRe = JSRegex(#"^\["#)

private func pybindScan(_ text: String, _ pat: String) -> [NamedRegistration] {
  let t = JSText(text)
  // pybind11 itself, or only a header that wraps it (torch/csrc/utils/pybind.h)
  guard pybindFileRe.test(t) else { return [] }
  var out: [NamedRegistration] = []
  let lineAt = lineIndex(t)
  for m in JSRegex(#"\.def(?:_static)?\s*\(\s*"("# + pat + #")"\s*,"#).all(t) {
    let name = m[1] ?? ""
    let args = argsAt(t, m.index)
    let second = args.count > 1 ? args[1] : ""
    let line = lineAt(m.index)
    let how = mDefRe.test(t.slice(max(0, m.index - 3), m.index + 4)) ? "m.def" : ".def"
    if lambdaRe.test(second) {
      out.append(NamedRegistration(name: name, line: line, lambda: true, how: how))
    } else if let target = targetOf(second) {
      out.append(NamedRegistration(name: name, line: line, target: target, how: how))
    }
  }
  return out
}

/// CPython's method tables, PyMethodDef: {"_x", fn, METH_…}, {"_x", castPyCFunctionWithKeywords(fn), …},
/// TypeError_to_NotImplemented_<fn> → fn
public func pyMethodDefs(_ text: String, _ name: String) -> [Registration] {
  pyMethodScan(text, escapeRegExp(name)).map(\.unnamed)
}

/// Every PyMethodDef entry of a file (for indexes)
public func pyMethodAll(_ text: String) -> [NamedRegistration] { pyMethodScan(text, #"\w+"#) }

private let methRe = JSRegex("METH_")
private let cIdentRe = JSRegex(#"[A-Za-z_][\w]*(?:::[A-Za-z_]\w*)*"#)
private let notTargetRe = JSRegex(
  #"^(castPyCFunction\w*|TypeError_to_NotImplemented_|PyCFunction\w*|reinterpret_cast|static_cast|void)$"#)

private func pyMethodScan(_ text: String, _ pat: String) -> [NamedRegistration] {
  let t = JSText(text)
  guard methRe.test(t) else { return [] }
  var out: [NamedRegistration] = []
  let lineAt = lineIndex(t)
  for m in JSRegex(#"\{\s*"("# + pat + #")"\s*,\s*([^,{}]*?)\s*,\s*METH_"#).all(t) {
    let ids = cIdentRe.all(m[2] ?? "").map(\.text).filter { !notTargetRe.test($0) }
    if let target = ids.last {
      out.append(NamedRegistration(name: m[1] ?? "", line: lineAt(m.index), target: target, how: "PyMethodDef"))
    }
  }
  return out
}

private let dispatchFileRe = JSRegex(#"REGISTER_\w*DISPATCH"#)
private let dispatchRe = JSRegex(#"\b((?:ALSO_)?REGISTER_\w*DISPATCH)\s*\(\s*(\w+)\s*,"#)

/// Every DispatchStub registration of a file (for indexes): REGISTER_DISPATCH(stub, &fn), REGISTER_CUDA_DISPATCH /
/// REGISTER_ARCH_DISPATCH(stub, arch, fn), REGISTER_ALL_CPU_DISPATCH…
public func dispatchAll(_ text: String) -> [DispatchRegistration] {
  let t = JSText(text)
  guard dispatchFileRe.test(t) else { return [] }
  var out: [DispatchRegistration] = []
  let lineAt = lineIndex(t)
  for m in dispatchRe.all(t) where !inDefine(t, m.index) {
    let args = argsAt(t, m.index)
    let macro = m[1] ?? ""
    if let target = targetOf(args.last ?? ""), target != "nullptr" {
      out.append(
        DispatchRegistration(name: m[2] ?? "", line: lineAt(m.index), target: target, how: macro, macro: macro))
    }
  }
  return out
}

private let defineRe = JSRegex(#"^\s*#\s*define"#)

/// Whether the line holding `i` is a #define (the test runs on the text from that line's start on, as the TypeScript
/// does on `text.slice(…)`, without copying it)
func inDefine(_ t: JSText, _ i: Int) -> Bool {
  defineRe.test(t, from: t.lastIndexOf(unit("\n"), from: i) + 1)
}

private let stubMacroRe = JSRegex(#"^(?:ALSO_)?REGISTER_(CUDA|XPU|HPU|HIP|MPS|MTIA|PRIVATEUSE1)_DISPATCH$"#)
private let cudaFileRe = JSRegex(#"\.(cu|cuh)$"#)
private let cudaDirRe = JSRegex(#"/(cuda|cudnn|miopen)/"#)
private let mpsFileRe = JSRegex(#"\.mm$"#)
private let mpsDirRe = JSRegex(#"/mps/"#)

/// The device of a DispatchStub registration from its macro and file: REGISTER_CUDA_DISPATCH → CUDA; for
/// REGISTER_DISPATCH the file decides (.cu, cuda/ → CUDA; .mm, mps/ → MPS; anything else CPU)
public func stubDevice(_ macro: String, _ file: String) -> String {
  if let k = stubMacroRe.exec(macro)?[1] { return k }
  // ARCH, AVX2, AVX512, ALL_CPU, SVE, VSX, ZVECTOR
  if macro != "REGISTER_DISPATCH" { return "CPU" }
  let f = file.jsSplit("\\").joined(separator: "/")
  if cudaFileRe.test(f) || cudaDirRe.test(f) { return "CUDA" }
  if mpsFileRe.test(f) || mpsDirRe.test(f) { return "MPS" }
  return "CPU"
}

private let torchLibraryRe = JSRegex("TORCH_LIBRARY")
private let torchBuiltinRe = JSRegex(#"^torch::|^c10::|^k[A-Z]"#)

/// m.def("name", &f) and m.impl("name", kCUDA, &f) in TORCH_LIBRARY(ns, m) / TORCH_LIBRARY_IMPL / _FRAGMENT; an m.def
/// with only a schema does not count
public func torchLibDefs(_ text: String, _ name: String) -> [Registration] {
  let t = JSText(text)
  guard torchLibraryRe.test(t) else { return [] }
  var out: [Registration] = []
  let lineAt = lineIndex(t)
  let re = JSRegex(#"\.(def|impl)\s*\(\s*""# + escapeRegExp(name) + #"(?:\.\w+)?\s*["(]"#)
  for m in re.all(t) {
    let args = argsAt(t, m.index)
    let last = args.last ?? ""
    // only a schema
    if args.count < 2 { continue }
    let line = lineAt(m.index)
    let how = "m.\(m[1] ?? "")"
    if lambdaRe.test(last) {
      out.append(Registration(line: line, lambda: true, how: how))
    } else if let target = targetOf(last), !torchBuiltinRe.test(target) {
      out.append(Registration(line: line, target: target, how: how))
    }
  }
  return out
}

/// An operator reached through torch.ops: its namespace, name and overload
public struct TorchOp: Hashable, Codable, Sendable {
  public var ns: String
  public var op: String
  public var overload: String?

  public init(ns: String, op: String, overload: String? = nil) {
    self.ns = ns
    self.op = op
    self.overload = overload
  }
}

private let torchOpsRe = JSRegex(#"(?:^|\.)torch\.ops\.(\w+)\.(\w+)(?:\.(\w+))?$"#)

/// torch.ops.sgl_kernel.awq_marlin_repack(.default) → namespace, name and overload (torch.ops.aten.add.Tensor →
/// Tensor; `default` is none)
public func torchOpOf(name: String, recv: String?) -> TorchOp? {
  guard let m = torchOpsRe.exec("\(recv ?? "").\(name)") else { return nil }
  let ns = m[1] ?? ""
  let op = m[2] ?? ""
  if let overload = m[3], !overload.isEmpty, overload != "default" {
    return TorchOp(ns: ns, op: op, overload: overload)
  }
  return TorchOp(ns: ns, op: op)
}

private let pyo3FileRe = JSRegex(#"#\[py(function|methods|module|class)"#)
private let pyo3NameRe = JSRegex(#"#\[pyo3\([^)]*name\s*=\s*"(\w+)""#)
private let pyfunctionRe = JSRegex(#"#\[pyfunction"#)
/// Rust functions exported to Python: #[pyfunction] fn name / #[pyo3(name = "name")]; methods in a #[pymethods] impl
public func pyo3Defs(_ text: String, _ syms: [Sym], _ name: String) -> [Sym] {
  guard pyo3FileRe.test(text) else { return [] }
  let lines = text.units.lines().map(string)
  var out: [Sym] = []
  for s in syms where s.kind == .def {
    let attrs = jsSlice(lines, s.start - 1, s.defLine - 1).joined(separator: "\n")
    let renamed = pyo3NameRe.exec(attrs)?[1]
    if (renamed ?? s.name) != name { continue }
    if pyfunctionRe.test(attrs) {
      out.append(s)
      continue
    }
    // a method: the impl it is in has #[pymethods] before it
    if let parent = s.parent, !parent.isEmpty {
      let ty = parent.jsSplit("::").last ?? ""
      let re = JSRegex(#"#\[pymethods\][\s\S]{0,200}?impl\s+(?:<[^>]*>\s*)?"# + escapeRegExp(ty) + #"\b"#)
      if re.test(text) { out.append(s) }
    }
  }
  return out
}
