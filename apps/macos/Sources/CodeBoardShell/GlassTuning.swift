import AppKit
import SwiftUI

// ponytail: temporary tuning panel: remove with its menu once the owner has picked values
/// The tab row's glass tuned live by hand: kept across launches under one key, so the owner can try values on the
/// running app and hand them over as one line
@MainActor final class GlassTuning {
  static let key = "debug.tabGlass"
  static let materials: [(name: String, material: NSVisualEffectView.Material)] = [
    ("popover", .popover), ("hudWindow", .hudWindow), ("fullScreenUI", .fullScreenUI), ("sidebar", .sidebar),
    ("underWindowBackground", .underWindowBackground), ("headerView", .headerView), ("titlebar", .titlebar),
    ("menu", .menu), ("toolTip", .toolTip), ("selection", .selection), ("contentBackground", .contentBackground),
    ("windowBackground", .windowBackground), ("sheet", .sheet), ("underPageBackground", .underPageBackground),
  ]
  private let shell: Shell
  private var panel: NSPanel?

  init(shell: Shell, defaults: UserDefaults = .standard) {
    self.shell = shell
    if let look = defaults.data(forKey: Self.key).flatMap({ try? JSONDecoder().decode(TopGlass.Look.self, from: $0) }) {
      shell.glass = look
    }
    track {
      // Nothing stored while the look is the compiled one, so Reset follows the defaults wherever they go
      if shell.glass == TopGlass.Look() {
        defaults.removeObject(forKey: Self.key)
      } else if let data = try? JSONEncoder().encode(shell.glass) {
        defaults.set(data, forKey: Self.key)
      }
    }
  }

  func reset() { shell.glass = TopGlass.Look() }

  /// What applies to the look's kind, as one line
  static func line(_ look: TopGlass.Look) -> String {
    let common = String(format: "tint=%.2f dissolve=%.0f", look.tint, look.dissolve)
    switch look.kind {
    case .material:
      let material = materials.first { $0.material == look.material }?.name ?? "\(look.material.rawValue)"
      let state = look.state == .active ? "active" : "followsWindowActiveState"
      return "kind=material material=\(material) \(common) emphasized=\(look.emphasized) state=\(state)"
    case .glass: return "kind=glass \(common)"
    }
  }

  func show() {
    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.orderFront(nil)
  }

  private func makePanel() -> NSPanel {
    // Non-activating and key only when a control needs it, so the main window stays key and its row looks as it will
    let panel = NSPanel(
      contentRect: .zero, styleMask: [.titled, .closable, .utilityWindow, .nonactivatingPanel], backing: .buffered,
      defer: false)
    panel.title = "Tab Row Glass"
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.isReleasedWhenClosed = false
    let host = NSHostingView(rootView: GlassPanel(shell: shell, reset: { [weak self] in self?.reset() }))
    panel.contentView = host
    panel.setContentSize(host.fittingSize)
    if !panel.setFrameUsingName("glassTuning") { panel.center() }
    panel.setFrameAutosaveName("glassTuning")
    return panel
  }

  static func menu() -> NSMenu {
    let menu = NSMenu(title: "Debug")
    // ponytail: temporary tuning panel: remove with its menu once the owner has picked values
    menu.addItem(withTitle: "Tab Row Glass…", action: #selector(AppDelegate.tuneGlass(_:)), keyEquivalent: "")
    return menu
  }
}

private struct GlassPanel: View {
  @Bindable var shell: Shell
  let reset: () -> Void

