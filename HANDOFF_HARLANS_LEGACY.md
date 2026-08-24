# Harlan's Legacy — Project Handoff

> A living archive of memory. A static, data-driven website + a zero-dependency
> admin CMS, backed by Supabase (data + storage) and deployed on Vercel.
> **This document contains NO credentials.** See §13 for what must be supplied separately.

_Snapshot date: 2026-08-24. Read-only handoff — no application/source files were modified to produce this._

---

## 1. Repository
- **Absolute path:** `D:\DATA\harlans-legacy-platform`
- **Git remote (origin):** `https://github.com/hellodanielkhan-hub/Harlans-Legacy.git`
- ⚠️ Do **not** confuse with unrelated projects on this machine (e.g. a `TalentSphere_Platform_outlet_fix` / `talenthunters.git` checkout). Harlan's Legacy is **only** the path above.

## 2. Branch
- `main`

## 3. HEAD commit (currently committed = currently deployed)
- `9495116` — *"Fix story photo manifest rebuild"* — the current production commit (deployed & READY on Vercel).
- Working tree is **0 ahead / 0 behind** `origin/main`. **The Phase-13 visual work IS now committed & live** (`414106f`), followed by this photo-manifest fix (`9495116`).

## 4. Git status — modified / untracked files
The Phase-13 work is now **committed**, so the working tree is essentially clean. The only uncommitted files are **two regenerated build outputs**, left by a local re-hydrate during verification — **not source edits, safe to discard**:
```
 M data/photos.json          (current Supabase family data — marvin now has more photos than the last committed snapshot)
 M family/marvin-yaffe.html  (regenerated from the above)
```
The maintainer can `git checkout -- data/photos.json family/marvin-yaffe.html` (or ignore them; they regenerate on any build).

### Source vs. generated (important for the new maintainer)
- **Hand-edited SOURCE files** are: `build.js`, `lib/reader.js`, `lib/photos.js`, `assets/experience.css`, and a small CSS/markup edit in `index.html` — all committed.
- All `story/`, `family/`, `journey/`, `place/`, `object/`, `event/` HTML, `stories.js`, `explore-data.js`, `search-index.json`, `data/*.json`, and the `assets/story-photos/` + `story-photos/` image trees are **GENERATED build output** (from `node build.js` / `node lib/hydrate.js`). **Do not hand-edit generated files** — change the source + templates and rebuild.

## 5. Committed vs. uncommitted
- **Committed & deployed** (`origin/main` @ `9495116`): the production platform (Phase-12A) **plus** the entire **Phase-13 "Lit Room" Story-Reader Stage-1 work** (`414106f`) **plus** the story-photo manifest fix (`9495116`). All live on Vercel.
- **Uncommitted:** only the two regenerated build-output files in §4 (safe to discard). No source work is uncommitted.

## 6. Completed work
**Phase 12A — committed & live** (`0255e69` → `e7a8e45`):
- Supabase (Postgres JSONB + Storage) + Vercel serverless backend; migration of all data.
- Fixed nested `/api/{resource}/{id}` routing on Vercel (catch-all only matched one segment).
- Draft-first CMS image upload; story-image de-dup groundwork; cascade-delete of story images; drafts excluded from public build; `/admin` → `/admin/` redirect; weekly-story "Continue reading" links to the canonical story page (no inline dump).

