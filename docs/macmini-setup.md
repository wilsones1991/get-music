# Setup guide

This app is split across two machines:

- **VPS (Racknerd, via Coolify):** runs this web app. Public HTTPS domain so Google
  OAuth works cleanly.
- **Mac mini:** runs qBittorrent (behind Mullvad) and Jellyfin, and holds the hard drive.

The web app talks to the Mac mini's qBittorrent + Jellyfin **over your existing WireGuard
tunnel**. Torrent traffic itself goes out through Mullvad.

```
[Browser] --HTTPS--> [Coolify/VPS: this app] --WireGuard--> [Mac mini]
                                                              ├─ qBittorrent (Docker, via gluetun/Mullvad) → hard drive
                                                              └─ Jellyfin
```

---

## As-built status (Mac mini) — DONE

The Mac mini half is set up and verified:
- **Colima** (Docker runtime) installed via Homebrew; the drive is shared into the VM by
  mounting `/Volumes` (mounting `/Volumes/Mac Seagate` directly fails — virtiofs chokes on
  the space in the name). Home dir `~/qbt-vpn` is also shared.
- **Live stack** lives at `~/qbt-vpn/docker-compose.yml` (real Mullvad key — kept OUT of
  git). gluetun (Mullvad, San Jose CA) + qBittorrent sharing its network.
- **qBittorrent Web UI**: host port **8090** (8080 was already taken by another service on
  the mini). Credentials in `~/qbt-vpn/qbt-credentials.txt`. CSRF/host-header validation
  disabled (LAN/WireGuard-only), incomplete downloads → `/incomplete`, downloads land in
  the existing `jellyfin-movies` / `-tv` / `-music` roots.
- **Killswitch verified**: your real home IP differs from qBittorrent's egress (which is a
  Mullvad address); with gluetun stopped, qBittorrent has no connectivity (no leak).

**Still to do:** Jellyfin API key (§3), Google OAuth (§4), Coolify deploy (§5), and
boot-persistence (below). gluetun's control server requires auth now — the
`~/qbt-vpn/gluetun-auth/config.toml` opens just the read-only publicip route for the app's
VPN-status check.

### Boot persistence (recommended)
Containers use `restart: unless-stopped`, but **Colima does not auto-start on reboot** by
default. To survive a mini reboot, set Colima to start on login (e.g. a LaunchAgent running
`colima start`, or `brew services`-style wrapper). Until then, after a reboot run
`colima start` once and the stack comes back on its own.

---

## 1. Mac mini: qBittorrent + Mullvad (Docker) — reference

1. **Install Docker** if needed. Check with `docker info`. If missing, the lightest option
   is Colima: `brew install colima docker && colima start`. (Docker Desktop also works.)
2. Copy `docs/docker-compose.yml` somewhere on the Mac mini and fill in:
   - Mullvad WireGuard private key + address (from
     https://mullvad.net/account/wireguard-config).
   - `PUID`/`PGID` → run `id -u` and `id -g`.
   - The drive mount: replace `/Volumes/YOUR_DRIVE/media` with your actual drive path.
3. `docker compose up -d`. qBittorrent's Web UI is now at `http://<mac-mini-ip>:8080`
   (default login `admin` / `adminadmin` — change it immediately and set the same
   credentials in the app's `QBITTORRENT_USER`/`QBITTORRENT_PASS`).
4. In qBittorrent, confirm the default save path is under `/downloads` so it lands on your
   drive. The subfolders (`/downloads/movies`, etc.) match the `MEDIA_*` env vars.

### Verify the killswitch / no leaks
- `docker exec gluetun wget -qO- https://ipinfo.io/ip` → should print a **Mullvad** IP,
  not your home IP.
- Stop gluetun (`docker stop gluetun`) → qBittorrent loses all connectivity (proof that
  torrents can never use your real IP). Start it again with `docker start gluetun`.

---

## 2. WireGuard reachability (VPS → Mac mini)

The VPS must be a WireGuard peer that can reach the Mac mini's WG IP. From the VPS:

```
curl http://<mac-mini-wg-ip>:8080        # qBittorrent Web UI
curl http://<mac-mini-wg-ip>:8000/v1/publicip/ip   # gluetun control (VPN status)
curl http://<mac-mini-wg-ip>:8096/System/Info/Public   # Jellyfin
```

Use these WG IPs in the app's `QBITTORRENT_URL`, `GLUETUN_CONTROL_URL`, `JELLYFIN_URL`.

> **Container networking note:** the Coolify app runs in a Docker container on the VPS. It
> must be able to route to the Mac mini's WireGuard IP. Easiest options: run WireGuard on
> the VPS host and start the app container with host networking, or add a route so the WG
> subnet is reachable from inside the container.

---

## 3. Jellyfin API key

Jellyfin → Dashboard → API Keys → create one → put it in `JELLYFIN_API_KEY`. The app calls
`POST {JELLYFIN_URL}/Library/Refresh` after each download so new media appears quickly.

---

## 4. Google OAuth credentials

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** →
   *Web application*.
2. Authorized redirect URI: `https://<your-domain>/auth/google/callback`
   (must match `BASE_URL` + `/auth/google/callback`).
3. Configure the OAuth consent screen (External; add yourself + your wife as test users, or
   publish it).
4. Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

---

## 5. Deploy on Coolify (VPS)

1. New resource → from this Git repo. Coolify builds the included `Dockerfile`.
2. Set all env vars from `.env.example` (real values). Make sure `BASE_URL` is your public
   HTTPS domain and `NODE_ENV=production`.
3. Add a **persistent volume** mounted at `/data` (matches `DATA_DIR`) so `users.json` and
   sessions survive redeploys.
4. Point your domain at the Coolify service and let it issue TLS.
5. Visit the site → you should be redirected to Google sign-in. The email(s) in
   `ADMIN_EMAILS` get in as admins; add everyone else from the **/admin** page.

---

## Access control model

- `ADMIN_EMAILS` (env): bootstrap admins. Always allowed, always admin, can't be removed in
  the UI — your safety net.
- Everyone else lives in `users.json` (on the `/data` volume) and is managed from `/admin`:
  add an email, toggle admin, or remove. Non-allowlisted Google logins see an
  "access pending" page.
