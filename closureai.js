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
const { sendMagicLinkEmail, sendVerificationEmail, sendPasswordResetEmail } = require("./email/sesEmail");
const bcrypt = require("bcryptjs");

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
  renderHtmlTemplate(res, filePath, {}, req.tenant);
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
// Allow any *.getclosureai.com subdomain for multi-tenant support
// ---------------------------------------------------------------------
app.use(
  cors({
    origin: function (origin, callback) {
      // No origin (same-origin requests, curl, etc.)
      if (!origin) {
        return callback(null, true);
      }
      // Explicit allowed origins from config
      if (APP_CONFIG.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Allow any *.getclosureai.com subdomain
      if (origin.match(/^https?:\/\/([a-z0-9-]+\.)?getclosureai\.com$/)) {
        return callback(null, true);
      }
      // Allow localhost for development
      if (origin.match(/^https?:\/\/localhost(:\d+)?$/)) {
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

          // Check if this is a coach platform checkout
          if (session.metadata?.product === "coach_platform") {
            await handleCoachPlatformCheckout(session);
          } else {
            await handlePaidUser(session); // grant pass + send secure link
          }
          break;
        }
        case "customer.subscription.created": {
          // Add setup fee to first invoice if this is a coach platform subscription
          const subscription = event.data.object;
          if (subscription.metadata?.product === "coach_platform" && subscription.metadata?.setup_fee_price_id) {
            console.log("✅ Adding setup fee invoice item for coach platform subscription");
            try {
              await stripe.invoiceItems.create({
                customer: subscription.customer,
                price: subscription.metadata.setup_fee_price_id,
                description: "One-time platform setup fee",
              });
              console.log("✅ Setup fee invoice item created");
            } catch (invoiceErr) {
              console.error("❌ Failed to add setup fee invoice item:", invoiceErr.message);
            }
          }
          break;
        }
        case "invoice.payment_succeeded": {
          // Create monthly commission for partner referrals
          const invoice = event.data.object;

          // Only process subscription invoices (not one-time charges)
          if (!invoice.subscription) {
            break;
          }

          // Skip if this is the first invoice (setup fee is handled separately)
          if (invoice.billing_reason === "subscription_create") {
            console.log("ℹ️ Skipping commission for initial subscription invoice (handled by checkout)");
            break;
          }

          console.log("✅ Stripe: invoice.payment_succeeded for subscription:", invoice.subscription);

          try {
            // Find the app by Stripe customer ID
            const appResult = await db.query(
              `SELECT a.id, a.partner_id, p.commission_percent
               FROM apps a
               LEFT JOIN partners p ON a.partner_id = p.id
               WHERE a.stripe_customer_id = $1`,
              [invoice.customer]
            );

            if (appResult.rows.length === 0) {
              console.log("ℹ️ No app found for customer:", invoice.customer);
              break;
            }

            const app = appResult.rows[0];

            // Check if this app has a partner referral
            if (!app.partner_id) {
              console.log("ℹ️ No partner referral for app:", app.id);
              break;
            }

            // Calculate monthly commission (30% of $97 = $29.10 by default)
            const monthlyFee = 97; // $97/month
            const commissionPercent = parseFloat(app.commission_percent) || 30;
            const commissionAmount = (monthlyFee * commissionPercent) / 100;

            // Create the monthly commission
            await db.query(
              `INSERT INTO commissions (partner_id, client_id, type, amount, status)
               VALUES ($1, $2, 'monthly', $3, 'pending')`,
              [app.partner_id, app.id, commissionAmount]
            );

            console.log(`✅ Created monthly commission: $${commissionAmount.toFixed(2)} for partner ${app.partner_id} (app ${app.id})`);
          } catch (err) {
            console.error("❌ Error creating monthly commission:", err);
          }
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
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------
// Multi-tenant resolution middleware
// Detects subdomain/custom domain and loads coach config from DB
// ---------------------------------------------------------------------
const MAIN_DOMAINS = ["getclosureai.com", "www.getclosureai.com", "app.getclosureai.com", "localhost"];

async function resolveTenant(req, res, next) {
  try {
    const hostname = req.hostname || req.get("host")?.split(":")[0] || "";

    // Check if this is a main domain (use default ClosureAI app)
    if (MAIN_DOMAINS.includes(hostname) || hostname.startsWith("localhost")) {
      req.tenant = null; // Will use global APP_ID
      return next();
    }

    // Extract subdomain from *.getclosureai.com
    let lookupValue = null;
    let lookupType = null;

    if (hostname.endsWith(".getclosureai.com")) {
      lookupValue = hostname.replace(".getclosureai.com", "");
      lookupType = "subdomain";
    } else {
      // Assume it's a custom domain
      lookupValue = hostname;
      lookupType = "custom_domain";
    }

    // Look up the tenant app
    const query = lookupType === "subdomain"
      ? `SELECT id, slug, name, business_name, coach_name, coach_email,
           coaching_niche, target_audience, coaching_style, coach_bio,
           custom_system_prompt, logo_url, primary_color, secondary_color, background_color,
           subdomain, custom_domain, status, is_active, auto_grant_access_days
         FROM apps WHERE subdomain = $1 AND is_active = true`
      : `SELECT id, slug, name, business_name, coach_name, coach_email,
           coaching_niche, target_audience, coaching_style, coach_bio,
           custom_system_prompt, logo_url, primary_color, secondary_color, background_color,
           subdomain, custom_domain, status, is_active, auto_grant_access_days
         FROM apps WHERE custom_domain = $1 AND is_active = true`;

    const result = await db.query(query, [lookupValue]);

    if (result.rows.length === 0) {
      // No tenant found - could show error or redirect
      console.log(`[Tenant] No active app found for ${lookupType}=${lookupValue}`);
      return res.status(404).send("App not found or not active.");
    }

    req.tenant = result.rows[0];
    console.log(`[Tenant] Resolved ${hostname} → ${req.tenant.business_name || req.tenant.slug}`);
    next();
  } catch (err) {
    console.error("[Tenant] Resolution error:", err);
    next(err);
  }
}

// Apply tenant resolution to all requests
app.use(resolveTenant);

// ---------------------------------------------------------------------
// Dynamic PWA manifest (per-tenant branding)
// Must be before static middleware to take precedence
// ---------------------------------------------------------------------
app.get("/manifest.json", (req, res) => {
  const tenant = req.tenant;

  // Build tenant-specific manifest
  const manifest = {
    name: tenant?.business_name || APP_CONFIG.appName || "ClosureAI",
    short_name: tenant?.business_name?.substring(0, 12) || APP_CONFIG.appName || "ClosureAI",
    description: tenant
      ? `Coaching sessions with ${tenant.coach_name || "your coach"}`
      : "AI-guided reflection sessions",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: tenant?.primary_color || APP_CONFIG.themeColor || "#0d9488",
    icons: [
      {
        src: tenant?.logo_url || "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable"
      },
      {
        src: tenant?.logo_url || "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable"
      }
    ]
  };

  res.setHeader("Content-Type", "application/manifest+json");
  res.json(manifest);
});

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

async function findOrCreateUser({ email, name, ghlContactId, appId = null, autoGrantDays = null }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email is required to findOrCreateUser");
  }

  // Use provided appId or fall back to global APP_ID
  const effectiveAppId = appId || APP_ID;
  if (!effectiveAppId) {
    throw new Error("APP_ID not initialized and no appId provided");
  }

  const existing = await db.query(
    "SELECT * FROM users WHERE app_id = $1 AND email = $2",
    [effectiveAppId, normalizedEmail]
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

  // Calculate access expiry if auto-grant is set
  let accessExpiry = null;
  if (autoGrantDays && autoGrantDays > 0) {
    accessExpiry = new Date(Date.now() + autoGrantDays * 24 * 60 * 60 * 1000);
  }

  const result = await db.query(
    `INSERT INTO users (email, name, ghl_contact_id, app_id, holiday_pass_expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [normalizedEmail, name, ghlContactId, effectiveAppId, accessExpiry]
  );

  if (accessExpiry) {
    console.log(`[User] Auto-granted ${autoGrantDays} days access to ${normalizedEmail}`);
  }

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

// ---------------------------------------------------------------------
// Password Auth Helper Functions
// ---------------------------------------------------------------------

/**
 * Validate password meets requirements:
 * - Min 8 characters
 * - At least 1 uppercase letter
 * - At least 1 number
 */
function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' }
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one uppercase letter' }
  }
  if (!/\d/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' }
  }
  return { valid: true }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

/**
 * Create email verification token
 */
async function createEmailVerificationToken(userType, userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

  await db.query(
    `INSERT INTO email_verification_tokens (user_type, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userType, userId, token, expires]
  )

  return token
}

/**
 * Create password reset token
 */
async function createPasswordResetToken(userType, userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  // Invalidate any existing tokens for this user
  await db.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE user_type = $1 AND user_id = $2 AND used_at IS NULL`,
    [userType, userId]
  )

  await db.query(
    `INSERT INTO password_reset_tokens (user_type, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userType, userId, token, expires]
  )

  return token
}

/**
 * Get base URL for the current request context
 */
function getBaseUrl(req) {
  const hostname = req.hostname || req.get('host')?.split(':')[0] || ''
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'

  // If we have a tenant with a base URL, use that
  if (req.tenant?.base_url) {
    return req.tenant.base_url
  }

  // Otherwise construct from request
  return `${protocol}://${hostname}`
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

/**
 * Get full app profile for building coach-specific prompts
 */
async function getAppProfile(appId) {
  const result = await db.query(
    `SELECT
      id, slug, name, coach_name, business_name,
      coaching_niche, target_audience, coaching_style, coach_bio,
      custom_system_prompt
    FROM apps WHERE id = $1`,
    [appId]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  return null;
}

// ---------------------------------------------------------------------
// Simple HTML templating helper for views / public shells
// ---------------------------------------------------------------------

function getTemplateTokens(tenant = null, extraTokens = {}) {
  // Default tokens from config
  const defaults = {
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

    // Tenant branding defaults (used in CSS variables)
    PRIMARY_COLOR: "#0d9488",
    SECONDARY_COLOR: "#14b8a6",
    BACKGROUND_COLOR: "#f8f9fa",
    COACH_NAME: "your coach",
    BUSINESS_NAME: APP_CONFIG.appName,
  };

  // Override with tenant-specific values if available
  if (tenant) {
    console.log(`[Template] Applying tenant overrides: logo_url=${tenant.logo_url}, primary_color=${tenant.primary_color}`);
    defaults.APP_NAME = tenant.business_name || tenant.name || defaults.APP_NAME;
    defaults.BUSINESS_NAME = tenant.business_name || tenant.name || defaults.BUSINESS_NAME;
    defaults.COACH_NAME = tenant.coach_name || defaults.COACH_NAME;
    defaults.PRIMARY_COLOR = tenant.primary_color || defaults.PRIMARY_COLOR;
    defaults.SECONDARY_COLOR = tenant.secondary_color || defaults.SECONDARY_COLOR;
    defaults.BACKGROUND_COLOR = tenant.background_color || defaults.BACKGROUND_COLOR;
    defaults.THEME_COLOR = tenant.primary_color || defaults.THEME_COLOR;
    if (tenant.logo_url) {
      defaults.APP_LOGO = tenant.logo_url;
    }
    // Update copy to use coach name
    defaults.LOGIN_HEADLINE = `Welcome to ${tenant.business_name || "your coaching space"}`;
    defaults.LOGIN_SUBHEADLINE = `Sign in to start your session with ${tenant.coach_name || "your coach"}`;
    defaults.SESSION_INTRO = `I'm here to help you work through whatever's on your mind. What would you like to explore today?`;
  }

  return {
    ...defaults,
    ...extraTokens,
  };
}

function renderHtmlTemplate(res, filePath, extraTokens = {}, tenant = null) {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("Error reading template:", filePath, err);
      return res.status(500).send("Error loading page.");
    }

    const tokens = getTemplateTokens(tenant, extraTokens);

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
// Partner auth middleware
// ---------------------------------------------------------------------

async function requirePartnerAuth(req, res, next) {
  const token = req.cookies.closureai_partner_auth;

  if (!token) {
    if (wantsJsonResponse(req)) {
      return res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    return res.redirect("/partners");
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const result = await db.query("SELECT * FROM partners WHERE id = $1", [
      payload.partnerId,
    ]);

    if (result.rows.length === 0) {
      res.clearCookie("closureai_partner_auth");
      if (wantsJsonResponse(req)) {
        return res.status(401).json({
          ok: false,
          code: "UNAUTHORIZED",
          message: "Partner not found",
        });
      }
      return res.redirect("/partners");
    }

    const partner = result.rows[0];

    // Check if partner is active
    if (partner.status !== "active") {
      if (wantsJsonResponse(req)) {
        return res.status(403).json({
          ok: false,
          code: "PARTNER_INACTIVE",
          message: "Your partner account is not active",
        });
      }
      return res.redirect("/partners");
    }

    req.partner = partner;
    return next();
  } catch (err) {
    console.error("requirePartnerAuth error:", err);
    res.clearCookie("closureai_partner_auth");
    if (wantsJsonResponse(req)) {
      return res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Authentication error",
      });
    }
    return res.redirect("/partners");
  }
}

// ---------------------------------------------------------------------
// Coach auth middleware (coaches are in apps table)
// ---------------------------------------------------------------------

async function requireCoachAuth(req, res, next) {
  const token = req.cookies.closureai_client_auth;

  if (!token) {
    if (wantsJsonResponse(req)) {
      return res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    return res.redirect("/coach/login");
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const result = await db.query(
      "SELECT * FROM apps WHERE id = $1",
      [payload.clientId]
    );

    if (result.rows.length === 0) {
      res.clearCookie("closureai_client_auth");
      if (wantsJsonResponse(req)) {
        return res.status(401).json({
          ok: false,
          code: "UNAUTHORIZED",
          message: "Account not found",
        });
      }
      return res.redirect("/coach/login");
    }

    const coach = result.rows[0];

    // Check if coach is suspended
    if (coach.status === "suspended" || coach.status === "cancelled") {
      res.clearCookie("closureai_client_auth");
      if (wantsJsonResponse(req)) {
        return res.status(403).json({
          ok: false,
          code: "ACCOUNT_SUSPENDED",
          message: "Your account has been suspended",
        });
      }
      return res.redirect("/coach/login");
    }

    req.coach = coach;
    return next();
  } catch (err) {
    console.error("requireCoachAuth error:", err);
    res.clearCookie("closureai_client_auth");
    if (wantsJsonResponse(req)) {
      return res.status(401).json({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Authentication error",
      });
    }
    return res.redirect("/coach/login");
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

/**
 * Handle a coach platform checkout completion
 * Creates a new app record with pending_onboarding status
 */
async function handleCoachPlatformCheckout(session) {
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const customerEmail = session.customer_details?.email || session.customer_email;
  const referralCode = session.metadata?.referral_code;

  console.log(`[Coach Platform] Processing checkout for customer: ${customerId}`);
  if (referralCode) {
    console.log(`[Coach Platform] Referral code: ${referralCode}`);
  }

  // Generate a unique onboarding token
  const onboardingToken = crypto.randomBytes(32).toString("hex");
  const onboardingTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Generate a unique slug for the new app
  const slug = `coach-${crypto.randomBytes(4).toString("hex")}`;

  // Look up partner by referral code if provided
  let partnerId = null;
  let partnerCommissionPercent = 30; // Default 30%
  if (referralCode) {
    try {
      const partnerResult = await db.query(
        `SELECT id, commission_percent FROM partners
         WHERE referral_code = $1 AND status = 'active'`,
        [referralCode]
      );
      if (partnerResult.rows.length > 0) {
        partnerId = partnerResult.rows[0].id;
        partnerCommissionPercent = parseFloat(partnerResult.rows[0].commission_percent);
        console.log(`[Coach Platform] Found partner: ${partnerId} with commission ${partnerCommissionPercent}%`);
      } else {
        console.log(`[Coach Platform] No active partner found for referral code: ${referralCode}`);
      }
    } catch (err) {
      console.error("[Coach Platform] Error looking up partner:", err);
    }
  }

  try {
    // Create a new app record
    // Generate placeholder base_url using the slug (will be updated during onboarding)
    const baseUrl = `https://${slug}.getclosureai.com`;

    const result = await db.query(
      `INSERT INTO apps (
        slug, name, base_url, coach_email, stripe_customer_id, stripe_subscription_id,
        status, setup_paid_at, onboarding_token, onboarding_token_expires_at, subdomain, partner_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11)
      RETURNING id, slug`,
      [
        slug,
        "Pending Setup", // Placeholder name until onboarding completes
        baseUrl,
        customerEmail,
        customerId,
        subscriptionId,
        "pending_onboarding",
        onboardingToken,
        onboardingTokenExpiresAt,
        slug, // Use slug as subdomain initially
        partnerId,
      ]
    );

    const appId = result.rows[0].id;
    console.log(`[Coach Platform] Created app ${result.rows[0].slug} with id ${appId}`);
    console.log(`[Coach Platform] Onboarding token: ${onboardingToken}`);

    // Create setup fee commission if referred by a partner
    if (partnerId) {
      const setupFee = 2495; // $2,495 setup fee
      const commissionAmount = (setupFee * partnerCommissionPercent) / 100;

      await db.query(
        `INSERT INTO commissions (partner_id, client_id, type, amount, status)
         VALUES ($1, $2, 'setup_fee', $3, 'pending')`,
        [partnerId, appId, commissionAmount]
      );

      console.log(`[Coach Platform] Created setup_fee commission: $${commissionAmount.toFixed(2)} for partner ${partnerId}`);
    }

    // TODO: Send welcome email with onboarding link
    // For now, the user will get redirected to /onboard/form?token=CHECKOUT_SESSION_ID
    // which will look up the app by stripe customer ID

  } catch (err) {
    console.error("[Coach Platform] Error creating app:", err);
    throw err;
  }
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
  // If already logged in as partner, redirect to dashboard
  const token = req.cookies.closureai_partner_auth;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return res.redirect("/partner/dashboard");
    } catch (e) {
      // Invalid token, continue to show partners page
    }
  }
  return res.sendFile(path.join(__dirname, "views", "partners.html"));
});

// Partner dashboard page
app.get("/partner/dashboard", requirePartnerAuth, (req, res) => {
  const filePath = path.join(__dirname, "views", "partner", "dashboard.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

// Partner logout
app.post("/partner/logout", (req, res) => {
  res.clearCookie("closureai_partner_auth");
  return res.json({ ok: true, redirectTo: "/partners" });
});

// Partner API: Get stats (referrals, earnings)
app.get("/api/partner/stats", requirePartnerAuth, async (req, res) => {
  try {
    const partnerId = req.partner.id;

    // Get referral count
    const referralsResult = await db.query(
      "SELECT COUNT(*) FROM apps WHERE partner_id = $1",
      [partnerId]
    );
    const totalReferrals = parseInt(referralsResult.rows[0].count, 10);

    // Get commission stats
    const commissionsResult = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) as paid,
        COALESCE(SUM(amount), 0) as total
      FROM commissions WHERE partner_id = $1`,
      [partnerId]
    );
    const { pending, paid, total } = commissionsResult.rows[0];

    return res.json({
      ok: true,
      data: {
        referralCode: req.partner.referral_code,
        totalReferrals,
        pendingEarnings: parseFloat(pending),
        paidEarnings: parseFloat(paid),
        totalEarnings: parseFloat(total),
        paymentMethod: req.partner.payment_method,
        paymentHandle: req.partner.payment_handle,
      },
    });
  } catch (err) {
    console.error("Error in /api/partner/stats:", err);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Partner API: Get referrals list
app.get("/api/partner/referrals", requirePartnerAuth, async (req, res) => {
  try {
    const partnerId = req.partner.id;

    const result = await db.query(
      `SELECT
        a.id,
        a.name,
        a.subdomain,
        a.status,
        a.created_at,
        a.coach_email
      FROM apps a
      WHERE a.partner_id = $1
      ORDER BY a.created_at DESC`,
      [partnerId]
    );

    return res.json({
      ok: true,
      data: result.rows.map((r) => ({
        id: r.id,
        appName: r.name,
        subdomain: r.subdomain,
        status: r.status,
        coachEmail: r.coach_email,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error("Error in /api/partner/referrals:", err);
    return res.status(500).json({ error: "Failed to fetch referrals" });
  }
});

// Partner API: Get commissions list
app.get("/api/partner/commissions", requirePartnerAuth, async (req, res) => {
  try {
    const partnerId = req.partner.id;

    const result = await db.query(
      `SELECT
        c.id,
        c.type,
        c.amount,
        c.status,
        c.paid_at,
        c.created_at,
        a.name as app_name
      FROM commissions c
      LEFT JOIN apps a ON a.id = c.client_id
      WHERE c.partner_id = $1
      ORDER BY c.created_at DESC`,
      [partnerId]
    );

    return res.json({
      ok: true,
      data: result.rows.map((r) => ({
        id: r.id,
        type: r.type,
        amount: parseFloat(r.amount),
        status: r.status,
        paidAt: r.paid_at,
        createdAt: r.created_at,
        appName: r.app_name,
      })),
    });
  } catch (err) {
    console.error("Error in /api/partner/commissions:", err);
    return res.status(500).json({ error: "Failed to fetch commissions" });
  }
});

// Partner API: Update payment method
app.put("/api/partner/payment-method", requirePartnerAuth, async (req, res) => {
  try {
    const partnerId = req.partner.id;
    const { paymentMethod, paymentHandle } = req.body || {};

    if (!paymentMethod || !["venmo", "paypal"].includes(paymentMethod)) {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    if (!paymentHandle || paymentHandle.trim().length < 2) {
      return res.status(400).json({ error: "Payment handle is required" });
    }

    await db.query(
      `UPDATE partners
        SET payment_method = $1, payment_handle = $2, updated_at = NOW()
        WHERE id = $3`,
      [paymentMethod, paymentHandle.trim(), partnerId]
    );

    return res.json({ ok: true, message: "Payment method updated" });
  } catch (err) {
    console.error("Error in /api/partner/payment-method:", err);
    return res.status(500).json({ error: "Failed to update payment method" });
  }
});

// Partner API: Get profile
app.get("/api/partner/profile", requirePartnerAuth, async (req, res) => {
  try {
    const partner = req.partner;
    return res.json({
      ok: true,
      data: {
        id: partner.id,
        name: partner.name,
        email: partner.email,
        referralCode: partner.referral_code,
        commissionPercent: parseFloat(partner.commission_percent),
        paymentMethod: partner.payment_method,
        paymentHandle: partner.payment_handle,
        status: partner.status,
        createdAt: partner.created_at,
      },
    });
  } catch (err) {
    console.error("Error in /api/partner/profile:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ---------------------------------------------------------------------
// Coach Dashboard Routes
// ---------------------------------------------------------------------

// Coach login page
app.get("/coach/login", (req, res) => {
  // Check if already authenticated
  const token = req.cookies.closureai_client_auth;
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET);
      return res.redirect("/my-app");
    } catch (e) {
      res.clearCookie("closureai_client_auth");
    }
  }
  res.sendFile(path.join(__dirname, "views", "coach", "login.html"));
});

// Coach dashboard page
app.get("/my-app", requireCoachAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "coach", "dashboard.html"));
});

// Coach settings page
app.get("/my-app/settings", requireCoachAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "coach", "settings.html"));
});

// Coach branding page
app.get("/my-app/branding", requireCoachAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "coach", "branding.html"));
});

// Coach logout
app.post("/coach/logout", (req, res) => {
  res.clearCookie("closureai_client_auth");
  return res.json({ ok: true, redirectTo: "/coach/login" });
});

// Coach API: Get dashboard stats
app.get("/api/coach/stats", requireCoachAuth, async (req, res) => {
  try {
    const coachId = req.coach.id;

    // Get user count (clients)
    const usersResult = await db.query(
      "SELECT COUNT(*) FROM users WHERE app_id = $1",
      [coachId]
    );
    const totalClients = parseInt(usersResult.rows[0].count, 10);

    // Get session count
    const sessionsResult = await db.query(
      "SELECT COUNT(*) FROM sessions WHERE app_id = $1",
      [coachId]
    );
    const totalSessions = parseInt(sessionsResult.rows[0].count, 10);

    // Get unique threads (conversations)
    const threadsResult = await db.query(
      "SELECT COUNT(DISTINCT thread_id) FROM sessions WHERE app_id = $1",
      [coachId]
    );
    const totalConversations = parseInt(threadsResult.rows[0].count, 10);

    // Get sessions in last 7 days
    const recentResult = await db.query(
      `SELECT COUNT(*) FROM sessions
       WHERE app_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [coachId]
    );
    const sessionsLast7Days = parseInt(recentResult.rows[0].count, 10);

    return res.json({
      ok: true,
      data: {
        totalClients,
        totalSessions,
        totalConversations,
        sessionsLast7Days,
        appStatus: req.coach.status,
        chargeUsers: req.coach.charge_users,
        interactionLimit: req.coach.interaction_limit,
      },
    });
  } catch (err) {
    console.error("Error in /api/coach/stats:", err);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Coach API: Get profile/app info
app.get("/api/coach/profile", requireCoachAuth, async (req, res) => {
  try {
    const coach = req.coach;

    // Get offers
    const offersResult = await db.query(
      "SELECT * FROM offers WHERE app_id = $1 ORDER BY display_order",
      [coach.id]
    );

    return res.json({
      ok: true,
      data: {
        id: coach.id,
        businessName: coach.business_name,
        coachName: coach.coach_name,
        coachEmail: coach.coach_email,
        coachPhone: coach.coach_phone,
        coachingNiche: coach.coaching_niche,
        targetAudience: coach.target_audience,
        coachingStyle: coach.coaching_style,
        coachBio: coach.coach_bio,
        subdomain: coach.subdomain,
        customDomain: coach.custom_domain,
        logoUrl: coach.logo_url,
        primaryColor: coach.primary_color,
        secondaryColor: coach.secondary_color,
        backgroundColor: coach.background_color,
        status: coach.status,
        chargeUsers: coach.charge_users,
        interactionLimit: coach.interaction_limit,
        hasStripeKeys: !!(coach.coach_stripe_secret_key && coach.coach_stripe_publishable_key),
        offers: offersResult.rows.map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
          ctaText: o.cta_text,
          ctaUrl: o.cta_url,
          isActive: o.is_active,
          showAsCard: o.show_as_card,
        })),
      },
    });
  } catch (err) {
    console.error("Error in /api/coach/profile:", err);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// Coach API: Get clients list
app.get("/api/coach/clients", requireCoachAuth, async (req, res) => {
  try {
    const coachId = req.coach.id;

    const result = await db.query(
      `SELECT
        u.id,
        u.email,
        u.name,
        u.created_at,
        u.holiday_pass_expires_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.app_id = $1) as session_count,
        (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id AND s.app_id = $1) as last_session
      FROM users u
      WHERE u.app_id = $1
      ORDER BY u.created_at DESC`,
      [coachId]
    );

    return res.json({
      ok: true,
      data: result.rows.map(r => ({
        id: r.id,
        email: r.email,
        name: r.name,
        createdAt: r.created_at,
        accessExpiresAt: r.holiday_pass_expires_at,
        sessionCount: parseInt(r.session_count, 10),
        lastSession: r.last_session,
      })),
    });
  } catch (err) {
    console.error("Error in /api/coach/clients:", err);
    return res.status(500).json({ error: "Failed to fetch clients" });
  }
});

// Coach API: Update profile
app.put("/api/coach/profile", requireCoachAuth, async (req, res) => {
  try {
    const coachId = req.coach.id;
    const {
      businessName,
      coachName,
      coachPhone,
      coachingNiche,
      targetAudience,
      coachingStyle,
      coachBio,
    } = req.body || {};

    await db.query(
      `UPDATE apps SET
        business_name = COALESCE($1, business_name),
        coach_name = COALESCE($2, coach_name),
        coach_phone = COALESCE($3, coach_phone),
        coaching_niche = COALESCE($4, coaching_niche),
        target_audience = COALESCE($5, target_audience),
        coaching_style = COALESCE($6, coaching_style),
        coach_bio = COALESCE($7, coach_bio)
      WHERE id = $8`,
      [businessName, coachName, coachPhone, coachingNiche, targetAudience, coachingStyle, coachBio, coachId]
    );

    return res.json({ ok: true, message: "Profile updated" });
  } catch (err) {
    console.error("Error in PUT /api/coach/profile:", err);
    return res.status(500).json({ error: "Failed to update profile" });
  }
});

// Coach API: Update branding
app.put("/api/coach/branding", requireCoachAuth, async (req, res) => {
  try {
    const coachId = req.coach.id;
    const { primaryColor, secondaryColor, backgroundColor, logoUrl } = req.body || {};

    const updates = [];
    const values = [coachId];
    let paramIndex = 1;

    if (primaryColor) {
      paramIndex++;
      updates.push(`primary_color = $${paramIndex}`);
      values.push(primaryColor);
    }

    if (secondaryColor) {
      paramIndex++;
      updates.push(`secondary_color = $${paramIndex}`);
      values.push(secondaryColor);
    }

    if (backgroundColor) {
      paramIndex++;
      updates.push(`background_color = $${paramIndex}`);
      values.push(backgroundColor);
    }

    if (logoUrl) {
      paramIndex++;
      updates.push(`logo_url = $${paramIndex}`);
      values.push(logoUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    await db.query(
      `UPDATE apps SET ${updates.join(", ")} WHERE id = $1`,
      values
    );

    return res.json({ ok: true, message: "Branding updated" });
  } catch (err) {
    console.error("Error in PUT /api/coach/branding:", err);
    return res.status(500).json({ error: "Failed to update branding" });
  }
});

// Coach API: Update settings (Stripe keys, charge users, interaction limit)
app.put("/api/coach/settings", requireCoachAuth, async (req, res) => {
  try {
    const coachId = req.coach.id;
    const { stripeSecretKey, stripePublishableKey, chargeUsers, interactionLimit } = req.body || {};

    const updates = [];
    const values = [coachId];
    let paramIndex = 1;

    if (stripeSecretKey !== undefined) {
      paramIndex++;
      updates.push(`coach_stripe_secret_key = $${paramIndex}`);
      values.push(stripeSecretKey || null);
    }

    if (stripePublishableKey !== undefined) {
      paramIndex++;
      updates.push(`coach_stripe_publishable_key = $${paramIndex}`);
      values.push(stripePublishableKey || null);
    }

    if (chargeUsers !== undefined) {
      paramIndex++;
      updates.push(`charge_users = $${paramIndex}`);
      values.push(!!chargeUsers);
    }

    if (interactionLimit !== undefined) {
      paramIndex++;
      updates.push(`interaction_limit = $${paramIndex}`);
      values.push(parseInt(interactionLimit, 10) || 6);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No updates provided" });
    }

    await db.query(
      `UPDATE apps SET ${updates.join(", ")} WHERE id = $1`,
      values
    );

    return res.json({ ok: true, message: "Settings updated" });
  } catch (err) {
    console.error("Error in PUT /api/coach/settings:", err);
    return res.status(500).json({ error: "Failed to update settings" });
  }
});

// Coach API: Upload logo (to S3)
app.post("/api/coach/upload-logo", requireCoachAuth, async (req, res) => {
  try {
    // Check if S3 is configured
    if (!process.env.AWS_S3_BUCKET) {
      return res.status(500).json({ error: "File uploads not configured" });
    }

    // This expects a base64 encoded image in the body
    const { image, filename, contentType } = req.body || {};

    if (!image || !filename) {
      return res.status(400).json({ error: "Image and filename are required" });
    }

    // Decode base64
    const buffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ""), "base64");

    // Generate unique filename
    const ext = path.extname(filename) || ".png";
    const key = `logos/${req.coach.id}/${Date.now()}${ext}`;

    // Upload to S3
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-2" });

    await s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "image/png",
    }));

    const logoUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || "us-east-2"}.amazonaws.com/${key}`;

    // Update the app with new logo URL
    await db.query("UPDATE apps SET logo_url = $1 WHERE id = $2", [logoUrl, req.coach.id]);

    return res.json({ ok: true, logoUrl });
  } catch (err) {
    console.error("Error in /api/coach/upload-logo:", err);
    return res.status(500).json({ error: "Failed to upload logo" });
  }
});

// Coach API: Manage offers
app.get("/api/coach/offers", requireCoachAuth, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM offers WHERE app_id = $1 ORDER BY display_order",
      [req.coach.id]
    );

    return res.json({
      ok: true,
      data: result.rows.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
        ctaText: o.cta_text,
        ctaUrl: o.cta_url,
        isActive: o.is_active,
        showAsCard: o.show_as_card,
        displayOrder: o.display_order,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/coach/offers:", err);
    return res.status(500).json({ error: "Failed to fetch offers" });
  }
});

app.post("/api/coach/offers", requireCoachAuth, async (req, res) => {
  try {
    const { title, description, ctaText, ctaUrl, isActive, showAsCard } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    // Get next display order
    const orderResult = await db.query(
      "SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM offers WHERE app_id = $1",
      [req.coach.id]
    );

    const result = await db.query(
      `INSERT INTO offers (app_id, title, description, cta_text, cta_url, is_active, show_as_card, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.coach.id, title, description, ctaText, ctaUrl, isActive !== false, showAsCard !== false, orderResult.rows[0].next_order]
    );

    return res.json({ ok: true, offer: result.rows[0] });
  } catch (err) {
    console.error("Error in POST /api/coach/offers:", err);
    return res.status(500).json({ error: "Failed to create offer" });
  }
});

app.put("/api/coach/offers/:id", requireCoachAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, ctaText, ctaUrl, isActive, showAsCard } = req.body || {};

    const result = await db.query(
      `UPDATE offers SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        cta_text = COALESCE($3, cta_text),
        cta_url = COALESCE($4, cta_url),
        is_active = COALESCE($5, is_active),
        show_as_card = COALESCE($6, show_as_card)
      WHERE id = $7 AND app_id = $8
      RETURNING *`,
      [title, description, ctaText, ctaUrl, isActive, showAsCard, id, req.coach.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ ok: true, offer: result.rows[0] });
  } catch (err) {
    console.error("Error in PUT /api/coach/offers/:id:", err);
    return res.status(500).json({ error: "Failed to update offer" });
  }
});

app.delete("/api/coach/offers/:id", requireCoachAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      "DELETE FROM offers WHERE id = $1 AND app_id = $2 RETURNING id",
      [id, req.coach.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Offer not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error in DELETE /api/coach/offers/:id:", err);
    return res.status(500).json({ error: "Failed to delete offer" });
  }
});

// Grant client access (for coaches who charge users)
app.post("/api/coach/grant-access", requireCoachAuth, async (req, res) => {
  try {
    const { email, name, days } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const accessDays = parseInt(days, 10) || 30;
    const expiresAt = new Date(Date.now() + accessDays * 24 * 60 * 60 * 1000);

    // Find or create user
    const normalizedEmail = email.toLowerCase().trim();
    let userResult = await db.query(
      "SELECT * FROM users WHERE email = $1 AND app_id = $2",
      [normalizedEmail, req.coach.id]
    );

    if (userResult.rows.length === 0) {
      // Create new user
      userResult = await db.query(
        `INSERT INTO users (email, name, app_id, holiday_pass_expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [normalizedEmail, name || null, req.coach.id, expiresAt]
      );
    } else {
      // Update existing user's access
      userResult = await db.query(
        `UPDATE users SET holiday_pass_expires_at = $1
         WHERE id = $2
         RETURNING *`,
        [expiresAt, userResult.rows[0].id]
      );
    }

    return res.json({
      ok: true,
      user: {
        id: userResult.rows[0].id,
        email: userResult.rows[0].email,
        accessExpiresAt: expiresAt,
      },
    });
  } catch (err) {
    console.error("Error in POST /api/coach/grant-access:", err);
    return res.status(500).json({ error: "Failed to grant access" });
  }
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
  renderHtmlTemplate(res, filePath, {}, req.tenant);
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

// Request a one-time Secure Link by email (legacy - kept for backward compat)
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
      appId: req.tenant?.id,
      autoGrantDays: req.tenant?.auto_grant_access_days,
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

// ---------------------------------------------------------------------
// Email/Password Authentication Routes
// ---------------------------------------------------------------------

// User Registration
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name } = req.body || {}

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const validation = validatePassword(password)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    const normalizedEmail = normalizeEmail(email)
    const appId = req.tenant?.id || APP_ID

    // Check if user already exists
    const existing = await db.query(
      'SELECT id, password_hash, email_verified FROM users WHERE app_id = $1 AND email = $2',
      [appId, normalizedEmail]
    )

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0]

      if (existingUser.password_hash) {
        return res.status(400).json({ error: 'An account with this email already exists. Please sign in.' })
      }

      // User exists but no password (e.g., from magic link or Google) - set password
      const passwordHash = await hashPassword(password)
      await db.query(
        `UPDATE users SET password_hash = $1, name = COALESCE($2, name), updated_at = NOW()
         WHERE id = $3`,
        [passwordHash, name, existingUser.id]
      )

      // Send verification email if not already verified
      if (!existingUser.email_verified) {
        const verifyToken = await createEmailVerificationToken('user', existingUser.id)
        const baseUrl = getBaseUrl(req)
        const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

        await sendVerificationEmail({ to: normalizedEmail, name, verifyUrl })
        return res.json({ ok: true, message: 'Password set. Please check your email to verify your account.' })
      }

      return res.json({ ok: true, message: 'Password set. You can now sign in.' })
    }

    // Create new user
    const passwordHash = await hashPassword(password)
    const result = await db.query(
      `INSERT INTO users (email, name, password_hash, app_id, email_verified, status)
       VALUES ($1, $2, $3, $4, false, 'active')
       RETURNING id`,
      [normalizedEmail, name || null, passwordHash, appId]
    )

    const verifyToken = await createEmailVerificationToken('user', result.rows[0].id)
    const baseUrl = getBaseUrl(req)
    const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

    await sendVerificationEmail({ to: normalizedEmail, name, verifyUrl })

    return res.json({ ok: true, message: 'Account created. Please check your email to verify.' })
  } catch (err) {
    console.error('Error in /auth/register:', err)
    return res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
})

// User Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const normalizedEmail = normalizeEmail(email)
    const appId = req.tenant?.id || APP_ID

    const result = await db.query(
      'SELECT id, password_hash, email_verified, name, status FROM users WHERE app_id = $1 AND email = $2',
      [appId, normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]

    if (!user.password_hash) {
      return res.status(401).json({
        error: 'This account was created with Google. Please use "Continue with Google" to sign in.'
      })
    }

    if (user.status === 'inactive') {
      return res.status(403).json({ error: 'This account has been deactivated.' })
    }

    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before signing in. Check your inbox for the verification link.',
        needsVerification: true,
        email: normalizedEmail
      })
    }

    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' })

    const hostname = req.hostname || req.get('host')?.split(':')[0] || ''
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }

    if (hostname.endsWith('.getclosureai.com')) {
      cookieOptions.domain = '.getclosureai.com'
    }

    res.cookie('closureai_auth', jwtToken, cookieOptions)

    return res.json({ ok: true, user: { id: user.id, name: user.name } })
  } catch (err) {
    console.error('Error in /auth/login:', err)
    return res.status(500).json({ error: 'Login failed. Please try again.' })
  }
})

// Email Verification
app.get("/auth/verify/:token", async (req, res) => {
  try {
    const { token } = req.params

    const result = await db.query(
      `SELECT * FROM email_verification_tokens
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    )

    if (result.rows.length === 0) {
      return res.status(400).send(`
        <!doctype html>
        <html>
          <head><title>Verification Failed</title></head>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>Invalid or Expired Link</h1>
            <p>This verification link is invalid or has expired.</p>
            <p><a href="/login">Return to login</a></p>
          </body>
        </html>
      `)
    }

    const { user_type, user_id } = result.rows[0]

    // Mark token as used
    await db.query(
      'UPDATE email_verification_tokens SET used_at = NOW() WHERE token = $1',
      [token]
    )

    // Update user's email_verified status
    const table = user_type === 'client' ? 'apps' : user_type === 'partner' ? 'partners' : 'users'
    await db.query(
      `UPDATE ${table} SET email_verified = true, updated_at = NOW() WHERE id = $1`,
      [user_id]
    )

    // Redirect to login with success message
    return res.redirect('/login?verified=true')
  } catch (err) {
    console.error('Error in /auth/verify/:token:', err)
    return res.status(500).send('Verification failed. Please try again.')
  }
})

// Resend Verification Email
app.post("/auth/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)
    const appId = req.tenant?.id || APP_ID

    const result = await db.query(
      'SELECT id, name, email_verified FROM users WHERE app_id = $1 AND email = $2',
      [appId, normalizedEmail]
    )

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a verification email has been sent.' })
    }

    const user = result.rows[0]

    if (user.email_verified) {
      return res.json({ ok: true, message: 'Email is already verified. You can sign in.' })
    }

    const verifyToken = await createEmailVerificationToken('user', user.id)
    const baseUrl = getBaseUrl(req)
    const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

    await sendVerificationEmail({ to: normalizedEmail, name: user.name, verifyUrl })

    return res.json({ ok: true, message: 'Verification email sent. Please check your inbox.' })
  } catch (err) {
    console.error('Error in /auth/resend-verification:', err)
    return res.status(500).json({ error: 'Failed to send verification email.' })
  }
})

