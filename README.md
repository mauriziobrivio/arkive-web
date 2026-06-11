# arkive-web

The **Arkive Web Companion** — a desktop web client for [Arkive](https://arkive-it.app), running against the same production Supabase backend as the iOS app. An existing Arkive user signs into the same account, sees their capsules, opens received capsules, and creates + seals new ones.

**Out of scope:** the Vault (iOS-only), Relics ordering, purchases, push notifications. The web client adapts to the backend — it never changes it.

## Stack

Multiple discrete HTML pages. No framework, no build step. Shared assets:

- `assets/tokens.css` — design tokens (the app's ratified palette) + base primitives
- `assets/arkive.js` — supabase-js v2 (CDN/ESM) client, per-page auth guard, boot sequence, canonical backend constants

The Supabase **publishable key** in `arkive.js` is public-by-design; row-level security is the boundary, exactly as on iOS. Service-role keys must never appear in this repo.

## Pages

| page | purpose |
|---|---|
| `index.html` | sign in (email/password). Account management lives in the Arkive app |
| `capsules.html` | My Capsules / Received mailboxes |
| `people.html` | recipients |
| `settings.html` | account overview, sign out |

## Local development

Any static server from the repo root, e.g.:

```sh
python3 -m http.server 4173
# → http://localhost:4173/
```

## Deploy

GitHub Pages serves `main` at the repo root on **https://app.arkive-it.app** (custom domain via `CNAME`). Push to `main` = deploy.

## Status

WS1 — scaffold, auth, signed-in shell. Capsule lists land in WS2.
