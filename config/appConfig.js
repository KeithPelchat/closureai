// config/appConfig.js

const APP_BASE_URL =
  process.env.APP_BASE_URL || "https://app.getclosureai.com";

const ALLOWED_ORIGINS_RAW =
  process.env.ALLOWED_ORIGINS ||
  "https://app.getclosureai.com,https://getclosureai.com,https://www.getclosureai.com";

module.exports = {
  appId: process.env.APP_ID || "closureai",
  appName: process.env.APP_NAME || "ClosureAI",
  themeColor: process.env.APP_THEME_COLOR || "#050816",

  // Core URLs
  baseUrl: APP_BASE_URL,

  // CORS / allowed origins for the browser
  allowedOrigins: ALLOWED_ORIGINS_RAW.split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Paths should be relative to /public or /assets
  appLogo: process.env.APP_LOGO || "/assets/closureai-logo-tpx.png",
  appIcon192: process.env.APP_ICON_192 || "/icons/icon-192.png",

  // Product / funnel naming (easy to swap per micro-app later)
  holidayPassName: process.env.HOLIDAY_PASS_NAME || "Holiday Pass",
  renewalPath: process.env.RENEWAL_PATH || "/holiday-pass",

  // Optional: marketing URLs
  marketingSiteUrl: process.env.MARKETING_SITE_URL || "https://getclosureai.com",

  // Optional: coach / micro-app specific values for future use
  coachName: process.env.COACH_NAME || "",
  supportEmail: process.env.SUPPORT_EMAIL || "support@moreleads.online",
};
