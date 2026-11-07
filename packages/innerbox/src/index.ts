// innerbox: a small semantic index for one project's boards. Documents are cut into short pieces, each piece embedded by a
// local model (EmbeddingGemma behind an OpenAI-compatible endpoint), vectors kept by content fingerprint so only new text is
// embedded (pictures too, when the model takes them), and the whole index is one file the caller stores where it likes.
export { Box } from "./box";
export { endpointEmbedder, type Embedder } from "./embed";
export { fingerprint, pieceBodies, queryText, type Doc, type DocImage } from "./text";
