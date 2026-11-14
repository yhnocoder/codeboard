/// Requests waiting for the web view: the highest priority first, then the oldest
struct RenderQueue {
  private var waiting: [(id: Int, priority: Int)] = []

  var isEmpty: Bool { waiting.isEmpty }

  mutating func push(_ id: Int, priority: Int) {
    // after every request of the same or higher priority: equal priorities keep their order
    let at = waiting.firstIndex { $0.priority < priority } ?? waiting.endIndex
    waiting.insert((id, priority), at: at)
  }

  /// false when it was not waiting (already taken)
  mutating func remove(_ id: Int) -> Bool {
    guard let i = waiting.firstIndex(where: { $0.id == id }) else { return false }
    waiting.remove(at: i)
    return true
  }

  mutating func pop() -> Int? {
    waiting.isEmpty ? nil : waiting.removeFirst().id
  }
}
