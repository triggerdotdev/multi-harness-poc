import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);

export type JuiceFSOptions = {
  metaUrl: string;
  prefix?: string;
  binary?: string;
  caCertificate?: string;
};

/** Sync only content-addressed files; a committed manifest owns the workspace layout. */
export class JuiceFS {
  private readonly prefix: string;
  private readonly binary: string;
  constructor(private readonly options: JuiceFSOptions) {
    this.prefix = options.prefix ?? "multi-harness";
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(this.prefix))
      throw new Error(
        "JUICEFS_PREFIX must contain safe relative path components",
      );
    if (!options.metaUrl) throw new Error("JUICEFS_META_URL is required");
    this.binary = options.binary ?? resolve("juicefs-bin/juicefs");
  }
  async upload(directory: string, keys: string[]) {
    await this.sync(directory, keys, "upload");
  }
  async download(directory: string, keys: string[]) {
    await this.sync(directory, keys, "download");
  }
  private async sync(
    directory: string,
    keys: string[],
    direction: "upload" | "download",
  ) {
    const selected = [...new Set(keys)];
    if (selected.some((key) => !/^blobs\/[a-f0-9]{64}$/.test(key)))
      throw new Error("Invalid JuiceFS content key");
    if (!selected.length) return;
    const temporary = await mkdtemp(join(tmpdir(), "harness-jfs-"));
    try {
      const list = join(temporary, "files.txt");
      await writeFile(list, selected.join("\n") + "\n", { mode: 0o600 });
      let metaUrl = this.options.metaUrl;
      if (this.options.caCertificate) {
        const ca = join(temporary, "ca.pem");
        await writeFile(ca, this.options.caCertificate, { mode: 0o600 });
        const url = new URL(metaUrl);
        if (url.protocol !== "rediss:")
          throw new Error(
            "JUICEFS_CA_CERT currently supports rediss metadata URLs",
          );
        url.searchParams.set("tls-ca-cert-file", ca);
        metaUrl = url.toString();
      }
      const remote = `jfs://MULTI_HARNESS_JFS/${this.prefix}/`;
      const local = resolve(directory) + "/";
      await mkdir(directory, { recursive: true });
      const paths = direction === "upload" ? [local, remote] : [remote, local];
      try {
        await exec(
          this.binary,
          [
            "sync",
            "--check-all",
            "--threads",
            "8",
            "--files-from",
            list,
            ...paths,
          ],
          {
            env: { ...process.env, MULTI_HARNESS_JFS: metaUrl },
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        // CLI diagnostics contain connection details. Do not forward them to run logs or the browser.
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(
          `JuiceFS ${direction} failed (${code ?? "process interrupted"}). Check the client, metadata service, and bucket access.`,
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
export function configuredJuiceFS(): JuiceFS | undefined {
  if (!process.env.JUICEFS_META_URL) return undefined;
  return new JuiceFS({
    metaUrl: process.env.JUICEFS_META_URL,
    prefix: process.env.JUICEFS_PREFIX,
    binary: process.env.JUICEFS_BINARY,
    caCertificate: process.env.JUICEFS_CA_CERT,
  });
}
