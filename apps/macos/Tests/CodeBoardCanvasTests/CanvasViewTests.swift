import CoreGraphics
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
    let seen = try ink(of: l.box, size: item.rect.size, canvas: t.canvas)
    let reference = try ink(of: alone.box, size: item.rect.size, canvas: t.canvas)
    #expect(reference > 1000)
    // both pictures composed: 1.2 times the ink (measured); a frameless Note measured 1.2 to 1.6
    #expect(abs(seen / reference - 1) < 0.03, "\(seen / reference)")

    // a zoom gesture clears the rest bitmap: the held one is seen again
    l.clearRest()
    #expect(!l.held.isHidden)
  }

  /// Darkness below the canvas colour, Σ(canvas − luma), of `layer` drawn by Core Animation one device pixel per unit
  private func ink(of layer: CALayer, size: CGSize, canvas: CGColor) throws -> Double {
    let w = Int(size.width)
    let h = Int(size.height)
    let root = CALayer()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.frame = CGRect(x: 0, y: 0, width: w, height: h)
    root.backgroundColor = canvas
    layer.position = CGPoint(x: size.width / 2, y: size.height / 2)
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
    let c = canvas.components ?? [1, 1, 1]
    let paper = 255 * (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
    return stride(from: 0, to: px.count, by: 4).reduce(0) {
      $0 + max(0, paper - (0.0722 * Double(px[$1]) + 0.7152 * Double(px[$1 + 1]) + 0.2126 * Double(px[$1 + 2])))
    }
  }
}
