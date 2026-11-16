import Foundation

// Entry points of a Python project: its console scripts and what its packages export. As
// packages/analysis/src/entry.ts.

/// A console script: `name = "module:func"`
public struct ProjectScript: Hashable, Codable, Sendable {
  public var name: String
  public var module: String
  public var `func`: String

  public init(name: String, module: String, func: String) {
    self.name = name
    self.module = module
    self.func = `func`
  }
}

private let scriptSectionRe = JSRegex(#"^\[(project\.scripts|tool\.poetry\.scripts)\]$"#)
private let scriptRe = JSRegex(#"^["']?([\w.-]+)["']?\s*=\s*["']([\w.]+):([\w.]+)["']"#)

/// pyproject.toml's [project.scripts]: name = "pkg.mod:func"
public func pyprojectScripts(_ toml: String) -> [ProjectScript] {
  var out: [ProjectScript] = []
  var inSection = false
  for raw in splitLines(toml) {
    let line = jsTrim(raw)
    if line.jsStartsWith("[") {
      inSection = scriptSectionRe.test(line)
      continue
    }
    if !inSection { continue }
    if let m = scriptRe.exec(line) { out.append(ProjectScript(name: m[1] ?? "", module: m[2] ?? "", func: m[3] ?? "")) }
  }
  return out
}

/// A name a package's __init__.py exports, and the module it imports it from
public struct InitExport: Hashable, Codable, Sendable {
  public var name: String
  public var from: String

  public init(name: String, from: String) {
    self.name = name
    self.from = from
  }
}

private let parenthesizedRe = JSRegex(#"\(\s*([^)]*)\)"#, "s")
private let spacesRe = JSRegex(#"\s+"#)
private let fromImportRe = JSRegex(#"^from\s+([\w.]+)\s+import\s+(.+)$"#)
private let commentRe = JSRegex("#.*$")
private let asRe = JSRegex(#"\s+as\s+"#)

/// The names a package's __init__.py exports: from .llm import LLM / from .x import (A, B as C)
public func initExports(_ text: String) -> [InitExport] {
  var out: [InitExport] = []
  let src = parenthesizedRe.replace(text, global: true) { m in spacesRe.replace(m[1] ?? "", global: true, with: " ") }
  for line in splitLines(src) {
    guard let m = fromImportRe.exec(jsTrim(line)) else { continue }
    for part in (m[2] ?? "").jsSplit(",") {
      let p = commentRe.replace(jsTrim(part), with: "")
      if p.isEmpty || p == "*" { continue }
      let pieces = asRe.split(p)
      let orig = pieces[0] ?? ""
      let alias = pieces.count > 1 ? pieces[1] : nil
      out.append(InitExport(name: jsTrim(alias ?? orig), from: m[1] ?? ""))
    }
  }
  return out
}

private let leadingDotsRe = JSRegex(#"^\.+"#)

/// A module path a.b.c → the relative file paths it may be
public func moduleFiles(_ mod: String, base: String = "") -> [String] {
  let p = (base.isEmpty ? "" : base + "/") + leadingDotsRe.replace(mod, with: "").jsSplit(".").joined(separator: "/")
  return ["\(p).py", "\(p)/__init__.py"]
}
