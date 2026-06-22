// how to gen columns:
// https://github.com/kleutzinger/age-of-actors-dokku-node/blob/7e4fb38742487325765c94924ca2b33f5aeb897a/static/tablemaker.js#L6
function genColumns() {
  return [
    {
      title: "title",
      field: "title",
      formatter: "textarea",
      cssClass: "titletext",
    },
    { title: "year", field: "year" },
    { title: "runtime", field: "runtime" },
    // { title: "torrents", field: "torrents" },
    { title: "initiate download", field: "download", formatter: "html" },
    {
      title: "image",
      field: "image",
      formatter: "image",
      formatterParams: {
        height: "100px",
      },
    },
    { field: "info", title: "info", formatter: "html" },
  ];
}
function makeTable(data) {
  let table = new Tabulator("#example-table", {
    data: data, //assign data to table
    layout: "fitDataFill",
    columns: genColumns(),
    responsiveLayout: "collapse", // collapse columns that no longer fit on the table into a list under the row
    layoutColumnsOnNewData: true,
    // layout: "fitData",
  });

  return table;
}

function autosubmit(t_url, hash, quality, type, movieTitle, movieUrl) {
  // populate and submit the post request form at the top of the page
  movieTitle = decodeURIComponent(movieTitle);
  movieUrl = decodeURIComponent(movieUrl);
  document.getElementById("magnet").value = t_url;

  // Helper function to create or update hidden input
  function setHiddenInput(id, name, value) {
    let input = document.getElementById(id);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.id = id;
      input.name = name;
      document.getElementById("main-form").appendChild(input);
    }
    input.value = value || "";
  }

  // Set all hidden fields
  setHiddenInput("hash", "hash", hash);
  setHiddenInput("quality", "quality", quality);
  setHiddenInput("type", "type", type);
  setHiddenInput("movieTitle", "movieTitle", movieTitle);
  setHiddenInput("movieUrl", "movieUrl", movieUrl);

  let submit_button = document.querySelector("#submit");
  submit_button.click();
}

function torrent_to_button_html(torrent, movieTitle, movieUrl) {
  // turn a torrent dict into a download button in the table
  const { quality, type, url, hash, size } = torrent;
  const safeTitle = encodeURIComponent(movieTitle);
  const safeMovieUrl = encodeURIComponent(movieUrl);
  return `<button onClick ="autosubmit('${url}', '${hash}', '${quality}', '${type}', '${safeTitle}', '${safeMovieUrl}')">${[quality, type, size].join(
    "<br>",
  )}</button>`;
}

function transform_api_response(api_json) {
  // take the api response (list of movies) and turn it into
  // data that the table can understand nicely
  let movies = api_json.data.movies;
  console.log(api_json);
  if (!movies) {
    return [];
  }
  const isHD = (t) =>
    t["quality"].includes("720") || t["quality"].includes("1080");
  const gen_info = (m) => {
    let source = `<a href="${m.url}">source (yts)</a>`;
    let imdb = `<a href="https://www.imdb.com/title/${m.imdb_code}/">IMDB (${m.rating})</a>`;
    let lbox = `<a href="https://letterboxd.com/imdb/${m.imdb_code}"/>Letterboxd</a>`;

    let runtime = `<span>${m.runtime} minutes</span>`;
    return [runtime, imdb, lbox, source].join("<br>");
  };
  let trimmed = movies.map((m) => {
    let torrents = m.torrents;
    return {
      title: m.title,
      torrents: torrents,
      year: m.year,
      runtime: m.runtime,
      download: torrents.map(t => torrent_to_button_html(t, m.title, m.url)).join(" "),
      image: `/tmdb-poster?imdb_id=${m.imdb_code}`,
      info: gen_info(m),
    };
  });

  return trimmed;
}

