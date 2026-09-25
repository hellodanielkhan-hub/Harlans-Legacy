/* =========================================================================
   Harlan's Legacy — primary brand mark (header + mobile menu)

   The supplied logo in the site ink colour: one pre-tinted variant per theme
   (tools/brand/make-logo.cjs), AVIF with a palette-PNG fallback, at 120/240/360
   px wide for 1×–3× screens. CSS shows the variant for the active theme; both
   are loading="lazy", so the hidden one is never fetched. width/height plus the
   exact aspect-ratio reserve the box, so the logo never shifts layout.

   index.html (static) carries the same markup and CSS by hand.
   ========================================================================= */
"use strict";

const SIZES = "(max-width: 360px) 91px, (max-width: 720px) 102px, 114px";
const WIDTHS = [120, 240, 360];

function variant(P, theme) {
  const set = ext => WIDTHS.map(w => `${P}assets/brand/logo-${theme}-${w}.${ext} ${w}w`).join(", ");
  return `<picture class="brand-logo brand-logo-${theme}"><source type="image/avif" srcset="${set("avif")}" sizes="${SIZES}">` +
    `<img src="${P}assets/brand/logo-${theme}-240.png" srcset="${set("png")}" sizes="${SIZES}" width="114" height="40" alt="Harlan's Legacy" loading="lazy" decoding="async"></picture>`;
}

// P: path prefix to the site root ("" or "../")
function brandLogo(P) { return variant(P, "day") + variant(P, "night"); }

// 40 px tall on desktop, 36 px in the ≤720 px menu layout, 32 px on the narrowest phones;
// the link keeps a 44 px touch target without changing the header row height.
const BRAND_CSS = `
.brand{ min-height:44px; }
.brand-logo{ display:block; line-height:0; }
.brand-logo img{ display:block; height:40px; width:auto; max-width:none; aspect-ratio:1132 / 399; }
.brand-logo-night{ display:none; }
html[data-theme="night"] .brand-logo-day{ display:none; }
html[data-theme="night"] .brand-logo-night{ display:block; }
@media (max-width:720px){ .brand-logo img{ height:36px; } }
@media (max-width:360px){ .brand-logo img{ height:32px; } }
`;

module.exports = { brandLogo, BRAND_CSS, SIZES };