// Forgot Password
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)
    const appId = req.tenant?.id || APP_ID

    const result = await db.query(
      'SELECT id, name FROM users WHERE app_id = $1 AND email = $2',
      [appId, normalizedEmail]
    )

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
    }

    const user = result.rows[0]
    const resetToken = await createPasswordResetToken('user', user.id)
    const baseUrl = getBaseUrl(req)
    const resetUrl = `${baseUrl}/auth/reset-password/${resetToken}`

    await sendPasswordResetEmail({ to: normalizedEmail, name: user.name, resetUrl })

    return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
  } catch (err) {
    console.error('Error in /auth/forgot-password:', err)
    return res.status(500).json({ error: 'Failed to process request.' })
  }
})

// Show Reset Password Form
app.get("/auth/reset-password/:token", async (req, res) => {
  try {
    const { token } = req.params

    const result = await db.query(
      `SELECT * FROM password_reset_tokens
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    )

    if (result.rows.length === 0) {
      return res.status(400).send(`
        <!doctype html>
        <html>
          <head><title>Link Expired</title></head>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h1>Invalid or Expired Link</h1>
            <p>This password reset link is invalid or has expired.</p>
            <p><a href="/login">Return to login</a> to request a new one.</p>
          </body>
        </html>
      `)
    }

    // Render reset password form
    const filePath = path.join(__dirname, 'public', 'reset-password.html')
    renderHtmlTemplate(res, filePath, { RESET_TOKEN: token }, req.tenant)
  } catch (err) {
    console.error('Error in GET /auth/reset-password/:token:', err)
    return res.status(500).send('Error loading reset form.')
  }
})

// Process Password Reset
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body || {}

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' })
    }

    const validation = validatePassword(password)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    const result = await db.query(
      `SELECT * FROM password_reset_tokens
       WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [token]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' })
    }

    const { user_type, user_id } = result.rows[0]

    // Hash new password
    const passwordHash = await hashPassword(password)

    // Update password and mark email as verified
    const table = user_type === 'client' ? 'apps' : user_type === 'partner' ? 'partners' : 'users'
    await db.query(
      `UPDATE ${table} SET password_hash = $1, email_verified = true, updated_at = NOW() WHERE id = $2`,
      [passwordHash, user_id]
    )

    // Mark token as used
    await db.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1',
      [token]
    )

    return res.json({ ok: true, message: 'Password reset successfully. You can now sign in.' })
  } catch (err) {
    console.error('Error in POST /auth/reset-password:', err)
    return res.status(500).json({ error: 'Failed to reset password.' })
  }
})

