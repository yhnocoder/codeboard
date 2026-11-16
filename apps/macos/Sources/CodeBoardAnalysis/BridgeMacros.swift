import Foundation

// Templates and macros on the way to a kernel launch: template parameters and constexprs, #define bodies, names pasted
// with ##, SWITCH_X(CASE_MACRO) launch macros, kernel<…><<<…>>> and JIT-compiled kernels. As the macro and template
// part of packages/analysis/src/bridge.ts.

private let templateRe = JSRegex(#"\btemplate\s*<"#)
private let defaultValueRe = JSRegex(#"=[\s\S]*$"#)
private let lastNameRe = JSRegex(#"([A-Za-z_]\w*)\s*$"#)

/// template <int kNumRanks, int kNumThreads, typename T = float> → the parameters' names
public func templateParams(_ head: String) -> [String] {
  let h = JSText(head)
  guard let t = templateRe.first(h) else { return [] }
  let open = t.end - 1
  var depth = 0
  var paren = 0
  var end = -1
  for i in open..<h.count {
    let ch = h.units[i]
    if ch == unit("(") {
      paren += 1
    } else if ch == unit(")") {
      paren -= 1
    } else if paren != 0 {
      continue
    } else if ch == unit("<") {
      depth += 1
    } else if ch == unit(">") {
      depth -= 1
      if depth == 0 {
        end = i
        break
      }
    }
  }
  if end < 0 { return [] }
  return splitArgs(h.slice(open + 1, end))
    .map { lastNameRe.exec(jsTrim(defaultValueRe.replace($0, with: "")))?[1] ?? "" }
    .filter { !$0.isEmpty }
}

private let constexprRe = JSRegex(#"constexpr\s+(?:static\s+)?[\w:<>]+\s+([A-Za-z_]\w*)\s*=\s*([^;]+);"#)

/// A function's constexpr int kNumThreads = 768; → ["kNumThreads": "768"]
public func constexprs(_ text: String) -> [String: String] {
  var out: [String: String] = [:]
  for m in constexprRe.all(text) { out[m[1] ?? ""] = jsTrim(m[2] ?? "") }
  return out
}

private let literalRe = JSRegex(#"^(-?\d[\w.]*|True|False|true|false|None|"[^"]*"|'[^']*')$"#)

func literal(_ s: String) -> Bool { literalRe.test(jsTrim(s)) }

/// The switch value of a launch macro: the argument it replaces and the values it may take
private struct Pick {
  let arg: String
  let opts: [String]
  let from: String
  let value: String
}

/// Template parameter names ← arguments (an argument that is a constant becomes its value)
private func bindTemplate(_ params: [String], _ args: [String], _ consts: [String: String], _ pick: Pick? = nil)
  -> [BoundVal]
{
  args.enumerated().map { i, a in
    let name = i < params.count ? params[i] : "#\(i + 1)"
    let a = jsTrim(a)
    if let pick, a == pick.arg { return BoundVal(name: name, value: pick.value, opts: pick.opts, from: pick.from) }
    if let v = consts[a], !v.isEmpty, literal(v) { return BoundVal(name: name, value: v) }
    return BoundVal(name: name, value: short(a, 32))
  }
}

/// A function-like #define: its parameters, its body (continued lines joined), its line
public struct MacroDef: Hashable, Codable, Sendable {
  public var params: [String]
  public var body: String
  public var line: Int

  public init(params: [String], body: String, line: Int) {
    self.params = params
    self.body = body
    self.line = line
  }
}

/// Values by name, kept in the order the names first came, as a JavaScript Map keeps them
public struct NameMap<Value: Sendable>: Sendable {
  public private(set) var keys: [String] = []
  private var values: [String: Value] = [:]

  public init() {}

  public subscript(key: String) -> Value? {
    get { values[key] }
    set {
      if values[key] == nil, newValue != nil { keys.append(key) }
      if newValue == nil { keys.removeAll { $0 == key } }
      values[key] = newValue
    }
  }

  public var isEmpty: Bool { keys.isEmpty }
  public var count: Int { keys.count }
}

extension NameMap: Equatable where Value: Equatable {}

private let defineMacroRe = JSRegex(#"^\s*#\s*define\s+([A-Za-z_]\w*)\(([^)]*)\)\s?(.*)$"#)
private let continuedRe = JSRegex(#"\\\s*$"#)

/// #define NAME(params) body, with lines continued by \ joined
public func macroDefs(_ text: String) -> NameMap<MacroDef> {
  var out = NameMap<MacroDef>()
  let lines = splitLines(text)
  for i in 0..<lines.count {
    guard let m = defineMacroRe.exec(lines[i]) else { continue }
    var body = m[3] ?? ""
    var k = i
    while continuedRe.test(lines[k]) && k + 1 < lines.count {
      k += 1
      body = continuedRe.replace(body, with: " ") + lines[k]
    }
    body = continuedRe.replace(body, with: "")
    let params = (m[2] ?? "").jsSplit(",").map(jsTrim).filter { !$0.isEmpty }
    out[m[1] ?? ""] = MacroDef(params: params, body: body, line: i + 1)
  }
  return out
}

/// A piece of a name a #define pastes together: plain text, or the macro's parameter at that index
public enum PastePiece: Hashable, Codable, Sendable {
  case text(String)
  case param(Int)
}

/// A #define that pastes its parameters into identifiers: each name it pastes, as pieces
public struct Paster: Hashable, Codable, Sendable {
  public var params: [String]
  public var names: [[PastePiece]]

  public init(params: [String], names: [[PastePiece]]) {
    self.params = params
    self.names = names
  }
}

private let pastedRe = JSRegex(#"\w+(?:\s*##\s*\w+)+"#)

/// The macros that paste parameters into identifiers with ## (TORCH_IMPL_FUNC(func##_Scalar_out),
/// foreach_tensor_##NAME##_scalar_kernel_slow)
public func pasteMacros(_ text: String) -> NameMap<Paster> {
  var out = NameMap<Paster>()
  if JSText(text).indexOf("##") < 0 { return out }
  let defs = macroDefs(text)
  for name in defs.keys {
    guard let d = defs[name] else { continue }
    var names: [[PastePiece]] = []
    // the TypeScript compares pieces joined by NUL, where parameter 0 and the text "0" are the same
    func key(_ ps: [PastePiece]) -> String {
      ps.map {
        switch $0 {
        case .text(let s): s
        case .param(let i): String(i)
        }
      }.joined(separator: "\0")
    }
    for m in pastedRe.all(d.body) {
      let pieces: [PastePiece] = m.text.jsSplit("##").map(jsTrim).map { p in
        d.params.firstIndex(of: p).map { .param($0) } ?? .text(p)
      }
      let pasted = pieces.contains {
        if case .param = $0 { return true }
        return false
      }
      if pasted && !names.contains(where: { key($0) == key(pieces) }) { names.append(pieces) }
    }
    if !names.isEmpty { out[name] = Paster(params: d.params, names: names) }
  }
  return out
}

private let wordOnlyRe = JSRegex(#"^\w*$"#)

/// The identifiers a pasting macro makes from one call's arguments (only arguments that are identifiers themselves)
public func pastedNames(_ p: Paster, _ args: [String]) -> [String] {
  var out: [String] = []
  for n in p.names {
    var parts: [String] = []
    var ok = true
    for piece in n {
      switch piece {
      case .text(let s): parts.append(s)
      case .param(let i):
        let a = i < args.count ? jsTrim(args[i]) : ""
        parts.append(a)
        if !wordOnlyRe.test(a) { ok = false }
      }
    }
    if ok { out.append(parts.joined()) }
  }
  return out
}

/// A call of a macro at the start of a line
public struct MacroCall: Hashable, Codable, Sendable {
  public var macro: String
  public var args: [String]
  public var line: Int
  /// The call's first line
  public var sig: String

  public init(macro: String, args: [String], line: Int, sig: String) {
    self.macro = macro
    self.args = args
    self.line = line
    self.sig = sig
  }
}

private let macroCallRe = JSRegex(#"^[ \t]*([A-Z][A-Z0-9_]*)\s*\("#, "m")

/// The calls, at the start of a line, of the macros `want` accepts: name, arguments, line, first line
public func macroCalls(_ text: String, _ want: (String) -> Bool) -> [MacroCall] {
  let t = JSText(text)
  var out: [MacroCall] = []
  let lineOf = lineIndex(t)
  for m in macroCallRe.all(t) {
    let macro = m[1] ?? ""
    // inside the body of some #define
    if !want(macro) || inDefine(t, m.index)
      || continuedRe.test(t.slice(t.lastIndexOf(unit("\n"), from: m.index - 2) + 1, m.index))
    {
      continue
    }
    let open = m.end - 1
    let close = matchClose(t, open)
    if close < 0 { continue }
    let end = t.indexOf("\n", from: m.index)
    out.append(
      MacroCall(
        macro: macro, args: splitArgs(t.slice(open + 1, close)), line: lineOf(m.index),
        sig: jsTrim(t.slice(m.index, end < 0 ? nil : end))))
  }
  return out
}

public struct LaunchMacro: Hashable, Codable, Sendable {
  /// The kernel it launches (dispatch)
  public var kernel: String
  /// Its template arguments, macro parameter names kept as written (ranks, kNumThreads, …)
  public var targs: [String]
  /// The case macro's parameter (ranks)
  public var param: String?
  /// The values the switch takes (2, 4, 8)
  public var cases: [String]?
  /// What the switch is on (num_ranks)
  public var on: String?
  public var switchName: String

  public init(
    kernel: String, targs: [String], param: String? = nil, cases: [String]? = nil, on: String? = nil,
    switchName: String
  ) {
    self.kernel = kernel
    self.targs = targs
    self.param = param
    self.cases = cases
    self.on = on
    self.switchName = switchName
  }
}

private let templateUseRe = JSRegex(#"([A-Za-z_]\w*)\s*<"#)
private let notKernelRe = JSRegex(
  #"^(reinterpret_cast|static_cast|const_cast|dynamic_cast|std|sizeof|decltype|max|min)$"#)

/// The kernel a case macro's body launches: kernel = X<…>, LAUNCH_KERNEL(&cfg, X<…>, …), X<…><<<…>>>; casts and the
/// like skipped
private func kernelIn(_ body: String) -> (kernel: String, targs: [String])? {
  let b = JSText(body)
  for m in templateUseRe.all(b) {
    let name = m[1] ?? ""
    if notKernelRe.test(name) { continue }
    let open = m.end - 1
    // the template arguments: up to the matching >
    var depth = 0
    var end = -1
    for i in open..<b.count {
      let ch = b.units[i]
      if ch == unit("<") {
        depth += 1
      } else if ch == unit(">") {
        depth -= 1
        if depth == 0 {
          end = i
          break
        }
      } else if ch == unit(";") || ch == unit("{") {
        break
      }
    }
    if end < 0 { continue }
    // << / >>
    if b[end + 1] == unit(">") || b[open + 1] == unit("<") { continue }
    return (name, splitArgs(b.slice(open + 1, end)))
  }
  return nil
}

private let switchOnRe = JSRegex(#"switch\s*\(\s*([^)]*?)\s*\)"#)

/// A call SWITCH_X(CASE_MACRO): CASE_MACRO is in `defs` (the same file), SWITCH_X in `switches` (maybe another header).
/// Nil when it is not one.
public func launchMacro(name: String, args: [Arg], defs: NameMap<MacroDef>, switches: NameMap<MacroDef>)
  -> LaunchMacro?
{
  let arg = args.map { jsTrim($0.text) }.first { defs[$0] != nil }
  let sw = switches[name] ?? defs[name]
  guard let arg, let cm = defs[arg] else {
    // the case macro itself is clicked (DISPATCH_LAUNCH_CASE(8)), or LAUNCH_KERNEL(&cfg, kernel<…>, …)
    let own = defs[name]
    let k = own.map { kernelIn($0.body) } ?? (args.count > 1 ? kernelIn(args[1].text + " ") : nil)
    guard let k else { return nil }
    return LaunchMacro(
      kernel: k.kernel, targs: k.targs, param: own?.params.first,
      cases: own != nil && !args.isEmpty ? [args[0].text] : nil, switchName: name)
  }
  guard let k = kernelIn(cm.body) else { return nil }
  var out = LaunchMacro(kernel: k.kernel, targs: k.targs, param: cm.params.first, switchName: name)
  if let sw {
    let on = switchOnRe.exec(sw.body)?[1]
    let cp = sw.params.last
    let re = JSRegex(#"case\s+([^:]+?)\s*:\s*"# + escapeRegExp(cp ?? "case_macro") + #"\s*\(([^)]*)\)"#)
    let cases = re.all(sw.body).map { m in splitArgs(m[2] ?? "").last ?? (m[1] ?? "") }
    if !cases.isEmpty {
      out.cases = cases
      out.on = on
    }
  }
  return out
}

/// A launch macro's values: template parameter names ← arguments; the switch's parameter takes one of its cases (the
/// last by default, usually the largest)
public func launchVals(_ lm: LaunchMacro, _ kernelHead: String, _ fnText: String) -> [BoundVal] {
  let params = templateParams(kernelHead)
  var pick: Pick?
  if let param = lm.param, !param.isEmpty, let cases = lm.cases, let last = cases.last {
    let from = lm.on.map { $0.isEmpty ? lm.switchName : "\(lm.switchName)(\($0))" } ?? lm.switchName
    pick = Pick(arg: param, opts: cases, from: from, value: last)
  }
  return bindTemplate(params, lm.targs, constexprs(fnText), pick)
}

private let templateCallRe = JSRegex(#"^[A-Za-z_]\w*\s*<"#)

/// CUDA's kernel<8, 768><<<…>>>: the template arguments written at the launch (`col` in UTF-16 code units)
public func launchTemplateArgs(_ lineText: String, _ col: Int) -> [String] {
  let rest = JSText(JSText(lineText).slice(col))
  guard let m = templateCallRe.first(rest) else { return [] }
  let open = m.end - 1
  var depth = 0
  for i in open..<rest.count {
    if rest.units[i] == unit("<") {
      if rest.startsWith("<<<", at: i) && depth == 0 { return [] }
      depth += 1
    } else if rest.units[i] == unit(">") {
      depth -= 1
      if depth == 0 { return splitArgs(rest.slice(open + 1, i)) }
    }
  }
  return []
}

public func bindLaunch(_ kernelHead: String, _ targs: [String], _ fnText: String) -> [BoundVal] {
  bindTemplate(templateParams(kernelHead), targs, constexprs(fnText))
}

/// A kernel a JIT compile may build: jit->compile("dispatch", std::format(R"(#include <…/{}.cuh> … &ns::{})", header,
/// func))
public struct JitKernel: Hashable, Codable, Sendable {
  public var header: String
  public var kernel: String
  public var targs: [String]
  public var ns: String?

  public init(header: String, kernel: String, targs: [String], ns: String? = nil) {
    self.header = header
    self.kernel = kernel
    self.targs = targs
    self.ns = ns
  }
}

private let jitIncludeRe = JSRegex(#"#include\s*<([^>]*)\{\}([^>]*)>"#)
private let jitRefRe = JSRegex(#"&([\w:]*?)\{\}"#)
private let jitFormatArgsRe = JSRegex(#"\)"\s*,\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)"#)
private let trailingColonsRe = JSRegex("::$")

/// The text of the compile call and of the function it is in → the kernels it may compile (one per if / else branch)
public func jitKernels(_ callText: String, _ fnText: String) -> [JitKernel] {
  guard let inc = jitIncludeRe.exec(callText), let ref = jitRefRe.exec(callText) else { return [] }
  let fmtArgs = jitFormatArgsRe.exec(callText)
  let hv = fmtArgs?[1] ?? "header_name"
  let fv = fmtArgs?[2] ?? "func_name"
  let fn = JSText(fnText)
  let headers = JSRegex(#"\b"# + escapeRegExp(hv) + #"\s*=\s*"([^"]+)""#).all(fn).map { (at: $0.index, v: $0[1] ?? "") }
  let funcRe = JSRegex(#"\b"# + escapeRegExp(fv) + #"\s*=\s*std::format\(\s*"([A-Za-z_]\w*)<([^"]*)>"\s*,"#)
  let funcs = funcRe.all(fn).map { m in
    (at: m.index, kernel: m[1] ?? "", targs: Array(argsAt(fn, m.index).dropFirst()))
  }
  let ns = trailingColonsRe.replace(ref[1] ?? "", with: "")
  return funcs.map { f in
    let h = headers.last { $0.at < f.at } ?? headers.first
    return JitKernel(
      header: "\(inc[1] ?? "")\(h?.v ?? "")\(inc[2] ?? "")", kernel: f.kernel, targs: f.targs,
      ns: ns.isEmpty ? nil : ns)
  }
}
