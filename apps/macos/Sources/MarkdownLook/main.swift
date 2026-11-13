// Draws Markdown files with the native renderer into PNGs, for comparing with the Note page (tools/markdown/look.mjs):
//   swift run MarkdownLook <out dir> <width> <look> <dark 0|1> <scale> <file.md>...
import AppKit
import CodeBoardMarkdown
import CodeBoardMarkdownUI

struct NoResources: MarkdownResources {
  let folder: URL
  let math: MathTypesetter?
  var diagrams: DiagramRenderer? { math as? DiagramRenderer }
  func imageSize(_ src: String) -> CGSize? {
    guard let s = CGImageSourceCreateWithURL(folder.appending(path: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int
    else { return nil }
    return CGSize(width: w, height: h)
  }
  /// the Note page in the comparison resolves no reference
  func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
  func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
  var mathPreamble: String { "" }
}

let a = CommandLine.arguments
guard a.count >= 7 else {
  print("usage: MarkdownLook <out dir> <width> <look> <dark 0|1> <scale> <file.md>...")
  exit(2)
}
let out = URL(filePath: a[1])
let width = CGFloat(Double(a[2])!)
let theme = Looks.theme(a[3], dark: a[4] == "1")
let scale = CGFloat(Double(a[5])!)
let here = URL(filePath: #filePath).deletingLastPathComponent()
Looks.registerFonts(here.appending(path: "../../web/dist/assets").standardized)
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let engines = try? JSEngines(script: here.appending(path: "../../web/dist/engines.js").standardized)
for file in a[6...] {
  let url = URL(filePath: file)
  let src = try String(contentsOf: url, encoding: .utf8)
  let res = NoResources(folder: url.deletingLastPathComponent(), math: engines)
  let t0 = Date()
  let layout = MarkdownLayout.make(MarkdownDocument(src), width: width, theme: theme, layout: nil, resources: res)
  let t1 = Date()
  let w = Int((layout.size.width * scale).rounded(.up))
  let h = Int((layout.size.height * scale).rounded(.up))
  let ctx = CGContext(
    data: nil, width: w, height: max(1, h), bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(theme.colors.surface.cg)
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.translateBy(x: 0, y: CGFloat(h))
  ctx.scaleBy(x: scale, y: -scale)
  layout.draw(in: ctx, scale: scale, clip: CGRect(origin: .zero, size: layout.size)) { _ in nil }
  let t2 = Date()
  let png = out.appending(path: url.deletingPathExtension().lastPathComponent + ".png")
  let dest = CGImageDestinationCreateWithURL(png as CFURL, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
  print(
    String(
      format: "%@ %.0fx%.0f layout %.2f ms draw %.2f ms", png.lastPathComponent, layout.size.width, layout.size.height,
      t1.timeIntervalSince(t0) * 1000, t2.timeIntervalSince(t1) * 1000))
}