  var body: some View {
    let kind = shell.glass.kind
    Form {
      Picker("Kind", selection: $shell.glass.kind) {
        Text("Material").tag(TopGlass.Kind.material)
        Text("Clear glass").tag(TopGlass.Kind.glass)
      }
      .pickerStyle(.segmented)
      Picker("Material", selection: $shell.glass.material) {
        ForEach(GlassTuning.materials, id: \.name) { Text($0.name).tag($0.material) }
      }
      .disabled(kind != .material)
      // Rounded as they move, so what is copied is exactly what is shown
      slider("Tint", value: $shell.glass.tint, in: 0...1, step: 0.01, shown: String(format: "%.2f", shell.glass.tint))
      slider(
        "Dissolve", value: $shell.glass.dissolve, in: 0...48, step: 1,
        shown: String(format: "%.0f pt", shell.glass.dissolve))
      Group {
        Toggle("Emphasized", isOn: $shell.glass.emphasized)
        Picker("State", selection: $shell.glass.state) {
          Text("active").tag(NSVisualEffectView.State.active)
          Text("followsWindowActiveState").tag(NSVisualEffectView.State.followsWindowActiveState)
        }
      }
      .disabled(kind != .material)
      HStack {
        Button("Reset", action: reset)
        Spacer()
        Button("Copy Values") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(GlassTuning.line(shell.glass), forType: .string)
        }
      }
    }
    .padding(14)
    .frame(width: 340)
  }

  private func slider(
    _ title: String, value: Binding<CGFloat>, in range: ClosedRange<CGFloat>, step: CGFloat, shown: String
  ) -> some View {
    LabeledContent(title) {
      HStack {
        Slider(
          value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = ($0 / step).rounded() * step }),
          in: range)
        Text(shown).monospacedDigit().frame(width: 44, alignment: .trailing)
      }
    }
  }
}

extension TopGlass.Look: Codable {
  private enum CodingKeys: String, CodingKey { case kind, material, tint, dissolve, emphasized, state }

  init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init()
    // ponytail: a look stored before there were kinds is a material; drop with the panel
    if let k = try c.decodeIfPresent(String.self, forKey: .kind).flatMap(TopGlass.Kind.init) { kind = k }
    if let m = NSVisualEffectView.Material(rawValue: try c.decode(Int.self, forKey: .material)) { material = m }
    tint = try c.decode(CGFloat.self, forKey: .tint)
    dissolve = try c.decode(CGFloat.self, forKey: .dissolve)
    emphasized = try c.decode(Bool.self, forKey: .emphasized)
    if let s = NSVisualEffectView.State(rawValue: try c.decode(Int.self, forKey: .state)) { state = s }
  }

  func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(kind.rawValue, forKey: .kind)
    try c.encode(material.rawValue, forKey: .material)
    try c.encode(tint, forKey: .tint)
    try c.encode(dissolve, forKey: .dissolve)
    try c.encode(emphasized, forKey: .emphasized)
    try c.encode(state.rawValue, forKey: .state)
  }
}

// ponytail: temporary, with the panel: the kinds of glass TopGlass can be made of, so the owner can compare them
extension TopGlass {
  static func effect(_ kind: Kind) -> NSView {
    switch kind {
    case .material:
      let v = FlippedEffect()
      v.blendingMode = .withinWindow
      return v
    case .glass:
      let v = NSGlassEffectView()
      v.style = .clear
      v.cornerRadius = 0
      v.wantsLayer = true
      return v
    }
  }

  /// The look on the kind's view, with its dissolve: a material takes it as its mask image, the glass as a layer mask
  static func adopt(_ look: Look, on effect: NSView, stops: [(at: CGFloat, alpha: CGFloat)]) {
    if let v = effect as? NSVisualEffectView {
      v.material = look.material
      v.isEmphasized = look.emphasized
      v.state = look.state
      v.maskImage = mask(dissolve: look.dissolve)
      return
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let mask = effect.layer?.mask as? CAGradientLayer ?? CAGradientLayer()
    mask.colors = stops.map { CGColor(gray: 0, alpha: $0.alpha) }
    mask.locations = stops.map { NSNumber(value: Double($0.at)) }
    // the glass's layer is y-up
    mask.startPoint = CGPoint(x: 0.5, y: 1)
    mask.endPoint = CGPoint(x: 0.5, y: 0)
    mask.frame = effect.bounds
    effect.layer?.mask = mask
    CATransaction.commit()
  }
}

/// A material lays its mask image out in its own coordinates, and the mask is drawn y-down
private final class FlippedEffect: NSVisualEffectView {
  override var isFlipped: Bool { true }
}
