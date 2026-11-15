import CodeBoardModel
import CoreGraphics
import Foundation
import Metal
import QuartzCore
import Testing

@testable import CodeBoardCanvas

@Test @MainActor func canvasIsLayerBacked() {
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

  /// A Note's first picture fades in over its paper: halfway through, the card is as opaque as its paper (a crossfade
  /// faded the paper out as the picture came in, and for a frame the board showed through the whole card, header too)
  @Test(arguments: [RestPlan.Slot.held, .overview, .rest])
  func aNotesFirstPictureFadesInOverItsPaper(slot: RestPlan.Slot) throws {
    let t = Theme.warmInk
    let size = CGSize(width: 200, height: 100)
    let item = Scene.Item(
      rect: CGRect(origin: .zero, size: size),
      drawing: .note(
        .init(id: "n", title: "Plan", content: .note(Note(text: "")), folder: URL(filePath: "/"), refs: [])),
      tilt: 0)
    let images = DecodeCache(cap: 1 << 20)
    let paper = try #require(CanvasView.render(item, scale: 2, theme: t, images: images).surface)
    let picture = try #require(CanvasView.render(item, scale: 2, theme: t, images: images).surface)
    let l = CanvasView.ItemLayers(item, overview: (paper, 2, .paper), shadow: nil)
    let whole = try render(l.box, size: size, scale: 1, canvas: t.canvas)
    l.take(.init(item: 0, slot: slot, scale: 2, note: true), picture)
    let shown = slot == .rest ? l.rest : l.held
    #expect(shown.animationKeys()?.isEmpty == false)
    // halfway through the fade
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shown.removeAllAnimations()
    shown.opacity = 0.5
    CATransaction.commit()
    let half = try render(l.box, size: size, scale: 1, canvas: t.canvas)
    let off = zip(whole, half).map { abs(Int($0) - Int($1)) }.max() ?? 0
    // the same text drawn twice differs only at its antialiased edges (measured 7); the board showing through, 102
    #expect(off <= 10, "the card differs by up to \(off) of 255 halfway through its fade")
  }

  /// A sheet's edge as the web board draws it (styles.css --wi-ring over --wi-soft): its hairline ring all round, no
  /// darker where the corners curve (the shadow's caster left its antialiased edge there, and the card's bitmap cut the
  /// ring off along the sides), at each level and at a zoom between them
  @Test(arguments: [(0.5, 1), (1, 2), (2, 4), (0.7, 2), (1.37, 4)] as [(CGFloat, CGFloat)])
  func aSheetsEdgeIsEvenAllRound(zoom: CGFloat, level: CGFloat) throws {
    let t = Theme.warmInk
    let card = CGSize(width: 200, height: 100)
    let item = Scene.Item(
      rect: CGRect(origin: .zero, size: card),
      drawing: .note(
        .init(id: "n", title: "Plan", content: .note(Note(text: "")), folder: URL(filePath: "/"), refs: [])),
      tilt: 0,
      bleed: Drawing.note(.init(id: "n", content: .note(Note(text: "")), folder: URL(filePath: "/"), refs: [])).bleed(t)
    )
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

  /// A bitmap shown at the scale it was drawn at, on a device pixel, is put on screen pixel for pixel: its layer covers
  /// what its pixels cover (its sides rounded up), not the item's size, whose fraction of a pixel stretched (resampled)
  /// all of it
  @Test(arguments: [RestPlan.Slot.held, .rest])
  func aBitmapAtItsOwnScaleIsShownPixelForPixel(slot: RestPlan.Slot) throws {
    let t = Theme.inkWash
    let item = Scene.Item(
      rect: CGRect(x: 0, y: 0, width: 320.3, height: 40.7),
      drawing: .label(.init(text: "Threads wait at the barrier until all arrive", kind: .section)), tilt: 0)
    let images = DecodeCache(cap: 1 << 20)
    let bitmap = try #require(CanvasView.render(item, scale: 2, theme: t, images: images).surface)
    let l = CanvasView.ItemLayers(item, overview: (nil, 1, .drawn), shadow: nil)
    l.take(.init(item: 0, slot: slot, scale: 2), bitmap)
    let shown = slot == .rest ? l.rest : l.held
    #expect(shown.frame.width * 2 == CGFloat(bitmap.width) && shown.frame.height * 2 == CGFloat(bitmap.height))
    let px = try render(l.box, size: item.rect.size, scale: 2, canvas: t.canvas)
    let w = Int((item.rect.width * 2).rounded(.up))
    let h = Int((item.rect.height * 2).rounded(.up))
    bitmap.lock(options: .readOnly, seed: nil)
    defer { bitmap.unlock(options: .readOnly, seed: nil) }
    let src = bitmap.baseAddress.assumingMemoryBound(to: UInt8.self)
    let c = t.canvas.components ?? [1, 1, 1]
    // the bitmap over the canvas colour, premultiplied BGRA, against what Core Animation made of it (its rows bottom up)
    var off = 0
    for y in 0..<Int(item.rect.height * 2) {
      for x in 0..<Int(item.rect.width * 2) {
        let i = y * bitmap.bytesPerRow + x * 4
        let a = Double(src[i + 3]) / 255
        for ch in 0..<3 {
          let over = Double(src[i + ch]) + 255 * c[2 - ch] * (1 - a)
          off = max(off, abs(Int(over.rounded()) - Int(px[((h - 1 - y) * w + x) * 4 + ch])))
        }
      }
    }
    // stretched by a fraction of a pixel, as it was, its edges kept 71 % of their contrast (59 % on a 1x screen)
    #expect(off <= 2, "\(off)")
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

/// At rest the board's items start on device pixels, which Core Animation shows without resampling them: the world's
/// translation and each item moved by less than half a device pixel, on a 2x screen and a 1x one alike (its own scale)
@MainActor @Suite(.serialized) struct RestOnPixelsTests {
  static func board() -> Board {
    Board(
      id: BoardID(rawValue: "px"),
      cards: [
        Card(
          id: cid("n"), x: 40.3, y: 41.7, width: 300.4,
          content: .own(CardContent(body: .note(Note(text: "# Prefill\n\nBatches wait for the longest prompt."))))),
        Card(
          id: cid("t"), x: 400.25, y: 60.6, width: 200,
          content: .own(CardContent(body: .text(TextCard(text: "A Text", wrap: false))))),
      ])
  }

  @Test(arguments: [1, 0.83] as [CGFloat])
  func atRestEveryItemInViewStartsOnADevicePixel(zoom: CGFloat) async throws {
    let rig = try await Rig(RestOnPixelsTests.board(), zoom: nil)
    defer { rig.close() }
    let c = rig.canvas
    // a camera between pixels, as a pan or a zoom leaves it
    let asked = CGPoint(x: 300.37, y: 210.81)
    c.place(zoom: zoom, centre: asked)
    await rig.idle()
    let k = c.camera.zoom * c.backing
    #expect(c.camera.zoom == zoom)
    // the camera where it was put; the world's translation within half a device pixel of it
    let want = CGPoint(x: asked.x - c.bounds.width / 2 / zoom, y: asked.y - c.bounds.height / 2 / zoom)
    #expect(abs(c.camera.origin.x - want.x) < 1e-9 && abs(c.camera.origin.y - want.y) < 1e-9)
    let t = c.world.sublayerTransform
    #expect(abs(t.m41 + want.x * zoom) * c.backing <= 0.5 && abs(t.m42 + want.y * zoom) * c.backing <= 0.5)
    func whole(_ v: CGFloat) -> Bool { abs(v - v.rounded()) < 1e-6 }
    let view = c.camera.visible(c.bounds.size)
    var seen = 0
    for (it, l) in zip(try #require(c.scene).items, c.items) where l.bitmapFrame.intersects(view) {
      seen += 1
      let o = CGPoint(x: t.m41 + l.bitmapFrame.minX * t.m11, y: t.m42 + l.bitmapFrame.minY * t.m22)
      #expect(whole(o.x * c.backing) && whole(o.y * c.backing), "\(String(describing: it.owner)) at \(o)")
      // each moved less than half a device pixel from where the board has it
      #expect(abs(l.box.position.x - it.rect.midX) * k <= 0.5 && abs(l.box.position.y - it.rect.midY) * k <= 0.5)
    }
    #expect(seen >= 2)
    // a zoom puts them back where the board has them
    c.place(zoom: zoom * 1.1, centre: asked)
    c.placeItems()
    for (it, l) in zip(try #require(c.scene).items, c.items) where it.tilt == 0 {
      #expect(l.box.position == CGPoint(x: it.rect.midX, y: it.rect.midY))
    }
  }
}
