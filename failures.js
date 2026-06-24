// A tiny persistent log of downloads the watchdog gave up on. The app is
// otherwise stateless (qBittorrent owns all torrent state), but a torrent that
// times out gets *deleted* from qBittorrent — so without this it would just
// vanish from the UI with no explanation. We persist to a small JSON file in
// DATA_DIR so the failure survives an app restart and the user can still see
// "❌ Failed — no seeders" for a while afterwards.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "failures.json");
const MAX = 50; // keep the log bounded; oldest entries fall off

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return []; // missing or corrupt → start fresh
  }
}

// Append a failure. `entry` is { hash, name, reason }; failedAt is stamped here.
function record(entry) {
  const list = load();
  list.unshift({ ...entry, failedAt: entry.failedAt || Math.floor(Date.now() / 1000) });
  const trimmed = list.slice(0, MAX);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.error("Failed to persist failure log:", e.message);
  }
  return trimmed;
}

// Failures from the last `maxAgeSec` seconds (default 24h), newest first.
function recent(maxAgeSec = 86400) {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  return load().filter((f) => (f.failedAt || 0) >= cutoff);
}

module.exports = { record, recent, list: load };
