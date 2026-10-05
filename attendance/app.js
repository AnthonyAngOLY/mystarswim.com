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
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function clearSession() {
    try { window.localStorage.removeItem(STORE_KEY); } catch (e) {}
    try { window.sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    store = null;
  }

  var session = null;   // { access_token, refresh_token, persistent }
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
        persistent: !!persistent
      };
      saveSession(session, persistent);
    });
  }

  function signOut() {
    clearSession();
    session = null; profile = null;
    hide($('appScreen')); hide($('consentScreen')); show($('loginScreen'));
    $('password').value = '';
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  function boot() {
    session = loadSession();
    if (!session || !session.access_token) { show($('loginScreen')); return; }
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

  function enterApp() {
    hide($('loginScreen')); hide($('consentScreen')); show($('appScreen'));
    $('whoName').textContent = profile.full_name || '';
    $('whoId').textContent = profile.staff_id || '';
    loadToday();
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
    return api('/rest/v1/alerts?select=id,shift_id,type,status,worker_reason&status=eq.open')
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
      var stage = !p['in'] ? 'in' : !p['out'] ? 'out' : 'done';
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
      var btn = stage === 'done'
        ? '<button class="btn done" disabled>Done</button>'
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

    Array.prototype.forEach.call($('todayList').querySelectorAll('[data-send]'), function (b) {
      b.addEventListener('click', function () {
        var box = b.parentNode, ta = box.querySelector('textarea');
        var text = (ta.value || '').trim();
        if (!text) { ta.focus(); return; }
        b.disabled = true; b.textContent = 'Sending…';
        rpc('set_my_alert_reason', { p_alert_id: b.getAttribute('data-send'), p_reason: text })
          .then(function () { loadToday(); })
          .catch(function (e) {
            b.disabled = false; b.textContent = 'Send reason';
            box.insertAdjacentHTML('beforeend',
              '<div class="hint err">' + esc(e.message || 'Could not send that.') + '</div>');
          });
      });
    });
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
  function explainBox(s) {
    var list = alertsFor(s.id);
    if (!list.length) return '';
    return list.map(function (a) {
      if (a.worker_reason) {
        return '<div class="explain done">'
          + '<div class="ask">' + esc(ALERT_ASK[a.type] || 'Needs an explanation.') + '</div>'
          + '<div class="said">You said: <i>' + esc(a.worker_reason) + '</i></div>'
          + '<div class="hint">Sent to your admin.</div></div>';
      }
      return '<div class="explain" data-alert="' + esc(a.id) + '">'
        + '<div class="ask">' + esc(ALERT_ASK[a.type] || 'Needs an explanation.') + '</div>'
        + '<textarea class="reason" rows="2" placeholder="What happened?"></textarea>'
        + '<button class="btn small-btn" data-send="' + esc(a.id) + '">Send reason</button>'
        + '</div>';
    }).join('');
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

    api(q).then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
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
          + '</div>';
      }).join('');
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
    doLogin($('staffId').value, $('password').value, $('keepMe').checked)
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
