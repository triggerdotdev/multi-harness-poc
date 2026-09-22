import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJSON, putJSON, type ObjectStore } from "./storage.js";
import type { NativeSnapshot } from "./native-state.js";
import type { Request, Turn } from "./protocol.js";

export type Commit = {
  version: 2;
  sequence: number;
  previous?: string;
  turn: Turn;
  native: NativeSnapshot;
};
export async function readCommits(
  store: ObjectStore,
  head?: string,
  until?: string,
) {
  const commits: { key: string; value: Commit }[] = [];
  const seen = new Set<string>();
  while (head && head !== until) {
    if (seen.has(head)) throw new Error("Cycle in conversation history");
    seen.add(head);
    const value = await getJSON<Commit>(store, head);
    if (value.version !== 2 || !Number.isSafeInteger(value.sequence))
      throw new Error("Unsupported conversation commit");
    commits.push({ key: head, value });
    head = value.previous;
  }
  return commits.reverse();
}
export async function commitTurn(
  store: ObjectStore,
  previous: string | undefined,
  sequence: number,
  turn: Turn,
  native: NativeSnapshot,
) {
  return putJSON(store, {
    version: 2,
    previous,
    sequence,
    turn,
    native,
  } satisfies Commit);
}
export const historyFile = (index: number) =>
  `.conversation/turn-${String(index + 1).padStart(8, "0")}.json`;

/** Full turns remain retrievable. Only the immediate handoff has a context budget. */
export async function prepareHandoff(
  workspace: string,
  turns: Turn[],
  through: number,
  request: Request,
  budget = 32_000,
) {
  await mkdir(join(workspace, ".conversation"), { recursive: true });
  const available = turns
    .map((turn, index) => ({ turn, index }))
    .filter(
      ({ turn, index }) => turn.status === "completed" && index >= through,
    );
  const inline: { user: string; assistant: string; harness: string }[] = [];
  let used = 0;
  let omitted = 0;
  for (const { turn, index } of available.toReversed()) {
    const entry = {
      user: turn.prompt,
      assistant: turn.text,
      harness: turn.harness,
    };
    const size = JSON.stringify(entry).length;
    if (used + size <= budget) {
      inline.unshift(entry);
      used += size;
    } else omitted++;
  }
  // Files are derived from committed history, never the source of truth. They can be rebuilt after a crash.
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (turn.status === "completed")
      await writeFile(
        join(workspace, historyFile(index)),
        JSON.stringify(turn),
        { flag: "wx" },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
  }
  await writeFile(
    join(workspace, ".conversation/index.jsonl"),
    turns
      .flatMap((turn, index) =>
        turn.status === "completed"
          ? [
              JSON.stringify({
                file: historyFile(index),
                harness: turn.harness,
                prompt: turn.prompt.slice(0, 240),
              }),
            ]
          : [],
      )
      .join("\n"),
  );
  return [
    "Work on the current request in the workspace. Read, create, and edit project files as needed to complete the request. Changes stay inside this conversation's workspace copy. Do not modify .conversation/.",
    `There are ${turns.length} saved turns. Completed turns are available as .conversation/turn-NNNNNNNN.json (one-based, eight digits). Failed/stopped turn numbers have no file. Read .conversation/index.jsonl to locate a turn, then read or search its file when earlier context is needed.`,
    `${omitted} unseen completed turns are available in those files rather than inline. Do not assume they are irrelevant.`,
    "Recent unseen completed turns (JSON):",
    JSON.stringify(inline),
    "Current request:",
    request.prompt,
  ].join("\n\n");
}
