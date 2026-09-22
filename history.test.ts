import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { FileStore, putJSON, getJSON } from "./src/storage.js";
import {
  commitTurn,
  readCommits,
  prepareHandoff,
  historyFile,
} from "./src/history.js";
import type { Turn } from "./src/protocol.js";

test("forty long answers survive restart, with incremental reads and retrievable context overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-test-"));
  try {
    const store = new FileStore(join(root, "objects"));
    const turns: Turn[] = [];
    let head: string | undefined, middle: string | undefined;
    for (let index = 0; index < 40; index++) {
      const turn: Turn = {
        id: randomUUID(),
        harness: "claude",
        prompt: `Question ${index}`,
        text: `Answer ${index}: ` + "full answer ".repeat(5_000),
        status: "completed",
      };
      turns.push(turn);
      head = await commitTurn(store, head, index + 1, turn, {
        version: 2,
        handles: {},
        files: {},
      });
      if (index === 29) middle = head;
    }
    const reopened = new FileStore(join(root, "objects"));
    expect(
      (await readCommits(reopened, head)).map(({ value }) => value.turn),
    ).toEqual(turns);
    expect(await readCommits(reopened, head, middle)).toHaveLength(10);
    const prompt = await prepareHandoff(join(root, "workspace"), turns, 0, {
      id: randomUUID(),
      harness: "codex",
      prompt: "Continue the work",
    });
    expect(prompt.length).toBeLessThan(33_000);
    expect(prompt).toContain("40 unseen completed turns");
    expect(
      JSON.parse(
        await readFile(join(root, "workspace", historyFile(0)), "utf8"),
      ),
    ).toEqual(turns[0]);
    const pending = {
      id: randomUUID(),
      harness: "pi",
      prompt: "Recover after a crash",
    };
    expect(await getJSON(reopened, await putJSON(store, pending))).toEqual(
      pending,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
