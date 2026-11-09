// The window chrome's sizes (the design spec), the same in every look, and the shape of a look's colours (Chrome): a look is a
// board theme (the canvas's tokens, themes.json) and a chrome variant, glass or solid, each with its own set in Looks/. The
// views take sizes from Design and colours from Look.current, nowhere else.
import SwiftUI

enum Design {
  // windows
  static let libraryDefault = CGSize(width: 1180, height: 760)
  static let libraryMin = CGSize(width: 720, height: 480)
  static let sidebarWidth: (min: CGFloat, ideal: CGFloat, max: CGFloat) = (200, 240, 320)
  static let boardSidebarWidth: CGFloat = 256
  static let zoomPill = (height: CGFloat(36), inset: CGFloat(16))
  /** The glass looks' tools capsule, floating at the bottom centre */
  static let toolsDock = (height: CGFloat(40), inset: CGFloat(14))
  static let boardTitleFont = NSFont.systemFont(ofSize: 15, weight: .bold)
  static let titleMax: CGFloat = 420
  /** The toolbar row (the traffic lights' row) */
  static let toolbarRow: CGFloat = 52
  /** The board's docks in a solid look's toolbar row */
  static let dock = (height: CGFloat(36), radius: CGFloat(12), padding: CGFloat(12), spacing: CGFloat(14))
  /** The board window's sidebar rows: a thumbnail, the name, cards · when */
  static let sideRow: CGFloat = 40

  // the board grid
  static let tileMin: CGFloat = 200, tileMax: CGFloat = 240
  static let gridSpacing: CGFloat = 20, gridRowSpacing: CGFloat = 20, gridPadding: CGFloat = 28
  static let groupGap: CGFloat = 28
  static let searchFieldWidth: CGFloat = 200
  static let groupFont = Font.system(size: 13, weight: .semibold)
  static let groupCountFont = Font.system(size: 12)
  static let thumbAspect: CGFloat = 3 / 2
  static let thumbRadius: CGFloat = 12
  static let thumbShadow = (radius: CGFloat(3), y: CGFloat(1), opacity: 0.06)
  static let selectionWidth: CGFloat = 2.5, selectionGap: CGFloat = 3
  static let tileNameFont = Font.system(size: 13, weight: .semibold)
  static let tileMetaFont = Font.system(size: 11).monospacedDigit()
  static let tileNameGap: CGFloat = 9, tileTextGap: CGFloat = 2
  static let namePillRadius: CGFloat = 5
  static let moreButton: CGFloat = 26, moreFade = 0.12

  // ⌘K
  static let panelWidth: CGFloat = 680
  static let panelRadius: CGFloat = 24
  /** How much of the panel's backdrop is solid behind the glass, light / dark */
  static let panelBackdrop = (light: 0.80, dark: 0.78)
  static let panelFieldHeight: CGFloat = 56
  static let panelFieldFont = Font.system(size: 22)
  static let panelMaxList: CGFloat = 460
  static let rowHeight: CGFloat = 46
  static let rowIcon: CGFloat = 28, rowRadius: CGFloat = 9
  static let rowTitleFont = Font.system(size: 13.5, weight: .medium)
  static let rowDetailFont = Font.system(size: 12)
  static let panelGroupFont = Font.system(size: 11, weight: .semibold)
  static let faint = 0.55

  // Settings
  static let formRadius: CGFloat = 12
}

/** A look's window chrome: one set per look (Looks/), all of the same shape */
struct Chrome {
  let id: String
  let name: String
  /** The board theme the canvas and the thumbnails draw in (themes.json) */
  let board: String
  /** Liquid Glass on the toolbar's buttons, the sidebar and ⌘K; solid colours otherwise */
  let glass: Bool
  /** Which Liquid Glass (glass looks): .clear lets the canvas show through, the system dims behind icons where it needs to */
  let glassStyle: NSGlassEffectView.Style
  /** System buttons, selection, the picked board's ring */
  let accent: NSColor
  /** Selected rows (⌘K) */
  let tint: NSColor
  /** The library's grid and the Settings window behind the groups */
  let content: NSColor
  /** nil: the system's sidebar material */
  let sidebar: NSColor?
  /** nil: the system's glass toolbar */
  let toolbar: NSColor?
  /** ⌘K's backdrop (clear in a glass look: the glass stays see-through) */
  let panel: NSColor
  /** Grouped forms, the hover button */
  let surface: NSColor
  let hair: NSColor
  /** The sidebar set in the board's serif (Ink Wash: Song, as the board's titles) */
  let serif: Bool

  static let all: [Chrome] = [.warmInk, .warmInkGlass, .inkWash, .inkWashGlass]
}

/** The look the app draws in (the Settings picker): SwiftUI views observe it, AppKit windows hear .codeboardSettings "look" */
@MainActor
final class Look: ObservableObject {
  static let shared = Look()
  static var current: Chrome { shared.chrome }
  @Published private(set) var chrome: Chrome
  private init() {
    chrome = Chrome.all.first { $0.id == Home.defaults.string(forKey: "codeboard.mac.look") } ?? .warmInkGlass
    Theme.look = chrome.board
  }
  func set(_ id: String) {
    guard let c = Chrome.all.first(where: { $0.id == id }), c.id != chrome.id else { return }
    Home.defaults.set(id, forKey: "codeboard.mac.look")
    chrome = c
    Theme.look = c.board
    NotificationCenter.default.post(name: .codeboardSettings, object: "look")
  }
}

extension NSColor {
  var color: Color { Color(nsColor: self) }
}

extension Chrome {
  /** The same glass for SwiftUI's .glassEffect */
  var swiftUIGlass: Glass { glassStyle == .clear ? .clear : .regular }
}
