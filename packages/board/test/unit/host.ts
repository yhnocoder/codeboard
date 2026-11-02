// The unit tests' host: what the board posts is kept in `sent`; the tests hand the board the host's messages through onHost
import type { BoardToHost } from "@codeboard/core";
import { connectHost } from "../../src/host";
import { onHost } from "../../src/hostio";

export const sent: BoardToHost[] = [];
connectHost({ post: (m) => sent.push(m), listen: () => {} }, onHost);
