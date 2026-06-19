# get-music

A small web app to search torrent aggregators (YTS, Snowfl) and send downloads to
**qBittorrent**, plus **paste a YouTube (or other) link** to grab it as MP3 or video (via
self-hosted **MeTube**), with **Google SSO** + an admin-managed email allowlist, and an
automatic **Jellyfin** library refresh after each download.

## Architecture

```
[Browser] --HTTPS--> [Coolify/VPS: this app] --WireGuard--> [Mac mini]
                                                              ├─ qBittorrent (Docker, via gluetun/Mullvad) → hard drive
                                                              ├─ MeTube (Docker, yt-dlp; normal connection) → hard drive
                                                              └─ Jellyfin
```

- The web app runs on a VPS (Coolify) behind a public HTTPS domain so Google OAuth works.
- qBittorrent + Jellyfin + the hard drive live on the Mac mini, reached over WireGuard.
- All torrent traffic on the Mac mini is forced through Mullvad (gluetun killswitch); the
  app refuses to submit downloads if the VPN reports down.

## Setup

The **Mac mini half** (qBittorrent + Mullvad, WireGuard, Jellyfin API key) is documented in
**[docs/macmini-setup.md](docs/macmini-setup.md)**. The **VPS deploy half** (Google OAuth +
Coolify) is below under [Deploying to the VPS](#deploying-to-the-vps-coolify). Configuration
is via env vars — see `.env.example`.

## Deploying to the VPS (Coolify)

The live deploy runs on Coolify at `https://get-media.eric-wilson.net`, building this repo's
`Dockerfile` from `master`. Things learned the hard way — check these before/after a deploy:

**Coolify resource**
- Build pack: **Dockerfile** (not Nixpacks). Branch: `master`.
- **Ports Exposes: `5000`** (matches `EXPOSE`/`PORT`). The app binds `0.0.0.0:5000`.
- **Domain**: set `https://get-media.eric-wilson.net`; Coolify issues Let's Encrypt TLS.
  DNS must already point at the VPS or cert issuance fails.
- **Persistent volume** mounted at **`/data`** (matches `DATA_DIR`). Leave the source path
  blank → Coolify manages a named volume. This holds `users.json` + sessions; without it,
  every redeploy wipes the allowlist and logs everyone out.

**Env vars** (set in Coolify; see `.env.example` for the full list). Deploy-critical ones:
- `BASE_URL=https://get-media.eric-wilson.net` — must exactly equal the served origin.
- `NODE_ENV=production` — **required**: it turns on `secure` session cookies. Without it,
  login silently fails to persist behind HTTPS. (`trust proxy` is already set in code for
  Coolify's TLS-terminating reverse proxy.)
- `DATA_DIR=/data`, plus the mini service URLs (`QBITTORRENT_URL=http://10.8.0.2:8090`,
  `GLUETUN_CONTROL_URL=http://10.8.0.2:8000`, `JELLYFIN_URL=http://10.8.0.2:8096`) and their
  secrets. Generate a **fresh** `SESSION_SECRET` for prod.

**Google OAuth**
- Authorized redirect URI must be exactly `BASE_URL` + `/auth/google/callback`.
- The app only requests `profile`/`email` (non-sensitive) scopes, so **publishing the
  consent screen needs no Google verification**. Publish it, or add each user as a test user.
- The app's own allowlist (`ADMIN_EMAILS` + `/admin`) is the real gate, not Google.

**Container → Mac mini networking (the thing most likely to break)**
- The app container must reach the mini's WireGuard IP `10.8.0.2`. The VPS must be a WG peer
  and the container must route to the WG subnet.
- `node:20-alpine` has **no `curl`** — verify from inside the container with `wget`:
  ```
  wget -qO- http://10.8.0.2:8096/System/Info/Public   # Jellyfin → JSON
  wget -qO- http://10.8.0.2:8000/v1/publicip/ip        # gluetun → JSON with public_ip
  wget -qO- http://10.8.0.2:8090/api/v2/app/version    # qBittorrent → 403 = alive (not an error)
  ```
  Login works over plain outbound HTTPS, so the app can load fine while the tunnel is broken —
  only VPN status, downloads, and Jellyfin refresh fail. A timeout/"bad address" here (not a
  403) means fix the WG routing/firewall (or use host networking).

### Gotchas (already handled in code)
- **qBittorrent v5 session cookie**: v5.2.2 names the auth cookie `QBT_SID_<internal-port>`
  (e.g. `QBT_SID_8080`), not `SID`. `qbittorrent.js` captures the whole `NAME=VALUE` pair so
  both legacy `SID` and v5 work. A `SID`-only parser fails login → every add/status call dies
  silently.
- qBittorrent v5 returns HTTP 204 (empty body) on login; CSRF/host-header validation are
  disabled (LAN/WireGuard-only), so a `Referer` header is enough.

## Local development

Requires Node 20. Copy `.env.example` to `.env`, fill in values (you can point at a local
qBittorrent and leave `GLUETUN_CONTROL_URL` unset to skip the VPN gate), then:

```
npm install
npm run dev
```

## Access control

- `ADMIN_EMAILS` (env): bootstrap admins — always allowed, can't be removed in the UI.
- Everyone else is managed from `/admin` and stored in `users.json` on the `DATA_DIR`
  volume. Non-allowlisted Google logins see an "access pending" page.

## Todo

```
[x] qBittorrent backend (replaces RuTorrent)
[x] Google SSO + admin email allowlist
[x] Jellyfin library refresh after download
[x] Mullvad VPN killswitch + in-app VPN status / download gating
[ ] add delete button to ui
```
