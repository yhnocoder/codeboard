import CodeBoardModel
import CodeBoardNotes
import CoreGraphics
import Foundation
import Metal
import QuartzCore
import Testing

@testable import CodeBoardCanvas

@Test @MainActor func canvasIsLayerBacked() {
  _ = Watchdog.started
  #expect(CanvasView(frame: .zero).layer != nil)
}

/// What Core Animation puts on screen for an item at rest, against the item drawn straight at that zoom
@MainActor @Suite struct RestWeightTests {
  /// A frameless item (a Section's title: text on nothing) at 50 % on a 2x screen holds 100 % for the next zoom-in and
  /// shows 50 % over it: its text must weigh what it weighs drawn at 50 %, not the two pictures added up
  @Test func textOverATransparentItemIsDrawnOnceAtRest() throws {
    let t = Theme.inkWash
    let item = Scene.Item(
      rect: CGRect(x: 0, y: 0, width: 320, height: 40),
      drawing: .label(.init(text: "Threads wait at the barrier until all arrive", kind: .section)), tilt: 0)
    let images = DecodeCache(cap: 1 << 20)
    let held = try #require(CanvasView.render(item, scale: 2, theme: t, images: images).surface)
    let shown = try #require(CanvasView.render(item, scale: 1, theme: t, images: images).surface)
    let l = CanvasView.ItemLayers(item, overview: (held, 2, .drawn), shadow: nil)
    l.take(.init(item: 0, slot: .rest, scale: 1), shown)
    let alone = CanvasView.ItemLayers(item, overview: (shown, 1, .drawn), shadow: nil)
    let seen = ink(try render(l.box, size: item.rect.size, scale: 1, canvas: t.canvas), canvas: t.canvas)
    let reference = ink(try render(alone.box, size: item.rect.size, scale: 1, canvas: t.canvas), canvas: t.canvas)
    #expect(reference > 1000)
    // both pictures composed: 1.2 times the ink (measured); a frameless Note measured 1.2 to 1.6
    #expect(abs(seen / reference - 1) < 0.03, "\(seen / reference)")

    // a zoom gesture clears the rest bitmap: the held one is seen again
    l.clearRest()
    #expect(!l.held.isHidden)
  }

  /// A sheet's edge as the web board draws it (styles.css --wi-ring over --wi-soft): its hairline ring all round, no
  /// darker where the corners curve (the shadow's caster left its antialiased edge there, and the card's bitmap cut the
  /// ring off along the sides), at each level and at a zoom between them
  @Test(arguments: [(0.5, 1), (1, 2), (2, 4), (0.7, 2), (1.37, 4)] as [(CGFloat, CGFloat)])
  func aSheetsEdgeIsEvenAllRound(zoom: CGFloat, level: CGFloat) throws {
    _ = Watchdog.started
    let t = Theme.warmInk
    let card = CGSize(width: 200, height: 100)
    let body = try NativeNotes.body(
      Note(text: ""), width: 200, look: "warm-ink", dark: false, env: NoteEnv(folder: URL(filePath: "/")))
    let note = Drawing.note(.init(id: "n", title: "Plan", content: Note(text: ""), body: body))
    let item = Scene.Item(rect: CGRect(origin: .zero, size: card), drawing: note, tilt: 0, bleed: note.bleed(t))
    let bitmap = try #require(CanvasView.render(item, scale: level, theme: t, images: DecodeCache(cap: 1)).surface)
    let l = CanvasView.ItemLayers(item, overview: (bitmap, level, .drawn), shadow: CanvasView.shadow(t))
    let s = zoom * 2
    let margin: CGFloat = 20
    let px = try render(l.box, size: card, scale: s, canvas: t.canvas, margin: margin)
    let w = Int(((card.width + 2 * margin) * s).rounded(.up))
    func luma(_ x: CGFloat, _ y: CGFloat) -> Double {
      let i = (Int(((y + margin) * s).rounded(.down)) * w + Int(((x + margin) * s).rounded(.down))) * 4
      return 0.0722 * Double(px[i]) + 0.7152 * Double(px[i + 1]) + 0.2126 * Double(px[i + 2])
    }
    // the darkest pixel across the top edge, the left edge and the top left corner's curve
    let step = 1 / (4 * s)
    let across = stride(from: -3, through: 1.5, by: step)
    let top = across.map { luma(card.width / 2, $0) }.min() ?? 0
    let left = across.map { luma($0, card.height / 2) }.min() ?? 0
    let corner = stride(from: -1, through: 4, by: step).map { luma($0, $0) }.min() ?? 0
    let c = t.canvas.components ?? [1, 1, 1]
    let canvas = 255 * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
    // measured: sides 192 to 232 on a canvas of 235, the corner within them; it was 167 to 189 with the sides at 220 to 232
    #expect(corner > min(top, left) - 10, "corner \(corner), sides \(top) \(left)")
    // half a pixel at 100 % is too faint to tell
    if level >= 2 { #expect(canvas - top > 25, "the ring along the top: \(top), canvas \(canvas)") }
  }

  /// `layer` (board units) drawn by Core Animation at `scale` device pixels per unit, `margin` units round it, over the
  /// canvas colour: BGRA rows
  private func render(_ layer: CALayer, size: CGSize, scale: CGFloat, canvas: CGColor, margin: CGFloat = 0) throws
    -> [UInt8]
  {
    let w = Int(((size.width + 2 * margin) * scale).rounded(.up))
    let h = Int(((size.height + 2 * margin) * scale).rounded(.up))
    let root = CALayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    // the scale about the top left corner, as the canvas's world
    root.anchorPoint = .zero
    root.frame = CGRect(x: 0, y: 0, width: w, height: h)
    root.backgroundColor = canvas
    root.isGeometryFlipped = true
    root.sublayerTransform = CATransform3DMakeScale(scale, scale, 1)
    layer.position = CGPoint(x: margin + size.width / 2, y: margin + size.height / 2)
    root.addSublayer(layer)
    CATransaction.commit()
    let device = try #require(MTLCreateSystemDefaultDevice())
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: w, height: h, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = .shared
    let texture = try #require(device.makeTexture(descriptor: d))
    let queue = try #require(device.makeCommandQueue())
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let r = CARenderer(
      mtlTexture: texture, options: [kCARendererMetalCommandQueue: queue, kCARendererColorSpace: space])
    r.layer = root
    r.bounds = root.frame
    // the renderer sees only committed layers
    CATransaction.flush()
    r.beginFrame(atTime: CACurrentMediaTime(), timeStamp: nil)
    r.addUpdate(r.bounds)
    r.render()
    r.endFrame()
    // after the renderer's work on the queue
    let buffer = try #require(queue.makeCommandBuffer())
    buffer.commit()
    buffer.waitUntilCompleted()
    var px = [UInt8](repeating: 0, count: w * h * 4)
    texture.getBytes(&px, bytesPerRow: w * 4, from: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0)
    return px
  }

  /// Darkness below the canvas colour, Σ(canvas − luma)
  private func ink(_ px: [UInt8], canvas: CGColor) -> Double {
    let c = canvas.components ?? [1, 1, 1]
    let paper = 255 * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
    return stride(from: 0, to: px.count, by: 4).reduce(0) {
      $0 + max(0, paper - (0.0722 * Double(px[$1]) + 0.7152 * Double(px[$1 + 1]) + 0.2126 * Double(px[$1 + 2])))
    }
  }
}
