// ════════════════════════════════════════════════════════════════════════
//  Turning a Terms & Conditions blob back into a document
// ════════════════════════════════════════════════════════════════════════
//  branches.terms_content is one free-text field, and it was rendered as
//  a run of identical paragraphs — every clause the same weight as every
//  other, section titles indistinguishable from the body beneath them.
//  That is hard to read and, in a document somebody signs, hard to refer
//  to afterwards: "clause 5.2" means nothing if 5.2 does not stand out.
//
//  This reads the shape that legal numbering already carries, so the
//  office types a plain document and gets a typeset one:
//
//    A LINE IN CAPITALS        the document's own title
//    1. Section Heading        a numbered title on its own line
//    1.1 Body text...          a clause: its number is set in bold
//    5.2 Short Title. Body     a clause with a lead-in: both in bold
//    **anything**              bold, anywhere, for the odd emphasis
//
//  Nothing has to be marked up. A document pasted in with no markers at
//  all comes out properly set, which matters because the people editing
//  it are not going to learn a syntax to do it.
//
//  Loaded by both app.html and intake.html, BEFORE their bundles, so the
//  Settings preview and the form a parent signs cannot drift apart —
//  which the two copies of the default wording already did.
// ════════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  var CLAUSE = /^(\d+\.\d+(?:\.\d+)*)(\s+)/;          // 5.2, 8.6.1
  var HEADING = /^(\d+\.)\s+\S/;                       // 5. Something
  // A lead-in title: the short label some clauses open with, as in
  // "5.2 No Replacement for Absence. A Session missed..." or
  // "3.1 Advance Notice: Cancellations must...".
  //
  // Length alone cannot tell a title from a short sentence — "These Terms
  // govern the enrolment of swimmers." fits any cap you pick, and bolding
  // it swallows the clause. Two further signals settle it:
  //
  //   · a colon is a label almost by definition, so it needs nothing more
  //   · a full stop needs Title Case, which a sentence does not have
  //
  // and in both cases something must follow it. A phrase that runs to the
  // end of the paragraph IS the paragraph, so it is not a lead-in.
  var LEADIN = /^([A-Z][^.:]{0,58}[.:])(\s+)(\S)/;

  // Title Case: every word long enough to carry weight is capitalised.
  // Short connectors (for, of, and, the) are allowed to stay lower.
  function isTitleCase(s) {
    var words = s.replace(/[.:]$/, '').split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 8) return false;
    for (var i = 0; i < words.length; i++) {
      var w = words[i].replace(/[^A-Za-z-]/g, '');
      if (w.length >= 4 && !/^[A-Z]/.test(w)) return false;
    }
    return true;
  }

  function isTitleLine(s) {
    // Capitals and punctuation only, and enough letters to mean it.
    return /[A-Z]/.test(s) && !/[a-z]/.test(s) &&
           (s.replace(/[^A-Za-z]/g, '').length >= 3);
  }

  // Split one paragraph into { type, text } where text may still carry
  // ** markers. Auto-detection writes those markers itself, so there is
  // one code path for emphasis rather than two.
  function classify(para) {
    var lines = para.split('\n');
    var first = lines[0].trim();

    if (lines.length === 1 && HEADING.test(first)) return { type: 'h3', text: first };
    if (lines.length === 1 && isTitleLine(first) && !/^\d/.test(first))
      return { type: 'h2', text: first };

    var m = para.match(CLAUSE);
    if (m) {
      var rest = para.slice(m[0].length);
      var lead = rest.match(LEADIN);
      // A full stop has to earn it; a colon does not.
      if (lead && /\.$/.test(lead[1]) && !isTitleCase(lead[1])) lead = null;
      var marked = lead
        ? '**' + m[1] + ' ' + lead[1] + '**' + rest.slice(lead[1].length)
        : '**' + m[1] + '**' + m[2] + rest;
      return { type: 'p', text: marked };
    }
    return { type: 'p', text: para };
  }

  // ** → <strong>. Unbalanced markers are left as typed rather than
  // swallowing the rest of the clause.
  function inline(React, text) {
    var out = [], re = /\*\*([\s\S]+?)\*\*/g, last = 0, m, k = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(React.createElement('strong', { key: 'b' + (k++) }, m[1]));
      last = re.lastIndex;
    }
    if (!out.length) return text;
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function parse(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\\n/g, '\n')
      .split(/\n{2,}/)
      .map(function (p) { return p.replace(/\s+$/, ''); })
      .filter(function (p) { return p.trim() !== ''; })
      .map(classify);
  }

  // React elements for a whole document. pClass/hClass let each page keep
  // its own styling; the parsing is what is shared.
  function render(React, raw, opts) {
    var o = opts || {};
    return parse(raw).map(function (blk, i) {
      var body = inline(React, blk.text);
      if (blk.type === 'h2')
        return React.createElement('h2', { key: i, className: o.h2Class || '' }, body);
      if (blk.type === 'h3')
        return React.createElement('h3', { key: i, className: o.h3Class || '' }, body);
      return React.createElement('p', { key: i, className: o.pClass || '' }, body);
    });
  }

  global.SSTerms = { parse: parse, render: render, inline: inline };
})(typeof window !== 'undefined' ? window : this);
