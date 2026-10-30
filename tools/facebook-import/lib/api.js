/* Read-only client for the existing Admin API (the same endpoints the Editorial Workspace uses).

   This client never writes: every write method throws before any network call. The only write path in
   the tool is lib/transport.js, reached only through the interactive authorization in lib/run.js.
   Read methods need HL_ADMIN_TOKEN in the environment of the person running them (see README: safe
   token entry); the snapshot/backup commands use a hidden prompt instead.

   Token handling:
   - the token is taken from HL_ADMIN_TOKEN once, and the variable is deleted from this process's environment
     straight away, so child processes and later code never see it;
   - it is held in a closure, not on the object, so logging or serializing the client cannot print it;
   - it is sent only in the x-admin-token header; a URL carrying a credential is refused;
   - every error message is scrubbed of it; close() forgets it. */
"use strict";

const { scrub, assertNoUrlCredentials } = require("./secrets.js");

const WRITES_ENABLED = false; // Turning this on requires the owner's separate written authorization.

class AdminApi {
  constructor(opts) {
    opts = opts || {};
    this.base = (opts.base || "https://www.harlanslegacy.com").replace(/\/$/, "");
    assertNoUrlCredentials(this.base);
    let token = opts.token !== undefined ? opts.token : process.env.HL_ADMIN_TOKEN;
    delete process.env.HL_ADMIN_TOKEN;
    const fetchFn = opts.fetch || globalThis.fetch;
    this.writesEnabled = WRITES_ENABLED && opts.allowWrites === true;
    const secrets = () => (token ? [token] : []);

    this.get = async (path) => {
      try {
        if (!token) throw new Error("HL_ADMIN_TOKEN is not set (read commands need it; dry-run does not).");
        const url = this.base + path;
        assertNoUrlCredentials(url);
        const r = await fetchFn(url, { headers: { "x-admin-token": token }, cache: "no-store" });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${body.error || ""}`.trim());
        return body;
      } catch (e) {
        throw new Error(scrub(e && e.message || e, secrets()));
      }
    };
    this.close = () => { token = null; delete process.env.HL_ADMIN_TOKEN; };
  }

  listStories() { return this.get("/api/stories"); }
  getStory(id) { return this.get("/api/stories/" + Number(id)); }
  getGallery(id) { return this.get("/api/story-photos/" + Number(id)); }
  getAllGalleries() { return this.get("/api/story-photos"); }
  getSite() { return this.get("/api/site"); }
  getEntities() { return this.get("/api/entities"); }
  getNarration(id) { return this.get("/api/narration/" + Number(id)); }

  _write() {
    if (!this.writesEnabled) throw new Error("Writes are disabled in this build (dry-run only).");
    throw new Error("Write transport not implemented until the import is authorized.");
  }
  createStory(/* body */) { return this._write(); }
  uploadImage(/* id, filename, dataUrl */) { return this._write(); }
}

module.exports = { AdminApi, WRITES_ENABLED };
