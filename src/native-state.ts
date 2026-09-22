import workspaceFiles from "./workspace-files.json" with { type: "json" };
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
  stat,
  mkdtemp,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FileStore, digest, type ObjectStore } from "./storage.js";
import { configuredJuiceFS } from "./juicefs.js";
import type { Request } from "./protocol.js";

const handle = z.object({
  id: z.string().min(1),
  through: z.number().int().nonnegative(),
});
const schema = z.object({
  version: z.literal(2),
  blobStore: z.literal("juicefs").optional(),
  handles: z.object({
    claude: handle.optional(),
    codex: handle.optional(),
    pi: handle.optional(),
  }),
  files: z.record(
    z.string(),
    z.object({
      key: z.string().regex(/^blobs\/[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      mode: z.number().int().min(0).max(0o777).optional(),
    }),
  ),
});
export type NativeSnapshot = z.infer<typeof schema>;
export type NativeContext = {
  home: string;
  id?: string;
  saveId: (id: string) => void;
};
export type NativeRuntime = {
  root: string;
  workspace: string;
  handles: NativeSnapshot["handles"];
};
const directories = ["workspace", "claude/projects", "codex/sessions", "pi"];
function allowed(path: string): boolean {
  if (
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  if (
    path.startsWith("workspace/.conversation/") ||
    path.startsWith("workspace/.checkpoint-")
  )
    return false;
  return (
    path.startsWith("workspace/") ||
    /^(claude\/projects|codex\/sessions|pi)\/.+\.jsonl$/.test(path)
  );
}
/** Freeze contents before allowing a harness to edit the live workspace. */
async function stageCapture(
  runtime: NativeRuntime,
  store: ObjectStore,
  previous?: NativeSnapshot,
) {
  const files: NativeSnapshot["files"] = {};
  const juicefs = configuredJuiceFS();
  const stage = await mkdtemp(join(tmpdir(), "harness-upload-"));
  const local = new FileStore(stage);
  const keys = new Set<string>();
  async function walk(relative: string) {
    const entries = await readdir(join(runtime.root, relative), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = `${relative}/${entry.name}`;
      if (
        path === "workspace/.conversation" ||
        path.startsWith("workspace/.checkpoint-")
      )
        continue;
      if (entry.isSymbolicLink())
        throw new Error("Workspace snapshots cannot contain symlinks");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && allowed(path)) {
        const body = await readFile(join(runtime.root, path));
        const key = `blobs/${digest(body)}`;
        const sameStore = (previous?.blobStore === "juicefs") === !!juicefs;
        if (
          (!sameStore || previous?.files[path]?.key !== key) &&
          !keys.has(key)
        ) {
          await local.put(key, body);
          keys.add(key);
        }
        files[path] = {
          key,
          bytes: body.length,
          mode: (await stat(join(runtime.root, path))).mode & 0o777,
        };
      }
    }
  }
  try {
    for (const path of directories) await walk(path);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  const snapshot: NativeSnapshot = {
    version: 2,
    ...(juicefs ? { blobStore: "juicefs" as const } : {}),
    handles: structuredClone(runtime.handles),
    files,
  };
  let pending: Promise<NativeSnapshot> | undefined;
  return {
    snapshot,
    upload() {
      if (!pending) {
        pending = (async () => {
          if (juicefs) await juicefs.upload(stage, [...keys]);
          else
            for (const key of keys)
              await store.put(key, (await local.get(key))!);
          return snapshot;
        })();
        // A first turn may run longer than an upload that fails. Observe rejection now,
        // while preserving it for the caller's durability barrier before committing.
        void pending.catch(() => {});
      }
      return pending;
    },
    async rollback() {
      if (previous)
        throw new Error("Only a full staged snapshot can restore locally");
      await restore(runtime, { ...snapshot, blobStore: undefined }, local);
    },
    async dispose() {
      // Keep the frozen files alive until the child process has finished reading them.
      await pending?.catch(() => {});
      await rm(stage, { recursive: true, force: true });
    },
  };
}

export async function prepareInitialUpload(
  runtime: NativeRuntime,
  store: ObjectStore,
) {
  return stageCapture(runtime, store);
}

export async function capture(
  runtime: NativeRuntime,
  store: ObjectStore,
  previous?: NativeSnapshot,
): Promise<NativeSnapshot> {
  const staged = await stageCapture(runtime, store, previous);
  try {
    return await staged.upload();
  } finally {
    await staged.dispose();
  }
}
export function validateSnapshot(value: unknown) {
  const snapshot = schema.parse(value);
  for (const path of Object.keys(snapshot.files))
    if (!allowed(path)) throw new Error("Invalid native snapshot path");
  return snapshot;
}
export async function restore(
  runtime: NativeRuntime,
  value: unknown,
  store: ObjectStore,
) {
  const snapshot = validateSnapshot(value);
  const stage = `${runtime.root}-restore-${randomUUID()}`;
  const downloaded = `${stage}-blobs`;
  const juicefs =
    snapshot.blobStore === "juicefs" ? configuredJuiceFS() : undefined;
  if (snapshot.blobStore === "juicefs" && !juicefs)
    throw new Error(
      "This conversation requires JUICEFS_META_URL to restore its workspace",
    );
  try {
    for (const path of directories)
      await mkdir(join(stage, path), { recursive: true, mode: 0o700 });
    if (juicefs)
      await juicefs.download(
        downloaded,
        Object.values(snapshot.files).map((file) => file.key),
      );
    for (const [path, reference] of Object.entries(snapshot.files)) {
      const body = juicefs
        ? await readFile(join(downloaded, reference.key)).catch(() => undefined)
        : await store.get(reference.key);
      if (
        !body ||
        body.length !== reference.bytes ||
        digest(body) !== reference.key.slice(6)
      )
        throw new Error(`Missing or corrupt snapshot file: ${path}`);
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await writeFile(join(stage, path), body, {
        mode: reference.mode ?? 0o600,
      });
      await chmod(join(stage, path), reference.mode ?? 0o600);
    }
    // Validate/download everything before replacing anything. A failed download preserves the current workspace.
    for (const path of directories) {
      await mkdir(dirname(join(runtime.root, path)), { recursive: true });
      await rm(join(runtime.root, path), { recursive: true, force: true });
      await rename(join(stage, path), join(runtime.root, path));
    }
    runtime.handles = structuredClone(snapshot.handles);
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(downloaded, { recursive: true, force: true });
  }
}
export async function openNative(
  sessionId: string,
  store: ObjectStore,
  snapshot?: NativeSnapshot,
): Promise<NativeRuntime> {
  const root = join(
    tmpdir(),
    `harness-native-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`,
  );
  const runtime: NativeRuntime = {
    root,
    workspace: join(root, "workspace"),
    handles: {},
  };
  if (snapshot) await restore(runtime, snapshot, store);
  else {
    const initial: NativeSnapshot = { version: 2, handles: {}, files: {} };
    const seed = await mkdtemp(join(tmpdir(), "harness-seed-"));
    const local = new FileStore(seed);
    try {
      for (const [path, content] of Object.entries(workspaceFiles)) {
        const body = Buffer.from(content);
        const key = `blobs/${digest(body)}`;
        await local.put(key, body);
        initial.files[`workspace/${path}`] = {
          key,
          bytes: body.length,
          mode: 0o600,
        };
      }
      // Bundled seed files already exist in the deployed image; no remote round trip.
      await restore(runtime, initial, local);
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  }
  return runtime;
}
export function nativeContext(
  runtime: NativeRuntime,
  harness: Request["harness"],
  through: number,
): NativeContext {
  return {
    home: join(runtime.root, harness),
    id: runtime.handles[harness]?.id,
    saveId: (id) => {
      runtime.handles[harness] = { id, through };
    },
  };
}
