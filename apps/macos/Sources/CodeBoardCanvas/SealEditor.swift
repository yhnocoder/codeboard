import AppKit
import CodeBoardModel
import SwiftUI

/// The eight seal colours (styles.css --seal-*, the same in every board theme), light and dark
public enum SealPalette {
  public static func color(_ c: Seal.Color) -> NSColor {
    let (light, dark): (UInt32, UInt32) =
      switch c {
      case .vermilion: (0x945b4a, 0xc69281)
      case .amber: (0x7d6635, 0xbaa475)
      case .olive: (0x59633f, 0x9ea67f)
      case .teal: (0x3b6461, 0x7ca7a2)
      case .ink: (0x4c6383, 0x9cb0ca)
      case .plum: (0x715474, 0xb79cb9)
      case .rose: (0x94616e, 0xcea4ae)
      case .graphite: (0x5b5752, 0xaba69e)
      }
    return NSColor(name: nil) { a in
      let hex = a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
      return NSColor(
        srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
  }
}

/// A seal as the sidebar and the Mark popover draw it: its letters on a 12 % tint of its colour, or solid. Latin text is
/// centred on its capitals; CJK text on its whole height, one point larger.
public struct SealBadge: View {
  let text: String
  let color: Seal.Color
  let solid: Bool
  /// Its height; the letters are 9/14 of it
  let height: CGFloat

  public init(text: String, color: Seal.Color, solid: Bool, height: CGFloat = 14) {
    self.text = text
    self.color = color
    self.solid = solid
    self.height = height
  }

  public var body: some View {
    let cjk = text.unicodeScalars.contains(where: Seal.isCJK)
    let size = height * 9 / 14 + (cjk ? height / 14 : 0)
    let font = NSFont.systemFont(ofSize: size, weight: .semibold)
    // the line box is centred; the capitals' middle sits this much above its middle
    let lift = cjk ? 0 : (font.ascender + font.descender - font.capHeight) / 2
    let c = Color(nsColor: SealPalette.color(color))
    Text(text)
      .font(SwiftUI.Font(font))
      .tracking(size * 0.02)
      .fixedSize()
      .offset(y: lift)
      .foregroundStyle(solid ? Color(nsColor: .textBackgroundColor) : c)
      .padding(.horizontal, height * 0.3)
      .frame(minWidth: height, minHeight: height, maxHeight: height)
      .background(RoundedRectangle(cornerRadius: height * 0.22).fill(c.opacity(solid ? 1 : 0.12)))
  }
}

/// Edit Mark…: a large preview of the seal with the board's name, the seal's text (the default as its placeholder) and
/// its eight colours. Every change is applied at once (`apply(seal, false)`); Return or closing it keeps the last one,
/// Esc puts back what it was (`apply(_, true)` once, when it closes). While a text is being composed nothing is applied.
public struct SealEditor: View {
  let id: BoardID
  let name: String
  let original: Seal?
  /// Another board in the same book drawn with this seal
  let clash: (String, Seal.Color) -> String?
  let apply: (Seal?, _ done: Bool) -> Void
  let dismiss: () -> Void
  @State private var text: String
  @State private var color: Seal.Color
  @State private var finished = false

  public init(
    id: BoardID, name: String, seal: Seal?, clash: @escaping (String, Seal.Color) -> String?,
    apply: @escaping (Seal?, Bool) -> Void, dismiss: @escaping () -> Void
  ) {
    self.id = id
    self.name = name
    original = seal
    self.clash = clash
    self.apply = apply
    self.dismiss = dismiss
    _text = State(initialValue: seal?.text ?? "")
    _color = State(initialValue: seal?.color ?? Seal.defaultColor(id))
  }

  private var kept: Seal? { Seal.keep(id: id, name: name, text: text, color: color) }

  public var body: some View {
    let shown = Seal.of(id: id, name: name, seal: kept)
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        SealBadge(text: shown.text, color: shown.color, solid: true, height: 32)
        Text(name).font(.system(size: 12.5, weight: .semibold)).lineLimit(1).truncationMode(.tail)
      }
      NameField(
        text: text, placeholder: Seal.defaultText(name.trimmingCharacters(in: .whitespacesAndNewlines)),
        clean: Seal.clean,
        changed: { t in
          text = t
          apply(kept, false)
        },
        commit: { _ in finish(kept) }, cancel: { finish(original) }
      )
      .frame(height: 22)
      HStack(spacing: 8) {
        ForEach(Seal.Color.allCases, id: \.self) { c in
          Circle()
            .fill(Color(nsColor: SealPalette.color(c)))
            .frame(width: 18, height: 18)
            .padding(2)
            .overlay(Circle().strokeBorder(Color.primary.opacity(c == color ? 0.7 : 0), lineWidth: 1.5))
            .contentShape(Circle())
            .onTapGesture {
              color = c
              apply(kept, false)
            }
        }
      }
      if let other = clash(shown.text, shown.color) {
        Text("Also used by \(other)").font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
      }
    }
    .padding(12)
    .frame(width: 236, alignment: .leading)
    .onDisappear { if !finished { apply(kept, true) } }
  }

  private func finish(_ seal: Seal?) {
    guard !finished else { return }
    finished = true
    apply(seal, true)
    dismiss()
  }
}

/// A one-line field that hands on what is typed only once a composition (an input method's marked text) has ended,
/// cleaned by `clean` then; Return commits, Esc cancels, losing focus commits
public struct NameField: NSViewRepresentable {
  let text: String
  let placeholder: String
  let clean: (String) -> String
  let changed: (String) -> Void
  let commit: (String) -> Void
  let cancel: () -> Void
  let font: NSFont

  public init(
    text: String, placeholder: String = "", font: NSFont = .systemFont(ofSize: 13), clean: @escaping (String) -> String,
    changed: @escaping (String) -> Void = { _ in }, commit: @escaping (String) -> Void, cancel: @escaping () -> Void
  ) {
    self.text = text
    self.placeholder = placeholder
    self.font = font
    self.clean = clean
    self.changed = changed
    self.commit = commit
    self.cancel = cancel
  }

  public func makeNSView(context: Context) -> NSTextField {
    let f = NSTextField(string: text)
    f.placeholderString = placeholder
    f.font = font
    f.focusRingType = .none
    f.bezelStyle = .roundedBezel
    f.delegate = context.coordinator
    f.lineBreakMode = .byTruncatingTail
    f.cell?.isScrollable = true
    DispatchQueue.main.async {
      f.window?.makeFirstResponder(f)
      f.currentEditor()?.selectAll(nil)
    }
    return f
  }

  public func updateNSView(_ f: NSTextField, context: Context) {
    context.coordinator.field = self
  }

  public func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor public final class Coordinator: NSObject, NSTextFieldDelegate {
    var field: NameField
    private var done = false

    init(_ field: NameField) { self.field = field }

    public func controlTextDidChange(_ n: Notification) {
      guard let f = n.object as? NSTextField, let editor = f.currentEditor() as? NSTextView,
        !editor.hasMarkedText()
      else { return }
      let c = field.clean(f.stringValue)
      if c != f.stringValue { f.stringValue = c }
      field.changed(c)
    }

    public func controlTextDidEndEditing(_ n: Notification) {
      guard !done, let f = n.object as? NSTextField else { return }
      done = true
      field.commit(f.stringValue)
    }

    public func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
      switch sel {
      case #selector(NSResponder.cancelOperation(_:)):
        done = true
        field.cancel()
        return true
      case #selector(NSResponder.insertNewline(_:)):
        done = true
        field.commit(field.clean(textView.string))
        return true
      default:
        return false
      }
    }
  }
}
