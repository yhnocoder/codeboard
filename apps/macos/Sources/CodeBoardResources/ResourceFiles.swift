import CodeBoardModel
import Foundation

// A resource package's files: its resource file, its entries (folders with an entry file, and files that are entries
// alone) read and written. New things are made as VaultFiles.swift makes them: built under a hidden name, then one
// rename into place, never over anything. Nothing here is cached or watched.

/// What is in a resource package, in Finder's order
public enum ResourceItem: Equatable, Sendable {
  /// A folder with its entry file; `path` the folder's, relative to the vault
  case entry(Entry, path: String)
  /// A file that is an entry alone (no id, no metadata): its name is its title
  case file(path: String)
  /// A folder whose entry file cannot be read, and why
  case unreadable(path: String, reason: String)
}

extension Vault {
  /// A new resource package `<title>.resource` in `folder`, with no entries
  @discardableResult
  public func newResource(in folder: String, title: String, preset: ResourcePreset) throws -> VaultResource {
    let name = Vault.packageName(for: title)
    let r = Resource(id: ResourceID(rawValue: Board.newID("r")), preset: preset)
    let path = Vault.join(folder, "\(name).\(Vault.resourceExtension)")
    try writePackage(r.encoded(), named: Vault.resourceFileName, at: path)
    return VaultResource(id: r.id, title: name, path: path, preset: preset, entryCount: 0)
  }

  /// The resource file of the package at `path`
  public func resource(at path: String) throws -> Resource {
    let file = url(of: path).appending(path: Vault.resourceFileName)
    return try Resource(decoding: readFile(file), file: file)
  }

