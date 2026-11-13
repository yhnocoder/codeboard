import Compression
import CoreGraphics
import Foundation
import IOSurface
import Synchronization

/// SVG pictures on disk, one file per key, the least recently used removed first once the folder holds more than
/// `limit` bytes. A file is raw BGRA compressed with LZ4 (lossless; a 35 MB picture in 6 ms and read back in 3, where
/// LZFSE took 150 ms to write it at half the size, and PNG is slower still), after a header with its pixel size and the
/// picture's size in CSS px; a measured size alone is the header with no pixels. Reads and writes run on the caller's thread
/// and may overlap.
final class SnapshotStore: Sendable {
  let folder: URL
  private let index: Mutex<CacheIndex?>
  private let limit: Int

  init(folder: URL, limit: Int) {
    self.folder = folder
    self.limit = limit
    index = Mutex(nil)
  }

  func read(_ key: SnapshotKey) -> SVGPicture? {
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

  func write(_ snap: SVGPicture, as key: SnapshotKey) throws {
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
    try put(Self.header(width: 0, height: 0, row: 0, size: size), as: key)
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

  private static let magic: UInt32 = 0x324E_4243  // "CBN2"; CBN1 files were LZFSE and read as misses
  private static let headerSize = 32

  /// The surface's memory as it is, row padding included, so that neither writing nor reading a picture copies its
  /// pixels into a buffer of their size. What it is compressed into is mapped, not allocated: the allocator keeps a
  /// freed block that large for reuse, in the footprint
  static func encode(_ snap: SVGPicture) -> Data? {
    let s = snap.surface
    let count = s.bytesPerRow * s.height
    // LZ4 grows what it cannot compress by at most a 255th, plus its headers; only the pages written take memory
    let room = headerSize + count + count / 255 + 4096
    guard let out = mmap(nil, room, PROT_READ | PROT_WRITE, MAP_ANON | MAP_PRIVATE, -1, 0),
      out != UnsafeMutableRawPointer(bitPattern: -1)
    else { return nil }
    let bytes = out.assumingMemoryBound(to: UInt8.self)
    header(width: s.width, height: s.height, row: s.bytesPerRow, size: snap.size).copyBytes(
      to: bytes, count: headerSize)
    s.lock(options: .readOnly, seed: nil)
    let n = compression_encode_buffer(
      bytes + headerSize, room - headerSize, s.baseAddress.assumingMemoryBound(to: UInt8.self), count, nil,
      COMPRESSION_LZ4_RAW)
    s.unlock(options: .readOnly, seed: nil)
    guard n > 0 else {
      munmap(out, room)
      return nil
    }
    return Data(bytesNoCopy: out, count: headerSize + n, deallocator: .custom { p, _ in munmap(p, room) })
  }

  private static func header(width w: Int, height h: Int, row: Int, size: CGSize) -> Data {
    var out = Data(capacity: headerSize)
    for v in [magic, UInt32(w), UInt32(h), UInt32(row)] {
      withUnsafeBytes(of: v.littleEndian) { out.append(contentsOf: $0) }
    }
    for v in [size.width, size.height] {
      withUnsafeBytes(of: Double(v).bitPattern.littleEndian) { out.append(contentsOf: $0) }
    }
    return out
  }

  /// The Note's size at 100 % from a file's header (a snapshot's or a measured size's)
  static func size(_ data: Data) -> CGSize? {
    guard data.count >= headerSize, u32(data, 0) == magic else { return nil }
    return CGSize(width: f64(data, 16), height: f64(data, 24))
  }

  private static func u32(_ data: Data, _ at: Int) -> UInt32 {
    data.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(fromByteOffset: at, as: UInt32.self)) }
  }

  private static func f64(_ data: Data, _ at: Int) -> Double {
    data.withUnsafeBytes {
      Double(bitPattern: UInt64(littleEndian: $0.loadUnaligned(fromByteOffset: at, as: UInt64.self)))
    }
  }

  static func decode(_ data: Data) -> SVGPicture? {
    guard data.count > headerSize, let size = size(data) else { return nil }
    let (w, h, row) = (Int(u32(data, 4)), Int(u32(data, 8)), Int(u32(data, 12)))
    // a surface laid out as the one written, or none (IOSurface would not take that row length here)
    guard w > 0, h > 0, let s = SVGPicture.makeSurface(width: w, height: h, bytesPerRow: row), s.bytesPerRow == row
    else { return nil }
    s.lock(options: [], seed: nil)
    let n = data.withUnsafeBytes { src in
      guard let base = src.baseAddress else { return 0 }
      return compression_decode_buffer(
        s.baseAddress.assumingMemoryBound(to: UInt8.self), row * h,
        base.advanced(by: headerSize).assumingMemoryBound(to: UInt8.self), data.count - headerSize, nil,
        COMPRESSION_LZ4_RAW)
    }
    s.unlock(options: [], seed: nil)
    guard n == row * h else { return nil }
    return SVGPicture(surface: s, size: size)
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
