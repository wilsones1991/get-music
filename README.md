# get-music

A small web app to search torrent aggregators (YTS, Snowfl) and send downloads to
**qBittorrent**, with **Google SSO** + an admin-managed email allowlist, and an automatic
**Jellyfin** library refresh after each download.

## Architecture

```
[Browser] --HTTPS--> [Coolify/VPS: this app] --WireGuard--> [Mac mini]
                                                              ├─ qBittorrent (Docker, via gluetun/Mullvad) → hard drive
                                                              └─ Jellyfin
```

- The web app runs on a VPS (Coolify) behind a public HTTPS domain so Google OAuth works.
- qBittorrent + Jellyfin + the hard drive live on the Mac mini, reached over WireGuard.
- All torrent traffic on the Mac mini is forced through Mullvad (gluetun killswitch); the
  app refuses to submit downloads if the VPN reports down.

## Setup

See **[docs/macmini-setup.md](docs/macmini-setup.md)** for the full walkthrough
(qBittorrent + Mullvad on the Mac mini, WireGuard, Jellyfin API key, Google OAuth, and
Coolify deploy). Configuration is via env vars — see `.env.example`.

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
