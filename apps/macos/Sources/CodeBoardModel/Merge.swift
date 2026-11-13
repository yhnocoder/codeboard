import Foundation

// What another writer put in a board file (another app on a synced vault, git, a script), merged into the board open
// here: three-way, item by item against the version this app last read or wrote (core patch.ts mergeFile, host
// storage/merge.ts). What only one side changed is taken from that side; an item both changed is merged field by field,
// and where both changed the same field the disk wins. What is left pointing at something gone goes (prune).

extension Board {
  /// `mine` (open here, maybe not saved yet) with what changed on disk since `base` (what was last read or written)
  public static func merge(base: Board, mine: Board, disk: Board) -> Board {
    var out = mine
    out.id = disk.id
    out.cards = mergeList(base.cards, mine.cards, disk.cards)
    out.arrows = mergeList(base.arrows, mine.arrows, disk.arrows)
    out.sections = mergeList(base.sections, mine.sections, disk.sections)
    out.sidenotes = mergeList(base.sidenotes, mine.sidenotes, disk.sidenotes)
    out.stickers = mergeList(base.stickers, mine.stickers, disk.stickers)
    out.shelf = mergeList(base.shelf, mine.shelf, disk.shelf)
    out.seal = mine.seal == base.seal ? disk.seal : disk.seal == base.seal ? mine.seal : disk.seal
    out.hideComments =
      mine.hideComments == base.hideComments
      ? disk.hideComments : disk.hideComments == base.hideComments ? mine.hideComments : disk.hideComments
    out.prune()
    return out
  }
}

/// One list merged by id. Mine's order, unless only the disk reordered; items only the disk added go at the end
func mergeList<T: Identifiable & Codable & Equatable>(_ base: [T], _ mine: [T], _ disk: [T]) -> [T] {
  let b = Dictionary(base.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
  let d = Dictionary(disk.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
  let m = Dictionary(mine.map { ($0.id, $0) }, uniquingKeysWith: { x, _ in x })
  var merged: [T.ID: T] = [:]
  for x in mine {
    switch (b[x.id], d[x.id]) {
    // unchanged here: the disk's (gone when the disk deleted it)
    case (let old?, let now) where old == x: if let now { merged[x.id] = now }
    // changed or added here only; or changed here and deleted there (the change keeps it)
    case (let old, let now) where now == nil || now == old: merged[x.id] = x
    // changed on both sides (or added with the same id): field by field
    case (let old, let now?): merged[x.id] = mergeFields(old, x, now)
    default: merged[x.id] = x
    }
  }
  // added on disk; what the disk has and base had but mine has not was deleted here, and stays deleted
  for x in disk where m[x.id] == nil && b[x.id] == nil { merged[x.id] = x }
  let mineReordered = mine.map(\.id).filter { b[$0] != nil } != base.map(\.id).filter { m[$0] != nil }
  let order = mineReordered ? mine.map(\.id) + disk.map(\.id) : disk.map(\.id) + mine.map(\.id)
  var seen = Set<T.ID>()
  return order.compactMap { id in seen.insert(id).inserted ? merged[id] : nil }
}

/// An item both sides changed: each field from the side that changed it; where both did, the disk's
func mergeFields<T: Codable>(_ base: T?, _ mine: T, _ disk: T) -> T {
  let encoder = JSONEncoder()
  encoder.outputFormatting = .sortedKeys
  func object(_ v: T?) -> [String: Any] {
    guard let v, let data = try? encoder.encode(v) else { return [:] }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  }
  func same(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case (nil, nil): true
    case (let x?, let y?): (x as? NSObject)?.isEqual(y) == true
    default: false
    }
  }
  let (b, m, d) = (object(base), object(mine), object(disk))
  var out = m
  for key in Set(b.keys).union(m.keys).union(d.keys) {
    // taken from the disk when this side left it as it was, or when both changed it
    if same(m[key], b[key]) || !same(d[key], b[key]) { out[key] = d[key] }
  }
  guard let data = try? JSONSerialization.data(withJSONObject: out),
    let v = try? JSONDecoder().decode(T.self, from: data)
  else { return disk }
  return v
}
