require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const path = require("path");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const bodyParser = require("body-parser");
const emojiFavicon = require("emoji-favicon");

const search = require("./search");
const qbittorrent = require("./qbittorrent");
const failures = require("./failures");
const metube = require("./metube");
const jellyfin = require("./jellyfin");
const vpn = require("./vpn");
const users = require("./users");
const { passport, router: authRouter, ensureAuth, ensureAdmin } = require("./auth");
const {
  MEDIA_PATHS,
  ALLOWED_SAVE_PATHS,
  classifyMedia,
  nameFromMagnet,
} = require("./classify");

const TMDB_KEY = process.env.TMDB_KEY;
const QBITTORRENT_WEBUI_URL = process.env.QBITTORRENT_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const isProd = process.env.NODE_ENV === "production";

// MEDIA_PATHS / ALLOWED_SAVE_PATHS live in ./classify (single source of truth):
// the frontend builds its dropdown from /media-paths, the classifier routes
// among these, and the server only accepts these exact values on submit.

const app = express();
app.set("port", process.env.PORT || 5000);
app.set("trust proxy", 1); // Coolify terminates TLS upstream

// Seed bootstrap admins into the allowlist file.
users.init();

// --- middleware ---------------------------------------------------------------
app.use(bodyParser.urlencoded({ extended: false }));
app.use(
  session({
    store: new FileStore({
      path: path.join(DATA_DIR, "sessions"),
      retries: 1,
      logFn: () => {},
    }),
    secret: process.env.SESSION_SECRET || "insecure-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use(emojiFavicon("cinema"));

// Public: favicon, static assets (css/js/images), and auth routes.
app.use(express.static(__dirname + "/public"));
app.use("/", authRouter);

// --- torrent download ----------------------------------------------------------
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://open.demonii.com:1337/announce",
  "https://tracker.moeblog.cn:443/announce",
  "udp://open.dstud.io:6969/announce",
  "udp://tracker.srv00.com:6969/announce",
  "https://tracker.zhuqiy.com:443/announce",
  "https://tracker.pmman.tech:443/announce",
];

function construct_magnet_link(hash, display_name, trackers) {
  const dn = encodeURIComponent(display_name);
  const trackerParams = trackers.map((t) => `tr=${encodeURIComponent(t)}`).join("&");
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}&${trackerParams}`;
}

// Shared submit path for /post and /yts: refuse if the VPN is down, hand the
// magnet/url to qBittorrent, then nudge Jellyfin to scan.
async function submitDownload(magnet, savePath, label, res) {
  if (!ALLOWED_SAVE_PATHS.has(savePath)) {
    return res.status(400).send("Invalid download directory");
  }

  const vpnStatus = await vpn.getStatus();
  if (vpnStatus.configured && !vpnStatus.active) {
    return res
      .status(503)
      .send("Refusing to download: VPN tunnel is not active. Check gluetun/Mullvad.");
  }

  const options = {};
  if (label && label !== "no-label") options.category = label;

  const result = await qbittorrent.addTorrent(magnet, savePath, options);
  if (result.success) {
    jellyfin.refreshLibrary(); // fire-and-forget
    return res.status(200).send(`succesfully submitted ${magnet}`);
  }
  const errorMsg = `Failed to submit torrent. qBittorrent returned status ${result.status} (${result.statusText}). Response: ${result.responseBody}`;
  console.error("Torrent submission failed:", errorMsg);
  return res.status(400).send(errorMsg);
}

// --- routes (all require auth) -------------------------------------------------
app.get("/", ensureAuth, function (request, response) {
  response.sendFile(__dirname + "/index.html");
});

app.get("/empty", ensureAuth, function (request, response) {
  response.send("");
});

// Unified search (Snowfl + Prowlarr, fuzzy-ranked). Kept at /snowfl so the
// existing frontend form target doesn't change.
app.use("/snowfl", ensureAuth, search);

app.get("/media-paths", ensureAuth, function (request, response) {
  response.json(MEDIA_PATHS);
});

// Auto-routing: given a magnet/url (or an explicit name + snowfl type), return
// the directory it should go in. { confident:false } means "name unrecognized,
// ask the user". The client uses this to skip the dropdown on the happy path.
app.get("/classify", ensureAuth, function (request, response) {
  const name = request.query.name || nameFromMagnet(request.query.magnet || "");
  response.json(classifyMedia({ name, snowflType: request.query.type }));
});

app.get("/client-url", ensureAuth, function (request, response) {
  response.json({ url: QBITTORRENT_WEBUI_URL });
});

app.get("/vpn-status", ensureAuth, async function (request, response) {
  response.json(await vpn.getStatus());
});

app.post("/post", ensureAuth, async function (request, response) {
  try {
    if (!request.body.magnet) {
      return response.status(400).send("Missing required field: magnet");
    }
    if (!request.body.mediatype) {
      return response.status(400).send("Missing required field: mediatype");
    }

    let magnet = request.body.magnet;

    // YTS download URLs are turned into magnet links from their hash.
    if (magnet.includes("yts.gg/torrent/download/")) {
      const { hash, quality, type, movieTitle } = request.body;
      if (!hash || !quality || !type || !movieTitle) {
        return response
          .status(400)
          .send("YTS torrents require hash, quality, type, and movieTitle fields");
      }
      const displayName = `${movieTitle} ${quality} ${type}`;
      magnet = construct_magnet_link(hash, displayName, DEFAULT_TRACKERS);
      console.log("Constructed magnet link:", magnet);
    } else if (!magnet.startsWith("magnet:") && !magnet.startsWith("http")) {
      return response
        .status(400)
        .send("Invalid magnet link or url - must start with 'magnet:' or 'http'");
    }

    return await submitDownload(magnet, request.body.mediatype, request.body.label, response);
  } catch (error) {
    console.error("Error in /post endpoint:", error);
    return response.status(500).send(`Internal server error: ${error.message}`);
  }
});

app.post("/yts", ensureAuth, async function (request, response) {
  try {
    if (!request.body.magnet) {
      return response.status(400).send("Missing required field: magnet");
    }
    if (!request.body.mediatype) {
      return response.status(400).send("Missing required field: mediatype");
    }
    return await submitDownload(
      request.body.magnet,
      request.body.mediatype,
      request.body.label,
      response
    );
  } catch (error) {
    console.error("Error in /yts endpoint:", error);
    return response.status(500).send(`Internal server error: ${error.message}`);
  }
});

// Paste a link (YouTube, etc.) → download audio (MP3) or video via MeTube on the
// Mac mini. Unlike torrents this does not go through Mullvad, so there's no VPN
// gate. MeTube routes audio to AUDIO_DOWNLOAD_DIR and video to DOWNLOAD_DIR.
app.post("/yt", ensureAuth, async function (request, response) {
  try {
    if (!metube.isConfigured()) {
      return response.status(503).send("Link downloads are not configured (METUBE_URL unset).");
    }
    const url = (request.body.url || "").trim();
    const kind = request.body.kind === "video" ? "video" : "audio";
    if (!url.startsWith("http")) {
      return response.status(400).send("Invalid URL - must start with 'http'");
    }
    const result = await metube.addDownload(url, kind);
    if (result.success) {
      // No refresh here — the file lands minutes later; the completion watcher
      // (see below) refreshes Jellyfin once it actually exists.
      return response
        .status(200)
        .send(
          `Submitted (${kind}). Downloading in the background — it'll show "✅ Done" below and appear in Jellyfin when finished. Large mixes can take a few minutes.`
        );
    }
    const errorMsg = `MeTube rejected the link (status ${result.status}). Response: ${result.responseBody}`;
    console.error("MeTube submission failed:", errorMsg);
    return response.status(400).send(errorMsg);
  } catch (error) {
    console.error("Error in /yt endpoint:", error);
    return response.status(500).send(`Internal server error: ${error.message}`);
  }
});