// Logout: clear cookie
app.post("/auth/logout", (req, res) => {
  res.clearCookie("closureai_auth");
  res.clearCookie("closureai_client_auth");
  res.clearCookie("closureai_partner_auth");
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Client (Coach) Authentication Routes
// ---------------------------------------------------------------------

// Client Login
app.post("/auth/client/login", async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, password_hash, email_verified, coach_name, status FROM apps WHERE coach_email = $1',
      [normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const client = result.rows[0]

    if (!client.password_hash) {
      return res.status(401).json({
        error: 'Please complete your account setup or use Google to sign in.'
      })
    }

    if (client.status === 'suspended' || client.status === 'cancelled') {
      return res.status(403).json({ error: 'This account has been suspended.' })
    }

    const valid = await verifyPassword(password, client.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (!client.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before signing in.',
        needsVerification: true,
        email: normalizedEmail
      })
    }

    const jwtToken = jwt.sign({ clientId: client.id }, JWT_SECRET, { expiresIn: '30d' })

    res.cookie('closureai_client_auth', jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    })

    return res.json({ ok: true, redirectTo: '/my-app' })
  } catch (err) {
    console.error('Error in /auth/client/login:', err)
    return res.status(500).json({ error: 'Login failed. Please try again.' })
  }
})

// Client Forgot Password
app.post("/auth/client/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, coach_name FROM apps WHERE coach_email = $1',
      [normalizedEmail]
    )

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
    }

    const client = result.rows[0]
    const resetToken = await createPasswordResetToken('client', client.id)
    const baseUrl = APP_CONFIG.baseUrl || getBaseUrl(req)
    const resetUrl = `${baseUrl}/auth/reset-password/${resetToken}`

    await sendPasswordResetEmail({ to: normalizedEmail, name: client.coach_name, resetUrl })

    return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
  } catch (err) {
    console.error('Error in /auth/client/forgot-password:', err)
    return res.status(500).json({ error: 'Failed to process request.' })
  }
})

