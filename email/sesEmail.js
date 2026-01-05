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

/**
 * HTML template for lead notification email to coach.
 */
function buildLeadNotificationHtml({ coachName, userName, userEmail, businessName, dashboardUrl }) {
  const safeCoachName = coachName || "Coach";
  const safeUserName = userName || "Not provided";
  const safeBusinessName = businessName || "Your Coaching App";
  const signedUpDate = new Date().toLocaleString();

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>New Lead for ${safeBusinessName}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #f9fafb;
          color: #1f2937;
        }
        .wrapper {
          width: 100%;
          padding: 32px 0;
        }
        .card {
          max-width: 600px;
          margin: 0 auto;
          padding: 28px 24px;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
          border: 1px solid #e5e7eb;
        }
        h2 {
          font-size: 22px;
          margin: 0 0 16px;
          color: #0d9488;
        }
        p {
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 12px;
        }
        .info-box {
          background: #f3f4f6;
          padding: 16px;
          border-radius: 8px;
          margin: 24px 0;
        }
        .info-box p {
          margin: 0 0 8px;
        }
        .info-box p:last-child {
          margin: 0;
        }
        .btn {
          display: inline-block;
          margin-top: 16px;
          padding: 12px 24px;
          border-radius: 6px;
          background: #0d9488;
          color: #ffffff !important;
          font-weight: 600;
          font-size: 14px;
          text-decoration: none;
        }
        .footer {
          font-size: 12px;
          color: #6b7280;
          margin-top: 32px;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <h2>New Lead for ${safeBusinessName}</h2>
          <p>Hey ${safeCoachName},</p>
          <p>Someone just signed up for your AI coaching tool!</p>
          <div class="info-box">
            <p><strong>Name:</strong> ${safeUserName}</p>
            <p><strong>Email:</strong> ${userEmail}</p>
            <p><strong>Signed up:</strong> ${signedUpDate}</p>
          </div>
          <p>
            <a href="${dashboardUrl}" class="btn" target="_blank" rel="noopener noreferrer">
              View Your Dashboard
            </a>
          </p>
          <p class="footer">
            &mdash; ClosureAI
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

/**
 * Plain-text fallback for lead notification email.
 */
function buildLeadNotificationText({ coachName, userName, userEmail, businessName, dashboardUrl }) {
  const safeCoachName = coachName || "Coach";
  const safeUserName = userName || "Not provided";
  const safeBusinessName = businessName || "Your Coaching App";
  const signedUpDate = new Date().toLocaleString();

  return [
    `New Lead for ${safeBusinessName}`,
    "",
    `Hey ${safeCoachName},`,
    "",
    "Someone just signed up for your AI coaching tool!",
    "",
    `Name: ${safeUserName}`,
    `Email: ${userEmail}`,
    `Signed up: ${signedUpDate}`,
    "",
    `View your dashboard: ${dashboardUrl}`,
    "",
    "— ClosureAI",
  ].join("\n");
}

/**
 * Send lead notification email to coach when new user signs up.
 */
async function sendLeadNotificationEmail({
  coachEmail,
  coachName,
  userName,
  userEmail,
  businessName,
  dashboardUrl,
}) {
  if (!coachEmail) {
    throw new Error("sendLeadNotificationEmail: 'coachEmail' is required");
  }
  if (!userEmail) {
    throw new Error("sendLeadNotificationEmail: 'userEmail' is required");
  }

  const from = buildFrom();
  const subject = `New lead: ${userName || userEmail}`;

  const htmlBody = buildLeadNotificationHtml({
    coachName,
    userName,
    userEmail,
    businessName,
    dashboardUrl,
  });
  const textBody = buildLeadNotificationText({
    coachName,
    userName,
    userEmail,
    businessName,
    dashboardUrl,
  });

  const params = {
    Source: from,
    Destination: {
      ToAddresses: [coachEmail],
    },
    ReplyToAddresses: EMAIL_CONFIG.replyToEmail
      ? [EMAIL_CONFIG.replyToEmail]
      : [],
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
        Text: {
          Data: textBody,
          Charset: "UTF-8",
        },
      },
    },
  };

  const command = new SendEmailCommand(params);
  await sesClient.send(command);
}

/**
 * HTML template for coach welcome/approval email.
 */