**Phase 13 Story Reader (Stage 1) — committed (`414106f`) & live; the arrival correction and Day-first default are included; the manifest fix is `9495116`:**
- **Foundation ("Lit Room"):** museum-label / frame / wall tokens (Day + Night) in `experience.css`.
- **Story Reader Stage 1 (current focus):**
  - **Shared `usedImageIds` de-duplication** across cover + auto composition + manual CMS plan + family portraits — **no photograph appears twice** (fixed the "305" duplication where a manual plan repeated the cover photo).
  - **Editorial image rules:** 0 → intentional no-photo cover; 1 → cover only; 2 → cover + one body beat; 3+ → distributed once each. **Auto-composition never stuffs family portraits** (opt-in only, max 1, via CMS plan).
  - **No-photo memories:** typographic cover + provenance + archival line ("No photograph survives — kept in Hal's words"); no empty box, no fabrication.
  - **Provenance** "wall text" (No. · when · where · Kept by Hal · read time).
  - **Opening testimony** (first paragraph set apart).
  - **Chapter rests** for long memories (e.g. #303 = 183 paragraphs → 6 rests); **coda**; **"Elsewhere in the collection"** (replaces "related posts").
  - **Arrival composition (latest correction):** cover + eyebrow + title + provenance composed as ONE arrival; **photo height-bounded** (portrait/square → beside the identity on desktop; landscape → contained banner; no-photo → typographic). Title/provenance sit within the first viewport; the photo no longer fills the screen (~43vh desktop, ~32–34vh tablet/mobile).
  - **Day-first default** on story pages: warm/light Day is the default identity; a saved toggle choice still wins; a dark-OS visitor is no longer auto-switched to Night (Night remains via the toggle).

## 7. Story Reader — features currently implemented (local)
Cinematic **arrival** (cover + identity as one unit) · **provenance** wall-text · **opening testimony** · calm book reading measure · **photographs as de-duplicated editorial beats** · **no-photo intentional treatment** · **chapter rests** · **coda** · **"Elsewhere in the collection"** · preserved: reading-progress thread, bookmark, marginalia, entity callouts/hovercards, knowledge-graph connections, lightbox, URLs, SEO, accessibility, reduced-motion. **Day-first**, warm/light identity; Night via toggle.

## 8. Story Reader — remaining weaknesses (honest)
- **Photo-rich paths unexercised by data:** only 2 of 4 published memories have a photograph (one each), so the **2-photo and 3+-photo** distribution logic is implemented but **not visually demonstrated** yet.
- **Beat placement is interval-based, not semantic** (no prose analysis of "narrative turns").
- **Arrival band is capped by `.story-card` (44rem):** desktop cover photo lands ~256px wide (~36% of the band); if a larger photo is wanted, let the arrival break slightly wider than the reading column (isolated tweak).
- **Cover crispness bounded by source derivatives** (~640px); no upscaling forced.
- **Awaiting the owner's emotional sign-off** ("opening a preserved memory, not a blog"). Structure/dedup/responsive/a11y/console are verified; the felt quality is the owner's gate.

## 9. NOT started yet (per the approved roadmap)
Stage 2 **Hero** · **Homepage** (curated Best-of entrance + Start Here/About) · dedicated **Archive** page · **Family/Profiles** · **Journeys** · **Discover/Search** alignment · final **responsive + a11y + performance QA** and **deploy** of Phase 13.

## 10. Local preview / server
- **Canonical:** `npm run serve` (= `node server.js`) → **http://localhost:4317/** (zero-dependency Node server; serves the built site + admin + local API).
- Other scripts: `npm run build` (photos + build), `npm run build:vercel` (hydrate + photos + build + collect-public), `npm run hydrate`, `npm run migrate`.
- During review, ad-hoc static servers over `./public` were also used (e.g. port 8797); these are throwaway and not part of the project.
- **First-time setup on a new machine:** `npm install`, create `.env` (see §13), then `npm run serve` (local file backend) or `npm run build:vercel` (Supabase-backed) → serve.

## 11. Important files & what each controls
| File / dir | Controls |
|---|---|
| `build.js` | Static-site generator: story pages (`storyPageHTML`), homepage regions, archive cards, family/journey/entity pages, search index, `stories.js`. Also `deriveData`, `coverPicture`, `storyProvenance`, cover orientation, Day-first head script. |
| `lib/reader.js` | Immersive reader composition (`composeBody`): image beats + **shared de-dup**, chapter rests, pull-quotes, entity callouts, coda. **The Story-Reader engine.** |
| `assets/experience.css` | Shared site-wide stylesheet loaded last on every page — the **"Lit Room" design system**, arrival composition, museum labels, framing, motion, day/night tokens. |
| `index.html` | Homepage template (design tokens in `:root`, section markup with `HL:` region markers the build injects into). |
| `lib/store.js` | Dual data backend: local JSON files vs. Supabase (JSONB + Storage), chosen by env. |
| `api/[...path].js` | Vercel serverless API (Supabase-backed) mirroring the admin API. |
| `server.js` | Local admin + preview server (file backend, port 4317). |
| `lib/hydrate.js` / `lib/collect-public.js` / `lib/photos.js` | Build pipeline: pull Supabase→local, assemble `./public`, generate responsive image derivatives. |
| `admin/` | Zero-dependency CMS (create/edit/publish memories, upload story + family photos). |
| `lib/graph.js`, `lib/journeys.js`, `lib/explore.js`, `lib/records.js`, `lib/reader.js` | Knowledge graph, journeys, Continue Exploring, shared record logic, reader. |
| `data/*.json` | Local seed/build cache (regenerated by hydrate); Supabase is the source of truth in production. |
| `supabase/schema.sql`, `vercel.json`, `DEPLOY.md` | Schema, Vercel config (build command, `/api` rewrite, `/admin` redirect), deploy runbook. |

## 12. Supabase / Vercel / deployment status
- **Live & healthy:** `harlanslegacy.com` (apex 308→ `www`), served by **Vercel** from `origin/main` @ **`9495116`** (deployment **READY**, build log error-free). **Production NOW includes the Phase-13 Story-Reader work** (arrival composition, Day-first, image system) and the story-photo manifest fix. Supabase REST auth returns **200 OK**.
- **Verified in production:** stories **304 & 305 display their photographs** (`has-photo`, image URLs 200); **305 shows its photo once** (cover only, no body duplicate); **214 stays intentionally no-photo** (no auto family portrait).
- **Backend:** **Supabase** — tables `documents` (site/entities/photos/story_photos JSONB) + `stories` (one row per memory), Storage buckets `photos` (family) + `story-photos` (editorial). RLS on with no policies (service-role bypasses; browser has no access).
- **Data now:** 13 memories — **4 published** (214 *The Blue Chair*, 303 *Following the Trail…*, 304 *The Red Suitcase*, 305 *The Tattoo That Wasn't* = current featured); 9 coming-soon. **Photographs exist only for 304 & 305** (one each). Family photos: hal / harlan / marvin / zandra.
- **Publish flow:** CMS write → Supabase → Vercel deploy-hook rebuild (`build:vercel` hydrates Supabase → rebuilds static site).
- **Next deploy:** happens automatically when the next approved stage is committed & pushed to `main`. (Owner review of the live Story Reader is the gate before Stage 2 — see §14.)

## 13. Secrets — DO NOT copy into any handoff document
The local **`.env`** (git-ignored) holds the following **names** (values must be supplied privately by the owner or rotated, **never** pasted into docs/chat):
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_TOKEN` — required at runtime (set as Vercel env vars in production).
- `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN` — setup/automation only; can be deleted after use.
- `.env.example` (committed) contains **placeholders only** — safe. The service-role key was rotated during setup; the new maintainer must obtain fresh credentials from the owner and recreate `.env` locally. **No credentials appear in this handoff.**

## 14. Approved blueprint & the exact next task
**Approved design blueprint (owner-signed):**
- Visual direction **"Lit Room," warm/light/clean, Day-first** (matches the PDF outline's *"five clean, simple pages — no clutter"*; the PDF is a **product/IA outline**, not a visual spec).
- IA per the PDF: **Start Here · This Week · Best of (curated 18–25, six themes) · The Archive (all, searchable) · About Harlan** — the homepage must be a **curated entrance**, distinct from a **dedicated Archive** page.
- Story reader = paced "preserved memory" (arrival → provenance → testimony → reading → earned photo beats → chapters → coda → elsewhere).
- Hero = **Concept B "warm archival Living Light"** (CSS/SVG flame + warm light; video only as a future drop-in); **not** dark/theatrical.
- Image system per §7/§8 above. No fabricated photos/people/content.

**Roadmap order (each stage built, verified, then owner review — no micro-commits):**
1. **Story Reader** ← *just implemented + arrival correction; awaiting owner's final emotional sign-off.*
2. **Hero** ← **the next approved task per the blueprint** (start only after the owner approves the reader).
3. Homepage · 4. Archive · 5. Family/Profiles · 6. Journeys · 7. Discover/Search · 8. Responsive+a11y+perf QA → deploy.

**Acceptance bar for every stage:** a genuine experience/structure change (not cosmetic); serves the PDF spirit; passes the emotional test ("a preserved life, not a blog"); no duplicate images; intentional at desktop/tablet/mobile with zero horizontal overflow; Day + Night; a11y + reduced-motion + no CLS + clean console; all existing features/URLs preserved; **no commit/push without owner approval.**

---

### Immediate next steps for the receiving maintainer
1. `npm install`; recreate `.env` from the owner's credentials (§13); `npm run serve` → http://localhost:4317/.
2. Review the local Story-Reader work (uncommitted) at `/story/304-…`, `/305-…`, `/214-…`, `/303-…`, Day + Night, desktop/tablet/mobile.
3. **Do not push** the Phase-13 work until the owner approves; then commit to `main` → Vercel deploys.
4. On approval, begin **Stage 2 — Hero** (warm Living Light), one reviewable transformation, then stop for review.
