# Admin guide — RBAC and the Admin tab

This repository is the **API only** (files at the repo root). Deploy with repository **root** as the app directory (Render: leave Root Directory empty or `.`). Run locally: `npm install && npm start`.

## What this does

- **Who can use the connector** is controlled on the **API server** using the Google account email of each user (`Session.getActiveUser().getEmail()` in Apps Script), sent as header **`X-User-Email`** on every API call.
- **What they can do** is split into:
  - **Datasets** — which registered datasets (sales, stock, …) appear in the Data tab and can be loaded.
  - **Features** — which sidebar tabs and actions are allowed: `explorer`, `ai`, `data`, `schedule`, `admin`.

The shared secret **`X-API-Key`** (optional env `API_KEY`) is separate: it proves the client is *your* deployment, not *which person* is using it. RBAC answers *which person*.

## Where to add or change users (important)

- **User emails are not Render / `.env` variables.** Do not try to list people in the dashboard “Environment” tab (except `RBAC_ENABLED=1` to turn the feature on).
- **PostgreSQL (recommended on Render):** set **`DATABASE_URL`** (Render injects this when you link a Postgres instance to the web service) or **`RBAC_DATABASE_URL`**. The API creates tables **`erp_rbac_users`** and **`erp_rbac_roles`**. On first run, if those tables are empty, it copies roles and users from **`users-config.json`** in the deploy. After that, **Admin → Save** and password changes are stored in the database and **survive redeploys**. Role *definitions* (`admin` / `manager` / `viewer` caps) are still **re-synced from `users-config.json` on every startup**, so edit roles in Git and redeploy to change dataset/feature lists.
- **File-only mode (no DB URL):** **Source of truth** is **`users-config.json`** in this repo. Each entry is `{ "email": "lowercase@gmail.com", "role": "admin" | "manager" | "viewer" }`. Typical workflow: edit → commit → push → redeploy. **Alternative:** sidebar **Admin** → **Save users to server** if the host can write that file (`RBAC_PERSIST=1`).

If your email is correct in Git but you still get “No role configured”, the live server is almost certainly running an **old deploy** — trigger a manual **Deploy** on Render (or confirm the user row exists in Postgres if you use `DATABASE_URL`).

## Bootstrap (recommended order)

1. Deploy **`users-config.json`** next to `index.js` (repo root) with at least one row in **`users`**:

   ```json
   "users": [
     { "email": "you@yourdomain.com", "role": "admin" }
   ]
   ```

2. Adjust **`roles`** in the same file if needed (dataset keys must match `datasets-registry.js`).

3. Set on the host: **`RBAC_ENABLED=1`** (and keep **`API_KEY`** set in production).

4. Redeploy / restart the Node process.

5. In Google Sheets, open the sidebar: you should see tabs according to your role. Users not listed get **403** with a clear message.

## Admin tab in the sidebar

- Visible only if the role includes feature **`admin`**.
- **Users** — loads `GET /api/admin/users`, edit list, **Save users to server** calls `POST /api/admin/users` with `{ "users": [ … ] }`.
- **Admin query console** — runs adaptive AI and shows a **preview table** (does not write to the sheet). Use **AI Query** to push rows to a tab.

## Persistence on PaaS (Render, etc.)

- **With `DATABASE_URL` / `RBAC_DATABASE_URL`:** `POST /api/admin/users` and password updates write **PostgreSQL**. User lists and hashes persist across redeploys.
- **File mode:** `POST /api/admin/users` rewrites **`users-config.json`** on disk. On an **ephemeral** disk, those edits are lost on redeploy unless you commit the file or use **`RBAC_PERSIST=0`** and manage the file only in Git.

## Chrome extension

- If you use **`chrome-extension/`**, it must also send **`X-User-Email`** (e.g. from Google OAuth profile) when calling the API, or RBAC will reject requests. The Sheets add-on path is covered by Apps Script automatically.

## Troubleshooting

| Symptom | Check |
|--------|--------|
| Everyone gets 403 “No role configured” | Email in `users` must match Google sign-in exactly (case-insensitive). |
| “Missing X-User-Email” | Apps Script not sending header — update `getApiHeaders_()` / redeploy script. |
| Admin API 403 `rbac_disabled` | `/api/admin/*` requires **`RBAC_ENABLED=1`**. |
| Admin save fails on host | **`RBAC_PERSIST=0`**, or read-only filesystem — edit file manually. |
