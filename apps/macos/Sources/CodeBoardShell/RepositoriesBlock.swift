import AppKit
import CodeBoardWorkspace
import SwiftUI
import UniformTypeIdentifiers

/// The bottom of the sidebar, under the vault tree: the repositories added on this Mac, or the one opened, its files in
/// place of the list. The line above it is dragged to change its height; a double-click on it gives back the default
struct RepositoriesBlock: View {
  let shell: Shell
  let model: RepositoriesModel
  /// The sidebar's height
  let room: CGFloat
  /// The list's own height, measured
  @State private var content: CGFloat = 0
  @State private var asksGitHub = false

  var body: some View {
    let height = model.shown(content: RepositoriesModel.handle + ShellTheme.rowHeight + content, room: room)
    VStack(spacing: 0) {
      BlockLine(model: model, height: height, room: room)
      header.padding(.horizontal, 10)
      ScrollView(.vertical) {
        Group {
          if model.opened != nil {
            LazyVStack(alignment: .leading, spacing: 1) { files }
          } else {
            VStack(alignment: .leading, spacing: 1) { repositories }
          }
        }
        .padding(.horizontal, 10)
        .padding(.top, 1)
        .padding(.bottom, 10)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          content = $0
        }
      }
      .scrollIndicators(.automatic)
    }
    .frame(height: height, alignment: .top)
  }

  /// The list's title and its plus; an opened repository's way back, its name and its commit, in the same row
  @ViewBuilder private var header: some View {
    if let r = model.opened {
      HStack(spacing: 0) {
        RowButton {
          Image(systemName: "chevron.left")
        } action: {
          model.close()
        }
        .help("Back to Repositories")
        Text(RepositoriesModel.name(r))
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ShellTheme.ink)
          .lineLimit(1)
          .truncationMode(.middle)
          .padding(.leading, 3)
        Spacer(minLength: 8)
        Text(model.head ?? "")
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(ShellTheme.faint)
          .fixedSize()
      }
      .padding(.leading, 2)
      .padding(.trailing, 8)
      .frame(height: ShellTheme.rowHeight)
    } else {
      HStack(spacing: 0) {
        Text("Repositories")
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(ShellTheme.muted)
        Spacer(minLength: 4)
        Menu {
          Button("Add Local Folder…") { Task { await model.pickFolder() } }
          Button("Add GitHub Repository…") { asksGitHub = true }
        } label: {
          Image(systemName: "plus").font(.system(size: 11.5, weight: .medium))
        }
        .menuStyle(.button)
        .buttonStyle(RowButtonStyle())
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Add a Repository")
        .popover(isPresented: $asksGitHub, arrowEdge: .bottom) {
          GitHubForm(model: model) { asksGitHub = false }
        }
      }
      .padding(.leading, 8)
      .padding(.trailing, 6)
      .frame(height: ShellTheme.rowHeight)
    }
  }

  @ViewBuilder private var repositories: some View {
    if let problem = model.problem { Quiet(text: problem) }
    if let notice = model.notice {
      Quiet(text: notice).onTapGesture { model.notice = nil }
    }
    ForEach(model.list) { r in
      RepositoryRow(shell: shell, model: model, repository: r)
    }
    ForEach(model.clones) { c in
      CloneRow(model: model, clone: c)
    }
    if model.list.isEmpty && model.clones.isEmpty && model.problem == nil {
      Quiet(text: "Add a folder on this Mac or a repository on GitHub to read its code here.")
      EntryRow(icon: "folder.badge.plus", title: "Add Local Folder…") { Task { await model.pickFolder() } }
      EntryRow(icon: "arrow.down.circle", title: "Add GitHub Repository…") { asksGitHub = true }
    }
  }

  @ViewBuilder private var files: some View {
    ForEach(model.rows, id: \.path) { row in
      FileRow(model: model, row: row)
    }
    if model.opened != nil && model.children[""]?.isEmpty == true {
      Quiet(text: "This folder is empty or cannot be read.")
    }
  }
}

/// The line between the vault tree and the block: dragged, it sets the block's height; a double-click gives back the
/// default
private struct BlockLine: View {
  let model: RepositoriesModel
  let height: CGFloat
  let room: CGFloat
  @State private var from: CGFloat?

  var body: some View {
    Hover { hovered in
      Rectangle()
        .fill(ShellTheme.shade.opacity(hovered || from != nil ? 0.24 : 0.12))
        .frame(height: 1)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity)
        .frame(height: RepositoriesModel.handle)
        .contentShape(Rectangle())
    }
    .pointerStyle(.rowResize)
    .gesture(
      DragGesture(minimumDistance: 1, coordinateSpace: .global)
        .onChanged { g in
          let start = from ?? height
          from = start
          model.drag(to: start - g.translation.height, room: room)
        }
        .onEnded { _ in
          from = nil
          model.dragEnded()
        }
    )
    .onTapGesture(count: 2) { model.restoreHeight() }
    .accessibilityElement()
    .accessibilityIdentifier("ui-repositoriesline")
    .accessibilityLabel("Repositories Divider")
  }
}

/// One quiet line of words in the block
private struct Quiet: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 11.5))
      .foregroundStyle(ShellTheme.muted)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// An entry point of the empty list, as a row
private struct EntryRow: View {
  let icon: String
  let title: String
  let action: () -> Void

