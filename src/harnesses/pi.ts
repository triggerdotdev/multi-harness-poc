import { mkdir, readFile, access } from "node:fs/promises";
import { writablePath, writeWorkspaceFile } from "./workspace-writes.js";
import { basename, join } from "node:path";
import {
  createAgentSession,
  defineTool,
  createWriteToolDefinition,
  createEditToolDefinition,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Harness } from "../protocol.js";

export const runPi: Harness = async (
  prompt,
  emit,
  signal,
  workspace,
  native,
) => {
  signal.throwIfAborted();
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(
    "anthropic",
    process.env.PI_MODEL ?? "claude-haiku-4-5",
  );
  if (!model) throw new Error("Pi model is not available");
  const manager = native
    ? native.id
      ? SessionManager.open(
          join(native.home, basename(native.id)),
          native.home,
          workspace,
        )
      : SessionManager.create(workspace, native.home)
    : SessionManager.inMemory();
  const { session } = await createAgentSession({
    cwd: workspace,
    modelRuntime,
    model,
    tools: ["read", "grep", "find", "ls", "write_file", "edit_file"],
    customTools: [
      defineTool({
        ...createWriteToolDefinition(workspace, {
          operations: {
            mkdir: async (path) => {
              await mkdir(await writablePath(workspace, path, true), {
                recursive: true,
              });
            },
            writeFile: (path, content) =>
              writeWorkspaceFile(workspace, path, content),
          },
        }),
        name: "write_file",
      }),
      defineTool({
        ...createEditToolDefinition(workspace, {
          operations: {
            access: async (path) => {
              await access(await writablePath(workspace, path));
            },
            readFile: async (path) =>
              readFile(await writablePath(workspace, path)),
            writeFile: (path, content) =>
              writeWorkspaceFile(workspace, path, content),
          },
        }),
        name: "edit_file",
      }),
    ],
    sessionManager: manager,
  });
  session.setAutoCompactionEnabled(true);
  const abort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  const unsubscribe = session.subscribe(emit);
  const timeout = setTimeout(
    () => void session.abort(),
    Number(process.env.HARNESS_TIMEOUT_MS || 900_000),
  );
  try {
    signal.throwIfAborted();
    await session.prompt(prompt);
    signal.throwIfAborted();
    const message = session.messages.findLast((m) => m.role === "assistant");
    if (!message || message.role !== "assistant")
      throw new Error("Pi ended without a response");
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "Pi did not complete the turn");
    }
    const file = manager.getSessionFile();
    if (file) native?.saveId(basename(file));
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
};
