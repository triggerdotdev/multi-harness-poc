import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
  writablePath,
  writeWorkspaceFile,
} from "./src/harnesses/workspace-writes.js";
import { capture, restore, type NativeRuntime } from "./src/native-state.js";
import { FileStore } from "./src/storage.js";
test("workspace writes create files, stay inside the copy, and roll back to a committed snapshot", async () => {
  const base = await mkdtemp(join(tmpdir(), "workspace-writes-"));
  const root = join(base, "runtime"),
    workspace = join(root, "workspace");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(base, "original.txt"), "original");
    const store = new FileStore(join(base, "objects"));
    const runtime: NativeRuntime = { root, workspace, handles: {} };
    await writeWorkspaceFile(
      workspace,
      "src/example.ts",
      "export const version = 1;",
    );
    const committed = await capture(runtime, store);
    await writeWorkspaceFile(
      workspace,
      "src/example.ts",
      "export const version = 2;",
    );
    await writeWorkspaceFile(workspace, "partial.txt", "unfinished turn");
    await symlink(base, join(workspace, "outside-directory"));
    await symlink(join(base, "original.txt"), join(workspace, "outside-file"));
    for (const path of [
      "../escape.txt",
      join(base, "original.txt"),
      "outside-file",
      "outside-directory/new.txt",
      ".conversation/turn.json",
      ".git/config",
    ]) {
      await expect(
        writeWorkspaceFile(workspace, path, "blocked"),
      ).rejects.toThrow();
    }
    expect(await readFile(join(base, "original.txt"), "utf8")).toBe("original");
    await restore(runtime, committed, store);
    expect(await readFile(join(workspace, "src/example.ts"), "utf8")).toBe(
      "export const version = 1;",
    );
    await expect(
      readFile(join(workspace, "partial.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await writablePath(workspace, join(workspace, "new.txt"))).toContain(
      "new.txt",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
