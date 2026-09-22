import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
try {
  const template = await readFile(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  const path = fileURLToPath(new URL("../.data/objects", import.meta.url));
  await writeFile(
    new URL("../.env", import.meta.url),
    template.replace("STORAGE_DIR=", `STORAGE_DIR=${JSON.stringify(path)}`),
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created .env. Fill in your Trigger project and provider keys, then run pnpm run doctor.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(
    ".env already exists; kept your settings. Run pnpm run doctor to check them.",
  );
}
