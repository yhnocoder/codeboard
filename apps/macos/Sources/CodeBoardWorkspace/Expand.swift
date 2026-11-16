import CodeBoardAnalysis
import Foundation

// packages/host/src/resolve.ts's expand: where a click on a call in a code card goes, and the card it makes. The
// resolvers are asked in the VS Code version's order and the first that answers wins: a pick from an earlier answer;
// the cross-language routes the language server cannot answer; the server's definitions and dynamic dispatch; Python
// calling into compiled code; stubs of compiled code; last the name index. PyTorch's operator routing (torch*.ts) is
// not here yet: in a PyTorch checkout a call into an operator falls through to the routes after it.

/// Which definition of an earlier answer to expand. rel: the path is relative to the segment's own source root (a
/// class card's member, a file outside the workspace too); qual: found by symbol, a pinned version's lines may move
public struct ExpandPick: Hashable, Sendable {
  public var path: String
  public var line: Int
  public var rel: Bool
  public var qual: String?

  public init(path: String, line: Int, rel: Bool = false, qual: String? = nil) {
    self.path = path
    self.line = line
    self.rel = rel
    self.qual = qual
  }
}

/// A click on a call: the segment's line and the call's column, its name and receiver as the card's mark knows them
public struct ExpandRequest: Hashable, Sendable {
  public var seg: CodeSegment
  public var line: Int
  public var col: Int
  public var name: String
  public var recv: String?
  public var pick: ExpandPick?

  public init(seg: CodeSegment, line: Int, col: Int, name: String, recv: String? = nil, pick: ExpandPick? = nil) {
    self.seg = seg
    self.line = line
    self.col = col
    self.name = name
    self.recv = recv
    self.pick = pick
  }
}

/// One definition to pick from; path as the host shows it
public struct DefinitionPick: Hashable, Sendable {
  public var label: String
  public var detail: String
  public var path: String
  public var line: Int
}

/// The card a call expands into: a function or class card's segment, the variables the call can pass, what it
/// crossed, a template instance's title; dispatching: a method whose overrides are still being asked (dispatchAt)
public struct ExpandedCard: Hashable, Sendable {
  public var segment: CodeSegment
  public var vars: [Var]
  public var mark: CrossMark
  public var title: String?
  public var dispatching: Bool
}

/// What a click on a call gives (protocol.ts's ExpandResult)
public enum Expanded: Hashable, Sendable {
  case card(ExpandedCard)
  /// Several definitions: the user picks one, which is asked again with that pick
  case pick([DefinitionPick])
  /// Dynamic dispatch: every implementation to pick from; base is the method of the static type
  case impls([ImplPick], base: String)
  /// Nothing found; name: the call's, to search by across languages
  case none(reason: String, name: String?)
}

extension Resolver {
  private enum Hit {
    case crossed([Crossed])
    case targets([Target])
    case reply(Expanded)
  }

  private struct LspAnswer {
    var defs: [Def]
    var stubs: [Def]
    var dispatch: ClickDispatch
  }

  private struct Cand: RankCandidate {
    var e: IndexEntry
    var path: String
    var qual: String { e.qual }
  }

