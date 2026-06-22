#!/bin/bash
# Heals the torrent stack after the external download drive briefly
# disconnects. When "/Volumes/Mac Seagate" drops off (sleep, loose cable,
# power blip) macOS re-mounts it automatically, but the already-running
# qbittorrent / metube containers keep a STALE bind mount — inside the
# container the paths read as "Bad file descriptor" and qBittorrent reports
# free_space_on_disk = -1 (the app then showed "NaN undefined free"). The only
# fix is to restart the affected container so Docker re-establishes the mount.
#
# This script detects exactly that condition and restarts only the affected
# containers — and ONLY when the host drive is actually healthy again, so it
# never restart-loops while the drive is genuinely unplugged.
#
# Run on an interval via launchd (com.eric.qbt-disk-watchdog).

export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=/Users/eric-wilson/qbt-vpn/disk-watchdog.log

# Host mount point that backs the bind mounts (its presence proves the drive).
HOST_MOUNT="/Volumes/Mac Seagate"
# Containers that bind-mount the drive, plus an in-container path to probe.
CONTAINERS=("qbittorrent" "metube")
PROBE_PATH="/downloads/music"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

# 1. Is the drive actually mounted on the host? If not, a restart can't help and
#    would just thrash the containers — so bail out quietly.
#
#    We check the mount TABLE, not the drive's contents. Under launchd, macOS
#    TCC denies this agent read access to external-volume *contents* even when
#    the drive is perfectly healthy, so an `ls` here false-negatives on every
#    run and the watchdog never acts. `mount` reads the kernel mount table and
#    isn't subject to TCC, so it reports the truth in both contexts.
if ! /sbin/mount | grep -qF " on ${HOST_MOUNT} "; then
  log "host drive not mounted (${HOST_MOUNT}) — drive disconnected; skipping (restart can't help)"
  exit 0
fi

# 2. For each container, probe its view of the drive. A non-zero exit means the
#    bind mount is stale while the host is healthy -> restart to re-mount.
for c in "${CONTAINERS[@]}"; do
  running=$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)
  if [ "$running" != "true" ]; then
    log "$c not running (state=${running:-absent}) — leaving to compose/launchd"
    continue
  fi

  if docker exec "$c" sh -c "ls '$PROBE_PATH' >/dev/null 2>&1"; then
    continue # healthy
  fi

  log "$c has a STALE mount ($PROBE_PATH unreadable) while host drive is healthy — restarting"
  if docker restart "$c" >/dev/null 2>&1; then
    log "$c restarted OK"
  else
    log "$c restart FAILED"
  fi
done
