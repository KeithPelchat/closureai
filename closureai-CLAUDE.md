# CLAUDE.md — ClosureAI White Label

> Project instructions for Claude Code. Read this first before any task.

## Project Overview

ClosureAI White Label is a B2B SaaS platform enabling coaches to offer branded AI-powered interaction tools to their clients/prospects. Coaches pay $2,495 setup + $97/month. The AI delivers structured conversations (6-8 turns) that provide quick wins while naturally presenting offers.

**Key differentiators:**
- Done-for-them (no AI learning curve for coaches)
- Structured interactions (not endless chatbot)
- Built-in offer presentation logic
- Coach analytics on user behavior

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js + Express 5 |
| Frontend | Server-rendered HTML + vanilla JS |
| Styling | Plain CSS (no framework) |
| Database | PostgreSQL 15 (AWS RDS) |
| Auth | JWT (httpOnly cookies) + Google OAuth + bcrypt |
| AI | OpenAI API |
| Email | AWS SES |
| Files | AWS S3 |
| Payments | Stripe |
| Hosting | AWS EC2 + nginx + PM2 |

## Project Structure

```
closureai/
├── closureai.js          # Main Express app entry point
├── db.js                 # PostgreSQL connection
├── config/
│   ├── appConfig.js      # App-wide settings
│   ├── emailConfig.js    # SES configuration
│   ├── promptsConfig.js  # AI prompt templates
│   ├── stripeConfig.js   # Stripe setup
│   └── uiConfig.js       # UI defaults
├── controllers/          # Route handlers (currently empty, logic in routes)
├── middleware/           # Auth, validation middleware
├── routes/               # Express routes (currently in closureai.js)
├── email/
│   └── sesEmail.js       # Email sending utilities
├── utils/                # Helper functions
├── views/                # HTML templates
│   ├── admin/            # Admin dashboard views
│   ├── platform/         # Client (Coach) dashboard views
│   ├── onboard/          # Client onboarding flow
│   ├── errors/           # Error pages
│   └── *.html            # User-facing views
├── public/
│   ├── css/              # Stylesheets
│   ├── js/               # Client-side JavaScript
│   ├── icons/            # PWA icons
│   └── videos/           # Demo videos
├── scripts/
│   └── migrations/       # SQL migration files
└── assets/               # Source assets (logos, etc.)
```

## Database Schema

**Key tables:**
- `apps` — Coaches (clients who pay us)
- `users` — End users (clients of coaches)
- `sessions` — AI conversation sessions
- `interactions` — Individual turns within sessions (NEW)
- `offers` — CTAs configured per coach
- `partners` — Affiliates (NEW)
- `commissions` — Partner earnings tracking (NEW)
- `prompts` — Versioned AI prompts per coach (NEW)
- `magic_links` — Legacy auth (being replaced)
- `password_reset_tokens` — Password reset flow (NEW)

**Relationships:**
- `users` belong to ONE `apps` (via app_id)
- `sessions` belong to `users` AND `apps`
- `interactions` belong to `sessions`
- `offers` belong to `apps`
- `commissions` link `partners` to `apps`
- `prompts` belong to `apps` (multiple versions, one active)

## Coding Standards

### JavaScript
- ES6+ syntax (async/await, arrow functions, destructuring)
- No semicolons (project style)
- Single quotes for strings
- 2-space indentation
- Use `const` by default, `let` when reassignment needed

### SQL
- Parameterized queries ONLY (prevent injection)
- Use `pg` library's `$1, $2` syntax
- Lowercase table and column names
- Snake_case for multi-word names

### HTML Templates
- Keep logic minimal in templates
- Pass data from routes, render in views
- Use consistent class naming (BEM-ish)

### API Responses
```javascript
// Success
res.json({ success: true, data: { ... } })

// Error
res.status(400).json({ success: false, error: 'Message here' })
```

### Error Handling
```javascript
try {
  // operation
} catch (error) {
  console.error('Context:', error)
  res.status(500).json({ success: false, error: 'Something went wrong' })
}
```

## Authentication Pattern

JWT stored in httpOnly cookie:

```javascript
// Setting token
res.cookie('token', jwt.sign(payload, process.env.JWT_SECRET), {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
})

// Middleware check
const token = req.cookies.token
const decoded = jwt.verify(token, process.env.JWT_SECRET)
req.user = decoded
```

**User types in JWT payload:**
- `type: 'user'` — End user
- `type: 'client'` — Coach
- `type: 'partner'` — Affiliate
- `type: 'admin'` — Platform admin (is_admin flag on users table)

## Key Patterns

### Database Queries
```javascript
const { rows } = await db.query(
  'SELECT * FROM apps WHERE id = $1',
  [appId]
)
const app = rows[0]
```

### Multi-tenant Routing
App detection by subdomain/domain:
```javascript
const host = req.hostname
let app

// Check custom domain first
app = await getAppByCustomDomain(host)

// Then check subdomain
if (!app) {
  const subdomain = host.split('.')[0]
  app = await getAppBySubdomain(subdomain)
}

req.app = app
```

