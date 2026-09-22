import { task } from "@trigger.dev/sdk";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareInitialUpload,
  capture,
  restore,
  nativeContext,
  type NativeRuntime,
} from "../native-state.js";
import { createStore, putJSON, getJSON } from "../storage.js";
import { runPi } from "../harnesses/pi.js";

export const backgroundUploadProbe = task({
  id: "juicefs-background-upload-probe",
  machine: "small-2x",
  retry: { maxAttempts: 1 },
  run: async (
    { stopAfterWrite = false }: { stopAfterWrite?: boolean },
    { ctx },
  ) => {
    const store = createStore({
      deployed: ctx.environment.type !== "DEVELOPMENT",
    });
    const root = await mkdtemp(join(tmpdir(), "background-upload-probe-"));
    const runtime: NativeRuntime = {
      root,
      workspace: join(root, "workspace"),
      handles: {},
    };
    const controller = new AbortController();
    let initial: Awaited<ReturnType<typeof prepareInitialUpload>> | undefined;
    try {
      await mkdir(runtime.workspace);
      for (let i = 0; i < 1000; i++)
        await writeFile(
          join(runtime.workspace, `${i}.txt`),
          randomBytes(16384),
        );
      const original = await readFile(join(runtime.workspace, "0.txt"));
      const started = performance.now();
      const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
      const times: Record<string, number> = {};
      initial = await prepareInitialUpload(runtime, store);
      times.harnessReadyMs = elapsed();
      const background = initial.upload().then(() => {
        times.initialUploadCompleteMs = elapsed();
      });
      void background.catch(() => {});
      try {
        await runPi(
          "Use write_file to replace 0.txt with exactly background-edit-verified followed by a newline. Do not read the other files. Confirm the write briefly.",
          (event) => {
            const e = event as any;
            if (
              e.type === "message_update" &&
              e.assistantMessageEvent?.type === "text_delta"
            )
              times.firstTextMs ??= elapsed();
            if (
              e.type === "tool_execution_end" &&
              e.toolName === "write_file" &&
              !e.isError
            ) {
              times.fileWrittenMs = elapsed();
              if (stopAfterWrite) controller.abort();
            }
          },
          controller.signal,
          runtime.workspace,
          nativeContext(runtime, "pi", 1),
        );
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (
          (await readFile(join(runtime.workspace, "0.txt"), "utf8")) !==
          "background-edit-verified\n"
        )
          throw new Error("Expected real write before stop");
        await initial.rollback();
        times.localRollbackCompleteMs = elapsed();
        if (
          !(await readFile(join(runtime.workspace, "0.txt"))).equals(original)
        )
          throw new Error("Local rollback failed");
      }
      times.harnessFinishedMs = elapsed();
      const native = await capture(runtime, store, initial.snapshot);
      times.deltaUploadCompleteMs = elapsed();
      await background;
      if (stopAfterWrite && !controller.signal.aborted)
        throw new Error("Stop was not exercised");
      const snapshotKey = await putJSON(store, native);
      times.committedMs = elapsed();
      await initial.dispose();
      initial = undefined;
      await rm(root, { recursive: true, force: true });
      await restore(runtime, await getJSON(store, snapshotKey), store);
      const restored = await readFile(join(runtime.workspace, "0.txt"));
      if (
        stopAfterWrite
          ? !restored.equals(original)
          : restored.toString() !== "background-edit-verified\n"
      )
        throw new Error("Saved workspace mismatch");
      return {
        runId: ctx.run.id,
        files: 1000,
        bytes: 16384000,
        stopAfterWrite,
        times,
        overlapped: times.fileWrittenMs < times.initialUploadCompleteMs,
        localRollbackBeforeUpload: stopAfterWrite
          ? times.localRollbackCompleteMs < times.initialUploadCompleteMs
          : undefined,
        restored: true,
      };
    } finally {
      await initial?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
});
