/* =========================================================================
   Harlan's Legacy — narration VOICE IDENTITY (provider-neutral)

   The voice identity is the creative voice itself ("harlan-v1"), independent of
   whichever provider synthesizes it. Freshness, job idempotency and caching use
   ONLY the identity version (NARRATION_PROVIDER_SPEC.md §6):

     • Switching or upgrading a PROVIDER never changes this → existing approved
       narrations are never marked outdated by a provider change.
     • Bump HARLAN_VOICE_IDENTITY_VERSION only for a deliberate change of the
       voice itself, which intentionally outdates approvals.

   HARLAN_VOICE_VERSION is read as a legacy fallback so existing records
   (voiceVersion "1") keep their meaning.
   ========================================================================= */
"use strict";

const VOICE_ID = process.env.HARLAN_VOICE_ID || "harlan-v1";
const VOICE_IDENTITY_VERSION = String(process.env.HARLAN_VOICE_IDENTITY_VERSION || process.env.HARLAN_VOICE_VERSION || "1");

module.exports = { VOICE_ID, VOICE_IDENTITY_VERSION };
