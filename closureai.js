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
// Multi-tenant app context
// ---------------------------------------------------------------------
const APP_SLUG = process.env.APP_SLUG || "closureai";
let APP_ID = null;

async function initAppId() {
  const result = await db.query(
    "SELECT id, slug, base_url FROM apps WHERE slug = $1",
    [APP_SLUG]
  );

  if (result.rows.length === 0) {
    throw new Error(`No apps row found for slug=${APP_SLUG}`);
  }

  APP_ID = result.rows[0].id;
  console.log(
    `[CLOSUREAI] Loaded app ${APP_SLUG} with id ${APP_ID} (base_url=${result.rows[0].base_url})`
  );
}

initAppId().catch((err) => {
  console.error("[CLOSUREAI] Failed to initialize APP_ID:", err);
  process.exit(1);
});

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
  if (!APP_ID) {
    throw new Error("APP_ID not initialized");
  }

  const existing = await db.query(
    "SELECT * FROM users WHERE app_id = $1 AND email = $2",
    [APP_ID, normalizedEmail]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];

    if (name !== user.name || ghlContactId !== user.ghl_contact_id) {
      const updated = await db.query(
        `UPDATE users
         SET name = $1,
             ghl_contact_id = $2,
             updated_at = now()
         WHERE id = $3
         RETURNING *`,
        [name, ghlContactId, user.id]
      );
      return updated.rows[0];
    }

    return user;
  }

  const result = await db.query(
    `INSERT INTO users (email, name, ghl_contact_id, app_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [normalizedEmail, name, ghlContactId, APP_ID]
  );

  return result.rows[0];
}

async function createMagicLink(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await db.query(
    `INSERT INTO magic_links (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expires]
  );

  // Use app base URL from config
  const baseUrl = APP_CONFIG.baseUrl || process.env.APP_BASE_URL;
  const loginPath = "/login/" + token;
  const loginUrl = `${baseUrl}${loginPath}`;

  return loginUrl;
}

async function getOffersForApp(appId, options = {}) {
  const { activeOnly = true } = options;

  let query = `
    SELECT
      id,
      title,
      description,
      url,
      offer_type,
      trigger_keywords,
      ai_mention_text,
      display_order,
      is_active,
      show_inline,
      show_at_wrapup,
      show_as_card,
      cta_text
    FROM offers
    WHERE app_id = $1
  `;

  if (activeOnly) {
    query += ` AND is_active = true`;
  }

  query += ` ORDER BY display_order ASC, created_at ASC`;

  const result = await db.query(query, [appId]);
  return result.rows;
}

async function getCoachNameForApp(appId) {
  const result = await db.query(
    `SELECT coach_name, slug FROM apps WHERE id = $1`,
    [appId]
  );

  if (result.rows.length > 0 && result.rows[0].coach_name) {
    return result.rows[0].coach_name;
  }

  return "your coach";
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

    const result = await db.query("SELECT * FROM users WHERE id = $1", [
      payload.userId,
    ]);

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

  return res.status(403).send(`
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
            <a href="${APP_CONFIG.renewalPath}">Renew ${APP_CONFIG.holidayPassName}</a>
          </div>
        </body>
      </html>
      `);
}

// ---------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------

async function requireAdmin(req, res, next) {
  const token = req.cookies.closureai_auth;

  if (!token) {
    return respondUnauthorized(req, res);
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      "SELECT * FROM users WHERE id = $1 AND app_id = $2",
      [payload.userId, APP_ID]
    );

    if (result.rows.length === 0) {
      return respondUnauthorized(req, res);
    }

    const user = result.rows[0];

    // Check admin flag
    if (!user.is_admin) {
      if (wantsJsonResponse(req)) {
        return res.status(403).json({
          ok: false,
          code: "ADMIN_REQUIRED",
          message: "Admin access required",
        });
      }
      return res.status(403).send("Admin access required");
    }

    req.user = user;
    req.holidayPassActive = hasActiveHolidayPass(user);
    req.holidayPassExpiresAt = user.holiday_pass_expires_at;

    return next();
  } catch (err) {
    console.error("requireAdmin error:", err);
    return respondUnauthorized(req, res);
  }
}

