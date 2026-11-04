/* The 25 owner-approved Batch 1 posts: imported 2026-10-31 as Drafts 406–430 (batch "batch-01").
   The only records the publish operation may publish. Which source post each record carries is checked
   at run time against the approved payload and the private registry (no post ids in this public file). */
"use strict";

const BATCH_1_IDS = Object.freeze(Array.from({ length: 25 }, (_, i) => 406 + i));
// lib/authorize.js payloadFingerprint() of the approved batch-01-import-payload.json
const BATCH_1_PAYLOAD_FINGERPRINT = "495ee0f7def7674105b917c36356916e5cfbfe475ece894731ed8f22b3d4a5db";
const BATCH_1_PHOTOS = 23;          // photographs across the 21 photo posts
const BATCH_1_TEXT_ONLY = 4;

// The This Week story, and record 404, which no batch authorization covers (a Draft until the owner published it
// in the Editorial Workspace on 2026-11-04; these tools never write it).
const FEATURED_ID = 405;
const SEPARATE_DRAFT_ID = 404;

module.exports = { BATCH_1_IDS, BATCH_1_PAYLOAD_FINGERPRINT, BATCH_1_PHOTOS, BATCH_1_TEXT_ONLY, FEATURED_ID, SEPARATE_DRAFT_ID };
