# Handoff: update docs for the move off Render, onto AWS

## Context

This app (Segment Archistrator) was previously hosted on Render, configured via
[render.yaml](render.yaml). That Render service has expired and is no longer in use.
The app is being re-hosted on AWS: Elastic Beanstalk (compute) + RDS (Postgres) +
CodePipeline (CI/CD) + SSM Parameter Store (secrets). That AWS deployment scaffolding
already exists in this repo (some of it merged, some in an open PR) — your job is
**documentation only**, not infrastructure. Do not modify `Procfile`, `buildspec.yml`,
`.ebextensions/`, or `.platform/` unless you find something in them that's factually
wrong relative to what's described below.

## The AWS architecture, for accurate documentation

- **Compute**: Elastic Beanstalk, Python 3.13 platform, Single-instance environment
  type (no load balancer), `t3.micro`. Started from "Sample application," then an app
  version is deployed via CodePipeline.
- **Database**: RDS PostgreSQL, Single-AZ, `db.t4g.micro`, not publicly accessible,
  reachable only from the EB instance's security group.
- **CI/CD**: CodePipeline, Source = GitHub (via GitHub App connection) → Build =
  CodeBuild running [buildspec.yml](buildspec.yml) (`pip install`, `npm ci && npm run
  build` for the frontend, `collectstatic`) → Deploy = Elastic Beanstalk. Test stage
  skipped (no CI test stage existed to reuse).
- **Process startup**: [Procfile](Procfile) — `gunicorn config.wsgi:application`.
- **Secrets**: AWS Systems Manager Parameter Store (SecureString), under the path
  `/segment-builder/prod/<NAME>`. Currently: `SECRET_KEY`, `DATABASE_URL`,
  `SEGMENT_TOKEN_ENCRYPTION_KEYS`, and optionally `SEGMENT_CATALOG_TOKEN` /
  `AIRTABLE_API_KEY`. Fetched into the app's environment at deploy time by
  [.platform/hooks/predeploy/01_fetch_secrets.sh](.platform/hooks/predeploy/01_fetch_secrets.sh)
  — this is deliberately NOT AWS Secrets Manager (cost tradeoff, team chose SSM).
- **Non-secret config**: plain Elastic Beanstalk Environment Properties (console:
  Configuration → Software) — `DJANGO_SETTINGS_MODULE=config.settings.prod`,
  `ALLOWED_HOSTS=<eb-environment-url>`, `SECURE_SSL_REDIRECT=False`, and optionally
  `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE`, `ALLOWED_EMAIL_DOMAINS`.
- **Migrations/catalog sync**: run post-deploy, after secrets are fetched and the app
  is live, by
  [.platform/hooks/postdeploy/01_migrate.sh](.platform/hooks/postdeploy/01_migrate.sh)
  (`migrate`, `seed_templates`, `sync_catalog`). This assumes single-instance — no
  leader election — flagged in a comment in that file for whoever scales this later.
- **No custom domain / HTTPS yet.** The environment currently serves plain HTTP on
  its default Elastic Beanstalk URL. Because of this,
  [config/settings/prod.py](config/settings/prod.py) now reads `SECURE_SSL_REDIRECT`
  from an env var (default `True`) instead of hard-coding `True` — it's explicitly set
  to `False` as a temporary EB environment property. **Google OAuth env vars are
  deliberately unset** (Google requires an `https://` redirect URI); the app still
  works anonymously without them. Revert `SECURE_SSL_REDIRECT` to the default and set
  up Google OAuth once a domain + ACM cert + HTTPS listener exist.

## Files that reference Render and need updating

Found via `grep -rn "RENDER_EXTERNAL_HOSTNAME\|onrender\.com\|Render dashboard"`:

- **[README.md:11](README.md#L11)** and **[README.md:97](README.md#L97)** — describes
  the Render same-origin cookie rationale and the `ALLOWED_HOSTS`/
  `RENDER_EXTERNAL_HOSTNAME` behavior. The underlying reasoning (serve the SPA and API
  same-origin so `SameSite=Lax` cookies and stock Django CSRF just work, no CORS)
  still fully applies on AWS — note that `amazonaws.com` and `elasticbeanstalk.com`
  are *also* on the Public Suffix List, same as `onrender.com`, so the reasoning
  transfers directly. Replace the Render-specific deploy instructions with the AWS
  flow above (or link out to wherever you end up documenting it in full).
- **[MANUAL_SMOKE_TESTS.md:4](MANUAL_SMOKE_TESTS.md#L4)** and
  **[MANUAL_SMOKE_TESTS.md:9](MANUAL_SMOKE_TESTS.md#L9)** — says "before/after
  deploying to Render" and "Set new env vars in the Render dashboard." Update to
  reference Elastic Beanstalk Environment Properties / SSM Parameter Store as
  appropriate per variable.
- **[render.yaml](render.yaml)** — now stale. **Ask the user** whether to delete it or
  keep it around for historical reference before touching it; don't remove it
  unilaterally.
- **[config/settings/prod.py:12](config/settings/prod.py#L12)** — still reads
  `RENDER_EXTERNAL_HOSTNAME`, which will just always be empty on AWS (harmless dead
  code, not a bug). Flag it to the user as removable cleanup; don't remove without
  asking, since it's still in active use if Render is ever reused.
- **[config/settings/base.py:81](config/settings/base.py#L81)** — comment about
  `onrender.com`/`SameSite=Lax`. The policy itself doesn't need to change (see above);
  the comment's phrasing is Render-specific and could be generalized.

## Hard stop: do not create or push to the new repo yourself

The user is moving this codebase into a **new repository under Twilio's own GitHub
org/account** (separate from the current repo this PR lives in). That new repo does
not exist yet, and creating it or pushing to it requires credentials/access that only
the user has (their own `gh auth login` session scoped to Twilio's org, or a specific
new remote URL they provide).

**Once you've finished the documentation updates above**, stop and tell the user
you're done and ready for the next step. Do not run `gh repo create`, `git remote
add`, `git push` to any Twilio-org URL, or anything that assumes that repo exists.
Wait for the user to set up their credentials/access and tell you the new repo's
location — only then proceed with pushing there, and only if they explicitly ask you
to.
