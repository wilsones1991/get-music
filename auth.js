// Google SSO via Passport + an admin-managed email allowlist.
// Exposes a router (login / OAuth / logout / whoami) and route guards.
const express = require("express");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const users = require("./users");

const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const configured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && BASE_URL);

if (configured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`,
      },
      (accessToken, refreshToken, profile, done) => {
        const email = profile.emails && profile.emails[0] && profile.emails[0].value;
        if (!email) return done(null, false);
        // We allow the login to complete here and enforce the allowlist in the
        // callback route, so unapproved users get a clear "access pending" page.
        return done(null, { email: email.toLowerCase(), name: profile.displayName });
      }
    )
  );
} else {
  console.warn(
    "Google SSO not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / BASE_URL); login will be unavailable"
  );
}

// Only the email is persisted in the session; admin status is resolved live so
// allowlist changes take effect without re-login.
passport.serializeUser((user, done) => done(null, user.email));
passport.deserializeUser((email, done) => done(null, { email }));

function page(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="/github-markdown.css"><title>${title}</title>
<style>body{max-width:680px;margin:48px auto;padding:0 16px;font-family:system-ui,sans-serif}
.btn{display:inline-block;background:#1a73e8;color:#fff;font-weight:bold;text-decoration:none;
padding:12px 20px;border-radius:6px;font-size:18px}</style></head><body>${bodyHtml}</body></html>`;
}

const loginPage = () =>
  page(
    "Sign in",
    `<h2>get-music</h2><p>Please sign in to continue.</p>
     <p><a class="btn" href="/auth/google">Sign in with Google</a></p>`
  );

const pendingPage = (email) =>
  page(
    "Access pending",
    `<h2>Access pending</h2>
     <p>You're signed in as <strong>${email}</strong>, but this account isn't on the
     allowed list yet.</p>
     <p>Ask an admin to add your email, then try again.</p>
     <p><a href="/auth/logout">Sign out</a></p>`
  );

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated() && users.isAllowed(req.user.email)) {
    return res.redirect("/");
  }
  res.send(loginPage());
});

router.get(
  "/auth/google",
  (req, res, next) => {
    if (!configured) return res.status(503).send("Google SSO is not configured on the server.");
    next();
  },
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  (req, res) => {
    const email = req.user.email;
    if (!users.isAllowed(email)) {
      return req.logout(() => res.status(403).send(pendingPage(email)));
    }
    res.redirect("/");
  }
);

router.get("/auth/logout", (req, res) => {
  req.logout(() => res.redirect("/login"));
});

router.get("/api/me", (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated() && users.isAllowed(req.user.email)) {
    return res.json({ email: req.user.email, isAdmin: users.isAdmin(req.user.email) });
  }
  res.status(401).json({ error: "not authenticated" });
});

// Redirect unauthenticated/unapproved users to the login page (or 401 for APIs).
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && users.isAllowed(req.user.email)) {
    return next();
  }
  if (req.accepts(["html", "json"]) === "json") {
    return res.status(401).json({ error: "not authenticated" });
  }
  res.redirect("/login");
}

function ensureAdmin(req, res, next) {
  if (
    req.isAuthenticated &&
    req.isAuthenticated() &&
    users.isAllowed(req.user.email) &&
    users.isAdmin(req.user.email)
  ) {
    return next();
  }
  res.status(403).send("Forbidden: admin access required");
}

module.exports = { passport, router, ensureAuth, ensureAdmin, configured };
