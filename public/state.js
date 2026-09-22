const terminal = new Set(["completed", "failed", "stopped"]);

// A server read can race a newer stream result. Terminal results never become pending again.
export function mergeRows(local, remote, { reload = false } = {}) {
  const previous = new Map(local.map((row) => [row.id, row]));
  const seen = new Set();
  const merged = remote.map((row) => {
    seen.add(row.id);
    const prior = previous.get(row.id);
    if (prior && terminal.has(prior.status) && !terminal.has(row.status))
      return prior;
    return {
      ...prior,
      ...row,
      partial: row.status === "pending" ? prior?.partial || "" : "",
      stopping: row.status === "pending" ? prior?.stopping || false : false,
    };
  });
  for (const row of local) {
    if (seen.has(row.id)) continue;
    // The browser has no delivery receipt after a reload. Keep the original request for retry.
    merged.push(
      reload && row.status === "pending"
        ? { ...row, status: "send-error", stopping: false }
        : row,
    );
  }
  return merged.sort(
    (a, b) =>
      (a.ordinal ?? Number.MAX_SAFE_INTEGER) -
      (b.ordinal ?? Number.MAX_SAFE_INTEGER),
  );
}

export function parseCache(value) {
  try {
    const cached = JSON.parse(value || "null");
    if (
      !cached ||
      !Array.isArray(cached.rows) ||
      !cached.rows.every(
        (row) =>
          row &&
          typeof row.id === "string" &&
          typeof row.prompt === "string" &&
          ["claude", "codex", "pi"].includes(row.harness) &&
          [
            "pending",
            "send-error",
            "completed",
            "failed",
            "stopped",
            "rejected",
          ].includes(row.status),
      )
    )
      return undefined;
    return {
      ...cached,
      cursor:
        typeof cached.cursor === "string" && /^\d{1,20}$/.test(cached.cursor)
          ? cached.cursor
          : undefined,
      draft: typeof cached.draft === "string" ? cached.draft : "",
      events: Array.isArray(cached.events)
        ? cached.events
            .filter(
              (e) =>
                e && typeof e.text === "string" && typeof e.time === "string",
            )
            .slice(-50)
        : [],
    };
  } catch {
    return undefined;
  }
}
