import AppKit
import CodeBoardCanvas
import CodeBoardModel
import SwiftUI

/// The window chrome drawn off screen at 2x for the review sheets (LookCompare): never in a window on screen
@MainActor package enum ShellPictures {
  /// The sidebar as the window shows it, on the window's ground
  package static func sidebar(_ shell: Shell, width: CGFloat, height: CGFloat, dark: Bool) -> CGImage? {
    draw(
      Sidebar(shell: shell).padding(.top, 8).frame(width: width, height: height, alignment: .top)
        .background(Color(nsColor: ShellTheme.ground)), dark: dark)
  }

  /// Sidebar toggle, back and forward, on the window's ground
  package static func titleControls(_ shell: Shell, dark: Bool) -> CGImage? {
    draw(TitleControls(shell: shell).padding(8).background(Color(nsColor: ShellTheme.ground)), dark: dark)
  }

  /// Any view at its own size (or the one it is given), in a light or dark appearance
  package static func draw(_ view: some View, dark: Bool) -> CGImage? {
    let host = NSHostingView(rootView: view)
    host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    let window = NSWindow(
      contentRect: CGRect(origin: CGPoint(x: -30000, y: -30000), size: host.frame.size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = host.appearance
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    defer { window.close() }
    let size = host.bounds.size
    guard
      let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2), bitsPerSample: 8,
        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
        bitsPerPixel: 0)
    else { return nil }
    rep.size = size
    host.cacheDisplay(in: host.bounds, to: rep)
    return rep.cgImage
  }
}
