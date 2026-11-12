import AppKit
import CodeBoardModel
import SwiftUI

/// The vault tree under the title line. A click shows the board in the current tab; ⌘-click, or Open in New Tab from the
/// row's menu, opens it in a new tab.
struct Sidebar: View {
  let shell: Shell

  var body: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 1) {
        if let tree = shell.tree {
          FolderContents(shell: shell, folder: tree, depth: 0)
        }
        if let error = shell.treeError {
          Text(error)
            .font(.system(size: 11.5))
            .foregroundStyle(ShellTheme.muted)
            .textSelection(.enabled)
            .padding(8)
        }
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 10)
    }
    .scrollIndicators(.automatic)
  }
}

private struct FolderContents: View {
  let shell: Shell
  let folder: VaultFolder
  let depth: Int

  var body: some View {
    ForEach(folder.folders, id: \.path) { child in
      FolderRow(shell: shell, folder: child, depth: depth)
      if shell.expanded.contains(child.path) {
        FolderContents(shell: shell, folder: child, depth: depth + 1)
      }
    }
    ForEach(folder.boards, id: \.id) { board in
      BoardRow(shell: shell, board: board, depth: depth)
    }
  }
}

private struct FolderRow: View {
  let shell: Shell
  let folder: VaultFolder
  let depth: Int

  var body: some View {
    let open = shell.expanded.contains(folder.path)
    Hover { hovered in
      Row(depth: depth, selected: false) {
        Image(systemName: "folder").font(.system(size: 13)).foregroundStyle(ShellTheme.icon)
      } label: {
        Text(folder.name)
        Spacer(minLength: 4)
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ShellTheme.faint)
          .rotationEffect(.degrees(open ? 90 : 0))
          .opacity(hovered ? 1 : 0)
      }
    }
    .onTapGesture {
      if open { shell.expanded.remove(folder.path) } else { shell.expanded.insert(folder.path) }
    }
  }
}

private struct BoardRow: View {
  let shell: Shell
  let board: VaultBoard
  let depth: Int

  var body: some View {
    let on = shell.current?.board == board.id
    Row(depth: depth, selected: on) {
      BoardIcon().stroke(on ? ShellTheme.selectedIcon : ShellTheme.icon, lineWidth: 1.2).frame(width: 15, height: 15)
    } label: {
      Text(board.title).fontWeight(on ? .semibold : .regular)
      Spacer(minLength: 0)
    }
    .onTapGesture { shell.show(board.id, newTab: NSEvent.modifierFlags.contains(.command)) }
    .contextMenu {
      Button("Open in New Tab") { shell.show(board.id, newTab: true) }
    }
  }
}

private struct Row<Icon: View, Label: View>: View {
  let depth: Int
  let selected: Bool
  @ViewBuilder var icon: Icon
  @ViewBuilder var label: Label

  var body: some View {
    HStack(spacing: 7) {
      icon.frame(width: 16, height: 16)
      label
    }
    .font(.system(size: 13))
    .foregroundStyle(ShellTheme.ink)
    .lineLimit(1)
    .truncationMode(.tail)
    .padding(.leading, 8 + CGFloat(depth) * ShellTheme.indent)
    .padding(.trailing, 8)
    .frame(height: ShellTheme.rowHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
    .capsule(selected)
    .contentShape(Rectangle())
  }
}

/// A board: a sheet with two cards on it
private struct BoardIcon: Shape {
  func path(in r: CGRect) -> Path {
    let u = r.width / 16
    var p = Path()
    p.addRoundedRect(
      in: CGRect(x: 2 * u, y: 2.5 * u, width: 12 * u, height: 11 * u), cornerSize: CGSize(width: 2 * u, height: 2 * u))
    p.addRoundedRect(
      in: CGRect(x: 4.5 * u, y: 5 * u, width: 3.5 * u, height: 2.6 * u),
      cornerSize: CGSize(width: 0.6 * u, height: 0.6 * u))
    p.addRoundedRect(
      in: CGRect(x: 8.5 * u, y: 9 * u, width: 3 * u, height: 2.2 * u),
      cornerSize: CGSize(width: 0.6 * u, height: 0.6 * u))
    return p.offsetBy(dx: r.minX, dy: r.minY)
  }
}
