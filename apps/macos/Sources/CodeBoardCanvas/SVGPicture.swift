import CoreGraphics
import IOSurface

/// An SVG file rasterized: `surface` is BGRA, premultiplied, sRGB, the picture's top left corner at its top left pixel;
/// `size` is its size in CSS px at the width asked for
struct SVGPicture: Sendable {
  let surface: IOSurface
  let size: CGSize

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

  /// The surface's pixels as an image (a copy: the surface may be reused)
  var image: CGImage? {
    surface.lock(options: .readOnly, seed: nil)
    defer { surface.unlock(options: .readOnly, seed: nil) }
    let data = Data(bytes: surface.baseAddress, count: surface.bytesPerRow * surface.height)
    guard let provider = CGDataProvider(data: data as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB) else {
      return nil
    }
    return CGImage(
      width: surface.width, height: surface.height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: surface.bytesPerRow, space: space,
      bitmapInfo: CGBitmapInfo(
        rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
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

enum SVGError: Error, Equatable {
  /// No built svg.html in the app's assets: `node apps/macos/web/build.mjs`
  case pageMissing(URL)
  case page(String)
  /// WebKit did not answer in time (the page did not load, the script or the snapshot never came back)
  case timedOut(String)
}
