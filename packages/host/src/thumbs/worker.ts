// The thumbnail worker's entry: decoding and shrinking a 2500 px screenshot takes a few hundred ms of JavaScript, which must not
// hold up the host. The extension builds it into dist/thumbs.js (esbuild.mjs) and hands its path to startHost
import { parentPort } from "node:worker_threads";
import { runJob, type ThumbJob } from "./job";

parentPort?.on("message", (m: { id: number; job: ThumbJob }) => {
  runJob(m.job).then(
    (done) => parentPort?.postMessage({ id: m.id, done }),
    (e) => parentPort?.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) }),
  );
});
