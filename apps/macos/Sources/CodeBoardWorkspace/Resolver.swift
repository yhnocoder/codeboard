import CodeBoardAnalysis
import Foundation

// The parts of packages/host/src/resolve.ts that ask the language server, or need a segment's sources and versions:
// the call clicked, the variables it passes, dynamic dispatch, how the click sorts a server's answer into definitions
// and stubs of compiled code, the stubs offered beside a cross-language answer, a local definition for a peek and a
// hover. What the click does with them (expand, the resolvers, the bridge's routes, the card) is not here.

/// How long a click waits for Go to Implementation (DISPATCH_WAIT): enough when it is kept or the server is warm;
/// beyond it the card is built first
public let dispatchWait: Duration = .milliseconds(200)

/// One implementation of a dynamically dispatched method to pick (core's ImplPick)
public struct ImplPick: Hashable, Sendable {
  public var label: String
  public var detail: String
  public var path: String
  public var line: Int
  public var qual: String
  /// The package of one outside the workspace
  public var lib: String?
  /// The base class's own method
  public var base: Bool
}

/// A method that subclasses override: every implementation (dispatchOf)
public struct Dispatch: Hashable, Sendable {
  public var impls: [ImplPick]
  /// The method's qual
  public var base: String
  /// Its class
  public var baseClass: String
  /// Its body is abstract, so it is no implementation itself
  public var abstract: Bool

  public var n: Int { impls.count }
}

/// What a click learnt of dynamic dispatch in the time it waits (askLsp's dispatch)
public enum ClickDispatch: Hashable, Sendable {
  case none
  case impls(Dispatch)
  /// Go to Implementation is still running: the board asks again (dispatchAt)
  case pending
}

/// A server's definitions at a click: .pyi stubs of Python code replaced by the code; stubs of compiled code
/// (torch._C.*, extensions) aside, an answer only when nothing else is found
public struct LspDefs: Hashable, Sendable {
  public var defs: [Def]
  public var stubs: [Def]
}

/// A stub of compiled code offered beside a cross-language answer
public struct StubAlternative: Hashable, Sendable {
  public var target: Target
  public var label: String
}

/// A hover as a signature and docs
public struct Hover: Hashable, Sendable {
  public var sig: String?
  public var doc: String?
}

/// An assignment or parameter in the function a peek is in, found without a server (localDef)
public struct LocalDef: Hashable, Sendable {
  public var line: Int
  public var plan: PeekPlan
  /// The lines shown: a parameter's line with one line around it
  public var rows: [Int]
  public var scope: String?
  public var follow: Follow?
}

public final class Resolver: Sendable {
  public let sources: Sources
  public let lsp: Lsp
  private let routesOps: @Sendable (String) async -> Bool

  /// routesOps: the file is in a PyTorch checkout whose operators the host routes (torchops.ts's opTableFor), so
  /// that Go to Implementation is not asked at its compiled code's stubs
  public init(_ sources: Sources, lsp: Lsp, routesOps: @escaping @Sendable (String) async -> Bool) {
    self.sources = sources
    self.lsp = lsp
    self.routesOps = routesOps
  }

  var lookup: CodeLookup { sources.lookup }

  // MARK: The call

  /// The call clicked: by the whole file at the segment's version, else by the segment's own lines without their
  /// common indent; at the column, else of the name on the line
  public func callSite(_ seg: CodeSegment, _ full: String?, line: Int, col: Int, name: String) -> CallSite? {
    var calls: [CallSite]
    var shift = 0
    var colOff = 0
    if let full, !full.isEmpty {
      calls = lookup.analysis.segAnalysis(seg.lang, full, start: line, end: line).calls
    } else {
      let d = dedent(seg.text)
      colOff = d.cut
      calls = lookup.analysis.analysisOf(seg.lang, d.lines.joined(separator: "\n")).calls
      shift = seg.start - 1
    }
    let on = calls.filter { $0.line + shift == line }
    return on.first { $0.col + colOff == col } ?? on.first { $0.name == name || $0.dispatch == name }
  }

  /// The variable candidates of an arrow marked Call: a class's by its __init__
  public func varsFor(_ site: CallSite, _ t: Target) async -> [Var] {
    let text = t.sym.kind == .class || t.sym.params.isEmpty ? await lookup.readText(t.abs) : nil
    let syms = text.flatMap { $0.isEmpty ? nil : lookup.analysis.analysisOf(lookup.langOf(t.abs), $0).symbols } ?? []
    return varCandidates(site, calleeOf(t.sym, syms))
  }

