# Remaining setup — handoff for a fresh agent

This is a continuation checklist. The **Mac mini half is fully built and verified**; what's
left is the **app deploy on the VPS** (Google OAuth + Coolify). Read this top to bottom
before acting — it captures context so you don't re-derive it. Also see
[`macmini-setup.md`](./macmini-setup.md) for the as-built details.

---

## Environment facts (don't re-derive these)

**Two machines:**
- **Mac mini** (this host, `Erics-Mac-mini`): runs qBittorrent (behind Mullvad), Jellyfin,
  and holds the hard drive. WireGuard IP **`10.8.0.2`**, LAN `192.168.50.200`.
- **VPS** (Racknerd, via **Coolify**): where this web app gets deployed. Reaches the mini
  over the existing WireGuard tunnel.

**Services on the mini:**
| Service | Address | Notes |
|---|---|---|
| qBittorrent Web UI | `http://10.8.0.2:8090` | host 8090 → container 8080 (8080 was taken). Creds in `~/qbt-vpn/qbt-credentials.txt`. v5.2.2. |
| gluetun control API | `http://10.8.0.2:8000` | `/v1/publicip/ip` is open (no auth) for the VPN-status check. |
| Jellyfin | `http://10.8.0.2:8096` | native Mac app. API key already set in the local `.env`. |

**Where things live:**
- **Live torrent stack** (real Mullvad key — NOT in git): `~/qbt-vpn/docker-compose.yml`.
  Managed with `docker compose -f ~/qbt-vpn/docker-compose.yml ...`.
- **Boot persistence**: LaunchAgent `com.eric.colima-qbt` runs `~/qbt-vpn/start-stack.sh`
  at login (starts Colima + the stack).
- **Docker runtime**: Colima (Intel mac, vz/virtiofs). The drive is shared into the VM via
  `/Volumes` (mounting the space-containing path directly fails). Downloads go into the
  drive's existing `jellyfin-movies` / `jellyfin-tv` / `jellyfin-music` roots, mapped to
  `/downloads/movies|tvshows|music` in the container; `/downloads/general` and `/incomplete`
  also exist.
- **Local app config**: `/Users/eric-wilson/get-music/.env` (gitignored). Already filled:
  qBittorrent, gluetun, Jellyfin (+ API key), media paths, `SESSION_SECRET`, `ADMIN_EMAILS`.
  Still blank: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TMDB_KEY`; `BASE_URL` is
  `localhost` for local testing.

**Gotcha already fixed:** qBittorrent v5 returns HTTP 204 (empty body) on login; `qbittorrent.js`
handles that. CSRF/host-header validation are disabled on qBittorrent (LAN/WireGuard-only).

**Node is NOT installed on the mini** — you can't `npm start` the app there. Test via the
Coolify Docker build, or install Node if you want to run it locally on the mini.

### Already verified working (do not redo)
- Mullvad killswitch / no IP leak (qBittorrent has no connectivity if the VPN drops).
- qBittorrent add flow (login → add with savepath + category → delete).
- Jellyfin `POST /Library/Refresh` → 204 with the configured API key.
- Boot persistence (LaunchAgent fired through launchd, stack came up).

---

## TODO 1 — Google OAuth client (required for login)

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID →
   Web application**.
2. **Authorized redirect URI**: `https://<your-domain>/auth/google/callback` — must exactly
   equal `BASE_URL` + `/auth/google/callback`.
3. Configure the **OAuth consent screen** (External). Add yourself + your wife as test users,
   or publish the app.
4. Put the client ID/secret into the Coolify env vars (TODO 2) — and into the local `.env`
   if you also want to test locally.

---

## TODO 2 — Deploy on Coolify (VPS)

1. **Source**: create a Coolify resource from this git repo. Either merge
   `feat/jellyfin-qbittorrent-sso` → `master` first, or point Coolify at the feature branch.
   Coolify builds the included `Dockerfile`.
2. **Env vars** (set in Coolify; pull secret values from the mini's `~/qbt-vpn/qbt-credentials.txt`
   and the mini's `.env`):
   ```
   QBITTORRENT_URL=http://10.8.0.2:8090
   QBITTORRENT_USER=admin
   QBITTORRENT_PASS=<from ~/qbt-vpn/qbt-credentials.txt>
   GLUETUN_CONTROL_URL=http://10.8.0.2:8000
   JELLYFIN_URL=http://10.8.0.2:8096
   JELLYFIN_API_KEY=<from mini .env>
   MEDIA_MOVIES=/downloads/movies
   MEDIA_TV=/downloads/tvshows
   MEDIA_MUSIC=/downloads/music
   MEDIA_GENERAL=/downloads/general
   BASE_URL=https://<your-domain>
   GOOGLE_CLIENT_ID=<from TODO 1>
   GOOGLE_CLIENT_SECRET=<from TODO 1>
   SESSION_SECRET=<generate a fresh long random string for prod>
   ADMIN_EMAILS=<your email>,<wife's email>
   DATA_DIR=/data
   NODE_ENV=production
   TMDB_KEY=<optional>
   ```
3. **Persistent volume**: mount one at **`/data`** (matches `DATA_DIR`) so `users.json` and
   sessions survive redeploys.
4. **⚠️ CRITICAL — container → mini networking.** The app container on the VPS must be able to
   reach the mini's WireGuard IP `10.8.0.2`. The VPS needs to be a WireGuard peer **and** the
   container must route to the WG subnet. Options: run the app container with host networking,
   or add a route so the WG subnet is reachable from inside the container. **Verify** from
   inside the deployed container:
   ```
   curl http://10.8.0.2:8090/api/v2/app/version      # qBittorrent (expect 403/Forbidden = alive)
   curl http://10.8.0.2:8000/v1/publicip/ip           # gluetun (expect JSON with public_ip)
   curl http://10.8.0.2:8096/System/Info/Public       # Jellyfin (expect JSON)
   ```
5. Point your domain at the Coolify service and let it issue TLS.

---

## TODO 3 — (optional) TMDB key
For movie posters. Get a key at themoviedb.org and set `TMDB_KEY`.

## TODO 4 — (optional) Auto-login on the mini
Boot persistence works, but the LaunchAgent only fires at **user login**. For hands-off
reboot recovery, enable automatic login (System Settings → Users & Groups → Automatic login).
Needs sudo; FileVault blocks auto-login. If you're OK logging in once after a reboot, skip this.

---

## End-to-end verification (after deploy)

1. Visit `https://<your-domain>` → redirected to Google → sign in with an allowlisted email
   → app loads. A non-allowlisted email should see the **"access pending"** page.
2. Open `/admin` as an admin → add your wife's email → confirm she can log in. Confirm a
   non-admin gets 403 on `/admin`.
3. VPN badge shows **active**. Search (YTS/Snowfl) → submit a download → it appears in
   qBittorrent (`http://10.8.0.2:8090`) downloading into the right folder via the VPN, and
   Jellyfin shows it after the scan.
4. Trigger a Coolify redeploy → confirm `users.json` and your session survive (the `/data`
   volume).

---

## Handy commands (on the mini)
```
docker compose -f ~/qbt-vpn/docker-compose.yml ps          # stack status
docker compose -f ~/qbt-vpn/docker-compose.yml logs -f     # logs
curl -s http://10.8.0.2:8000/v1/publicip/ip                # VPN public IP
cat ~/qbt-vpn/qbt-credentials.txt                          # qBittorrent creds
launchctl list | grep colima-qbt                           # boot agent status
```
