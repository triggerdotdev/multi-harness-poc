import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

/** Resolve a writable workspace path, including new files, without following symlinks. */
export async function writablePath(
  workspace: string,
  input: string,
  directory = false,
) {
  const root = await realpath(workspace);
  const target = resolve(workspace, input);
  const outside = (path: string) =>
    path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  let local = relative(root, target);
  if (outside(local)) local = relative(resolve(workspace), target);
  if (outside(local) || (!directory && !local))
    throw new Error("Write path is outside the workspace");
  const parts = local.split(sep).filter(Boolean);
  if (
    [".conversation", ".git"].includes(parts[0]) ||
    parts[0]?.startsWith(".checkpoint-")
  )
    throw new Error("This workspace path is managed by the application");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new Error("Writes through symlinks are not allowed");
  }
  return current;
}
export async function writeWorkspaceFile(
  workspace: string,
  path: string,
  content: string,
) {
  const target = await writablePath(workspace, path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.write-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
