# ClosureAI Micro-App Template – Setup Checklist

When you create a new micro-app from this template, follow **all** of these steps.

---

## 1. Create a new repo from this template

1. On GitHub, open this repo.
2. Go to **Settings → General**.
3. Under **Template repository**, check **“Template repository”** and save.
4. Return to the main repo page.
5. Click **“Use this template” → “Create a new repository”**.
6. Name it something like:
   - `coach-sarah-clarity`
   - `closureai-coachname`

---

## 2. Clone and create your `.env`

```bash
git clone git@github.com:YOUR_USER/YOUR_NEW_REPO.git
cd YOUR_NEW_REPO
cp .env.template .env
```

Then open `.env` and update at minimum:

### Required App Values
- `APP_ID` – unique ID for this app (e.g. `coach-sarah-clarity`)
- `APP_NAME` – user-facing name (e.g. `Sarah's Clarity Studio`)
- `APP_BASE_URL` – where the app is deployed (e.g. `https://app.sarahclarity.com`)
- `COACH_NAME` – coach's name
- `SUPPORT_EMAIL` – support address for the app

### Required External Services
- `OPENAI_API_KEY` – from OpenAI dashboard  
- `STRIPE_SECRET_KEY` – from Stripe  
- `STRIPE_PRICE_ID` – the price ID for this app  
- `STRIPE_WEBHOOK_SECRET` – from Stripe webhook settings  
- `JWT_SECRET` – long random string (generate with `openssl rand -hex 32`)  
- `AWS_REGION` – usually `us-east-1`  
- `EMAIL_FROM_EMAIL` – must be SES-verified  
- `EMAIL_REPLY_TO` – optional, defaults to support

### Optional UI Text Overrides
You can override default UI text using:

- `UI_APP_TAGLINE`
- `UI_LOGIN_HEADLINE`
- `UI_LOGIN_SUBHEADLINE`
- `UI_SESSION_TITLE`
- `UI_SESSION_INTRO`
- `UI_DASHBOARD_*`
- `UI_HOLIDAY_*`

(All defaults are in `config/uiConfig.js`.)

---

## 3. Update assets (optional but recommended)

To customize branding, update these files:

- `assets/closureai-logo-tpx.png`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`

Or adjust their paths in:

- `config/appConfig.js`
- `.env` (`APP_LOGO`, `APP_ICON_192`)

---

## 4. Configure Stripe

In your Stripe account:

1. Create a **Product** and **Price** for this micro-app.
2. Put these values in `.env`:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID`
3. Add a webhook endpoint:

```
APP_BASE_URL/stripe/webhook
```

4. Copy the webhook signing secret to `.env` as:

```
STRIPE_WEBHOOK_SECRET
```

---

## 5. Test email (SES)

Before deploying, ensure:

- `EMAIL_FROM_EMAIL` or your whole domain is verified in SES.
- IAM permissions allow `ses:SendEmail`.
- Your region (`AWS_REGION`) matches your SES settings.

Then test:

```bash
curl "https://YOUR_APP_BASE_URL/test/email?to=you@example.com"
```

Verify the magic-link email arrives and displays correctly.

---

## 6. Deploy

Deploy as you normally do (PM2, systemd, Docker, etc.):

1. Copy repo to the server.
2. Create `.env` on the server (never commit secrets).
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
node closureai.js
```

Or via PM2:

```bash
pm2 start closureai.js --name "closureai-microapp"
```

### Confirm everything works:

- `/health` returns JSON:  
  `{ "status": "ok", "app": "ClosureAI" }`
- `/login` loads
- Stripe checkout works end-to-end
- Magic link login email arrives and authenticates properly

---

## 7. Optional: per-coach prompt customization

If a coach’s use case differs from the default “Holiday Sanity Pass”:

- Update `config/promptsConfig.js` with a new system prompt variant.
- Optionally expose a `PROMPT_PROFILE` in `.env` to switch prompts dynamically.

**Always maintain the required safety rails:**

- No therapy/medical/legal/crisis advice  
- Crisis routing instructions remain in place  
- Boundaries against diagnoses or labels  
