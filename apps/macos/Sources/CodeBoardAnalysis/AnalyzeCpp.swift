// C's, C++'s and CUDA's symbols and calls, as packages/analysis/src/index.ts reads them

private let cppSkip: Set<String> = [
  "sizeof", "static_cast", "reinterpret_cast", "const_cast", "dynamic_cast", "printf", "assert",
]

private func containsAny(_ s: String, _ parts: [String]) -> Bool { parts.contains { s.contains($0) } }

func cppSymbols(_ cx: Context, _ root: Node) {
  func visit(_ n: Node, _ scope: [String], _ cls: String?) {
    for c in n.namedChildren {
      var def = c
      let start = c.startRow
      while def.type == "template_declaration" {
        let inner =
          def.namedChildren.first {
            containsAny(
              $0.type, ["function_definition", "class_specifier", "struct_specifier", "template_declaration"])
          } ?? def.lastNamedChild
        // A half-written template with nothing in it defines nothing
        guard let inner else { break }
        def = inner
      }
      if def.type == "friend_declaration" { def = def.namedChildren.first { $0.type == "function_definition" } ?? def }
      if def.type == "field_declaration", let t = def.field("type"),
        containsAny(t.type, ["class_specifier", "struct_specifier"])
      {
        def = t
      }
      if def.type == "function_definition" {
        let decl = funcDeclarator(def.field("declarator"))
        var nameNode = decl?.field("declarator")
        // TORCH_IMPL_FUNC(name) (params): a macro around the name
        if let nn = nameNode, nn.type == "function_declarator", let ps = nn.field("parameters"),
          ps.namedChildCount == 1, let p0 = ps.firstNamedChild
        {
          nameNode = p0.firstNamedChild ?? p0
        }
        let full = nameNode?.text ?? "?"
        let name = full.jsSplit("::").last ?? full
        let body = def.field("body")
        cx.out.symbols.append(
          Sym(
            name: name, qual: (scope + [full]).joined(separator: "::"), kind: .def, start: start + 1,
            defLine: def.startRow + 1, end: c.endRow + 1,
            sig: oneLine(cx.text(def.startIndex, body?.startIndex ?? def.endIndex)),
            params: cppParams(decl?.field("parameters")), parent: cls))
        continue
      }
      if def.type == "class_specifier" || def.type == "struct_specifier", let body = def.field("body") {
        let nn = def.field("name")
        let name = (nn?.type == "template_type" ? nn?.field("name")?.text : nn?.text) ?? "?"
        let qual = (scope + [name]).joined(separator: "::")
        cx.out.symbols.append(
          Sym(
            name: name, qual: qual, kind: .class, start: start + 1, defLine: def.startRow + 1, end: c.endRow + 1,
            sig: oneLine(cx.text(def.startIndex, body.startIndex)), params: [], parent: cls))
        visit(body, scope + [name], qual)
        continue
      }
      if c.type == "namespace_definition" {
        let name = c.field("name")?.text ?? ""
        if let body = c.field("body") { visit(body, name.isEmpty ? scope : scope + [name], cls) }
        continue
      }
      if c.namedChildCount > 0,
        c.type == "ERROR"
          || containsAny(c.type, ["declaration_list", "field_declaration_list", "linkage_specification", "preproc_"])
      {
        visit(c, scope, cls)
      }
    }
  }
  visit(root, [], nil)
}

func cppCall(_ cx: Context, _ n: Node, _ loop: Bool, _ inRhs: Bool) {
  guard let fn = n.field("function") else { return }
  var nameNode: Node?
  var recv: String?
  switch fn.type {
  case "identifier": nameNode = fn
  case "field_expression":
    nameNode = untemplated(fn.field("field"))
    recv = fn.field("argument")?.text
  case "qualified_identifier": (nameNode, recv) = qualified(fn)
  case "template_function": nameNode = untemplated(fn)
  default: break
  }
  guard let nameNode, !cppSkip.contains(nameNode.text) else { return }
  let name = nameNode.text
  let col = nameNode.startColumn
  let args = (n.field("arguments")?.namedChildren ?? []).filter { $0.type != "comment" }.map {
    Arg(text: oneLine($0.text), name: $0.type == "identifier" ? $0.text : nil)
  }
  cx.out.calls.append(
    CallSite(
      line: nameNode.startRow + 1, col: col, end: col + name.jsLength, name: name, recv: recv, loop: loop, args: args,
      assigned: inRhs ? assignedTo(n, .cpp) : nil,
      // CUDA's kernel<<<grid, block>>>(…): a call_expression with a kernel_call_syntax
      launch: n.namedChildren.contains { $0.type == "kernel_call_syntax" } ? .chevrons : nil))
}

/// a::b<T>::f<U> gives the name f (without template arguments) and the receiver a::b<T>: joined scope by scope, not
/// cut from the text (template arguments may hold :: too)
private func qualified(_ q: Node) -> (Node?, String) {
  var scope: [String] = []
  var n: Node? = q
  while let x = n, x.type == "qualified_identifier" {
    if let s = x.field("scope") { scope.append(s.text) }
    n = x.field("name")
  }
  return (untemplated(n), scope.joined(separator: "::"))
}

/// The name of f<T>, o.f<T> and o.template f<T> is f
private func untemplated(_ node: Node?) -> Node? {
  var n = node
  if let x = n, x.type == "dependent_name" { n = x.firstNamedChild }
  guard let x = n else { return nil }
  return x.type == "template_function" || x.type == "template_method" ? x.field("name") : x
}

private func funcDeclarator(_ node: Node?) -> Node? {
  var d = node
  while let x = d, x.type != "function_declarator" {
    d = x.field("declarator") ?? x.namedChildren.first { $0.type.hasSuffix("declarator") }
  }
  return d
}

private func cppParams(_ ps: Node?) -> [Param] {
  var out: [Param] = []
  for p in ps?.namedChildren ?? [] where p.type.contains("parameter_declaration") {
    var d = p.field("declarator")
    while let x = d, x.type != "identifier" {
      d = x.field("declarator") ?? x.namedChildren.first { $0.type == "identifier" }
    }
    if let d { out.append(Param(name: d.text, kind: .pos)) }
  }
  return out
}
