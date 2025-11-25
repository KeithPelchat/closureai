require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const https = require("https");

const APP_CONFIG = require("./config/appConfig");
const PROMPTS_CONFIG = require("./config/promptsConfig");
const STRIPE_CONFIG = require("./config/stripeConfig");
const UI_CONFIG = require("./config/uiConfig");



const db = require("./db");
const { sendMagicLinkEmail } = require("./email/sesEmail");
const stripe = require("stripe")(STRIPE_CONFIG.secretKey || "");
if (!STRIPE_CONFIG.secretKey) {
  console.warn(
    "[Stripe] STRIPE_SECRET_KEY is not set. Stripe-related routes will fail until configured."
  );
}



// OpenAI client (v4+ style)
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

// ---------------------------------------------------------------------
// Static assets (logo, favicons, OG images, etc.)
// ---------------------------------------------------------------------
app.use("/assets", express.static(path.join(__dirname, "assets")));

// ---------------------------------------------------------------------
// Root route → templated default.html (PWA entry shell)
// ---------------------------------------------------------------------
app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "public", "default.html");
  renderHtmlTemplate(res, filePath);
});


// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3200;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";

// ---------------------------------------------------------------------
// CORS (safe for everything, including Stripe)
// ---------------------------------------------------------------------
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || APP_CONFIG.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS: " + origin));
    },
    credentials: true,
  })
);

// =====================================================================
// STRIPE WEBHOOK – must use raw body and be registered BEFORE express.json
// =====================================================================
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_CONFIG.webhookSecret
      );

    } catch (err) {
      console.error("❌ Stripe webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          console.log("✅ Stripe: checkout.session.completed");
          const session = event.data.object;
          await handlePaidUser(session); // grant pass + send secure link
          break;
        }
        default:
          console.log(`ℹ️ Unhandled Stripe event type: ${event.type}`);
      }

      return res.sendStatus(200);
    } catch (err) {
      console.error("❌ Error handling Stripe webhook:", err);
      return res.status(500).send("Webhook handler error");
    }
  }
);

// ---------------------------------------------------------------------
// Global middleware for everything else
// ---------------------------------------------------------------------
app.use(express.json());
app.use(cookieParser());

// Serve static assets (CSS/JS/images)
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function normalizeEmail(email) {
  return email ? email.trim().toLowerCase() : null;
}

/**
 * Compute the Holiday Pass expiry date.
 *
 * Fixed model: everyone’s pass expires on **January 3rd** at 23:59:59 UTC
 * of the *next upcoming* January 3rd.
 */
function getHolidayPassExpiryDate() {
  const now = new Date();

  const nowYear = now.getUTCFullYear();
  const jan3ThisYear = Date.UTC(nowYear, 0, 3, 23, 59, 59); // Jan is month 0
  let targetYear = nowYear;

  if (now.getTime() > jan3ThisYear) {
    // We're past this year's Jan 3 in UTC → move to next year
    targetYear = nowYear + 1;
  }

  return new Date(Date.UTC(targetYear, 0, 3, 23, 59, 59));
}

/**
 * Given a DB user row, determine if the Holiday Pass is active.
 */
function hasActiveHolidayPass(user) {
  if (!user || !user.holiday_pass_expires_at) return false;
  const now = new Date();
  const expires = new Date(user.holiday_pass_expires_at);
  return expires >= now;
}

// ---------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------

async function findOrCreateUser({ email, name, ghlContactId }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email is required to findOrCreateUser");
  }

  const existing = await db.query(
    "SELECT * FROM closureai_users WHERE email = $1",
    [normalizedEmail]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];

    // Keep user info fresh if GHL or Stripe sends updates
    if (name !== user.name || ghlContactId !== user.ghl_contact_id) {
      await db.query(
        "UPDATE closureai_users SET name = $1, ghl_contact_id = $2, updated_at = now() WHERE id = $3",
        [name, ghlContactId, user.id]
      );
      user.name = name;
      user.ghl_contact_id = ghlContactId;
    }

    return user;
  }

  const id = uuidv4();
  const result = await db.query(
    `INSERT INTO closureai_users (id, email, name, ghl_contact_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, normalizedEmail, name, ghlContactId]
  );

  return result.rows[0];
}

async function createMagicLink(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await db.query(
    `INSERT INTO closureai_magic_links (id, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [uuidv4(), userId, token, expires]
  );

  return `${APP_CONFIG.baseUrl}/login/${token}`;
}