  /// A call linked to an existing card (dragged onto it, Link to Existing Card): the variables by the card's symbol
  public func callVars(_ seg: CodeSegment, line: Int, col: Int, name: String, target t: CodeSegment)
    async throws(GitError) -> [Var]
  {
    if seg.src == .free { return [] }
    guard let site = callSite(seg, try await sources.versionText(seg), line: line, col: col, name: name) else {
      return []
    }
    let full = t.src == .free ? nil : try await sources.versionText(t)
    let syms: [Sym]
    if let full, !full.isEmpty {
      syms = lookup.analysis.analysisOf(t.lang, full).symbols
    } else {
      // only the segment's lines: analysed without their common indent, the lines shifted back
      let shift = t.start - 1
      syms = lookup.analysis.analysisOf(t.lang, dedent(t.text).lines.joined(separator: "\n")).symbols.map { s in
        var s = s
        s.start += shift
        s.defLine += shift
        s.end += shift
        // a method analysed alone does not show its self
        if let p = s.params.first, p.name == "self" || p.name == "cls" { s.params[0].kind = .self }
        return s
      }
    }
    let top =
      t.symbol.flatMap { r in syms.first { $0.qual == r.qual } }
      ?? syms.first { s in
        s.start >= t.start && s.end <= t.end && (s.name == name || hasUnitSuffix(s.qual, ".\(name)"))
      }
      ?? symbolAt(syms, line: t.start)
    return top.map { varCandidates(site, calleeOf($0, syms)) } ?? []
  }

  /// The current file of a segment as the host path ranking compares with
  public func currentFile(_ seg: CodeSegment) async -> String {
    await sources.workingPlace(seg).map { lookup.hostPath($0.abs) } ?? seg.path
  }

  // MARK: The server's answer at a click

  /// Go to Definition at the call in the working copy (askLsp's first part), nil when the segment's lines are not
  /// the working copy's. A .pyi beside a .py stands for the .py; a stub with no .py beside it in the project is kept
  /// aside. A library's stubs (typeshed's builtins.pyi, a package outside the workspace or in .venv) are answers: a
  /// pybind .def("get") has nothing to do with dict.get
  public func clickDefs(_ seg: CodeSegment, line: Int, col: Int, name: String) async -> LspDefs? {
    guard let wp = await sources.workingPlace(seg), wp.exact else { return nil }
    return await sortDefs(await lsp.clickDefs(wp.abs, line: wp.start + (line - seg.start), col: col), name: name)
  }

  func sortDefs(_ answer: [Def], name: String) async -> LspDefs {
    var defs: [Def] = []
    var stubs: [Def] = []
    for d in answer {
      var impl: Def? = d
      if isStub(d) {
        impl = await lookup.stubImpl(d, name: name)
        if impl == nil && !(sources.inWorkspace(d.abs) && !inExcludedDir(d.abs)) { impl = d }
      }
      guard let impl else {
        stubs.append(d)
        continue
      }
      if !defs.contains(where: { jsEqual($0.abs, impl.abs) && $0.line == impl.line }) { defs.append(impl) }
    }
    return LspDefs(defs: defs, stubs: defs.isEmpty ? stubs : [])
  }

  private func inExcludedDir(_ abs: String) -> Bool { FileQuery.code.excludes(abs, root: lookup.ws.rootOf(abs)) }

  /// Dynamic dispatch at a click's one definition (askLsp's last part): the implementations if Go to
  /// Implementation answers within dispatchWait; pending when it may (it keeps running, so the board's next ask
  /// finds it kept)
  public func clickDispatch(_ defs: [Def], name: String) async -> ClickDispatch {
    guard defs.count == 1 else { return .none }
    let d = defs[0]
    switch await within(Task { await self.dispatchOf(d, name: name) }, dispatchWait, clock: lsp.clock) {
    case .late: return await lookup.mayDispatch(d, name) ? .pending : .none
    case .done(let r): return r.map(ClickDispatch.impls) ?? .none
    }
  }

  /// The stubs' definitions as alternatives beside a cross-language answer of these targets (withStubs)
  public func stubAlternatives(_ have: [Target], _ stubs: [Def], name: String) async -> [StubAlternative] {
    var out: [StubAlternative] = []
    for d in stubs {
      guard let t = await lookup.symAtDef(d, name: name) else { continue }
      let same = { (x: Target) in jsEqual(x.abs, t.abs) && x.sym.qual == t.sym.qual }
      if have.contains(where: same) || out.contains(where: { same($0.target) }) { continue }
      out.append(StubAlternative(target: t, label: "stub · \(NodePath.basename(t.abs)) \(t.sym.qual)"))
    }
    return out
  }

  // MARK: Dynamic dispatch

  /// Where to ask Go to Implementation for a definition: a stub's .py; not at a PyTorch compiled code's stub, where
  /// the operator routes answer instead (Pylance searches the whole workspace there for ~24 s and finds nothing)
  func implSite(_ d: Def, name: String) async -> Def? {
    if !isStub(d) { return d }
    if let impl = await lookup.stubImpl(d, name: name) { return impl }
    return await routesOps(d.abs) ? nil : d
  }

