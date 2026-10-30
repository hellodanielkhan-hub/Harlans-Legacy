/* Client for the existing Admin API (the same endpoints the Editorial Workspace uses).

   This build is DRY-RUN ONLY: every write method throws before any network call.
   Read methods (used by future `backup` / `verify` commands) need HL_ADMIN_TOKEN in the
   environment of the person running them; the token is never written to disk or logs. */
"use strict";

const WRITES_ENABLED = false; // Turning this on requires the owner's separate written authorization.

class AdminApi {
  constructor(opts) {
    opts = opts || {};
    this.base = (opts.base || "https://www.harlanslegacy.com").replace(/\/$/, "");
    this.token = opts.token !== undefined ? opts.token : process.env.HL_ADMIN_TOKEN;
    this.fetch = opts.fetch || globalThis.fetch;
    this.writesEnabled = WRITES_ENABLED && opts.allowWrites === true;
  }

  async get(path) {
    if (!this.token) throw new Error("HL_ADMIN_TOKEN is not set (read commands need it; dry-run does not).");
    const r = await this.fetch(this.base + path, { headers: { "x-admin-token": this.token }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${body.error || ""}`.trim());
    return body;
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