// ---------------------------------------------------------------------
// Simple HTML templating helper for views / public shells
// ---------------------------------------------------------------------

function getTemplateTokens(extraTokens = {}) {
  return {
    // Core app tokens (already used in default.html/login.html)
    APP_NAME: APP_CONFIG.appName,
    THEME_COLOR: APP_CONFIG.themeColor,
    APP_ICON_192: APP_CONFIG.appIcon192,
    APP_LOGO: APP_CONFIG.appLogo,
    HOLIDAY_PASS_NAME: APP_CONFIG.holidayPassName,

    // High-level branding
    APP_TAGLINE: UI_CONFIG.app.tagline,
    PRIMARY_CTA_LABEL: UI_CONFIG.app.primaryCtaLabel,

    // Login page copy
    LOGIN_HEADLINE: UI_CONFIG.loginPage.headline,
    LOGIN_SUBHEADLINE: UI_CONFIG.loginPage.subheadline,

    // Dashboard copy
    DASHBOARD_TITLE: UI_CONFIG.dashboardPage.title,
    DASHBOARD_EMPTY_TITLE: UI_CONFIG.dashboardPage.emptyStateTitle,
    DASHBOARD_EMPTY_BODY: UI_CONFIG.dashboardPage.emptyStateBody,

    // Session page copy
    SESSION_TITLE: UI_CONFIG.sessionPage.title,
    SESSION_INTRO: UI_CONFIG.sessionPage.intro,

    // Holiday pass page copy
    HOLIDAY_HEADLINE: UI_CONFIG.holidayPassPage.headline,
    HOLIDAY_SUBHEADLINE: UI_CONFIG.holidayPassPage.subheadline,

    // Allow per-call overrides
    ...extraTokens,
  };
}

function renderHtmlTemplate(res, filePath, extraTokens = {}) {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("Error reading template:", filePath, err);
      return res.status(500).send("Error loading page.");
    }

    const tokens = getTemplateTokens(extraTokens);

    let rendered = html;
    for (const [key, value] of Object.entries(tokens)) {
      const safeVal = value == null ? "" : String(value);
      // Replace all {{KEY}} instances
      const pattern = new RegExp(`{{${key}}}`, "g");
      rendered = rendered.replace(pattern, safeVal);
    }

    res.send(rendered);
  });
}


// ---------------------------------------------------------------------
// Auth middleware (JWT + Holiday Pass enforcement)
// ---------------------------------------------------------------------

async function requireAuth(req, res, next) {
  const token = req.cookies.closureai_auth;

  if (!token) {
    return respondUnauthorized(req, res);
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      "SELECT * FROM closureai_users WHERE id = $1",
      [payload.userId]
    );

    if (result.rows.length === 0) {
      return respondUnauthorized(req, res);
    }

    const user = result.rows[0];
    const passActive = hasActiveHolidayPass(user);

    req.user = user;
    req.holidayPassActive = passActive;
    req.holidayPassExpiresAt = user.holiday_pass_expires_at;

    if (!passActive) {
      return respondHolidayPassExpired(req, res);
    }

    return next();
  } catch (err) {
    console.error("requireAuth error:", err);
    return respondUnauthorized(req, res);
  }
}

function wantsJsonResponse(req) {
  if (req.path.startsWith("/api/")) return true;
  const accept = req.headers.accept || "";
  return accept.includes("application/json");
}

