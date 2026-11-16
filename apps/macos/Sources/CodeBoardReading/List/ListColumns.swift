import AppKit
import CodeBoardModel
import CodeBoardResources

/// A column of a resource's list, described by what it reads from a row and how it orders rows: a preset's columns are
/// a list of these, so a field the user adds later is one more
struct ListColumn {
  var id: String
  var title: String
  var width: CGFloat
  var minWidth: CGFloat = 48
  /// What its cell says
  var value: (ListRow) -> String
  /// A second, quieter line under it; nil: one line
  var detail: ((ListRow) -> String)?
  /// The filter looks in its value and detail
  var searched = false
  /// Rows in ascending order; equal ones keep Finder's order
  var order: (ListRow, ListRow) -> Bool
  /// Which way a first click on its header sorts
  var ascending = true
  /// Rows it says nothing for, sorted after the others whichever way; nil: none are
  var blank: ((ListRow) -> Bool)?
  /// The resource's field it shows; nil: one of the preset's
  var field: Resource.Field?
}

extension ListColumn {
  static func title(_ name: String, detail: ((ListRow) -> String)?) -> ListColumn {
    ListColumn(
      id: "title", title: name, width: 300, minWidth: 120, value: \.title, detail: detail, searched: true,
      order: { $0.title.localizedStandardCompare($1.title) == .orderedAscending })
  }

  static var papers: [ListColumn] {
    [
      // the second line: the authors, then where it was published
      title(
        "Title",
        detail: {
          ([$0.authors.joined(separator: ", ")] + [$0.venue ?? ""]).filter { !$0.isEmpty }.joined(separator: " · ")
        }),
      ListColumn(
        id: "year", title: "Year", width: 56, minWidth: 44, value: { $0.year.map(String.init) ?? "" },
        order: { ($0.year ?? .min) < ($1.year ?? .min) }, ascending: false),
      boards,
    ]
  }

  static var web: [ListColumn] {
    [
      title("Title", detail: { $0.site ?? "" }),
      date("saved", "Saved", \.saved),
      boards,
    ]
  }

  static var files: [ListColumn] {
    [
      title("Name", detail: nil),
      ListColumn(
        id: "size", title: "Size", width: 84, value: { $0.size.map(ListColumn.size) ?? "" },
        order: { ($0.size ?? -1) < ($1.size ?? -1) }, ascending: false),
      date("modified", "Modified", \.modified),
      boards,
    ]
  }

  static var boards: ListColumn {
    ListColumn(
      id: "boards", title: "Boards", width: 150, minWidth: 64, value: { $0.boards.joined(separator: ", ") },
      order: { ($0.boards.count, $0.boards.joined()) < ($1.boards.count, $1.boards.joined()) }, ascending: false)
  }

  static func date(_ id: String, _ title: String, _ date: KeyPath<ListRow, Date?>) -> ListColumn {
    ListColumn(
      id: id, title: title, width: 104, value: { $0[keyPath: date].map(ListColumn.day) ?? "" },
      order: { ($0[keyPath: date] ?? .distantPast) < ($1[keyPath: date] ?? .distantPast) }, ascending: false)
  }

  static func day(_ d: Date) -> String { d.formatted(date: .numeric, time: .omitted) }
  static func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }

  /// A preset's columns
  static func of(_ preset: ResourcePreset) -> [ListColumn] {
    switch preset {
    case .papers: papers
    case .web: web
    // images (until their grid) list as files do
    case .files, .images: files
    case .blank: [title("Title", detail: nil)]
    }
  }

  /// How a preset's list is sorted until a header is clicked: papers newest year first, then by title; the others
  /// newest first
  static func defaultSort(_ preset: ResourcePreset) -> [NSSortDescriptor] {
    switch preset {
    case .papers: [NSSortDescriptor(key: "year", ascending: false), NSSortDescriptor(key: "title", ascending: true)]
    case .web: [NSSortDescriptor(key: "saved", ascending: false)]
    case .files, .images: [NSSortDescriptor(key: "modified", ascending: false)]
    case .blank: [NSSortDescriptor(key: "title", ascending: true)]
    }
  }
}

extension [ListColumn] {
  /// `rows` in the order `sort` gives (its first descriptor first, then the next for ties), ties in Finder's order
  func sorted(_ rows: [ListRow], by sort: [NSSortDescriptor]) -> [ListRow] {
    let keys = sort.compactMap { d in first { $0.id == d.key }.map { ($0.order, d.ascending, $0.blank) } }
    return rows.enumerated().sorted { a, b in
      for (less, up, blank) in keys {
        if let blank {
          let (x, y) = (blank(a.element), blank(b.element))
          if x != y { return y }
          if x { continue }
        }
        if less(a.element, b.element) { return up }
        if less(b.element, a.element) { return !up }
      }
      return a.offset < b.offset
    }.map(\.element)
  }

  /// The rows whose searched columns say `query`, ignoring case and accents; every row for an empty query
  func filtered(_ rows: [ListRow], by query: String) -> [ListRow] {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return rows }
    let searched = filter(\.searched)
    return rows.filter { row in
      searched.contains { c in
        [c.value(row), c.detail?(row) ?? ""].contains {
          $0.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
      }
    }
  }
}
