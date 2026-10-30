# Facebook Shabbat Shalom importer

Local tool for adding the missing Facebook "Shabbat Shalom" posts to Harlan's Legacy as **Draft** memories
through the **existing Admin API**: the same endpoints and record shape the Editorial Workspace uses.
Built against `3a327d8` (`main` after PR #1, which lets a batch defer the rebuild on Draft writes).

**Production writes are disabled.** `lib/api.js` refuses every write (`WRITES_ENABLED = false`), and `import.js`
accepts only `dry-run`. `lib/batch.js` runs a batch only through an injected transport, which today only the
isolated rehearsals provide. Enabling writes needs the owner's separate written authorization.

## Files

| File | Purpose |
|---|---|
| `import.js` | `dry-run`: oldest first, readiness, duplicates, exact request bodies, image order, rebuild impact. **No network calls.** Writes `runs/dry-run-<time>/` (plan.json, status.csv, report.md, text-diffs.md). `plan()` is shared with the batch tools. |
| `lib/batch.js` | Runs one approved batch: preflight, then per post create → upload photos → read back and verify, then **one** closing `POST /api/build` only when every post is verified. Resumes from the ledger without duplicates. |
| `build-batch-payload.js` | Builds an import-ready batch payload (items + approval fingerprints) from the manifest and an approved-batch file. Stops on any difference from the approval. |
| `lib/text.js` | Facebook text → paragraphs. Removes only standalone hashtag lines, "Week/Issue #" headers, a title line equal to the title, Facebook's "See more/less", and lines the owner listed in `removeLines`. Never edits wording; punctuation issues are reported only. |
| `lib/record.js` | Builds the body exactly like `admin.js collect()` and previews it through the server's own `lib/records.js normalize()`. Status is always `draft`, featured `false`. |
| `lib/dupes.js` | Blocks the same Facebook post id, the same opening text, or ≥50 % shared 5-word phrases with an on-site memory; flags the same title or date and repeats inside the manifest. |
| `lib/images.js` | File present, JPEG/PNG, dimensions, SHA-256, ≤ 3.2 MB (Vercel's 4.5 MB request limit with base64), order 1..n (order 1 = Primary), no repeats, count = Facebook count. |
| `lib/ledger.js` | Append-only JSON-lines ledger: `created`, `image`, `verified`, `error`, `batch-built`. A run resumes from it and only ever touches ids it created. |
| `lib/api.js` | Admin API client. Reads need `HL_ADMIN_TOKEN` in the operator's own shell (never in files, logs or chat). Writes are disabled. |
| `fixtures/site-snapshot-2026-10-30.json` | The 19 live memories + pilot Draft No. 404 (protected ids; 403 is This Week's). Used by the unit tests and for provisional ids. |
| `test/importer.test.js` | Unit tests: `node --test tools/facebook-import/test/importer.test.js` |
| `rehearsal/*.cjs` | Isolated end-to-end rehearsals (below). |

## Photo mode (zero-photo safeguard)

Every planned post and every batch item **must declare `photoMode`**. There is no default.

| `photoMode` | Meaning | Rules |
|---|---|---|
| `"photos"` | Import with photos 1..n | At least one photo listed. Photo 1 is the only Primary, and the order follows Facebook. Every local file must match its approved SHA-256. |
| `"none"` | Import without any photo | No photo listed. The post either has no photos (`photosConfirmedNone`), or it is a text-only import whose images the owner excluded (`excludeImages: true` in the manifest entry). |

- **Fails closed.** These stop the whole batch in preflight, before any write:
  - a missing or unknown `photoMode`;
  - `"none"` with photos listed;
  - `"photos"` with none listed.
- **Part of the approval.** `photoMode` is in the approval fingerprint, so removing a post's photos after approval (switching it to `"none"`) no longer matches the approved fingerprint.
- **No upload requests.** A `"none"` post sends no photo-upload request. Its gallery must read back empty with no Primary; a photo found there stops the batch.
- **Read-back check.** For every `"photos"` post the read-back checks the stored file names, their order and the Primary. It also checks the **SHA-256 of every stored original** through `opts.readStoredPhoto(storyId, galleryItem)`. A batch with photos and no reader stops in preflight.

## Manifest fields set by the owner during review

`approved` · `title` · `category` (`funny|grief|momdad|toledo|shabbat|ordinary`) · `removeLines` (exact lines to
leave out) · `keepFirstLine` · `photosConfirmedNone` (the post really has no photos) · `excludeImages` (text-only import) ·
`photos.files` (ordered).

## Isolated rehearsals

Each rehearsal runs the real `api/[...path].js` from a **throwaway git worktree**, in file mode on 127.0.0.1, with a random token.
- Supabase Storage and the Vercel deploy hook are local stubs.
- Local photos are only read.
- The build step needs `sharp` on `NODE_PATH`.

```
git worktree add --detach <tmp>/t <commit>
node tools/facebook-import/rehearsal/zero-photo-workflow.cjs <tmp>/t <manifest.json> tools/facebook-import/fixtures/site-snapshot-2026-10-30.json <out.json>
node tools/facebook-import/rehearsal/pr1-regression.cjs <tmp>/t patched <dry-run plan.json> <out.json>
node tools/facebook-import/rehearsal/payload-rehearsal.cjs <tmp>/t <batch-NN-import-payload.json> <out.json>
git worktree remove --force <tmp>/t
```

Use a fresh worktree for each rehearsal, because they write test data into it.

## How a future authorized batch would run

**Strictly serial**: one request at a time, with nobody saving in the admin. Before the run:
1. Take a GET-only backup (`/api/stories`, `/api/story-photos`, `/api/site`, `/api/entities`).
2. Take a fresh snapshot, and re-plan the story ids from it.

`runBatch()` then creates each Draft with the `x-defer-rebuild: 1` header, uploads its photos in order, and verifies:
- status, featured, title, text, date and category;
- photo files, their order, Primary and stored bytes.

Only when every post is verified does it send the one build.

**If the run stops:** a stopped batch never builds, and its Drafts stay unpublished. Re-running resumes the same batch. Only ledger-owned ids may ever be removed, and existing memories are never in scope.