// Client Resend Verification
app.post("/auth/client/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, coach_name, email_verified FROM apps WHERE coach_email = $1',
      [normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a verification email has been sent.' })
    }

    const client = result.rows[0]

    if (client.email_verified) {
      return res.json({ ok: true, message: 'Email is already verified. You can sign in.' })
    }

    const verifyToken = await createEmailVerificationToken('client', client.id)
    const baseUrl = APP_CONFIG.baseUrl || getBaseUrl(req)
    const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

    await sendVerificationEmail({ to: normalizedEmail, name: client.coach_name, verifyUrl })

    return res.json({ ok: true, message: 'Verification email sent. Please check your inbox.' })
  } catch (err) {
    console.error('Error in /auth/client/resend-verification:', err)
    return res.status(500).json({ error: 'Failed to send verification email.' })
  }
})

// ---------------------------------------------------------------------
// Partner Authentication Routes
// ---------------------------------------------------------------------

// Partner Registration
app.post("/auth/partner/register", async (req, res) => {
  try {
    const { email, password, name, paymentMethod, paymentHandle } = req.body || {}

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' })
    }

    const validation = validatePassword(password)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    // Validate payment method if provided
    if (paymentMethod && !["venmo", "paypal"].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' })
    }

    const normalizedEmail = normalizeEmail(email)

    // Check if partner exists
    const existing = await db.query(
      'SELECT id FROM partners WHERE email = $1',
      [normalizedEmail]
    )

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' })
    }

    const passwordHash = await hashPassword(password)
    const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase()

    const result = await db.query(
      `INSERT INTO partners (email, name, password_hash, referral_code, email_verified, status, payment_method, payment_handle)
       VALUES ($1, $2, $3, $4, false, 'active', $5, $6)
       RETURNING id`,
      [normalizedEmail, name, passwordHash, referralCode, paymentMethod || null, paymentHandle || null]
    )

    const verifyToken = await createEmailVerificationToken('partner', result.rows[0].id)
    const baseUrl = APP_CONFIG.baseUrl || getBaseUrl(req)
    const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

    await sendVerificationEmail({ to: normalizedEmail, name, verifyUrl })

    return res.json({ ok: true, message: 'Account created. Please check your email to verify.' })
  } catch (err) {
    console.error('Error in /auth/partner/register:', err)
    return res.status(500).json({ error: 'Registration failed. Please try again.' })
  }
})