// ---------------------------------------------------------------------
// Stripe helpers
// ---------------------------------------------------------------------

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
    `UPDATE users
     SET holiday_pass_expires_at = $1,
         updated_at = now()
     WHERE id = $2`,
    [expiresAt.toISOString(), user.id]
  );

  console.log(
    `🎟️ ${APP_CONFIG.holidayPassName} granted to ${user.email} until ${expiresAt.toISOString()}`
  );

  user.holiday_pass_expires_at = expiresAt.toISOString();

  return { user, expiresAt };
}

async function handlePaidUser(session) {
  const { user, expiresAt } = await ensureUserWithHolidayPassFromSession(
    session
  );

  const loginUrl = await createMagicLink(user.id);

  await sendMagicLinkEmail({
    to: user.email,
    name: user.name || user.email,
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
  res.json({ status: "ok", app: APP_CONFIG.appName, slug: APP_SLUG });
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

app.get("/demo", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "demo.html"));
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
      "SELECT id, holiday_pass_expires_at FROM users WHERE id = $1",
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

// Google OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  try {
    if (error) {
      console.error(
        "[Google OAuth] Error from Google:",
        error,
        error_description
      );
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
      console.error(
        "[Google OAuth] Failed to parse ID token payload:",
        parseErr
      );
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

    const user = await findOrCreateUser({
      email,
      name,
      ghlContactId: null,
    });

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

    return res.redirect("/");
  } catch (err) {
    console.error("[Google OAuth] Unexpected error in callback:", err);
    return res
      .status(500)
      .send("Google login failed unexpectedly. Please try again.");
  }
});

// ---------------------------------------------------------------------
// Legacy + existing auth flows
// ---------------------------------------------------------------------

// GHL webhook: create user + magic link
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
       FROM magic_links ml
       JOIN users u ON u.id = ml.user_id
       WHERE ml.token = $1`,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid or expired link.");
    }

    const row = result.rows[0];

    if (row.used_at) {
      console.log("Magic link already used:", token);
    }

    const now = new Date();
    if (now > row.expires_at) {
      return res.status(400).send("This link has expired.");
    }

    await db.query("UPDATE magic_links SET used_at = now() WHERE id = $1", [
      row.id,
    ]);

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
app.get("/checkout/success", async (req, res) => {
  const { session_id: sessionId } = req.query;

  if (!sessionId) {
    return res.status(400).send("Missing session_id");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const { user } = await ensureUserWithHolidayPassFromSession(session);

    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.cookie("closureai_auth", jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.redirect("/dashboard");
  } catch (err) {
    console.error("Error in /checkout/success:", err);
    return res
      .status(500)
      .send("Error completing purchase. Please check your email for access.");
  }
});

// Legacy success / cancel pages
app.get("/success", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "success.html"));
});

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

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, name, ghl_contact_id, created_at, updated_at, holiday_pass_expires_at, is_admin
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];

    return res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      ghl_contact_id: user.ghl_contact_id,
      created_at: user.created_at,
      updated_at: user.updated_at,
      holiday_pass_expires_at: user.holiday_pass_expires_at,
      holiday_pass_active: req.holidayPassActive,
      holidayPassExpiresAt: user.holiday_pass_expires_at,
      holidayPassActive: req.holidayPassActive,
      isAdmin: user.is_admin || false,
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
        FROM sessions
        WHERE user_id = $1
          AND app_id = $2
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
      LIMIT $3
      `,
      [req.user.id, APP_ID, limit]
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
      FROM sessions
      WHERE user_id = $1
        AND app_id = $2
        AND thread_id = $3
      ORDER BY turn_index ASC, created_at ASC
      `,
      [req.user.id, APP_ID, threadId]
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

async function callOpenAIForClosure(conversationMessages, assistantTurnsParam, offers = [], coachName = "your coach") {
  const history = Array.isArray(conversationMessages)
    ? conversationMessages
    : [];

  const assistantTurns =
    typeof assistantTurnsParam === "number"
      ? assistantTurnsParam
      : countAssistantTurns(history);

  const maxTurns = PROMPTS_CONFIG.maxAssistantTurns || 6;

  // Use the new dynamic prompt builder
  const systemPrompt = PROMPTS_CONFIG.buildSystemPrompt({
    basePrompt: PROMPTS_CONFIG.systemPrompt,
    assistantTurns,
    maxTurns,
    offers,
    coachName,
    isWrapUp: false,
  });

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

    // -----------------------------
    // Build conversation history
    // -----------------------------
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

    // How many assistant turns so far in this thread (for wrap-up logic)
    const assistantTurns = conversationMessages.filter(
      (m) => m.role === "assistant"
    ).length;

    // -----------------------------
    // Fetch offers and coach name for this app
    // -----------------------------
    const offers = await getOffersForApp(APP_ID);
    const coachName = await getCoachNameForApp(APP_ID);

    // -----------------------------
    // Call OpenAI with offer context
    // -----------------------------
    const assistantReply = await callOpenAIForClosure(
      conversationMessages,
      assistantTurns,
      offers,
      coachName
    );

    // If no threadId was provided, this is a brand-new thread
    const effectiveThreadId = threadId || uuidv4();

    // Use the explicit narrative if provided, otherwise last user message
    const inputPrompt =
      typeof narrative === "string" && narrative.trim()
        ? narrative.trim()
        : conversationMessages[conversationMessages.length - 1].content;

    const rawOutput = assistantReply;
    const cleanedOutput = assistantReply;
    const parsed = null;

    // -----------------------------
    // Persist session row
    // -----------------------------
    const sessionId = uuidv4();
    const turnIndex = assistantTurns;

    await db.query(
      `
      INSERT INTO sessions (
        id,
        user_id,
        app_id,
        thread_id,
        turn_index,
        input_prompt,
        raw_output,
        cleaned_output
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        sessionId,
        req.user.id,
        APP_ID,
        effectiveThreadId,
        turnIndex,
        inputPrompt,
        rawOutput,
        cleanedOutput,
      ]
    );

    // -----------------------------
    // Determine if we should return offers for UI card
    // -----------------------------
    const maxTurns = PROMPTS_CONFIG.maxAssistantTurns || 6;
    const isWrapUpTurn = assistantTurns >= maxTurns - 1;

    // Get offers that should show as cards
    const cardOffers = isWrapUpTurn
      ? offers.filter((o) => o.show_as_card && o.is_active)
      : [];

    // -----------------------------
    // Response
    // -----------------------------
    return res.json({
      success: true,
      sessionId,
      threadId: effectiveThreadId,
      rawOutput,
      cleanedOutput,
      parsed,
      turnIndex: assistantTurns + 1,
      isWrapUp: isWrapUpTurn,
      offers: cardOffers.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        url: o.url,
        offerType: o.offer_type,
        ctaText: o.cta_text,
      })),
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
// Offer management API routes
// ---------------------------------------------------------------------

