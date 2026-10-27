// Note 里代码块的样例（每种语言一段）：小样和 gen.ts 共用。着色是宿主做的（shiki），gen.ts 按宿主的 highlight 预先算好写进 notecode.json
export const NOTE_CODE: Record<string, string> = {
  python: "def allocate(self, seq: Sequence):\n    # 先找空闲块\n    block_id = self.free_block_ids[0]\n    return len(seq) * 2",
  typescript: "export function rebase(seg: Segment, by: number): Segment {\n  return { ...seg, start: seg.start + by };\n}",
  cpp: "__global__ void store_kvcache(const float* k, int* slot) {\n  int i = blockIdx.x;\n  cache[slot[i]] = k[i];\n}",
  rust: "fn hash_block(tokens: &[u32], prefix: u64) -> u64 {\n    xxh64(bytemuck::cast_slice(tokens), prefix)\n}",
  bash: "python bench.py --model Qwen3-0.6B \\\n  --max-num-seqs 256 --enforce-eager",
  json: '{ "block_size": 256, "num_kvcache_blocks": 1024, "tensor_parallel_size": 2 }',
  diff: "-    if not self.block_manager.can_append(seq):\n+    while not self.block_manager.can_append(seq):\n         self.preempt(seq)",
  "": "没有语言：纯文字代码块\n  缩进照留",
};

/** 别处的 Note 里用到的代码块（support/groups.ts 的 RICH），一起预先着色：[语言, 代码] */
export const NOTE_CODE_EXTRA: [string, string][] = [
  ["python", "num_blocks = (seq.num_tokens + block_size - 1) // block_size"],
];

/** notecode.json 的键：语言（白板用 langId 规整过的）+ 代码 */
export const noteCodeKey = (lang: string, text: string) => `${lang}\u0000${text}`;
