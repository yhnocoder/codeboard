import Foundation

// The shapes of an analysis result (symbols, calls, a whole file) and lookups on them, as packages/analysis/src/syms.ts
// has them. Lines are 1-based; columns are 0-based UTF-16 code units, as the board files store them.

public struct Param: Hashable, Codable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case `self`, pos, kw, star, dstar
  }

  public var name: String
  public var kind: Kind

  public init(name: String, kind: Kind) {
    self.name = name
    self.kind = kind
  }
}

public struct Sym: Hashable, Codable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case def, `class`
  }

  public var name: String
  /// `Scheduler.schedule`; in C++ `ns::Cls::f`
  public var qual: String
  public var kind: Kind
  /// First line, decorators or `template` included
  public var start: Int
  /// The line of `def` / `class`
  public var defLine: Int
  /// Last line, inclusive
  public var end: Int
  /// The signature on one line
  public var sig: String
  public var params: [Param]
  /// The `qual` of the class it is in
  public var parent: String?
  /// The docstring, without its quotes and common indentation
  public var doc: String?

  public init(
    name: String, qual: String, kind: Kind, start: Int, defLine: Int, end: Int, sig: String, params: [Param],
    parent: String? = nil, doc: String? = nil
  ) {
    self.name = name
    self.qual = qual
    self.kind = kind
    self.start = start
    self.defLine = defLine
    self.end = end
    self.sig = sig
    self.params = params
    self.parent = parent
    self.doc = doc
  }
}

public struct Arg: Hashable, Codable, Sendable {
  public var text: String
  public var name: String?
  public var kw: String?
  public var star: Bool?

  public init(text: String, name: String? = nil, kw: String? = nil, star: Bool? = nil) {
    self.text = text
    self.name = name
    self.kw = kw
    self.star = star
  }
}

public struct CallSite: Hashable, Codable, Sendable {
  /// A kernel launch: Triton's `kernel[grid](…)` or CUDA's `kernel<<<…>>>(…)`
  public enum Launch: String, Codable, Sendable {
    case grid
    case chevrons = "<<<"
  }

  public var line: Int
  /// Where the called name starts
  public var col: Int
  public var end: Int
  public var name: String
  /// `self.scheduler` of `self.scheduler.schedule()`
  public var recv: String?
  /// Inside a `for`, `while` or comprehension of the same function
  public var loop: Bool
  public var args: [Arg]
  /// What takes the return value: `seqs, is_prefill = …`
  public var assigned: [String]?
  /// `call("run", …)` forwards by string: the string is kept, and `run` is not counted as called
  public var dispatch: String?
  public var launch: Launch?

  public init(
    line: Int, col: Int, end: Int, name: String, recv: String? = nil, loop: Bool, args: [Arg],
    assigned: [String]? = nil, dispatch: String? = nil, launch: Launch? = nil
  ) {
    self.line = line
    self.col = col
    self.end = end
    self.name = name
    self.recv = recv
    self.loop = loop
    self.args = args
    self.assigned = assigned
    self.dispatch = dispatch
    self.launch = launch
  }
}

public struct LineSpan: Hashable, Codable, Sendable {
  public var start: Int
  public var end: Int

  public init(start: Int, end: Int) {
    self.start = start
    self.end = end
  }
}

/// A name an import binds: `import torch.multiprocessing as mp` gives `mp` and `torch.multiprocessing`; a relative
/// import's module starts with a dot. `from` marks `from X import name`, where the name need not be a module.
public struct ImportedName: Hashable, Codable, Sendable {
  public var name: String
  public var module: String
  public var line: Int
  public var from: Bool?

  public init(name: String, module: String, line: Int, from: Bool? = nil) {
    self.name = name
    self.module = module
    self.line = line
    self.from = from
  }
}

public struct FileAnalysis: Hashable, Codable, Sendable {
  public var lang: String
  public var symbols: [Sym]
  /// Each line's `LineFlag`s (index = line - 1)
  public var flags: [Int]
  /// Comments at the end of a line: line → the column the comment starts at
  public var trailing: [Int: Int]
  public var calls: [CallSite]
  /// Python's `if __name__ == "__main__":` blocks
  public var mainBlocks: [LineSpan]
  /// The module docstring
  public var doc: String?
  public var imports: [ImportedName]

  public init(
    lang: String, symbols: [Sym] = [], flags: [Int] = [], trailing: [Int: Int] = [:], calls: [CallSite] = [],
    mainBlocks: [LineSpan] = [], doc: String? = nil, imports: [ImportedName] = []
  ) {
    self.lang = lang
    self.symbols = symbols
    self.flags = flags
    self.trailing = trailing
    self.calls = calls
    self.mainBlocks = mainBlocks
    self.doc = doc
    self.imports = imports
  }
}

/// The innermost symbol that holds a line
public func symbolAt(_ syms: [Sym], line: Int, kind: Sym.Kind? = nil) -> Sym? {
  // JavaScript's sort is stable, so among symbols of one length the first in the list wins; `min` keeps that too
  syms.filter { $0.start <= line && line <= $0.end && (kind == nil || $0.kind == kind) }
    .min { $0.end - $0.start < $1.end - $1.start }
}
