// Thin client for Snowfl (snowfl.com torrent meta-search) via the unofficial
// snowfl-api package. Snowfl needs no configuration — it's the always-on
// fallback search source. Result aggregation, fuzzy ranking, and table
// rendering all live in search.js.
//
// https://www.npmjs.com/package/snowfl-api
const { Snowfl, Sort } = require("snowfl-api");

const snowfl = new Snowfl();
const searchConfig = {
  sort: Sort.MAX_SEED,
  includeNsfw: false,
};

function isConfigured() {
  return true;
}

// Returns Snowfl's raw result objects. Each has: name, magnet, url, size,
// seeder, leecher, type, site, age, trusted, nsfw — the shape search.js and
// prowlarr.js both standardize on.
async function search(query) {
  const res = await snowfl.parse(query, searchConfig);
  return Array.isArray(res?.data) ? res.data : [];
}

module.exports = { isConfigured, search };
