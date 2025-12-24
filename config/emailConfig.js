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

  // Magic-link / secure login email configuration (legacy, kept for backward compat)
  magicLink: {
    subject:
      process.env.EMAIL_MAGICLINK_SUBJECT ||
      `Your secure link to ${APP_CONFIG.appName}`,
    previewText:
      process.env.EMAIL_MAGICLINK_PREVIEW ||
      "Tap your secure link to jump back into your clarity space.",
    heading:
      process.env.EMAIL_MAGICLINK_HEADING ||
      `Here's your secure link to ${APP_CONFIG.appName}`,
    intro:
      process.env.EMAIL_MAGICLINK_INTRO ||
      "We created a one-time secure login link just for you.",
    buttonLabel:
      process.env.EMAIL_MAGICLINK_BUTTON || "Open my secure link",
    footerText:
      process.env.EMAIL_MAGICLINK_FOOTER ||
      "If you didn't request this link, you can safely ignore this email.",
    includeTextBody: boolEnv(
      "EMAIL_MAGICLINK_INCLUDE_TEXT",
      true
    ),
  },

  // Email verification configuration
  emailVerification: {
    subject:
      process.env.EMAIL_VERIFY_SUBJECT ||
      `Verify your email for ${APP_CONFIG.appName}`,
    previewText:
      process.env.EMAIL_VERIFY_PREVIEW ||
      "Please verify your email to activate your account.",
    heading:
      process.env.EMAIL_VERIFY_HEADING ||
      "Verify your email address",
    intro:
      process.env.EMAIL_VERIFY_INTRO ||
      "Thanks for signing up! Please click the button below to verify your email and activate your account.",
    buttonLabel:
      process.env.EMAIL_VERIFY_BUTTON || "Verify Email",
    footerText:
      process.env.EMAIL_VERIFY_FOOTER ||
      "If you didn't create an account, you can safely ignore this email.",
    includeTextBody: boolEnv("EMAIL_VERIFY_INCLUDE_TEXT", true),
  },

  // Password reset configuration
  passwordReset: {
    subject:
      process.env.EMAIL_RESET_SUBJECT ||
      `Reset your password for ${APP_CONFIG.appName}`,
    previewText:
      process.env.EMAIL_RESET_PREVIEW ||
      "We received a request to reset your password.",
    heading:
      process.env.EMAIL_RESET_HEADING ||
      "Reset your password",
    intro:
      process.env.EMAIL_RESET_INTRO ||
      "We received a request to reset your password. Click the button below to choose a new password.",
    buttonLabel:
      process.env.EMAIL_RESET_BUTTON || "Reset Password",
    footerText:
      process.env.EMAIL_RESET_FOOTER ||
      "This link expires in 1 hour. If you didn't request this, you can safely ignore this email.",
    includeTextBody: boolEnv("EMAIL_RESET_INCLUDE_TEXT", true),
  },
};