// Rust's symbols and calls, as packages/analysis/src/index.ts reads them

/// `s.replace(/<.*$/, "")`: from the first `<` with no line end after it
private func withoutGenerics(_ s: String) -> String {
  let u = s.units
  let lastBreak = u.lastIndex { $0 == 0x0A || $0 == 0x0D || $0 == 0x2028 || $0 == 0x2029 }
  let from = lastBreak.map { $0 + 1 } ?? u.startIndex
  guard let lt = u[from...].firstIndex(of: unit("<")) else { return s }
  return string(u[..<lt])
}

/// Symbols: fns, the methods in impls (Type::f), traits, structs and enums (as classes), mods. #[…] attributes count
/// into the start line, as Python's decorators do.
func rustSymbols(_ cx: Context, _ root: Node) {
  func symbol(
    _ c: Node, _ name: String, _ scope: [String], _ cls: String?, start: Int, _ kind: Sym.Kind, sigEnd: Int,
    params: [Param]
  ) -> Sym {
    Sym(
      name: name, qual: (scope + [name]).joined(separator: "::"), kind: kind, start: start + 1,
      defLine: c.startRow + 1, end: c.endRow + 1, sig: oneLine(cx.text(c.startIndex, sigEnd)), params: params,
      parent: cls)
  }
  func visit(_ n: Node, _ scope: [String], _ cls: String?) {
    var attrStart = -1
    for c in n.namedChildren {
      if c.type == "attribute_item" {
        if attrStart < 0 { attrStart = c.startRow }
        continue
      }
      let start = attrStart >= 0 ? attrStart : c.startRow
      attrStart = -1
      switch c.type {
      case "function_item", "function_signature_item":
        let name = c.field("name")?.text ?? "?"
        let body = c.field("body")
        var params: [Param] = []
        for p in c.field("parameters")?.namedChildren ?? [] {
          if p.type == "self_parameter" {
            params.append(Param(name: "self", kind: .self))
          } else if p.type == "parameter", let pat = p.field("pattern")?.text, !pat.isEmpty {
            params.append(Param(name: withoutMut(pat), kind: .pos))
          }
        }
        var sym = symbol(
          c, name, scope, cls, start: start, .def, sigEnd: body?.startIndex ?? c.endIndex, params: params)
        if sym.sig.hasSuffix(";") { sym.sig.removeLast() }
        cx.out.symbols.append(sym)
      case "impl_item", "trait_item":
        let ty = withoutGenerics(c.field(c.type == "impl_item" ? "type" : "name")?.text ?? "?")
        let body = c.field("body")
        if c.type == "trait_item" {
          cx.out.symbols.append(
            symbol(c, ty, scope, cls, start: start, .class, sigEnd: body?.startIndex ?? c.endIndex, params: []))
        }
        if let body { visit(body, scope + [ty], (scope + [ty]).joined(separator: "::")) }
      case "struct_item", "enum_item":
        let name = c.field("name")?.text ?? "?"
        cx.out.symbols.append(
          symbol(
            c, name, scope, cls, start: start, .class, sigEnd: c.field("body")?.startIndex ?? c.endIndex, params: []))
      case "mod_item":
        if let name = c.field("name")?.text, !name.isEmpty, let body = c.field("body") {
          visit(body, scope + [name], cls)
        }
      default: break
      }
    }
  }
  visit(root, [], nil)
}

/// `s.replace(/^mut\s+/, "")`
private func withoutMut(_ s: String) -> String {
  let u = s.units
  guard u.starts(with: "mut".utf16) else { return s }
  let rest = u.dropFirst(3)
  let spaces = rest.prefix(while: isJSSpace)
  return spaces.isEmpty ? s : string(rest.dropFirst(spaces.count))
}

func rustCall(_ cx: Context, _ n: Node, _ loop: Bool, _ inRhs: Bool) {
  var fn = n.field("function")
  if let f = fn, f.type == "generic_function" { fn = f.field("function") }
  guard let fn else { return }
  var nameNode: Node?
  var recv: String?
  switch fn.type {
  case "identifier": nameNode = fn
  case "field_expression":
    nameNode = fn.field("field")
    recv = fn.field("value")?.text
  case "scoped_identifier":
    nameNode = fn.field("name")
    recv = fn.field("path")?.text
  default: break
  }
  guard let nameNode else { return }
  var assigned: [String]?
  if inRhs, let p = n.parent, p.type == "let_declaration" {
    assigned = [p.field("pattern")?.text ?? ""].filter { !$0.isEmpty }
  }
  let name = nameNode.text
  let col = nameNode.startColumn
  let args = (n.field("arguments")?.namedChildren ?? []).filter { !$0.type.contains("comment") }.map {
    Arg(text: oneLine($0.text), name: $0.type == "identifier" ? $0.text : nil)
  }
  cx.out.calls.append(
    CallSite(
      line: nameNode.startRow + 1, col: col, end: col + name.jsLength, name: name, recv: recv, loop: loop, args: args,
      assigned: assigned?.isEmpty == false ? assigned : nil))
}
