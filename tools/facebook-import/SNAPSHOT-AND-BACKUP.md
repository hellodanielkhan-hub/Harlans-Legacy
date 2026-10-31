# Snapshot, id allocation and backup: process and tooling design

**Status: implemented** in `lib/snapshot.js` (`import.js snapshot`, `backup`, `verify-backup`; the comparison after a run is part of `import.js run`). Rehearsed only against isolated local copies; it has not been run against Production. Where the implementation differs from the design below, the code and the README's "Production run" section are authoritative: the token is entered at a hidden prompt, and stored originals are read through the admin-only `GET /api/story-photos/<id>/<photoId>/original` route.

Every step is **read-only (GET)**. Credentials come only from `HL_ADMIN_TOKEN`, entered as described in the README ("safe token entry"). They are deleted from the environment when read, sent only in the `x-admin-token` header, and never written to any file below.

## 1. Fresh read-only Production inventory snapshot

`node import.js snapshot --out <run folder>` (proposed)

| Read | Endpoint | Saved as |
|---|---|---|
| All memories (published, Coming Soon, Drafts) | `GET /api/stories` | `snapshot.json` → `memories[]` |
| All galleries | `GET /api/story-photos` | `snapshot.json` → `galleries{}` |

`snapshot.json`:

```json
{ "takenAt": "<ISO time>", "source": "GET https://www.harlanslegacy.com/api/stories + /api/story-photos",
  "count": 0, "maxId": 0,
  "memories": [ { "id": 0, "status": "", "featured": false, "title": "", "importSource": null, "sha256": "<canonical JSON of the memory>" } ],
  "galleries": { "story-<id>": { "primary": "", "files": [""] } },
  "sha256": "<of everything above>" }
```

- **Fail closed.** Any non-200 answer, an empty list, or a list without every id in `PROTECTED_IDS` stops the snapshot.
- **What the runner uses.** `runBatch()` takes `opts.snapshot` (`takenAt` + `memories[]` with id, status, featured and importSource). It refuses a snapshot older than 6 hours.

## 2. Collision-free story id allocation

1. Run `plan()` with the fresh snapshot.
   - New ids start after **every** id in the snapshot and every id in the importer's ledger (`max + 1`).
   - Ids in `protectedIds` are refused.
2. Rebuild the payload with `build-batch-payload.js --snapshot <fresh snapshot.json>`. The approvals stay valid, because the story id is the one field the fingerprint leaves out.
3. **At run time** `runBatch()` checks again, against the snapshot and its fixed `PROTECTED_IDS`. Then, per post:
   - it creates only after `GET /api/stories/<id>` answers 404;
   - the API refuses an existing id with 409.
4. **If the site changes between the snapshot and the run** (an editor saves a new memory), the batch stops at that post with nothing overwritten. Take a new snapshot and re-plan.

## 3. Read-only backup of the relevant records and photos

`node import.js backup --out <run folder>/backup` (proposed). Run it immediately before the batch, after the snapshot.

| Item | Source | Saved as |
|---|---|---|
| Every memory record | `GET /api/stories` | `stories.json` |
| Every gallery manifest | `GET /api/story-photos` | `story-photos.json` |
| Site settings, entities | `GET /api/site`, `GET /api/entities` | `site.json`, `entities.json` |
| Protected memories, one by one | `GET /api/stories/<id>` for 303-305, 388-404 | `protected/<id>.json` |
| Stored photo originals of the protected memories | the planned admin-only photo endpoint (separate API change), not public URLs | `protected/photos/<id>/<file>` + `SHA256SUMS.txt` |

The backup folder stays on the operator's machine. It is never committed and never uploaded. It holds no credential: request headers are not saved.

## 4. Backup integrity verification

`node import.js verify-backup <backup folder>` (proposed):
- Every file must be listed in `MANIFEST.json`, with its byte count and SHA-256. Recompute and compare them.
- The record count and the id set must equal the snapshot's.
- Every protected id must be present, with the same canonical SHA-256 as in the snapshot.
- For every protected photo: the stored digest (from the admin endpoint) must equal the SHA-256 of the backed-up bytes.
- Any mismatch blocks the run.

## 5. Confirming protected records stay unchanged

`node import.js check-protected --before <backup> --after <new snapshot>` (proposed). Run it after the batch, and after any resume.
- Take a new read-only snapshot.
- For each of 303-305, 388-403 and 404: compare the canonical record SHA-256, the gallery file list and the Primary with the backup. All must be identical.
- No. 403 must still be the featured memory.
- Live count unchanged; Drafts increased by exactly the batch's verified posts.
- The public site must have no `/story/<id>-*.html` for any imported Draft.

These checks are what the rehearsals already assert on throwaway data ("every memory that existed before the test is byte-identical", "protected memories and their galleries are byte-identical after every attempt").

## Order of operations for an authorized batch

| Step | Action | Writes? |
|---|---|---|
| 1 | Safe token entry | — |
| 2 | Snapshot | read-only |
| 3 | Backup + verify-backup | read-only |
| 4 | Re-plan + rebuild the payload | local files only |
| 5 | Owner authorization and enabling writes | separate decision |
| 6 | `runBatch` | Draft creates and photo uploads, deferred; one build |
| 7 | New snapshot + check-protected | read-only |
| 8 | Clear the token | — |
