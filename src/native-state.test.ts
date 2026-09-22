import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { capture, restore, type NativeRuntime } from "./native-state.js";
import { FileStore } from "./storage.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-snapshot-test-"));
  roots.push(root);
  const runtime: NativeRuntime = {
    root: join(root, "runtime"),
    workspace: join(root, "runtime/workspace"),
    handles: {},
  };
  for (const name of [
    "workspace",
    "claude/projects/demo",
    "codex/sessions",
    "pi",
  ])
    await mkdir(join(runtime.root, name), { recursive: true });
  return { runtime, store: new FileStore(join(root, "objects")) };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("restores more than 4 MiB of workspace/native files, rolls back partial writes, and excludes credentials", async () => {
  const { runtime: r, store } = await fixture();
  r.handles.claude = { id: randomUUID(), through: 24 };
  const large = randomBytes(6 * 1024 * 1024);
  await writeFile(join(r.workspace, "large.bin"), large);
  await writeFile(
    join(r.root, "claude/projects/demo/turn.jsonl"),
    '{"tool_result":"remembered"}\n',
  );
  await writeFile(join(r.root, "claude/auth.json"), "never archive this");
  const snapshot = await capture(r, store);
  expect(snapshot.files["claude/auth.json"]).toBeUndefined();
  expect(JSON.stringify(snapshot).length).toBeLessThan(1000);
  await writeFile(join(r.workspace, "partial.txt"), "unfinished");
  r.handles.claude!.through = 25;
  await restore(r, snapshot, store);
  expect((await readFile(join(r.workspace, "large.bin"))).equals(large)).toBe(
    true,
  );
  await expect(
    readFile(join(r.workspace, "partial.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(r.handles.claude?.through).toBe(24);
  expect(await capture(r, store, snapshot)).toEqual(snapshot);
});
it("a corrupt object cannot replace the current workspace", async () => {
  const { runtime: r, store } = await fixture();
  await writeFile(join(r.workspace, "README.md"), "original");
  const snapshot = await capture(r, store);
  await store.put(
    snapshot.files["workspace/README.md"].key,
    Buffer.from("corrupt"),
  );
  await expect(restore(r, snapshot, store)).rejects.toThrow("corrupt snapshot");
  expect(await readFile(join(r.workspace, "README.md"), "utf8")).toBe(
    "original",
  );
});
it.each([
  "workspace/../../escape",
  "claude/auth.json",
  "/absolute",
  "codex/sessions/../auth.json",
])("rejects snapshot path %s before writing", async (path) => {
  const { runtime, store } = await fixture();
  await expect(
    restore(
      runtime,
      {
        version: 2,
        handles: {},
        files: { [path]: { key: `blobs/${"a".repeat(64)}`, bytes: 1 } },
      },
      store,
    ),
  ).rejects.toThrow("Invalid native snapshot path");
});