// Get all offers for the current app (admin use)
app.get("/api/offers", requireAuth, async (req, res) => {
  try {
    const offers = await getOffersForApp(APP_ID, { activeOnly: false });
    return res.json({ offers });
  } catch (err) {
    console.error("Error fetching offers:", err);
    return res.status(500).json({ error: "Failed to fetch offers" });
  }
});

// Create a new offer
app.post("/api/offers", requireAuth, async (req, res) => {
  try {
    const {
      title,
      description,
      url,
      offerType = "general",
      triggerKeywords = [],
      aiMentionText,
      displayOrder = 0,
      showInline = true,
      showAtWrapup = true,
      showAsCard = true,
      ctaText = "Learn More",
    } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const result = await db.query(
      `INSERT INTO offers (
        app_id, title, description, url, offer_type,
        trigger_keywords, ai_mention_text, display_order,
        show_inline, show_at_wrapup, show_as_card, cta_text
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        APP_ID,
        title,
        description,
        url,
        offerType,
        triggerKeywords,
        aiMentionText,
        displayOrder,
        showInline,
        showAtWrapup,
        showAsCard,
        ctaText,
      ]
    );

    return res.json({ offer: result.rows[0] });
  } catch (err) {
    console.error("Error creating offer:", err);
    return res.status(500).json({ error: "Failed to create offer" });
  }
});

// Update an offer
app.put("/api/offers/:offerId", requireAuth, async (req, res) => {
  try {
    const { offerId } = req.params;
    const {
      title,
      description,
      url,
      offerType,
      triggerKeywords,
      aiMentionText,
      displayOrder,
      isActive,
      showInline,
      showAtWrapup,
      showAsCard,
      ctaText,
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (url !== undefined) {
      updates.push(`url = $${paramIndex++}`);
      values.push(url);
    }
    if (offerType !== undefined) {
      updates.push(`offer_type = $${paramIndex++}`);
      values.push(offerType);
    }
    if (triggerKeywords !== undefined) {
      updates.push(`trigger_keywords = $${paramIndex++}`);
      values.push(triggerKeywords);
    }
    if (aiMentionText !== undefined) {
      updates.push(`ai_mention_text = $${paramIndex++}`);
      values.push(aiMentionText);
    }
    if (displayOrder !== undefined) {
      updates.push(`display_order = $${paramIndex++}`);
      values.push(displayOrder);
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }
    if (showInline !== undefined) {
      updates.push(`show_inline = $${paramIndex++}`);
      values.push(showInline);
    }
    if (showAtWrapup !== undefined) {
      updates.push(`show_at_wrapup = $${paramIndex++}`);
      values.push(showAtWrapup);
    }
    if (showAsCard !== undefined) {
      updates.push(`show_as_card = $${paramIndex++}`);
      values.push(showAsCard);
    }
    if (ctaText !== undefined) {
      updates.push(`cta_text = $${paramIndex++}`);
      values.push(ctaText);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(offerId, APP_ID);

    const result = await db.query(
      `UPDATE offers SET ${updates.join(", ")}
       WHERE id = $${paramIndex++} AND app_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ offer: result.rows[0] });
  } catch (err) {
    console.error("Error updating offer:", err);
    return res.status(500).json({ error: "Failed to update offer" });
  }
});

