import AppKit
import CodeBoardCanvas
import CodeBoardModel
import SwiftUI

/// The vault tree under the title line: the vault's own row, then its folders and boards. A click shows a board in the
/// current tab (⌘-click: a new tab); a folder's name opens its folder board when it has one, its triangle only opens
/// and closes it; a double-click on a name renames it in place. Boards and folders are dragged between folders. Each
/// board, and each folder with a folder board, has its seal at the far right; clicking it edits the seal.
struct Sidebar: View {
  let shell: Shell

  var body: some View {
    ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 1) {
        if let tree = shell.tree {
          RootRow(shell: shell)
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

/// Whether the click that ended is the second of a double-click
@MainActor private var isDoubleClick: Bool { (NSApp.currentEvent?.clickCount ?? 1) >= 2 }

@MainActor private func drop(_ items: [String], into folder: String, _ shell: Shell) -> Bool {
  items.compactMap(VaultDrag.path).reduce(false) { ok, p in shell.move(p, into: folder) != nil || ok }
}

/// The vault itself: its name; on hover a new board and a new folder in it. Dropping on it moves to the top.
private struct RootRow: View {
  let shell: Shell
  @State private var target = false

  var body: some View {
    Hover { hovered in
      HStack(spacing: 0) {
        Text(shell.vault?.root.lastPathComponent ?? "")
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(ShellTheme.muted)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        if hovered {
          RowButton {
            Image(systemName: "plus")
          } action: {
            shell.newBoard(in: "")
          }
          RowButton {
            Image(systemName: "folder.badge.plus")
          } action: {
            shell.newFolder(in: "")
          }
        }
      }
      .padding(.leading, 8)
      .padding(.trailing, 6)
      .frame(height: ShellTheme.rowHeight)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(DropRing(on: target))
      .contentShape(Rectangle())
    }
    .dropDestination(for: String.self) { items, _ in
      drop(items, into: "", shell)
    } isTargeted: {
      target = $0
    }
  }
}

private struct FolderRow: View {
  let shell: Shell
  let folder: VaultFolder
  let depth: Int
  @State private var target = false

  var body: some View {
    let open = shell.expanded.contains(folder.path)
    let own = folder.folderBoard
    let on = own != nil && shell.current?.board == own?.id
    Hover { hovered in
      Row(depth: depth, selected: on, target: target) {
        Image(systemName: "chevron.right")
          .font(.system(size: 8.5, weight: .semibold))
          .foregroundStyle(ShellTheme.faint)
          .rotationEffect(.degrees(open ? 90 : 0))
          .frame(width: 14, height: ShellTheme.rowHeight)
          .contentShape(Rectangle())
          .onTapGesture { toggle() }
        Image(systemName: "folder").font(.system(size: 13))
          .foregroundStyle(on ? ShellTheme.selectedIcon : ShellTheme.icon)
          .frame(width: 16)
      } label: {
        Name(shell: shell, renaming: .folder(folder.path), text: folder.name, bold: on) {
          shell.rename(folder: folder.path, to: $0)
        }
      } trailing: {
        if hovered && shell.renaming == nil {
          RowButton {
            Image(systemName: "plus")
          } action: {
            shell.newBoard(in: folder.path)
          }
          RowButton {
            Image(systemName: "folder.badge.plus")
          } action: {
            shell.newFolder(in: folder.path)
          }
          if own == nil {
            RowButton {
              BoardIcon().stroke(lineWidth: 1.2).frame(width: 14, height: 14)
            } action: {
              shell.newFolderBoard(in: folder.path)
            }
          }
        }
        if let own { SealSlot(shell: shell, board: own, lit: hovered || on) }
      }
    }
    .onTapGesture {
      if isDoubleClick {
        shell.renaming = .folder(folder.path)
      } else if let own {
        shell.show(own.id, newTab: NSEvent.modifierFlags.contains(.command))
      } else {
        toggle()
      }
    }
    .draggable(VaultDrag.payload(folder.path))
    .dropDestination(for: String.self) { items, _ in
      drop(items, into: folder.path, shell)
    } isTargeted: {
      target = $0
    }
    .contextMenu {
      Button("New Board") { shell.newBoard(in: folder.path) }
      Button("New Folder") { shell.newFolder(in: folder.path) }
      Divider()
      Button("Rename") { shell.renaming = .folder(folder.path) }
      Divider()
      if let own { Button("Delete Folder Board") { shell.trash(own.path) } }
      Button("Delete Folder") { shell.trash(folder.path) }
    }
  }

  private func toggle() {
    if shell.expanded.contains(folder.path) {
      shell.expanded.remove(folder.path)
    } else {
      shell.expanded.insert(folder.path)
    }
  }
}

private struct BoardRow: View {
  let shell: Shell
  let board: VaultBoard
  let depth: Int

  var body: some View {
    let on = shell.current?.board == board.id
    Hover { hovered in
      Row(depth: depth, selected: on, target: false) {
        Color.clear.frame(width: 14, height: 1)
        BoardIcon().stroke(on ? ShellTheme.selectedIcon : ShellTheme.icon, lineWidth: 1.2).frame(width: 16, height: 16)
      } label: {
        Name(shell: shell, renaming: .board(board.id), text: board.title, bold: on) {
          shell.rename(board: board, to: $0)
        }
      } trailing: {
        SealSlot(shell: shell, board: board, lit: hovered || on)
      }
    }
    .onTapGesture {
      if isDoubleClick {
        shell.renaming = .board(board.id)
      } else {
        shell.show(board.id, newTab: NSEvent.modifierFlags.contains(.command))
      }
    }
    .draggable(VaultDrag.payload(board.path))
    .contextMenu {
      Button("Rename") { shell.renaming = .board(board.id) }
      Button("Edit Mark…") { shell.sealEditing = board.id }
      Divider()
      Button("Delete") { shell.trash(board.path) }
    }
  }
}

/// A row's name, or the field it is renamed in
private struct Name: View {
  let shell: Shell
  let renaming: Shell.Renaming
  let text: String
  let bold: Bool
  let rename: (String) -> Void

  var body: some View {
    if shell.renaming == renaming {
      NameField(
        text: text, clean: { $0 },
        commit: { t in
          shell.renaming = nil
          rename(t)
        },
        cancel: { shell.renaming = nil }
      )
      .frame(height: 20)
    } else {
      Text(text).fontWeight(bold ? .semibold : .regular).lineLimit(1).truncationMode(.tail)
    }
  }
}

/// A board's seal at the far right of its row, solid while the row is hovered, the board is open or its seal is being
/// edited; a click edits it in a popover beside it
private struct SealSlot: View {
  let shell: Shell
  let board: VaultBoard
  let lit: Bool

  var body: some View {
    let s = board.drawnSeal
    let editing = shell.sealEditing == board.id
    SealBadge(text: s.text, color: s.color, solid: lit || editing)
      .fixedSize()
      .contentShape(Rectangle())
      .onTapGesture { shell.sealEditing = board.id }
      .popover(
        isPresented: Binding(
          get: { shell.sealEditing == board.id },
          set: { if !$0, shell.sealEditing == board.id { shell.sealEditing = nil } }),
        arrowEdge: .trailing
      ) {
        SealEditor(
          id: board.id, name: board.title, seal: board.seal,
          clash: { t, c in shell.tree?.sealClash(board.id, t, c)?.title },
          apply: { seal, done in shell.setSeal?(board.id, seal, done) },
          dismiss: { shell.sealEditing = nil })
      }
  }
}

private struct Row<Lead: View, Label: View, Trailing: View>: View {
  let depth: Int
  let selected: Bool
  let target: Bool
  @ViewBuilder var lead: Lead
  @ViewBuilder var label: Label
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 0) {
      lead
      label.padding(.leading, 7).layoutPriority(-1)
      Spacer(minLength: 4)
      HStack(spacing: 2) { trailing }.fixedSize()
    }
    .font(.system(size: 13))
    .foregroundStyle(ShellTheme.ink)
    .padding(.leading, 2 + CGFloat(depth) * ShellTheme.indent)
    .padding(.trailing, 6)
    .frame(height: ShellTheme.rowHeight)
    .frame(maxWidth: .infinity, alignment: .leading)
    .capsule(selected)
    .background(DropRing(on: target))
    .contentShape(Rectangle())
  }
}

/// The ring a row shows while something dragged over it would go into it
private struct DropRing: View {
  let on: Bool

  var body: some View {
    RoundedRectangle(cornerRadius: ShellTheme.rowRadius)
      .strokeBorder(ShellTheme.shade.opacity(on ? 0.35 : 0), lineWidth: 1.5)
  }
}

/// A small icon button in a row, shown on hover
private struct RowButton<Label: View>: View {
  @ViewBuilder var label: Label
  let action: () -> Void

  var body: some View {
    Button(action: action) { label.font(.system(size: 11.5, weight: .medium)) }
      .buttonStyle(RowButtonStyle())
  }
}

private struct RowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    Hover { hovered in
      configuration.label
        .foregroundStyle(ShellTheme.muted)
        .frame(width: 20, height: 20)
        .background(
          RoundedRectangle(cornerRadius: 5)
            .fill(ShellTheme.shade.opacity(configuration.isPressed ? 0.12 : hovered ? 0.07 : 0))
        )
        .contentShape(Rectangle())
    }
  }
}

/// A board: a sheet with two cards on it
struct BoardIcon: Shape {
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
