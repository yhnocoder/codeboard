// Python's symbols, calls, imports and docstrings, as packages/analysis/src/index.ts reads them

import TreeSitterCore

/// A body whose first statement is a string: its lines get the docstring flag, and its text is returned
func docstring(_ cx: Context, _ body: Node?) -> String? {
  var first = body?.firstNamedChild
  while let f = first, f.type == "comment" { first = f.nextNamedSibling }
  guard let first, first.type == "expression_statement", first.namedChildCount == 1,
    let s = first.firstNamedChild, s.type == "string"
  else { return nil }
  for r in first.startRow...first.endRow { cx.out.flags[r] |= LineFlag.docstring }
  let doc = cleanDoc(s.text)
  return doc.isEmpty ? nil : doc
}

func pyDef(_ cx: Context, _ def: Node, _ up: DefFrame?) -> DefFrame {
  // With decorators it starts at the first decorator's line
  let c = def.parent.flatMap { $0.type == "decorated_definition" ? $0 : nil } ?? def
  let cs = c.startIndex
  let e = def.endIndex
  // The definition around was not reached, or this one is not in its body (a tree with errors): not a symbol
  if let up, !(up.visited && up.bs <= cs && e <= up.be) {
    return DefFrame(e: e, visited: false, scope: [], qual: "", isClass: false, bs: 0, be: 0)
  }
  let scope = up?.scope ?? []
  let cls = up.flatMap { $0.isClass ? $0.qual : nil }
  let name = def.field("name")?.text ?? "?"
  let qual = (scope + [name]).joined(separator: ".")
  let body = def.field("body")
  let isClass = def.type == "class_definition"
  let frame = DefFrame(
    e: e, visited: true, scope: scope + [name], qual: qual, isClass: isClass, bs: body?.startIndex ?? 0,
    be: body?.endIndex ?? -1)
  guard cx.meets(c) else { return frame }
  let sig = withoutColon(oneLine(cx.text(def.startIndex, body?.startIndex ?? e)))
  var sym = Sym(
    name: name, qual: qual, kind: isClass ? .class : .def, start: c.startRow + 1, defLine: def.startRow + 1,
    end: c.endRow + 1, sig: sig,
    params: isClass ? [] : pyParams(def.field("parameters"), method: cls != nil), parent: cls)
  let at = cx.out.symbols.count
  cx.out.symbols.append(sym)
  if let doc = docstring(cx, body) {
    sym.doc = doc
    cx.out.symbols[at] = sym
  }
  return frame
}

/// `s.replace(/:\s*$/, "")`
private func withoutColon(_ s: String) -> String {
  let u = s.units
  let t = jsTrimEnd(u)
  guard let last = t.last, last == unit(":") else { return s }
  return string(t.dropLast())
}

func pyCall(_ cx: Context, _ n: Node, _ loop: Bool, _ inRhs: Bool) {
  guard var fn = n.field("function") else { return }
  var nameNode: Node?
  var recv: String?
  // Triton's kernel[grid](…): the call is to kernel, launched with [grid]
  var launch: CallSite.Launch?
  if fn.type == "subscript", let v = fn.field("value"), v.type == "identifier" || v.type == "attribute" {
    fn = v
    launch = .grid
  }
  if fn.type == "identifier" {
    nameNode = fn
  } else if fn.type == "attribute" {
    nameNode = fn.field("attribute")
    recv = fn.field("object")?.text
  }
  guard let nameNode else { return }
  let name = nameNode.text
  if pySkip.contains(name) && (recv ?? "").isEmpty { return }
  let al = n.field("arguments")
  let col = nameNode.startColumn
  var site = CallSite(
    line: nameNode.startRow + 1, col: col, end: col + name.jsLength, name: name, recv: recv, loop: loop,
    args: pyArgs(al), assigned: inRhs ? assignedTo(n, .python) : nil, launch: launch)
  // call("run", …): the string is kept, nothing guessed
  if ["call", "dispatch", "invoke", "run_method"].contains(name), let first = al?.firstNamedChild,
    first.type == "string"
  {
    site.dispatch = unquoted(first.text.units)
  }
  cx.out.calls.append(site)
}

/// `s.replace(/^[rbuf]*["']+|["']+$/g, "")`
private func unquoted(_ s: Units) -> String {
  var body = s
  let letters = body.prefix { "rbuf".utf16.contains($0) }
  let quotes = body.dropFirst(letters.count).prefix(while: isQuote)
  if !quotes.isEmpty { body = body.dropFirst(letters.count + quotes.count) }
  var e = body.endIndex
  while e > body.startIndex && isQuote(body[e - 1]) { e -= 1 }
  return string(body[body.startIndex..<e])
}

/// A string literal's text as a docstring, as Python's inspect.cleandoc gives it
public func cleanDoc(_ lit: String) -> String {
  let trimmed = jsTrim(lit.units)
  let content = quotedContent(trimmed) ?? lit.units
  var detabbed: [UInt16] = []
  for u in content {
    if u == unit("\t") { detabbed += Array("    ".utf16) } else { detabbed.append(u) }
  }
  let lines = detabbed[...].lines()
  let indents = lines.dropFirst().filter { !$0.isBlank }.map { $0.count - jsTrimStart($0).count }
  let ind = indents.min()
  var out = [jsTrim(lines[0])] + lines.dropFirst().map { l in jsTrimEnd(ind.map { jsSlice(l, $0) } ?? l) }
  while let f = out.first, f.isEmpty { out.removeFirst() }
  while let l = out.last, l.isEmpty { out.removeLast() }
  return out.map(string).joined(separator: "\n")
}

