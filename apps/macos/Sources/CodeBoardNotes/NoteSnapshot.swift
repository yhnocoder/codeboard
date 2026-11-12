import CoreGraphics
import IOSurface

/// A Note drawn at one scale: `surface` is BGRA, premultiplied, sRGB, `ceil(size × scale)` pixels, the Note's top left
/// corner at its top left pixel; `size` is the card's size at 100 % in points (its content's height when the request gave
/// none; a Free Text's width is its text's)
public struct NoteSnapshot: Sendable {
  public let surface: IOSurface
  public let size: CGSize

  /// `bytesPerRow`: a row length IOSurface gave a surface of this width before (nil: its own choice)
  static func makeSurface(width: Int, height: Int, bytesPerRow: Int? = nil) -> IOSurface? {
    var p: [IOSurfacePropertyKey: any Sendable] = [
      .width: width, .height: height, .bytesPerElement: 4, .pixelFormat: 0x4247_5241,  // 'BGRA'
    ]
    if let bytesPerRow { p[.bytesPerRow] = bytesPerRow }
    let s = IOSurface(properties: p)
    if let s, let space = CGColorSpace(name: CGColorSpace.sRGB)?.copyPropertyList() {
      IOSurfaceSetValue(s as IOSurfaceRef, kIOSurfaceColorSpace, space)
    }
    return s
  }

  static func draw(_ image: CGImage, into s: IOSurface) {
    s.lock(options: [], seed: nil)
    defer { s.unlock(options: [], seed: nil) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
      let ctx = CGContext(
        data: s.baseAddress, width: s.width, height: s.height, bitsPerComponent: 8, bytesPerRow: s.bytesPerRow,
        space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return }
    ctx.clear(CGRect(x: 0, y: 0, width: s.width, height: s.height))
    ctx.draw(image, in: CGRect(x: 0, y: s.height - image.height, width: image.width, height: image.height))
  }
}

public enum NoteRenderError: Error {
  /// No built Note page (page.html) in this folder: `node apps/macos/web/build.mjs`
  case pageMissing(URL)
  case page(String)
}
