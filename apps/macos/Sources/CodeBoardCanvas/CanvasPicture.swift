import AppKit
import CodeBoardModel
import CryptoKit

// The board as it was last shown, kept in the app's caches when it is left: opened again in a canvas showing nothing yet
// (the app's first board after launch), that picture is over the view from the first frame until the board's own
// layers are drawn at rest. It stands only for exactly what it shows: the board's bytes, the look, the view's size and
// scale, the camera, the Note page's build, the system and the app; anything else and it is not used. While a board
// opens, input goes nowhere (it would act on a board not shown yet).

extension CanvasView {
  /// ~/Library/Caches/<bundle id, or CodeBoard>/board-pictures
  static var defaultPictures: URL {
    URL.cachesDirectory.appending(components: Bundle.main.bundleIdentifier ?? "CodeBoard", "board-pictures")
  }

  /// The file a picture of this board, taken so, is in
  func pictureFile(_ board: VaultBoard, in vault: Vault, bytes: Data, theme: Theme, camera: Camera) -> URL? {
    guard let folder = picturesFolder, !bounds.isEmpty else { return nil }
    let backing = window?.backingScaleFactor ?? 2
    let app = Bundle.main.executableURL.flatMap {
      try? FileManager.default.attributesOfItem(atPath: $0.path(percentEncoded: false))[.modificationDate] as? Date
    }
    var h = SHA256()
    h.update(data: bytes)
    for part in [
      theme.id.rawValue, "\(theme.dark)", "\(bounds.size.width)x\(bounds.size.height)@\(backing)",
      "\(camera.origin.x),\(camera.origin.y),\(camera.zoom)", notes.build,
      ProcessInfo.processInfo.operatingSystemVersionString, "\(app?.timeIntervalSince1970 ?? 0)",
    ] {
      h.update(data: Data([0]))
      h.update(data: Data(part.utf8))
    }
    let key = h.finalize().map { String(format: "%02x", $0) }.joined()
    return folder.appending(path: "\(Self.pictureStem(board, in: vault))-\(key).lz4")
  }

  /// A board's pictures start with this
  static func pictureStem(_ board: VaultBoard, in vault: Vault) -> String {
    SHA256.hash(data: Data("\(vault.root.path(percentEncoded: false))\n\(board.id.rawValue)".utf8)).prefix(12)
      .map { String(format: "%02x", $0) }.joined()
  }

