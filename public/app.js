import { mergeRows, parseCache } from "./state.js";
const $ = (id) => document.getElementById(id);
const names = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
let chat,
  source,
  rows = [],
  cursor,
  events = [],
  closed = false,
  loading = false;
let hasMore = false,
  nextBefore,
  total = 0;
let navigation = 0,
  refresh = 0,
  historyRequest = 0,
  cacheUnavailable = false,
  refreshing;
const cacheKey = (id) => `harness-lab:${id}`;
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) {
    const failure = new Error(
      data.error || `Request failed (${response.status})`,
    );
    failure.status = response.status;
    throw failure;
  }
  return data;
}
function error(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}
function persist() {
  if (!chat) return;
  try {
    localStorage.setItem(
      cacheKey(chat),
      JSON.stringify({
        // Saved answers come from the durable backend; keep browser storage for the outbox and draft.
        rows: rows
          .filter((row) =>
            ["pending", "send-error", "rejected"].includes(row.status),
          )
          .map((row) => ({ ...row, partial: "" })),
        cursor,
        events,
        draft: $("prompt").value,
        harness: document.querySelector('input[name="harness"]:checked').value,
      }),
    );
    cacheUnavailable = false;
  } catch {
    cacheUnavailable = true;
  }
  $("cache-warning").hidden = !cacheUnavailable;
}
const outboxPrefix = (id) => `harness-outbox:${id}:`;
function keepDelivery(id, row) {
  try {
    localStorage.setItem(
      outboxPrefix(id) + row.id,
      JSON.stringify({ ...row, status: "send-error", partial: "" }),
    );
  } catch {
    cacheUnavailable = true;
    $("cache-warning").hidden = false;
  }
}
function confirmDelivery(id, requestId) {
  try {
    localStorage.removeItem(outboxPrefix(id) + requestId);
  } catch {
    /* The server result still wins on reload. */
  }
}
function readOutbox(id) {
  const recovered = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(outboxPrefix(id))) continue;
      const cached = parseCache(
        JSON.stringify({ rows: [JSON.parse(localStorage.getItem(key))] }),
      );
      if (cached) recovered.push(...cached.rows);
    }
  } catch {
    cacheUnavailable = true;
  }
  return recovered;
}
function recoverOutbox(id, saved) {
  const known = new Set(saved.map((row) => row.id));
  return [...saved, ...readOutbox(id).filter((row) => !known.has(row.id))];
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text) el.textContent = text;
  return el;
}
function activity(text) {
  events.push({
    text,
    time: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  });
  events = events.slice(-50);
}
function render() {
  const pending = rows.some((r) => r.status === "pending");
  const uncertain = rows.some((r) => r.status === "send-error");
  $("send").disabled =
    loading || closed || pending || uncertain || !$("prompt").value.trim();
  $("send").hidden = pending;
  $("stop").hidden = !pending;
  $("stop").disabled = rows.some((r) => r.status === "pending" && r.stopping);
  $("stop").textContent = $("stop").disabled ? "Stopping…" : "Stop";
  $("new").disabled = loading;
  $("mobile-history").disabled = loading;
  $("prompt").disabled = loading || closed;
  $("close").hidden = !chat || closed;
  $("close").disabled = pending || loading;
  const included = rows.filter((r) => r.status === "completed").length;
  $("hint").textContent = closed
    ? "Conversation closed. Start a new one."
    : pending
      ? "Reply in progress. Choose the next harness while you wait."
      : uncertain
        ? "Delivery is uncertain. Retry the same request before sending another."
        : `${total || rows.length} ${(total || rows.length) === 1 ? "request" : "requests"} · ${included} completed ${included === 1 ? "turn" : "turns"} shown`;
  $("load-older").hidden = !hasMore;
  $("context-count").textContent =
    `${included} completed ${included === 1 ? "turn" : "turns"} shown. Earlier turns stay retrievable by each harness.`;
  if (rows.length) {
    const container = $("messages");
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      100;
    container.replaceChildren();
    for (const row of rows) {
      const turn = node("article", "turn");
      turn.dataset.requestId = row.id;
      turn.append(node("div", "user-message", row.prompt));
      const label = node("div", "assistant-label");
      label.append(node("span", `badge ${row.harness}`, names[row.harness]));
      turn.append(
        label,
        node(
          "div",
          `answer ${row.status === "pending" ? "pending" : ""}`,
          row.text || row.partial || "",
        ),
      );
      turn.append(
        node(
          "div",
          `turn-status ${row.status}`,
          row.status === "pending"
            ? `${row.count || 0} events · ${row.stage || "Queued"}`
            : row.status === "completed"
              ? "Completed"
              : row.status === "stopped"
                ? "Stopped · excluded from next turn’s context"
                : row.status === "send-error"
                  ? "Delivery not confirmed"
                  : row.status === "rejected"
                    ? "Not sent"
                    : "Turn failed · excluded from next turn’s context",
        ),
      );
      if (row.status === "send-error") {
        const retry = node("button", "retry", "Retry delivery");
        retry.disabled = loading || closed || pending;
        retry.onclick = () => deliver(row);
        turn.append(retry);
      }
      if (["failed", "stopped", "rejected"].includes(row.status)) {
        const retry = node("button", "retry", "Edit and retry");
        retry.disabled = loading || closed || pending || uncertain;
        retry.onclick = () => {
          $("prompt").value = row.prompt;
          persist();
          render();
          $("prompt").focus();
        };
        turn.append(retry);
      }
      container.append(turn);
    }
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }
  const list = $("activity-list");
  if (events.length) {
    list.replaceChildren(
      ...events
        .slice(-12)
        .reverse()
        .map((event) => {
          const item = node("div", "activity-item", event.text);
          item.append(node("time", "", event.time));
          return item;
        }),
    );
  }
}
function apply(event) {
  if (event.type === "native") {
    activity(
      `${names[event.harness]} · ${event.resumed ? "resumed native history" : "new native session"}${event.restored ? " from saved files" : ""}`,
    );
    return;
  }
  if (event.type === "lifecycle") {
    activity(
      event.phase === "resumed"
        ? "Session resumed"
        : "Session waiting for input",
    );
    return;
  }
  const row = rows.find((r) => r.id === event.requestId);
  if (!row) return;
  if (
    event.type === "started" &&
    !["completed", "failed", "stopped"].includes(row.status)
  ) {
    row.status = "pending";
    row.partial = "";
    row.count = 0;
    row.stage = "Starting";
    activity(`${names[event.harness]} started`);
    $("a11y-status").textContent = `${names[event.harness]} is responding.`;
  }
  if (event.type === "text" && row.status === "pending" && !row.stopping)
    row.partial = event.replace ? event.text : (row.partial || "") + event.text;
  if (event.type === "tool")
    activity(`${names[event.harness]} · ${event.name}`);
  if (event.type === "retrying") {
    row.stage = `Retrying (attempt ${event.attempt})`;
    activity(row.stage);
  }
  if (event.type === "event" && row.status === "pending" && !row.stopping) {
    row.count = (row.count || 0) + 1;
    row.stage = "Working";
    const native = event.event;
    if (event.harness === "claude") {
      const raw = native.event;
      if (
        raw?.type === "content_block_delta" &&
        raw.delta?.type === "text_delta"
      )
        row.partial = (row.partial || "") + raw.delta.text;
      if (
        raw?.type === "content_block_start" &&
        raw.content_block?.type === "tool_use"
      )
        activity(`Claude Code · ${raw.content_block.name}`);
    } else if (event.harness === "codex") {
      if (native.item?.type === "agent_message") row.partial = native.item.text;
      if (
        native.type === "item.started" &&
        native.item?.type === "mcp_tool_call"
      )
        activity(`Codex · ${native.item.server} / ${native.item.tool}`);
      if (
        native.type === "item.started" &&
        native.item?.type === "command_execution"
      )
        activity(`Codex · ${native.item.command}`);
    } else {
      if (
        native.type === "message_update" &&
        native.assistantMessageEvent?.type === "text_delta"
      )
        row.partial = (row.partial || "") + native.assistantMessageEvent.delta;
      if (native.type === "tool_execution_start")
        activity(`Pi · ${native.toolName}`);
    }
  }
  if (event.type === "result") {
    confirmDelivery(chat, event.requestId);
    const alreadyDone = row.status === event.status && row.text === event.text;
    row.status = event.status;
    row.text = event.text;
    row.partial = "";
    row.stopping = false;
    if (!alreadyDone) {
      activity(`${names[event.harness]} · ${event.status}`);
      $("a11y-status").textContent =
        `${names[event.harness]} turn ${event.status}.`;
    }
  }
}
async function refreshRun() {
  const id = chat;
  if (!id || (refreshing?.id === id && refreshing.navigation === navigation))
    return;
  const attempt = { id, navigation };
  refreshing = attempt;
  const request = ++refresh;
  try {
    const state = await api(`/api/chats/${id}`);
    if (chat !== id || request !== refresh || loading) return;
    $("run-id").textContent = state.runId || "Waiting";
    closed = closed || state.closed;
    total = state.total;
    if (closed) {
      source?.close();
      $("connection").textContent = "Closed";
    }
    for (const saved of state.requests) {
      if (["completed", "failed", "stopped"].includes(saved.status)) {
        const recovered = rows.some(
          (row) => row.id === saved.id && row.status === "send-error",
        );
        apply({
          type: "result",
          requestId: saved.id,
          harness: saved.harness,
          status: saved.status,
          text: saved.text,
        });
        if (recovered) error();
      }
    }
    rows = mergeRows(recoverOutbox(id, rows), state.requests);
    persist();
    render();
  } catch {
    /* Keep the stream and retry state available while the backend is unreachable. */
  } finally {
    if (refreshing === attempt) refreshing = undefined;
  }
}
function connect() {
  source?.close();
  if (!chat || closed) {
    $("connection").textContent = "Closed";
    return;
  }
  const connectedChat = chat;
  $("connection").textContent = "Connecting…";
  source = new EventSource(
    `/api/chats/${chat}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  const connection = source;
  source.onopen = () => {
    if (source !== connection) return;
    $("connection").textContent = "Live connection";
    $("connection").classList.remove("offline");
  };
  source.onerror = () => {
    if (source !== connection) return;
    $("connection").textContent = "Reconnecting…";
    $("connection").classList.add("offline");
  };
  source.onmessage = (message) => {
    if (connectedChat !== chat || source !== connection) return;
    if (cursor && BigInt(message.lastEventId) <= BigInt(cursor)) return;
    const event = JSON.parse(message.data);
    apply(event);
    cursor = message.lastEventId;
    persist();
    render();
    if (event.type === "started" || event.type === "result") void refreshRun();
  };
}
async function history() {
  const request = ++historyRequest;
  const chats = await api("/api/chats");
  if (request !== historyRequest) return chats;
  $("mobile-history").replaceChildren(
    ...chats.map((item, index) => {
      const option = node("option", "", `Conversation ${chats.length - index}`);
      option.value = item.id;
      option.selected = item.id === chat;
      return option;
    }),
  );
  return chats;
}
async function openChat(id) {
  const selection = ++navigation;
  ++refresh;
  persist();
  loading = true;
  render();
  source?.close();
  error();
  let remote;
  try {
    remote = await api(`/api/chats/${id}`);
  } catch (e) {
    if (selection !== navigation) return;
    throw e;
  }
  if (selection !== navigation) return;
  chat = id;
  closed = remote.closed;
  hasMore = remote.hasMore;
  nextBefore = remote.nextBefore;
  total = remote.total;
  let cached;
  try {
    cached = parseCache(localStorage.getItem(cacheKey(id)));
  } catch {
    cacheUnavailable = true;
  }
  rows = mergeRows(recoverOutbox(id, cached?.rows || []), remote.requests, {
    reload: true,
  });
  for (const row of remote.requests) confirmDelivery(id, row.id);
  cursor = cached?.cursor;
  events = cached?.events || [];
  $("prompt").value = cached?.draft || "";
  const selectedHarness = cached?.harness || "claude";
  document.querySelector(
    `input[name="harness"][value="${["claude", "codex", "pi"].includes(selectedHarness) ? selectedHarness : "claude"}"]`,
  ).checked = true;
  try {
    localStorage.setItem("harness-active", chat);
  } catch {
    cacheUnavailable = true;
  }
  $("chat-label").textContent = `Conversation · ${chat.slice(-8)}`;
  $("session-id").textContent = chat;
  $("run-id").textContent = remote.runId || "Waiting";
  if (!rows.length)
    $("messages").innerHTML =
      '<div class="empty"><p>No messages. Select a harness and send a request.</p><button id="starter" type="button">Read README.md</button></div>';
  $("activity-list").replaceChildren(node("p", "muted", "No activity."));
  loading = false;
  persist();
  render();
  connect();
  await history();
}
async function newChat() {
  loading = true;
  render();
  error();
  try {
    const created = await api("/api/chats", { method: "POST" });
    await openChat(created.id);
  } catch (e) {
    error(e.message);
  } finally {
    loading = false;
    render();
  }
}
async function deliver(row) {
  const id = chat;
  row.status = "pending";
  error();
  persist();
  keepDelivery(id, row);
  render();
  try {
    const result = await api(`/api/chats/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        id: row.id,
        harness: row.harness,
        prompt: row.prompt,
      }),
    });
    confirmDelivery(id, row.id);
    if (
      id === chat &&
      ["completed", "failed", "stopped"].includes(result.status)
    ) {
      apply({
        type: "result",
        requestId: row.id,
        harness: row.harness,
        status: result.status,
        text: result.text,
      });
      persist();
      render();
    }
  } catch (e) {
    if (e.status >= 400 && e.status < 500) confirmDelivery(id, row.id);
    if (id !== chat) return;
    if (row.status === "pending")
      row.status =
        e.status >= 400 && e.status < 500 ? "rejected" : "send-error";
    error(e.message);
    persist();
    render();
  }
}
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  if ($("send").disabled) return;
  const prompt = $("prompt").value.trim();
  if (!prompt) return;
  if (!chat) await newChat();
  if (!chat) return;
  const row = {
    id: crypto.randomUUID(),
    harness: document.querySelector('input[name="harness"]:checked').value,
    prompt,
    status: "pending",
    text: "",
    partial: "",
  };
  rows.push(row);
  $("prompt").value = "";
  await deliver(row);
};
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
$("prompt").addEventListener("input", () => {
  persist();
  render();
});
for (const input of document.querySelectorAll('input[name="harness"]'))
  input.addEventListener("change", persist);
