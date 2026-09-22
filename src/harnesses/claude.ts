import { query } from "@anthropic-ai/claude-agent-sdk";
import { writablePath } from "./workspace-writes.js";
import type { Harness } from "../protocol.js";

export const runClaude: Harness = async (
  prompt,
  emit,
  signal,
  workspace,
  native,
) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.HARNESS_TIMEOUT_MS || 900_000),
  );
  try {
    signal.throwIfAborted();
    for await (const event of query({
      prompt,
      options: {
        cwd: workspace,
        resume: native?.id,
        env: native
          ? { ...process.env, CLAUDE_CONFIG_DIR: native.home }
          : undefined,
        model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5",
        tools: ["Read", "Glob", "Grep", "Write", "Edit"],
        allowedTools: ["Read", "Glob", "Grep", "Write", "Edit"],
        permissionMode: "dontAsk",
        settingSources: [],
        hooks: {
          PreToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PreToolUse") return {};
                  try {
                    const path = (input.tool_input as { file_path?: unknown })
                      .file_path;
                    if (typeof path !== "string")
                      throw new Error("Expected a workspace file path");
                    const target = await writablePath(workspace, path);
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "allow",
                        updatedInput: {
                          ...(input.tool_input as Record<string, unknown>),
                          file_path: target,
                        },
                      },
                    };
                  } catch (error) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason:
                          error instanceof Error
                            ? error.message
                            : "Invalid workspace write",
                      },
                    };
                  }
                },
              ],
            },
          ],
        },
        includePartialMessages: true,
        abortController: controller,
      },
    })) {
      emit(event);
      if (
        native &&
        "session_id" in event &&
        typeof event.session_id === "string"
      )
        native.saveId(event.session_id);
      if (event.type === "result") {
        if (event.subtype !== "success" || event.is_error) {
          throw new Error("Claude did not complete the turn");
        }
        return event.result;
      }
    }
    throw new Error("Claude ended without a result");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
};
