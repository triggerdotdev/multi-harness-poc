import { task, wait } from "@trigger.dev/sdk";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore, getJSON, putJSON } from "../storage.js";
import {
  capture,
  restore,
  type NativeRuntime,
  type NativeSnapshot,
} from "../native-state.js";

export const juicefsStorageProbe = task({
  id: "juicefs-storage-probe",
  machine: "small-2x",
  retry: { maxAttempts: 1 },
  run: async (
    payload: {
      mode: "egress" | "write" | "read";
      snapshotKey?: string;
      marker?: string;
      waitSeconds?: number;
    },
    { ctx },
  ) => {
    if (payload.mode === "egress") {
      const response = await fetch("https://checkip.amazonaws.com", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Egress lookup failed");
      return { egressIp: (await response.text()).trim() };
    }
    const store = createStore({
      deployed: ctx.environment.type !== "DEVELOPMENT",
    });
    const root = await mkdtemp(join(tmpdir(), "jfs-storage-probe-"));
    const runtime: NativeRuntime = {
      root,
      workspace: join(root, "workspace"),
      handles: {},
    };
    try {
      await mkdir(runtime.workspace);
      let snapshot: NativeSnapshot;
      let key = payload.snapshotKey;
      const marker = payload.marker ?? randomUUID();
      if (payload.mode === "write") {
        await writeFile(join(runtime.workspace, "proof.txt"), marker);
        await writeFile(
          join(runtime.workspace, "run.sh"),
          "#!/bin/sh\nexit 0\n",
          { mode: 0o755 },
        );
        snapshot = await capture(runtime, store);
        if (snapshot.blobStore !== "juicefs")
          throw new Error("Expected JuiceFS snapshot");
        key = await putJSON(store, snapshot);
      } else {
        if (!key || !payload.marker)
          throw new Error("Read probe needs snapshotKey and marker");
        snapshot = await getJSON<NativeSnapshot>(store, key);
      }
      await rm(runtime.workspace, { recursive: true, force: true });
      if (payload.waitSeconds) await wait.for({ seconds: payload.waitSeconds });
      await restore(runtime, snapshot, store);
      if (
        (await readFile(join(runtime.workspace, "proof.txt"), "utf8")) !==
        marker
      )
        throw new Error("Restored file mismatch");
      if (
        ((await stat(join(runtime.workspace, "run.sh"))).mode & 0o777) !==
        0o755
      )
        throw new Error("Executable mode was not restored");
      // Exercise a same-size change and rollback without mutating the saved turn.
      await writeFile(
        join(runtime.workspace, "proof.txt"),
        "x".repeat(marker.length),
      );
      await restore(runtime, snapshot, store);
      if (
        (await readFile(join(runtime.workspace, "proof.txt"), "utf8")) !==
        marker
      )
        throw new Error("Rollback mismatch");
      return {
        snapshotKey: key,
        marker,
        restored: true,
        rollback: true,
        blobStore: snapshot.blobStore,
        runId: ctx.run.id,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});