  /// Everything in the package at `path` that is an entry; names starting with `.`, and folders without an entry file,
  /// are not
  public func items(in path: String) throws -> [ResourceItem] {
    let dir = url(of: path)
    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
    } catch {
      throw VaultError.unreadable(dir, error.localizedDescription)
    }
    var out: [ResourceItem] = []
    for name in names.sorted(by: { $0.localizedStandardCompare($1) == .orderedAscending })
    where !name.hasPrefix(".") && name != Vault.resourceFileName {
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: dir.appending(path: name).path, isDirectory: &isDir) else {
        continue
      }
      let child = Vault.join(path, name)
      guard isDir.boolValue else {
        out.append(.file(path: child))
        continue
      }
      let file = dir.appending(path: name).appending(path: Vault.entryFileName)
      guard FileManager.default.fileExists(atPath: file.path) else { continue }
      do {
        out.append(.entry(try Entry(decoding: readFile(file), file: file), path: child))
      } catch {
        out.append(.unreadable(path: child, reason: "\(error)"))
      }
    }
    return out
  }

  /// The entry in the folder at `path`
  public func entry(at path: String) throws -> Entry {
    let file = url(of: path).appending(path: Vault.entryFileName)
    return try Entry(decoding: readFile(file), file: file)
  }

  /// The entry written to its folder at `path`, all at once
  public func write(_ entry: Entry, at path: String) throws {
    let file = url(of: path).appending(path: Vault.entryFileName)
    do {
      try entry.encoded().write(to: file, options: .atomic)
    } catch {
      throw VaultError.unwritable(file, error.localizedDescription)
    }
  }

  /// A new entry folder in the resource at `resource`, named for its title (` 2`, ` 3`… when taken), with its entry
  /// file and `files` (by name) in it, made whole under a hidden name and renamed into place; its path
  @discardableResult
  public func newEntry(_ entry: Entry, in resource: String, with files: [String: Data] = [:]) throws -> String {
    let path = Vault.join(resource, freeName(in: resource, Vault.folderName(for: entry.title), extension: nil))
    guard !files.isEmpty else {
      try writePackage(entry.encoded(), named: Vault.entryFileName, at: path)
      return path
    }
    // the files laid out beside it first; the package is a copy of them (a clone on APFS)
    let staged = url(of: resource).appending(path: ".files-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: staged) }
    do {
      try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: false)
      for (name, data) in files { try data.write(to: staged.appending(path: name)) }
    } catch {
      throw VaultError.unwritable(url(of: path), error.localizedDescription)
    }
    try writePackage(entry.encoded(), named: Vault.entryFileName, at: path, copying: staged)
    return path
  }

  /// `data` put in the entry folder at `path` as `name`, or as `<name>-2.<ext>`, `-3`… when that is taken, so it stays
  /// a plain file name: written under a hidden name, then one rename, never over anything. The name it got
  public func addEntryFile(_ data: Data, named name: String, to path: String) throws -> String {
    let folder = url(of: path)
    let hidden = folder.appending(path: ".\(name).new-\(UUID().uuidString)")
    do { try data.write(to: hidden) } catch { throw VaultError.unwritable(folder, error.localizedDescription) }
    defer { try? FileManager.default.removeItem(at: hidden) }
    let ext = (name as NSString).pathExtension
    let base = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
    for n in 1...999 {
      let free = n == 1 ? name : ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)"
      do {
        try Vault.rename(hidden, to: folder.appending(path: free))
        return free
      } catch VaultError.exists {
        continue
      }
    }
    throw VaultError.exists(folder.appending(path: name))
  }

  /// A file that is an entry alone given a folder of its own, named as the file without its extension, with `entry`
  /// written in it: the folder is built under a hidden name, the file goes into it in one rename (as `name`, the name
  /// its versions give it, when its own is not a plain file name), and the folder is renamed into place. The folder's
  /// path
  @discardableResult
  public func promote(file path: String, to entry: Entry, as name: String? = nil) throws -> String {
    let from = url(of: path)
    let resource = path.split(separator: "/").dropLast().joined(separator: "/")
    let hidden = url(of: resource).appending(path: ".\(from.lastPathComponent).entry-\(UUID().uuidString)")
    do {
      try FileManager.default.createDirectory(at: hidden, withIntermediateDirectories: false)
      try entry.encoded().write(to: hidden.appending(path: Vault.entryFileName))
    } catch {
      try? FileManager.default.removeItem(at: hidden)
      throw VaultError.unwritable(from, error.localizedDescription)
    }
    let inside = hidden.appending(path: name ?? from.lastPathComponent)
    do { try Vault.rename(from, to: inside) } catch {
      try? FileManager.default.removeItem(at: hidden)
      throw error
    }
    // the file has left its name, so the folder may take it
    let name = Vault.folderName(for: from.deletingPathExtension().lastPathComponent)
    let to = Vault.join(resource, freeName(in: resource, name, extension: nil))
    do { try Vault.rename(hidden, to: url(of: to)) } catch {
      try? Vault.rename(inside, to: from)
      try? FileManager.default.removeItem(at: hidden)
      throw error
    }
    return to
  }

  /// A copy of the file at `source` put in the resource at `resource` as an entry alone, under its own name (` 2`, ` 3`…
  /// before the extension when taken): copied under a hidden name, then one rename, never over anything. Its path
  @discardableResult
  public func addFile(_ source: URL, to resource: String) throws -> String {
    let ext = source.pathExtension
    let base = freeName(
      in: resource, source.deletingPathExtension().lastPathComponent, extension: ext.isEmpty ? nil : ext)
    let path = Vault.join(resource, ext.isEmpty ? base : "\(base).\(ext)")
    let hidden = url(of: resource).appending(path: ".\(base).new-\(UUID().uuidString)")
    do {
      try FileManager.default.copyItem(at: source, to: hidden)
    } catch {
      throw VaultError.unwritable(url(of: path), error.localizedDescription)
    }
    do { try Vault.rename(hidden, to: url(of: path)) } catch {
      try? FileManager.default.removeItem(at: hidden)
      throw error
    }
    return path
  }

  /// A name a version may give its file (FORMAT.md: a plain file name): `name` when it is one, else `file` with its
  /// extension
  public static func plainFileName(_ name: String) -> String {
    if isFileName(name) { return name }
    let ext = (name as NSString).pathExtension
    return isFileName("file.\(ext)") && !ext.isEmpty ? "file.\(ext)" : "file"
  }

  private func readFile(_ file: URL) throws -> Data {
    do {
      return try Data(contentsOf: file)
    } catch {
      throw VaultError.unreadable(file, error.localizedDescription)
    }
  }
}
