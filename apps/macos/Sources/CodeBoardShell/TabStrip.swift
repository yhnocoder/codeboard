import AppKit
import CodeBoardReading
import SwiftUI

/// A tab as a strip shows it
struct StripTab: Identifiable, Equatable {
  let id: UUID
  let title: String
  /// A preview, its title in italic
  var italic = false
}

/// What a tab strip shows and acts on: the board's tabs (the shell) or the reading pane's
@MainActor protocol TabSource: AnyObject {
  var stripTabs: [StripTab] { get }
  var selected: UUID? { get }
  func select(_ tab: UUID)
  func close(_ tab: UUID)
  func move(_ tab: UUID, to index: Int)
  /// Where a tab dragged from another window would go in this row, while it is over it
  var dropIndex: Int? { get }
  /// What a tab dragged out of the row tells; nil: tabs stay in their row
  var tabDragging: TabDragging? { get }
  /// How far the row is scrolled sideways, for where a tab dragged from another window goes
  var stripScroll: CGFloat { get set }
}

extension TabSource {
  var dropIndex: Int? { nil }
  var tabDragging: TabDragging? { nil }
}

/// A tab dragged out of its row, to another window's row of its kind or to a window of its own (WindowSet's TabDrag)
@MainActor protocol TabDragging: AnyObject {
  /// The pointer at `p` on screen drags `tab`, held `grab` from the tab's top left (y down): true once it is out of
  /// its row, where the row no longer reorders it
  func dragged(_ tab: UUID, title: String, at p: CGPoint, grab: CGPoint) -> Bool
  /// Let go at `p`
  func dropped(_ tab: UUID, at p: CGPoint)
}

extension Shell: TabSource {
  var stripTabs: [StripTab] { tabs.map { StripTab(id: $0.id, title: board($0.board)?.title ?? "") } }
  var dropIndex: Int? { tabDrop }
}

extension ReadingPane: TabSource {
  var stripTabs: [StripTab] { tabs.map { StripTab(id: $0.id, title: $0.title, italic: $0.preview) } }
  var dropIndex: Int? { tabDrop }
  var tabDragging: TabDragging? { tabDragger as? TabDragging }
}

/// Where a strip's tabs measure their frames
private let tabSpace = "tabs"

