/** 按插入顺序（老的在前）删掉 keep 以外、超出 max 个的那些：Map 当 LRU 用，用到一项时先删再放回去 */
export function trimLru<K, V>(m: Map<K, V>, keep: ReadonlySet<K>, max: number) {
  let extra = -max;
  for (const k of m.keys()) if (!keep.has(k)) extra++;
  for (const k of m.keys()) {
    if (extra <= 0) break;
    if (!keep.has(k)) {
      m.delete(k);
      extra--;
    }
  }
}
