// Auto-routing: pick which media directory a torrent should land in.
//
// For magnets the file list isn't known until qBittorrent fetches metadata, so
// at submit time the release *name* (plus snowfl's coarse `type`) is all we
// have. These are pure string heuristics over that name. Phase 2 will verify
// against the real files post-metadata and relocate if the name lied.
//
// This module also owns MEDIA_PATHS so the directory list has a single source
// of truth shared by the submit path, the /media-paths dropdown, and the
// classifier itself.
require("dotenv").config();

// Download directories as qBittorrent (in its container) sees them. Driven by
// env so the same image works for any mount layout.
const MEDIA_PATHS = {
  "Movie Directory": process.env.MEDIA_MOVIES || "/downloads/movies",
  "TV Show Directory": process.env.MEDIA_TV || "/downloads/tvshows",
  "Music Directory": process.env.MEDIA_MUSIC || "/downloads/music",
  "General Torrent Directory": process.env.MEDIA_GENERAL || "/downloads/torrents",
};
const ALLOWED_SAVE_PATHS = new Set(Object.values(MEDIA_PATHS));

// Internal category key -> the human label used in MEDIA_PATHS / the dropdown.
const LABEL_BY_CATEGORY = {
  tvshows: "TV Show Directory",
  music: "Music Directory",
  movies: "Movie Directory",
};

// Ordered: first match wins. TV episode markers and audio signals are checked
// before generic video tags so e.g. "Inferno (2026) [FLAC 24-44]" routes to
// music — the bare year would otherwise look movie-ish.
const RULES = [
  {
    category: "tvshows",
    re: /\b(s\d{1,2}[ ._-]?e\d{1,2}|\d{1,2}x\d{2}|season[ ._-]?\d|complete[ ._-]?series)\b/i,
  },
  {
    category: "music",
    re: /(\bflac\b|\bmp3\b|\bm4a\b|\baac\b|\balac\b|320[ ._-]?kbps|\bv0\b|\bvinyl\b|discograph|\b\d{2}-(?:44|48|96)\b|cdrip|web[ ._-]?flac|\beac\b)/i,
  },
  {
    category: "movies",
    re: /\b(1080p|720p|2160p|480p|4k|x264|x265|h\.?26[45]|hevc|xvid|bluray|blu-ray|web-?dl|web-?rip|brrip|bdrip|hdrip|dvdrip|remux|hdtv)\b/i,
  },
];

// snowfl's coarse `type` -> our category. Used only as a fallback prior when
// the name itself matched nothing; the exact strings vary, so anything
// unrecognized just falls through to "ask the user".
const SNOWFL_TYPE = {
  video: "movies",
  movie: "movies",
  movies: "movies",
  audio: "music",
  music: "music",
  tv: "tvshows",
  "tv show": "tvshows",
  series: "tvshows",
};

// Classify a release. Returns { category, label, path, confident }. When no
// rule and no prior matches, confident is false and the caller should ask.
function classifyMedia({ name = "", snowflType = "" } = {}) {
  const text = String(name || "");
  let category = null;

  for (const rule of RULES) {
    if (rule.re.test(text)) {
      category = rule.category;
      break;
    }
  }

  if (!category) {
    const prior = SNOWFL_TYPE[String(snowflType || "").trim().toLowerCase()];
    if (prior) category = prior;
  }

  if (!category) {
    return { category: null, label: null, path: null, confident: false };
  }

  const label = LABEL_BY_CATEGORY[category];
  return { category, label, path: MEDIA_PATHS[label], confident: true };
}

// Best-effort human-readable name from a magnet link (dn= param) or a .torrent
// URL, so the manual-magnet box and pasted links can be classified too.
function nameFromMagnet(magnetOrUrl = "") {
  const s = String(magnetOrUrl || "");
  const dn = s.match(/[?&]dn=([^&]+)/i);
  if (dn) {
    try {
      return decodeURIComponent(dn[1].replace(/\+/g, " "));
    } catch (e) {
      return dn[1];
    }
  }
  if (/^https?:/i.test(s)) {
    try {
      const u = new URL(s);
      const base = decodeURIComponent(u.pathname.split("/").pop() || "");
      return base.replace(/\.torrent$/i, "");
    } catch (e) {
      return "";
    }
  }
  return "";
}

module.exports = { MEDIA_PATHS, ALLOWED_SAVE_PATHS, classifyMedia, nameFromMagnet };
