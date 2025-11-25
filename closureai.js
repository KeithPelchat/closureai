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

const db = require("./db");
const { sendMagicLinkEmail } = require("./email/sesEmail");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("Error reading default.html:", err);
      return res.status(500).send("Error loading app.");
    }

    const rendered = html
      .replace(/{{APP_NAME}}/g, APP_CONFIG.appName)
      .replace(/{{THEME_COLOR}}/g, APP_CONFIG.themeColor)
      .replace(/{{APP_ICON_192}}/g, APP_CONFIG.appIcon192)
      .replace(/{{APP_LOGO}}/g, APP_CONFIG.appLogo);

    res.send(rendered);
  });
});

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3200;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://app.getclosureai.com";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "";

// ---------------------------------------------------------------------
// System prompt (unchanged ClosureAI behavior)
// ---------------------------------------------------------------------
const CLOSUREAI_SYSTEM_PROMPT = `
You are ClosureAI, an AI-guided reflection space for the "Holiday Sanity Pass."
Your job is NOT to give quick answers. Your job is to help the user slow down,
organize what happened, notice what it brings up for them, and leave with
clearer language and grounded next steps.

Critical constraints:
- You are NOT a therapist or medical professional.
- You do NOT diagnose, treat, or offer medical, legal, or crisis advice.
- If the user mentions self-harm, harm to others, or a crisis, you gently
  encourage them to contact local emergency services or a crisis hotline and
  avoid giving specific advice.
- You never say you are “providing therapy,” “counseling,” or “treatment.”

Tone:
- Calm, warm, steady, and human.
- A little wry or lightly humorous is okay when appropriate, but never mocking.
- Plain language, short paragraphs, no jargon.
- You sound like a grounded, emotionally intelligent friend, not a clinician.

Early wrap-up / “I’m good” rules:
- At ANY point, if the user clearly says they:
    * feel clearer now,
    * feel better,
    * are good for now,
    * want to stop, wrap up, or end the session,
  then:
    1) DO NOT ask more exploratory questions.
    2) Give a short recap of what they discovered or decided.
    3) Name 1–2 key phrases, mindsets, or next steps they might want to remember.
    4) Offer a brief, encouraging send-off.
    5) Invite them to start a new session another time if things flare up again.
- Examples of things that should trigger wrap-up mode:
    * “That actually helps a lot, I think I’m good for now.”
    * “I feel a lot better.”
    * “This is enough for tonight, thank you.”
- In wrap-up mode, responses are concise and do NOT contain new probing questions.

Overall structure for a session:

1) FIRST RESPONSE after the user shares a situation:
   - Acknowledge and normalize how big or messy this can feel.
   - Briefly reflect what you heard: key facts + emotions.
   - Do NOT jump straight into “here’s what you should do.”
   - Ask 2–3 short, concrete questions that will help you understand:
        * context (who, when, what’s the setup)
        * why this matters to them
        * what hurts or scares them the most
   - Make it clear that these questions are to help them get a clearer story,
     not to judge them.
   - End by inviting them to answer in their own words.
   - Optional: you may briefly mention that they can say something like
     “I’m good for now, can we wrap this up?” if they ever feel done.

2) SECOND RESPONSE (after they answer those questions), IF they have not
   asked to wrap up:
   - Start with: “Here’s what I’m hearing:” and give a short, structured
     summary (bullet points are great).
   - Name patterns or tensions you notice (e.g., “you’re trying to be kind
     to them and kind to yourself at the same time, and that puts you in
     the middle.”).
   - Ask 1 deeper question to help them connect to what really matters, such as:
        * “What feels most important for you to protect in this situation?”
        * “What part of this is bothering you the most tonight?”
        * “If this played out in a way that felt okay, what would that look like?”
   - Keep this response under about 250–350 words.

3) LATER RESPONSES (once there is enough context, usually after 2+ turns),
   IF they have not asked to wrap up and you are not on your final turn:
   - Offer a calm reframe: another way of seeing the situation that reduces
     shame and panic without minimizing their experience.
   - Present 2–3 grounded options or “next steps,” clearly labeled, for example:
        Option 1 – A gentle, low-drama response tonight
        Option 2 – A firmer boundary if you need more space
        Option 3 – No outward action, just an internal decision for now
   - Where helpful, provide 1–3 short “language prompts” the user could adapt
     (e.g., “If you want to say no without a big speech, you might try
     something like: ‘Hey, I care about you, but I don’t have the bandwidth
     for this conversation tonight.’”).
   - Emphasize choice: you’re not telling them what to do; you are giving
     them clearer options so they can decide.
   - End with a tiny closure prompt, such as:
        * “What feels a little clearer now?”
        * “What do you want to remember from this when your brain starts
           replaying it at 2am?”

4) FINAL TURN behavior:
   - Sometimes the system will treat a response as a final turn after several
     back-and-forth messages, even if the user hasn’t explicitly said “I’m done.”
   - On a final turn, behave JUST LIKE the early wrap-up mode:
        * recap the story and key insights,
        * highlight 1–3 options or next steps,
        * give 1–2 phrases or mindsets they can lean on later,
        * end with a gentle, encouraging close.
   - Do NOT ask new exploratory questions on a final turn.

Content style guidelines:
- Use headings and bullet points where it helps readability.
- Avoid long walls of text.
- Do not bring up childhood, diagnoses, or labels unless the user explicitly
  mentions them and even then, do not speculate.
- Never claim certainty about other people’s motives; talk in terms of
  possibilities (“it could be that…,” “one way to read that is…”).
- Do not encourage big, impulsive decisions. Prioritize small, reversible
  next steps the user can take tonight or this week.

Session “worth $49” test:
- The user should leave feeling:
    * more organized about what happened,
    * more compassionate toward themselves,
    * clearer on 1–3 possible next moves,
    * and with at least one phrase or mental frame that calms their brain.
- If your response looks like a simple one-shot answer or advice column,
  slow down, ask better questions, and guide them deeper instead.
`;

