import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { repositoryTools } from "./src/harnesses/repository-tools.js";
import { test, expect } from "vitest";
test("repository tool reads the workspace and rejects traversal and escaping symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "repository-tools-"));
  const root = join(base, "workspace");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await writeFile(join(root, "README.md"), "Release Notes Demo");
  await writeFile(join(base, "outside.txt"), "outside");
  await symlink(join(base, "outside.txt"), join(root, "outside-link"));
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", repositoryTools],
    env: { AGENT_WORKSPACE: root },
  });
  try {
    await client.connect(transport);
    expect(
      await client.callTool({ name: "list_files", arguments: {} }),
    ).toMatchObject({
      content: [
        {
          type: "text",
          text: JSON.stringify({ files: ["README.md"], nextOffset: null }),
        },
      ],
    });
    expect(
      await client.callTool({
        name: "read_file",
        arguments: { path: "README.md" },
      }),
    ).toMatchObject({ content: [{ type: "text", text: "Release Notes Demo" }] });
    const long = "start\n" + "x".repeat(100_000) + "\nend";
    await writeFile(join(root, "large.ts"), long);
    const page = await client.callTool({
      name: "read_file",
      arguments: { path: "large.ts", offset: 64_000, limit: 40_000 },
    });
    expect(page).toMatchObject({
      content: [{ type: "text", text: long.slice(64_000, 104_000) }],
      structuredContent: { nextOffset: null },
    });
    const listing = await client.callTool({
      name: "list_files",
      arguments: { limit: 1 },
    });
    expect(
      JSON.parse((listing.content as { text: string }[])[0].text).nextOffset,
    ).toBe(1);
    const last = await client.callTool({
      name: "list_files",
      arguments: { offset: 1, limit: 1 },
    });
    expect(
      JSON.parse((last.content as { text: string }[])[0].text).nextOffset,
    ).toBeNull();
    for (const path of ["../outside.txt", "outside-link"])
      expect(
        await client.callTool({ name: "read_file", arguments: { path } }),
      ).toMatchObject({ isError: true });
    expect(
      await client.callTool({
        name: "write_file",
        arguments: { path: "src/new.ts", content: "export const value = 1;" },
      }),
    ).not.toMatchObject({ isError: true });
    expect(
      await client.callTool({
        name: "edit_file",
        arguments: {
          path: "src/new.ts",
          oldText: "value = 1",
          newText: "value = 2",
        },
      }),
    ).not.toMatchObject({ isError: true });
    expect(await readFile(join(root, "src/new.ts"), "utf8")).toBe(
      "export const value = 2;",
    );
    for (const path of [
      "../outside.txt",
      "outside-link",
      ".conversation/history.json",
      ".git/config",
    ]) {
      expect(
        await client.callTool({
          name: "write_file",
          arguments: { path, content: "blocked" },
        }),
      ).toMatchObject({ isError: true });
    }
    expect(await readFile(join(base, "outside.txt"), "utf8")).toBe("outside");
  } finally {
    await client.close();
    await rm(base, { recursive: true, force: true });
  }
});
