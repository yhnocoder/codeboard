import Compression
import CoreGraphics
import Foundation
import IOSurface
import Synchronization

/// Note snapshots on disk, one file per key, the least recently used removed first once the folder holds more than
/// `limit` bytes. A file is raw BGRA compressed with LZFSE (lossless; 1–3 ms to read, PNG is ten times slower), after a
/// header with its pixel size and the Note's size at 100 %; a measured size alone is the header with no pixels. Reads
/// and writes run on the caller's thread and may overlap.
final class SnapshotStore: Sendable {
  let folder: URL
  private let index: Mutex<CacheIndex?>
  private let limit: Int

  init(folder: URL, limit: Int) {
    self.folder = folder
    self.limit = limit
    index = Mutex(nil)
  }

  func read(_ key: SnapshotKey) -> NoteSnapshot? {
    let url = file(key)
    guard let data = try? Data(contentsOf: url) else { return nil }
    guard let snap = Self.decode(data) else {
      try? FileManager.default.removeItem(at: url)
      return nil
    }
    let now = Date()
    try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: url.path(percentEncoded: false))
    withIndex { $0.touch(key.hex, at: now) }
    return snap
  }

  func write(_ snap: NoteSnapshot, as key: SnapshotKey) throws {
    guard let data = Self.encode(snap) else { return }
    try put(data, as: key)
  }

  func readSize(_ key: SnapshotKey) -> CGSize? {
    let url = file(key)
    guard let data = try? Data(contentsOf: url), let size = Self.size(data) else { return nil }
    let now = Date()
    try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: url.path(percentEncoded: false))
    withIndex { $0.touch(key.hex, at: now) }
    return size
  }

  func writeSize(_ size: CGSize, as key: SnapshotKey) throws {
    try put(Self.header(width: 0, height: 0, size: size), as: key)
  }

  private func put(_ data: Data, as key: SnapshotKey) throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try data.write(to: file(key), options: .atomic)
    let gone = withIndex { $0.insert(key.hex, size: data.count, at: Date()) }
    for name in gone { try? FileManager.default.removeItem(at: folder.appending(path: name)) }
  }

  private func file(_ key: SnapshotKey) -> URL { folder.appending(path: key.hex) }

  /// The index is read from the folder on first use: file sizes, and modification dates as the last use
  private func withIndex<T>(_ body: (inout CacheIndex) -> T) -> T {
    index.withLock { slot in
      var idx = slot ?? CacheIndex(limit: limit, files: listFiles())
      defer { slot = idx }
      return body(&idx)
    }
  }

  private func listFiles() -> [(name: String, size: Int, used: Date)] {
    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
    let urls =
      (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(keys))) ?? []
    return urls.compactMap { u in
      guard let v = try? u.resourceValues(forKeys: keys), let size = v.fileSize else { return nil }
      return (u.lastPathComponent, size, v.contentModificationDate ?? .distantPast)
    }
  }

  // MARK: the file format

  private static let magic: UInt32 = 0x314E_4243  // "CBN1"
  private static let headerSize = 28

  static func encode(_ snap: NoteSnapshot) -> Data? {
    let s = snap.surface
    let w = s.width
    let h = s.height
    let row = w * 4
    var raw = [UInt8](repeating: 0, count: row * h)
    s.lock(options: .readOnly, seed: nil)
    raw.withUnsafeMutableBytes { dst in
      guard let base = dst.baseAddress else { return }
      for y in 0..<h { (base + y * row).copyMemory(from: s.baseAddress + y * s.bytesPerRow, byteCount: row) }
    }
    s.unlock(options: .readOnly, seed: nil)
    var out = header(width: w, height: h, size: snap.size)
    // LZFSE of raw pixels never grows past the input by more than its block headers
    var packed = [UInt8](repeating: 0, count: raw.count + 4096)
    let n = compression_encode_buffer(&packed, packed.count, raw, raw.count, nil, COMPRESSION_LZFSE)
    guard n > 0 else { return nil }
    out.append(contentsOf: packed[..<n])
    return out
  }

  private static func header(width w: Int, height h: Int, size: CGSize) -> Data {
    var out = Data(capacity: headerSize + w * h)
    for v in [magic, UInt32(w), UInt32(h)] { withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) } }
    for v in [size.width, size.height] {
      withUnsafeBytes(of: Double(v).bitPattern.littleEndian) { out.append(contentsOf: $0) }
    }
    return out
  }

  /// The Note's size at 100 % from a file's header (a snapshot's or a measured size's)
  static func size(_ data: Data) -> CGSize? {
    guard data.count >= headerSize, u32(data, 0) == magic else { return nil }
    return CGSize(width: f64(data, 12), height: f64(data, 20))
  }

  private static func u32(_ data: Data, _ at: Int) -> UInt32 {
    data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: at, as: UInt32.self)) }
  }

  private static func f64(_ data: Data, _ at: Int) -> Double {
    data.withUnsafeBytes {
      Double(bitPattern: UInt64(littleEndian: $0.loadUnaligned(fromByteOffset: at, as: UInt64.self)))
    }
  }

  static func decode(_ data: Data) -> NoteSnapshot? {
    guard data.count > headerSize, let size = size(data) else { return nil }
    let w = Int(u32(data, 4))
    let h = Int(u32(data, 8))
    guard w > 0, h > 0, let s = NoteSnapshot.makeSurface(width: w, height: h) else { return nil }
    let row = w * 4
    var raw = [UInt8](repeating: 0, count: row * h)
    let n = data.withUnsafeBytes { src in
      guard let base = src.baseAddress else { return 0 }
      return compression_decode_buffer(
        &raw, raw.count, base.advanced(by: headerSize).assumingMemoryBound(to: UInt8.self), data.count - headerSize,
        nil,
        COMPRESSION_LZFSE)
    }
    guard n == raw.count else { return nil }
    s.lock(options: [], seed: nil)
    raw.withUnsafeBytes { src in
      guard let base = src.baseAddress else { return }
      for y in 0..<h { (s.baseAddress + y * s.bytesPerRow).copyMemory(from: base + y * row, byteCount: row) }
    }
    s.unlock(options: [], seed: nil)
    return NoteSnapshot(surface: s, size: size)
  }
}

/// Which files the cache holds, how big and when each was last used; what to remove to stay under the limit
struct CacheIndex {
  private(set) var total = 0
  private var files: [String: (size: Int, used: Date)] = [:]
  let limit: Int

  init(limit: Int, files: [(name: String, size: Int, used: Date)] = []) {
    self.limit = limit
    for f in files {
      self.files[f.name] = (f.size, f.used)
      total += f.size
    }
  }

  var names: Set<String> { Set(files.keys) }

  mutating func touch(_ name: String, at date: Date) {
    files[name]?.used = date
  }

  /// Adds (or replaces) a file and returns the ones to remove, least recently used first; never the one just added
  mutating func insert(_ name: String, size: Int, at date: Date) -> [String] {
    total += size - (files[name]?.size ?? 0)
    files[name] = (size, date)
    guard total > limit else { return [] }
    // ponytail: sorts every file on each insert over the limit; a heap if the cache ever holds 100k+ files
    var gone: [String] = []
    for (n, f) in files.sorted(by: { ($0.value.used, $0.key) < ($1.value.used, $1.key) })
    where total > limit && n != name {
      files[n] = nil
      total -= f.size
      gone.append(n)
    }
    return gone
  }
}
