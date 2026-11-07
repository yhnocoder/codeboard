// An embedding model behind an OpenAI-compatible endpoint (POST {base}/embeddings), such as oMLX serving EmbeddingGemma on
// the user's own machine. Texts arrive already prompted (text.ts); vectors come back normalized.

export interface Embedder {
  /** The model's name: the index is kept per model, a different one starts it again */
  model(): Promise<string>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Texts per request */
export const BATCH = 16;

export type EndpointOptions = {
  /** e.g. http://127.0.0.1:11001/v1 */
  base: string;
  key?: string;
  /** none: the first model the server lists with "embed" in its name (or its only model) */
  model?: string;
  /** a fetch to use instead of the global one (tests) */
  fetch?: typeof fetch;
};

export function unit(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export function endpointEmbedder(o: EndpointOptions): Embedder {
  const base = o.base.replace(/\/+$/, "");
  const get = o.fetch ?? fetch;
  const headers = { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) };
  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const r = await get(url, { ...init, headers }).catch((e: Error & { cause?: { code?: string } }) => {
      throw new Error(`Cannot reach the embedding server at ${base} (${e.cause?.code ?? e.message})`);
    });
    if (!r.ok) throw new Error(`The embedding server answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  };
  let picked: Promise<string> | undefined;
  const model = () =>
    (picked ??= o.model
      ? Promise.resolve(o.model)
      : call<{ data?: { id: string }[] }>(`${base}/models`).then((j) => {
          const ids = (j.data ?? []).map((m) => m.id);
          const id = ids.find((x) => /embed/i.test(x)) ?? (ids.length === 1 ? ids[0] : undefined);
          if (!id) throw new Error(`No embedding model on ${base} (it lists: ${ids.join(", ") || "none"})`);
          return id;
        })).catch((e) => {
      picked = undefined;
      throw e;
    });
  return {
    model,
    async embed(texts) {
      const m = await model();
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const j = await call<{ data: { index: number; embedding: number[] }[] }>(`${base}/embeddings`, {
          method: "POST",
          body: JSON.stringify({ model: m, input: texts.slice(i, i + BATCH) }),
        });
        for (const d of [...j.data].sort((a, b) => a.index - b.index)) out.push(unit(d.embedding));
      }
      return out;
    },
  };
}
