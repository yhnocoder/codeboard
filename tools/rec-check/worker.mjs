// One rec-check worker: per region of a luma frame, the mean, the standard deviation, the variance of the Laplacian (sharpness)
// and a 4×4 grid of cell means (the region's signature, which flash and blur compare); plus the share of near-white pixels
// over the whole frame, sampled every 4th pixel of every 4th row. Regions are read every other row.
import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ i, buf, w, h, rects }) => {
  const f = new Uint8Array(buf);
  const n = rects.length / 4;
  const stats = new Float32Array(n * 3);
  const sig = new Uint8Array(n * 16);
  const cell = new Float64Array(16);
  const cnt = new Float64Array(16);
  for (let r = 0; r < n; r++) {
    const x0 = rects[r * 4];
    const y0 = rects[r * 4 + 1];
    const rw = rects[r * 4 + 2];
    const rh = rects[r * 4 + 3];
    cell.fill(0);
    cnt.fill(0);
    let s = 0;
    let ss = 0;
    let ls = 0;
    let lss = 0;
    let ln = 0;
    // ponytail: every other row, half the cost; a defect one pixel high on a skipped row goes unseen
    for (let y = y0; y < y0 + rh; y += 2) {
      const cy = (((y - y0) * 4) / rh) | 0;
      const row = y * w;
      const inner = y > 0 && y < h - 1;
      for (let c = 0; c < 4; c++) {
        const xs = x0 + ((c * rw) >> 2);
        const xe = x0 + (((c + 1) * rw) >> 2);
        let cs = 0;
        // the Laplacian only where all four neighbours exist; the edge pixels count for the means alone
        const a = inner ? Math.max(xs, 1) : xe;
        const b = inner ? Math.min(xe, w - 1) : xe;
        for (let x = xs; x < a; x++) {
          const v = f[row + x];
          cs += v;
          ss += v * v;
        }
        if (b > a) {
          // a sliding window: each pixel is read once from this row, and once from the rows above and below
          let left = f[row + a - 1];
          let v = f[row + a];
          const up = row - w;
          const down = row + w;
          for (let x = a; x < b; x++) {
            const right = f[row + x + 1];
            cs += v;
            ss += v * v;
            const l = 4 * v - left - right - f[up + x] - f[down + x];
            ls += l;
            lss += l * l;
            left = v;
            v = right;
          }
        }
        for (let x = Math.max(b, a); x < xe; x++) {
          const v = f[row + x];
          cs += v;
          ss += v * v;
        }
        if (b > a) ln += b - a;
        cell[cy * 4 + c] += cs;
        cnt[cy * 4 + c] += xe - xs;
        s += cs;
      }
    }
    let np = 0;
    for (let k = 0; k < 16; k++) np += cnt[k];
    const mean = s / np;
    stats[r * 3] = mean;
    stats[r * 3 + 1] = Math.sqrt(Math.max(0, ss / np - mean * mean));
    stats[r * 3 + 2] = ln ? lss / ln - (ls / ln) ** 2 : 0;
    for (let k = 0; k < 16; k++) sig[r * 16 + k] = cnt[k] ? Math.round(cell[k] / cnt[k]) : 0;
  }
  let white = 0;
  let all = 0;
  for (let y = 2; y < h; y += 4) {
    for (let x = 2; x < w; x += 4) {
      all++;
      if (f[y * w + x] >= 240) white++;
    }
  }
  parentPort.postMessage({ i, buf, stats, sig, white: white / all }, [buf]);
});
