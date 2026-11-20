// Follows a thread's rollout file (~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl)
// incrementally and keeps a small activity summary for the current turn.
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

const IGNORED_TOOLS = new Set(["wait", "sleep", "text"]);
const MISS_RETRY_MS = 10_000;
// Calls without an output yet (and code-mode cells being waited on) tracked per turn.
const MAX_RUNNING = 64;
const MAX_EDITED_FILES = 64;
// Code-mode `exec` that yields before finishing; a later `wait` call finishes the cell.
const RUNNING_CELL = /^Script running with cell ID (\S+)/;
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File:\s*([^\r\n"\\]+)/g;

// `tools` counts every call of the turn by name; `running` maps a call id (or
// "cell:<id>") to the tool names it started, until its output is recorded.
export function emptyActivity() {
  return {
    sessionStartedAt: null,
    turns: 0,
    turnStartedAt: null,
    tools: new Map(),
    editedFiles: new Set(),
    lastCommand: null,
    plan: null,
    running: new Map(),
    waits: new Map(),
    tokenUsage: null,
    lastContextTokens: null,
    contextWindow: null,
  };
}

function recordPatchFiles(activity, src) {
  if (typeof src !== "string" || !src.includes("*** ")) return;
  if (!(activity.editedFiles instanceof Set)) activity.editedFiles = new Set();
  for (const m of src.matchAll(PATCH_FILE)) {
    const file = m[1].trim();
    if (!file) continue;
    if (activity.editedFiles.size >= MAX_EDITED_FILES && !activity.editedFiles.has(file)) break;
    activity.editedFiles.add(file);
  }
}

// Map.set that keeps at most `max` entries, dropping the oldest.
function setBounded(map, key, value, max = MAX_RUNNING) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// name -> number of calls still running.
export function runningCounts(activity) {
  const out = new Map();
  if (!activity || !(activity.running instanceof Map)) return out;
  for (const names of activity.running.values()) {
    for (const n of names) out.set(n, (out.get(n) || 0) + 1);
  }
  return out;
}

// JS object literal -> JSON, good enough for the arguments the model writes.
function looseJson(src) {
  try {
    return JSON.parse(src);
  } catch {
    try {
      return JSON.parse(src.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'));
    } catch {
      return null;
    }
  }
}

function balancedObject(text, from) {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function planFrom(args) {
  const steps = args && Array.isArray(args.plan) ? args.plan : null;
  if (!steps || !steps.length) return null;
  const done = steps.filter((s) => s && s.status === "completed").length;
  const current = steps.find((s) => s && s.status === "in_progress");
  return { done, total: steps.length, current: current ? String(current.step || "") : null };
}

// Returns the name when it counts as a tool call.
function countTool(activity, name) {
  if (!name || typeof name !== "string" || IGNORED_TOOLS.has(name)) return null;
  activity.tools.set(name, (activity.tools.get(name) || 0) + 1);
  return name;
}

function track(activity, callId, names) {
  if (callId && names.length) setBounded(activity.running, String(callId), names);
}

function outputText(out) {
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const first = out.find((x) => x && typeof x.text === "string");
    return first ? first.text : "";
  }
  return "";
}

// function_call_output / custom_tool_call_output: the matching call is done, unless
// it is a code-mode cell that yielded ("Script running with cell ID …"); that cell
// stays running until a `wait` on it returns anything else.
function finishCall(activity, p) {
  if (!p.call_id) return;
  const id = String(p.call_id);
  const cell = RUNNING_CELL.exec(outputText(p.output).slice(0, 200));
  const names = activity.running.get(id);
  const waited = activity.waits.get(id);
  activity.running.delete(id);
  activity.waits.delete(id);
  if (cell) {
    if (names) setBounded(activity.running, `cell:${cell[1]}`, names);
  } else if (waited) {
    activity.running.delete(`cell:${waited}`);
  }
}

// Code-mode `exec` calls wrap real tools: text(await tools.exec_command({cmd:"..."}))
function applyExecInput(activity, input) {
  const names = [];
  for (const m of input.matchAll(/tools\.([A-Za-z_][\w]*)\s*\(/g)) {
    const name = countTool(activity, m[1]);
    if (name) names.push(name);
    if (m[1] === "update_plan") {
      const obj = balancedObject(input, m.index);
      const plan = obj && planFrom(looseJson(obj));
      if (plan) activity.plan = plan;
    }
  }
  let last = null;
  for (const m of input.matchAll(/\bcmd\s*"?\s*:\s*"((?:[^"\\]|\\.)*)"/g)) last = m[1];
  if (last !== null) activity.lastCommand = looseJson(`"${last}"`) ?? last;
  recordPatchFiles(activity, input);
  return names;
}

export function applyLine(activity, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return;
  const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(ts) && (activity.sessionStartedAt == null || ts < activity.sessionStartedAt)) {
    activity.sessionStartedAt = ts;
  }
  const p = o.payload;
  if (!p) return;
  if (!(activity.running instanceof Map)) activity.running = new Map();
  if (!(activity.waits instanceof Map)) activity.waits = new Map();
  if (!(activity.editedFiles instanceof Set)) activity.editedFiles = new Set();
  if (o.type === "event_msg") {
    if (p.type === "task_started") {
      activity.turns = (activity.turns || 0) + 1;
      activity.turnStartedAt = Number.isFinite(ts) ? ts : Date.now();
      activity.tools = new Map();
      activity.lastCommand = null;
      activity.running.clear();
      activity.waits.clear();
    } else if (p.type === "task_complete" || p.type === "turn_aborted") {
      // Whatever had no output by the end of the turn is not running any more.
      activity.running.clear();
      activity.waits.clear();
    } else if (p.type === "token_count" && p.info && typeof p.info === "object") {
      const tot = p.info.total_token_usage;
      if (tot && typeof tot === "object") {
        activity.tokenUsage = {
          total_input_tokens: Number(tot.input_tokens ?? tot.total_input_tokens) || 0,
          cache_read_input_tokens: Number(tot.cached_input_tokens ?? tot.cache_read_input_tokens) || 0,
          output_tokens: Number(tot.output_tokens) || 0,
        };
      }
      const last = p.info.last_token_usage;
      if (last && typeof last === "object") {
        const used = Number(last.total_tokens) || (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
        if (Number.isFinite(used) && used >= 0) activity.lastContextTokens = used;
      }
      if (Number.isFinite(p.info.model_context_window) && p.info.model_context_window > 0) {
        activity.contextWindow = p.info.model_context_window;
      }
    }
    return;
  }
  if (o.type !== "response_item") return;
  if (p.type === "custom_tool_call" && p.name === "exec" && typeof p.input === "string") {
    track(activity, p.call_id, applyExecInput(activity, p.input));
  } else if (p.type === "function_call" || p.type === "custom_tool_call") {
    const name = countTool(activity, p.name);
    if (name) track(activity, p.call_id, [name]);
    if (p.name === "wait" && p.call_id) {
      const args = looseJson(typeof p.arguments === "string" ? p.arguments : "");
      if (args && args.cell_id != null) setBounded(activity.waits, String(p.call_id), String(args.cell_id));
    }
    if (p.name === "update_plan") {
      const plan = planFrom(looseJson(p.arguments || p.input || ""));
      if (plan) activity.plan = plan;
    }
    if (p.name === "apply_patch") {
      recordPatchFiles(activity, p.input || p.arguments || "");
    }
    if (p.name === "shell" || p.name === "exec_command") {
      const args = looseJson(p.arguments || "") || {};
      const cmd = Array.isArray(args.command) ? args.command.join(" ") : args.cmd || args.command;
      if (cmd) activity.lastCommand = String(cmd);
    }
  } else if (p.type === "local_shell_call") {
    countTool(activity, "shell");
    track(activity, p.call_id || p.id, ["shell"]);
    const cmd = p.action && p.action.command;
    if (cmd) activity.lastCommand = Array.isArray(cmd) ? cmd.join(" ") : String(cmd);
  } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    finishCall(activity, p);
  } else if (p.type === "web_search_call") {
    countTool(activity, "web_search");
  }
}

async function listDesc(dir) {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

export async function findRollout(codexHome, threadId) {
  const suffix = `-${threadId}.jsonl`;
  const root = join(codexHome, "sessions");
  for (const y of await listDesc(root)) {
    for (const m of await listDesc(join(root, y))) {
      for (const d of await listDesc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        const hit = (await listDesc(dir)).find((f) => f.endsWith(suffix));
        if (hit) return join(dir, hit);
      }
    }
  }
  return null;
}

const EMPTY = Buffer.alloc(0);
const LIMITS = {
  // On first attach to a large rollout, start this many bytes before the end.
  initialTail: 2 * 1024 * 1024,
  // Most bytes parsed per poll; a backlog is consumed over several polls.
  maxRead: 4 * 1024 * 1024,
  // A record longer than this is dropped instead of buffered.
  maxLine: 1024 * 1024,
  // Threads tracked at once (least recently used are evicted).
  maxThreads: 8,
};

function freshState(t) {
  t.offset = 0;
  t.rest = EMPTY;
  t.skipping = false; // drop bytes up to the next newline
  t.ident = null;
  t.activity = emptyActivity();
}

export class TranscriptWatcher {
  constructor(codexHome, options = {}) {
    this.codexHome = codexHome;
    this.limits = { ...LIMITS, ...options };
    this.openFile = options.open || open;
    this.threads = new Map(); // id -> state, least recently used first
  }

  activity(threadId) {
    const t = this.threads.get(threadId);
    return t ? t.activity : null;
  }

  update(threadId) {
    if (!threadId) return Promise.resolve(null);
    let t = this.threads.get(threadId);
    if (t) this.threads.delete(threadId);
    else {
      t = { path: null, missAt: 0, pending: null };
      freshState(t);
    }
    this.threads.set(threadId, t);
    while (this.threads.size > this.limits.maxThreads) {
      this.threads.delete(this.threads.keys().next().value);
    }
    if (!t.pending) {
      t.pending = this.#read(threadId, t)
        .catch(() => {})
        .finally(() => {
          t.pending = null;
        });
    }
    return t.pending.then(() => t.activity);
  }

  async #read(threadId, t) {
    if (!t.path) {
      if (Date.now() - t.missAt < MISS_RETRY_MS) return;
      t.path = await findRollout(this.codexHome, threadId);
      if (!t.path) {
        t.missAt = Date.now();
        return;
      }
    }
    let fh;
    try {
      fh = await this.openFile(t.path, "r");
    } catch (e) {
      if (e && e.code === "ENOENT") {
        // Moved or deleted: look for it again on the next poll.
        t.path = null;
        t.missAt = 0;
        freshState(t);
        return;
      }
      throw e;
    }
    try {
      const st = await fh.stat();
      const ident = `${st.dev}:${st.ino}`;
      if (t.ident !== ident || st.size < t.offset) {
        freshState(t);
        t.ident = ident;
        if (st.size > this.limits.initialTail) {
          t.offset = st.size - this.limits.initialTail;
          t.skipping = true;
        }
      }
      const want = Math.min(st.size - t.offset, this.limits.maxRead);
      if (want <= 0) return;
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, t.offset);
      if (bytesRead <= 0) return;
      t.offset += bytesRead;
      this.#consume(t, buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  }

  #consume(t, chunk) {
    let data = chunk;
    if (t.skipping) {
      const i = data.indexOf(0x0a);
      if (i < 0) return;
      data = data.subarray(i + 1);
      t.skipping = false;
    }
    if (t.rest.length) data = Buffer.concat([t.rest, data]);
    // Check each record in bytes before decoding, keeping incomplete UTF-8 in the tail.
    let start = 0;
    for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, start)) {
      const length = nl - start;
      if (length > 0 && length <= this.limits.maxLine) {
        applyLine(t.activity, data.toString("utf8", start, nl));
      }
      start = nl + 1;
    }
    const tail = data.subarray(start);
    if (tail.length > this.limits.maxLine) {
      t.rest = EMPTY;
      t.skipping = true;
    } else {
      // Copy, so the remainder does not pin the whole read buffer.
      t.rest = tail.length ? Buffer.from(tail) : EMPTY;
    }
  }
}
