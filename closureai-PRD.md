# ClosureAI White Label — Product Requirements Document

**Generated:** December 23, 2024  
**Version:** 1.0 (MVP)  
**Timeline:** 2 weeks  
**Domain:** getclosureai.com

---

## 1. Executive Summary

ClosureAI White Label enables coaches to offer their clients/prospects a branded, AI-powered interaction tool that delivers quick wins while naturally guiding users toward paid offers. The platform handles all technical complexity—prompt engineering, branding, analytics—so coaches can focus on coaching.

**Business Model:** $2,495 setup + $97/month per Coach  
**Revenue Target:** 20 Clients in first 3 months (~600 end users)

---

## 2. Problem Statement

**Persona:** Wendy Fisher, life/spiritual coach at WendyLFisher.com. Her signature program is $6,000 for 6 months. She gets clients through networking but struggles with marketing. She's not technical and doesn't want to learn AI tools, build custom GPTs, or deal with "shiny object syndrome." She wants to help people, not fiddle with technology.

**Problem:** Coaches need a way to:
1. Give prospects immediate value (a "quick win") that demonstrates their methodology
2. Convert prospects into paying clients without aggressive sales tactics
3. Provide existing clients with a self-service tool between sessions
4. Access analytics on what their clients struggle with

**Current alternatives fail because:**
- ChatGPT requires coaches to learn prompt engineering
- Custom GPTs require ongoing maintenance and don't include analytics
- Generic chatbots don't capture the coach's unique voice/methodology
- No existing solution has built-in offer presentation logic

---

## 3. User Roles & Permissions

| Role | Description | Permissions |
|------|-------------|-------------|
| **User** | End user (prospect or client of Coach) | Use AI tool, view own sessions, manage own profile |
| **Client** | Coach who pays $2,495 + $97/mo | View their Users, view session data, configure offers/branding, connect Stripe |
| **Partner** | Affiliate who refers Coaches | View referral link, see referred Clients + status, view earnings |
| **Admin** | Platform owner (Keith + future VAs) | Full access: all Clients, Users, Partners, prompts, financials |

### Permission Details

**Users CAN:**
- Sign up / log in (Google OAuth or email/password)
- Start new AI sessions
- View their session history and transcripts
- Update profile (password, email preferences)
- Request account deletion

**Users CANNOT:**
- See other Users' data
- Access any Coach/Admin functionality
- Continue closed sessions (fresh start only)

**Clients (Coaches) CAN:**
- Complete onboarding (methodology, branding, payment)
- View their Users list
- View any User's session transcripts
- See aggregate stats (total users, sessions, avg turns, weekly/monthly activity)
- Configure interaction limits (default 6, max 8)
- Configure offers (midpoint, end CTA)
- Upload logo, set brand colors
- Connect their own Stripe keys (optional)
- Toggle paid access requirement for Users
- Manage User access status (active/inactive)

**Clients CANNOT:**
- View or edit their AI prompt (Admin only)
- See other Coaches' data
- Access Partner or Admin dashboards

**Partners CAN:**
- Sign up via hidden /partners route
- View their unique referral link
- See list of referred Clients (name, status, join date)
- View total earnings (setup + monthly commissions)

**Partners CANNOT:**
- See Client user data or session content
- Edit Client information
- Access Admin functionality

**Admins CAN:**
- Everything
- View/edit all Client prompts (with version history)
- Change Client and Partner statuses
- View platform-wide metrics
- Manage commissions

---

## 4. User Flows

### 4.1 User Registration & First Session

```
1. User arrives at coach-branded URL (wendy.getclosureai.com or wendylfisher.com/closure)
2. Sees branded landing page with value prop + Login/Signup
3. Signs up with Google OAuth or email/password
4. If email/password: receives verification email, must verify before continuing
5. After verification: lands on User dashboard (empty state)
6. Clicks "Start New Session"
7. Enters first message
8. AI responds (turn 1)
9. Conversation continues...
10. At turn 5: AI mentions upcoming wrap-up, soft reference to offer
11. At turn 6 (or configured limit): AI provides summary + presents end CTA
12. User can click "I'm Done" anytime to trigger early summary
13. Session closes, appears in history
14. User sees offer card at bottom of transcript (if Coach configured)
```