// Free disk space on the qBittorrent download volume.
app.get("/diskspace", ensureAuth, async function (request, response) {
  try {
    response.json(await qbittorrent.getFreeSpace());
  } catch (error) {
    console.error(error);
    response.status(500).send("Internal Server Error");
  }
});

// Recent downloads table (kept as server-rendered HTML for the existing HTMX swap).
app.get("/dl-status", ensureAuth, async function (request, response) {
  try {
    const limit = parseInt(request.query.limit, 10) || 5;
    const items = await qbittorrent.getTorrents(limit);
    const live = items.map((item) => {
      const { name, size, finished, progress, dlspeed, state, addedOn } = item;
      const pct = Math.round((progress || 0) * 100);
      let dlStatus;
      if (finished) {
        dlStatus = "✅ Done";
      } else if (dlspeed > 0) {
        const mbps = (dlspeed / 1000000).toFixed(1);
        dlStatus = `⬇ ${pct}% · ${mbps} MB/s`;
      } else {
        // Stalled/queued/metadata states: show progress + the qBittorrent state
        // so a stuck download (e.g. no seeds) is distinguishable from a moving one.
        dlStatus = `${pct}% · ${state}`;
      }
      return { name, sizeGB: size / 1000000000, ts: addedOn, dlStatus };
    });
    // Watchdog-ended downloads are deleted from qBittorrent, so they only survive
    // in the failure log — merge them in (newest-first) so a timed-out torrent
    // shows "❌ Failed — …" instead of silently disappearing.
    const failed = failures.recent().map((f) => ({
      name: f.name,
      sizeGB: null,
      ts: f.failedAt,
      dlStatus: `❌ Failed — ${f.reason}`,
    }));
    const content = [...failed, ...live]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit)
      .map((r) => {
        const size = r.sizeGB == null ? "—" : `${r.sizeGB.toFixed(2)}GB`;
        return `<tr>
              <td>${r.name.substring(0, 40)}</td>
              <td>${size}</td>
              <td>${r.dlStatus}</td>
            </tr>`;
      })
      .join("\n");

    const htmlTable = `<table>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>DL Status</th>
                    </tr>
                    ${content}
                  </table>`;
    response.send(htmlTable);
  } catch (error) {
    console.error(error);
    response.status(500).send("Internal Server Error");
  }
});

