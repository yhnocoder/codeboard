import Foundation

// Python kernels and dispatch: Triton's @triton.jit / autotune values, TileLang factories, abstract base methods. As
// the Python part of packages/analysis/src/bridge.ts.

/// A Triton kernel's decorators and parameters
public struct TritonInfo: Hashable, Codable, Sendable {
  public var jit: Bool
  public var constexprs: [String]
  public var configs: [[BoundVal]]

  public init(jit: Bool, constexprs: [String], configs: [[BoundVal]]) {
    self.jit = jit
    self.constexprs = constexprs
    self.configs = configs
  }
}

private let tritonJitRe = JSRegex(#"@triton\.jit|@triton\.autotune|@triton\.heuristics|@jit\b"#)
private let sigEndRe = JSRegex(#"\)\s*(->[^:]*)?:\s*(#.*)?$"#)
private let tlConstexprRe = JSRegex(#"([A-Za-z_]\w*)\s*:\s*tl\.constexpr"#)
private let tritonConfigRe = JSRegex(#"triton\.Config\(\s*\{([^}]*)\}\s*(?:,([^)]*))?\)"#)
private let configKeyRe = JSRegex(#"["'](\w+)["']\s*:\s*([^,]+)"#)
private let configOptRe = JSRegex(#"(num_stages|num_warps|num_ctas)\s*=\s*([^,\s)]+)"#)

/// A def's decorators and parameters: @triton.jit, @triton.autotune(configs=[triton.Config({…}, num_stages=…,
/// num_warps=…), …]), the tl.constexpr parameters
public func tritonInfo(_ lines: [String], _ sym: Sym) -> TritonInfo {
  let head = jsSlice(lines, sym.start - 1, sym.defLine - 1).joined(separator: "\n")
  let jit = tritonJitRe.test(head)
  // the parameters, up to the ) (over several lines)
  var sig = ""
  var i = max(0, sym.defLine - 1)
  while i < min(lines.count, sym.end) {
    sig += lines[i] + "\n"
    if sigEndRe.test(lines[i]) { break }
    i += 1
  }
  let cx = tlConstexprRe.all(sig).map { $0[1] ?? "" }
  var configs: [[BoundVal]] = []
  for m in tritonConfigRe.all(head) {
    var vals: [BoundVal] = []
    for kv in configKeyRe.all(m[1] ?? "") { vals.append(BoundVal(name: kv[1] ?? "", value: jsTrim(kv[2] ?? ""))) }
    for kv in configOptRe.all(m[2] ?? "") {
      let k = kv[1] ?? ""
      vals.append(BoundVal(name: k == "num_stages" ? "stages" : k == "num_warps" ? "warps" : k, value: kv[2] ?? ""))
    }
    configs.append(vals)
  }
  return TritonInfo(jit: jit, constexprs: cx, configs: configs)
}

/// kernel[grid](…)'s values: the constexpr parameters whose argument is a constant (BLOCK_M → 64), or when none is,
/// at most 3 name → expression. Of autotune's configs the first is the one chosen, the others grey alternatives.
public func tritonVals(_ info: TritonInfo, _ params: [String], _ args: [Arg]) -> (vals: [BoundVal], alts: [CallAlt]) {
  var bound: [(name: String, text: String)] = []
  var i = 0
  for a in args {
    if a.star == true { break }
    if let kw = a.kw, !kw.isEmpty { continue }
    let p = i < params.count ? params[i] : nil
    i += 1
    if let p, !p.isEmpty, info.constexprs.contains(p) { bound.append((p, a.text)) }
  }
  for a in args {
    if let kw = a.kw, !kw.isEmpty, info.constexprs.contains(kw) { bound.append((kw, a.text)) }
  }
  let lits = bound.filter { literal($0.text) }
  var vals = (lits.isEmpty ? Array(bound.prefix(3)) : lits).map { BoundVal(name: $0.name, value: short($0.text, 28)) }
  var alts: [CallAlt] = []
  if let first = info.configs.first {
    vals.append(contentsOf: first)
    let fixed = Array(vals.prefix(max(0, vals.count - first.count)))
    for (k, c) in info.configs.dropFirst().enumerated() {
      let label = "config \(k + 2) · " + c.map { "\($0.name)=\($0.value)" }.joined(separator: " ")
      alts.append(CallAlt(label: label, vals: fixed + c))
    }
  }
  return (vals, alts)
}

private let tilelangJitRe = JSRegex(#"@(tilelang|tl)\.jit\b|@tilelang\.jit|@jit\b"#)
private let primFuncRe = JSRegex(#"@T\.prim_func|@tilelang\.prim_func|@T\.macro"#)

/// A @tilelang.jit factory's @T.prim_func inside it (the factory is skipped, straight to the prim_func)
public func tilelangInner(_ lines: [String], _ factory: Sym, _ syms: [Sym]) -> Sym? {
  let head = jsSlice(lines, factory.start - 1, factory.defLine - 1).joined(separator: "\n")
  guard tilelangJitRe.test(head) else { return nil }
  return syms.first { s in
    s.qual.jsStartsWith(factory.qual + ".")
      && jsSlice(lines, s.start - 1, s.defLine - 1).contains { primFuncRe.test($0) }
  }
}

/// Factory parameters ← arguments: block_N → 64, num_stages → 2
public func factoryVals(_ params: [Param], _ args: [Arg]) -> [BoundVal] {
  let ps = params.filter { $0.kind != .self }
  var out: [BoundVal] = []
  var i = 0
  for a in args {
    if a.star == true { break }
    if let kw = a.kw, !kw.isEmpty { continue }
    let p = i < ps.count ? ps[i] : nil
    i += 1
    if let p, p.kind != .star, p.kind != .dstar { out.append(BoundVal(name: p.name, value: short(a.text, 28))) }
  }
  for a in args {
    if let kw = a.kw, !kw.isEmpty { out.append(BoundVal(name: kw, value: short(a.text, 28))) }
  }
  return out
}

private let abstractRe = JSRegex(#"@(abc\.)?abstractmethod"#)
private let signatureRe = JSRegex(#"^[\s\S]*?\)\s*(->[^:]*)?:"#)
private let docstringRe = JSRegex(#"^\s*[rRbBuU]*("""|''')[\s\S]*?\1"#)
private let commentRe = JSRegex("#.*$", "m")
private let abstractBodyRe = JSRegex(#"^(raise\s+NotImplementedError\b.*|\.\.\.|pass)$"#, "s")

/// Whether a base class's method is abstract: @abstractmethod, or a body (docstring aside) that is only raise
/// NotImplementedError / ... / pass
public func isAbstractBody(_ lines: [String], _ sym: Sym) -> Bool {
  if jsSlice(lines, sym.start - 1, sym.defLine - 1).contains(where: { abstractRe.test($0) }) { return true }
  var body = jsSlice(lines, sym.defLine - 1, sym.end).joined(separator: "\n")
  // the signature off
  body = signatureRe.replace(body, with: "")
  body = jsTrim(commentRe.replace(docstringRe.replace(body, with: ""), global: true, with: ""))
  return body.isEmpty || abstractBodyRe.test(body)
}