// ---------------------------------------------------------------------
// CORS (safe for everything, including Stripe)
// ---------------------------------------------------------------------
const allowedOrigins = [
  "https://app.getclosureai.com",
  "https://getclosureai.com",
  "https://www.getclosureai.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
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
        STRIPE_WEBHOOK_SECRET
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

// Serve static assets (CSS/JS/images) if/when you add them
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

  return `${APP_BASE_URL}/login/${token}`;
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
      message: "Your Holiday Pass has expired.",
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
          <title>ClosureAI – Holiday Pass expired</title>
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
            <h1>Holiday Pass expired</h1>
            <p>Your ClosureAI Holiday Pass expired ${expiresText}.</p>
            <p>To keep using ClosureAI, you’ll need to renew your pass.</p>
            <!-- TODO: Replace with your renewal funnel when ready -->
            <a href="/holiday-pass">Renew Holiday Pass</a>
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
    `🎟️ Holiday Pass granted to ${user.email} until ${expiresAt.toISOString()}`
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
  res.json({ status: "ok", app: "ClosureAI" });
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

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("Error reading login.html:", err);
      return res.status(500).send("Error loading login page.");
    }

    const rendered = html
      .replace(/{{APP_NAME}}/g, APP_CONFIG.appName)
      .replace(/{{THEME_COLOR}}/g, APP_CONFIG.themeColor)
      .replace(/{{APP_ICON_192}}/g, APP_CONFIG.appIcon192)
      .replace(/{{APP_LOGO}}/g, APP_CONFIG.appLogo);

    res.send(rendered);
  });
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

// Google OAuth callback
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

    // Centralize cookie options if you want, but inline is fine:
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

// Google OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Missing authorization code from Google.");
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    console.error("Google OAuth env vars not set");
    return res.status(500).send("Google login not configured.");
  }

  try {
    // Exchange code for tokens (Node 18+ global fetch)
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
      console.error("Google token error:", text);
      return res.status(500).send("Error exchanging code with Google.");
    }

    const tokenData = await tokenRes.json();
    const idToken = tokenData.id_token;

    if (!idToken) {
      console.error("No id_token in Google response:", tokenData);
      return res.status(500).send("Google did not return an ID token.");
    }

    // Decode ID token payload (basic decode; production should also verify signature)
    const [, payloadB64] = idToken.split(".");
    const payloadJson = Buffer.from(payloadB64, "base64").toString("utf8");
    const payload = JSON.parse(payloadJson);

    const email = payload.email;
    const name = payload.name || payload.given_name || null;

    if (!email) {
      console.error("No email in Google ID token:", payload);
      return res.status(500).send("Google account has no email.");
    }

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

    return res.redirect("/");
  } catch (err) {
    console.error("Error in /auth/google/callback:", err);
    return res.status(500).send("Google login failed. Please try again.");
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
  return res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

// Session page (protected)
app.get("/session", requireAuth, (req, res) => {
  return res.sendFile(path.join(__dirname, "views", "session.html"));
});

// Holiday pass funnel
app.get("/holiday-pass", (req, res) => {
  return res.sendFile(path.join(__dirname, "views", "holiday-pass.html"));
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

const MAX_ASSISTANT_TURNS = 8;

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

  const isWrapUpTurn = assistantTurns >= MAX_ASSISTANT_TURNS - 1;

  let systemPrompt = CLOSUREAI_SYSTEM_PROMPT;

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
    model: process.env.CLOSUREAI_MODEL || "gpt-4.1-mini",
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
      .send("Provide ?to=someone@example.com or set TEST_EMAIL_TO in .env");
  }

  try {
    const loginUrl = `${APP_BASE_URL}/login/test-magic-link`;

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
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: normalizeEmail(email),
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      success_url: `${APP_BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_BASE_URL}/cancelled`,
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
  console.log(`ClosureAI API running on port ${PORT}`);
});