### OpenAI Integration
```javascript
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { role: 'system', content: activePrompt.prompt_text },
    ...conversationHistory
  ],
  max_tokens: 1000
})
```

## Common Commands

```bash
# Start development (with auto-reload)
pm2 start closureai.js --watch

# Start production
pm2 start closureai.js --name closureai

# View logs
pm2 logs closureai

# Restart
pm2 restart closureai

# Run migration
psql $DATABASE_URL -f scripts/migrations/XXX_name.sql

# Connect to database
psql $DATABASE_URL
```

## Environment Variables

Required in `.env`:
```
DATABASE_URL=
JWT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=
AWS_SES_FROM_EMAIL=
OPENAI_API_KEY=
BASE_URL=
ENCRYPTION_KEY=
```

## Current Focus: MVP Completion

### Priority 1: Auth Upgrade
- [ ] Add email/password registration
- [ ] Add email verification flow
- [ ] Add password reset flow
- [ ] Keep Google OAuth working
- [ ] Unify auth for all user types

### Priority 2: Data Model Updates
- [ ] Run migrations for new tables
- [ ] Create interactions table (break out from sessions)
- [ ] Create partners table
- [ ] Create commissions table
- [ ] Create prompts table with versioning
- [ ] Add new fields to apps and users

### Priority 3: Partner System
- [ ] Partner signup (/partners route)
- [ ] Partner dashboard
- [ ] Referral link generation
- [ ] Commission auto-calculation on Client payment
- [ ] Admin commission management

### Priority 4: Client Features
- [ ] Complete onboarding form
- [ ] Client dashboard with stats
- [ ] Stripe keys storage (encrypted)
- [ ] User charging toggle
- [ ] Branding settings (logo upload to S3)

### Priority 5: Admin Features
- [ ] Prompt management with versioning
- [ ] Platform metrics
- [ ] Partner management
- [ ] Commission tracking

### Priority 6: User Features
- [ ] Session summary generation
- [ ] Individual interaction storage
- [ ] "I'm Done" early close
- [ ] Improved session history UI

## Security Checklist

**ALWAYS:**
- [ ] Parameterized queries (never string concatenation)
- [ ] Validate and sanitize all input
- [ ] Check ownership before returning data
- [ ] Use httpOnly cookies for tokens
- [ ] Hash passwords with bcrypt (cost 12)
- [ ] Encrypt sensitive data (Stripe keys)
- [ ] Rate limit auth endpoints

**NEVER:**
- [ ] Log sensitive data (passwords, tokens, keys)
- [ ] Return stack traces to client
- [ ] Trust client-side data without validation
- [ ] Use eval() or similar
- [ ] Store plaintext passwords
- [ ] Expose internal IDs unnecessarily

## Known Issues / Tech Debt

1. **Routes in main file:** Most routes are in `closureai.js`. Should be split into route modules.

2. **Magic links:** Legacy auth system. Being replaced with email/password + OAuth.

3. **Sessions blob storage:** Currently stores `raw_output` and `cleaned_output` as blobs. Migrating to individual `interactions` records.

4. **No input validation library:** Currently manual. Consider adding Joi or express-validator.

5. **CSS organization:** Multiple CSS files, some overlap. Could consolidate.

## DO NOT

- **Do not** change the Express 5 setup or switch to a different framework
- **Do not** add React or other frontend frameworks
- **Do not** change the database from PostgreSQL
- **Do not** expose the prompt text to Clients (it's protected IP)
- **Do not** store unencrypted Stripe keys
- **Do not** allow Users to access other Users' sessions
- **Do not** allow Clients to access other Clients' data
- **Do not** skip email verification for email/password signups

## Helpful Context

- **Wendy Fisher** is the reference client (life coach, WendyLFisher.com)
- **Greg Pihs** is a potential Partner who certifies coaches
- Keith manages multiple domains and can handle DNS setup manually
- The goal is revenue in 2 weeks — ship fast, iterate later
- Coaches are NOT technical — UI must be dead simple
- The AI prompt is the core IP — never expose to clients

## Testing Approach (MVP)

Manual testing for now:
1. Test each user flow end-to-end
2. Test edge cases (payment fails, API down, etc.)
3. Test multi-tenant isolation (Coach A can't see Coach B's data)
4. Test auth flows (login, logout, token expiry)

Automated tests in V2.

## Deployment

```bash
# SSH to EC2
ssh ec2-user@<ip>

# Pull latest
cd closureai
git pull origin main

# Install deps if package.json changed
npm install

# Run any new migrations
psql $DATABASE_URL -f scripts/migrations/XXX.sql

# Restart
pm2 restart closureai

# Check logs
pm2 logs closureai --lines 50
```

## Questions for Keith

Before starting a task, ask if unclear about:
1. Business logic (how should X work?)
2. UI/UX preferences (what should it look like?)
3. Priority (is this MVP or V2?)
4. Existing code (is there something I should reuse?)
