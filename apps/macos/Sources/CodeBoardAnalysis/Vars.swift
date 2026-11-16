// The variables a call may show, as packages/analysis/src/vars.ts proposes them: candidates only, none is added by
// default. Empty when they cannot be told (*args passed on, dispatch by string, an unknown callee).

private func short(_ s: String, _ n: Int = 28) -> String {
  let u = s.units
  return u.count > n ? string(u.prefix(n - 1)) + "…" : s
}

private func pair(_ a: String, _ b: String) -> Var { a == b ? Var(a: a) : Var(a: a, b: b) }

public func varCandidates(_ call: CallSite, _ callee: Sym?) -> [Var] {
  guard let callee, call.dispatch == nil || call.dispatch?.isEmpty == true else { return [] }
  var out: [Var] = []
  let params = callee.params.filter { $0.kind != .self }
  // obj.method(x) of a module function without self (torch.foo, say): the arguments still pair up in order
  var i = 0
  for a in call.args {
    // After *args nothing lines up
    if a.star == true { break }
    if let kw = a.kw, !kw.isEmpty { continue }
    guard i < params.count, ![.star, .dstar, .kw].contains(params[i].kind) else { break }
    out.append(pair(a.name ?? short(a.text), params[i].name))
    i += 1
  }
  for a in call.args {
    guard let kw = a.kw, !kw.isEmpty else { continue }
    if !params.contains(where: { $0.name == kw }) && !params.contains(where: { $0.kind == .dstar }) { continue }
    out.append(pair(a.name ?? short(a.text), kw))
  }
  if let assigned = call.assigned, !assigned.isEmpty { out.append(Var(a: assigned.joined(separator: ", "), ret: true)) }
  var seen = Set<String>()
  return out.filter { seen.insert($0.key).inserted }
}