// Partner Login
app.post("/auth/partner/login", async (req, res) => {
  try {
    const { email, password } = req.body || {}

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, password_hash, email_verified, name, status FROM partners WHERE email = $1',
      [normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const partner = result.rows[0]

    if (!partner.password_hash) {
      return res.status(401).json({
        error: 'Please complete your account setup or use Google to sign in.'
      })
    }

    if (partner.status === 'inactive') {
      return res.status(403).json({ error: 'This account has been deactivated.' })
    }

    const valid = await verifyPassword(password, partner.password_hash)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (!partner.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before signing in.',
        needsVerification: true,
        email: normalizedEmail
      })
    }

    const jwtToken = jwt.sign({ partnerId: partner.id }, JWT_SECRET, { expiresIn: '30d' })

    res.cookie('closureai_partner_auth', jwtToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    })

    return res.json({ ok: true, redirectTo: '/partner/dashboard' })
  } catch (err) {
    console.error('Error in /auth/partner/login:', err)
    return res.status(500).json({ error: 'Login failed. Please try again.' })
  }
})

// Partner Forgot Password
app.post("/auth/partner/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, name FROM partners WHERE email = $1',
      [normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
    }

    const partner = result.rows[0]
    const resetToken = await createPasswordResetToken('partner', partner.id)
    const baseUrl = APP_CONFIG.baseUrl || getBaseUrl(req)
    const resetUrl = `${baseUrl}/auth/reset-password/${resetToken}`

    await sendPasswordResetEmail({ to: normalizedEmail, name: partner.name, resetUrl })

    return res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' })
  } catch (err) {
    console.error('Error in /auth/partner/forgot-password:', err)
    return res.status(500).json({ error: 'Failed to process request.' })
  }
})

