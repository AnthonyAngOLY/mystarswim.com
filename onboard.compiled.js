const {
  useState,
  useEffect
} = React;

// ── Supabase helpers ───────────────────────────────────────────────────
// Self-contained, like intake.js: this page is served on its own and must
// not depend on the admin bundle being loaded.
const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};

// Everything this page can do goes through two database functions. There
// is no table access here at all: the anon key is public, so the only
// safe surface is one that answers a boolean and one that writes a row.
async function rpc(name, body) {
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify(body || {})
    });
  } catch (e) {
    throw new Error('Cannot reach Star Swim. Check your connection and try again.');
  }
  const txt = await res.text();
  if (!res.ok) {
    let msg = '';
    try {
      const d = JSON.parse(txt);
      msg = d.message || d.error || d.hint || '';
    } catch (e) {}
    throw new Error(msg || 'Something went wrong. Please try again.');
  }
  return txt ? JSON.parse(txt) : null;
}
function tokenFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return (p.get('t') || '').trim();
}

// ── The form ───────────────────────────────────────────────────────────
const FIELDS = [{
  k: 'full_name',
  label: 'Full name (as per IC)',
  required: true,
  auto: 'name',
  hint: 'Exactly as it appears on your IC — this is what goes on your payslip.'
}, {
  k: 'ic_no',
  label: 'IC number',
  required: true,
  auto: 'off',
  hint: 'Numbers only is fine, dashes are fine too.'
}, {
  k: 'phone',
  label: 'Phone number',
  required: true,
  type: 'tel',
  auto: 'tel'
}, {
  k: 'email',
  label: 'Email',
  type: 'email',
  auto: 'email',
  hint: 'Optional, but it is how we send you anything in writing.'
}, {
  k: 'emergency_name',
  label: 'Emergency contact — name',
  group: 'Emergency contact'
}, {
  k: 'emergency_phone',
  label: 'Emergency contact — phone',
  type: 'tel'
}, {
  k: 'bank_name',
  label: 'Bank name',
  group: 'For your salary',
  hint: 'Maybank, CIMB, Public Bank, and so on.'
}, {
  k: 'bank_account',
  label: 'Bank account number',
  auto: 'off'
}, {
  k: 'applicant_note',
  label: 'Anything we should know',
  textarea: true,
  hint: 'When you can start, days you cannot work — anything useful.'
}];
function App() {
  const token = tokenFromUrl();
  const [checking, setChecking] = useState(true);
  const [linkOk, setLinkOk] = useState(false);
  const [d, setD] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  // Check the link before anyone types. Finding out it is dead after five
  // minutes of typing is the one failure that would make somebody give up.
  useEffect(() => {
    if (!token) {
      setChecking(false);
      return;
    }
    rpc('check_crew_invite', {
      p_token: token
    }).then(ok => setLinkOk(ok === true)).catch(() => setLinkOk(false)).finally(() => setChecking(false));
  }, []);
  function up(k, v) {
    setD(prev => ({
      ...prev,
      [k]: v
    }));
  }
  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await rpc('submit_crew_application', {
        p_token: token,
        p_data: d
      });
      if (r && r.ok) setDone(r);else setErr(r && r.error || 'Something went wrong. Please try again.');
    } catch (ex) {
      setErr(ex.message);
    }
    setBusy(false);
  }
  if (checking) {
    return /*#__PURE__*/React.createElement("div", {
      className: "page"
    }, /*#__PURE__*/React.createElement("div", {
      className: "card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "muted"
    }, "Checking the link…")));
  }
  if (!token || !linkOk) {
    return /*#__PURE__*/React.createElement("div", {
      className: "page"
    }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
      className: "card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "bad-title"
    }, "This link is not in use"), /*#__PURE__*/React.createElement("p", {
      className: "muted"
    }, "It may have been replaced with a newer one. Ask your manager at Star Swim for the current link — it only takes them a moment to send it.")), /*#__PURE__*/React.createElement(Foot, null));
  }
  if (done) {
    return /*#__PURE__*/React.createElement("div", {
      className: "page"
    }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("div", {
      className: "done-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "done-icon"
    }, "✓"), /*#__PURE__*/React.createElement("div", {
      className: "done-title"
    }, done.duplicate ? 'We already have your details' : 'Thank you — that is everything'), /*#__PURE__*/React.createElement("div", {
      className: "done-sub"
    }, done.duplicate ? 'Your details came through earlier. There is nothing more for you to do.' : 'Your details have gone to the Star Swim office. Someone will check them and add you to the team. You do not need to send this again.')), /*#__PURE__*/React.createElement(Foot, null));
  }
  let lastGroup = null;
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement(Brand, null), /*#__PURE__*/React.createElement("form", {
    className: "card",
    onSubmit: submit,
    noValidate: true
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-title"
  }, "Your details"), /*#__PURE__*/React.createElement("p", {
    className: "muted",
    style: {
      marginBottom: 18
    }
  }, "This goes straight to the Star Swim office. Nobody else sees it, and nothing is public. It takes about two minutes."), FIELDS.map(f => {
    const head = f.group && f.group !== lastGroup ? lastGroup = f.group : null;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: f.k
    }, head && /*#__PURE__*/React.createElement("div", {
      className: "group-head"
    }, head), /*#__PURE__*/React.createElement("div", {
      className: "field"
    }, /*#__PURE__*/React.createElement("label", {
      htmlFor: f.k
    }, f.label, f.required && /*#__PURE__*/React.createElement("span", {
      className: "req"
    }, " *")), f.textarea ? /*#__PURE__*/React.createElement("textarea", {
      id: f.k,
      className: "input area",
      rows: "3",
      value: d[f.k] || '',
      maxLength: 500,
      onChange: e => up(f.k, e.target.value)
    }) : /*#__PURE__*/React.createElement("input", {
      id: f.k,
      className: "input",
      type: f.type || 'text',
      value: d[f.k] || '',
      autoComplete: f.auto || 'on',
      onChange: e => up(f.k, e.target.value)
    }), f.hint && /*#__PURE__*/React.createElement("div", {
      className: "hint"
    }, f.hint)));
  }), err && /*#__PURE__*/React.createElement("div", {
    className: "err"
  }, err), /*#__PURE__*/React.createElement("button", {
    className: "submit",
    type: "submit",
    disabled: busy
  }, busy ? 'Sending…' : 'Send my details'), /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      textAlign: 'center',
      marginTop: 10
    }
  }, "You can only send this once.")), /*#__PURE__*/React.createElement(Foot, null));
}
function Brand() {
  return /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, /*#__PURE__*/React.createElement("img", {
    src: "./logo.png",
    alt: "",
    className: "brand-logo"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "brand-title"
  }, "Star Swim Sdn Bhd"), /*#__PURE__*/React.createElement("div", {
    className: "brand-sub"
  }, "New crew — joining details")));
}
function Foot() {
  return /*#__PURE__*/React.createElement("div", {
    className: "foot"
  }, "Star Swim Sdn Bhd · Ipoh, Perak", /*#__PURE__*/React.createElement("br", null), "Your details are used for employment records and payroll only.");
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));