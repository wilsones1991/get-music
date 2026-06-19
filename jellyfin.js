// Minimal Jellyfin integration: trigger a library scan so newly downloaded
// media shows up without waiting for the scheduled scan.
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const BASE = (process.env.JELLYFIN_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.JELLYFIN_API_KEY;

// Fire-and-forget refresh of the whole Jellyfin library. Errors are logged but
// never thrown — a failed scan should not fail the download submission.
async function refreshLibrary() {
  if (!BASE || !API_KEY) {
    console.warn("Jellyfin not configured (JELLYFIN_URL / JELLYFIN_API_KEY); skipping scan");
    return false;
  }
  try {
    const res = await fetch(`${BASE}/Library/Refresh`, {
      method: "POST",
      headers: { "X-Emby-Token": API_KEY },
    });
    if (!res.ok) {
      console.error(`Jellyfin library refresh failed (status ${res.status})`);
      return false;
    }
    console.log("Triggered Jellyfin library refresh");
    return true;
  } catch (error) {
    console.error("Jellyfin library refresh error:", error.message);
    return false;
  }
}

module.exports = { refreshLibrary };