function respondUnauthorized(req, res) {
  if (wantsJsonResponse(req)) {
    return res.status(401).json({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Not authenticated",
    });
  }

  // For normal browser navigation, send them to the login page
  return res.redirect(302, "/login");
}

function respondHolidayPassExpired(req, res) {
  const expiresAt = req.holidayPassExpiresAt;

  if (wantsJsonResponse(req)) {
    return res.status(403).json({
      ok: false,
      code: "HOLIDAY_PASS_EXPIRED",
      message: `Your ${APP_CONFIG.holidayPassName} has expired.`,
      data: {
        holidayPassActive: false,
        holidayPassExpiresAt: expiresAt,
      },
    });
  }

  const expiresText = expiresAt
    ? new Date(expiresAt).toLocaleString()
    : "already";

  return res
    .status(403)
    .send(
      `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${APP_CONFIG.appName} – ${APP_CONFIG.holidayPassName} expired</title>
          <style>
            body {
              margin: 0;
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              background: #020617;
              color: #e2e8f0;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
            }
            .card {
              max-width: 480px;
              padding: 32px 28px;
              border-radius: 24px;
              background: #020617;
              box-shadow: 0 24px 80px rgba(15, 23, 42, 0.9);
              border: 1px solid #1f2937;
            }
            h1 { font-size: 24px; margin-bottom: 12px; }
            p { font-size: 14px; line-height: 1.6; margin: 0 0 10px; }
            a {
              display: inline-block;
              margin-top: 18px;
              padding: 10px 18px;
              border-radius: 999px;
              background: #22c55e;
              color: #020617;
              font-weight: 600;
              font-size: 14px;
              text-decoration: none;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>${APP_CONFIG.holidayPassName} expired</h1>
            <p>Your ${APP_CONFIG.appName} ${APP_CONFIG.holidayPassName} expired ${expiresText}.</p>
            <p>To keep using ${APP_CONFIG.appName}, you’ll need to renew your pass.</p>
            <!-- TODO: Replace with your renewal funnel when ready -->
            <a href="${APP_CONFIG.renewalPath}">Renew ${APP_CONFIG.holidayPassName}</a>
          </div>
        </body>
      </html>
      `
    );
}

// ---------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------

/**
 * Shared helper used by both:
 * - Stripe webhook
 * - /checkout/success (auto-login)
 *
 * It guarantees:
 * - user exists
 * - holiday_pass_expires_at is set/extended
 */
async function ensureUserWithHolidayPassFromSession(session) {
  const email =
    session.customer_details?.email || session.customer_email || null;
  const name = session.customer_details?.name || null;

  if (!email) {
    throw new Error(
      `Stripe session ${session.id} has no email; cannot create user`
    );
  }

  const user = await findOrCreateUser({
    email,
    name,
    ghlContactId: null,
  });

  const expiresAt = getHolidayPassExpiryDate();

  await db.query(
    `UPDATE closureai_users
     SET holiday_pass_expires_at = $1,
         updated_at = now()
     WHERE id = $2`,
    [expiresAt.toISOString(), user.id]
  );

  console.log(
    `🎟️ ${APP_CONFIG.holidayPassName} granted to ${user.email} until ${expiresAt.toISOString()}`
  );

  // Update user object in memory to reflect expiry
  user.holiday_pass_expires_at = expiresAt.toISOString();

  return { user, expiresAt };
}

// Handle a successful paid Stripe checkout in the webhook:
// grant Holiday Pass + send Secure Link email
async function handlePaidUser(session) {
  const { user, expiresAt } = await ensureUserWithHolidayPassFromSession(
    session
  );

  const loginUrl = await createMagicLink(user.id);

  await sendMagicLinkEmail({
    to: user.email,
    name: user.name,
    loginUrl,
  });

  console.log(
    `✨ Secure link sent for Stripe customer: ${user.email} (expires ${expiresAt.toISOString()})`
  );
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", app: APP_CONFIG.appName });
});

