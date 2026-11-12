import AppKit

public final class CanvasView: NSView {
  public override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) {
    fatalError("CanvasView is not loaded from nibs")
  }
}