// Delete an offer
app.delete("/api/offers/:offerId", requireAuth, async (req, res) => {
  try {
    const { offerId } = req.params;

    const result = await db.query(
      `DELETE FROM offers WHERE id = $1 AND app_id = $2 RETURNING id`,
      [offerId, APP_ID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error("Error deleting offer:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// =====================================================================
// ADMIN DASHBOARD ROUTES
// =====================================================================

// Admin page routes
app.get("/admin", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "dashboard.html");
  renderHtmlTemplate(res, filePath);
});

app.get("/admin/users", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "users.html");
  renderHtmlTemplate(res, filePath);
});

app.get("/admin/sessions", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "sessions.html");
  renderHtmlTemplate(res, filePath);
});

app.get("/admin/offers", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "offers.html");
  renderHtmlTemplate(res, filePath);
});

app.get("/admin/settings", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "settings.html");
  renderHtmlTemplate(res, filePath);
});

// ---------------------------------------------------------------------
// Admin API: User Management
// ---------------------------------------------------------------------

// List all users for this app
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = req.query.search ? req.query.search.trim().toLowerCase() : null;

    let whereClause = "WHERE u.app_id = $1";
    const params = [APP_ID];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (LOWER(u.email) LIKE $${params.length} OR LOWER(u.name) LIKE $${params.length})`;
    }

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get users with session counts
    const result = await db.query(
      `SELECT
        u.id,
        u.email,
        u.name,
        u.is_admin,
        u.holiday_pass_expires_at,
        u.created_at,
        COUNT(DISTINCT s.thread_id) AS session_count,
        MAX(s.created_at) AS last_session_at
      FROM users u
      LEFT JOIN sessions s ON s.user_id = u.id AND s.app_id = $1
      ${whereClause}
      GROUP BY u.id
      ORDER BY u.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const now = new Date();
    const users = result.rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: u.is_admin || false,
      holidayPassExpiresAt: u.holiday_pass_expires_at,
      holidayPassActive: u.holiday_pass_expires_at ? new Date(u.holiday_pass_expires_at) >= now : false,
      createdAt: u.created_at,
      sessionCount: parseInt(u.session_count, 10) || 0,
      lastSessionAt: u.last_session_at,
    }));

    return res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Error in GET /api/admin/users:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get single user details
