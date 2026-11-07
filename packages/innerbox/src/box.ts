// The index: vectors kept by the fingerprint of the text they were made from (so unchanged text is never embedded again, and
// two documents with the same piece share one vector), and which pieces each document has. A document's score for a query is
// its best piece's. Searching compares the query with every vector: a few milliseconds for tens of thousands of pieces.
import { BATCH, unit, type Embedder } from "./embed";
import { fingerprint, imageFingerprint, PICTURE, pieces, type Doc, type DocImage } from "./text";

/** piece: which of the document's pieces matched best (an index into pieceBodies); picture: the key of the picture that did
 *  instead (then piece is -1) */
export type Hit = { id: string; score: number; piece: number; picture?: string };

/** Pictures read (one after another) and embedded between two batch() calls (each takes a second or so) */
const PICTURES = 4;
/** File format version (toBytes) */
const FORMAT = 1;
const MAGIC = 0x31786269; // "ibx1"

export class Box {
  /** fingerprint → unit vector */
  private vecs = new Map<string, Float32Array>();
  /** document id → its pieces' fingerprints (only documents whose pieces all have vectors) */
  private docs = new Map<string, string[]>();
  /** Pictures the server turned down (too big, a format it does not read): left out while this box lives, asked again by the next */
  private refused = new Set<string>();

  constructor(readonly model: string) {}

  get size() {
    return this.docs.size;
  }

  /** Pieces of these documents not embedded yet (pictures too) */
  missing(docs: Doc[]): number {
    const need = new Set<string>();
    for (const d of docs) {
      for (const p of pieces(d)) if (!this.vecs.has(fingerprint(p))) need.add(fingerprint(p));
      for (const img of d.images ?? []) {
        const f = imageFingerprint(img);
        if (!this.vecs.has(f) && !this.refused.has(f)) need.add(f);
      }
    }
    return need.size;
  }

  /**
   * Brings the index to exactly these documents: embeds the pieces it has no vector for (in the order given, so put what
   * matters most first; pictures after all the text), forgets documents that are gone and vectors no document uses. A document
   * becomes searchable as soon as its text is in, and each picture joins it when embedded (none, when the model does not take
   * pictures). After each request batch(done) is awaited (to save what is done so far, so a window closed halfway keeps it;
   * done: pieces embedded so far) and stop() asked; when it says yes, the rest waits for the next update.
   * Answers whether anything changed.
   */
  async update(
    docs: Doc[],
    embedder: Embedder,
    o: { stop?: () => boolean; batch?: (done: number) => Promise<void> } = {},
  ): Promise<boolean> {
    const stop = o.stop ?? (() => false);
    let changed = false,
      done = 0;
    const want = new Map<string, { texts: string[]; fps: string[]; images: DocImage[] }>();
    for (const d of docs) {
      const texts = pieces(d);
      want.set(d.id, { texts, fps: texts.map(fingerprint), images: d.images ?? [] });
    }
    for (const id of [...this.docs.keys()])
      if (!want.has(id)) {
        this.docs.delete(id);
        this.packed = undefined;
        changed = true;
      }
    const settle = () => {
      for (const [id, w] of want) {
        if (!w.fps.every((f) => this.vecs.has(f))) continue;
        const fps = [...w.fps, ...w.images.map(imageFingerprint).filter((f) => this.vecs.has(f))];
        const had = this.docs.get(id);
        if (!(had && had.length === fps.length && had.every((f, i) => f === fps[i]))) {
          this.docs.set(id, fps);
          this.packed = undefined;
          changed = true;
        }
      }
    };
    settle();
    const queue: [string, string][] = [];
    const pics: [string, DocImage][] = [];
    const queued = new Set<string>();
    for (const w of want.values()) {
      w.fps.forEach((f, i) => {
        if (!this.vecs.has(f) && !queued.has(f)) {
          queued.add(f);
          queue.push([f, w.texts[i]]);
        }
      });
      for (const img of w.images) {
        const f = imageFingerprint(img);
        if (!this.vecs.has(f) && !this.refused.has(f) && !queued.has(f)) {
          queued.add(f);
          pics.push([f, img]);
        }
      }
    }
    for (let i = 0; i < queue.length && !stop(); i += BATCH) {
      const batch = queue.slice(i, i + BATCH);
      const vs = await embedder.embed(batch.map(([, t]) => t));
      batch.forEach(([f], j) => this.vecs.set(f, vs[j]));
      done += batch.length;
      settle();
      await o.batch?.(done);
    }
    for (let i = 0; i < pics.length && !stop() && embedder.embedImages; i += PICTURES) {
      // one after another: an SVG is drawn by the open board, which should not draw several in one go
      const urls: (readonly [string, string | undefined])[] = [];
      for (const [f, img] of pics.slice(i, i + PICTURES)) urls.push([f, await img.url()]);
      const read = urls.filter((x): x is readonly [string, string] => !!x[1]);
      const vs = read.length ? await embedder.embedImages(read.map(([, u]) => u)) : [];
      if (!vs) break; // the model does not take pictures
      read.forEach(([f], j) => {
        const v = vs[j];
        if (v) this.vecs.set(f, v);
        else this.refused.add(f);
      });
      done += urls.length;
      settle();
      await o.batch?.(done);
    }
    if (!stop()) {
      const used = new Set<string>();
      for (const w of want.values()) {
        for (const f of w.fps) used.add(f);
        for (const img of w.images) used.add(imageFingerprint(img));
      }
      for (const f of [...this.vecs.keys()]) if (!used.has(f)) this.vecs.delete(f);
    }
    return changed;
  }

