require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const path = require("path");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const bodyParser = require("body-parser");
const emojiFavicon = require("emoji-favicon");

const snowfl = require("./snowfl");
const qbittorrent = require("./qbittorrent");
const jellyfin = require("./jellyfin");
const vpn = require("./vpn");
const users = require("./users");
const { passport, router: authRouter, ensureAuth, ensureAdmin } = require("./auth");

const TMDB_KEY = process.env.TMDB_KEY;
const QBITTORRENT_WEBUI_URL = process.env.QBITTORRENT_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const isProd = process.env.NODE_ENV === "production";

// Download directories as qBittorrent (in its container) sees them. Driven by
// env so the same image works for any mount layout; the frontend builds its
// dropdown from /media-paths and the server only accepts these exact values.
const MEDIA_PATHS = {
  "Movie Directory": process.env.MEDIA_MOVIES || "/downloads/movies",
  "TV Show Directory": process.env.MEDIA_TV || "/downloads/tvshows",
  "Music Directory": process.env.MEDIA_MUSIC || "/downloads/music",
  "General Torrent Directory": process.env.MEDIA_GENERAL || "/downloads/torrents",
};
const ALLOWED_SAVE_PATHS = new Set(Object.values(MEDIA_PATHS));

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

app.use("/snowfl", ensureAuth, snowfl);

app.get("/media-paths", ensureAuth, function (request, response) {
  response.json(MEDIA_PATHS);
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
    const content = items
      .map((item) => {
        const { name, size, finished } = item;
        const sizeGB = (size / 1000000000).toFixed(2);
        const dlStatus = finished ? "Done" : "Started";
        return `<tr>
              <td>${name.substring(0, 40)}</td>
              <td>${sizeGB}GB</td>
              <td>${dlStatus}</td>
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

app.listen(app.get("port"), function () {
  console.log("Node app is running at http://0.0.0.0:" + app.get("port"));
});
