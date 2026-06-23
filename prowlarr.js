// Thin client for Prowlarr (self-hosted indexer manager) running on the Mac mini
// alongside qBittorrent, reached over WireGuard. Prowlarr aggregates many torrent
// indexers behind one Torznab/JSON API, so it surfaces releases Snowfl misses and
// — crucially for music — lets us scope a search to the Audio category.
//
// Results are normalized to the SAME field shape Snowfl returns (see snowfl.js)
// so search.js can merge both sources into one table without special-casing.
// Docs: https://wiki.servarr.com/prowlarr
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const BASE = (process.env.PROWLARR_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.PROWLARR_API_KEY || "";

// Newznab/Torznab top-level category ids. Prowlarr reports a release's categories
// as either bare numbers or { id, name } objects depending on version.
const AUDIO = 3000;
const MOVIES = 2000;
const TV = 5000;
const XXX = 6000;

function isConfigured() {
  return Boolean(BASE && API_KEY);
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function humanAge(dateStr) {
  const t = Date.parse(dateStr || "");
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "today";
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.floor(days / 30)} months`;
  return `${Math.floor(days / 365)} years`;
}

// Pull the numeric category ids out of a release, tolerating both encodings.
function categoryIds(release) {
  return (release.categories || [])
    .map((c) => (typeof c === "number" ? c : c && c.id))
    .filter((n) => typeof n === "number");
}

// Map to a Snowfl-style coarse `type` string so classify.js routes it the same
// way it routes Snowfl results (e.g. "Audio" -> Music directory).
function categoryType(release) {
  const ids = categoryIds(release);
  const inBand = (band) => ids.some((id) => id >= band && id < band + 1000);
  if (inBand(AUDIO)) return "Audio";
  if (inBand(MOVIES)) return "Video";
  if (inBand(TV)) return "TV";
  if (inBand(XXX)) return "XXX";
  return "";
}

function normalize(release) {
  const type = categoryType(release);
  return {
    name: release.title || "(untitled)",
    // qBittorrent accepts both magnet: and http(s) .torrent URLs, so either works
    // as the download target. Prefer a real magnet; fall back to the download URL.
    magnet: release.magnetUrl || release.downloadUrl || undefined,
    url: release.infoUrl || release.downloadUrl || "",
    size: humanSize(release.size),
    seeder: release.seeders ?? "",
    leecher: release.leechers ?? "",
    type,
    site: release.indexer || "prowlarr",
    age: humanAge(release.publishDate),
    trusted: false, // Prowlarr doesn't expose a trust flag
    nsfw: type === "XXX",
  };
}

// Search Prowlarr. `audioOnly` scopes the query to the Audio category (3000) so
// music searches stop competing with movie/TV noise. Returns normalized results
// (torrents only — usenet releases can't be handed to qBittorrent).
async function search(query, { audioOnly = false } = {}) {
  if (!isConfigured()) return [];
  const params = new URLSearchParams({ query, type: "search", limit: "100" });
  if (audioOnly) params.append("categories", String(AUDIO));

  const res = await fetch(`${BASE}/api/v1/search?${params}`, {
    headers: { "X-Api-Key": API_KEY, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Prowlarr search failed (status ${res.status})`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((r) => !r.protocol || r.protocol === "torrent")
    .map(normalize);
}

module.exports = { isConfigured, search };