// MeTube (link download) status table, mirroring /dl-status for the HTMX swap.
app.get("/yt-status", ensureAuth, async function (request, response) {
  try {
    if (!metube.isConfigured()) {
      return response.send("<table><tr><td>Link downloads not configured.</td></tr></table>");
    }
    const limit = parseInt(request.query.limit, 10) || 5;
    const items = await metube.getHistory(limit);
    const content = items
      .map(({ title, status }) => {
        // MeTube's REST API doesn't expose live percent, so an in-flight item
        // shows as "pending" the whole time — present that as "Working…" rather
        // than a misleading "0%".
        let dlStatus;
        if (status === "finished") {
          dlStatus = "✅ Done";
        } else if (status === "error") {
          dlStatus = "❌ Failed";
        } else {
          dlStatus = "⏳ Working…";
        }
        return `<tr>
              <td>${String(title).substring(0, 40)}</td>
              <td>${dlStatus}</td>
            </tr>`;
      })
      .join("\n");

    const htmlTable = `<table>
                    <tr>
                      <th>Name</th>
                      <th>DL Status</th>
                    </tr>
                    ${content}
                  </table>`;
    response.send(htmlTable);
  } catch (error) {
    console.error(error);
    response.status(500).send("Internal Server Error");
  }
});

app.get("/tmdb-poster", ensureAuth, async function (request, response) {
  const imdb_id = request.query.imdb_id;
  if (!imdb_id || !TMDB_KEY) {
    return response.status(400).send("Missing imdb_id or TMDB_KEY not configured");
  }
  try {
    const url = `https://api.themoviedb.org/3/find/${imdb_id}?external_source=imdb_id&api_key=${TMDB_KEY}`;
    const tmdbResp = await fetch(url);
    const data = await tmdbResp.json();
    const movie = data.movie_results?.[0];
    if (!movie?.poster_path) {
      return response.status(404).send("No poster found");
    }
    return response.redirect(`https://image.tmdb.org/t/p/w185${movie.poster_path}`);
  } catch (error) {
    return response.status(500).send("TMDB lookup error");
  }
});

// --- admin (allowlist management) ----------------------------------------------
app.get("/admin", ensureAdmin, function (request, response) {
  response.sendFile(__dirname + "/admin.html");
});

app.get("/admin/api/users", ensureAdmin, function (request, response) {
  response.json({ users: users.listUsers() });
});

