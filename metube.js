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

// Normalize one MeTube history entry to the fields the status table needs.
function normalizeEntry(entry) {
  return {
    title: entry.title || entry.name || entry.url || "(unknown)",
    status: entry.status || "?",
    // MeTube reports percent as 0..100 (may be null while resolving metadata).
    percent: typeof entry.percent === "number" ? entry.percent : null,
    speed: entry.speed || null, // bytes/sec when downloading
  };
}

// MeTube's /history returns groups (queue / pending / done) each keyed by id.
// Flatten them into a single recent-first list for the status table.
function flatten(group) {
  if (!group) return [];
  // Group can be an object map { id: entry } or an array of [id, entry] pairs.
  const values = Array.isArray(group)
    ? group.map((pair) => (Array.isArray(pair) ? pair[1] : pair))
    : Object.values(group);
  return values.map(normalizeEntry);
}

// Returns the most recent MeTube items, normalized for the status table.
async function getHistory(limit = 5) {
  if (!BASE) throw new Error("METUBE_URL is not configured");
  const res = await fetch(`${BASE}/history`);
  if (!res.ok) throw new Error(`MeTube /history failed (status ${res.status})`);
  const data = await res.json();
  // Active items (queue/pending) first, then completed.
  const items = [...flatten(data?.queue), ...flatten(data?.pending), ...flatten(data?.done)];
  return items.slice(0, limit);
}

module.exports = { isConfigured, addDownload, getHistory };
