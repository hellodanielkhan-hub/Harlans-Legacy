/* Append-only progress ledger (JSON lines). The import resumes from the last confirmed step per post;
   nothing is ever assumed saved without a "verified" line written after reading it back. */
"use strict";

const fs = require("fs");
const path = require("path");

const STEPS = ["created", "image", "verified"];

class Ledger {
  constructor(file) { this.file = file; }

  read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  }

  append(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + "\n");
  }

  // Per post: { storyId, imagesDone:[order...], verified, failed }
  state() {
    const s = {};
    for (const e of this.read()) {
      const p = s[e.postId] = s[e.postId] || { storyId: null, imagesDone: [], verified: false, lastError: null };
      if (e.step === "created") p.storyId = e.storyId;
      if (e.step === "image") p.imagesDone.push(e.order);
      if (e.step === "verified") p.verified = true;
      if (e.step === "error") p.lastError = e.error;
    }
    return s;
  }

  // Has this batch already had its one closing build (step "batch-built")?
  batchBuilt(batchId) { return this.read().some(e => e.step === "batch-built" && e.batchId === batchId); }

  // Story ids this importer created; the only ids it may ever touch again.
  ownedIds() { return new Set(Object.values(this.state()).map(p => p.storyId).filter(id => id != null)); }
}

module.exports = { Ledger, STEPS };
