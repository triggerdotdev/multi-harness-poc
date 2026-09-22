import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const checksums = {
  "linux-x64": [
    "linux-amd64",
    "eb67a7be5d174b420cb3734d441971b3a462ab522b78ad2a6ed993e7deddcd44",
  ],
  "linux-arm64": [
    "linux-arm64",
    "c29bff8f609366011cee03b9abcc76c11a06308b2c314364b8c340a2bfbc6c48",
  ],
  "darwin-x64": [
    "darwin-amd64",
    "f1d0dfa7d4bdf51e3e06525da593dd4750470c104cac4fc17baeaa6c0829860d",
  ],
  "darwin-arm64": [
    "darwin-arm64",
    "565fad233fbd4a2262fdc248c4d4aee0c0a18f3ce04168804f42d0d40dd292d5",
  ],
};
async function install(architecture) {
  const release = checksums[`${process.platform}-${architecture}`];
  if (!release)
    throw new Error("Use Linux or macOS for the local JuiceFS worker");
  const temporary = await mkdtemp(join(tmpdir(), "install-juicefs-"));
  try {
    const response = await fetch(
      `https://github.com/juicedata/juicefs/releases/download/v1.3.1/juicefs-1.3.1-${release[0]}.tar.gz`,
    );
    if (!response.ok)
      throw new Error(`JuiceFS download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== release[1])
      throw new Error("JuiceFS archive checksum mismatch");
    const archive = join(temporary, "juicefs.tar.gz");
    await writeFile(archive, bytes);
    const destination = resolve("juicefs-bin");
    await mkdir(destination, { recursive: true });
    await promisify(execFile)("tar", [
      "-xzf",
      archive,
      "-C",
      destination,
      "juicefs",
    ]);
    await chmod(join(destination, "juicefs"), 0o755);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const architecture = process.env.JUICEFS_INSTALL_ARCH ?? process.arch;
await install(architecture);
try {
  await promisify(execFile)(resolve("juicefs-bin/juicefs"), ["--version"]);
} catch {
  if (process.platform !== "darwin" || architecture !== "arm64")
    throw new Error("JuiceFS could not start on this machine");
  console.log(
    "The ARM client could not start. Trying the checksum-verified Intel release through Rosetta.",
  );
  await install("x64");
  try {
    await promisify(execFile)(resolve("juicefs-bin/juicefs"), ["--version"]);
  } catch {
    throw new Error(
      "The Intel client needs Rosetta. Install Rosetta or run the worker on Linux.",
    );
  }
}
console.log("Installed and verified JuiceFS 1.3.1 in juicefs-bin/juicefs");