### 4.2 Client Onboarding

```
1. Coach visits getclosureai.com/onboard (or referred via Partner link)
2. Fills onboarding form:
   - Name, email, phone
   - Business name
   - Coaching niche
   - Target audience
   - Coaching methodology/philosophy (detailed text)
   - Coaching style/voice description
   - Bio
   - Logo upload
   - Primary/secondary brand colors
   - Desired subdomain (wendy.getclosureai.com)
   - Custom domain (optional, manual setup later)
3. Proceeds to payment ($2,495 setup via Stripe)
4. Payment succeeds → Status = "pending"
5. Admin receives notification
6. Admin crafts prompt from methodology, sets as active
7. Admin changes status to "active"
8. Coach receives "You're Live!" email with login link
9. Coach logs in to dashboard
```

### 4.3 Partner Referral Flow

```
1. Partner signs up at /partners (hidden route)
2. Receives unique referral link: getclosureai.com/onboard?ref=PARTNER_CODE
3. Shares link with coaches they certify
4. Coach signs up via that link
5. Partner ID attached to Client record
6. When Client pays setup: Commission calculated (partner's %, default 30%)
7. Commission record created (type: setup_fee, status: pending)
8. Monthly: When Client's subscription renews, monthly commission calculated
9. Admin manually pays Partners, marks commissions as paid
```

---

## 5. Feature Specifications

### 5.1 Core AI Interaction

**Description:** The heart of the product. A structured conversation between User and AI that delivers value while respecting boundaries.

**User Story:** As a User, I want to have a focused conversation about my challenges so that I get actionable insights without endless back-and-forth.

**Acceptance Criteria:**
- [ ] Conversation limited to configurable number of turns (default 6, max 8)
- [ ] Each turn = one User message + one AI response
- [ ] AI uses Coach's custom prompt (personality, methodology, voice)
- [ ] At turn N-1 (e.g., turn 5 of 6): AI naturally mentions session wrapping up
- [ ] At midpoint: Soft, inline mention of Coach's offer (helpful, not salesy)
- [ ] At final turn: AI provides session summary + presents end CTA
- [ ] User can click "I'm Done" button anytime to trigger summary early
- [ ] After close: Session locked, no continuation
- [ ] All turns stored individually for analytics

**Technical Notes:**
- Use OpenAI API with Coach's custom system prompt
- Store thread_id for conversation continuity within session
- Each interaction stored separately in interactions table
- Session summary generated via separate API call with full transcript context

**Edge Cases:**
- OpenAI rate limit: Show error, allow retry
- OpenAI down: Show friendly error message, log incident
- User rapid-fires messages: Debounce, process sequentially
- User opens multiple tabs: Session tied to single thread, last write wins

---

### 5.2 Offers System

**Description:** Configurable CTAs that appear during and after AI interactions.

**User Story:** As a Coach, I want to present relevant offers to Users at the right moment so that I convert engaged prospects.

**Acceptance Criteria:**
- [ ] Coach can configure multiple offers
- [ ] Each offer has: title, description, URL, CTA text, offer type
- [ ] Offer types: discovery_call, membership, program, resource
- [ ] Settings: show_inline (midpoint), show_at_wrapup (end), show_as_card (in transcript)
- [ ] Display order configurable
- [ ] Trigger keywords (optional): if User mentions keyword, offer becomes more relevant
- [ ] Offers can be active/inactive
- [ ] Midpoint offer = subtle inline mention by AI
- [ ] End offer = card UI below summary
- [ ] Transcript view: optional offer card at bottom (Coach configurable)

