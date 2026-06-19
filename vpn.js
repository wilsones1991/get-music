// Queries gluetun's control server to confirm the Mullvad tunnel is up.
// Used both for the UI badge and to gate downloads (defense in depth on top of
// gluetun's own killswitch).
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const BASE = (process.env.GLUETUN_CONTROL_URL || "").replace(/\/+$/, "");

// Returns { configured, active, ip, country }. When the control URL isn't set we
// report configured:false so the app can choose not to block downloads.
async function getStatus() {
  if (!BASE) return { configured: false, active: false };
  try {
    const res = await fetch(`${BASE}/v1/publicip/ip`);
    if (!res.ok) return { configured: true, active: false };
    const data = await res.json();
    const ip = data.public_ip || data.ip || null;
    return {
      configured: true,
      active: Boolean(ip),
      ip,
      country: data.country || null,
    };
  } catch {
    return { configured: true, active: false };
  }
}

module.exports = { getStatus };
