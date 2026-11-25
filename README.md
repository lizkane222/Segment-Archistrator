# Archistrator

Draw, read and walk through a Segment architecture. A canvas for Connections, Unify and Engage
that can be filled in by hand, seeded from a reference template, or read from a real workspace —
and then played back event by event to answer "what actually reaches Braze if this filter drops?"

Django + DRF serving a React / React Flow single-page app from the same origin.

## Why one service and not two

Hosted platform domains such as `elasticbeanstalk.com` and `amazonaws.com` are on the Public
Suffix List, so two services on them cannot share a cookie domain. This app's entire auth model is an httpOnly session cookie, so a split
frontend/backend would force `SameSite=None` third-party cookies — which Safari's ITP and
Chrome's third-party cookie restrictions break. Serving the built SPA from Django keeps
everything same-origin: `SameSite=Lax` works, Django's stock CSRF works, and there is no CORS
configuration to get wrong.

## Running it locally

Postgres first:

```sh
docker run -d --name segarch-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=segarch postgres:16
```

Then:

```sh
cp .env.example .env
# Generate the key that encrypts stored Segment tokens and paste it into .env:
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_templates

cd frontend && npm ci && npm run build && cd ..
python manage.py runserver 0.0.0.0:8010
```

The frontend builds into `static/spa/`, which Django serves. Rebuild the frontend after
changing anything under `frontend/src`; Django itself autoreloads.

## Tests

```sh
python -m pytest -q          # backend
cd frontend && npx vitest run # frontend
```

The frontend suite has no jsdom, deliberately — everything with real logic in it is a pure
module (routing geometry, the tab model, the topology rules, the simulation reducer) and is
tested as one. What that does *not* catch is layout: a broken flexbox throws no error. Check the
window after any change to the shell.

## Connecting a workspace

Two ways in, offered as equals:

- **A Segment Public API token.** Scoped to one workspace, revocable on its own. Read-only
  scopes are enough. This is the one every workspace read goes through.
- **An app session `auth_token`.** Already in your browser if you are logged in to Segment, so
  there is nothing to create and nobody to ask.

The second is somebody's *whole login session* — it carries all of their access, in every
workspace they can reach, and cannot be revoked without ending their session. Use your own
login rather than asking a customer for theirs.

What each one reads differs, and the app says so rather than letting you find out from a gap:

| | Public API token | App session |
| --- | --- | --- |
| Sources, destinations, warehouses, and their connections | yes | yes |
| Functions, Reverse ETL models | yes | not yet |
| Unify spaces, audiences, computed traits | yes | not yet |

The GraphQL read is one request rather than one per source, because `Source.integrations` and
`Source.warehouses` are fields — which matters, since that client is throttled to one request a
second on purpose. Everything it cannot reach comes back in the graph's `warnings`, worded so the
absence reads as this tool's limitation rather than as a fact about the workspace.

Nothing is stored in the browser. A pasted credential is validated against Segment, encrypted
with `SEGMENT_TOKEN_ENCRYPTION_KEYS` and kept server-side; only an opaque httpOnly session id
comes back. Write keys stay masked until explicitly revealed, and each reveal writes an audit
row.

## Deploying

