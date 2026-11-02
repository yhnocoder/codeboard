// The unit tests' host: what the board posts is kept in `sent`; the tests hand the board the host's messages through fromHost
import type { BoardToHost, HostToBoard } from "@codeboard/core";
import { createMarkdown } from "@yhnocoder/markdown";
import { connectHost } from "../../src/host";
import { onHost } from "../../src/hostio";

export const sent: BoardToHost[] = [];
const md = createMarkdown();
connectHost({ post: (m) => sent.push(m), listen: () => {} }, (m) => onHost(m, md));
/** The host says m */
export const fromHost = (m: HostToBoard) => onHost(m, md);