**Technical Notes:**
- Existing `offers` table structure is solid
- AI prompt includes active offer context for natural mentions
- Frontend renders offer cards based on configuration

---

### 5.3 User Dashboard

**Description:** Where Users see their session history and manage their account.

**Acceptance Criteria:**
- [ ] Header: User name, logout button
- [ ] Session list: Each shows first message as title, date, click to view
- [ ] "Start New Session" button (prominent)
- [ ] Empty state for new users: encouraging message + Start button
- [ ] Session detail view: full transcript, AI summary at top, offer card at bottom (if configured)
- [ ] Back to dashboard navigation
- [ ] Settings link: change password, email preferences, delete account

---

### 5.4 Client (Coach) Dashboard

**Description:** Where Coaches monitor their Users and configure their tool.

**Acceptance Criteria:**
- [ ] Overview stats:
  - Total Users
  - Total Sessions
  - Avg Turns per Session
  - Sessions This Week
  - Sessions This Month
- [ ] Users list: Name, email, join date, session count, last active, status toggle
- [ ] Filter users by name/email search
- [ ] Filter sessions by date range
- [ ] Click user → see their sessions
- [ ] Click session → see full transcript
- [ ] Settings section:
  - Branding: logo upload, primary/secondary colors
  - Interaction settings: turn limit (1-8 slider)
  - Offers management: CRUD for offers
  - Stripe settings: API keys (masked), toggle for charging Users
  - Domain info: current subdomain, custom domain instructions
- [ ] Profile: update name, email, phone, password

**Stats Calculations:**
- Avg Turns = SUM(turn_count) / COUNT(sessions)
- Sessions This Week = sessions WHERE created_at > NOW() - 7 days
- Sessions This Month = sessions WHERE created_at > NOW() - 30 days

---

### 5.5 Partner Dashboard

**Description:** Simple affiliate tracking for Partners.

**Acceptance Criteria:**
- [ ] Display unique referral link (copy button)
- [ ] Referred Clients list: name, status, join date
- [ ] Total earnings display (all-time)
- [ ] No access to Client user data or session content

---

### 5.6 Admin Dashboard

**Description:** Full platform management for Keith and future team.

**Acceptance Criteria:**
- [ ] Overview metrics:
  - Total MRR (active clients × $97)
  - Total Clients (by status breakdown)
  - Total Users (across all Clients)
  - Churn rate (cancelled / total in period)
  - LTV estimate (avg client lifetime × $97 + $2,495)
- [ ] Clients list:
  - All clients with status, joined date, payment status
  - Search/filter
  - Click → see their dashboard view (users, sessions, stats)
  - Status dropdown: pending, active, suspended, cancelled
  - Link to edit their prompt
- [ ] Partners list:
  - All partners with status, commission %, referral count
  - Status toggle (active/inactive)
  - Commissions owed (pending amounts)
- [ ] Financials:
  - Revenue by month (chart)
  - Setup fees collected
  - MRR trend
  - Commissions owed to Partners
- [ ] Prompt Management:
  - Select Client
  - View current active prompt
  - Edit and save (creates new version)
  - Version history (last 3 versions)
  - Set which version is active

---

### 5.7 Authentication System

**Description:** Unified auth for all user types.

**Acceptance Criteria:**
- [ ] Google OAuth for all roles
- [ ] Email/password option for all roles
- [ ] Email verification required for email/password signups
- [ ] Verification email clearly states requirement upfront
- [ ] Password reset flow (forgot password → email link → reset form)
- [ ] Password requirements: min 8 chars, 1 uppercase, 1 number
- [ ] Session duration: 24 hours default
- [ ] "Remember me" checkbox: extends to 30 days
- [ ] JWT-based sessions (existing implementation)
- [ ] Role detected from user record, redirects to appropriate dashboard
- [ ] Partner signup only via /partners (not linked from public pages)

---

### 5.8 User Export (CSV)

