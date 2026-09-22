import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { repositoryTools } from "./repository-tools.js";
import type { Harness } from "../protocol.js";

export const runCodex: Harness = async (
  prompt,
  emit,
  signal,
  workspace,
  native,
) => {
  const codex = new Codex({
    env: native
      ? {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          CODEX_HOME: native.home,
        }
      : undefined,
    apiKey: process.env.CODEX_API_KEY,
    config: {
      features: { shell_tool: false },
      developer_instructions:
        "Use the repository MCP tools to read, create, and edit files in the supplied workspace. The user has authorized workspace edits. Shell commands are disabled.",
      mcp_servers: {
        repository: {
          command: process.execPath,
          args: ["--input-type=module", "-e", repositoryTools],
          env: { AGENT_WORKSPACE: workspace },
          tools: {
            write_file: { approval_mode: "approve" },
            edit_file: { approval_mode: "approve" },
          },
        },
      },
    },
  });
  const options: ThreadOptions = {
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    model: process.env.CODEX_MODEL,
  };
  const thread = native?.id
    ? codex.resumeThread(native.id, options)
    : codex.startThread(options);
  const { events } = await thread.runStreamed(prompt, {
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(Number(process.env.HARNESS_TIMEOUT_MS || 900_000)),
    ]),
  });
  let text = "";
  for await (const event of events) {
    emit(event);
    if (event.type === "thread.started") native?.saveId(event.thread_id);
    if (
      event.type === "item.completed" &&
      event.item.type === "agent_message"
    ) {
      text = event.item.text;
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "turn.completed") return text;
  }
  throw new Error("Codex ended without a completed turn");
};