app.get("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await db.query(
      `SELECT
        u.*,
        COUNT(DISTINCT s.thread_id) AS session_count
      FROM users u
      LEFT JOIN sessions s ON s.user_id = u.id AND s.app_id = $1
      WHERE u.id = $2 AND u.app_id = $1
      GROUP BY u.id`,
      [APP_ID, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const u = result.rows[0];
    const now = new Date();

    return res.json({
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: u.is_admin || false,
      holidayPassExpiresAt: u.holiday_pass_expires_at,
      holidayPassActive: u.holiday_pass_expires_at ? new Date(u.holiday_pass_expires_at) >= now : false,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      sessionCount: parseInt(u.session_count, 10) || 0,
    });
  } catch (err) {
    console.error("Error in GET /api/admin/users/:userId:", err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
});

// Update user (admin, pass expiry, name)
app.patch("/api/admin/users/:userId", requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, isAdmin, holidayPassExpiresAt } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (isAdmin !== undefined) {
      updates.push(`is_admin = $${paramIndex++}`);
      values.push(isAdmin);
    }
    if (holidayPassExpiresAt !== undefined) {
      updates.push(`holiday_pass_expires_at = $${paramIndex++}`);
      values.push(holidayPassExpiresAt ? new Date(holidayPassExpiresAt).toISOString() : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    updates.push(`updated_at = now()`);
    values.push(userId, APP_ID);

    const result = await db.query(
      `UPDATE users SET ${updates.join(", ")}
       WHERE id = $${paramIndex++} AND app_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const u = result.rows[0];
    const now = new Date();

    return res.json({
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: u.is_admin || false,
      holidayPassExpiresAt: u.holiday_pass_expires_at,
      holidayPassActive: u.holiday_pass_expires_at ? new Date(u.holiday_pass_expires_at) >= now : false,
    });
  } catch (err) {
    console.error("Error in PATCH /api/admin/users/:userId:", err);
    return res.status(500).json({ error: "Failed to update user" });
  }
});

// ---------------------------------------------------------------------
// Admin API: Analytics
// ---------------------------------------------------------------------

// Analytics overview
app.get("/api/admin/analytics/overview", requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get user counts
    const userResult = await db.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(CASE WHEN holiday_pass_expires_at >= $2 THEN 1 END) AS active_pass_users
      FROM users
      WHERE app_id = $1`,
      [APP_ID, now.toISOString()]
    );

    // Get session counts and averages
    const sessionResult = await db.query(
      `SELECT
        COUNT(*) AS total_sessions,
        COUNT(DISTINCT thread_id) AS total_threads,
        COUNT(CASE WHEN created_at >= $2 THEN 1 END) AS sessions_this_week,
        COUNT(CASE WHEN created_at >= $3 THEN 1 END) AS sessions_this_month
      FROM sessions
      WHERE app_id = $1`,
      [APP_ID, weekAgo.toISOString(), monthAgo.toISOString()]
    );

    // Get average turns per thread
    const avgResult = await db.query(
      `SELECT AVG(turn_count) AS avg_turns
      FROM (
        SELECT thread_id, COUNT(*) AS turn_count
        FROM sessions
        WHERE app_id = $1
        GROUP BY thread_id
      ) t`,
      [APP_ID]
    );

    return res.json({
      totalUsers: parseInt(userResult.rows[0].total_users, 10) || 0,
      activePassUsers: parseInt(userResult.rows[0].active_pass_users, 10) || 0,
      totalSessions: parseInt(sessionResult.rows[0].total_sessions, 10) || 0,
      totalThreads: parseInt(sessionResult.rows[0].total_threads, 10) || 0,
      sessionsThisWeek: parseInt(sessionResult.rows[0].sessions_this_week, 10) || 0,
      sessionsThisMonth: parseInt(sessionResult.rows[0].sessions_this_month, 10) || 0,
      avgTurnsPerThread: parseFloat(avgResult.rows[0].avg_turns) || 0,
    });
  } catch (err) {
    console.error("Error in GET /api/admin/analytics/overview:", err);
    return res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// Activity trends
app.get("/api/admin/analytics/trends", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await db.query(
      `SELECT
        DATE(created_at) AS date,
        COUNT(*) AS sessions,
        COUNT(DISTINCT user_id) AS unique_users
      FROM sessions
      WHERE app_id = $1 AND created_at >= $2
      GROUP BY DATE(created_at)
      ORDER BY date ASC`,
      [APP_ID, startDate.toISOString()]
    );

    return res.json({
      period: `${days} days`,
      data: result.rows.map((r) => ({
        date: r.date,
        sessions: parseInt(r.sessions, 10) || 0,
        uniqueUsers: parseInt(r.unique_users, 10) || 0,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/admin/analytics/trends:", err);
    return res.status(500).json({ error: "Failed to fetch trends" });
  }
});

// Top users by session count
app.get("/api/admin/analytics/top-users", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const result = await db.query(
      `SELECT
        u.id,
        u.email,
        COUNT(DISTINCT s.thread_id) AS session_count,
        MAX(s.created_at) AS last_session_at
      FROM users u
      JOIN sessions s ON s.user_id = u.id AND s.app_id = $1
      WHERE u.app_id = $1
      GROUP BY u.id
      ORDER BY session_count DESC
      LIMIT $2`,
      [APP_ID, limit]
    );

    return res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        email: u.email,
        sessionCount: parseInt(u.session_count, 10) || 0,
        lastSessionAt: u.last_session_at,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/admin/analytics/top-users:", err);
    return res.status(500).json({ error: "Failed to fetch top users" });
  }
});

// ---------------------------------------------------------------------
// Admin API: Sessions
// ---------------------------------------------------------------------

// List recent sessions (admin view with user info)
app.get("/api/admin/sessions", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT thread_id) FROM sessions WHERE app_id = $1`,
      [APP_ID]
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get session threads with user info
    const result = await db.query(
      `WITH thread_summary AS (
        SELECT
          s.thread_id,
          s.user_id,
          MIN(s.created_at) AS started_at,
          MAX(s.created_at) AS last_updated_at,
          COUNT(*) AS turn_count,
          MIN(CASE WHEN s.turn_index = 0 OR s.turn_index IS NULL THEN s.input_prompt END) AS first_message
        FROM sessions s
        WHERE s.app_id = $1
        GROUP BY s.thread_id, s.user_id
      )
      SELECT
        t.thread_id,
        t.started_at,
        t.last_updated_at,
        t.turn_count,
        t.first_message,
        u.email AS user_email
      FROM thread_summary t
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.last_updated_at DESC
      LIMIT $2 OFFSET $3`,
      [APP_ID, limit, offset]
    );

    return res.json({
      sessions: result.rows.map((s) => ({
        threadId: s.thread_id,
        userEmail: s.user_email,
        startedAt: s.started_at,
        lastUpdatedAt: s.last_updated_at,
        turnCount: parseInt(s.turn_count, 10) || 0,
        firstMessage: s.first_message,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Error in GET /api/admin/sessions:", err);
    return res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// Get session detail (admin view)
app.get("/api/admin/sessions/:threadId", requireAdmin, async (req, res) => {
  try {
    const { threadId } = req.params;

    const result = await db.query(
      `SELECT
        s.id,
        s.thread_id,
        s.input_prompt,
        s.cleaned_output,
        s.created_at,
        s.turn_index,
        u.email AS user_email
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.app_id = $1 AND s.thread_id = $2
      ORDER BY s.turn_index ASC, s.created_at ASC`,
      [APP_ID, threadId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }

    return res.json({
      threadId,
      userEmail: result.rows[0].user_email,
      messages: result.rows.map((m) => ({
        id: m.id,
        inputPrompt: m.input_prompt,
        cleanedOutput: m.cleaned_output,
        createdAt: m.created_at,
        turnIndex: m.turn_index,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/admin/sessions/:threadId:", err);
    return res.status(500).json({ error: "Failed to fetch session" });
  }
});

// ---------------------------------------------------------------------
// Admin API: Offers (mirrors existing routes with admin auth)
// ---------------------------------------------------------------------

app.get("/api/admin/offers", requireAdmin, async (req, res) => {
  try {
    const offers = await getOffersForApp(APP_ID, { activeOnly: false });
    return res.json({ offers });
  } catch (err) {
    console.error("Error fetching admin offers:", err);
    return res.status(500).json({ error: "Failed to fetch offers" });
  }
});

app.post("/api/admin/offers", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      url,
      offerType = "general",
      triggerKeywords = [],
      aiMentionText,
      displayOrder = 0,
      showInline = true,
      showAtWrapup = true,
      showAsCard = true,
      ctaText = "Learn More",
    } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    const result = await db.query(
      `INSERT INTO offers (
        app_id, title, description, url, offer_type,
        trigger_keywords, ai_mention_text, display_order,
        show_inline, show_at_wrapup, show_as_card, cta_text
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        APP_ID,
        title,
        description,
        url,
        offerType,
        triggerKeywords,
        aiMentionText,
        displayOrder,
        showInline,
        showAtWrapup,
        showAsCard,
        ctaText,
      ]
    );

    return res.json({ offer: result.rows[0] });
  } catch (err) {
    console.error("Error creating admin offer:", err);
    return res.status(500).json({ error: "Failed to create offer" });
  }
});

