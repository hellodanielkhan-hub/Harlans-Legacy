# Facebook Shabbat Shalom importer

Local tool for adding the missing Facebook "Shabbat Shalom" posts to Harlan's Legacy as **Draft** memories
through the **existing Admin API**: the same endpoints and record shape the Editorial Workspace uses.
Built against `3a327d8` (`main` after PR #1, which lets a batch defer the rebuild on Draft writes).

**Dry-run is the default. A Production write happens only through `import.js run`, interactively** (see "Production run" below):
- the exact batch identifier and payload fingerprint are typed, the admin token is entered at a hidden prompt, and a typed confirmation phrase is required after the read-only checks;
- no environment variable, flag or argument can skip any of these steps;
- `lib/transport.js` can only create new non-featured Drafts, upload their photos and send one build; it refuses every PUT and DELETE and every other path before a request is made;
- `lib/api.js` stays a read-only client (`WRITES_ENABLED = false`).

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
| `lib/transport.js` | The live transport: an allow-list of the reads above and the only writes the import needs (new Drafts, their photos, one build). It talks **only** to `https://www.harlanslegacy.com` (exact match), refuses redirects, and keeps the token in a closure, header only. `createRehearsalTransport()` is the separate loopback-only interface the rehearsals use; the CLI never loads it. |
| `lib/snapshot.js` | Fresh read-only snapshot, collision-free id allocation, local backup (records, site documents, every stored original) and its verification, post-run comparison. |
| `lib/authorize.js` | The interactive authorization: TTY only, batch identifier, payload fingerprint, hidden token, typed confirmation phrase. |
| `lib/run.js` | One Production Draft import, start to finish, in the order shown under "Production run". |
| `fixtures/synthetic-site-snapshot.json` | Synthetic snapshot for the unit tests: fictional ids, titles, dates and text. A real site snapshot is never committed; real runs use a fresh read-only snapshot kept outside the repository. |
| `SNAPSHOT-AND-BACKUP.md` | Snapshot, id allocation, backup and integrity checks (implemented in `lib/snapshot.js`). |
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
node tools/facebook-import/rehearsal/first-batch-workflow.cjs <tmp>/a <tmp>/b <tmp>/c <batch-NN-import-payload.json> <out.json>
git worktree remove --force <tmp>/t
```

## Production run

Needs the owner's separate written authorization, and the API change in this PR deployed (header-only auth and
`GET /api/story-photos/<id>/<photoId>/digest|original`). Strictly serial, with nobody saving in the admin.

**Destination:**
- `snapshot`, `backup` and `run` talk only to `https://www.harlanslegacy.com`.
- There is no `--api` option. Passing one is refused before the token prompt and before any request.
- The destination is printed before the token is asked for.
- A redirect is refused, never followed with the token.

```
node tools/facebook-import/import.js backup --out <empty local folder>          # read-only; verifies itself
node tools/facebook-import/import.js verify-backup <folder>                     # offline re-check
node tools/facebook-import/import.js run --payload <batch-01-import-payload.json> --backup <folder> --ledger <ledger.jsonl>
```

`run` (lib/run.js) stops at the first failed step and writes nothing before step 6:
1. **Payload:** every item matches its approval fingerprint; counts are shown.
2. **Backup:** verifies (every file's SHA-256, every memory's record, every stored photo equal to the server-side digest) and is under 6 hours old.
3. **Authorization:** an interactive terminal; type the batch identifier (`batch-01`); paste the payload fingerprint; enter the admin token at the hidden prompt.
4. **Snapshot:** fresh and read-only. Every memory in the backup must be unchanged; anything new must be this batch's own import Draft.
5. **Ids:** allocated after the highest occupied, protected or ledger id (the provisional ids in the payload are never used as such); each new id must answer 404 on a direct check.
6. **Confirmation:** the summary (ids, counts, snapshot) is shown; type `IMPORT batch-01 AS DRAFTS`.
7. **Import:** `runBatch()` creates the Drafts with `x-defer-rebuild: 1`, uploads photos in order (photo 1 is Primary), reads every record, gallery and stored photo back (SHA-256 through the digest route), and sends **one** build only when every post is verified.
8. **After:** a second read-only snapshot; every pre-existing memory must be unchanged.

**If it stops** (network, HTTP error, mismatch, interruption): no build is sent. Drafts already created stay in the
database as **unpublished Drafts**; they are not on the public site. Run the same command with the same ledger to
resume: posts keep their ids (from the ledger, or found by `importSource` when an answer was lost), photos already
stored are not uploaded again, and the one build follows only when all 25 are verified. Re-running a completed batch
sends nothing. Removing Drafts left by an abandoned batch is a separate, separately authorized step; this tool
cannot delete.
