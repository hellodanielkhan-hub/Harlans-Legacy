/* =========================================================================
   Harlan's Legacy — REMOTE ASYNC PROVIDER TRANSPORT (contract §3.2, spec §17.3)

   HARLAN_PROVIDER_A_ENDPOINT is the provider's BASE URL. Routes:
     POST   <base>/v1/synthesize              signed envelope → 202 {providerJobId}
     GET    <base>/v1/jobs/<id>               status, heartbeat, signed completion
     GET    <base>/v1/jobs/<id>/files/<name>  pull a finished output (signed)
     DELETE <base>/v1/jobs/<id>               cancel + delete provider-side outputs
     GET    <base>/v1/health                  slots / devices / cold-start timestamps
   Poll + pull means the benchmark needs NO public platform URL and the provider
   holds NO platform storage credentials. A push callback
   (HARLAN_STAGING_COMPLETION_URL) is optional and uses the same signed envelopes.
   Nothing here can set Ready/Approved or publish.
   ========================================================================= */
"use strict";

const { ProviderError, ACCEPT_TIMEOUT_MS, signPayload, signRequest } = require("./contract.js");

function base(cfg) {
  if (!cfg || !cfg.endpoint || !cfg.secret) throw new ProviderError("provider_not_configured", "remote provider endpoint/secret not configured");
  return String(cfg.endpoint).replace(/\/+$/, "").replace(/\/v1\/synthesize$/, "");
}

async function timed(url, init, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ctl.signal }, init)); }
  catch (e) { throw new ProviderError(e && e.name === "AbortError" ? "timeout" : "capacity", "provider unreachable: " + String(e && e.message || e)); }
  finally { clearTimeout(timer); }
}

async function dispatch(request, cfg) {
  const b = base(cfg);
  const envelope = signPayload(request, cfg.secret);
  const t0 = Date.now();
  const res = await timed(b + "/v1/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) }, cfg.acceptTimeoutMs || ACCEPT_TIMEOUT_MS);
  const acceptMs = Date.now() - t0;
  let body = null; try { body = await res.json(); } catch (e) { /* non-JSON */ }
  if (res.status === 400 || res.status === 422) throw new ProviderError((body && body.code === "voice_unavailable") ? "voice_unavailable" : "invalid_request", "provider rejected request: " + JSON.stringify(body));
  if (res.status === 401) throw new ProviderError("signature_invalid", "provider rejected the request signature");
  if (res.status === 429 || res.status === 503) throw new ProviderError("capacity", "provider at capacity (" + res.status + ")");
  if (!res.ok) throw new ProviderError("internal", "provider error " + res.status);
  if (!body || !body.providerJobId) throw new ProviderError("result_invalid", "provider did not return providerJobId");
  return { providerJobId: body.providerJobId, acceptMs, accepted: body };
}

async function signedGet(cfg, pathname, ms) {
  const res = await timed(base(cfg) + pathname, { method: "GET", headers: signRequest("GET", pathname, cfg.secret) }, ms || 15000);
  if (res.status === 401) throw new ProviderError("signature_invalid", "provider rejected the request signature");
  return res;
}

async function poll(cfg, providerJobId) {
  const res = await signedGet(cfg, "/v1/jobs/" + encodeURIComponent(providerJobId));
  if (res.status === 404) throw new ProviderError("heartbeat_lost", "provider no longer knows job " + providerJobId);
  if (!res.ok) throw new ProviderError("internal", "provider poll error " + res.status);
  return res.json();
}

async function fetchFile(cfg, providerJobId, name) {
  const res = await signedGet(cfg, "/v1/jobs/" + encodeURIComponent(providerJobId) + "/files/" + encodeURIComponent(name), 120000);
  if (!res.ok) throw new ProviderError("result_invalid", "provider file " + name + " unavailable (" + res.status + ")");
  return Buffer.from(await res.arrayBuffer());
}

async function health(cfg) {
  const res = await signedGet(cfg, "/v1/health");
  if (!res.ok) throw new ProviderError("capacity", "provider health " + res.status);
  return res.json();
}

async function cancel(cfg, providerJobId) {
  const p = "/v1/jobs/" + encodeURIComponent(providerJobId);
  const res = await timed(base(cfg) + p, { method: "DELETE", headers: signRequest("DELETE", p, cfg.secret) }, 15000);
  return res.ok;
}

module.exports = { dispatch, poll, fetchFile, health, cancel };