  var body: some View {
    Hover { hovered in
      Row(depth: 0, selected: false, target: false) {
        Color.clear.frame(width: 14, height: 1)
        Image(systemName: icon).font(.system(size: 12)).foregroundStyle(ShellTheme.icon).frame(width: 16, height: 16)
      } label: {
        Text(title).foregroundStyle(ShellTheme.muted)
      } trailing: {
        EmptyView()
      }
      .background(
        RoundedRectangle(cornerRadius: ShellTheme.rowRadius, style: .continuous)
          .fill(ShellTheme.shade.opacity(hovered ? 0.06 : 0)))
    }
    .onTapGesture(perform: action)
  }
}

/// An added repository: a laptop for a folder on this Mac, a download for a clone; a click opens it, its menu removes it
private struct RepositoryRow: View {
  let shell: Shell
  let model: RepositoriesModel
  let repository: Repository

  var body: some View {
    let clone: Bool? =
      switch repository.kind {
      case .folder: nil
      case .clone(let lightweight): lightweight
      }
    Row(depth: 0, selected: false, target: false) {
      Color.clear.frame(width: 14, height: 1)
      Image(systemName: clone == nil ? "laptopcomputer" : "arrow.down.circle").font(.system(size: 12))
        .foregroundStyle(ShellTheme.icon)
        .frame(width: 16, height: 16)
    } label: {
      Text(RepositoriesModel.name(repository)).lineLimit(1).truncationMode(.middle)
    } trailing: {
      EmptyView()
    }
    .help(
      clone == nil
        ? repository.path
        : clone == true
          ? "Lightweight clone: commit history only, file contents downloaded when read" : "Full clone"
    )
    .onTapGesture { Task { await model.open(repository) } }
    .contextMenu {
      Button("Remove…") { Task { await model.remove(repository, confirm: shell.confirm) } }
    }
  }
}

/// A clone under way, a spinner in place of its icon and a cross that stops it; failed, why under it until dismissed
private struct CloneRow: View {
  let model: RepositoriesModel
  let clone: RepositoriesModel.Clone

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Row(depth: 0, selected: false, target: false) {
        Color.clear.frame(width: 14, height: 1)
        Group {
          if clone.error == nil {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(ShellTheme.muted)
          }
        }
        .frame(width: 16, height: 16)
      } label: {
        Text(clone.name).lineLimit(1).truncationMode(.middle).foregroundStyle(ShellTheme.muted)
      } trailing: {
        RowButton {
          Image(systemName: "xmark")
        } action: {
          model.cancel(clone.id)
        }
        .help(clone.error == nil ? "Stop Cloning" : "Dismiss")
      }
      if let error = clone.error {
        Text(error)
          .font(.system(size: 11.5))
          .foregroundStyle(ShellTheme.muted)
          .lineLimit(3)
          .truncationMode(.middle)
          .fixedSize(horizontal: false, vertical: true)
          .help(error)
          // under the name
          .padding(.leading, 2 + 14 + 16 + 7)
          .padding(.trailing, 6)
          .padding(.bottom, 5)
      }
    }
  }
}

/// A folder or file of the opened repository: a folder's arrow at the row's end; a file's click previews it, a
/// double-click keeps it
private struct FileRow: View {
  let model: RepositoriesModel
  let row: RepositoriesModel.TreeRow

  var body: some View {
    let on = model.selected == row.path
    let open = model.expanded.contains(row.path)
    Row(depth: row.depth, selected: on, target: false) {
      Color.clear.frame(width: 14, height: 1)
      Image(systemName: row.isFolder ? "folder" : "doc").font(.system(size: row.isFolder ? 13 : 12))
        .foregroundStyle(on ? ShellTheme.selectedIcon : ShellTheme.icon)
        .frame(width: 16)
    } label: {
      Text(row.name).fontWeight(on ? .semibold : .regular).lineLimit(1).truncationMode(.middle)
    } trailing: {
      if row.isFolder {
        Image(systemName: "chevron.right")
          .font(.system(size: 8.5, weight: .semibold))
          .foregroundStyle(ShellTheme.faint)
          .rotationEffect(.degrees(open ? 90 : 0))
          .frame(width: 14, height: ShellTheme.rowHeight)
      }
    }
    .onTapGesture {
      if row.isFolder {
        Task { await model.toggle(row.path) }
      } else {
        model.click(row.path, preview: !isDoubleClick)
      }
    }
  }
}

/// The address of a GitHub repository and how much of it to download; a wrong address is said under the field
private struct GitHubForm: View {
  let model: RepositoriesModel
  let done: () -> Void
  @State private var address = ""
  @State private var lightweight = true
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Add a GitHub Repository").font(.system(size: 13, weight: .semibold))
      VStack(alignment: .leading, spacing: 4) {
        TextField("github.com/owner/name", text: $address)
          .textFieldStyle(.roundedBorder)
          .onSubmit(add)
          .onChange(of: address) { error = nil }
        if let error {
          Text(error)
            .font(.system(size: 11.5))
            .foregroundStyle(ShellTheme.selectedIcon)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      // The system's segmented control: its choices are read by accessibility and reached with the keyboard
      Picker("Clone", selection: $lightweight) {
        Text("Lightweight").tag(true)
        Text("Full").tag(false)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .accessibilityIdentifier("repository-clone-kind")
      Text(
        lightweight
          ? "Commit history only; file contents are downloaded when read." : "Everything is downloaded at once."
      )
      .font(.system(size: 11.5)).foregroundStyle(ShellTheme.muted)
      .fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Cancel", action: done).keyboardShortcut(.cancelAction)
        Button("Add", action: add)
          .keyboardShortcut(.defaultAction)
          .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
    .padding(14)
    .frame(width: 310)
  }

  private func add() {
    if let e = model.addGitHub(address, lightweight: lightweight) { error = e } else { done() }
  }
}