// Partner Resend Verification
app.post("/auth/partner/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {}

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const normalizedEmail = normalizeEmail(email)

    const result = await db.query(
      'SELECT id, name, email_verified FROM partners WHERE email = $1',
      [normalizedEmail]
    )

    if (result.rows.length === 0) {
      return res.json({ ok: true, message: 'If an account exists, a verification email has been sent.' })
    }

    const partner = result.rows[0]

    if (partner.email_verified) {
      return res.json({ ok: true, message: 'Email is already verified. You can sign in.' })
    }

    const verifyToken = await createEmailVerificationToken('partner', partner.id)
    const baseUrl = APP_CONFIG.baseUrl || getBaseUrl(req)
    const verifyUrl = `${baseUrl}/auth/verify/${verifyToken}`

    await sendVerificationEmail({ to: normalizedEmail, name: partner.name, verifyUrl })

    return res.json({ ok: true, message: 'Verification email sent. Please check your inbox.' })
  } catch (err) {
    console.error('Error in /auth/partner/resend-verification:', err)
    return res.status(500).json({ error: 'Failed to send verification email.' })
  }
})

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

  // Encode the originating hostname in state so we can redirect back after auth
  const hostname = req.hostname || req.get("host")?.split(":")[0] || "";
  const stateData = {
    nonce: crypto.randomBytes(16).toString("hex"),
    returnHost: hostname,
  };
  const state = Buffer.from(JSON.stringify(stateData)).toString("base64url");

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("access_type", "online");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  console.log("[Google OAuth] Redirecting to Google auth, return host:", hostname);
  return res.redirect(authUrl.toString());
});

// Google OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  const { code, error, error_description, state } = req.query;

  // Decode state to get return host
  let returnHost = null;
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
      returnHost = stateData.returnHost;
    } catch (e) {
      console.warn("[Google OAuth] Could not decode state:", e.message);
    }
  }

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
      appId: req.tenant?.id,
      autoGrantDays: req.tenant?.auto_grant_access_days,
    });

    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "30d",
    });

    // Set cookie with domain for cross-subdomain auth
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };

    // If returnHost is a subdomain of getclosureai.com, set cookie domain for sharing
    if (returnHost && returnHost.endsWith(".getclosureai.com")) {
      cookieOptions.domain = ".getclosureai.com";
    }

    res.cookie("closureai_auth", jwtToken, cookieOptions);

    // Redirect back to the originating tenant subdomain
    let redirectUrl = "/";
    if (returnHost && returnHost !== "getclosureai.com" && returnHost.endsWith(".getclosureai.com")) {
      redirectUrl = `https://${returnHost}/`;
    }

    console.log(
      "[Google OAuth] Login complete for",
      email,
      "→ redirecting to",
      redirectUrl
    );

    return res.redirect(redirectUrl);
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
      appId: req.tenant?.id,
      autoGrantDays: req.tenant?.auto_grant_access_days,
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

    // Set cookie with domain for cross-subdomain auth if on a subdomain
    const hostname = req.hostname || req.get("host")?.split(":")[0] || "";
    const cookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };

    if (hostname.endsWith(".getclosureai.com")) {
      cookieOptions.domain = ".getclosureai.com";
    }

    res.cookie("closureai_auth", jwtToken, cookieOptions);

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
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

// Session page (protected)
app.get("/session", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "views", "session.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

// Holiday pass funnel
app.get("/holiday-pass", (req, res) => {
  const filePath = path.join(__dirname, "views", "holiday-pass.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
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
    const effectiveAppId = req.tenant?.id || APP_ID;

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
      [req.user.id, effectiveAppId, limit]
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

async function callOpenAIForClosure(conversationMessages, assistantTurnsParam, offers = [], coachName = "your coach", appProfile = null) {
  const history = Array.isArray(conversationMessages)
    ? conversationMessages
    : [];

  const assistantTurns =
    typeof assistantTurnsParam === "number"
      ? assistantTurnsParam
      : countAssistantTurns(history);

  const maxTurns = PROMPTS_CONFIG.maxAssistantTurns || 6;

  // Build coach-specific base prompt from app profile
  const basePrompt = appProfile
    ? PROMPTS_CONFIG.buildCoachBasePrompt(appProfile)
    : PROMPTS_CONFIG.systemPrompt;

  // Use the dynamic prompt builder with offer injection
  const systemPrompt = PROMPTS_CONFIG.buildSystemPrompt({
    basePrompt,
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
    // Fetch app profile and offers for coach-specific prompts
    // Use tenant from middleware if available, otherwise fall back to global APP_ID
    // -----------------------------
    const effectiveAppId = req.tenant?.id || APP_ID;
    const appProfile = req.tenant || await getAppProfile(effectiveAppId);
    const offers = await getOffersForApp(effectiveAppId);
    const coachName = appProfile?.coach_name || "your coach";

    // -----------------------------
    // Call OpenAI with coach-specific prompt and offer context
    // -----------------------------
    const assistantReply = await callOpenAIForClosure(
      conversationMessages,
      assistantTurns,
      offers,
      coachName,
      appProfile
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
        effectiveAppId,
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
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

app.get("/admin/users", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "users.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

app.get("/admin/sessions", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "sessions.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

app.get("/admin/offers", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "offers.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
});

app.get("/admin/settings", requireAdmin, (req, res) => {
  const filePath = path.join(__dirname, "views", "admin", "settings.html");
  renderHtmlTemplate(res, filePath, {}, req.tenant);
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

// Get users for filter dropdown (lightweight list)
// NOTE: Must be defined BEFORE /api/admin/users/:userId to avoid "list" being treated as userId
app.get("/api/admin/users/list", requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, name FROM users WHERE app_id = $1 ORDER BY email ASC`,
      [APP_ID]
    );

    return res.json({
      users: result.rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
      })),
    });
  } catch (err) {
    console.error("Error in GET /api/admin/users/list:", err);
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

app.get("/api/admin/sessions", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Filter parameters
    const userId = req.query.userId || null;
    const startDate = req.query.startDate || null;
    const endDate = req.query.endDate || null;

    // Build WHERE clause for filters
    let whereClause = "s.app_id = $1";
    const params = [APP_ID];

    if (userId) {
      params.push(userId);
      whereClause += ` AND s.user_id = $${params.length}`;
    }

    if (startDate) {
      params.push(startDate);
      whereClause += ` AND s.created_at >= $${params.length}::date`;
    }

    if (endDate) {
      params.push(endDate);
      whereClause += ` AND s.created_at < ($${params.length}::date + interval '1 day')`;
    }

    // Get total count with filters
    const countResult = await db.query(
      `SELECT COUNT(DISTINCT thread_id) FROM sessions s WHERE ${whereClause}`,
      params
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
        WHERE ${whereClause}
        GROUP BY s.thread_id, s.user_id
      )
      SELECT
        t.thread_id,
        t.started_at,
        t.last_updated_at,
        t.turn_count,
        t.first_message,
        u.email AS user_email,
        u.id AS user_id
      FROM thread_summary t
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.last_updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.json({
      sessions: result.rows.map((s) => ({
        threadId: s.thread_id,
        userId: s.user_id,
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
      filters: {
        userId,
        startDate,
        endDate,
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
// Admin Partner/Commission Management (Platform-wide)
// ---------------------------------------------------------------------

// Get all partners (for platform admin)
app.get("/api/admin/partners", requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        p.id,
        p.name,
        p.email,
        p.referral_code,
        p.commission_percent,
        p.payment_method,
        p.payment_handle,
        p.status,
        p.email_verified,
        p.created_at,
        COUNT(DISTINCT a.id) as referral_count,
        COALESCE(SUM(CASE WHEN c.status = 'pending' THEN c.amount ELSE 0 END), 0) as pending_earnings,
        COALESCE(SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END), 0) as paid_earnings
      FROM partners p
      LEFT JOIN apps a ON a.partner_id = p.id
      LEFT JOIN commissions c ON c.partner_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC`
    );

    return res.json({
      ok: true,
      data: result.rows.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        referralCode: p.referral_code,
        commissionPercent: parseFloat(p.commission_percent),
        paymentMethod: p.payment_method,
        paymentHandle: p.payment_handle,
        status: p.status,
        emailVerified: p.email_verified,
        createdAt: p.created_at,
        referralCount: parseInt(p.referral_count, 10),
        pendingEarnings: parseFloat(p.pending_earnings),
        paidEarnings: parseFloat(p.paid_earnings),
      })),
    });
  } catch (err) {
    console.error("Error in /api/admin/partners:", err);
    return res.status(500).json({ error: "Failed to fetch partners" });
  }
});

// Get all commissions (for platform admin)
app.get("/api/admin/commissions", requireAdmin, async (req, res) => {
  try {
    const { status, partnerId } = req.query;

    let query = `
      SELECT
        c.id,
        c.partner_id,
        c.client_id,
        c.type,
        c.amount,
        c.status,
        c.paid_at,
        c.created_at,
        p.name as partner_name,
        p.email as partner_email,
        p.payment_method,
        p.payment_handle,
        a.name as app_name,
        a.coach_email
      FROM commissions c
      LEFT JOIN partners p ON p.id = c.partner_id
      LEFT JOIN apps a ON a.id = c.client_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND c.status = $${params.length}`;
    }

    if (partnerId) {
      params.push(partnerId);
      query += ` AND c.partner_id = $${params.length}`;
    }

    query += ` ORDER BY c.created_at DESC`;

    const result = await db.query(query, params);

    return res.json({
      ok: true,
      data: result.rows.map((c) => ({
        id: c.id,
        partnerId: c.partner_id,
        clientId: c.client_id,
        type: c.type,
        amount: parseFloat(c.amount),
        status: c.status,
        paidAt: c.paid_at,
        createdAt: c.created_at,
        partnerName: c.partner_name,
        partnerEmail: c.partner_email,
        paymentMethod: c.payment_method,
        paymentHandle: c.payment_handle,
        appName: c.app_name,
        coachEmail: c.coach_email,
      })),
    });
  } catch (err) {
    console.error("Error in /api/admin/commissions:", err);
    return res.status(500).json({ error: "Failed to fetch commissions" });
  }
});

// Mark commission as paid
app.put("/api/admin/commissions/:id/paid", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE commissions
       SET status = 'paid', paid_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, partner_id, amount, type`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Commission not found or already paid" });
    }

    const commission = result.rows[0];
    console.log(`[Admin] Marked commission ${id} as paid: $${commission.amount} (${commission.type})`);

    return res.json({
      ok: true,
      message: "Commission marked as paid",
      data: {
        id: commission.id,
        partnerId: commission.partner_id,
        amount: parseFloat(commission.amount),
        type: commission.type,
      },
    });
  } catch (err) {
    console.error("Error in /api/admin/commissions/:id/paid:", err);
    return res.status(500).json({ error: "Failed to update commission" });
  }
});

// Update partner status
app.put("/api/admin/partners/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["active", "suspended"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const result = await db.query(
      `UPDATE partners
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, status`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Partner not found" });
    }

    const partner = result.rows[0];
    console.log(`[Admin] Updated partner ${id} status to: ${status}`);

    return res.json({
      ok: true,
      message: `Partner status updated to ${status}`,
      data: partner,
    });
  } catch (err) {
    console.error("Error in /api/admin/partners/:id/status:", err);
    return res.status(500).json({ error: "Failed to update partner status" });
  }
});

// Get commission summary (for dashboard stats)
app.get("/api/admin/commissions/summary", requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'paid') as paid_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) as pending_amount,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) as paid_amount,
        COALESCE(SUM(amount), 0) as total_amount
      FROM commissions`
    );

    const summary = result.rows[0];

    return res.json({
      ok: true,
      data: {
        pendingCount: parseInt(summary.pending_count, 10),
        paidCount: parseInt(summary.paid_count, 10),
        pendingAmount: parseFloat(summary.pending_amount),
        paidAmount: parseFloat(summary.paid_amount),
        totalAmount: parseFloat(summary.total_amount),
      },
    });
  } catch (err) {
    console.error("Error in /api/admin/commissions/summary:", err);
    return res.status(500).json({ error: "Failed to fetch commission summary" });
  }
});

// ---------------------------------------------------------------------
// Onboarding Routes (Coach signup flow)
// ---------------------------------------------------------------------

// Platform admin emails (hardcoded for now)
const PLATFORM_ADMINS = (process.env.PLATFORM_ADMIN_EMAILS || "keith@hypergen.ai").split(",").map(e => e.trim().toLowerCase());

function requirePlatformAdmin(req, res, next) {
  if (!req.user || !PLATFORM_ADMINS.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: "Platform admin access required" });
  }
  next();
}

