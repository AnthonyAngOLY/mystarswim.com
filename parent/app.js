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
    hide($('s-app')); hide($('s-otp')); show($('s-login'));
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
  // WhatsApp that is not only a security line, it is the bill.
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
        if (r.ok && d && d.known === true && !d.error) return d.channel || 'whatsapp';
        throw new Error((d && d.error)
          || 'We could not send a code just now. Please try again shortly.');
      });
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
        // Signed in to Supabase, but no parent account answers to this
        // user. Says so rather than showing an empty app.
        signOut();
        note($('loginNote'),
          'That number signed in, but it is not linked to a family yet. '
          + 'Call the centre and we will connect it.', true);
        return;
      }
      family = f;
      hide($('s-login')); hide($('s-otp')); show($('s-app'));
      $('whoName').textContent = family.name;
      var n = (family.children || []).length;
      $('whoKids').textContent = n === 1 ? '1 swimmer' : n + ' swimmers';
      wkStart = mondayOf(todayKL());
      wkDay = todayKL();
      setView('home');
      return Promise.all([loadHome(), loadMessages()]);
    });
  }

  function setView(v) {
    view = v;
    ['home', 'child', 'sched', 'credits', 'billing', 'msgs'].forEach(function (k) {
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
        $('homeKids').innerHTML = kids.length ? kids.map(function (k, i) {
          var nx = byKid[k.id];
          return '<div class="card tapcard" data-kid="' + esc(k.id) + '"><div class="row">'
            + '<div class="kid k' + ((i % 3) + 1) + '">' + esc(initials(k.name)) + '</div>'
            + '<div class="grow"><div class="big">' + esc(k.name)
            +   ' <span style="color:var(--muted);font-weight:400">\u203a</span></div>'
            + '<div class="sub">' + (nx
                ? esc(whenWord(nx.class_date) + ' · ' + hhmm(nx.start_time) + ' · ' + nx.lesson)
                : 'No class booked') + '</div>'
            + '</div></div></div>';
        }).join('') : '<div class="card"><div class="sub">No swimmers on this account yet.</div></div>';

        Array.prototype.forEach.call($('homeKids').querySelectorAll('[data-kid]'), function (c) {
          c.addEventListener('click', function () {
            var id = c.getAttribute('data-kid');
            var k = kids.filter(function (x) { return x.id === id; })[0];
            openChild(id, k && k.name, byKid[id], kids.indexOf(k));
          });
        });
      })
      .catch(function (e) { note($('appNote'), e.message, true); });
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
    setView('child');
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

  // ── Inbox ────────────────────────────────────────────────────────────
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
        return '<div class="card msg' + (m.read_at ? '' : ' unread') + '" data-m="' + esc(m.id) + '">'
          + '<div style="font-weight:800">' + esc(m.title)
          +   (m.read_at ? '' : '<span class="dot"></span>') + '</div>'
          + '<div class="lead" style="margin-top:4px;white-space:pre-wrap">' + esc(m.body) + '</div>'
          + '<div class="sub" style="margin-top:6px">'
          +   esc(m.kind === 'reminder' ? 'Reminder' : 'Star Swim') + ' · '
          +   esc(ago(m.created_at)) + '</div></div>';
      }).join('') : '<div class="empty">Nothing from the centre yet.</div>';

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
  $('sendCode').addEventListener('click', function () {
    var p = e164($('phone').value);
    if (p.replace(/\D/g, '').length < 10) {
      note($('loginNote'), 'That does not look like a mobile number.', true); return;
    }
    note($('loginNote'), '');
    this.disabled = true; this.textContent = 'Sending…';
    var btn = this;
    sendCode(p).then(function (channel) {
      pendingPhone = p;
      // Which way it went matters: somebody waiting on WhatsApp will not
      // think to look in their text messages.
      $('otpSentTo').textContent = 'We sent it to ' + p
        + (channel === 'sms' ? ' by SMS' : ' on WhatsApp');
      note($('otpNote'), '');
      $('code').value = '';
      hide($('s-login')); show($('s-otp'));
      $('code').focus();
    }).catch(function (e) {
      note($('loginNote'), e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Send me a code';
    });
  });

  $('verifyCode').addEventListener('click', function () {
    var t = String($('code').value || '').replace(/\D/g, '');
    if (t.length < 4) { note($('otpNote'), 'Enter the code we sent you.', true); return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Signing in…';
    verify(pendingPhone, t).then(enter).catch(function (e) {
      note($('otpNote'), e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
    });
  });

  $('resendCode').addEventListener('click', function () {
    var btn = this; btn.disabled = true; btn.textContent = 'Sending…';
    sendCode(pendingPhone).then(function (channel) {
      note($('otpNote'), 'Sent again' + (channel === 'sms' ? ', by SMS.' : ', on WhatsApp.'));
    }).catch(function (e) {
      note($('otpNote'), e.message, true);
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Send it again';
    });
  });

  $('backToPhone').addEventListener('click', function () {
    hide($('s-otp')); show($('s-login')); note($('loginNote'), '');
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
