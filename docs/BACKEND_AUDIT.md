# Backend & project audit — 2026-09-26

Read-only audit taken at production `main` = `61cc9da`. Nothing was cleaned up,
moved or deleted as part of it; the "clean later" list is a proposal only.

## How production actually works (source of truth)

| Concern | Source of truth | Notes |
|---|---|---|
| Stories, site, entities, photo manifests | Supabase Postgres (`stories` rows, `documents` JSONB) | Edited only through Admin → `api/[...path].js` (serverless, service role server-side). |
| Photo originals | Supabase Storage `photos`, `story-photos` (public) | Derivatives generated at build (`lib/photos.js`). |
| Narration audio + timings | Supabase Storage `listen` (**private**) | Ready/unapproved reachable only via moderator-issued preview capability → 10-min signed URL. |
| Narration jobs / audit | Supabase `documents`: `narration_jobs`, `narration_audit` | Local file copies exist only in the dev checkout. |
| Public site | Vercel build of git `main` | `build:vercel` = hydrate → photos → build.js → collect-public → `public/`. Only approved narrations are hydrated. |
| Publish | Admin save → `VERCEL_DEPLOY_HOOK_URL` rebuild | The committed `data/*.json` is **not** read by the Vercel build. |

## A. Clean

- Production data flow is single-directional: Admin/API → Supabase → Vercel build. The build never writes to Supabase.
- Secrets: `.env` is git-ignored; no secret values are tracked (release commits were secret-scanned).
- `public/` is git-ignored and assembled from an explicit allow-list (`lib/collect-public.js`): `tools/`, `lib/`, `data/`, `docs/` never ship.
- Narration privacy: private `listen` bucket, approved-only hydration, build-time listening-integrity guard, `check:dev-security` (22 checks).
- Build regenerates `story/`, `family/`, `journey/`, `place/`, `object/`, `event/` from production data, so stale tracked pages are not served (e.g. `/story/214-the-blue-chair.html` → 404).
- Branches `narration-release`, `mobile-listen-fix`, `logo-brand-mark` are all ancestors of `main` (fully merged).

## B. Messy

- **Two checkouts with different truths.** `D:\DATA\harlans-legacy-platform` is on local `main` at `7dcbc47` (4 commits behind `origin/main`) with 40 modified tracked files and the original, pre-release narration work uncommitted. `D:\DATA\harlans-release-narration` (a git worktree, now on feature branches) is where every production release was made.
- **Stale tracked data.** `data/stories.json` on `main` holds 13 stories (Blue Chair 214 + 9 "coming soon" + 303–305); production has 9 published (303–305, 388–393). A second, outdated source of truth.
- **Generated files mixed with source.** `index.html` is hand-authored *and* rewritten in place by `build.js` (marker regions); tracked `story/*.html`, `family/`, `journey/`… plus `stories.js`, `explore-data.js`, `search-index.json` are build outputs. Every local build dirties them.
- **Root clutter (dev checkout, untracked):** ~60 prototype/proof pages (`hero-*`, `listen-*-proof*`, `clean-hero-*`, `experience-study-*`, `art-*`, `index.pre-cinematic-hero.backup.html`) and design notes.
- **108,245 untracked, un-ignored files** in the dev checkout; 108,060 are `prototype/voicelab` (`venv-cuda/` 53.6k, `pipcache/` 0.8k not covered even by `main`'s `.gitignore`).
- 11 historical `failed` narration jobs (paused/timed-out backfill attempts) remain in production job history — harmless, noisy.
- Legacy listening engine `assets/listen.js` / `listen.css` still in the dev checkout (build guard forbids wiring it).

## C. Risky

1. **`npm run migrate` can overwrite production with stale data.** It upserts local `data/*.json` into Supabase: 303–305 would lose their narration/publication records and 214 + 9 placeholder stories would reappear. Only guard: needing the two Supabase variables in the shell.
2. **The dev checkout's code predates privacy/mobile/logo.** Its `lib/hydrate.js` copies *every* narration (including unapproved Ready audio) into the build, and it lacks the preview capability. Committing/pushing from that checkout would regress production.
3. **`lib/narration/worker.js` loads `.env` itself.** Running it locally targets production Supabase, and its `pump()` calls `jobs.prune()`, which deletes finished jobs older than 24 h (the backfill history crosses that on 2026-09-26).
4. **Local dev server is local-only by require order.** `server.js` → `worker.js` → `.env` puts the production service-role key and engine command into the dev server's environment; the store stays file-backed only because `store.js` was first required earlier. Reordering requires would silently point `npm start` at production.
5. Scripts that write production by design: `tools/narration-backfill/{enqueue,carryover-304,pause}.cjs`, `lib/narration/staging-worker.js`, `lib/migrate.js`. None has a `--production` confirmation.
6. A bulk `git add -A` in the dev checkout would try to stage venvs, caches and prototypes (public repo).

## D. Clean later (not done)

- `.gitignore`: `prototype/voicelab/venv*/`, `prototype/voicelab/pipcache/`, `**/__pycache__/`.
- Add an explicit production guard (e.g. `HARLAN_ALLOW_PRODUCTION_WRITE=1` + confirmation) to `migrate`, the backfill tools and the workers; make `worker.js` not auto-load `.env`; make the dev server refuse production credentials unless asked.
- Remove `jobs.prune()` from the production path or make its horizon explicit.
- Stop tracking build outputs (generated pages, `stories.js`, `explore-data.js`, `search-index.json`) and move `index.html`'s generated regions to a template → output split. Replace tracked `data/*.json` with a small, clearly-named local fixture.
- Retire or archive the dev checkout after porting anything still wanted (voicelab tooling, backfill tools) onto a branch from `main`; rename the worktree folder.
- Move prototype/proof pages to `prototype/` (or delete); keep design notes under `docs/`.
- Delete fully-merged branches once no longer needed as release markers.

## E. Must NOT be touched (live production system)

Supabase tables/buckets and their privacy settings; `lib/store.js`, `lib/hydrate.js` (approved-only), `lib/narration/*` incl. `preview-cap.js`, `api/[...path].js`, `server.js` security guards, `lib/static-guard.js`; `assets/listen-cinematic.{js,css}`, `assets/listen-soundscape.js`; the 9 stories' approved/Ready generations and job/audit history; `assets/brand/*` + `lib/brand.js`; favicons/manifest; `vercel.json`; the Vercel project and its environment variables.
