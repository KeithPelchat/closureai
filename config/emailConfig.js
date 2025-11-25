// config/emailConfig.js

const APP_CONFIG = require("./appConfig");

function boolEnv(name, defaultVal) {
  const raw = process.env[name];
  if (!raw) return defaultVal;
  return raw.toLowerCase() === "true" || raw === "1";
}

module.exports = {
  // Who the email appears to be from
  fromName: process.env.EMAIL_FROM_NAME || APP_CONFIG.appName || "ClosureAI",
  fromEmail:
    process.env.EMAIL_FROM_EMAIL || "support@getclosureai.com",

  // Optional reply-to override
  replyToEmail:
    process.env.EMAIL_REPLY_TO || "support@getclosureai.com",

  // Magic-link / secure login email configuration
  magicLink: {
    subject:
      process.env.EMAIL_MAGICLINK_SUBJECT ||
      `Your secure link to ${APP_CONFIG.appName}`,
    previewText:
      process.env.EMAIL_MAGICLINK_PREVIEW ||
      "Tap your secure link to jump back into your clarity space.",
    heading:
      process.env.EMAIL_MAGICLINK_HEADING ||
      `Here’s your secure link to ${APP_CONFIG.appName}`,
    intro:
      process.env.EMAIL_MAGICLINK_INTRO ||
      "We created a one-time secure login link just for you.",
    buttonLabel:
      process.env.EMAIL_MAGICLINK_BUTTON || "Open my secure link",
    footerText:
      process.env.EMAIL_MAGICLINK_FOOTER ||
      "If you didn’t request this link, you can safely ignore this email.",
    includeTextBody: boolEnv(
      "EMAIL_MAGICLINK_INCLUDE_TEXT",
      true
    ),
  },
};