function buildCoachWelcomeHtml({ coachName, businessName, subdomain, customDomain, dashboardUrl }) {
  const safeCoachName = coachName || "Coach";
  const safeBusinessName = businessName || "Your Coaching App";

  // Determine the app URL
  let appUrl;
  if (customDomain) {
    appUrl = `https://${customDomain}`;
  } else {
    appUrl = `https://${subdomain}.getclosureai.com`;
  }

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Your ClosureAI App is Live!</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background: #f9fafb;
          color: #1f2937;
        }
        .wrapper {
          width: 100%;
          padding: 32px 0;
        }
        .card {
          max-width: 600px;
          margin: 0 auto;
          padding: 32px;
          border-radius: 16px;
          background: #ffffff;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
          border: 1px solid #e5e7eb;
        }
        .logo {
          text-align: center;
          margin-bottom: 24px;
        }
        .logo span {
          font-size: 28px;
          font-weight: bold;
          color: #0d9488;
        }
        h1 {
          font-size: 24px;
          margin: 0 0 16px;
          color: #0d9488;
        }
        h2 {
          font-size: 16px;
          margin: 24px 0 8px;
          color: #374151;
        }
        p {
          font-size: 15px;
          line-height: 1.6;
          margin: 0 0 16px;
        }
        .url-box {
          background: #f3f4f6;
          padding: 16px;
          border-radius: 8px;
          margin: 16px 0;
          font-family: monospace;
          font-size: 14px;
          word-break: break-all;
        }
        .url-box a {
          color: #0d9488;
          text-decoration: none;
        }
        .btn {
          display: inline-block;
          margin-top: 16px;
          padding: 14px 28px;
          border-radius: 8px;
          background: #0d9488;
          color: #ffffff !important;
          font-weight: 600;
          font-size: 15px;
          text-decoration: none;
        }
        .steps {
          background: #f0fdfa;
          padding: 20px;
          border-radius: 8px;
          margin: 24px 0;
          border-left: 4px solid #0d9488;
        }
        .steps ol {
          margin: 0;
          padding-left: 20px;
        }
        .steps li {
          margin-bottom: 8px;
        }
        .footer {
          font-size: 13px;
          color: #6b7280;
          margin-top: 32px;
          padding-top: 24px;
          border-top: 1px solid #e5e7eb;
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <div class="logo">
            <span>ClosureAI</span>
          </div>

          <h1>Your AI Coaching App is Live!</h1>

          <p>Hi ${safeCoachName},</p>

          <p>Great news — <strong>${safeBusinessName}</strong> is now live and ready to start generating leads!</p>

          <h2>Your App URL</h2>
          <div class="url-box">
            <a href="${appUrl}">${appUrl}</a>
          </div>
          <p style="font-size: 13px; color: #6b7280;">Share this link with your audience. When they visit, they'll see your branded landing page and can sign up for a free coaching session.</p>

          <h2>Your Dashboard</h2>
          <div class="url-box">
            <a href="${dashboardUrl}">${dashboardUrl}</a>
          </div>
          <p style="font-size: 13px; color: #6b7280;">Log in with Google or the email you registered with to manage your app, view leads, and update settings.</p>

          <div class="steps">
            <strong>What to do next:</strong>
            <ol>
              <li>Log into your dashboard and review your branding</li>
              <li>Set up your offers (the products/services you want to promote)</li>
              <li>Test your app by running through a coaching session yourself</li>
              <li>Share your link with clients and on social media!</li>
            </ol>
          </div>

          <h2>Getting Leads</h2>
          <p>When someone signs up on your app, you'll receive an email notification with their contact info. You can also export all leads from your dashboard at any time.</p>

          <p style="text-align: center;">
            <a href="${dashboardUrl}" class="btn">Go to Your Dashboard</a>
          </p>

          <p class="footer">
            Need help? Just reply to this email and we'll get back to you.<br><br>
            Welcome aboard!<br>
            — Keith
          </p>
        </div>
      </div>
    </body>
  </html>
  `;
}

/**
 * Plain-text fallback for coach welcome email.
 */
function buildCoachWelcomeText({ coachName, businessName, subdomain, customDomain, dashboardUrl }) {
  const safeCoachName = coachName || "Coach";
  const safeBusinessName = businessName || "Your Coaching App";

  let appUrl;
  if (customDomain) {
    appUrl = `https://${customDomain}`;
  } else {
    appUrl = `https://${subdomain}.getclosureai.com`;
  }

  return [
    `Your AI Coaching App is Live!`,
    "",
    `Hi ${safeCoachName},`,
    "",
    `Great news — ${safeBusinessName} is now live and ready to start generating leads!`,
    "",
    "YOUR APP URL:",
    appUrl,
    "(Share this with your audience)",
    "",
    "YOUR DASHBOARD:",
    dashboardUrl,
    "(Log in with Google or your registered email)",
    "",
    "WHAT TO DO NEXT:",
    "1. Log into your dashboard and review your branding",
    "2. Set up your offers (the products/services you want to promote)",
    "3. Test your app by running through a coaching session yourself",
    "4. Share your link with clients and on social media!",
    "",
    "GETTING LEADS:",
    "When someone signs up on your app, you'll receive an email notification",
    "with their contact info. You can also export all leads from your dashboard.",
    "",
    "Need help? Just reply to this email.",
    "",
    "Welcome aboard!",
    "— Keith",
  ].join("\n");
}

/**
 * Send welcome email to coach when their app is approved.
 */
async function sendCoachWelcomeEmail({
  coachEmail,
  coachName,
  businessName,
  subdomain,
  customDomain,
}) {
  if (!coachEmail) {
    throw new Error("sendCoachWelcomeEmail: 'coachEmail' is required");
  }
  if (!subdomain && !customDomain) {
    throw new Error("sendCoachWelcomeEmail: either 'subdomain' or 'customDomain' is required");
  }

  const from = buildFrom();
  const subject = `Your ${businessName || "ClosureAI"} coaching app is live!`;

  // Build dashboard URL
  let dashboardUrl;
  if (customDomain) {
    dashboardUrl = `https://${customDomain}/my-app`;
  } else {
    dashboardUrl = `https://${subdomain}.getclosureai.com/my-app`;
  }

  const htmlBody = buildCoachWelcomeHtml({
    coachName,
    businessName,
    subdomain,
    customDomain,
    dashboardUrl,
  });
  const textBody = buildCoachWelcomeText({
    coachName,
    businessName,
    subdomain,
    customDomain,
    dashboardUrl,
  });

  const params = {
    Source: from,
    Destination: {
      ToAddresses: [coachEmail],
    },
    ReplyToAddresses: EMAIL_CONFIG.replyToEmail
      ? [EMAIL_CONFIG.replyToEmail]
      : [],
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: "UTF-8",
        },
        Text: {
          Data: textBody,
          Charset: "UTF-8",
        },
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
  sendLeadNotificationEmail,
  sendCoachWelcomeEmail,
};