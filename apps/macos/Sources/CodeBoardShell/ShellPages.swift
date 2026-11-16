import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import Foundation
import Shiyi
import os

// by name: another module has an Item and a Kind too, and `Shiyi.` is the package's class
import struct Shiyi.Item
import enum Shiyi.Kind

/// The saving service the app carries (Contents/Resources/shiyi, tools/shiyi/fetch.mjs) over its Swift package: a
/// service of this Mac's, started when none runs, keeping pages in its data folder, `home`
struct ShiyiStore: PageStore {
  let home: URL?
  private let client: Shiyi

  /// `home` nil: the service's own folder, the one its browser extension saves into
  init(home: URL?, binary: URL) throws {
    self.home = home
    client = try Shiyi(home: home, binary: binary)
  }

  func saveLink(_ meta: PageLink) async throws -> SavedItem {
    try await said { try SavedItem(await client.saveLink(LinkMeta(url: meta.url, title: meta.title))) }
  }

  func savePage(_ meta: PageCapture, file: URL) async throws -> SavedItem {
    try await said { try SavedItem(await client.savePage(PageMeta(url: meta.url, title: meta.title), page: file)) }
  }

  func items(kind: SavedItem.Kind?, after: String?, limit: Int) async throws -> SavedItems {
    try await said {
      let list = try await client.items(kind: kind.map { $0 == .link ? Kind.link : .page }, limit: limit, cursor: after)
      return SavedItems(items: try list.items.map(SavedItem.init), next: list.nextCursor)
    }
  }

  func writePage(hash: String, to: URL) async throws -> Int64 {
    try await said { try await client.writePage(hash: hash, to: to) }
  }

  func pin(id: String, pinned: Bool) async throws {
    _ = try await said { try await client.pin(id: id, pinned: pinned) }
  }

  /// Each file as the service gives it, `{domain, origin, rules}`: what its scripts' rules library reads
  func rules(forHost host: String) async throws -> [Data] {
    try await said { try await client.rules(forHost: host).map { try JSONEncoder().encode($0) } }
  }

  /// The service's errors as the save button says them, after "could not be saved: "
  struct Failure: LocalizedError {
    var error: ShiyiError

    var errorDescription: String? {
      switch error.code {
      case "service": "the saving service is not running and could not be started"
      case "too-large": "it is larger than the saving service keeps"
      case "not-found": "the saving service does not have it"
      default: error.message.isEmpty ? "the saving service said \(error.code)" : error.message
      }
    }
  }

  private func said<T>(_ call: () async throws -> T) async throws -> T {
    do { return try await call() } catch let e as ShiyiError { throw Failure(error: e) }
  }
}

extension SavedItem {
  init(_ item: Item) throws {
    let at = try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(item.savedAt)
    self.init(
      id: item.id, kind: item.kind == .link ? .link : .page, url: item.url, title: item.title ?? item.url,
      savedAt: Int64((at.timeIntervalSince1970 * 1000).rounded()), pageHash: item.pageHash, bytes: item.pageBytes)
  }
}

extension Shell {
  /// The app's own identity: the one run whose service is the person's, shared with the browser extension
  static let appID = "com.yhnocoder.codeboard"

  /// The service at `binary` for an app of identity `id`: the app's uses the service's own folder; any other (a
  /// try-out build, the acceptance app, a test) one in its folder on this Mac, `machine`, so that it never reads,
  /// writes or starts the person's. None without a binary, or for another identity without a folder
  static func pageStore(binary: URL?, id: String?, machine: URL?) -> ShiyiStore? {
    guard let binary else { return nil }
    if id == appID { return try? ShiyiStore(home: nil, binary: binary) }
    // short: the service's socket is in it, and a socket's path has room for about 100 bytes
    guard let machine else { return nil }
    return try? ShiyiStore(home: machine.appending(path: "Shiyi", directoryHint: .isDirectory), binary: binary)
  }

  /// What was saved elsewhere since this Mac last looked (the browser extension's pages), into the vault's web
  /// resource, off the main thread; quietly: a failure is logged and tried again next time. One at a time, since two
  /// would both make the entry of a new address
  func importPages() {
    guard !pagesImporting, let store = Self.webSaving, let vault, let machine = machineFolder else { return }
    pagesImporting = true
    let watermark = machine.appending(path: "Web/page-watermark.json")
    Task {
      defer { pagesImporting = false }
      await Self.importPages(from: store, into: vault, watermark: watermark)
    }
  }

  @concurrent static func importPages(from store: any PageStore, into vault: Vault, watermark: URL) async {
    do {
      // a vault gets its web resource only once there is something to put in it
      guard try await !store.items(kind: nil, after: nil, limit: 1).items.isEmpty else { return }
      try await PageImport.run(
        from: store, into: vault, resource: WebReading.webResource(in: vault), watermark: watermark)
    } catch {
      Logger(subsystem: "CodeBoard", category: "pages").error(
        "saved pages not imported: \(error.localizedDescription, privacy: .public)")
    }
  }
}

@MainActor private var pagesImporting = false