async function get_disk_space_from_server() {
  try {
    const endpoint = new URL("/diskspace", window.location.href).href;
    const response = await fetch(endpoint);
    const json = await response.json();
    return json;
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function write_client_url_to_ui() {
  const endpoint = new URL("/client-url", window.location.href).href;
  // fetch endpoint with get request
  let response = await fetch(endpoint);
  let json = await response.json();
  const url = json.url;
  let client_url_div = document.getElementById("client-url");
  if (url) {
    client_url_div.innerHTML = `<a href="${url}">qbittorrent</a>`;
  } else {
    client_url_div.innerHTML = "";
  }
}

async function populate_media_paths() {
  // build the directory dropdown from the server-configured paths
  const endpoint = new URL("/media-paths", window.location.href).href;
  const response = await fetch(endpoint);
  const paths = await response.json();
  const select = document.getElementById("mediatype");
  select.innerHTML = "";
  for (const [label, value] of Object.entries(paths)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }
  // Default to the Music Directory so audio downloads don't silently fall into
  // the Movies folder (the first entry) and miss the Jellyfin music library.
  const musicOption = Array.from(select.options).find(
    (o) => o.textContent === "Music Directory"
  );
  if (musicOption) select.value = musicOption.value;
}

async function populate_user_bar() {
  try {
    const response = await fetch(new URL("/api/me", window.location.href).href);
    if (!response.ok) return;
    const me = await response.json();
    document.getElementById("user-email").textContent = me.email || "";
    if (me.isAdmin) {
      document.getElementById("admin-link").style.display = "inline";
    }
  } catch (e) {
    console.error(e);
  }
}

async function update_vpn_badge() {
  const badge = document.getElementById("vpn-badge");
  try {
    const response = await fetch(new URL("/vpn-status", window.location.href).href);
    const status = await response.json();
    if (!status.configured) {
      badge.className = "vpn-badge vpn-unknown";
      badge.textContent = "VPN: not configured";
    } else if (status.active) {
      badge.className = "vpn-badge vpn-ok";
      badge.textContent = `🔒 VPN active${status.country ? " · " + status.country : ""}`;
    } else {
      badge.className = "vpn-badge vpn-down";
      badge.textContent = "⚠ VPN DOWN — downloads blocked";
    }
  } catch (e) {
    badge.className = "vpn-badge vpn-down";
    badge.textContent = "⚠ VPN status unknown";
  }
}

function set_disk_space_in_ui(json) {
  if (!json) {
    return;
  }
  function formatBytes(a, b = 2) {
    if (!+a) return "0 Bytes";
    const c = 0 > b ? 0 : b,
      d = Math.floor(Math.log(a) / Math.log(1024));
    return `${parseFloat((a / Math.pow(1024, d)).toFixed(c))} ${
      ["Bytes", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"][d]
    }`;
  }
  const { total, free } = json;
  //  add a div to the page with the free space
  let free_space_span = document.getElementById("free-space");
  if (total) {
    const ratio = `${formatBytes(free)} / ${formatBytes(total)}`;
    const percent_full = ((total - free) / total) * 100;
    const percent_full_text = `${percent_full.toFixed(1)}% full`;
    free_space_span.innerHTML = `${ratio} (${percent_full_text})`;
  } else {
    // qBittorrent only reports free space on the download disk
    free_space_span.innerHTML = `${formatBytes(free)} free`;
  }
}

async function search() {
  // search for a movie and write to the table
  let search_query = document.getElementById("search-box").value;
  // return a random page of the results
  let is_rand = search_query === "";

  let api_movie_list = await search_yts(fetch, search_query, is_rand);
  let table = makeTable(transform_api_response(api_movie_list));
}

document.addEventListener("DOMContentLoaded", async function (event) {
  // check if param of ?yts-search=... exists and pre-fill the value
  const url = new URL(window.location.href);
  const search_param = url.searchParams.get("yts-search");
  if (search_param) {
    document.getElementById("search-box").value = search_param;
    // scroll into view
    document.getElementById("search-box").scrollIntoView();
  }
  search();
  // persist label from <select> in localstorage
  let cached_label = localStorage.getItem("label");
  if (cached_label) {
    document.getElementById("label").value = cached_label;
  }

  // set label when the label input changes
  document.getElementById("label").addEventListener("change", (e) => {
    localStorage.setItem("label", e.target.value);
  });

  let hash = window.location.hash;
  if (hash) {
    // set label to whatever the hash is
    // i.e. "kevin"
    document.getElementById("label").value = hash.replace("#", "");
  }
  populate_user_bar();
  update_vpn_badge();
  setInterval(update_vpn_badge, 30000);
  try {
    await populate_media_paths();
  } catch (e) {
    console.error(e);
  }
  try {
    await write_client_url_to_ui();
  } catch (e) {
    console.error(e);
  }
  set_disk_space_in_ui(await get_disk_space_from_server());
});

document.body.addEventListener("htmx:afterRequest", function (evt) {
  const targetError = evt.target.attributes.getNamedItem("hx-target-error");
  if (evt.detail.failed && targetError) {
    document.getElementById(targetError.value).style.display = "inline";
  }
});
document.body.addEventListener("htmx:beforeRequest", function (evt) {
  const targetError = evt.target.attributes.getNamedItem("hx-target-error");
  if (targetError) {
    document.getElementById(targetError.value).style.display = "none";
  }
});