$("stop").onclick = async () => {
  const id = chat;
  const row = rows.find((r) => r.status === "pending");
  if (!row) return;
  row.stopping = true;
  row.stage = "Stopping";
  persist();
  render();
  try {
    await api(`/api/chats/${id}/stop`, {
      method: "POST",
      body: JSON.stringify({ type: "stop", requestId: row.id }),
    });
  } catch (e) {
    row.stopping = false;
    if (chat === id) {
      error(e.message);
      persist();
      render();
    }
  }
};
$("new").onclick = newChat;
$("mobile-history").onchange = () =>
  openChat($("mobile-history").value).catch((e) => {
    error(e.message);
    loading = false;
    render();
    connect();
  });
$("messages").addEventListener("click", (event) => {
  if (event.target.id === "starter") {
    $("prompt").value = "Read README.md. What is this project called?";
    $("prompt").focus();
    persist();
    render();
  }
});
$("close").onclick = async () => {
  const id = chat;
  try {
    await api(`/api/chats/${id}/close`, { method: "POST" });
    if (chat !== id) return;
    closed = true;
    source?.close();
    $("connection").textContent = "Closed";
    render();
  } catch (e) {
    if (chat === id) error(e.message);
  }
};
try {
  loading = true;
  render();
  const chats = await history();
  let active;
  try {
    active = localStorage.getItem("harness-active");
  } catch {
    cacheUnavailable = true;
  }
  const selected = chats.find((item) => item.id === active) || chats[0];
  if (selected) await openChat(selected.id);
  else await newChat();
} catch (e) {
  error(e.message);
} finally {
  loading = false;
  render();
}

setInterval(() => {
  if (!loading && !document.hidden && chat && !closed) void refreshRun();
}, 5_000);
window.addEventListener("online", () => {
  connect();
  void refreshRun();
});

window.addEventListener("focus", () => {
  if (!loading) void refreshRun();
});

window.addEventListener("storage", (event) => {
  if (!loading && chat && event.key?.startsWith(outboxPrefix(chat)))
    void refreshRun();
});

$("load-older").onclick = async () => {
  const id = chat,
    selection = navigation;
  $("load-older").disabled = true;
  try {
    const page = await api(`/api/chats/${id}?before=${nextBefore}`);
    if (id !== chat || selection !== navigation) return;
    rows = mergeRows(rows, page.requests);
    hasMore = page.hasMore;
    nextBefore = page.nextBefore;
    persist();
    render();
  } catch (e) {
    error(e.message);
  } finally {
    $("load-older").disabled = false;
  }
};