// Onboarding landing page
app.get("/onboard", (req, res) => {
  return res.sendFile(path.join(__dirname, "views/onboard/index.html"));
});

// Onboarding form (after payment)
app.get("/onboard/form", (req, res) => {
  return res.sendFile(path.join(__dirname, "views/onboard/form.html"));
});

// Onboarding success
app.get("/onboard/success", (req, res) => {
  return res.sendFile(path.join(__dirname, "views/onboard/success.html"));
});

// Create Stripe checkout session
app.post("/api/onboard/create-checkout", async (req, res) => {
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const { referralCode } = req.body || {};

    console.log("[STRIPE] Creating checkout with prices:", {
      monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
      setup: process.env.STRIPE_SETUP_PRICE_ID,
      referralCode: referralCode || "none",
    });

    // First, verify the price exists and get its details
    let monthlyPrice;
    try {
      monthlyPrice = await stripe.prices.retrieve(process.env.STRIPE_MONTHLY_PRICE_ID);
      console.log("[STRIPE] Monthly price details:", {
        id: monthlyPrice.id,
        type: monthlyPrice.type,
        recurring: monthlyPrice.recurring,
      });
    } catch (priceErr) {
      console.error("[STRIPE] Error fetching monthly price:", priceErr.message);
      return res.status(500).json({ error: "Invalid monthly price configuration" });
    }

    // Build line items - subscription + one-time setup fee
    const lineItems = [
      {
        price: process.env.STRIPE_MONTHLY_PRICE_ID,
        quantity: 1,
      },
    ];

    // Add one-time setup fee to line_items if configured
    // Stripe Checkout allows mixing recurring + one-time prices in subscription mode
    if (process.env.STRIPE_SETUP_PRICE_ID) {
      lineItems.push({
        price: process.env.STRIPE_SETUP_PRICE_ID,
        quantity: 1,
      });
    }

    // Build metadata with referral code if provided
    const sessionMetadata = {
      product: "coach_platform",
    };
    if (referralCode) {
      sessionMetadata.referral_code = referralCode;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: lineItems,
      subscription_data: {
        metadata: {
          product: "coach_platform",
        },
      },
      success_url: `${process.env.APP_BASE_URL || "https://app.getclosureai.com"}/onboard/form?token={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_BASE_URL || "https://app.getclosureai.com"}/onboard?cancelled=true`,
      metadata: sessionMetadata,
    });

    console.log("[STRIPE] Checkout session created:", session.id);
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err.message);
    return res.status(500).json({ error: "Failed to create checkout session: " + err.message });
  }
});

// Get onboarding data
app.get("/api/onboard/:token", async (req, res) => {
  try {
    const { token } = req.params;

    // Try to find by checkout session ID (Stripe) or onboarding token
    let result = await db.query(
      `SELECT * FROM apps WHERE onboarding_token = $1 OR stripe_customer_id = $1`,
      [token]
    );

    // If not found by token, check if this is a Stripe session ID
    if (!result.rows.length && token.startsWith("cs_")) {
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      console.log("[Onboard] Looking up checkout session:", token);

      try {
        const session = await stripe.checkout.sessions.retrieve(token);
        console.log("[Onboard] Session customer:", session.customer);

        if (session && session.customer) {
          // Look up by stripe_customer_id (most reliable)
          result = await db.query(
            `SELECT * FROM apps WHERE stripe_customer_id = $1`,
            [session.customer]
          );
          console.log("[Onboard] Found app by customer ID:", result.rows.length > 0);
        }
      } catch (stripeErr) {
        console.error("[Onboard] Error retrieving Stripe session:", stripeErr.message);
      }
    }

    if (!result.rows.length) {
      return res.status(404).json({ error: "Invalid or expired onboarding link" });
    }

    const app = result.rows[0];

    // Parse saved form data if any
    let formData = {};
    let offers = [];
    try {
      if (app.onboarding_data) {
        const data = typeof app.onboarding_data === "string"
          ? JSON.parse(app.onboarding_data)
          : app.onboarding_data;
        formData = data.formData || {};
        offers = data.offers || [];
      }
    } catch (e) {}

    return res.json({
      email: app.coach_email,
      formData,
      offers,
      logoUrl: app.logo_url,
      status: app.status,
    });
  } catch (err) {
    console.error("Error fetching onboarding data:", err);
    return res.status(500).json({ error: "Failed to fetch onboarding data" });
  }
});

