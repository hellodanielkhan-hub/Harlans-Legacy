/* =========================================================================
   Harlan's Legacy — the Archive page (archive.html)

   The complete collection, where browsing belongs. The homepage is only a
   window into it (This Week's memory + one more + "Explore the archive").
   Every published memory is listed here, newest first, grouped by the month
   it was kept; theme filters (only themes that actually hold memories, with
   counts) and the grouped search over stories/people/places/objects/events
   (moved here from the homepage) sit above the list. Coming-soon memories,
   if any, follow as unlinked entries. Drafts never reach this page (build.js
   filters them before calling in).

   Denser than the homepage by design, but in the same museum language: a
   catalogue ledger — date, small matted plate, title, opening line, thread.
   ========================================================================= */
"use strict";

const { pageShell, text, attr } = require("./family.js");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Plain opening line for a ledger entry: the summary, cleaned of markdown marks
// and of an exact doubled sentence, trimmed at a word boundary.
function openingLine(s, max) {
  let t = String(s.summary || s.lead || "").replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(.{12,}?)\s+\1(?=\s|$)/, "$1");            // a dateline typed twice
  const half = t.length / 2;
  if (t.length > 20 && t.slice(0, Math.floor(half)).trim() === t.slice(Math.ceil(half)).trim()) t = t.slice(0, Math.floor(half)).trim();
  if (t.length > max) t = t.slice(0, t.lastIndexOf(" ", max)).replace(/[,;:—–-]+$/, "") + "…";
  return t;
}

function monthKey(s) { return (s.publishedISO || "").slice(0, 7); }
function monthTitle(key) { const [y, m] = key.split("-"); return `<span>${MONTHS[+m - 1]}</span> ${y}`; }
function dayLabel(s) { const [, m, d] = (s.publishedISO || "").split("-"); return m ? `${SHORT[+m - 1]} ${+d}` : text(s.dateLabel || ""); }

function entry(s, deps) {
  const plate = deps.storyPhotoPicture(s, "(max-width:640px) 76px, 104px");
  const dot = `background:var(--thread-${s.theme})`;
  const narrated = deps.listenOn(s) ? `<span class="arc-narrated" title="This memory can be listened to on its page">Narrated</span>` : "";
  const inner = [
    `<span class="arc-date">No.&nbsp;${s.id}<br><b>${dayLabel(s)}</b></span>`,
    plate ? `<span class="arc-plate">${plate}</span>` : `<span class="arc-plate is-words" aria-hidden="true"><span class="arc-mark"></span></span>`,
    `<span class="arc-text"><span class="arc-title">${text(s.title)}</span><span class="arc-teaser">${text(openingLine(s, 150))}</span></span>`,
    `<span class="arc-thread"><span class="dot" style="${dot}"></span>${text(s.themeLabel)}${narrated}</span>`
  ].join("");
  return s.published
    ? `<li class="arc-item" data-theme="${attr(s.theme)}"><a class="arc-link" href="${s.url}">${inner}</a></li>`
    : `<li class="arc-item is-soon" data-theme="${attr(s.theme)}"><div class="arc-link">${inner}</div></li>`;
}

