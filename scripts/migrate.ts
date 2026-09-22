import { configure, runs, sessions } from "@trigger.dev/sdk";
import { gunzipSync } from "node:zlib";
import { createStore, digest } from "../src/storage.js";
import { commitTurn } from "../src/history.js";
import { validateSnapshot, type NativeSnapshot } from "../src/native-state.js";
import { requestSchema, type Turn } from "../src/protocol.js";

const sessionId = process.argv[2];
if (!sessionId)
  throw new Error("Usage: pnpm run migrate -- harness-SESSION-ID");
configure({
  accessToken: process.env.TRIGGER_SECRET_KEY,
  baseURL: process.env.TRIGGER_API_URL || "https://api.trigger.dev",
});
const session = await sessions.retrieve(sessionId);
if (session.metadata?.stateKey) {
  console.log("Conversation already uses object storage.");
  process.exit(0);
}
if (session.currentRunId) {
  const run = await runs.retrieve(session.currentRunId);
  if (
    ![
      "COMPLETED",
      "FAILED",
      "CANCELED",
      "SYSTEM_FAILURE",
      "CRASHED",
      "TIMED_OUT",
      "EXPIRED",
    ].includes(run.status)
  )
    throw new Error(
      "Let the current run finish or cancel it before migrating. Migration must not race an active worker.",
    );
}
const store = createStore();
let snapshot: NativeSnapshot = { version: 2, handles: {}, files: {} };
const revision = session.metadata?.nativeRevision;
if (revision) {
  const abort = new AbortController();
  const stream = await sessions
    .open(sessionId)
    .channel("native-state")
    .out.read<{ revision: string; archive: string }>({
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      timeoutInSeconds: 1,
    });
  let found = false;
  try {
    for await (const record of stream) {
      if (record.revision !== revision) continue;
      const legacy = JSON.parse(
        gunzipSync(Buffer.from(record.archive, "base64")).toString("utf8"),
      );
      snapshot.handles = legacy.handles;
      for (const [path, encoded] of Object.entries(legacy.files)) {
        if (
          path.startsWith("workspace/.checkpoint-") ||
          path.startsWith("workspace/.conversation/")
        )
          continue;
        const body = Buffer.from(encoded as string, "base64");
        const key = `blobs/${digest(body)}`;
        await store.put(key, body);
        snapshot.files[path] = { key, bytes: body.length };
      }
      found = true;
      break;
    }
    if (!found)
      throw new Error(
        "Legacy native snapshot is missing; migration did not change the session.",
      );
  } finally {
    abort.abort();
  }
}
snapshot = validateSnapshot(snapshot);
const turns = (session.metadata?.turns ?? []) as Turn[];
let head: string | undefined;
for (let index = 0; index < turns.length; index++) {
  requestSchema.parse(turns[index]);
  head = await commitTurn(store, head, index + 1, turns[index], snapshot);
}
if (!head)
  throw new Error(
    "No saved turns to migrate. Start a new conversation with the updated worker.",
  );
await sessions.update(sessionId, {
  metadata: {
    stateKey: head,
    pendingKey: null,
    turns: null,
    nativeRevision: null,
  },
});
console.log(
  `Migrated ${turns.length} turns and the latest native workspace. Restart the updated worker to continue.`,
);