// Static informational pages
app.get("/partners", (req, res) => {
  return res.sendFile(path.join(__dirname, "views", "partners.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "terms.html"));
});

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "privacy.html"));
});

app.get("/disclaimer", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "disclaimer.html"));
});

app.get("/coach", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "coach.html"));
});

// Login page → templated login.html
app.get("/login", (req, res) => {
  const filePath = path.join(__dirname, "public", "login.html");
  renderHtmlTemplate(res, filePath);
});


// ---------------------------------------------------------------------
// Auth status & Secure Link auth
// ---------------------------------------------------------------------

// Simple auth status for the default.html shell
app.get("/auth/status", async (req, res) => {
  const token = req.cookies.closureai_auth;

  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      "SELECT id, holiday_pass_expires_at FROM closureai_users WHERE id = $1",
      [payload.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ authenticated: false });
    }

    const user = result.rows[0];
    const holidayPassActive = hasActiveHolidayPass(user);

    return res.json({
      authenticated: true,
      holidayPassActive,
      holidayPassExpiresAt: user.holiday_pass_expires_at,
    });
  } catch (err) {
    return res.json({ authenticated: false });
  }
});

// Request a one-time Secure Link by email
app.post("/auth/secure-link", async (req, res) => {
  try {
    const { email, name } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const user = await findOrCreateUser({
      email,
      name: name || null,
      ghlContactId: null,
    });

    const loginUrl = await createMagicLink(user.id);

    await sendMagicLinkEmail({
      to: user.email,
      name: user.name || user.email,
      loginUrl,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in /auth/secure-link:", err);
    return res
      .status(500)
      .json({ error: "Unable to send Secure Link. Please try again." });
  }
});

// Logout: clear cookie
app.post("/auth/logout", (req, res) => {
  res.clearCookie("closureai_auth");
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Google OAuth login
// ---------------------------------------------------------------------

// Start Google OAuth login
app.get("/auth/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    console.error("[Google OAuth] Missing CLIENT_ID or REDIRECT_URI env");
    return res
      .status(500)
      .send("Google login is not configured. Please try email link instead.");
  }

  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  console.log("[Google OAuth] Redirecting to Google auth:", authUrl.toString());
  return res.redirect(authUrl.toString());
});

// Google OAuth callback (single, de-duplicated implementation)
app.get("/auth/google/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  try {
    if (error) {
      console.error("[Google OAuth] Error from Google:", error, error_description);
      return res
        .status(400)
        .send("Google login was cancelled or failed. Please try again.");
    }

    if (!code) {
      console.error("[Google OAuth] Missing authorization code in callback");
      return res.status(400).send("Missing authorization code from Google.");
    }

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
      console.error("[Google OAuth] Env vars not set");
      return res.status(500).send("Google login is not configured.");
    }

    console.log("[Google OAuth] Exchanging code for tokens...");

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error(
        "[Google OAuth] Token endpoint error:",
        tokenRes.status,
        text
      );
      return res
        .status(500)
        .send("Error talking to Google. Please try again or use email link.");
    }

    const tokenData = await tokenRes.json();
    const idToken = tokenData.id_token;

    if (!idToken) {
      console.error("[Google OAuth] No id_token in token response:", tokenData);
      return res
        .status(500)
        .send("Google did not return an ID token. Please try again.");
    }

    // Decode ID token payload (NOT verifying signature here; could be added later)
    const parts = idToken.split(".");
    if (parts.length < 2) {
      console.error("[Google OAuth] Malformed ID token:", idToken);
      return res.status(500).send("Malformed ID token from Google.");
    }

    const payloadJson = Buffer.from(parts[1], "base64").toString("utf8");
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (parseErr) {
      console.error("[Google OAuth] Failed to parse ID token payload:", parseErr);
      return res.status(500).send("Could not parse Google ID token.");
    }

    const email = payload.email;
    const name = payload.name || payload.given_name || null;

    if (!email) {
      console.error("[Google OAuth] No email in ID token payload:", payload);
      return res
        .status(500)
        .send("Google account did not include an email address.");
    }

    console.log("[Google OAuth] Authenticated Google user:", email);

    // Re-use your existing findOrCreateUser helper
    const user = await findOrCreateUser({
      email,
      name,
      ghlContactId: null,
    });

    // Issue the same JWT you use elsewhere
    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.cookie("closureai_auth", jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    console.log(
      "[Google OAuth] Login complete for",
      email,
      "→ redirecting to /"
    );

    // Important: always send a response from here
    return res.redirect("/");
  } catch (err) {
    console.error("[Google OAuth] Unexpected error in callback:", err);
    // Always return *something* so the process doesn't crash
    return res
      .status(500)
      .send("Google login failed unexpectedly. Please try again.");
  }
});