/// The tabs in a panel's top bar, the board's and the reading pane's alike: a click selects on mouse down, a drag
/// reorders, the strip scrolls sideways with faded edges when it overflows and keeps the selected tab in view
struct TabStrip<Source: TabSource>: View {
  let source: Source
  @State private var frames: [Tab.ID: CGRect] = [:]
  @State private var drag: (tab: Tab.ID, grabX: CGFloat, dx: CGFloat)?
  /// The tab dragged out of the row, faded where it was
  @State private var out: Tab.ID?
  /// Whether there is more strip beyond the left and right edge
  @State private var more = [false, false]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 2) {
          let tabs = source.stripTabs
          ForEach(tabs) { tab in
            TabItem(
              title: tab.title, italic: tab.italic, selected: tab.id == source.selected, close: { source.close(tab.id) }
            )
            .id(tab.id)
            .opacity(out == tab.id ? 0.35 : 1)
            .overlay(alignment: .leading) { if source.dropIndex == tabs.firstIndex(of: tab) { dropMark.offset(x: -2) } }
            .overlay(alignment: .trailing) {
              if source.dropIndex == tabs.count, tab == tabs.last { dropMark.offset(x: 2) }
            }
            .offset(x: offset(of: tab.id))
            .zIndex(drag?.tab == tab.id ? 1 : 0)
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(tabSpace)) }) { frames[tab.id] = $0 }
            .gesture(reorder(tab.id))
          }
        }
        .padding(.horizontal, ShellTheme.stripPadding)
        .frame(maxHeight: .infinity)
        .coordinateSpace(.named(tabSpace))
      }
      .scrollIndicators(.never)
      .onScrollGeometryChange(
        for: [Bool].self,
        of: { [$0.contentOffset.x > 0.5, $0.contentOffset.x + $0.containerSize.width < $0.contentSize.width - 0.5] }
      ) { more = $1 }
      .onScrollGeometryChange(for: CGFloat.self, of: { $0.contentOffset.x }) { source.stripScroll = $1 }
      .mask(fades)
      .onChange(of: source.selected) { _, tab in
        if let tab { withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo(tab) } }
      }
      // Titles, and so widths, may arrive later (a board's with the tree: restored tabs have none before it)
      .onChange(of: source.stripTabs.map(\.title)) {
        if let tab = source.selected { proxy.scrollTo(tab) }
      }
    }
  }

  /// Where a tab from another window would go
  private var dropMark: some View {
    Capsule().fill(ShellTheme.ink).frame(width: 2, height: ShellTheme.tabHeight - 6)
  }

  private func offset(of tab: Tab.ID) -> CGFloat {
    guard let drag, drag.tab == tab, out != tab, let frame = frames[tab] else { return 0 }
    return drag.grabX + drag.dx - frame.minX
  }

  /// Each edge fades only while there is more strip beyond it
  private var fades: some View {
    HStack(spacing: 0) {
      LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
        .frame(width: more[0] ? 24 : 0)
      Color.black
      LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
        .frame(width: more[1] ? 24 : 0)
    }
  }

  private func reorder(_ tab: Tab.ID) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .named(tabSpace))
      .onChanged { value in
        if drag?.tab != tab {
          source.select(tab)
          drag = (tab, frames[tab]?.minX ?? 0, 0)
        }
        drag?.dx = abs(value.translation.width) < 4 && drag?.dx == 0 ? 0 : value.translation.width
        let tabs = source.stripTabs
        // out of the row: the window set takes it from here
        if let d = source.tabDragging, let drag, let frame = frames[tab],
          d.dragged(
            tab, title: tabs.first { $0.id == tab }?.title ?? "", at: NSEvent.mouseLocation,
            grab: CGPoint(x: value.startLocation.x - drag.grabX, y: value.startLocation.y - frame.minY))
        {
          out = tab
          return
        }
        guard let drag, let i = tabs.firstIndex(where: { $0.id == tab }), let frame = frames[tab] else { return }
        let center = drag.grabX + drag.dx + frame.width / 2
        if i + 1 < tabs.count, let next = frames[tabs[i + 1].id], center > next.midX {
          withAnimation(.snappy(duration: 0.18)) { source.move(tab, to: i + 1) }
        } else if i > 0, let prev = frames[tabs[i - 1].id], center < prev.midX {
          withAnimation(.snappy(duration: 0.18)) { source.move(tab, to: i - 1) }
        }
      }
      .onEnded { _ in
        source.tabDragging?.dropped(tab, at: NSEvent.mouseLocation)
        guard out != tab else {
          out = nil
          drag = nil
          return
        }
        withAnimation(.snappy(duration: 0.18)) { drag = nil }
      }
  }
}

/// Sized to its title in the selected weight, so selecting never moves its neighbours. The close button appears on hover
/// at the leading edge (where macOS tabs keep it), in padding wide enough to hold it, so nothing shifts or hides
struct TabItem: View {
  let title: String
  let italic: Bool
  let selected: Bool
  let close: () -> Void

  var body: some View {
    Hover { hovered in
      Text(title)
        .font(.system(size: 12, weight: selected ? .semibold : .regular))
        .italic(italic)
        .foregroundStyle(selected ? ShellTheme.ink : ShellTheme.muted)
        .lineLimit(1)
        .truncationMode(.tail)
        .padding(.horizontal, ShellTheme.tabPadding)
        .frame(width: Self.width(of: title), height: ShellTheme.tabHeight)
        .overlay(alignment: .leading) {
          Hover { over in
            Button(action: close) {
              Image(systemName: "xmark").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(ShellTheme.muted)
                .frame(width: 16, height: 16)
                .background(Circle().fill(ShellTheme.shade.opacity(over ? 0.1 : 0)))
            }
            .buttonStyle(.plain)
          }
          .padding(.leading, 4)
          .opacity(hovered ? 1 : 0)
          .help("Close Tab")
        }
        .background {
          if hovered && !selected {
            RoundedRectangle(cornerRadius: ShellTheme.rowRadius, style: .continuous)
              .fill(ShellTheme.shade.opacity(0.05))
          }
        }
        .capsule(selected)
        .contentShape(Rectangle())
    }
  }

  static func width(of title: String) -> CGFloat {
    let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
    let text = ceil(NSAttributedString(string: title, attributes: [.font: font]).size().width)
    return min(max(text + 2 * ShellTheme.tabPadding, ShellTheme.tabMinWidth), ShellTheme.tabMaxWidth)
  }
}