The app runs on AWS: Elastic Beanstalk (Python 3.13, single-instance, `t3.micro`) for compute,
RDS PostgreSQL (Single-AZ, `db.t4g.micro`, reachable only from the EB instance's security group)
for the database, and CodePipeline for CI/CD. (It previously ran on Render; `render.yaml` is a
leftover from that.)

**Pipeline.** GitHub (via GitHub App connection) → CodeBuild running `buildspec.yml`
(`pip install`, `npm ci && npm run build`, `collectstatic`) → Elastic Beanstalk deploy. There is
no test stage. Processes start from `Procfile` (`gunicorn config.wsgi:application`).

**Secrets** live in SSM Parameter Store as SecureString under `/segment-builder/prod/<NAME>` and
are fetched into the environment at deploy time by `.platform/hooks/predeploy/01_fetch_secrets.sh`.

| Parameter | Notes |
| --- | --- |
| `SECRET_KEY` | Django secret key. |
| `DATABASE_URL` | The RDS connection string. |
| `SEGMENT_TOKEN_ENCRYPTION_KEYS` | Fernet needs exactly 32 url-safe-base64 bytes, so generate it (`python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`). Rotate by *prepending* a new key to the comma-separated list, so existing ciphertext stays readable. |
| `SEGMENT_CATALOG_TOKEN` (optional) | Reads the *global* Segment catalog on deploy. Not a customer token, never used for customer data. |
| `AIRTABLE_API_KEY` (optional) | Feedback integration. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The OAuth client's secret. **Required for anyone to sign in** — see "Sign-in" below. |

**Non-secret config** is set as Elastic Beanstalk environment properties (Configuration →
Software): `DJANGO_SETTINGS_MODULE=config.settings.prod`, `ALLOWED_HOSTS=<eb-environment-url>`,
`SECURE_SSL_REDIRECT=False` (until HTTPS), and optionally `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`,
`ALLOWED_EMAIL_DOMAINS`, `CSP_REPORT_ONLY` (a rollout escape hatch if the CSP ever blocks something real).

**Migrations and catalog sync** run after each deploy from `.platform/hooks/postdeploy/01_migrate.sh`
(`migrate`, `seed_templates`, `sync_catalog`). This assumes a single instance, with no leader
election, so revisit it before scaling out.

**Sign-in (required).** Production is closed: nobody can reach anything until they have signed in
with a Google Workspace account on `ALLOWED_EMAIL_DOMAINS` (default `twilio.com`). There is no anonymous
mode and invitations do not admit anyone (`REQUIRE_ACCOUNT` and `INVITATIONS_ENABLED` are fixed in
`config/settings/prod.py`, not read from the environment). The app checks the verified email's domain
*and* Google's `hd` claim, which only a Workspace-managed account carries.

To set it up:

1. <https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID** →
   *Web application*. Under **Authorized redirect URIs** add
   `https://<your-domain>/api/auth/google/callback`. Google refuses a plain-`http://` redirect except for
   localhost, so **sign-in cannot work until the app is served over HTTPS.**
2. <https://console.cloud.google.com/apis/credentials/consent> → set the user type to **Internal**, so
   Google itself refuses accounts outside the Workspace (belt and braces with the app's own check).
3. Elastic Beanstalk → Configuration → Software → environment properties (plain, not secret):
   `GOOGLE_OAUTH_CLIENT_ID=<client id>`, `GOOGLE_OAUTH_REDIRECT_URI=https://<your-domain>/api/auth/google/callback`
   (pin it, so the proxy cannot change the scheme or host Google is told), `ALLOWED_HOSTS=<your-domain>`.
4. AWS Console → Systems Manager → Parameter Store → **Create parameter**: name
   `/segment-builder/prod/GOOGLE_OAUTH_CLIENT_SECRET`, type **SecureString**, value = the client secret.
   Redeploy; the predeploy hook picks it up.

**HTTPS.** Until a domain, ACM certificate and HTTPS listener exist the environment can only serve plain
HTTP, and with it nobody can sign in (above). When they do: remove the `SECURE_SSL_REDIRECT=False`
override, set `SECURE_HSTS_SECONDS=3600` for the first deploy and raise it once nothing has gone wrong
(browsers will refuse HTTP for that long once they have seen it), and leave the load balancer's health
check on `/api/health` — it is answered before host validation and the HTTPS redirect, so the check
(which arrives over HTTP with the instance's IP as `Host`) stays green.

**Zscaler.** The app is reached through Zscaler, so: restrict the load balancer's security group to
Zscaler's egress ranges (published at <https://config.zscaler.com>) so the app cannot be reached
around it; every `/api/` response carries `Cache-Control: no-store` and `Vary: Cookie`, so an inspecting
proxy cannot cache one person's diagrams and serve them to the next; and the CSP (`config/middleware.py`)
sends nothing off-origin from the page. If Zscaler's TLS inspection breaks Google sign-in for some
users, exempt `accounts.google.com` and `oauth2.googleapis.com` from inspection in Zscaler policy.

**Workspaces and tab groups.** A signed-in person can connect several Segment workspaces at once. Each
connection is stored encrypted against their account; tabs are grouped by workspace, and every request
names its tab's workspace in an `X-Workspace-Id` header. The server only ever resolves that against the
caller's *own* connections, so a tab can never act as a workspace its account has not connected.

`config/settings/prod.py` refuses to boot without an encryption key — a missing one would mean
tokens stored under a throwaway key, unreadable after the next restart and silently so.

## Layout

```
apps/auth_workspace/   sessions, token encryption, the two ways in
apps/segmentapi/       Public API + GraphQL clients, and topology.py -- the rules
apps/catalog/          workspace and catalog reads
apps/diagrams/         saved diagrams, templates, save-time validation
frontend/src/canvas/   React Flow: nodes, edges, routing geometry, layout rules
frontend/src/inspector/ the per-component panel
frontend/src/simulation/ the walkthrough reducer
```

`apps/segmentapi/topology.py` is the one place that knows what a Segment architecture is allowed
to look like. The frontend fetches it from `/api/meta/topology` rather than keeping its own copy,
so the canvas cannot draw something the backend would reject.
