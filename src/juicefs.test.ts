import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  capture,
  restore,
  prepareInitialUpload,
  type NativeRuntime,
} from "./native-state.js";
import { FileStore } from "./storage.js";
import { JuiceFS } from "./juicefs.js";
const exec = promisify(execFile);
const roots: string[] = [];
const original = {
  meta: process.env.JUICEFS_META_URL,
  binary: process.env.JUICEFS_BINARY,
  prefix: process.env.JUICEFS_PREFIX,
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  for (const [name, value] of Object.entries({
    JUICEFS_META_URL: original.meta,
    JUICEFS_BINARY: original.binary,
    JUICEFS_PREFIX: original.prefix,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-real-jfs-"));
  roots.push(root);
  const binary = resolve(process.env.JUICEFS_TEST_BINARY!);
  const metaUrl = "sqlite3://" + join(root, "metadata.db");
  await exec(
    binary,
    [
      "format",
      "--storage",
      "file",
      "--bucket",
      join(root, "blocks"),
      metaUrl,
      "harness-test",
    ],
    { timeout: 30_000 },
  );
  process.env.JUICEFS_META_URL = metaUrl;
  process.env.JUICEFS_BINARY = binary;
  process.env.JUICEFS_PREFIX = "tests";
  const runtime: NativeRuntime = {
    root: join(root, "runtime"),
    workspace: join(root, "runtime/workspace"),
    handles: {},
  };
  await mkdir(runtime.workspace, { recursive: true });
  return {
    root,
    runtime,
    store: new FileStore(join(root, "objects")),
    juicefs: new JuiceFS({ metaUrl, binary, prefix: "tests" }),
  };
}
describe.runIf(!!process.env.JUICEFS_TEST_BINARY)(
  "real mount-free JuiceFS snapshots",
  () => {
    test("saves immutable generations and restores exact files, deletions and executable modes", async () => {
      const { root, runtime: r, store } = await fixture();
      await writeFile(join(r.workspace, "edit.txt"), "version1");
      await writeFile(join(r.workspace, "delete.txt"), "old");
      await writeFile(join(r.workspace, "run.sh"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      await chmod(join(r.workspace, "run.sh"), 0o770);
      const first = await capture(r, store);
      expect(first.blobStore).toBe("juicefs");
      await writeFile(join(r.workspace, "edit.txt"), "version2");
      await rm(join(r.workspace, "delete.txt"));
      const second = await capture(r, store, first);
      expect(second.files["workspace/run.sh"].key).toBe(
        first.files["workspace/run.sh"].key,
      );
      await rm(r.root, { recursive: true, force: true });
      await restore(r, second, store);
      expect(await readFile(join(r.workspace, "edit.txt"), "utf8")).toBe(
        "version2",
      );
      await expect(stat(join(r.workspace, "delete.txt"))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      expect((await stat(join(r.workspace, "run.sh"))).mode & 0o777).toBe(
        0o770,
      );
      await restore(r, first, store);
      expect(await readFile(join(r.workspace, "edit.txt"), "utf8")).toBe(
        "version1",
      );
      expect(await readFile(join(r.workspace, "delete.txt"), "utf8")).toBe(
        "old",
      );
      // Blob contents went through JuiceFS rather than falling back to the old store.
      await expect(stat(join(root, "objects/blobs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }, 30_000);
    test("uploads a frozen seed concurrently with live edits through the real client", async () => {
      const { runtime: r, store } = await fixture();
      await writeFile(join(r.workspace, "proof.txt"), "original");
      const initial = await prepareInitialUpload(r, store);
      try {
        const pending = initial.upload();
        await writeFile(join(r.workspace, "proof.txt"), "modified");
        const changed = await capture(r, store, initial.snapshot);
        await pending;
        await restore(r, changed, store);
        expect(await readFile(join(r.workspace, "proof.txt"), "utf8")).toBe(
          "modified",
        );
        await restore(r, initial.snapshot, store);
        expect(await readFile(join(r.workspace, "proof.txt"), "utf8")).toBe(
          "original",
        );
      } finally {
        await initial.dispose();
      }
    }, 30_000);
    test("rejects corrupt remote content before replacing the current workspace", async () => {
      const { root, runtime: r, store, juicefs } = await fixture();
      await writeFile(join(r.workspace, "proof.txt"), "good");
      const saved = await capture(r, store);
      const key = saved.files["workspace/proof.txt"].key;
      const corrupt = join(root, "corrupt");
      await mkdir(join(corrupt, "blobs"), { recursive: true });
      await writeFile(join(corrupt, key), "evil");
      await juicefs.upload(corrupt, [key]);
      await expect(restore(r, saved, store)).rejects.toThrow(
        "corrupt snapshot",
      );
      expect(await readFile(join(r.workspace, "proof.txt"), "utf8")).toBe(
        "good",
      );
    }, 30_000);
    test("rejects invalid content keys before invoking the client", async () => {
      const { juicefs, root } = await fixture();
      await expect(juicefs.download(root, ["../escape"])).rejects.toThrow(
        "Invalid JuiceFS content key",
      );
    }, 30_000);
  },
);
