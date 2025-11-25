// email/sesEmail.js
require("dotenv").config();
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

// Initialize SES client
const ses = new SESClient({
  region: process.env.AWS_REGION || "us-east-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Send a transactional email via AWS SES
 */
async function sendMagicLinkEmail({ to, name, loginUrl }) {
  const fromEmail =
    process.env.CLOSUREAI_FROM_EMAIL || "ClosureAI <hello@getclosureai.com>";

  const safeName = name?.trim() || "there";

  const subject = "Your private ClosureAI session link";

  const textBody = `
Hi ${safeName},

Here’s your private link to begin your ClosureAI Holiday Closure session:

${loginUrl}

This link works for 24 hours and will take you directly into your secure dashboard.

Your session is for reflection only — nothing you write is ever emailed or shared.

If you ever feel unsafe or in crisis, please contact a qualified professional
or local emergency services.

– ClosureAI
  `.trim();

  const htmlBody = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #0f172a; line-height: 1.6; max-width: 480px; margin: 0 auto;">
    <p>Hi ${safeName},</p>

    <p>Your private <strong>ClosureAI Holiday Closure</strong> session is ready.</p>

    <p style="margin: 24px 0;">
      <a href="${loginUrl}"
        style="background:#22c55e; padding:14px 22px; border-radius:999px; 
               color:#020617; text-decoration:none; font-weight:600; display:inline-block;">
        Start Your Closure Session
      </a>
    </p>

    <p>This link works for 24 hours and takes you directly into your secure dashboard.</p>

    <p style="font-size:13px; color:#475569; margin-top:24px;">
      Your session is for reflection only — nothing you write here is ever emailed to anyone.
      If you ever feel unsafe or in crisis, please contact a qualified professional or
      local emergency services.
    </p>

    <p style="font-size:13px; color:#94a3b8; margin-top:16px;">– ClosureAI</p>
  </div>
  `;

  const params = {
    Source: fromEmail,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: textBody },
        Html: { Data: htmlBody },
      },
    },
  };

  try {
    await ses.send(new SendEmailCommand(params));
    console.log("Magic link email sent to:", to);
  } catch (err) {
    console.error("SES email error:", err);
    throw err;
  }
}

module.exports = {
  sendMagicLinkEmail,
};
