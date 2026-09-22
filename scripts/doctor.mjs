import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
let errors = 0;
function check(ok, message) {
  console.log(`${ok ? "OK" : "MISSING"}  ${message}`);
  if (!ok) errors++;
}
check(
  Number(process.versions.node.split(".")[0]) >= 24,
  `Node.js 24+ (found ${process.versions.node})`,
);
check(
  existsSync(new URL("../node_modules/@trigger.dev/sdk", import.meta.url)),
  "Dependencies installed: pnpm install",
);
for (const executable of ["git", "rg"])
  check(
    spawnSync(executable, ["--version"], { stdio: "ignore" }).status === 0,
    `${executable} on PATH`,
  );
check(!!process.env.TRIGGER_PROJECT_REF, "TRIGGER_PROJECT_REF set in .env");
check(!!process.env.TRIGGER_SECRET_KEY, "TRIGGER_SECRET_KEY set in .env");
check(
  !!(process.env.ANTHROPIC_API_KEY || process.env.CODEX_API_KEY),
  "At least one provider key configured",
);
console.log(
  `Claude Code / Pi: ${process.env.ANTHROPIC_API_KEY ? "configured" : "set ANTHROPIC_API_KEY to use these harnesses"}`,
);
console.log(
  `Codex: ${process.env.CODEX_API_KEY ? "configured" : "set CODEX_API_KEY to use this harness"}`,
);
if (process.env.CODEX_API_KEY)
  check(
    !!process.env.CODEX_MODEL,
    "CODEX_MODEL set to a model your account can use",
  );
if (!process.env.STORAGE_BUCKET)
  check(
    !!process.env.STORAGE_DIR && isAbsolute(process.env.STORAGE_DIR),
    "STORAGE_DIR is an absolute path shared by frontend and local worker",
  );
console.log(
  process.env.STORAGE_BUCKET
    ? "Storage: S3-compatible bucket configured (check bucket access separately)"
    : "Storage: local filesystem; frontend and local worker must use the same STORAGE_DIR",
);
if (process.env.JUICEFS_META_URL) {
  const binary = process.env.JUICEFS_BINARY || "./juicefs-bin/juicefs";
  check(
    spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0,
    "JuiceFS client starts: pnpm run juicefs:install",
  );
  console.log(
    "Workspace storage: JuiceFS configured (metadata and bucket access need a live check)",
  );
}
console.log(
  "This checks local prerequisites, not credential validity or model access.",
);
process.exitCode = errors ? 1 : 0;
