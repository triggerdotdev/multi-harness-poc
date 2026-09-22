import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileStore, type ObjectStore } from "./src/storage.js";
import {
  capture,
  openNative,
  prepareInitialUpload,
  restore,
  type NativeRuntime,
} from "./src/native-state.js";

test("new workspaces use bundled files without accessing remote storage", async () => {
  const inaccessible: ObjectStore = {
    get: async () => {
      throw new Error("Remote storage accessed during startup");
    },
    put: async () => {
      throw new Error("Remote storage accessed during startup");
    },
  };
  const runtime = await openNative(randomUUID(), inaccessible);
  try {
    expect(
      await readFile(join(runtime.workspace, "README.md"), "utf8"),
    ).toContain("Release Notes Demo");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("a blocked initial upload preserves frozen bytes while edits and rollback proceed locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "initial-upload-test-"));
  const runtime: NativeRuntime = {
    root: join(root, "runtime"),
    workspace: join(root, "runtime/workspace"),
    handles: {},
  };
  const remote = new FileStore(join(root, "remote"));
  let release!: () => void;
  const gate = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    resolve: () => release(),
  };
  let finished = false;
  let prepared: Awaited<ReturnType<typeof prepareInitialUpload>> | undefined;
  try {
    await mkdir(runtime.workspace, { recursive: true });
    await writeFile(join(runtime.workspace, "proof.txt"), "original");
    prepared = await prepareInitialUpload(runtime, {
      get: (key) => remote.get(key),
      put: async (key, body) => {
        await gate.promise;
        await remote.put(key, body);
      },
    });
    const pending = prepared.upload().then(() => {
      finished = true;
    });
    await writeFile(join(runtime.workspace, "proof.txt"), "modified");
    runtime.handles.pi = { id: "partial-session", through: 1 };
    const changed = await capture(runtime, remote, prepared.snapshot);
    expect(finished).toBe(false);
    expect(
      await remote.get(prepared.snapshot.files["workspace/proof.txt"].key),
    ).toBeUndefined();
    await prepared.rollback();
    expect(await readFile(join(runtime.workspace, "proof.txt"), "utf8")).toBe(
      "original",
    );
    expect(runtime.handles).toEqual({});
    expect(finished).toBe(false);
    gate.resolve();
    await pending;
    await restore(runtime, changed, remote);
    expect(await readFile(join(runtime.workspace, "proof.txt"), "utf8")).toBe(
      "modified",
    );
    await restore(runtime, prepared.snapshot, remote);
    expect(await readFile(join(runtime.workspace, "proof.txt"), "utf8")).toBe(
      "original",
    );
  } finally {
    gate.resolve();
    await prepared?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("background upload failure remains a commit barrier but does not prevent local rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "initial-failure-test-"));
  const runtime: NativeRuntime = {
    root,
    workspace: join(root, "workspace"),
    handles: {},
  };
  await mkdir(runtime.workspace);
  await writeFile(join(runtime.workspace, "proof.txt"), "original");
  const prepared = await prepareInitialUpload(runtime, {
    get: async () => undefined,
    put: async () => {
      throw new Error("Upload unavailable");
    },
  });
  try {
    void prepared.upload();
    await writeFile(join(runtime.workspace, "proof.txt"), "modified");
    await prepared.rollback();
    expect(await readFile(join(runtime.workspace, "proof.txt"), "utf8")).toBe(
      "original",
    );
    await expect(prepared.upload()).rejects.toThrow("Upload unavailable");
  } finally {
    await prepared.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
