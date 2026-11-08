// The app icon, made at build time (build.sh) from CodeBoard's own glyph (extensions/vscode/media/icon.svg): the same card with
// its eyes and the Vermilion prompt, on macOS's icon shape (an 824 px rounded square on the 1024 px grid, a light paper
// gradient). Writes the 1024 px master; build.sh makes the sizes with sips and the .icns with iconutil.
//   swift icon.swift <icon.svg> <out.png>
import AppKit

let args = CommandLine.arguments
var glyph = try String(contentsOfFile: args[1], encoding: .utf8)
// the glyph's own drawing, coloured: ink lines, a paper card, the prompt in Vermilion
let inner = glyph.range(of: #"(?s)<svg[^>]*>(.*)</svg>"#, options: .regularExpression).map { String(glyph[$0]) } ?? ""
glyph = inner.replacingOccurrences(of: #"^<svg[^>]*>"#, with: "", options: .regularExpression).replacingOccurrences(of: "</svg>", with: "")
for (a, b) in [
  ("fill=\"currentColor\"", "fill=\"#211f1b\""), ("<rect x=\"2.8\"", "<rect fill=\"#fdfcfa\" x=\"2.8\""),
  ("<path d=\"m7.8", "<path stroke=\"#d4472a\" stroke-width=\"2\" d=\"m7.8"),
] {
  guard glyph.contains(a) else { fatalError("icon.svg changed: no \(a)") }
  glyph = glyph.replacingOccurrences(of: a, with: b)
}
let svg = """
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfbf6"/><stop offset="1" stop-color="#e9e3d7"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#paper)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#000" stroke-opacity="0.08"/>
  <g transform="translate(512 520) scale(28) translate(-12 -12.25)" fill="none" stroke="#211f1b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">\(glyph)</g>
  </svg>
  """
guard let img = NSImage(data: Data(svg.utf8)) else { fatalError("could not draw the icon") }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: 1024, height: 1024)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
img.draw(in: NSRect(x: 0, y: 0, width: 1024, height: 1024))
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