  /// The board shown, as it is on screen at rest without what only this moment shows (selection, hover, the ports and
  /// handles, popups), written in the background over its earlier pictures; when it is left
  func keepPicture() {
    guard let (board, vault) = shown, let drawn = shownBoard, scene != nil, motion.isResting, gesture == nil,
      let bytes = try? drawn.encoded(),
      let file = pictureFile(board, in: vault, bytes: bytes, theme: theme, camera: camera),
      let image = renderPicture()
    else { return }
    let stem = Self.pictureStem(board, in: vault)
    Self.watchQuit()
    Self.pictureWrites.async {
      let fm = FileManager.default
      let folder = file.deletingLastPathComponent()
      try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
      for old in (try? fm.contentsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? []
      where old.hasPrefix(stem) {
        try? fm.removeItem(at: folder.appending(path: old))
      }
      guard let data = Self.packed(image) else { return }
      let tmp = folder.appending(path: ".\(UUID().uuidString)")
      if (try? data.write(to: tmp)) != nil { try? fm.moveItem(at: tmp, to: file) }
      // the boards left last: a few MB each
      let kept =
        ((try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
        .filter { !$0.lastPathComponent.hasPrefix(".") }
        .sorted {
          let d = { (u: URL) in
            (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
          }
          return d($0) > d($1)
        }
      for old in kept.dropFirst(Self.picturesKept) { try? fm.removeItem(at: old) }
    }
  }

  nonisolated static let picturesKept = 24

  /// Pictures are written one at a time; the app quitting waits for them
  package nonisolated static let pictureWrites = DispatchQueue(label: "CanvasView.pictures", qos: .utility)
  private static var quitWatched = false

  private static func watchQuit() {
    guard !quitWatched else { return }
    quitWatched = true
    NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: nil
    ) { _ in pictureWrites.sync {} }
  }

  /// A picture as its pixels (BGRA, premultiplied, as drawn) after its size, LZ4-compressed: read back in a few
  /// milliseconds, where decoding a PNG of a window takes a tenth of a second
  nonisolated static func packed(_ image: CGImage) -> Data? {
    guard let pixels = image.dataProvider?.data as Data?,
      let body = try? (pixels as NSData).compressed(using: .lz4) as Data
    else { return nil }
    var head = [UInt32(image.width), UInt32(image.height), UInt32(image.bytesPerRow)]
    return Data(bytes: &head, count: 12) + body
  }

  nonisolated static func unpacked(_ file: URL) -> CGImage? {
    guard let data = try? Data(contentsOf: file), data.count > 12 else { return nil }
    let head = data.prefix(12).withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    let (w, h, row) = (Int(head[0]), Int(head[1]), Int(head[2]))
    guard let pixels = try? (data.dropFirst(12) as NSData).decompressed(using: .lz4) as Data, pixels.count == row * h,
      let provider = CGDataProvider(data: pixels as CFData)
    else { return nil }
    return CGImage(
      width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: row,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(
        rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }

  /// The backdrop and the board's layers, drawn at the view's scale
  func renderPicture() -> CGImage? {
    guard let root = layer, !bounds.isEmpty else { return nil }
    let k = window?.backingScaleFactor ?? 2
    guard
      let ctx = CGContext(
        data: nil, width: Int(bounds.width * k), height: Int(bounds.height * k), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    var hidden: [CALayer] = (root.sublayers ?? []).filter { $0 !== backdrop && $0 !== world }
    hidden += [chrome] + selectedLooks.values.flatMap { $0 } + [hoverLine].compactMap { $0 }
    hidden = hidden.filter { !$0.isHidden }
    withoutAnimation { for l in hidden { l.isHidden = true } }
    ctx.translateBy(x: 0, y: bounds.height * k)
    ctx.scaleBy(x: k, y: -k)
    root.render(in: ctx)
    withoutAnimation { for l in hidden { l.isHidden = false } }
    return ctx.makeImage()
  }

  /// The board's picture over the view, when there is one of it exactly as it is about to open
  public func showPicture(_ board: VaultBoard, in vault: Vault, theme: Theme) {
    guard scene == nil, picture.isHidden,
      let c = arriving
        ?? cameras?.cameras(for: vault)[board.id].map({
          Camera(origin: CGPoint(x: $0.x, y: $0.y), zoom: $0.zoom)
        }),
      let bytes = try? Data(contentsOf: vault.url(of: board.path).appending(path: Vault.boardFileName)),
      let file = pictureFile(board, in: vault, bytes: bytes, theme: theme, camera: c),
      let image = Self.unpacked(file)
    else { return }
    withoutAnimation {
      picture.frame = bounds
      picture.contents = image
      picture.isHidden = false
    }
    // on screen now, before whatever else this turn of the run loop does
    CATransaction.flush()
    pictureCamera = c
    pictureShownAt = CACurrentMediaTime()
    link?.isPaused = false
  }

  /// The picture goes once the board's own layers show it: at rest with every item in view drawn, or as soon as
  /// anything moves the camera
  func pictureCheck() {
    guard !picture.isHidden, scene != nil, !opening else { return }
    let b = blankInView
    if camera != pictureCamera || gesture != nil || (isSettled && b.empty.isEmpty && b.paper.isEmpty) { dropPicture() }
  }

  package var pictureShown: Bool { !picture.isHidden }
  package var isOpening: Bool { opening }
  package var shownVaultBoard: VaultBoard? { shown?.0 }

  func dropPicture() {
    guard !picture.isHidden else { return }
    withoutAnimation {
      picture.isHidden = true
      picture.contents = nil
    }
    pictureCamera = nil
  }
}
