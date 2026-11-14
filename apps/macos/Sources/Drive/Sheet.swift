import AppKit

/// Contact sheets of a recording: its frames side by side, each with its number and what the hands were doing
enum Sheet {
  static func write(frames: [Driver.Frame], from folder: URL, to file: URL, every: Int, width: CGFloat = 360) {
    let shown = frames.filter { $0.image != nil }.enumerated().filter { $0.offset % max(1, every) == 0 }.map(\.element)
    let images = shown.compactMap { f -> (Driver.Frame, CGImage)? in
      guard let name = f.image,
        let img = NSImage(contentsOf: folder.appending(path: name))?.cgImage(
          forProposedRect: nil, context: nil, hints: nil)
      else { return nil }
      return (f, img)
    }
    guard let first = images.first?.1 else { return }
    let cols = 4
    let h = width * CGFloat(first.height) / CGFloat(first.width)
    let label: CGFloat = 18
    let rows = (images.count + cols - 1) / cols
    let size = CGSize(width: CGFloat(cols) * (width + 8) + 8, height: CGFloat(rows) * (h + label + 8) + 8)
    guard
      let ctx = CGContext(
        data: nil, width: Int(size.width * 2), height: Int(size.height * 2), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return }
    ctx.scaleBy(x: 2, y: 2)
    ctx.setFillColor(CGColor(gray: 0.92, alpha: 1))
    ctx.fill(CGRect(origin: .zero, size: size))
    for (i, (f, img)) in images.enumerated() {
      let x = 8 + CGFloat(i % cols) * (width + 8)
      let top = 8 + CGFloat(i / cols) * (h + label + 8)
      let y = size.height - top - label - h
      ctx.draw(img, in: CGRect(x: x, y: y, width: width, height: h))
      let text = NSAttributedString(
        string: "\(f.n) · \(f.label)",
        attributes: [.font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular), .foregroundColor: NSColor.black])
      let line = CTLineCreateWithAttributedString(text)
      ctx.textPosition = CGPoint(x: x, y: y + h + 5)
      CTLineDraw(line, ctx)
    }
    guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil)
    else { return }
    CGImageDestinationAddImage(dest, out, nil)
    CGImageDestinationFinalize(dest)
  }

  /// A picture as cells of `cell` pixels, each its average colour (RGBA packed), rows from the top: the picture drawn
  /// small, so Core Graphics does the averaging
  static func cells(_ img: CGImage, cell: Int) -> [[UInt32]] {
    let w = img.width / cell
    let h = img.height / cell
    guard w > 0, h > 0,
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let data = ctx.data
    else { return [] }
    ctx.interpolationQuality = .medium
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let px = data.bindMemory(to: UInt32.self, capacity: w * h)
    return (0..<h).map { y in (0..<w).map { x in px[y * w + x] } }
  }
}
