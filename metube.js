// Thin client for MeTube (self-hosted yt-dlp), running on the Mac mini alongside
// qBittorrent/Jellyfin and reached over WireGuard. It downloads a pasted link as
// audio (MP3) or video into the existing Jellyfin media roots.
// Docs: https://github.com/alexta69/metube
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const BASE = (process.env.METUBE_URL || "").replace(/\/+$/, "");

function isConfigured() {
  return Boolean(BASE);
}

// Submit a URL to MeTube. `kind` is "audio" (→ MP3, lands in AUDIO_DOWNLOAD_DIR)
// or "video" (lands in DOWNLOAD_DIR). MeTube's /add reads only the keys it knows,
// so we send a superset that works across versions: older builds drive the
// audio/video split off `format`, newer builds off `download_type`.
async function addDownload(url, kind) {
  if (!BASE) throw new Error("METUBE_URL is not configured");
  const body =
    kind === "audio"
      ? { url, download_type: "audio", format: "mp3", quality: "best", auto_start: true }
      : { url, download_type: "video", format: "mp4", quality: "best", auto_start: true };

  const res = await fetch(`${BASE}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // MeTube returns 200 with { status: "ok" } on success, or { status: "error", msg }.
  let success = res.ok;
  try {
    success = res.ok && JSON.parse(text)?.status === "ok";
  } catch {
    // non-JSON body: fall back to the HTTP status
  }
  return {
    success,
    status: res.status,
    statusText: res.statusText,
    responseBody: text,
  };
}

// A MeTube history group can be an object map { id: entry } or an array of
// [id, entry] pairs (or bare entries). Return the raw entry objects either way.
function rawEntries(group) {
  if (!group) return [];
  return Array.isArray(group)
    ? group.map((pair) => (Array.isArray(pair) ? pair[1] : pair))
    : Object.values(group);
}

// Normalize one MeTube history entry to the fields the status table needs. Note:
// MeTube's REST /history reports an in-flight item as status "pending" with no
// percent (live progress is only pushed over its websocket), so the table can't
// show a live percentage — only pending → finished/error.
function normalizeEntry(entry) {
  return {
    title: entry.title || entry.name || entry.url || "(unknown)",
    status: entry.status || "?",
  };
}

// Returns the most recent MeTube items, normalized for the status table.
async function getHistory(limit = 5) {
  if (!BASE) throw new Error("METUBE_URL is not configured");
  const res = await fetch(`${BASE}/history`);
  if (!res.ok) throw new Error(`MeTube /history failed (status ${res.status})`);
  const data = await res.json();
  // Active items (queue/pending) first, then completed.
  const items = [
    ...rawEntries(data?.queue),
    ...rawEntries(data?.pending),
    ...rawEntries(data?.done),
  ].map(normalizeEntry);
  return items.slice(0, limit);
}

// Returns the ids of completed downloads. Used by the completion watcher to
// trigger a Jellyfin refresh once a file actually exists (downloads finish
// minutes after submission, so refreshing on submit is too early).
async function getFinishedIds() {
  if (!BASE) return [];
  const res = await fetch(`${BASE}/history`);
  if (!res.ok) throw new Error(`MeTube /history failed (status ${res.status})`);
  const data = await res.json();
  return rawEntries(data?.done)
    .map((e) => e.id)
    .filter(Boolean);
}

module.exports = { isConfigured, addDownload, getHistory, getFinishedIds };