**Description:** Coaches can export their user list for import into their CRM.

**User Story:** As a Coach, I want to export my users to a CSV so I can import them into my CRM and follow up outside the platform.

**Acceptance Criteria:**
- [ ] Export button on Client dashboard (Users section)
- [ ] Generates CSV with: name, email, status, joined_date, last_session_date, total_sessions
- [ ] Filename: `closureai-users-YYYY-MM-DD.csv`
- [ ] Downloads immediately (no email delivery)
- [ ] Respects current filters (if user list is filtered, export only filtered results)

**Technical Notes:**
- Endpoint: `GET /api/client/users/export`
- Query joins users + sessions for aggregates
- Use `text/csv` content type with `Content-Disposition: attachment`

---

### 5.9 Custom Domains

**Description:** Coaches can have their tool on their own domain.

**Acceptance Criteria:**
- [ ] Default: subdomain on getclosureai.com (wendy.getclosureai.com)
- [ ] Optional: custom domain (closure.wendylfisher.com)
- [ ] Manual setup process (Admin configures nginx)
- [ ] Instructions provided to Coach for DNS setup (CNAME record)
- [ ] Wildcard SSL cert covers *.getclosureai.com
- [ ] Custom domains get individual SSL (Let's Encrypt)
- [ ] App detects domain → loads correct Client's branding/config

---

### 5.10 Payment Integration (Coach Charging Users)

**Description:** Coaches can optionally charge their Users using their own Stripe account.

**Acceptance Criteria:**
- [ ] Coach provides their Stripe API keys (secret + publishable)
- [ ] Keys stored encrypted in database
- [ ] Keys displayed masked in UI (sk_live_****1234)
- [ ] Toggle: "Require payment for User access"
- [ ] If toggle ON but no keys: blocked with message "Add Stripe keys to enable"
- [ ] If toggle ON with keys: Users see payment gate before first session
- [ ] Payment goes directly to Coach's Stripe (not platform)
- [ ] Coach manually manages User access (active/inactive toggle)
- [ ] Platform has no visibility into Coach's Stripe transactions

---

## 6. Data Model

### 6.1 Apps (Clients/Coaches)

Existing table with additions:

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| slug | varchar | URL-safe identifier |
| name | varchar | Coach's name |
| business_name | varchar | |
| email | varchar | unique |
| phone | varchar | |
| password_hash | varchar | nullable if OAuth only |
| google_id | varchar | nullable |
| email_verified | boolean | default false |
| logo_url | varchar | S3 URL |
| primary_color | varchar(7) | hex |
| secondary_color | varchar(7) | hex |
| subdomain | varchar | e.g., "wendy" |
| custom_domain | varchar | nullable |
| status | varchar | pending, active, suspended, cancelled |
| partner_id | uuid | FK to partners, nullable |
| stripe_customer_id | varchar | their subscription to us |
| stripe_subscription_id | varchar | |
| coach_stripe_secret_key | varchar | encrypted, for charging their users |
| coach_stripe_publishable_key | varchar | |
| charge_users | boolean | default false |
| coaching_niche | varchar | |
| coaching_style | text | |
| coach_bio | text | |
| target_audience | text | |
| onboarding_data | jsonb | full methodology capture |
| interaction_limit | int | default 6, max 8 |
| setup_paid_at | timestamp | |
| approved_at | timestamp | |
| suspended_at | timestamp | nullable |
| created_at | timestamp | |
| updated_at | timestamp | |

### 6.2 Users

Existing table with additions:

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| app_id | uuid | FK to apps |
| email | varchar | unique per app |
| name | varchar | |
| password_hash | varchar | nullable if OAuth only |
| google_id | varchar | nullable |
| email_verified | boolean | default false |
| status | varchar | active, inactive |
| ghl_contact_id | varchar | legacy, nullable |
| is_admin | boolean | default false |
| created_at | timestamp | |
| updated_at | timestamp | |

### 6.3 Sessions

Modified for summary:

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| app_id | uuid | FK |
| user_id | uuid | FK |
| thread_id | varchar | OpenAI thread ID |
| status | varchar | active, completed |
| turn_count | int | current turns |
| summary | text | AI-generated summary |
| closed_at | timestamp | nullable until closed |
| created_at | timestamp | |
| updated_at | timestamp | |

### 6.4 Interactions (NEW)

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| session_id | uuid | FK |
| turn_number | int | 1, 2, 3... |
| user_message | text | |
| ai_response | text | |
| offer_shown | varchar | nullable, which offer if any |
| tokens_used | int | for cost tracking |
| created_at | timestamp | |

### 6.5 Offers

Existing table is good:

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| app_id | uuid | FK |
| title | varchar | |
| description | text | |
| url | varchar | |
| offer_type | varchar | discovery_call, membership, program, resource |
| trigger_keywords | text | comma-separated |
| ai_mention_text | text | how AI should reference it |
| display_order | int | |
| is_active | boolean | |
| show_inline | boolean | midpoint |
| show_at_wrapup | boolean | end |
| show_as_card | boolean | in transcript view |
| cta_text | varchar | button text |
| created_at | timestamp | |
| updated_at | timestamp | |

### 6.6 Partners (NEW)

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| email | varchar | unique |
| name | varchar | |
| password_hash | varchar | nullable |
| google_id | varchar | nullable |
| email_verified | boolean | |
| referral_code | varchar | unique, URL-safe |
| commission_percent | decimal | default 30 |
| payment_method | varchar | "venmo:@handle" or "paypal:email" |
| status | varchar | active, inactive |
| created_at | timestamp | |
| updated_at | timestamp | |

### 6.7 Commissions (NEW)

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| partner_id | uuid | FK |
| client_id | uuid | FK to apps |
| type | varchar | setup_fee, monthly |
| amount | decimal | calculated |
| status | varchar | pending, paid |
| paid_at | timestamp | nullable |
| period_start | date | for monthly, which month |
| period_end | date | |
| created_at | timestamp | |

### 6.8 Prompts (NEW)

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| app_id | uuid | FK |
| version | int | 1, 2, 3... |
| prompt_text | text | the system prompt |
| is_active | boolean | only one active per app |
| created_by | uuid | admin user id |
| notes | text | admin notes about changes |
| created_at | timestamp | |

### 6.9 Password Reset Tokens (NEW)

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| user_type | varchar | user, client, partner |
| user_id | uuid | FK to respective table |
| token | varchar | unique, hashed |
| expires_at | timestamp | |
| used_at | timestamp | nullable |
| created_at | timestamp | |

---

## 7. API Endpoints

### Authentication

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | /api/auth/register | Email/password signup | No |
| POST | /api/auth/login | Email/password login | No |
| GET | /api/auth/google | Google OAuth initiate | No |
| GET | /api/auth/google/callback | Google OAuth callback | No |
| POST | /api/auth/verify-email | Verify email token | No |
| POST | /api/auth/forgot-password | Request reset email | No |
| POST | /api/auth/reset-password | Reset with token | No |
| POST | /api/auth/logout | End session | Yes |
| GET | /api/auth/me | Get current user | Yes |

### User (End User)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /api/user/sessions | List my sessions | User |
| POST | /api/user/sessions | Start new session | User |
| GET | /api/user/sessions/:id | Get session detail | User |
| POST | /api/user/sessions/:id/message | Send message | User |
| POST | /api/user/sessions/:id/close | Close session early | User |
| PUT | /api/user/profile | Update profile | User |
| DELETE | /api/user/account | Request deletion | User |

### Client (Coach)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /api/client/stats | Dashboard stats | Client |
| GET | /api/client/users | List users | Client |
| GET | /api/client/users/:id | User detail | Client |
| PUT | /api/client/users/:id/status | Toggle user status | Client |
| GET | /api/client/users/:id/sessions | User's sessions | Client |
| GET | /api/client/sessions/:id | Session detail | Client |
| GET | /api/client/offers | List offers | Client |
| POST | /api/client/offers | Create offer | Client |
| PUT | /api/client/offers/:id | Update offer | Client |
| DELETE | /api/client/offers/:id | Delete offer | Client |
| PUT | /api/client/settings | Update settings | Client |
| PUT | /api/client/branding | Update branding | Client |
| POST | /api/client/branding/logo | Upload logo | Client |
| PUT | /api/client/stripe | Update Stripe keys | Client |
| GET | /api/client/users/export | Download CSV export | Client |

### Partner

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /api/partner/referral-link | Get referral link | Partner |
| GET | /api/partner/referrals | List referred clients | Partner |
| GET | /api/partner/earnings | Total earnings | Partner |

### Admin

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | /api/admin/stats | Platform metrics | Admin |
| GET | /api/admin/clients | List all clients | Admin |
| GET | /api/admin/clients/:id | Client detail | Admin |
| PUT | /api/admin/clients/:id/status | Change status | Admin |
| GET | /api/admin/clients/:id/prompt | Get client prompt | Admin |
| PUT | /api/admin/clients/:id/prompt | Update prompt | Admin |
| GET | /api/admin/clients/:id/prompt/history | Prompt versions | Admin |
| GET | /api/admin/partners | List partners | Admin |
| PUT | /api/admin/partners/:id/status | Toggle status | Admin |
| GET | /api/admin/commissions | List commissions | Admin |
| PUT | /api/admin/commissions/:id/paid | Mark as paid | Admin |
| GET | /api/admin/financials | Revenue data | Admin |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /webhooks/stripe | Stripe events (subscription updates, payment failures, cancellations) |

**Required Stripe webhook events:**
- `invoice.payment_succeeded` — Mark payment current
- `invoice.payment_failed` — Log failure, dunning in progress
- `customer.subscription.deleted` — Suspend Client after dunning exhausted

---

### Special Records

**Global Anonymous Client:** A system `apps` record (id: `00000000-0000-0000-0000-000000000000` or similar) used for anonymized user data. When users request deletion, their PII is stripped and records reassigned here for aggregate analytics.

---

## 8. Security Requirements

### OWASP Top 10 Compliance

| Risk | Mitigation |
|------|------------|
| Injection | Parameterized queries (pg library), input validation |
| Broken Auth | JWT with httpOnly cookies, secure password hashing (bcrypt), rate limiting on auth endpoints |
| Sensitive Data Exposure | HTTPS everywhere, encrypt Stripe keys at rest, mask keys in UI |
| XXE | Not applicable (no XML processing) |
| Broken Access Control | Role-based middleware, verify ownership on all resource access |
| Security Misconfiguration | Environment variables for secrets, security headers (helmet.js) |
| XSS | Output encoding, CSP headers, sanitize user input |
| Insecure Deserialization | Validate JSON structure, no eval() |
| Using Components with Known Vulnerabilities | Regular npm audit, keep dependencies updated |
| Insufficient Logging | Log auth events, admin actions, errors to CloudWatch |

### Additional Security

- Rate limiting on all API endpoints
- CORS configured for specific domains
- Stripe keys stored encrypted (AES-256)
- Password requirements enforced
- Session invalidation on password change
- CSRF protection on forms
- File upload validation (logo: image types only, max 2MB)

---

## 9. Compliance

### GDPR (EU Users)

- [ ] Cookie consent banner
- [ ] Privacy policy with data processing details
- [ ] Right to access: User can view their data
- [ ] Right to deletion: User can request account deletion
- [ ] Data portability: Export user data on request
- [ ] Clear consent language during signup

### International Coaches

- [ ] Terms of Service updated for international use
- [ ] Data processing addendum available
- [ ] Clear statement of data storage location (US - AWS us-east-2)

---

## 10. Non-Functional Requirements

### Performance
- Page load: < 2 seconds
- API response: < 500ms (non-AI endpoints)
- AI response: < 10 seconds (OpenAI dependent)

### Availability
- Target: 99.5% uptime
- Single EC2 instance acceptable for MVP scale
- RDS handles database reliability

### Scale
- Launch: 20 Clients, ~600 Users
- Year 1: 100 Clients, ~3,000 Users
- PostgreSQL + single EC2 handles this comfortably

### Monitoring
- PM2 for process management
- CloudWatch for basic EC2 metrics
- Application-level error logging
- V2: Sentry for error tracking

---

## 11. Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                               │
│  (Browsers: Users, Coaches, Partners, Admin)                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     NGINX (EC2)                              │
│  - SSL termination (wildcard + custom certs)                │
│  - Subdomain routing                                         │
│  - Static file serving                                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   EXPRESS APP (PM2)                          │
│  - API routes                                                │
│  - Authentication (JWT)                                      │
│  - Business logic                                            │
│  - View rendering (HTML templates)                           │
└─────────────────────────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │    OpenAI    │ │     AWS      │ │    Stripe    │
│    (RDS)     │ │     API      │ │  SES + S3    │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

### Tech Stack
- **Runtime:** Node.js + Express 5
- **Frontend:** Server-rendered HTML + vanilla JS + CSS
- **Database:** PostgreSQL 15 (RDS)
- **Auth:** JWT (httpOnly cookies) + Google OAuth + bcrypt
- **AI:** OpenAI API (GPT-4)
- **Email:** AWS SES
- **Files:** AWS S3
- **Payments:** Stripe
- **Process Manager:** PM2
- **Web Server:** nginx
- **Hosting:** AWS EC2 (us-east-2)

---

## 12. MVP Scope

### In Scope (Ship in 2 weeks)

**Authentication:**
- [ ] Email/password signup + login
- [ ] Google OAuth signup + login
- [ ] Email verification flow
- [ ] Password reset flow
- [ ] Role-based redirects

**User Features:**
- [ ] Branded landing page per Coach
- [ ] Core AI interaction (configurable turns)
- [ ] Session summary on close
- [ ] "I'm Done" early close
- [ ] Session history dashboard
- [ ] Transcript view with offers

**Client Features:**
- [ ] Onboarding form (capture methodology)
- [ ] Payment gate ($2,495 setup)
- [ ] Dashboard with stats
- [ ] Users list + session drill-down
- [ ] User CSV export
- [ ] Offers CRUD
- [ ] Branding settings (logo, colors)
- [ ] Interaction limit config
- [ ] Stripe keys + charge toggle

**Partner Features:**
- [ ] Signup via /partners
- [ ] Referral link
- [ ] Basic dashboard (referrals + earnings)

**Admin Features:**
- [ ] Metrics overview
- [ ] Clients list + status management
- [ ] Partners list + status management
- [ ] Prompt management (edit + 3 versions)
- [ ] Commissions tracking

**Infrastructure:**
- [ ] Subdomain routing (*.getclosureai.com)
- [ ] Custom domain support (manual nginx)
- [ ] S3 logo upload
- [ ] Interactions table (per-turn storage)

### Out of Scope (V2+)

- [ ] Multi-user teams for Coaches
- [ ] Admin impersonation (view as Client/User)
- [ ] Automated Partner payouts
- [ ] Webhook integration with Coach's Stripe
- [ ] Dev/staging environments
- [ ] Advanced analytics (cohort analysis, etc.)
- [ ] Mobile app
- [ ] API for third-party integrations

---

## 13. Resolved Decisions

| Question | Decision |
|----------|----------|
| Grace period on failed payment | 7 days. Stripe Smart Retries + dunning enabled. Handle `customer.subscription.deleted` webhook. |
| Data retention on cancellation | 90 days, unless compliance requires different (e.g., GDPR deletion request) |
| User deletion requests | Anonymize and reassign to "global/anonymous client" — preserves aggregate data while removing PII. Document in privacy policy. |
| Prompt template | Use existing `config/promptsConfig.js` as starting framework |

---

## 14. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| OpenAI API changes/pricing | Medium | High | Abstract AI calls, monitor costs |
| Coach prompt quality varies | High | Medium | Create prompt guidelines, review before go-live |
| Custom domain DNS issues | Medium | Low | Clear instructions, offer to do it for them |
| Partner disputes over commissions | Low | Medium | Clear terms, audit trail |
| Security breach | Low | Critical | OWASP compliance, regular audits |
| Stripe account issues (Coach's) | Medium | Low | Their problem, we just store keys |

---

## Appendix A: Database Migrations Needed

```sql
-- 001_add_auth_fields.sql
ALTER TABLE apps ADD COLUMN password_hash VARCHAR;
ALTER TABLE apps ADD COLUMN google_id VARCHAR;
ALTER TABLE apps ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE apps ADD COLUMN coach_stripe_secret_key VARCHAR;
ALTER TABLE apps ADD COLUMN coach_stripe_publishable_key VARCHAR;
ALTER TABLE apps ADD COLUMN charge_users BOOLEAN DEFAULT FALSE;
ALTER TABLE apps ADD COLUMN interaction_limit INT DEFAULT 6;

ALTER TABLE users ADD COLUMN password_hash VARCHAR;
ALTER TABLE users ADD COLUMN google_id VARCHAR;
ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN status VARCHAR DEFAULT 'active';

-- 002_create_partners.sql
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR UNIQUE NOT NULL,
  name VARCHAR NOT NULL,
  password_hash VARCHAR,
  google_id VARCHAR,
  email_verified BOOLEAN DEFAULT FALSE,
  referral_code VARCHAR UNIQUE NOT NULL,
  commission_percent DECIMAL DEFAULT 30,
  payment_method VARCHAR,
  status VARCHAR DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 003_create_commissions.sql
CREATE TABLE commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID REFERENCES partners(id),
  client_id UUID REFERENCES apps(id),
  type VARCHAR NOT NULL,
  amount DECIMAL NOT NULL,
  status VARCHAR DEFAULT 'pending',
  paid_at TIMESTAMP,
  period_start DATE,
  period_end DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 004_create_interactions.sql
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  turn_number INT NOT NULL,
  user_message TEXT NOT NULL,
  ai_response TEXT NOT NULL,
  offer_shown VARCHAR,
  tokens_used INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 005_create_prompts.sql
CREATE TABLE prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id),
  version INT NOT NULL,
  prompt_text TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  created_by UUID,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Migrate existing prompts
INSERT INTO prompts (app_id, version, prompt_text, is_active, created_at)
SELECT id, 1, custom_system_prompt, TRUE, NOW()
FROM apps
WHERE custom_system_prompt IS NOT NULL;

-- 006_create_password_reset_tokens.sql
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type VARCHAR NOT NULL,
  user_id UUID NOT NULL,
  token VARCHAR UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 007_add_session_summary.sql
ALTER TABLE sessions ADD COLUMN summary TEXT;
ALTER TABLE sessions ADD COLUMN closed_at TIMESTAMP;
```

---

## Appendix B: Environment Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:5432/closureai

# Auth
JWT_SECRET=your-secret-key
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://getclosureai.com/api/auth/google/callback

# Stripe (Platform)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# AWS
AWS_REGION=us-east-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_S3_BUCKET=closureai-uploads
AWS_SES_FROM_EMAIL=noreply@getclosureai.com

# OpenAI
OPENAI_API_KEY=sk-...

# App
NODE_ENV=production
BASE_URL=https://getclosureai.com
PORT=3000

# Encryption (for storing Coach Stripe keys)
ENCRYPTION_KEY=32-byte-hex-key
```
