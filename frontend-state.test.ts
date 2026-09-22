import { describe, expect, it } from "vitest";
import { mergeRows, parseCache } from "./public/state.js";
const a = {
  id: "a",
  harness: "claude",
  prompt: "Read the file",
  status: "pending",
  text: "",
  partial: "Half an answer",
};
describe("browser transcript recovery", () => {
  it("retains an unacknowledged request after offline reload with the same identity and content", () => {
    expect(mergeRows([a], [], { reload: true })).toEqual([
      { ...a, status: "send-error", stopping: false },
    ]);
  });
  it("adds a turn sent from another tab while preserving the local in-flight partial response", () => {
    const remote = {
      id: "b",
      harness: "codex",
      prompt: "Continue",
      status: "pending",
      text: "",
    };
    expect(
      mergeRows([a], [{ ...a, partial: undefined }, remote]),
    ).toMatchObject([
      { id: "a", partial: "Half an answer" },
      { id: "b", prompt: "Continue" },
    ]);
  });
  it("does not regress a streamed result when an older HTTP response arrives", () => {
    const finished = {
      ...a,
      status: "completed",
      text: "Saved answer",
      partial: "",
    };
    expect(mergeRows([finished], [a])).toEqual([finished]);
  });
  it("reconciles a cached uncertain request with the committed server result without duplication", () => {
    const remote = { ...a, status: "completed", text: "Saved answer" };
    expect(
      mergeRows([{ ...a, status: "send-error", stopping: true }], [remote], {
        reload: true,
      }),
    ).toEqual([{ ...remote, partial: "", stopping: false }]);
  });
  it("handles corrupt cached data", () => {
    expect(parseCache("{broken")).toBeUndefined();
    expect(
      parseCache(JSON.stringify({ rows: [null], cursor: "42" })),
    ).toBeUndefined();
    expect(
      parseCache(
        JSON.stringify({ rows: [a], cursor: "not-a-number", events: [null] }),
      ),
    ).toMatchObject({ cursor: undefined, events: [] });
  });
});