app.put("/api/admin/offers/:offerId", requireAdmin, async (req, res) => {
  try {
    const { offerId } = req.params;
    const {
      title,
      description,
      url,
      offerType,
      triggerKeywords,
      aiMentionText,
      displayOrder,
      isActive,
      showInline,
      showAtWrapup,
      showAsCard,
      ctaText,
    } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(title);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (url !== undefined) {
      updates.push(`url = $${paramIndex++}`);
      values.push(url);
    }
    if (offerType !== undefined) {
      updates.push(`offer_type = $${paramIndex++}`);
      values.push(offerType);
    }
    if (triggerKeywords !== undefined) {
      updates.push(`trigger_keywords = $${paramIndex++}`);
      values.push(triggerKeywords);
    }
    if (aiMentionText !== undefined) {
      updates.push(`ai_mention_text = $${paramIndex++}`);
      values.push(aiMentionText);
    }
    if (displayOrder !== undefined) {
      updates.push(`display_order = $${paramIndex++}`);
      values.push(displayOrder);
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }
    if (showInline !== undefined) {
      updates.push(`show_inline = $${paramIndex++}`);
      values.push(showInline);
    }
    if (showAtWrapup !== undefined) {
      updates.push(`show_at_wrapup = $${paramIndex++}`);
      values.push(showAtWrapup);
    }
    if (showAsCard !== undefined) {
      updates.push(`show_as_card = $${paramIndex++}`);
      values.push(showAsCard);
    }
    if (ctaText !== undefined) {
      updates.push(`cta_text = $${paramIndex++}`);
      values.push(ctaText);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(offerId, APP_ID);

    const result = await db.query(
      `UPDATE offers SET ${updates.join(", ")}
       WHERE id = $${paramIndex++} AND app_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ offer: result.rows[0] });
  } catch (err) {
    console.error("Error updating admin offer:", err);
    return res.status(500).json({ error: "Failed to update offer" });
  }
});

app.delete("/api/admin/offers/:offerId", requireAdmin, async (req, res) => {
  try {
    const { offerId } = req.params;

    const result = await db.query(
      `DELETE FROM offers WHERE id = $1 AND app_id = $2 RETURNING id`,
      [offerId, APP_ID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ deleted: true });
  } catch (err) {
    console.error("Error deleting admin offer:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// ---------------------------------------------------------------------
// Admin API: App Settings
// ---------------------------------------------------------------------

app.get("/api/admin/app", requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, slug, base_url, coach_name FROM apps WHERE id = $1`,
      [APP_ID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "App not found" });
    }

    const app = result.rows[0];

    return res.json({
      id: app.id,
      slug: app.slug,
      baseUrl: app.base_url,
      coachName: app.coach_name,
      systemPrompt: PROMPTS_CONFIG.systemPrompt || "No system prompt configured",
    });
  } catch (err) {
    console.error("Error in GET /api/admin/app:", err);
    return res.status(500).json({ error: "Failed to fetch app settings" });
  }
});

app.patch("/api/admin/app", requireAdmin, async (req, res) => {
  try {
    const { coachName } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (coachName !== undefined) {
      updates.push(`coach_name = $${paramIndex++}`);
      values.push(coachName || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(APP_ID);

    const result = await db.query(
      `UPDATE apps SET ${updates.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING id, slug, base_url, coach_name`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "App not found" });
    }

    const app = result.rows[0];

    return res.json({
      id: app.id,
      slug: app.slug,
      baseUrl: app.base_url,
      coachName: app.coach_name,
    });
  } catch (err) {
    console.error("Error in PATCH /api/admin/app:", err);
    return res.status(500).json({ error: "Failed to update app settings" });
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
  console.log(
    `${APP_CONFIG.appName} API running on port ${PORT} [slug=${APP_SLUG}]`
  );
});
