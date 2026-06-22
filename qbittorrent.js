// Thin client for the qBittorrent Web API (v2).
// Maintains a session cookie (SID) and transparently re-authenticates on 403.
// Docs: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const BASE = (process.env.QBITTORRENT_URL || "").replace(/\/+$/, "");
const USER = process.env.QBITTORRENT_USER;
const PASS = process.env.QBITTORRENT_PASS;

let sidCookie = null; // cached session cookie as a full "NAME=VALUE" pair

function api(path) {
  return `${BASE}/api/v2${path}`;
}

// qBittorrent rejects requests whose Referer/Origin host doesn't match unless
// the host-header validation is disabled. Sending Referer keeps it happy.
function baseHeaders(extra = {}) {
  const headers = { Referer: BASE, ...extra };
  if (sidCookie) headers.Cookie = sidCookie;
  return headers;
}

async function login() {
  if (!BASE) throw new Error("QBITTORRENT_URL is not configured");
  const res = await fetch(api("/auth/login"), {
    method: "POST",
    headers: {
      Referer: BASE,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: USER || "", password: PASS || "" }),
  });
  const text = await res.text();
  // qBittorrent <5 returns 200 "Ok."; v5+ returns 204 with an empty body. Treat
  // any 2xx that isn't an explicit "Fails." as success.
  if (!res.ok || text.trim().toLowerCase() === "fails.") {
    throw new Error(
      `qBittorrent login failed (status ${res.status}): ${text.trim() || "no body"}`
    );
  }
  const setCookie = res.headers.get("set-cookie") || "";
  // qBittorrent names the session cookie "SID" (<=4.x) or "QBT_SID_<port>" (5.x).
  // Capture the whole NAME=VALUE pair so we resend it verbatim regardless of name.
  const match = setCookie.match(/((?:QBT_)?SID(?:_\d+)?=[^;]+)/);
  if (!match) {
    throw new Error("qBittorrent login succeeded but no SID cookie was returned");
  }
  sidCookie = match[1];
  return sidCookie;
}

// Run a request, logging in first if needed and retrying once on a 403 (expired session).
async function withAuth(doRequest) {
  if (!sidCookie) await login();
  let res = await doRequest();
  if (res.status === 403) {
    await login();
    res = await doRequest();
  }
  return res;
}

// Add a magnet link or http(s) .torrent URL. qBittorrent fetches http torrent
// URLs itself, so no local download/base64 dance is required.
async function addTorrent(urlOrMagnet, savePath, { category } = {}) {
  const body = { urls: urlOrMagnet };
  if (savePath) body.savepath = savePath;
  if (category) body.category = category;

  const res = await withAuth(() =>
    fetch(api("/torrents/add"), {
      method: "POST",
      headers: baseHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams(body),
    })
  );
  const text = await res.text();
  // qBittorrent returns 200 "Ok." on success and "Fails." when it can't add the
  // torrent; v5 may return an empty 2xx body. Treat 2xx without "Fails." as success.
  const success = res.ok && text.trim().toLowerCase() !== "fails.";
  return {
    success,
    status: res.status,
    statusText: res.statusText,
    responseBody: text,
  };
}

// Returns { total, free } in bytes. qBittorrent only exposes free space on the
// download disk, so total is null (the UI shows free space alone in that case).
async function getFreeSpace() {
  const res = await withAuth(() => fetch(api("/sync/maindata"), { headers: baseHeaders() }));
  if (!res.ok) throw new Error(`qBittorrent maindata failed (status ${res.status})`);
  const data = await res.json();
  // qBittorrent returns -1 for free_space_on_disk when it can't read the
  // download disk (e.g. an external drive's bind mount went stale). Surface
  // that as null rather than a bogus negative byte count so the UI can show
  // "unavailable" instead of a NaN.
  const raw = data?.server_state?.free_space_on_disk;
  const free = typeof raw === "number" && raw >= 0 ? raw : null;
  return { total: null, free };
}

// Returns the most recent torrents, normalized for the recent-downloads table.
async function getTorrents(limit = 5) {
  const params = new URLSearchParams({
    sort: "added_on",
    reverse: "true",
    limit: String(limit),
  });
  const res = await withAuth(() =>
    fetch(api(`/torrents/info?${params}`), { headers: baseHeaders() })
  );
  if (!res.ok) throw new Error(`qBittorrent torrents/info failed (status ${res.status})`);
  const items = await res.json();
  return items.map((t) => ({
    name: t.name,
    size: t.size,
    downloaded: t.completed, // bytes completed
    progress: t.progress, // 0..1
    finished: t.progress >= 1,
    dlspeed: t.dlspeed, // bytes/sec
    state: t.state,
    hash: t.hash,
    category: t.category,
  }));
}

module.exports = { login, addTorrent, getFreeSpace, getTorrents };
