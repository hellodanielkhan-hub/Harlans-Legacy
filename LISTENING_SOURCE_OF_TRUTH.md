# Listening — Source of Truth

This document is authoritative. If code and this document disagree, treat it as a bug
and reconcile deliberately. The build enforces the invariants below (see
`assertListeningIntegrity` in `build.js`); do not weaken them to make a build pass.

## Approved feature origin
`listen-cinematic-experience-v2.html` — the canonical concept that was approved: a
cinematic physical-book Listening experience (closed book → opening ritual → settle →
narrated reading with spatial ink-front writing → single-leaf page turns → ending).

## Evolved feature lineage (successive stages of the SAME feature)
1. `listen-cinematic-experience-v2.html` — approved origin + latest evolved prototype.
2. Physical cinematic book opening/reading (composition, cover, opening) — `listen-cinematic-composition-v1.html`.
3. Master FSM + singleton fixed-slot leaf introduced — `listen-cinematic-book-v6.html`.
4. Authoritative-text + paint-only ink-front writing — `listen-memory-scene-v1.html`.
5. Page-turn debugging/proof (engineering only) — `listen-page-engine-proof.html` (motion sibling: `listen-cinematic-motion-proof.html`).
6. Corrected single-leaf / master-FSM / page-turn architecture folded back into the prototype.
7. **Final production engine** — `assets/listen-cinematic.js` (+ `assets/listen-cinematic.css`, `assets/listen-soundscape.js`).

The prototype/proof files are **reference/engineering artifacts** and MUST NOT be wired
into production. They are preserved, not rewritten or deleted.

## Canonical production engine
- **Engine ID:** `harlan-listen-cinematic` (constant `ENGINE_ID` + `window.HL_LISTEN_ENGINE`).
- **Files:** `assets/listen-cinematic.js`, `assets/listen-cinematic.css`, `assets/listen-soundscape.js`.
- **Derivation:** the evolved implementation of `listen-cinematic-experience-v2.html`,
  parameterized and modularized for the real reader. Mounted in a Shadow DOM so it
  cannot alter the normal reader.

## Manual page-turn proof
`listen-page-engine-proof.html` — an isolation rig used to fix page movement. **Not a
product.** Never wired into a story page.

## Required architectural invariants (enforced)
The production engine MUST contain all of:
- Master FSM `IDLE → ENTERING → CLOSED_BOOK → OPENING → OPEN_SETTLE → READING → (TURNING → READING)* → ENDING → EXIT`.
- **No narration / writing / focus / soundscape before `OPEN_SETTLE`** (they may start only in `enterReading`, which runs after the open sequence settles).
- Singleton fixed-slot `#leaf` + `#dest` destination handoff (the corrected page-turn from the proof). Exactly one turning leaf.
- Paint-only spatial ink-front writing (`mask-position`), layout never changes.
- Exactly one `.cur` spoken-word focus at any instant.
- `audio.currentTime` is the single authoritative reading clock.
- Ending/exit sequence, pause/resume, Escape teardown, responsive desktop/mobile.

Build markers asserted in the engine file: `harlan-listen-cinematic`, `OPEN_SETTLE`,
`destText`, `maskPosition`, `audio.currentTime`, `HL_LISTEN_ENGINE`.

## Narration / public-manifest contract
Per story, `assets/listen/<id>/listen.json` (written at approval) exposes ONLY approved
public playback data — paths are relative to `assets/listen/<id>/`:
```
{ audio, words, sentences, paragraphs, zones?, duration, voiceId, voiceVersion, soundscape?, label }
```
The engine consumes: the story's narrated paragraphs from the reader markup
(`[data-narrate]`), plus `narration.mp3` / `narration.words.json` /
`narration.sentences.json` / `narration.paragraphs.json` / `narration.zones.json` (when
present) from the manifest. No engine commands, worker commands, filesystem paths,
secrets, admin job details, or generation config are ever exposed to the browser.

