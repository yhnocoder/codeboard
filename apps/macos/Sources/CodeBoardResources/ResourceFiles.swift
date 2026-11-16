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
  /// file alone; its path
  @discardableResult
  public func newEntry(_ entry: Entry, in resource: String) throws -> String {
    let path = Vault.join(resource, freeName(in: resource, Vault.folderName(for: entry.title), extension: nil))
    try writePackage(entry.encoded(), named: Vault.entryFileName, at: path)
    return path
  }

  /// A file that is an entry alone given a folder of its own, named as the file without its extension, with `entry`
  /// written in it: the folder is built under a hidden name, the file goes into it in one rename, and the folder is
  /// renamed into place. The folder's path
  @discardableResult
  public func promote(file path: String, to entry: Entry) throws -> String {
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
    let inside = hidden.appending(path: from.lastPathComponent)
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

  private func readFile(_ file: URL) throws -> Data {
    do {
      return try Data(contentsOf: file)
    } catch {
      throw VaultError.unreadable(file, error.localizedDescription)
    }
  }
}
