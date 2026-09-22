import { juicefsExtension } from "./src/build/juicefs.js";
import { loadEnvFile } from "node:process";
import { defineConfig } from "@trigger.dev/sdk";
import { aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

// The CLI resolves this config before loading its --env-file into process.env.
try {
  loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const project =
  process.env.TRIGGER_PROJECT_REF || process.env.MULTI_HARNESS_PROJECT_REF;
if (!project)
  throw new Error(
    "Set TRIGGER_PROJECT_REF in .env before starting the worker.",
  );

export default defineConfig({
  project,
  runtime: "node-24",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  retries: { enabledInDev: true, default: { maxAttempts: 3 } },
  build: {
    external: [
      "@anthropic-ai/claude-agent-sdk",
      "@openai/codex-sdk",
      "@earendil-works/pi-coding-agent",
      "@modelcontextprotocol/sdk",
    ],
    extensions: [
      aptGet({ packages: ["git", "ripgrep", "curl", "ca-certificates"] }),
      juicefsExtension(),
      syncEnvVars(async () => [
        { name: "MULTI_HARNESS_PROJECT_REF", value: project },
        ...["ANTHROPIC_API_KEY", "CODEX_API_KEY", "JUICEFS_META_URL"].flatMap(
          (name) =>
            process.env[name]
              ? [{ name, value: process.env[name]!, isSecret: true }]
              : [],
        ),
        ...[
          "CODEX_MODEL",
          "CLAUDE_MODEL",
          "PI_MODEL",
          "AGENT_IDLE_TIMEOUT",
          "HARNESS_TIMEOUT_MS",
          "STORAGE_BUCKET",
          "STORAGE_PREFIX",
          "STORAGE_ENDPOINT",
          "STORAGE_FORCE_PATH_STYLE",
          "AWS_REGION",
          "JUICEFS_PREFIX",
          "JUICEFS_CA_CERT",
        ].flatMap((name) =>
          process.env[name] ? [{ name, value: process.env[name]! }] : [],
        ),
      ]),
    ],
  },
});
