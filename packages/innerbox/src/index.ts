// innerbox: a small semantic index for one project's boards. Documents are cut into short pieces, each piece embedded by a
// local model (EmbeddingGemma behind an OpenAI-compatible endpoint), vectors kept by content fingerprint so only new text is
// embedded, and the whole index is one file the caller stores where it likes.
export { Box } from "./box";
export { BATCH, endpointEmbedder, type Embedder } from "./embed";
export { queryText, type Doc } from "./text";
