// ─────────────────────────────────────────────────────────────────────────
// Star Swim Attendance — worker app
//
// Deliberately dependency-free: no React, no Supabase client, no CDN. This
// app is used pool-side on mobile data, and every byte it cannot fetch is a
// worker who cannot punch. Plain fetch against PostgREST and the Edge
// Function is enough for three screens, and it keeps the PWA installable
// and usable with a cold cache.
//
// Workers log in with a staff ID. Supabase Auth needs an email, so each
// staff ID maps to a hidden internal address — workers never see or type it.
// ─────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var cfg = window.APP_CONFIG || {};
  var TZ = 'Asia/Kuala_Lumpur';
  var EMAIL_DOMAIN = 'staff.mystarswim.internal';
  var STORE_KEY = 'ssb.attendance.session';
  // Kept apart from the session: the staff ID outlives a sign-out, the
  // tokens must not.
  var ID_KEY    = 'ssb.attendance.staff_id';
  var KEEP_KEY  = 'ssb.attendance.keep';
  var KEEP_DAYS = 90;

  // ── Session storage ────────────────────────────────────────────────────
  // "Keep me logged in" decides persistent vs session storage. Both are read
  // on boot so a worker who ticked the box stays in across app restarts.
  var store = null; // the storage the current session lives in

  function saveSession(s, persistent) {
    store = persistent ? window.localStorage : window.sessionStorage;
    try { store.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }
  function loadSession() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); } catch (e) {}
    if (raw) { store = window.localStorage; }
    if (!raw) {
      try { raw = window.sessionStorage.getItem(STORE_KEY); } catch (e) {}
      if (raw) { store = window.sessionStorage; }
    }
    if (!raw) return null;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return null; }
    // The checkbox promises 90 days. localStorage would otherwise keep it for
    // ever, so the promise is kept here rather than left to the browser.
    if (s && s.persistent && s.saved_at &&
        Date.now() - s.saved_at > KEEP_DAYS * 86400000) {
      clearSession();
      return null;
    }
    return s;
  }
  function clearSession() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
    try { window.sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    store = null;
  }

  // The staff ID is not a secret, and typing it on a wet poolside phone is the
  // slowest part of signing in. It survives sign-out; the password never
  // touches our storage and is left to the browser's own manager.
  function rememberStaffId(id, keep) {
    try {
      window.localStorage.setItem(ID_KEY, id);
      window.localStorage.setItem(KEEP_KEY, keep ? '1' : '0');
    } catch (e) { /* private mode */ }
  }

  function prefillLogin() {
    var id = null, keep = null;
    try {
      id = window.localStorage.getItem(ID_KEY);
      keep = window.localStorage.getItem(KEEP_KEY);
    } catch (e) {}
    if (keep !== null) $('keepMe').checked = keep === '1';
    // Only into an empty field. The browser may have autofilled an ID and a
    // password as a matched pair, and replacing half of it breaks the other.
    if (id && !$('staffId').value) {
      $('staffId').value = id;
      try { $('password').focus(); } catch (e) {}
    }
  }

  // Chrome and Safari will usually notice a submitted login form on their own.
  // This says it outright where the API exists, so the offer to save does not
  // rest on a heuristic. Everywhere else it is a no-op.
  function offerCredentialSave(id, password) {
    try {
      if (!navigator.credentials || !window.PasswordCredential) return;
      var c = new window.PasswordCredential({ id: id, password: password, name: id });
      navigator.credentials.store(c).catch(function () {});
    } catch (e) { /* unsupported, or blocked by policy */ }
  }

  var session = null;   // { access_token, refresh_token, persistent, saved_at }
  var profile = null;   // { crew_id, full_name, staff_id, consented_at }

  // ── Helpers ────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Today's date as the database sees it: a KL calendar date, not the device's.
  function todayKL() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  }
  function prettyDate(iso) {
    var d = new Date(iso + 'T00:00:00+08:00');
    return new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  }
  // '09:00:00' -> '9:00 AM'
  function prettyTime(t) {
    var p = String(t).split(':');
    var h = parseInt(p[0], 10), m = p[1] || '00';
    var ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + m + ' ' + ap;
  }
  function staffIdToEmail(id) {
    return String(id).trim().toLowerCase().replace(/\s+/g, '') + '@' + EMAIL_DOMAIN;
  }

  // ── API ────────────────────────────────────────────────────────────────
  function authHeaders() {
    return {
      'apikey': cfg.supabaseAnonKey,
      'Authorization': 'Bearer ' + (session && session.access_token),
      'Content-Type': 'application/json'
    };
  }

  // Exchange the refresh token for a new access token. Returns true on success.
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.resolve(false);
    return fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'apikey': cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (d) {
        session.access_token = d.access_token;
        session.refresh_token = d.refresh_token || session.refresh_token;
        saveSession(session, session.persistent);
        return true;
      });
    }).catch(function () { return false; });
  }

  // fetch + one transparent retry after a token refresh. An expired token is
  // the normal case for a worker who opens the app days later.
  function api(path, opts, isRetry) {
    opts = opts || {};
    opts.headers = authHeaders();
    return fetch(cfg.supabaseUrl + path, opts).then(function (r) {
      if (r.status === 401 && !isRetry) {
        return refreshSession().then(function (ok) {
          if (!ok) { signOut(); throw new Error('Your session expired. Please sign in again.'); }
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
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || 'Request failed'); });
      return r.json();
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────
  function doLogin(staffId, password, persistent) {
    return fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffIdToEmail(staffId), password: password })
    }).then(function (r) {
      if (!r.ok) throw new Error('Incorrect staff ID or password.');
      return r.json();
    }).then(function (d) {
      session = {
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        persistent: !!persistent,
        // Set once, at sign-in. Refreshing the token does not restart the 90
        // days, or a worker who opens the app daily would never sign in again.
        saved_at: Date.now()
      };
      saveSession(session, persistent);
    });
  }

  function signOut() {
    closeMenu();
    clearSession();
    session = null; profile = null;
    hide($('appScreen')); hide($('consentScreen')); hide($('passwordScreen'));
    show($('loginScreen'));
    $('password').value = '';
    prefillLogin();
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  function boot() {
    session = loadSession();
    if (!session || !session.access_token) { show($('loginScreen')); prefillLogin(); return; }
    loadProfile().catch(function () { signOut(); });
  }

  function loadProfile() {
    return rpc('get_my_profile').then(function (rows) {
      if (!rows || !rows.length) {
        throw new Error('Your login is not linked to a worker record.');
      }
      profile = rows[0];
      hide($('loginScreen'));
      if (!profile.consented_at) { show($('consentScreen')); return; }
      enterApp();
    });
  }

  // How long a worker has to correct a reason, set by the admin.
  var reasonWindowMin = 2;
  var checkoutGraceMin = 30;
  function loadSettings() {
    return api('/rest/v1/attendance_settings?select=reason_edit_window_min,no_checkout_alert_min,timezone')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (rows && rows[0]) {
          if (rows[0].reason_edit_window_min != null) reasonWindowMin = rows[0].reason_edit_window_min;
          if (rows[0].no_checkout_alert_min != null) checkoutGraceMin = rows[0].no_checkout_alert_min;
        }
      }).catch(function () {});
  }

  // Offered once per admin-issued password, straight after sign-in, because
  // that is the moment they still have the slip of paper in front of them.
  var pwOffered = false;
  function maybeOfferPasswordChange() {
    if (!profile || !profile.must_change_password || pwOffered) return false;
    pwOffered = true;
    hide($('loginScreen')); hide($('consentScreen')); hide($('appScreen'));
    $('pwUser').value = profile.staff_id || '';
    show($('passwordScreen'));
    return true;
  }

  function enterApp() {
    if (maybeOfferPasswordChange()) return;
    hide($('loginScreen')); hide($('consentScreen')); hide($('passwordScreen'));
    show($('appScreen'));
    $('whoName').textContent = profile.full_name || '';
    $('whoId').textContent = profile.staff_id || '';
    $('menuPassword').classList.toggle('hidden', !profile.must_change_password);
    loadSettings().then(loadToday);
  }

  // ── Today ──────────────────────────────────────────────────────────────
  var todayShifts = [];

  function loadToday() {
    var date = todayKL();
    $('todayDate').textContent = prettyDate(date);
    $('todayList').innerHTML = '<p class="empty">Loading…</p>';

    var q = '/rest/v1/shifts?select=id,shift_date,start_time,end_time,status,late_min,early_min,'
          + 'locations(name),shift_categories(name)'
          + '&shift_date=eq.' + date + '&order=start_time.asc';

    Promise.all([
      api(q).then(function (r) { return r.ok ? r.json() : []; }),
      rpc('get_my_shift_buddies', { p_date: date }).catch(function () { return []; }),
      loadMyAlerts()
    ]).then(function (res) {
      todayShifts = res[0] || [];
      var buddies = res[1] || [];
      myAlerts = res[2] || [];
      // Anything still unexplained that is NOT on today's list — an absence is
      // almost always yesterday, so without this it would be unreachable.
      var todayIds = todayShifts.map(function (x) { return x.id; });
      var elsewhere = myAlerts.filter(function (a) {
        return !a.worker_reason && todayIds.indexOf(a.shift_id) === -1;
      }).length;
      // punch() writes its green confirmation here and then calls this, so
      // rebuilding the box blindly wiped it within the second: the worker
      // taps, sees the line flash, and taps again to be sure it took. Carry
      // it over, above whatever else needs saying.
      var confirmed = $('punchMsg').querySelector('.note.ok');
      $('punchMsg').innerHTML = elsewhere
        ? '<div class="note info">' + elsewhere + ' earlier session'
          + (elsewhere === 1 ? '' : 's') + ' still need'
          + (elsewhere === 1 ? 's' : '') + ' a reason — see <b>History</b>.</div>'
        : '';
      if (confirmed) $('punchMsg').insertBefore(confirmed, $('punchMsg').firstChild);

      if (!todayShifts.length) {
        $('todayList').innerHTML = '<p class="empty">No sessions scheduled today.</p>';
        return;
      }
      return loadPunches(todayShifts.map(function (s) { return s.id; }))
        .then(function (punches) { renderToday(todayShifts, punches, buddies); });
    }).catch(function (e) {
      $('todayList').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  // Anything of theirs still awaiting a decision. RLS already limits this to
  // the signed-in worker's own rows.
  var myAlerts = [];
  function loadMyAlerts() {
    return api('/rest/v1/alerts?select=id,shift_id,type,status,worker_reason,worker_reason_at&status=eq.open')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }

  function loadPunches(ids) {
    if (!ids.length) return Promise.resolve([]);
    var q = '/rest/v1/punches?select=shift_id,type,punched_at,accepted,distance_m,inside_fence,lat,lng'
          + '&accepted=is.true&shift_id=in.(' + ids.join(',') + ')';
    return api(q).then(function (r) { return r.ok ? r.json() : []; });
  }

  function renderToday(shifts, punches, buddies) {
    var byShift = {};
    punches.forEach(function (p) {
      byShift[p.shift_id] = byShift[p.shift_id] || {};
      byShift[p.shift_id][p.type] = p;
    });
    var buddyBy = {};
    buddies.forEach(function (b) {
      (buddyBy[b.shift_id] = buddyBy[b.shift_id] || []).push(b.buddy_name);
    });

    $('todayList').innerHTML = shifts.map(function (s) {
      var p = byShift[s.id] || {};
      var stage = buttonStage(s, p);
      var loc = (s.locations && s.locations.name) || 'Location';
      var cat = (s.shift_categories && s.shift_categories.name) || '';
      var mates = buddyBy[s.id] || [];

      var meta = [];
      if (p['in'])  meta.push('Checked in ' + fmtClock(p['in'].punched_at));
      if (p['out']) meta.push('Checked out ' + fmtClock(p['out'].punched_at));
      if (s.late_min)  meta.push('Late ' + s.late_min + ' min');
      if (s.early_min) meta.push('Left early ' + s.early_min + ' min');
      if (mates.length) meta.push('Also scheduled here: ' + mates.join(', '));

      // Blue to start, green once they are in and the only thing left is to
      // check out, grey when the session is done. The colour alone tells a
      // worker where they are in the session from across the pool deck.
      var btn = stage === 'done'      ? '<button class="btn done" disabled>Done</button>'
              : CLOSED_NOTE[stage]  ? '<div class="closed-note">' + esc(CLOSED_NOTE[stage]) + '</div>'
              : '<button class="btn' + (stage === 'out' ? ' go' : '') + '"'
                + ' data-punch="' + s.id + '" data-type="' + stage + '">'
                + (stage === 'in' ? 'Check in' : 'Check out') + '</button>';

      return ''
        + '<div class="card s-' + esc(s.status) + '" id="card-' + esc(s.id) + '">'
        +   '<div class="time">' + esc(prettyTime(s.start_time)) + ' – ' + esc(prettyTime(s.end_time))
        +     (cat ? '<span class="tag">' + esc(cat) + '</span>' : '') + '</div>'
        +   '<div class="loc">' + esc(loc) + '</div>'
        +   '<div class="meta">' + esc(meta.join(' · ')) + '</div>'
        +   (p['in'] ? proofLine(p['in'], loc) : '')
        +   '<div style="margin-top:8px"><span class="pill p-' + esc(s.status) + '">'
        +     esc(statusLabel(s.status)) + '</span></div>'
        +   explainBox(s)
        +   btn
        + '</div>';
    }).join('');

    Array.prototype.forEach.call($('todayList').querySelectorAll('[data-punch]'), function (b) {
      b.addEventListener('click', function () {
        punch(b.getAttribute('data-punch'), b.getAttribute('data-type'), b);
      });
    });

    wireExplain($('todayList'));
    startCountdowns();
  }

  // Shows the worker the same evidence the admin sees: where the check-in was
  // taken and whether it fell inside the pool's area. Green means it counted.
  function proofLine(punch, locName) {
    if (punch.lat == null || punch.lng == null) return '';
    var ok = punch.inside_fence !== false;
    var dist = punch.distance_m == null ? ''
      : (punch.distance_m >= 1000 ? (punch.distance_m / 1000).toFixed(1) + ' km'
                                  : Math.round(punch.distance_m) + ' m');
    return '<div class="proof ' + (ok ? 'ok' : 'bad') + '">'
      + '<span class="tick">' + (ok ? '✓' : '✗') + '</span> '
      + esc(dist ? dist + ' from ' + locName : locName)
      + '<span class="ll">' + esc(Number(punch.lat).toFixed(6) + ', ' + Number(punch.lng).toFixed(6)) + '</span>'
      + '</div>';
  }

  // Being late is something only the person who was late can explain. Rather
  // than an admin chasing them for it, they write it here and the admin only
  // decides whether it stands.
  // A short, neutral list. A long menu of excuses invites picking the softest
  // one; the pay decision stays with the admin either way. "Forgot to tap" is
  // offered only where a punch was genuinely missed, never for an absence.
  var REASONS = {
    sick:      'Unwell',
    family:    'Family emergency',
    transport: 'Transport or traffic',
    venue:     'Pool or venue problem',
    forgot:    'Forgot to tap',
    other:     'Something else'
  };
  var REASON_SETS = {
    late:        ['transport','family','sick','venue','other'],
    early_leave: ['sick','family','venue','other'],
    absent:      ['sick','family','transport','other'],
    no_checkin:  ['forgot','transport','sick','family','other'],
    no_checkout: ['forgot','venue','other'],
    geofence:    ['venue','other']
  };

  var ALERT_ASK = {
    late:        'You were marked late.',
    early_leave: 'You left before the session ended.',
    absent:      'You were marked absent.',
    no_checkin:  'No check-in was recorded.',
    no_checkout: 'No check-out was recorded.',
    geofence:    'A check-in was refused for being too far away.'
  };
  function alertsFor(shiftId) {
    return myAlerts.filter(function (a) { return a.shift_id === shiftId; });
  }
  // Seconds left to correct a reason, from the moment it was first saved.
  function secondsLeft(a) {
    if (!a.worker_reason_at) return reasonWindowMin * 60;
    var gone = (Date.now() - new Date(a.worker_reason_at).getTime()) / 1000;
    return Math.max(0, Math.round(reasonWindowMin * 60 - gone));
  }
  function mmss(sec) {
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function explainBox(s) {
    var list = alertsFor(s.id);
    if (!list.length) return '';
    return list.map(function (a) {
      var ask = esc(ALERT_ASK[a.type] || 'Needs an explanation.');

      if (!a.worker_reason && !a.worker_reason_code) {
        return '<div class="explain" data-alert="' + esc(a.id) + '">'
          + '<div class="ask">' + ask + '</div>'
          + reasonChips(a)
          + '<textarea class="reason" rows="2" placeholder="Anything to add? (optional)"></textarea>'
          + '<button class="btn small-btn" data-send="' + esc(a.id) + '">Send reason</button>'
          + '<div class="hint">You can change this for ' + reasonWindowMin
          + ' minutes after sending.</div>'
          + '</div>';
      }

      var left = secondsLeft(a);
      var said = [REASONS[a.worker_reason_code], a.worker_reason].filter(Boolean).join(' — ');
      return '<div class="explain done" data-alert="' + esc(a.id) + '">'
        + '<div class="ask">' + ask + '</div>'
        + '<div class="said">You said: <i>' + esc(said) + '</i></div>'
        + (left > 0
            ? '<button class="btn small-btn edit" data-edit="' + esc(a.id) + '">Change</button>'
              + '<div class="hint">Locked in <b data-countdown="' + esc(a.id) + '">'
              + mmss(left) + '</b></div>'
            : '<div class="hint">Sent to your admin.</div>')
        + '</div>';
    }).join('');
  }

  // One tap is the whole interaction for most people; the text box is there
  // for when it is not.
  function reasonChips(a, selected) {
    var codes = REASON_SETS[a.type] || ['other'];
    return '<div class="chips">' + codes.map(function (c) {
      return '<button type="button" class="chip' + (c === selected ? ' on' : '') + '"'
        + ' data-code="' + c + '">' + esc(REASONS[c]) + '</button>';
    }).join('') + '</div>';
  }

  // Swap the box back to an editable field, keeping what they wrote.
  function startEdit(id) {
    var a = myAlerts.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    var box = document.querySelector('.explain[data-alert="' + id + '"]');
    if (!box) return;
    box.classList.remove('done');
    box.innerHTML = '<div class="ask">' + esc(ALERT_ASK[a.type] || 'Needs an explanation.') + '</div>'
      + reasonChips(a, a.worker_reason_code)
      + '<textarea class="reason" rows="2"></textarea>'
      + '<button class="btn small-btn" data-send="' + esc(id) + '">Save change</button>'
      + '<div class="hint">Locked in <b data-countdown="' + esc(id) + '">'
      + mmss(secondsLeft(a)) + '</b></div>';
    var ta = box.querySelector('textarea');
    ta.value = a.worker_reason || '';
    ta.focus();
    wireExplain(box);
  }

  // One ticker for the whole screen: updates every countdown and, at zero,
  // reloads so the box settles into its locked state.
  var countdownTimer = null;
  function startCountdowns() {
    if (countdownTimer) clearInterval(countdownTimer);
    if (!document.querySelector('[data-countdown]')) return;
    countdownTimer = setInterval(function () {
      var any = false;
      Array.prototype.forEach.call(document.querySelectorAll('[data-countdown]'), function (el) {
        var a = myAlerts.filter(function (x) { return x.id === el.getAttribute('data-countdown'); })[0];
        if (!a) return;
        var left = secondsLeft(a);
        el.textContent = mmss(left);
        if (left > 0) any = true;
      });
      if (!any) { clearInterval(countdownTimer); countdownTimer = null; loadToday(); }
    }, 1000);
  }

  // Used by Today, History, and a box re-opened for editing.
  function wireExplain(root) {
    Array.prototype.forEach.call(root.querySelectorAll('.chip'), function (c) {
      c.addEventListener('click', function () {
        var box = c.closest('.explain');
        var was = c.classList.contains('on');
        Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (x) {
          x.classList.remove('on');
        });
        if (!was) c.classList.add('on');
        // "Something else" says nothing on its own, so ask for words.
        var ta = box.querySelector('textarea');
        var needsWords = !was && c.getAttribute('data-code') === 'other';
        ta.placeholder = needsWords ? 'What happened?' : 'Anything to add? (optional)';
        if (needsWords) ta.focus();
      });
    });

    Array.prototype.forEach.call(root.querySelectorAll('[data-send]'), function (b) {
      b.addEventListener('click', function () {
        var box = b.closest('.explain'), ta = box.querySelector('textarea');
        var text = (ta.value || '').trim();
        var chip = box.querySelector('.chip.on');
        var code = chip ? chip.getAttribute('data-code') : null;
        var err  = box.querySelector('.hint.err');
        if (err) err.remove();
        if (!code && !text) {
          box.insertAdjacentHTML('beforeend',
            '<div class="hint err">Pick a reason, or type what happened.</div>');
          return;
        }
        if (code === 'other' && !text) { ta.focus(); 
          box.insertAdjacentHTML('beforeend',
            '<div class="hint err">Tell us what happened.</div>');
          return;
        }
        var label = b.textContent;
        b.disabled = true; b.textContent = 'Sending…';
        rpc('set_my_alert_reason', { p_alert_id: b.getAttribute('data-send'),
                                     p_reason: text || null, p_code: code })
          .then(function () { refreshViews(); })
          .catch(function (e) {
            b.disabled = false; b.textContent = label;
            var old = box.querySelector('.hint.err');
            if (old) old.remove();
            box.insertAdjacentHTML('beforeend',
              '<div class="hint err">' + esc(e.message || 'Could not send that.') + '</div>');
          });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-edit]'), function (b) {
      b.addEventListener('click', function () { startEdit(b.getAttribute('data-edit')); });
    });
  }
  // Redraw whichever list is on screen.
  function refreshViews() {
    if (!$('viewHistory').classList.contains('hidden')) loadHistory();
    else loadToday();
  }

  // What the card should offer. Previously this read the punches alone, so a
  // session already marked absent still showed a live Check in — the worker
  // tapped it and the server refused. A button that cannot work should not be
  // there at all.
  function buttonStage(s, p) {
    var ended = minutesPastEnd(s);
    if (s.status === 'absent') return 'absent';
    if (!p['in'])  return ended > 0 ? 'missed_in' : 'in';
    if (!p['out']) return ended > checkoutGraceMin ? 'missed_out' : 'out';
    return 'done';
  }
  // Say what specifically is closed. "Nothing more to do" reads as a
  // contradiction next to a box still asking for a reason.
  var CLOSED_NOTE = {
    absent:     'Marked absent. Your admin will close this.',
    missed_in:  'Too late to check in. Your admin will record this.',
    missed_out: 'Too late to check out. Your admin will record your time.'
  };
  // Minutes since the session's end, in the pool's timezone.
  function minutesPastEnd(s) {
    var t = String(s.end_time).split(':');
    var end = new Date(s.shift_date + 'T'
      + String(t[0]).padStart(2, '0') + ':' + String(t[1]).padStart(2, '0') + ':00+08:00');
    return (Date.now() - end.getTime()) / 60000;
  }

  function fmtClock(iso) {
    return new Intl.DateTimeFormat('en-GB',
      { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  }
  function statusLabel(s) {
    return {
      scheduled: 'Scheduled', on_time: 'On time', late: 'Late',
      early_leave: 'Left early', incomplete: 'No check-out',
      absent: 'Absent', geofence_flag: 'Location flagged'
    }[s] || s;
  }

  // ── Punch ──────────────────────────────────────────────────────────────
  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('This device cannot provide a location.')); return;
      }
      navigator.geolocation.getCurrentPosition(
        function (pos) { resolve(pos.coords); },
        function (err) {
          reject(new Error(
            err.code === 1 ? 'Location permission is off. Turn it on for this app and try again.'
          : err.code === 3 ? 'Could not get a location in time. Move into the open and try again.'
                           : 'Could not get your location. Try again.'));
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  function punch(shiftId, type, btn) {
    var msg = $('punchMsg');
    msg.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Getting your location…';

    var lastFix = 0, lastLng = 0;
    getPosition().then(function (c) {
      lastFix = c.latitude; lastLng = c.longitude;
      btn.textContent = 'Sending…';
      return api('/functions/v1/punch', {
        method: 'POST',
        body: JSON.stringify({
          shift_id: shiftId, type: type,
          lat: c.latitude, lng: c.longitude, accuracy_m: c.accuracy
        })
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, body: d }; });
      });
    }).then(function (res) {
      if (!res.ok) throw new Error(res.body && res.body.error ? res.body.error : 'Could not record that.');
      var d = res.body.distance_m;
      var where = d == null ? '' : ' · ' + (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m') + ' from the pool';
      msg.innerHTML = '<div class="note ok">'
        + '<b>✓ ' + (type === 'in' ? 'Checked in' : 'Checked out') + ' at '
        + esc(fmtClock(res.body.punched_at)) + '</b>' + esc(where)
        + '<div class="ll">' + esc(lastFix.toFixed(6) + ', ' + lastLng.toFixed(6)) + '</div>'
        + '</div>';
      loadToday();
    }).catch(function (e) {
      msg.innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
      btn.disabled = false;
      btn.textContent = type === 'in' ? 'Check in' : 'Check out';
    });
  }

  // ── History ────────────────────────────────────────────────────────────
  function loadHistory() {
    var box = $('historyList');
    box.innerHTML = '<p class="empty">Loading…</p>';
    var from = new Date(Date.now() - 30 * 86400000);
    var fromStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(from);
    var q = '/rest/v1/shifts?select=id,shift_date,start_time,end_time,status,late_min,early_min,remark,'
          + 'locations(name)&shift_date=gte.' + fromStr
          + '&shift_date=lt.' + todayKL() + '&order=shift_date.desc,start_time.desc';

    Promise.all([
      api(q).then(function (r) { return r.ok ? r.json() : []; }),
      loadMyAlerts()
    ]).then(function (res) {
      var rows = res[0] || [];
      myAlerts = res[1] || [];
      if (!rows.length) { box.innerHTML = '<p class="empty">Nothing in the last 30 days.</p>'; return; }
      box.innerHTML = rows.map(function (s) {
        var bits = [];
        if (s.late_min)  bits.push('Late ' + s.late_min + ' min');
        if (s.early_min) bits.push('Left early ' + s.early_min + ' min');
        if (s.remark)    bits.push('Admin note: ' + s.remark);
        return ''
          + '<div class="card s-' + esc(s.status) + '">'
          +   '<div class="time">' + esc(prettyDate(s.shift_date)) + '</div>'
          +   '<div class="loc">' + esc(prettyTime(s.start_time)) + ' – ' + esc(prettyTime(s.end_time))
          +     ' · ' + esc((s.locations && s.locations.name) || '') + '</div>'
          +   (bits.length ? '<div class="meta">' + esc(bits.join(' · ')) + '</div>' : '')
          +   '<div style="margin-top:8px"><span class="pill p-' + esc(s.status) + '">'
          +     esc(statusLabel(s.status)) + '</span></div>'
          +   explainBox(s)
          + '</div>';
      }).join('');
      wireExplain(box);
      startCountdowns();
    }).catch(function (e) {
      box.innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────
  function loadSummary() {
    var box = $('summaryBody');
    box.innerHTML = '<p class="empty">Loading…</p>';
    api('/rest/v1/v_attendance_monthly?select=*&order=period.desc')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (!rows.length) { box.innerHTML = '<p class="empty">No hours recorded yet.</p>'; return; }
        var byPeriod = {};
        rows.forEach(function (r) { (byPeriod[r.period] = byPeriod[r.period] || []).push(r); });
        box.innerHTML = Object.keys(byPeriod).sort().reverse().map(function (p) {
          var label = new Intl.DateTimeFormat('en-GB',
            { timeZone: TZ, month: 'long', year: 'numeric' }).format(new Date(p + 'T00:00:00+08:00'));
          return '<h2>' + esc(label) + '</h2>'
            + '<table><thead><tr><th>Category</th><th class="num">Sessions</th>'
            + '<th class="num">Hours</th><th class="num">Late</th><th class="num">Absent</th></tr></thead><tbody>'
            + byPeriod[p].map(function (r) {
                return '<tr><td>' + esc(r.category_name) + '</td>'
                  + '<td class="num">' + esc(r.sessions) + '</td>'
                  + '<td class="num">' + Number(r.attended_hours || 0).toFixed(1) + '</td>'
                  + '<td class="num">' + esc(r.late_count || 0) + '</td>'
                  + '<td class="num">' + esc(r.absent_count || 0) + '</td></tr>';
              }).join('')
            + '</tbody></table>';
        }).join('');
      }).catch(function (e) {
        box.innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
      });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn'), err = $('loginError');
    hide(err); btn.disabled = true; btn.textContent = 'Signing in…';
    var id = $('staffId').value.trim(), pw = $('password').value, keep = $('keepMe').checked;
    doLogin(id, pw, keep)
      .then(function () {
        // Only once the credentials are known good — no point remembering a
        // staff ID that was mistyped, or offering to save a wrong password.
        rememberStaffId(id, keep);
        offerCredentialSave(id, pw);
      })
      .then(loadProfile)
      .catch(function (ex) {
        err.textContent = ex.message; show(err);
        clearSession(); session = null;
      })
      .then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  });

  $('consentBtn').addEventListener('click', function () {
    var btn = $('consentBtn'), err = $('consentError');
    hide(err); btn.disabled = true; btn.textContent = 'Saving…';
    rpc('record_my_consent').then(function (at) {
      profile.consented_at = at || new Date().toISOString();
      enterApp();
    }).catch(function (e) {
      err.textContent = e.message; show(err);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'I understand — continue';
    });
  });

  $('passwordForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('pwBtn'), err = $('pwError');
    var cur = $('curPw').value, a = $('newPw').value, b = $('newPw2').value;
    hide(err);
    if (a !== b) { err.textContent = 'The two new passwords do not match.'; show(err); return; }
    if (a.length < 8) { err.textContent = 'Use at least 8 characters.'; show(err); return; }
    if (a === cur) { err.textContent = 'Choose something different from the one you were given.'; show(err); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch(cfg.supabaseUrl + '/functions/v1/staff-auth', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'change_own_password', current_password: cur, new_password: a })
    }).then(function (r) {
      return r.json().catch(function () { return {}; })
        .then(function (d) { if (!r.ok) throw new Error(d.error || 'Could not save that.'); });
    }).then(function () {
      profile.must_change_password = false;
      offerCredentialSave(profile.staff_id || $('pwUser').value, a);
      $('curPw').value = $('newPw').value = $('newPw2').value = '';
      enterApp();
    }).catch(function (ex) {
      err.textContent = ex.message; show(err);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Save password';
    });
  });
  // Skipping keeps the offer for next sign-in; it is spent only by using it.
  $('pwLater').addEventListener('click', function () {
    $('curPw').value = $('newPw').value = $('newPw2').value = '';
    enterApp();
  });

  // ── Account menu ───────────────────────────────────────────────────────
  // Sign out lived at the bottom of My summary, which nobody would think to
  // look for. It belongs with the name it signs out of.
  function closeMenu() {
    $('whoMenu').classList.add('hidden');
    $('whoBtn').setAttribute('aria-expanded', 'false');
  }
  function toggleMenu() {
    var open = $('whoMenu').classList.toggle('hidden') === false;
    $('whoBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  $('whoBtn').addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', function (e) {
    if (!$('whoMenu').classList.contains('hidden') && !$('whoMenu').contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  // Only shown while their one change is still available, so the menu never
  // offers something that would be refused.
  $('menuPassword').addEventListener('click', function () {
    closeMenu();
    pwOffered = false;
    maybeOfferPasswordChange();
  });

  $('consentSignOut').addEventListener('click', signOut);
  $('signOutBtn').addEventListener('click', signOut);

  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-view');
      Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      ['Today', 'History', 'Summary'].forEach(function (name) {
        $('view' + name).classList.toggle('hidden', name !== v);
      });
      if (v === 'History') loadHistory();
      if (v === 'Summary') loadSummary();
      if (v === 'Today') loadToday();
    });
  });

  // Refresh Today when the app comes back to the foreground — a worker
  // typically reopens it at the pool, minutes after last looking at it.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && profile && !$('viewToday').classList.contains('hidden')) loadToday();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  boot();
})();
