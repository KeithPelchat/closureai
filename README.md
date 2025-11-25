# ClosureAI

This repo contains the ClosureAI app, which is also the base template
for DFY micro-app builds (primarily for coaches).

## Branches

- `main` – current production / live version.
- `template-refactor` – in-progress work to turn ClosureAI into a reusable micro-app template.

## High-level structure

- `closureai.js` – main Express server (will become more modular).
- `config/` – app-level config (will be expanded for branding, prompts, Stripe, email).
- `views/` – HTML views (session, dashboard, legal, marketing).
- `public/` – static assets, JS, CSS, service worker.
- `assets/` – brand-specific graphics.

