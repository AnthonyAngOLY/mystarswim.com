// Finding Chromium without pinning a path that will move.
//
// The first version of this hardcoded /opt/pw-browsers/chromium-1194/
// chrome-linux/chrome. The image was rebuilt, the browser became
// chromium-1243/chrome-linux64/chrome, and every test failed before it
// reached a single assertion.
//
// So: ask Playwright first, since it knows where its own browser is, and
// only go looking if that fails.
'use strict';
const fs = require('fs');
const path = require('path');

const PW = '/opt/node22/lib/node_modules/playwright';

function hunt() {
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium')).sort().reverse()) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const p = path.join(root, dir, sub, 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

async function launch(opts) {
  const { chromium } = require(PW);
  try {
    return await chromium.launch(opts || {});          // Playwright's own
  } catch (e) {
    const exe = process.env.CHROME || hunt();
    if (!exe) throw e;
    return await chromium.launch({ ...(opts || {}), executablePath: exe });
  }
}

// The pages load React from a CDN the sandbox cannot reach, so the
// request is answered from node_modules instead. Serving a local copy
// beats editing the page to suit the test: the test then drives the file
// that is actually deployed.
const CDN = {
  'react.production.min.js':     'react/umd/react.production.min.js',
  'react.development.js':        'react/umd/react.development.js',
  'react-dom.production.min.js': 'react-dom/umd/react-dom.production.min.js',
  'react-dom.development.js':    'react-dom/umd/react-dom.development.js'
};

async function offline(page) {
  await page.route('https://cdnjs.cloudflare.com/**', route => {
    const file = CDN[path.basename(new URL(route.request().url()).pathname)];
    const full = file && path.join(__dirname, '..', 'node_modules', file);
    if (full && fs.existsSync(full)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript',
                             body: fs.readFileSync(full, 'utf8') });
    }
    return route.abort();
  });
}

module.exports = { launch, offline, require: () => require(PW) };
