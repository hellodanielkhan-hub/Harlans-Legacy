# Facebook Shabbat Shalom importer

Local tool for adding the missing Facebook "Shabbat Shalom" posts to Harlan's Legacy as **Draft** memories
through the **existing Admin API**: the same endpoints and record shape the Editorial Workspace uses.
Built against `3a327d8` (`main` after PR #1, which lets a batch defer the rebuild on Draft writes).

**Production writes are disabled.**
- `lib/api.js` refuses every write (`WRITES_ENABLED = false`).
- `import.js` accepts only `dry-run`.
- `lib/batch.js` runs a batch only through an injected transport, and today only the isolated rehearsals provide one.

Enabling writes needs the owner's separate written authorization.

## Files

| File | Purpose |
|---|---|
| `import.js` | `dry-run`: oldest first, readiness, duplicates, exact request bodies, image order, rebuild impact. **No network calls.** Writes `runs/dry-run-<time>/`. `plan()` is shared with the batch tools. |
| `lib/batch.js` | Runs one approved batch: preflight, then per post create → upload photos → read back and verify, then **one** closing `POST /api/build` only when every post is verified. Resumes from the ledger without duplicates. |
| `lib/secrets.js` | Keeps credentials out of URLs, logs, ledgers and error messages. |
| `build-batch-payload.js` | Builds an import-ready batch payload (items + approval fingerprints) from the manifest and an approved-batch file. Stops on any difference from the approval. |
| `lib/text.js` | Facebook text → paragraphs. Removes only standalone hashtag lines, "Week/Issue #" headers, a title line equal to the title, Facebook's "See more/less", and lines listed in `removeLines`. Never edits wording. |
| `lib/record.js` | Builds the body exactly like `admin.js collect()` and previews it through the server's own `lib/records.js normalize()`. Status is always `draft`, featured `false`. |
| `lib/dupes.js` | Blocks the same Facebook post id, the same opening text, or ≥50 % shared 5-word phrases with an on-site memory; flags the same title or date. |
| `lib/images.js` | File present, JPEG/PNG, dimensions, SHA-256, ≤ 3.2 MB, order 1..n (order 1 = Primary), no repeats, count = Facebook count. |
| `lib/ledger.js` | Append-only JSON-lines ledger: `created`, `image`, `verified`, `error`, `batch-built`. |
| `lib/api.js` | Admin API read client. Writes are disabled. |
| `fixtures/synthetic-site-snapshot.json` | Synthetic snapshot for the unit tests: fictional ids, titles, dates and text. A real site snapshot is never committed; real runs use a fresh read-only snapshot kept outside the repository. |
| `SNAPSHOT-AND-BACKUP.md` | Process and tooling design: fresh read-only snapshot, id allocation, backup, integrity checks. |
| `test/importer.test.js` | Unit tests: `node --test tools/facebook-import/test/importer.test.js` |
| `rehearsal/*.cjs` | Isolated end-to-end rehearsals (below). |

## Safeguards in `lib/batch.js`

All of these run in **preflight, before any request is sent**. Any failure stops the whole batch with nothing written.

1. **Complete approval fingerprint.**
   - The owner approves the complete canonical import record: every record field except the provisional story id (title, slug, status, featured, category, dates, summary, description, ogDescription, lead, body, people/places/objects/events, bookPart, keywords, echoStories, readingTime, readerImages, importSource), plus `photoMode` and every photo's file name, order, Primary flag and SHA-256.
   - It is serialized deterministically, with sorted keys at every level, and hashed with SHA-256.
   - **Unknown fields are refused** at every level (item, record, `importSource`, photo); they are never ignored.
2. **Photo mode.** Every item declares `photoMode`, and there is no default.
   - `"photos"`: 1..n photos. Photo 1 is the only Primary, the order follows Facebook, and every local file must match its SHA-256.
   - `"none"`: no photo listed, and no upload request is ever sent.
   - A missing or unknown mode, `"none"` with photos, or `"photos"` without photos fails closed.
3. **Protected ids.** These come from the runner and a fresh read-only snapshot, **never from a payload**.
   - `PROTECTED_IDS` is fixed in `lib/batch.js`: Nos. 303-305, 388-403 and 404. No exception applies to them.
   - Every id the fresh snapshot (`opts.snapshot`) shows as occupied is also refused. The one exception is this importer's own Draft for the *same* post, so an interrupted batch can resume.
   - A snapshot must be under 6 hours old. A missing or stale snapshot stops the batch.
   - The API's own guards stay in place: 409 on an existing id, and adoption only of the same post's import Draft. The importer never sends PUT or DELETE.
4. **Deferred rebuild mode is required** (`defer: true`). A missing or false `defer` stops the batch, and no environment variable or argument can change that. A successful batch sends exactly one closing build; a stopped batch sends none.
5. **Read-back.** After each post is written, the story, its gallery and every stored photo are read back, and each read must answer HTTP 200.
   - Every record field is compared as stored.
   - The photos must match by file name, order and Primary.
   - Every stored original must match its approved SHA-256, through `opts.storedPhotoDigest(storyId, galleryItem)`. That function answers `{ status, body: { file, sha256 } }`.
   - A batch with photos and no digest function stops in preflight.
   - Production needs an admin-only digest endpoint, prepared separately as an API change. Until it exists, a batch with photos cannot run.
6. **Credentials.** `opts.secrets` and anything that looks like a credential are scrubbed from every ledger line and result message.

## Credentials: safe token entry

Reads (the snapshot and backup) need the Admin token in `HL_ADMIN_TOKEN`.
- `lib/api.js` reads it once and deletes it from the process environment straight away.
- It keeps the token in a closure that `close()` clears, sends it only in the `x-admin-token` header, and refuses any URL that carries a credential (`?token=` and the like).
- Its error messages are scrubbed.

**Never** type the token on a command line, put it in a file, or paste it into chat.

PowerShell. `Read-Host -AsSecureString` input is not written to PSReadLine history, and the commands themselves contain no secret:

```powershell
$sec = Read-Host "Admin token" -AsSecureString
$env:HL_ADMIN_TOKEN = [System.Net.NetworkCredential]::new("", $sec).Password
Remove-Variable sec
# ... run the read-only command ...
Remove-Item Env:HL_ADMIN_TOKEN
```

Never write `$env:HL_ADMIN_TOKEN = "<the token>"`: PSReadLine saves that line to `(Get-PSReadLineOption).HistorySavePath`.

Bash: `read -rs HL_ADMIN_TOKEN && export HL_ADMIN_TOKEN`, and afterwards `unset HL_ADMIN_TOKEN`.

## Manifest fields set by the owner during review

`approved` · `title` · `category` (`funny|grief|momdad|toledo|shabbat|ordinary`) · `removeLines` · `keepFirstLine` ·
`photosConfirmedNone` · `excludeImages` (text-only import) · `photos.files` (ordered).

## Isolated rehearsals

Each rehearsal runs the real `api/[...path].js` from a **throwaway git worktree**, in file mode on 127.0.0.1, with a random token.
- Supabase Storage, the stored-photo digest and the Vercel deploy hook are local stubs.
- Local photos are only read.
- The build step needs `sharp` on `NODE_PATH`.
- The manifest, `<snapshot.json>` (a read-only site snapshot) and `<samples.json>` (which manifest posts to rehearse with) are local files kept outside the repository.
- Use a fresh worktree for each rehearsal.

```
git worktree add --detach <tmp>/t <commit>
node tools/facebook-import/rehearsal/zero-photo-workflow.cjs <tmp>/t <manifest.json> <snapshot.json> <samples.json> <out.json>
node tools/facebook-import/rehearsal/pr1-regression.cjs <tmp>/t patched <dry-run plan.json> <out.json>
node tools/facebook-import/rehearsal/payload-rehearsal.cjs <tmp>/t <batch-NN-import-payload.json> <out.json>
git worktree remove --force <tmp>/t
```

## How a future authorized batch would run

See `SNAPSHOT-AND-BACKUP.md` for the steps before and after.

1. **Before the run:**
   - Make a read-only backup, and verify it.
   - Take a fresh read-only snapshot, and re-plan the ids from it.
   - Rebuild the payload. The approvals survive a re-plan, because the id is not fingerprinted.
2. **The run itself:** strictly serial, with nobody saving in the admin. `runBatch()` creates the Drafts with `x-defer-rebuild: 1`, uploads the photos in order, verifies everything, and sends the one build only when every post is verified.
3. **If the run stops:** a stopped batch never builds, and its Drafts stay unpublished. Re-running resumes the same batch. Only ledger-owned ids may ever be removed, and existing memories are never in scope.
