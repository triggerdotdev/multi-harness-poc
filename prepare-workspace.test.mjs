import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareWorkspace } from "./scripts/prepare-workspace.mjs";
const roots = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-import-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
test("imports a curated source folder without hidden files, credentials, dependencies, or symlinks", async () => {
  const root = await fixture();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  for (const [name, content] of Object.entries({
    "README.md": "Example",
    "src/app.ts": "export const answer = 42;",
    ".env": "PRIVATE=excluded",
    "auth.json": "{}",
    "credentials.json": "{}",
    "node_modules/dependency.js": "excluded",
    "pnpm-lock.yaml": "excluded",
    "image.json": "\0binary",
  }))
    await writeFile(join(root, name), content);
  await symlink(join(root, "README.md"), join(root, "linked.md"));
  const result = await prepareWorkspace(root);
  expect(result.files).toEqual({
    "README.md": "Example",
    "src/app.ts": "export const answer = 42;",
  });
});
test("imports larger source trees and still rejects an empty folder", async () => {
  const root = await fixture();
  await expect(prepareWorkspace(root)).rejects.toThrow(
    "No supported source files",
  );
  await writeFile(join(root, "large.ts"), "a".repeat(65537));
  expect((await prepareWorkspace(root)).files["large.ts"]).toHaveLength(65537);
  await rm(join(root, "large.ts"));
  await Promise.all(
    Array.from({ length: 101 }, (_, i) =>
      writeFile(join(root, `${i}.ts`), "a"),
    ),
  );
  expect(Object.keys((await prepareWorkspace(root)).files)).toHaveLength(101);
});