app.post("/admin/api/users", ensureAdmin, function (request, response) {
  try {
    const { email, isAdmin } = request.body;
    const list = users.addUser(email, {
      isAdmin: isAdmin === "true" || isAdmin === true || isAdmin === "on",
      addedBy: request.user.email,
    });
    response.json({ users: list });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.delete("/admin/api/users/:email", ensureAdmin, function (request, response) {
  try {
    response.json({ users: users.removeUser(request.params.email) });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post("/admin/api/users/:email/admin", ensureAdmin, function (request, response) {
  try {
    const makeAdmin = request.body.isAdmin === "true" || request.body.isAdmin === true;
    response.json({ users: users.setAdmin(request.params.email, makeAdmin) });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

// Watch MeTube for newly-completed downloads and refresh Jellyfin when one
// finishes. Link downloads complete minutes after submission, so refreshing at
// submit time is too early; this is what actually gets the file into Jellyfin
// without waiting for its scheduled scan.
if (metube.isConfigured()) {
  const seenFinished = new Set();
  let primed = false; // first poll just records existing items, no refresh
  setInterval(async () => {
    try {
      const ids = await metube.getFinishedIds();
      const fresh = ids.filter((id) => !seenFinished.has(id));
      ids.forEach((id) => seenFinished.add(id));
      if (!primed) {
        primed = true;
        return;
      }
      if (fresh.length) {
        console.log(`MeTube: ${fresh.length} new completion(s); refreshing Jellyfin`);
        jellyfin.refreshLibrary(); // fire-and-forget
      }
    } catch (error) {
      // Transient (MeTube restarting / WireGuard blip) — try again next tick.
    }
  }, 30000).unref();
}

// Stall watchdog: end downloads that can't find anyone to download from. A
// torrent stuck in metaDL/stalledDL with no reachable seeders will sit at 0%
// forever — qBittorrent never gives up on its own. Once a download makes no
// progress for STALL_TIMEOUT, we delete it (and any partial files) and log the
// failure so the UI can show "❌ Failed — no seeders" instead of a perpetual
// "0% · metaDL". We only ever time out torrents that are actively trying to
// download — never a user-paused torrent, a finished/seeding one, or one whose
// files went missing on a drive disconnect (that's a different, recoverable
// failure handled elsewhere).
if (process.env.QBITTORRENT_URL) {
  const STALL_TIMEOUT_MS =
    (parseInt(process.env.TORRENT_STALL_TIMEOUT_MIN, 10) || 30) * 60 * 1000;
  const DOWNLOADING_STATES = new Set([
    "downloading",
    "metaDL",
    "forcedMetaDL",
    "stalledDL",
    "forcedDL",
    "queuedDL",
    "allocating",
  ]);
  // hash -> { downloaded, since }: `since` is when progress last advanced.
  const progress = new Map();

  setInterval(async () => {
    let torrents;
    try {
      torrents = await qbittorrent.getAllTorrents();
    } catch (error) {
      return; // qBittorrent unreachable (restart / VPN blip) — retry next tick.
    }
    const now = Date.now();
    const live = new Set();
    for (const t of torrents) {
      if (t.finished || !DOWNLOADING_STATES.has(t.state)) continue;
      live.add(t.hash);
      const prev = progress.get(t.hash);
      if (!prev) {
        // First sighting. If it's already at 0 bytes, anchor the stall clock to
        // when it was added so a torrent stuck across an app restart is caught
        // promptly rather than handed a fresh full window.
        const since = t.downloaded === 0 && t.addedOn ? t.addedOn * 1000 : now;
        progress.set(t.hash, { downloaded: t.downloaded, since });
        continue;
      }
      if (t.downloaded > prev.downloaded) {
        progress.set(t.hash, { downloaded: t.downloaded, since: now });
        continue;
      }
      if (now - prev.since >= STALL_TIMEOUT_MS) {
        const mins = Math.round((now - prev.since) / 60000);
        try {
          await qbittorrent.deleteTorrent(t.hash, true);
          failures.record({
            hash: t.hash,
            name: t.name,
            reason: t.numSeeds > 0 ? "stalled (peers unreachable)" : "no seeders",
          });
          progress.delete(t.hash);
          console.log(
            `Watchdog: ended "${t.name}" after ${mins}m with no progress (${t.state}, ${t.numSeeds} seeds)`
          );
        } catch (error) {
          console.error(`Watchdog: failed to delete ${t.hash}: ${error.message}`);
        }
      }
    }
    // Forget bookkeeping for torrents that finished or were removed.
    for (const hash of progress.keys()) {
      if (!live.has(hash)) progress.delete(hash);
    }
  }, 60000).unref();
}

app.listen(app.get("port"), function () {
  console.log("Node app is running at http://0.0.0.0:" + app.get("port"));
});
