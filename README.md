# Telegram Session Vault — Safe Demo

A GitHub/Railway-ready **testing scaffold** for a consent-based persistent Telegram-session management product UI.

## What this project includes

- Admin login using Railway environment variables
- Server-backed session profile storage
- Telegram-style profile cards with avatar, username, phone, Telegram ID and Premium badge
- Stable country/region network-profile simulation with fixed demo egress labels/IPs
- Session health checks and `ACTIVE` / `REAUTH_REQUIRED` state machine
- User disconnect flow
- Telegram-side revoke and user re-auth **simulation**
- Private simulated login-code event inbox
- Server-Sent Events (SSE) so new simulated code events appear automatically in open dashboards
- Optional server-generated automatic mock events
- Audit trail
- `/health` endpoint for Railway
- Railway config and Procfile

## Important boundary

This repository is intentionally a **safe demo scaffold**. It does **not**:

- intercept or harvest real Telegram login OTPs;
- hide a Telegram session from the account owner;
- bypass or defeat Telegram/user session revocation;
- clone another device's IP or impersonate a network to evade Telegram security controls;
- store real MTProto auth keys.

For production, integrate only an approved Telegram client flow with explicit user consent, encrypted credential/session storage, user-controlled disconnect, and normal Telegram revocation behavior.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Default local login:

```text
Username: admin
Password: change-this-password
```

Change these immediately in public environments.

## Push to GitHub

From the project folder:

```bash
git init
git add .
git commit -m "Initial Telegram Session Vault safe demo"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## Deploy on Railway

1. Create a new Railway project from your GitHub repository.
2. Railway will detect Node.js and run `npm start`.
3. Add these Variables:

```text
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD=use-a-strong-password
SESSION_SECRET=use-a-long-random-secret
AUTO_MOCK_EVENTS=false
DATA_FILE=./data/state.json
```

4. Generate a Railway domain.
5. `/health` should return `{ "ok": true, ... }`.

### Optional automatic mock login-code events

Set:

```text
AUTO_MOCK_EVENTS=true
AUTO_MOCK_EVENT_INTERVAL_MS=30000
```

The server will create a **simulated** login-code event roughly every 30 seconds while at least one account is active. The dashboard receives it automatically through SSE.

## Railway persistent storage

Railway deployments can have ephemeral local files. If you want the demo JSON state to survive redeploys:

1. Add a Railway Volume.
2. Mount it at `/app/data`.
3. Set:

```text
DATA_FILE=/app/data/state.json
```

On first use, ensure a valid state JSON exists there or copy the included `data/state.json` seed into the mounted path.

For a real multi-instance production service, replace the JSON store with PostgreSQL/Supabase.

## Production architecture direction

Recommended safe architecture:

```text
Browser / Mini App
       |
Auth + Consent API
       |
Account Service ---- Audit Log
       |
Encrypted Session Vault (KMS-backed)
       |
Per-account Worker
       |
Stable user-approved network profile
       |
Telegram API / approved client integration

Health Monitor -> ACTIVE / REAUTH_REQUIRED / DISCONNECTED
```

Do not expose raw session material or sensitive login codes to admins, logs, analytics, or unrelated users.
