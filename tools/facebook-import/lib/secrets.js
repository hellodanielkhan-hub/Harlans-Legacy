/* Keeps credentials out of URLs, logs, ledgers, reports and error messages. */
"use strict";

// Credentials travel only in request headers. Any URL that carries one is refused before it is used.
const URL_CREDENTIAL = /[?&#](?:token|admin[-_]?token|moderator[-_]?token|key|apikey|api_key|access_token|secret|password)=/i;
function assertNoUrlCredentials(url) {
  if (URL_CREDENTIAL.test(String(url))) throw new Error("refusing a URL that carries a credential; credentials go in headers only");
}

// Replace every known secret, and anything that looks like a credential assignment, with [redacted].
function scrub(text, secrets) {
  let s = String(text);
  for (const v of secrets || []) if (v && String(v).length >= 4) s = s.split(String(v)).join("[redacted]");
  return s
    .replace(/((?:x-(?:admin|moderator)-token|authorization)["']?\s*[:=]\s*["']?)[^\s"'\\,;}]+/gi, "$1[redacted]")
    .replace(/([?&#](?:token|admin[-_]?token|moderator[-_]?token|key|apikey|api_key|access_token|secret|password)=)[^&#\s"'\\]+/gi, "$1[redacted]");
}

module.exports = { scrub, assertNoUrlCredentials, URL_CREDENTIAL };
