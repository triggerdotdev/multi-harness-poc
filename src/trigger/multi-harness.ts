import {
  capture,
  restore,
  openNative,
  nativeContext,
  prepareInitialUpload,
} from "../native-state.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { logger, sessions, task } from "@trigger.dev/sdk";
import {
  requestSchema,
  stopSchema,
  type Harness,
  type Output,
  type Request,
  type Turn,
} from "../protocol.js";
import { createStore, getJSON, putJSON, digest } from "../storage.js";
import { commitTurn, prepareHandoff, readCommits } from "../history.js";
import { runClaude } from "../harnesses/claude.js";
import { runCodex } from "../harnesses/codex.js";
import { runPi } from "../harnesses/pi.js";

const harnesses: Record<"claude" | "codex" | "pi", Harness> = {
  claude: runClaude,
  codex: runCodex,
  pi: runPi,
};
export const multiHarness = task({
  id: "multi-harness",
  retry: { maxAttempts: 3, minTimeoutInMs: 1_000, maxTimeoutInMs: 10_000 },
  machine: "small-2x",
  run: async ({ sessionId }: { sessionId: string }, { ctx }) => {
    const store = createStore({
      deployed: ctx.environment.type !== "DEVELOPMENT",
    });
    const session = sessions.open(sessionId);
    const saved = await sessions.retrieve(sessionId);
    let head = saved.metadata?.stateKey as string | undefined;
    if (!head && saved.metadata?.nativeRevision)
      throw new Error(
        "This conversation uses the older inline storage format. Run the migration command before reopening it.",
      );
    const commits = await readCommits(store, head);
    const turns = commits.map(({ value }) => value.turn);
    const completed = new Map(
      commits.map(({ key, value }) => [
        value.turn.id,
        { key, turn: value.turn },
      ]),
    );
    const runtime = await openNative(
      sessionId,
      store,
      commits.at(-1)?.value.native,
    );
    let snapshot = commits.at(-1)?.value.native;
    let initial: Awaited<ReturnType<typeof prepareInitialUpload>> | undefined;
    let recovery = saved.metadata?.pendingKey
      ? await getJSON<Request>(store, String(saved.metadata.pendingKey))
      : undefined;
    const bootId = randomUUID();
    const stopped = new Set<string>();
    let active: { id: string; controller: AbortController } | undefined;
    const stopKey = (id: string) =>
      `stops/${digest(Buffer.from(sessionId))}/${id}`;
    const listener = session.in.on((value: unknown) => {
      const stop = stopSchema.safeParse(value);
      if (!stop.success) return;
      if (!completed.has(stop.data.requestId)) {
        stopped.add(stop.data.requestId);
        if (active?.id === stop.data.requestId) active.controller.abort();
      }
      return true;
    });
    try {
      while (true) {
        const next = recovery
          ? { ok: true as const, output: recovery }
          : await session.in.waitWithIdleTimeout<unknown>({
              idleTimeoutInSeconds: 10,
              timeout: process.env.AGENT_IDLE_TIMEOUT || "5m",
              onSuspend: async () => {
                await session.out.append({
                  type: "lifecycle",
                  phase: "suspending",
                  bootId,
                  turns: turns.length,
                });
              },
              onResume: async () => {
                await session.out.append({
                  type: "lifecycle",
                  phase: "resumed",
                  bootId,
                  turns: turns.length,
                });
              },
            });
        recovery = undefined;
        if (!next.ok || (await sessions.retrieve(sessionId)).closedAt) return;
        const parsed = requestSchema.safeParse(next.output);
        if (!parsed.success) {
          logger.warn("Ignoring an invalid harness request");
          continue;
        }
        const request = parsed.data;
        const previous = completed.get(request.id);
        if (previous) {
          if (
            previous.turn.prompt !== request.prompt ||
            previous.turn.harness !== request.harness
          )
            throw new Error("A request ID was reused with different content");
          await session.out.append({
            type: "committed",
            requestId: request.id,
            commitKey: previous.key,
          });
          continue;
        }
        const pendingKey = await putJSON(store, request);
        // Recover this request after a retry even if its input stream cursor has already advanced.
        await sessions.update(sessionId, {
          metadata: { stateKey: head ?? null, pendingKey },
        });
        const controller = new AbortController();
        active = { id: request.id, controller };
        if (
          stopped.delete(request.id) ||
          (await store.get(stopKey(request.id)))
        )
          controller.abort();
        if (!snapshot) {
          initial = await prepareInitialUpload(runtime, store);
          snapshot = initial.snapshot;
          void initial.upload();
        }
        const before = snapshot;
        const rollback = () =>
          initial ? initial.rollback() : restore(runtime, before, store);
        const wasResumed = !!runtime.handles[request.harness];
        const writer = session.out.writer<Output>({
          execute: async ({ write }) => {
            let status: Turn["status"] = "completed",
              text = "",
              partial = "";
            const emitText = (value: string, replace = false) => {
              if (replace) partial = value;
              else partial += value;
              for (let offset = 0; offset < value.length; offset += 16_000)
                write({
                  type: "text",
                  requestId: request.id,
                  text: value.slice(offset, offset + 16_000),
                  replace: replace && offset === 0,
                });
            };
            for (let attempt = 1; attempt <= 3; attempt++) {
              write({
                type: "started",
                requestId: request.id,
                harness: request.harness,
                attempt,
              });
              partial = "";
              try {
                controller.signal.throwIfAborted();
                const prompt = await prepareHandoff(
                  runtime.workspace,
                  turns,
                  runtime.handles[request.harness]?.through ?? 0,
                  request,
                );
                text = await harnesses[request.harness](
                  prompt,
                  (event) => {
                    const e = event as any;
                    if (
                      request.harness === "claude" &&
                      e.type === "stream_event" &&
                      e.event?.delta?.type === "text_delta"
                    )
                      emitText(e.event.delta.text);
                    if (
                      request.harness === "codex" &&
                      e.type === "item.completed" &&
                      e.item?.type === "agent_message"
                    )
                      emitText(e.item.text, true);
                    if (
                      request.harness === "pi" &&
                      e.type === "message_update" &&
                      e.assistantMessageEvent?.type === "text_delta"
                    )
                      emitText(e.assistantMessageEvent.delta);
                    const tool =
                      e.event?.content_block?.type === "tool_use"
                        ? e.event.content_block.name
                        : e.type === "tool_execution_start"
                          ? e.toolName
                          : e.type === "item.started" &&
                              e.item?.type === "mcp_tool_call"
                            ? `${e.item.server}/${e.item.tool}`
                            : undefined;
                    if (tool)
                      write({
                        type: "tool",
                        requestId: request.id,
                        harness: request.harness,
                        name: String(tool),
                      });
                  },
                  controller.signal,
                  runtime.workspace,
                  nativeContext(runtime, request.harness, turns.length + 1),
                );
                if (await store.get(stopKey(request.id))) controller.abort();
                controller.signal.throwIfAborted();
                break;
              } catch (error) {
                await rollback();
                if (controller.signal.aborted) {
                  status = "stopped";
                  text = partial;
                  break;
                }
                logger.error("Harness attempt failed", {
                  error,
                  attempt,
                  requestId: request.id,
                });
                if (attempt === 3) {
                  status = "failed";
                  text =
                    "The harness failed after three attempts. Check the run logs, then edit and retry.";
                  break;
                }
                write({
                  type: "retrying",
                  requestId: request.id,
                  attempt: attempt + 1,
                });
                try {
                  await delay(attempt * 1_000, undefined, {
                    signal: controller.signal,
                  });
                } catch {
                  status = "stopped";
                  text = partial;
                  break;
                }
              }
            }
            // Capture edits from the live workspace while the frozen seed uploads.
            let native = await capture(runtime, store, before);
            await initial?.upload();
            // Stop may arrive while either upload is running. Never commit those edits.
            if (
              status === "completed" &&
              (controller.signal.aborted ||
                (await store.get(stopKey(request.id))))
            ) {
              await rollback();
              native = before;
              status = "stopped";
              text = partial;
            }
            const turn: Turn = { ...request, status, text };
            const commitKey = await commitTurn(
              store,
              head,
              turns.length + 1,
              turn,
              native,
            );
            // This pointer is the commit point. Unreferenced uploads are never completed turns.
            await sessions.update(sessionId, {
              metadata: { stateKey: commitKey, pendingKey: null },
            });
            await initial?.dispose();
            initial = undefined;
            head = commitKey;
            snapshot = native;
            turns.push(turn);
            completed.set(turn.id, { key: commitKey, turn });
            active = undefined;
            stopped.delete(request.id);
            const nativeId = runtime.handles[request.harness]?.id;
            if (status === "completed" && nativeId)
              write({
                type: "native",
                requestId: request.id,
                harness: request.harness,
                id: nativeId,
                resumed: wasResumed,
                restored: !!saved.metadata?.stateKey,
              });
            write({ type: "committed", requestId: request.id, commitKey });
          },
        });
        await writer.waitUntilComplete();
      }
    } finally {
      listener.off();
      await initial?.dispose();
    }
  },
});
