import AppKit
import CodeBoardCanvas
import SwiftUI

/// The window chrome's colours and metrics, from the D2 mock; tuned on the running app, so only here. Each colour has a
/// light and a dark value and resolves itself where it is drawn, in the appearance of the view drawing it, which is the
/// app's (`Shell.dark` follows the same); a layer's colour is resolved with `cg(_:dark:)`
enum ShellTheme {
  // ponytail: the mock is light only; the dark values are Warm Ink dark's tokens (styles.css) in the roles the light
  // ones play (ink, ink-2, surface, the hairline tint), not tuned on the running app yet
  /// The window background, which the sidebar is part of
  static let ground = pair(0xeee9e0, 0x131312)
  /// The whole board panel, top bar included, is one surface with the canvas boards are shown on, in the board theme
  static func board(_ theme: Theme) -> CGColor { theme.canvas }
  static let capsule = Color(nsColor: pair(0xfdfcfa, 0x252422))
  static let ink = Color(nsColor: pair(0x211f1b, 0xece8e0))
  static let muted = Color(nsColor: pair(0x625e56, 0xaca79d))
  static let faint = Color(nsColor: pair(0xa39d92, 0x6e6a62))
  static let icon = Color(nsColor: pair(0x8a8378, 0x8a857c))
  static let selectedIcon = Color(nsColor: pair(0x9a3f22, 0xe59572))
  /// The warm brown every hairline and hover is a tint of; in dark a warm white
  static let shadeNS = pair(0x3c2d14, 0xfff0dc)
  static let shade = Color(nsColor: shadeNS)
  /// What shadows are a tint of: the warm brown, black in dark
  static let dropNS = pair(0x3c2d14, 0x000000)
  static let drop = Color(nsColor: dropNS)

  /// A colour that is `light` in a light appearance and `dark` in a dark one
  private static func pair(_ light: UInt32, _ dark: UInt32) -> NSColor {
    NSColor(name: nil) { a in
      let hex = a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
      return NSColor(
        srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
  }

  /// A colour as a layer takes it, in that appearance (a layer does not follow the appearance by itself)
  static func cg(_ color: NSColor, dark: Bool) -> CGColor {
    var out = color.cgColor
    NSAppearance(named: dark ? .darkAqua : .aqua)?.performAsCurrentDrawingAppearance { out = color.cgColor }
    return out
  }

  static let sidebarWidth: CGFloat = 244
  /// Between the panel and the window edge
  static let inset: CGFloat = 8
  static let panelRadius: CGFloat = 11
  static let rowHeight: CGFloat = 28
  static let rowRadius: CGFloat = 7
  static let indent: CGFloat = 18
  static let tabHeight: CGFloat = 28
  /// The mock's 11, widened to hold the hover close button (16 wide, 4 in) on both sides so the title stays centred
  static let tabPadding: CGFloat = 20
  static let tabMinWidth: CGFloat = 72
  static let tabMaxWidth: CGFloat = 200
  /// The frosted glass under the tabs: the system material blurred, the share of the canvas colour laid over it, and
  /// how far below the bar it dissolves into the canvas
  static let glassMaterial = NSVisualEffectView.Material.popover
  static let glassTint: CGFloat = 0.6
  static let glassDissolve: CGFloat = 14
}

extension View {
  /// The white capsule of a selected row or tab: the mock's `box-shadow: 0 0 0 .5px shade/.12, 0 1px 3px shade/.10`, a
  /// hairline ring wholly outside the fill and a soft drop
  func capsule(_ on: Bool) -> some View {
    background {
      if on {
        RoundedRectangle(cornerRadius: ShellTheme.rowRadius)
          .fill(ShellTheme.capsule)
          .shadow(color: ShellTheme.drop.opacity(0.10), radius: 1.5, x: 0, y: 1)
          .background(
            RoundedRectangle(cornerRadius: ShellTheme.rowRadius + 0.5).fill(ShellTheme.shade.opacity(0.12))
              .padding(-0.5))
      }
    }
  }
}

/// A borderless chrome button: a tint on hover, darker and a little smaller the moment it is pressed, no transitions
struct ChromeButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    Hover { hovered in
      configuration.label
        .foregroundStyle(enabled ? ShellTheme.muted : ShellTheme.faint)
        .frame(width: 28, height: 26)
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(ShellTheme.shade.opacity(configuration.isPressed ? 0.12 : hovered && enabled ? 0.06 : 0))
        )
        .scaleEffect(configuration.isPressed ? 0.97 : 1)
        .contentShape(Rectangle())
    }
  }
}

/// Hands its content whether the pointer is over it
struct Hover<Content: View>: View {
  @ViewBuilder var content: (Bool) -> Content
  @State private var on = false

  var body: some View {
    content(on).onHover { on = $0 }
  }
}