  /** The vectors in one block and each document's rows in it, made on the first search after a change */
  private packed?: { m: Float32Array; dim: number; ids: string[]; rows: Int32Array; starts: Int32Array };

  private pack() {
    if (this.packed) return this.packed;
    const at = new Map<string, number>();
    const ids: string[] = [];
    const starts: number[] = [];
    const rows: number[] = [];
    for (const [id, fps] of this.docs) {
      ids.push(id);
      starts.push(rows.length);
      for (const f of fps) {
        let r = at.get(f);
        if (r === undefined) at.set(f, (r = at.size));
        rows.push(r);
      }
    }
    starts.push(rows.length);
    const first = this.vecs.values().next().value;
    const dim = first ? first.length : 0;
    const m = new Float32Array(at.size * dim);
    for (const [f, r] of at) m.set(this.vecs.get(f)!, r * dim);
    this.packed = { m, dim, ids, rows: Int32Array.from(rows), starts: Int32Array.from(starts) };
    return this.packed;
  }

  /** The k documents closest to the query vector (unit), best first. floor: the least score a text piece or a picture counts
   *  with (a model scores pictures higher than text overall); a document with none that counts is left out */
  search(q: Float32Array, k: number, floor: { text?: number; picture?: number } = {}): Hit[] {
    const least = [floor.text ?? -1, floor.picture ?? -1];
    const { m, dim, ids, rows, starts } = this.pack();
    const n = Math.min(dim, q.length);
    const sims = new Float32Array(m.length / (dim || 1));
    const n4 = n - (n % 4);
    for (let r = 0, o = 0; r < sims.length; r++, o += dim) {
      // four sums side by side: a quarter faster than one
      let a = 0,
        b = 0,
        c = 0,
        d = 0;
      for (let i = 0; i < n4; i += 4) {
        a += m[o + i] * q[i];
        b += m[o + i + 1] * q[i + 1];
        c += m[o + i + 2] * q[i + 2];
        d += m[o + i + 3] * q[i + 3];
      }
      for (let i = n4; i < n; i++) a += m[o + i] * q[i];
      sims[r] = a + b + c + d;
    }
    const hits: Hit[] = [];
    for (let d = 0; d < ids.length; d++) {
      const fps = this.docs.get(ids[d])!;
      let best = -1,
        piece = -1;
      for (let j = starts[d]; j < starts[d + 1]; j++) {
        const v = sims[rows[j]];
        if (v > best && v >= least[+fps[j - starts[d]].startsWith(PICTURE)]) {
          best = v;
          piece = j - starts[d];
        }
      }
      if (piece < 0) continue;
      const f = fps[piece];
      hits.push(
        f.startsWith(PICTURE)
          ? { id: ids[d], score: best, piece: -1, picture: f.slice(PICTURE.length) }
          : { id: ids[d], score: best, piece },
      );
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  /** The index as a file: a JSON header (model, fingerprints, documents), then each vector as int8 with its scale */
  toBytes(): Uint8Array {
    const fps = [...this.vecs.keys()];
    const at = new Map(fps.map((f, i) => [f, i]));
    const dim = fps.length ? this.vecs.get(fps[0])!.length : 0;
    const docs: Record<string, number[]> = {};
    for (const [id, list] of this.docs) docs[id] = list.map((f) => at.get(f)!);
    const head = new TextEncoder().encode(JSON.stringify({ v: FORMAT, model: this.model, dim, fps, docs }));
    const pad = (4 - ((8 + head.length) % 4)) % 4;
    const off = 8 + head.length + pad;
    const out = new Uint8Array(off + fps.length * 4 + fps.length * dim);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, head.length, true);
    out.set(head, 8);
    const scales = new Float32Array(out.buffer, off, fps.length);
    const body = new Int8Array(out.buffer, off + fps.length * 4);
    fps.forEach((f, i) => {
      const v = this.vecs.get(f)!;
      let m = 0;
      for (const x of v) m = Math.max(m, Math.abs(x));
      const s = m / 127 || 1;
      scales[i] = s;
      for (let j = 0; j < dim; j++) body[i * dim + j] = Math.round(v[j] / s);
    });
    return out;
  }

  /** A file toBytes wrote; undefined when it is not one (or another format, or another model's) */
  static fromBytes(b: Uint8Array, model: string): Box | undefined {
    try {
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (view.getUint32(0, true) !== MAGIC) return undefined;
      const len = view.getUint32(4, true);
      const head: { v: number; model: string; dim: number; fps: string[]; docs: Record<string, number[]> } = JSON.parse(
        new TextDecoder().decode(b.subarray(8, 8 + len)),
      );
      if (head.v !== FORMAT || head.model !== model) return undefined;
      const off = 8 + len + ((4 - ((8 + len) % 4)) % 4);
      const n = head.fps.length,
        dim = head.dim;
      const copy = b.slice(off, off + n * 4 + n * dim);
      if (copy.length !== n * 4 + n * dim) return undefined;
      const scales = new Float32Array(copy.buffer, 0, n);
      const body = new Int8Array(copy.buffer, n * 4);
      const box = new Box(model);
      head.fps.forEach((f, i) => {
        const v = new Float32Array(dim);
        for (let j = 0; j < dim; j++) v[j] = body[i * dim + j] * scales[i];
        box.vecs.set(f, unit(v));
      });
      for (const [id, list] of Object.entries(head.docs))
        box.docs.set(
          id,
          list.map((i) => head.fps[i]),
        );
      return box;
    } catch {
      return undefined;
    }
  }
}
