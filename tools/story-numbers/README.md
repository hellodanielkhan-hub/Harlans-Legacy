# Story Numbers (Scenario 2+)

Every memory has three separate identifiers:

| Field | What it is | Shown to readers |
|---|---|---|
| `storyNumber` | The permanent Harlan's Legacy Story Number. It is unique, never reused and never a retired number. | Yes: "No. N" / "Story No. N" |
| `originalBlogNumber` | Hal's own Facebook issue number, where he stated one. It may repeat (#388 appears twice). | No (reference only) |
| `id` | The internal Record ID. It keys the URL, galleries, narration folders and echo stories. | Never |

## What is public and what is private

**Public** (this repository):
- `data/story-number-policy.json`: the 56 retired numbers, the first new number (448), the rule that every other number below 448 is reserved for one historical weekly post, and the SHA-256 of the two private files.
- `data/story-number-assignments.json`: the approved map, as Record ID → Story No. and Original Blog No. only.
- `lib/numbering.js`: the rules, enforced by the serverless API and the local server.
  - The server refuses a number that is retired, already in use, previously issued, or another record's approved number.
  - A reserved historical number can go only to its approved record, or to a memory created by the Facebook importer.
  - A saved number can't be changed or cleared, and a save without the field keeps it.
  - Publishing requires a number.

**Private** (kept outside the repository; required by the local tools only):
- `story-number-registry.full.json`: one entry per verified weekly post, with its internal post id, date and number.
- `story-number-assignments.full.json`: the approved map with the source post of every record.

`lib/private-registry.js` refuses the folder unless the hashes match the public policy, the numbering rule holds, and the private map equals the public one with every number tracing to its source post:

```
node tools/story-numbers/release.js check-registry --registry <private folder>
```

The importer uses the folder to give each new Draft its reserved number: `import.js dry-run … --registry <folder>`, or `build-batch-payload.js … --registry <folder>`. The approved payload fingerprint covers those numbers.

## The release: two separate operations

Each operation is its own interactive session. The admin token is entered once at a hidden prompt; each session takes its own fresh backup and can send exactly one kind of write.

```
node tools/story-numbers/release.js release-numbers --registry <private folder> --payload <batch-01-import-payload.json> --backup <empty dir> --ledger <file.jsonl>
# wait until the site has rebuilt (verify-public), then:
node tools/story-numbers/release.js publish-batch-1 --registry <private folder> --payload <batch-01-import-payload.json> --backup <another empty dir> --ledger <file.jsonl>
node tools/story-numbers/release.js verify-public          # read-only, no token
```

Both operations first check, before any write:
1. The deployed map equals this checkout's.
2. A complete backup has been taken and verified.
3. This Week is 405 alone, 404 is a Draft, and no Story Number is duplicated or retired.
4. The Batch 1 identity holds: the approved payload fingerprint, records 406–430 carrying its 25 posts one each, and each approved number tracing to the private registry.
5. Every Batch 1 photo matches the payload (SHA-256, order, Primary).

Then each operation writes:
- `release-numbers`: after the typed confirmation `ASSIGN 46 STORY NUMBERS`, one request writes only `storyNumber` and `originalBlogNumber`, in one store write with one rebuild. The result is verified by read-back.
- `publish-batch-1`: refused until the release is complete and visible on the public site. After the typed confirmation `PUBLISH 25 BATCH 1 STORIES`, one request publishes exactly 406–430. Only their status changes, with one rebuild. The result is verified by read-back and on the public pages.

Every step and every stop is appended to the ledger. A rerun never writes twice:
- An applied release has nothing to write.
- A publication whose answer was lost is detected and verified instead of being sent again.

## Tests

```
node --test lib/numbering.test.js
node --test tools/story-numbers/test/release.test.js            # API + both operations on 127.0.0.1, incl. lost answers and reruns
node --test tools/story-numbers/test/render.test.js             # every public display location, from a real build
node --test tools/story-numbers/test/private-registry.test.js   # set HL_STORY_REGISTRY_DIR to also check the real private files
```
