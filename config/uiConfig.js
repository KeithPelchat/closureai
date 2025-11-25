// config/uiConfig.js
// Central place for UI text / micro-app branding.

module.exports = {
  app: {
    shortName: process.env.UI_APP_SHORT_NAME || "ClosureAI",
    tagline:
      process.env.UI_APP_TAGLINE ||
      "Clarity for messy, very human moments.",
    primaryCtaLabel:
      process.env.UI_PRIMARY_CTA_LABEL || "Start a clarity session",
  },

  loginPage: {
    headline:
      process.env.UI_LOGIN_HEADLINE || "Log back into your clarity space",
    subheadline:
      process.env.UI_LOGIN_SUBHEADLINE ||
      "Use your email to get a secure, one-click login link.",
  },

  dashboardPage: {
    title:
      process.env.UI_DASHBOARD_TITLE || "Your recent clarity sessions",
    emptyStateTitle:
      process.env.UI_DASHBOARD_EMPTY_TITLE || "No sessions yet",
    emptyStateBody:
      process.env.UI_DASHBOARD_EMPTY_BODY ||
      "When you start a clarity session, your threads will show up here.",
  },

  sessionPage: {
    title: process.env.UI_SESSION_TITLE || "New clarity session",
    intro:
      process.env.UI_SESSION_INTRO ||
      "Take a breath. Write what happened in your own words, and we’ll sort through it together.",
  },

  holidayPassPage: {
    headline:
      process.env.UI_HOLIDAY_HEADLINE || "Holiday Sanity Pass access",
    subheadline:
      process.env.UI_HOLIDAY_SUBHEADLINE ||
      "Get on-demand support for the moments that won’t leave your brain alone.",
  },
};
