# Manual smoke tests — pre-deploy validation

Checklist for the Google OAuth accounts feature, GraphQL/Airtable integrations, and
canvas/simulation rewrite before/after deploying to Render. Check items off as you
validate them.

## 0. Render config (do these first — nothing below works without them)

- [ ] Set new env vars in the Render dashboard: `GOOGLE_OAUTH_CLIENT_ID`,
      `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` (must exactly match
      `https://<host>/api/auth/google/callback` in Google Cloud console),
      `ALLOWED_EMAIL_DOMAINS`, `AIRTABLE_TABLE` (now has no default — was `Feedback`
      before).
- [ ] Confirm the Google OAuth redirect URI is registered in Google Cloud Console for
      the actual Render hostname, not just localhost.
- [ ] Run `python manage.py invite_user --email you@example.com` (or set
      `ALLOWED_EMAIL_DOMAINS`) against prod once deployed — otherwise no one can sign in.
- [ ] Watch the build log for `seed_templates` — this now **hard-fails the build** if
      template fixtures don't validate against `topology.py`. `sync_catalog` failing is
      fine (best-effort).
- [ ] Confirm `/api/health` still returns 200 post-deploy (healthCheckPath).

## 1. Sign-in / accounts (new feature, highest risk)

- [ ] Click sign-in with no Google env vars configured → button/flow says sign-in
      unavailable, doesn't 500 or bounce to a Google error page.
- [ ] Full Google sign-in round trip with an allowed-domain email → lands back on app
      signed in, cookie set.
- [ ] Sign-in with an email that is neither in `ALLOWED_EMAIL_DOMAINS` nor invited →
      refused with the "ask someone to invite you" message.
- [ ] Cancel the Google consent screen → returns to app with "Sign-in was cancelled,"
      not an error page.
- [ ] Invite a teammate's email (`POST /api/invitations`) while signed in, then sign in
      as that email → admitted, invitation marked accepted.
- [ ] Invite the same email twice → second call returns `alreadyInvited: true`, no
      duplicate row/behavior.
- [ ] Draw a diagram anonymously, then sign in → anonymous diagram(s) get claimed onto
      the new account (check `claimed` count in the UI notice).
- [ ] Sign in as Account A in a browser already signed in as Account B → previous
      anonymous/account scope is **not** carried over (data-leak check).
- [ ] Log out → session becomes anonymous again, not stranded/logged-out-with-no-session.
- [ ] Replay a used OAuth callback URL (reuse the same `code`/`state`) → fails
      gracefully ("link has expired"), doesn't double-create anything.
- [ ] Leave a session idle most of a day while occasionally active → session cookie
      expiry slides forward (doesn't log out mid-session anymore).
- [ ] Confirm `/` response has `Cache-Control: no-store` (devtools Network tab) so a
      stale cached `index.html` never points at deleted hashed JS/CSS after this deploy.

## 2. Workspace connect dialog (GraphQL/app-session + operator slug flow)

- [ ] Connect with Public API token (existing path) still works end-to-end.
- [ ] "App session / auth_token" credential option is **hidden** unless signed in with
      a `@twilio.com` email; attempting it server-side as a non-Twilio account is
      rejected even if forced.
- [ ] Token textarea masks input by default (dots), "Reveal"/"Hide" toggle works, and
      paste/submit still work while masked.
- [ ] Switching credential tabs clears the pasted token (no leakage across tabs).
- [ ] Connecting to the `segment-operator` gateway workspace triggers the new
      slug-entry step, and submitting a valid slug connects; back button returns to
      the workspace list.
- [ ] Multi-workspace credential still shows the workspace picker correctly.

## 3. Feedback form → Airtable

- [ ] Submit feedback with `AIRTABLE_TABLE` unset in a test env → form correctly
      reports "unavailable" rather than a raw error.
- [ ] Submit real feedback in prod → row appears in Airtable with Status defaulted to
      the expected "new" option and App field populated (not creating stray duplicate
      select options — check `airtable_schema` command output first if unsure of exact
      option names).

## 4. Catalog sync

- [ ] `sync_catalog` runs cleanly against real `SEGMENT_CATALOG_TOKEN` (or confirm it's
      acceptable if it's skipped on this deploy).

## 5. Canvas / diagram editing (large rewrite — connectors, anchors, shapes)

- [ ] Draw a connector and drop its endpoint anywhere along a shape's border (not just
      fixed anchor points) — connects and re-routes correctly, including after moving
      the shape.
- [ ] Old fixed "anchor gutter" UI is gone; confirm nothing visually references it
      (dead hover affordance, stray tooltip).
- [ ] Shapes palette: spot-check several of the new geometric/Lucid icon shapes render,
      drag onto canvas, resize, and restyle correctly.
- [ ] Zones, Segment nodes, and generic Shape nodes: selection, resize, label edit, and
      connector attachment all still work.
- [ ] Split view (shared header/palette/inspector across two panes) — open two diagrams
      side by side, confirm inspector/palette act on the correct pane.
- [ ] Save/reload a diagram with connectors attached mid-border (not at a
      corner/anchor) — round-trips correctly (serialize/deserialize).
- [ ] Undo/redo across connector, shape, and zone edits.

## 6. Simulation / walkthrough (router.js/scenarios.js rewrite)

- [ ] Run a walkthrough on a diagram with Linked Audiences / Data Graph / SQL Table
      components — playhead advances, event preview shows correct data at each step.
- [ ] Pause/resume/scrub the walkthrough drawer.
- [ ] Run a scenario that hits a branch/condition node — router correctly follows the
      expected path.

## 7. General smoke test

- [ ] Fresh incognito visit to the deployed URL loads with no console errors, correct
      title ("Segment Archistrator"), and CSS/JS assets load.
- [ ] Existing anonymous flow (no sign-in at all) still fully works — connect, build,
      save, simulate.
