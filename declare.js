// ─────────────────────────────────────────────────────────────────────────
// The health declaration, for children who are already with us
// ─────────────────────────────────────────────────────────────────────────
// The six health questions are asked at enrolment. Everybody who joined
// before the intake form asked them has nothing on file — and the terms
// they signed declare, on their behalf, that the child "does not have
// any known medical, physical or psychological condition that would
// prevent safe participation", with clause 9.4 saying non-disclosure may
// mean withdrawal without refund.
//
// So we were holding families to a disclosure obligation through a form
// that gave them nowhere to disclose. This is the page that closes that,
// without asking anybody to enrol again.
//
// WHAT IT IS NOT
// Not a sign-up, not a second T&C, not a login. A parent proves who they
// are the same way the intake form lets a returning family in: the
// account number they were given, and a phone number already on the
// account. Either alone answers nothing, and both failures say the same
// sentence, so this is not a way to walk the list of families.
//
// It never touches the database directly. Everything goes through
// public-intake, which holds the service role; this page holds the anon
// key, which cannot read students and must not be able to.
// ─────────────────────────────────────────────────────────────────────────
const { useState } = React;

const cfg = window.APP_CONFIG || {};
const TC_COMPANY = 'Star Swim Sdn Bhd';

// One call, one place. The Edge Function answers both actions.
async function callIntake(payload){
  const res = await fetch(`${cfg.supabaseUrl}/functions/v1/public-intake`, {
    method: 'POST',
    headers: {
      apikey: cfg.supabaseAnonKey || '',
      Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const txt = await res.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch(_e){ body = null; }
  if(!body) throw new Error('Something went wrong. Please try again shortly.');
  return body;
}

// The six, word for word as the intake form asks them. A question that
// read differently here would mean two different declarations wearing
// the same name.
const HEALTH_Q = [
  ['supervision', 'Has a doctor ever advised that your child should only do physical activity under medical supervision — for example a heart condition or high blood pressure?'],
  ['chestPain',   'Has your child had chest pain, dizziness, fainting or loss of balance, especially when not physically active?'],
  ['boneJoint',   'Does your child have any bone, joint or physical condition that could be made worse by exercise?'],
  ['medication',  'Is your child taking any medication for their heart, blood pressure, or another long-term condition?'],
  ['learning',    'Does your child have a learning difficulty or a behavioural condition — ADHD or autism, for example — or need extra support to follow instructions?'],
  ['other',       'Is there any other reason your child may not be able to swim safely?']
];
const BLANK_HEALTH = { supervision:null, chestPain:null, boneJoint:null,
                       medication:null, learning:null, other:null, details:'' };
const anyYes     = h => HEALTH_Q.some(([k]) => h && h[k] === true);
const allAnswered = h => HEALTH_Q.every(([k]) => h && (h[k] === true || h[k] === false));

function DeclarationForm(){
  // Step 1 — who is this
  const [acctNo, setAcctNo]       = useState('');
  const [acctPhone, setAcctPhone] = useState('');
  const [looking, setLooking]     = useState(false);
  const [found, setFound]         = useState(null);   // {displayName, accountNo, childList}

  // Step 2 — which children, and what about each
  const [picked, setPicked] = useState({});           // id -> true
  const [health, setHealth] = useState({});           // id -> answers

  // Step 3 — signing
  const [sig, setSig]       = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState('');
  const [done, setDone]     = useState(null);

  const kids = (found && found.childList) || [];
  const chosen = kids.filter(k => picked[k.id]);

  async function lookUp(e){
    if(e) e.preventDefault();
    setErr('');
    if(!acctNo.trim() || !acctPhone.trim()){
      setErr('Enter your account number and a phone number on the account.');
      return;
    }
    setLooking(true);
    try{
      const r = await callIntake({ action:'lookup',
        accountNo: acctNo.trim(), accountPhone: acctPhone.trim() });
      if(!r.ok){ setErr(r.error || 'That account number and phone number do not go together.'); setFound(null); return; }
      // A family with no children on the account has nothing to declare,
      // and saying so plainly beats an empty list that reads as a fault.
      if(!r.childList || !r.childList.length){
        setErr('We found your account, but there are no swimmers on it. Please call the centre.');
        setFound(null); return;
      }
      setFound(r);
      // Everybody ticked to begin with: the common case is a parent
      // declaring for all their children in one go, and unticking one is
      // easier than finding the one you meant.
      const p = {}, h = {};
      r.childList.forEach(k => { p[k.id] = true; h[k.id] = { ...BLANK_HEALTH }; });
      setPicked(p); setHealth(h);
      if(!sig.trim() && r.displayName) setSig('');
    } catch(ex){ setErr(ex.message || 'Could not check that just now.'); }
    finally{ setLooking(false); }
  }

  function setAnswer(id, key, val){
    setHealth(h => ({ ...h, [id]: { ...(h[id] || BLANK_HEALTH), [key]: val } }));
  }

  // Said once, here, so the button's reason for being disabled and the
  // message on submit cannot disagree.
  function whatIsMissing(){
    if(!chosen.length) return 'Choose at least one swimmer.';
    for(const k of chosen){
      const h = health[k.id] || BLANK_HEALTH;
      if(!allAnswered(h)) return `Please answer all six questions for ${k.name}.`;
      if(anyYes(h) && !String(h.details || '').trim())
        return `Please tell us what we should know about ${k.name}.`;
    }
    if(!agreed) return 'Please confirm the declaration.';
    if(!sig.trim()) return 'Type your name to sign.';
    return '';
  }
  const missing = whatIsMissing();

  async function submit(){
    const m = whatIsMissing();
    if(m){ setErr(m); return; }
    setErr(''); setBusy(true);
    try{
      const r = await callIntake({
        action: 'declare',
        accountNo: acctNo.trim(),
        accountPhone: acctPhone.trim(),
        signatureName: sig.trim(),
        children: chosen.map(k => ({ id: k.id, health: health[k.id] }))
      });
      if(!r.ok){ setErr(r.error || 'That did not go through. Please try again.'); return; }
      setDone(r);
    } catch(ex){ setErr(ex.message || 'That did not go through.'); }
    finally{ setBusy(false); }
  }

  if(done) return <div className="page">
    <Brand />
    <div className="card done-card">
      <div className="done-tick">✓</div>
      <div style={{fontSize:20,fontWeight:800,marginBottom:6}}>Thank you</div>
      <div className="why" style={{maxWidth:460,margin:'0 auto'}}>
        We have recorded your declaration for{' '}
        <strong>{done.declared.map(d => d.name).join(', ')}</strong>.
        If you told us about anything, someone will speak to you before the next lesson.
        It does not usually mean your child cannot swim with us.
      </div>
      <div className="done-ref">{done.reference}</div>
      <div className="why" style={{marginTop:10}}>Your reference, if you need to ask us about this.</div>
    </div>
  </div>;

  return <div className="page">
    <Brand />

    {/* ── Who is this ─────────────────────────────────────────────── */}
    <div className="card">
      <div className="section-title">Find your family</div>
      <div className="why" style={{marginBottom:14}}>
        Your <strong>account number</strong> is on your receipts and looks like
        {' '}<strong>TAN-7391</strong>. If you do not have it, ask us and we will tell you.
        We also need a phone number already on your account — both have to match,
        which is what stops anybody else opening your children's details.
      </div>
      {err && !found && <div className="err-banner">{err}</div>}
      <form onSubmit={lookUp}>
        <div className="field-row">
          <div className="field">
            <label>Account number</label>
            <input className="input" value={acctNo} autoCapitalize="characters"
              onChange={e=>setAcctNo(e.target.value.toUpperCase())}
              placeholder="TAN-7391" disabled={looking || !!found} />
          </div>
          <div className="field">
            <label>Phone number on the account</label>
            <input className="input" value={acctPhone} inputMode="tel"
              onChange={e=>setAcctPhone(e.target.value)}
              placeholder="012-345 6789" disabled={looking || !!found} />
          </div>
        </div>
        {!found && <button type="submit" className="submit-btn" disabled={looking}>
          {looking ? 'Checking…' : 'Find my family'}
        </button>}
      </form>
      {found && <div className="found-note" style={{marginTop:12,marginBottom:0}}>
        Found you — <strong>{found.displayName || found.accountNo}</strong>.{' '}
        <a href="#" onClick={e=>{e.preventDefault(); setFound(null); setErr(''); setPicked({}); setHealth({});}}>
          Not you?
        </a>
      </div>}
    </div>

    {found && <>
      {/* ── Which children ───────────────────────────────────────── */}
      <div className="card">
        <div className="section-title">Who are you declaring for</div>
        <div className="why" style={{marginBottom:12}}>
          Untick anybody you are not answering for today. You can come back for them later.
        </div>
        {kids.map(k => <label key={k.id} className={`child-pick ${picked[k.id]?'is-on':''}`}>
          <input type="checkbox" checked={!!picked[k.id]}
            onChange={e=>setPicked(p => ({ ...p, [k.id]: e.target.checked }))} />
          <span className="child-pick-name">{k.name}</span>
        </label>)}
      </div>

      {/* ── The six, per child ───────────────────────────────────── */}
      {chosen.map(k => {
        const h = health[k.id] || BLANK_HEALTH;
        return <div className="card" key={k.id}>
          <div className="section-title">{k.name}</div>
          <div className="health-block" style={{marginTop:0}}>
            <div className="health-note">
              Please answer all six. If anything is yes we will talk to you before the
              next lesson — it does not usually mean your child cannot swim with us.
            </div>
            {HEALTH_Q.map(([key, q]) => <div key={key} className={`health-q ${h[key]===true?'is-yes':''}`}>
              <div className="health-q-text">{q}</div>
              <div className="gender-toggle health-yn">
                <button type="button" className={`gender-opt ${h[key]===false?'active':''}`}
                  onClick={()=>setAnswer(k.id, key, false)}>No</button>
                <button type="button" className={`gender-opt ${h[key]===true?'active':''}`}
                  onClick={()=>setAnswer(k.id, key, true)}>Yes</button>
              </div>
            </div>)}
            {anyYes(h) && <div className="field" style={{marginTop:10,marginBottom:0}}>
              <label>What should we know?<span className="req">*</span></label>
              <textarea className="input health-details" rows={3}
                value={h.details || ''}
                onChange={e=>setAnswer(k.id, 'details', e.target.value)}
                placeholder="A sentence is enough — the condition, and anything the instructor should do differently." />
            </div>}
          </div>
        </div>;
      })}

      {/* ── Signing ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="section-title">Sign</div>
        <label className={`check-row ${agreed?'is-on':''}`}>
          <input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} />
          <span className="check-row-text">
            The answers above are true and complete as far as I know, for{' '}
            <strong>{chosen.map(k => k.name).join(', ') || 'the swimmers selected'}</strong>.
            I will tell <strong>{TC_COMPANY}</strong> if anything changes.
          </span>
        </label>
        <div className="field">
          <label>Type your full name to sign<span className="req">*</span></label>
          <input className="input sig-input" value={sig} onChange={e=>setSig(e.target.value)}
            placeholder="Your name" />
        </div>
        {err && <div className="err-banner" style={{marginTop:4}}>{err}</div>}
        {!err && missing && <div className="why" style={{marginBottom:10}}>{missing}</div>}
        <button className="submit-btn" onClick={submit} disabled={busy || !!missing}>
          {busy ? 'Sending…' : 'Submit declaration'}
        </button>
      </div>
    </>}
  </div>;
}

function Brand(){
  return <div className="brand-card">
    <img className="brand-logo" src="./logo.png" alt="" />
    <div>
      <div className="brand-title">Health Declaration</div>
      <div className="brand-sub">{TC_COMPANY} · for swimmers already enrolled</div>
    </div>
  </div>;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(DeclarationForm)
);
