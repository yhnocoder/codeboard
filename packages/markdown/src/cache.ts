// The caches a Markdown instance keeps are bounded: past their size the oldest entry goes first

/** Set k in m, dropping the oldest entry once m holds max */
export function capped<K, V>(m: Map<K, V>, max: number, k: K, v: V) {
  if (m.size >= max && !m.has(k)) m.delete(m.keys().next().value!);
  m.set(k, v);
}
/** Add v to s, dropping the oldest entry once s holds max */
export function cappedAdd<V>(s: Set<V>, max: number, v: V) {
  if (s.size >= max && !s.has(v)) s.delete(s.values().next().value!);
  s.add(v);
}