## Soundscape source
The story-specific emotional soundscape lives in `assets/listen-soundscape.js`
(`HLSoundscape`). It is the approved Blue Chair score (a real C·Am7·Fmaj7·G6 chamber
progression + room tone + watch-tick), zone-driven from `narration.zones.json`, on an
independent WebAudio bus, automatically ducked under the narration. Narration remains
the authoritative voice track; missing zones/WebAudio fail gracefully to silence.

## Production gating rules
Listening is wired for a story ONLY when ALL hold (see `build.js`):
- `site.features.listening !== false` (feature flag, default on).
- `story.narration.status === "approved"`.
- `story.narration.sourceRevision === sourceRevision(story)` (fresh; edits → outdated → off).
- `assets/listen/<id>/listen.json` exists.

Missing / processing / failed / outdated / superseded → no Listen wiring at all; the
normal reader renders exactly as before. Audio/timings/zones load lazily only on the
Listen gesture.

## Legacy engine status
`assets/listen.js` + `assets/listen.css` = the OLD generic multi-leaf film player. It is
**RETIRED from production** (no longer injected by `build.js`) but **kept on disk as a
rollback reference** until the new engine passes full real-browser QA. It must never be
wired into a story page again (build guard enforces this).

## Platform capability & narration workflow (productization)
Cinematic Story Listening is a **platform capability available to every story**, not a
Blue-Chair special case. Blue Chair (214, generation `gen_4f94ce2febb7`) is the first
approved production story and the frozen reference for playback behavior.

Voice narration is a first-class authoring workflow:
- Per-story editor panel: status, freshness, generation, voice id/version, duration,
  generated/approved timestamps, truthful multi-stage progress (Queued → Generating →
  Aligning → Finalizing → Ready → Approved), Preview, Approve, Regenerate, Retry.
- Super-Admin **Narration Library** (`admin/narration.html`): every story's state +
  Generate / Regenerate / Preview / Approve, **Generate missing** (queues only
  missing/outdated/failed — never approved+fresh), Retry failed, Cancel queued, live
  job counts. Honestly reports "engine: not configured" when no synthesis engine is set.
- Generation is **not auto-approved**; the admin approves explicitly, which writes the
  public manifest and binds the generation to the story revision.

### Publication contract (§4/§5)
Publishing a story runs `publishReadiness`:
- **approved + fresh** → publishes with Listening; a `narrationPublication` binding
  `{storyId, sourceRevision, generationId, voiceId, voiceVersion, manifest, boundAt}` is
  stamped on the record.
- **outdated** (text changed) → publish is **blocked** (409 `narration_stale`); the stale
  narration is never published and no binding is written.
- **processing / failed / none** → the story may publish **without** Listening; no binding.

A published story therefore can never carry a binding for a stale revision (build guard
enforces this). Freshness is the existing SHA-256 `sourceRevision` of the narrated text.

### Engine (unchanged, engine-agnostic)
`NarrationService → VoiceEngineAdapter → configured Harlan engine → alignment → public
assets`. No second TTS architecture, no browser TTS, no fake speech, no voice
substitution. If `HARLAN_ENGINE_CMD` is unset the job fails truthfully with
`engine_not_configured`; the whole workflow stays wired for the real engine. Generation
runs in the worker, never the serverless request path.

## Guardrail
`build.js` runs `assertListeningIntegrity()` on every build and FAILS LOUDLY if: the
public reader references the legacy engine or a proof file; the production engine is
missing its ID or any invariant marker; Blue Chair loses its approved+fresh narration;
the Blue Chair manifest points to a different generation than the approved record; or
multiple competing engines are wired. It also enforces the narration/publication
contract for every story: each Listening-eligible story must be approved+fresh with a
public manifest that exists and points at its approved generation whose audio asset
exists on disk; every story must resolve a narration state; no **published** story may
carry a `narrationPublication` binding for a stale revision; and Blue Chair's approved
generation must remain exactly `gen_4f94ce2febb7`. "Currently wired" or a filename cannot
establish approval — only this contract + the enforced markers can.
