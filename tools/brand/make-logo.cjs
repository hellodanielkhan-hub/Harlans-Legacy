/* =========================================================================
   Harlan's Legacy — brand logo derivatives

   Source of truth: tools/brand/harlans-legacy-logo-master.png — the supplied
   logo trimmed to its exact visible bounds (1132×399, untinted, lossless).
   Not shipped: collect-public only publishes assets/ and the page folders.

   The site shows the logo's exact shape in the site ink colour, so it reads on
   the light day header and matches the existing wordmark at night:
       day   #1C2430  (--ink-primary, day)
       night #EDE6D6  (--ink-primary, night)
   Only RGB is replaced; the alpha channel (the logo's shape and edges) is kept
   exactly, which also removes the background-remover's white edge halo.

   Output: assets/brand/logo-{day|night}-{120|240|360}.{avif,png}
   AVIF is near-lossless; the 64-colour palette PNG fallback is smaller than
   lossless WebP for this single-ink mark, so WebP is not generated.
   Usage:
     node tools/brand/make-logo.cjs                 # rebuild derivatives from the master
     node tools/brand/make-logo.cjs --from <png>    # re-trim a new source into the master first
   ========================================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..", "..");
const MASTER = path.join(__dirname, "harlans-legacy-logo-master.png");
const OUT = path.join(ROOT, "assets", "brand");
const INKS = { day: "#1C2430", night: "#EDE6D6" };
const WIDTHS = [120, 240, 360];            // covers 91–114 CSS px at 1×–3×

async function trimToVisible(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] === 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  await sharp(src).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png({ compressionLevel: 9 }).toFile(MASTER);
  return { from: [W, H], bounds: [x0, y0, x1, y1], master: [x1 - x0 + 1, y1 - y0 + 1] };
}

function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 }; }

async function tinted(width, hex) {
  const alpha = await sharp(MASTER).resize({ width, kernel: "lanczos3" }).extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = alpha.info;
  return sharp({ create: { width: w, height: h, channels: 3, background: hexRgb(hex) } })
    .joinChannel(alpha.data, { raw: { width: w, height: h, channels: 1 } });
}

async function main() {
  const i = process.argv.indexOf("--from");
  if (i > 0) console.log("trimmed:", JSON.stringify(await trimToVisible(process.argv[i + 1])));
  const m = await sharp(MASTER).metadata();
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [];
  for (const [theme, hex] of Object.entries(INKS)) for (const w of WIDTHS) {
    const base = path.join(OUT, `logo-${theme}-${w}`);
    await (await tinted(w, hex)).png({ palette: true, colours: 64, compressionLevel: 9, effort: 10 }).toFile(base + ".png");
    await (await tinted(w, hex)).avif({ quality: 70, effort: 9 }).toFile(base + ".avif");
    const h = (await sharp(base + ".png").metadata()).height;
    rows.push(`${theme} ${w}x${h}  avif ${fs.statSync(base + ".avif").size}B  png ${fs.statSync(base + ".png").size}B`);
  }
  console.log(`master ${m.width}x${m.height} (aspect ${(m.width / m.height).toFixed(4)})`);
  rows.forEach(r => console.log(r));
}

main().catch(e => { console.error(e); process.exit(1); });
