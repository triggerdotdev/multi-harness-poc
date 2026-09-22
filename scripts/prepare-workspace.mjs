import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const excluded = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "auth.json",
  "credentials.json",
]);
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".sql",
  ".css",
  ".html",
  ".vue",
  ".svelte",
  ".sh",
]);
function included(path) {
  const parts = path.split(/[\\/]/);
  return (
    !parts.some((p) => p.startsWith(".") || excluded.has(p.toLowerCase())) &&
    extensions.has(extname(path).toLowerCase())
  );
}

export async function prepareWorkspace(directory) {
  const root = await realpath(resolve(directory));
  let candidates;
  try {
    // Only tracked files when the source is a Git checkout; use their current on-disk contents.
    const { stdout } = await exec(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--", "."],
      { maxBuffer: Infinity },
    );
    candidates = stdout.split("\0").filter(Boolean);
  } catch (error) {
    if (error.code !== 128)
      throw new Error(
        "Could not list source files. Install Git and check the directory.",
      );
    candidates = [];
    async function walk(path = "") {
      for (const entry of await readdir(join(root, path), {
        withFileTypes: true,
      })) {
        if (
          entry.name.startsWith(".") ||
          excluded.has(entry.name.toLowerCase()) ||
          entry.isSymbolicLink()
        )
          continue;
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile()) candidates.push(name);
      }
    }
    await walk();
  }
  const files = {};
  let bytes = 0;
  for (const name of candidates.sort()) {
    if (!included(name)) continue;
    const path = join(root, name);
    if ((await lstat(path)).isSymbolicLink()) continue;
    const local = relative(root, await realpath(path));
    if (
      local === ".." ||
      local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(local)
    )
      continue;
    const info = await lstat(path);
    if (!info.isFile()) continue;
    const data = await readFile(path);
    if (data.includes(0)) continue;
    bytes += data.length;
    files[name.replaceAll("\\", "/")] = data.toString("utf8");
  }
  if (!Object.keys(files).length)
    throw new Error(
      "No supported source files found. Use a directory with tracked source files or a curated non-Git folder.",
    );
  return { files, bytes };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = process.argv.slice(2).filter((arg) => arg !== "--")[0];
  if (!directory) {
    console.error(
      "Usage: pnpm run workspace /path/to/repository-or-subdirectory",
    );
    process.exitCode = 1;
  } else {
    try {
      const { files, bytes } = await prepareWorkspace(directory);
      await writeFile(
        new URL("../src/workspace-files.json", import.meta.url),
        `${JSON.stringify(files, null, 2)}\n`,
      );
      console.log(
        `Prepared ${Object.keys(files).length} files (${Math.ceil(bytes / 1024)} KiB) in src/workspace-files.json.`,
      );
      console.log(
        "Review that file before starting or deploying. Start a new conversation to use the new workspace.",
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
