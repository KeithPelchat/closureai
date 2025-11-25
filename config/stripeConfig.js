// config/stripeConfig.js

const APP_CONFIG = require("./appConfig");

module.exports = {
  // Core Stripe credentials
  secretKey: process.env.STRIPE_SECRET_KEY || "",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",

  // Product / price configuration
  priceId: process.env.STRIPE_PRICE_ID || "",
  mode: process.env.STRIPE_MODE || "payment",

  // Promotions
  allowPromotionCodes:
    (process.env.STRIPE_ALLOW_PROMOTION_CODES || "true").toLowerCase() ===
    "true",

  // Success / cancel paths relative to APP base URL
  successPath:
    process.env.STRIPE_SUCCESS_PATH || "/checkout/success?session_id={CHECKOUT_SESSION_ID}",
  cancelPath: process.env.STRIPE_CANCEL_PATH || "/cancelled",

  // Convenience helpers
  getSuccessUrl() {
    // If successPath already includes {CHECKOUT_SESSION_ID}, don't re-add it
    if (this.successPath.includes("{CHECKOUT_SESSION_ID}")) {
      return `${APP_CONFIG.baseUrl}${this.successPath}`;
    }
    return `${APP_CONFIG.baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
  },

  getCancelUrl() {
    return `${APP_CONFIG.baseUrl}${this.cancelPath}`;
  },
};
