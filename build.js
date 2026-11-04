#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Compile a JSX bundle to the plain JavaScript the browser loads.
//
//   node build.js app.js app.compiled.js
//   node build.js intake.js intake.compiled.js
//
// WHY THIS FILE IS IN THE REPO
// It was not, and CLAUDE.md told whoever came next to run it. The settings
// below lived in a scratch directory on one machine; when that machine was
// rebuilt they went with it, and the only record of how the committed
// bundles had been produced was a paragraph of prose.
//
// THE SETTINGS ARE NOT PREFERENCES
// app.compiled.js and intake.compiled.js are committed, so a rebuild must
// reproduce them byte for byte or every build floods the diff with noise
// and hides the change somebody actually made.
//
//   useSpread           {...props} stays a spread rather than becoming an
//                       _extends helper
//   compact: false      no reflowing of lines
//   comments: true      the comments are half the point of reading these
//                       files; stripping them loses the reasoning
//   jsescOption.minimal without it every box-drawing character in a
//                       comment escapes to \uXXXX and a four-line change
//                       arrives as a four-hundred-line diff
//
// Run with --check to compile and compare without writing, which is how to
// tell whether a committed bundle matches its source.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const args = process.argv.slice(2).filter(a => a !== '--check');
const checkOnly = process.argv.includes('--check');

if (args.length !== 2) {
  console.error('usage: node build.js <source.js> <compiled.js> [--check]');
  process.exit(2);
}

const [src, out] = args;

const result = babel.transformFileSync(path.resolve(src), {
  presets: [[require.resolve('@babel/preset-react'), { useSpread: true }]],
  compact: false,
  comments: true,
  babelrc: false,
  configFile: false,
  generatorOpts: { jsescOption: { minimal: true } }
});

const code = result.code;

if (checkOnly) {
  const existing = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  if (existing === null) {
    console.error(`${out} does not exist`);
    process.exit(1);
  }
  // Trailing newline is the one difference not worth failing over.
  if (existing.replace(/\n+$/, '') === code.replace(/\n+$/, '')) {
    console.log(`${out} matches ${src}`);
    process.exit(0);
  }
  console.error(`${out} does NOT match ${src}`);
  process.exit(1);
}

fs.writeFileSync(out, code);
console.log(`${src} -> ${out}  (${code.length} bytes)`);
