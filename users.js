// Email allowlist store, backed by a JSON file on a persistent disk.
// Bootstrap admins come from the ADMIN_EMAILS env var and cannot be removed or
// demoted from the UI, so you can never lock yourself out.
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

const BOOTSTRAP_ADMINS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const norm = (email) => (email || "").trim().toLowerCase();
const isBootstrapAdmin = (email) => BOOTSTRAP_ADMINS.includes(norm(email));

function load() {
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) return { users: [] };
    return data;
  } catch {
    return { users: [] };
  }
}

function save(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// Ensure every bootstrap admin exists in the file as an admin. Called at startup.
function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = load();
  let changed = false;
  for (const email of BOOTSTRAP_ADMINS) {
    const existing = data.users.find((u) => norm(u.email) === email);
    if (!existing) {
      data.users.push({
        email,
        isAdmin: true,
        addedBy: "ADMIN_EMAILS",
        addedAt: new Date().toISOString(),
      });
      changed = true;
    } else if (!existing.isAdmin) {
      existing.isAdmin = true;
      changed = true;
    }
  }
  if (changed) save(data);
  return data;
}

function listUsers() {
  return load().users.map((u) => ({
    ...u,
    isAdmin: u.isAdmin || isBootstrapAdmin(u.email),
    protected: isBootstrapAdmin(u.email),
  }));
}

function isAllowed(email) {
  const e = norm(email);
  if (!e) return false;
  if (isBootstrapAdmin(e)) return true;
  return load().users.some((u) => norm(u.email) === e);
}

function isAdmin(email) {
  const e = norm(email);
  if (!e) return false;
  if (isBootstrapAdmin(e)) return true;
  const user = load().users.find((u) => norm(u.email) === e);
  return Boolean(user && user.isAdmin);
}

function addUser(email, { isAdmin = false, addedBy = null } = {}) {
  const e = norm(email);
  if (!e || !e.includes("@")) throw new Error("Invalid email address");
  const data = load();
  if (data.users.some((u) => norm(u.email) === e)) {
    throw new Error("User already exists");
  }
  data.users.push({
    email: e,
    isAdmin: Boolean(isAdmin),
    addedBy: addedBy ? norm(addedBy) : null,
    addedAt: new Date().toISOString(),
  });
  save(data);
  return listUsers();
}

function removeUser(email) {
  const e = norm(email);
  if (isBootstrapAdmin(e)) throw new Error("Cannot remove a bootstrap admin");
  const data = load();
  const before = data.users.length;
  data.users = data.users.filter((u) => norm(u.email) !== e);
  if (data.users.length === before) throw new Error("User not found");
  save(data);
  return listUsers();
}

function setAdmin(email, makeAdmin) {
  const e = norm(email);
  if (isBootstrapAdmin(e) && !makeAdmin) {
    throw new Error("Cannot demote a bootstrap admin");
  }
  const data = load();
  const user = data.users.find((u) => norm(u.email) === e);
  if (!user) throw new Error("User not found");
  user.isAdmin = Boolean(makeAdmin);
  save(data);
  return listUsers();
}

module.exports = {
  init,
  listUsers,
  isAllowed,
  isAdmin,
  addUser,
  removeUser,
  setAdmin,
};
