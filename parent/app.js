/* ══════════════════════════════════════════════════════════════════════
   Star Swim — the parent app
   ══════════════════════════════════════════════════════════════════════
   A parent signs in with their phone and a code. There is no password,
   because a password is a thing to forget and reset, and the office
   already holds a verified number for every family.

   Everything this app reads comes from a function keyed to the signed-in
   account. It never asks for "account 123" — there is no parameter to
   ask with. See supabase_parent_app_reads.sql.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Installable. Registered relative, so the scope is this directory and
  // never the whole site — which matters when the same files are also
  // served from the root of app.mystarswim.com.
  var BUILD = 12;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  var cfg = window.APP_CONFIG || {};
  var TZ = 'Asia/Kuala_Lumpur';
  var KEY = 'ssb.parent.session';

  var session = null;   // { access_token, refresh_token }
  var family  = null;   // what my_family() returned
  var view    = 'home';
  var wkStart = null;
  var wkDay   = null;

  // ── Small helpers ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function todayKL() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  }
  function mondayOf(iso) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dow(iso, long) {
    return new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, weekday: long ? 'long' : 'short' })
      .format(new Date(iso + 'T00:00:00+08:00'));
  }
  function dayNum(iso) { return String(Number(iso.slice(8, 10))); }
  function niceDate(iso) {
    return new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
      .format(new Date(iso + 'T00:00:00+08:00'));
  }
  // '09:00:00' -> '9:00 AM'
  function hhmm(t) {
    var p = String(t).split(':');
    var h = parseInt(p[0], 10), m = p[1] || '00';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function money(n) {
    return 'RM ' + Number(n || 0).toLocaleString('en-MY',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return ((p[0] || '')[0] || '?').toUpperCase() + ((p[1] || '')[0] || '').toUpperCase();
  }
  function note(el, text, bad) {
    el.innerHTML = text ? '<div class="note ' + (bad ? 'err' : 'ok') + '">' + esc(text) + '</div>' : '';
  }

  // A number typed on a phone, as E.164. Malaysian unless they gave a
  // country code. The same three shapes the database accepts, so a
  // parent typing their number the way they always write it gets in.
  function e164(raw) {
    var s = String(raw || '').trim();
    if (s.charAt(0) === '+') return '+' + s.slice(1).replace(/\D/g, '');
    var d = s.replace(/\D/g, '');
    if (!d) return '';
    if (d.slice(0, 2) === '60') return '+' + d;
    if (d.charAt(0) === '0')    return '+60' + d.slice(1);
    return '+60' + d;
  }

  // ── Network ──────────────────────────────────────────────────────────
  var OFFLINE = 'Cannot reach Star Swim. Check your connection and try again.';
  function asOffline() { throw new Error(OFFLINE); }

  function readable(text, fallback) {
    var d = null;
    try { d = JSON.parse(text); } catch (e) {}
    var m = d && (d.msg || d.message || d.error_description || d.error);
    if (typeof m === 'string' && m.trim()) return m.trim();
    return fallback || 'Something went wrong. Please try again.';
  }

  var refreshing = null;
  function refresh() {
    if (!session || !session.refresh_token) return Promise.resolve(false);
    if (refreshing) return refreshing;
    refreshing = fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (d) {
        session.access_token = d.access_token;
        session.refresh_token = d.refresh_token || session.refresh_token;
        save();
        return true;
      });
    }).catch(function () { return false; })
      .then(function (ok) { refreshing = null; return ok; });
    return refreshing;
  }

  function api(path, opts, isRetry) {
    opts = opts || {};
    opts.headers = {
      apikey: cfg.supabaseAnonKey,
      Authorization: 'Bearer ' + (session && session.access_token),
      'Content-Type': 'application/json'
    };
    return fetch(cfg.supabaseUrl + path, opts).catch(asOffline).then(function (r) {
      if (r.status === 401 && !isRetry) {
        return refresh().then(function (ok) {
          if (!ok) { signOut(); throw new Error('Please sign in again.'); }
          return api(path, opts, true);
        });
      }
      return r;
    });
  }

  function rpc(name, args) {
    return api('/rest/v1/rpc/' + name, {
      method: 'POST', body: JSON.stringify(args || {})
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(readable(t)); });
      return r.json();
    });
  }

  // ── Session ──────────────────────────────────────────────────────────
  function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) {} }
  function load() {
    try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { session = null; }
  }
  function signOut() {
    session = null; family = null;
    try { localStorage.removeItem(KEY); } catch (e) {}
    closeWhoMenu();
    // Left blank on purpose. Signing out is most often about handing the
    // phone to somebody else, and a number already in the box invites
    // the next person to tap Send and wait for a code that goes to a
    // phone they are not holding.
    if ($('phone')) $('phone').value = '';
    note($('loginNote'), '');
    note($('otpNote'), '');
    hide($('s-app')); hide($('s-otp')); hide($('s-setpw')); hide($('s-askcode'));
    show($('s-login'));
    if ($('pw')) $('pw').value = '';
  }

  // ── Still ours? ──────────────────────────────────────────────────────
  // A session already open does not pass the sign-in gate again, ever.
  // It renews itself quietly and keeps working, so a family archived
  // this morning went on opening the app -- their own name at the top
  // and nothing underneath, which reads as the system having lost them
  // rather than as an account that has been closed.
  //
  // Asked when the app is brought back to the front, which on a phone is
  // every time it is opened. Cheap, and it is the same call the app
  // already makes on the way in.
  //
  // Silent on a failure: no signal at the pool is not a reason to sign a
  // parent out, and the next check is one tap away.
  var recheckAt = 0;
  function recheckAccess() {
    if (!session) return;
    var now = Date.now();
    if (now - recheckAt < 30000) return;    // not on every flicker
    recheckAt = now;
    rpc('my_family').then(function (f) {
      if (f && f.ok !== true) {
        signOut();
        note($('loginNote'), f.error
          || 'This account is no longer active. Call the centre.', true);
      }
    }).catch(function () { /* offline; ask again next time */ });
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) recheckAccess();
  });
  window.addEventListener('focus', recheckAccess);

  // ── The account menu ─────────────────────────────────────────────────
  function closeWhoMenu() {
    var m = $('whoMenu'), b = $('whoBtn');
    if (m) m.classList.add('hidden');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggleWhoMenu() {
    var m = $('whoMenu'), b = $('whoBtn');
    if (!m) return;
    var open = m.classList.contains('hidden');
    m.classList.toggle('hidden', !open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ── Signing in ───────────────────────────────────────────────────────
  var pendingPhone = '';

  // The code is not asked for from Supabase directly. parent-signin
  // checks the number against the centre's own records first, behind the
  // service role, and only then sends. Supabase knows whether a number
  // has signed in before; it does not know whether it belongs to a Star
  // Swim family, and that is the question worth asking.
  //
  // It also means a stranger cannot make us send a single message. With
  // SMS that is not only a security line, it is the bill — an
  // international long code charges per message, every message.
  function sendCode(phone) {
    return fetch(cfg.supabaseUrl + '/functions/v1/parent-signin', {
      method: 'POST',
      headers: {
        apikey: cfg.supabaseAnonKey,
        // The Verify JWT gate reads Authorization, not apikey. Both are
        // sent, because leaving the toggle on is the safe default and a
        // form that 401s on every submission is a bad way to find out.
        Authorization: 'Bearer ' + cfg.supabaseAnonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: phone })
    }).catch(asOffline).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        // 'sms' if the server did not say, because SMS is what is
        // registered. This read 'whatsapp' while no WhatsApp sender
        // existed, which would have had the app tell a parent to look
        // somewhere no message was ever going to arrive.
        // Resolves with both, because the caller needs the channel for
        // what it tells the parent and the cooldown for how long it
        // holds the resend button.
        if (r.ok && d && d.known === true && !d.error) {
          return { channel: d.channel || 'sms', cooldownSec: Number(d.cooldown_sec) || 0 };
        }
        var err = new Error((d && d.error)
          || 'We could not send a code just now. Please try again shortly.');
        // Carried, not swallowed: the countdown on the resend button is
        // the server's number when the server gave one.
        if (d && d.wait_sec) err.waitSec = Number(d.wait_sec) || 0;
        throw err;
      });
    });
  }

  // ── Signing in with a password ───────────────────────────────────────
  // Through our own function rather than straight at Supabase, because
  // Supabase will not apply the archived-account gate, will not count
  // the wrong tries, and will not put the attempt in the spend log.
  function loginWithPassword(phone, password) {
    return fetch(cfg.supabaseUrl + '/functions/v1/parent-login', {
      method: 'POST',
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + cfg.supabaseAnonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ phone: phone, password: password })
    }).catch(asOffline).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.ok && d && d.ok === true && d.access_token) {
          session = { access_token: d.access_token, refresh_token: d.refresh_token };
          save();
          return d;
        }
        var err = new Error((d && d.error) || 'That number and password do not match.');
        if (d && d.must_use_code) err.mustUseCode = true;
        if (d && typeof d.tries_left === 'number') err.triesLeft = d.tries_left;
        // A function that is not deployed yet answers 404. Treated as
        // "no password sign-in here", so the app falls back to codes
        // rather than telling a parent their password is wrong.
        if (r.status === 404) err.notDeployed = true;
        throw err;
      });
    });
  }

  // Set or change it. Straight to Supabase, with the session we already
  // hold: this is the one call that needs no gate, because holding a
  // session is already proof of whatever the gate would have asked.
  function setPassword(pw) {
    return fetch(cfg.supabaseUrl + '/auth/v1/user', {
      method: 'PUT',
      headers: {
        apikey: cfg.supabaseAnonKey,
        Authorization: 'Bearer ' + (session && session.access_token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: pw })
    }).catch(asOffline).then(function (r) {
      if (r.ok) return true;
      return r.text().then(function (t) { throw new Error(readable(t, 'Could not save that password.')); });
    });
  }

  function verify(phone, token) {
    return fetch(cfg.supabaseUrl + '/auth/v1/verify', {
      method: 'POST',
      headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, token: token, type: 'sms' })
    }).catch(asOffline).then(function (r) {
      if (!r.ok) throw new Error('That code did not work. Check it, or send a new one.');
      return r.json();
    }).then(function (d) {
      session = { access_token: d.access_token, refresh_token: d.refresh_token };
      save();
      // First sign-in: link this person to the family whose number they
      // just proved they hold. Every sign-in after, it is a no-op that
      // only stamps the date.
      return rpc('claim_parent_account').then(function (c) {
        if (!c || c.ok !== true) {
          throw new Error((c && c.error)
            || 'We could not match that number to a family. Call the centre.');
        }
        return rpc('touch_parent_login').catch(function () {});
      }).catch(function (e) {
        // A session with no family behind it is worse than none: it
        // looks like being let in. Throw it away before showing a screen.
        session = null;
        try { localStorage.removeItem(KEY); } catch (ignore) {}
        throw e;
      });
    });
  }

  // ── Loading the app ──────────────────────────────────────────────────
  function enter() {
    return rpc('my_family').then(function (f) {
      if (!f || f.ok !== true) {
        // Either no account answers to this user, or the family has been
        // archived. The server words both, because the words belong with
        // the rule rather than in whatever build this phone happens to
        // be running.
        signOut();
        note($('loginNote'), (f && f.error)
          || 'That number signed in, but it is not linked to a family yet. '
           + 'Call the centre and we will connect it.', true);
        return;
      }
      family = f;
      hide($('s-login')); hide($('s-otp')); hide($('s-setpw')); hide($('s-askcode'));
    show($('s-app'));
      $('whoName').textContent = family.name;
      var n = (family.children || []).length;
      $('whoKids').textContent = n === 1 ? '1 swimmer' : n + ' swimmers';
      // The number in the menu, not on the header. On a phone two people
      // share it is the thing that settles whose app this is, and it is
      // worth a tap to see rather than a permanent line of small print.
      $('whoPhone').textContent = family.phone
        ? 'Signed in as ' + family.phone : 'Signed in';
      wkStart = mondayOf(todayKL());
      wkDay = todayKL();
      setView('home');
      return Promise.all([loadHome(), loadMessages()]);
    });
  }

  function setView(v) {
    view = v;
    ['home', 'child', 'progress', 'sched', 'credits', 'billing', 'msgs'].forEach(function (k) {
      $('v-' + k).classList.toggle('hidden', k !== v);
    });
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
      // The child screen hangs off Home rather than having a tab of its
      // own, so Home stays lit while you are inside it.
      b.classList.toggle('on', b.getAttribute('data-v') === (v === 'child' ? 'home' : v));
    });
    window.scrollTo(0, 0);
    if (v === 'sched')   loadSchedule();
    if (v === 'credits') loadCredits();
    if (v === 'billing') loadBilling();
    if (v === 'msgs')    loadMessages();
    // Fetched on entry rather than at sign-in: a family two years in has
    // a hundred of these and none of it is needed to open the app.
    if (v === 'progress') { if (progRows === null) loadProgress(); else renderProgress(); }
  }

  // ── Home ─────────────────────────────────────────────────────────────
  function loadHome() {
    var from = todayKL();
    return rpc('my_schedule', { p_from: from, p_to: addDays(from, 27) })
      .then(function (rows) {
        rows = rows || [];
        // The next class that has not been cancelled. A cancelled one is
        // not "next up", it is news, and news is the banner's job.
        var next = rows.filter(function (r) { return !r.is_cancelled; })[0];
        $('homeNext').innerHTML = next
          ? '<div class="card" style="border-color:#BAE6FD;background:linear-gradient(180deg,#F7FCFF,#fff)">'
            + '<div class="row"><div class="kid k1">' + esc(initials(next.child)) + '</div>'
            + '<div class="grow"><div class="big">' + esc(next.child) + '</div>'
            + '<div class="sub">' + esc(whenWord(next.class_date)) + ' · '
            +   esc(hhmm(next.start_time)) + '–' + esc(hhmm(next.end_time)) + '</div>'
            + '<div class="sub">' + esc([next.pool, next.lesson, next.coach && ('Coach ' + next.coach)]
                .filter(Boolean).join(' · ')) + '</div>'
            + '</div></div></div>'
          : '<div class="card"><div class="sub">Nothing scheduled in the next four weeks.</div></div>';

        // One card per child, with their next class under the name.
        var byKid = {};
        rows.forEach(function (r) {
          if (r.is_cancelled) return;
          if (!byKid[r.student_id]) byKid[r.student_id] = r;
        });
        var kids = family.children || [];
        var drawKids = function () {
          $('homeKids').innerHTML = kids.length ? kids.map(function (k, i) {
            var nx = byKid[k.id];
            var g = homeLevels[k.id];
            return '<div class="card tapcard" data-kid="' + esc(k.id) + '"><div class="row">'
              + '<div class="kid k' + ((i % 3) + 1) + '">' + esc(initials(k.name)) + '</div>'
              + '<div class="grow"><div class="big">' + esc(k.name)
              +   ' <span style="color:var(--muted);font-weight:400">\u203a</span></div>'
              + '<div class="sub">' + (nx
                  ? esc(whenWord(nx.class_date) + ' · ' + hhmm(nx.start_time) + ' · ' + nx.lesson)
                  : 'No class booked') + '</div>'
              // The one thing a parent wants at a glance, on the first
              // screen, without opening anything.
              + (g ? '<div style="margin-top:7px"><span class="lvlchip"'
                     + (hex(g.colour) ? ' style="color:' + hex(g.colour)
                                      + ';border-color:' + hex(g.colour) + '"' : '') + '>'
                     + (g.icon ? '<img src="' + esc(iconUrl(g.icon)) + '" alt="">' : '')
                     + esc(g.program) + ' \u00b7 '
                     + (g.level ? esc(stageWord(g.label, g.level)) : 'Starting out')
                     + '<small>' + esc(String(g.earned)) + '/' + esc(String(g.total)) + '</small>'
                     + '</span></div>' : '')
              + '</div></div></div>';
          }).join('') : '<div class="card"><div class="sub">No swimmers on this account yet.</div></div>';
          wireKidCards();
        };
        var wireKidCards = function () {
          Array.prototype.forEach.call($('homeKids').querySelectorAll('[data-kid]'), function (c) {
            c.addEventListener('click', function () {
              var id = c.getAttribute('data-kid');
              var k = kids.filter(function (x) { return x.id === id; })[0];
              openChild(id, k && k.name, byKid[id], kids.indexOf(k));
            });
          });
        };
        drawKids();

        // Badges after the cards, not before: a ladder that has not
        // loaded must never hold up the class times, which are what the
        // screen is for.
        kids.forEach(function (k) {
          rpc('my_child_grading', { p_student: k.id }).then(function (g) {
            if (!g || g.ok !== true || g.graded === false) return;
            // The roundel of the level she is actually on, not the
            // programme's mark: the chip is her badge, and a programme
            // logo is the same on every card on the screen.
            var held = (g.milestones || []).filter(function (m) { return m.activated; });
            var top = held.length ? held[held.length - 1] : null;
            homeLevels[k.id] = {
              program: g.program.name,
              icon: (top && top.icon) || g.program.icon,
              colour: (top && top.colour) || g.program.colour,
              label: top && top.label,
              level: g.level,
              total: g.levels_total,
              earned: held.length
            };
            drawKids();
          }).catch(function () {});
        });

      })
      .catch(function (e) { note($('appNote'), e.message, true); });
  }

  // ── The collection ───────────────────────────────────────────────────
  // What a child has earned, and what is next. Drawn above the coaches'
  // notes because a badge is the thing a parent came to look at and a
  // note is the thing they read.
  //
  // Every milestone, earned or not, and every task inside it: the point
  // of a ladder a family can see is that the next rung is visible. A
  // list of only what is finished answers "how is she doing" with a
  // number and nothing to do about it.
  var gradeOpen = {};
  // student_id -> the chip on the home screen.
  var homeLevels = {};

  // program_id -> is the "who wrote this ladder" paragraph open.
  var sylOpen = {};

  function iconUrl(p) {
    if (!p) return null;
    // A path beginning with / is served by this site. The MAS roundels
    // ship with the build, so standing a new environment up does not
    // begin with seven uploads to a storage bucket. Anything else is a
    // key in grading-icons, which is where an icon uploaded in Settings
    // → Grading still goes.
    if (p.charAt(0) === '/') return p;
    return cfg.supabaseUrl + '/storage/v1/object/public/grading-icons/' + encodeURI(p);
  }

  // A colour out of the database is drawn into a style attribute. The
  // column has a CHECK on it, but a value that reaches an attribute is
  // checked where it is used too, not only where it was stored.
  function hex(c) { return (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/).test(c || '') ? c : ''; }

  // What a rung is called. level_no orders the ladder; label is what the
  // child's badge says, and on the Swim Passport those differ -- stage
  // "1" is the third rung, because A and B come first. Printing the
  // ordinal beside a sticker reading "Learn to Swim 1" is a year of
  // front-desk questions.
  function stageWord(label, levelNo) {
    if (label) return 'Stage ' + label;
    return levelNo ? 'Level ' + levelNo : '';
  }

  // Likewise a URL that becomes an href. http and https only: the
  // office types this box, and `javascript:` in it would be script
  // running in every parent's browser.
  function webUrl(u) { return (/^https?:\/\//i).test(u || '') ? u : ''; }

  // The line under the programme name: who owns this syllabus, what it
  // is called, which edition. Quiet — a parent came to see their child's
  // levels, not our accreditation — with one tap to the paragraph that
  // says what a level here does and does not mean.
  function syllabusHtml(prog) {
    var s = prog && prog.syllabus; if (!s) return '';
    var line = [s.body, s.name].filter(Boolean).join(' · ');
    if (s.version) line += (line ? ' ' : '') + 'v' + s.version;
    if (!line) line = 'About this syllabus';
    var url = webUrl(s.url);
    var more = !!(s.note || url);
    var open = !!sylOpen[prog.id];
    // The marker leads the line. Trailing, it orphans onto a second row
    // the moment the syllabus name is long -- and "BADGES - Swimming
    // Proficiency Test" is exactly long enough.
    return '<div class="sylrow">'
      + '<button type="button" class="syl"' + (more ? ' data-syl="' + esc(prog.id) + '"' : '')
      +   ' aria-expanded="' + (open ? 'true' : 'false') + '">'
      +   (more ? '<i>' + (open ? '\u2212' : 'i') + '</i>' : '') + esc(line) + '</button>'
      + (more && open
          ? '<div class="sylnote">' + esc(s.note || '')
            + (url ? ' <a href="' + esc(url) + '" target="_blank" rel="noopener">'
                   + 'Read the syllabus</a>' : '')
            + '</div>'
          : '')
      + '</div>';
  }

  function loadChildGrading(studentId) {
    return rpc('my_child_grading', { p_student: studentId }).then(function (g) {
      var el = $('childGrading');
      if (!el) return;
      // Not graded is not an error and must not read as one. Plenty of
      // lesson types are a hire or a one-off.
      if (!g || g.ok !== true || g.graded === false) { el.innerHTML = ''; return; }
      el.innerHTML = gradingHtml(g);
      wireGrading(studentId, g);
    }).catch(function () {
      // Before the grading module is installed. Silent: the rest of the
      // page is the page.
      var el = $('childGrading'); if (el) el.innerHTML = '';
    });
  }

  function gradingHtml(g) {
    var held = (g.milestones || []).filter(function (m) { return m.activated; });
    var earned = held.length;
    // The roundel of the level she is on, not the programme's mark: the
    // chip is her badge, and a programme logo squeezed to 16px is a grey
    // smudge that says nothing.
    var topMs = held.length ? held[held.length - 1] : null;
    var topIcon = topMs && topMs.icon;
    var out = '<div class="h" style="display:flex;align-items:center;gap:8px">'
      + '<span>' + esc(g.program.name) + '</span>'
      + '<span class="lvlchip">'
      + (topIcon ? '<img src="' + esc(iconUrl(topIcon)) + '" alt="">' : '')
      + (g.level ? esc(stageWord(topMs && topMs.label, g.level)) : 'Starting out')
      + '<small>' + earned + '/' + esc(String(g.levels_total)) + '</small></span></div>';

    out += syllabusHtml(g.program);

    (g.milestones || []).forEach(function (m) {
      var done = Number(m.done) || 0, total = Number(m.total) || 0;
      var pct = total ? Math.round(done * 100 / total) : 0;
      var open = !!gradeOpen[m.id];
      // The level's own colour, the programme's if it has none. A ladder
      // drawn in one blue is a ladder a parent has to read to tell apart.
      var c = hex(m.colour) || hex(g.program.colour);
      // --c is set on the row so the stripe, the bar fill and the bubble
      // all read it. Set on the bubble alone it would not reach the bar,
      // and three inline colours drift apart the first time one is
      // edited.
      out += '<div class="msrow' + (m.activated ? ' is-on' : '') + '" data-ms="' + esc(m.id) + '"'
        + (c ? ' style="--c:' + c + '"' : '') + '>'
        + '<div class="msrow-head" data-toggle="' + esc(m.id) + '">'
        // A roundel is round, and its PNG is transparent. The tile
        // behind it has to go, or the circle sits on a grey square.
        +   '<span class="msrow-badge' + (m.icon ? ' has-img' : '') + '">'
        +     (m.icon ? '<img src="' + esc(iconUrl(m.icon)) + '" alt="">'
                      : (m.activated ? '\u2605' : '\u25cb')) + '</span>'
        +   '<span class="msrow-nm"><b>' + esc(m.name) + '</b>'
        +     '<span>' + esc(stageWord(m.label, m.level_no))
        +       (m.activated ? ' \u00b7 earned' : '') + '</span></span>'
        +   '<span class="msrow-chev">' + (open ? '\u25b2' : '\u25bc') + '</span>'
        + '</div>'
        // The bar, with the count riding above the fill edge. Clamped
        // away from both ends so the bubble never hangs off the card.
        + '<div class="msbar-wrap">'
        +   '<span class="msbubble" style="left:' + Math.min(93, Math.max(7, pct)) + '%">'
        +     done + '/' + total + '</span>'
        +   '<div class="msbar"><i style="width:' + pct + '%"></i></div>'
        + '</div>'
        + (open ? taskListHtml(m) : '')
        + '</div>';
    });
    return out;
  }

  function taskListHtml(m) {
    var ts = m.tasks || [];
    if (!ts.length) return '<div class="mstasks"><span class="mstask todo">'
      + 'Nothing set on this level yet.</span></div>';
    // Done first, greyed ones after — the order the server already sorts
    // them in, so what a parent sees is what their child can do, then
    // what is next.
    var out = '<div class="mstasks">' + ts.map(function (t) {
      return '<div class="mstask ' + (t.done ? 'done' : 'todo') + '">'
        + '<span class="tick">\u2713</span><span>' + esc(t.name) + '</span></div>';
    }).join('') + '</div>';
    if (m.certificate && m.activated) {
      out += '<div class="mscert">'
        + (m.certificate_claimed_at
            ? '\u2713 Certificate collected'
            : '\u2605 A certificate is waiting \u2014 ask at the centre next time you are in.')
        + '</div>';
    }
    return out;
  }

  function wireGrading(studentId, g) {
    var redraw = function () {
      $('childGrading').innerHTML = gradingHtml(g);
      wireGrading(studentId, g);
    };
    Array.prototype.forEach.call($('childGrading').querySelectorAll('[data-toggle]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-toggle');
        gradeOpen[id] = !gradeOpen[id];
        redraw();
      });
    });
    Array.prototype.forEach.call($('childGrading').querySelectorAll('[data-syl]'), function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-syl');
        sylOpen[id] = !sylOpen[id];
        redraw();
      });
    });
  }

  // ── One child ────────────────────────────────────────────────────────
  // What the coaches have written about them. The reason a parent opens
  // this app twice a term rather than twice a year.
  function openChild(id, name, next, idx) {
    $('childName').textContent = name || '';
    var av = $('childInitials');
    av.textContent = initials(name);
    av.className = 'kid k' + ((Math.max(0, idx) % 3) + 1);
    $('childNext').textContent = next
      ? whenWord(next.class_date) + ' · ' + hhmm(next.start_time) + ' · ' + next.lesson
      : 'No class booked';
    $('childNotes').innerHTML = '<div class="empty">Loading…</div>';
    $('childGrading').innerHTML = '';
    setView('child');
    loadChildGrading(id);
    rpc('my_child_notes', { p_student: id }).then(function (rows) {
      rows = rows || [];
      $('childNotes').innerHTML = rows.length ? rows.map(function (n) {
        return '<div class="card pnote">'
          + '<div class="lead" style="white-space:pre-wrap">' + esc(n.body) + '</div>'
          + '<div class="by">' + esc(n.author) + ' · ' + esc(ago(n.created_at)) + '</div>'
          + '</div>';
      }).join('')
        : '<div class="empty">Nothing yet.<br>Coaches write here after a lesson '
          + 'when there is something to say.</div>';
    }).catch(function (e) {
      $('childNotes').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  // ── Progress ─────────────────────────────────────────
  // Every note about every swimmer in the family, newest first, rather
  // than one child at a time behind a tap. my_child_notes() with no
  // argument has always returned exactly this and nothing ever asked
  // for it.
  //
  // Grouped by month, because a family two years in has a hundred of
  // these and a flat list is a wall. Filtered by swimmer, but only when
  // there is more than one — a filter with a single option is furniture.
  var progFilter = null;    // student_id, or null for everybody
  var progRows = null;      // cached, so tapping a chip does not refetch

  function loadProgress() {
    $('progBody').innerHTML = '<div class="empty">Loading…</div>';
    return rpc('my_child_notes', {}).then(function (rows) {
      progRows = rows || [];
      renderProgress();
    }).catch(function (e) {
      $('progBody').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  function renderProgress() {
    var rows = progRows || [];
    var kids = [];
    rows.forEach(function (n) {
      if (!kids.some(function (k) { return k.id === n.student_id; }))
        kids.push({ id: n.student_id, name: n.child });
    });

    $('progFilter').innerHTML = kids.length > 1
      ? '<button data-f="" class="' + (progFilter ? '' : 'on') + '">Everyone</button>'
        + kids.map(function (k) {
            return '<button data-f="' + esc(k.id) + '" class="'
              + (progFilter === k.id ? 'on' : '') + '">' + esc(k.name) + '</button>';
          }).join('')
      : '';
    Array.prototype.forEach.call($('progFilter').querySelectorAll('[data-f]'), function (b) {
      b.addEventListener('click', function () {
        progFilter = b.getAttribute('data-f') || null;
        renderProgress();
      });
    });

    var show = progFilter
      ? rows.filter(function (n) { return n.student_id === progFilter; })
      : rows;

    if (!show.length) {
      $('progBody').innerHTML = '<div class="empty">Nothing yet.<br>'
        + 'Coaches write here after a lesson when there is something to say.</div>';
      return;
    }

    var html = '', month = '';
    show.forEach(function (n) {
      var m = monthWord(n.created_at);
      if (m !== month) { month = m; html += '<div class="progmonth">' + esc(m) + '</div>'; }
      html += '<div class="card pnote">'
        // The swimmer's name leads only when the list holds more than
        // one. Inside a single child's list it is noise on every card.
        + (kids.length > 1 && !progFilter
            ? '<div class="who">' + esc(n.child) + '</div>' : '')
        + '<div class="lead" style="white-space:pre-wrap">' + esc(n.body) + '</div>'
        + '<div class="by">' + esc(n.author) + ' · ' + esc(noteDate(n.created_at)) + '</div>'
        + '</div>';
    });
    $('progBody').innerHTML = html;
  }

  function monthWord(ts) {
    try {
      return new Date(ts).toLocaleDateString('en-GB',
        { month: 'long', year: 'numeric', timeZone: TZ });
    } catch (e) { return ''; }
  }

  // The full date, not "3 days ago". A note is a record, and a record
  // read six months later needs to say when it was written.
  function noteDate(ts) {
    try {
      return new Date(ts).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
    } catch (e) { return ''; }
  }

  function whenWord(iso) {
    var t = todayKL();
    if (iso === t) return 'Today';
    if (iso === addDays(t, 1)) return 'Tomorrow, ' + niceDate(iso);
    return niceDate(iso);
  }

  // ── Classes ──────────────────────────────────────────────────────────
  function loadSchedule() {
    $('schedBody').innerHTML = '<div class="empty">Loading…</div>';
    return rpc('my_schedule', { p_from: wkStart, p_to: addDays(wkStart, 6) })
      .then(function (rows) { renderSchedule(rows || []); })
      .catch(function (e) {
        $('schedBody').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
      });
  }

  function renderSchedule(rows) {
    var today = todayKL();
    $('wkLabel').textContent = (wkStart === mondayOf(today) ? 'This week · ' : '')
      + niceDate(wkStart).replace(/^\w+,\s*/, '') + ' – '
      + niceDate(addDays(wkStart, 6)).replace(/^\w+,\s*/, '');

    var has = {};
    rows.forEach(function (r) { if (!r.is_cancelled) has[r.class_date] = 1; });
    var strip = '';
    for (var i = 0; i < 7; i++) {
      var d = addDays(wkStart, i);
      strip += '<button data-d="' + d + '" class="' + (d === wkDay ? 'on' : '')
        + (has[d] ? '' : ' off') + '">' + esc(dow(d)) + '<b>' + esc(dayNum(d)) + '</b></button>';
    }
    $('wkDays').innerHTML = strip;
    Array.prototype.forEach.call($('wkDays').querySelectorAll('[data-d]'), function (b) {
      b.addEventListener('click', function () {
        wkDay = b.getAttribute('data-d'); renderSchedule(rows);
      });
    });
    var sel = $('wkDays').querySelector('button.on');
    if (sel && sel.scrollIntoView) {
      try { sel.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }

    var day = rows.filter(function (r) { return r.class_date === wkDay; });
    $('schedBody').innerHTML = day.length ? day.map(function (r) {
      var tags = [];
      if (r.is_cancelled)    tags.push('<span class="pill p-slate">Cancelled</span>');
      if (r.is_replacement)  tags.push('<span class="pill p-blue">Replacement</span>');
      if (r.attendance === 'attended') tags.push('<span class="pill p-green">Attended</span>');
      if (r.attendance === 'absent')   tags.push('<span class="pill p-amber">Away</span>');
      return '<div class="card' + (r.is_cancelled ? ' off' : '') + '">'
        + '<div class="row"><div class="grow">'
        + '<div class="big' + (r.is_cancelled ? ' strike' : '') + '">'
        +   esc(hhmm(r.start_time)) + ' – ' + esc(hhmm(r.end_time)) + '</div>'
        + '<div class="sub">' + esc(r.child) + ' · ' + esc(r.lesson) + '</div>'
        + '<div class="sub">' + esc([r.pool, r.coach && ('Coach ' + r.coach)]
            .filter(Boolean).join(' · ')) + '</div>'
        + '</div></div>'
        + (tags.length ? '<div style="margin-top:8px">' + tags.join(' ') + '</div>' : '')
        + (r.is_cancelled
            ? '<div class="sub" style="margin-top:6px">This class did not run. No credit was used.</div>'
            : '')
        + '</div>';
    }).join('') : '<div class="empty">No class on ' + esc(dow(wkDay, true)) + '.</div>';
  }

  // ── Credits ──────────────────────────────────────────────────────────
  function loadCredits() {
    $('creditsBody').innerHTML = '<div class="empty">Loading…</div>';
    return rpc('my_credits').then(function (rows) {
      rows = rows || [];
      if (!rows.length) {
        $('creditsBody').innerHTML = '<div class="empty">No credits on this account yet.</div>';
        return;
      }
      var by = {};
      rows.forEach(function (r) { (by[r.child] = by[r.child] || []).push(r); });
      $('creditsBody').innerHTML = Object.keys(by).map(function (child, i) {
        return '<div class="card"><div class="row">'
          + '<div class="kid k' + ((i % 3) + 1) + '">' + esc(initials(child)) + '</div>'
          + '<div class="grow"><div class="big">' + esc(child) + '</div></div></div>'
          + by[child].map(function (r) {
              var n = Number(r.remaining);
              return '<div class="line"></div><div class="row">'
                + '<div class="grow"><div style="font-weight:700">' + esc(r.lesson) + '</div>'
                + (n < 0 ? '<div class="sub" style="color:var(--amber-tx)">'
                           + Math.abs(n) + ' class' + (Math.abs(n) === 1 ? '' : 'es')
                           + ' owed — the centre will be in touch</div>'
                   : n === 0 ? '<div class="sub">None left</div>' : '')
                + '</div>'
                + '<div class="money" style="font-size:19px;color:'
                +   (n < 0 ? 'var(--amber-tx)' : n === 0 ? 'var(--muted)' : 'var(--text)') + '">'
                +   esc(n) + '</div></div>';
            }).join('')
          + '</div>';
      }).join('');
    }).catch(function (e) {
      $('creditsBody').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  // ── Billing ──────────────────────────────────────────────────────────
  function loadBilling() {
    $('invBody').innerHTML = '<div class="empty">Loading…</div>';
    $('rcptBody').innerHTML = '';
    return Promise.all([rpc('my_invoices'), rpc('my_receipts')]).then(function (out) {
      var inv = out[0] || [], rc = out[1] || [];
      $('invBody').innerHTML = inv.length ? inv.map(function (i) {
        var owed = Number(i.outstanding || 0);
        return '<div class="card"><div class="row">'
          + '<div class="grow"><div class="big">' + esc(i.invoice_number || '—') + '</div>'
          + '<div class="sub">' + esc(i.issue_date ? niceDate(i.issue_date) : '')
          +   (i.due_date ? ' · due ' + esc(niceDate(i.due_date)) : '') + '</div></div>'
          + '<div style="text-align:right"><div class="money">' + esc(money(i.total)) + '</div>'
          + (owed > 0.004
              ? '<span class="pill p-amber">' + esc(money(owed)) + ' due</span>'
              : '<span class="pill p-green">Paid</span>')
          + '</div></div></div>';
      }).join('') : '<div class="empty">No invoices yet.</div>';

      $('rcptBody').innerHTML = rc.length ? rc.map(function (p) {
        var refund = Number(p.amount) < 0 || p.kind === 'refund';
        return '<div class="card"><div class="row">'
          + '<div class="grow"><div style="font-weight:700">' + esc(p.receipt_number || '—') + '</div>'
          + '<div class="sub">' + esc(p.payment_date ? niceDate(p.payment_date) : '')
          +   (p.method ? ' · ' + esc(p.method) : '')
          +   (p.invoice_number ? ' · ' + esc(p.invoice_number) : '') + '</div></div>'
          + '<div class="money" style="color:' + (refund ? 'var(--amber-tx)' : 'var(--green-tx)') + '">'
          +   (refund ? 'Refund ' : '') + esc(money(Math.abs(Number(p.amount || 0)))) + '</div>'
          + '</div></div>';
      }).join('') : '<div class="empty">No receipts yet.</div>';
    }).catch(function (e) {
      $('invBody').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  // ── Inbox ────────────────────────────────────────────
  // What a message says it is, under the text. This knew two kinds and
  // called everything else "Star Swim", so a receipt and a reminder and
  // an absence note all arrived wearing the same label — which is the
  // one thing a list of messages has to get right, because it is what a
  // parent scans before deciding whether to open anything.
  var KIND_LABEL = {
    reminder:     'Class reminder',
    replacement:  'Replacement class',
    payment:      'Payment received',
    absence:      'Attendance',
    outstanding:  'Your account',
    announcement: 'Announcement',
    correction:   'Attendance corrected'
  };
  function kindLabel(k) { return KIND_LABEL[k] || 'Star Swim'; }
  function loadMessages() {
    return rpc('my_messages', { p_limit: 50 }).then(function (rows) {
      rows = rows || [];
      var unread = rows.filter(function (m) { return !m.read_at; });
      $('msgDot').innerHTML = unread.length ? '<span class="dot"></span>' : '';

      // The newest unread announcement rides at the top of Home, because
      // a notice nobody opens is a notice nobody got.
      var top = unread.filter(function (m) { return m.kind === 'announcement'; })[0];
      $('homeBanner').innerHTML = top
        ? '<div class="card" style="background:var(--amber-bg);border-color:var(--amber-bd)">'
          + '<div class="row" style="align-items:flex-start">'
          + '<div style="font-size:18px;line-height:1">📣</div><div class="grow">'
          + '<div style="font-weight:800;color:#92400E;font-size:15px">' + esc(top.title) + '</div>'
          + '<div class="lead" style="color:#92400E;margin-top:3px">' + esc(top.body) + '</div>'
          + '<div class="sub" style="color:#B45309;margin-top:6px">Star Swim · '
          +   esc(ago(top.created_at)) + '</div></div></div></div>'
        : '';

      $('msgBody').innerHTML = rows.length ? rows.map(function (m) {
        // Only an absence can be disputed from here. A parent who thinks
        // a payment or a reminder is wrong is telephoning anyway, and a
        // button on every message turns one meaningful signal into noise
        // the office has to sort through.
        var canFlag = m.kind === 'absence';
        var foot = '';
        if (m.flagged_at) {
          foot = '<div class="msgflag flagged">'
               + '<span>⚑ You told us this looks wrong. The centre will check it.</span>'
               + '<button class="linkish" data-unflag="' + esc(m.id) + '">Undo</button></div>';
        } else if (canFlag) {
          foot = '<div class="msgflag">'
               + '<button class="linkish" data-flag="' + esc(m.id) + '">'
               + 'This isn’t right</button></div>';
        }
        return '<div class="card msg' + (m.read_at ? '' : ' unread') + '" data-m="' + esc(m.id) + '">'
          + '<div style="font-weight:800">' + esc(m.title)
          +   (m.read_at ? '' : '<span class="dot"></span>') + '</div>'
          + '<div class="lead" style="margin-top:4px;white-space:pre-wrap">' + esc(m.body) + '</div>'
          + '<div class="sub" style="margin-top:6px">'
          +   esc(kindLabel(m.kind)) + ' · '
          +   esc(ago(m.created_at)) + '</div>' + foot + '</div>';
      }).join('') : '<div class="empty">Nothing from the centre yet.</div>';

      Array.prototype.forEach.call($('msgBody').querySelectorAll('[data-flag],[data-unflag]'), function (b) {
        b.addEventListener('click', function (ev) {
          // stopPropagation, or the card's own handler marks the message
          // read in the same tap and the list reloads underneath us.
          ev.stopPropagation();
          var on  = b.getAttribute('data-flag');
          var off = b.getAttribute('data-unflag');
          b.disabled = true;
          b.textContent = on ? 'Sending…' : 'Undoing…';
          rpc(on ? 'flag_message' : 'unflag_message',
              on ? { p_id: on } : { p_id: off })
            .then(loadMessages)
            .catch(function (e) {
              b.disabled = false;
              b.textContent = on ? 'This isn’t right' : 'Undo';
              alert(e.message || 'Could not send that just now.');
            });
        });
      });

      Array.prototype.forEach.call($('msgBody').querySelectorAll('[data-m]'), function (c) {
        c.addEventListener('click', function () {
          if (!c.classList.contains('unread')) return;
          c.classList.remove('unread');
          var d = c.querySelector('.dot'); if (d) d.remove();
          rpc('mark_message_read', { p_id: c.getAttribute('data-m') })
            .then(loadMessages).catch(function () {});
        });
      });
    }).catch(function () {});
  }

  function ago(ts) {
    if (!ts) return '';
    var ms = Date.now() - new Date(ts).getTime();
    var h = Math.floor(ms / 3600000);
    if (h < 1) return 'just now';
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.floor(h / 24);
    if (d < 8) return d + (d === 1 ? ' day ago' : ' days ago');
    return new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(ts));
  }

  // ── Wiring ───────────────────────────────────────────────────────────
  // Opening the code screen carries over whatever they already typed, so
  // nobody retypes a number they have entered once.
  $('toCode').addEventListener('click', function () {
    note($('loginNote'), ''); note($('askNote'), '');
    $('askPhone').value = $('phone').value || '';
    hide($('s-login')); show($('s-askcode'));
    $('askPhone').focus();
  });

  $('backToPw').addEventListener('click', function () {
    note($('askNote'), '');
    hide($('s-askcode')); show($('s-login'));
  });

  $('sendCode').addEventListener('click', function () {
    var p = e164($('askPhone').value);
    if (p.replace(/\D/g, '').length < 10) {
      note($('askNote'), 'Enter the mobile number the centre has for you.', true); return;
    }
    note($('askNote'), '');
    this.disabled = true; this.textContent = 'Sending…';
    var btn = this;
    sendCode(p).then(function (out) {
      var channel = out.channel;
      pendingPhone = p;
      // Which way it went matters: somebody waiting on WhatsApp will not
      // think to look in their text messages.
      $('otpSentTo').textContent = 'We sent it to ' + p
        + (channel === 'sms' ? ' by SMS' : ' on WhatsApp');
      note($('otpNote'), '');
      $('code').value = '';
      hide($('s-login')); hide($('s-askcode')); show($('s-otp'));
      holdResend(out.cooldownSec || RESEND_WAIT);
      $('code').focus();
    }).catch(function (e) {
      note($('askNote'), e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Send me a code';
    });
  });

  // Sign in with the password. The common path once a parent has one,
  // and the only one that costs nothing.
  $('signIn').addEventListener('click', function () {
    var p = e164($('phone').value);
    var pw = String($('pw').value || '');
    if (p.replace(/\D/g, '').length < 10) {
      note($('loginNote'), 'That does not look like a mobile number.', true); return;
    }
    if (!pw) {
      note($('loginNote'), 'Enter your password, or ask us for a code.', true); return;
    }
    note($('loginNote'), '');
    var btn = this; btn.disabled = true; btn.textContent = 'Signing in…';
    loginWithPassword(p, pw).then(function () {
      $('pw').value = '';
      return enter();
    }).catch(function (e) {
      if (e.notDeployed) {
        // parent-login is not up yet. Say what to do rather than what
        // broke: the code path is still there and still works.
        note($('loginNote'), 'Passwords are not switched on yet — '
          + 'ask us for a code instead.', true);
      } else if (e.mustUseCode) {
        note($('loginNote'), e.message, true);
        $('pw').value = '';
      } else {
        note($('loginNote'), e.message
          + (typeof e.triesLeft === 'number' && e.triesLeft > 0 && e.triesLeft <= 2
             ? ' ' + e.triesLeft + ' more tr' + (e.triesLeft === 1 ? 'y' : 'ies')
               + ' before we send a code instead.' : ''), true);
      }
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
    });
  });

  // Both boxes, same behaviour. Seeing what you typed on a phone
  // keyboard is what actually prevents the mistake.
  function wireShow(boxId, fieldId) {
    var box = $(boxId);
    if (!box) return;
    box.addEventListener('change', function () {
      $(fieldId).type = box.checked ? 'text' : 'password';
    });
  }
  wireShow('pwShow', 'pw');
  wireShow('newpwShow', 'newpw');

  // ── Choosing a password ──────────────────────────────────────────────
  // Reached only straight after a code was accepted, which is both the
  // first sign-in and the way back from a forgotten password.
  var pwSaveFails = 0;
  function askForPassword() {
    pwSaveFails = 0;
    $('newpw').value = '';
    note($('setpwNote'), '');
    hide($('s-login')); hide($('s-otp')); hide($('s-askcode')); show($('s-setpw'));
    $('newpw').focus();
  }

  $('savePw').addEventListener('click', function () {
    var pw = String($('newpw').value || '');
    if (pw.length < 8) {
      note($('setpwNote'), 'Make it at least 8 characters.', true); return;
    }
    var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
    setPassword(pw).then(function () {
      $('newpw').value = '';
      return enter();
    }).catch(function (e) {
      pwSaveFails++;
      note($('setpwNote'), e.message, true);
      // Forced, but never a dead end. If saving genuinely cannot work —
      // a setting wrong at Supabase's end, say — then holding every
      // parent on this screen after they have already proved who they
      // are would break the app for all of them at once. They are in;
      // the password can wait for the account menu.
      if (pwSaveFails >= 2 && !$('pwLater')) {
        var later = document.createElement('button');
        later.id = 'pwLater';
        later.className = 'btn btn-ghost';
        later.style.marginTop = '8px';
        later.textContent = 'Continue without one for now';
        later.addEventListener('click', function () { enter(); });
        btn.parentNode.appendChild(later);
      }
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Save and continue';
    });
  });

  $('verifyCode').addEventListener('click', function () {
    var t = String($('code').value || '').replace(/\D/g, '');
    if (t.length < 4) { note($('otpNote'), 'Enter the code we sent you.', true); return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Signing in…';
    verify(pendingPhone, t).then(askForPassword).catch(function (e) {
      note($('otpNote'), e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
    });
  });

  // ── Send it again, but not four times in ten seconds ─────────────────
  // Every tap is a message Twilio charges for. A parent who does not see
  // the SMS within a few seconds taps this again, and again — which is
  // the ordinary way the bill grows, far more than anything deliberate.
  //
  // The server refuses inside its own cooldown anyway and says how long
  // is left. This is the same rule said earlier and visibly, so the
  // parent waits because the screen told them to rather than because a
  // tap did nothing. Counting down beats a dead button: a button that
  // does not respond reads as broken, and broken is what people tap
  // harder.
  var resendTimer = null;
  // Only a fallback, for a server too old to say. The real number comes
  // back with the permission to send.
  var RESEND_WAIT = 60;

  function holdResend(seconds) {
    var btn = $('resendCode');
    var left = Math.max(1, Math.ceil(seconds || RESEND_WAIT));
    if (resendTimer) clearInterval(resendTimer);
    btn.disabled = true;
    var tick = function () {
      btn.textContent = 'Send it again in ' + left + 's';
      if (left <= 0) {
        clearInterval(resendTimer); resendTimer = null;
        btn.disabled = false; btn.textContent = 'Send it again';
        return;
      }
      left--;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  function releaseResend() {
    if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
    var btn = $('resendCode');
    btn.disabled = false; btn.textContent = 'Send it again';
  }

  $('resendCode').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
    sendCode(pendingPhone).then(function (out) {
      note($('otpNote'), 'Sent again' + (out.channel === 'sms' ? ', by SMS.' : ', on WhatsApp.'));
      holdResend(out.cooldownSec || RESEND_WAIT);
    }).catch(function (e) {
      note($('otpNote'), e.message, true);
      // The server says how many seconds are left when it refuses for
      // the cooldown. Honour its figure over ours: the two can differ if
      // the office changes the setting, and the parent should be told
      // the truth rather than our guess at it.
      if (e.waitSec) holdResend(e.waitSec); else releaseResend();
    });
  });

  $('whoBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    toggleWhoMenu();
  });
  // Anywhere else, and Escape, shuts it. A menu that only closes by
  // tapping the thing that opened it is a menu people close by reloading.
  document.addEventListener('click', function (e) {
    if ($('whoMenu').classList.contains('hidden')) return;
    if ($('whoMenu').contains(e.target)) return;
    closeWhoMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeWhoMenu();
  });
  // Changing it while signed in needs no code: holding a session is
  // already proof of everything a code would have proved. Only a
  // forgotten password costs a message, which is the point.
  $('changePwBtn').addEventListener('click', function () {
    closeWhoMenu();
    hide($('s-app'));
    askForPassword();
    note($('setpwNote'), '');
    $('setpwNote').innerHTML =
      '<div class="note info">Choose a new password. The old one stops working.</div>';
  });

  $('signOutBtn').addEventListener('click', function () {
    // Confirmed, because getting back in is not free: it costs an SMS,
    // a wait, and six of them an hour is the whole allowance.
    if (!window.confirm('Sign out?\n\nYou will need a new code by text message to sign back in.')) {
      closeWhoMenu();
      return;
    }
    signOut();
  });

  // "Use a different number" belongs on the screen that asks for one,
  // not on the sign-in screen, which would make them find the code
  // button again.
  $('backToPhone').addEventListener('click', function () {
    releaseResend();
    note($('askNote'), '');
    hide($('s-otp')); hide($('s-login')); show($('s-askcode'));
    $('askPhone').focus();
  });

  Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { setView(b.getAttribute('data-v')); });
  });

  $('childBack').addEventListener('click', function () { setView('home'); });

  $('wkPrev').addEventListener('click', function () {
    wkStart = addDays(wkStart, -7);
    wkDay = (wkStart === mondayOf(todayKL())) ? todayKL() : wkStart;
    loadSchedule();
  });
  $('wkNext').addEventListener('click', function () {
    wkStart = addDays(wkStart, 7);
    wkDay = (wkStart === mondayOf(todayKL())) ? todayKL() : wkStart;
    loadSchedule();
  });

  $('phone').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('sendCode').click();
  });
  $('code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('verifyCode').click();
  });

  // ── Start ────────────────────────────────────────────────────────────
  load();
  if (session && session.access_token) {
    enter().catch(function () { signOut(); });
  } else {
    show($('s-login'));
  }
})();
