import CodeBoardAnalysis
import Foundation

// packages/host/src/bridge.ts without PyTorch's operator routing (torch*.ts, a later block): the boundaries a call
// crosses into other code (pybind, PyMethodDef, PyO3, TORCH_LIBRARY, launch macros, JIT compiles), and what a kernel
// launch or a TileLang factory binds once the target is found. Each answers the target and what its Call mark takes.

/// What a call crossed, merged into its Call mark (protocol.ts's CrossMark; observed evidence is not the host's)
public struct CrossMark: Hashable, Sendable {
  /// pybind · ext.cpp m.def, kernel[grid], launch macro · …: the label's first line
  public var bound: String?
  /// The values fixed on the way (template arguments, constexprs, a config, a factory's arguments)
  public var vals: [BoundVal]
  /// The call's other possible targets, drawn as grey dashed boxes beside the card
  public var alts: [CallAlt]

  public init(bound: String? = nil, vals: [BoundVal] = [], alts: [CallAlt] = []) {
    self.bound = bound
    self.vals = vals
    self.alts = alts
  }
}

/// A target across a boundary; title: a template instance's name (dispatch<8, 768>); label: its name as an alternative
public struct Crossed: Hashable, Sendable {
  public var t: Target
  public var mark: CrossMark
  public var title: String?
  public var label: String?

  public init(t: Target, mark: CrossMark = CrossMark(), title: String? = nil, label: String? = nil) {
    self.t = t
    self.mark = mark
    self.title = title
    self.label = label
  }
}

/// A template instance's card name: dispatch<8, 768, 8192> (chip.ts's instName)
func instName(_ kernel: String, _ vals: [BoundVal]) -> String {
  vals.isEmpty ? kernel : "\(kernel)<\(vals.map(\.value).joined(separator: ", "))>"
}

extension CodeLookup {
  /// A C++ or Rust definition by qual (near: that file's first): of the name, its qual's tail matching
  /// (deep_ep::Buffer::f for Buffer::f), with the parameters of the file's whole analysis
  func symByQual(_ qual: String, grammar: Grammar, near: String? = nil) async -> Target? {
    let parts = qual.components(separatedBy: "::").filter { !$0.isEmpty }
    guard let name = parts.last else { return nil }
    let ents = await index.lookupName(name).filter {
      $0.name == name && grammarOfFile($0.abs) == grammar && $0.kind == .def
    }
    func score(_ e: IndexEntry) -> Int {
      let t = e.qual.components(separatedBy: "::")
      var n = 0
      while n < parts.count && n < t.count && parts[parts.count - 1 - n] == t[t.count - 1 - n] { n += 1 }
      return n
    }
    let far = { (e: IndexEntry) in near.map { jsEqual(e.abs, $0) } == true ? 0 : 1 }
    // JavaScript's sort is stable: the index's order breaks ties
    let ranked = ents.enumerated().map { (i: $0.offset, e: $0.element, s: score($0.element)) }
      .filter { $0.s >= min(parts.count, 2) || (parts.count == 1 && $0.s == 1) }
      .sorted { ($1.s, far($0.e), $0.i) < ($0.s, far($1.e), $1.i) }
    for x in ranked {
      guard let text = await readText(x.e.abs) else { continue }
      let sym =
        analysis.analysisOf(langOf(x.e.abs), text).symbols.first { $0.qual == x.e.qual && $0.defLine == x.e.defLine }
        ?? toSym(x.e)
      return Target(abs: x.e.abs, sym: sym)
    }
    return nil
  }

  /// A registration inside a lambda: the target is that lambda, one line, named by the symbol holding it
  func lambdaTarget(_ abs: String, line: Int) async -> Target? {
    guard let text = await readText(abs) else { return nil }
    let holder = symbolAt(analysis.analysisOf(langOf(abs), text).symbols, line: line)
    let lines = splitLines(text)
    let l = line >= 1 && line <= lines.count ? lines[line - 1] : ""
    return Target(
      abs: abs,
      sym: Sym(
        name: "<lambda>", qual: holder.map { "\($0.qual) · lambda" } ?? "lambda", kind: .def, start: line,
        defLine: line, end: line, sig: jsTrim(l), params: []))
  }

  private func registered(_ r: Registration, in abs: String, near: String?) async -> Target? {
    if r.lambda == true { return await lambdaTarget(abs, line: r.line) }
    guard let target = r.target else { return nil }
    return await symByQual(target, grammar: .cpp, near: near)
  }

