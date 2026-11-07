// An embedding model behind an OpenAI-compatible endpoint (POST {base}/embeddings), such as oMLX serving EmbeddingGemma on
// the user's own machine. Texts arrive already prompted (text.ts); vectors come back normalized. Pictures go in the shape the
// server takes (SHAPES); a server that answers the first one with an error in every shape does not take pictures.

export interface Embedder {
  /** The model's name: the index is kept per model, a different one starts it again */
  model(): Promise<string>;
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Pictures (data: URLs), one vector each; undefined when the model does not take pictures (then they are left out) */
  embedImages?(urls: string[]): Promise<Float32Array[] | undefined>;
}

/** How a picture (a data: URL) goes in /embeddings' input, as servers take it: a content part (oMLX), an {image} item (SGLang) */
const SHAPES = {
  part: (url: string) => ({ type: "image_url", image_url: { url } }),
  item: (url: string) => ({ image: url }),
};

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
    if (!r.ok)
      throw Object.assign(new Error(`The embedding server answered ${r.status}: ${(await r.text()).slice(0, 200)}`), {
        status: r.status,
      });
    return (await r.json()) as T;
  };
  const vectors = async (input: unknown[]) => {
    const j = await call<{ data: { index: number; embedding: number[] }[] }>(`${base}/embeddings`, {
      method: "POST",
      body: JSON.stringify({ model: await model(), input }),
    });
    return [...j.data].sort((a, b) => a.index - b.index).map((d) => unit(d.embedding));
  };
  /** The item shape the server takes pictures in; null: it takes none; undefined: not known before the first picture */
  let shape: keyof typeof SHAPES | null | undefined;
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
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) out.push(...(await vectors(texts.slice(i, i + BATCH))));
      return out;
    },
    async embedImages(urls) {
      if (shape === null) return undefined;
      const out: Float32Array[] = [];
      // one at a time: a picture is hundreds of tokens and large to send
      for (const url of urls) {
        if (shape) {
          out.push(...(await vectors([SHAPES[shape](url)])));
          continue;
        }
        // the first picture finds the item shape the server takes; an error answer to every shape means no pictures
        for (const s of Object.keys(SHAPES) as (keyof typeof SHAPES)[]) {
          const v = await vectors([SHAPES[s](url)]).catch((e: { status?: number }) => {
            if (e.status === undefined) throw e;
            return undefined;
          });
          if (v) {
            shape = s;
            out.push(...v);
            break;
          }
        }
        if (!shape) {
          shape = null;
          return undefined;
        }
      }
      return out;
    },
  };
}
