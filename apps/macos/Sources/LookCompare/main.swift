import CodeBoardCanvas
import CodeBoardModel
import CodeBoardSyntax
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// The Swift half of the look comparison (tools/look/compare.mjs runs it after the web half): the fixture storage folder
// imported into a vault, drawn by the canvas's drawing code at the same rects and zooms as the web board's pictures in
// <out>/<theme>/ (and <theme>-dark/), and each pair written side by side with their difference.
//   swift run -c release LookCompare <storage folder> <out folder>

struct Rects: Decodable {
  struct R: Decodable {
    var x, y, w, h: Double
  }
  var margin: Double
  var zooms: [Double]
  var rects: [String: R]
}

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write(Data("usage: LookCompare <storage folder> <out folder>\n".utf8))
  exit(2)
}
let storage = URL(filePath: args[1])
let out = URL(filePath: args[2])
let fm = FileManager.default
let vaultURL = fm.temporaryDirectory.appending(path: "look-vault-\(ProcessInfo.processInfo.processIdentifier)")
defer { try? fm.removeItem(at: vaultURL) }
_ = try LegacyImport.run(from: storage, to: vaultURL)
let vault = Vault(root: vaultURL)
guard let entry = try vault.tree().allBoards.first else { fatalError("the fixture has no board") }
let board = try vault.board(at: entry.path)
let package = vault.url(of: entry.path)
let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

func read(_ url: URL) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func write(_ img: CGImage, _ url: URL) {
  guard let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
  CGImageDestinationAddImage(d, img, nil)
  CGImageDestinationFinalize(d)
}

/// RGBA bytes of an image at its own size
func pixels(_ img: CGImage, width w: Int, height h: Int) -> [UInt8] {
  var px = [UInt8](repeating: 0, count: w * h * 4)
  px.withUnsafeMutableBytes { buf in
    let ctx = CGContext(
      data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  return px
}

/// web | swift | difference (black where they differ, ×4), and the mean difference per channel (0…255)
func sideBySide(_ web: CGImage, _ swift: CGImage) -> (CGImage?, Double) {
  let w = max(web.width, swift.width)
  let h = max(web.height, swift.height)
  let a = pixels(web, width: w, height: h)
  let b = pixels(swift, width: w, height: h)
  var diff = [UInt8](repeating: 255, count: w * h * 4)
  var total = 0
  for i in stride(from: 0, to: a.count, by: 4) {
    var d = 0
    for c in 0..<3 { d = max(d, abs(Int(a[i + c]) - Int(b[i + c]))) }
    total += d
    let v = UInt8(max(0, 255 - min(255, d * 4)))
    diff[i] = v
    diff[i + 1] = v
    diff[i + 2] = v
  }
  let gap = 12
  let ctx = CGContext(
    data: nil, width: 3 * w + 2 * gap, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  ctx?.setFillColor(CGColor(gray: 0.5, alpha: 1))
  ctx?.fill(CGRect(x: 0, y: 0, width: 3 * w + 2 * gap, height: h))
  let diffImage = diff.withUnsafeMutableBytes { buf in
    CGContext(
      data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?.makeImage()
  }
  for (i, img) in [web, swift, diffImage].enumerated() {
    guard let img else { continue }
    ctx?.draw(img, in: CGRect(x: i * (w + gap), y: h - img.height, width: img.width, height: img.height))
  }
  return (ctx?.makeImage(), Double(total) / Double(w * h))
}

var report = ""
let highlighter = Highlighter()
for theme in Theme.all.flatMap({ [$0, Theme.named($0.id, dark: true)] }) {
  let name = theme.id.rawValue + (theme.dark ? "-dark" : "")
  let dir = out.appending(path: name)
  guard let data = try? Data(contentsOf: dir.appending(path: "rects.json")),
    let rects = try? JSONDecoder().decode(Rects.self, from: data)
  else {
    print("\(name): no web pictures (run tools/look/compare.mjs)")
    continue
  }
  // what the Note page measures, as the web board measured it
  var sizes: [CardID: CGSize] = [:]
  for (id, r) in rects.rects { sizes[CardID(rawValue: id)] = CGSize(width: r.w, height: r.h) }
  func picture(_ rect: CGRect, scale: CGFloat, backdrop: Bool) -> (image: CGImage?, cards: [String: CGRect]) {
    Picture.draw(
      board: board, package: package, vault: vault, theme: theme, highlighter: highlighter, sizes: sizes, rect: rect,
      scale: scale, backdrop: backdrop)
  }
  // the whole board as the web view showed it: 1440 × 900 at 100 %, on a 2x screen
  let whole = picture(CGRect(x: 0, y: 0, width: 1440, height: 900), scale: 2, backdrop: true)
  if let img = whole.image {
    write(img, dir.appending(path: "swift-board.png"))
    if let web = read(dir.appending(path: "web-board.png")) {
      let (pair, d) = sideBySide(web, img)
      if let pair { write(pair, dir.appending(path: "board.png")) }
      report += String(format: "%@ board: %.2f\n", name, d)
    }
  }
  for z in rects.zooms {
    for (card, r) in rects.rects.sorted(by: { $0.key < $1.key }) {
      let m = rects.margin
      let wpx = ((r.w + 2 * m) * z).rounded(.up)
      let hpx = ((r.h + 2 * m) * z).rounded(.up)
      let rect = CGRect(x: r.x - m, y: r.y - m, width: wpx / z, height: hpx / z)
      let crop = "\(card)@\(Int(z))"
      guard
        let img = picture(rect, scale: 2 * z, backdrop: false).image,
        let web = read(dir.appending(path: "web-\(crop).png"))
      else { continue }
      write(img, dir.appending(path: "swift-\(crop).png"))
      let (pair, d) = sideBySide(web, img)
      if let pair { write(pair, dir.appending(path: "\(crop).png")) }
      let mine = whole.cards[card].map { "\(Int($0.width))×\(Int($0.height))" } ?? "missing"
      report += String(format: "%@ %@: %.2f (web %d×%d, swift %@)\n", name, crop, d, Int(r.w), Int(r.h), mine)
    }
  }
}
try report.write(to: out.appending(path: "report.txt"), atomically: true, encoding: .utf8)
print(report, terminator: "")
print("pictures in \(out.path(percentEncoded: false))")
