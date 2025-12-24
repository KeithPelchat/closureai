// email/sesEmail.js

const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const EMAIL_CONFIG = require("../config/emailConfig");
const APP_CONFIG = require("../config/appConfig");

const sesRegion = process.env.AWS_REGION || "us-east-1";

const sesClient = new SESClient({
  region: sesRegion,
});

/**
 * Build the "From" header - "Name <email@example.com>"
 */
function buildFrom() {
  const name = EMAIL_CONFIG.fromName || APP_CONFIG.appName || "ClosureAI";
  const email = EMAIL_CONFIG.fromEmail;
  if (!email) {
    throw new Error(
      "EMAIL_FROM_EMAIL (or equivalent) is not configured for SES sender"
    );
  }
  return `${name} <${email}>`;
}

/**
 * Simple HTML template for the magic link email.
 */
function buildMagicLinkHtml({ name, loginUrl }) {
  const c = EMAIL_CONFIG.magicLink;
  const safeName = name || "there";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${c.subject}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #020617;
          color: #e2e8f0;
        }
        .wrapper {
          width: 100%;
          padding: 32px 0;
        }
        .card {
          max-width: 480px;
          margin: 0 auto;
          padding: 28px 24px;
          border-radius: 24px;
          background: #020617;
          box-shadow: 0 24px 80px rgba(15, 23, 42, 0.9);
          border: 1px solid #1f2937;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 12px;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 12px;
        }
        .btn {
          display: inline-block;
          margin-top: 16px;
          padding: 10px 18px;
          border-radius: 999px;
          background: #22c55e;
          color: #020617 !important;
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
        }
        .url {
          font-size: 12px;
          word-break: break-all;
          color: #94a3b8;
          margin-top: 16px;
        }
        .footer {
          font-size: 12px;
          color: #6b7280;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <p style="font-size:12px;color:#9ca3af;margin:0 0 6px;">
            ${c.previewText}
          </p>
          <h1>${c.heading}</h1>
          <p>Hi ${safeName},</p>
          <p>${c.intro}</p>
          <p>
            <a href="${loginUrl}" class="btn" target="_blank" rel="noopener noreferrer">
              ${c.buttonLabel}
            </a>
          </p>
          <p class="url">
            If the button doesn’t work, you can copy and paste this link into your browser:<br />
            ${loginUrl}
          </p>
          <p class="footer">
            ${c.footerText}
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

/**
 * Plain-text fallback body.
 */
function buildMagicLinkText({ name, loginUrl }) {
  const c = EMAIL_CONFIG.magicLink;
  const safeName = name || "there";

  return [
    `Hi ${safeName},`,
    "",
    c.intro,
    "",
    `Your secure link: ${loginUrl}`,
    "",
    c.footerText,
  ].join("\n");
}

/**
 * HTML template for email verification.
 */
function buildVerificationHtml({ name, verifyUrl }) {
  const c = EMAIL_CONFIG.emailVerification;
  const safeName = name || "there";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${c.subject}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #020617;
          color: #e2e8f0;
        }
        .wrapper {
          width: 100%;
          padding: 32px 0;
        }
        .card {
          max-width: 480px;
          margin: 0 auto;
          padding: 28px 24px;
          border-radius: 24px;
          background: #020617;
          box-shadow: 0 24px 80px rgba(15, 23, 42, 0.9);
          border: 1px solid #1f2937;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 12px;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 12px;
        }
        .btn {
          display: inline-block;
          margin-top: 16px;
          padding: 10px 18px;
          border-radius: 999px;
          background: #22c55e;
          color: #020617 !important;
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
        }
        .url {
          font-size: 12px;
          word-break: break-all;
          color: #94a3b8;
          margin-top: 16px;
        }
        .footer {
          font-size: 12px;
          color: #6b7280;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <p style="font-size:12px;color:#9ca3af;margin:0 0 6px;">
            ${c.previewText}
          </p>
          <h1>${c.heading}</h1>
          <p>Hi ${safeName},</p>
          <p>${c.intro}</p>
          <p>
            <a href="${verifyUrl}" class="btn" target="_blank" rel="noopener noreferrer">
              ${c.buttonLabel}
            </a>
          </p>
          <p class="url">
            If the button doesn't work, you can copy and paste this link into your browser:<br />
            ${verifyUrl}
          </p>
          <p class="footer">
            ${c.footerText}
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

/**
 * Plain-text fallback for verification email.
 */
function buildVerificationText({ name, verifyUrl }) {
  const c = EMAIL_CONFIG.emailVerification;
  const safeName = name || "there";

  return [
    `Hi ${safeName},`,
    "",
    c.intro,
    "",
    `Verify your email: ${verifyUrl}`,
    "",
    c.footerText,
  ].join("\n");
}

/**
 * HTML template for password reset.
 */
function buildPasswordResetHtml({ name, resetUrl }) {
  const c = EMAIL_CONFIG.passwordReset;
  const safeName = name || "there";

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${c.subject}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #020617;
          color: #e2e8f0;
        }
        .wrapper {
          width: 100%;
          padding: 32px 0;
        }
        .card {
          max-width: 480px;
          margin: 0 auto;
          padding: 28px 24px;
          border-radius: 24px;
          background: #020617;
          box-shadow: 0 24px 80px rgba(15, 23, 42, 0.9);
          border: 1px solid #1f2937;
        }
        h1 {
          font-size: 22px;
          margin: 0 0 12px;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 12px;
        }
        .btn {
          display: inline-block;
          margin-top: 16px;
          padding: 10px 18px;
          border-radius: 999px;
          background: #f59e0b;
          color: #020617 !important;
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
        }
        .url {
          font-size: 12px;
          word-break: break-all;
          color: #94a3b8;
          margin-top: 16px;
        }
        .footer {
          font-size: 12px;
          color: #6b7280;
          margin-top: 20px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <p style="font-size:12px;color:#9ca3af;margin:0 0 6px;">
            ${c.previewText}
          </p>
          <h1>${c.heading}</h1>
          <p>Hi ${safeName},</p>
          <p>${c.intro}</p>
          <p>
            <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">
              ${c.buttonLabel}
            </a>
          </p>
          <p class="url">
            If the button doesn't work, you can copy and paste this link into your browser:<br />
            ${resetUrl}
          </p>
          <p class="footer">
            ${c.footerText}
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

/**
 * Plain-text fallback for password reset email.
 */
function buildPasswordResetText({ name, resetUrl }) {
  const c = EMAIL_CONFIG.passwordReset;
  const safeName = name || "there";

  return [
    `Hi ${safeName},`,
    "",
    c.intro,
    "",
    `Reset your password: ${resetUrl}`,
    "",
    c.footerText,
  ].join("\n");
}

/**
 * Send the magic link email using SES.
 *
 * Uses the classic SES v1 SendEmail API shape:
 * Source, Destination, Message { Subject, Body: { Html, Text } }
 */
async function sendMagicLinkEmail({ to, name, loginUrl }) {
  if (!to) {
    throw new Error("sendMagicLinkEmail: 'to' is required");
  }
  if (!loginUrl) {
    throw new Error("sendMagicLinkEmail: 'loginUrl' is required");
  }

  const from = buildFrom();
  const c = EMAIL_CONFIG.magicLink;

  const htmlBody = buildMagicLinkHtml({ name, loginUrl });
  const textBody = EMAIL_CONFIG.magicLink.includeTextBody
    ? buildMagicLinkText({ name, loginUrl })
    : undefined;

  const params = {
    Source: from,
    Destination: {
      ToAddresses: [to],
    },
    ReplyToAddresses: EMAIL_CONFIG.replyToEmail
      ? [EMAIL_CONFIG.replyToEmail]
      : [],
    Message: {
      Subject: {
        Data: c.subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
        ...(textBody
          ? {
              Text: {
                Data: textBody,
                Charset: "UTF-8",
              },
            }
          : {}),
      },
    },
  };

  const command = new SendEmailCommand(params);
  await sesClient.send(command);
}

/**
 * Send email verification email using SES.
 */
async function sendVerificationEmail({ to, name, verifyUrl }) {
  if (!to) {
    throw new Error("sendVerificationEmail: 'to' is required");
  }
  if (!verifyUrl) {
    throw new Error("sendVerificationEmail: 'verifyUrl' is required");
  }

  const from = buildFrom();
  const c = EMAIL_CONFIG.emailVerification;

  const htmlBody = buildVerificationHtml({ name, verifyUrl });
  const textBody = c.includeTextBody
    ? buildVerificationText({ name, verifyUrl })
    : undefined;

  const params = {
    Source: from,
    Destination: {
      ToAddresses: [to],
    },
    ReplyToAddresses: EMAIL_CONFIG.replyToEmail
      ? [EMAIL_CONFIG.replyToEmail]
      : [],
    Message: {
      Subject: {
        Data: c.subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
        ...(textBody
          ? {
              Text: {
                Data: textBody,
                Charset: "UTF-8",
              },
            }
          : {}),
      },
    },
  };

  const command = new SendEmailCommand(params);
  await sesClient.send(command);
}

/**
 * Send password reset email using SES.
 */
async function sendPasswordResetEmail({ to, name, resetUrl }) {
  if (!to) {
    throw new Error("sendPasswordResetEmail: 'to' is required");
  }
  if (!resetUrl) {
    throw new Error("sendPasswordResetEmail: 'resetUrl' is required");
  }

  const from = buildFrom();
  const c = EMAIL_CONFIG.passwordReset;

  const htmlBody = buildPasswordResetHtml({ name, resetUrl });
  const textBody = c.includeTextBody
    ? buildPasswordResetText({ name, resetUrl })
    : undefined;

  const params = {
    Source: from,
    Destination: {
      ToAddresses: [to],
    },
    ReplyToAddresses: EMAIL_CONFIG.replyToEmail
      ? [EMAIL_CONFIG.replyToEmail]
      : [],
    Message: {
      Subject: {
        Data: c.subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
        ...(textBody
          ? {
              Text: {
                Data: textBody,
                Charset: "UTF-8",
              },
            }
          : {}),
      },
    },
  };

  const command = new SendEmailCommand(params);
  await sesClient.send(command);
}

module.exports = {
  sendMagicLinkEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};