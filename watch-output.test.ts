import { createServer } from "node:http";
import { configure } from "@trigger.dev/sdk";
import { expect, test } from "vitest";
import { watchOutput } from "./src/watch-output.js";

test("output survives an empty idle window and resumes from the last delivered cursor", async () => {
  const cursors: unknown[] = [];
  const abort = new AbortController();
  const server = createServer((req, res) => {
    cursors.push(req.headers["last-event-id"]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "X-Stream-Version": "v2",
    });
    const n = cursors.length;
    if (n === 2) return res.end();
    res.end(
      `event: batch\ndata: ${JSON.stringify({ records: [{ seq_num: n, timestamp: Date.now(), body: JSON.stringify({ id: `record-${n}`, data: { value: n } }) }] })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a TCP address");
  configure({
    baseURL: `http://127.0.0.1:${address.port}`,
    accessToken: "local-test",
  });
  const delivered: string[] = [];
  const stream = watchOutput<{ value: number }>("local-session", {
    signal: abort.signal,
    onPart: (part) => delivered.push(part.id),
  });
  try {
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { value: 1 },
    });
    expect(await stream.next()).toMatchObject({
      done: false,
      value: { value: 3 },
    });
    expect(cursors).toEqual([undefined, "1", "1"]);
    expect(delivered).toEqual(["1", "3"]);
    const pending = stream.next();
    abort.abort();
    expect(await pending).toMatchObject({ done: true });
    expect(cursors).toHaveLength(3);
  } finally {
    abort.abort();
    await stream.return();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