function renderArchive(site, stories, searchRecords, deps) {
  const byDate = (a, b) => ((a.publishedISO || "") < (b.publishedISO || "") ? 1 : (a.publishedISO || "") > (b.publishedISO || "") ? -1 : b.id - a.id);
  const pub = stories.filter(s => s.published).sort(byDate);
  const soon = stories.filter(s => !s.published).sort((a, b) => b.id - a.id);

  // theme filters: only threads that hold at least one memory, in site order
  const counts = {};
  stories.forEach(s => { counts[s.theme] = (counts[s.theme] || 0) + 1; });
  const chips = [`<button class="chip" type="button" data-filter="all" aria-pressed="true">All memories <span class="chip-n">${stories.length}</span></button>`]
    .concat(Object.keys(site.themes).filter(k => counts[k]).map(k =>
      `<button class="chip" type="button" data-filter="${attr(k)}" aria-pressed="false"><span class="dot" style="background:var(--thread-${k})"></span>${text(site.themes[k].label)} <span class="chip-n">${counts[k]}</span></button>`));

  // chronological ledger, grouped by the month each memory was kept
  const groups = [];
  pub.forEach(s => { const k = monthKey(s) || "undated"; let g = groups[groups.length - 1]; if (!g || g.key !== k) groups.push(g = { key: k, items: [] }); g.items.push(s); });
  const months = groups.map(g => `
      <section class="arc-month" aria-labelledby="m-${g.key}">
        <h2 class="arc-month-title" id="m-${g.key}">${g.key === "undated" ? "Undated" : monthTitle(g.key)}</h2>
        <ol class="arc-items">
          ${g.items.map(s => entry(s, deps)).join("\n          ")}
        </ol>
      </section>`).join("");
  const soonHtml = soon.length ? `
      <section class="arc-month arc-soon" aria-labelledby="m-soon">
        <h2 class="arc-month-title" id="m-soon"><span>Still being gathered</span></h2>
        <ol class="arc-items">
          ${soon.map(s => entry(s, deps)).join("\n          ")}
        </ol>
      </section>` : "";

  const safeIndex = JSON.stringify(searchRecords).replace(/</g, "\\u003c");
  const main = `
<main id="main">
  <section class="arc-head">
    <div class="container">
      <p class="eyebrow">The archive</p>
      <h1>Every Friday, a story — kept.</h1>
      <p class="arc-intro">The complete Harlan's Legacy archive is being gathered and added progressively. Each memory is kept the same way — completely, and on purpose.</p>
      <p class="arc-count">${pub.length} ${pub.length === 1 ? "memory" : "memories"} kept so far · newest first</p>
    </div>
  </section>

  <section class="arc-body" aria-label="All memories">
    <div class="container">
      <div class="arc-tools">
        <div class="archive-search" id="search">
          <label class="visually-hidden" for="hl-search-input">Search the archive, people, places, objects and events</label>
          <div class="search-field" role="combobox" aria-haspopup="listbox" aria-owns="search-panel" aria-expanded="false">
            <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg>
            <input type="text" id="hl-search-input" autocomplete="off" spellcheck="false" placeholder="Search stories, people, places, objects, events…" aria-controls="search-panel" aria-autocomplete="list" aria-activedescendant="">
            <button type="button" class="search-clear" id="search-clear" aria-label="Clear search" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>
          </div>
          <div class="search-panel" id="search-panel" role="listbox" aria-label="Search results" hidden></div>
          <p class="visually-hidden" id="search-status" aria-live="polite"></p>
        </div>
        <div class="chip-row" role="group" aria-label="Filter memories by thread">
          ${chips.join("\n          ")}
        </div>
      </div>
      <p class="visually-hidden" id="arc-status" aria-live="polite"></p>
      <div class="arc-list" id="arc-list">${months}${soonHtml}
      </div>
      <p class="arc-empty" id="arc-empty" hidden>No memories in that thread yet — try another, or show all.</p>
    </div>
  </section>
</main>
<script id="hl-search-index" type="application/json">${safeIndex}</script>
<script src="assets/archive-search.js" defer></script>`;

  return pageShell({
    depth: 0,
    active: "archive",
    title: "The Archive — Harlan's Legacy",
    description: "Every memory kept in Harlan's Legacy so far — one Friday at a time, newest first, by thread and by month.",
    canonical: `${site.domain}/archive.html`,
    footerNote: "The archive grows one Friday at a time.",
    css: ARCHIVE_CSS,
    main,
    script: ARCHIVE_SCRIPT
  });
}

// theme filter: shows/hides existing entries (native `hidden`), hides empty months
const ARCHIVE_SCRIPT = `
  var arcItems = Array.prototype.slice.call(document.querySelectorAll(".arc-item"));
  var arcMonths = Array.prototype.slice.call(document.querySelectorAll(".arc-month"));
  var arcChips = Array.prototype.slice.call(document.querySelectorAll(".chip-row .chip"));
  var arcEmpty = document.getElementById("arc-empty"), arcStatus = document.getElementById("arc-status");
  function arcFilter(f, label){
    var shown = 0;
    arcItems.forEach(function(li){ var m = f === "all" || li.getAttribute("data-theme") === f; li.hidden = !m; if (m) shown++; });
    arcMonths.forEach(function(sec){ sec.hidden = !sec.querySelector(".arc-item:not([hidden])"); });
    if (arcEmpty) arcEmpty.hidden = shown !== 0;
    if (arcStatus) arcStatus.textContent = "Showing " + shown + " of " + arcItems.length + " memories — " + label + ".";
  }
  arcChips.forEach(function(chip){
    chip.addEventListener("click", function(){
      arcChips.forEach(function(c){ c.setAttribute("aria-pressed", c === chip ? "true" : "false"); });
      var f = chip.getAttribute("data-filter");
      arcFilter(f, f === "all" ? "all memories" : chip.textContent.replace(/\\s*\\d+\\s*$/, "").trim());
      try { history.replaceState(null, "", f === "all" ? location.pathname : "#thread-" + f); } catch (e) {}
    });
  });
  var hm = /^#thread-([a-z]+)$/.exec(location.hash);
  if (hm) { var pre = arcChips.filter(function(c){ return c.getAttribute("data-filter") === hm[1]; })[0]; if (pre) pre.click(); }
`;

