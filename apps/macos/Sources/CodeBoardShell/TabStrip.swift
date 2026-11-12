import SwiftUI

/// The board tabs in the panel's top bar: a click selects on mouse down, a drag reorders, the strip scrolls sideways
/// with faded edges when it overflows and keeps the selected tab in view
struct TabStrip: View {
  let shell: Shell
  @State private var frames: [Tab.ID: CGRect] = [:]
  @State private var drag: (tab: Tab.ID, grabX: CGFloat, dx: CGFloat)?
  /// Whether there is more strip beyond the left and right edge
  @State private var more = [false, false]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal) {
        HStack(spacing: 2) {
          ForEach(shell.tabs) { tab in
            TabItem(
              title: shell.board(tab.board)?.title ?? "", selected: tab.id == shell.selected,
              close: { shell.close(tab.id) }
            )
            .id(tab.id)
            .offset(x: offset(of: tab.id))
            .zIndex(drag?.tab == tab.id ? 1 : 0)
            .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(Self.space)) }) { frames[tab.id] = $0 }
            .gesture(reorder(tab.id))
          }
        }
        .padding(.horizontal, 2)
        .frame(maxHeight: .infinity)
        .coordinateSpace(.named(Self.space))
      }
      .scrollIndicators(.never)
      .onScrollGeometryChange(
        for: [Bool].self,
        of: { [$0.contentOffset.x > 0.5, $0.contentOffset.x + $0.containerSize.width < $0.contentSize.width - 0.5] }
      ) { more = $1 }
      .mask(fades)
      .onChange(of: shell.selected) { _, tab in
        if let tab { withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo(tab) } }
      }
      // Titles, and so widths, arrive with the tree (restored tabs have none before it)
      .onChange(of: shell.tree) {
        if let tab = shell.selected { proxy.scrollTo(tab) }
      }
    }
  }

  private nonisolated static let space = "tabs"

  private func offset(of tab: Tab.ID) -> CGFloat {
    guard let drag, drag.tab == tab, let frame = frames[tab] else { return 0 }
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
    DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space))
      .onChanged { value in
        if drag?.tab != tab {
          shell.select(tab)
          drag = (tab, frames[tab]?.minX ?? 0, 0)
        }
        drag?.dx = abs(value.translation.width) < 4 && drag?.dx == 0 ? 0 : value.translation.width
        guard let drag, let i = shell.tabs.firstIndex(where: { $0.id == tab }), let frame = frames[tab] else { return }
        let center = drag.grabX + drag.dx + frame.width / 2
        if i + 1 < shell.tabs.count, let next = frames[shell.tabs[i + 1].id], center > next.midX {
          withAnimation(.snappy(duration: 0.18)) { shell.move(tab, to: i + 1) }
        } else if i > 0, let prev = frames[shell.tabs[i - 1].id], center < prev.midX {
          withAnimation(.snappy(duration: 0.18)) { shell.move(tab, to: i - 1) }
        }
      }
      .onEnded { _ in withAnimation(.snappy(duration: 0.18)) { drag = nil } }
  }
}

private struct TabItem: View {
  let title: String
  let selected: Bool
  let close: () -> Void

  var body: some View {
    Hover { hovered in
      HStack(spacing: 4) {
        Text(title)
          .font(.system(size: 12, weight: selected ? .semibold : .regular))
          .foregroundStyle(selected ? ShellTheme.ink : ShellTheme.muted)
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(maxWidth: .infinity)
        Button(action: close) {
          Image(systemName: "xmark").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(ShellTheme.muted)
            .frame(width: 16, height: 16)
            .background(Circle().fill(ShellTheme.shade.opacity(0.08)).opacity(hovered ? 1 : 0))
        }
        .buttonStyle(.plain)
        .opacity(hovered ? 1 : 0)
        .help("Close Tab")
      }
      .padding(.leading, 11 + 20)
      .padding(.trailing, 6)
      .frame(minWidth: ShellTheme.tabMinWidth, maxWidth: ShellTheme.tabMaxWidth, minHeight: 28, maxHeight: 28)
      .fixedSize()
      .background {
        if hovered && !selected {
          RoundedRectangle(cornerRadius: ShellTheme.rowRadius).fill(ShellTheme.shade.opacity(0.05))
        }
      }
      .capsule(selected)
      .contentShape(Rectangle())
    }
  }
}
