import { createStore, digest, getJSON } from "./storage.js";
import { readCommits, type Commit } from "./history.js";
import { resolve, join } from "node:path";
import { watchOutput } from "./watch-output.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { configure, sessions, runs } from "@trigger.dev/sdk";
import {
  requestSchema,
  stopSchema,
  type Output,
  type Turn,
} from "./protocol.js";

if (!process.env.TRIGGER_SECRET_KEY)
  throw new Error(
    "Set TRIGGER_SECRET_KEY in .env. Run pnpm run doctor for setup checks.",
  );
configure({
  accessToken: process.env.TRIGGER_SECRET_KEY,
  baseURL: process.env.TRIGGER_API_URL || "https://api.trigger.dev",
});
const dataDir = resolve(process.env.DATA_DIR || ".data");
await mkdir(dataDir, { recursive: true });
const store = createStore();
const db = new DatabaseSync(join(dataDir, "frontend.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS chat_state(chat TEXT PRIMARY KEY, head TEXT, sequence INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requests(id TEXT NOT NULL, chat TEXT NOT NULL, harness TEXT NOT NULL,
 prompt TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, PRIMARY KEY(chat,id));`);
type Row = {
  id: string;
  harness: string;
  prompt: string;
  status: string;
  text: string;
  created: string;
};
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
class InputError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function body(req: IncomingMessage) {
  req.setEncoding("utf8");
  let text = "";
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) continue;
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > 512_000) {
      tooLarge = true;
      text = "";
    }
  }
  if (tooLarge) throw new InputError("Request is too large", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new InputError("Request body must be valid JSON", 400);
  }
}
function saveResult(chat: string, result: Extract<Output, { type: "result" }>) {
  db.prepare("UPDATE requests SET status=?,text=? WHERE id=? AND chat=?").run(
    result.status,
    result.text,
    result.requestId,
    chat,
  );
}
async function reconcile(chat: string, head?: string) {
  if (!head) return;
  const saved = db
    .prepare("SELECT head,sequence FROM chat_state WHERE chat=?")
    .get(chat) as { head: string; sequence: number } | undefined;
  if (saved?.head === head) return;
  const changes = await readCommits(store, head, saved?.head);
  if (!changes.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare("SELECT sequence FROM chat_state WHERE chat=?")
      .get(chat) as { sequence: number } | undefined;
    if ((current?.sequence ?? 0) < changes.at(-1)!.value.sequence) {
      for (const { value } of changes) {
        const turn = value.turn;
        db.prepare(
          "INSERT INTO requests(id,chat,harness,prompt,status,text,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat,id) DO UPDATE SET status=excluded.status,text=excluded.text",
        ).run(
          turn.id,
          chat,
          turn.harness,
          turn.prompt,
          turn.status,
          turn.text,
          new Date().toISOString(),
        );
      }
      db.prepare(
        "INSERT INTO chat_state VALUES(?,?,?) ON CONFLICT(chat) DO UPDATE SET head=excluded.head,sequence=excluded.sequence",
      ).run(chat, head, changes.at(-1)!.value.sequence);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
let origin = "";
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host)
      return json(res, 403, { error: "Invalid host" });
    if (req.headers.origin && req.headers.origin !== origin)
      return json(res, 403, { error: "Invalid origin" });
    let owner = req.headers.cookie?.match(
      /(?:^|; )harness_owner=([a-f0-9-]{36})(?:;|$)/,
    )?.[1];
    if (!owner) {
      owner = randomUUID();
      res.setHeader(
        "Set-Cookie",
        `harness_owner=${owner}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
      );
    }
    const url = new URL(req.url!, origin);
    const assets: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"],
      "/state.js": ["state.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
    };
    if (req.method === "GET" && assets[url.pathname]) {
      const [file, mime] = assets[url.pathname];
      const content = await readFile(
        new URL(`../public/${file}`, import.meta.url),
      );
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      return res.end(content);
    }
    if (url.pathname === "/api/chats") {
      if (req.method === "GET")
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT id,created FROM chats WHERE owner=? ORDER BY created DESC",
            )
            .all(owner),
        );
      if (req.method === "POST") {
        const id = `harness-${randomUUID()}`;
        await sessions.start({
          type: "multi-harness",
          externalId: id,
          taskIdentifier: "multi-harness",
          triggerConfig: { basePayload: { sessionId: id }, maxAttempts: 3 },
        });
        db.prepare("INSERT INTO chats VALUES(?,?,?)").run(
          id,
          owner,
          new Date().toISOString(),
        );
        return json(res, 201, { id });
      }
    }
    const match = url.pathname.match(
      /^\/api\/chats\/(harness-[a-f0-9-]{36})(?:\/(events|messages|close|stop))?$/,
    );
    if (!match) return json(res, 404, { error: "Not found" });
    const [, id, action] = match;
    if (
      !db.prepare("SELECT id FROM chats WHERE id=? AND owner=?").get(id, owner)
    )
      return json(res, 404, { error: "Conversation not found" });
    if (!action && req.method === "GET") {
      const remote = await sessions.retrieve(id);
      await reconcile(id, remote.metadata?.stateKey as string | undefined);
      if (
        remote.currentRunId &&
        db
          .prepare("SELECT 1 FROM requests WHERE chat=? AND status='pending'")
          .get(id)
      ) {
        const run = await runs.retrieve(remote.currentRunId);
        if (run.isFailed || run.isCancelled)
          db.prepare(
            "UPDATE requests SET status='send-error' WHERE chat=? AND status='pending'",
          ).run(id);
      }
      // Older inline-format conversations remain readable while they are migrated.
      for (const turn of (remote.metadata?.turns ?? []) as Turn[])
        saveResult(id, {
          type: "result",
          requestId: turn.id,
          harness: turn.harness,
          status: turn.status,
          text: turn.text,
        });
      const before = Number(
        url.searchParams.get("before") || Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(before) || before < 1)
        return json(res, 400, { error: "Invalid page cursor" });
      const page = db
        .prepare(
          "SELECT rowid AS ordinal,* FROM requests WHERE chat=? AND rowid<? ORDER BY rowid DESC LIMIT 51",
        )
        .all(id, before) as (Row & { ordinal: number })[];
      const more = page.length > 50;
      const requests = page.slice(0, 50).reverse();
      return json(res, 200, {
        id,
        closed: !!remote.closedAt,
        runId: remote.currentRunId,
        requests,
        hasMore: more,
        nextBefore: requests[0]?.ordinal,
        total: (
          db
            .prepare("SELECT COUNT(*) AS n FROM requests WHERE chat=?")
            .get(id) as { n: number }
        ).n,
      });
    }
    if (action === "close" && req.method === "POST") {
      await sessions.close(id, { reason: "Closed from the lab" });
      return json(res, 200, { ok: true });
    }
    if (action === "stop" && req.method === "POST") {
      const parsed = stopSchema.safeParse(await body(req));
      if (!parsed.success)
        return json(res, 400, { error: "Invalid stop request" });
      const row = db
        .prepare("SELECT status FROM requests WHERE id=? AND chat=?")
        .get(parsed.data.requestId, id) as { status: string } | undefined;
      if (!row) return json(res, 404, { error: "Request not found" });
      if (["completed", "failed", "stopped"].includes(row.status))
        return json(res, 200, { status: row.status });
      await store.put(
        `stops/${digest(Buffer.from(id))}/${parsed.data.requestId}`,
        Buffer.from("stopped"),
      );
      await sessions.open(id).in.send(parsed.data);
      return json(res, 202, { status: "stopping" });
    }
    if (action === "messages" && req.method === "POST") {
      const parsed = requestSchema.safeParse(await body(req));
      if (!parsed.success)
        return json(res, 400, {
          error: "Choose a harness and enter 1–64,000 characters.",
        });
      const request = parsed.data;
      let previous = db
        .prepare("SELECT * FROM requests WHERE id=? AND chat=?")
        .get(request.id, id) as Row | undefined;
      if (
        previous &&
        (previous.prompt !== request.prompt ||
          previous.harness !== request.harness)
      )
        return json(res, 409, { error: "Request ID already used." });
      if (
        previous?.status === "completed" ||
        previous?.status === "failed" ||
        previous?.status === "stopped"
      )
        return json(res, 200, previous);
      const state = await sessions.retrieve(id);
      if (state.closedAt)
        return json(res, 409, {
          error: "This conversation is closed. Start a new one.",
        });
      await reconcile(id, state.metadata?.stateKey as string | undefined);
      for (const turn of (state.metadata?.turns ?? []) as Turn[])
        saveResult(id, {
          type: "result",
          requestId: turn.id,
          harness: turn.harness,
          status: turn.status,
          text: turn.text,
        });
      previous = db
        .prepare("SELECT * FROM requests WHERE id=? AND chat=?")
        .get(request.id, id) as Row | undefined;
      if (
        previous &&
        ["completed", "failed", "stopped"].includes(previous.status)
      )
        return json(res, 200, previous);
      // SQLite makes admission atomic across overlapping browser requests.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          db
            .prepare(
              "SELECT id FROM requests WHERE chat=? AND status IN ('pending','send-error') AND id<>?",
            )
            .get(id, request.id)
        ) {
          db.exec("ROLLBACK");
          return json(res, 409, {
            error:
              "Resolve the current request before sending another one. Retry delivery if its status is unknown.",
          });
        }
        db.prepare(
          "INSERT INTO requests(id,chat,harness,prompt,status,created) VALUES(?,?,?,?,'pending',?) ON CONFLICT(chat,id) DO UPDATE SET status='pending'",
        ).run(
          request.id,
          id,
          request.harness,
          request.prompt,
          new Date().toISOString(),
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      try {
        await sessions.open(id).in.send(request);
      } catch {
        db.prepare(
          "UPDATE requests SET status='send-error' WHERE id=? AND chat=? AND status='pending'",
        ).run(request.id, id);
        return json(res, 502, {
          error:
            "Delivery could not be confirmed. Retry this request with the same ID.",
        });
      }
      return json(res, 202, { ok: true });
    }
    if (action === "events" && req.method === "GET") {
      const cursor =
        req.headers["last-event-id"] ?? url.searchParams.get("cursor");
      if (cursor && !/^\d+$/.test(String(cursor)))
        return json(res, 400, { error: "Invalid stream cursor" });
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      try {
        const parts: string[] = [];
        const stream = watchOutput<Output>(id, {
          signal: controller.signal,
          lastEventId: cursor ? String(cursor) : undefined,
          onPart: ({ id: eventId }) => {
            parts.push(eventId);
          },
        });
        for await (let event of stream) {
          const eventId = parts.shift();
          if (event.type === "committed") {
            const commit = await getJSON<Commit>(store, event.commitKey);
            if (commit.turn.id !== event.requestId)
              throw new Error("Mismatched committed result");
            event = {
              type: "result",
              requestId: commit.turn.id,
              harness: commit.turn.harness,
              status: commit.turn.status,
              text: commit.turn.text,
            };
          }
          if (event.type === "result") saveResult(id, event);
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          console.error(
            "Stream reconnect needed",
            error instanceof Error ? error.message : error,
          );
      } finally {
        clearInterval(heartbeat);
        controller.abort();
        res.end();
      }
      return;
    }
    return json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof InputError)
      return json(res, error.status, { error: error.message });
    console.error(error instanceof Error ? error.message : error);
    if (!res.headersSent)
      json(res, 500, {
        error:
          "The lab could not complete this request. Check the server output and retry.",
      });
    else res.end();
  }
});
server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No listening address");
  origin = `http://127.0.0.1:${address.port}`;
  console.log(`Multi-harness POC: ${origin}`);
});