  /// Python's obj.name(…) the language server cannot follow (a C extension): name's pybind, PyMethodDef and PyO3
  /// registrations
  public func viaRegistry(_ name: String) async -> [Crossed] {
    var out: [Crossed] = []
    for f in await index.grepWord(name, grammar: .cpp) {
      let base = NodePath.basename(f.abs)
      for r in pybindDefs(f.text, name) {
        if let t = await registered(r, in: f.abs, near: f.abs) {
          out.append(Crossed(t: t, mark: CrossMark(bound: "pybind · \(base) \(r.how)")))
        }
      }
      for r in pyMethodDefs(f.text, name) {
        guard let target = r.target, let t = await symByQual(target, grammar: .cpp, near: f.abs) else { continue }
        out.append(Crossed(t: t, mark: CrossMark(bound: "PyMethodDef · \(base)")))
      }
    }
    for f in await index.grepWord(name, grammar: .rust) {
      let methods = textContains(f.text, "#[pymethods]")
      for s in pyo3Defs(f.text, analysis.analysisOf("rust", f.text).symbols, name) {
        let how = methods && !(s.parent ?? "").isEmpty ? "pymethods" : "pyfunction"
        out.append(
          Crossed(
            t: Target(abs: f.abs, sym: s), mark: CrossMark(bound: "PyO3 · \(NodePath.basename(f.abs)) #[\(how)]")))
      }
    }
    return out
  }

  /// torch.ops.ns.op(…): the C++ function TORCH_LIBRARY registers
  func viaTorchOps(_ site: CallSite) async -> [Crossed] {
    guard let op = torchOpOf(name: site.name, recv: site.recv) else { return [] }
    var out: [Crossed] = []
    for f in await index.grepWord(op.op, grammar: .cpp) {
      for r in torchLibDefs(f.text, op.op) {
        guard let t = await registered(r, in: f.abs, near: nil),
          !out.contains(where: { jsEqual($0.t.abs, t.abs) && $0.t.sym.qual == t.sym.qual })
        else { continue }
        out.append(Crossed(t: t, mark: CrossMark(bound: "torch.ops · \(NodePath.basename(f.abs)) \(r.how)")))
      }
    }
    return out
  }

  /// A kernel's definition: of the name, the __global__ one (near's file first); with `file`, else the first found
  func kernelSym(_ name: String, near: String?, file: ((String) -> Bool)? = nil) async -> (t: Target, head: String)? {
    let all = await index.lookupName(name).filter {
      grammarOfFile($0.abs) == .cpp && $0.kind == .def && (file?($0.abs) ?? true)
    }
    let isNear = { (e: IndexEntry) in near.map { jsEqual(e.abs, $0) } == true }
    var fallback: (t: Target, head: String)?
    for e in all.filter(isNear) + all.filter({ !isNear($0) }) {
      guard let text = await readText(e.abs) else { continue }
      let head = lineSlice(splitLines(text), e.start - 1, e.defLine).joined(separator: "\n")
      let sym =
        analysis.analysisOf(langOf(e.abs), text).symbols.first { $0.qual == e.qual && $0.defLine == e.defLine }
        ?? toSym(e)
      let hit = (t: Target(abs: e.abs, sym: sym), head: head)
      if textContains(head, "__global__") { return hit }
      if fallback == nil { fallback = hit }
    }
    return file == nil ? nil : fallback
  }

  /// The text of the function holding the line; the whole text outside one
  private func fnText(_ abs: String, _ text: String, line: Int) -> String {
    let fn = symbolAt(analysis.analysisOf(langOf(abs), text).symbols.filter { $0.kind == .def }, line: line)
    return fn.map { lineSlice(splitLines(text), $0.start - 1, $0.end).joined(separator: "\n") } ?? text
  }

  /// SWITCH_X(CASE_MACRO), CASE_MACRO(8), LAUNCH_KERNEL(&cfg, k<…>, …): the kernel actually launched and its template
  /// values
  func viaLaunchMacro(_ site: CallSite, _ abs: String, _ text: String) async -> [Crossed] {
    let defs = macroDefs(text)
    let argMacro = site.args.contains { defs[jsTrim($0.text)] != nil }
    if !argMacro && defs[site.name] == nil && !textContains(site.name, "LAUNCH") { return [] }
    // SWITCH_X may be defined in another header
    var switches = NameMap<MacroDef>()
    if argMacro && defs[site.name] == nil {
      for f in await index.grepWord(site.name, grammar: .cpp) {
        let m = macroDefs(f.text)
        if m[site.name] != nil {
          switches = m
          break
        }
      }
    }
    guard let lm = launchMacro(name: site.name, args: site.args, defs: defs, switches: switches),
      let k = await kernelSym(lm.kernel, near: abs)
    else { return [] }
    let vals = launchVals(lm, k.head, fnText(abs, text, line: site.line))
    return [
      Crossed(
        t: k.t, mark: CrossMark(bound: "launch macro · \(site.name)", vals: vals), title: instName(lm.kernel, vals))
    ]
  }