// Save onboarding progress
app.post("/api/onboard/:token/save", async (req, res) => {
  try {
    const { token } = req.params;
    const { formData, offers, logoUrl } = req.body;

    // Resolve the stripe_customer_id if token is a checkout session
    let customerId = token;
    if (token.startsWith("cs_")) {
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.retrieve(token);
        customerId = session.customer;
      } catch (stripeErr) {
        console.error("[Onboard Save] Error retrieving session:", stripeErr.message);
      }
    }

    await db.query(
      `UPDATE apps SET
        onboarding_data = $2,
        logo_url = COALESCE($3, logo_url),
        business_name = COALESCE($4, business_name),
        coach_name = COALESCE($5, coach_name),
        subdomain = COALESCE($6, subdomain),
        custom_domain = COALESCE($7, custom_domain),
        primary_color = COALESCE($8, primary_color),
        secondary_color = COALESCE($9, secondary_color)
      WHERE onboarding_token = $1 OR stripe_customer_id = $1`,
      [
        customerId,
        JSON.stringify({ formData, offers }),
        logoUrl,
        formData?.business_name,
        formData?.coach_name,
        formData?.subdomain,
        formData?.custom_domain,
        formData?.primary_color,
        formData?.secondary_color,
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error saving onboarding progress:", err);
    return res.status(500).json({ error: "Failed to save progress" });
  }
});

// Logo upload presigned URL
app.post("/api/onboard/:token/upload-logo", async (req, res) => {
  try {
    const { token } = req.params;
    const { filename, contentType } = req.body;

    // Verify token
    const appResult = await db.query(
      `SELECT id FROM apps WHERE onboarding_token = $1 OR stripe_customer_id = $1`,
      [token]
    );
    if (!appResult.rows.length) {
      return res.status(404).json({ error: "Invalid token" });
    }

    const appId = appResult.rows[0].id;
    const ext = filename.split(".").pop();
    const key = `logos/${appId}_${Date.now()}.${ext}`;

    const AWS = require("aws-sdk");
    const s3 = new AWS.S3({ region: process.env.AWS_REGION || "us-east-2" });

    const uploadUrl = s3.getSignedUrl("putObject", {
      Bucket: process.env.S3_BUCKET || "closureai-assets",
      Key: key,
      ContentType: contentType,
      Expires: 300,
    });

    const fileUrl = `https://${process.env.S3_BUCKET || "closureai-assets"}.s3.amazonaws.com/${key}`;

    return res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.error("Error generating upload URL:", err);
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// Submit onboarding
app.post("/api/onboard/:token/submit", async (req, res) => {
  try {
    const { token } = req.params;
    const { formData, offers, logoUrl } = req.body;

    console.log("[Onboard Submit] Processing token:", token);

    // Resolve the stripe_customer_id if token is a checkout session
    let customerId = token;
    if (token.startsWith("cs_")) {
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.retrieve(token);
        customerId = session.customer;
        console.log("[Onboard Submit] Resolved customer ID:", customerId);
      } catch (stripeErr) {
        console.error("[Onboard Submit] Error retrieving session:", stripeErr.message);
      }
    }

    // Update app with all data and change status
    const result = await db.query(
      `UPDATE apps SET
        status = 'pending_review',
        onboarding_data = $2,
        onboarding_completed_at = NOW(),
        logo_url = COALESCE($3, logo_url),
        business_name = $4,
        coach_name = $5,
        coach_phone = $6,
        coaching_niche = $7,
        target_audience = $8,
        coaching_style = $9,
        coach_bio = $10,
        subdomain = $11,
        custom_domain = $12,
        primary_color = COALESCE($13, primary_color),
        secondary_color = COALESCE($14, secondary_color)
      WHERE onboarding_token = $1 OR stripe_customer_id = $1
      RETURNING *`,
      [
        customerId,
        JSON.stringify({ formData, offers }),
        logoUrl,
        formData?.business_name,
        formData?.coach_name,
        formData?.coach_phone,
        formData?.coaching_niche,
        formData?.target_audience,
        formData?.coaching_style,
        formData?.coach_bio,
        formData?.subdomain,
        formData?.custom_domain,
        formData?.primary_color,
        formData?.secondary_color,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Invalid token" });
    }

    const app = result.rows[0];

    // Create offers if provided
    if (offers && offers.length) {
      for (const offer of offers) {
        if (offer.title) {
          await db.query(
            `INSERT INTO offers (app_id, title, description, url, cta_text, is_active)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [app.id, offer.title, offer.description, offer.url, offer.cta_text || "Learn More"]
          );
        }
      }
    }

    // TODO: Send notification email to platform admin
    console.log(`[ONBOARDING] New coach submitted: ${app.coach_email} (${app.business_name})`);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error submitting onboarding:", err);
    return res.status(500).json({ error: "Failed to submit onboarding" });
  }
});

// ---------------------------------------------------------------------
// Platform Admin Routes
// ---------------------------------------------------------------------

// Platform admin pages
app.get("/platform", requireAuth, requirePlatformAdmin, (req, res) => {
  return res.sendFile(path.join(__dirname, "views/platform/dashboard.html"));
});

app.get("/platform/pending", requireAuth, requirePlatformAdmin, (req, res) => {
  return res.sendFile(path.join(__dirname, "views/platform/pending.html"));
});

app.get("/platform/coaches", requireAuth, requirePlatformAdmin, (req, res) => {
  return res.sendFile(path.join(__dirname, "views/platform/coaches.html"));
});

app.get("/platform/coach/:id", requireAuth, requirePlatformAdmin, (req, res) => {
  return res.sendFile(path.join(__dirname, "views/platform/coach-detail.html"));
});

// Platform admin API
app.get("/api/platform/stats", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM apps WHERE status = 'pending_review') AS pending_count,
        (SELECT COUNT(*) FROM apps WHERE status = 'active') AS active_count,
        (SELECT COUNT(*) FROM apps WHERE status IN ('pending_onboarding', 'pending_review', 'active')) AS total_coaches
    `);

    return res.json(stats.rows[0]);
  } catch (err) {
    console.error("Error fetching platform stats:", err);
    return res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/api/platform/coaches", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { status } = req.query;

    let query = `SELECT * FROM apps WHERE status != 'pending_payment'`;
    const params = [];

    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await db.query(query, params);

    return res.json({
      coaches: result.rows.map(app => ({
        id: app.id,
        businessName: app.business_name,
        coachName: app.coach_name,
        coachEmail: app.coach_email,
        status: app.status,
        subdomain: app.subdomain,
        customDomain: app.custom_domain,
        createdAt: app.created_at,
        approvedAt: app.approved_at,
      })),
    });
  } catch (err) {
    console.error("Error fetching coaches:", err);
    return res.status(500).json({ error: "Failed to fetch coaches" });
  }
});

app.get("/api/platform/coaches/:id", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`SELECT * FROM apps WHERE id = $1`, [id]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const app = result.rows[0];

    // Get offers
    const offersResult = await db.query(
      `SELECT * FROM offers WHERE app_id = $1 ORDER BY display_order`,
      [id]
    );

    // Parse onboarding data
    let onboardingData = {};
    try {
      if (app.onboarding_data) {
        onboardingData = typeof app.onboarding_data === "string"
          ? JSON.parse(app.onboarding_data)
          : app.onboarding_data;
      }
    } catch (e) {}

    return res.json({
      id: app.id,
      businessName: app.business_name,
      coachName: app.coach_name,
      coachEmail: app.coach_email,
      coachPhone: app.coach_phone,
      status: app.status,
      subdomain: app.subdomain,
      customDomain: app.custom_domain,
      logoUrl: app.logo_url,
      primaryColor: app.primary_color,
      secondaryColor: app.secondary_color,
      backgroundColor: app.background_color,
      coachingNiche: app.coaching_niche,
      targetAudience: app.target_audience,
      coachingStyle: app.coaching_style,
      coachBio: app.coach_bio,
      customSystemPrompt: app.custom_system_prompt,
      onboardingData,
      offers: offersResult.rows,
      createdAt: app.created_at,
      setupPaidAt: app.setup_paid_at,
      approvedAt: app.approved_at,
      suspendedAt: app.suspended_at,
    });
  } catch (err) {
    console.error("Error fetching coach:", err);
    return res.status(500).json({ error: "Failed to fetch coach" });
  }
});

// Update coach data
app.patch("/api/platform/coaches/:id", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      status,
      business_name,
      coach_name,
      coach_email,
      coach_phone,
      coaching_niche,
      target_audience,
      coaching_style,
      coach_bio,
      subdomain,
      custom_domain,
      primary_color,
      secondary_color,
      logo_url,
      custom_system_prompt,
    } = req.body;

    // Build dynamic update based on status change
    let statusFields = '';
    if (status === 'active') {
      statusFields = ', is_active = true, approved_at = COALESCE(approved_at, NOW())';
    } else if (status === 'suspended') {
      statusFields = ', is_active = false, suspended_at = NOW()';
    } else if (status === 'cancelled') {
      statusFields = ', is_active = false';
    }

    const result = await db.query(
      `UPDATE apps SET
        status = COALESCE($2, status),
        business_name = COALESCE($3, business_name),
        coach_name = COALESCE($4, coach_name),
        coach_email = COALESCE($5, coach_email),
        coach_phone = COALESCE($6, coach_phone),
        coaching_niche = COALESCE($7, coaching_niche),
        target_audience = COALESCE($8, target_audience),
        coaching_style = COALESCE($9, coaching_style),
        coach_bio = COALESCE($10, coach_bio),
        subdomain = COALESCE($11, subdomain),
        custom_domain = COALESCE(NULLIF($12, ''), custom_domain),
        primary_color = COALESCE($13, primary_color),
        secondary_color = COALESCE($14, secondary_color),
        logo_url = COALESCE(NULLIF($15, ''), logo_url),
        custom_system_prompt = $16,
        is_active = CASE WHEN $2 = 'active' THEN true WHEN $2 IN ('suspended', 'cancelled') THEN false ELSE is_active END,
        approved_at = CASE WHEN $2 = 'active' AND approved_at IS NULL THEN NOW() ELSE approved_at END,
        suspended_at = CASE WHEN $2 = 'suspended' THEN NOW() ELSE suspended_at END
      WHERE id = $1
      RETURNING *`,
      [
        id,
        status || null,
        business_name || null,
        coach_name || null,
        coach_email || null,
        coach_phone || null,
        coaching_niche || null,
        target_audience || null,
        coaching_style || null,
        coach_bio || null,
        subdomain || null,
        custom_domain || '',
        primary_color || null,
        secondary_color || null,
        logo_url || '',
        custom_system_prompt || null,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    console.log(`[Platform] Updated coach ${id}`);
    return res.json({ ok: true, coach: result.rows[0] });
  } catch (err) {
    console.error("Error updating coach:", err);
    return res.status(500).json({ error: "Failed to update coach" });
  }
});

app.post("/api/platform/coaches/:id/approve", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Update status to active
    const result = await db.query(
      `UPDATE apps SET
        status = 'active',
        is_active = true,
        approved_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const app = result.rows[0];

    // Create admin user for coach if not exists
    const existingUser = await db.query(
      `SELECT id FROM users WHERE app_id = $1 AND email = $2`,
      [id, app.coach_email]
    );

    if (!existingUser.rows.length) {
      await db.query(
        `INSERT INTO users (app_id, email, name, is_admin, created_at)
         VALUES ($1, $2, $3, true, NOW())`,
        [id, app.coach_email, app.coach_name]
      );
    } else {
      await db.query(
        `UPDATE users SET is_admin = true WHERE app_id = $1 AND email = $2`,
        [id, app.coach_email]
      );
    }

    // TODO: Send welcome email to coach
    console.log(`[PLATFORM] Approved coach: ${app.coach_email} (${app.business_name})`);

    return res.json({ ok: true, app: result.rows[0] });
  } catch (err) {
    console.error("Error approving coach:", err);
    return res.status(500).json({ error: "Failed to approve coach" });
  }
});

app.post("/api/platform/coaches/:id/suspend", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE apps SET
        status = 'suspended',
        is_active = false,
        suspended_at = NOW()
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    console.log(`[PLATFORM] Suspended coach: ${result.rows[0].coach_email}`);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error suspending coach:", err);
    return res.status(500).json({ error: "Failed to suspend coach" });
  }
});

app.post("/api/platform/coaches/:id/reactivate", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE apps SET
        status = 'active',
        is_active = true,
        suspended_at = NULL
      WHERE id = $1
      RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    console.log(`[PLATFORM] Reactivated coach: ${result.rows[0].coach_email}`);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error reactivating coach:", err);
    return res.status(500).json({ error: "Failed to reactivate coach" });
  }
});

app.patch("/api/platform/coaches/:id", requireAuth, requirePlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update query
    const allowedFields = [
      "business_name", "coach_name", "coach_email", "coach_phone",
      "subdomain", "custom_domain", "logo_url", "primary_color", "secondary_color",
      "coaching_niche", "target_audience", "coaching_style", "coach_bio",
      "custom_system_prompt"
    ];

    const setClauses = [];
    const values = [id];

    for (const [key, value] of Object.entries(updates)) {
      const snakeKey = key.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
      if (allowedFields.includes(snakeKey)) {
        values.push(value);
        setClauses.push(`${snakeKey} = $${values.length}`);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const result = await db.query(
      `UPDATE apps SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
      values
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Coach not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error updating coach:", err);
    return res.status(500).json({ error: "Failed to update coach" });
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
