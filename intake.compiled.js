const {
  useState
} = React;

// ── Supabase REST helpers (mirrors app.js — kept self-contained so this
// page can be served independently of the admin SPA) ──
const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};
async function rest(path, opts = {}) {
  const merged = {
    ...BASE_HEADERS,
    ...(opts.headers || {})
  };
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: merged
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : null;
}
async function insertRows(table, payload) {
  return rest(`${table}?select=*`, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify(Array.isArray(payload) ? payload : [payload])
  });
}
async function patchRows(table, match, payload) {
  const q = Object.entries(match).map(([k, v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=*${q}`, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=representation'
    },
    body: JSON.stringify(payload)
  });
}
// True when a PostgREST error means a column doesn't exist yet (the T&C
// digital-signature migration hasn't been run on this deployment). Lets the
// acceptance write retry with the legacy row shape instead of failing.
function isMissingColumnErr(err) {
  const m = err && err.message || '';
  return /PGRST204|42703|schema cache|does not exist/i.test(m);
}

// ── Date / age helpers (must match app.js logic so the admin app sees
// the same computed age that's shown on this form) ──
function fromDateStr(s) {
  const [y, m, d] = (s || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ageMonthsFromDob(dob) {
  if (!dob) return null;
  try {
    const d = fromDateStr(dob);
    const now = new Date();
    let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (now.getDate() < d.getDate()) m--;
    return Math.max(0, m);
  } catch (_) {
    return null;
  }
}
function ageFromDob(dob) {
  const m = ageMonthsFromDob(dob);
  if (m == null) return null;
  if (m < 60) return Math.floor(m / 6) / 2;
  return Math.floor(m / 12);
}
function ageDisplay(age) {
  if (age === null || age === undefined || age === '') return '—';
  return `${age}y`;
}

// ── Terms & Conditions content — mirror of app.js's TC_CONTENT. Kept in
// sync manually; both files import nothing else, so duplication is the
// simplest dependency-free choice for a static-hosted page. ──
const TC_COMPANY = 'Star Swim Sdn Bhd';
const TC_CONTENT = [{
  h: '1. Introduction',
  body: `These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by ${TC_COMPANY} ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms.`
}, {
  h: '2. Safeguarding & Child Protection',
  body: `${TC_COMPANY} is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.\n\n2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.\n\n2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.\n\n2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.\n\n2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from ${TC_COMPANY} and the relevant guardian of every swimmer present.`
}, {
  h: '3. Class Cancellation & Attendance Policy',
  body: `3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.\n\n3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.\n\n3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.`
}, {
  h: '4. School-Initiated Cancellations',
  body: `4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather. Participants will be notified as promptly as possible. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.\n\n4.2 Instructor Cancellation: Should a class be cancelled by ${TC_COMPANY} or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson.`
}, {
  h: '5. Replacement Class Policy',
  body: `5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available.\n\n5.2 Personal & Private Classes: Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space.\n\n5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing.`
}, {
  h: '6. Credit System',
  body: `6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.\n\n6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.\n\n6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.`
}, {
  h: '7. Health, Safety & Medical Disclosure',
  body: `7.1 Good Health Confirmation: You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities.

7.2 Medical & Behavioural Declaration: You further declare that, to the best of your knowledge, the swimmer named in this registration:
  (a) does not have any known medical, physical, or psychological condition that would prevent safe participation in swimming lessons;
  (b) has not been advised by a medical professional to refrain from physical activity or aquatic programmes;
  (c) is not under any medication or treatment that would interfere with swim lesson participation;
  (d) does not require additional support unless previously disclosed.

7.3 Disclosure Obligation: Any pre-existing medical condition, allergy, behavioural consideration, or physical limitation must be disclosed to the School prior to the commencement of classes. If any such conditions exist, you confirm that you have disclosed them during registration or will inform the School's administrators before lessons commence.

7.4 Consequences of Non-Disclosure: You understand that failure to disclose relevant medical or behavioural information may affect the safety and quality of instruction and may result in withdrawal from the programme without refund.

7.5 Liability: The School is not liable for injuries or health events arising from undisclosed medical or behavioural conditions.

7.6 Emergency Authorisation: In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.`
}, {
  h: '8. Liability Waiver',
  body: `8.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.`
}, {
  h: '9. Photography, Video & Marketing Consent',
  body: `9.1 By accepting these Terms, you consent to ${TC_COMPANY} taking photographs and video recordings of the swimmer during lessons, classes, and events for the purposes of instructor training, social media, advertising, school newsletters, and other marketing activities undertaken by the School.

9.2 Opt-Out: If you wish to withhold consent for the use of your swimmer's images in marketing materials, please notify the School in writing at the time of registration or thereafter. The School will then take reasonable steps to exclude the swimmer from marketing photography going forward; this opt-out does not retroactively remove already-published materials.

9.3 This School-led photography consent is distinct from the third-party photography restrictions described in clause 2.4. Visitors and other guardians remain prohibited from photographing or recording any swimmer (including their own child within shared pool areas) without prior written consent from ${TC_COMPANY} and the relevant guardians of every swimmer present.`
}, {
  h: '10. Acceptance & Governing Law',
  body: `This Agreement is governed by the laws of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.`
}];

// Flatten the default T&C into one text blob — fallback when a branch has no
// custom terms_content set.
function defaultTermsText() {
  return TC_CONTENT.map(s => `${s.h}\n${s.body}`).join('\n\n').replace(/\\n/g, '\n');
}
function IntakeForm() {
  // Parent / guardian (shared across all children registered in this submission)
  const [gName, setGName] = useState('');
  const [gEmail, setGEmail] = useState('');
  const [gPhone, setGPhone] = useState('');
  const [gIC, setGIC] = useState('');
  const [gTIN, setGTIN] = useState('');

  // Children — array of { name, dob, gender }. Always at least one row.
  const [children, setChildren] = useState([{
    name: '',
    dob: '',
    gender: null
  }]);

  // Branch picker — list pulled from DB. Defaults to SSGT (HQ) on first load.
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState('');
  React.useEffect(() => {
    (async () => {
      try {
        const rows = await rest('branches?select=*&is_active=eq.true&order=sort_order.asc,name.asc');
        const list = rows || [];
        setBranches(list);
        // Default to SSGT (HQ) if present, else first active branch.
        const hq = list.find(b => (b.code || '').toUpperCase() === 'SSGT') || list[0];
        if (hq) setBranchId(hq.id);
      } catch (_) {/* table may not exist on older deploys — silently skip */}
    })();
  }, []);

  // Emergency contact — when sameAsGuardian, the three fields below are
  // disabled and the form submits the guardian's name/phone instead.
  const [sameAsGuardian, setSameAsGuardian] = useState(false);
  const [eName, setEName] = useState('');
  const [ePhone, setEPhone] = useState('');
  const [eRel, setERel] = useState('');
  const [tcOpen, setTcOpen] = useState(false);
  const [tcAccepted, setTcAccepted] = useState(false);
  // Digital signature — guardian types their full name to sign. Must match
  // the Parent / Guardian name entered above; recorded as the acceptance's
  // signature_name for the audit trail.
  const [sigName, setSigName] = useState('');
  // Referral / discount code captured at intake (free-text, optional). Validation
  // and redemption happen later at invoice time; we just record what was given.
  const [referralCode, setReferralCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null); // { guardianName, children: [...] }

  function setChildAt(i, field, val) {
    setChildren(cs => cs.map((c, j) => j === i ? {
      ...c,
      [field]: val
    } : c));
  }
  function addChild() {
    setChildren(cs => [...cs, {
      name: '',
      dob: '',
      gender: null
    }]);
  }
  function removeChild(i) {
    setChildren(cs => cs.length > 1 ? cs.filter((_, j) => j !== i) : cs);
  }
  function validate() {
    if (!gName.trim()) return 'Please enter the parent or guardian name.';
    if (!gEmail.trim() || !/^\S+@\S+\.\S+$/.test(gEmail.trim())) return 'Please enter a valid email address.';
    if (!gPhone.trim()) return 'Please enter a phone number for the parent or guardian.';
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (!c.name.trim()) return `Please enter swimmer ${i + 1}'s full name.`;
      if (!c.dob) return `Please enter swimmer ${i + 1}'s date of birth.`;
      if (!c.gender) return `Please pick swimmer ${i + 1}'s gender.`;
    }
    if (!sameAsGuardian) {
      if (!eName.trim()) return 'Please enter an emergency contact name (or check "Same as Parent/Guardian").';
      if (!ePhone.trim()) return 'Please enter an emergency contact phone (or check "Same as Parent/Guardian").';
      if (!eRel.trim()) return 'Please enter the emergency contact relationship (or check "Same as Parent/Guardian").';
    }
    if (!tcAccepted) return 'Please read and accept the Terms & Conditions to submit.';
    if (!sigName.trim()) return 'Please type your full name to sign the Terms & Conditions.';
    if (sigName.trim().toLowerCase() !== gName.trim().toLowerCase()) return 'Your typed signature must match the Parent / Guardian name entered above.';
    return null;
  }
  async function handleSubmit() {
    const errMsg = validate();
    if (errMsg) {
      setErr(errMsg);
      return;
    }
    if (submitting) return;
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      setErr('Server not configured — please contact the school administrator.');
      return;
    }
    setErr('');
    setSubmitting(true);
    try {
      const emergencyName = sameAsGuardian ? gName.trim() : eName.trim();
      const emergencyPhone = sameAsGuardian ? gPhone.trim() : ePhone.trim();
      const emergencyRel = sameAsGuardian ? 'Parent / Guardian' : eRel.trim();

      // One call, behind the service role. This used to be three writes
      // with the anon key — insert the children, upsert the acceptance,
      // patch the children back — which is why students could not be
      // locked down: locking it would have taken enrolment with it.
      //
      // The account_id is no longer minted here either. A parent
      // enrolling a second child months later was becoming a second
      // family, which was cosmetic when account_id only grouped rows on
      // a screen and is not cosmetic now that it decides who may see
      // which children. The function matches them by phone instead.
      const res = await fetch(`${cfg.supabaseUrl}/functions/v1/public-intake`, {
        method: 'POST',
        // Both headers. Supabase's "Verify JWT" gate reads Authorization,
        // not apikey, so sending only the latter means a 401 the moment
        // that toggle is on — and it is on by default.
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.supabaseAnonKey,
          Authorization: `Bearer ${cfg.supabaseAnonKey}`
        },
        body: JSON.stringify({
          guardianName: gName.trim(),
          guardianEmail: gEmail.trim(),
          guardianPhone: gPhone.trim(),
          guardianIc: gIC.trim() || null,
          guardianTin: gTIN.trim() || null,
          branchId: branchId || null,
          emergencyName,
          emergencyPhone,
          emergencyRelationship: emergencyRel,
          emergencySameAsGuardian: !!sameAsGuardian,
          referralCode: referralCode.trim() || null,
          signatureName: sigName.trim(),
          children: children.map(c => ({
            name: c.name.trim(),
            dob: c.dob || null,
            gender: c.gender
          }))
        })
      });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out || out.ok !== true) {
        throw new Error(out && out.error || 'Registration could not be completed. Please call the centre.');
      }
      const registered = out.registered || [];
      setDone({
        guardianName: gName.trim(),
        email: gEmail.trim(),
        children: registered
      });
      window.scrollTo({
        top: 0,
        behavior: 'smooth'
      });
    } catch (e) {
      setErr(e?.message || 'Submission failed. Please try again or hand the tablet back to the school administrator.');
    } finally {
      setSubmitting(false);
    }
  }
  function resetForm() {
    setGName('');
    setGEmail('');
    setGPhone('');
    setChildren([{
      name: '',
      dob: '',
      gender: null
    }]);
    setSameAsGuardian(false);
    setEName('');
    setEPhone('');
    setERel('');
    setTcAccepted(false);
    setTcOpen(false);
    setReferralCode('');
    setSigName('');
    setErr('');
    setDone(null);
    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }
  if (done) {
    return /*#__PURE__*/React.createElement("div", {
      className: "page"
    }, /*#__PURE__*/React.createElement("div", {
      className: "success-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "success-icon"
    }, "✅"), /*#__PURE__*/React.createElement("div", {
      className: "success-title"
    }, "Thank you, ", done.guardianName, "!"), /*#__PURE__*/React.createElement("div", {
      className: "success-sub"
    }, "We've received your registration. Star Swim will be in touch on ", /*#__PURE__*/React.createElement("strong", null, done.email), " shortly to confirm your first lesson."), /*#__PURE__*/React.createElement("div", {
      className: "success-list"
    }, done.children.map((c, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "success-list-item"
    }, "• ", c.name, " — ", ageDisplay(c.age), " · T&C signed (ID: ", c.acceptanceId, ")"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
      className: "success-reset",
      onClick: resetForm
    }, "Register Another Family"))), /*#__PURE__*/React.createElement("div", {
      className: "footer-note"
    }, TC_COMPANY, " · Swimmer Registration"));
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand-card"
  }, /*#__PURE__*/React.createElement("img", {
    src: "./logo.png",
    alt: "Star Swim Sdn Bhd",
    className: "brand-logo"
  }), /*#__PURE__*/React.createElement("div", {
    className: "brand-title"
  }, "Swimmer Registration"), /*#__PURE__*/React.createElement("div", {
    className: "brand-sub"
  }, TC_COMPANY, " · Welcome — please fill in your details below")), err ? /*#__PURE__*/React.createElement("div", {
    className: "err-banner"
  }, "⚠ ", err) : null, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Parent / Guardian"), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Full Name", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: gName,
    onChange: e => setGName(e.target.value),
    placeholder: "Your full name",
    autoComplete: "name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Email", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "email",
    value: gEmail,
    onChange: e => setGEmail(e.target.value),
    placeholder: "email@example.com",
    autoComplete: "email",
    inputMode: "email"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: gPhone,
    onChange: e => setGPhone(e.target.value),
    placeholder: "+60 1X-XXX XXXX",
    autoComplete: "tel",
    inputMode: "tel"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "IC No. ", /*#__PURE__*/React.createElement("span", {
    className: "opt-label"
  }, "optional")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: gIC,
    onChange: e => setGIC(e.target.value),
    placeholder: "e.g. 901231-14-5678"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "TIN No. ", /*#__PURE__*/React.createElement("span", {
    className: "opt-label"
  }, "optional")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: gTIN,
    onChange: e => setGTIN(e.target.value),
    placeholder: "e.g. IG12345678090"
  }))), branches.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Branch / Location", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("select", {
    className: "select",
    value: branchId,
    onChange: e => setBranchId(e.target.value)
  }, branches.map(b => /*#__PURE__*/React.createElement("option", {
    key: b.id,
    value: b.id
  }, b.name, b.code ? ` (${b.code})` : ''))))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Swimmer(s)"), children.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "child-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "child-card-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "child-label"
  }, /*#__PURE__*/React.createElement("span", {
    className: "child-num"
  }, i + 1), " Swimmer ", i + 1), children.length > 1 ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "child-remove",
    onClick: () => removeChild(i),
    title: "Remove this swimmer"
  }, "×") : null), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Full Name", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: c.name,
    onChange: e => setChildAt(i, 'name', e.target.value),
    placeholder: "Swimmer's full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field-row-3"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      marginBottom: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Date of Birth", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "date",
    value: c.dob,
    max: todayStr(),
    onChange: e => setChildAt(i, 'dob', e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      marginBottom: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Age"), /*#__PURE__*/React.createElement("div", {
    className: `age-display ${c.dob ? '' : 'is-empty'}`
  }, ageDisplay(c.dob ? ageFromDob(c.dob) : null))), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      marginBottom: 0
    }
  }, /*#__PURE__*/React.createElement("label", null, "Gender", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("div", {
    className: "gender-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${c.gender === 'female' ? 'active' : ''}`,
    onClick: () => setChildAt(i, 'gender', c.gender === 'female' ? null : 'female')
  }, "♀ F"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: `gender-opt ${c.gender === 'male' ? 'active' : ''}`,
    onClick: () => setChildAt(i, 'gender', c.gender === 'male' ? null : 'male')
  }, "♂ M")))))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "add-child-btn",
    onClick: addChild
  }, "+ Add Another Swimmer")), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Emergency Contact"), /*#__PURE__*/React.createElement("label", {
    className: `check-row ${sameAsGuardian ? 'is-on' : ''}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: sameAsGuardian,
    onChange: e => setSameAsGuardian(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "check-row-text"
  }, /*#__PURE__*/React.createElement("strong", null, "Same as Parent / Guardian"), " — use the contact details above (you won't need to re-enter them)")), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Emergency Contact Name", sameAsGuardian ? '' : /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: sameAsGuardian ? gName : eName,
    onChange: e => setEName(e.target.value),
    disabled: sameAsGuardian,
    placeholder: "Full name"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Phone Number", sameAsGuardian ? '' : /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    type: "tel",
    value: sameAsGuardian ? gPhone : ePhone,
    onChange: e => setEPhone(e.target.value),
    disabled: sameAsGuardian,
    placeholder: "+60 1X-XXX XXXX",
    inputMode: "tel"
  })), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", null, "Relationship to Swimmer", sameAsGuardian ? '' : /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*")), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: sameAsGuardian ? 'Parent / Guardian' : eRel,
    onChange: e => setERel(e.target.value),
    disabled: sameAsGuardian,
    placeholder: "e.g. Grandparent, Aunt"
  })))), /*#__PURE__*/React.createElement("div", {
    className: "card referral-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "referral-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "referral-text"
  }, /*#__PURE__*/React.createElement("div", {
    className: "referral-title"
  }, "🎟 Referral / Discount Code ", /*#__PURE__*/React.createElement("span", {
    className: "optional-tag"
  }, "optional")), /*#__PURE__*/React.createElement("div", {
    className: "referral-hint"
  }, "If you were referred or have a promo code")), /*#__PURE__*/React.createElement("input", {
    className: "input referral-input",
    value: referralCode,
    onChange: e => setReferralCode(e.target.value.toUpperCase()),
    placeholder: "e.g. SARAH2025",
    maxLength: 32
  }))), /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "section-title"
  }, "Terms & Conditions"), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "tc-toggle",
    onClick: () => setTcOpen(o => !o),
    "aria-expanded": tcOpen
  }, /*#__PURE__*/React.createElement("span", null, tcOpen ? 'Hide full Terms & Conditions' : 'Read full Terms & Conditions'), /*#__PURE__*/React.createElement("span", {
    className: "tc-chev"
  }, tcOpen ? '▴' : '▾')), tcOpen && /*#__PURE__*/React.createElement("div", {
    className: "tc-doc",
    tabIndex: 0
  }, /*#__PURE__*/React.createElement("h1", null, TC_COMPANY), /*#__PURE__*/React.createElement("h2", null, "Swimming Lesson Enrolment — Terms & Conditions"), (() => {
    const b = branches.find(x => x.id === branchId);
    const raw = b && b.terms_content && b.terms_content.trim() ? b.terms_content : defaultTermsText();
    // Numbering is the markup: see terms-render.js, loaded by both
    // this page and the admin so the two cannot drift.
    return window.SSTerms.render(React, raw, {
      h2Class: 'tc-doc-title'
    });
  })()), /*#__PURE__*/React.createElement("label", {
    className: `check-row ${tcAccepted ? 'is-on' : ''}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: tcAccepted,
    onChange: e => setTcAccepted(e.target.checked)
  }), /*#__PURE__*/React.createElement("span", {
    className: "check-row-text"
  }, "I have read and fully understood the Terms & Conditions of ", /*#__PURE__*/React.createElement("strong", null, TC_COMPANY), ". I agree to be bound by this Agreement on behalf of myself and/or the enrolled swimmer(s) above, and confirm all information provided is accurate.")), /*#__PURE__*/React.createElement("div", {
    className: "field",
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("label", null, "Digital Signature", /*#__PURE__*/React.createElement("span", {
    className: "req"
  }, "*"), " — type your full name to sign"), /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: sigName,
    onChange: e => setSigName(e.target.value),
    placeholder: gName.trim() ? `Type "${gName.trim()}" to sign` : 'Enter the Parent / Guardian name above first',
    style: {
      fontFamily: '"Segoe Script","Brush Script MT",cursive',
      fontSize: 18
    }
  }), sigName.trim() && gName.trim() && sigName.trim().toLowerCase() !== gName.trim().toLowerCase() && /*#__PURE__*/React.createElement("div", {
    className: "hint",
    style: {
      color: '#b91c1c',
      marginTop: 4
    }
  }, "⚠ Must match the Parent / Guardian name above: ", /*#__PURE__*/React.createElement("strong", null, gName.trim())))), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "submit-btn",
    onClick: handleSubmit,
    disabled: submitting
  }, submitting ? 'Submitting…' : 'Submit Registration'), /*#__PURE__*/React.createElement("div", {
    className: "footer-note"
  }, TC_COMPANY, " · Information you provide is used solely for class administration and emergency purposes."), /*#__PURE__*/React.createElement("div", {
    className: "print-pdf-row"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "print-pdf-link",
    onClick: () => {
      const w = window.open('./form.html', '_blank', 'noopener,noreferrer,width=800,height=900');
      // form.html auto-triggers window.print() on load — the user sees
      // the print dialog immediately without needing to click again.
    }
  }, "🖨 Print PDF version of this form"), /*#__PURE__*/React.createElement("span", {
    className: "print-pdf-hint"
  }, "Hard-copy registration · opens print dialog automatically")));
}
window.addEventListener('error', ev => {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `<div class="page"><div class="err-banner">⚠ ${ev.error && ev.error.message || ev.message || 'Unknown error'}</div></div>`;
  }
});
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(IntakeForm, null));