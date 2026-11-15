import AppKit
import CodeBoardModel

// A Section title's colour as main's: in the selected Section's colour while it is selected (styles.css .slabel.sel,
// Ink Wash's --zhu), in the ink while the pointer is on it (.slabel:hover), easing over 150 ms (180 in Ink Wash). The
// title is a picture: one in the new colour is drawn over it while the old fades out.

extension CanvasView {
  /// The colour a Section's title shows in now, when not its own
  func titleTone(_ id: SectionID) -> CGColor? {
    let c: CGColor? =
      document?.selection.contains(.section(id)) == true
      ? theme.sectionSelected : hoveredTitle == id && gesture == nil ? theme.ink : nil
    return c == theme.sectionTitle ? nil : c
  }

  /// The titles' colours brought up to date: a picture in the colour drawn over each title that takes one
  func toneTitles() {
    guard let s = scene else { return }
    let ease = theme.id == .inkWash ? 0.18 : 0.15
    var now: [SectionID: Tone] = [:]
    for f in s.frames {
      guard let c = titleTone(f.id), let i = index(of: .sectionTitle(f.id)) else { continue }
      let it = items[i]
      let scale = max(1, camera.zoom * backing)
      if let was = toned[f.id], was.layer.superlayer === it.box, was.colour == c, was.scale == scale {
        now[f.id] = was
        continue
      }
      var t = theme
      t.sectionTitle = c
      guard let surface = Self.render(s.items[i], scale: scale, theme: t, images: images).surface else { continue }
      let l = CALayer()
      l.name = "tone"
      l.frame = it.held.frame
      l.contentsGravity = .resize
      l.contents = surface
      let fresh = toned[f.id]?.layer.superlayer !== it.box
      toned[f.id]?.layer.removeFromSuperlayer()
      it.box.addSublayer(l)
      if fresh {
        Self.fade(l, from: 0, to: 1, over: ease)
        for p in [it.held, it.rest] { Self.fade(p, from: 1, to: 0, over: ease) }
      } else {
        for p in [it.held, it.rest] { p.opacity = 0 }
      }
      now[f.id] = Tone(colour: c, scale: scale, layer: l)
    }
    for (id, was) in toned where now[id]?.layer !== was.layer {
      guard now[id] == nil else {
        was.layer.removeFromSuperlayer()
        continue
      }
      let box = was.layer.superlayer
      was.layer.name = "tone going"
      Self.fade(was.layer, from: 1, to: 0, over: ease) { was.layer.removeFromSuperlayer() }
      if let i = index(of: .sectionTitle(id)), items[i].box === box {
        for p in [items[i].held, items[i].rest] { Self.fade(p, from: 0, to: 1, over: ease) }
      }
    }
    toned = now
  }

  /// `l`'s opacity to `to`, from `from`, over `over` seconds; then `done`
  static func fade(
    _ l: CALayer, from: Float, to: Float, over: CFTimeInterval, done: (@MainActor () -> Void)? = nil
  ) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if let done { CATransaction.setCompletionBlock { MainActor.assumeIsolated { done() } } }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = from
    a.toValue = to
    a.duration = over
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    l.opacity = to
    l.add(a, forKey: "tone")
    CATransaction.commit()
  }
}

/// A title drawn in another colour over it
struct Tone {
  var colour: CGColor
  var scale: CGFloat
  var layer: CALayer
}
