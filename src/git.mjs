import { execFile } from "node:child_process";

const TTL_MS = 2000;
const MAX_ENTRIES = 16;
const cache = new Map(); // cwd -> { at, info, pending }, in least-recently-used order

export function parseStatus(out) {
  const lines = out.split(/\r?\n/);
  const head = lines[0] || "";
  if (!head.startsWith("## ")) return null;
  const h = head.slice(3);
  let branch = null;
  let ahead = 0;
  let behind = 0;
  let m;
  if ((m = /^No commits yet on (.+)$/.exec(h)) || (m = /^Initial commit on (.+)$/.exec(h))) {
    branch = m[1];
  } else if (h.startsWith("HEAD (no branch)")) {
    branch = "detached";
  } else {
    branch = h.split(" [")[0].split("...")[0];
    const a = /ahead (\d+)/.exec(h);
    const b = /behind (\d+)/.exec(h);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  let dirty = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const l of lines.slice(1)) {
    if (!l.trim()) continue;
    dirty++;
    const x = l[0];
    const y = l[1];
    if (x === "?" && y === "?") {
      untracked++;
    } else {
      if (x && x !== " " && x !== "?") staged++;
      if (y && y !== " " && y !== "?") modified++;
    }
  }
  return { branch, ahead, behind, dirty, staged, modified, untracked };
}

export const GIT_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "--branch",
  // Count untracked files even if the user set status.showUntrackedFiles=no.
  "--untracked-files=normal",
];

function run(cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      GIT_ARGS,
      {
        cwd,
        timeout: 800,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (err, stdout) => resolve(err ? null : parseStatus(stdout)),
    );
  });
}

// Returns the cached info and refreshes it in the background when stale.
// Awaiting `refresh` waits for a fresh value.
export function gitInfo(cwd) {
  if (!cwd) return { info: null, refresh: Promise.resolve(null) };
  let entry = cache.get(cwd);
  if (entry) cache.delete(cwd);
  else entry = { at: 0, info: null, pending: null };
  cache.set(cwd, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  if (!entry.pending && Date.now() - entry.at > TTL_MS) {
    entry.pending = run(cwd).then((info) => {
      entry.info = info;
      entry.at = Date.now();
      entry.pending = null;
      return info;
    });
  }
  return { info: entry.info, refresh: entry.pending || Promise.resolve(entry.info) };
}

export const _cacheSize = () => cache.size;
