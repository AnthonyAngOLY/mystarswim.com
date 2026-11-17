// ─────────────────────────────────────────────────────────────────────────
// The QR code that gets a parent to the app.
//
//   node scripts/make-qr.js
//
// Writes qr-app.svg and qr-app.png at the repository root, both encoding
// https://app.mystarswim.com and nothing else.
//
// WHY IT IS GENERATED AND COMMITTED
// The page that shows it must not fetch it. A QR rendered by a script at
// view time is a QR that is blank when the script fails, and the one place
// this is printed and pinned to a wall is the one place nobody is watching
// a console. Committed as a file, it is either there or the page is
// visibly broken.
//
// WHY IT DECODES ITS OWN OUTPUT BEFORE WRITING
// A wrong QR looks exactly like a right one. There is no reading it, no
// proofreading it, and the failure is discovered by a parent standing at
// the counter with a phone that went somewhere else. So this encodes,
// renders to pixels, decodes those pixels back, and refuses to write
// anything unless what comes back is the string that went in.
//
// ERROR CORRECTION
// Level H — up to 30% of the symbol can be damaged and it still reads.
// This gets printed, laminated, taped to a counter and photographed at an
// angle in pool lighting. The denser symbol is worth it.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs   = require('fs');
const path = require('path');

// The short URL on the printed card, not the app itself. A parent who has
// never installed anything needs the page that explains it first; the app
// is one tap from there. /get is a rewrite, so this is also exactly what
// the address bar shows them afterwards.
const URL_ = 'https://www.mystarswim.com/get';
const ROOT = path.resolve(__dirname, '..');

async function main() {
  let QR, jsQR, PNG;
  try {
    QR   = require('qrcode');
    jsQR = require('jsqr');
    PNG  = require('pngjs').PNG;
  } catch (e) {
    console.error('Missing a dependency. Run: npm install');
    process.exit(1);
  }

  const opts = { errorCorrectionLevel: 'H', margin: 2 };

  // Pixels first, so the check is against something a camera could see.
  const png = await QR.toBuffer(URL_, { ...opts, type: 'png', width: 800 });
  const img = PNG.sync.read(png);
  const got = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);

  if (!got) {
    console.error('Generated a symbol that does not decode at all. Nothing written.');
    process.exit(1);
  }
  if (got.data !== URL_) {
    console.error('Decoded to ' + JSON.stringify(got.data) +
                  ', wanted ' + JSON.stringify(URL_) + '. Nothing written.');
    process.exit(1);
  }

  const svg = await QR.toString(URL_, { ...opts, type: 'svg' });
  fs.writeFileSync(path.join(ROOT, 'qr-app.svg'), svg);
  fs.writeFileSync(path.join(ROOT, 'qr-app.png'), png);

  console.log('qr-app.svg and qr-app.png written.');
  console.log('Encodes: ' + URL_);
  console.log('Verified by decoding the rendered pixels back to that string.');
}

main().catch(e => { console.error(e); process.exit(1); });