/// The content of `/^[rRbBuUfF]*("""|'''|"|')([\s\S]*?)\1$/`, or nil when the text is not one literal
private func quotedContent(_ s: Units) -> Units? {
  let letters = s.prefix { "rRbBuUfF".utf16.contains($0) }
  let rest = s.dropFirst(letters.count)
  for q in ["\"\"\"", "'''", "\"", "'"] {
    let quote = Array(q.utf16)
    guard rest.count >= 2 * quote.count, rest.prefix(quote.count).elementsEqual(quote),
      rest.suffix(quote.count).elementsEqual(quote)
    else { continue }
    return rest.dropFirst(quote.count).dropLast(quote.count)
  }
  return nil
}

func pyImport(_ n: Node, _ out: inout FileAnalysis) {
  let line = n.startRow + 1
  if n.type == "import_statement" {
    for c in n.namedChildren {
      if c.type == "dotted_name" {
        let top = c.text.jsSplit(".")[0]
        out.imports.append(ImportedName(name: top, module: top, line: line))
      } else if c.type == "aliased_import" {
        out.imports.append(
          ImportedName(name: c.field("alias")?.text ?? "", module: c.field("name")?.text ?? "", line: line))
      }
    }
  } else {
    let mod = n.field("module_name")?.text ?? ""
    for c in n.fields("name") {
      if c.type == "dotted_name" {
        out.imports.append(ImportedName(name: c.text, module: mod, line: line, from: true))
      } else if c.type == "aliased_import" {
        out.imports.append(ImportedName(name: c.field("alias")?.text ?? "", module: mod, line: line, from: true))
      }
    }
  }
}

/// The top-level package a called name is bound to: the import of the first name of its receiver (or of the name
/// itself). Relative imports, local definitions and `self.x` give nil (the current file's own package).
public func importPkg(_ imports: [ImportedName], name: String, recv: String? = nil) -> String? {
  let s = Array((recv ?? name).utf16)
  func isWord(_ u: UInt16) -> Bool {
    (u >= 0x30 && u <= 0x39) || (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || u == 0x5F
  }
  guard let first = s.first, isWord(first), !(first >= 0x30 && first <= 0x39) else { return nil }
  let root = String(decoding: s.prefix(while: isWord), as: UTF16.self)
  guard let im = imports.first(where: { $0.name == root }), !im.module.isEmpty, !im.module.hasPrefix(".") else {
    return nil
  }
  return im.module.jsSplit(".")[0]
}

// Built-in functions are not calls to expand
private let pySkip = Set(
  ("print len range zip min max sum sorted list dict set tuple int float str bool type getattr setattr hasattr"
    + " isinstance issubclass enumerate super iter next map filter any all abs round repr id hash open vars dir"
    + " callable reversed object divmod pow format chr ord").jsSplit(" "))

private func pyParams(_ ps: Node?, method: Bool) -> [Param] {
  var out: [Param] = []
  var kwOnly = false
  for p in ps?.namedChildren ?? [] {
    var name = ""
    var kind: Param.Kind = kwOnly ? .kw : .pos
    switch p.type {
    case "identifier": name = p.text
    case "typed_parameter":
      let kids = p.namedChildren
      name = kids.first { $0.type == "identifier" }?.text ?? ""
      if kids.first?.type == "list_splat_pattern" {
        name = kids[0].firstNamedChild?.text ?? ""
        kind = .star
        kwOnly = true
      } else if kids.first?.type == "dictionary_splat_pattern" {
        name = kids[0].firstNamedChild?.text ?? ""
        kind = .dstar
      }
    case "default_parameter", "typed_default_parameter": name = p.field("name")?.text ?? ""
    case "list_splat_pattern":
      name = p.firstNamedChild?.text ?? ""
      kind = .star
      kwOnly = true
    case "dictionary_splat_pattern":
      name = p.firstNamedChild?.text ?? ""
      kind = .dstar
    case "keyword_separator":
      kwOnly = true
      continue
    default: continue
    }
    if name.isEmpty { continue }
    if method && out.isEmpty && (name == "self" || name == "cls") { kind = .self }
    out.append(Param(name: name, kind: kind))
  }
  return out
}

private func pyArgs(_ al: Node?) -> [Arg] {
  var out: [Arg] = []
  for a in al?.namedChildren ?? [] where a.type != "comment" {
    if a.type == "keyword_argument" {
      let v = a.field("value")
      out.append(
        Arg(
          text: oneLine(v?.text ?? ""), name: v.flatMap { $0.type == "identifier" ? $0.text : nil },
          kw: a.field("name")?.text))
    } else if a.type == "list_splat" || a.type == "dictionary_splat" {
      out.append(Arg(text: a.text, star: true))
    } else {
      out.append(Arg(text: oneLine(a.text), name: a.type == "identifier" ? a.text : nil))
    }
  }
  return out
}
