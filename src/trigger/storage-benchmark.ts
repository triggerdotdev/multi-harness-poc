import { task } from "@trigger.dev/sdk";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture, restore, type NativeRuntime } from "../native-state.js";
import { createStore, getJSON, putJSON } from "../storage.js";
import type { Commit } from "../history.js";

export const storageBenchmark = task({
  id: "juicefs-storage-benchmark",
  machine: "small-2x",
  retry: { maxAttempts: 1 },
  run: async ({ commitKey }: { commitKey?: string }, { ctx }) => {
    if (!process.env.JUICEFS_META_URL) throw new Error("JuiceFS required");
    const store = createStore({
      deployed: ctx.environment.type !== "DEVELOPMENT",
    });
    const samples: Record<string, unknown>[] = [];
    async function measured<T>(
      row: Record<string, unknown>,
      name: string,
      fn: () => Promise<T>,
    ) {
      const start = performance.now();
      const result = await fn();
      row[name] = Math.round((performance.now() - start) * 10) / 10;
      return result;
    }
    if (commitKey) {
      const commit = await getJSON<Commit>(store, commitKey);
      for (let iteration = 0; iteration < 3; iteration++) {
        const root = await mkdtemp(join(tmpdir(), "jfs-real-benchmark-"));
        const runtime: NativeRuntime = {
          root,
          workspace: join(root, "workspace"),
          handles: {},
        };
        const row: Record<string, unknown> = {
          scenario: "saved conversation",
          iteration,
          files: Object.keys(commit.native.files).length,
          bytes: Object.values(commit.native.files).reduce(
            (n, f) => n + f.bytes,
            0,
          ),
        };
        try {
          await measured(row, "restoreMs", () =>
            restore(runtime, commit.native, store),
          );
          await measured(row, "unchangedCaptureMs", () =>
            capture(runtime, store, commit.native),
          );
          samples.push(row);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
    for (const [files, bytesPerFile] of [
      [100, 4096],
      [1000, 16384],
    ]) {
      for (let iteration = 0; iteration < 3; iteration++) {
        const root = await mkdtemp(join(tmpdir(), "jfs-synthetic-benchmark-"));
        const runtime: NativeRuntime = {
          root,
          workspace: join(root, "workspace"),
          handles: {},
        };
        const row: Record<string, unknown> = {
          scenario: `${files} files`,
          iteration,
          files,
          bytes: files * bytesPerFile,
        };
        try {
          await mkdir(runtime.workspace);
          for (let i = 0; i < files; i++)
            await writeFile(
              join(runtime.workspace, `${i}.txt`),
              randomBytes(bytesPerFile),
            );
          const first = await measured(row, "initialCaptureMs", () =>
            capture(runtime, store),
          );
          await measured(row, "manifestPutMs", () => putJSON(store, first));
          await measured(row, "unchangedCaptureMs", () =>
            capture(runtime, store, first),
          );
          const changed = randomBytes(bytesPerFile);
          await writeFile(join(runtime.workspace, "0.txt"), changed);
          const next = await measured(row, "oneFileEditCaptureMs", () =>
            capture(runtime, store, first),
          );
          await rm(runtime.root, { recursive: true, force: true });
          await measured(row, "restoreMs", () => restore(runtime, next, store));
          if (
            !(await readFile(join(runtime.workspace, "0.txt"))).equals(changed)
          )
            throw new Error("Restored bytes differ");
          samples.push(row);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
    return {
      runId: ctx.run.id,
      measurement:
        "wall clock milliseconds, sequential trials, fresh CLI processes; caches not forcibly flushed; random incompressible synthetic data",
      samples,
    };
  },
});
