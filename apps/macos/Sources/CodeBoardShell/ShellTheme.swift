import AppKit
import SwiftUI

/// The window chrome's colours and metrics, from the D2 mock; tuned on the running app, so only here
enum ShellTheme {
  /// The window background, which the sidebar is part of
  static let ground = NSColor(srgbRed: 0.933, green: 0.914, blue: 0.878, alpha: 1)
  /// The board panel and its top bar: the canvas colour
  static let canvas = NSColor(srgbRed: 0.973, green: 0.965, blue: 0.945, alpha: 1)
  static let capsule = Color(red: 0.992, green: 0.988, blue: 0.980)
  static let ink = Color(red: 0.129, green: 0.122, blue: 0.106)
  static let muted = Color(red: 0.384, green: 0.369, blue: 0.337)
  static let faint = Color(red: 0.639, green: 0.616, blue: 0.573)
  static let icon = Color(red: 0.541, green: 0.514, blue: 0.471)
  static let selectedIcon = Color(red: 0.604, green: 0.247, blue: 0.133)
  /// The warm brown every hairline, hover and shadow is a tint of
  static let shade = Color(red: 60 / 255, green: 45 / 255, blue: 20 / 255)
  static let shadeNS = NSColor(srgbRed: 60 / 255, green: 45 / 255, blue: 20 / 255, alpha: 1)

  static let sidebarWidth: CGFloat = 244
  /// Between the panel and the window edge
  static let inset: CGFloat = 8
  static let panelRadius: CGFloat = 11
  static let rowHeight: CGFloat = 28
  static let rowRadius: CGFloat = 7
  static let indent: CGFloat = 18
  static let tabMinWidth: CGFloat = 104
  static let tabMaxWidth: CGFloat = 220
}

extension View {
  /// The white capsule of a selected row or tab
  func capsule(_ on: Bool) -> some View {
    background {
      if on {
        RoundedRectangle(cornerRadius: ShellTheme.rowRadius)
          .fill(ShellTheme.capsule)
          .shadow(color: ShellTheme.shade.opacity(0.10), radius: 1.5, x: 0, y: 1)
          .overlay(
            RoundedRectangle(cornerRadius: ShellTheme.rowRadius).stroke(ShellTheme.shade.opacity(0.12), lineWidth: 0.5))
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