// ---------------------------------------------------------------------
// Legacy + existing auth flows
// ---------------------------------------------------------------------

// GHL webhook: create user + magic link (legacy support)
app.post("/ghl/new-user", async (req, res) => {
  try {
    const { email, name, contactId } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const user = await findOrCreateUser({
      email,
      name: name || null,
      ghlContactId: contactId || null,
    });

    const loginUrl = await createMagicLink(user.id);

    return res.json({ success: true, loginUrl });
  } catch (err) {
    console.error("Error in /ghl/new-user:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Magic link login
app.get("/login/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const result = await db.query(
      `SELECT ml.*, u.id AS user_id
       FROM closureai_magic_links ml
       JOIN closureai_users u ON u.id = ml.user_id
       WHERE ml.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired link.");
    }

    const row = result.rows[0];

    if (row.used_at) {
      console.log("Magic link already used:", token);
      // Still allow login within expiry for now
    }

    const now = new Date();
    if (now > row.expires_at) {
      return res.status(400).send("This link has expired.");
    }

    await db.query(
      "UPDATE closureai_magic_links SET used_at = now() WHERE id = $1",
      [row.id]
    );

    // 🔐 30-day session to match the Holiday Pass window
    const jwtToken = jwt.sign({ userId: row.user_id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.cookie("closureai_auth", jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.redirect("/");
  } catch (err) {
    console.error("Error in /login/:token:", err);
    return res.status(500).send("Server error");
  }
});

// Success page AFTER auto-login
// Stripe will redirect here with ?session_id=cs_test_...
app.get("/checkout/success", async (req, res) => {
  const { session_id: sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).send("Missing session_id");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const { user } = await ensureUserWithHolidayPassFromSession(session);

    // Issue JWT here as well (auto-login)
    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.cookie("closureai_auth", jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // Optional: you can render a nice page; for now just redirect
    return res.redirect("/d");
  } catch (err) {
    console.error("Error in /checkout/success:", err);
    return res
      .status(500)
      .send("Error completing purchase. Please check your email for access.");
  }
});

// Legacy success page (if someone hits /success directly)
app.get("/success", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "success.html"));
});

// Cancelled checkout
app.get("/cancelled", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "cancelled.html"));
});

// Dashboard (protected)
app.get("/dashboard", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "views", "dashboard.html");
  renderHtmlTemplate(res, filePath);
});

// Session page (protected)
app.get("/session", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "views", "session.html");
  renderHtmlTemplate(res, filePath);
});

// Holiday pass funnel
app.get("/holiday-pass", (req, res) => {
  const filePath = path.join(__dirname, "views", "holiday-pass.html");
  renderHtmlTemplate(res, filePath);
});

// =========================
// Authenticated JSON API
// =========================

// Get current user info
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, name, ghl_contact_id, created_at, updated_at, holiday_pass_expires_at
       FROM closureai_users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    return res.json({
      // snake_case as in DB
      id: user.id,
      email: user.email,
      name: user.name,
      ghl_contact_id: user.ghl_contact_id,
      created_at: user.created_at,
      updated_at: user.updated_at,
      holiday_pass_expires_at: user.holiday_pass_expires_at,
      holiday_pass_active: req.holidayPassActive,

      // camelCase for frontend convenience
      holidayPassExpiresAt: user.holiday_pass_expires_at,
      holidayPassActive: req.holidayPassActive,
    });
  } catch (err) {
    console.error("Error in /api/me:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// List recent clarity sessions (thread list)
app.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);

    const result = await db.query(
      `
      WITH base AS (
        SELECT
          id,
          user_id,
          COALESCE(thread_id, id) AS thread_key,
          input_prompt,
          created_at,
          turn_index
        FROM closureai_sessions
        WHERE user_id = $1
      ),
      per_thread AS (
        SELECT
          thread_key,
          MIN(created_at) AS started_at,
          MAX(created_at) AS last_updated_at,
          MAX(
            CASE
              WHEN turn_index IS NULL OR turn_index = 0 THEN input_prompt
              ELSE NULL
            END
          ) AS first_user_message
        FROM base
        GROUP BY thread_key
      )
      SELECT
        thread_key,
        started_at,
        last_updated_at,
        first_user_message
      FROM per_thread
      ORDER BY last_updated_at DESC
      LIMIT $2
      `,
      [req.user.id, limit]
    );

    function makeTitle(text) {
      if (!text) return "Clarity session";
      let t = String(text).replace(/\s+/g, " ").trim();
      if (!t) return "Clarity session";
      if (t.length > 140) t = t.slice(0, 137) + "…";
      return t;
    }

    const threads = result.rows.map((row) => ({
      threadId: row.thread_key,
      startedAt: row.started_at,
      lastUpdatedAt: row.last_updated_at,
      title: makeTitle(row.first_user_message),
    }));

    return res.json(threads);
  } catch (err) {
    console.error("Error in GET /api/sessions:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get full conversation for a given thread
app.get("/api/threads/:threadId", requireAuth, async (req, res) => {
  try {
    const { threadId } = req.params;

    const result = await db.query(
      `
      SELECT
        id,
        thread_id,
        input_prompt,
        cleaned_output,
        raw_output,
        created_at,
        turn_index
      FROM closureai_sessions
      WHERE user_id = $1
        AND thread_id = $2
      ORDER BY turn_index ASC, created_at ASC
      `,
      [req.user.id, threadId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const messages = result.rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      inputPrompt: row.input_prompt || "",
      cleanedOutput: row.cleaned_output || "",
      rawOutput: row.raw_output || "",
      createdAt: row.created_at,
      turnIndex: row.turn_index,
    }));

    return res.json({ threadId, messages });
  } catch (err) {
    console.error("Error in GET /api/threads/:threadId:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------------------------------------------------------------
// OpenAI helper
// ---------------------------------------------------------------------

function countAssistantTurns(history) {
  return (history || []).filter((m) => m.role === "assistant").length;
}

async function callOpenAIForClosure(conversationMessages, assistantTurnsParam) {
  const history = Array.isArray(conversationMessages)
    ? conversationMessages
    : [];

  const assistantTurns =
    typeof assistantTurnsParam === "number"
      ? assistantTurnsParam
      : countAssistantTurns(history);

  const maxTurns = PROMPTS_CONFIG.maxAssistantTurns || 8;
  const isWrapUpTurn = assistantTurns >= maxTurns - 1;

  let systemPrompt = PROMPTS_CONFIG.systemPrompt;

  if (isWrapUpTurn) {
    systemPrompt += `
    
SESSION WRAP-UP MODE (IMPORTANT):

You have already responded to this user several times in this session.
In THIS response, gently bring the conversation to a natural stopping point.

Do:
- Give a short, structured recap of what you've heard and what matters most to them.
- Highlight 1–3 concrete things they can remember or try next (small, doable steps).
- Offer 1 very small closing reflection question like:
    "What feels most important to remember from this conversation?"
  or
    "What feels a little lighter or clearer right now?"

Do NOT:
- Open new big lines of inquiry.
- Ask more than ONE small closing question.
- Encourage them to keep digging tonight.

Sound warm and encouraging, and make it clear this is a good place to pause.
`;
  }

  const messages = [{ role: "system", content: systemPrompt }, ...history];

  const completion = await openai.chat.completions.create({
    model: PROMPTS_CONFIG.model || "gpt-4.1-mini",
    messages,
    temperature: 0.7,
    max_tokens: 800,
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ---------------------------------------------------------------------
// Run Closure protocol + save message in a thread
// ---------------------------------------------------------------------
app.post("/api/ai/closure", requireAuth, async (req, res) => {
  try {
    const { narrative, messages, threadId } = req.body || {};

    let conversationMessages = null;

    if (Array.isArray(messages) && messages.length > 0) {
      conversationMessages = messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").trim(),
      }));
    } else if (typeof narrative === "string" && narrative.trim()) {
      conversationMessages = [{ role: "user", content: narrative.trim() }];
    }

    if (!conversationMessages || conversationMessages.length === 0) {
      return res.status(400).json({
        error: "Either narrative or messages[] is required",
      });
    }

    const assistantTurns = conversationMessages.filter(
      (m) => m.role === "assistant"
    ).length;

    const assistantReply = await callOpenAIForClosure(
      conversationMessages,
      assistantTurns
    );

    const newId = uuidv4();
    const effectiveThreadId = threadId || newId;

    const inputPrompt =
      typeof narrative === "string" && narrative.trim()
        ? narrative.trim()
        : conversationMessages[conversationMessages.length - 1].content;

    const rawOutput = assistantReply;
    const cleanedOutput = assistantReply;
    const parsed = null;

    await db.query(
      `INSERT INTO closureai_sessions (
         id,
         user_id,
         thread_id,
         turn_index,
         input_prompt,
         raw_output,
         cleaned_output
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId,
        req.user.id,
        effectiveThreadId,
        assistantTurns,
        inputPrompt,
        rawOutput,
        cleanedOutput,
      ]
    );

    return res.json({
      success: true,
      sessionId: newId,
      threadId: effectiveThreadId,
      rawOutput,
      cleanedOutput,
      parsed,
    });
  } catch (err) {
    console.error("Error in /api/ai/closure:", err);
    return res.status(500).json({
      error: "Problem generating closure. Please try again.",
    });
  }
});

// ---- SES test route ----
app.get("/test/email", async (req, res) => {
  const to = req.query.to || process.env.TEST_EMAIL_TO;

  if (!to) {
    return res
      .status(400)
      .send(
        "Provide ?to=someone@example.com or set TEST_EMAIL_TO in .env"
      );
  }

  try {
    const loginUrl = `${APP_CONFIG.baseUrl}/login/test-magic-link`;

    await sendMagicLinkEmail({
      to,
      name: "ClosureAI Tester",
      loginUrl,
    });

    res.send(`Test email sent to ${to}`);
  } catch (err) {
    console.error("Error sending test SES email:", err);
    res.status(500).send("Failed to send test email");
  }
});

// ---- Stripe: Create Checkout Session ----
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

        const session = await stripe.checkout.sessions.create({
          mode: STRIPE_CONFIG.mode,
          payment_method_types: ["card"],
          customer_email: normalizeEmail(email),
          line_items: [
            {
              price: STRIPE_CONFIG.priceId,
              quantity: 1,
            },
          ],
          allow_promotion_codes: STRIPE_CONFIG.allowPromotionCodes,
          success_url: STRIPE_CONFIG.getSuccessUrl(),
          cancel_url: STRIPE_CONFIG.getCancelUrl(),
        });


    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res
      .status(500)
      .json({ error: "Unable to create checkout session" });
  }
});

// ---------------------------------------------------------------------
// Catch-all 404
// ---------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  return res.status(404).send("Not found");
});

// ---- Server start ----
app.listen(PORT, () => {
  console.log(`${APP_CONFIG.appName} API running on port ${PORT}`);
});