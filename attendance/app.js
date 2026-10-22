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
  // What the server sends back is not written for a worker. PostgREST wraps a
  // raise from a function as {code, details, hint, message}, and printing the
  // lot put a line of JSON on a poolside phone. Only the message is meant for
  // a person; anything else gets a sentence instead.
  function readableError(text, fallback) {
    var d = null;
    try { d = JSON.parse(text); } catch (e) {}
    var m = d && (d.message || d.error_description || d.error || d.msg || d.detail);
    if (typeof m === 'string' && m.trim()) return m.trim();
    if (typeof text === 'string' && text.trim() && text.indexOf('{') !== 0) return text.trim();
    return fallback || 'Something went wrong. Please try again.';
  }

  // fetch only rejects when the request never got a reply at all: no signal in
  // a pool car park, flight mode, a Wi-Fi that has quietly dropped. That is
  // not the worker's fault and must not read like a wrong password.
  var OFFLINE = 'Cannot reach Star Swim. Check your connection and try again.';
  function asOffline() { throw new Error(OFFLINE); }

  function authHeaders() {
    return {
      'apikey': cfg.supabaseAnonKey,
      'Authorization': 'Bearer ' + (session && session.access_token),
      'Content-Type': 'application/json'
    };
  }

  // Exchange the refresh token for a new access token. Returns true on success.
  //
  // Shared, because several requests discover an aged-out token at the same
  // moment: opening the app fires the roster, the buddies and the alerts
  // together. Supabase SPENDS a refresh token when it is used, so a second
  // caller presenting the same one is refused — and the app read that refusal
  // as "signed out" and sent the worker back to the password screen, in the
  // middle of checking in. One refresh, everyone waits on it.
  var refreshInFlight = null;
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.resolve(false);
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
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
    }).catch(function () { return false; })
      .then(function (ok) { refreshInFlight = null; return ok; });
    return refreshInFlight;
  }

  // fetch + one transparent retry after a token refresh. An expired token is
  // the normal case for a worker who opens the app days later.
  function api(path, opts, isRetry) {
    opts = opts || {};
    opts.headers = authHeaders();
    return fetch(cfg.supabaseUrl + path, opts).catch(asOffline).then(function (r) {
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
      if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t)); });
      return r.json();
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────
  function doLogin(staffId, password, persistent) {
    return fetch(cfg.supabaseUrl + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'apikey': cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: staffIdToEmail(staffId), password: password })
    }).catch(asOffline).then(function (r) {
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

  // Nothing back from get_my_profile means two quite different people: a
  // website login that was never meant to open this app, and a crew member
  // whose attendance login has been taken off their record. One sentence
  // for both told neither of them what to do next.
  function explainEmptyProfile() {
    var fallback = 'This login does not open the attendance app. Sign in with your '
                 + 'staff ID — it starts with ss.';
    return rpc('my_login_kind').then(function (kind) {
      if (kind === 'website') {
        throw new Error('That password is right, but this login is for the website. '
          + 'The attendance app needs your own staff ID — it starts with ss — and '
          + 'the password that came with it. Ask the office if you have not been '
          + 'given one yet.');
      }
      if (kind === 'crew') {
        throw new Error('Your crew record is there, but the app could not read it. '
          + 'Tell the office — this one is not your doing.');
      }
      throw new Error('This login is not linked to a crew record. Ask the office to '
        + 'set up your attendance login.');
    }, function () {
      // Older database, or the function is not reachable. Say the useful
      // half rather than nothing.
      throw new Error(fallback);
    });
  }

  function loadProfile() {
    return rpc('get_my_profile').then(function (rows) {
      if (!rows || !rows.length) {
        return explainEmptyProfile();
      }
      profile = rows[0];
      hide($('loginScreen'));
      // The location notice is about being geolocated at a session. Someone
      // with no sessions is never asked for their location, so putting it to
      // them would be theatre.
      if (!isOffice() && !profile.consented_at) { show($('consentScreen')); return; }
      enterApp();
    });
  }

  // How long a worker has to correct a reason, set by the admin.
  var reasonWindowMin = 2;
  var checkoutGraceMin = 30;
  // What the server counts as finishing early. Taken from the same setting it
  // uses, so the warning and the record can never disagree.
  var graceMin = 5;
  function loadSettings() {
    return api('/rest/v1/attendance_settings?select=grace_min,reason_edit_window_min,no_checkout_alert_min,timezone')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (rows && rows[0]) {
          if (rows[0].grace_min != null) graceMin = rows[0].grace_min;
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
    $('whoId').textContent = profile.staff_id || (isOffice() ? 'Office' : '');
    $('menuPassword').classList.toggle('hidden', !profile.must_change_password);
    // The tab goes, not just its contents: a button that refuses to open is
    // worse than one that was never there.
    $('apprTab').classList.toggle('hidden', !canApprove());

    if (isOffice()) {
      // One side only, so a switch between sides would switch to nothing.
      // Both it and the way back are taken away rather than left to confuse.
      $('hrToggle').classList.add('hidden');
      $('meTab').classList.add('hidden');
      refreshBadges();
      setMode(true);
      return;
    }

    $('hrToggle').classList.toggle('hidden', !canRoster());
    $('hrToggle').textContent = canApprove() ? 'HR' : 'Roster';
    $('meTab').classList.remove('hidden');
    if (canRoster()) refreshBadges();
    loadSettings().then(loadToday);
  }

  // ── Today ──────────────────────────────────────────────────────────────
  var todayShifts = [];

  function loadToday() {
    var date = todayKL();
    $('todayDate').textContent = prettyDate(date);
    $('todayList').innerHTML = '<p class="empty">Loading…</p>';

    var scope = mine();
    if (!scope) { $('todayList').innerHTML = '<p class="empty">No sessions scheduled today.</p>'; return; }
    var q = '/rest/v1/shifts?select=id,shift_date,start_time,end_time,status,late_min,early_min,'
          + 'locations(name),shift_categories(name)'
          + '&shift_date=eq.' + date + scope + '&order=start_time.asc';

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
        return needsReason(a) && todayIds.indexOf(a.shift_id) === -1;
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
  // Every worker-side read is narrowed to the signed-in crew member by
  // hand. RLS is a floor, not a view: shifts carries both a worker policy
  // and an admin-reads-everything policy, and policies are OR'd — so the
  // moment the person holding the phone is also an administrator, "give me
  // today's shifts" means everybody's. That is how a manager opened Today
  // and found another instructor's sessions on it.
  function mine() {
    return profile && profile.crew_id
      ? '&crew_id=eq.' + encodeURIComponent(profile.crew_id)
      : null;
  }

  function loadMyAlerts() {
    var scope = mine();
    if (!scope) return Promise.resolve([]);
    return api('/rest/v1/alerts?select=id,shift_id,type,status,worker_reason,worker_reason_code,worker_reason_at&status=eq.open' + scope)
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }

  function loadPunches(ids) {
    if (!ids.length) return Promise.resolve([]);
    var scope = mine();
    if (!scope) return Promise.resolve([]);
    var q = '/rest/v1/punches?select=shift_id,type,punched_at,accepted,distance_m,inside_fence,lat,lng'
          + '&accepted=is.true' + scope + '&shift_id=in.(' + ids.join(',') + ')';
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
        var id = b.getAttribute('data-punch'), type = b.getAttribute('data-type');
        var sh = shiftById(id);
        var left = sh ? Math.round(-minutesPastEnd(sh)) : 0;
        // A session that is still running should not end on one tap. Checking
        // out on time goes straight through — the friction belongs only where
        // the mistake costs something.
        if (type === 'out' && left > graceMin) { confirmEarlyOut(b, id, left); return; }
        punch(id, type, b);
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
  // No geofence entry: a check-in from the wrong place is refused outright,
  // and the worker is told so at the moment they tap. Asking them afterwards
  // to explain a thing that never happened invites an excuse for an event
  // with no record — the refusal itself is the record, and it is the admin's
  // to look at.
  var REASON_SETS = {
    late:        ['transport','family','sick','venue','other'],
    early_leave: ['sick','family','venue','other'],
    absent:      ['sick','family','transport','other'],
    no_checkin:  ['forgot','transport','sick','family','other'],
    no_checkout: ['forgot','venue','other']
  };

  var ALERT_ASK = {
    late:        'You were marked late.',
    early_leave: 'You left before the session ended.',
    absent:      'You were marked absent.',
    no_checkin:  'No check-in was recorded.',
    no_checkout: 'No check-out was recorded.'
  };
  // The one place that decides whether a session is still waiting on the
  // worker. The banner and the box used to answer this separately and
  // disagreed. Answering with a single tap sets worker_reason_code and
  // leaves worker_reason null, so History showed the box answered and
  // locked while the banner went on asking for a reason that could no
  // longer be given. A kind of alert the worker is never shown — a
  // refused check-in — counted towards it too, and nothing in the app
  // could ever clear it.
  function needsReason(a) {
    return !!ALERT_ASK[a.type] && !a.worker_reason && !a.worker_reason_code;
  }
  function alertsFor(shiftId) {
    return myAlerts.filter(function (a) {
      return a.shift_id === shiftId && ALERT_ASK[a.type];
    });
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

      if (needsReason(a)) {
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
      // Green while it can still be changed, grey once it cannot. An expired
      // box used to keep the colour of something still in play, which read as
      // "we are waiting on you" when nothing more was possible.
      return '<div class="explain ' + (left > 0 ? 'done' : 'locked') + '" data-alert="' + esc(a.id) + '">'
        + '<div class="ask">' + ask + '</div>'
        + '<div class="said">You said: <i>' + esc(said) + '</i></div>'
        + (left > 0
            ? '<button class="btn small-btn edit" data-edit="' + esc(a.id) + '">Change</button>'
              + '<div class="hint">Locked in <b data-countdown="' + esc(a.id) + '">'
              + mmss(left) + '</b></div>'
            : '<div class="hint">🔒 Locked in. With your admin now.</div>')
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
    // Without this the countdown in a reopened box stood still and the Save
    // button stayed live past the window — the server refused it, which is
    // the right answer given far too late.
    startCountdowns();
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

  // ── Leave ──────────────────────────────────────────────────────────────
  var leaveBalances = [], leaveRequests = [], leaveFormOpen = false;

  var LV_STATUS = { pending:'Pending', approved:'Approved',
                    rejected:'Not approved', cancelled:'Withdrawn' };

  function fmtLeaveDate(d) {
    if (!d) return '';
    try {
      return new Intl.DateTimeFormat('en-GB',
        { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
        .format(new Date(d + 'T00:00:00+08:00'));
    } catch (e) { return d; }
  }
  function leaveRange(r) {
    return r.start_date === r.end_date
      ? fmtLeaveDate(r.start_date)
      : fmtLeaveDate(r.start_date) + ' – ' + fmtLeaveDate(r.end_date);
  }
  function daysBetween(a, b) {
    if (!a || !b) return 0;
    var d1 = new Date(a + 'T00:00:00+08:00'), d2 = new Date(b + 'T00:00:00+08:00');
    return Math.round((d2 - d1) / 86400000) + 1;
  }
  function todayISO() { return todayKL(); }

  function loadLeave() {
    $('leaveBalances').innerHTML = '<p class="empty">Loading…</p>';
    return Promise.all([
      rpc('get_my_leave_balances').catch(function () { return []; }),
      api('/rest/v1/leave_requests?select=id,leave_type_id,start_date,end_date,days,reason,'
        + 'status,document_path,applied_at,decision_note' + (mine() || '&id=is.null')
        + '&order=applied_at.desc')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
    ]).then(function (res) {
      leaveBalances = res[0] || [];
      leaveRequests = res[1] || [];
      renderLeave();
    });
  }

  function renderLeave() {
    var box = $('leaveBalances');
    if (!leaveBalances.length) {
      box.innerHTML = '<div class="note info">Your leave allowance has not been set up yet. '
        + 'Your admin enters it, and it will appear here.</div>';
    } else {
      box.innerHTML = leaveBalances.map(function (b) {
        var left = Number(b.days_available);
        // Unpaid leave has no ceiling, so "0 left" would read as "you may not
        // apply" — the opposite of the truth.
        var uncapped = b.cap_days == null && Number(b.days_given) === 0;
        var cls = uncapped ? ' free' : left < 0 ? ' over' : left === 0 ? ' none' : '';
        var bits = uncapped
          ? [Number(b.days_used).toFixed(0) + ' taken', 'no limit']
          : [Number(b.days_given).toFixed(0) + ' given',
             Number(b.days_used).toFixed(0) + ' taken'];
        if (b.is_paid === false && !uncapped) bits.push('unpaid');
        // Days carried in when they were ported across. Without this a
        // worker sees days taken with no applications behind them and has
        // no way to tell whether it is right.
        var before = Number(b.days_before || 0);
        if (before > 0) bits.push(before.toFixed(0) + ' before this app');
        return '<div class="lv-bal">'
          + '<div class="name">' + esc(b.label) + '</div>'
          + '<div class="left' + cls + '">'
          +   (uncapped ? 'No limit' : left.toFixed(left % 1 ? 1 : 0) + '<small>left</small>')
          + '</div>'
          + '<p class="sub">' + esc(bits.join(' · ')) + '</p>'
          + '</div>';
      }).join('');
    }

    var list = $('leaveList');
    if (!leaveRequests.length) {
      list.innerHTML = '<p class="empty">You have not applied for any leave.</p>';
      return;
    }
    var typeLabel = {};
    leaveBalances.forEach(function (b) { typeLabel[b.leave_type_id] = b.label; });
    list.innerHTML = leaveRequests.map(function (r) {
      // Theirs to withdraw while it is still ahead of them.
      var canCancel = (r.status === 'pending')
        || (r.status === 'approved' && r.start_date > todayISO());
      return '<div class="lv-req st-' + esc(r.status) + '">'
        + '<div class="top"><div class="kind">' + esc(typeLabel[r.leave_type_id] || 'Leave') + '</div>'
        +   '<span class="lv-pill">' + esc(LV_STATUS[r.status] || r.status) + '</span></div>'
        + '<div class="when">' + esc(leaveRange(r)) + ' · '
        +   esc(Number(r.days).toFixed(Number(r.days) % 1 ? 1 : 0))
        +   ' day' + (Number(r.days) === 1 ? '' : 's') + '</div>'
        + (r.reason ? '<div class="why">' + esc(r.reason) + '</div>' : '')
        + (r.document_path ? '<div class="why">📎 Document attached</div>' : '')
        + (r.decision_note ? '<div class="note info">Your admin said: ' + esc(r.decision_note) + '</div>' : '')
        + (canCancel
            ? '<button class="btn small-btn" data-cancel="' + esc(r.id) + '"'
              + ' style="background:var(--slate-tx)">Withdraw</button>'
            : '')
        + '</div>';
    }).join('');

    Array.prototype.forEach.call(list.querySelectorAll('[data-cancel]'), function (b) {
      b.addEventListener('click', function () {
        b.disabled = true; b.textContent = 'Withdrawing…';
        rpc('cancel_my_leave', { p_request_id: b.getAttribute('data-cancel') })
          .then(loadLeave)
          .catch(function (e) {
            b.disabled = false; b.textContent = 'Withdraw';
            leaveNote(e.message, true);
          });
      });
    });
  }

  function leaveNote(msg, bad) {
    $('leaveMsg').innerHTML = msg
      ? '<div class="note ' + (bad ? 'err' : 'ok') + '">' + esc(msg) + '</div>' : '';
  }

  // A photo of an MC off a phone is several megabytes of detail nobody needs.
  // Long edge 1600px and JPEG quality 0.82 keeps a certificate readable at a
  // fraction of the size — which matters on a pool deck with one bar of signal.
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) return resolve(file);   // a PDF goes as-is
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 1600, w = img.width, h = img.height;
        if (w > max || h > max) {
          if (w >= h) { h = Math.round(h * max / w); w = max; }
          else        { w = Math.round(w * max / h); h = max; }
        }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(function (blob) {
          resolve(blob ? new File([blob], 'doc.jpg', { type: 'image/jpeg' }) : file);
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
      img.src = url;
    });
  }

  // Into the worker's own folder. The bucket is private and the policy keys on
  // the folder name, so a path outside their own crew id is refused server-side.
  function uploadLeaveDoc(file) {
    return shrinkImage(file).then(function (small) {
      var ext = small.type === 'application/pdf' ? 'pdf' : 'jpg';
      var path = profile.crew_id + '/' + Date.now() + '.' + ext;
      return fetch(cfg.supabaseUrl + '/storage/v1/object/leave-docs/' + path, {
        method: 'POST',
        headers: {
          'apikey': cfg.supabaseAnonKey,
          'Authorization': 'Bearer ' + (session && session.access_token),
          'Content-Type': small.type || 'image/jpeg'
        },
        body: small
      }).catch(asOffline).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t, 'Could not upload that.')); });
        return path;
      });
    });
  }

  function openLeaveForm() {
    if (leaveFormOpen) return;
    leaveFormOpen = true;
    leaveNote('');
    $('leaveApplyBtn').classList.add('hidden');

    var opts = leaveBalances.map(function (b) {
      var free = b.cap_days == null && Number(b.days_given) === 0;
      return '<option value="' + esc(b.code) + '" data-doc="' + (b.requires_document ? '1' : '')
        + '" data-free="' + (free ? '1' : '')
        + '" data-left="' + esc(b.days_available) + '">' + esc(b.label) + '</option>';
    }).join('');

    var form = document.createElement('div');
    form.className = 'lv-form';
    form.id = 'leaveForm';
    form.innerHTML =
        '<label for="lvType">Kind of leave</label>'
      + '<select id="lvType">' + opts + '</select>'
      + '<div class="row"><div><label for="lvFrom">First day</label>'
      +   '<input type="date" id="lvFrom" value="' + todayISO() + '" /></div>'
      +   '<div><label for="lvTo">Last day</label>'
      +   '<input type="date" id="lvTo" value="' + todayISO() + '" /></div></div>'
      + '<label for="lvWhy">Reason (optional)</label>'
      + '<textarea id="lvWhy" rows="2" placeholder="Anything your admin should know"></textarea>'
      + '<div id="lvDoc"></div>'
      + '<div id="lvWarn"></div>'
      + '<button class="btn" id="lvSend" style="margin-top:12px">Send application</button>'
      + '<button class="btn ghost" id="lvClose" style="margin-top:8px">Cancel</button>';
    $('leaveApplyBtn').parentNode.insertBefore(form, $('leaveMsg'));

    var docFile = null;
    function refresh() {
      var sel = $('lvType'), opt = sel.options[sel.selectedIndex];
      var needsDoc = opt && opt.getAttribute('data-doc') === '1';
      var left = opt ? Number(opt.getAttribute('data-left')) : 0;
      var days = daysBetween($('lvFrom').value, $('lvTo').value);

      $('lvDoc').innerHTML = needsDoc
        ? '<div class="lv-doc"><b>A photo is required for this.</b> '
          + 'Your MC or the certificate — a clear photo is enough.'
          + '<input type="file" id="lvFile" accept="image/*,application/pdf" capture="environment" />'
          + '<div id="lvThumb"></div></div>'
        : '';
      if (needsDoc) {
        $('lvFile').addEventListener('change', function (e) {
          docFile = e.target.files[0] || null;
          $('lvThumb').innerHTML = docFile && /^image\//.test(docFile.type)
            ? '<img class="thumb" src="' + URL.createObjectURL(docFile) + '" alt="" />' : '';
        });
      } else { docFile = null; }

      // Over the allowance is allowed through — a hospital stay does not stop
      // because the allowance did. It says so rather than refusing.
      var noCeiling = opt && opt.getAttribute('data-free') === '1';
      $('lvWarn').innerHTML = (days > 0 && !noCeiling && left != null && days > left)
        ? '<div class="lv-warn">That is ' + days + ' day' + (days === 1 ? '' : 's')
          + ', and you have ' + left.toFixed(left % 1 ? 1 : 0)
          + ' left. You can still apply — your admin decides.</div>'
        : (days > 0
            ? '<div class="note info" style="margin:10px 0 0">' + days + ' day'
              + (days === 1 ? '' : 's') + '.</div>'
            : '<div class="note err" style="margin:10px 0 0">The last day is before the first.</div>');
    }
    $('lvType').addEventListener('change', refresh);
    $('lvFrom').addEventListener('change', function () {
      if ($('lvTo').value < $('lvFrom').value) $('lvTo').value = $('lvFrom').value;
      refresh();
    });
    $('lvTo').addEventListener('change', refresh);
    refresh();

    $('lvClose').addEventListener('click', closeLeaveForm);
    $('lvSend').addEventListener('click', function () {
      var btn = $('lvSend');
      var sel = $('lvType'), opt = sel.options[sel.selectedIndex];
      var needsDoc = opt && opt.getAttribute('data-doc') === '1';
      var from = $('lvFrom').value, to = $('lvTo').value;
      if (!from || !to || daysBetween(from, to) < 1) { leaveNote('Check the dates.', true); return; }
      if (needsDoc && !docFile) { leaveNote('A photo of your document is needed for this.', true); return; }

      btn.disabled = true; btn.textContent = 'Sending…';
      leaveNote('');
      (needsDoc ? uploadLeaveDoc(docFile) : Promise.resolve(null))
        .then(function (path) {
          return rpc('apply_for_leave', {
            p_type_code: sel.value, p_start: from, p_end: to,
            p_reason: ($('lvWhy').value || '').trim() || null,
            p_document_path: path
          });
        })
        .then(function () {
          closeLeaveForm();
          leaveNote('Sent. Your admin will decide and you will see it here.');
          return loadLeave();
        })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = 'Send application';
          leaveNote(e.message, true);
        });
    });
  }

  function closeLeaveForm() {
    var f = $('leaveForm');
    if (f) f.remove();
    leaveFormOpen = false;
    $('leaveApplyBtn').classList.remove('hidden');
  }

  // ── HR on the phone ────────────────────────────────────────────────────
  // A switch rather than a seventh tab: four things fit a phone's bottom bar
  // legibly, and this app needs four on each side.
  var hrMode = false, hrCrew = [], hrLocations = [], hrCats = [];
  var rsWeekStart = null, rsDay = null, rsShifts = [], rsPunches = [];
  var hrAlerts = [], hrAlertSeg = 'open', apprSeg = 'pending', apprList = [];

  // Calendar arithmetic, not instant arithmetic. The rest of the app is careful
  // to work in the pool's timezone, and getDay()/setDate() quietly use the
  // device's — so a phone set to anything but Malaysia would draw the week
  // from the wrong Monday. Anchoring at noon UTC puts the date far enough from
  // either midnight that no offset can tip it into the day before.
  function mondayOf(iso) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  function addDaysISO(iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dowShort(iso) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' })
      .format(new Date(iso + 'T00:00:00+08:00'));
  }
  function dayNum(iso) { return String(Number(iso.slice(8, 10))); }

  // Two separate authorities, deliberately not bundled. A coordinator covering
  // a sick instructor needs the roster and the alerts; they have no business
  // in anybody's medical certificate. is_admin gets the first, is_hr the lot.
  function canRoster() { return !!(profile && (profile.is_hr || profile.is_admin)); }
  function canApprove() { return !!(profile && profile.is_hr); }
  // Somebody from the office: a scheduler account signing in here with the
  // same password they use on the desktop. No crew row, so no sessions of
  // their own — nothing to consent to, nothing to punch, and no "Me" side to
  // switch back to.
  function isOffice() { return !!profile && !profile.crew_id; }

  function setMode(on) {
    hrMode = !!on;
    $('mainNav').classList.toggle('hidden', hrMode);
    $('hrNav').classList.toggle('hidden', !hrMode);
    $('hrToggle').classList.toggle('on', hrMode);
    $('hrToggle').textContent = hrMode ? 'Me' : (canApprove() ? 'HR' : 'Roster');
    showView(hrMode ? 'Roster' : 'Today');
  }

  var ALL_VIEWS = ['Today','Week','History','Leave','Summary','Roster','Alerts','Approvals'];
  function showView(v) {
    ALL_VIEWS.forEach(function (name) {
      var el = $('view' + name);
      if (el) el.classList.toggle('hidden', name !== v);
    });
    var nav = hrMode ? $('hrNav') : $('mainNav');
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === v);
    });
    if (v === 'Week')      loadWeek();
    if (v === 'History')   loadHistory();
    if (v === 'Leave')     { closeLeaveForm(); loadLeave(); }
    if (v === 'Summary')   loadSummary();
    if (v === 'Roster')    loadRoster();
    if (v === 'Alerts')    loadHrAlerts();
    if (v === 'Approvals') { if (!canApprove()) { showView('Roster'); return; } loadApprovals(); }
  }

  // Loaded once when HR mode is first opened: the pickers barely change.
  function loadHrRefs() {
    if (hrCrew.length) return Promise.resolve();
    return Promise.all([
      rpc('get_rosterable_crew').catch(function () { return []; }),
      api('/rest/v1/locations?select=id,name,is_active&order=name.asc')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      api('/rest/v1/shift_categories?select=id,name,sort_order&order=sort_order.asc')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
    ]).then(function (res) {
      hrCrew = res[0] || [];
      hrLocations = (res[1] || []).filter(function (l) { return l.is_active !== false; });
      hrCats = res[2] || [];
    });
  }

  // ── Roster ─────────────────────────────────────────────────────────────
  function loadRoster() {
    if (!rsWeekStart) { rsWeekStart = mondayOf(todayKL()); rsDay = todayKL(); }
    if (rsDay < rsWeekStart || rsDay > addDaysISO(rsWeekStart, 6)) rsDay = rsWeekStart;
    $('rosterList').innerHTML = '<p class="empty">Loading…</p>';
    return loadHrRefs().then(function () {
      var from = rsWeekStart, to = addDaysISO(rsWeekStart, 6);
      return api('/rest/v1/shifts?select=id,crew_id,shift_date,start_time,end_time,'
        + 'location_id,category_id,status,is_void'
        + '&is_void=eq.false&shift_date=gte.' + from + '&shift_date=lte.' + to
        + '&order=shift_date.asc,start_time.asc')
        .then(function (r) { return r.ok ? r.json() : []; });
    }).then(function (rows) {
      rsShifts = rows || [];
      renderRoster();
    }).catch(function (e) {
      $('rosterList').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  function renderRoster() {
    var end = addDaysISO(rsWeekStart, 6);
    $('wkLabel').textContent =
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' })
        .format(new Date(rsWeekStart + 'T00:00:00+08:00'))
      + ' – ' +
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
        .format(new Date(end + 'T00:00:00+08:00'));

    var today = todayKL();
    var byDay = {};
    rsShifts.forEach(function (s) { (byDay[s.shift_date] = byDay[s.shift_date] || []).push(s); });

    var strip = '';
    for (var i = 0; i < 7; i++) {
      var d = addDaysISO(rsWeekStart, i);
      var n = (byDay[d] || []).length;
      strip += '<button class="day-chip' + (d === rsDay ? ' on' : '')
        + (d === today ? ' today' : '') + (d < today ? ' past' : '') + '" data-day="' + d + '">'
        + '<span class="dow">' + esc(dowShort(d)) + '</span>'
        + '<span class="dnum">' + esc(dayNum(d)) + '</span>'
        + '<span class="cnt' + (n ? '' : ' none') + '"></span></button>';
    }
    $('dayStrip').innerHTML = strip;
    Array.prototype.forEach.call($('dayStrip').querySelectorAll('[data-day]'), function (b) {
      b.addEventListener('click', function () { rsDay = b.getAttribute('data-day'); renderRoster(); });
    });
    // Seven chips do not fit a phone's width, so the day being looked at has
    // to be brought to where it can be seen — otherwise today sits half off
    // the right edge, which is exactly where it must not be.
    var sel = $('dayStrip').querySelector('.day-chip.on');
    if (sel && sel.scrollIntoView) {
      try { sel.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {}
    }

    $('rsDayLabel').textContent = prettyDate(rsDay);

    var crewName = {}; hrCrew.forEach(function (c) { crewName[c.id] = c.full_name; });
    var locName  = {}; hrLocations.forEach(function (l) { locName[l.id] = l.name; });
    var catName  = {}; hrCats.forEach(function (c) { catName[c.id] = c.name; });

    // Sorted here rather than trusted from the query: the order a day reads in
    // is the whole point of the screen.
    var list = (byDay[rsDay] || []).slice().sort(function (a, b) {
      return String(a.start_time).localeCompare(String(b.start_time));
    });
    $('rosterList').innerHTML = list.length
      ? list.map(function (s) {
          return '<div class="rs-card s-' + esc(s.status) + '" data-shift="' + esc(s.id) + '">'
            + '<div class="t1"><span class="time">' + esc(prettyTime(s.start_time))
            +   ' – ' + esc(prettyTime(s.end_time)) + '</span>'
            +   '<span class="pill p-' + esc(s.status) + '">' + esc(statusLabel(s.status)) + '</span></div>'
            + '<div class="who">' + esc(crewName[s.crew_id] || 'Unassigned') + '</div>'
            + '<div class="meta">' + esc(locName[s.location_id] || '—')
            +   (catName[s.category_id] ? ' · ' + esc(catName[s.category_id]) : '') + '</div>'
            + '</div>';
        }).join('')
      : '<p class="empty">Nothing rostered.</p>';

    Array.prototype.forEach.call($('rosterList').querySelectorAll('[data-shift]'), function (c) {
      c.addEventListener('click', function () {
        var sh = rsShifts.filter(function (x) { return x.id === c.getAttribute('data-shift'); })[0];
        if (sh) openShiftSheet(sh);
      });
    });

    // A day already gone takes no new sessions, the same rule the desktop
    // roster follows.
    $('rsAdd').disabled = rsDay < today;
    $('rsAdd').textContent = rsDay < today ? 'That day has passed' : '+ Add session';
    $('rsCopy').disabled = addDaysISO(rsWeekStart, 6) < today;
  }

  function rosterNote(msg, bad) {
    $('rosterMsg').innerHTML = msg
      ? '<div class="note ' + (bad ? 'err' : 'ok') + '">' + esc(msg) + '</div>' : '';
  }

  // ── The sheet ──────────────────────────────────────────────────────────
  function closeSheet() {
    var b = document.querySelector('.sheet-back'), s = document.querySelector('.sheet');
    if (b) b.remove();
    if (s) s.remove();
  }

  function openShiftSheet(shift) {
    closeSheet();
    var isNew = !shift;
    var back = document.createElement('div');
    back.className = 'sheet-back';
    back.addEventListener('click', closeSheet);

    var opt = function (rows, sel, labelKey) {
      return rows.map(function (r) {
        return '<option value="' + esc(r.id) + '"' + (r.id === sel ? ' selected' : '') + '>'
          + esc(r[labelKey]) + '</option>';
      }).join('');
    };

    var sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML =
        '<div class="grab"></div>'
      + '<h3>' + (isNew ? 'New session' : 'Edit session') + '</h3>'
      + '<p class="sub" style="margin:0">' + esc(prettyDate(isNew ? rsDay : shift.shift_date)) + '</p>'
      + '<label for="shWho">Worker</label>'
      + '<select id="shWho"><option value="">Choose…</option>'
      +   opt(hrCrew, isNew ? '' : shift.crew_id, 'full_name') + '</select>'
      + '<label for="shLoc">Pool</label>'
      + '<select id="shLoc">' + opt(hrLocations, isNew ? (hrLocations[0] || {}).id : shift.location_id, 'name') + '</select>'
      + '<label for="shCat">Category</label>'
      + '<select id="shCat">' + opt(hrCats, isNew ? (hrCats[0] || {}).id : shift.category_id, 'name') + '</select>'
      + '<div class="row"><div><label for="shFrom">Start</label>'
      +   '<input type="time" id="shFrom" value="' + (isNew ? '09:00' : String(shift.start_time).slice(0, 5)) + '" /></div>'
      +   '<div><label for="shTo">End</label>'
      +   '<input type="time" id="shTo" value="' + (isNew ? '11:00' : String(shift.end_time).slice(0, 5)) + '" /></div></div>'
      + (isNew
          ? '<label for="shRepeat">Repeat weekly</label>'
            + '<select id="shRepeat"><option value="1">Just this once</option>'
            + '<option value="2">2 weeks</option><option value="4">4 weeks</option>'
            + '<option value="8">8 weeks</option><option value="12">12 weeks</option></select>'
          : '')
      + '<div id="shErr"></div>'
      + '<button class="btn" id="shSave" style="margin-top:14px">'
      +   (isNew ? 'Add session' : 'Save changes') + '</button>'
      + (isNew ? '' : '<button class="btn ghost" id="shVoid" style="margin-top:8px;color:var(--red-tx)">Remove this session</button>')
      + '<button class="btn ghost" id="shCancel" style="margin-top:8px">Cancel</button>';

    document.body.appendChild(back);
    document.body.appendChild(sheet);

    function err(m) {
      $('shErr').innerHTML = m ? '<div class="note err" style="margin:12px 0 0">' + esc(m) + '</div>' : '';
    }

    $('shCancel').addEventListener('click', closeSheet);
    $('shSave').addEventListener('click', function () {
      var who = $('shWho').value, from = $('shFrom').value, to = $('shTo').value;
      if (!who) { err('Choose who is working.'); return; }
      if (!from || !to || to <= from) { err('The end time must be after the start.'); return; }

      var btn = $('shSave');
      btn.disabled = true; btn.textContent = 'Saving…';
      err('');

      var base = {
        crew_id: who, location_id: $('shLoc').value, category_id: $('shCat').value,
        start_time: from + ':00', end_time: to + ':00'
      };
      var work;
      if (isNew) {
        var weeks = Number(($('shRepeat') || {}).value || 1);
        var rows = [];
        for (var i = 0; i < weeks; i++) {
          rows.push(Object.keys(base).reduce(function (o, k) { o[k] = base[k]; return o; },
            { shift_date: addDaysISO(rsDay, i * 7) }));
        }
        work = api('/rest/v1/shifts', {
          method: 'POST',
          body: JSON.stringify(rows)
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t)); });
          return rows.length;
        });
      } else {
        work = api('/rest/v1/shifts?id=eq.' + encodeURIComponent(shift.id), {
          method: 'PATCH',
          body: JSON.stringify(base)
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t)); });
          return 0;
        });
      }

      work.then(function (n) {
        closeSheet();
        rosterNote(isNew
          ? (n > 1 ? n + ' sessions added.' : 'Session added.')
          : 'Session updated.');
        return loadRoster();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = isNew ? 'Add session' : 'Save changes';
        err(e.message);
      });
    });

    if (!isNew) {
      $('shVoid').addEventListener('click', function () {
        var b = $('shVoid');
        if (b.getAttribute('data-sure') !== '1') {
          b.setAttribute('data-sure', '1');
          b.textContent = 'Tap again to remove';
          return;
        }
        b.disabled = true; b.textContent = 'Removing…';
        // Voided, never deleted: the session is evidence of what was planned.
        api('/rest/v1/shifts?id=eq.' + encodeURIComponent(shift.id), {
          method: 'PATCH', body: JSON.stringify({ is_void: true })
        }).then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t)); });
          closeSheet();
          rosterNote('Session removed.');
          return loadRoster();
        }).catch(function (e) {
          b.disabled = false; b.textContent = 'Remove this session';
          err(e.message);
        });
      });
    }
  }

  function copyLastWeek() {
    var btn = $('rsCopy');
    if (btn.getAttribute('data-sure') !== '1') {
      btn.setAttribute('data-sure', '1');
      btn.textContent = 'Tap again to copy last week';
      return;
    }
    btn.disabled = true; btn.textContent = 'Copying…';
    var prev = addDaysISO(rsWeekStart, -7);
    api('/rest/v1/shifts?select=crew_id,shift_date,start_time,end_time,location_id,category_id'
      + '&is_void=eq.false&shift_date=gte.' + prev + '&shift_date=lte.' + addDaysISO(prev, 6))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        var today = todayKL();
        // Already-taken slots and days that have gone are skipped rather than
        // refused, so one tap does as much as it legitimately can.
        var taken = {};
        rsShifts.forEach(function (s) {
          taken[s.crew_id + '|' + s.shift_date + '|' + s.start_time] = true;
        });
        var out = rows.map(function (s) {
          return { crew_id: s.crew_id, shift_date: addDaysISO(s.shift_date, 7),
                   start_time: s.start_time, end_time: s.end_time,
                   location_id: s.location_id, category_id: s.category_id };
        }).filter(function (s) {
          return s.shift_date >= today
            && !taken[s.crew_id + '|' + s.shift_date + '|' + s.start_time];
        });
        if (!out.length) { throw new Error('Nothing to copy that is not already here.'); }
        return api('/rest/v1/shifts', { method: 'POST', body: JSON.stringify(out) })
          .then(function (r) {
            if (!r.ok) return r.text().then(function (t) { throw new Error(readableError(t)); });
            return out.length;
          });
      })
      .then(function (n) {
        btn.removeAttribute('data-sure');
        rosterNote(n + ' session' + (n === 1 ? '' : 's') + ' copied from last week.');
        return loadRoster();
      })
      .catch(function (e) {
        btn.removeAttribute('data-sure');
        rosterNote(e.message, true);
      })
      .then(function () { btn.disabled = false; btn.textContent = '⧉ Copy last week'; });
  }

  // ── Alerts ─────────────────────────────────────────────────────────────
  function loadHrAlerts() {
    $('hrAlertList').innerHTML = '<p class="empty">Loading…</p>';
    return loadHrRefs().then(function () {
      return api('/rest/v1/alerts?select=id,shift_id,crew_id,type,status,raised_at,'
        + 'worker_reason,worker_reason_code,resolution_action'
        + '&status=eq.' + hrAlertSeg + '&order=raised_at.desc&limit=100')
        .then(function (r) { return r.ok ? r.json() : []; });
    }).then(function (rows) {
      hrAlerts = rows || [];
      renderHrAlerts();
      refreshBadges();
    }).catch(function (e) {
      $('hrAlertList').innerHTML = '<div class="note err">' + esc(e.message) + '</div>';
    });
  }

  var ALERT_NAME = {
    late: 'Late', early_leave: 'Left early', absent: 'Absent',
    no_checkin: 'No check-in', no_checkout: 'No check-out', geofence: 'Wrong place'
  };

  function renderHrAlerts() {
    var crewName = {}; hrCrew.forEach(function (c) { crewName[c.id] = c.full_name; });
    $('hrAlertList').innerHTML = hrAlerts.length
      ? hrAlerts.map(function (a) {
          var said = [REASONS[a.worker_reason_code], a.worker_reason].filter(Boolean).join(' — ');
          return '<div class="al-card s-' + esc(a.type === 'late' ? 'late' : a.type === 'absent' ? 'absent' : 'incomplete') + '">'
            + '<div class="t1"><span class="who">' + esc(crewName[a.crew_id] || 'Someone') + '</span>'
            +   '<span class="pill p-' + esc(a.type === 'late' ? 'late' : 'incomplete') + '">'
            +   esc(ALERT_NAME[a.type] || a.type) + '</span></div>'
            + '<div class="meta">' + esc(fmtWhen(a.raised_at)) + '</div>'
            + (said ? '<div class="said">“' + esc(said) + '”</div>'
                    : (a.status === 'open' ? '<div class="meta">No reason given yet.</div>' : ''))
            + (a.resolution_action ? '<div class="meta">Closed: ' + esc(a.resolution_action.replace(/_/g, ' ')) + '</div>' : '')
            + '</div>';
        }).join('')
      : '<p class="empty">' + (hrAlertSeg === 'open' ? 'Nothing open.' : 'Nothing settled yet.') + '</p>';
  }

  function fmtWhen(iso) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short',
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
        .format(new Date(iso));
    } catch (e) { return iso; }
  }

  // ── Leave approvals ────────────────────────────────────────────────────
  function loadApprovals() {
    $('apprList').innerHTML = '<p class="empty">Loading…</p>';
    return Promise.all([
      loadHrRefs(),
      api('/rest/v1/leave_types?select=id,label,is_paid&order=sort_order.asc')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
      api('/rest/v1/leave_requests?select=id,crew_id,leave_type_id,start_date,end_date,days,'
        + 'reason,status,document_path,applied_at,decision_note&order=applied_at.desc&limit=100')
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
    ]).then(function (res) {
      apprList = { types: res[1] || [], rows: res[2] || [] };
      renderApprovals();
      refreshBadges();
    });
  }

  function renderApprovals() {
    var crewName = {}; hrCrew.forEach(function (c) { crewName[c.id] = c.full_name; });
    var typeLabel = {}; (apprList.types || []).forEach(function (t) { typeLabel[t.id] = t.label; });
    var rows = (apprList.rows || []).filter(function (r) {
      return apprSeg === 'all' || r.status === 'pending';
    });
    $('apprList').innerHTML = rows.length
      ? rows.map(function (r) {
          return '<div class="lv-req st-' + esc(r.status) + '" data-appr="' + esc(r.id) + '">'
            + '<div class="top"><div class="kind">' + esc(crewName[r.crew_id] || 'Someone') + '</div>'
            +   '<span class="lv-pill">' + esc(LV_STATUS[r.status] || r.status) + '</span></div>'
            + '<div class="when">' + esc(typeLabel[r.leave_type_id] || 'Leave') + ' · '
            +   esc(leaveRange(r)) + ' · ' + esc(Number(r.days).toFixed(Number(r.days) % 1 ? 1 : 0))
            +   ' day' + (Number(r.days) === 1 ? '' : 's') + '</div>'
            + (r.reason ? '<div class="why">' + esc(r.reason) + '</div>' : '')
            + (r.document_path ? '<button class="btn small-btn" data-doc="' + esc(r.document_path)
                + '" style="background:var(--slate-tx)">📎 Open document</button>' : '')
            + (r.status === 'pending'
                ? '<div style="display:flex;gap:8px;margin-top:9px">'
                  + '<button class="btn small-btn" data-no="' + esc(r.id) + '"'
                  +   ' style="flex:1;margin-top:0;background:var(--slate-tx)">Reject</button>'
                  + '<button class="btn small-btn" data-yes="' + esc(r.id) + '"'
                  +   ' style="flex:1;margin-top:0;background:var(--green-tx)">Approve</button></div>'
                : (r.decision_note ? '<div class="note info">Note: ' + esc(r.decision_note) + '</div>' : ''))
            + '</div>';
        }).join('')
      : '<p class="empty">' + (apprSeg === 'pending' ? 'Nothing waiting.' : 'No applications yet.') + '</p>';

    function decide(id, status, btn) {
      btn.disabled = true; btn.textContent = '…';
      rpc('decide_leave', { p_request_id: id, p_status: status })
        .then(function () {
          apprNote(status === 'approved' ? 'Approved.' : 'Rejected.');
          return loadApprovals();
        })
        .catch(function (e) {
          btn.disabled = false; btn.textContent = status === 'approved' ? 'Approve' : 'Reject';
          apprNote(e.message, true);
        });
    }
    Array.prototype.forEach.call($('apprList').querySelectorAll('[data-yes]'), function (b) {
      b.addEventListener('click', function () { decide(b.getAttribute('data-yes'), 'approved', b); });
    });
    Array.prototype.forEach.call($('apprList').querySelectorAll('[data-no]'), function (b) {
      b.addEventListener('click', function () { decide(b.getAttribute('data-no'), 'rejected', b); });
    });
    Array.prototype.forEach.call($('apprList').querySelectorAll('[data-doc]'), function (b) {
      b.addEventListener('click', function () { openLeaveDoc(b.getAttribute('data-doc'), b); });
    });
  }

  function apprNote(msg, bad) {
    $('apprMsg').innerHTML = msg
      ? '<div class="note ' + (bad ? 'err' : 'ok') + '">' + esc(msg) + '</div>' : '';
  }

  // A signed link that expires. The bucket is private; these are medical
  // certificates and must not be reachable by guessing a URL.
  function openLeaveDoc(path, btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Opening…';
    fetch(cfg.supabaseUrl + '/storage/v1/object/sign/leave-docs/' + path, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ expiresIn: 300 })
    }).catch(asOffline).then(function (r) {
      if (!r.ok) throw new Error('Could not open that document.');
      return r.json();
    }).then(function (d) {
      window.open(cfg.supabaseUrl + '/storage/v1' + (d.signedURL || d.signedUrl), '_blank', 'noopener');
    }).catch(function (e) {
      apprNote(e.message, true);
    }).then(function () { btn.disabled = false; btn.textContent = label; });
  }

  // Counts on the HR tabs, so neither has to be opened to find out.
  function refreshBadges() {
    Promise.all([
      api('/rest/v1/alerts?select=id&status=eq.open').then(function (r) { return r.ok ? r.json() : []; }),
      canApprove()
        ? api('/rest/v1/leave_requests?select=id&status=eq.pending')
            .then(function (r) { return r.ok ? r.json() : []; })
        : Promise.resolve([])
    ]).then(function (res) {
      var a = (res[0] || []).length, l = (res[1] || []).length;
      $('alertBadge').textContent = a;
      $('alertBadge').classList.toggle('hidden', !a);
      $('apprBadge').textContent = l;
      $('apprBadge').classList.toggle('hidden', !l || !canApprove());
    }).catch(function () {});
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

  function shiftById(id) {
    for (var i = 0; i < todayShifts.length; i++) {
      if (todayShifts[i].id === id) return todayShifts[i];
    }
    return null;
  }

  // Replaces the button in place rather than opening a dialog: a dialog on a
  // phone appears under the thumb that just tapped, which is the one place it
  // must not be.
  function confirmEarlyOut(btn, id, left) {
    var box = document.createElement('div');
    box.className = 'confirm-out';
    box.innerHTML =
        '<div class="confirm-head">' + left + ' minute' + (left === 1 ? '' : 's')
      +   ' still to go</div>'
      + '<div class="confirm-body">Checking out now ends the session early and'
      +   ' tells your admin. Tapped by mistake? Stay checked in.</div>'
      + '<div class="confirm-acts">'
      +   '<button class="btn ghost" data-stay>Stay checked in</button>'
      +   '<button class="btn warn" data-go>Check out anyway</button>'
      + '</div>';
    btn.parentNode.replaceChild(box, btn);

    function restore() {
      if (box.parentNode) box.parentNode.replaceChild(btn, box);
    }
    box.querySelector('[data-stay]').addEventListener('click', restore);
    box.querySelector('[data-go]').addEventListener('click', function () {
      restore();
      punch(id, 'out', btn);
    });
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
  // ── My week ────────────────────────────────────────────────────────────
  // The whole week at once, not a day at a time. "When am I working this
  // week" is one question, and answering it should not cost seven taps —
  // which is the difference between this and the HR roster screen, where
  // you are editing one day and want it on its own.
  var wkStart = null;

  function weekLabel(startISO) {
    var endISO = addDaysISO(startISO, 6);
    var fmt = function (iso, opts) {
      return new Intl.DateTimeFormat('en-GB',
        Object.assign({ timeZone: TZ }, opts)).format(new Date(iso + 'T00:00:00+08:00'));
    };
    var sameMonth = startISO.slice(0, 7) === endISO.slice(0, 7);
    return fmt(startISO, { day: 'numeric', month: sameMonth ? undefined : 'short' })
         + ' – ' + fmt(endISO, { day: 'numeric', month: 'short' })
         + (startISO.slice(0, 4) === todayKL().slice(0, 4) ? '' : ' ' + startISO.slice(0, 4));
  }

  // Hours between two 'HH:MM:SS' times. Sessions do not cross midnight here,
  // and a negative span would mean bad data rather than a night shift.
  function spanHours(start, end) {
    var a = String(start).split(':'), b = String(end).split(':');
    var mins = (b[0] * 60 + (+b[1] || 0)) - (a[0] * 60 + (+a[1] || 0));
    return mins > 0 ? mins / 60 : 0;
  }

  function loadWeek() {
    if (!wkStart) wkStart = mondayOf(todayKL());
    var box = $('weekList');
    var scope = mine();
    if (!scope) { box.innerHTML = '<p class="empty">No sessions on your roster.</p>';
                  $('wkmTotal').textContent = ''; return; }
    var from = wkStart, to = addDaysISO(wkStart, 6);
    $('wkmLabel').textContent = weekLabel(wkStart);
    $('wkmToday').classList.toggle('hidden', wkStart === mondayOf(todayKL()));
    box.innerHTML = '<p class="empty">Loading…</p>';
    $('wkmTotal').textContent = '';

    api('/rest/v1/shifts?select=id,shift_date,start_time,end_time,status,is_void,'
      + 'locations(name),shift_categories(name)'
      + '&shift_date=gte.' + from + '&shift_date=lte.' + to + scope
      + '&order=shift_date.asc,start_time.asc')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        rows = (rows || []).filter(function (s) { return !s.is_void; });
        var today = todayKL();
        var hours = 0;
        rows.forEach(function (s) { hours += spanHours(s.start_time, s.end_time); });

        $('wkmTotal').textContent = rows.length
          ? rows.length + (rows.length === 1 ? ' session · ' : ' sessions · ')
            + hours.toFixed(hours % 1 ? 1 : 0) + (hours === 1 ? ' hour' : ' hours')
          : 'Nothing rostered this week.';

        if (!rows.length) {
          box.innerHTML = '<p class="empty">No sessions this week. '
            + 'If that looks wrong, speak to your manager.</p>';
          return;
        }

        var byDay = {};
        rows.forEach(function (s) { (byDay[s.shift_date] = byDay[s.shift_date] || []).push(s); });

        var out = '';
        for (var i = 0; i < 7; i++) {
          var iso = addDaysISO(wkStart, i);
          var list = byDay[iso] || [];
          var isToday = iso === today;
          var past = iso < today;
          out += '<div class="wkday' + (isToday ? ' is-today' : '') + (past ? ' is-past' : '') + '">'
               + '<div class="wkday-head">'
               +   '<span class="wkday-name">' + esc(prettyDate(iso).replace(/,.*$/, '')) + '</span>'
               +   (isToday ? '<span class="wkday-tag">Today</span>' : '')
               + '</div>';
          if (!list.length) {
            out += '<div class="wkday-off">Off</div>';
          } else {
            out += list.map(function (s) {
              var place = (s.locations && s.locations.name) || '';
              var cat   = (s.shift_categories && s.shift_categories.name) || '';
              return '<div class="wkrow">'
                   +   '<div class="wkrow-time">' + esc(prettyTime(s.start_time))
                   +     ' – ' + esc(prettyTime(s.end_time)) + '</div>'
                   +   '<div class="wkrow-where">' + esc([place, cat].filter(Boolean).join(' · ')) + '</div>'
                   // Only once a session is over does its outcome mean
                   // anything. A "Scheduled" chip on Thursday's work tells
                   // nobody anything they did not already know.
                   +   (s.status && s.status !== 'scheduled'
                        ? '<span class="pill p-' + esc(s.status) + '">' + esc(statusLabel(s.status)) + '</span>'
                        : '')
                   + '</div>';
            }).join('');
          }
          out += '</div>';
        }
        box.innerHTML = out;
      })
      .catch(function (e) {
        box.innerHTML = '<div class="note err">' + esc(readableError(e.message, OFFLINE)) + '</div>';
      });
  }

  function loadHistory() {
    var box = $('historyList');
    box.innerHTML = '<p class="empty">Loading…</p>';
    var from = new Date(Date.now() - 30 * 86400000);
    var fromStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(from);
    var scope = mine();
    if (!scope) { box.innerHTML = '<p class="empty">Nothing in the last 30 days.</p>'; return; }
    var q = '/rest/v1/shifts?select=id,shift_date,start_time,end_time,status,late_min,early_min,remark,'
          + 'locations(name)&shift_date=gte.' + fromStr
          + '&shift_date=lt.' + todayKL() + scope + '&order=shift_date.desc,start_time.desc';

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
    }).catch(asOffline).then(function (r) {
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

  $('leaveApplyBtn').addEventListener('click', openLeaveForm);

  // ── My week wiring ──
  $('wkmPrev').addEventListener('click', function () {
    wkStart = addDaysISO(wkStart || mondayOf(todayKL()), -7); loadWeek();
  });
  $('wkmNext').addEventListener('click', function () {
    wkStart = addDaysISO(wkStart || mondayOf(todayKL()), 7); loadWeek();
  });
  $('wkmToday').addEventListener('click', function () {
    wkStart = mondayOf(todayKL()); loadWeek();
  });

  // ── HR wiring ──
  $('hrToggle').addEventListener('click', function () { setMode(!hrMode); });
  $('wkPrev').addEventListener('click', function () {
    rsWeekStart = addDaysISO(rsWeekStart, -7); rsDay = rsWeekStart; rosterNote(''); loadRoster();
  });
  $('wkNext').addEventListener('click', function () {
    rsWeekStart = addDaysISO(rsWeekStart, 7); rsDay = rsWeekStart; rosterNote(''); loadRoster();
  });
  $('rsAdd').addEventListener('click', function () { openShiftSheet(null); });
  $('rsCopy').addEventListener('click', copyLastWeek);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  Array.prototype.forEach.call($('alertSeg').querySelectorAll('[data-seg]'), function (b) {
    b.addEventListener('click', function () {
      hrAlertSeg = b.getAttribute('data-seg');
      Array.prototype.forEach.call($('alertSeg').querySelectorAll('[data-seg]'), function (x) {
        x.classList.toggle('on', x === b);
      });
      loadHrAlerts();
    });
  });
  Array.prototype.forEach.call($('apprSeg').querySelectorAll('[data-seg]'), function (b) {
    b.addEventListener('click', function () {
      apprSeg = b.getAttribute('data-seg');
      Array.prototype.forEach.call($('apprSeg').querySelectorAll('[data-seg]'), function (x) {
        x.classList.toggle('on', x === b);
      });
      renderApprovals();
    });
  });

  $('consentSignOut').addEventListener('click', signOut);
  $('signOutBtn').addEventListener('click', signOut);

  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-view');
      // The Me button on the HR bar is a way back, not a seventh view.
      if (hrMode && v === 'Today') { if (isOffice()) return; setMode(false); return; }
      showView(v);
      if (v === 'Today') loadToday();
    });
  });

  // Refresh Today when the app comes back to the foreground — a worker
  // typically reopens it at the pool, minutes after last looking at it.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && profile && !isOffice()
        && !$('viewToday').classList.contains('hidden')) loadToday();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  boot();
})();
