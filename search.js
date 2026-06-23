// Unified torrent search. Queries Snowfl (always) and Prowlarr (when configured)
// in parallel, de-dupes the combined results, fuzzy-ranks them by relevance to
// the query, then renders the HTML table the frontend HTMX swap expects.
//
// Mounted at /snowfl for backwards-compatibility with the existing form target.
const express = require("express");
const bodyParser = require("body-parser");
const Fuse = require("fuse.js");
const jht = require("json-html-table");

const snowfl = require("./snowfl");
const prowlarr = require("./prowlarr");
const { classifyMedia } = require("./classify");

const app = express.Router();
app.use(bodyParser.urlencoded({ extended: true }));

app.post("/", async (req, res) => {
  try {
    const query = (req.body?.query || "").trim();
    if (!query) {
      res.status(200).send("no query");
      return;
    }
    const audioOnly = req.body?.music === "on" || req.body?.music === "true";
    const table = await search_to_table(query, audioOnly);
    res.setHeader("Content-Type", "text/html");
    res.send(table);
  } catch (e) {
    res.status(200).send(e.toString());
  }
});

// --- download button rendering -------------------------------------------------
function magnet_url_to_dl_button(url, route) {
  // Turn a result into a download button. The detected route is baked in: a
  // confident guess submits straight to that directory; an unrecognized one opens
  // the directory picker modal (confident=false).
  const path = route.confident ? route.path : "";
  const suffix = route.confident ? ` → ${route.label.replace(" Directory", "")}` : "";
  return `<button onClick="routeMagnet('${url}', '${path}', ${route.confident})">Easy Download${suffix}</button>`;
}
function no_magnet(url) {
  return `<a href=${url}>please manually get torrent from here sorry</a>`;
}

// --- merge + rank --------------------------------------------------------------
function tokenize(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

// btih hash uniquely identifies a torrent across sources; fall back to a
// name+size key for results that only carry an http .torrent link.
function magnetHash(magnet) {
  const m = String(magnet || "").match(/xt=urn:btih:([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}
function dedupeKey(el) {
  return magnetHash(el.magnet) || `${tokenize(el.name).join(" ")}|${el.size || ""}`;
}

// Prefer the copy with a real download link, then the one with more seeders.
function isBetter(a, b) {
  const am = a.magnet ? 1 : 0;
  const bm = b.magnet ? 1 : 0;
  if (am !== bm) return am > bm;
  return (Number(a.seeder) || 0) > (Number(b.seeder) || 0);
}

function mergeResults(lists) {
  const byKey = new Map();
  for (const el of lists.flat()) {
    if (!el || !el.name) continue;
    const key = dedupeKey(el);
    const prev = byKey.get(key);
    if (!prev || isBetter(el, prev)) byKey.set(key, el);
  }
  return [...byKey.values()];
}

// Sort by relevance to the query. Fuse supplies a typo-tolerant fuzzy score;
// ignoreLocation:true drops Fuse's default bias toward matches near the START of
// the name, which is the whole point — searching "album" should surface
// "Artist - Album", not just titles that begin with the query.
function rankResults(results, query) {
  const qTokens = tokenize(query);
  const fuse = new Fuse(results, {
    keys: ["name"],
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
  const fuseScore = new Map();
  for (const hit of fuse.search(query)) fuseScore.set(hit.refIndex, hit.score);

  const scored = results.map((el, i) => {
    const lname = String(el.name || "").toLowerCase();
    const hits = qTokens.filter((t) => lname.includes(t)).length;
    return {
      el,
      hasDownload: el.magnet ? 1 : 0,
      allTokens: qTokens.length > 0 && hits === qTokens.length ? 1 : 0,
      hits,
      fuse: fuseScore.has(i) ? fuseScore.get(i) : 1, // missing = worst match
      seeder: Number(el.seeder) || 0,
    };
  });

  scored.sort(
    (a, b) =>
      b.hasDownload - a.hasDownload ||
      b.allTokens - a.allTokens ||
      b.hits - a.hits ||
      a.fuse - b.fuse ||
      b.seeder - a.seeder
  );
  return scored.map((s) => s.el);
}

async function search_to_table(query, audioOnly) {
  const [snow, prow] = await Promise.all([
    snowfl.search(query).catch((e) => {
      console.error("Snowfl search failed:", e.message);
      return [];
    }),
    prowlarr.isConfigured()
      ? prowlarr.search(query, { audioOnly }).catch((e) => {
          console.error("Prowlarr search failed:", e.message);
          return [];
        })
      : Promise.resolve([]),
  ]);

  let jsonArray = mergeResults([snow, prow]);

  // Classify once so we can both filter (music-only mode) and label rows.
  jsonArray.forEach((el) => {
    el._route = classifyMedia({ name: el.name, snowflType: el.type });
  });
  if (audioOnly) {
    jsonArray = jsonArray.filter((el) => el._route.category === "music");
  }

  jsonArray = rankResults(jsonArray, query);

  jsonArray.forEach((element) => {
    const route = element._route;
    element["route"] = route.confident ? route.label.replace(" Directory", "") : "❓ ask";
    element["dlbutton"] = magnet_url_to_dl_button(element["magnet"], route);
    if (element.magnet == undefined) {
      element["dlbutton"] = no_magnet(element["url"]);
    }
    element["source_link"] = `<a href="${element["url"]}">${element["name"]}</a>`;
    delete element._route;
  });

  const keys = [
    "dlbutton",
    "route",
    "size",
    "seeder",
    "source_link",
    "site",
    "age",
    "leecher",
    "type",
    "trusted",
    "nsfw",
  ];
  if (jsonArray.length == 0) {
    return "No results found";
  }
  const hideButton = `<button hx-get="/empty" hx-target="#snowfl-output" hx-swap="innerHTML">(hide table)</button>`;
  return hideButton + jht(jsonArray, keys);
}

module.exports = app;
