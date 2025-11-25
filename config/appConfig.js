// config/appConfig.js

module.exports = {
  appId: process.env.APP_ID || "closureai",
  appName: process.env.APP_NAME || "ClosureAI",
  themeColor: process.env.APP_THEME_COLOR || "#050816",

  // Paths should be relative to /public
  appLogo: process.env.APP_LOGO || "/assets/closureai-logo-tpx.png",
  appIcon192: process.env.APP_ICON_192 || "/icons/icon-192.png",

  // Optional: coach / micro-app specific values for future use
  coachName: process.env.COACH_NAME || "",
  supportEmail: process.env.SUPPORT_EMAIL || "support@moreleads.online",
};