  /// jit->compile("…", std::format(R"(#include <…/{}.cuh> … &ns::{})", header, func)): which kernel is compiled and
  /// launched; the other branch of an if / else is an alternative
  func viaJit(_ site: CallSite, _ abs: String, _ text: String) async -> [Crossed] {
    // the call's whole text, from its name to the matching parenthesis
    let at = splitLines(text).prefix(max(0, site.line - 1)).reduce(0) { $0 + $1.utf16.count + 1 } + site.col
    let u = Array(text.utf16)
    guard at <= u.count, let open = u[at...].firstIndex(of: 40) else { return [] }
    let close = matchClose(text, open)
    guard close >= 0 else { return [] }
    let callText = String(decoding: u[at...close], as: UTF16.self)
    guard textContains(callText, "#include") else { return [] }
    var out: [Crossed] = []
    for j in jitKernels(callText, fnText(abs, text, line: site.line)) {
      let file = { (f: String) in hasUnitSuffix(f.replacingOccurrences(of: "\\", with: "/"), j.header) }
      guard let k = await kernelSym(j.kernel, near: nil, file: file) else { continue }
      let params = templateParams(k.head)
      let vals = j.targs.enumerated().map { i, x in
        BoundVal(
          name: i < params.count ? params[i] : "#\(i + 1)",
          value: x.utf16.count > 28 ? String(decoding: x.utf16.prefix(27), as: UTF16.self) + "…" : x)
      }
      out.append(Crossed(t: k.t, mark: CrossMark(bound: "JIT compile · \(NodePath.basename(j.header))", vals: vals)))
    }
    return out
  }

  /// Before the language server: torch.ops (Python), a launch macro or a JIT compile (C++). Nothing when none is
  /// recognised
  func crossBefore(_ site: CallSite?, lang: String, here: FileText?) async -> [Crossed] {
    guard let site else { return [] }
    if grammarOf(lang) != .cpp { return textContains(site.recv ?? "", "torch.ops") ? await viaTorchOps(site) : [] }
    guard let here else { return [] }
    let lm = await viaLaunchMacro(site, here.abs, here.text)
    if !lm.isEmpty { return lm }
    return ["compile", "build", "jit_compile"].contains(site.name) ? await viaJit(site, here.abs, here.text) : []
  }

  /// The target found: Triton's [grid] launch takes its constexprs and configs, CUDA's <<<>>> its template values,
  /// a TileLang factory becomes the prim_func inside it
  func decorate(_ site: CallSite?, _ t: Target, caller: CallerText?) async -> Crossed {
    let plain = Crossed(t: t)
    guard let site, let text = await readText(t.abs) else { return plain }
    let lines = splitLines(text)
    let lang = langOf(t.abs)
    if site.launch == .grid && lang == "python" {
      let full =
        analysis.analysisOf(lang, text).symbols.first { $0.qual == t.sym.qual && $0.defLine == t.sym.defLine } ?? t.sym
      let (vals, alts) = tritonVals(tritonInfo(lines, t.sym), full.params.map(\.name), site.args)
      return Crossed(t: Target(abs: t.abs, sym: full), mark: CrossMark(bound: "kernel[grid]", vals: vals, alts: alts))
    }
    if site.launch == .chevrons, let caller {
      let head = lineSlice(lines, t.sym.start - 1, t.sym.defLine).joined(separator: "\n")
      let vals = bindLaunch(head, launchTemplateArgs(caller.line, col: site.col), caller.fnText)
      return Crossed(
        t: t, mark: CrossMark(bound: "kernel<<<…>>>", vals: vals),
        title: vals.isEmpty ? nil : instName(t.sym.name, vals))
    }
    if lang == "python" && t.sym.kind == .def {
      let syms = analysis.analysisOf(lang, text).symbols
      if let inner = tilelangInner(lines, t.sym, syms) {
        let factory = syms.first { $0.qual == t.sym.qual } ?? t.sym
        return Crossed(
          t: Target(abs: t.abs, sym: inner),
          mark: CrossMark(bound: "tilelang.jit factory", vals: factoryVals(factory.params, site.args)),
          title: "\(factory.name) → \(inner.name)")
      }
    }
    return plain
  }
}

extension Resolver {
  /// Several targets: the first is the one taken, the rest its alternatives
  func withAlts(_ list: [Crossed]) -> Crossed {
    guard var first = list.first else { preconditionFailure("withAlts of nothing") }
    for r in list.dropFirst() {
      first.mark.alts.append(
        CallAlt(
          label: r.label ?? r.title ?? r.t.sym.qual, detail: "\(lookup.hostPath(r.t.abs)):\(r.t.sym.defLine)",
          path: lookup.hostPath(r.t.abs), line: r.t.sym.defLine, qual: r.t.sym.qual, lib: sources.libOf(r.t.abs),
          vals: r.mark.vals.isEmpty ? nil : r.mark.vals))
    }
    return first
  }
}