const ARCHIVE_CSS = `
.arc-head{ padding-block: clamp(var(--sp-6), 8vw, var(--sp-8)) var(--sp-4); }
.arc-head .eyebrow{ font-family: var(--font-voice); text-transform: uppercase; letter-spacing: .22em; font-size: .72rem; color: var(--ember-core); margin: 0; }
.arc-head h1{ font-family: var(--font-display); font-weight: 340; font-size: clamp(2.4rem, 1.4rem + 4vw, 4.6rem); line-height: 1.02; letter-spacing: -.022em; margin: var(--sp-2) 0 var(--sp-3); max-width: 16ch; text-wrap: balance; }
.arc-intro{ font-size: var(--text-body-lg, 1.2rem); color: var(--ink-secondary); max-width: 52ch; margin: 0 0 var(--sp-2); }
.arc-count{ font-family: var(--font-voice); text-transform: uppercase; letter-spacing: .14em; font-size: .7rem; color: var(--ink-muted); margin: 0; }
.arc-body{ padding-block: 0 var(--sp-8); }
.arc-tools{ position: sticky; top: 77px; z-index: 20; padding: var(--sp-3) 0; margin-bottom: var(--sp-3);
  background: color-mix(in srgb, var(--paper-base) 94%, transparent); border-bottom: 1px solid var(--ink-whisper); }
.archive-search{ position: relative; max-width: 640px; margin-bottom: var(--sp-2); }
.search-field{ display: flex; align-items: center; gap: var(--sp-2); background: var(--paper-raised); border: 1px solid var(--ink-whisper); border-radius: var(--radius-soft); padding: 0.15em 0.9em; transition: border-color var(--dur-quiet) var(--ease-settle), box-shadow var(--dur-quiet) var(--ease-settle); }
.search-field:focus-within{ border-color: var(--ember-core); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ember-glow) 30%, transparent); }
.search-icon{ width: 18px; height: 18px; color: var(--ink-muted); flex-shrink: 0; }
.search-field:focus-within .search-icon{ color: var(--ember-core); }
#hl-search-input{ flex: 1; min-width: 0; border: none; background: transparent; font-family: var(--font-reading); font-size: var(--text-body); color: var(--ink-primary); padding: 0.85em 0; outline: none; }
#hl-search-input::placeholder{ color: var(--ink-muted); }
.search-clear{ display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; background: transparent; color: var(--ink-muted); cursor: pointer; border-radius: 999px; flex-shrink: 0; }
.search-clear:hover{ color: var(--ember-core); }
.search-clear svg{ width: 16px; height: 16px; }
.search-panel{ position: absolute; top: calc(100% + 8px); left: 0; right: 0; background: var(--paper-raised); border: 1px solid var(--ink-whisper); border-radius: var(--radius-soft); box-shadow: var(--shadow-raised); max-height: min(60vh, 460px); overflow-y: auto; padding: var(--sp-1); }
.search-group{ padding: var(--sp-1) 0; }
.search-group + .search-group{ border-top: 1px solid var(--ink-whisper); }
.search-group-title{ display: flex; align-items: center; gap: 0.5em; font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-muted); font-weight: 500; padding: 0.5em 0.8em 0.35em; }
.search-group-title .dot{ width: 7px; height: 7px; border-radius: 50%; }
.search-result{ display: flex; align-items: baseline; gap: var(--sp-2); text-decoration: none; color: var(--ink-primary); padding: 0.6em 0.8em; border-radius: var(--radius-card); scroll-margin: 0.5em; }
.search-result:hover, .search-result.is-active{ background: var(--paper-deep); }
.search-result.is-active{ box-shadow: inset 2px 0 0 var(--ember-core); }
.search-result .sr-title{ font-weight: 500; }
.search-result .sr-title mark{ background: color-mix(in srgb, var(--ember-glow) 45%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.search-result .sr-sub{ font-size: var(--text-caption); color: var(--ink-muted); margin-left: auto; padding-left: var(--sp-2); white-space: nowrap; }
.search-empty{ padding: var(--sp-3) var(--sp-2); text-align: center; color: var(--ink-muted); font-size: var(--text-caption); }
.chip-row{ display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.chip{ font-size: var(--text-label); letter-spacing: 0.05em; padding: 0.5em 0.95em; min-height: 36px; border-radius: 999px; border: 1px solid var(--ink-whisper); background: transparent; color: var(--ink-secondary); cursor: pointer; display: inline-flex; align-items: center; gap: 0.5em; font-family: inherit; transition: border-color var(--dur-quiet), color var(--dur-quiet), background var(--dur-quiet); }
.chip .dot{ width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.chip .chip-n{ font-variant-numeric: tabular-nums; opacity: .6; }
.chip:hover{ border-color: var(--ember-core); color: var(--ink-primary); }
.chip[aria-pressed="true"]{ background: var(--ink-primary); border-color: var(--ink-primary); color: var(--paper-raised); }
.chip:focus-visible{ outline: 2px solid var(--ember-core); outline-offset: 3px; }

.arc-month{ margin-top: var(--sp-6); padding-block: 0; }
.arc-month[hidden], .arc-item[hidden]{ display: none; }
.arc-month-title{ display: flex; align-items: baseline; gap: .5em; font-family: var(--font-voice); font-weight: 400; text-transform: uppercase; letter-spacing: .2em; font-size: .72rem; color: var(--label-ink, var(--ink-muted)); margin: 0 0 var(--sp-2); padding-bottom: .7rem; border-bottom: 1px solid var(--ink-whisper); }
.arc-month-title span{ font-family: var(--font-display); text-transform: none; letter-spacing: -.01em; font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.3rem); font-weight: 340; color: var(--ink-primary); }
.arc-items{ list-style: none; margin: 0; padding: 0; }
.arc-item + .arc-item{ border-top: 1px solid color-mix(in srgb, var(--ink-whisper) 70%, transparent); }
.arc-link{ display: grid; grid-template-columns: 6.5rem 104px minmax(0, 1fr) 13rem; gap: var(--sp-4); align-items: center; padding: var(--sp-3) var(--sp-2); margin-inline: calc(var(--sp-2) * -1); text-decoration: none; color: inherit; border-radius: 2px; transition: background var(--dur-quiet) var(--ease-settle); }
a.arc-link:hover{ background: color-mix(in srgb, var(--paper-raised) 70%, transparent); }
a.arc-link:hover .arc-title{ color: var(--ember-deep, var(--ember-core)); }
a.arc-link:focus-visible{ outline: 2px solid var(--ember-core); outline-offset: 2px; }
.arc-date{ font-family: var(--font-voice); text-transform: uppercase; letter-spacing: .14em; font-size: .64rem; line-height: 1.7; color: var(--ink-muted); }
.arc-date b{ font-weight: 400; color: var(--ink-secondary); letter-spacing: .1em; font-size: .78rem; }
.arc-plate{ display: block; width: 104px; aspect-ratio: 1; padding: 5px; background: var(--mat, var(--paper-raised)); border: 1px solid var(--frame-line, var(--ink-whisper)); box-shadow: var(--exhibit-shadow, var(--shadow-card)); }
.arc-plate picture, .arc-plate img{ display: block; width: 100%; height: 100%; object-fit: cover; }
.arc-plate.is-words{ display: grid; place-items: center; }
.arc-mark{ width: 30%; height: 1px; background: var(--ember-core); opacity: .7; }
.arc-text{ display: flex; flex-direction: column; gap: .3rem; min-width: 0; }
.arc-title{ font-family: var(--font-display); font-weight: 440; font-size: clamp(1.25rem, 1.05rem + .7vw, 1.6rem); line-height: 1.15; letter-spacing: -.01em; color: var(--ink-primary); transition: color var(--dur-quiet); text-wrap: balance; }
.arc-teaser{ color: var(--ink-secondary); font-size: .98rem; line-height: 1.5; max-width: 62ch; }
.arc-thread{ display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; font-family: var(--font-voice); text-transform: uppercase; letter-spacing: .1em; font-size: .62rem; color: var(--ink-muted); }
.arc-thread .dot{ width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.arc-narrated{ flex-basis: 100%; color: var(--ember-core); }
.arc-narrated::before{ content: "▸ "; }
.is-soon .arc-title{ color: var(--ink-secondary); }
.arc-empty{ padding: var(--sp-5); text-align: center; color: var(--ink-secondary); border: 1px dashed var(--ink-whisper); border-radius: var(--radius-soft); margin-top: var(--sp-5); }
@media (max-width: 960px){ .arc-link{ grid-template-columns: 5.5rem 88px minmax(0, 1fr); } .arc-plate{ width: 88px; } .arc-thread{ grid-column: 3; margin-top: -.6rem; } }
@media (max-width: 720px){ .arc-tools{ top: 77px; } }
@media (max-width: 640px){
  .arc-tools{ position: static; background: none; }
  .arc-link{ grid-template-columns: 76px minmax(0, 1fr); gap: .35rem var(--sp-3); align-items: start; padding-block: var(--sp-3); }
  .arc-plate{ width: 76px; grid-row: span 3; }
  .arc-date{ grid-column: 2; order: -1; line-height: 1.4; }
  .arc-date br{ display: none; }
  .arc-date b::before{ content: " · "; }
  .arc-text, .arc-thread{ grid-column: 2; margin-top: 0; }
  .arc-teaser{ font-size: .95rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .chip-row{ flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-inline: calc(var(--sp-3) * -1); padding-inline: var(--sp-3); -webkit-overflow-scrolling: touch; }
  .chip-row::-webkit-scrollbar{ display: none; }
  .chip{ flex-shrink: 0; }
  .search-result .sr-sub{ display: none; }
}
`;

module.exports = { renderArchive, openingLine };