  /// A definition that is a method of a class: Go to Implementation on it. Overrides make it dynamic dispatch: every
  /// implementation (the base's own when it is not abstract), a library's marked with its package
  public func dispatchOf(_ def: Def, name: String) async -> Dispatch? {
    if lookup.langOf(def.abs) != "python" { return nil }
    guard let d = await implSite(def, name: name) else { return nil }
    let found = await lookup.symAtDef(d, name: name)
    guard overridable(found, name), let b = found, let baseClass = b.sym.parent else { return nil }
    let locs: [Def]
    do throws(LanguageError) {
      locs = try await lsp.impls(d)
    } catch {
      return nil
    }
    var impls: [Target] = []
    for l in locs where !(jsEqual(l.abs, d.abs) && l.line == d.line) {
      guard let t = await lookup.symAtDef(l, name: name) else { continue }
      let same = { (x: Target) in jsEqual(x.abs, t.abs) && x.sym.qual == t.sym.qual }
      if !same(b) && !impls.contains(where: same) { impls.append(t) }
    }
    if impls.isEmpty { return nil }
    let abstract = await lookup.readText(b.abs).map { isAbstractBody(splitLines($0), b.sym) } ?? false
    let pick = { (t: Target, base: Bool) in
      ImplPick(
        label: t.sym.qual, detail: "\(self.lookup.hostPath(t.abs)):\(t.sym.defLine)", path: self.lookup.hostPath(t.abs),
        line: t.sym.defLine, qual: t.sym.qual, lib: self.sources.libOf(t.abs), base: base)
    }
    let list = (abstract ? [] : [pick(b, true)]) + impls.map { pick($0, false) }
    lookup.ws.log(.info, "dynamic dispatch \(b.sym.qual) → \(list.count) implementations")
    return Dispatch(impls: list, base: b.sym.qual, baseClass: baseClass, abstract: abstract)
  }

  /// The board asks after a click answered pending: whether the definition at the same call is overridden (the
  /// definition and Go to Implementation come from the cache, the click's own requests)
  public func dispatchAt(_ seg: CodeSegment, line: Int, col: Int, name: String) async -> Dispatch? {
    guard hasLocalFile(seg.src), let wp = await sources.workingPlace(seg), wp.exact else { return nil }
    let defs = await lsp.clickDefs(wp.abs, line: wp.start + (line - seg.start), col: col)
    guard defs.count == 1 else { return nil }
    return await dispatchOf(defs[0], name: name)
  }

  // MARK: Peek without a server

  /// An assignment word = … or a parameter, up the function the line is in; for self.x every self.x = … of its
  /// class, first first. By the segment's version of the file
  public func localDef(_ seg: CodeSegment, line: Int, word: String) async throws(GitError) -> LocalDef? {
    guard let full = try await sources.versionText(seg), !full.isEmpty else { return nil }
    let lines = splitLines(full)
    let isSelf = startsWith(word, "self.")
    let name = isSelf ? String(decoding: word.utf16.dropFirst(5), as: UTF16.self) : word
    let esc = escapeRegExp(name)
    let re = JSRegex(
      isSelf
        ? #"^\s*self\."# + esc + #"\s*(:[^=]*)?=(?!=)"#
        : #"^\s*"# + esc + #"\s*(:[^=]*)?=(?!=)|^\s*(?:async\s+)?def\s+\w+\(.*\b"# + esc + #"\b"#)
    let a = lookup.analysis.analysisOf(seg.lang, full)
    let fn = symbolAt(a.symbols, line: line, kind: .def)
    let cls = isSelf ? a.symbols.first { $0.kind == .class && fn?.parent == $0.qual } : nil
    let lo = cls?.start ?? fn?.start ?? 1
    let hi = cls?.end ?? line - 1
    let at = { (l: Int) in l >= 1 && l <= lines.count ? lines[l - 1] : "" }
    let order = isSelf ? Array(stride(from: lo, through: hi, by: 1)) : Array(stride(from: hi, through: lo, by: -1))
    guard let hit = order.first(where: { re.test(at($0)) && $0 != line }) else { return nil }
    let plan = peekPlan(a, lines, line: hit, word: name)
    var rows = plan.rows
    if plan.kind == .function {
      rows = []
      for l in [max(1, hit - 1), hit, min(lines.count, hit + 1)] where !rows.contains(l) { rows.append(l) }
    }
    return LocalDef(
      line: hit, plan: plan, rows: rows, scope: symbolAt(a.symbols, line: hit)?.qual, follow: followOf(at(hit), name))
  }

  /// The server's hover (Pylance: a signature code block and Markdown docs); nil without one
  public func hoverAt(_ abs: String, line: Int, col: Int) async -> Hover? {
    guard let parts = try? await lookup.ws.language.hover(abs, line: line, col: col) else { return nil }
    // Pylance ends its docs with HTML comments (<!--moduleHash:…-->), which Markdown would show as they are
    let r = splitHover(jsTrim(htmlComment.replace(parts.joined(separator: "\n\n"), global: true, with: "")))
    return r.sig != nil || r.doc != nil ? Hover(sig: r.sig, doc: r.doc) : nil
  }
}

private let htmlComment = JSRegex(#"<!--[\s\S]*?-->"#)

/// Lines without their common indent (highlight.ts's dedent): cut is the indent taken off, blank lines not counted
func dedent(_ lines: [String]) -> (cut: Int, lines: [String]) {
  let indent = { (l: String) in l.utf16.count - jsTrimStart(l).utf16.count }
  let cut = lines.filter { !jsTrim($0).isEmpty }.map(indent).min() ?? 0
  return (cut, lines.map { String(decoding: $0.utf16.dropFirst(min(cut, indent($0))), as: UTF16.self) })
}