  /// Where a click on a call goes, and the card it makes
  public func expand(_ m: ExpandRequest) async -> Expanded {
    let seg = m.seg
    switch seg.src {
    case .free: return .none(reason: "Free code has no source to follow.", name: nil)
    case .github: return .none(reason: "Expanding calls in GitHub code is not supported yet.", name: nil)
    case .repo, .external: break
    }
    let full = ((try? await sources.versionText(seg)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    let site = callSite(seg, full, line: m.line, col: m.col, name: m.name)
    if site == nil {
      lookup.ws.log(
        .warn,
        "expand \(m.name) → callSite miss path=\(seg.path):\(m.line):\(m.col)"
          + (full == nil ? " (file text unavailable, used saved lines)" : ""))
    }
    let here = full.map { FileText(abs: sources.absOf(seg) ?? seg.path, text: $0) }
    let (hit, l) = await resolve(m, site: site, here: here)
    var crossed: [Crossed] = []
    var targets: [Target] = []
    switch hit {
    case .reply(let r)?: return r
    case .crossed(let c)?: crossed = c
    case .targets(let t)?: targets = t
    case nil: break
    }
    // a cross-language answer still offers the compiled code's stubs as alternatives
    if !crossed.isEmpty, let stubs = l?.stubs, !stubs.isEmpty {
      crossed += await stubAlternatives(crossed.map(\.t), stubs, name: m.name).map {
        Crossed(t: $0.target, label: $0.label)
      }
    }
    if crossed.isEmpty && targets.isEmpty {
      let why = site?.dispatch != nil ? "Dynamic dispatch: not resolved" : "No definition found for “\(m.name)”."
      lookup.ws.log(
        .warn, "expand \(m.name) → \(why) path=\(seg.path):\(m.line):\(m.col) lsp=\(l?.defs.count ?? 0)")
      return .none(reason: why, name: m.name)
    }
    if targets.count > 1 { return .pick(targets.map(defPick)) }
    let x =
      crossed.isEmpty
      ? await lookup.decorate(site, targets[0], caller: full.map { lookup.callerOf(seg.lang, $0, m.line) })
      : withAlts(crossed)
    if !crossed.isEmpty {
      lookup.ws.log(
        .info,
        "expand \(m.name) → \(x.mark.bound ?? "definition") → \(x.t.sym.qual) (\(lookup.hostPath(x.t.abs)):"
          + "\(x.t.sym.defLine))" + (crossed.count > 1 ? " +\(crossed.count - 1) alternatives" : ""))
    }
    guard let segment = await cardSegment(x.t) else {
      lookup.ws.log(.error, "expand \(m.name) → cannot read \(lookup.hostPath(x.t.abs))")
      return .none(reason: "Cannot read \(lookup.hostPath(x.t.abs)).", name: nil)
    }
    var vars: [Var] = []
    if let site, !x.t.sym.name.hasPrefix("<") { vars = await varsFor(site, x.t) }
    return .card(
      ExpandedCard(
        segment: segment, vars: vars, mark: x.mark, title: x.title,
        dispatching: l?.dispatch == .pending && crossed.isEmpty))
  }

  private func defPick(_ t: Target) -> DefinitionPick {
    let p = lookup.hostPath(t.abs)
    return DefinitionPick(label: t.sym.qual, detail: "\(p):\(t.sym.defLine)", path: p, line: t.sym.defLine)
  }

  /// The resolvers in order: the first answer, and the language server's when it was asked
  private func resolve(_ m: ExpandRequest, site: CallSite?, here: FileText?) async -> (Hit?, LspAnswer?) {
    let seg = m.seg
    // a pick from an earlier answer: only that
    if let p = m.pick {
      let abs = p.rel ? sources.absOf(CodeSegment(copying: seg, path: p.path)) : fromHostPath(p.path)
      guard let abs,
        let t = await lookup.symAtDef(Def(abs: abs, line: p.line, col: 0), name: p.rel ? m.name : nil, qual: p.qual)
      else { return (.targets([]), nil) }
      return (.targets([t]), nil)
    }
    let before = await lookup.crossBefore(site, lang: seg.lang, here: here)
    if !before.isEmpty { return (.crossed(before), nil) }
    let l = await askLsp(m)
    if case .impls(let d)? = l?.dispatch { return (.reply(.impls(d.impls, base: d.base)), l) }
    let defs = await targetsAt(l?.defs ?? [], name: m.name)
    if !defs.isEmpty { return (.targets(defs), l) }
    // Python calling into C / C++ / Rust: the registrations, unless the index has a Python definition of the name
    // (self.model.forward is not the C++ .def("forward"))
    if seg.lang == "python" && (l?.defs ?? []).isEmpty,
      !(await lookup.index.lookupName(m.name)).contains(where: { hasUnitSuffix($0.abs, ".py") })
    {
      let reg = await lookup.viaRegistry(m.name)
      if !reg.isEmpty { return (.crossed(reg), l) }
    }
    let stubs = await targetsAt(l?.stubs ?? [], name: m.name)
    if !stubs.isEmpty { return (.targets(stubs), l) }
    return (await byName(m, site: site, lspAnswered: !(l?.defs ?? []).isEmpty), l)
  }

  /// Go to Definition at the call in the working copy, sorted out, and dynamic dispatch at its one definition; nil
  /// when the segment is not the working copy's lines
  private func askLsp(_ m: ExpandRequest) async -> LspAnswer? {
    guard let d = await clickDefs(m.seg, line: m.line, col: m.col, name: m.name) else { return nil }
    return LspAnswer(defs: d.defs, stubs: d.stubs, dispatch: await clickDispatch(d.defs, name: m.name))
  }

  private func targetsAt(_ defs: [Def], name: String) async -> [Target] {
    var out: [Target] = []
    for d in defs {
      guard let t = await lookup.symAtDef(d, name: name),
        !out.contains(where: { jsEqual($0.abs, t.abs) && $0.sym.qual == t.sym.qual })
      else { continue }
      out.append(t)
    }
    return out
  }

  /// By name, ranked by the receiver: the one that stands out, else the first twenty to pick from. When the language
  /// server gave a definition that is no function or class (a variable, an attribute), only the current file and the
  /// files read lately: no workspace scan
  private func byName(_ m: ExpandRequest, site: CallSite?, lspAnswered: Bool) async -> Hit? {
    let seg = m.seg
    var ents =
      lspAnswered
      ? await lookup.nearbyEntries(m.name, here: await sources.workingPlace(seg)?.abs)
      : await lookup.index.lookupName(m.name)
    if grammarOf(seg.lang) == .cpp { ents = await lookup.cppCands(ents, site) }
    let cands = ents.map { Cand(e: $0, path: lookup.hostPath($0.abs)) }
    if cands.isEmpty { return nil }
    let parentOf = { (q: String) in unitSplit(q, ".").dropLast().joined(separator: ".") }
    let own = seg.symbol.map { $0.kind == .class ? $0.qual : parentOf($0.qual) }
    let selfClass = [own, seg.scope.map(parentOf)].compactMap { $0 }.first { !$0.isEmpty }
    let (ranked, best) = rankByReceiver(
      cands, recv: m.recv ?? site?.recv, path: await currentFile(seg), selfClass: selfClass)
    if let best { return .targets([Target(abs: best.e.abs, sym: toSym(best.e))]) }
    return .reply(
      .pick(
        ranked.prefix(20).map {
          DefinitionPick(label: $0.qual, detail: "\($0.path):\($0.e.defLine)", path: $0.path, line: $0.e.defLine)
        }))
  }

  /// A path as the host shows it back to the file: relative to the first root
  private func fromHostPath(_ p: String) -> String {
    NodePath.isAbsolute(p) ? p : NodePath.resolve(lookup.ws.roots.first ?? "", p)
  }

  /// A function or class card's segment of the target (cards.ts's cardForFileSym), pinned as Add Function pins it
  func cardSegment(_ t: Target) async -> CodeSegment? {
    guard let text = await lookup.readText(t.abs), let loc = try? await sources.locOfFile(t.abs) else { return nil }
    return try? await sources.makeSegment(
      id: "", loc, lines: splitLines(text), start: t.sym.start, end: t.sym.end,
      symbol: SymbolRef(qual: t.sym.qual, kind: t.sym.kind == .class ? .class : .function), lang: lookup.langOf(t.abs))
  }
}

extension CodeSegment {
  /// The same source and version, another file
  init(copying s: CodeSegment, path: String) {
    self = s
    self.path = path
  }
}
