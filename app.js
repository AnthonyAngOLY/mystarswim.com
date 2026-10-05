// ============================================================================
// SSB Scheduler app.js — Module 2 build
// ============================================================================
// What changed in Module 2:
//   * Loads pools, operating_hours, and session_instructors from the new schema.
//   * Sessions now carry pool_id, lesson_type_id, instructors[], and computed
//     capacity (current / max / status). Body counts use the same arithmetic
//     as the pool_occupancy() Postgres function.
//   * Weekly grid has a pool filter (All / Pool A / Pool B / ...). In All mode
//     each day-column splits into per-pool sub-columns.
//   * Each event renders a capacity chip with green / amber / red coloring.
//     Over-capacity sessions also get an amber border. Nothing is enforced;
//     the scheduler still has full freedom to save anything. Hard enforcement
//     is Module 3.
//   * Session modal: pool selector; lesson-type change auto-defaults the
//     duration from scheduler_lesson_types.default_duration_minutes; a small
//     capacity preview shows current vs max after edits.
//   * Settings: new Pools panel, new Operating Hours panel, lesson-type rows
//     gain an Edit toggle that exposes age range / ratio / billing / default
//     pool / coach-in-pool / default duration.
//   * Operating hours drive the visible grid bounds. Default seed (8 AM to 9
//     PM, every day, 30-min blocks) produces the same grid as before.
// ============================================================================

const { useState, useEffect, useMemo } = React;
// Section navigation used by Accounts / Settings / Directory sidebars:
// desktop keeps the left-column button nav; phones get a native dropdown
// (a wrapping strip of 9–13 pills ate half the screen).
function SectionNav({ items, value, onChange, ariaLabel }){
  const isMobile = useIsMobile();
  if(isMobile){
    return <select className="section-select" value={value} onChange={e=>onChange(e.target.value)} aria-label={ariaLabel||'Section'}>
      {items.map(([k,l,extra])=><option key={k} value={k}>{l}{extra!=null?` (${extra})`:''}</option>)}
    </select>;
  }
  return <nav className="side-nav">
    {items.map(([k,l,extra])=><button key={k} className={`side-nav-btn${value===k?' active':''}`} onClick={()=>onChange(k)}>{extra!=null?<><span>{l}</span><span className="count">{extra}</span></>:l}</button>)}
  </nav>;
}
// Reactive mobile-breakpoint hook — drives the app-style layout switch
// (bottom tab bar, daily-first schedule) below 820px.
function useIsMobile(){
  const [m,setM] = useState(()=>window.matchMedia('(max-width:820px)').matches);
  useEffect(()=>{
    const q = window.matchMedia('(max-width:820px)');
    const h = e=>setM(e.matches);
    q.addEventListener ? q.addEventListener('change',h) : q.addListener(h);
    return ()=>{ q.removeEventListener ? q.removeEventListener('change',h) : q.removeListener(h); };
  },[]);
  return m;
}

// ───────────────────────────────────────────────────────────────────── constants

const DAYS_S = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const DAYS_F = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const SLOT_MIN = 30;
const ROW_H = 42;
const DEFAULT_OPEN = 480;    // 8:00 AM fallback if operating_hours table is empty
const DEFAULT_CLOSE = 1260;  // 9:00 PM fallback

const DEFAULT_TYPES = {
  "LTS": { bg:"#DBEAFE", bd:"#3B82F6", tx:"#1E40AF" },
  "LTS Adult": { bg:"#CFFAFE", bd:"#06B6D4", tx:"#0E7490" },
  "Personal 1": { bg:"#FED7AA", bd:"#F97316", tx:"#C2410C" },
  "Personal 2": { bg:"#FEF9C3", bd:"#CA8A04", tx:"#854D0E" },
  "Fam3": { bg:"#D1FAE5", bd:"#10B981", tx:"#065F46" },
  "Fam4": { bg:"#DCFCE7", bd:"#22C55E", tx:"#14532D" },
  "Fam5": { bg:"#D9F99D", bd:"#84CC16", tx:"#365314" },
  "Toddler": { bg:"#FCE7F3", bd:"#EC4899", tx:"#831843" },
  "Baby&Me": { bg:"#EDE9FE", bd:"#8B5CF6", tx:"#4C1D95" },
  "Personal Clara": { bg:"#FEE2E2", bd:"#EF4444", tx:"#7F1D1D" }
};

// ───────────────────────────────────────────────────────────────────── REST glue

const cfg = window.APP_CONFIG || {};
const BASE_HEADERS = {
  apikey: cfg.supabaseAnonKey || '',
  Authorization: `Bearer ${cfg.supabaseAnonKey || ''}`,
  'Content-Type': 'application/json'
};
// ── Phase 2: request as `authenticated`, not as the shared anon key ────────
// The login function mirrors each scheduler login into Supabase Auth and
// returns a real session. When we hold one we send it, so PostgREST evaluates
// RLS with actual claims; without one we send the anon key exactly as before.
//
// Safety: RLS is still OFF on the legacy tables, so both credentials reach the
// same rows today. That means a problem with the JWT can always degrade to the
// anon key rather than taking the app down — see the 401 handling in rest().
let sbSession = null;   // { access_token, refresh_token } | null
function setSbSession(s){ sbSession = (s && s.access_token) ? s : null; }
function authHeadersFor(){
  if(!sbSession) return BASE_HEADERS;
  return { ...BASE_HEADERS, Authorization: `Bearer ${sbSession.access_token}` };
}
// Swap an expired access token for a fresh one. Returns true on success.
async function refreshSbSession(){
  if(!sbSession || !sbSession.refresh_token) return false;
  try{
    const res = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method:'POST',
      headers:{ apikey: cfg.supabaseAnonKey, 'Content-Type':'application/json' },
      body: JSON.stringify({ refresh_token: sbSession.refresh_token })
    });
    if(!res.ok) return false;
    const d = await res.json();
    if(!d.access_token) return false;
    sbSession = { access_token:d.access_token, refresh_token:d.refresh_token || sbSession.refresh_token };
    // Keep the stored session in step so a reload does not start out stale.
    try{
      const raw = localStorage.getItem('ssb.auth');
      if(raw){ const a = JSON.parse(raw); a.supabase = sbSession; localStorage.setItem('ssb.auth', JSON.stringify(a)); }
    }catch(_){}
    return true;
  }catch(_){ return false; }
}
function apiUrl(path){ return `${cfg.supabaseUrl}/rest/v1/${path}`; }
async function rest(path, opts={}){
  const mergedHeaders = { ...authHeadersFor(), ...(opts.headers || {}) };
  let res = await fetch(apiUrl(path), { ...opts, headers: mergedHeaders });
  // A 401 while carrying a JWT means the token expired or went bad. Try a
  // refresh; if that fails, drop back to the anon key rather than leaving the
  // user staring at a broken app. Only the RLS-protected screens need the JWT.
  if(res.status === 401 && sbSession && !opts.headers?.Authorization){
    const refreshed = await refreshSbSession();
    if(!refreshed) sbSession = null;
    res = await fetch(apiUrl(path), { ...opts, headers: { ...authHeadersFor(), ...(opts.headers || {}) } });
  }
  const txt = await res.text();
  if(!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : null;
}
async function selectRows(table, select='*', extra=''){ return rest(`${table}?select=${select}${extra}`); }
// True when a PostgREST error means a column doesn't exist yet (a migration
// hasn't been run on this deployment). Lets write paths retry with a legacy
// row shape instead of crashing. Covers PostgREST's schema-cache miss
// (PGRST204) and Postgres' undefined_column (42703 / "does not exist").
function isMissingColumnErr(err){
  const m = (err && err.message) || '';
  return /PGRST204|42703|schema cache|does not exist/i.test(m);
}
// Fetch EVERY row of a table in 1000-row chunks. PostgREST silently caps un-ranged
// requests at 1000 rows — invoices/payments outgrow that, so all financial tables
// must load through this helper or records quietly vanish from the UI and reports.
async function selectAllRows(table, select='*', extra=''){
  const CHUNK=1000; let out=[]; let offset=0;
  for(;;){
    const rows = await rest(`${table}?select=${select}${extra}&limit=${CHUNK}&offset=${offset}`);
    out = out.concat(rows||[]);
    if(!rows || rows.length < CHUNK) break;
    offset += CHUNK;
    if(offset > 200000) break; // safety valve
  }
  return out;
}

// ── Payment-method registry ─────────────────────────────────────────
// Built-in defaults keep the app working before the payment_methods table
// exists (pre-migration) and give legacy codes stable labels/colours forever.
// After loadInvoiceData() fetches the table, PM_LIST holds the configured
// methods; helpers below prefer it and fall back to the defaults.
const PM_DEFAULTS = [
  { code:'cash',          label:'Cash',          color:'green'  },
  { code:'bank_transfer', label:'Bank Transfer', color:'blue'   },
  { code:'duitnow',       label:'DuitNow',       color:'pink'   },
  { code:'card',          label:'Card',          color:'purple' },
  { code:'cheque',        label:'Cheque',        color:'amber'  },
  { code:'other',         label:'Other',         color:'slate'  },
];
let PM_LIST = null; // set after payment_methods table loads
function activeMethods(){
  const src = (PM_LIST&&PM_LIST.length) ? PM_LIST.filter(m=>m.is_active!==false) : PM_DEFAULTS;
  return src.slice().sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
}
function allMethods(){ return (PM_LIST&&PM_LIST.length) ? PM_LIST : PM_DEFAULTS; }
function methodDef(code){
  const c=(code||'').toLowerCase();
  return allMethods().find(m=>m.code===c) || PM_DEFAULTS.find(m=>m.code===c) || null;
}
const PM_COLORS = ['green','blue','pink','purple','amber','teal','coral','slate'];
function methodColor(code){
  const d=methodDef(code);
  if(d&&d.color) return d.color;
  // stable hash for unconfigured codes
  let h=0; const s=String(code||'other'); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  return PM_COLORS[h%PM_COLORS.length];
}
async function insertRows(table, payload, select='*'){ return rest(`${table}?select=${select}`, { method:'POST', headers:{ Prefer:'return=representation' }, body: JSON.stringify(Array.isArray(payload)?payload:[payload]) }); }
async function patchRows(table, match, payload, select='*'){
  const q = Object.entries(match).map(([k,v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, { method:'PATCH', headers:{ Prefer:'return=representation' }, body: JSON.stringify(payload) });
}
async function deleteRows(table, match, select='*'){
  const q = Object.entries(match).map(([k,v]) => `&${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('');
  return rest(`${table}?select=${select}${q}`, { method:'DELETE', headers:{ Prefer:'return=representation' } });
}

// ───────────────────────────────────────────────────────────────────── helpers

function toDateStr(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fromDateStr(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
function todayStr(){ return toDateStr(new Date()); }
function minuteToTime(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return `${h}:${String(m).padStart(2,'0')} ${ampm}`; }
// Short time: drops :00 on the hour — "8 AM", "5 PM", "10:30 AM"
function shortTime(mins){ const h24=Math.floor(mins/60), m=mins%60, ampm=h24<12?'AM':'PM', h=h24%12||12; return m===0?`${h} ${ampm}`:`${h}:${String(m).padStart(2,'0')} ${ampm}`; }
function shortRange(startMin,durMin){ return `${shortTime(startMin)}–${shortTime(startMin+durMin)}`; }
// Compact label for whole-hour agenda rows: "10 AM", "12 PM", "1:30 PM".
function hourLabel(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return m === 0 ? `${h} ${ampm}` : `${h}:${String(m).padStart(2,'0')} ${ampm}`; }
// Display-only: shorten a full name to its first two words ("Ashton Ang Zi Yang" → "Ashton Ang"). Full name is untouched in the database.
function shortName(name){ const parts = String(name || '').trim().split(/\s+/).filter(Boolean); return parts.slice(0, 3).join(' '); }
// clip20: truncate name to 20 chars max (with ellipsis) for tight weekly grid cells
function clip22(name){ const n = shortName(name); return n.length > 18 ? n.slice(0, 17) + '…' : n; }
// toTitleCase: capitalize first letter of every word; used to auto-correct name inputs
function toTitleCase(s){ return (s||'').replace(/\b\w/g, c => c.toUpperCase()); }
// Age shown in years, e.g. " (5)". Blank when unknown.
function ageSuffix(s){ return (s && s.age !== null && s.age !== undefined && s.age !== '') ? ` (${s.age})` : ''; }
// Compute total months between a DOB and today. Birthday-aware (subtracts a
// month if today is before the day-of-month). Returns null on invalid input.
function ageMonthsFromDob(dob){
  if(!dob) return null;
  try{
    const d = (typeof dob === 'string') ? fromDateStr(dob) : new Date(dob);
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if(now.getDate() < d.getDate()) months--;
    return Math.max(0, months);
  } catch(_){ return null; }
}
// Display age: half-year precision for under-5s (e.g. 1.5, 2.0, 4.5),
// integer years for 5+. Matches the precision the swim school actually
// uses when slotting toddlers into age-banded classes.
function ageFromDob(dob){
  const m = ageMonthsFromDob(dob);
  if(m == null) return null;
  if(m < 60) return Math.floor(m / 6) / 2;
  return Math.floor(m / 12);
}
function ageDisplay(age){
  if(age === null || age === undefined || age === '') return '—';
  return `${age}y`;
}
function studentLabel(s){ return s.name + ageSuffix(s) + (s && s.remark ? ` — ${s.remark}` : ''); }
// Build the modal's student rows: existing students first, padded with blanks
// up to the lesson type's ratio (so "max 4" shows 4 boxes). Falls back to 4.
function buildStudentRows(existing, cap){
  const rows = (existing || []).map(s => ({ studentId: s.studentId || null, name: s.name || '', age: (s.age === null || s.age === undefined ? '' : String(s.age)), remark: s.remark || '', attendance: s.attendance || 'pending' }));
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, rows.length, 1);
  while(rows.length < target) rows.push({ studentId:null, name:'', age:'', remark:'', attendance:'pending' });
  return rows;
}
// Re-normalize rows when the lesson type changes: keep filled rows, pad to the new ratio.
function rebuildRowsForCap(rows, cap){
  const filled = (rows || []).filter(r => (r.name || '').trim() || r.studentId);
  const c = Number(cap) > 0 ? Number(cap) : 4;
  const target = Math.max(c, filled.length, 1);
  const out = filled.slice();
  while(out.length < target) out.push({ studentId:null, name:'', age:'', remark:'', attendance:'pending' });
  return out;
}
function formatRange(startMin, durationMin){ return `${minuteToTime(startMin)}–${minuteToTime(startMin + durationMin)}`; }
// Compact form for tight cards: drops ":00" and the space before AM/PM, keeps
// non-zero minutes ("11AM", "11:30AM", "12PM-1PM").
function compactTime(mins){ const h24 = Math.floor(mins / 60), m = mins % 60, ampm = h24 < 12 ? 'AM' : 'PM'; const h = h24 % 12 || 12; return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2,'0')}${ampm}`; }
function compactRange(startMin, durationMin){ return `${compactTime(startMin)}-${compactTime(startMin + durationMin)}`; }
function longDate(s){ return fromDateStr(s).toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }); }
function monthCells(d){ const y=d.getFullYear(), m=d.getMonth(); const first=new Date(y,m,1); const offset=(first.getDay()+6)%7; const start=new Date(y,m,1-offset); return Array.from({length:42},(_,i)=>{ const x=new Date(start); x.setDate(start.getDate()+i); return x; }); }
function monthKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function dateToWeekdayIndex(dateStr){ return (fromDateStr(dateStr).getDay() + 6) % 7; }
function excludeFromStudentTotals(sessionType){
  const t = String(sessionType || '').toLowerCase();
  return t.includes('replacement') || t.includes('trial');
}
function weekBounds(dateStr){ const d = fromDateStr(dateStr); const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay()+6)%7)); const sunday = new Date(monday); sunday.setDate(monday.getDate()+6); return { start:monday, end:sunday }; }
function weekStartStr(dateStr){ return toDateStr(weekBounds(dateStr).start); }
function addDays(dateStr, days){ const d = fromDateStr(dateStr); d.setDate(d.getDate()+days); return toDateStr(d); }

// M2: dynamic grid bounds from operating_hours rows. Falls back to 8 AM - 9 PM.
// Uses the widest window across all open days so days that close earlier just
// show empty cells past their close time.
function computeGridBounds(operatingHours){
  const open = (operatingHours || []).filter(h => h.is_open !== false);
  if(!open.length) return { startMin: DEFAULT_OPEN, endMin: DEFAULT_CLOSE };
  const startMin = Math.min(...open.map(h => Number(h.open_minute)));
  const endMin   = Math.max(...open.map(h => Number(h.close_minute)));
  // Snap to the SLOT_MIN grid so row arithmetic stays clean.
  return {
    startMin: Math.floor(startMin / SLOT_MIN) * SLOT_MIN,
    endMin:   Math.ceil(endMin / SLOT_MIN) * SLOT_MIN
  };
}

// M2: mirrors the Postgres pool_occupancy() rounding so JS and DB agree on
// when one session blocks another.
function sessionCapacity(session, lessonType){
  const ratio = Number((lessonType && lessonType.students_per_instructor) || 0);
  const instCount = Math.max(0, (session.instructors || []).length);
  const max = ratio > 0 ? ratio * Math.max(1, instCount) : 0;
  const current = (session.students || []).length;
  let status = 'unknown';
  if(max > 0){
    if(current > max) status = 'over';
    else if(current === max) status = 'full';
    else if(current / max >= 0.8) status = 'tight';
    else status = 'open';
  }
  // Manual lock: scheduler marked the class full (e.g. wide skill spread
  // means the instructor can't absorb another swimmer even under ratio).
  const locked = session.markedFull === true;
  if(locked && status !== 'over') status = 'full';
  return { current, max, status, locked };
}

function capacityChipColors(status){
  switch(status){
    case 'open':  return { bg:'#E4F6EC', tx:'#138A53', bd:'#BFE8CF' };
    case 'tight': return { bg:'#FCEFD6', tx:'#B45309', bd:'#F2DCA8' };
    case 'full':  return { bg:'#FCE7D6', tx:'#C2410C', bd:'#F3D2B0' };
    case 'over':  return { bg:'#FCE7E7', tx:'#D63B3B', bd:'#F3C9C9' };
    default:      return { bg:'#F0F0F5', tx:'#6C6C7E', bd:'#E1E1EC' };
  }
}

// M2: print helpers preserved as before.
function printWeeklyView(){ document.body.setAttribute('data-print-view','weekly'); window.print(); setTimeout(()=>document.body.removeAttribute('data-print-view'),300); }
function printDailyView(dateStr){ document.body.setAttribute('data-print-view','daily'); document.body.setAttribute('data-print-date', dateStr || ''); window.print(); setTimeout(()=>{document.body.removeAttribute('data-print-view'); document.body.removeAttribute('data-print-date');},300); }
function printWeeklyTable(){ const s=document.createElement('style'); s.id='wt-page-style'; s.textContent='@page{size:A3 landscape;margin:8mm}'; document.head.appendChild(s); document.body.setAttribute('data-print-view','weekly-table'); window.print(); setTimeout(()=>{ document.body.removeAttribute('data-print-view'); const el=document.getElementById('wt-page-style'); if(el) el.remove(); },500); }

// M2: assign _col / _total within a set of overlapping sessions. Extracted from
// the prior inline logic so it can be reused per (day, pool) tuple.
function packParallelColumns(items){
  const sorted = items.slice().sort((a,b) =>
    a.startMinute - b.startMinute ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    String(a.id).localeCompare(String(b.id)));
  const cols = [];
  const out = [];
  sorted.forEach(item => {
    const end = item.startMinute + item.durationMinutes;
    let idx = 0;
    while(idx < cols.length && cols[idx] > item.startMinute) idx++;
    cols[idx] = end;
    out.push({ ...item, _col: idx });
  });
  const total = Math.max(cols.length, 1);
  return out.map(x => ({ ...x, _total: total }));
}

// ============================================================================
// App
// ============================================================================

// M2.1: human week-range label, e.g. "May 25 – 31, 2026" or "May 25 – Jun 1, 2026".
// Compact form for phone sub-bars: "Aug 10–16" / "Aug 31–Sep 6" (no year)
function weekRangeLabelShort(wkStart){
  const start = fromDateStr(wkStart);
  const end = new Date(start); end.setDate(start.getDate()+6);
  const sM = start.toLocaleDateString(undefined,{month:'short'});
  const eM = end.toLocaleDateString(undefined,{month:'short'});
  return sM===eM ? `${sM} ${start.getDate()}–${end.getDate()}` : `${sM} ${start.getDate()}–${eM} ${end.getDate()}`;
}
function weekRangeLabel(wkStart){
  const start = fromDateStr(wkStart);
  const end = new Date(start); end.setDate(start.getDate()+6);
  const sM = start.toLocaleDateString(undefined,{month:'short'});
  const eM = end.toLocaleDateString(undefined,{month:'short'});
  const sY = start.getFullYear(), eY = end.getFullYear();
  if(sY !== eY) return `${sM} ${start.getDate()}, ${sY} – ${eM} ${end.getDate()}, ${eY}`;
  if(sM === eM) return `${sM} ${start.getDate()} – ${end.getDate()}, ${eY}`;
  return `${sM} ${start.getDate()} – ${eM} ${end.getDate()}, ${eY}`;
}

// M2.1: one navigation band shared by Weekly and Daily. A week stepper with a
// readable range label, a "This Week" reset, and a right-aligned actions slot.
function PeriodNav({ rangeLabel, onPrev, onNext, onToday, isCurrent, children }){
  return <div className="period-nav">
    <div className="period-nav-left">
      <div className="period-stepper">
        <button className="step-btn" onClick={onPrev} title="Previous week" aria-label="Previous week">‹</button>
        <div className="period-label">{rangeLabel}</div>
        <button className="step-btn" onClick={onNext} title="Next week" aria-label="Next week">›</button>
      </div>
      <button className={`today-btn ${isCurrent?'is-current':''}`} onClick={onToday} disabled={isCurrent} title="Jump to the current week">This Week</button>
    </div>
    {children ? <div className="period-nav-actions">{children}</div> : null}
  </div>;
}

function App({ currentUser, onLogout }){
  const [view,setView] = useState(()=>{
    // Admin (procurement) lands directly in Directory. Others start on Schedule.
    if(currentUser && currentUser.role==='admin') return 'adminDirectory';
    return 'schedule';
  });
  const [scheduleSection,setScheduleSection] = useState('week'); // 'week'|'day'|'month'
  // ── Programme planner (event & workout planning calendar) ──────────────
  const [programmeSection,setProgrammeSection] = useState('week'); // 'week'|'month'
  const [programmeSessions,setProgrammeSessions] = useState([]);
  const [programmeCategories,setProgrammeCategories] = useState([]);
  const [billingTerms,setBillingTerms] = useState([]);
  const [products,setProducts] = useState([]);
  const isSysadmin = (currentUser?.role === 'sysadmin');
  const canSchedule = canUseScheduler(currentUser?.role);
  const canSystem = canUseAdminSystem(currentUser?.role);
  // Two-side app: 'schedule' or 'system'. Sysadmin defaults to schedule side
  // and can toggle. Admin (procurement) is pinned to system side. Anyone with
  // scheduler-only access is pinned to schedule side.
  const [side,setSide] = useState(()=>{
    if(!canSchedule && canSystem) return 'system';
    return 'schedule';
  });
  const isMobile = useIsMobile();
  const [mobileMoreOpen,setMobileMoreOpen] = useState(false);
  // The 7-column week grid is unusable on a phone — steer mobile users to
  // the Daily agenda whenever Weekly would render.
  useEffect(()=>{ if(isMobile && view==='schedule' && scheduleSection==='week') setScheduleSection('day'); },[isMobile, view, scheduleSection]);
  useEffect(()=>{ setMobileMoreOpen(false); },[view, side]);
  function switchSide(next){
    setSide(next);
    if(next==='system') setView('adminDirectory');
    else setView('schedule');
  }
  // Robust: header rendering follows the CURRENT VIEW, not a separate `side`
  // state, so the header can never drift out of sync with the content area.
  const isOnSystemView = ['adminDirectory','adminVouchers','adminCrew','adminPromos','attendance'].includes(view);
  // Defensive: if view and side ever get out of sync (e.g. after login flow
  // or a stale route), snap view back to the side's home. Prevents the
  // "half-breed" state where system nav is shown but schedule content mounts.
  useEffect(()=>{
    const scheduleViews = new Set(['schedule','programme','accounts','shop','messages','enroll','settings','students']);
    const systemViews = new Set(['adminDirectory','adminVouchers','adminCrew','adminPromos','attendance']);
    if(side==='schedule' && systemViews.has(view)) setView('schedule');
    if(side==='system' && scheduleViews.has(view)) setView('adminDirectory');
  }, [side, view]);
  const [contactMessages,setContactMessages] = useState([]);
  const newMsgCount = useMemo(()=> (contactMessages||[]).filter(m=>m.status==='new').length, [contactMessages]);
  const [appUsers,setAppUsers] = useState([]);
  // ── Admin & Procurement (System side) data ──
  const [adminCategories,setAdminCategories] = useState([]);
  const [adminCompanies,setAdminCompanies] = useState([]);
  const [adminContacts,setAdminContacts] = useState([]);
  const [adminPayees,setAdminPayees] = useState([]);
  const [adminVouchers,setAdminVouchers] = useState([]);
  const [adminEmployees,setAdminEmployees] = useState([]);
  const [adminCrewLoadFailed,setAdminCrewLoadFailed] = useState(false);
  // ── Attendance module (geofenced punch clock) ──
  // Reads RLS-protected tables, so these calls only succeed once the signed-in
  // user carries a Supabase JWT (Phase 2). Before that they fail closed and
  // the section shows a plain explanation rather than an empty grid.
  const [attendanceSection,setAttendanceSection] = useState('live');
  const [attLocations,setAttLocations] = useState([]);
  const [attCategories,setAttCategories] = useState([]);
  const [attShifts,setAttShifts] = useState([]);
  const [attSettings,setAttSettings] = useState(null);
  const [attWeekStart,setAttWeekStart] = useState(weekStartStr(todayStr()));
  const [attBlocked,setAttBlocked] = useState(false);
  const [attToday,setAttToday] = useState([]);
  const [attPunches,setAttPunches] = useState([]);
  const [attLoadedAt,setAttLoadedAt] = useState(null);
  const [attReportMode,setAttReportMode] = useState('month');
  const [attReportAnchor,setAttReportAnchor] = useState(todayStr());
  const [attReportShifts,setAttReportShifts] = useState([]);
  const [attAlerts,setAttAlerts] = useState([]);
  const [attAlertShifts,setAttAlertShifts] = useState([]);
  const [attAlertFilter,setAttAlertFilter] = useState('open');
  const [attOpenAlertCount,setAttOpenAlertCount] = useState(0);
  const [promos,setPromos] = useState([]);
  const [programmeModal,setProgrammeModal] = useState(null);
  const [programmeDate,setProgrammeDate] = useState(todayStr());     // own week cursor (independent of Schedule)
  const [programmeMonthCursor,setProgrammeMonthCursor] = useState(new Date());
  const [programmePoolId,setProgrammePoolId] = useState(null);
  const [adminSection,setAdminSection] = useState('pools');      // 'summary'|'pools'|'instructors'|'lessonTypes'
  const [accountSection,setAccountSection] = useState('accounts');
  // Clear sticky search box when switching account sub-tabs
  useEffect(() => { setAccountSearchQ(''); }, [accountSection]); // 'accounts'|'familyGroups'|'invoices'|'receipts'|'pendingCredits'|'aging'|'codes'
  const [loading,setLoading] = useState(true);
  const [status,setStatus] = useState('');
  const [error,setError] = useState('');
  const [sessions,setSessions] = useState([]);
  const [students,setStudents] = useState([]);
  const [familyGroups,setFamilyGroups] = useState([]);
  const [groupMemberships,setGroupMemberships] = useState([]);
  const [creditBalances,setCreditBalances] = useState([]);
  const [creditPurchases,setCreditPurchases] = useState([]);
  const [subscriptions,setSubscriptions] = useState([]);
  const [codes,setCodes] = useState([]);
  const [replacementPending,setReplacementPending] = useState([]);
  const [tcAcceptances,setTcAcceptances] = useState([]);
  const [remarks,setRemarks] = useState({});
  const [options,setOptions] = useState({ instructors:[], durations:[], lessonTypes:[], pools:[], operatingHours:[], packages:[], branches:[] });
  const [monthCursor,setMonthCursor] = useState(new Date());
  const [selectedDate,setSelectedDate] = useState(todayStr());
  const [selectedPoolId,setSelectedPoolId] = useState(null);
  // Search box lifted to App so it can live in the sticky sub-bar
  const [accountSearchQ, setAccountSearchQ] = useState('');
  // Branch filter — remembered across sessions; defaults to last selection or HQ.
  const [currentBranchId,setCurrentBranchIdRaw] = useState(() => {
    try{ return window.localStorage.getItem('ssb.currentBranchId') || null; }catch(_){ return null; }
  });
  function setCurrentBranchId(id){
    setCurrentBranchIdRaw(id);
    setSelectedPoolId(null); // reset pool filter when branch changes
    try{ if(id) window.localStorage.setItem('ssb.currentBranchId', id);
         else window.localStorage.removeItem('ssb.currentBranchId'); }catch(_){}
  }
  const [enabledTypes,setEnabledTypes] = useState(null);
  const [selectedInstructors,setSelectedInstructors] = useState(new Set());
  const [modal,_setModal] = useState(null);
  // modalRef is always the latest modal value — updated synchronously
  // inside every setModal call so saveSession never reads stale data.
  const modalRef = React.useRef(null);
  function setModal(valOrFn){
    if(typeof valOrFn === 'function'){
      _setModal(prev => {
        const next = valOrFn(prev);
        modalRef.current = next;
        return next;
      });
    } else {
      modalRef.current = valOrFn;
      _setModal(valOrFn);
    }
  }
  const [saveBusy,setSaveBusy] = useState(false);
  const [remarkDraft,setRemarkDraft] = useState('');
  // ── Invoicing state ────────────────────────────────────────────────
  const [invoices,setInvoices] = useState([]);
  const [invoiceLines,setInvoiceLines] = useState([]);
  const [pmts,setPmts] = useState([]);
  const [pendingCredits,setPendingCredits] = useState([]);
  const [invoiceSettings,setInvoiceSettings] = useState({ invoice_prefix:'INV', receipt_prefix:'RCT', next_invoice_seq:1, next_receipt_seq:1, leading_zeros:3, include_date:true, date_format:'YYYYMM', allow_delete_invoice:false });
  const [paymentMethods,setPaymentMethods] = useState([]);
  const [websiteSettings,setWebsiteSettings] = useState(null);   // public_schedule_settings row
  const [publicPricing,setPublicPricing] = useState([]);         // public_pricing rows

  useEffect(() => { boot(); }, []);
  // Default branch on first load: prefer SSGT (HQ), else first active branch.
  useEffect(() => {
    if(currentBranchId) return;
    if(!options.branches?.length) return;
    const hq = options.branches.find(b => (b.code||'').toUpperCase() === 'SSGT') || options.branches.find(b => b.is_active !== false) || options.branches[0];
    if(hq) setCurrentBranchId(hq.id);
  }, [options.branches]);
  useEffect(() => { if(cfg.supabaseUrl && cfg.supabaseAnonKey) loadRemarks(monthCursor).catch(handleErr); }, [monthCursor]);
  useEffect(() => { setRemarkDraft(remarks[selectedDate] || ''); }, [selectedDate, remarks]);

  function handleErr(err){ console.error(err); setError(err?.message || String(err)); setStatus('Error'); }

  async function boot(){
    if(!cfg.supabaseUrl || !cfg.supabaseAnonKey){ setError('Missing config.js values.'); setLoading(false); return; }
    try{
      setLoading(true); setError('');
      // Phase 1 — critical: options + sessions needed to render the first view.
      await Promise.all([loadOptions(), loadSessions()]);
      setLoading(false);
      setStatus('Connected');
      // Phase 2 — background: load everything else after first paint.
      Promise.all([
        loadStudents(), loadGroups(), loadGroupMemberships(),
        loadCreditBalances(), loadCreditPurchases(),
        loadSubscriptions(), loadCodes(), loadReplacementPending(),
        loadTcAcceptances(), loadRemarks(monthCursor), loadInvoiceData(),
        loadProgrammeSessions(), loadProgrammeCategories(), loadBillingTerms(), loadProducts(), loadContactMessages(), loadAppUsers(), loadAdminAll()
      ]).catch(e => console.warn('Background load warning:', e));
    } catch(err){ handleErr(err); setLoading(false); }
  }

  // ── Invoice loaders ────────────────────────────────────────────────
  async function loadInvoiceData(){
    try{
      const [invRows, lineRows, payRows, pcRows, settRows, pmRows, wsRows, ppRows] = await Promise.all([
        selectAllRows('invoices','*','&order=created_at.desc'),
        selectAllRows('invoice_lines','*','&order=invoice_id.asc,sort_order.asc'),
        selectAllRows('payments','*','&order=invoice_id.asc,created_at.asc'),
        selectAllRows('pending_credits','*','&order=created_at.desc'),
        selectRows('invoice_settings','*').catch(()=>[]),
        selectRows('payment_methods','*','&order=sort_order.asc').catch(()=>[]),
        selectRows('public_schedule_settings','*').catch(()=>[]),
        selectRows('public_pricing','*','&order=category.asc,sort_order.asc').catch(()=>[]),
      ]);
      setInvoices(invRows||[]);
      setInvoiceLines(lineRows||[]);
      setPmts(payRows||[]);
      setPendingCredits(pcRows||[]);
      if(settRows?.[0]) setInvoiceSettings(settRows[0]);
      PM_LIST = (pmRows&&pmRows.length)?pmRows:null;
      setPaymentMethods(pmRows||[]);
      setWebsiteSettings(wsRows?.[0]||null);
      setPublicPricing(ppRows||[]);
    }catch(e){ console.warn('Invoice tables not found — run migrations first.',e); }
  }

  // ── Number formatting ──────────────────────────────────────────────
  // Pure helper — builds a formatted number string from a settings object
  // and a raw sequence integer. Used for live preview and generation.
  function formatInvoiceNumber(sett, seq){
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY:   `-${y}`,
      MM:     `-${m}`,
      MMYY:   `-${m}${yy}`,
      none:   '',
    }[sett.date_format||'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros)||3);
    const seqStr = String(seq).padStart(pad,'0');
    return `${sett.invoice_prefix||'INV'}${datePart}-${seqStr}`;
  }
  function formatReceiptNumber(sett, seq){
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(y).slice(-2);
    const datePart = sett.include_date !== false ? {
      YYYYMM: `-${y}${m}`,
      YYYY:   `-${y}`,
      MM:     `-${m}`,
      MMYY:   `-${m}${yy}`,
      none:   '',
    }[sett.date_format||'YYYYMM'] ?? `-${y}${m}` : '';
    const pad = Math.max(1, Number(sett.leading_zeros)||3);
    const seqStr = String(seq).padStart(pad,'0');
    return `${sett.receipt_prefix||'RCT'}${datePart}-${seqStr}`;
  }

  // Save invoice settings (upsert on id=1)
  async function saveInvoiceSettings(patch){
    try{
      await patchRows('invoice_settings',{id:1},patch);
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to save settings'); }
  }

  // ── Payment-method CRUD (global config, Settings → Payment Methods) ─
  async function addPaymentMethod({ code, label }){
    try{
      const c=(code||'').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'');
      if(!c){ alert('Code is required'); return; }
      if(allMethods().some(m=>m.code===c)){ alert(`Code "${c}" already exists`); return; }
      const maxSort = Math.max(0,...paymentMethods.map(m=>m.sort_order??0));
      await insertRows('payment_methods',{ code:c, label:(label||'').trim()||c, is_active:true, sort_order:maxSort+1 });
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to add payment method'); }
  }
  async function updatePaymentMethod(id, patch){
    try{ await patchRows('payment_methods',{id},patch); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update payment method'); }
  }
  async function movePaymentMethod(id, dir){
    // Swap sort_order with the neighbour in the given direction (-1 up, +1 down)
    const sorted = paymentMethods.slice().sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
    const i = sorted.findIndex(m=>m.id===id);
    const j = i + dir;
    if(i<0 || j<0 || j>=sorted.length) return;
    try{
      await Promise.all([
        patchRows('payment_methods',{id:sorted[i].id},{sort_order:sorted[j].sort_order??j}),
        patchRows('payment_methods',{id:sorted[j].id},{sort_order:sorted[i].sort_order??i}),
      ]);
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to reorder'); }
  }

  // ── Website (public site) settings CRUD ─────────────────────────────
  async function saveWebsiteSettings(patch){
    try{ await patchRows('public_schedule_settings',{id:1},{...patch,updated_at:new Date().toISOString()}); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to save — has the website migration been run?'); }
  }
  async function addPricingCard(card){
    try{
      const maxSort = Math.max(0,...publicPricing.filter(p=>p.category===card.category).map(p=>p.sort_order??0));
      await insertRows('public_pricing',{ ...card, sort_order:maxSort+1 });
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to add pricing card'); }
  }
  async function updatePricingCard(id, patch){
    try{ await patchRows('public_pricing',{id},patch); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update pricing card'); }
  }
  async function deletePricingCard(id){
    if(!confirm('Delete this pricing card? (Marketing content only — no financial records affected.)')) return;
    try{ await deleteRows('public_pricing',{id}); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete pricing card'); }
  }
  async function movePricingCard(id, dir){
    const card = publicPricing.find(p=>p.id===id); if(!card) return;
    const peers = publicPricing.filter(p=>p.category===card.category).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
    const i = peers.findIndex(p=>p.id===id); const j = i+dir;
    if(i<0||j<0||j>=peers.length) return;
    try{
      await Promise.all([
        patchRows('public_pricing',{id:peers[i].id},{sort_order:peers[j].sort_order??j}),
        patchRows('public_pricing',{id:peers[j].id},{sort_order:peers[i].sort_order??i}),
      ]);
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to reorder'); }
  }
  // Category order is derived from the cards: a category's position is the
  // LOWEST sort_order among its cards. Legacy tie-break (Toddlers, LTS
  // Children first) keeps existing sites stable until the first manual move.
  function orderedPricingCats(list){
    const minSort={};
    (list||[]).forEach(p=>{ const k=p.category||'General'; const s=Number(p.sort_order)||0; if(!(k in minSort)||s<minSort[k]) minSort[k]=s; });
    const pri = c => c==='Toddlers'?0 : c==='LTS Children'?1 : 2;
    return Object.keys(minSort).sort((a,b)=> (minSort[a]-minSort[b]) || (pri(a)-pri(b)) || a.localeCompare(b));
  }
  async function movePricingCategory(cat, dir){
    const cats = orderedPricingCats(publicPricing);
    const i = cats.indexOf(cat); const j = i+dir;
    if(i<0||j<0||j>=cats.length) return;
    [cats[i],cats[j]] = [cats[j],cats[i]];
    // Renumber every card 1..N following the new category order, preserving
    // within-category order — blocks become contiguous, minima distinct.
    const seq=[];
    cats.forEach(c=>{
      publicPricing
        .filter(p=>(p.category||'General')===c)
        .sort((a,b)=>((a.sort_order??0)-(b.sort_order??0)) || String(a.id).localeCompare(String(b.id)))
        .forEach(p=>seq.push(p));
    });
    try{
      const patches = seq.map((p,idx)=>({p, so:idx+1})).filter(x=>x.p.sort_order!==x.so);
      await Promise.all(patches.map(x=>patchRows('public_pricing',{id:x.p.id},{sort_order:x.so})));
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to reorder categories'); }
  }

  // ── Collision-safe number allocation ───────────────────────────────
  // The invoice_settings counter can drift out of sync with reality: a
  // manual DB edit, a deleted-then-recreated invoice, a failed insert that
  // still bumped the counter, or two devices racing can leave "next_seq"
  // pointing at a number that's already on a saved row. Reusing it trips a
  // unique-constraint error (or silently duplicates a human-facing number).
  // These helpers walk the sequence forward against a FRESH read of the
  // table until the formatted number is genuinely free, and report how many
  // numbers were stepped over so the status bar can surface the drift.
  async function nextFreeInvoiceNumber(sett, startSeq){
    let seq = Math.max(1, Number(startSeq)||1);
    const rows = await selectRows('invoices','invoice_number').catch(()=>null);
    const taken = new Set((rows||invoices||[]).map(i=>i.invoice_number).filter(Boolean));
    const from = formatInvoiceNumber(sett, seq);
    let skipped = 0;
    while(taken.has(formatInvoiceNumber(sett, seq))){ seq++; skipped++; }
    return { seq, number: formatInvoiceNumber(sett, seq), skipped, from };
  }
  async function nextFreeReceiptNumber(sett, startSeq){
    let seq = Math.max(1, Number(startSeq)||1);
    const rows = await selectRows('payments','receipt_number').catch(()=>null);
    const taken = new Set((rows||pmts||[]).map(p=>p.receipt_number).filter(Boolean));
    const from = formatReceiptNumber(sett, seq);
    let skipped = 0;
    while(taken.has(formatReceiptNumber(sett, seq))){ seq++; skipped++; }
    return { seq, number: formatReceiptNumber(sett, seq), skipped, from };
  }

  // ── Invoice CRUD ───────────────────────────────────────────────────
  async function createInvoice({ accountName, accountEmail, accountPhone, lines, notes, dueDate, branchId }){
    // Read current settings (fresh from DB to get latest seq)
    const settRows = await selectRows('invoice_settings','*').catch(()=>[]);
    const sett = settRows?.[0] || invoiceSettings;
    const startSeq = Number(sett.next_invoice_seq)||1;
    // Walk forward past any number already taken (counter drift / races).
    const { seq, number: invoiceNumber, skipped, from } = await nextFreeInvoiceNumber(sett, startSeq);
    // Increment counter immediately so concurrent creates don't collide
    await patchRows('invoice_settings',{id:1},{next_invoice_seq: seq+1}).catch(()=>{});
    if(skipped) setStatus(`Invoice # ${from} was already taken — skipped ${skipped} number${skipped===1?'':'s'} to ${invoiceNumber}.`);
    const totalAmount = lines.reduce((s,l)=>s+Number(l.amount||0),0);
    const now = new Date();
    const inserted = await insertRows('invoices',{
      invoice_number:invoiceNumber, account_name:accountName,
      account_email:accountEmail||null, account_phone:accountPhone||null,
      status:'draft', issue_date:toDateStr(now), due_date:dueDate||null,
      notes:notes||null, total_amount:totalAmount, amount_paid:0,
      branch_id: (branchId !== undefined) ? (branchId || null) : (currentBranchId && currentBranchId !== 'all' ? currentBranchId : null)
    });
    const invoiceId = inserted?.[0]?.id;
    if(invoiceId && lines.length){
      await insertRows('invoice_lines', lines.map((l,i)=>({
        invoice_id:invoiceId, description:l.description,
        lesson_type_name:l.lessonTypeName||null, lesson_type_id:l.lessonTypeId||null,
        package_name:l.packageName||null, package_id:l.packageId||null,
        family_group_id:l.familyGroupId||null, family_group_name:l.familyGroupName||null,
        student_names:l.studentNames||null, student_ids:l.studentIds||null,
        amount:Number(l.amount||0), quantity:l.quantity||1, is_billable:true,
        line_type:l.lineType||'package',
        credits_per_swimmer:l.creditsPerSwimmer||null, billing_mode:l.billingMode||null,
        sort_order:i
      })));
    }
    await loadInvoiceData();
    return invoiceId;
  }

  // Point-of-sale: create a product invoice (cash sale or against an account)
  // and, if paid now, immediately record the payment/receipt. Returns the
  // invoice + payment for on-screen confirmation and receipt printing.
  async function createProductSale({ buyerName, buyerEmail, buyerPhone, branchId, lines, paid, paymentMethod, paymentDate, notes }){
    const invoiceId = await createInvoice({
      accountName: buyerName || 'Cash Sale', accountEmail: buyerEmail || null, accountPhone: buyerPhone || null,
      lines, notes: notes || null, dueDate: null, branchId: branchId || null
    });
    if(!invoiceId) throw new Error('Failed to create invoice');
    const total = lines.reduce((s,l)=>s+Number(l.amount||0),0);
    let payment = null;
    if(paid && total>0){
      const res = await recordPayment({ invoiceId, amount: total, paymentDate: paymentDate || todayStr(), paymentMethod: paymentMethod || 'cash', referenceNumber: null, notes: notes || 'Product sale' });
      payment = { receipt_number: res?.receiptNumber || null, amount: total, payment_date: paymentDate || todayStr(), payment_method: paymentMethod || 'cash' };
    }
    const invRows = await selectRows('invoices','*',`&id=eq.${invoiceId}`).catch(()=>[]);
    const invoice = invRows?.[0] || { id:invoiceId, account_name: buyerName, account_phone: buyerPhone||null, total_amount: total, amount_paid: paid?total:0 };
    return { invoice, payment, invoiceId };
  }

  async function recordPayment({ invoiceId, amount, paymentDate, paymentMethod, referenceNumber, notes:pNotes }){
    // Read current settings (fresh) for receipt number
    const settRows = await selectRows('invoice_settings','*').catch(()=>[]);
    const sett = settRows?.[0] || invoiceSettings;
    const startSeq = Number(sett.next_receipt_seq)||1;
    // Walk forward past any receipt number already taken (counter drift / races).
    const { seq, number: receiptNumber, skipped, from } = await nextFreeReceiptNumber(sett, startSeq);
    await patchRows('invoice_settings',{id:1},{next_receipt_seq: seq+1}).catch(()=>{});
    if(skipped) setStatus(`Receipt # ${from} was already taken — skipped ${skipped} number${skipped===1?'':'s'} to ${receiptNumber}.`);
    const inserted = await insertRows('payments',{
      invoice_id:invoiceId, receipt_number:receiptNumber,
      amount:Number(amount), payment_date:paymentDate||todayStr(),
      payment_method:paymentMethod||'cash',
      reference_number:referenceNumber||null, notes:pNotes||null
    });
    const paymentId = inserted?.[0]?.id;
    // Seed pending_credits from billable lines
    if(paymentId){
      const invLines = invoiceLines.filter(l=>l.invoice_id===invoiceId && l.is_billable);
      const creditRows = [];
      // NOTE: PostgREST bulk inserts require every object in the array to have
      // IDENTICAL keys (else PGRST102 "All object keys must match"). Family rows
      // and per-student rows must therefore both carry family_group_id AND
      // student_id, with explicit nulls for whichever doesn't apply.
      invLines.forEach(l=>{
        if(l.family_group_id){
          creditRows.push({ invoice_id:invoiceId, payment_id:paymentId,
            family_group_id:l.family_group_id, student_id:null,
            lesson_type_id:l.lesson_type_id??null,
            package_id:l.package_id??null, description:l.description??null,
            credits_per_swimmer:l.credits_per_swimmer||4, status:'pending' });
        } else if(l.student_ids){
          l.student_ids.split(',').map(s=>s.trim()).filter(Boolean).forEach(sid=>{
            creditRows.push({ invoice_id:invoiceId, payment_id:paymentId,
              family_group_id:null, student_id:sid,
              lesson_type_id:l.lesson_type_id??null,
              package_id:l.package_id??null, description:l.description??null,
              credits_per_swimmer:l.credits_per_swimmer||4, status:'pending' });
          });
        }
      });
      if(creditRows.length) await insertRows('pending_credits',creditRows);
    }
    // Recalculate invoice status
    const invoice = invoices.find(i=>i.id===invoiceId);
    const existingPaid = pmts.filter(p=>p.invoice_id===invoiceId).reduce((s,p)=>s+Number(p.amount),0);
    const totalPaid = existingPaid + Number(amount);
    const newStatus = totalPaid >= Number(invoice?.total_amount||0) ? 'paid' : totalPaid>0 ? 'partial' : 'sent';
    await patchRows('invoices',{id:invoiceId},{amount_paid:totalPaid,status:newStatus,updated_at:new Date().toISOString()});
    await loadInvoiceData();
    return { receiptNumber };
  }

  async function confirmCredit(credit){
    // Write credits directly — skips the `subscriptions` table (which is
    // optional / not yet migrated) and writes straight to credit_purchases
    // + student_credit_balances, which are always present.
    try{
      const creditsNum = credit.credits_per_swimmer || 4;
      const date = toDateStr(new Date());
      // Resolve which swimmers receive the credit
      let affectedStudents = [];
      if(credit.family_group_id){
        const members = (membersByGroup && membersByGroup[credit.family_group_id]) || [];
        affectedStudents = credit.lesson_type_id
          ? members.filter(m => (m.lessonTypeIds || []).includes(credit.lesson_type_id))
          : members;
      } else if(credit.student_id){
        const stu = studentById[credit.student_id];
        if(stu) affectedStudents = [stu];
      }
      if(!affectedStudents.length){ alert('No swimmers found to credit.'); return; }
      // Insert credit_purchases rows
      await insertRows('credit_purchases', affectedStudents.map(s => ({
        student_id: s.id, lesson_type_id: credit.lesson_type_id,
        purchase_date: date, credits_added: creditsNum,
        source: 'pending_credit_confirmed', notes: `Confirmed from pending credit ${credit.id}`
      })));
      // Bump each balance
      for(const s of affectedStudents){
        await bumpBalance(s.id, credit.lesson_type_id, creditsNum);
      }
      // Mark the pending credit as confirmed
      await patchRows('pending_credits',{id:credit.id},{
        status:'confirmed', confirmed_at: new Date().toISOString()
      });
      await Promise.all([loadCreditBalances(), loadInvoiceData(), loadStudents()]);
      setStatus(`Confirmed: +${creditsNum} credits to ${affectedStudents.length} swimmer${affectedStudents.length===1?'':'s'}.`);
    }catch(err){ handleErr(err); alert(err.message||'Failed to confirm credit'); }
  }

  async function reverseCredit(credit){
    if(!confirm('Reverse this pending credit? Credits will not be allocated.')) return;
    try{
      await patchRows('pending_credits',{id:credit.id},{status:'reversed',reversed_at:new Date().toISOString()});
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to reverse'); }
  }

  async function voidInvoice(id, reason){
    try{
      await deleteRows('payments',{invoice_id:id}).catch(()=>{});
      await deleteRows('pending_credits',{invoice_id:id}).catch(()=>{});
      await patchRows('invoices',{id},{status:'void', amount_paid:0, void_reason:(reason||'').slice(0,100)||null, voided_at:new Date().toISOString(), updated_at:new Date().toISOString()});
      await loadInvoiceData();
    } catch(err){ handleErr(err); alert(err.message||'Failed to void'); }
  }

  // Refund a genuinely-paid invoice: records a negative "refund" receipt against
  // it and marks the invoice 'refunded'. Because every cash report and the
  // Receipts list read the payments table, the negative entry nets the cash out
  // automatically. (For invoices raised in error, use Void instead.)
  async function refundInvoice({ invoiceId, amount, refundDate, method, reference, reason }){
    const amt = Math.abs(Number(amount) || 0);
    if(!amt){ alert('Enter a valid refund amount.'); return; }
    try{
      const settRows = await selectRows('invoice_settings','*').catch(()=>[]);
      const sett = settRows?.[0] || invoiceSettings;
      const startSeq = Number(sett.next_receipt_seq) || 1;
      // Walk forward past any receipt number already taken (counter drift / races).
      const { seq, number: receiptNumber, skipped, from } = await nextFreeReceiptNumber(sett, startSeq);
      await patchRows('invoice_settings',{id:1},{next_receipt_seq: seq+1}).catch(()=>{});
      if(skipped) setStatus(`Receipt # ${from} was already taken — skipped ${skipped} number${skipped===1?'':'s'} to ${receiptNumber}.`);
      await insertRows('payments',{
        invoice_id: invoiceId, receipt_number: receiptNumber, kind: 'refund',
        amount: -amt, payment_date: refundDate || todayStr(),
        payment_method: method || 'cash',
        reference_number: reference || null,
        notes: reason ? `Refund: ${reason}` : 'Refund'
      });
      // Recompute amount_paid from all payments (the negative refund is included).
      const pays = await selectRows('payments','*',`&invoice_id=eq.${invoiceId}`).catch(()=>[]);
      const paid = (pays||[]).reduce((s,p)=>s+Number(p.amount||0),0);
      await patchRows('invoices',{id:invoiceId},{ amount_paid: paid, status:'refunded', updated_at:new Date().toISOString() });
      await loadInvoiceData();
    } catch(err){ handleErr(err); alert(err.message||'Failed to record refund'); }
  }

  async function deleteInvoice(id){
    if(!confirm('Permanently delete this invoice, all its lines, and all payments? This cannot be undone.')) return;
    try{
      await deleteRows('payments',{invoice_id:id});
      await deleteRows('pending_credits',{invoice_id:id}).catch(()=>{});
      await deleteRows('invoice_lines',{invoice_id:id});
      await deleteRows('invoices',{id});
      await loadInvoiceData();
    } catch(err){ handleErr(err); alert(err.message||'Failed to delete invoice'); }
  }

  // Add or amend the void reason on an already-voided invoice (reason-only
  // patch — does not touch payments/credits, which void already handled).
  async function updateVoidReason(id, reason){
    try{
      await patchRows('invoices',{id},{ void_reason:(reason||'').slice(0,100)||null, updated_at:new Date().toISOString() });
      await loadInvoiceData();
    } catch(err){ handleErr(err); alert(err.message||'Failed to update void reason'); }
  }

  async function updateInvoiceStatus(id,newStatus){
    try{ await patchRows('invoices',{id},{status:newStatus,updated_at:new Date().toISOString()}); await loadInvoiceData(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update status'); }
  }

  // ── Invoice line CRUD (Phase 2) ────────────────────────────────────
  async function recalcInvoiceTotal(invoiceId){
    // Re-sum billable lines and push to invoices.total_amount
    const lines = invoiceLines.filter(l=>l.invoice_id===invoiceId && l.is_billable);
    const total = lines.reduce((s,l)=>s+Number(l.amount||0),0);
    await patchRows('invoices',{id:invoiceId},{total_amount:total,updated_at:new Date().toISOString()});
  }

  async function addInvoiceLine(invoiceId, lineData){
    try{
      const existing = invoiceLines.filter(l=>l.invoice_id===invoiceId);
      const qty = Math.max(1, Number(lineData.quantity)||1);
      // If a unit price is given, amount = qty × unit; otherwise treat amount as the line total.
      const amount = lineData.unitPrice != null ? (Number(lineData.unitPrice)||0) * qty : (Number(lineData.amount)||0);
      await insertRows('invoice_lines',{
        invoice_id:invoiceId, description:lineData.description||'Custom line',
        amount:amount, quantity:qty, is_billable:true,
        line_type:lineData.lineType||'product',
        lesson_type_name:lineData.lessonTypeName||null, package_name:lineData.packageName||null,
        sort_order: existing.length
      });
      await loadInvoiceData();
      // Recalc after reload so new line is in invoiceLines
      const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${invoiceId}&is_billable=eq.true`).catch(()=>[]);
      const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
      await patchRows('invoices',{id:invoiceId},{total_amount:total,updated_at:new Date().toISOString()});
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to add line'); }
  }

  async function updateInvoiceLine(lineId, patch){
    try{
      await patchRows('invoice_lines',{id:lineId},patch);
      // Find the invoice this line belongs to
      const line = invoiceLines.find(l=>l.id===lineId);
      if(line){
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(()=>[]);
        const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
        await patchRows('invoices',{id:line.invoice_id},{total_amount:total,updated_at:new Date().toISOString()});
      }
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to update line'); }
  }

  async function deleteInvoiceLine(lineId){
    if(!confirm('Remove this line from the invoice?')) return;
    try{
      const line = invoiceLines.find(l=>l.id===lineId);
      await deleteRows('invoice_lines',{id:lineId});
      if(line){
        await loadInvoiceData();
        const refreshed = await selectRows('invoice_lines','*',`&invoice_id=eq.${line.invoice_id}&is_billable=eq.true`).catch(()=>[]);
        const total = (refreshed||[]).reduce((s,l)=>s+Number(l.amount||0),0);
        await patchRows('invoices',{id:line.invoice_id},{total_amount:total,updated_at:new Date().toISOString()});
      }
      await loadInvoiceData();
    }catch(err){ handleErr(err); alert(err.message||'Failed to delete line'); }
  }

  // M2: also loads pools and operating_hours.
  async function loadOptions(){
    const [instructors, durations, lessonTypes, pools, operatingHours, packages, branches] = await Promise.all([
      selectRows('scheduler_instructors', '*', '&order=sort_order.asc,name.asc'),
      selectRows('scheduler_durations', '*', '&order=sort_order.asc,slots.asc'),
      selectRows('scheduler_lesson_types', '*', '&order=sort_order.asc,name.asc'),
      selectRows('pools', '*', '&order=sort_order.asc,name.asc'),
      selectRows('operating_hours', '*', '&order=weekday.asc'),
      selectRows('packages', '*', '&order=sort_order.asc,name.asc').catch(()=>[]),
      selectRows('branches', '*', '&order=sort_order.asc,name.asc').catch(()=>[])
    ]);
    setOptions({
      instructors: instructors || [],
      durations: durations || [],
      lessonTypes: lessonTypes || [],
      pools: pools || [],
      operatingHours: operatingHours || [],
      packages: packages || [],
      branches: branches || []
    });
    // Expose branches to module-level print helpers (printInvoice, printReceipt)
    // which sit outside the App component and need to resolve invoice.branch_id.
    try{ window.__SSB_BRANCHES__ = branches || []; }catch(_){}
  }

  // M2: students are loaded via PostgREST resource embedding (nested inside
  // each session row) rather than a separate flat query. This bypasses the
  // Supabase default 1000-row limit on weekly_session_students — when the
  // table exceeded 1000 rows, newly saved students were silently cut off.
  async function loadSessions(){
    const [sessionRows, instructorJoinRows, instructorCatalog] = await Promise.all([
      selectAllRows('weekly_sessions','*,weekly_session_students(*)','&order=week_start_date.asc,weekday.asc,start_minute.asc,created_at.asc'),
      selectAllRows('session_instructors', '*'),
      selectRows('scheduler_instructors', '*')
    ]);
    const instructorById = {};
    (instructorCatalog || []).forEach(i => { instructorById[i.id] = i; });
    const instructorsBySession = {};
    (instructorJoinRows || []).forEach(r => {
      const key = String(r.session_id);
      if(!instructorsBySession[key]) instructorsBySession[key] = [];
      const inst = instructorById[r.instructor_id];
      if(inst) instructorsBySession[key].push({ id: inst.id, name: inst.name });
    });
    const merged = (sessionRows || []).map(r => {
      const students = (r.weekly_session_students || []).map(s => ({
        id: s.id, studentId: s.student_id || null, name: s.student_name || '',
        age: (s.student_age === null || s.student_age === undefined) ? null : Number(s.student_age),
        remark: s.remark || '', isReplacement: !!s.is_replacement,
        replacementFrom: s.replacement_from || '', attendance: s.attendance_status || 'pending'
      }));
      return {
        id: r.id,
        weekStartDate: r.week_start_date || weekStartStr(todayStr()),
        day: Number(r.weekday) - 1,
        startMinute: Number(r.start_minute),
        durationMinutes: Number(r.duration_minutes),
        type: r.lesson_type || '',
        lessonTypeId: r.lesson_type_id || null,
        poolId: r.pool_id || null,
        familyGroupId: r.family_group_id || null,
        legacyInstructor: r.instructor || '',
        markedFull: r.marked_full === true,
        rescheduledFromDay: r.rescheduled_from_day != null ? Number(r.rescheduled_from_day) - 1 : null,
        rescheduledFromStartMinute: r.rescheduled_from_start_minute != null ? Number(r.rescheduled_from_start_minute) : null,
        cancelledAt: r.cancelled_at || null,
        cancelledReason: r.cancelled_reason || null,
        cancelledTargetSessionId: r.cancelled_target_session_id || null,
        sortOrder: Number(r.sort_order ?? 0),
        students,
        instructors: instructorsBySession[String(r.id)] || []
      };
    });
    setSessions(merged);
  }

  // ── Programme loaders ──────────────────────────────────────────────
  async function loadProgrammeSessions(){
    try{
      const rows = await selectAllRows('programme_sessions','*','&order=week_start_date.asc,weekday.asc,start_minute.asc,sort_order.asc').catch(()=>[]);
      setProgrammeSessions((rows||[]).map(r => ({
        id: r.id,
        weekStartDate: r.week_start_date || weekStartStr(todayStr()),
        day: Number(r.weekday) - 1,
        startMinute: Number(r.start_minute),
        durationMinutes: Number(r.duration_minutes || 60),
        branchId: r.branch_id || null,
        poolId: r.pool_id || null,
        title: r.title || '',
        body: r.body || '',
        categoryId: r.category_id || null,
        label: r.label || '',
        color: r.color || null,
        instructorIds: Array.isArray(r.instructor_ids) ? r.instructor_ids : [],
        sortOrder: Number(r.sort_order || 0)
      })));
    } catch(e){ console.warn('Programme sessions not available yet (run supabase_programme_migration.sql):', e?.message || e); setProgrammeSessions([]); }
  }
  async function loadProgrammeCategories(){
    try{
      const rows = await selectRows('programme_categories','*','&order=sort_order.asc,name.asc').catch(()=>[]);
      setProgrammeCategories(rows || []);
    } catch(_){ setProgrammeCategories([]); }
  }
  async function loadBillingTerms(){
    try{
      const rows = await selectRows('billing_terms','*','&order=start_date.asc,sort_order.asc,name.asc').catch(()=>[]);
      setBillingTerms(rows || []);
    } catch(_){ setBillingTerms([]); }
  }
  async function loadProducts(){
    try{
      const rows = await selectRows('products','*','&order=sort_order.asc,name.asc').catch(()=>[]);
      setProducts(rows || []);
    } catch(_){ setProducts([]); }
  }
  async function loadContactMessages(){
    try{
      const rows = await selectAllRows('contact_messages','*','&order=created_at.desc').catch(()=>[]);
      setContactMessages(rows || []);
    } catch(_){ setContactMessages([]); }
  }
  // Phase 0 (RLS hardening): staff-user management runs server-side via the
  // admin-users edge function (service role), so the browser never reads or
  // writes app_users directly. The caller's signed session token authorizes
  // each request; the function enforces sysadmin-only.
  async function adminUsersCall(action, payload={}){
    const res = await fetch(`${cfg.supabaseUrl}/functions/v1/admin-users`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', apikey: cfg.supabaseAnonKey, Authorization:`Bearer ${currentUser?.token||''}` },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }
  // Staff logins for the attendance app. Unlike adminUsersCall (which carries
  // the Phase 0 signed token), staff-auth authenticates the caller with their
  // real Supabase JWT, so it needs the session minted at login.
  async function staffAuthCall(action, payload={}){
    if(!sbSession?.access_token){
      throw new Error('Sign out and sign in again to enable staff login management.');
    }
    const res = await fetch(`${cfg.supabaseUrl}/functions/v1/staff-auth`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', apikey: cfg.supabaseAnonKey,
                Authorization:`Bearer ${sbSession.access_token}` },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }
  async function crewProvisionLogin(crewId, staffId, password){
    await staffAuthCall('provision', { crew_id:crewId, staff_id:staffId, password });
    await loadAdminAll();
  }
  async function crewResetLogin(crewId, password){
    await staffAuthCall('reset', { crew_id:crewId, password });
  }
  async function crewUnlinkLogin(crewId){
    await staffAuthCall('unlink', { crew_id:crewId });
    await loadAdminAll();
  }
  async function loadAppUsers(){
    try{
      const { users } = await adminUsersCall('list');
      setAppUsers(users || []);
    } catch(_){ setAppUsers([]); }
  }
  // ── Admin & Procurement loaders ──
  async function loadAdminAll(){
    let empLoadFailed = false;
    try{
      const [cats,cos,cts,pys,vs,eps,prs] = await Promise.all([
        selectRows('admin_categories','*','&order=name.asc').catch(()=>[]),
        selectRows('admin_companies','*','&order=name.asc').catch(()=>[]),
        selectRows('admin_contacts','*','&order=name.asc').catch(()=>[]),
        selectRows('admin_payees','*','&order=name.asc').catch(()=>[]),
        selectAllRows('admin_payment_vouchers','*','&order=serial_no.desc').catch(()=>[]),
        selectRows('admin_employees','*','&order=full_name.asc').catch(()=>{ empLoadFailed=true; return []; }),
        selectRows('promos','*','&order=starts_at.desc').catch(()=>[]),
      ]);
      setAdminCategories(cats||[]); setAdminCompanies(cos||[]); setAdminContacts(cts||[]);
      setAdminPayees(pys||[]); setAdminVouchers(vs||[]); setAdminEmployees(eps||[]);
      setPromos(prs||[]);
      setAdminCrewLoadFailed(empLoadFailed);
    } catch(_){ setAdminCrewLoadFailed(true); }
  }

  async function loadAttendance(){
    try{
      const from = attWeekStart, to = addDays(attWeekStart,6);
      const [locs,cats,sh,st] = await Promise.all([
        selectRows('locations','*','&order=name.asc'),
        selectRows('shift_categories','*','&order=sort_order.asc'),
        selectAllRows('shifts','*',`&is_void=eq.false&shift_date=gte.${from}&shift_date=lte.${to}&order=shift_date.asc,start_time.asc`),
        selectRows('attendance_settings','*').catch(()=>[]),
      ]);
      setAttLocations(locs||[]); setAttCategories(cats||[]);
      setAttShifts(sh||[]); setAttSettings((st||[])[0]||null);
      setAttBlocked(false);
    } catch(_){
      // Most likely cause: no Supabase JWT yet, so RLS denies every table.
      setAttLocations([]); setAttCategories([]); setAttShifts([]);
      setAttBlocked(true);
    }
  }
  useEffect(()=>{ if(view==='attendance') loadAttendance(); }, [view, attWeekStart]);

  // Today only, with the punches attached. Kept separate from the weekly
  // roster load because this one runs on a timer.
  async function loadAttendanceLive(){
    try{
      const today = todayStr();
      const sh = await selectAllRows('shifts','*',`&is_void=eq.false&shift_date=eq.${today}&order=start_time.asc`);
      const ids = (sh||[]).map(r=>r.id);
      let pu = [];
      if(ids.length){
        pu = await selectAllRows('punches',
          'shift_id,type,punched_at,accepted,distance_m,inside_fence,lat,lng,accuracy_m',
          `&shift_id=in.(${ids.join(',')})&order=punched_at.asc`);
      }
      setAttToday(sh||[]); setAttPunches(pu||[]);
      setAttLoadedAt(new Date().toISOString());
      setAttBlocked(false);
    } catch(_){ setAttToday([]); setAttPunches([]); setAttBlocked(true); }
  }
  useEffect(()=>{
    if(view!=='attendance' || attendanceSection!=='live') return;
    loadAttendanceLive();
    const t = setInterval(loadAttendanceLive, 45000);
    return ()=>clearInterval(t);
  }, [view, attendanceSection]);

  // Report period: a Mon–Sun week, or a calendar month.
  const attReportRange = useMemo(()=>{
    if(attReportMode==='week'){
      const f = weekStartStr(attReportAnchor);
      return { from:f, to:addDays(f,6), label:weekRangeLabel(f) };
    }
    const d = fromDateStr(attReportAnchor);
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last  = new Date(d.getFullYear(), d.getMonth()+1, 0);
    return { from:toDateStr(first), to:toDateStr(last),
             label:first.toLocaleDateString('en-GB',{month:'long',year:'numeric'}) };
  }, [attReportMode, attReportAnchor]);

  async function loadAttendanceReport(){
    try{
      const rows = await selectAllRows('shifts','*',
        `&is_void=eq.false&shift_date=gte.${attReportRange.from}&shift_date=lte.${attReportRange.to}&order=shift_date.asc`);
      setAttReportShifts(rows||[]); setAttBlocked(false);
    } catch(_){ setAttReportShifts([]); setAttBlocked(true); }
  }
  useEffect(()=>{
    if(view==='attendance' && attendanceSection==='report') loadAttendanceReport();
  }, [view, attendanceSection, attReportRange.from, attReportRange.to]);

  async function loadAttendanceAlerts(){
    try{
      const rows = await selectAllRows('alerts','*',
        `&status=eq.${attAlertFilter}&order=raised_at.desc`);
      // Voided sessions still matter here — the alert outlives them.
      const ids = Array.from(new Set((rows||[]).map(a=>a.shift_id)));
      let sh = [];
      if(ids.length) sh = await selectAllRows('shifts','*',`&id=in.(${ids.join(',')})`);
      setAttAlerts(rows||[]); setAttAlertShifts(sh||[]); setAttBlocked(false);
    } catch(_){ setAttAlerts([]); setAttAlertShifts([]); setAttBlocked(true); }
  }
  // Badge count, kept current whenever the module is open so the nav can show
  // how much is waiting without the Alerts tab being the active one.
  async function refreshOpenAlertCount(){
    try{
      const rows = await selectRows('alerts','id','&status=eq.open');
      setAttOpenAlertCount((rows||[]).length);
    } catch(_){ setAttOpenAlertCount(0); }
  }
  useEffect(()=>{
    if(view==='attendance' && attendanceSection==='alerts') loadAttendanceAlerts();
  }, [view, attendanceSection, attAlertFilter]);
  useEffect(()=>{ if(view==='attendance') refreshOpenAlertCount(); }, [view, attendanceSection]);

  // An admin-entered punch. source='admin' makes it visually distinct from a
  // real one, and the DB refuses it without a remark.
  async function attEnterPunch(shift, type, hhmm, remark){
    const stamp = new Date(`${shift.shift_date}T${hhmm}:00+08:00`).toISOString();
    await insertRows('punches', {
      shift_id: shift.id, crew_id: shift.crew_id, type,
      punched_at: stamp, source: 'admin', accepted: true, remark
    });
  }
  async function attResolveAlert(alertRow, out){
    // The alert carries the decision; the session keeps whatever happened.
    await patchRows('alerts',{id:alertRow.id},{
      status:'resolved', resolution_action: out.resolution_action,
      pay_treatment: out.pay_treatment || null, remark: out.remark,
      resolved_at: new Date().toISOString()
    });
    const patch = {};
    if(out.markAbsent) patch.status = 'absent';
    if(out.markUnpaidLeave) patch.is_unpaid_leave = true;
    if(out.pay_treatment) patch.pay_treatment = out.pay_treatment;
    if(out.remark) patch.remark = out.remark;
    if(Object.keys(patch).length){
      patch.updated_at = new Date().toISOString();
      await patchRows('shifts',{id:alertRow.shift_id}, patch);
    }
    await loadAttendanceAlerts();
    await refreshOpenAlertCount();
  }

  async function attSaveLocation(data, id){
    try{
      if(id) await patchRows('locations',{id},data); else await insertRows('locations',data);
      await loadAttendance();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save location'); }
  }
  // Void-not-delete: retiring keeps the row so past sessions still resolve.
  async function attRetireLocation(id){
    try{ await patchRows('locations',{id},{is_active:false}); await loadAttendance(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to retire location'); }
  }
  async function attSaveShift(data, id){
    try{
      if(id) await patchRows('shifts',{id},data); else await insertRows('shifts',data);
      await loadAttendance();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save session'); }
  }
  // Copy every session from the previous week into the one on screen.
  // Mirrors "Duplicate Previous Week" in the lesson scheduler, which is the
  // idiom staff already know. Each week stays independent data afterwards, so
  // a holiday or a swap is edited on that week alone — no series to fight.
  async function attCopyPreviousWeek(){
    try{
      const prevStart = addDays(attWeekStart,-7), prevEnd = addDays(attWeekStart,-1);
      const prev = await selectAllRows('shifts','*',
        `&is_void=eq.false&shift_date=gte.${prevStart}&shift_date=lte.${prevEnd}`);
      if(!(prev||[]).length){ alert('There are no sessions in the previous week to copy.'); return; }
      // A worker cannot hold two sessions at the same moment (enforced by a
      // unique index), so skip anything already on this week rather than
      // letting the insert fail wholesale.
      const taken = new Set((attShifts||[]).map(x=>`${x.crew_id}|${x.shift_date}|${x.start_time}`));
      const rows = prev.map(x=>({
        crew_id:x.crew_id, shift_date:addDays(x.shift_date,7),
        start_time:x.start_time, end_time:x.end_time,
        location_id:x.location_id, category_id:x.category_id
      })).filter(r=>!taken.has(`${r.crew_id}|${r.shift_date}|${r.start_time}`));
      if(!rows.length){ alert('Every session from last week is already on this week.'); return; }
      if(!confirm(`Copy ${rows.length} session${rows.length===1?'':'s'} from last week into this week?`)) return;
      await insertRows('shifts', rows);
      await loadAttendance();
    } catch(err){ handleErr(err); alert(err.message||'Failed to copy last week'); }
  }
  // One session repeated on the same weekday for N weeks. Creates plain dated
  // rows — there is no recurrence rule to reason about later.
  async function attAddShiftSeries(base, weeks){
    try{
      const rows=[]; for(let i=0;i<weeks;i++) rows.push({ ...base, shift_date: addDays(base.shift_date, i*7) });
      await insertRows('shifts', rows);
      await loadAttendance();
    } catch(err){ handleErr(err); alert(err.message||'Failed to add the sessions'); }
  }
  async function attVoidShift(id){
    try{ await patchRows('shifts',{id},{is_void:true}); await loadAttendance(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to void session'); }
  }

  async function loadStudents(){
    try{
      const [rows, enrollmentRows] = await Promise.all([
        selectAllRows('students', '*', '&order=name.asc'),
        selectAllRows('student_enrollments', '*').catch(()=>[]) // table may not exist yet
      ]);
      const byStudent = {};
      (enrollmentRows || []).forEach(e => {
        if(!byStudent[e.student_id]) byStudent[e.student_id] = [];
        byStudent[e.student_id].push({ id: e.id, lessonTypeId: e.lesson_type_id, packageId: e.package_id, quantity: Number(e.quantity) || 1 });
      });
      setStudents((rows || []).map(r => {
        const dob = r.date_of_birth || null;
        // DOB is the source of truth — age is recomputed every load so it
        // tracks today's date (a 4-year-old becomes 5 on their birthday
        // without any data write). Fallback to stored age only when DOB is
        // missing (legacy rows pre-migration).
        const ageNow = dob != null ? ageFromDob(dob) : (r.age === null || r.age === undefined ? null : Number(r.age));
        return {
          id: r.id,
          name: r.name || '',
          dob: dob,
          age: ageNow,
          gender: r.gender || null,
          package: r.package || '',
          packageId: r.package_id || null,
          familyGroupId: r.family_group_id || null,
          lessonTypeIds: Array.isArray(r.lesson_type_ids) ? r.lesson_type_ids : [],
          enrollments: byStudent[r.id] || [],
          isActive: r.is_active !== false,
          guardianName: r.guardian_name || '',
          guardianEmail: r.guardian_email || '',
          guardianPhone: r.guardian_phone || '',
          guardianIc: r.guardian_ic || '',
          guardianTin: r.guardian_tin || '',
          accountId: r.account_id || null,
          branchId: r.branch_id || null,
          emergencyPhone: r.emergency_phone || '',
          emergencyName: r.emergency_name || '',
          emergencyRelationship: r.emergency_relationship || '',
          emergencySameAsGuardian: !!r.emergency_same_as_guardian,
          tcAcceptedAt: r.tc_accepted_at || null,
          tcAcceptanceId: r.tc_acceptance_id || null
        };
      }));
    } catch(e){ console.warn('Swimmer registry not available yet (run the students migration):', e?.message || e); setStudents([]); }
  }

  async function loadGroups(){
    try{
      const rows = await selectAllRows('family_groups', '*', '&order=name.asc');
      setFamilyGroups((rows || []).map(r => ({ id:r.id, name:r.name || '', packageId:r.package_id || null, groupType: r.group_type || 'discount' })));
    } catch(e){ console.warn('Family groups not available yet (run the family groups migration):', e?.message || e); setFamilyGroups([]); }
  }

  // Many-to-many membership loader. A swimmer can belong to multiple
  // family groups (one per unique lesson_type+package). See migration
  // `supabase_family_group_members_migration.sql`. On a fresh DB before
  // that migration runs, the query 404s and we fall back to deriving
  // memberships from the legacy students.family_group_id column.
  async function loadGroupMemberships(){
    try{
      const rows = await selectAllRows('family_group_members', '*');
      setGroupMemberships((rows || []).map(r => ({ familyGroupId: r.family_group_id, studentId: r.student_id })));
    } catch(e){
      console.warn('family_group_members table not yet available (run the migration). Falling back to legacy single-FK derivation:', e?.message || e);
      // Fallback: derive from students.family_group_id (read in loadStudents)
      setGroupMemberships(null);  // null sentinel — useMemo uses students as source instead
    }
  }

  async function loadCreditBalances(){
    try{
      const rows = await selectAllRows('student_credit_balances', '*');
      setCreditBalances(rows || []);
    } catch(e){ console.warn('Credit balances not available (run the replacement+credits migration):', e?.message || e); setCreditBalances([]); }
  }

  // ── Credit Purchases ────────────────────────────────────────────────
  // Every credit-issuing event (sign-up, top-up, gift, manual adjustment)
  // recorded as its own row. The running balance in
  // student_credit_balances is the denormalised cache. Use:
  //   - addCreditPurchase to record a purchase AND bump the balance
  //   - reverseCreditPurchase (delete) to remove a purchase AND
  //     decrement the balance accordingly
  async function loadCreditPurchases(){
    try{
      const rows = await selectAllRows('credit_purchases', '*', '&order=purchase_date.desc,created_at.desc');
      setCreditPurchases(rows || []);
    } catch(e){ console.warn('Credit purchases not available (run the ghost+credits migration):', e?.message || e); setCreditPurchases([]); }
  }
  async function addCreditPurchase({ studentId, lessonTypeId, purchaseDate, creditsAdded, source, notes }){
    try{
      setError('');
      const add = Number(creditsAdded);
      if(!studentId || !lessonTypeId || !add) return;
      await insertRows('credit_purchases', [{
        student_id: studentId, lesson_type_id: lessonTypeId,
        purchase_date: purchaseDate || toDateStr(new Date()),
        credits_added: add,
        source: source || 'manual',
        notes: notes || null
      }]);
      // Bump the running balance row. If none exists yet, create it
      // with this purchase as the seed.
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      if(bal){
        const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + add);
        const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, add));
        await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, {
          remaining_balance: newRemaining,
          initial_balance: newInitial,
          updated_at: new Date().toISOString()
        });
      } else {
        // First purchase for this (student, LT) — seed the balance row.
        await insertRows('student_credit_balances', [{
          student_id: studentId, lesson_type_id: lessonTypeId,
          initial_balance: Math.max(0, add), remaining_balance: Math.max(0, add)
        }]);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
      setStatus(`Recorded ${add > 0 ? '+' : ''}${add} credit${Math.abs(add)===1?'':'s'} for swimmer.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add credit purchase'); }
  }
  async function deleteCreditPurchase(purchase){
    if(!purchase || !purchase.id) return;
    if(!confirm(`Delete this credit record: ${purchase.credits_added > 0 ? '+' : ''}${purchase.credits_added} on ${purchase.purchase_date}?\n\nThe running balance will be adjusted accordingly.`)) return;
    try{
      await deleteRows('credit_purchases', { id: purchase.id });
      // Reverse the running balance.
      const key = creditKey(purchase.student_id, purchase.lesson_type_id);
      const bal = creditByKey[key];
      if(bal){
        const next = Math.max(0, (Number(bal.remaining_balance) || 0) - Number(purchase.credits_added));
        const init = Math.max(0, (Number(bal.initial_balance) || 0) - Math.max(0, Number(purchase.credits_added)));
        await patchRows('student_credit_balances', { student_id: purchase.student_id, lesson_type_id: purchase.lesson_type_id }, {
          remaining_balance: next,
          initial_balance: init,
          updated_at: new Date().toISOString()
        });
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete credit record'); }
  }

  // ── Subscriptions ────────────────────────────────────────────────────
  // A subscription is one purchase event. For an individual swimmer it
  // credits N credits to one balance. For a family group it credits N to
  // each eligible member's balance (creating one credit_purchases row per
  // member, all sharing the same subscription_id). Cancelling reverses by
  // inserting negative-credit purchases — the ledger keeps the full audit
  // trail and the running balance corrects itself.
  async function loadSubscriptions(){
    try{
      const rows = await selectRows('subscriptions', '*', '&order=subscription_date.desc,created_at.desc');
      setSubscriptions(rows || []);
    } catch(e){ console.warn('Subscriptions not available (run subscriptions migration):', e?.message || e); setSubscriptions([]); }
  }

  async function loadCodes(){
    try{
      const rows = await selectRows('scheduler_codes', '*', '&order=created_at.desc');
      setCodes(rows || []);
    } catch(e){ console.warn('Codes table not available (run codes migration):', e?.message || e); setCodes([]); }
  }
  async function addCode(input){
    // Normalises the form payload into the storage-shape, then inserts.
    // Returns the inserted row so the caller can immediately render it.
    try{
      setError('');
      const row = {
        code: (input.code || '').trim().toUpperCase(),
        code_type: input.codeType || 'discount',
        owner_student_id: input.ownerStudentId || null,
        discount_type: input.discountType || null,
        discount_value: input.discountValue != null && input.discountValue !== '' ? Number(input.discountValue) : null,
        referrer_reward_type: input.referrerRewardType || null,
        referrer_reward_value: input.referrerRewardValue != null && input.referrerRewardValue !== '' ? Number(input.referrerRewardValue) : null,
        valid_from: input.validFrom || null,
        valid_until: input.validUntil || null,
        max_uses: input.maxUses != null && input.maxUses !== '' ? Number(input.maxUses) : null,
        max_uses_per_customer: input.maxUsesPerCustomer != null && input.maxUsesPerCustomer !== '' ? Number(input.maxUsesPerCustomer) : 1,
        applies_to: input.appliesTo || 'all',
        applicable_package_ids: input.applicablePackageIds || null,
        minimum_amount: input.minimumAmount != null && input.minimumAmount !== '' ? Number(input.minimumAmount) : null,
        is_active: input.isActive !== false,
        notes: input.notes || null
      };
      if(!row.code) throw new Error('Code string is required');
      const ins = await insertRows('scheduler_codes', row);
      await loadCodes();
      return ins?.[0] || null;
    } catch(e){ setError(`addCode: ${e?.message || e}`); throw e; }
  }
  async function updateCode(id, patch){
    try{
      setError('');
      const body = {};
      if('code' in patch) body.code = (patch.code || '').trim().toUpperCase();
      if('codeType' in patch) body.code_type = patch.codeType;
      if('ownerStudentId' in patch) body.owner_student_id = patch.ownerStudentId || null;
      if('discountType' in patch) body.discount_type = patch.discountType || null;
      if('discountValue' in patch) body.discount_value = patch.discountValue != null && patch.discountValue !== '' ? Number(patch.discountValue) : null;
      if('referrerRewardType' in patch) body.referrer_reward_type = patch.referrerRewardType || null;
      if('referrerRewardValue' in patch) body.referrer_reward_value = patch.referrerRewardValue != null && patch.referrerRewardValue !== '' ? Number(patch.referrerRewardValue) : null;
      if('validFrom' in patch) body.valid_from = patch.validFrom || null;
      if('validUntil' in patch) body.valid_until = patch.validUntil || null;
      if('maxUses' in patch) body.max_uses = patch.maxUses != null && patch.maxUses !== '' ? Number(patch.maxUses) : null;
      if('maxUsesPerCustomer' in patch) body.max_uses_per_customer = patch.maxUsesPerCustomer != null && patch.maxUsesPerCustomer !== '' ? Number(patch.maxUsesPerCustomer) : 1;
      if('appliesTo' in patch) body.applies_to = patch.appliesTo;
      if('applicablePackageIds' in patch) body.applicable_package_ids = patch.applicablePackageIds || null;
      if('minimumAmount' in patch) body.minimum_amount = patch.minimumAmount != null && patch.minimumAmount !== '' ? Number(patch.minimumAmount) : null;
      if('isActive' in patch) body.is_active = !!patch.isActive;
      if('notes' in patch) body.notes = patch.notes || null;
      await patchRows('scheduler_codes', `id=eq.${id}`, body);
      await loadCodes();
    } catch(e){ setError(`updateCode: ${e?.message || e}`); throw e; }
  }
  async function deleteCode(id){
    try{
      setError('');
      await deleteRows('scheduler_codes', `id=eq.${id}`);
      await loadCodes();
    } catch(e){ setError(`deleteCode: ${e?.message || e}`); throw e; }
  }

  // bumpBalance: idempotent helper that either creates or updates the
  // student_credit_balances cache after a purchase is inserted.
  // adjustBalanceTo: hard-set the remaining balance for (student, lt) to a
  // target number by inserting a single credit_purchase row whose
  // credits_added equals the required delta. Audit-friendly (source
  // 'manual', notes default to "Manual adjustment to N"), reverses the
  // problem where a legacy direct-seeded balance can't be cancelled
  // because it has no purchase or subscription record to undo.
  async function adjustBalanceTo(studentId, lessonTypeId, targetBalance, notes){
    try{
      setError('');
      const key = creditKey(studentId, lessonTypeId);
      const bal = creditByKey[key];
      const current = bal ? Number(bal.remaining_balance) || 0 : 0;
      const target = Math.max(0, Number(targetBalance) || 0);
      const delta = target - current;
      if(delta === 0){ alert(`Balance is already ${target}.`); return; }
      await insertRows('credit_purchases', [{
        student_id: studentId,
        lesson_type_id: lessonTypeId,
        purchase_date: toDateStr(new Date()),
        credits_added: delta,
        source: 'manual',
        notes: notes || `Manual adjustment: ${current} → ${target}`
      }]);
      await bumpBalance(studentId, lessonTypeId, delta);
      await Promise.all([loadCreditBalances(), loadCreditPurchases()]);
      setStatus(`Adjusted balance: ${current} → ${target} (Δ ${delta > 0 ? '+' : ''}${delta}).`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to adjust balance'); }
  }

  async function bumpBalance(studentId, lessonTypeId, delta){
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    const d = Number(delta);
    if(bal){
      const newRemaining = Math.max(0, (Number(bal.remaining_balance) || 0) + d);
      const newInitial = Math.max(0, (Number(bal.initial_balance) || 0) + Math.max(0, d));
      await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, {
        remaining_balance: newRemaining, initial_balance: newInitial, updated_at: new Date().toISOString()
      });
    } else if(d > 0){
      await insertRows('student_credit_balances', [{ student_id: studentId, lesson_type_id: lessonTypeId, initial_balance: d, remaining_balance: d }]);
    }
  }

  // addSubscription({ subjectType, subjectId, lessonTypeId, creditsPerSwimmer, ... })
  // For 'student': credits one swimmer. For 'family_group': credits every
  // member enrolled in the given lesson type. Returns the subscription row.
  async function addSubscription({ subjectType, subjectId, lessonTypeId, creditsPerSwimmer, source, notes, amountPaid, receiptNumber, subscriptionDate, packageId, quantity = 1 }){
    try{
      setError('');
      const credits = Number(creditsPerSwimmer);
      const qty = Math.max(1, Number(quantity) || 1);
      if(!subjectId || !lessonTypeId || !credits) { alert('Subscription requires a subject, lesson type, and credits.'); return null; }
      // Resolve affected swimmers based on subject type.
      let affectedStudents = [];
      if(subjectType === 'student'){
        const stu = studentById[subjectId];
        if(!stu) { alert('Swimmer not found.'); return null; }
        affectedStudents = [stu];
      } else if(subjectType === 'family_group'){
        const members = (membersByGroup && membersByGroup[subjectId]) || [];
        affectedStudents = members.filter(m => (m.lessonTypeIds || []).includes(lessonTypeId));
        if(!affectedStudents.length){ alert('No members of this group are enrolled in the selected lesson type.'); return null; }
      } else { alert('Unknown subscription subject type.'); return null; }
      const totalCreditsPerSwimmer = credits * qty;
      const date = subscriptionDate || toDateStr(new Date());
      // Insert the parent subscription row.
      const subRows = await insertRows('subscriptions', [{
        subject_type: subjectType,
        subject_id: subjectId,
        lesson_type_id: lessonTypeId,
        package_id: packageId || null,
        credits_per_swimmer: totalCreditsPerSwimmer,
        swimmer_count: affectedStudents.length,
        subscription_date: date,
        source: source || 'subscription',
        notes: notes || null,
        amount_paid: amountPaid != null ? Number(amountPaid) : null,
        receipt_number: receiptNumber || null
      }]);
      const sub = subRows?.[0];
      if(!sub){ alert('Failed to create subscription.'); return null; }
      // Insert credit_purchases for each affected swimmer.
      const purchasePayload = affectedStudents.map(s => ({
        student_id: s.id, lesson_type_id: lessonTypeId,
        purchase_date: date, credits_added: totalCreditsPerSwimmer,
        source: source || 'subscription',
        notes: notes || null,
        subscription_id: sub.id
      }));
      await insertRows('credit_purchases', purchasePayload);
      // Bump each balance.
      for(const s of affectedStudents){
        await bumpBalance(s.id, lessonTypeId, totalCreditsPerSwimmer);
      }
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Added subscription: +${totalCreditsPerSwimmer} credits to ${affectedStudents.length} swimmer${affectedStudents.length===1?'':'s'}.`);
      return sub;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add subscription'); return null; }
  }

  // cancelSubscription(subscription): inserts negative-credit purchases
  // matching each original purchase (linked by subscription_id), then
  // marks the subscription as cancelled_at = now.
  async function cancelSubscription(subscription, reason){
    if(!subscription || !subscription.id) return;
    if(subscription.cancelled_at){ alert('This subscription is already cancelled.'); return; }
    if(!confirm(`Cancel subscription from ${subscription.subscription_date}?\n\nThis reverses the ${subscription.credits_per_swimmer} credits per swimmer for ${subscription.swimmer_count} swimmer${subscription.swimmer_count===1?'':'s'}. The original purchase records stay in the ledger; offsetting negative entries will be added.`)) return;
    try{
      // Fetch the original purchase rows for this subscription so we can
      // reverse each one (handles the case where some swimmers' purchases
      // were since edited or the row count differs from swimmer_count).
      const originals = (creditPurchases || []).filter(p => p.subscription_id === subscription.id && Number(p.credits_added) > 0);
      if(!originals.length){ alert('No original purchase records found for this subscription.'); return; }
      const date = toDateStr(new Date());
      const reversals = originals.map(orig => ({
        student_id: orig.student_id,
        lesson_type_id: orig.lesson_type_id,
        purchase_date: date,
        credits_added: -Number(orig.credits_added),
        source: 'cancellation',
        notes: `Cancellation of subscription from ${subscription.subscription_date}${reason ? ` — ${reason}` : ''}`,
        subscription_id: subscription.id
      }));
      await insertRows('credit_purchases', reversals);
      // Reverse each balance.
      for(const r of reversals){
        await bumpBalance(r.student_id, r.lesson_type_id, r.credits_added);
      }
      // Mark subscription cancelled.
      await patchRows('subscriptions', { id: subscription.id }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: reason || null
      });
      await Promise.all([loadCreditBalances(), loadCreditPurchases(), loadSubscriptions()]);
      setStatus(`Cancelled subscription — ${reversals.length} reversal${reversals.length===1?'':'s'} recorded.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to cancel subscription'); }
  }

  // Pending-replacement state — swimmers who were removed from their booked
  // class for the week and are awaiting placement into another same-LT class.
  async function loadReplacementPending(){
    try{
      const rows = await selectAllRows('replacement_pending', '*');
      setReplacementPending(rows || []);
    } catch(e){ console.warn('Replacement pending not available (run the replacement pending migration):', e?.message || e); setReplacementPending([]); }
  }

  // Key by student+LT+week so the modal can quickly check if a candidate has
  // a pending state for the active week. Resolved entries are deleted, not
  // flagged, so anything in this map is currently awaiting placement.
  const pendingByKey = useMemo(() => {
    const m = {};
    replacementPending.forEach(p => { m[`${p.student_id}:${p.lesson_type_id}:${p.week_start_date}`] = p; });
    return m;
  }, [replacementPending]);

  // ── markForReplacement: remove a swimmer from their booked class for the
  // week and queue them as a replacement candidate. The row in
  // weekly_session_students is deleted and a replacement_pending entry is
  // created (so they appear with an "R-pending" flag in same-LT dropdowns).
  async function markForReplacement({ studentId, sessionId, weekStartDate, lessonTypeId, lessonTypeName, day, startMinute }){
    if(!studentId || !sessionId || !lessonTypeId){ alert('Cannot mark for replacement: missing session information.'); return false; }
    const label = `${DAYS_S[day]} ${minuteToTime(startMinute)}`;
    if(!confirm(`Move this swimmer out of ${lessonTypeName} ${label} for replacement?\n\nThey will become a replacement candidate in any other ${lessonTypeName} class this week. The original slot will be released.`)) return false;
    try{
      await deleteRows('weekly_session_students', { session_id: sessionId, student_id: studentId });
      // Upsert pending entry — re-marking the same swimmer simply refreshes it.
      await rest('replacement_pending?on_conflict=student_id,week_start_date,lesson_type_id', { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([{ student_id: studentId, week_start_date: weekStartDate, lesson_type_id: lessonTypeId, original_session_label: label, original_session_id: sessionId }]) });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      return true;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to mark for replacement'); return false; }
  }

  async function clearPendingReplacement({ studentId, weekStartDate, lessonTypeId }){
    try{
      await deleteRows('replacement_pending', { student_id: studentId, week_start_date: weekStartDate, lesson_type_id: lessonTypeId });
      await loadReplacementPending();
    } catch(_){}
  }

  async function cancelPendingReplacement(pending, opts = { restore: true }){
    if(!pending || !pending.id) return false;
    const student = studentById[pending.student_id];
    const swimmerName = student?.name || 'this swimmer';
    const originalSession = sessions.find(s => s.id === pending.original_session_id);
    const sessionExists = !!pending.original_session_id && !!originalSession;
    const today = todayStr();
    const origWeek = pending.week_start_date || '';
    const datePassed = origWeek && origWeek < today;

    // ── Case 1: original session was deleted or moved ─────────────────
    if(!sessionExists && pending.original_session_id){
      alert(
        `Original slot no longer available.\n\n` +
        `${swimmerName}'s original class "${pending.original_session_label}" has been deleted or moved.\n\n` +
        `${swimmerName} will remain in the pending replacement queue. You must place them in an active session to resolve this.`
      );
      return false; // stay in limbo — no action taken
    }

    // ── Case 2: no original session ID at all (can only clear limbo) ──
    if(!sessionExists){
      if(!confirm(`Remove ${swimmerName} from the pending-replacement queue?\n\nNo original session is recorded. They will be cleared from limbo.`)) return false;
      await deleteRows('replacement_pending', { id: pending.id });
      await Promise.all([loadSessions(), loadReplacementPending()]);
      setStatus(`Cleared limbo entry for ${swimmerName}.`);
      return true;
    }

    // ── Case 3: original session exists — offer restore ───────────────
    if(sessionExists){
      const lt = lessonTypeById(pending.lesson_type_id);
      const cap = sessionCapacity(originalSession, lt);
      if(cap.locked){
        if(!confirm(`🔒 ${pending.original_session_label} is marked as FULL by the scheduler.\n\nRestore ${swimmerName} anyway? (The lock stays on afterwards.)`)) return false;
      } else if(cap.max > 0 && cap.current >= cap.max){
        if(!confirm(`${pending.original_session_label} is now full (${cap.current}/${cap.max}). Restore ${swimmerName} anyway (class will be over capacity)?`)) return false;
      }
      // Date-passed: show a non-blocking advisory alert, then a single confirm
      if(datePassed){
        alert(
          `⚠️ The original session week (${origWeek}) has already passed.\n\n` +
          `${swimmerName} will be restored to "${pending.original_session_label}" for record-keeping. ` +
          `Please manually review their attendance and credit status for that session.`
        );
      }
      if(!confirm(`Restore ${swimmerName} to "${pending.original_session_label}"?${datePassed ? '\n\n(Past session — attendance & credits need manual review)' : ''}`)) return false;
      try{
        await insertRows('weekly_session_students', [{
          session_id: pending.original_session_id,
          student_id: pending.student_id,
          student_name: student?.name || swimmerName,
          student_age: student?.age != null ? Number(student.age) : null,
          is_replacement: false,
          attendance_status: 'pending'
        }]);
        await deleteRows('replacement_pending', { id: pending.id });
        await Promise.all([loadSessions(), loadReplacementPending()]);
        setStatus(`Restored ${swimmerName} to ${pending.original_session_label}${datePassed?' — mark attendance manually':''}.`);
        return true;
      } catch(err){ handleErr(err); alert(err.message || 'Failed to restore'); return false; }
    }
  }

  // ── Full Class Replacement module ────────────────────────────────────
  // Two paths to cancel an entire scheduled class for the week:
  //
  //  (A) forwardClassToNextWeek — deletes the session for THIS week. No
  //      attendance is marked, so no credits deduct. Swimmers attend the
  //      same slot next week as normal. The scheduler is responsible for
  //      ensuring next week's session exists (Duplicate Previous Week
  //      handles that when needed).
  //
  //  (B) startFullClassMove — sets `pendingMove`, closes the modal, and
  //      drops the WeekView into "pick a slot" mode. The next slot click
  //      anywhere in the weekly grid calls placePendingMove(targetDay,
  //      targetStartMinute), which UPDATEs the session row in place
  //      (preserving its id, students, instructors, attendance, and credit
  //      ties — only weekday + start_minute change). The rescheduled_from_*
  //      columns mark it as moved so a future Duplicate Previous Week
  //      restores the canonical slot.
  const [pendingMove, setPendingMove] = useState(null);
  async function forwardClassToNextWeek(sessionId, sourceLabel){
    if(!sessionId) return;
    const src = sessions.find(s => s.id === sessionId);
    if(!src){ alert('Source session not found.'); return; }
    if(src.cancelledAt){ alert('This session is already cancelled.'); return; }

    const nextWeekStart = addDays(src.weekStartDate, 7);

    // Two paths, depending on whether next week already holds the same
    // recurring slot:
    //   (A) Match exists → don't create another copy; just point the
    //       cancellation marker at the existing next-week session.
    //   (B) No match → clone the session forward: insert a new row in
    //       next week, copy the non-replacement student rows and the
    //       instructor links, then mark this week's row as cancelled.
    // In both paths the original row stays in the DB — it becomes a
    // greyed-out "ghost" in the weekly grid, restorable by clicking.
    // Replacement students are week-scoped one-offs and are NEVER carried
    // forward — they belong to the original week's replacement bucket.
    const existingNextWeek = sessions.find(s =>
      s.weekStartDate === nextWeekStart &&
      s.day === src.day &&
      s.startMinute === src.startMinute &&
      s.lessonTypeId === src.lessonTypeId &&
      (s.poolId || null) === (src.poolId || null) &&
      !s.cancelledAt
    );
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    const swimmerCount = enrolledRegular.length;
    const confirmMsg = existingNextWeek
      ? `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nNext week already has the same class at the same slot — this week's run is cancelled and the ${swimmerCount} swimmer${swimmerCount===1?'':'s'} will attend that existing session.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.`
      : `Forward ${sourceLabel} to next week (${nextWeekStart})?\n\nThis week's session is cancelled and recreated next week (same day, same time) with the same ${swimmerCount} swimmer${swimmerCount===1?'':'s'}.\n\nThe original spot stays visible as a greyed-out shell; click it to restore. Credits already consumed this week will be refunded.`;
    if(!confirm(confirmMsg)) return;

    try{
      // Refund credits for any swimmer whose attendance was already marked
      // attended/absent on this session — those credits were deducted on
      // the prior save but shouldn't have been, since the class is now
      // being forwarded (i.e., it didn't actually happen this week).
      if(src.lessonTypeId){
        for(const s of (src.students || [])){
          if(!s.studentId) continue;
          const att = s.attendance || 'pending';
          if(att === 'attended' || att === 'absent'){
            await adjustCredit(s.studentId, src.lessonTypeId, 1);
          }
        }
      }

      let targetId = existingNextWeek ? existingNextWeek.id : null;
      if(!existingNextWeek){
        // Clone into next week.
        const inserted = await insertRows('weekly_sessions', [{
          week_start_date: nextWeekStart,
          weekday: src.day + 1,
          start_minute: src.startMinute,
          duration_minutes: src.durationMinutes,
          lesson_type: src.type,
          lesson_type_id: src.lessonTypeId,
          marked_full: src.markedFull === true,
          pool_id: src.poolId || null,
          family_group_id: src.familyGroupId || null,
          instructor: src.legacyInstructor || null
        }]);
        targetId = inserted?.[0]?.id;
        if(targetId){
          if(enrolledRegular.length){
            await insertRows('weekly_session_students', enrolledRegular.map(s => ({
              session_id: targetId,
              student_id: s.studentId || null,
              student_name: s.name || '',
              student_age: s.age != null ? Number(s.age) : null,
              remark: s.remark || null,
              is_replacement: false,
              attendance_status: 'pending'   // fresh week, fresh attendance
            })));
          }
          if(src.instructors && src.instructors.length){
            try{
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: targetId,
                instructor_id: i.id
              })));
            } catch(_){} // session_instructors table may not exist on older DBs — instructor name is also on the session row as a fallback
          }
        }
      }

      // Mark this week's session as cancelled-forwarded, pointing at the
      // target. Don't delete — the original stays as a ghost.
      await patchRows('weekly_sessions', { id: sessionId }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'forwarded',
        cancelled_target_session_id: targetId || null
      });

      await loadSessions();
      setModal(null);
      setStatus(existingNextWeek
        ? `Forwarded ${sourceLabel} → ${nextWeekStart} (merged into existing next-week session). Original is greyed out — click to restore.`
        : `Forwarded ${sourceLabel} → ${nextWeekStart} (cloned ${swimmerCount} swimmer${swimmerCount===1?'':'s'} forward). Original is greyed out — click to restore.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to forward class'); }
  }

  // restoreCancelledSession — unwind a forward/reschedule. Deletes the
  // target session (which holds students + instructors that were cloned
  // over) and clears the cancellation marker on the original so it
  // becomes live again at its original spot. We don't reverse any credit
  // refunds the cancellation issued — those were correct for the period
  // the class was missing; if attendance is re-marked the credits will
  // re-deduct on save normally.
  async function restoreCancelledSession(sessionId){
    const ghost = sessions.find(s => s.id === sessionId);
    if(!ghost){ alert('Session not found.'); return; }
    if(!ghost.cancelledAt){ alert('This session is not cancelled.'); return; }

    const label = `${ghost.type} on ${DAYS_F[ghost.day]} ${minuteToTime(ghost.startMinute)}`;
    const reasonLabel = ghost.cancelledReason === 'forwarded' ? 'forward to next week'
                      : ghost.cancelledReason === 'rescheduled' ? 'reschedule'
                      : 'cancellation';
    if(!confirm(`Restore ${label} to its original spot?\n\nThis undoes the ${reasonLabel}: the replacement session will be deleted and this slot becomes live again with its swimmers.`)) return;
    try{
      // Delete the target (replacement) session if we have one and it
      // still exists. The on-delete-set-null FK means we don't strictly
      // need to clear cancelled_target_session_id first, but we do it
      // anyway in the PATCH below.
      if(ghost.cancelledTargetSessionId){
        const target = sessions.find(s => s.id === ghost.cancelledTargetSessionId);
        if(target){
          await deleteRows('weekly_session_students', { session_id: target.id });
          try{ await deleteRows('session_instructors', { session_id: target.id }); } catch(_){}
          await deleteRows('weekly_sessions', { id: target.id });
        }
      }
      // Clear the cancellation marker on the original.
      await patchRows('weekly_sessions', { id: sessionId }, {
        cancelled_at: null,
        cancelled_reason: null,
        cancelled_target_session_id: null
      });
      await loadSessions();
      setStatus(`Restored ${label} to its original slot.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to restore session'); }
  }
  function startFullClassMove({ sessionId, sourceLabel, lessonTypeName, weekStartDate, originalDay, originalStartMinute, swimmerCount }){
    if(!sessionId) return;
    setPendingMove({ sessionId, sourceLabel, lessonTypeName, weekStartDate, originalDay, originalStartMinute, swimmerCount });
    setModal(null);
    setStatus(`Click an empty slot in the weekly grid to drop ${lessonTypeName} (${sourceLabel}).`);
  }
  function cancelPendingMove(){ setPendingMove(null); setStatus(''); }
  async function placePendingMove(targetDay, targetStartMinute){
    if(!pendingMove) return;
    const src = sessions.find(s => s.id === pendingMove.sessionId);
    if(!src){ alert('Source session not found.'); setPendingMove(null); return; }
    if(src.cancelledAt){ alert('This session is already cancelled.'); setPendingMove(null); return; }
    const targetLabel = `${DAYS_F[targetDay]} ${minuteToTime(targetStartMinute)}`;
    if(!confirm(`Move ${pendingMove.lessonTypeName} (${pendingMove.swimmerCount} swimmer${pendingMove.swimmerCount===1?'':'s'}) from ${pendingMove.sourceLabel} to ${targetLabel}?\n\nThe original spot stays visible as a greyed-out shell — click it to restore.`)) return;
    try{
      // Refund any credits already consumed on the original — same logic
      // as Forward: the class is being moved so attendance to date is
      // wiped on the clone (it starts at "pending").
      if(src.lessonTypeId){
        for(const s of (src.students || [])){
          if(!s.studentId) continue;
          const att = s.attendance || 'pending';
          if(att === 'attended' || att === 'absent'){
            await adjustCredit(s.studentId, src.lessonTypeId, 1);
          }
        }
      }

      // Clone the session at the new slot. Same week, new weekday +
      // start_minute. We carry rescheduled_from_* on the CLONE (not the
      // ghost) so a future Duplicate Previous Week still restores the
      // canonical slot for the next week.
      const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
      const inserted = await insertRows('weekly_sessions', [{
        week_start_date: src.weekStartDate,
        weekday: targetDay + 1,
        start_minute: targetStartMinute,
        duration_minutes: src.durationMinutes,
        lesson_type: src.type,
        lesson_type_id: src.lessonTypeId,
        marked_full: src.markedFull === true,
        pool_id: src.poolId || null,
        family_group_id: src.familyGroupId || null,
        instructor: src.legacyInstructor || null,
        rescheduled_from_day: src.day + 1,
        rescheduled_from_start_minute: src.startMinute
      }]);
      const targetId = inserted?.[0]?.id;
      if(targetId){
        if(enrolledRegular.length){
          await insertRows('weekly_session_students', enrolledRegular.map(s => ({
            session_id: targetId,
            student_id: s.studentId || null,
            student_name: s.name || '',
            student_age: s.age != null ? Number(s.age) : null,
            remark: s.remark || null,
            is_replacement: false,
            attendance_status: 'pending'
          })));
        }
        if(src.instructors && src.instructors.length){
          try{
            await insertRows('session_instructors', src.instructors.map(i => ({
              session_id: targetId,
              instructor_id: i.id
            })));
          } catch(_){}
        }
      }

      // Mark original as cancelled-rescheduled, pointing at the clone.
      await patchRows('weekly_sessions', { id: pendingMove.sessionId }, {
        cancelled_at: new Date().toISOString(),
        cancelled_reason: 'rescheduled',
        cancelled_target_session_id: targetId || null
      });

      await loadSessions();
      setPendingMove(null);
      setStatus(`Moved ${pendingMove.lessonTypeName} to ${targetLabel}. Original spot greyed out — click to restore.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to move class'); }
  }

  async function loadTcAcceptances(){
    try{
      const rows = await selectAllRows('tc_acceptances', '*');
      setTcAcceptances(rows || []);
    } catch(e){ console.warn('T&C acceptances not available (run the student profile migration):', e?.message || e); setTcAcceptances([]); }
  }

  async function saveTcAcceptance({ studentId, guardianName, guardianEmail, lessonTypeName, signatureName, signedVia }){
    try{
      const acceptanceId = `TC-${Date.now().toString(36).toUpperCase().slice(-7)}`;
      const now = new Date().toISOString();
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.slice(0,300) : null;
      // Legacy row shape — always accepted. Digital-signature columns are
      // spliced on top only when the migration has been run.
      const legacyRow = { student_id:studentId, acceptance_id:acceptanceId, accepted_at:now, guardian_name:guardianName, guardian_email:guardianEmail||null, lesson_type_name:lessonTypeName };
      const fullRow = { ...legacyRow, signature_name:(signatureName||guardianName||'').trim()||null, signed_via:signedVia||'app', user_agent:ua };
      const upsert = (row) => rest('tc_acceptances?on_conflict=student_id', { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([row]) });
      // Try the full row; if the signature columns aren't there yet, fall
      // back to the legacy shape so signing still works pre-migration.
      try{ await upsert(fullRow); }
      catch(e){ if(isMissingColumnErr(e)) await upsert(legacyRow); else throw e; }
      // Mirror acceptance info onto the student row for quick list display.
      await patchRows('students', { id: studentId }, { tc_accepted_at: now, tc_acceptance_id: acceptanceId });
      await Promise.all([loadTcAcceptances(), loadStudents()]);
      return acceptanceId;
    } catch(err){ handleErr(err); throw err; }
  }

  // creditBalanceKey — quickly look up a balance by student + lesson type.
  function creditKey(studentId, lessonTypeId){ return `${studentId}:${lessonTypeId}`; }
  const creditByKey = useMemo(() => {
    const m = {};
    creditBalances.forEach(b => { m[creditKey(b.student_id, b.lesson_type_id)] = b; });
    return m;
  }, [creditBalances]);
  // Purchases-by-key memo — same shape as creditByKey but holds the
  // chronological purchase list. Each value is an array of purchase
  // rows sorted by purchase_date descending (newest first).
  const purchasesByKey = useMemo(() => {
    const m = {};
    creditPurchases.forEach(p => {
      const k = creditKey(p.student_id, p.lesson_type_id);
      (m[k] = m[k] || []).push(p);
    });
    return m;
  }, [creditPurchases]);
  // Purchases grouped by student (across all lesson types) for the
  // Swimmers tab's expandable credit panel.
  const purchasesByStudent = useMemo(() => {
    const m = {};
    creditPurchases.forEach(p => {
      (m[p.student_id] = m[p.student_id] || []).push(p);
    });
    return m;
  }, [creditPurchases]);

  async function loadRemarks(cursor){
    const start = new Date(cursor.getFullYear(), cursor.getMonth()-1, 1);
    const end = new Date(cursor.getFullYear(), cursor.getMonth()+2, 0);
    const rows = await selectRows('calendar_remarks', '*', `&calendar_date=gte.${toDateStr(start)}&calendar_date=lte.${toDateStr(end)}&order=calendar_date.asc`);
    const map = {};
    (rows || []).forEach(r => { map[r.calendar_date] = r.remark || ''; });
    setRemarks(map);
  }

  function activeInstructors(){ return options.instructors.filter(x => x.is_active !== false); }
  function activeDurations(){ return options.durations.filter(x => x.is_active !== false); }
  function activeLessonTypes(){
    const list = options.lessonTypes.filter(x => x.is_active !== false);
    if(currentBranchId && currentBranchId !== 'all') return list.filter(t => !t.branch_id || t.branch_id === currentBranchId);
    return list;
  }
  function activePools(){
    let pools = options.pools.filter(x => x.is_active !== false);
    // Branch filter: when a branch is selected, only that branch's pools.
    // 'all' or null falls through to show every pool.
    if(currentBranchId && currentBranchId !== 'all'){
      pools = pools.filter(p => !p.branch_id || p.branch_id === currentBranchId);
    }
    return pools;
  }
  function allActivePools(){ return options.pools.filter(x => x.is_active !== false); }
  function activeBranches(){ return (options.branches||[]).filter(x => x.is_active !== false); }
  function branchById(id){ return (options.branches||[]).find(b => b.id === id) || null; }
  function activePackages(){
    const list = options.packages.filter(x => x.is_active !== false);
    if(currentBranchId && currentBranchId !== 'all') return list.filter(p => !p.branch_id || p.branch_id === currentBranchId);
    return list;
  }
  function packageById(id){ return options.packages.find(p => p.id === id) || null; }

  function lessonTypeByName(name){ return options.lessonTypes.find(t => t.name === name) || null; }
  function lessonTypeById(id){ return options.lessonTypes.find(t => t.id === id) || null; }
  function poolById(id){ return options.pools.find(p => p.id === id) || null; }
  function instructorByName(name){ return options.instructors.find(i => i.name === name) || null; }

  function colorsFor(type){
    const x = lessonTypeByName(type);
    return x ? { bg:x.bg_color, bd:x.border_color, tx:x.text_color } : (DEFAULT_TYPES[type] || { bg:'#E2E8F0', bd:'#64748B', tx:'#0F172A' });
  }

  const gridBounds = useMemo(() => computeGridBounds(options.operatingHours), [options.operatingHours]);
  const gridSlots = Math.max(1, Math.round((gridBounds.endMin - gridBounds.startMin) / SLOT_MIN));
  function slotToMinute(slot){ return gridBounds.startMin + slot * SLOT_MIN; }
  function minuteToSlot(min){ return Math.round((min - gridBounds.startMin) / SLOT_MIN); }

  const selectedWeekStart = weekStartStr(selectedDate);
  const currentWeekStart = weekStartStr(todayStr());
  const isFutureSelectedWeek = selectedWeekStart > currentWeekStart;

  // ── Programme derived data ─────────────────────────────────────────────
  const programmeWeekStart = weekStartStr(programmeDate);
  const programmeMonthDates = useMemo(() => monthCells(programmeMonthCursor), [programmeMonthCursor]);
  // 7-day grid for the selected programme week, branch- and pool-filtered.
  const programmeWeekDays = useMemo(() => {
    const days = Array.from({length:7}, () => []);
    (programmeSessions || []).forEach(s => {
      if(s.weekStartDate !== programmeWeekStart) return;
      // branch filter (lenient: unassigned sessions show everywhere)
      if(currentBranchId && currentBranchId !== 'all'){
        if(s.branchId && s.branchId !== currentBranchId) return;
      }
      // pool tab filter
      if(programmePoolId && s.poolId !== programmePoolId) return;
      if(s.day >= 0 && s.day < 7) days[s.day].push(s);
    });
    days.forEach(arr => arr.sort((a,b) => a.startMinute - b.startMinute || a.sortOrder - b.sortOrder));
    return days;
  }, [programmeSessions, programmeWeekStart, currentBranchId, programmePoolId]);
  // Sessions on a given calendar date (for the monthly view), branch-filtered.
  function programmeSessionsForDate(ds){
    const ws = weekStartStr(ds);
    const di = (fromDateStr(ds).getDay() + 6) % 7;
    return (programmeSessions || []).filter(s => {
      if(s.weekStartDate !== ws || s.day !== di) return false;
      if(currentBranchId && currentBranchId !== 'all' && s.branchId && s.branchId !== currentBranchId) return false;
      return true;
    }).sort((a,b) => a.startMinute - b.startMinute);
  }

  function sessionsForDate(dateStr){
    const day = dateToWeekdayIndex(dateStr);
    const ws = weekStartStr(dateStr);
    // Branch scope (same semantics as the weekly grid's weekBlocks): a session
    // belongs to the selected branch when its pool is one of that branch's
    // pools; sessions without a pool fold into the current branch's first
    // pool. Keeps Daily and Monthly consistent with Weekly.
    const branchPoolIds = new Set(activePools().map(p => p.id));
    return sessions
      .filter(s => s.weekStartDate === ws && s.day === day)
      .filter(s => branchPoolIds.size === 0 || !s.poolId || branchPoolIds.has(s.poolId))
      .sort((a,b) => a.startMinute - b.startMinute);
  }

  const weekSessions = useMemo(() => sessions.filter(s => s.weekStartDate === selectedWeekStart), [sessions, selectedWeekStart]);

  // M2.1: pool is no longer a structural column split — it's a badge. We pack
  // all of a day's sessions (optionally filtered to one pool) into a single
  // aligned column grid. peak = the day's maximum simultaneous sessions, which
  // drives that day's width so the busiest cluster still clears a readable
  // minimum. Null-pool sessions fold into the first active pool for filtering.
  // ── Combined filter pipeline ───────────────────────────────────────────
  // Two filter dimensions stack: lesson types (enabledTypes set) and
  // instructors (selectedInstructors set). A session is shown only when
  // both filters pass. Instructor selection has a cascade: picking
  // instructors auto-narrows the visible lesson types to the union of what
  // they teach (the user's intent: "select instructor → only their classes
  // visible"). Manual type toggles afterward refine within that set.
  function passesFilters(s){
    if(enabledTypes !== null && !enabledTypes.has(s.type)) return false;
    if(selectedInstructors.size > 0){
      const ids = (s.instructors || []).map(i => i.id);
      if(!ids.some(id => selectedInstructors.has(id))) return false;
    }
    return true;
  }
  function filteredSessionsForDate(dateStr){ return sessionsForDate(dateStr).filter(passesFilters); }

  const weekBlocks = useMemo(() => {
    const allActive = activePools(); // already branch-filtered
    const allPoolIds = new Set(allActive.map(p => p.id));
    const fallbackPoolId = allActive[0]?.id || null;
    return Array.from({length:7}, (_, day) => {
      let items = weekSessions.filter(s => s.day === day);
      if(!selectedPoolId){
        // Default: show all pools that belong to the current branch
        if(allPoolIds.size > 0)
          items = items.filter(s => allPoolIds.has(s.poolId || fallbackPoolId));
      } else {
        // Specific pool selected
        items = items.filter(s => (s.poolId || fallbackPoolId) === selectedPoolId);
      }
      items = items.filter(passesFilters);
      const packed = packParallelColumns(items);
      const peak = packed.length ? packed[0]._total : 1;
      return { packed, peak: Math.max(1, peak) };
    });
  }, [weekSessions, selectedPoolId, enabledTypes, selectedInstructors, options.pools, currentBranchId]);

  // ── Lesson-type legend filters ──
  const allTypesShown = useMemo(() => {
    if(enabledTypes === null) return true;
    const names = activeLessonTypes().map(t => t.name);
    return names.length > 0 && names.every(n => enabledTypes.has(n));
  }, [enabledTypes, options.lessonTypes, currentBranchId]);
  function isTypeEnabled(name){ return enabledTypes === null ? true : enabledTypes.has(name); }
  function toggleType(name){
    setEnabledTypes(prev => {
      const base = prev === null ? new Set(activeLessonTypes().map(t => t.name)) : new Set(prev);
      if(base.has(name)) base.delete(name); else base.add(name);
      return base;
    });
  }
  function toggleAllTypes(){ setEnabledTypes(allTypesShown ? new Set() : null); }

  // ── Instructor legend filters with cascade ──
  function isInstructorActive(id){ return selectedInstructors.has(id); }
  function toggleInstructor(id){
    const next = new Set(selectedInstructors);
    if(next.has(id)) next.delete(id); else next.add(id);
    setSelectedInstructors(next);
    // Cascade: instructor selection rewrites the visible types to the union
    // of what the selected instructors teach this week. Deselecting the last
    // instructor restores the all-types-on state.
    if(next.size === 0){
      setEnabledTypes(null);
    } else {
      const taught = new Set();
      sessions.forEach(s => {
        if((s.instructors || []).some(i => next.has(i.id))) taught.add(s.type);
      });
      setEnabledTypes(taught);
    }
  }
  function clearInstructors(){ setSelectedInstructors(new Set()); setEnabledTypes(null); }

  // All-pools packing, ignoring the filter — used for the printed weekly table
  // so a printout is always the complete record.
  const weekBlocksAllPools = useMemo(() => {
    return Array.from({length:7}, (_, day) => packParallelColumns(weekSessions.filter(s => s.day === day)));
  }, [weekSessions]);

  const summary = useMemo(() => {
    const byType = {}, byInst = {}, byPool = {};
    activeLessonTypes().forEach(x => byType[x.name] = 0);
    activeInstructors().forEach(x => byInst[x.name] = 0);
    activePools().forEach(p => byPool[p.name] = 0);
    let totalStudents = 0;
    let totalSessions = 0;
    weekSessions.forEach(s => {
      // Cancelled ghosts don't count — they're shells of classes that
      // didn't happen this week. Their swimmers moved with the
      // replacement session, which is already in the list (possibly in
      // a different week or slot).
      if(s.cancelledAt) return;
      totalSessions += 1;
      const excluded = excludeFromStudentTotals(s.type);
      const count = excluded ? 0 : s.students.length;
      byType[s.type] = (byType[s.type] || 0) + count;
      const pool = poolById(s.poolId);
      if(pool) byPool[pool.name] = (byPool[pool.name] || 0) + count;
      s.instructors.forEach(inst => { byInst[inst.name] = (byInst[inst.name] || 0) + count; });
      totalStudents += count;
    });
    return { byType, byInst, byPool, totalStudents, totalSessions };
  }, [weekSessions, options, currentBranchId]);

  function defaultFormForStart(startMinute, poolId){
    const firstType = activeLessonTypes()[0];
    const firstInst = activeInstructors()[0];
    const firstPool = poolId || (firstType && firstType.default_pool_id) || (activePools()[0] && activePools()[0].id) || null;
    const dur = (firstType && firstType.default_duration_minutes) || 50;
    return {
      type: firstType?.name || '',
      lessonTypeId: firstType?.id || null,
      instructorId: firstInst?.id || null,
      instructorName: firstInst?.name || '',
      poolId: firstPool,
      durationMinutes: dur,
      studentRows: buildStudentRows([], firstType?.students_per_instructor),
      // Always present so the modal's .filter/.some() chains never hit undefined,
      // even when the modal opens in 'add' mode with no existing replacements.
      replacementRows: []
    };
  }

  function openAdd(day, slot, poolId){
    const startMinute = slotToMinute(slot);
    setModal({ mode:'add', id:null, weekStartDate: selectedWeekStart, day, startMinute, form: defaultFormForStart(startMinute, poolId) });
  }

  // Same as openAdd but uses an explicit weekStartDate and accepts startMinute
  // directly (not a slot index) — used by EnrollView which passes raw minute
  // values from its hour grid and doesn't have access to App's minuteToSlot.
  function openAddForWeek(weekStartDate, day, startMinute, poolId){
    setModal({ mode:'add', id:null, weekStartDate, day, startMinute, form: defaultFormForStart(startMinute, poolId) });
  }

  function openAddAtTime(day, startMinute, poolId){
    setModal({ mode:'add', id:null, weekStartDate: selectedWeekStart, day, startMinute, form: defaultFormForStart(startMinute, poolId) });
  }

  function openEdit(item){
    // Ghost session — clicking the greyed-out shell prompts to restore
    // it to its original slot, undoing the forward/reschedule. We hand
    // off to restoreCancelledSession rather than opening the editor;
    // the underlying row is locked while cancelled (no edits allowed).
    if(item && item.cancelledAt){
      restoreCancelledSession(item.id);
      return;
    }
    const firstInst = item.instructors[0] || null;
    const regularStudents = (item.students || []).filter(s => !s.isReplacement);
    const replacementStudents = (item.students || []).filter(s => s.isReplacement);
    // Snapshot attendance so saveSession can compute credit deltas only for
    // actual state transitions (pending↔attended, pending↔absent).
    const originalAttendance = {};
    (item.students || []).forEach(s => {
      if(s.studentId) originalAttendance[s.studentId] = s.attendance || 'pending';
    });
    setModal({
      mode:'edit', id:item.id, weekStartDate:item.weekStartDate, day:item.day, startMinute:item.startMinute,
      rescheduledFromDay: item.rescheduledFromDay ?? null,
      rescheduledFromStartMinute: item.rescheduledFromStartMinute ?? null,
      originalAttendance,
      originalReplacementRows: replacementStudents.map(s => {
        const dec = decodeReplacementFrom(s.replacementFrom||'');
        return { studentId:s.studentId, name:s.name, replacementFrom:dec.label, originalSessionId:dec.sessionId, lessonTypeId: lessonTypeByName(item.type)?.id || null };
      }),
      originalRegularCount: regularStudents.length,
      form:{
        markedFull: item.markedFull === true,
        type:item.type,
        lessonTypeId:item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : (instructorByName(item.legacyInstructor)?.id || null),
        instructorName: firstInst ? firstInst.name : (item.legacyInstructor || ''),
        poolId: item.poolId,
        familyGroupId: item.familyGroupId || null,
        durationMinutes:item.durationMinutes,
        studentRows: buildStudentRows(regularStudents, lessonTypeByName(item.type)?.students_per_instructor),
        replacementRows: replacementStudents.map(s => { const dec=decodeReplacementFrom(s.replacementFrom||''); return { studentId:s.studentId, name:s.name, age:s.age, replacementFrom:dec.label, originalSessionId:dec.sessionId, attendance: s.attendance || 'pending' }; })
      }
    });
  }

  // M4: open an existing session from the Enroll matcher, pre-dropping the
  // chosen swimmer into the first empty slot so the user just confirms + saves.
  function openEnroll(item, swimmers){
    // swimmers may be: a single student object (legacy callers) or an array.
    const list = Array.isArray(swimmers) ? swimmers : (swimmers ? [swimmers] : []);
    if(item.markedFull && list.length){
      alert('🔒 This class is marked as FULL by the scheduler.\n\nOpening it without adding — untick "Mark as full" inside if you want to slot this swimmer in (e.g. for a trial), then re-lock afterwards.');
      openEdit(item);
      return;
    }
    const firstInst = item.instructors[0] || null;
    const rows = buildStudentRows(item.students, lessonTypeByName(item.type)?.students_per_instructor);
    list.forEach(student => {
      if(!student) return;
      if(rows.some(r => r.studentId === student.id)) return;
      const slot = { studentId: student.id, name: student.name, age: (student.age == null ? '' : String(student.age)) };
      const idx = rows.findIndex(r => !r.studentId && !(r.name || '').trim());
      if(idx >= 0) rows[idx] = slot; else rows.push(slot);
    });
    setModal({
      mode:'edit', id:item.id, weekStartDate:item.weekStartDate, day:item.day, startMinute:item.startMinute,
      form:{
        type:item.type, lessonTypeId:item.lessonTypeId,
        instructorId: firstInst ? firstInst.id : (instructorByName(item.legacyInstructor)?.id || null),
        instructorName: firstInst ? firstInst.name : (item.legacyInstructor || ''),
        poolId: item.poolId, durationMinutes:item.durationMinutes, studentRows: rows,
        replacementRows: []
      }
    });
  }

  // M4: open a fresh session prefilled with the matcher's type/day/time and the
  const [highlightedSessionId, setHighlightedSessionId] = useState(null);

  // ── jumpToSession: navigate to Weekly View + pulse-highlight the card ──
  // Called when a swimmer's scheduled session badge is clicked in the
  // Accounts panel. Switches to Weekly View, scrolls to the right week,
  // and pulses the specific session card for 10 seconds — no modal opens.
  // ── saveDragOrder: persist slot reordering to DB ──────────────────
  // Called after a drag-and-drop drop in WeekView or DailyView.
  // orderedIds is the new [id, id, ...] sequence for all sessions in that slot.
  async function saveDragOrder(orderedIds){
    try{
      await Promise.all(orderedIds.map((id, i) =>
        patchRows('weekly_sessions', { id }, { sort_order: i })));
      await loadSessions();
    } catch(e){ console.warn('saveDragOrder failed:', e); }
  }

  function jumpToSession(session){
    setSelectedDate(addDays(session.weekStartDate, session.day));
    setView('schedule');
    setScheduleSection('week');
    setTimeout(() => {
      setHighlightedSessionId(session.id);
      // After React renders the highlighted card, scroll it to centre of viewport
      setTimeout(() => {
        const el = document.querySelector('.wa-card-highlight');
        if(el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      }, 120);
      setTimeout(() => setHighlightedSessionId(null), 10000);
    }, 80);
  }

  // swimmer already in slot 1. weekStartDate is explicit so it lands in the week
  // the matcher was searching, regardless of the app's current selected week.
  function openCreateFor(weekStart, day, startMinute, lessonType, swimmers){
    const list = Array.isArray(swimmers) ? swimmers.filter(Boolean) : (swimmers ? [swimmers] : []);
    const firstInst = activeInstructors()[0] || null;
    const existing = list.map(s => ({ studentId:s.id, name:s.name, age:s.age }));
    setSelectedDate(addDays(weekStart, day));
    setModal({
      mode:'add', id:null, weekStartDate: weekStart, day, startMinute,
      form:{
        type: lessonType?.name || activeLessonTypes()[0]?.name || '',
        lessonTypeId: lessonType?.id || null,
        instructorId: firstInst?.id || null,
        instructorName: firstInst?.name || '',
        poolId: (lessonType && lessonType.default_pool_id) || (activePools()[0] && activePools()[0].id) || null,
        durationMinutes: (lessonType && lessonType.default_duration_minutes) || 50,
        studentRows: buildStudentRows(existing, lessonType?.students_per_instructor),
        replacementRows: []
      }
    });
  }

  // M2: save now writes pool_id, lesson_type_id, and a session_instructors
  // row. The legacy instructor text column is kept in sync so a downgrade or
  // partial deploy doesn't lose data. Deleted students/instructors are
  // wiped-and-rewritten on every save — the dataset is small enough that the
  // simplicity is worth the extra round-trip.
  async function saveSession(){
    // Always read the latest modal via ref — avoids a stale-closure race where
    // the user clicks Save immediately after picking a student before React
    // has committed the state update.
    const m = modalRef.current;
    if(!m) return;
    try{
      setSaveBusy(true); setError('');
      const lt = lessonTypeByName(m.form.type) || lessonTypeById(m.form.lessonTypeId);
      const inst = options.instructors.find(i => i.id === m.form.instructorId) || instructorByName(m.form.instructorName);
      const payload = {
        week_start_date: m.weekStartDate || selectedWeekStart,
        weekday: m.day + 1,
        start_minute: m.startMinute,
        duration_minutes: Number(m.form.durationMinutes),
        lesson_type: m.form.type || '',
        lesson_type_id: lt ? lt.id : null,
        pool_id: m.form.poolId || null,
        family_group_id: null,
        instructor: inst ? inst.name : '',
        marked_full: m.form.markedFull === true,
        rescheduled_from_day: m.rescheduledFromDay != null ? m.rescheduledFromDay + 1 : null,
        rescheduled_from_start_minute: m.rescheduledFromStartMinute ?? null
      };
      // ── Mark-as-full guard ─────────────────────────────────────────
      // While locked, saving may not INCREASE the roster. Removing swimmers,
      // attendance, and other edits stay allowed; unlocking in the same save
      // (toggle off) naturally lifts the block.
      if(m.form.markedFull && m.mode === 'edit' && m.originalRegularCount != null){
        const newRegular = (m.form.studentRows||[]).filter(r => r.studentId || (r.name||'').trim()).length;
        const newRepl    = (m.form.replacementRows||[]).filter(r => r.studentId).length;
        const origTotal  = m.originalRegularCount + (m.originalReplacementRows||[]).length;
        if(newRegular + newRepl > origTotal){
          alert('🔒 This class is marked as FULL.\n\nNo new swimmers can be added while locked. Untick "Mark as full", save the addition, then re-lock once the trial or extra swimmer is settled.');
          setSaveBusy(false); return;
        }
      }
      let sessionId = m.id;
      // ── Replacement undo check ──────────────────────────────────────
      // If editing an existing session, detect replacement students who were
      // present in the original (originalReplacementRows) but are now absent
      // from replacementRows. Warn the user and offer to restore them to
      // replacement_pending so the slot isn't silently lost.
      if(m.id && (m.originalReplacementRows||[]).length > 0){
        const newReplIds = new Set((m.form.replacementRows||[]).filter(r=>r.studentId).map(r=>r.studentId));
        const removed = (m.originalReplacementRows||[]).filter(r => r.studentId && !newReplIds.has(r.studentId));
        if(removed.length > 0){
          const lines = removed.map(r => {
            const fromLabel = r.replacementFrom || '(original slot unknown)';
            return `• ${r.name} — originally from "${fromLabel}"`;
          });
          const proceed = confirm(
            `The following replacement student${removed.length>1?'s were':' was'} removed:\n\n${lines.join('\n')}\n\n` +
            `They will return to the Pending Replacements panel.\n` +
            `A "Cancel & restore" button will let you send them back to their original slot — even if that date has passed.\n\n` +
            `Proceed with saving?`
          );
          if(!proceed){ setSaveBusy(false); return; }
          // Re-insert into replacement_pending — now with original_session_id restored!
          const lt2 = lessonTypeByName(m.form.type) || lessonTypeById(m.form.lessonTypeId);
          for(const r of removed){
            if(r.studentId && lt2?.id){
              try{
                await rest('replacement_pending?on_conflict=student_id,week_start_date,lesson_type_id',{
                  method:'POST', headers:{Prefer:'return=representation,resolution=merge-duplicates'},
                  body:JSON.stringify([{
                    student_id:r.studentId,
                    week_start_date:m.weekStartDate||selectedWeekStart,
                    lesson_type_id:lt2.id,
                    original_session_label:r.replacementFrom||'',
                    original_session_id:r.originalSessionId||null   // ← preserved from encoded replacementFrom
                  }])
                });
              }catch(_){}
            }
          }
          await loadReplacementPending();
        }
      }
      // ────────────────────────────────────────────────────────────────
      if(m.id){
        const updated = await patchRows('weekly_sessions', { id: m.id }, payload);
        sessionId = updated?.[0]?.id || m.id;
        await deleteRows('weekly_session_students', { session_id: sessionId });
        await deleteRows('session_instructors', { session_id: sessionId });
      } else {
        const inserted = await insertRows('weekly_sessions', payload);
        sessionId = inserted?.[0]?.id;
        if(!sessionId) throw new Error('Session was created but no ID was returned — cannot save students.');
      }
      // Regular enrolled students
      const allStudentRows = m.form.studentRows || [];
      const rows = allStudentRows.map(r => ({
        studentId: r.studentId || null,
        name: (r.name || '').trim(),
        age: r.age,
        remark: (r.remark || '').trim(),
        attendance: r.attendance || 'pending'
      })).filter(r => r.name || r.studentId);

      const filledInForm = allStudentRows.filter(r => r.studentId || (r.name||'').trim()).length;
      setStatus(`Session saved — ${rows.length} student(s) written${rows.length !== filledInForm ? ` (form showed ${filledInForm} filled)` : ''}.`);
      if(rows.length === 0 && filledInForm > 0){
        alert(`DEBUG: Form has ${filledInForm} filled slot(s) but 0 passed the filter.\nFirst slot: ${JSON.stringify(allStudentRows[0])}\nCheck console for details.`);
        console.log('studentRows at save:', JSON.stringify(allStudentRows));
      }

      if(sessionId && rows.length){
        await insertRows('weekly_session_students', rows.map(r => ({
          session_id: sessionId,
          student_id: r.studentId || null,
          student_name: r.name,
          student_age: (r.age === '' || r.age === null || r.age === undefined) ? null : Number(r.age),
          remark: r.remark || null,
          is_replacement: false,
          replacement_from: null,
          attendance_status: r.attendance || 'pending'
        })));
        // ── VERIFY: immediately read back what's in the DB ──
        const verify = await selectRows('weekly_session_students', '*', `&session_id=eq.${sessionId}`);
        console.log('DB verify after insert:', verify?.length, 'rows for session', sessionId, JSON.stringify(verify));
        setStatus(`Wrote ${rows.length} student(s) → DB shows ${verify?.length ?? '?'} for this session. sessionId=${sessionId}`);
      }
      // Replacement students
      const replRows = (m.form.replacementRows || []).filter(r => r.name || r.studentId);
      if(sessionId && replRows.length){
        await insertRows('weekly_session_students', replRows.map(r => ({
          session_id: sessionId,
          student_id: r.studentId || null,
          student_name: (r.name || '').trim(),
          student_age: r.age != null ? Number(r.age) : null,
          remark: r.remark || null,
          is_replacement: true,
          replacement_from: (r.replacementFrom || '').trim() || null,
          attendance_status: r.attendance || 'pending'
        })));
        const wk = m.weekStartDate || selectedWeekStart;
        for(const r of replRows){
          if(r.studentId && lt?.id && pendingByKey[`${r.studentId}:${lt.id}:${wk}`]){
            try{ await deleteRows('replacement_pending', { student_id: r.studentId, week_start_date: wk, lesson_type_id: lt.id }); } catch(_){}
          }
        }
        await loadReplacementPending();
      }
      if(sessionId && inst){
        await insertRows('session_instructors', [{ session_id: sessionId, instructor_id: inst.id }]);
      }
      if(lt && lt.id && sessionId){
        // Credits are never auto-seeded when creating/saving sessions.
        // All credits flow from Pending Credits → payment receipt only.
        await loadCreditBalances();
      }
      if(sessionId && lt?.id){
        const orig = m.originalAttendance || {};
        const allSavedRows = [...rows, ...replRows.map(r => ({ studentId: r.studentId, attendance: r.attendance || 'pending' }))];
        const isConsuming = (s) => s === 'attended' || s === 'absent';
        for(const r of allSavedRows){
          if(!r.studentId) continue;
          const oldS = orig[r.studentId] || 'pending';
          const newS = r.attendance || 'pending';
          if(oldS === newS) continue;
          if(!isConsuming(oldS) && isConsuming(newS)){
            await adjustCredit(r.studentId, lt.id, -1);
          } else if(isConsuming(oldS) && !isConsuming(newS)){
            await adjustCredit(r.studentId, lt.id, 1);
          }
        }
      }
      await loadSessions();
      setModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save session'); }
    finally{ setSaveBusy(false); }
  }

  async function adjustCredit(studentId, lessonTypeId, delta){
    const key = creditKey(studentId, lessonTypeId);
    const bal = creditByKey[key];
    if(!bal) return;
    const next = Math.max(0, (bal.remaining_balance || 0) + delta);
    try{ await patchRows('student_credit_balances', { student_id: studentId, lesson_type_id: lessonTypeId }, { remaining_balance: next, updated_at: new Date().toISOString() }); await loadCreditBalances(); }
    catch(err){ alert(err.message || 'Failed to adjust credit'); }
  }

  async function initCredit(studentId, lessonTypeId, initial){
    const n = Number(initial);
    if(!n || n < 0) return;
    try{
      await rest(`student_credit_balances?select=*`, { method:'POST', headers:{ Prefer:'return=representation,resolution=merge-duplicates' }, body: JSON.stringify([{ student_id:studentId, lesson_type_id:lessonTypeId, initial_balance:n, remaining_balance:n }]) });
      await loadCreditBalances();
    } catch(err){ alert(err.message || 'Failed to set credits'); }
  }

  async function deleteSession(){
    if(!modal?.id) return;
    if(!confirm('Delete this scheduled session for the selected week?')) return;
    try{
      await deleteRows('weekly_session_students', { session_id: modal.id });
      await deleteRows('session_instructors', { session_id: modal.id });
      await deleteRows('weekly_sessions', { id: modal.id });
      await loadSessions();
      setModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete session'); }
  }

  async function saveRemark(){
    try{
      setError('');
      const val = remarkDraft.trim();
      if(remarks[selectedDate] !== undefined){
        if(val) await patchRows('calendar_remarks', { calendar_date: selectedDate }, { remark: val });
        else await deleteRows('calendar_remarks', { calendar_date: selectedDate });
      } else if(val) {
        await insertRows('calendar_remarks', { calendar_date: selectedDate, remark: val });
      }
      await loadRemarks(monthCursor);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save remark'); }
  }

  // ───── Settings mutations ─────────────────────────────────────────────────

  async function addOption(kind, extra={}){
    try{
      if(kind === 'instructor') await insertRows('scheduler_instructors', { name: extra.name, gender: extra.gender || null, sort_order: options.instructors.length + 1, is_active:true });
      if(kind === 'duration') await insertRows('scheduler_durations', { label: extra.label, slots: Number(extra.slots), sort_order: options.durations.length + 1, is_active:true });
      if(kind === 'lessonType'){
        const ltBranch = extra.branchId || (currentBranchId && currentBranchId !== 'all' ? currentBranchId : null);
        const inserted = await insertRows('scheduler_lesson_types', { name: extra.name, bg_color: extra.bg, border_color: extra.bd, text_color: extra.tx, branch_id: ltBranch, sort_order: options.lessonTypes.length + 1, is_active:true });
        const newId = inserted?.[0]?.id;
        if(newId){
          // Auto-relink: any decoupled sessions that still carry this exact name (and no link) reattach to the new type.
          await rest(`weekly_sessions?lesson_type=eq.${encodeURIComponent(extra.name)}&lesson_type_id=is.null`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type_id: newId }) });
          // Seed the two default packages every lesson type ships with — inherit the type's branch.
          await insertRows('packages', [
            { lesson_type_id: newId, name: 'Normal', branch_id: ltBranch, sort_order: 1, is_active: true, billing_mode: 'monthly' },
            { lesson_type_id: newId, name: 'Trial',  branch_id: ltBranch, sort_order: 2, is_active: true, billing_mode: 'monthly' }
          ]);
        }
        await loadSessions();
      }
      if(kind === 'pool') await insertRows('pools', { name: extra.name, capacity_total: Number(extra.capacity), sort_order: options.pools.length + 1, is_active:true });
      if(kind === 'package'){
        const ltId = extra.lessonTypeId || null;
        const parentLt = ltId ? options.lessonTypes.find(t => t.id === ltId) : null;
        const pkgBranch = (parentLt && parentLt.branch_id) || (currentBranchId && currentBranchId !== 'all' ? currentBranchId : null);
        const siblings = ltId ? options.packages.filter(p => p.lesson_type_id === ltId) : options.packages.filter(p => !p.lesson_type_id);
        await insertRows('packages', { lesson_type_id: ltId, branch_id: pkgBranch, name: extra.name, pax: (extra.pax === '' || extra.pax == null) ? null : Number(extra.pax), amount: (extra.amount === '' || extra.amount == null) ? null : Number(extra.amount), billing_mode: extra.billingMode || 'monthly', billing_count: (extra.billingCount === '' || extra.billingCount == null) ? null : Number(extra.billingCount), is_group: !!extra.isGroup, fallback_per_pax: (extra.fallbackPerPax === '' || extra.fallbackPerPax == null) ? null : Number(extra.fallbackPerPax), sort_order: siblings.length + 1, is_active:true });
      }
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add option'); }
  }

  // Edit a lesson type. If the name changes, cascade the new name onto every
  // linked session's text column so colors and labels stay correct everywhere.
  async function saveLessonType(row, patch){
    try{
      setError('');
      await patchRows('scheduler_lesson_types', { id: row.id }, patch);
      if(patch.name && patch.name !== row.name){
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type: patch.name }) });
      }
      // Keep this type's packages aligned to the same branch if it was reassigned.
      if('branch_id' in patch && patch.branch_id !== row.branch_id){
        await patchRows('packages', { lesson_type_id: row.id }, { branch_id: patch.branch_id || null });
      }
      await loadOptions();
      await loadSessions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update lesson type'); }
  }

  // Save a branch's custom Terms & Conditions. Empty/blank → NULL, which makes
  // the branch fall back to the default T&C on the intake page.
  async function saveBranchTerms(branchId, content){
    try{
      const val = (content && content.trim()) ? content : null;
      await patchRows('branches', { id: branchId }, { terms_content: val });
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save terms'); }
  }

  // Delete a lesson type but keep its classes. Sessions are decoupled
  // (lesson_type_id → null) while their lesson_type text name is preserved, so
  // re-creating a type with the same name relinks them automatically.
  async function deleteLessonType(row){
    const linked = sessions.filter(s => s.lessonTypeId === row.id).length;
    const msg = linked > 0
      ? `${linked} class${linked===1?'':'es'} currently use "${row.name}".\n\nDeleting will UNLINK them: the classes stay in the schedule and keep the name "${row.name}", but lose this color/metadata link. Re-creating a lesson type with the exact same name will automatically relink them.\n\nProceed?`
      : `Delete lesson type "${row.name}"? No classes are currently using it.`;
    if(!confirm(msg)) return;
    try{
      setError('');
      if(linked > 0){
        await rest(`weekly_sessions?lesson_type_id=eq.${encodeURIComponent(row.id)}`, { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ lesson_type_id: null }) });
      }
      await deleteRows('scheduler_lesson_types', { id: row.id });
      await loadOptions();
      await loadSessions();
      setStatus(linked > 0 ? `Unlinked ${linked} class${linked===1?'':'es'}; "${row.name}" kept on the schedule.` : `Deleted "${row.name}".`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete lesson type'); }
  }

  async function toggleOption(table, row){
    try{ await patchRows(table, { id: row.id }, { is_active: !row.is_active }); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update option'); }
  }
  async function deleteOption(table, row, label){
    if(!confirm(`Delete "${label}" from this dropdown list? Existing schedule rows will stay unchanged.`)) return;
    try{ await deleteRows(table, { id: row.id }); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete option'); }
  }

  // Instructor delete is special: a FK on session_instructors blocks the raw
  // delete when the instructor is assigned to any class. We surface the usage
  // count in a tailored confirm, preserve the deleted name on each affected
  // session's legacy `instructor` column so the scheduler can still see who
  // used to teach it (rendered greyed-out with an amber ⚠), then drop the
  // FK rows and the instructor itself. Classes and students are left intact.
  async function deleteInstructor(row){
    try{
      const affected = sessions.filter(s => s.instructors.some(i => i.id === row.id));
      const message = affected.length
        ? `"${row.name}" is currently assigned to ${affected.length} class${affected.length===1?'':'es'}.\n\n` +
          `Deleting will leave those classes without an instructor. Their card will show an amber ⚠ warning until you reassign someone from the instructor list — the classes, students, times, and pool stay exactly as they are.\n\n` +
          `Proceed with deletion?`
        : `Delete "${row.name}" from the instructor list? No classes reference this instructor.`;
      if(!confirm(message)) return;
      // Preserve the name on each affected session's legacy text column so the
      // scheduler still sees a greyed-out reference until reassignment.
      for(const s of affected){
        const remaining = s.instructors.filter(i => i.id !== row.id);
        if(remaining.length === 0 && !s.legacyInstructor){
          await patchRows('weekly_sessions', { id: s.id }, { instructor: row.name });
        }
      }
      // Drop FK rows first so the parent delete can succeed.
      await deleteRows('session_instructors', { instructor_id: row.id });
      await deleteRows('scheduler_instructors', { id: row.id });
      await Promise.all([loadOptions(), loadSessions()]);
      setStatus(`Deleted "${row.name}"${affected.length ? ` · ${affected.length} class${affected.length===1?'':'es'} now need a new instructor` : ''}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete instructor'); }
  }
  async function patchOption(table, idOrMatch, patch){
    try{
      const match = (typeof idOrMatch === 'object' && idOrMatch !== null) ? idOrMatch : { id: idOrMatch };
      await patchRows(table, match, patch);
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update option'); }
  }

  async function updatePool(id, patch){
    try{ await patchRows('pools', {id}, patch); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update pool'); }
  }

  // ── Branches CRUD ────────────────────────────────────────────────────────
  async function addBranch({ name, code, color }){
    try{
      const next = (options.branches||[]).length + 1;
      await insertRows('branches', { name, code: code || null, color: color || null, sort_order: next, is_active: true });
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add branch'); }
  }
  async function updateBranch(id, patch){
    try{ await patchRows('branches', {id}, patch); await loadOptions(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update branch'); }
  }
  async function deleteBranch(id){
    if(!confirm('Delete this branch?\n\nAny pools/students/invoices linked to it will be unlinked (set to null). They will appear under "All branches" until reassigned.')) return;
    try{
      await deleteRows('branches', {id});
      await Promise.all([loadOptions(), loadStudents(), loadInvoiceData()]);
      // If we were viewing it, fall back to HQ
      if(currentBranchId === id){
        const hq = (options.branches||[]).find(b => (b.code||'').toUpperCase() === 'SSGT' && b.id !== id);
        setCurrentBranchId(hq ? hq.id : null);
      }
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete branch'); }
  }

  // ── Programme CRUD ───────────────────────────────────────────────────────
  function programmeCategoryById(id){ return (programmeCategories||[]).find(c => c.id === id) || null; }
  function progInstructorById(id){ return (options.instructors||[]).find(i => i.id === id) || null; }

  function openProgrammeCreate(day, startMinute, poolId){
    setProgrammeModal({
      mode:'add', id:null, weekStartDate: programmeWeekStart,
      form:{
        weekday: day, startMinute: startMinute, durationMinutes: 60,
        poolId: poolId || null, categoryId: null, title: '', body: '', color: null,
        instructorIds: [],
        branchId: (currentBranchId && currentBranchId !== 'all') ? currentBranchId : null
      }
    });
  }
  function openProgrammeEdit(s){
    setProgrammeModal({
      mode:'edit', id:s.id, weekStartDate: s.weekStartDate,
      form:{
        weekday: s.day, startMinute: s.startMinute, durationMinutes: s.durationMinutes,
        poolId: s.poolId, categoryId: s.categoryId, title: s.title, body: s.body, color: s.color,
        instructorIds: s.instructorIds || [],
        branchId: s.branchId || null
      }
    });
  }
  async function saveProgrammeSession(){
    const m = programmeModal; if(!m) return;
    try{
      setSaveBusy(true); setError('');
      const payload = {
        week_start_date: m.weekStartDate,
        weekday: Number(m.form.weekday) + 1,
        start_minute: Number(m.form.startMinute),
        duration_minutes: Number(m.form.durationMinutes || 60),
        // stamp current branch on create; preserve original branch on edit
        branch_id: m.mode === 'edit' ? (m.form.branchId || null)
                 : ((currentBranchId && currentBranchId !== 'all') ? currentBranchId : null),
        pool_id: m.form.poolId || null,
        title: (m.form.title || '').trim() || null,
        body: (m.form.body || '').trim() || null,
        category_id: m.form.categoryId || null,
        color: m.form.color || null,
        instructor_ids: Array.isArray(m.form.instructorIds) ? m.form.instructorIds.slice(0,3) : []
      };
      if(m.mode === 'edit' && m.id){ await patchRows('programme_sessions', {id:m.id}, payload); }
      else { await insertRows('programme_sessions', payload); }
      await loadProgrammeSessions();
      setProgrammeModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to save programme session'); }
    finally{ setSaveBusy(false); }
  }
  async function deleteProgrammeSession(id){
    if(!confirm('Delete this programme session? This cannot be undone.')) return;
    try{
      await deleteRows('programme_sessions', {id});
      await loadProgrammeSessions();
      setProgrammeModal(null);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete programme session'); }
  }
  // Copy ONE programme session into the next N weeks at the same weekday +
  // start time, carrying all details (branch, pool, title, body, category,
  // colour, instructors). Weeks that already have a matching session at the
  // same slot + title are skipped so re-running doesn't pile up duplicates.
  async function duplicateProgrammeSessionForward(sessionId, weekCount){
    const src = (programmeSessions||[]).find(s => s.id === sessionId);
    if(!src){ alert('Source session not found.'); return; }
    const n = Math.max(1, Math.min(52, Number(weekCount) || 1));
    if(!confirm(`Copy "${src.title || 'this session'}" on ${DAYS_F[src.day]} ${minuteToTime(src.startMinute)} to the next ${n} week${n===1?'':'s'}?\n\nWeeks that already have a matching session at the same day & time are skipped.`)) return;
    let created = 0;
    try{
      for(let w = 1; w <= n; w++){
        const targetWeekStart = addDays(src.weekStartDate, 7 * w);
        const exists = (programmeSessions||[]).some(s =>
          s.weekStartDate === targetWeekStart && s.day === src.day &&
          s.startMinute === src.startMinute && (s.title||'') === (src.title||''));
        if(exists) continue;
        await insertRows('programme_sessions', [{
          week_start_date: targetWeekStart,
          weekday: src.day + 1,
          start_minute: src.startMinute,
          duration_minutes: src.durationMinutes,
          branch_id: src.branchId || null,
          pool_id: src.poolId || null,
          title: src.title || null,
          body: src.body || null,
          category_id: src.categoryId || null,
          color: src.color || null,
          instructor_ids: src.instructorIds || []
        }]);
        created++;
      }
      await loadProgrammeSessions();
      setProgrammeModal(null);
      alert(created ? `Copied to ${created} week${created===1?'':'s'}.` : 'No new sessions created — every target week already had a matching session.');
    } catch(err){ handleErr(err); alert(err.message || 'Failed to copy programme session'); }
  }
  async function addProgrammeCategory({ name, color }){
    try{
      const next = (programmeCategories||[]).length + 1;
      await insertRows('programme_categories', { name, color: color || null, sort_order: next, is_active: true });
      await loadProgrammeCategories();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add category'); }
  }
  async function updateProgrammeCategory(id, patch){
    try{ await patchRows('programme_categories', {id}, patch); await loadProgrammeCategories(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update category'); }
  }
  async function deleteProgrammeCategory(id){
    if(!confirm('Delete this category?\n\nSessions using it keep their text but lose the category tag.')) return;
    try{ await deleteRows('programme_categories', {id}); await Promise.all([loadProgrammeCategories(), loadProgrammeSessions()]); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete category'); }
  }

  // ── Billing Terms CRUD (Settings › Billing Terms) ────────────────────────
  async function addBillingTerm({ name, startDate, endDate, branchId }){
    try{
      const next = (billingTerms||[]).length + 1;
      await insertRows('billing_terms', {
        name,
        start_date: startDate || null,
        end_date: endDate || null,
        branch_id: branchId || null,
        sort_order: next, is_active: true
      });
      await loadBillingTerms();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add billing term'); }
  }
  async function updateBillingTerm(id, patch){
    try{ await patchRows('billing_terms', {id}, patch); await loadBillingTerms(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update billing term'); }
  }
  async function deleteBillingTerm(id){
    if(!confirm('Delete this billing term?')) return;
    try{ await deleteRows('billing_terms', {id}); await loadBillingTerms(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete billing term'); }
  }

  // ── Product catalogue CRUD (Settings › Products) ─────────────────────────
  async function addCatalogProduct({ name, sku, price, imageUrl, description }){
    try{
      const next = (products||[]).length + 1;
      await insertRows('products', { name, sku: sku||null, price: (price===''||price==null)?null:Number(price), image_url: imageUrl||null, description: description||null, sort_order: next, is_active: true });
      await loadProducts();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add product'); }
  }
  async function updateCatalogProduct(id, patch){
    try{ await patchRows('products', {id}, patch); await loadProducts(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to update product'); }
  }
  async function deleteCatalogProduct(id){
    if(!confirm('Delete this product from the catalogue?')) return;
    try{ await deleteRows('products', {id}); await loadProducts(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete product'); }
  }
  async function reorderProducts(orderedIds){
    try{
      await Promise.all((orderedIds||[]).map((id,idx)=>patchRows('products',{id},{sort_order:idx+1})));
      await loadProducts();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to reorder products'); }
  }

  // ── Contact messages (website enquiries) ─────────────────────────────────
  async function markMessageRead(id){
    try{ await patchRows('contact_messages',{id},{status:'read',read_at:new Date().toISOString()}); await loadContactMessages(); }
    catch(err){ handleErr(err); }
  }
  async function markAllMessagesRead(){
    try{
      const ids=(contactMessages||[]).filter(m=>m.status==='new').map(m=>m.id);
      await Promise.all(ids.map(id=>patchRows('contact_messages',{id},{status:'read',read_at:new Date().toISOString()})));
      await loadContactMessages();
    } catch(err){ handleErr(err); }
  }
  async function deleteContactMessage(id){
    if(!confirm('Delete this message? This cannot be undone.')) return;
    try{ await deleteRows('contact_messages',{id}); await loadContactMessages(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete message'); }
  }

  // ── User management (Settings › Users — sysadmin only) ───────────────────
  // All mutations go through the admin-users edge function; the browser no
  // longer generates hashes or touches app_users directly (see adminUsersCall).
  async function createAppUser({ username, displayName, password, role }){
    const u=(username||'').trim().toLowerCase();
    if(!u || !password){ alert('Username and password are required.'); return; }
    if((appUsers||[]).some(x=>x.username===u)){ alert('That username already exists.'); return; }
    try{
      await adminUsersCall('create', { username:u, displayName:(displayName||'').trim()||u, password, role:role||'admin' });
      await loadAppUsers();
    } catch(err){ handleErr(err); alert(err.message||'Failed to create user'); }
  }
  async function setAppUserPassword(id, newPassword){
    if(!newPassword){ alert('Enter a new password.'); return; }
    try{
      await adminUsersCall('reset', { id, newPassword });
      await loadAppUsers();
      alert('Password updated.');
    } catch(err){ handleErr(err); alert(err.message||'Failed to set password'); }
  }
  async function patchAppUser(id, patch){
    try{ await adminUsersCall('patch', { id, patch }); await loadAppUsers(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update user'); }
  }
  async function deleteAppUser(id){
    const u=(appUsers||[]).find(x=>x.id===id);
    if(u && u.username===currentUser?.username){ alert("You can't delete the account you're signed in with."); return; }
    if(!confirm(`Delete user "${u?.username||''}"? They will no longer be able to sign in.`)) return;
    try{ await adminUsersCall('delete', { id }); await loadAppUsers(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete user'); }
  }

  // ── Admin & Procurement CRUD helpers ─────────────────────────────────────
  async function adminAddCategory(name){
    const n=(name||'').trim(); if(!n) return;
    try{ await insertRows('admin_categories',{name:n}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to add category'); }
  }
  async function adminUpdateCategory(id, patch){
    try{ await patchRows('admin_categories',{id},patch); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update category'); }
  }
  async function adminDeleteCategory(id){
    if(!confirm('Delete this category?')) return;
    try{ await deleteRows('admin_categories',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete category'); }
  }
  async function adminSaveCompany(data, id){
    try{
      if(id) await patchRows('admin_companies',{id},data);
      else await insertRows('admin_companies',data);
      await loadAdminAll();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save company'); }
  }
  async function adminDeleteCompany(id){
    if(!confirm('Delete this company? Its contacts will become independent.')) return;
    try{ await deleteRows('admin_companies',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete company'); }
  }
  async function adminSaveContact(data, id){
    try{
      if(id) await patchRows('admin_contacts',{id},data);
      else await insertRows('admin_contacts',data);
      await loadAdminAll();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save contact'); }
  }
  async function adminDeleteContact(id){
    if(!confirm('Delete this contact?')) return;
    try{ await deleteRows('admin_contacts',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete contact'); }
  }
  async function adminSavePayee(data, id){
    try{
      let payeeId=id;
      if(id) await patchRows('admin_payees',{id},data);
      else {
        const rows=await insertRows('admin_payees',data);
        payeeId = rows?.[0]?.id;
      }
      await loadAdminAll();
      return payeeId;
    } catch(err){ handleErr(err); alert(err.message||'Failed to save payee'); return null; }
  }
  async function adminDeletePayee(id){
    if(!confirm('Delete this payee? Existing vouchers keep their recorded details.')) return;
    try{ await deleteRows('admin_payees',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete payee'); }
  }
  async function adminSaveVoucher(data, id){
    try{
      if(id){
        const before = (adminVouchers||[]).find(v=>v.id===id) || null;
        await patchRows('admin_payment_vouchers',{id},data);
        // Amendment trail — write-once snapshot. Non-fatal if the
        // voucher_amendments migration hasn't been run yet.
        try{
          await insertRows('voucher_amendments',{
            voucher_id: String(id),
            voucher_no: before ? adminPvNo(before) : null,
            status_at_edit: before?.status || null,
            edited_by: currentUser?.displayName || currentUser?.username || null,
            before_data: before || null,
            after_data: data,
          });
        }catch(_){ console.warn('voucher_amendments not recorded — run the migration'); }
      }
      else { await insertRows('admin_payment_vouchers',{...data,status:data.status||'Draft'}); }
      await loadAdminAll();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save voucher'); }
  }
  async function adminSetVoucherStatus(id, status){
    try{ await patchRows('admin_payment_vouchers',{id},{status}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update voucher'); }
  }
  async function adminSaveEmployee(data, id){
    try{
      if(id) await patchRows('admin_employees',{id},data);
      else await insertRows('admin_employees',data);
      await loadAdminAll();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save employee'); }
  }
  // Import employees parsed from CSV/Excel. Matches existing rows by emp_no
  // (preferred) or case-insensitive full_name; matched rows are updated,
  // the rest inserted. Every insert row carries the FULL key set (nulls for
  // blanks) — PostgREST bulk inserts reject arrays with mismatched keys.
  async function adminImportEmployees(rows){
    const FIELDS=['full_name','emp_no','ic_no','position','department','employment_type','start_date','status','phone','email','emergency_name','emergency_phone','bank_name','bank_account','notes'];
    const byEmpNo={}, byName={};
    (adminEmployees||[]).forEach(e=>{
      if(e.emp_no) byEmpNo[String(e.emp_no).trim().toLowerCase()]=e;
      if(e.full_name) byName[String(e.full_name).trim().toLowerCase()]=e;
    });
    const inserts=[], updates=[];
    rows.forEach(r=>{
      const rec={};
      FIELDS.forEach(f=>{ const v=r[f]; rec[f]=(v==null||String(v).trim()==='')?null:String(v).trim(); });
      if(!rec.full_name) return;
      if(!rec.status) rec.status='Active';
      if(!rec.employment_type) rec.employment_type='Full-time';
      const hit = (rec.emp_no && byEmpNo[rec.emp_no.toLowerCase()]) || byName[rec.full_name.toLowerCase()];
      if(hit) updates.push({id:hit.id, patch:rec});
      else inserts.push(rec);
    });
    let inserted=0, updated=0;
    try{
      if(inserts.length){ await insertRows('admin_employees',inserts); inserted=inserts.length; }
      for(const u of updates){ await patchRows('admin_employees',{id:u.id},u.patch); updated++; }
      await loadAdminAll();
      return {inserted,updated,skipped:rows.length-inserts.length-updates.length};
    }catch(err){ handleErr(err); throw err; }
  }

  async function adminDeleteEmployee(id){
    if(!confirm('Delete this employee?')) return;
    try{ await deleteRows('admin_employees',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete employee'); }
  }

  // ── Promotions (marketing banners on the public website) ─────────────────
  async function adminSavePromo(data, id){
    try{
      if(id) await patchRows('promos',{id},data);
      else await insertRows('promos',data);
      await loadAdminAll();
    } catch(err){ handleErr(err); alert(err.message||'Failed to save promo'); }
  }
  async function adminDeletePromo(id){
    if(!confirm('Delete this promo? This cannot be undone.')) return;
    try{ await deleteRows('promos',{id}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to delete promo'); }
  }
  async function adminTogglePromoActive(id, next){
    try{ await patchRows('promos',{id},{is_active:next}); await loadAdminAll(); }
    catch(err){ handleErr(err); alert(err.message||'Failed to update promo'); }
  }

  // Reorder a settings list by reindexing sort_order across the whole list, so
  // the result is clean and gap-free regardless of the existing values.
  async function reorderOption(table, list, index, dir){
    const arr = (list || []).slice();
    const j = index + dir;
    if(j < 0 || j >= arr.length) return;
    const tmp = arr[index]; arr[index] = arr[j]; arr[j] = tmp;
    try{
      await Promise.all(arr.map((r, i) => patchRows(table, { id: r.id }, { sort_order: i + 1 })));
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to reorder'); }
  }

  // ───── Swimmer registry CRUD ──────────────────────────────────────────────
  async function addStudent({ name, dateOfBirth, gender, enrollments, guardianName, guardianEmail, guardianPhone, guardianIc, guardianTin, emergencyName, emergencyPhone, emergencyRelationship, emergencySameAsGuardian, tcAcceptedAt, tcAcceptanceId, accountId, branchId }){
    try{
      setError('');
      const validEnrollments = (enrollments || []).filter(e => e.lessonTypeId);
      const lessonTypeIds = [...new Set(validEnrollments.map(e => e.lessonTypeId))];
      const primaryPackageId = validEnrollments[0]?.packageId || null;
      const primaryPkg = primaryPackageId ? packageById(primaryPackageId) : null;
      const sameAsG = !!emergencySameAsGuardian;
      const dob = dateOfBirth || null;
      const computedAge = dob ? ageFromDob(dob) : null;
      const inserted = await insertRows('students', {
        name,
        date_of_birth: dob,
        age: computedAge,
        gender: gender || null,
        package_id: primaryPackageId, package: primaryPkg ? primaryPkg.name : null,
        lesson_type_ids: lessonTypeIds, is_active: true,
        account_id: accountId || null,   // inherit account group from parent account
        branch_id: branchId || currentBranchId || null,   // stamp with current branch by default
        guardian_name: guardianName || null, guardian_email: guardianEmail || null, guardian_phone: guardianPhone || null,
        guardian_ic: guardianIc || null, guardian_tin: guardianTin || null,
        emergency_name: sameAsG ? (guardianName || null) : (emergencyName || null),
        emergency_phone: sameAsG ? (guardianPhone || null) : (emergencyPhone || null),
        emergency_relationship: sameAsG ? 'Parent / Guardian' : (emergencyRelationship || null),
        emergency_same_as_guardian: sameAsG,
        // T&C inheritance: a swimmer added under an existing account
        // inherits the account-level T&C acceptance so the whole household
        // shares one consent record.
        tc_accepted_at: tcAcceptedAt || null,
        tc_acceptance_id: tcAcceptanceId || null
      });
      const studentId = inserted?.[0]?.id;
      if(studentId && validEnrollments.length){
        try{ await insertRows('student_enrollments', validEnrollments.map(e => ({ student_id: studentId, lesson_type_id: e.lessonTypeId, package_id: e.packageId || null, quantity: Math.max(1, Number(e.quantity) || 1) }))); }
        catch(err){ console.warn('Could not insert enrollments (table may not exist yet):', err?.message || err); }
        // Credits are NOT auto-seeded here. They must flow through the
        // Pending Credits → payment receipt → Confirm workflow only.
      }
      await loadStudents();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to add swimmer'); }
  }
  async function updateStudent(id, patch){
    try{
      setError('');
      const body = {};
      if('name' in patch) body.name = patch.name;
      if('dateOfBirth' in patch){
        const dob = patch.dateOfBirth || null;
        body.date_of_birth = dob;
        body.age = dob ? ageFromDob(dob) : null;
      }
      if('gender' in patch) body.gender = patch.gender || null;
      if('guardianName' in patch) body.guardian_name = patch.guardianName || null;
      if('guardianEmail' in patch) body.guardian_email = patch.guardianEmail || null;
      if('guardianPhone' in patch) body.guardian_phone = patch.guardianPhone || null;
      if('guardianIc'    in patch) body.guardian_ic    = patch.guardianIc    || null;
      if('guardianTin'   in patch) body.guardian_tin   = patch.guardianTin   || null;
      if('emergencySameAsGuardian' in patch) body.emergency_same_as_guardian = !!patch.emergencySameAsGuardian;
      if('emergencyPhone' in patch) body.emergency_phone = patch.emergencyPhone || null;
      if('emergencyName' in patch) body.emergency_name = patch.emergencyName || null;
      if('emergencyRelationship' in patch) body.emergency_relationship = patch.emergencyRelationship || null;
      if('isActive' in patch) body.is_active = !!patch.isActive;
      // Enrollments: mirror onto legacy columns for backward compat, then
      // sync the student_enrollments table (delete-all then insert).
      if('enrollments' in patch){
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        const lessonTypeIds = [...new Set(validEnrollments.map(e => e.lessonTypeId))];
        const primaryPackageId = validEnrollments[0]?.packageId || null;
        const primaryPkg = primaryPackageId ? packageById(primaryPackageId) : null;
        body.lesson_type_ids = lessonTypeIds;
        body.package_id = primaryPackageId;
        body.package = primaryPkg ? primaryPkg.name : null;
      }
      await patchRows('students', { id }, body);
      if('enrollments' in patch){
        const validEnrollments = (patch.enrollments || []).filter(e => e.lessonTypeId);
        try{
          await deleteRows('student_enrollments', { student_id: id });
          if(validEnrollments.length){
            await insertRows('student_enrollments', validEnrollments.map(e => ({ student_id: id, lesson_type_id: e.lessonTypeId, package_id: e.packageId || null, quantity: Math.max(1, Number(e.quantity) || 1) })));
          }
        } catch(err){ console.warn('Could not sync enrollments (table may not exist yet):', err?.message || err); }
        // Credits are NOT auto-seeded when enrollments change.
        // They flow from Pending Credits → payment confirmation only.
        await loadCreditBalances();
      }
      await loadStudents();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update swimmer'); }
  }
  async function deleteStudent(row){
    const enrolled = sessions.filter(s => s.students.some(st => st.studentId === row.id)).length;
    const msg = enrolled > 0
      ? `${row.name} is attached to ${enrolled} scheduled session${enrolled===1?'':'s'}.\n\nDeleting from the registry keeps those enrollments on the schedule (the name stays) but unlinks them. Proceed?`
      : `Delete swimmer "${row.name}" from the registry?`;
    if(!confirm(msg)) return;
    try{
      setError('');
      await deleteRows('students', { id: row.id });
      await loadStudents();
      await loadSessions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete swimmer'); }
  }

  async function deleteAccount(pg){
    if(!pg?.swimmers?.length){ alert('No swimmers found on this account.'); return; }
    const swimmerList = pg.swimmers.map(s => `• ${s.name}`).join('\n');
    if(!confirm(
      `PERMANENTLY DELETE account "${pg.name}" and all ${pg.swimmers.length} swimmer${pg.swimmers.length===1?'':'s'}?\n\n${swimmerList}\n\n` +
      `This removes their enrollments, credit balances, and pending replacement entries.\n\n` +
      `⚠️ This cannot be undone. Session names on the timetable remain but become unlinked.`
    )) return;
    try{
      setError('');
      for(const s of pg.swimmers){
        await deleteRows('student_credit_balances', { student_id: s.id }).catch(()=>{});
        await deleteRows('student_enrollments',     { student_id: s.id }).catch(()=>{});
        await deleteRows('replacement_pending',     { student_id: s.id }).catch(()=>{});
        await deleteRows('pending_credits',         { student_id: s.id }).catch(()=>{});
        await deleteRows('students',                { id: s.id });
      }
      await loadStudents();
      await loadSessions();
      setStatus(`Deleted account "${pg.name}" — ${pg.swimmers.length} swimmer${pg.swimmers.length===1?'':'s'} removed.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to delete account'); }
  }

  // ───── Family groups (single-payer bundles) ──────────────────────────────
  async function addGroup({ name, packageId, groupType }){
    try{
      setError('');
      const ins = await insertRows('family_groups', { name, package_id: packageId || null, group_type: groupType || 'discount' });
      await loadGroups();
      return ins?.[0] || null;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to create family group'); return null; }
  }
  async function updateGroup(id, patch){
    try{
      setError('');
      const body = {};
      if('name' in patch) body.name = patch.name;
      if('packageId' in patch) body.package_id = patch.packageId || null;
      if('groupType' in patch) body.group_type = patch.groupType;
      await patchRows('family_groups', { id }, body);
      await loadGroups();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to update family group'); }
  }
  async function deleteGroup(row, silent){
    if(!silent){
      const memberCount = (membersByGroup[row.id] || []).length;
      if(!confirm(memberCount > 0
        ? `Delete family group "${row.name}"? Its ${memberCount} member${memberCount===1?'':'s'} stay in the swimmer registry but will no longer be billed as a group.`
        : `Delete family group "${row.name}"?`)) return;
    }
    try{ setError(''); await deleteRows('family_groups', { id: row.id }); await loadGroups(); await loadGroupMemberships(); await loadStudents(); }
    catch(err){ handleErr(err); alert(err.message || 'Failed to delete family group'); }
  }
  // ── Multi-group membership write API ────────────────────────────────
  // A swimmer can be in many groups (one per unique lesson_type+package).
  // Uniqueness — "swimmer can't be in two groups with the same (lesson_type,
  // package)" — is enforced here because it touches two tables and can't
  // be a single DB constraint without denormalization. We check before
  // inserting; the UI also surfaces a "Already in <other group>" message
  // earlier so users see it without hitting the alert.
  // `targetOverride` is for callers (like handleCreate in ParentGroupManager)
  // who just INSERTED the group and have the row in hand — React's state
  // batching means familyGroups in our closure won't reflect the insert
  // until the next render, so the find-by-id below would fail. The
  // override lets the caller skip that lookup. Shape must match the
  // familyGroups row: { id, name, packageId, groupType }.
  async function addStudentToGroup(studentId, groupId, targetOverride){
    try{
      setError('');
      const target = targetOverride || familyGroups.find(g => g.id === groupId);
      if(!target){ alert('Group not found.'); return false; }
      // Check uniqueness: is the swimmer already in another group with
      // the same (lesson_type, package)? Skip if target group has no
      // package set yet — that's a misconfiguration the UI surfaces
      // separately.
      if(target.packageId){
        const existingGroupIds = groupIdsByStudent[studentId] || new Set();
        for(const otherId of existingGroupIds){
          if(otherId === groupId) return true; // already in this group — no-op
          const other = familyGroups.find(g => g.id === otherId);
          if(other && other.packageId === target.packageId){
            alert(`This swimmer is already in "${other.name}" which has the same package. A swimmer can only be in one group per (lesson type, package) combination — remove them from "${other.name}" first.`);
            return false;
          }
        }
      }
      await insertRows('family_group_members', { family_group_id: groupId, student_id: studentId });
      await loadGroupMemberships();
      return true;
    } catch(err){
      // Idempotent: PK conflict on duplicate add is silently OK
      if(err?.message && /duplicate|conflict|23505/i.test(err.message)){ await loadGroupMemberships(); return true; }
      handleErr(err); alert(err.message || 'Failed to add swimmer to group'); return false;
    }
  }
  async function removeStudentFromGroup(studentId, groupId){
    try{
      setError('');
      await deleteRows('family_group_members', { family_group_id: groupId, student_id: studentId });
      await loadGroupMemberships();
      return true;
    } catch(err){ handleErr(err); alert(err.message || 'Failed to remove swimmer from group'); return false; }
  }
  // Back-compat shim — old call sites still pass setStudentGroup(id, groupId|null).
  // groupId is non-null → ADD to group (with uniqueness check).
  // groupId is null     → REMOVE from any/all groups (used when "uncheck all").
  async function setStudentGroup(studentId, groupId){
    if(groupId){ return addStudentToGroup(studentId, groupId); }
    // null = remove from all groups the swimmer is in
    const ids = Array.from(groupIdsByStudent[studentId] || []);
    for(const gid of ids){ await removeStudentFromGroup(studentId, gid); }
    return true;
  }

  // Move an item from one index to another (used by drag-and-drop), then reindex.
  async function moveOption(table, list, from, to){
    if(from === to || from == null || to == null) return;
    const arr = (list || []).slice();
    if(from < 0 || to < 0 || from >= arr.length || to >= arr.length) return;
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    try{
      await Promise.all(arr.map((r, i) => patchRows(table, { id: r.id }, { sort_order: i + 1 })));
      await loadOptions();
    } catch(err){ handleErr(err); alert(err.message || 'Failed to reorder'); }
  }

  // duplicateSessionForward: clone ONE session into N future weeks at the
  // same weekday + start_minute. Same lesson type, same pool, same
  // instructor, same regular students (replacements excluded — they're
  // week-scoped one-offs). Attendance resets to 'pending' on the clones.
  // If a clone slot already has a matching session in a target week, that
  // week is skipped silently (avoids creating parallel duplicates).
  async function duplicateSessionForward(sessionId, weekCount){
    const src = sessions.find(s => s.id === sessionId);
    if(!src){ alert('Source session not found.'); return; }
    if(src.cancelledAt){ alert('Cannot duplicate a cancelled session — restore it first.'); return; }
    const n = Math.max(1, Math.min(52, Number(weekCount) || 1));
    const enrolledRegular = (src.students || []).filter(s => !s.isReplacement);
    if(!confirm(`Duplicate "${src.type}" on ${DAYS_F[src.day]} ${minuteToTime(src.startMinute)} to the next ${n} week${n===1?'':'s'}?\n\n${enrolledRegular.length} swimmer${enrolledRegular.length===1?'':'s'} will be cloned. Attendance resets to pending each week. Weeks that already have a matching session at the same slot will be skipped.`)) return;
    let created = 0;
    try{
      for(let w = 1; w <= n; w++){
        const targetWeekStart = addDays(src.weekStartDate, 7 * w);
        const inserted = await insertRows('weekly_sessions', [{
          week_start_date: targetWeekStart,
          weekday: src.day + 1,
          start_minute: src.startMinute,
          duration_minutes: src.durationMinutes,
          lesson_type: src.type,
          lesson_type_id: src.lessonTypeId,
          marked_full: src.markedFull === true,
          pool_id: src.poolId || null,
          family_group_id: null,
          instructor: src.legacyInstructor || null
        }]);
        const newId = inserted?.[0]?.id;
        if(newId){
          if(enrolledRegular.length){
            await insertRows('weekly_session_students', enrolledRegular.map(s => ({
              session_id: newId,
              student_id: s.studentId || null,
              student_name: s.name || '',
              student_age: s.age != null ? Number(s.age) : null,
              remark: s.remark || null,
              is_replacement: false,
              attendance_status: 'pending'
            })));
          }
          if(src.instructors && src.instructors.length){
            try{
              await insertRows('session_instructors', src.instructors.map(i => ({
                session_id: newId, instructor_id: i.id
              })));
            } catch(_){}
          }
          created++;
        }
      }
      await loadSessions();
      setModal(null);
      setStatus(`Duplicated: ${created} session${created===1?'':'s'} created for the next ${n} week${n===1?'':'s'}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to duplicate session forward'); }
  }

  async function duplicatePreviousWeek(){
    try{
      if(!isFutureSelectedWeek){ alert('Week duplication is only available for a future week.'); return; }
      const prevWeekStart = addDays(selectedWeekStart, -7);
      const sourceSessions = sessions
        .filter(s => s.weekStartDate === prevWeekStart && !s.cancelledAt)
        .sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
      if(!sourceSessions.length){ alert('No classes found in the previous week to duplicate.'); return; }
      // Pre-count trial swimmers in the source so we can mention it in the confirm prompt.
      const trialInSource = sourceSessions.reduce((n, s) => n + (s.students || []).filter(st => st.studentId && trialStudentIds.has(st.studentId)).length, 0);
      const trialNote = trialInSource
        ? `\n\nNote: ${trialInSource} trial swimmer${trialInSource===1?'':'s'} on these classes won’t be carried over — trial bookings are one-offs by design. Re-add them next week if they convert to a regular package.`
        : '';
      if(!confirm(`Duplicate all classes from ${prevWeekStart} into ${selectedWeekStart}? Existing classes in the selected week will remain.${trialNote}`)) return;
      // Rescheduled personal sessions: restore original day/time for the new week.
      // Replacement students: one-off only — skip on duplicate.
      const payload = sourceSessions.map(s => ({
        week_start_date: selectedWeekStart,
        // If session was rescheduled for last week, restore its canonical position.
        weekday:      s.rescheduledFromDay          != null ? s.rescheduledFromDay + 1          : s.day + 1,
        start_minute: s.rescheduledFromStartMinute  != null ? s.rescheduledFromStartMinute  : s.startMinute,
        duration_minutes: s.durationMinutes,
        lesson_type: s.type,
        lesson_type_id: s.lessonTypeId,
        marked_full: s.markedFull === true,
        pool_id: s.poolId,
        family_group_id: s.familyGroupId || null,
        instructor: s.legacyInstructor,
        rescheduled_from_day: null,           // clear reschedule flag in the new week
        rescheduled_from_start_minute: null
      }));
      const inserted = await insertRows('weekly_sessions', payload);
      const studentPayload = [];
      const instructorPayload = [];
      let skippedTrials = 0, skippedReplacements = 0;
      (inserted || []).forEach((row, idx) => {
        const src = sourceSessions[idx];
        (src.students || []).forEach(st => {
          if(st.isReplacement){ skippedReplacements++; return; } // one-off — do not carry forward
          if(st.studentId && trialStudentIds.has(st.studentId)){ skippedTrials++; return; }
          studentPayload.push({ session_id: row.id, student_id: st.studentId || null, student_name: st.name, student_age: (st.age === null || st.age === undefined) ? null : Number(st.age) });
        });
        (src.instructors || []).forEach(it => instructorPayload.push({ session_id: row.id, instructor_id: it.id }));
      });
      if(studentPayload.length) await insertRows('weekly_session_students', studentPayload);
      if(instructorPayload.length) await insertRows('session_instructors', instructorPayload);
      await loadSessions();
      const skips = [skippedTrials ? `${skippedTrials} trial` : null, skippedReplacements ? `${skippedReplacements} replacement` : null].filter(Boolean);
      setStatus(`Duplicated ${sourceSessions.length} class${sourceSessions.length===1?'':'es'} from previous week${skips.length ? ` · skipped ${skips.join(' and ')} swimmer${(skippedTrials+skippedReplacements)===1?'':'s'}` : ''}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to duplicate previous week'); }
  }

  async function clearDayClasses(dayIndex){
    try{
      if(!isFutureSelectedWeek){ alert('You can only remove all classes for a future week. Current week and past weeks are protected.'); return; }
      const dayLabel = DAYS_F[dayIndex];
      const targets = sessions.filter(s => s.weekStartDate === selectedWeekStart && s.day === dayIndex);
      if(!targets.length){ alert(`No classes found for ${dayLabel} in the selected week.`); return; }
      if(!confirm(`Remove all classes for ${dayLabel} in the week starting ${selectedWeekStart}? This will not affect the current week or any past week.`)) return;
      for(const s of targets){
        await deleteRows('weekly_session_students', { session_id: s.id });
        await deleteRows('session_instructors', { session_id: s.id });
        await deleteRows('weekly_sessions', { id: s.id });
      }
      await loadSessions();
      setStatus(`Removed ${targets.length} class${targets.length===1?'':'es'} for ${dayLabel}.`);
    } catch(err){ handleErr(err); alert(err.message || 'Failed to remove day classes'); }
  }

  // Export the selected week as a multi-tab attendance roster (one tab per day
  // that has classes), mirroring the AquaLabz monthly-roster layout: numbered
  // student rows with Name/Age/Gender/Remarks, a per-date attendance column,
  // a payment/notes column, and a teacher signature line per class.
  function exportWeekExcel(){
    if(typeof XLSX === 'undefined'){ alert('Excel library is still loading. Please try again in a moment.'); return; }
    const DSHORT = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const sheets = [];
    for(let day = 0; day < 7; day++){
      const ds = addDays(selectedWeekStart, day);
      const dObj = fromDateStr(ds);
      const daySessions = weekSessions.filter(s => s.day === day).sort((a,b) => a.startMinute - b.startMinute || String(a.type).localeCompare(String(b.type)));
      if(!daySessions.length) continue;
      const dateLabel = `${dObj.getDate()}/${dObj.getMonth()+1}/${dObj.getFullYear()}`;
      const longDay = dObj.toLocaleDateString(undefined, { weekday:'long', day:'numeric', month:'long', year:'numeric' });
      const aoa = [];
      const merges = [];
      const mergeFull = (r) => merges.push({ s:{ r, c:0 }, e:{ r, c:6 } });
      mergeFull(aoa.length); aoa.push([`AquaLabz — ${longDay}`,'','','','','','']);
      mergeFull(aoa.length); aoa.push(['✓ = attended,  X = absent','','','','','','']);
      aoa.push(['','','','','','','']);
      daySessions.forEach(s => {
        const lt = lessonTypeByName(s.type);
        const cap = lt && lt.students_per_instructor ? Number(lt.students_per_instructor) : 0;
        const instr = s.instructors.map(i=>i.name).join(', ') || s.legacyInstructor || '';
        const pool = poolById(s.poolId)?.name || '';
        const titleBits = [s.type || 'Class', formatRange(s.startMinute, s.durationMinutes)];
        if(pool) titleBits.push(pool);
        if(instr) titleBits.push(instr);
        mergeFull(aoa.length); aoa.push([titleBits.join('  ·  '),'','','','','','']);
        aoa.push(['No.','Name','Age','Gender','Remarks', dateLabel, 'Payment / Notes']);
        s.students.forEach((stu, i) => aoa.push([i+1, stu.name || '', (stu.age === null || stu.age === undefined || stu.age === '') ? '' : stu.age, '', stu.remark || '', '', '']));
        const fillTo = Math.max(cap, s.students.length) + 2;
        for(let i = s.students.length; i < fillTo; i++) aoa.push([i+1, '', '', '', '', '', '']);
        aoa.push(['','','','','','T : ____________________','']);
        aoa.push(['','','','','','','']);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{wch:5},{wch:30},{wch:8},{wch:11},{wch:22},{wch:13},{wch:28}];
      ws['!merges'] = merges;
      sheets.push({ name: `${DSHORT[day]} ${dObj.getDate()} ${dObj.toLocaleDateString(undefined,{month:'short'})}`.slice(0,31), ws });
    }
    if(!sheets.length){ alert('No classes are scheduled in this week, so there is nothing to export.'); return; }
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => XLSX.utils.book_append_sheet(wb, s.ws, s.name));
    const start = fromDateStr(selectedWeekStart);
    const end = fromDateStr(addDays(selectedWeekStart, 6));
    const fmt = (d) => `${d.getDate()} ${d.toLocaleDateString(undefined,{month:'short'})}`;
    const fname = `${start.toLocaleDateString(undefined,{month:'long'})} ${start.getFullYear()} (${fmt(start)} - ${fmt(end)}).xlsx`;
    XLSX.writeFile(wb, fname);
    setStatus(`Exported ${sheets.length} day${sheets.length===1?'':'s'} to ${fname}`);
  }

  const monthDates = monthCells(monthCursor);
  const selectedItems = sessionsForDate(selectedDate);
  // selectedWeekLabel removed — the header now shows today's date instead.
  const lessonTypeCounts = useMemo(() => {
    const m = {};
    sessions.forEach(s => { if(s.lessonTypeId) m[s.lessonTypeId] = (m[s.lessonTypeId] || 0) + 1; });
    return m;
  }, [sessions]);

  // Set of swimmer IDs currently on a "trial" package (one-off bookings). Drives
  // the trial annotation in the modal/cards and the duplicate-week skip rule.
  const trialStudentIds = useMemo(() => {
    const trialPkgIds = new Set((options.packages || []).filter(p => (p.name || '').toLowerCase().includes('trial')).map(p => p.id));
    const ids = new Set();
    students.forEach(s => { if(s.packageId && trialPkgIds.has(s.packageId)) ids.add(s.id); });
    return ids;
  }, [students, options.packages]);
  // Lesson-type-scoped trial lookup: trialByLessonType[ltId] is the Set of
  // trial student IDs enrolled in that lesson type. A student in the global
  // trial set who's only enrolled in LTS won't appear under PERSONAL —
  // matching the policy that "trial" is per-lesson-type, not global.
  const trialByLessonType = useMemo(() => {
    const m = {};
    students.forEach(s => {
      if(!trialStudentIds.has(s.id)) return;
      (s.lessonTypeIds || []).forEach(ltId => {
        if(!m[ltId]) m[ltId] = new Set();
        m[ltId].add(s.id);
      });
    });
    return m;
  }, [students, trialStudentIds]);
  const groupById = useMemo(() => { const m = {}; familyGroups.forEach(g => m[g.id] = g); return m; }, [familyGroups]);
  // Multi-group membership derived from the junction table when available,
  // falling back to the legacy single-FK column. Two related maps:
  //   • groupIdsByStudent: studentId → Set<groupId>
  //   • membersByGroup:    groupId → student rows
  const { groupIdsByStudent, membersByGroup, studentsWithGroups } = useMemo(() => {
    const idsByStu = {};
    const byGroup = {};
    if(groupMemberships === null){
      // Legacy fallback path (junction table not migrated yet)
      students.forEach(s => {
        if(s.familyGroupId){
          idsByStu[s.id] = new Set([s.familyGroupId]);
          (byGroup[s.familyGroupId] = byGroup[s.familyGroupId] || []).push(s);
        }
      });
    } else {
      const stuById = {}; students.forEach(s => { stuById[s.id] = s; });
      (groupMemberships || []).forEach(m => {
        if(!idsByStu[m.studentId]) idsByStu[m.studentId] = new Set();
        idsByStu[m.studentId].add(m.familyGroupId);
        const s = stuById[m.studentId];
        if(s){ (byGroup[m.familyGroupId] = byGroup[m.familyGroupId] || []).push(s); }
      });
    }
    // Enriched student rows carrying their full group-set for downstream consumers.
    const withGroups = students.map(s => ({
      ...s,
      familyGroupIds: idsByStu[s.id] ? Array.from(idsByStu[s.id]) : [],
      // Keep legacy singular `familyGroupId` populated with the first group
      // for back-compat with code paths that haven't been refactored yet.
      familyGroupId: idsByStu[s.id] ? Array.from(idsByStu[s.id])[0] : null
    }));
    return { groupIdsByStudent: idsByStu, membersByGroup: byGroup, studentsWithGroups: withGroups };
  }, [students, groupMemberships]);

  // Indexed by id but using the ENRICHED row set so callers can read
  // `.familyGroupIds` (the multi-group array) — needed by the SessionModal's
  // bound-cascade logic, the Billing Preview, and any other consumer that
  // wants to know all groups a swimmer is in. MUST be declared AFTER the
  // destructuring above so `studentsWithGroups` is in scope.
  const studentById = useMemo(() => { const m = {}; (studentsWithGroups || []).forEach(s => m[s.id] = s); return m; }, [studentsWithGroups]);

  // parentGroups: nest swimmers under their guardian (parent) account.
  // When account_id is populated (post-migration) each account is truly
  // isolated — two guardians sharing an email are separate accounts.
  // Pre-migration fallback: cluster on email → phone → name as before.
  const parentGroups = useMemo(() => {
    const m = {};
    // Pre-filter by current branch (header selector) — shows only this branch's accounts.
    // Accounts with no branchId on their swimmers are shown in every branch.
    const branchFiltered = currentBranchId && currentBranchId !== 'all'
      ? (studentsWithGroups || []).filter(s => !s.branchId || s.branchId === currentBranchId)
      : (studentsWithGroups || []);
    branchFiltered.forEach(s => {
      // Prefer the stable account_id once the migration has run
      let key;
      if(s.accountId){
        key = `id:${s.accountId}`;
      } else {
        const emailKey = (s.guardianEmail || '').toLowerCase().trim();
        const phoneKey = (s.guardianPhone || '').replace(/\s+/g,'').trim();
        const nameKey  = (s.guardianName  || '').toLowerCase().trim();
        key = emailKey ? `e:${emailKey}` : phoneKey ? `p:${phoneKey}` : nameKey ? `n:${nameKey}` : '__unassigned__';
      }
      if(!m[key]){
        const rawId = s.accountId || '';
        const displayCode = rawId ? 'AC·' + rawId.replace(/-/g,'').slice(0,6).toUpperCase() : '';
        m[key] = {
          key,
          displayCode,
          accountId: s.accountId || null,
          branchId: s.branchId || null,   // dominant branch from first swimmer
          name: s.guardianName || (key === '__unassigned__' ? '— Unassigned —' : '— No name —'),
          email: s.guardianEmail || '',
          phone: s.guardianPhone || '',
          ic: s.guardianIc || '',
          tin: s.guardianTin || '',
          emergencyPhone: s.emergencyPhone || '',
          emergencyName: s.emergencyName || '',
          emergencyRelationship: s.emergencyRelationship || '',
          emergencySameAsGuardian: !!s.emergencySameAsGuardian,
          swimmers: []
        };
      }
      m[key].swimmers.push(s);
    });
    Object.values(m).forEach(pg => {
      pg.isActive = pg.swimmers.some(s => s.isActive !== false);
    });
    return Object.values(m).sort((a,b) => {
      if(a.key === '__unassigned__') return 1;
      if(b.key === '__unassigned__') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [studentsWithGroups, currentBranchId]);

  // All accounts across every branch (NOT branch-filtered) — for the Sales module's
  // "invoice to" account picker. Just name/email/phone per guardian account.
  const allAccountsForSale = useMemo(() => {
    const byAcct = {};
    (students||[]).forEach(s => {
      if(s.isActive===false) return;
      const gname=(s.guardianName||'').trim();
      if(!gname) return;
      const key = s.accountId || ('n:'+gname.toLowerCase());
      if(!byAcct[key]) byAcct[key]={ key, name:gname, email:s.guardianEmail||'', phone:s.guardianPhone||'', count:0 };
      if(!byAcct[key].email && s.guardianEmail) byAcct[key].email=s.guardianEmail;
      if(!byAcct[key].phone && s.guardianPhone) byAcct[key].phone=s.guardianPhone;
      byAcct[key].count++;
    });
    return Object.values(byAcct).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  }, [students]);

  // Which sessions (in the selected week) each swimmer is already in — drives the
  // double-booking warning in the enrollment modal.
  const weekEnrollments = useMemo(() => {
    const m = {};
    weekSessions.forEach(s => {
      // Cancelled ghosts retain their student rows for restore purposes
      // but those swimmers aren't actually booked into this slot anymore —
      // skip the ghost so the double-booking warning doesn't false-fire.
      if(s.cancelledAt) return;
      s.students.forEach(st => {
        if(!st.studentId) return;
        (m[st.studentId] = m[st.studentId] || []).push({ day:s.day, startMinute:s.startMinute, type:s.type, sessionId:s.id });
      });
    });
    return m;
  }, [weekSessions]);

  // Each swimmer's recurring class slots across all weeks, de-duplicated by
  // (lesson type, weekday, start), for the Swimmers tab schedule column.
  const scheduleByStudent = useMemo(() => {
    const m = {};
    sessions.forEach(s => s.students.forEach(st => {
      const id = st.studentId; if(!id) return;
      const key = `${s.type}|${s.day}|${s.startMinute}`;
      if(!m[id]) m[id] = {};
      if(!m[id][key]) m[id][key] = { type:s.type, lessonTypeId:s.lessonTypeId, day:s.day, startMinute:s.startMinute, durationMinutes:s.durationMinutes };
    }));
    const out = {};
    Object.keys(m).forEach(id => { out[id] = Object.values(m[id]).sort((a,b) => a.day - b.day || a.startMinute - b.startMinute); });
    return out;
  }, [sessions]);

  return <div>
    <div className="header"><div className="header-inner">
      {/* Row 1: brand · utility (branch, status, user) */}
      <div className="header-row">
        <a className="brand" href="./index.html" title="Go to mystarswim.com">
          <img src="./logo.png" alt="SSB" className="logo" />
          <div className="brand-titles">
            <div style={{fontSize:14,fontWeight:800,letterSpacing:'-.3px',lineHeight:1}}>{isOnSystemView?'SSB System':'SSB Scheduler'}</div>
            <div className="brand-tagline" style={{fontSize:9,color:'#64748B',marginTop:2,lineHeight:1}}>{isOnSystemView?'Admin & Procurement':'Pool-aware lesson calendar'}</div>
          </div>
        </a>
        <div className="utility-cluster">
          {!isOnSystemView && (() => {
            const b = currentBranchId && currentBranchId!=='all' ? branchById(currentBranchId) : null;
            const style = b?.color ? { '--branch-tint': b.color+'22', '--branch-color': b.color } : {};
            return <div className="branch-selector" data-branch-color={b?.color?'1':undefined} style={style} title="Switch the active branch">
              <select className="branch-select" value={currentBranchId || ''} onChange={e=>setCurrentBranchId(e.target.value || null)}>
                {(options.branches||[]).filter(x=>x.is_active!==false).map(x => <option key={x.id} value={x.id}>{x.code || x.name}</option>)}
                <option value="all">All</option>
              </select>
            </div>;
          })()}
          {!isOnSystemView && <div className="header-summary" title="At a glance"><span style={{color:'var(--primary)',fontWeight:800}}>{summary.totalStudents}</span> students · <span style={{color:'var(--primary)',fontWeight:800}}>{summary.totalSessions}</span> sessions</div>}
          <div className="header-status" title={loading?'Connecting to server…':(error?'Connection error':'All good')}>
            <span className={`status-dot ${loading?'is-loading':(error?'is-error':'is-ok')}`} aria-hidden="true" />
            <span className="header-status-label">{loading ? 'Connecting…' : (error ? 'Error' : (status || 'Ready'))}</span>
          </div>
          {currentUser && <div className="user-chip" title={`Signed in as ${currentUser.username} · Role: ${currentUser.role}`}>
            <span>👤</span>
            <span className="user-name">{currentUser.displayName||currentUser.username}</span>
            <button className="user-logout" onClick={()=>{ if(confirm('Sign out?')) onLogout(); }} title="Sign out">Logout</button>
          </div>}
        </div>
      </div>
      {/* Row 2: primary nav */}
      <nav className="main-nav header-row">
        <div style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:1}}>
        {side==='schedule' && <>
          <button className={`nav-btn ${view==='schedule'?'active':''}`} onClick={()=>setView('schedule')} title="Schedule">📅 <span className="nav-label">Schedule</span></button>
          <button className={`nav-btn ${view==='programme'?'active':''}`} onClick={()=>{ setView('programme'); setProgrammeSection('week'); }} title="Programme">📋 <span className="nav-label">Programme</span></button>
          <button className={`nav-btn ${view==='accounts'?'active':''}`} onClick={()=>{ setView('accounts'); setAccountSection('accounts'); }} title="Accounts">👤 <span className="nav-label">Accounts</span></button>
          <button className={`nav-btn ${view==='shop'?'active':''}`} onClick={()=>setView('shop')} title="Shop">🛒 <span className="nav-label">Shop</span></button>
          <button className={`nav-btn ${view==='messages'?'active':''}`} onClick={()=>setView('messages')} title="Messages" style={{position:'relative'}}>✉️ <span className="nav-label">Messages</span>{newMsgCount>0&&<span style={{position:'absolute',top:2,right:2,background:'#EF4444',color:'#fff',fontSize:10,fontWeight:800,borderRadius:999,minWidth:16,height:16,lineHeight:'16px',padding:'0 4px',textAlign:'center'}}>{newMsgCount>99?'99+':newMsgCount}</span>}</button>
          <button className={`nav-btn ${view==='enroll'?'active':''}`} onClick={()=>setView('enroll')} title="Explore">🔍 <span className="nav-label">Explore</span></button>
          <button type="button" className="nav-btn nav-btn-link" onClick={()=>window.open('./intake.html','_blank','noopener,noreferrer')} title="Intake form (new tab)">📝 <span className="nav-label">Intake ↗</span></button>
          {isSysadmin && <button className={`nav-btn ${view==='settings'?'active':''}`} onClick={()=>{ setView('settings'); setAdminSection('pools'); }} title="Settings">⚙️ <span className="nav-label">Settings</span></button>}
        </>}
        {side==='system' && <>
          <button className={`nav-btn ${view==='adminDirectory'?'active':''}`} onClick={()=>setView('adminDirectory')} title="Directory">📇 <span className="nav-label">Directory</span></button>
          <button className={`nav-btn ${view==='adminVouchers'?'active':''}`} onClick={()=>setView('adminVouchers')} title="Payment Vouchers">🧾 <span className="nav-label">Vouchers</span></button>
          <button className={`nav-btn ${view==='adminCrew'?'active':''}`} onClick={()=>setView('adminCrew')} title="Crew">👥 <span className="nav-label">Crew</span></button>
          <button className={`nav-btn ${view==='adminPromos'?'active':''}`} onClick={()=>setView('adminPromos')} title="Website Promotions">📢 <span className="nav-label">Promotions</span></button>
          <button className={`nav-btn ${view==='attendance'?'active':''}`} onClick={()=>setView('attendance')} title="Attendance">⏱️ <span className="nav-label">Attendance</span></button>
        </>}
        </div>
        {canUseScheduler(currentUser?.role) && canUseAdminSystem(currentUser?.role) && <button type="button" className="nav-btn" style={{background:side==='system'?'#EEF7FD':'#F0FDF4',border:'1px solid var(--border)',fontWeight:800}} onClick={()=>switchSide(side==='schedule'?'system':'schedule')} title={`Switch to ${side==='schedule'?'System':'Scheduling'} side`}>{side==='schedule'?'🏢 System ↔':'📅 Scheduling ↔'}</button>}
      </nav>
      </div>
    </div>{/* end header */}

    {/* ── Mobile bottom app bar (≤820px) — replaces the top nav row ── */}
    {isMobile && currentUser && <nav className="mobile-tabbar" aria-label="Primary">
      {side==='schedule' ? <>
        <button className={`mtab ${view==='schedule'?'active':''}`} onClick={()=>setView('schedule')}><span className="mtab-ic">📅</span>Schedule</button>
        <button className={`mtab ${view==='programme'?'active':''}`} onClick={()=>{ setView('programme'); setProgrammeSection('week'); }}><span className="mtab-ic">📋</span>Programme</button>
        <button className={`mtab ${view==='accounts'?'active':''}`} onClick={()=>{ setView('accounts'); setAccountSection('accounts'); }}><span className="mtab-ic">👤</span>Accounts</button>
        <button className={`mtab ${view==='shop'?'active':''}`} onClick={()=>setView('shop')}><span className="mtab-ic">🛒</span>Shop</button>
      </> : <>
        <button className={`mtab ${view==='adminDirectory'?'active':''}`} onClick={()=>setView('adminDirectory')}><span className="mtab-ic">📇</span>Directory</button>
        <button className={`mtab ${view==='adminVouchers'?'active':''}`} onClick={()=>setView('adminVouchers')}><span className="mtab-ic">🧾</span>Vouchers</button>
        <button className={`mtab ${view==='adminCrew'?'active':''}`} onClick={()=>setView('adminCrew')}><span className="mtab-ic">👥</span>Crew</button>
        <button className={`mtab ${view==='adminPromos'?'active':''}`} onClick={()=>setView('adminPromos')}><span className="mtab-ic">📢</span>Promos</button>
      </>}
      <button className={`mtab ${mobileMoreOpen?'active':''}`} onClick={()=>setMobileMoreOpen(v=>!v)} style={{position:'relative'}}>
        <span className="mtab-ic">☰</span>More
        {side==='schedule' && newMsgCount>0 && <span className="mtab-badge">{newMsgCount>99?'99+':newMsgCount}</span>}
      </button>
    </nav>}

    {/* ── "More" sheet — everything that doesn't fit the bar ── */}
    {isMobile && currentUser && mobileMoreOpen && <div className="more-sheet-backdrop" onClick={()=>setMobileMoreOpen(false)}>
      <div className="more-sheet" onClick={e=>e.stopPropagation()}>
        <div className="more-sheet-grab" aria-hidden="true"></div>
        {side==='schedule' && <>
          <button className="more-item" onClick={()=>{ setView('messages'); }}>✉️ Messages {newMsgCount>0&&<span className="more-badge">{newMsgCount>99?'99+':newMsgCount}</span>}</button>
          <button className="more-item" onClick={()=>{ setView('enroll'); }}>🔍 Explore</button>
          <button className="more-item" onClick={()=>{ window.open('./intake.html','_blank','noopener,noreferrer'); setMobileMoreOpen(false); }}>📝 Intake form ↗</button>
          {isSysadmin && <button className="more-item" onClick={()=>{ setView('settings'); setAdminSection('pools'); }}>⚙️ Settings</button>}
        </>}
        {side==='system' && <button className="more-item" onClick={()=>{ setView('attendance'); }}>⏱️ Attendance</button>}
        {canUseScheduler(currentUser?.role) && canUseAdminSystem(currentUser?.role) &&
          <button className="more-item" onClick={()=>{ switchSide(side==='schedule'?'system':'schedule'); }}>{side==='schedule'?'🏢 Switch to System':'📅 Switch to Scheduling'}</button>}
        <button className="more-item more-item-danger" onClick={()=>{ if(confirm('Sign out?')) onLogout(); }}>🚪 Logout</button>
      </div>
    </div>}

    {/* ── Sub-bar: schedule tabs ── */}
    {!loading && view==='schedule' && <div className="sub-bar"><div className="sub-bar-inner">
      {!isMobile && <button className={`sub-tab ${scheduleSection==='week'?'active':''}`} onClick={()=>setScheduleSection('week')}>Weekly</button>}
      <button className={`sub-tab ${scheduleSection==='day'?'active':''}`} onClick={()=>setScheduleSection('day')}>Daily</button>
      <button className={`sub-tab ${scheduleSection==='month'?'active':''}`} onClick={()=>setScheduleSection('month')}>Monthly</button>
      {/* Inline week navigation — keeps Prev/Range/Next/This Week sticky with the sub-bar */}
      {(scheduleSection==='week' || scheduleSection==='day') && <div className="sub-bar-spacer">
        <div className={`period-stepper ${isMobile?'stepper-sm':''}`} style={{margin:0}}>
          <button className="step-btn" onClick={()=>setSelectedDate(addDays(selectedDate,-7))} title="Previous week" aria-label="Previous week">‹</button>
          <div className="period-label" style={{fontSize:isMobile?11:12}}>{isMobile ? weekRangeLabelShort(selectedWeekStart) : weekRangeLabel(selectedWeekStart)}</div>
          <button className="step-btn" onClick={()=>setSelectedDate(addDays(selectedDate,7))} title="Next week" aria-label="Next week">›</button>
        </div>
        <button className={`today-btn ${selectedWeekStart===currentWeekStart?'is-current':''}`} disabled={selectedWeekStart===currentWeekStart} onClick={()=>setSelectedDate(todayStr())} style={{marginLeft:6}}>{isMobile?'Now':'This Week'}</button>
      </div>}
    </div></div>}

    {/* ── Sub-bar: programme tabs ── */}
    {!loading && view==='programme' && <div className="sub-bar"><div className="sub-bar-inner">
      <button className={`sub-tab ${programmeSection==='week'?'active':''}`} onClick={()=>setProgrammeSection('week')}>Weekly</button>
      <button className={`sub-tab ${programmeSection==='month'?'active':''}`} onClick={()=>setProgrammeSection('month')}>Monthly</button>
      {programmeSection==='week' && <div className="sub-bar-spacer">
        <div className="period-stepper" style={{margin:0}}>
          <button className="step-btn" onClick={()=>setProgrammeDate(addDays(programmeDate,-7))} title="Previous week" aria-label="Previous week">‹</button>
          <div className="period-label" style={{fontSize:12}}>{weekRangeLabel(programmeWeekStart)}</div>
          <button className="step-btn" onClick={()=>setProgrammeDate(addDays(programmeDate,7))} title="Next week" aria-label="Next week">›</button>
        </div>
        <button className={`today-btn ${programmeWeekStart===currentWeekStart?'is-current':''}`} disabled={programmeWeekStart===currentWeekStart} onClick={()=>setProgrammeDate(todayStr())} style={{marginLeft:6}}>This Week</button>
      </div>}
    </div></div>}

    {/* ── Sub-bar: accounts tabs ── */}
    {/* Accounts navigation is now a left-column nav rendered with the content below. */}

    {/* ── Sub-bar: admin tabs ── */}
    {/* Settings navigation is now a left-column nav rendered with the content below. */}


    <div className="wrap">
      {loading ? <div className="card" style={{textAlign:'center',padding:'42px'}}><div style={{fontSize:34,marginBottom:10}}>⏳</div><div>Loading scheduler…</div><div className="small subtle" style={{marginTop:6}}>{status || 'Connecting'}</div></div> : null}
      {!loading && error ? <div className="card error-card"><div style={{fontWeight:800,marginBottom:4}}>Error</div><div className="small">{error}</div></div> : null}

      {/* ── Schedule views ── */}
      {!loading && view==='schedule' && scheduleSection==='week' && <WeekView
        weekBlocks={weekBlocks}
        weekBlocksAllPools={weekBlocksAllPools}
        pools={activePools()}
        selectedPoolId={selectedPoolId}
        setSelectedPoolId={setSelectedPoolId}
        branchLabel={currentBranchId && currentBranchId!=='all' ? (branchById(currentBranchId)?.name || '') : 'All Branches'}
        gridBounds={gridBounds}
        gridSlots={gridSlots}
        slotToMinute={slotToMinute}
        minuteToSlot={minuteToSlot}
        colorsFor={colorsFor}
        lessonTypeByName={lessonTypeByName}
        poolById={poolById}
        onAdd={openAdd}
        onEdit={openEdit}
        activeLessonTypes={activeLessonTypes()}
        selectedDate={selectedDate}
        sessionsForDate={sessionsForDate}
        selectedWeekStart={selectedWeekStart}
        currentWeekStart={currentWeekStart}
        isFutureSelectedWeek={isFutureSelectedWeek}
        onPrevWeek={()=>setSelectedDate(addDays(selectedDate,-7))}
        onNextWeek={()=>setSelectedDate(addDays(selectedDate,7))}
        onThisWeek={()=>setSelectedDate(todayStr())}
        onDuplicateWeek={duplicatePreviousWeek}
        onClearDay={clearDayClasses}
        onJumpToDay={(dayIndex)=>{ const d=fromDateStr(selectedWeekStart); d.setDate(d.getDate()+dayIndex); setSelectedDate(toDateStr(d)); setScheduleSection('day'); }}
        isTypeEnabled={isTypeEnabled}
        onToggleType={toggleType}
        onToggleAllTypes={toggleAllTypes}
        allTypesShown={allTypesShown}
        activeInstructors={activeInstructors()}
        isInstructorActive={isInstructorActive}
        onToggleInstructor={toggleInstructor}
        onClearInstructors={clearInstructors}
        instructorFilterActive={selectedInstructors.size > 0}
        weekPendingReplacements={replacementPending.filter(p => {
          // Show on the selected week AND any past-week limbo records that
          // were never placed (they remain pending until manually resolved).
          // Only future-week (>selectedWeekStart) records are hidden until
          // their own week becomes the selected week.
          if(p.week_start_date > selectedWeekStart) return false;
          // Branch filter: only show replacements whose student belongs to the current branch
          if(currentBranchId && currentBranchId !== 'all'){
            const stu = studentById[p.student_id];
            if(stu && stu.branchId && stu.branchId !== currentBranchId) return false;
          }
          return true;
        })}
        lessonTypeById={lessonTypeById}
        studentById={studentById}
        onCancelPendingReplacement={cancelPendingReplacement}
        pendingMove={pendingMove}
        onPlacePendingMove={placePendingMove}
        onCancelPendingMove={cancelPendingMove}
        onExportExcel={exportWeekExcel}
        trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType}
        creditByKey={creditByKey}
        highlightedSessionId={highlightedSessionId}
        onReorderSlot={saveDragOrder}
      />}

      {!loading && view==='schedule' && scheduleSection==='day' && <DailyView
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        sessionsForDate={filteredSessionsForDate} colorsFor={colorsFor}
        lessonTypeByName={lessonTypeByName} poolById={poolById}
        branchLabel={currentBranchId && currentBranchId!=='all' ? (branchById(currentBranchId)?.name || '') : 'All Branches'}
        onAddAtTime={openAddAtTime} onEdit={openEdit}
        onReorderSlot={saveDragOrder}
        selectedWeekStart={selectedWeekStart}
        currentWeekStart={currentWeekStart}
        onPrevWeek={()=>setSelectedDate(addDays(selectedDate,-7))}
        onNextWeek={()=>setSelectedDate(addDays(selectedDate,7))}
        onThisWeek={()=>setSelectedDate(todayStr())}
        onExportExcel={exportWeekExcel}
        activeLessonTypes={activeLessonTypes()}
        isTypeEnabled={isTypeEnabled}
        onToggleType={toggleType}
        onToggleAllTypes={toggleAllTypes}
        allTypesShown={allTypesShown}
        activeInstructors={activeInstructors()}
        isInstructorActive={isInstructorActive}
        onToggleInstructor={toggleInstructor}
        onClearInstructors={clearInstructors}
        instructorFilterActive={selectedInstructors.size > 0}
        trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType}
        creditByKey={creditByKey}
      />}

      {!loading && view==='schedule' && scheduleSection==='month' && <MonthView
        monthCursor={monthCursor} setMonthCursor={setMonthCursor}
        selectedDate={selectedDate} setSelectedDate={setSelectedDate}
        monthDates={monthDates} sessionsForDate={sessionsForDate} colorsFor={colorsFor}
        remarks={remarks} remarkDraft={remarkDraft} setRemarkDraft={setRemarkDraft} saveRemark={saveRemark}
        selectedItems={selectedItems}
      />}

      {/* ── Programme views ── */}
      {!loading && view==='programme' && programmeSection==='week' && <ProgrammeWeekView
        programmeWeekDays={programmeWeekDays}
        pools={activePools()}
        selectedPoolId={programmePoolId}
        setSelectedPoolId={setProgrammePoolId}
        gridBounds={gridBounds}
        categoryById={programmeCategoryById}
        poolById={poolById}
        instructorById={progInstructorById}
        onAdd={openProgrammeCreate}
        onEdit={openProgrammeEdit}
        selectedWeekStart={programmeWeekStart}
        currentWeekStart={currentWeekStart}
        onPrev={()=>setProgrammeDate(addDays(programmeDate,-7))}
        onNext={()=>setProgrammeDate(addDays(programmeDate,7))}
        onToday={()=>setProgrammeDate(todayStr())}
        branchLabel={currentBranchId && currentBranchId!=='all' ? (branchById(currentBranchId)?.name || '') : 'All Branches'}
      />}
      {!loading && view==='programme' && programmeSection==='month' && <ProgrammeMonthView
        monthCursor={programmeMonthCursor} setMonthCursor={setProgrammeMonthCursor}
        monthDates={programmeMonthDates}
        selectedDate={programmeDate} setSelectedDate={setProgrammeDate}
        programmeSessionsForDate={programmeSessionsForDate}
        categoryById={programmeCategoryById}
        instructorById={progInstructorById}
        onAdd={openProgrammeCreate}
        onEdit={openProgrammeEdit}
      />}

      {!loading && view==='shop' && <SalesView
        accounts={allAccountsForSale}
        products={products}
        branches={options.branches||[]}
        currentBranchId={currentBranchId}
        invoices={invoices}
        pmts={pmts}
        onRefund={refundInvoice}
        onCreateSale={createProductSale}
        onViewInvoices={()=>{ setView('accounts'); setAccountSection('invoices'); }}
      />}

      {/* ── Messages (website enquiries) ── */}
      {!loading && view==='messages' && <MessagesView
        messages={contactMessages}
        onMarkRead={markMessageRead}
        onMarkAllRead={markAllMessagesRead}
        onDelete={deleteContactMessage}
        onRefresh={loadContactMessages}
      />}

      {/* ── Admin & Procurement (System side) ── */}
      {!loading && side==='system' && view==='adminDirectory' && canSystem && <AdminDirectoryView
        companies={adminCompanies}
        contacts={adminContacts}
        categories={adminCategories}
        addCategory={adminAddCategory}
        updateCategory={adminUpdateCategory}
        deleteCategory={adminDeleteCategory}
        saveCompany={adminSaveCompany}
        deleteCompany={adminDeleteCompany}
        saveContact={adminSaveContact}
        deleteContact={adminDeleteContact}
        onRefresh={loadAdminAll}
      />}
      {!loading && side==='system' && view==='adminVouchers' && canSystem && <AdminVouchersView isSysadmin={isSysadmin}
        vouchers={adminVouchers}
        payees={adminPayees}
        savePayee={adminSavePayee}
        deletePayee={adminDeletePayee}
        saveVoucher={adminSaveVoucher}
        setVoucherStatus={adminSetVoucherStatus}
        onRefresh={loadAdminAll}
      />}
      {!loading && side==='system' && view==='adminCrew' && canSystem && <AdminCrewView loadFailed={adminCrewLoadFailed} importEmployees={adminImportEmployees}
        employees={adminEmployees}
        canManageLogins={isSysadmin}
        provisionLogin={crewProvisionLogin}
        resetLogin={crewResetLogin}
        unlinkLogin={crewUnlinkLogin}
        saveEmployee={adminSaveEmployee}
        deleteEmployee={adminDeleteEmployee}
        onRefresh={loadAdminAll}
      />}
      {!loading && side==='system' && view==='attendance' && canSystem && <>
        <div className="sub-bar"><div className="sub-bar-inner">
          <button className={`sub-tab ${attendanceSection==='live'?'active':''}`} onClick={()=>setAttendanceSection('live')}>Live</button>
          <button className={`sub-tab ${attendanceSection==='roster'?'active':''}`} onClick={()=>setAttendanceSection('roster')}>Roster</button>
          <button className={`sub-tab ${attendanceSection==='alerts'?'active':''}`} onClick={()=>setAttendanceSection('alerts')}>
            Alerts{attOpenAlertCount>0 && <span style={{marginLeft:6,background:'#EF4444',color:'#fff',
              fontSize:10,fontWeight:800,borderRadius:999,padding:'1px 6px'}}>{attOpenAlertCount}</span>}
          </button>
          <button className={`sub-tab ${attendanceSection==='report'?'active':''}`} onClick={()=>setAttendanceSection('report')}>Report</button>
          <button className={`sub-tab ${attendanceSection==='locations'?'active':''}`} onClick={()=>setAttendanceSection('locations')}>Locations</button>
        </div></div>
        {attBlocked && <div className="card" style={{borderColor:'#FCD34D',background:'#FFFBEB'}}>
          <div style={{fontWeight:700,marginBottom:4}}>Attendance data is not available for this login.</div>
          <div className="small">These tables require a Supabase Auth session. Sign out and sign in again to pick one up; if it still fails, the Phase 2 SQL and the updated <code>login</code> function may not be deployed yet.</div>
        </div>}
        {!attBlocked && attendanceSection==='live' && <AttendanceLiveView
          shifts={attToday}
          punches={attPunches}
          locations={attLocations}
          categories={attCategories}
          employees={adminEmployees}
          lastLoaded={attLoadedAt}
          onRefresh={loadAttendanceLive}
        />}
        {!attBlocked && attendanceSection==='alerts' && <AttendanceAlertsView
          alerts={attAlerts}
          shifts={attAlertShifts}
          locations={attLocations}
          employees={adminEmployees}
          filter={attAlertFilter} setFilter={setAttAlertFilter}
          resolveAlert={attResolveAlert}
          enterPunch={attEnterPunch}
          onRefresh={loadAttendanceAlerts}
        />}
        {!attBlocked && attendanceSection==='report' && <AttendanceReportView
          shifts={attReportShifts}
          categories={attCategories}
          employees={adminEmployees}
          mode={attReportMode} setMode={setAttReportMode}
          anchor={attReportAnchor} setAnchor={setAttReportAnchor}
          rangeLabel={attReportRange.label}
          from={attReportRange.from} to={attReportRange.to}
        />}
        {!attBlocked && attendanceSection==='locations' && <AttendanceLocationsView
          locations={attLocations}
          settings={attSettings}
          saveLocation={attSaveLocation}
          retireLocation={attRetireLocation}
        />}
        {!attBlocked && attendanceSection==='roster' && <AttendanceRosterView
          shifts={attShifts}
          locations={attLocations}
          categories={attCategories}
          employees={adminEmployees}
          weekStart={attWeekStart}
          setWeekStart={setAttWeekStart}
          saveShift={attSaveShift}
          voidShift={attVoidShift}
          copyPreviousWeek={attCopyPreviousWeek}
          addShiftSeries={attAddShiftSeries}
        />}
      </>}
      {!loading && side==='system' && view==='adminPromos' && canSystem && <AdminPromosView
        promos={promos}
        savePromo={adminSavePromo}
        deletePromo={adminDeletePromo}
        toggleActive={adminTogglePromoActive}
        onRefresh={loadAdminAll}
      />}

      {/* ── Accounts views (no side-column for billing sub-sections) ── */}
      {/* ── Accounts: left-column nav + content ── */}
      {!loading && view==='accounts' && <div className="side-shell">
        <SectionNav ariaLabel="Accounts section" value={accountSection} onChange={setAccountSection}
          items={[['accounts','Accounts'],['familyGroups','Groups'],['swimmers','Swimmers'],['invoices','Invoices'],['receipts','Receipts'],['pendingCredits','Pending Credits'],['aging','Aging'],['codes','Discounts'],...(isSysadmin?[['reports','Reports']]:[])]} />
        <div className="side-content">
          {['accounts','familyGroups','swimmers','invoices','receipts'].includes(accountSection) && <div style={{marginBottom:12,maxWidth:440}}>
            <input className="input" value={accountSearchQ} onChange={e=>setAccountSearchQ(e.target.value)}
              placeholder={accountSection==='swimmers' ? 'Search swimmer, parent, phone…'
                         : accountSection==='invoices' ? 'Search invoice # or account…'
                         : accountSection==='receipts' ? 'Search receipt #, invoice, account…'
                         : accountSection==='familyGroups' ? 'Search group or member…'
                         : 'Search account, email, phone, swimmer…'} />
          </div>}
      {!loading && view==='accounts' && (accountSection==='accounts'||accountSection==='familyGroups') && <ParentsView
        externalSearchQ={accountSearchQ}
        branches={options.branches||[]}
        accountSection={accountSection}
        setAccountSection={setAccountSection}
        parentGroups={parentGroups}
        lessonTypes={activeLessonTypes()}
        lessonTypeById={lessonTypeById}
        packages={activePackages()}
        products={products}
        packageById={packageById}
        familyGroups={currentBranchId && currentBranchId !== 'all'
          ? (familyGroups || []).filter(g => {
              const gid = g.id;
              return (studentsWithGroups || []).some(s =>
                (s.familyGroupIds || []).includes(gid) && (!s.branchId || s.branchId === currentBranchId)
              );
            })
          : familyGroups}
        groupById={groupById}
        membersByGroup={membersByGroup}
        creditByKey={creditByKey}
        subscriptions={subscriptions}
        addStudent={addStudent}
        updateStudent={updateStudent}
        deleteStudent={deleteStudent} deleteAccount={deleteAccount}
        addGroup={addGroup}
        updateGroup={updateGroup}
        deleteGroup={deleteGroup}
        setStudentGroup={setStudentGroup}
        addStudentToGroup={addStudentToGroup}
        removeStudentFromGroup={removeStudentFromGroup}
        groupIdsByStudent={groupIdsByStudent}
        addSubscription={addSubscription}
        cancelSubscription={cancelSubscription}
        adjustBalanceTo={adjustBalanceTo}
        scheduleByStudent={scheduleByStudent}
        sessions={sessions}
        poolById={poolById}
        selectedWeekStart={selectedWeekStart}
        createInvoice={createInvoice}
        setAdminSection={setAdminSection}
        onJumpToSession={jumpToSession}
        setView={setView}
      />}
      {!loading && view==='accounts' && accountSection==='swimmers' && <StudentsView
        externalSearchQ={accountSearchQ}
        students={currentBranchId && currentBranchId !== 'all'
          ? students.filter(s => !s.branchId || s.branchId === currentBranchId)
          : students}
        lessonTypes={activeLessonTypes()} lessonTypeById={lessonTypeById}
        packages={activePackages()} packageById={packageById}
        groupById={groupById} familyGroups={familyGroups} membersByGroup={membersByGroup}
        scheduleByStudent={scheduleByStudent} sessions={sessions}
        jumpToWeek={(weekStartDate, dayIndex)=>{ const d=fromDateStr(weekStartDate); d.setDate(d.getDate()+(dayIndex||0)); setSelectedDate(toDateStr(d)); setView('schedule'); setScheduleSection('week'); }}
        creditByKey={creditByKey} purchasesByStudent={purchasesByStudent}
        subscriptions={subscriptions} addCreditPurchase={addCreditPurchase}
        deleteCreditPurchase={deleteCreditPurchase} addSubscription={addSubscription}
        cancelSubscription={cancelSubscription} adjustBalanceTo={adjustBalanceTo}
        addStudent={addStudent} updateStudent={updateStudent} deleteStudent={deleteStudent} deleteAccount={deleteAccount}
      />}
      {!loading && view==='accounts' && accountSection==='invoices' && <InvoicesView
        externalSearchQ={accountSearchQ}
        branches={options.branches||[]}
        invoices={invoices} invoiceLines={invoiceLines} pmts={pmts}
        pendingCredits={pendingCredits} lessonTypeById={lessonTypeById}
        packageById={packageById} studentById={studentById}
        products={products}
        membersByGroup={membersByGroup}
        invoiceSettings={invoiceSettings} paymentMethods={paymentMethods} onSaveSettings={saveInvoiceSettings}
        formatInvoiceNumber={formatInvoiceNumber} formatReceiptNumber={formatReceiptNumber}
        onVoid={voidInvoice} onDelete={invoiceSettings.allow_delete_invoice ? deleteInvoice : null} onRefund={refundInvoice} onEditVoidReason={updateVoidReason} onUpdateStatus={updateInvoiceStatus}
        onRecordPayment={recordPayment} onConfirmCredit={confirmCredit}
        onReverseCredit={reverseCredit} onAddLine={addInvoiceLine}
        onUpdateLine={updateInvoiceLine} onDeleteLine={deleteInvoiceLine}
      />}
      {!loading && view==='accounts' && accountSection==='receipts' && <ReceiptsView externalSearchQ={accountSearchQ} pmts={pmts} invoices={invoices} branches={options.branches||[]} />}
      {!loading && view==='accounts' && accountSection==='pendingCredits' && <PendingCreditsView
        branches={options.branches||[]}
        pendingCredits={currentBranchId && currentBranchId !== 'all'
          ? pendingCredits.filter(pc => {
              // Priority 1: use the invoice's branch_id — most reliable for both
              // individual and group/family credits since invoices are stamped at creation.
              if(pc.invoice_id){
                const inv = invoices.find(i => i.id === pc.invoice_id);
                if(inv){
                  if(!inv.branch_id) return true; // unassigned invoice → show everywhere
                  return inv.branch_id === currentBranchId;
                }
              }
              // Priority 2: fall back to the individual student's branchId
              if(pc.student_id){
                const stu = studentById[pc.student_id];
                if(stu){
                  if(!stu.branchId) return true; // unassigned student → show everywhere
                  return stu.branchId === currentBranchId;
                }
              }
              // No anchor found (old data with no branch info) → show in all branches
              return true;
            })
          : pendingCredits} invoices={invoices}
        studentById={studentById} familyGroups={familyGroups}
        groupById={id => groupById[id]} lessonTypeById={lessonTypeById}
        packageById={packageById} onConfirm={confirmCredit} onReverse={reverseCredit}
      />}
      {!loading && view==='accounts' && accountSection==='aging' && <AgingReportView invoices={invoices} pmts={pmts} branches={options.branches||[]} />}
      {!loading && view==='accounts' && accountSection==='reports' && isSysadmin && <ReportsView
        invoices={invoices} pmts={pmts} pendingCredits={pendingCredits}
        students={students} sessions={sessions}
        creditBalances={creditBalances}
        currentBranchId={currentBranchId}
        branches={options.branches||[]} lessonTypes={activeLessonTypes()}
        lessonTypeById={lessonTypeById}
      />}
      {!loading && view==='accounts' && accountSection==='codes' && <SettingsView
        section="codes" options={options}
        addOption={addOption} toggleOption={toggleOption} deleteOption={deleteOption}
        codes={codes} students={students} packages={options.packages}
        addCode={addCode} updateCode={updateCode} deleteCode={deleteCode}
        pools={activePools()} onUpdatePool={updatePool}
      />}
        </div>
      </div>}

      {/* ── Explore ── */}
      {!loading && view==='enroll' && <EnrollView
        sessions={sessions.filter(s => {
          if(!currentBranchId || currentBranchId === 'all') return true;
          // A session belongs to a branch via its pool's branch_id
          const pool = poolById(s.poolId);
          if(!pool) return true; // no pool assigned — show in all branches
          return !pool.branch_id || pool.branch_id === currentBranchId;
        })}
        students={students} studentById={studentById}
        lessonTypes={activeLessonTypes()} lessonTypeById={lessonTypeById}
        lessonTypeByName={lessonTypeByName} poolById={poolById} colorsFor={colorsFor}
        gridBounds={gridBounds} packages={options.packages} instructors={activeInstructors()}
        initialWeekStart={selectedWeekStart} onEnroll={openEnroll}
        onCreate={openCreateFor} onEdit={openEdit}
        onAdd={(day, startMinute, poolId, weekStart) => openAddForWeek(weekStart, day, startMinute, poolId)}
      />}

      {/* ── Swimmers (legacy direct link) ── */}
      {!loading && view==='students' && <StudentsView
        students={students} lessonTypes={activeLessonTypes()} lessonTypeById={lessonTypeById}
        packages={activePackages()} packageById={packageById}
        groupById={groupById} familyGroups={familyGroups} membersByGroup={membersByGroup}
        scheduleByStudent={scheduleByStudent} sessions={sessions}
        jumpToWeek={(weekStartDate, dayIndex)=>{ const d=fromDateStr(weekStartDate); d.setDate(d.getDate()+(dayIndex||0)); setSelectedDate(toDateStr(d)); setView('schedule'); setScheduleSection('week'); }}
        creditByKey={creditByKey} purchasesByStudent={purchasesByStudent}
        subscriptions={subscriptions} addCreditPurchase={addCreditPurchase}
        deleteCreditPurchase={deleteCreditPurchase} addSubscription={addSubscription}
        cancelSubscription={cancelSubscription} adjustBalanceTo={adjustBalanceTo}
        addStudent={addStudent} updateStudent={updateStudent} deleteStudent={deleteStudent} deleteAccount={deleteAccount}
      />}

      {/* ── Settings: left-column nav + content ── */}
      {!loading && view==='settings' && isSysadmin && <div className="side-shell">
        <SectionNav ariaLabel="Settings section" value={adminSection} onChange={setAdminSection}
          items={[['summary','Summary'],['branches','Branches'],['pools','Pools & Hours'],['instructors','Instructors'],['lessonTypes','Lesson Types'],['programme','Programme'],['terms','Terms'],['billingTerms','Billing Terms'],['products','Products'],['paymentMethods','Payment Methods'],['invoiceSettings','Invoice Numbering'],['website','Website'],['users','Users']]} />
        <div className="side-content">
          {adminSection==='summary' && <SummaryView summary={summary} pools={activePools()} />}
          {adminSection==='branches' && <BranchesAdminView
            branches={options.branches||[]}
            addBranch={addBranch}
            updateBranch={updateBranch}
            deleteBranch={deleteBranch}
          />}
          {adminSection==='programme' && <ProgrammeCategoriesView
            categories={programmeCategories}
            addCategory={addProgrammeCategory}
            updateCategory={updateProgrammeCategory}
            deleteCategory={deleteProgrammeCategory}
          />}
          {adminSection==='terms' && <TermsAdminView
            branches={options.branches||[]}
            currentBranchId={currentBranchId}
            defaultTerms={defaultTermsText()}
            onSave={saveBranchTerms}
          />}
          {adminSection==='billingTerms' && <BillingTermsAdminView
            terms={billingTerms}
            branches={options.branches||[]}
            currentBranchId={currentBranchId}
            addTerm={addBillingTerm}
            updateTerm={updateBillingTerm}
            deleteTerm={deleteBillingTerm}
          />}
          {adminSection==='products' && <ProductsAdminView
            products={products}
            addProduct={addCatalogProduct}
            updateProduct={updateCatalogProduct}
            deleteProduct={deleteCatalogProduct}
            reorderProducts={reorderProducts}
          />}
          {adminSection==='users' && <UsersAdminView
            users={appUsers}
            currentUser={currentUser}
            createUser={createAppUser}
            setPassword={setAppUserPassword}
            patchUser={patchAppUser}
            deleteUser={deleteAppUser}
          />}
          {adminSection==='paymentMethods' && <PaymentMethodsPanel
            methods={paymentMethods}
            onAdd={addPaymentMethod}
            onUpdate={updatePaymentMethod}
            onMove={movePaymentMethod}
          />}
          {adminSection==='website' && <WebsitePanel
            settings={websiteSettings}
            lessonTypes={options.lessonTypes||[]}
            branches={options.branches||[]}
            pricing={publicPricing}
            onSaveSettings={saveWebsiteSettings}
            onAddCard={addPricingCard}
            onUpdateCard={updatePricingCard}
            onDeleteCard={deletePricingCard}
            onMoveCard={movePricingCard}
            onMoveCategory={movePricingCategory}
          />}
          {adminSection==='invoiceSettings' && <div className="card">
            <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>Invoice Numbering &amp; Permissions</div>
            <div className="small subtle" style={{marginBottom:16}}>These are sensitive settings. Invoice deletion is irreversible — enable the delete permission only for authorised users.</div>
            <InvoiceSettingsPanel settings={invoiceSettings} onSave={saveInvoiceSettings} formatInvoiceNumber={formatInvoiceNumber} formatReceiptNumber={formatReceiptNumber} />
          </div>}
          {(adminSection==='pools'||adminSection==='instructors'||adminSection==='lessonTypes') && <SettingsView
            section={adminSection}
            options={options}
            currentBranchId={currentBranchId}
            addOption={addOption}
            toggleOption={toggleOption}
            deleteOption={deleteOption}
            deleteInstructor={deleteInstructor}
            patchOption={patchOption}
            reorderOption={reorderOption}
            moveOption={moveOption}
            saveLessonType={saveLessonType}
            deleteLessonType={deleteLessonType}
            lessonTypeCounts={lessonTypeCounts}
            codes={codes}
            students={students}
            packages={options.packages}
            addCode={addCode}
            updateCode={updateCode}
            deleteCode={deleteCode}
            pools={activePools()}
            onUpdatePool={updatePool}
          />}
        </div>
      </div>}

    </div>{/* end .wrap */}

    {modal ? <SessionModal
      modal={modal} setModal={setModal} saveBusy={saveBusy}
      saveSession={saveSession} deleteSession={deleteSession}
      openAddAtTime={openAddAtTime}
      instructors={activeInstructors()}
      lessonTypes={activeLessonTypes()}
      pools={activePools()}
      lessonTypeByName={lessonTypeByName}
      poolById={poolById}
      packageById={packageById}
      students={students}
      studentById={studentById}
      weekEnrollments={weekEnrollments}
      familyGroups={familyGroups}
      membersByGroup={membersByGroup}
      groupById={groupById}
      trialStudentIds={trialStudentIds}
      trialByLessonType={trialByLessonType}
      creditByKey={creditByKey}
      purchasesByKey={purchasesByKey}
      addCreditPurchase={addCreditPurchase}
      adjustCredit={adjustCredit}
      initCredit={initCredit}
      pendingByKey={pendingByKey}
      replacementPending={replacementPending}
      markForReplacement={markForReplacement}
      forwardClassToNextWeek={forwardClassToNextWeek}
      startFullClassMove={startFullClassMove}
      duplicateSessionForward={duplicateSessionForward}
    /> : null}

    {programmeModal ? <ProgrammeSessionModal
      modal={programmeModal} setModal={setProgrammeModal} busy={saveBusy}
      onSave={saveProgrammeSession} onDelete={deleteProgrammeSession}
      onDuplicateForward={duplicateProgrammeSessionForward}
      pools={activePools()} categories={programmeCategories}
      instructors={activeInstructors()} gridBounds={gridBounds}
    /> : null}
  </div>;
}

// ============================================================================
// WeekView (M2: pool toggle, sub-cols, capacity chips)
// ============================================================================

function WeekView(props){
  const { weekBlocks, weekBlocksAllPools, pools, selectedPoolId, setSelectedPoolId,
          gridBounds, gridSlots, slotToMinute, minuteToSlot, colorsFor,
          lessonTypeByName, poolById, onAdd, onEdit, activeLessonTypes,
          selectedDate, sessionsForDate, selectedWeekStart, currentWeekStart, isFutureSelectedWeek,
          onPrevWeek, onNextWeek, onThisWeek, onDuplicateWeek, onClearDay, onJumpToDay,
          isTypeEnabled, onToggleType, onToggleAllTypes, allTypesShown, onExportExcel,
          activeInstructors, isInstructorActive, onToggleInstructor, onClearInstructors, instructorFilterActive,
          weekPendingReplacements, lessonTypeById, studentById, onCancelPendingReplacement,
          pendingMove, onPlacePendingMove, onCancelPendingMove,
          trialStudentIds, trialByLessonType, creditByKey, highlightedSessionId, onReorderSlot } = props;

  const [printMenu, setPrintMenu] = useState(false);
  // ── Slot drag-to-reorder ──────────────────────────────────────────
  // Tracks a custom display order per cell (keyed weekStart:day:hourBucket).
  // Order is in-memory only; survives navigation within the session but
  // resets on page reload. The DB sort is unchanged.
  const [dragId,     setDragId]     = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [slotOrders, setSlotOrders] = useState({});

  function cellKey(di, h){ return `${selectedWeekStart}:${di}:${h}`; }

  function applySlotOrder(rawCell, di, h){
    if(rawCell.length <= 1) return rawCell;
    const custom = slotOrders[cellKey(di, h)];
    if(!custom || !custom.length) return rawCell;
    const rank = new Map(custom.map((id, i) => [String(id), i]));
    return [...rawCell].sort((a, b) =>
      (rank.has(String(a.id)) ? rank.get(String(a.id)) : 9999) -
      (rank.has(String(b.id)) ? rank.get(String(b.id)) : 9999));
  }

  function onCardDragStart(e, block, rawCell, di, h){
    e.stopPropagation();
    setDragId(block.id);
    // Snapshot current visual order on first drag in this slot
    const k = cellKey(di, h);
    if(!slotOrders[k])
      setSlotOrders(prev => ({ ...prev, [k]: rawCell.map(b => String(b.id)) }));
    e.dataTransfer.effectAllowed = 'move';
  }

  function onCardDragOver(e, block){
    e.preventDefault(); e.stopPropagation();
    if(String(dragOverId) !== String(block.id)) setDragOverId(block.id);
  }

  function onCardDrop(e, targetBlock, rawCell, di, h){
    e.preventDefault(); e.stopPropagation();
    if(!dragId || String(dragId) === String(targetBlock.id)){
      setDragId(null); setDragOverId(null); return;
    }
    const k = cellKey(di, h);
    const base = (slotOrders[k] || rawCell.map(b => String(b.id)));
    const without = base.filter(id => id !== String(dragId));
    const ti = without.indexOf(String(targetBlock.id));
    if(ti === -1){ setDragId(null); setDragOverId(null); return; }
    const next = [...without]; next.splice(ti, 0, String(dragId));
    setSlotOrders(prev => ({ ...prev, [k]: next }));
    setDragId(null); setDragOverId(null);
    if(onReorderSlot) onReorderSlot(next);
  }

  function onCardDragEnd(){ setDragId(null); setDragOverId(null); }

  const wb = weekBounds(selectedDate);
  const printDays = Array.from({length:7}, (_,i) => { const d = new Date(wb.start); d.setDate(wb.start.getDate()+i); const ds = toDateStr(d); return { date:d, ds, items:sessionsForDate(ds) }; });

  // Full-width agenda: 7 equal day columns fill the screen, one row per hour.
  // Sessions stack vertically inside each day-hour cell, so a busy slot grows
  // downward instead of forcing a horizontal scrollbar. Each card lays its
  // details out on separate lines.
  const showPoolBadge = !selectedPoolId && pools.length > 1;
  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = [];
  for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);

  const weekGrid = <>
    <div className="pool-tabs">
      <button className={`pool-tab ${selectedPoolId===null?'active':''}`} onClick={()=>setSelectedPoolId(null)}>
        All
      </button>
      {pools.map(p => <button key={p.id} className={`pool-tab ${selectedPoolId===p.id?'active':''}`} onClick={()=>setSelectedPoolId(p.id)}>{p.name} <span className="pool-tab-cap">cap {p.capacity_total}</span></button>)}
    </div>

    <div className="wagenda">
      <div className="wa-corner" />
      {DAYS_S.map((d,di) => {
        const dateObj = new Date(wb.start); dateObj.setDate(wb.start.getDate()+di);
        const dateStr = dateObj.toLocaleDateString(undefined,{month:'short', day:'numeric'});
        return <div key={'head'+di} className="wa-dayhead">
          <button className="week-day-link" onClick={() => onJumpToDay(di)} title={`Open ${DAYS_F[di]} daily view`}>
            <div>{d}</div>
            <div style={{fontSize:'10px',fontWeight:600,color:'#94A3B8'}}>{dateStr}</div>
          </button>
          {isFutureSelectedWeek ? <button className="week-clear-btn" onClick={(e)=>{e.stopPropagation(); onClearDay(di);}}>Remove all</button> : <div className="week-clear-placeholder">Protected</div>}
        </div>;
      })}
      {hours.map(h => <React.Fragment key={h}>
        <div className="wa-time">{hourLabel(h)}</div>
        {DAYS_S.map((_,di) => {
          const rawCell = weekBlocks[di].packed.filter(b => b.startMinute >= h && b.startMinute < h + 60);
          const orderedCell = applySlotOrder(rawCell, di, h);
          return <div key={di+'-'+h} className={`wa-cell ${pendingMove?'wa-cell-targetable':''}`} onClick={() => {
            if(pendingMove){
              onPlacePendingMove && onPlacePendingMove(di, slotToMinute(minuteToSlot(h)));
            } else {
              onAdd(di, minuteToSlot(h), selectedPoolId || undefined);
            }
          }}>
            {orderedCell.map(block => <AgendaCard key={block.id} block={block} colorsFor={colorsFor} lessonTypeByName={lessonTypeByName} poolById={poolById} showPoolBadge={showPoolBadge} onEdit={onEdit} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} creditByKey={creditByKey}
        isDraggable={rawCell.length > 1}
        isDragging={String(dragId) === String(block.id)}
        isDragOver={String(dragOverId) === String(block.id)}
        isHighlighted={highlightedSessionId && String(highlightedSessionId) === String(block.id)}
        onDragStartCard={e => onCardDragStart(e, block, rawCell, di, h)}
        onDragOverCard={e => onCardDragOver(e, block)}
        onDropCard={e => onCardDrop(e, block, rawCell, di, h)}
        onDragEndCard={onCardDragEnd}
        />)}
          </div>;
        })}
      </React.Fragment>)}
    </div>
  </>;

  return <>
    <div className="card print-target" style={{marginBottom:16}}>
      <div className="view-head">
        <div>
          <div className="view-title">Weekly View</div>
          <div className="small subtle">Pool shown as a badge — use the pool tabs to focus one pool. Busy days widen and scroll sideways; the time axis stays pinned.</div>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(selectedWeekStart)} onPrev={onPrevWeek} onNext={onNextWeek} onToday={onThisWeek} isCurrent={selectedWeekStart === currentWeekStart}>
        <button className="btn btn-primary small-btn" onClick={onDuplicateWeek} disabled={!isFutureSelectedWeek}>Duplicate Previous Week</button>
        <div className="print-wrap">
          <button className="btn btn-print small-btn" onClick={()=>setPrintMenu(v=>!v)}>Print <span className="caret">▾</span></button>
          {printMenu ? <>
            <div className="menu-backdrop" onClick={()=>setPrintMenu(false)} />
            <div className="drop-menu">
              <button className="drop-item" onClick={()=>{ setPrintMenu(false); printWeeklyView(); }}>Weekly rundown <span className="drop-hint">A4 · per-day list</span></button>
              <button className="drop-item" onClick={()=>{ setPrintMenu(false); printWeeklyTable(); }}>Weekly grid <span className="drop-hint">A3 · time table</span></button>
            </div>
          </> : null}
        </div>
        <button className="btn btn-print small-btn" onClick={onExportExcel} title="Download this week as a multi-tab attendance roster">Export Excel</button>
      </PeriodNav>
      <div className="nav-note">{isFutureSelectedWeek ? 'Future week — "Remove all classes" and "Duplicate Previous Week" are enabled.' : 'Current and past weeks are protected from bulk removal.'}</div>
      <div className="legend-bar legend-bar-v" style={{marginBottom:12}}>
        <div className="legend-row">
          <span className="legend-label">Types</span>
          <div className="legend">
            {activeLessonTypes.map(t => { const c = colorsFor(t.name); const on = isTypeEnabled(t.name); return <button key={t.id || t.name} className={`chip chip-toggle ${on?'':'chip-off'}`} style={on?{background:c.bg,borderColor:c.bd,color:c.tx}:undefined} onClick={()=>onToggleType(t.name)} title={on?'Showing — click to hide':'Hidden — click to show'}>{t.name}</button>; })}
          </div>
          <button className={`legend-allbtn ${allTypesShown?'':'is-off'}`} onClick={onToggleAllTypes}>
            <span className="dot" />{allTypesShown ? 'Hide all' : 'Show all'}
          </button>
        </div>
        <div className="legend-row legend-row-instructors">
          <span className="legend-label">Instructors</span>
          <div className="legend">
            {(activeInstructors || []).length === 0 ? <span className="small subtle">No instructors</span> : (activeInstructors || []).map(inst => {
              const on = isInstructorActive(inst.id);
              const gIcon = inst.gender === 'female' ? '♀' : (inst.gender === 'male' ? '♂' : '');
              return <button key={inst.id} className={`chip chip-instructor ${on?'is-on':''}`} onClick={()=>onToggleInstructor(inst.id)} title={on?`Filtering — click to remove ${inst.name}`:`Click to filter to ${inst.name}'s classes`}>{gIcon ? <span className="inst-chip-g" aria-hidden="true">{gIcon}</span> : null}{inst.name}</button>;
            })}
          </div>
          <button className={`legend-allbtn ${instructorFilterActive?'':'is-off'}`} onClick={onClearInstructors} disabled={!instructorFilterActive} title={instructorFilterActive?'Remove instructor filter':'No instructor filter active'}>
            <span className="dot" />{instructorFilterActive ? 'Clear' : 'No filter'}
          </button>
        </div>
      </div>
      {pendingMove && <div className="pending-move-banner">
        <div className="pending-move-icon" aria-hidden="true">📅</div>
        <div className="pending-move-text">
          <div className="pending-move-title">Pick a slot to place {pendingMove.lessonTypeName}</div>
          <div className="pending-move-sub">Moving from <strong>{pendingMove.sourceLabel}</strong> · {pendingMove.swimmerCount} swimmer{pendingMove.swimmerCount===1?'':'s'} — click any time-cell in the grid below.</div>
        </div>
        <button type="button" className="btn btn-ghost small" onClick={onCancelPendingMove}>Cancel move</button>
      </div>}
      {(weekPendingReplacements || []).length > 0 && <div className="pending-repl-card">
        <div className="pending-repl-head">
          <span className="pending-repl-badge" aria-hidden="true">R</span>
          <div className="pending-repl-title">Pending Replacements · {weekPendingReplacements.length}</div>
        </div>
        <div className="pending-repl-grid">
          {weekPendingReplacements.map(p => {
            const stu = studentById ? studentById[p.student_id] : null;
            const lt = lessonTypeById ? lessonTypeById(p.lesson_type_id) : null;
            const stillExists = (props.weekBlocks || []).some(day => (day.packed || []).some(b => b.id === p.original_session_id));
            const datePassed = p.week_start_date && p.week_start_date < (new Date().toISOString().slice(0,10));
            return <div key={p.id} className={`pending-repl-chip${datePassed?' repl-chip-passed':''}`}>
              <div className="repl-chip-name">{stu ? stu.name : '?'}{stu?.age != null ? <span className="repl-chip-age"> {stu.age}y</span> : null}</div>
              <div className="repl-chip-meta">{lt ? lt.name : '—'} · {p.original_session_label || '?'}</div>
              {datePassed && <div className="repl-chip-warn">⚠ past date</div>}
              {!stillExists && <div className="repl-chip-warn">⚠ slot deleted</div>}
              <button type="button" className="repl-chip-btn" onClick={()=>onCancelPendingReplacement && onCancelPendingReplacement(p, { restore: true })} title={stillExists ? `Cancel — restore to ${p.original_session_label}` : 'Original class deleted — clear limbo only'}>
                {stillExists ? 'Restore' : 'Clear'}
              </button>
            </div>;
          })}
        </div>
      </div>}
      {weekGrid}
    </div>

    <div className="print-rundown">
      <div className="print-title">Weekly Daily Rundown{props.branchLabel ? ` — ${props.branchLabel}` : ''}</div>
      <div className="print-meta">{wb.start.toLocaleDateString()} to {wb.end.toLocaleDateString()}</div>
      {printDays.map(({date, ds, items}) => <div className="print-day" key={ds}>
        <h3>{date.toLocaleDateString(undefined,{weekday:'long', year:'numeric', month:'long', day:'numeric'})}</h3>
        <table><tbody>
          {items.length ? items.map(it => {
            const instLabel = it.instructors.map(i=>i.name).join(', ') || it.legacyInstructor || '-';
            return <tr key={it.id}>
              <td className="print-time-col">{formatRange(it.startMinute, it.durationMinutes)}</td>
              <td className="print-type-col">{it.type}</td>
              <td className="print-inst-col">{instLabel}</td>
              <td className="print-stu-col">{it.students.length ? it.students.map(s => <div key={s.id||s.name} className="print-stu-name">{studentLabel(s)}</div>) : <span style={{color:'#aaa'}}>-</span>}</td>
            </tr>;
          }) : <tr className="empty-row"><td colSpan="4">No sessions</td></tr>}
        </tbody></table>
      </div>)}
    </div>
    <PrintWeeklyTableSection weekBlocksAllPools={weekBlocksAllPools} wb={wb} selectedWeekStart={selectedWeekStart} gridSlots={gridSlots} gridBounds={gridBounds} slotToMinute={slotToMinute} poolById={poolById} branchLabel={props.branchLabel} />
  </>;
}

// M2.2: agenda card — a static, full-width card inside a day-hour cell. Details
// stack on separate lines; the student list wraps to use vertical space.
function AgendaCard({ block, colorsFor, lessonTypeByName, poolById, showPoolBadge, onEdit, trialStudentIds, trialByLessonType, creditByKey,
  isDraggable, isDragging, isDragOver, isHighlighted, onDragStartCard, onDragOverCard, onDropCard, onDragEndCard }){
  const c = colorsFor(block.type);
  const lt = lessonTypeByName(block.type);
  const cap = sessionCapacity(block, lt);
  const chip = capacityChipColors(cap.status);
  const pool = poolById(block.poolId);
  const isOver = cap.status === 'over';
  const missingInst = block.instructors.length === 0;
  const instName = (block.instructors[0]?.name) || block.legacyInstructor || '';
  const isPersonal = lessonTypeByName(block.type)?.class_type === 'personal';
  const isRescheduled = block.rescheduledFromDay != null;
  const isCancelled = !!block.cancelledAt;
  // Trial flag is per-lesson-type: only fires if the swimmer's enrollment
  // matches this card's lesson type. Falls back to the global set if no map
  // is passed (defensive — shouldn't happen in normal mount path).
  const trialSet = (trialByLessonType && block.lessonTypeId) ? trialByLessonType[block.lessonTypeId] : trialStudentIds;
  // Cancelled session — greyed-out shell. Clicking calls onEdit which
  // detects the cancelled state and routes to restore. Don't render
  // capacity, students, or instructor details — they're misleading
  // on a class that didn't happen.
  if(isCancelled){
    const reasonLabel = block.cancelledReason === 'forwarded' ? 'Forwarded → next week'
                      : block.cancelledReason === 'rescheduled' ? 'Rescheduled — moved'
                      : 'Cancelled';
    return <div className="wa-card wa-card-cancelled" onClick={(e)=>{e.stopPropagation(); onEdit(block);}} title="Click to restore this session to its original slot">
      <div className="wa-card-head">
        <span className="wa-card-title wa-card-title-strike">{block.type}</span>
        <span className="wa-cancelled-tag">{reasonLabel}</span>
      </div>
      <div className="wa-card-line wa-card-strike">{compactRange(block.startMinute, block.durationMinutes)}{instName ? ` · ${instName}` : ''}</div>
      <div className="wa-card-restore-hint">Click to restore</div>
    </div>;
  }
  return <div className={`wa-card ${isOver?'event-over':''} ${missingInst?'wa-card-warn':''} ${isDragging?'wa-card-dragging':''} ${isDragOver?'wa-card-dragover':''} ${isHighlighted?'wa-card-highlight':''}`}
    draggable={isDraggable || false}
    onDragStart={onDragStartCard}
    onDragOver={onDragOverCard}
    onDrop={onDropCard}
    onDragEnd={onDragEndCard}
    onClick={(e)=>{e.stopPropagation(); onEdit(block);}}
    style={{ background:c.bg, borderLeft:`3px solid ${c.bd}`, color:c.tx }}>
    {missingInst ? <span className="card-warn-corner" title="No instructor assigned — needs reassignment">⚠</span> : null}
    <div className="wa-card-head">
      <span className="wa-card-title">{block.type}</span>
      {cap.max > 0 ? <span className="cap-chip" style={{background:chip.bg, color:chip.tx, borderColor:chip.bd}}>{cap.locked?'🔒':''}{cap.current}/{cap.max}</span> : <span className="cap-chip cap-chip-unknown">{cap.locked?'🔒':''}{cap.current}</span>}
    </div>
    <div className="wa-card-line">{showPoolBadge && pool ? <span className="event-pool-pill">{pool.name}</span> : null}{compactRange(block.startMinute, block.durationMinutes)}{isRescheduled ? <span className="reschedule-tag" title={`Rescheduled — was ${DAYS_S[block.rescheduledFromDay]} ${minuteToTime(block.rescheduledFromStartMinute)}`}>⇄</span> : null}</div>
    <div className={`wa-card-line wa-card-inst ${missingInst?'inst-missing':''}`}>{missingInst ? <span className="warn-tri" title="Instructor was removed — pick a new one in the modal">⚠</span> : null}<span className={missingInst?'inst-orphan':''}>{instName || 'Unassigned'}</span>{missingInst ? <span className="inst-warn-chip">Needs instructor</span> : null}</div>
    {block.students.length
      ? <div className="wa-card-students">{block.students.map((s,i) => {
          const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
          const isRepl = s.isReplacement;
          const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${block.lessonTypeId}`] : null;
          return <span key={s.id || i} className={`wa-stu ${isRepl?'wa-stu-repl':''}`} title={studentLabel(s) + (isTrial?' (trial)':'') + (isRepl?` replacing from ${replFromLabel(s.replacementFrom)||'?'}`:'')}>
            {isRepl?<span className="repl-mark">R</span>:null}
            {clip22(s.name) + ageSuffix(s)}
            {isTrial ? <span className="trial-mark"> (trial)</span> : null}
            {bal ? <span className={`credit-mark ${bal.remaining_balance<=2?'credit-low':''}`}> · {bal.remaining_balance}cr</span> : null}
            {s.remark ? ` — ${s.remark}` : ''}
          </span>;
        })}</div>
      : <div className="wa-card-line wa-card-students-empty">—</div>}
  </div>;
}

// ============================================================================
// DailyView (M2: pool labels on each session)
// ============================================================================

function DailyView({ selectedDate, setSelectedDate, sessionsForDate, colorsFor, lessonTypeByName, poolById, branchLabel, onAddAtTime, onEdit, selectedWeekStart, currentWeekStart, onPrevWeek, onNextWeek, onThisWeek, onExportExcel, activeLessonTypes, isTypeEnabled, onToggleType, onToggleAllTypes, allTypesShown, activeInstructors, isInstructorActive, onToggleInstructor, onClearInstructors, instructorFilterActive, trialStudentIds, trialByLessonType, creditByKey, onReorderSlot }){
  const wb = weekBounds(selectedDate);
  const weekDays = Array.from({length:7}, (_,i) => { const d = new Date(wb.start); d.setDate(wb.start.getDate()+i); return { date:d, ds:toDateStr(d), idx:i }; });
  const items = sessionsForDate(selectedDate);
  const hourStarts = Array.from({length:13}, (_,i) => 480 + i*60);

  // ── Slot drag-to-reorder (same pattern as WeekView) ────────────────
  const [dailyDragId,     setDailyDragId]     = useState(null);
  const [dailyDragOverId, setDailyDragOverId] = useState(null);
  const [dailySlotOrders, setDailySlotOrders] = useState({});

  function dailySlotKey(start){ return `${selectedDate}:${start}`; }

  function applyDailyOrder(rawItems, start){
    if(rawItems.length <= 1) return rawItems;
    const custom = dailySlotOrders[dailySlotKey(start)];
    if(!custom || !custom.length) return rawItems;
    const rank = new Map(custom.map((id, i) => [String(id), i]));
    return [...rawItems].sort((a, b) =>
      (rank.has(String(a.id)) ? rank.get(String(a.id)) : 9999) -
      (rank.has(String(b.id)) ? rank.get(String(b.id)) : 9999));
  }

  function onDailyDragStart(e, it, rawItems, start){
    e.stopPropagation();
    setDailyDragId(it.id);
    const k = dailySlotKey(start);
    if(!dailySlotOrders[k])
      setDailySlotOrders(prev => ({ ...prev, [k]: rawItems.map(s => String(s.id)) }));
    e.dataTransfer.effectAllowed = 'move';
  }

  function onDailyDragOver(e, it){
    e.preventDefault(); e.stopPropagation();
    if(String(dailyDragOverId) !== String(it.id)) setDailyDragOverId(it.id);
  }

  function onDailyDrop(e, targetIt, rawItems, start){
    e.preventDefault(); e.stopPropagation();
    if(!dailyDragId || String(dailyDragId) === String(targetIt.id)){
      setDailyDragId(null); setDailyDragOverId(null); return;
    }
    const k = dailySlotKey(start);
    const base = dailySlotOrders[k] || rawItems.map(s => String(s.id));
    const without = base.filter(id => id !== String(dailyDragId));
    const ti = without.indexOf(String(targetIt.id));
    if(ti === -1){ setDailyDragId(null); setDailyDragOverId(null); return; }
    const next = [...without]; next.splice(ti, 0, String(dailyDragId));
    setDailySlotOrders(prev => ({ ...prev, [k]: next }));
    setDailyDragId(null); setDailyDragOverId(null);
    if(onReorderSlot) onReorderSlot(next);
  }

  function onDailyDragEnd(){ setDailyDragId(null); setDailyDragOverId(null); }
  const isMobile = useIsMobile();
  const [filterSheetOpen,setFilterSheetOpen] = useState(false);
  // Filter chips are rendered in two homes: inline legend on desktop,
  // bottom sheet on mobile. Build once, mount wherever.
  const hiddenTypeCount = (activeLessonTypes||[]).filter(t=>!isTypeEnabled(t.name)).length;
  const activeFilterCount = hiddenTypeCount + ((instructorFilterActive)?1:0);
  const typeChips = (activeLessonTypes || []).map(t => { const c = colorsFor(t.name); const on = isTypeEnabled(t.name); return <button key={t.id || t.name} className={`chip chip-toggle ${on?'':'chip-off'}`} style={on?{background:c.bg,borderColor:c.bd,color:c.tx}:undefined} onClick={()=>onToggleType(t.name)} title={on?'Showing — click to hide':'Hidden — click to show'}>{t.name}</button>; });
  const instructorChips = (activeInstructors || []).length === 0 ? <span className="small subtle">No instructors</span> : (activeInstructors || []).map(inst => {
    const on = isInstructorActive(inst.id);
    const gIcon = inst.gender === 'female' ? '♀' : (inst.gender === 'male' ? '♂' : '');
    return <button key={inst.id} className={`chip chip-instructor ${on?'is-on':''}`} onClick={()=>onToggleInstructor(inst.id)} title={on?`Filtering — click to remove ${inst.name}`:`Click to filter to ${inst.name}'s classes`}>{gIcon ? <span className="inst-chip-g" aria-hidden="true">{gIcon}</span> : null}{inst.name}</button>;
  });
  return <div className="grid">
    <div className="card no-print">
      {!isMobile && <div className="view-head">
        <div>
          <div className="view-title">Daily View</div>
          <div className="small subtle">Hour-by-hour for the selected day. Every hour is shown even when empty.</div>
        </div>
      </div>}
      {!isMobile && <PeriodNav rangeLabel={weekRangeLabel(selectedWeekStart)} onPrev={onPrevWeek} onNext={onNextWeek} onToday={onThisWeek} isCurrent={selectedWeekStart === currentWeekStart}>
        <button className="btn btn-print" onClick={() => printDailyView(selectedDate)}>Print</button>
        <button className="btn btn-print" onClick={onExportExcel} title="Download this week as a multi-tab attendance roster">Export Excel</button>
      </PeriodNav>}
      {isMobile
        ? <div className="daily-mobile-controls">
            <select className="daily-day-select" value={selectedDate} onChange={e=>setSelectedDate(e.target.value)} aria-label="Select day">
              {weekDays.map(({date, ds, idx}) => <option key={ds} value={ds}>{DAYS_S[idx]} · {date.toLocaleDateString(undefined,{month:'short', day:'numeric'})}{ds===todayStr()?' (today)':''}</option>)}
            </select>
            <button className={`daily-filter-btn ${activeFilterCount>0?'has-active':''}`} onClick={()=>setFilterSheetOpen(true)}>
              ⚙ Filters{activeFilterCount>0?` · ${activeFilterCount}`:''}
            </button>
          </div>
        : <>
          <div className="nav-note">Showing <b style={{color:'var(--text)'}}>{longDate(selectedDate)}</b></div>
          <div className="daily-day-tabs">
            {weekDays.map(({date, ds, idx}) => <button key={ds} className={`daily-day-tab ${selectedDate===ds?'active':''}`} onClick={() => setSelectedDate(ds)}>{DAYS_S[idx]} · {date.toLocaleDateString(undefined,{month:'short', day:'numeric'})}</button>)}
          </div>
        </>}
      {!isMobile && <div className="legend-bar legend-bar-v" style={{marginBottom:12}}>
        <div className="legend-row">
          <span className="legend-label">Types</span>
          <div className="legend">{typeChips}</div>
          <button className={`legend-allbtn ${allTypesShown?'':'is-off'}`} onClick={onToggleAllTypes}>
            <span className="dot" />{allTypesShown ? 'Hide all' : 'Show all'}
          </button>
        </div>
        <div className="legend-row legend-row-instructors">
          <span className="legend-label">Instructors</span>
          <div className="legend">{instructorChips}</div>
          <button className={`legend-allbtn ${instructorFilterActive?'':'is-off'}`} onClick={onClearInstructors} disabled={!instructorFilterActive}>
            <span className="dot" />{instructorFilterActive ? 'Clear' : 'No filter'}
          </button>
        </div>
      </div>}
      {isMobile && filterSheetOpen && <div className="more-sheet-backdrop" onClick={()=>setFilterSheetOpen(false)}>
        <div className="more-sheet filter-sheet" onClick={e=>e.stopPropagation()}>
          <div className="more-sheet-grab" aria-hidden="true"></div>
          <div className="filter-sheet-head">
            <span>Class types</span>
            <button className="legend-allbtn" onClick={onToggleAllTypes}><span className="dot"/>{allTypesShown?'Hide all':'Show all'}</button>
          </div>
          <div className="filter-sheet-chips">{typeChips}</div>
          <div className="filter-sheet-head" style={{marginTop:14}}>
            <span>Instructors</span>
            <button className="legend-allbtn" onClick={onClearInstructors} disabled={!instructorFilterActive}><span className="dot"/>{instructorFilterActive?'Clear':'No filter'}</button>
          </div>
          <div className="filter-sheet-chips">{instructorChips}</div>
          <div className="filter-sheet-foot">
            <button className="btn btn-print" onClick={()=>{ printDailyView(selectedDate); }}>Print</button>
            <button className="btn btn-print" onClick={onExportExcel}>Export Excel</button>
            <button className="btn btn-primary" style={{marginLeft:'auto'}} onClick={()=>setFilterSheetOpen(false)}>Done</button>
          </div>
        </div>
      </div>}
      <div className="daily-grid">
        {hourStarts.map(start => {
          const rawItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
          const rowItems = applyDailyOrder(rawItems, start);
          return <div className="daily-row" key={start}>
            <div className="daily-time">{minuteToTime(start)}</div>
            <div className={`daily-slot ${rowItems.length ? '' : 'empty'}`}>
              {rowItems.length ? <div className="daily-sessions">
                {rowItems.map(it => {
                  const c = colorsFor(it.type);
                  const lt = lessonTypeByName(it.type);
                  const cap = sessionCapacity(it, lt);
                  const chip = capacityChipColors(cap.status);
                  const pool = poolById(it.poolId);
                  const missingInst = it.instructors.length === 0;
                  const instName = (it.instructors[0]?.name) || it.legacyInstructor || '';
                  const isPersonalIt = lessonTypeByName(it.type)?.class_type === 'personal';
                  const isRescheduledIt = it.rescheduledFromDay != null;
                  const isBeingDragged = String(dailyDragId) === String(it.id);
                  const isDropTarget  = String(dailyDragOverId) === String(it.id);
                  return <div key={it.id}
                    className={`daily-event ${missingInst?'daily-event-warn':''} ${isBeingDragged?'daily-event-dragging':''} ${isDropTarget?'daily-event-dragover':''}`}
                    onDragOver={e => onDailyDragOver(e, it)}
                    onDrop={e => onDailyDrop(e, it, rawItems, start)}
                    onDragEnd={onDailyDragEnd}
                    onClick={() => onEdit(it)}
                    style={{background:c.bg, borderLeftColor:c.bd, color:c.tx}}>
                    {rawItems.length > 1 && <div
                      className="daily-drag-handle"
                      draggable={true}
                      onDragStart={e => onDailyDragStart(e, it, rawItems, start)}
                      onClick={e => e.stopPropagation()}
                      title="Drag to reorder"
                    >⠿</div>}
                    {missingInst ? <span className="card-warn-corner" title="No instructor assigned — needs reassignment">⚠</span> : null}
                    <div className="daily-event-top">
                      <div style={{minWidth:0,flex:1}}>
                        <div className="daily-event-title" style={{color:c.tx}}>{it.type} {pool ? <span className="pool-badge">{pool.name}</span> : null}{it.familyGroupId ? <span title="Family group booking" style={{marginLeft:4}}>👪</span> : null}{isRescheduledIt ? <span className="reschedule-tag" title={`Rescheduled — was ${DAYS_S[it.rescheduledFromDay]} ${minuteToTime(it.rescheduledFromStartMinute)}`}> ⇄</span> : null}</div>
                        <div className={`daily-event-sub ${missingInst?'inst-missing':''}`}>{compactRange(it.startMinute, it.durationMinutes)} · {missingInst ? <><span className="warn-tri">⚠</span><span className="inst-orphan">{instName || 'Unassigned'}</span><span className="inst-warn-chip">Needs instructor</span></> : instName || '—'}</div>
                        {it.students.length
                          ? (() => {
                              // Per-session trial set: only swimmers whose
                              // enrolment includes THIS lesson type flag as
                              // trial. Falls back to global set defensively.
                              const trialSet = (trialByLessonType && it.lessonTypeId) ? trialByLessonType[it.lessonTypeId] : trialStudentIds;
                              return <div className="daily-event-students">{it.students.map((s, si) => {
                                const isTrial = !!(s.studentId && trialSet && trialSet.has(s.studentId));
                                const isRepl = s.isReplacement;
                                const bal = s.studentId && creditByKey ? creditByKey[`${s.studentId}:${it.lessonTypeId}`] : null;
                                return <span key={s.id || si} className={`daily-event-stu ${isRepl?'daily-stu-repl':''}`} title={isRepl?`Replacement from ${replFromLabel(s.replacementFrom)||'?'}`:undefined}>{isRepl?<span className="repl-mark-sm">R</span>:null}{s.name + ageSuffix(s)}{isTrial ? <span className="trial-mark"> (trial)</span> : null}{bal ? <span className={`credit-mark ${bal.remaining_balance<=2?'credit-low':''}`}> · {bal.remaining_balance}cr</span> : null}</span>;
                              })}</div>;
                            })()
                          : <div className="daily-event-sub">No students listed</div>}
                        {it.students.filter(s=>s.remark).map((s,ri)=><div key={ri} className="daily-event-note">📝 {shortName(s.name)}: {s.remark}</div>)}
                      </div>
                      <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:6}}>
                        {cap.max > 0 ? <span className="cap-chip cap-chip-lg" style={{background:chip.bg, color:chip.tx, borderColor:chip.bd}}>{cap.locked?'🔒 ':''}{cap.current}/{cap.max}</span> : <span className="cap-chip cap-chip-lg cap-chip-unknown">{cap.locked?'🔒 ':''}{cap.current}</span>}
                      </div>
                    </div>
                  </div>;
                })}
              </div> : <>
                <div className="small subtle">No sessions</div>
                <button className="btn btn-secondary small-btn" onClick={() => onAddAtTime(dateToWeekdayIndex(selectedDate), start)}>Add Session</button>
              </>}
              {rowItems.length ? <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}><button className="btn btn-secondary small-btn" onClick={() => onAddAtTime(dateToWeekdayIndex(selectedDate), start)}>Add Session</button></div> : null}
            </div>
          </div>;
        })}
        <div className="daily-row">
          <div className="daily-time">{minuteToTime(1260)}</div>
          <div className="daily-slot empty"><div className="small subtle">Day end marker</div></div>
        </div>
      </div>
    </div>
    <div className="print-daily">
      <div className="print-daily-heading">Daily Schedule{branchLabel ? ` — ${branchLabel}` : ''}</div>
      <div className="print-daily-date">{longDate(selectedDate)}</div>
      <table className="print-daily-table">
        <thead>
          <tr>
            <th className="print-th-time">Time</th>
            <th className="print-th-detail">Session Details</th>
          </tr>
        </thead>
        <tbody>
          {hourStarts.map(start => {
            const rowItems = items.filter(it => it.startMinute >= start && it.startMinute < start + 60);
            return <tr key={`p-${start}`}>
              <td className="print-time-cell">{shortTime(start)}</td>
              <td className="print-detail-cell">
                {rowItems.length
                  ? <div className="print-day-cols">
                      {rowItems.map(it => {
                        const pool = poolById(it.poolId);
                        const inst = it.instructors.map(i=>i.name).join(', ') || it.legacyInstructor || '';
                        const meta = [pool ? pool.name : '', inst].filter(Boolean).join(' · ');
                        return <div key={it.id} className="print-day-col">
                          <div className="print-session-head">{shortRange(it.startMinute, it.durationMinutes)} · {it.type}</div>
                          {meta && <div className="print-session-meta">{meta}</div>}
                          <div className="print-session-students">
                            {it.students.length
                              ? it.students.map((s,i) => <div key={i} className="print-student-name">{studentLabel(s)}</div>)
                              : <div className="print-student-name print-student-empty">No students</div>}
                          </div>
                        </div>;
                      })}
                    </div>
                  : <span className="print-no-session">—</span>
                }
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </div>;
}

// ============================================================================
// MonthView (unchanged from M1)
// ============================================================================

function MonthView({ monthCursor, setMonthCursor, selectedDate, setSelectedDate, monthDates, sessionsForDate, colorsFor, remarks, remarkDraft, setRemarkDraft, saveRemark, selectedItems }){
  const options = [];
  for(let y=2025;y<=2032;y++) for(let m=0;m<12;m++){ const d = new Date(y,m,1); options.push(<option key={`${y}-${m}`} value={monthKey(d)}>{d.toLocaleDateString(undefined,{month:'long', year:'numeric'})}</option>); }
  return <>
    <div style={{display:'flex',gap:16,width:'100%',alignItems:'flex-start'}}>
      <div className="card" style={{flex:'1 1 0',minWidth:0}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:14}}>
          <div><div style={{fontSize:18,fontWeight:800}}>Monthly Calendar</div><div className="small subtle">Monday-first calendar. Click a day to expand the rundown below.</div></div>
          <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
            <button className="btn btn-ghost" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()-1, 1))}>←</button>
            <select className="select" style={{width:240}} value={monthKey(monthCursor)} onChange={(e)=>{ const [y,m] = e.target.value.split('-').map(Number); setMonthCursor(new Date(y,m-1,1)); }}>{options}</select>
            <button className="btn btn-ghost" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()+1, 1))}>→</button>
          </div>
        </div>
        <div className="month-grid">
          {DAYS_S.map(d => <div key={d} className="month-dow">{d}</div>)}
          {monthDates.map(d => {
            const ds = toDateStr(d), inMonth = d.getMonth() === monthCursor.getMonth(), items = sessionsForDate(ds), hasRemark = !!(remarks[ds] || '').trim();
            return <div key={ds} className={`day-box ${inMonth?'':'outside'} ${selectedDate===ds?'selected':''}`} onClick={() => setSelectedDate(ds)}>
              <div className="day-top"><div className="day-num">{d.getDate()}</div><div className={`remark-dot ${hasRemark ? 'has-content' : 'empty'}`}>+remark</div></div>
              <div>{items.length ? items.slice(0,3).map(ev => { const c = colorsFor(ev.type); return <div key={ev.id} className="mini-item" style={{background:c.bg,borderLeftColor:c.bd,color:c.tx}}>{minuteToTime(ev.startMinute)} · {ev.type}</div>; }) : <div className="small subtle">No sessions</div>}</div>
            </div>;
          })}
        </div>
      </div>
      <div className="card" style={{flex:'0 0 320px'}}>
        <div style={{fontSize:18,fontWeight:800}}>One-off Day Remark</div>
        <div className="small subtle" style={{margin:'4px 0 12px'}}>This remark is saved only for <b>{longDate(selectedDate)}</b>. It does not recur.</div>
        <textarea className="textarea" value={remarkDraft} onChange={(e)=>setRemarkDraft(e.target.value)} placeholder="Add closure note, special arrangement, replacement note, etc." />
        <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="btn btn-primary" onClick={saveRemark}>Save Remark</button></div>
      </div>
    </div>
    <div className="card" style={{marginTop:16}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div><div style={{fontSize:18,fontWeight:800}}>Daily Rundown</div><div className="small subtle">{longDate(selectedDate)}</div></div>
        <div className="pill">Sessions for this date in this week's schedule</div>
      </div>
      <div className="table-wrap"><table><thead><tr><th style={{width:130}}>Time</th><th style={{width:170}}>Lesson Type</th><th style={{width:160}}>Instructor</th><th>Students</th></tr></thead><tbody>
        {selectedItems.length ? selectedItems.map(g => <tr key={g.id}><td>{formatRange(g.startMinute, g.durationMinutes)}</td><td><span className="pill">{g.type}</span></td><td>{g.instructors.map(i=>i.name).join(', ') || g.legacyInstructor}</td><td>{g.students.map(s=>s.name+ageSuffix(s)).join(', ') || '-'}</td></tr>) : <tr><td colSpan="4" className="empty">No schedule for this day.</td></tr>}
      </tbody></table></div>
    </div>
  </>;
}

// ============================================================================
// SummaryView (M2: by-pool breakdown added)
// ============================================================================

function BranchesAdminView({ branches, addBranch, updateBranch, deleteBranch }){
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState('#0EA5E9');
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({name:'', code:'', color:''});

  function startEdit(b){
    setEditingId(b.id);
    setEditForm({ name: b.name||'', code: b.code||'', color: b.color||'#0EA5E9' });
  }
  async function saveEdit(){
    if(!editForm.name.trim()) return;
    await updateBranch(editingId, { name: editForm.name.trim(), code: editForm.code.trim() || null, color: editForm.color || null });
    setEditingId(null);
  }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>🏢 Branches</div>
      <div className="small subtle" style={{marginBottom:14}}>Branches are administrative locations (HQ + rented pool sites). They filter Accounts, Pools, and Invoices throughout the app. Instructors, lesson types, packages, and invoice numbering are shared across all branches.</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <input className="input" style={{flex:'1 1 200px',maxWidth:240}} placeholder="Branch name (e.g. Ipoh)" value={name} onChange={e=>setName(e.target.value)} />
        <input className="input" style={{width:120}} placeholder="Code (e.g. IPH)" value={code} onChange={e=>setCode(e.target.value)} maxLength={8} />
        <input type="color" className="input" style={{width:64,padding:2}} value={color} onChange={e=>setColor(e.target.value)} title="Branch tint color" />
        <button className="btn btn-primary small" disabled={!name.trim()} onClick={async ()=>{
          if(!name.trim()) return;
          await addBranch({ name: name.trim(), code: code.trim() || null, color });
          setName(''); setCode(''); setColor('#0EA5E9');
        }}>+ Add Branch</button>
      </div>
    </div>

    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0}}>
        <table>
          <thead><tr>
            <th style={{width:'40%'}}>Name</th>
            <th style={{width:'15%'}}>Code</th>
            <th style={{width:90}}>Color</th>
            <th style={{width:100}}>Status</th>
            <th style={{width:200,textAlign:'right'}}>Actions</th>
          </tr></thead>
          <tbody>
            {(branches||[]).length === 0 && <tr><td colSpan={5} className="empty">No branches yet. Add one above to get started.</td></tr>}
            {(branches||[]).map(b => editingId === b.id ? (
              <tr key={b.id}>
                <td><input className="input" value={editForm.name} onChange={e=>setEditForm({...editForm, name:e.target.value})} /></td>
                <td><input className="input" value={editForm.code} onChange={e=>setEditForm({...editForm, code:e.target.value})} maxLength={8} /></td>
                <td><input type="color" className="input" style={{width:50,padding:2}} value={editForm.color} onChange={e=>setEditForm({...editForm, color:e.target.value})} /></td>
                <td className="small subtle">{b.is_active===false ? 'Archived' : 'Active'}</td>
                <td style={{textAlign:'right'}}>
                  <button className="btn btn-primary small" onClick={saveEdit} style={{marginRight:6}}>Save</button>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={b.id}>
                <td style={{fontWeight:600}}>{b.name}</td>
                <td><span style={{fontFamily:'monospace',fontSize:12,fontWeight:600,color:'var(--text-2)'}}>{b.code||'—'}</span></td>
                <td>{b.color ? <span style={{display:'inline-block',width:24,height:24,borderRadius:6,background:b.color,border:'1px solid var(--border)'}} /> : <span className="subtle">—</span>}</td>
                <td>{b.is_active===false ? <span className="pill" style={{background:'#FEF3C7',color:'#92400E'}}>Archived</span> : <span className="pill" style={{background:'#D1FAE5',color:'#065F46'}}>Active</span>}</td>
                <td style={{textAlign:'right'}}>
                  <button className="btn btn-ghost small" onClick={()=>startEdit(b)} style={{marginRight:6}}>✎ Edit</button>
                  <button className="btn btn-ghost small" onClick={()=>updateBranch(b.id, { is_active: b.is_active === false })} style={{marginRight:6}}>{b.is_active===false ? 'Restore' : 'Archive'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteBranch(b.id)}>🗑 Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

function SummaryView({ summary, pools }){
  const typeRows = Object.entries(summary.byType).sort((a,b)=>b[1]-a[1]);
  const instRows = Object.entries(summary.byInst).sort((a,b)=>b[1]-a[1]);
  const poolRows = Object.entries(summary.byPool).sort((a,b)=>b[1]-a[1]);
  return <>
    <div className="grid grid-3">
      <div className="card"><div className="small subtle">Total students</div><div style={{fontSize:34,fontWeight:800,color:'var(--primary)'}}>{summary.totalStudents}</div><div className="small subtle" style={{marginTop:6}}>Excludes lesson types containing "replacement" or "trial".</div></div>
      <div className="card"><div className="small subtle">Sessions this week</div><div style={{fontSize:34,fontWeight:800,color:'var(--teal)'}}>{summary.totalSessions}</div></div>
      <div className="card"><div className="small subtle">Active pools</div><div style={{fontSize:34,fontWeight:800,color:'#F59E0B'}}>{pools.length}</div></div>
    </div>
    <div className="grid grid-3" style={{marginTop:16}}>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Lesson Type</div><div className="table-wrap"><table><thead><tr><th>Lesson Type</th><th>Students</th></tr></thead><tbody>{typeRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Pool</div><div className="table-wrap"><table><thead><tr><th>Pool</th><th>Students</th></tr></thead><tbody>{poolRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
      <div className="card"><div style={{fontSize:18,fontWeight:800,marginBottom:10}}>By Instructor</div><div className="table-wrap"><table><thead><tr><th>Instructor</th><th>Students</th></tr></thead><tbody>{instRows.map(([k,v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></div></div>
    </div>
  </>;
}

// ============================================================================
// SettingsView (M2: pools, operating hours, expanded lesson-type editor)
// ============================================================================

function billingText(mode, count){ if(count === null || count === undefined || count === '') return ''; return `${count} ${mode === 'credit' ? 'credits' : 'monthly'}`; }
function BillingControl({ mode, count, onMode, onCount }){
  return <div style={{display:'flex',alignItems:'flex-end',gap:12,flexWrap:'wrap'}}>
    <div className="field" style={{margin:0}}>
      <label>Billing</label>
      <div className="seg">
        <button type="button" className={`seg-btn ${mode === 'credit' ? '' : 'on'}`} onClick={()=>onMode('monthly')}>Monthly</button>
        <button type="button" className={`seg-btn ${mode === 'credit' ? 'on' : ''}`} onClick={()=>onMode('credit')}>Credit</button>
      </div>
    </div>
    <div className="field" style={{margin:0}}>
      <label>{mode === 'credit' ? 'Credits' : 'Lessons per month'}</label>
      <div className="suffix-input">
        <input className="input" type="number" min="0" value={count} onChange={(e)=>onCount(e.target.value)} placeholder={mode === 'credit' ? '6' : '4'} />
        <span className="suffix-tag">{mode === 'credit' ? 'credits' : 'monthly'}</span>
      </div>
    </div>
  </div>;
}

function PackageEditor({ row, onSave, onCancel }){
  const [name, setName] = useState(row.name || '');
  const [pax, setPax] = useState(row.pax == null ? '' : String(row.pax));
  const [amount, setAmount] = useState(row.amount == null ? '' : String(row.amount));
  const [mode, setMode] = useState(row.billing_mode === 'credit' ? 'credit' : 'monthly');
  const [count, setCount] = useState(row.billing_count == null ? '' : String(row.billing_count));
  const [isGroup, setIsGroup] = useState(!!row.is_group);
  const [fallback, setFallback] = useState(row.fallback_per_pax == null ? '' : String(row.fallback_per_pax));
  return <div style={{width:'100%'}}>
    <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 90px 130px',gap:10}}>
      <div className="field" style={{margin:0}}><label>Package name</label><input className="input" value={name} onChange={(e)=>setName(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>{isGroup ? 'Required pax' : 'Pax'}</label><input className="input" type="number" min="1" value={pax} onChange={(e)=>setPax(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>{isGroup ? 'Bundle total (RM)' : 'Amount (RM)'}</label><input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></div>
    </div>
    <div style={{marginTop:10}}><BillingControl mode={mode} count={count} onMode={setMode} onCount={setCount} /></div>
    <label className="gb-check" style={{marginTop:10}}><input type="checkbox" checked={isGroup} onChange={e=>setIsGroup(e.target.checked)} /> Family unit (single payer for the required pax)</label>
    {isGroup ? <div className="field" style={{marginTop:8,maxWidth:280}}><label>Standard rate per pax if under-enrolled (RM)</label><input className="input" type="number" min="0" step="0.01" value={fallback} onChange={e=>setFallback(e.target.value)} placeholder="200" /></div> : null}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>{ const v = name.trim(); if(!v) return; onSave({ name:v, pax:(pax === '' ? null : Number(pax)), amount:(amount === '' ? null : Number(amount)), billing_mode:mode, billing_count:(count === '' ? null : Number(count)), is_group:isGroup, fallback_per_pax:(fallback === '' ? null : Number(fallback)) }); }}>Save</button>
    </div>
  </div>;
}

function SettingsView({ section, options, currentBranchId, status, addOption, toggleOption, deleteOption, deleteInstructor, patchOption, reorderOption, moveOption, saveLessonType, deleteLessonType, lessonTypeCounts, codes, students, packages, addCode, updateCode, deleteCode }){
  const dragRef = React.useRef({ canDrag:false });
  const [drag, setDrag] = useState({ key:null, idx:null });
  const [over, setOver] = useState(null);
  function gripEl(){ return <span className="grip" title="Drag to reorder" onMouseDown={()=>{ dragRef.current.canDrag = true; }} onTouchStart={()=>{ dragRef.current.canDrag = true; }}>⠿</span>; }
  function dragProps(listKey, table, list, idx){
    return {
      draggable:true,
      onDragStart:(e)=>{ if(!dragRef.current.canDrag){ e.preventDefault(); return; } setDrag({ key:listKey, idx }); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(idx)); }catch(_){} },
      onDragOver:(e)=>{ if(drag.key !== listKey) return; e.preventDefault(); if(over !== idx) setOver(idx); },
      onDrop:(e)=>{ e.preventDefault(); if(drag.key === listKey && drag.idx != null && drag.idx !== idx) moveOption(table, list, drag.idx, idx); setDrag({ key:null, idx:null }); setOver(null); dragRef.current.canDrag = false; },
      onDragEnd:()=>{ setDrag({ key:null, idx:null }); setOver(null); dragRef.current.canDrag = false; }
    };
  }
  function dragClass(listKey, idx){ return `${drag.key===listKey && drag.idx===idx ? 'lt-dragging' : ''} ${drag.key===listKey && over===idx && drag.idx!=null && drag.idx!==idx ? 'lt-drop' : ''}`; }
  function reorderCluster(listKey, table, list, idx){
    return <span style={{display:'inline-flex',alignItems:'center',gap:4}}>
      {gripEl()}
      <span className="reorder">
        <button className="reorder-btn" disabled={idx===0} title="Move up" onClick={()=>reorderOption(table, list, idx, -1)}>↑</button>
        <button className="reorder-btn" disabled={idx===list.length-1} title="Move down" onClick={()=>reorderOption(table, list, idx, 1)}>↓</button>
      </span>
    </span>;
  }
  const [newInstructor, setNewInstructor] = useState('');
  const [newInstructorGender, setNewInstructorGender] = useState(null);
  const [editingInstructorId, setEditingInstructorId] = useState(null);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeBranchId, setNewTypeBranchId] = useState(() => {
    if(currentBranchId && currentBranchId !== 'all') return currentBranchId;
    const first = (options.branches||[]).find(b => b.is_active !== false);
    return first ? first.id : '';
  });
  React.useEffect(() => { if(currentBranchId && currentBranchId !== 'all') setNewTypeBranchId(currentBranchId); }, [currentBranchId]);
  const [bg, setBg] = useState('#DBEAFE');
  const [bd, setBd] = useState('#3B82F6');
  const [tx, setTx] = useState('#1E40AF');
  const [newPoolName, setNewPoolName] = useState('');
  const [newPoolCap, setNewPoolCap] = useState(16);
  const [editingPoolId, setEditingPoolId] = useState(null);
  const [editPoolForm, setEditPoolForm] = useState({ name:'', capacity_total:16 });
  const [newPkgName, setNewPkgName] = useState('');
  const [newPkgPax, setNewPkgPax] = useState('');
  const [newPkgAmount, setNewPkgAmount] = useState('');
  const [newPkgMode, setNewPkgMode] = useState('monthly');
  const [newPkgCount, setNewPkgCount] = useState('');
  const [newPkgGroup, setNewPkgGroup] = useState(false);
  const [newPkgFallback, setNewPkgFallback] = useState('');
  const [editPkgId, setEditPkgId] = useState(null);
  const [pkgPanelLtId, setPkgPanelLtId] = useState(null);
  const [editingLessonId, setEditingLessonId] = useState(null);
  const counts = lessonTypeCounts || {};

  return <>
    {/* Pools & Operating Hours */}
    {section === 'pools' && <div className="settings-cols" style={{gridTemplateColumns:'1fr 1fr'}}>
      <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Pools</div>
        <div className="small subtle" style={{marginTop:4}}>Capacity includes every body in the water, instructors included.</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
          <input className="input" style={{flex:'1 1 130px'}} placeholder="Pool name" value={newPoolName} onChange={(e)=>setNewPoolName(e.target.value)} />
          <input className="input" style={{width:96}} type="number" min="1" placeholder="Cap" value={newPoolCap} onChange={(e)=>setNewPoolCap(e.target.value)} />
          <button className="btn btn-primary" onClick={()=>{ const v = newPoolName.trim(); const c = Number(newPoolCap); if(!v || !c || c < 1) return; addOption('pool', { name:v, capacity:c }); setNewPoolName(''); setNewPoolCap(16); }}>Add</button>
        </div>
        <div className="settings-list">
          {options.pools.length ? options.pools.map((r, idx) => {
            const isEditing = editingPoolId === r.id;
            return <div key={r.id} className={`row-item ${dragClass('pool', idx)}`} style={isEditing?{flexDirection:'column',alignItems:'stretch',gap:10}:{}} {...dragProps('pool', 'pools', options.pools, idx)}>
              {isEditing ? <>
                <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
                  <input className="input" style={{flex:'1 1 130px'}} value={editPoolForm.name} onChange={e=>setEditPoolForm({...editPoolForm,name:e.target.value})} placeholder="Pool name" />
                  <input className="input" style={{width:90}} type="number" min="1" value={editPoolForm.capacity_total} onChange={e=>setEditPoolForm({...editPoolForm,capacity_total:Number(e.target.value)})} placeholder="Cap" />
                  {(options.branches||[]).length > 0 && <select className="select" style={{width:140,padding:'4px 8px',fontSize:12}} value={editPoolForm.branch_id || ''} onChange={e=>setEditPoolForm({...editPoolForm,branch_id:e.target.value||null})}>
                    <option value="">No branch</option>
                    {(options.branches||[]).filter(b=>b.is_active!==false).map(b=><option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}
                  </select>}
                </div>
                <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                  <button className="btn btn-ghost small" onClick={()=>setEditingPoolId(null)}>Cancel</button>
                  <button className="btn btn-primary small" onClick={()=>{
                    const v=editPoolForm.name.trim(); const c=Number(editPoolForm.capacity_total);
                    if(!v||!c||c<1) return;
                    patchOption('pools',r.id,{name:v,capacity_total:c,branch_id:editPoolForm.branch_id||null});
                    setEditingPoolId(null);
                  }}>Save</button>
                </div>
              </> : <>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  {reorderCluster('pool', 'pools', options.pools, idx)}
                  <span className="pill" style={{background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD'}}>{r.is_active?'Active':'Hidden'}</span>
                  <div style={{fontWeight:600}}>{r.name}</div>
                  <span className="small subtle">cap {r.capacity_total}</span>
                  {(()=>{ const b=(options.branches||[]).find(x=>x.id===r.branch_id); return b?<span className="pill" style={{fontSize:10,background:'var(--surface-2)',color:'var(--text-3)'}}>{b.code||b.name}</span>:null; })()}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn btn-ghost small" style={{background:'#EAB308',color:'#000',border:'1px solid #CA8A04'}} onClick={()=>{ setEditPoolForm({name:r.name,capacity_total:r.capacity_total,branch_id:r.branch_id||''}); setEditingPoolId(r.id); }}>✎ Edit</button>
                  <button className="btn btn-ghost small" onClick={()=>toggleOption('pools',r)}>{r.is_active?'Hide':'Show'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteOption('pools',r,r.name)}>Delete</button>
                </div>
              </>}
            </div>;
          }) : <div className="empty">No pools</div>}
        </div>
      </div>

      <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Operating Hours</div>
        <div className="small subtle" style={{marginTop:4}}>Per-weekday open and close window. Drives the visible weekly grid bounds.</div>
        <div className="settings-list">
          {DAYS_F.map((label, idx) => {
            const row = options.operatingHours.find(h => Number(h.weekday) === idx + 1);
            if(!row) return <div key={idx} className="row-item"><div className="small subtle">{label}: not configured</div></div>;
            const fmtTime = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
            return <div key={row.weekday} className="row-item">
              <div style={{display:'flex',alignItems:'center',gap:7,flexWrap:'wrap'}}>
                <div style={{minWidth:74,fontWeight:700}}>{label}</div>
                <input className="input" style={{width:128,padding:'6px 8px',fontSize:13}} type="time" defaultValue={fmtTime(row.open_minute)} onBlur={(e)=>{ const [h,m] = e.target.value.split(':').map(Number); const v = h*60+m; if(Number.isFinite(v) && v !== row.open_minute) patchOption('operating_hours', { weekday: row.weekday }, { open_minute: v }); }} />
                <span className="small subtle">to</span>
                <input className="input" style={{width:128,padding:'6px 8px',fontSize:13}} type="time" defaultValue={fmtTime(row.close_minute)} onBlur={(e)=>{ const [h,m] = e.target.value.split(':').map(Number); const v = h*60+m; if(Number.isFinite(v) && v !== row.close_minute) patchOption('operating_hours', { weekday: row.weekday }, { close_minute: v }); }} />
                <label className="small" style={{display:'flex',alignItems:'center',gap:4}}>
                  <input type="checkbox" checked={row.is_open !== false} onChange={(e)=>patchOption('operating_hours', { weekday: row.weekday }, { is_open: e.target.checked })} />
                  Open
                </label>
              </div>
            </div>;
          })}
        </div>
      </div>
    </div>}

    {/* ── Instructors ──────────────────────────────────────────────── */}
    {section === 'instructors' && <div className="card">
        <div style={{fontSize:16,fontWeight:800}}>Instructors</div>
        <div className="small subtle" style={{marginTop:4}}>Names available in the session instructor dropdown. Edit to rename or set a gender.</div>
        <div className="inst-add">
          <input className="input" placeholder="Add instructor name" value={newInstructor} onChange={(e)=>setNewInstructor(e.target.value)} />
          <div className="gender-toggle gender-toggle-sm" role="radiogroup" aria-label="Gender">
            <button type="button" className={`gender-opt ${newInstructorGender==='female'?'active':''}`} onClick={()=>setNewInstructorGender(newInstructorGender==='female'?null:'female')} title="Female">♀ F</button>
            <button type="button" className={`gender-opt ${newInstructorGender==='male'?'active':''}`} onClick={()=>setNewInstructorGender(newInstructorGender==='male'?null:'male')} title="Male">♂ M</button>
          </div>
          <button className="btn btn-primary" onClick={()=>{ const v = newInstructor.trim(); if(!v) return; addOption('instructor', { name:v, gender:newInstructorGender }); setNewInstructor(''); setNewInstructorGender(null); }}>Add</button>
        </div>
        <div className="settings-list">{options.instructors.length ? options.instructors.map((r, idx) => {
          const assigned = (lessonTypeCounts && lessonTypeCounts.__bySessionInstructor && lessonTypeCounts.__bySessionInstructor[r.id]) || 0; // not provided; computed below in row instead
          return editingInstructorId === r.id
            ? <div key={r.id} className="row-item" style={{display:'block'}}>
                <InstructorEditor row={r} branches={options.branches} onCancel={()=>setEditingInstructorId(null)} onSave={(patch)=>{ patchOption('scheduler_instructors', r.id, patch); setEditingInstructorId(null); }} />
              </div>
            : <div key={r.id} className={`row-item ${dragClass('inst', idx)}`} {...dragProps('inst', 'scheduler_instructors', options.instructors, idx)}>
                <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'nowrap',minWidth:0,overflow:'hidden'}}>
                  {reorderCluster('inst', 'scheduler_instructors', options.instructors, idx)}
                  <span className="pill" style={{fontSize:10,padding:'2px 7px',background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD',flexShrink:0}}>{r.is_active?'Active':'Hidden'}</span>
                  <div style={{fontWeight:700,fontSize:12,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',minWidth:0}}>{r.name}</div>
                  {r.gender ? <span className={`gender-chip gender-chip-${r.gender}`} style={{fontSize:10,padding:'2px 6px',flexShrink:0}} title={r.gender==='female'?'Female':'Male'}>{r.gender==='female'?'♀':'♂'}</span> : null}
                  {r.primary_branch_id && (() => { const b = (options.branches||[]).find(x => x.id === r.primary_branch_id); return b ? <span style={{fontSize:10,padding:'2px 6px',background:'var(--surface-2)',border:'1px solid var(--border)',borderRadius:4,color:'var(--text-3)',fontFamily:'monospace',flexShrink:0}} title={`Primary branch: ${b.name}`}>🏢 {b.code||b.name}</span> : null; })()}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button className="btn btn-ghost small" onClick={()=>setEditingInstructorId(r.id)}>Edit</button>
                  <button className="btn btn-ghost small" onClick={()=>toggleOption('scheduler_instructors',r)}>{r.is_active?'Hide':'Show'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteInstructor(r)}>Delete</button>
                </div>
              </div>;
        }) : <div className="empty">No instructors</div>}</div>
    </div>}

    {/* ── Lesson Types ─────────────────────────────────────────────── */}
    {section === 'lessonTypes' && (() => {
      const branchTypes = (currentBranchId && currentBranchId !== 'all')
        ? options.lessonTypes.filter(t => !t.branch_id || t.branch_id === currentBranchId)
        : options.lessonTypes;
      const branchById = id => (options.branches||[]).find(b => b.id === id) || null;
      const activeBranches = (options.branches||[]).filter(b => b.is_active !== false);
      const showBranchTag = !currentBranchId || currentBranchId === 'all';
      return <><div className="card">
      <div style={{fontSize:18,fontWeight:800}}>Lesson Types</div>
      <div className="small subtle" style={{marginTop:4}}>Create a type for a branch and pick its colors. Lesson types and their packages are branch-specific — the list below shows the active branch's types. Click Edit on a row to rename it, set age range, ratio, billing, and default pool.</div>

      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 150px 78px 78px 78px auto',gap:10,alignItems:'end',marginTop:14}}>
        <div className="field" style={{margin:0}}><label>Name</label><input className="input" placeholder="e.g. LTS Group" value={newTypeName} onChange={(e)=>setNewTypeName(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Branch</label><select className="select" value={newTypeBranchId} onChange={(e)=>setNewTypeBranchId(e.target.value)}>{activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}</select></div>
        <div className="field" style={{margin:0}}><label>Background</label><input className="swatch" type="color" value={bg} onChange={(e)=>setBg(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Border</label><input className="swatch" type="color" value={bd} onChange={(e)=>setBd(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Text</label><input className="swatch" type="color" value={tx} onChange={(e)=>setTx(e.target.value)} /></div>
        <button className="btn btn-primary" style={{height:38}} disabled={!newTypeBranchId} onClick={()=>{ const v = newTypeName.trim(); if(!v || !newTypeBranchId) return; addOption('lessonType', { name:v, bg, bd, tx, branchId:newTypeBranchId }); setNewTypeName(''); }}>Add</button>
      </div>

      <div className="settings-list">
        {branchTypes.length ? branchTypes.map((r, idx) => { const n = counts[r.id] || 0; const pkgCount = (options.packages||[]).filter(p=>p.lesson_type_id===r.id).length; const poolName = (options.pools.find(p=>p.id===r.default_pool_id)?.name); const editingThis = editingLessonId===r.id; const pkgPanelOpen = pkgPanelLtId===r.id; const rBranch = showBranchTag ? branchById(r.branch_id) : null; return <div key={r.id}
          className={`lesson-row ${dragClass('lt', idx)}`} {...dragProps('lt', 'scheduler_lesson_types', branchTypes, idx)}>
          <div className={`lt-row-card ${!r.is_active ? 'lt-row-hidden' : ''}`}>
            <div className="lt-row-top">
              <div className="lt-row-lead">
                {reorderCluster('lt', 'scheduler_lesson_types', branchTypes, idx)}
                <span className="lt-name-chip" style={{background:r.bg_color,borderColor:r.border_color,color:r.text_color}}>{r.name}</span>
                {rBranch ? <span className="lt-branch-tag" style={rBranch.color?{background:rBranch.color+'1A',borderColor:rBranch.color,color:rBranch.color}:{}}>{rBranch.code || rBranch.name}</span> : null}
                <span className={`lt-type-badge lt-type-${r.class_type||'group'}`}>{r.class_type==='personal'?'🧑 Personal':'👥 Group'}</span>
                <span className="lt-classes-pill" title="Classes on the schedule using this type">{n} {n===1?'class':'classes'}</span>
              </div>
              <div className="lt-row-actions">
                <button className={`btn-packages ${pkgPanelOpen?'active':''}`} onClick={()=>setPkgPanelLtId(pkgPanelOpen?null:r.id)} title="Manage packages nested under this lesson type">Packages <span className="pkg-count-badge">{pkgCount}</span></button>
                <button className={`btn btn-ghost small ${editingThis?'btn-active':''}`} onClick={()=>setEditingLessonId(editingThis?null:r.id)}>{editingThis?'Close':'Edit'}</button>
                <button className="btn btn-ghost small" onClick={()=>toggleOption('scheduler_lesson_types',r)}>{r.is_active?'Hide':'Show'}</button>
                <button className="btn btn-danger small" onClick={()=>deleteLessonType(r)}>Delete</button>
              </div>
            </div>
            <div className="lt-row-meta">
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Ratio</span>
                <span className={`lt-meta-value ${r.students_per_instructor?'':'lt-meta-empty'}`}>{r.students_per_instructor ? `1:${r.students_per_instructor}` : '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Duration</span>
                <span className={`lt-meta-value ${r.default_duration_minutes?'':'lt-meta-empty'}`}>{r.default_duration_minutes ? `${r.default_duration_minutes} min` : '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Billing</span>
                <span className={`lt-meta-value ${r.billing_model?'':'lt-meta-empty'}`}>{r.billing_model || '—'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Default Pool</span>
                <span className={`lt-meta-value ${poolName?'':'lt-meta-empty'}`}>{poolName || 'None set'}</span>
              </div>
              <div className="lt-meta-tile">
                <span className="lt-meta-label">Age</span>
                <span className={`lt-meta-value ${(r.age_min_months!=null||r.age_max_months!=null)?'':'lt-meta-empty'}`}>{(r.age_min_months!=null||r.age_max_months!=null) ? `${r.age_min_months!=null?Math.floor(r.age_min_months/12)+'y':'·'}–${r.age_max_months!=null?Math.floor(r.age_max_months/12)+'y':'·'}` : 'Any age'}</span>
              </div>
            </div>
          </div>
          {editingLessonId === r.id ? <LessonTypeEditor row={r} pools={options.pools} onSave={(patch)=>{ saveLessonType(r, patch); setEditingLessonId(null); }} /> : null}
          {pkgPanelLtId === r.id ? <LessonTypePackages
            lessonType={r}
            packages={(options.packages||[]).filter(p=>p.lesson_type_id===r.id).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))}
            editPkgId={editPkgId}
            setEditPkgId={setEditPkgId}
            addOption={addOption}
            toggleOption={toggleOption}
            deleteOption={deleteOption}
            patchOption={patchOption}
            reorderOption={reorderOption}
          /> : null}
        </div>; }) : <div className="empty">No lesson types</div>}
      </div>
    </div>

    {/* Legacy packages — pre-nesting orphans, with a reassign-to-lesson-type control */}
    {(() => {
      const orphans = (options.packages || []).filter(p => !p.lesson_type_id);
      if(!orphans.length) return null;
      return <div className="card" style={{marginTop:16}}>
        <div style={{fontSize:16,fontWeight:800}}>Legacy Packages</div>
        <div className="small subtle" style={{marginTop:4}}>These packages exist from before packages were nested under lesson types. Assign each to a lesson type, or delete it. Swimmers and family groups on these still work until you reassign.</div>
        <div className="settings-list" style={{marginTop:10}}>{orphans.map(r => <div key={r.id} className="row-item">
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span className="pill" style={{background:'#FEF3C7',color:'#92400E',borderColor:'#FCD34D'}}>Unassigned</span>
            <div style={{fontWeight:700}}>{r.name}</div>
            <span className="small subtle">{r.pax != null ? `${r.pax} pax` : '—'}{r.amount != null ? ` · RM${r.amount}` : ''}{billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : ''}{r.is_group ? ' · 👪 family' : ''}</span>
          </div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <select className="select" defaultValue="" onChange={(e)=>{ if(e.target.value) patchOption('packages', r.id, { lesson_type_id: e.target.value }); }}>
              <option value="">Move to…</option>
              {options.lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
            <button className="btn btn-danger small" onClick={()=>deleteOption('packages',r,r.name)}>Delete</button>
          </div>
        </div>)}</div>
      </div>;
    })()}
    </>; })()}

    {/* ── Referral & Discount Codes ─────────────────────────────────── */}
    {section === 'codes' && addCode && <CodesPanel codes={codes||[]} students={students||[]} packages={packages||[]} addCode={addCode} updateCode={updateCode} deleteCode={deleteCode} />}
  </>;
}

// ============================================================================
// CodesPanel — Referral & Discount code management. Two filter pills toggle
// between the two kinds, then a single table-style list with inline create/edit.
// The same row schema serves both kinds; the editor adapts its fields to
// the selected code_type. Pure record-keeping for now — redemption logic
// will live in the future invoice module.
// ============================================================================
function CodesPanel({ codes, students, packages, addCode, updateCode, deleteCode }){
  const [filter, setFilter] = useState('all');         // all | referral | discount | active | expired
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);

  const today = todayStr();
  const filtered = (codes || []).filter(c => {
    if(filter === 'all') return true;
    if(filter === 'referral' || filter === 'discount') return c.code_type === filter;
    if(filter === 'active'){
      if(!c.is_active) return false;
      if(c.valid_until && c.valid_until < today) return false;
      if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return false;
      return true;
    }
    if(filter === 'expired'){
      if(!c.is_active) return true;
      if(c.valid_until && c.valid_until < today) return true;
      if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return true;
      return false;
    }
    return true;
  });

  function codeStatus(c){
    if(!c.is_active) return { label:'Inactive', tone:'grey' };
    if(c.valid_until && c.valid_until < today) return { label:'Expired', tone:'red' };
    if(c.valid_from && c.valid_from > today) return { label:'Scheduled', tone:'blue' };
    if(c.max_uses != null && (c.current_uses || 0) >= c.max_uses) return { label:'Used up', tone:'red' };
    return { label:'Active', tone:'green' };
  }
  function summarizeDiscount(c){
    if(!c.discount_type || c.discount_value == null) return '—';
    if(c.discount_type === 'percentage') return `${c.discount_value}% off`;
    if(c.discount_type === 'fixed') return `RM${c.discount_value} off`;
    if(c.discount_type === 'credit') return `+${c.discount_value} credits`;
    return '—';
  }
  function summarizeReferrerReward(c){
    if(c.code_type !== 'referral') return '—';
    if(!c.referrer_reward_type || c.referrer_reward_value == null) return '—';
    if(c.referrer_reward_type === 'percentage') return `${c.referrer_reward_value}% off`;
    if(c.referrer_reward_type === 'fixed') return `RM${c.referrer_reward_value} off`;
    if(c.referrer_reward_type === 'credit') return `+${c.referrer_reward_value} credits`;
    return '—';
  }
  function ownerName(id){
    const s = (students || []).find(x => x.id === id);
    return s ? s.name : '—';
  }

  return <div className="card" style={{marginTop:16}}>
    <div className="settings-section-title" style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
      <span>🎟 Referral &amp; Discount Codes</span>
      <span className="small subtle" style={{fontWeight:400,letterSpacing:0,textTransform:'none'}}>Manage promotional and referral codes. These are captured at intake and will be validated when invoices are generated.</span>
    </div>

    <div className="codes-toolbar" style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:12}}>
      <div className="codes-filter" style={{display:'flex',gap:4,border:'1px solid var(--border-2)',borderRadius:6,padding:2,background:'var(--surface)'}}>
        {['all','referral','discount','active','expired'].map(f =>
          <button key={f} className={`codes-filter-pill ${filter===f?'active':''}`} onClick={()=>setFilter(f)}>{f.charAt(0).toUpperCase()+f.slice(1)}</button>
        )}
      </div>
      <div style={{marginLeft:'auto'}}>
        <button className="btn btn-primary small" onClick={()=>{ setCreating(true); setEditingId(null); }}>+ New Code</button>
      </div>
    </div>

    {creating && <CodeEditor
      initial={{}}
      students={students}
      packages={packages}
      onCancel={()=>setCreating(false)}
      onSave={async (input)=>{ try{ await addCode(input); setCreating(false); } catch(_){} }}
    />}

    {filtered.length === 0 && !creating && <div className="empty" style={{padding:24,textAlign:'center',color:'var(--text-3)'}}>No codes match this filter.</div>}

    {filtered.length > 0 && <div className="codes-table-wrap" style={{border:'1px solid var(--border-2)',borderRadius:8,overflow:'hidden'}}>
      <table className="codes-table" style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead style={{background:'var(--surface-2)'}}>
          <tr>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Code</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Type</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Redeemer Benefit</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Referrer Reward</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Validity</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Uses</th>
            <th style={{textAlign:'left',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}>Status</th>
            <th style={{textAlign:'right',padding:'9px 10px',fontSize:10,textTransform:'uppercase',letterSpacing:.6,color:'var(--text-3)',fontWeight:800}}></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(c => {
            const st = codeStatus(c);
            const isEditing = editingId === c.id;
            return <React.Fragment key={c.id}>
              <tr style={{borderTop:'1px solid var(--border-2)'}}>
                <td style={{padding:'9px 10px',fontWeight:800,fontFamily:'ui-monospace,monospace',letterSpacing:.5}}>{c.code}</td>
                <td style={{padding:'9px 10px'}}>
                  {c.code_type === 'referral'
                    ? <span style={{display:'inline-flex',gap:5,alignItems:'center',fontSize:11,fontWeight:700,color:'var(--green-tx)',background:'var(--green-bg)',padding:'2px 8px',borderRadius:5,border:'1px solid var(--green-bd)'}}>👥 Referral</span>
                    : <span style={{display:'inline-flex',gap:5,alignItems:'center',fontSize:11,fontWeight:700,color:'var(--amber-tx)',background:'var(--amber-bg)',padding:'2px 8px',borderRadius:5,border:'1px solid var(--amber-bd)'}}>🏷 Discount</span>}
                  {c.code_type === 'referral' && c.owner_student_id ? <div className="small subtle" style={{marginTop:3}}>Owner: {ownerName(c.owner_student_id)}</div> : null}
                </td>
                <td style={{padding:'9px 10px'}}>{summarizeDiscount(c)}</td>
                <td style={{padding:'9px 10px'}}>{summarizeReferrerReward(c)}</td>
                <td style={{padding:'9px 10px',fontSize:11}}>{c.valid_from || c.valid_until
                  ? <span>{c.valid_from || '—'} → {c.valid_until || 'open'}</span>
                  : <span className="subtle">Always</span>}</td>
                <td style={{padding:'9px 10px',fontSize:11}}>{c.current_uses || 0}{c.max_uses != null ? ` / ${c.max_uses}` : ' (∞)'}</td>
                <td style={{padding:'9px 10px'}}>
                  <span className={`code-status-pill code-status-${st.tone}`}>{st.label}</span>
                </td>
                <td style={{padding:'9px 10px',textAlign:'right',whiteSpace:'nowrap'}}>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(isEditing?null:c.id)}>{isEditing?'Close':'Edit'}</button>
                  <button className="btn btn-ghost small" onClick={()=>updateCode(c.id, { isActive: !c.is_active })} title={c.is_active?'Deactivate':'Reactivate'}>{c.is_active?'⏸':'▶'}</button>
                  <button className="btn btn-danger small" onClick={()=>{ if(confirm(`Delete code "${c.code}"? This cannot be undone.`)) deleteCode(c.id); }}>×</button>
                </td>
              </tr>
              {isEditing && <tr><td colSpan={8} style={{padding:0,background:'var(--surface-2)'}}>
                <div style={{padding:'12px 14px'}}>
                  <CodeEditor
                    initial={c}
                    students={students}
                    packages={packages}
                    onCancel={()=>setEditingId(null)}
                    onSave={async (input)=>{ try{ await updateCode(c.id, input); setEditingId(null); } catch(_){} }}
                  />
                </div>
              </td></tr>}
            </React.Fragment>;
          })}
        </tbody>
      </table>
    </div>}
  </div>;
}

// Inline form for creating / editing a single code. Adapts to the selected
// code_type — referral codes get an owner picker and referrer-reward fields,
// discount codes hide those.
function CodeEditor({ initial, students, packages, onCancel, onSave }){
  const [codeStr, setCodeStr] = useState(initial.code || '');
  const [codeType, setCodeType] = useState(initial.code_type || 'discount');
  const [ownerStudentId, setOwnerStudentId] = useState(initial.owner_student_id || '');
  const [discountType, setDiscountType] = useState(initial.discount_type || 'percentage');
  const [discountValue, setDiscountValue] = useState(initial.discount_value ?? '');
  const [referrerRewardType, setReferrerRewardType] = useState(initial.referrer_reward_type || 'credit');
  const [referrerRewardValue, setReferrerRewardValue] = useState(initial.referrer_reward_value ?? '');
  const [validFrom, setValidFrom] = useState(initial.valid_from || '');
  const [validUntil, setValidUntil] = useState(initial.valid_until || '');
  const [maxUses, setMaxUses] = useState(initial.max_uses ?? '');
  const [maxUsesPerCustomer, setMaxUsesPerCustomer] = useState(initial.max_uses_per_customer ?? 1);
  const [appliesTo, setAppliesTo] = useState(initial.applies_to || 'all');
  const [minimumAmount, setMinimumAmount] = useState(initial.minimum_amount ?? '');
  const [isActive, setIsActive] = useState(initial.is_active !== false);
  const [notes, setNotes] = useState(initial.notes || '');

  const isReferral = codeType === 'referral';

  return <div className="code-editor" style={{padding:14,background:'var(--surface)',border:'1px solid var(--border-2)',borderRadius:8,marginBottom:12}}>
    <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'var(--text-3)',marginBottom:10}}>
      {initial.id ? `Edit code "${initial.code}"` : 'New code'}
    </div>

    {/* Type + Code string */}
    <div className="form-grid" style={{gridTemplateColumns:'auto 1fr auto'}}>
      <div className="field">
        <label>Type</label>
        <div style={{display:'flex',gap:4,border:'1px solid var(--border-2)',borderRadius:6,padding:2,background:'var(--surface-2)'}}>
          <button type="button" className={`codes-type-toggle ${codeType==='discount'?'active':''}`} onClick={()=>setCodeType('discount')}>🏷 Discount</button>
          <button type="button" className={`codes-type-toggle ${codeType==='referral'?'active':''}`} onClick={()=>setCodeType('referral')}>👥 Referral</button>
        </div>
      </div>
      <div className="field">
        <label>Code <span className="req">*</span></label>
        <input className="input" value={codeStr} onChange={e=>setCodeStr(e.target.value.toUpperCase())} placeholder="e.g. SARAH2025 or NEW50" style={{fontFamily:'ui-monospace,monospace',letterSpacing:.5,fontWeight:700}} />
      </div>
      <div className="field">
        <label>Status</label>
        <label className="gb-check" style={{height:38,display:'inline-flex',alignItems:'center',gap:6}}>
          <input type="checkbox" checked={isActive} onChange={e=>setIsActive(e.target.checked)} /> Active
        </label>
      </div>
    </div>

    {isReferral && <div className="form-grid" style={{gridTemplateColumns:'1fr',marginTop:8}}>
      <div className="field">
        <label>Owner (existing customer who shares this code)</label>
        <select className="select" value={ownerStudentId} onChange={e=>setOwnerStudentId(e.target.value)}>
          <option value="">— Select swimmer —</option>
          {(students || []).filter(s => s.isActive !== false).map(s => <option key={s.id} value={s.id}>{s.name}{s.guardianName ? ` (${s.guardianName})` : ''}</option>)}
        </select>
      </div>
    </div>}

    {/* Redeemer benefit */}
    <div style={{marginTop:12,padding:'10px 12px',background:'#F0F9FF',border:'1px solid #BFDBFE',borderRadius:6}}>
      <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'#1E40AF',marginBottom:7}}>Redeemer Benefit — what the new customer gets</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
        <div className="field">
          <label>Benefit Type</label>
          <select className="select" value={discountType} onChange={e=>setDiscountType(e.target.value)}>
            <option value="percentage">Percentage off</option>
            <option value="fixed">Fixed amount off (RM)</option>
            <option value="credit">Bonus credits</option>
          </select>
        </div>
        <div className="field">
          <label>Value <span className="subtle small">({discountType==='percentage'?'%':discountType==='fixed'?'RM':'credits'})</span></label>
          <input className="input" type="number" min="0" step="0.01" value={discountValue} onChange={e=>setDiscountValue(e.target.value)} placeholder={discountType==='percentage'?'10':discountType==='fixed'?'50':'4'} />
        </div>
      </div>
    </div>

    {/* Referrer reward */}
    {isReferral && <div style={{marginTop:10,padding:'10px 12px',background:'#F0FDF4',border:'1px solid #BBF7D0',borderRadius:6}}>
      <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:.6,fontWeight:800,color:'#065F46',marginBottom:7}}>Referrer Reward — what the existing customer earns</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
        <div className="field">
          <label>Reward Type</label>
          <select className="select" value={referrerRewardType} onChange={e=>setReferrerRewardType(e.target.value)}>
            <option value="credit">Bonus credits</option>
            <option value="fixed">Fixed amount off (RM)</option>
            <option value="percentage">Percentage off</option>
          </select>
        </div>
        <div className="field">
          <label>Value <span className="subtle small">({referrerRewardType==='percentage'?'%':referrerRewardType==='fixed'?'RM':'credits'})</span></label>
          <input className="input" type="number" min="0" step="0.01" value={referrerRewardValue} onChange={e=>setReferrerRewardValue(e.target.value)} placeholder={referrerRewardType==='percentage'?'10':referrerRewardType==='fixed'?'50':'2'} />
        </div>
      </div>
    </div>}

    {/* Validity + limits */}
    <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr',marginTop:10}}>
      <div className="field">
        <label>Valid From <span className="subtle small">(blank = anytime)</span></label>
        <input className="input" type="date" value={validFrom} onChange={e=>setValidFrom(e.target.value)} />
      </div>
      <div className="field">
        <label>Valid Until <span className="subtle small">(blank = no expiry)</span></label>
        <input className="input" type="date" value={validUntil} onChange={e=>setValidUntil(e.target.value)} />
      </div>
    </div>
    <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr',marginTop:8}}>
      <div className="field">
        <label>Max Total Uses <span className="subtle small">(blank = ∞)</span></label>
        <input className="input" type="number" min="0" value={maxUses} onChange={e=>setMaxUses(e.target.value)} placeholder="unlimited" />
      </div>
      <div className="field">
        <label>Max Uses per Customer</label>
        <input className="input" type="number" min="1" value={maxUsesPerCustomer} onChange={e=>setMaxUsesPerCustomer(e.target.value)} placeholder="1" />
      </div>
      <div className="field">
        <label>Minimum Invoice (RM)</label>
        <input className="input" type="number" min="0" step="0.01" value={minimumAmount} onChange={e=>setMinimumAmount(e.target.value)} placeholder="none" />
      </div>
    </div>
    <div className="form-grid" style={{gridTemplateColumns:'1fr 2fr',marginTop:8}}>
      <div className="field">
        <label>Applies To</label>
        <select className="select" value={appliesTo} onChange={e=>setAppliesTo(e.target.value)}>
          <option value="all">All purchases</option>
          <option value="first_purchase">First purchase only</option>
        </select>
      </div>
      <div className="field">
        <label>Internal Notes</label>
        <input className="input" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. Q1 launch promo, only for new families" />
      </div>
    </div>

    <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:14}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>{
        if(!codeStr.trim()){ alert('Code string is required.'); return; }
        onSave({
          code: codeStr,
          codeType,
          ownerStudentId: isReferral ? (ownerStudentId || null) : null,
          discountType, discountValue,
          referrerRewardType: isReferral ? referrerRewardType : null,
          referrerRewardValue: isReferral ? referrerRewardValue : null,
          validFrom, validUntil,
          maxUses, maxUsesPerCustomer,
          appliesTo, minimumAmount,
          isActive, notes
        });
      }}>{initial.id ? 'Save Changes' : 'Create Code'}</button>
    </div>
  </div>;
}

// Manage packages nested under one lesson type: add, edit (PackageEditor),
// reorder with ↑/↓, hide, delete. Same controls as the old top-level card but
// scoped to its lesson type — so each type owns its Normal, Trial, Family 3…
// Inline editor for an instructor: rename + Female/Male toggle.
function InstructorEditor({ row, onSave, onCancel, branches }){
  const [name, setName] = useState(row.name || '');
  const [gender, setGender] = useState(row.gender || null);
  const [primaryBranchId, setPrimaryBranchId] = useState(row.primary_branch_id || '');
  function apply(){ const v = (name || '').trim(); if(!v) return; onSave({ name:v, gender: gender || null, primary_branch_id: primaryBranchId || null }); }
  return <div className="inst-editor">
    <div className="field" style={{margin:0,flex:1,minWidth:160}}>
      <label>Name</label>
      <input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Instructor name" />
    </div>
    <div className="field" style={{margin:0}}>
      <label>Gender</label>
      <div className="gender-toggle">
        <button type="button" className={`gender-opt ${gender==='female'?'active':''}`} onClick={()=>setGender(gender==='female'?null:'female')}>♀ Female</button>
        <button type="button" className={`gender-opt ${gender==='male'?'active':''}`} onClick={()=>setGender(gender==='male'?null:'male')}>♂ Male</button>
      </div>
    </div>
    {(branches||[]).length > 0 && <div className="field" style={{margin:0,minWidth:140}}>
      <label>Primary Branch <span style={{fontWeight:400,color:'var(--text-3)',fontSize:10}}>(hint only)</span></label>
      <select className="select" value={primaryBranchId} onChange={e=>setPrimaryBranchId(e.target.value)}>
        <option value="">— None —</option>
        {(branches||[]).filter(b=>b.is_active!==false).map(b => <option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}
      </select>
    </div>}
    <div style={{display:'flex',gap:6,alignSelf:'flex-end'}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={apply}>Save</button>
    </div>
  </div>;
}

function LessonTypePackages({ lessonType, packages, editPkgId, setEditPkgId, addOption, toggleOption, deleteOption, patchOption, reorderOption }){
  const [name, setName] = useState('');
  const [pax, setPax] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('monthly');
  const [count, setCount] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [fallback, setFallback] = useState('');
  function reset(){ setName(''); setPax(''); setAmount(''); setMode('monthly'); setCount(''); setIsGroup(false); setFallback(''); }
  return <div className="lt-packages">
    <div className="lt-packages-head">
      <span className="chip" style={{background:lessonType.bg_color,borderColor:lessonType.border_color,color:lessonType.text_color,fontWeight:800}}>{lessonType.name}</span>
      <span className="small subtle">Packages nested under this lesson type</span>
    </div>

    <div className="lt-packages-list">
      {packages.length ? packages.map((r, i) => editPkgId === r.id
        ? <div key={r.id} className="row-item" style={{display:'block'}}>
            <PackageEditor row={r} onCancel={()=>setEditPkgId(null)} onSave={(patch)=>{ patchOption('packages', r.id, patch); setEditPkgId(null); }} />
          </div>
        : <div key={r.id} className="row-item">
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <div className="reorder">
                <button className="reorder-btn" disabled={i===0} title="Move up" onClick={()=>reorderOption('packages', packages, i, -1)}>↑</button>
                <button className="reorder-btn" disabled={i===packages.length-1} title="Move down" onClick={()=>reorderOption('packages', packages, i, 1)}>↓</button>
              </div>
              <span className="pill" style={{background:r.is_active?'var(--primary-soft)':'#F0F0F5',color:r.is_active?'var(--primary-on-soft)':'#9C9CAD'}}>{r.is_active?'Active':'Hidden'}</span>
              <div style={{fontWeight:700}}>{r.name}</div>
              <span className="small subtle">{r.pax != null ? `${r.pax}${r.is_group ? ' pax req.' : ' pax'}` : '—'} · {r.amount != null ? `RM${r.amount}${r.is_group ? ' bundle' : ''}` : 'no amount'}{billingText(r.billing_mode, r.billing_count) ? ` · ${billingText(r.billing_mode, r.billing_count)}` : ''}{r.is_group ? ` · 👪 family${r.fallback_per_pax != null ? `, RM${r.fallback_per_pax}/pax fallback` : ''}` : ''}</span>
            </div>
            <div style={{display:'flex',gap:6}}>
              <button className="btn btn-ghost small" onClick={()=>setEditPkgId(r.id)}>Edit</button>
              <button className="btn btn-ghost small" onClick={()=>toggleOption('packages',r)}>{r.is_active?'Hide':'Show'}</button>
              <button className="btn btn-danger small" onClick={()=>deleteOption('packages',r,r.name)}>Delete</button>
            </div>
          </div>) : <div className="empty">No packages yet for this lesson type.</div>}
    </div>

    <div className="lt-packages-add">
      <div style={{fontSize:13,fontWeight:700,marginBottom:6}}>+ Add a package under {lessonType.name}</div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 90px 130px',gap:10}}>
        <div className="field" style={{margin:0}}><label>Name</label><input className="input" placeholder="e.g. Family of 4" value={name} onChange={(e)=>setName(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Pax</label><input className="input" type="number" min="1" value={pax} onChange={(e)=>setPax(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Amount (RM)</label><input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e)=>setAmount(e.target.value)} /></div>
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',gap:12,marginTop:10,flexWrap:'wrap'}}>
        <BillingControl mode={mode} count={count} onMode={setMode} onCount={setCount} />
        <button className="btn btn-primary small" onClick={()=>{ const v = name.trim(); if(!v) return; addOption('package', { lessonTypeId:lessonType.id, name:v, pax, amount, billingMode:mode, billingCount:count, isGroup, fallbackPerPax:fallback }); reset(); }}>Add Package</button>
      </div>
      <div style={{display:'flex',alignItems:'flex-end',gap:14,marginTop:8,flexWrap:'wrap'}}>
        <label className="gb-check"><input type="checkbox" checked={isGroup} onChange={e=>setIsGroup(e.target.checked)} /> Family unit (single payer)</label>
        {isGroup ? <div className="field" style={{margin:0,maxWidth:260}}><label>Standard rate per pax if under-enrolled (RM)</label><input className="input" type="number" min="0" step="0.01" placeholder="200" value={fallback} onChange={e=>setFallback(e.target.value)} /></div> : null}
      </div>
    </div>
  </div>;
}

// M2: inline editor for the new lesson-type fields. Saves on Apply.
function LessonTypeEditor({ row, pools, onSave }){
  const [draft, setDraft] = useState({
    name: row.name || '',
    age_min_months: row.age_min_months ?? '',
    age_max_months: row.age_max_months ?? '',
    students_per_instructor: row.students_per_instructor ?? '',
    default_duration_minutes: row.default_duration_minutes ?? '',
    billing_model: row.billing_model || 'monthly',
    class_type: row.class_type || 'group',
    monthly_fee: row.monthly_fee ?? '',
    lessons_per_month: row.lessons_per_month ?? '',
    credit_count: row.credit_count ?? '',
    credit_fee: row.credit_fee ?? '',
    default_pool_id: row.default_pool_id || '',
    coach_in_pool: row.coach_in_pool !== false,
    bg_color: row.bg_color || '#DBEAFE',
    border_color: row.border_color || '#3B82F6',
    text_color: row.text_color || '#1E40AF'
  });
  function setF(k, v){ setDraft(d => ({ ...d, [k]: v })); }
  function clean(v){ if(v === '' || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : v; }
  return <div className="lesson-edit">
    <div className="form-grid" style={{gridTemplateColumns:'repeat(4, minmax(0,1fr))'}}>
      <div className="field" style={{gridColumn:'1 / 3'}}><label>Name</label><input className="input" value={draft.name} onChange={(e)=>setF('name', e.target.value)} placeholder="Lesson type name" /></div>
      <div className="field"><label>Age min (months)</label><input className="input" type="number" value={draft.age_min_months} onChange={(e)=>setF('age_min_months', e.target.value)} placeholder="60 for 5 years" /></div>
      <div className="field"><label>Age max (months)</label><input className="input" type="number" value={draft.age_max_months} onChange={(e)=>setF('age_max_months', e.target.value)} placeholder="216 for 18 years" /></div>
      <div className="field"><label>Students per instructor</label><input className="input" type="number" value={draft.students_per_instructor} onChange={(e)=>setF('students_per_instructor', e.target.value)} placeholder="6 for 1:6" /></div>
      <div className="field"><label>Default duration (min)</label><input className="input" type="number" value={draft.default_duration_minutes} onChange={(e)=>setF('default_duration_minutes', e.target.value)} placeholder="50" /></div>
      <div className="field"><label>Default pool</label><select className="select" value={draft.default_pool_id} onChange={(e)=>setF('default_pool_id', e.target.value)}><option value="">(none)</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div className="field"><label>Billing model</label><select className="select" value={draft.billing_model} onChange={(e)=>setF('billing_model', e.target.value)}><option value="monthly">Monthly</option><option value="credit">Credit</option></select></div>
      <div className="field"><label>Class type</label>
        <div className="gender-toggle" style={{marginTop:2}}>
          <button type="button" className={`gender-opt ${draft.class_type==='group'?'active':''}`} onClick={()=>setF('class_type','group')}>👥 Group</button>
          <button type="button" className={`gender-opt ${draft.class_type==='personal'?'active':''}`} onClick={()=>setF('class_type','personal')}>🧑 Personal</button>
        </div>
        <div className="hint" style={{marginTop:4}}>{draft.class_type==='personal'?'Private lesson — enables credit tracking and per-week reschedule':'Group lesson — enables drop-in replacement for absent swimmers'}</div>
      </div>
      <div className="field"><label>Coach in pool</label><div style={{display:'flex',alignItems:'center',gap:8,padding:'10px 0'}}><input type="checkbox" checked={draft.coach_in_pool} onChange={(e)=>setF('coach_in_pool', e.target.checked)} /><span className="small subtle">Uncheck for on-deck coaching (Strokelab Elite)</span></div></div>
      {draft.billing_model === 'monthly' ? <>
        <div className="field"><label>Monthly fee</label><input className="input" type="number" step="0.01" value={draft.monthly_fee} onChange={(e)=>setF('monthly_fee', e.target.value)} /></div>
        <div className="field"><label>Lessons per month</label><input className="input" type="number" value={draft.lessons_per_month} onChange={(e)=>setF('lessons_per_month', e.target.value)} placeholder="4" /></div>
      </> : <>
        <div className="field"><label>Credit count</label><input className="input" type="number" value={draft.credit_count} onChange={(e)=>setF('credit_count', e.target.value)} placeholder="4 or 6" /></div>
        <div className="field"><label>Credit fee (full pack)</label><input className="input" type="number" step="0.01" value={draft.credit_fee} onChange={(e)=>setF('credit_fee', e.target.value)} /></div>
      </>}
      <div className="field"><label>Background</label><input className="swatch" type="color" value={draft.bg_color} onChange={(e)=>setF('bg_color', e.target.value)} /></div>
      <div className="field"><label>Border</label><input className="swatch" type="color" value={draft.border_color} onChange={(e)=>setF('border_color', e.target.value)} /></div>
      <div className="field"><label>Text</label><input className="swatch" type="color" value={draft.text_color} onChange={(e)=>setF('text_color', e.target.value)} /></div>
    </div>
    <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:10}}>
      <button className="btn btn-primary" onClick={()=>{
        onSave({
          name: draft.name.trim() || row.name,
          age_min_months: clean(draft.age_min_months),
          age_max_months: clean(draft.age_max_months),
          students_per_instructor: clean(draft.students_per_instructor),
          default_duration_minutes: clean(draft.default_duration_minutes),
          billing_model: draft.billing_model,
          class_type: draft.class_type || 'group',
          monthly_fee: clean(draft.monthly_fee),
          lessons_per_month: clean(draft.lessons_per_month),
          credit_count: clean(draft.credit_count),
          credit_fee: clean(draft.credit_fee),
          default_pool_id: draft.default_pool_id || null,
          coach_in_pool: !!draft.coach_in_pool,
          bg_color: draft.bg_color,
          border_color: draft.border_color,
          text_color: draft.text_color
        });
      }}>Apply Changes</button>
    </div>
  </div>;
}

// ============================================================================
// SessionModal (M2: pool selector, lesson-type auto-default, capacity preview)
// ============================================================================

// M4: deterministic enrollment matcher. Given an age (or a registered swimmer)
// plus availability, it filters the selected week's sessions to age-eligible
// lesson types, ranks them by open capacity, and offers one-tap enroll/create.
function EnrollView({ sessions, students, studentById, lessonTypes, lessonTypeById, lessonTypeByName, poolById, colorsFor, gridBounds, packages, instructors, initialWeekStart, onEnroll, onCreate, onEdit, onAdd }){
  const [weekStart, setWeekStart] = useState(initialWeekStart);

  // ── Filter state ──────────────────────────────────────────────────
  // Lesson Types: empty Set = no filter (show all). Non-empty = show only matching.
  const [activeLts, setActiveLts] = useState(new Set());
  // Not Full: OFF = show all (including full). ON = hide full sessions.
  const [notFull, setNotFull] = useState(false);
  // Instructors: all ON by default. Toggle off to hide that instructor's sessions.
  const allInstNames = useMemo(() => (instructors || []).map(i => i.name), [instructors]);
  const [activeInsts, setActiveInsts] = useState(() => new Set(allInstNames));
  // Gender quick-toggle: applies to instructor pills in bulk.
  const [genderMode, setGenderMode] = useState('all'); // 'all' | 'male' | 'female'
  React.useEffect(() => { setActiveInsts(new Set(allInstNames)); }, [allInstNames]);

  function toggleLt(id){ setActiveLts(s => { const n = new Set(s); if(n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function toggleInst(name){ setActiveInsts(s => { const n = new Set(s); if(n.has(name)) n.delete(name); else n.add(name); return n; }); setGenderMode('custom'); }
  function setGender(mode){
    setGenderMode(mode);
    if(mode === 'all'){ setActiveInsts(new Set(allInstNames)); return; }
    const filtered = (instructors || []).filter(i => (i.gender || '').toLowerCase() === mode).map(i => i.name);
    setActiveInsts(new Set(filtered));
  }

  // ── Session analysis + filtering ──────────────────────────────────
  const weekSessions = useMemo(() => sessions.filter(s => s.weekStartDate === weekStart), [sessions, weekStart]);

  const analyzed = useMemo(() => {
    return weekSessions.map(s => {
      const lt = (s.lessonTypeId && lessonTypeById(s.lessonTypeId)) || lessonTypeByName(s.type);
      const cap = sessionCapacity(s, lt);
      const isFull = cap.max > 0 && cap.current >= cap.max;
      const instName = (s.instructors?.[0]?.name) || s.legacyInstructor || '';
      return { s, lt, ltId: lt?.id, cap, isFull, instName };
    });
  }, [weekSessions, lessonTypeById, lessonTypeByName]);

  const visible = useMemo(() => {
    return analyzed.filter(a => {
      // 1. Lesson type: if any selected, must match
      if(activeLts.size > 0 && !activeLts.has(a.ltId)) return false;
      // 2. Not Full filter
      if(notFull && a.isFull) return false;
      // 3. Instructor filter
      if(a.instName && !activeInsts.has(a.instName)) return false;
      return true;
    });
  }, [analyzed, activeLts, notFull, activeInsts]);

  const byDay = useMemo(() => Array.from({length:7}, (_,di) => visible.filter(v => v.s.day === di).sort((a,b) => a.s.startMinute - b.s.startMinute)), [visible]);

  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = []; for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const wb = weekBounds(weekStart);

  // Stats
  const totalShown = visible.length;
  const totalAll = analyzed.length;
  const fullCount = visible.filter(v => v.isFull).length;
  const openCount = totalShown - fullCount;

  return <>
    <div className="card" style={{marginBottom:16}}>
      <div className="view-head">
        <div>
          <div className="view-title">Schedule Explorer</div>
          <div className="small subtle">Filter the weekly schedule by lesson type, availability, and instructor. Click any session to view or edit.</div>
        </div>
        <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
          <span className="enroll-stat fits">{openCount} open</span>
          <span className="enroll-stat full">{fullCount} full</span>
          <span className="small subtle">{totalShown}/{totalAll} shown</span>
        </div>
      </div>
      <PeriodNav rangeLabel={weekRangeLabel(weekStart)} onPrev={()=>setWeekStart(addDays(weekStart,-7))} onNext={()=>setWeekStart(addDays(weekStart,7))} onToday={()=>setWeekStart(initialWeekStart)} isCurrent={weekStart===initialWeekStart} />

      {/* ── Lesson Type pills (additive: none selected = show all) ─── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Lesson Type</div>
        <div className="enroll-filter-pills">
          {lessonTypes.map(lt => {
            const isOn = activeLts.has(lt.id);
            const c = colorsFor(lt.name);
            return <button key={lt.id} type="button" className={`enroll-pill ${isOn ? 'is-on' : ''}`} style={isOn ? {background:c.bg, borderColor:c.bd, color:c.tx} : {}} onClick={()=>toggleLt(lt.id)}>{lt.name}</button>;
          })}
          {activeLts.size > 0 ? <button type="button" className="enroll-pill-clear" onClick={()=>setActiveLts(new Set())}>✕ Clear</button> : null}
        </div>
      </div>

      {/* ── Availability toggle ──────────────────────────────────────── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Availability</div>
        <div className="enroll-filter-pills">
          <button type="button" className={`enroll-pill ${notFull ? 'is-on' : ''}`} style={notFull ? {background:'#D1FAE5',borderColor:'#10B981',color:'#065F46'} : {}} onClick={()=>setNotFull(v=>!v)}>Not Full Only</button>
        </div>
      </div>

      {/* ── Instructor filters + gender quick-toggles ────────────────── */}
      <div className="enroll-filter-section">
        <div className="enroll-filter-label">Instructor</div>
        <div className="enroll-filter-pills" style={{marginBottom:4}}>
          <button type="button" className={`enroll-pill ${genderMode==='all'?'is-on':''}`} style={genderMode==='all'?{background:'#DBEAFE',borderColor:'#3B82F6',color:'#1E3A8A'}:{}} onClick={()=>setGender('all')}>All</button>
          <button type="button" className={`enroll-pill ${genderMode==='male'?'is-on':''}`} style={genderMode==='male'?{background:'#DBEAFE',borderColor:'#3B82F6',color:'#1E3A8A'}:{}} onClick={()=>setGender('male')}>♂ Male</button>
          <button type="button" className={`enroll-pill ${genderMode==='female'?'is-on':''}`} style={genderMode==='female'?{background:'#FCE7F3',borderColor:'#EC4899',color:'#831843'}:{}} onClick={()=>setGender('female')}>♀ Female</button>
        </div>
        <div className="enroll-filter-pills">
          {(instructors || []).map(inst => {
            const isOn = activeInsts.has(inst.name);
            return <button key={inst.id||inst.name} type="button" className={`enroll-pill ${isOn ? 'is-on' : ''}`} onClick={()=>toggleInst(inst.name)}>{inst.name}</button>;
          })}
        </div>
      </div>
    </div>

    <div className="card">
      <div className="enroll-grid">
        <div className="enroll-grid-corner" />
        {DAYS_S.map((d,di) => {
          const dt = new Date(wb.start); dt.setDate(wb.start.getDate()+di);
          return <div key={'h'+di} className="enroll-grid-dayhead">
            <div className="enroll-grid-dayname">{d}</div>
            <div className="enroll-grid-daydate">{dt.toLocaleDateString(undefined,{month:'short',day:'numeric'})}</div>
          </div>;
        })}
        {hours.map(h => <React.Fragment key={h}>
          <div className="enroll-grid-time">{hourLabel(h)}</div>
          {DAYS_S.map((_,di) => {
            const cellInfos = byDay[di].filter(v => v.s.startMinute >= h && v.s.startMinute < h + 60);
            return <div key={'c'+di+'-'+h} className="enroll-grid-cell">
              {cellInfos.map(info => {
                const c = colorsFor(info.s.type);
                const capLabel = info.cap.max > 0 ? `${info.cap.current}/${info.cap.max}` : `${info.cap.current}`;
                return <div key={info.s.id} className={`enroll-mini ${info.isFull ? 'mini-full' : 'mini-fits'}`} style={{borderLeftColor:c.bd,background:c.bg}} onClick={(e)=>{ e.stopPropagation(); onEnroll(info.s, []); }}>
                  <div className="enroll-mini-top">
                    <span className="enroll-mini-type" style={{color:c.tx}}>{info.s.type}</span>
                    <div style={{display:'flex',alignItems:'center',gap:4}}>
                      <span className="enroll-mini-cap">{capLabel}</span>
                      {onEdit && <span className="enroll-mini-edit" title="Edit session" onClick={e=>{ e.stopPropagation(); onEdit(info.s); }}>✎</span>}
                    </div>
                  </div>
                  <div className="enroll-mini-meta">{minuteToTime(info.s.startMinute)}{info.instName ? ` · ${info.instName}` : ''}</div>
                </div>;
              })}
              {onAdd && <div className="enroll-add-btn" title="Add session" onClick={()=>{
                try{ onAdd(di, h, null, weekStart); }
                catch(err){ console.error('EnrollView + error:', err); alert('Could not open add session: ' + err.message); }
              }}>+</div>}
            </div>;
          })}
        </React.Fragment>)}
      </div>
    </div>
  </>;
}

// Searchable swimmer combobox used in each enrollment slot.
// The dropdown is portalled into document.body and positioned with
// position:fixed so it floats above the modal — never clipped by the
// scrollable modal-body. Auto-flips upward when there isn't enough room
// below; tracks the input on window scroll/resize.
function StudentSelect({ valueId, fallbackLabel, studentById, candidates, onPick, conflict, trialStudentIds, pendingByKey, weekStartDate, lessonTypeId }){
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [popPos, setPopPos] = useState(null);   // { left, top, width, flipUp, maxH }
  const triggerRef = React.useRef(null);
  const sel = valueId ? studentById[valueId] : null;
  const label = sel ? `${sel.name}${sel.age != null ? ` (${sel.age})` : ''}` : (fallbackLabel || '');
  const filtered = (candidates || []).filter(s => !q || (s.name || '').toLowerCase().includes(q.toLowerCase()));
  // Trial flag is context-sensitive: a swimmer's global "trial" status only
  // surfaces here if the current session's lesson type matches one of their
  // enrolled lesson types. A trial LTS swimmer dropped into a Personal-class
  // dropdown reads as a regular candidate, not as "trial".
  function isTrialFor(s){
    if(!(trialStudentIds && trialStudentIds.has(s.id))) return false;
    if(!lessonTypeId) return false;
    return (s.lessonTypeIds || []).includes(lessonTypeId);
  }
  // Sort: pending-replacement first, then context-matching trial, then the
  // rest alphabetical — so flagged candidates surface at the top of the
  // dropdown when scheduler is looking for one.
  const sortedFiltered = filtered.slice().sort((a, b) => {
    const aP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${a.id}:${lessonTypeId}:${weekStartDate}`]);
    const bP = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${b.id}:${lessonTypeId}:${weekStartDate}`]);
    if(aP !== bP) return aP ? -1 : 1;
    const aT = isTrialFor(a);
    const bT = isTrialFor(b);
    if(aT !== bT) return aT ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });
  function choose(s){ onPick(s); setOpen(false); setQ(''); }

  // Recompute popup position from the trigger's bounding rect. Used on
  // open + on resize + on capture-phase scroll so scrolling the modal
  // body keeps the dropdown stuck to the input.
  function recalcPos(){
    const el = triggerRef.current;
    if(!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const desired = 280; // ideal dropdown height
    const spaceBelow = vh - r.bottom - 12;
    const spaceAbove = r.top - 12;
    const flipUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxH = Math.min(desired, Math.max(140, flipUp ? spaceAbove : spaceBelow));
    setPopPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)),
      top: flipUp ? null : (r.bottom + 5),
      bottom: flipUp ? (vh - r.top + 5) : null,
      width: Math.max(r.width, 260),
      maxH
    });
  }
  React.useEffect(() => {
    if(!open) return;
    recalcPos();
    const onResize = () => recalcPos();
    const onScroll = () => recalcPos();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);  // capture so modal-body scroll also fires
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  // The dropdown body — extracted so we can portal it cleanly.
  const dropdown = open && popPos ? <>
    <div className="ssel-backdrop" onClick={()=>{ setOpen(false); setQ(''); }} />
    <div className="ssel-pop ssel-pop-portal" style={{
      position:'fixed',
      left: popPos.left,
      ...(popPos.top != null ? { top: popPos.top } : {}),
      ...(popPos.bottom != null ? { bottom: popPos.bottom } : {}),
      width: popPos.width
    }}>
      <div className="ssel-list" style={{ maxHeight: popPos.maxH }}>
        {sortedFiltered.length ? sortedFiltered.map(s => {
          const isPending = !!(pendingByKey && lessonTypeId && weekStartDate && pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`]);
          const isTrial = isTrialFor(s);
          const pendingInfo = isPending ? pendingByKey[`${s.id}:${lessonTypeId}:${weekStartDate}`] : null;
          return <button key={s.id} type="button" className={`ssel-item ${isPending ? 'ssel-item-pending' : ''} ${isTrial ? 'ssel-item-trial' : ''}`} onClick={()=>choose(s)}>
            <span className="ssel-item-main">
              {isPending ? <span className="ssel-flag ssel-flag-r" title={`Pending replacement from ${pendingInfo.original_session_label}`}>R-pending</span> : null}
              {isTrial ? <span className="ssel-flag ssel-flag-trial" title="Trial swimmer — one-off booking for this lesson type">trial</span> : null}
              <span className="ssel-item-name">{s.name}</span>
            </span>
            <span className="ssel-item-meta">{s.age != null ? `${s.age}y` : ''}{isPending ? ` · from ${pendingInfo.original_session_label}` : (s.package ? ` · ${s.package}` : '')}</span>
          </button>;
        }) : <div className="ssel-empty">No swimmers found</div>}
      </div>
    </div>
  </> : null;

  return <div className="ssel" ref={triggerRef}>
    <div className={`ssel-control ${label ? 'has' : ''}`}>
      <input
        className="ssel-input"
        type="text"
        value={open ? q : label}
        placeholder={label ? '' : 'Type to search swimmer…'}
        onFocus={()=>{ setOpen(true); setQ(''); }}
        onChange={(e)=>{ setQ(e.target.value); if(!open) setOpen(true); }} />
      {label
        ? <span className="ssel-x" title="Clear slot" onMouseDown={(e)=>{ e.preventDefault(); onPick(null); setQ(''); setOpen(false); }}>×</span>
        : <span className="ssel-caret" title="Browse" onMouseDown={(e)=>{ e.preventDefault(); setOpen(o=>!o); setQ(''); }}>▾</span>}
    </div>
    {conflict ? <div className="ssel-warn">⚠ Also booked {conflict} this week</div> : null}
    {dropdown ? ReactDOM.createPortal(dropdown, document.body) : null}
  </div>;
}

// Shared component used by both the register form and the editor — renders
// a list of (Lesson Type, Package) rows with a "+ Add Lessons" button.
// Already-selected lesson types are filtered out of the dropdown for the
// other rows so the unique(student_id, lesson_type_id) constraint is never
// violated by the UI.
function LessonsEditor({ enrollments, setEnrollments, lessonTypes, packages }){
  function update(idx, field, value){
    const next = enrollments.map((e, i) => i === idx ? { ...e, [field]: value, ...(field === 'lessonTypeId' ? { packageId: '' } : {}) } : e);
    setEnrollments(next);
  }
  function add(){ setEnrollments([...enrollments, { lessonTypeId: '', packageId: '', quantity: 1 }]); }
  function remove(idx){ setEnrollments(enrollments.filter((_, i) => i !== idx)); }
  return <>
    <div className="lessons-rows">
      {enrollments.map((e, i) => {
        const ltPkgs = e.lessonTypeId ? (packages || []).filter(p => p.lesson_type_id === e.lessonTypeId && p.is_active !== false) : [];
        const usedLtIds = enrollments.map((en, j) => j !== i ? en.lessonTypeId : null).filter(Boolean);
        const availableLts = (lessonTypes || []).filter(lt => !usedLtIds.includes(lt.id));
        const qty = Math.max(1, Number(e.quantity) || 1);
        return <div key={i} className="lesson-row">
          <select className="select" value={e.lessonTypeId} onChange={ev => update(i, 'lessonTypeId', ev.target.value)}>
            <option value="">— Lesson Type —</option>
            {availableLts.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
          </select>
          <select className="select" value={e.packageId || ''} onChange={ev => update(i, 'packageId', ev.target.value)} disabled={!e.lessonTypeId}>
            <option value="">{e.lessonTypeId ? '— Package —' : '← pick type first'}</option>
            {ltPkgs.map(p => <option key={p.id} value={p.id}>{p.name}{p.amount != null ? ` · RM${p.amount}` : ''}{billingText(p.billing_mode, p.billing_count) ? ` · ${billingText(p.billing_mode, p.billing_count)}` : ''}</option>)}
          </select>
          <input className="select lesson-row-qty" type="number" min="1" step="1" value={qty} title="Quantity — how many times per cycle (multiplies billing & credits)" onChange={ev => update(i, 'quantity', Math.max(1, parseInt(ev.target.value, 10) || 1))} />
          {enrollments.length > 1 ? <button type="button" className="lesson-row-x" onClick={() => remove(i)} title="Remove this lesson">×</button> : <span className="lesson-row-x-spacer" />}
        </div>;
      })}
    </div>
    <button type="button" className="btn btn-ghost lesson-add-btn" onClick={add}>+ Add Lessons</button>
  </>;
}

function StudentEditor({ row, lessonTypes, packages, onSave, hideAccountSections }){
  const [name, setName] = useState(row.name || '');
  const [dob, setDob] = useState(row.dob || '');
  const [gender, setGender] = useState(row.gender || null);
  const [enrollments, setEnrollments] = useState(
    (row.enrollments && row.enrollments.length)
      ? row.enrollments.map(e => ({ lessonTypeId: e.lessonTypeId || '', packageId: e.packageId || '', quantity: Math.max(1, Number(e.quantity) || 1) }))
      : (row.lessonTypeIds && row.lessonTypeIds.length
          ? row.lessonTypeIds.map((ltId, i) => ({ lessonTypeId: ltId, packageId: i === 0 ? (row.packageId || '') : '', quantity: 1 }))
          : [{ lessonTypeId: '', packageId: '', quantity: 1 }])
  );
  const [guardianName, setGuardianName] = useState(row.guardianName || '');
  const [guardianEmail, setGuardianEmail] = useState(row.guardianEmail || '');
  const [guardianPhone, setGuardianPhone] = useState(row.guardianPhone || '');
  const [sameAsGuardian, setSameAsGuardian] = useState(!!row.emergencySameAsGuardian);
  const [emergencyPhone, setEmergencyPhone] = useState(row.emergencyPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(row.emergencyRelationship || '');
  // Adult-self defaults to true on edits where the swimmer's name matches
  // the guardian name (legacy data import heuristic), but mostly it's
  const [emergencyName, setEmergencyName] = useState(row.emergencyName || '');
  // user-toggled on the +New Account flow.
  const [adultSelf, setAdultSelf] = useState(!!(row.name && row.guardianName && row.name === row.guardianName));
  function handleSameAsGuardian(v){
    setSameAsGuardian(v);
    if(v){
      setEmergencyName(guardianName);
      setEmergencyPhone(guardianPhone);
      setEmergencyRel('Account Holder');
    }
  }
  // Adult-self: account holder name == swimmer name. Pre-fills swimmer
  // name from the (already typed) account holder name when toggled on,
  // and keeps them in sync while the toggle is active.
  function handleAdultSelf(v){
    setAdultSelf(v);
    if(v){
      if(guardianName) setName(guardianName);
      else if(name) setGuardianName(name);
    }
  }
  const computedAge = dob ? ageFromDob(dob) : null;

  return <div className="lesson-edit">
    {/* Account Holder + Emergency Contact (only in +New Account flow) */}
    {!hideAccountSections && <>
      <div className="account-section">
        <div className="account-section-title">Parent / Guardian (Account Holder)</div>
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div className="field"><label>Parent Name</label><input className="input" value={guardianName} onChange={e=>{ setGuardianName(e.target.value); if(adultSelf) setName(e.target.value); if(sameAsGuardian) setEmergencyName(e.target.value); }} onBlur={e=>{ const v=toTitleCase(e.target.value); setGuardianName(v); if(adultSelf) setName(v); if(sameAsGuardian) setEmergencyName(v); }} placeholder="Full name" /></div>
          <div className="field"><label>Email</label><input className="input" type="email" value={guardianEmail} onChange={e=>setGuardianEmail(e.target.value)} placeholder="email@example.com" /></div>
          <div className="field"><label>Phone</label><input className="input" type="tel" value={guardianPhone} onChange={e=>{ setGuardianPhone(e.target.value); if(sameAsGuardian) setEmergencyPhone(e.target.value); }} placeholder="+60 1X-XXXXXXX" /></div>
        </div>
      </div>
      <div className="account-section">
        <div className="account-section-title">Emergency Contact</div>
        <label className="gb-check" style={{marginBottom:7,display:'inline-flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={sameAsGuardian} onChange={e=>handleSameAsGuardian(e.target.checked)} /> Same as account holder above</label>
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
          <div className="field"><label>Emergency Contact Name</label><input className="input" value={sameAsGuardian?guardianName:emergencyName} onChange={e=>setEmergencyName(e.target.value)} onBlur={e=>setEmergencyName(toTitleCase(e.target.value))} disabled={sameAsGuardian} placeholder="Full name" /></div>
          <div className="field"><label>Phone</label><input className="input" type="tel" value={sameAsGuardian?guardianPhone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={sameAsGuardian} placeholder="+60 1X-XXXXXXX" /></div>
          <div className="field"><label>Relationship</label><input className="input" value={sameAsGuardian?'Account Holder':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={sameAsGuardian} placeholder="e.g. Mother, Father, Spouse, Sibling" /></div>
        </div>
      </div>
    </>}

    {/* Swimmer Details — kept simple: name, DOB, gender, then lessons */}
    <div className="student-form-section">
      <div className="student-form-section-title">Swimmer Details</div>
      <div className="form-grid" style={{gridTemplateColumns:'1.3fr 130px 60px auto'}}>
        <div className="field"><label>Name</label><input className="input" value={name} onChange={e=>{ setName(e.target.value); if(adultSelf) setGuardianName(e.target.value); }} onBlur={e=>{ const v=toTitleCase(e.target.value); setName(v); if(adultSelf) setGuardianName(v); }} disabled={adultSelf && !!guardianName} /></div>
        <div className="field"><label>Date of Birth</label><input className="input" type="date" value={dob} max={todayStr()} onChange={e=>setDob(e.target.value)} /></div>
        <div className="field"><label>Age</label><div className={`age-display ${computedAge==null?'is-empty':''}`} aria-label="Auto-calculated age">{ageDisplay(computedAge)}</div></div>
        <div className="field"><label>Gender</label>
          <div className="gender-toggle"><button type="button" className={`gender-opt ${gender==='female'?'active':''}`} onClick={()=>setGender(gender==='female'?null:'female')}>♀ F</button><button type="button" className={`gender-opt ${gender==='male'?'active':''}`} onClick={()=>setGender(gender==='male'?null:'male')}>♂ M</button></div>
        </div>
      </div>
    </div>
    <div className="student-form-section">
      <div className="student-form-section-title">Lessons</div>
      <LessonsEditor enrollments={enrollments} setEnrollments={setEnrollments} lessonTypes={lessonTypes} packages={packages} />
    </div>
    {/* Adult-self toggle — sits within the swimmer-details zone since it
        affects swimmer naming. Hidden in nested mode where the account
        relationship is already established. */}
    {!hideAccountSections && <label className="adult-self-toggle gb-check">
      <input type="checkbox" checked={adultSelf} onChange={e=>handleAdultSelf(e.target.checked)} />
      <span>Adult swimmer — I am my own guardian <span className="subtle small">(pre-fill swimmer name with account holder name)</span></span>
    </label>}

    <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}><button className="btn btn-primary" onClick={()=>{
      const v = name.trim(); if(!v) return;
      // In nested mode (editing a swimmer under an existing account),
      // the patch omits guardian/emergency — those are owned at the
      // account level and propagated separately by ParentContactEditor.
      const patch = { name:v, dateOfBirth: dob || null, gender, enrollments };
      if(!hideAccountSections){
        patch.guardianName = guardianName;
        patch.guardianEmail = guardianEmail;
        patch.guardianPhone = guardianPhone;
        patch.emergencySameAsGuardian = sameAsGuardian;
        patch.emergencyName = sameAsGuardian ? guardianName : emergencyName;
        patch.emergencyPhone = sameAsGuardian ? guardianPhone : emergencyPhone;
        patch.emergencyRelationship = sameAsGuardian ? 'Account Holder' : emergencyRel;
      }
      onSave(patch);
    }}>Save Swimmer</button></div>
  </div>;
}

// ============================================================================
// CreditHistoryPanel — per-swimmer credit ledger. Shows running balance per
// lesson-type, the chronological purchase history beneath, and an inline
// "Add purchase" form. Each purchase row is the authoritative record of
// when credits arrived; the running balance in student_credit_balances is
// the denormalised cache that the schedule reads. Adding a purchase
// bumps the balance; deleting one reverses it.
// ============================================================================
// ============================================================================
// BalanceAdjuster — small inline "Set balance to N" widget. Writes a
// manual credit_purchase for the delta between current and target so the
// running balance moves there cleanly and the adjustment is logged.
// Solves the legacy-balance problem where a directly-seeded
// student_credit_balances row has no purchase or subscription to undo.
// ============================================================================
function BalanceAdjuster({ currentBalance, onApply }){
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState(String(currentBalance));
  function submit(){
    const target = Math.max(0, parseInt(val, 10) || 0);
    if(target === currentBalance){ setOpen(false); return; }
    if(!confirm(`Set balance to ${target}? (Currently ${currentBalance}.)\n\nThis will record a manual adjustment of ${target - currentBalance > 0 ? '+' : ''}${target - currentBalance} credits.`)) return;
    onApply(target, null);
    setOpen(false);
  }
  if(!open){
    return <button className="btn btn-ghost small" title="Manually set balance to a specific value" onClick={()=>{ setVal(String(currentBalance)); setOpen(true); }}>⚖ Adjust</button>;
  }
  return <span className="balance-adjust-form">
    <span className="balance-adjust-label">Set to:</span>
    <input className="input" type="number" min="0" value={val} onChange={e=>setVal(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') submit(); if(e.key==='Escape') setOpen(false); }} style={{width:60,padding:'3px 6px',fontSize:11}} autoFocus />
    <button className="btn btn-primary small" onClick={submit}>Apply</button>
    <button className="btn btn-ghost small" onClick={()=>setOpen(false)}>Cancel</button>
  </span>;
}

function CreditHistoryPanel({ swimmer, lessonTypes, lessonTypeById, purchases, subscriptions, creditByKey, groupById, membersByGroup, addCreditPurchase, deleteCreditPurchase, addSubscription, cancelSubscription, adjustBalanceTo, onClose }){
  // Group context: who is this swimmer's family group, and is it bound?
  // Bound-group members have credit operations locked to the group level
  // (the Family Groups panel handles add/cancel for all members at once).
  const group = swimmer.familyGroupId && groupById ? groupById[swimmer.familyGroupId] : null;
  const isBoundMember = !!(group && group.groupType === 'bound');
  const isUnboundGroupMember = !!(group && group.groupType !== 'bound');
  const swimmerLts = (swimmer.lessonTypeIds || []).map(id => lessonTypeById(id)).filter(Boolean);
  const defaultLtId = swimmerLts[0]?.id || lessonTypes[0]?.id || '';
  const [purchaseDate, setPurchaseDate] = useState(toDateStr(new Date()));
  const [ltId, setLtId] = useState(defaultLtId);
  const [credits, setCredits] = useState(4);
  const [source, setSource] = useState('topup');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Group purchases by lesson type so each LT shows its own ledger.
  const purchasesByLt = {};
  (purchases || []).forEach(p => {
    (purchasesByLt[p.lesson_type_id] = purchasesByLt[p.lesson_type_id] || []).push(p);
  });
  // Sort within each LT by date desc (newest first).
  Object.values(purchasesByLt).forEach(arr => arr.sort((a,b) => (b.purchase_date || '').localeCompare(a.purchase_date || '') || (b.created_at || '').localeCompare(a.created_at || '')));

  // Lesson types to display — all enrolled types, plus any LT that has
  // purchase history but no current enrollment (so historical records
  // don't vanish when a swimmer un-enrolls).
  const displayLtIds = new Set(swimmerLts.map(lt => lt.id));
  Object.keys(purchasesByLt).forEach(id => displayLtIds.add(id));
  const displayLts = [...displayLtIds].map(id => lessonTypeById(id)).filter(Boolean);

  async function submitPurchase(){
    if(!ltId || !credits) return;
    setBusy(true);
    try{
      await addCreditPurchase({
        studentId: swimmer.id,
        lessonTypeId: ltId,
        purchaseDate,
        creditsAdded: Number(credits),
        source,
        notes: notes.trim() || null
      });
      // Reset for the next entry but keep the LT + source so the user
      // can add multiple top-ups quickly.
      setCredits(4);
      setNotes('');
    } finally { setBusy(false); }
  }

  function fmtDate(d){
    if(!d) return '';
    try{ return new Date(d).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' }); } catch(_){ return d; }
  }
  function sourceLabel(s){
    if(s === 'signup') return '🆕 Sign-up';
    if(s === 'topup') return '💳 Top-up';
    if(s === 'gift') return '🎁 Gift';
    if(s === 'manual') return '✏️ Manual';
    if(s === 'refund') return '↩ Refund';
    return s || '—';
  }

  return <div className="credit-panel">
    <div className="credit-panel-head">
      <div>
        <div className="credit-panel-title">💳 Credit ledger · {swimmer.name}</div>
        <div className="credit-panel-sub">Every purchase recorded with its date. The running balance is purchases minus credits consumed by attendance.</div>
      </div>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>

    {/* Add-purchase form */}
    <div className="credit-add-form">
      <div className="credit-add-row">
        <div className="field"><label>Date</label><input className="input" type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)} /></div>
        <div className="field"><label>Lesson Type</label>
          <select className="select" value={ltId} onChange={e=>setLtId(e.target.value)}>
            <option value="">— select —</option>
            {(lessonTypes || []).map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Credits</label><input className="input" type="number" value={credits} onChange={e=>setCredits(e.target.value)} placeholder="4" /></div>
        <div className="field"><label>Source</label>
          <select className="select" value={source} onChange={e=>setSource(e.target.value)}>
            <option value="signup">Sign-up</option>
            <option value="topup">Top-up</option>
            <option value="gift">Gift</option>
            <option value="manual">Manual adjustment</option>
            <option value="refund">Refund</option>
          </select>
        </div>
        <div className="field" style={{flex:'2 1 240px'}}>
          <label>Notes <span className="subtle" style={{textTransform:'none',letterSpacing:0,fontWeight:600}}>· optional</span></label>
          <input className="input" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. cash, receipt #1234" />
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:6,gap:6}}>
        <span className="credit-add-hint">Use negative credits to record a manual deduction (e.g. expiry).</span>
        <button className="btn btn-primary small" onClick={submitPurchase} disabled={busy || !ltId || !Number(credits)}>{busy ? 'Saving…' : '+ Record purchase'}</button>
      </div>
    </div>

    {/* Group context banner */}
    {group ? <div className={`credit-group-banner ${isBoundMember?'credit-group-banner-bound':''}`}>
      {isBoundMember
        ? <>🔗 <strong>{group.name}</strong> · bound group — all subscription changes happen at the group level. Individual purchase records are kept for the audit trail but no manual +/− adjustments are made here.</>
        : <>👪 <strong>{group.name}</strong> · discount group — subscriptions can be added at the group level (adds to all members) and balances can diverge per-swimmer based on attendance.</>}
    </div> : null}

    {/* Per-lesson-type ledgers */}
    {displayLts.length === 0 && <div className="credit-panel-empty">No lesson-type enrolments yet. Add one in Edit, then record a purchase here.</div>}
    {displayLts.map(lt => {
      const bal = creditByKey[`${swimmer.id}:${lt.id}`];
      const list = purchasesByLt[lt.id] || [];
      const totalPurchased = list.reduce((sum,p) => sum + Number(p.credits_added || 0), 0);
      // Subscriptions affecting this swimmer for this LT — either as
      // direct subject (student type) or as member of their family group
      // (group type).
      const subs = (subscriptions || []).filter(s =>
        s.lesson_type_id === lt.id &&
        ((s.subject_type === 'student' && s.subject_id === swimmer.id) ||
         (s.subject_type === 'family_group' && swimmer.familyGroupId && s.subject_id === swimmer.familyGroupId))
      ).slice().sort((a,b) => (b.subscription_date||'').localeCompare(a.subscription_date||''));
      // Subscription-quick-add is shown for individuals and unbound group
      // members (the latter triggers a group-wide subscription). Bound
      // group members must use the Family Groups panel.
      const canQuickSub = !isBoundMember && addSubscription;
      return <div key={lt.id} className="credit-lt-block">
        <div className="credit-lt-head">
          <span className="credit-lt-name" style={{background:lt.bg_color,color:lt.text_color,borderColor:lt.border_color}}>{lt.name}</span>
          <span className="credit-lt-totals">
            {bal
              ? <>
                  <strong className={bal.remaining_balance<=2?'credit-low':''}>{bal.remaining_balance}</strong> credits
                </>
              : <em className="subtle">No balance row yet</em>}
            {list.length > 0 && <span className="credit-lt-aggregate"> · {totalPurchased > 0 ? '+' : ''}{totalPurchased} credits across {list.length} record{list.length===1?'':'s'}</span>}
          </span>
          {/* Manual adjust — direct override that writes a manual purchase
              row for the delta. Use to correct legacy balances that have
              no purchase/subscription record to cancel against. */}
          {adjustBalanceTo && !isBoundMember && <BalanceAdjuster
            currentBalance={bal ? Number(bal.remaining_balance) || 0 : 0}
            onApply={(target, notes) => adjustBalanceTo(swimmer.id, lt.id, target, notes)} />}
        </div>

        {canQuickSub && null /* Quick subscription buttons removed — use Adjust or record via Pending Credits */}

        {subs.length > 0 && <div className="credit-sub-list">
          <div className="credit-sub-list-title">Subscription log</div>
          {subs.map(s => <div key={s.id} className={`credit-sub-row ${s.cancelled_at?'is-cancelled':''}`}>
            <span className="credit-sub-date">{fmtDate(s.subscription_date)}</span>
            <span className="credit-sub-amount">+{s.credits_per_swimmer} × {s.swimmer_count}</span>
            <span className="credit-sub-subject">{s.subject_type === 'family_group' ? `👪 ${group?.name || 'group'}` : '👤 individual'}</span>
            <span className="credit-sub-meta subtle">{s.source}{s.amount_paid != null ? ` · RM${s.amount_paid}` : ''}{s.receipt_number ? ` · ${s.receipt_number}` : ''}</span>
            {s.cancelled_at
              ? <span className="credit-sub-cancelled-tag">Cancelled</span>
              : cancelSubscription ? <button className="btn btn-ghost small" title="Cancel this subscription (reverses credits, keeps the record)" onClick={()=>cancelSubscription(s)}>Cancel</button> : null}
          </div>)}
        </div>}

        {list.length === 0
          ? <div className="credit-empty">No purchases recorded for this lesson type.</div>
          : <table className="credit-ledger">
              <thead><tr><th style={{width:120}}>Date</th><th style={{width:90}}>Credits</th><th style={{width:130}}>Source</th><th>Notes</th><th style={{width:36}}></th></tr></thead>
              <tbody>
                {list.map(p => <tr key={p.id} className={p.subscription_id?'is-from-sub':''}>
                  <td style={{fontWeight:600}}>{fmtDate(p.purchase_date)}</td>
                  <td><span className={`credit-delta ${Number(p.credits_added) < 0 ? 'credit-delta-neg' : 'credit-delta-pos'}`}>{Number(p.credits_added) > 0 ? '+' : ''}{p.credits_added}</span></td>
                  <td>{sourceLabel(p.source)}</td>
                  <td className="subtle">{p.notes || '—'}</td>
                  <td>{!isBoundMember && <button className="btn btn-danger small" title="Delete this purchase record" onClick={()=>deleteCreditPurchase(p)}>×</button>}</td>
                </tr>)}
              </tbody>
            </table>
        }
      </div>;
    })}
  </div>;
}

// ============================================================================
// ReceiptsView — consolidated subscription / receipt log. Lists every
// subscription in date order with filters by status (active / cancelled /
// all), with a one-click cancel and a printable receipt per row.
// ============================================================================
// ============================================================================
// Swimmer accent palette — six tasteful pastel-derived colours that cycle
// per swimmer-index inside an account. Lets the user visually scan "this
// is Lee Wei's row vs Lee Mei's row" without reading the name. Each
// entry pairs a saturated accent (used for the left-bar + name colour)
// with a darker text tone for the swimmer name. Hand-picked to fit the
// app's existing lesson-type palette DNA.
// ============================================================================
const SWIMMER_ACCENTS = [
  { accent:'#06B6D4', text:'#0E7490' },   // cyan
  { accent:'#8B5CF6', text:'#5B21B6' },   // violet
  { accent:'#F43F5E', text:'#9F1239' },   // rose
  { accent:'#F59E0B', text:'#92400E' },   // amber
  { accent:'#10B981', text:'#065F46' },   // emerald
  { accent:'#3B82F6', text:'#1E40AF' }    // blue
];
function swimmerAccent(idx){ return SWIMMER_ACCENTS[idx % SWIMMER_ACCENTS.length]; }

// ============================================================================
// ParentsView — the de facto administration page. Every operation that
// concerns a parent or their child(ren) happens here:
//   • Create a new parent (which seeds them with their first swimmer)
//   • Edit parent contact (propagates to all children's guardian fields)
//   • Add / edit / delete swimmers under a parent (full StudentEditor)
//   • Create or assign bound/discount family groups for a parent's kids
//   • Credit management: quick subscription buttons, balance adjustment,
//     subscription log, ledger
// The Swimmers page is intentionally read-only — use this page to admin.
// ============================================================================
// ── BranchFilterPills ────────────────────────────────────────────────────────
// Reusable branch filter row used by Accounts, Invoices, Receipts, Pending Credits.
// value=null means "All branches". onChange receives null or a branch.id string.
function BranchFilterPills({ branches, value, onChange }){
  if(!branches || branches.length < 2) return null;
  const active = branches.filter(b => b.is_active !== false);
  if(!active.length) return null;
  return <div style={{display:'flex',gap:4,flexWrap:'wrap',alignItems:'center'}}>
    <span className="small subtle" style={{marginRight:2}}>Branch:</span>
    <button
      className={`sub-tab${!value ? ' active' : ''}`}
      style={{padding:'3px 10px',fontSize:11,height:26}}
      onClick={()=>onChange(null)}>All</button>
    {active.map(b => <button
      key={b.id}
      className={`sub-tab${value===b.id ? ' active' : ''}`}
      style={{padding:'3px 10px',fontSize:11,height:26,
        ...(value===b.id && b.color ? {background:b.color,borderColor:b.color,color:'#fff'} : {})}}
      onClick={()=>onChange(value===b.id ? null : b.id)}>
      {b.code || b.name}
    </button>)}
  </div>;
}

function ParentsView({ accountSection, setAccountSection, branches, parentGroups, lessonTypes, lessonTypeById, packages, packageById, products, familyGroups, groupById, membersByGroup, creditByKey, subscriptions, addStudent, updateStudent, deleteStudent, deleteAccount, addGroup, updateGroup, deleteGroup, setStudentGroup, addStudentToGroup, removeStudentFromGroup, groupIdsByStudent, addSubscription, cancelSubscription, adjustBalanceTo, scheduleByStudent, sessions, poolById, selectedWeekStart, createInvoice, setAdminSection, onJumpToSession, setView, externalSearchQ }){
  // ── Sub-view driven by external accountSection prop (from nav dropdown) ──
  const adminView = accountSection || 'accounts';
  const setAdminView = (v) => { if(setAccountSection) setAccountSection(v); };
  // Search comes from the sticky sub-bar when provided; falls back to internal state
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [statusFilter, setStatusFilter] = useState('active');
  const [expandedKey, setExpandedKey] = useState(null);
  const [contactEditKey, setContactEditKey] = useState(null);
  const [addingSwimmerFor, setAddingSwimmerFor] = useState(null);
  const [editingSwimmerId, setEditingSwimmerId] = useState(null);
  const [groupPanelKey, setGroupPanelKey] = useState(null);
  const [billingKey, setBillingKey] = useState(null);
  const [selectedAccountKeys, setSelectedAccountKeys] = useState(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  // ── Account printout ────────────────────────────────────────────────
  // Opens a popup with a clean, parent-friendly summary: account holder,
  // family groups, each swimmer's lesson types + packages, and their
  // scheduled class sessions for the viewed week.
  function printAccountSummary(pg){
    const wb = weekBounds(selectedWeekStart || todayStr());
    const weekLabel = `${wb.start.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})} – ${wb.end.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})}`;
    const groupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))].map(gid => groupById?.[gid]).filter(Boolean);
    const groupsHtml = groupsInPlay.length ? groupsInPlay.map(g => {
      const pkg = g.packageId ? packageById?.(g.packageId) : null;
      const lt = pkg?.lesson_type_id ? lessonTypeById?.(pkg.lesson_type_id) : null;
      const members = (membersByGroup?.[g.id] || []).map(m => m.name).join(', ');
      return '<div style="margin-top:4px;font-size:10.5pt">' +
        (g.groupType === 'bound' ? '🔗' : '👪') + ' <strong>' + g.name + '</strong>' +
        (lt && pkg ? ' · ' + lt.name + ' · ' + pkg.name : '') +
        '<div style="font-size:10pt;color:#555;margin-left:18px">Members: ' + (members || 'None') + '</div></div>';
    }).join('') : '<div style="font-size:10pt;color:#999">No family groups</div>';
    const swimmerSections = pg.swimmers.map(sw => {
      const enrolments = sw.enrollments || [];
      // Build per-swimmer schedule from sessions directly (scheduleByStudent
      // doesn't carry weekStartDate or instructor/pool context).
      const weekSessions = (sessions || []).filter(s => s.weekStartDate === (selectedWeekStart || ''));
      const swSessions = weekSessions.filter(s => (s.students || []).some(st => st.studentId === sw.id));
      const slotsByLt = {};
      swSessions.forEach(s => { const k = s.lessonTypeId || '_'; (slotsByLt[k] = slotsByLt[k] || []).push(s); });
      const enrolHtml = enrolments.map(e => {
        const lt = lessonTypeById?.(e.lessonTypeId);
        const pkg = packageById?.(e.packageId);
        const ltSlots = (slotsByLt[e.lessonTypeId] || []).slice().sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
        const slotLines = ltSlots.map(sl => {
          const pool = sl.poolId && poolById ? poolById(sl.poolId) : null;
          const inst = (sl.instructors && sl.instructors[0] && sl.instructors[0].name) || sl.legacyInstructor || '';
          return '<div style="margin-left:22px;font-size:10pt;color:#333">' +
            DAYS_F[sl.day] + ' ' + minuteToTime(sl.startMinute) + '–' + minuteToTime(sl.startMinute + sl.durationMinutes) +
            (pool ? ' · ' + pool.name : '') +
            (inst ? ' · ' + inst : '') +
            '</div>';
        }).join('');
        return '<div style="margin-top:6px"><div style="font-size:10.5pt;font-weight:600">' +
          (lt?.name || 'Lesson') + ' · ' + (pkg?.name || 'Package') +
          '</div>' + (slotLines || '<div style="margin-left:22px;font-size:10pt;color:#999">No sessions this week</div>') + '</div>';
      }).join('');
      return '<div style="margin-top:14px;padding:10px 12px;border:1px solid #ccc;border-radius:6px">' +
        '<div style="font-size:12pt;font-weight:700">' + sw.name +
        (sw.age != null ? ' · ' + sw.age + 'y' : '') +
        (sw.gender ? ' · ' + (sw.gender === 'male' ? 'M' : sw.gender === 'female' ? 'F' : sw.gender) : '') + '</div>' +
        (enrolHtml || '<div style="font-size:10pt;color:#999;margin-top:4px">No enrolments</div>') + '</div>';
    }).join('');
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Account Summary – ' + pg.name + '</title>' +
      '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;padding:24px 28px;max-width:720px;margin:0 auto}' +
      '@page{size:A4 portrait;margin:20mm 16mm}@media print{body{padding:0}}' +
      '.hdr{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}' +
      '.hdr h1{font-size:16pt;font-weight:800;letter-spacing:-.3px}' +
      '.hdr-meta{font-size:10.5pt;color:#444;margin-top:3px}' +
      '.section{margin-top:16px}.section-title{font-size:11pt;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#666;border-bottom:1px solid #ddd;padding-bottom:3px;margin-bottom:6px}</style>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>' +
      '</head><body>' +
      '<div class="hdr"><h1>' + pg.name + '</h1>' +
      '<div class="hdr-meta">' + [pg.email, pg.phone].filter(Boolean).join(' · ') + '</div>' +
      '<div class="hdr-meta" style="margin-top:2px">Week: ' + weekLabel + '</div></div>' +
      '<div class="section"><div class="section-title">Family Groups</div>' + groupsHtml + '</div>' +
      '<div class="section"><div class="section-title">Swimmers & Schedule</div>' + swimmerSections + '</div>' +
      '<div style="margin-top:24px;font-size:9pt;color:#999;border-top:1px solid #ddd;padding-top:8px">Generated ' + new Date().toLocaleDateString(undefined,{dateStyle:'long'}) + ' · Star Swim Sdn Bhd</div>' +
      '</body></html>';
    const w = window.open('', '_blank');
    if(w){ w.document.write(html); w.document.close(); }
  }

  const filtered = (parentGroups || [])
    .filter(pg => {
      if(statusFilter === 'active' && !pg.isActive) return false;
      if(statusFilter === 'archived' && pg.isActive) return false;
      return true;
    })
    .filter(pg => {
      if(!searchQ.trim()) return true;
      const q = searchQ.toLowerCase();
      if((pg.name || '').toLowerCase().includes(q)) return true;
      if((pg.email || '').toLowerCase().includes(q)) return true;
      if((pg.phone || '').toLowerCase().includes(q)) return true;
      return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
    });

  // Cross-filter hits: accounts matching the search query that live in the
  // OTHER status bucket — visible only when a specific filter is active and
  // the search returns no results (or fewer results) from the current view.
  function matchesSearch(pg){
    if(!searchQ.trim()) return false;
    const q = searchQ.toLowerCase();
    if((pg.name || '').toLowerCase().includes(q)) return true;
    if((pg.email || '').toLowerCase().includes(q)) return true;
    if((pg.phone || '').toLowerCase().includes(q)) return true;
    return pg.swimmers.some(s => (s.name || '').toLowerCase().includes(q));
  }
  const archiveHits = searchQ.trim() && statusFilter === 'active'
    ? (parentGroups || []).filter(pg => !pg.isActive && matchesSearch(pg))
    : [];
  const activeHits = searchQ.trim() && statusFilter === 'archived'
    ? (parentGroups || []).filter(pg => pg.isActive && matchesSearch(pg))
    : [];
  const activeCount = (parentGroups || []).filter(p => p.isActive).length;
  const archivedCount = (parentGroups || []).filter(p => !p.isActive).length;
  const totalSwimmers = (parentGroups || []).reduce((sum, p) => sum + p.swimmers.length, 0);
  const totalActiveCredits = Object.values(creditByKey || {}).reduce((sum, b) => sum + (Number(b.remaining_balance) || 0), 0);

  // Propagate parent-level contact + emergency edits to every child's
  // guardian_*/emergency_* fields so the account is the single source of
  // truth for who to call.
  async function saveParentContact(pg, patch){
    for(const s of pg.swimmers){
      await updateStudent(s.id, {
        guardianName: patch.guardianName,
        guardianEmail: patch.guardianEmail,
        guardianPhone: patch.guardianPhone,
        emergencyName: patch.emergencySameAsGuardian ? patch.guardianName : patch.emergencyName,
        emergencyPhone: patch.emergencySameAsGuardian ? patch.guardianPhone : patch.emergencyPhone,
        emergencyRelationship: patch.emergencySameAsGuardian ? 'Account Holder' : patch.emergencyRelationship,
        emergencySameAsGuardian: !!patch.emergencySameAsGuardian
      });
    }
    setContactEditKey(null);
  }

  // Archive/restore parent — flips is_active on every child. Status is
  // derived (any active swimmer ⇒ active parent), so toggling all of
  // them together keeps the derived state coherent.
  async function setParentArchived(pg, archived){
    const verb = archived ? 'archive' : 'restore';
    if(!confirm(`${archived ? 'Archive' : 'Restore'} parent "${pg.name}" and all ${pg.swimmers.length} of their swimmer${pg.swimmers.length===1?'':'s'}?`)) return;
    for(const s of pg.swimmers){
      await updateStudent(s.id, { isActive: !archived });
    }
  }

  // deleteAccount is passed as a prop from App scope

  return <>
    {adminView === 'familyGroups' && <FamilyGroupsAdminView
      familyGroups={familyGroups}
      membersByGroup={membersByGroup}
      lessonTypes={lessonTypes}
      lessonTypeById={lessonTypeById}
      packages={packages}
      packageById={packageById}
      deleteGroup={deleteGroup}
      updateGroup={updateGroup}
      externalSearchQ={externalSearchQ}
    />}

    {adminView === 'accounts' && <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>👤 Accounts — Administration</div>
          <div className="small subtle" style={{marginTop:3}}>An account is either a parent registering one or more children, or an adult swimmer registering themselves. Click an account to expand, then edit contact, add or edit swimmers, manage family groups, and adjust credits.</div>
        </div>
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div><div className="small subtle">Accounts</div><div style={{fontSize:22,fontWeight:800,color:'var(--primary)'}}>{(parentGroups||[]).length}</div></div>
          <div><div className="small subtle">Swimmers</div><div style={{fontSize:22,fontWeight:800,color:'var(--text)'}}>{totalSwimmers}</div></div>
          <div><div className="small subtle">Active credits</div><div style={{fontSize:22,fontWeight:800,color:'var(--teal)'}}>{totalActiveCredits}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:12,color:'var(--text-2)',userSelect:'none'}}>
          <input type="checkbox"
            checked={selectedAccountKeys.size === filtered.length && filtered.length > 0}
            ref={el=>{ if(el) el.indeterminate = selectedAccountKeys.size>0 && selectedAccountKeys.size<filtered.length; }}
            onChange={()=>{
              if(selectedAccountKeys.size === filtered.length) setSelectedAccountKeys(new Set());
              else setSelectedAccountKeys(new Set(filtered.map(p=>p.key)));
            }}
          /> Select all
        </label>
        <input className="input" style={{flex:1,minWidth:200,maxWidth:420,display:'none'}} placeholder="Search by account name, email, phone, or swimmer name…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
        <div className="tabs" style={{gap:2,padding:2}}>
          <button className={`tab ${statusFilter==='active'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('active')}>Active ({activeCount})</button>
          <button className={`tab ${statusFilter==='archived'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('archived')}>Archived ({archivedCount})</button>
          <button className={`tab ${statusFilter==='all'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter('all')}>All</button>
        </div>
      </div>
      {selectedAccountKeys.size > 0 && <div className="inv-bulk-bar" style={{marginTop:8}}>
        <span style={{fontWeight:700,fontSize:13}}>{selectedAccountKeys.size} account{selectedAccountKeys.size>1?'s':''} selected</span>
        <button className="btn btn-primary small" disabled={batchBusy} onClick={async ()=>{
          if(!confirm(`Generate invoices for the ${selectedAccountKeys.size} selected account(s)?\n\nEach invoice will be pre-populated with the same line items shown in Billing Preview. Accounts with no billable items will produce a RM 0.00 draft.`)) return;
          setBatchBusy(true);
          let created=0;
          for(const key of selectedAccountKeys){
            const pg = (parentGroups||[]).find(p=>p.key===key);
            if(!pg) continue;
            // Compute billing lines via the same helper BillingPreviewPanel uses
            const { allItems } = computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes);
            await createInvoice({
              accountName:pg.name, accountEmail:pg.email, accountPhone:pg.phone,
              lines:allItems,
              notes:'Batch generated', dueDate:null
            });
            created++;
          }
          setBatchBusy(false);
          setSelectedAccountKeys(new Set());
          setAccountSection('invoices'); setView('accounts');
        }}>{batchBusy ? 'Generating…' : `🧾 Generate ${selectedAccountKeys.size} Invoice${selectedAccountKeys.size>1?'s':''}`}</button>
        <button className="btn btn-ghost small" onClick={()=>setSelectedAccountKeys(new Set())}>Clear</button>
      </div>}
    </div>{/* end header card */}

    {/* Cross-filter notice */}
    {archiveHits.length > 0 && <div className="cross-filter-notice">
      <span>🗄 {archiveHits.length} {archiveHits.length === 1 ? 'result' : 'results'} found in <strong>Archives</strong>{archiveHits.length === 1 ? `: ${archiveHits[0].name}` : ': ' + archiveHits.map(p => p.name).join(', ')}</span>
      <button className="btn btn-ghost small" onClick={()=>{ setStatusFilter('archived'); if(archiveHits.length === 1) setExpandedKey(archiveHits[0].key); }}>
        {archiveHits.length === 1 ? 'Go to account →' : 'Switch to Archives →'}
      </button>
    </div>}
    {activeHits.length > 0 && <div className="cross-filter-notice">
      <span>👤 {activeHits.length} {activeHits.length === 1 ? 'result' : 'results'} found in <strong>Active accounts</strong>{activeHits.length === 1 ? `: ${activeHits[0].name}` : ': ' + activeHits.map(p => p.name).join(', ')}</span>
      <button className="btn btn-ghost small" onClick={()=>{ setStatusFilter('active'); if(activeHits.length === 1) setExpandedKey(activeHits[0].key); }}>
        {activeHits.length === 1 ? 'Go to account →' : 'Switch to Active →'}
      </button>
    </div>}

    {filtered.length === 0 && <div className="card empty" style={{padding:30}}>No accounts match.</div>}

    {filtered.map(pg => {
      const isExpanded = expandedKey === pg.key;
      const isEditingContact = contactEditKey === pg.key;
      const isAddingSwimmer = addingSwimmerFor === pg.key;
      const isManagingGroup = groupPanelKey === pg.key;
      const swimmerCount = pg.swimmers.length;
      const parentActiveCredits = pg.swimmers.reduce((sum, s) => {
        return sum + (s.lessonTypeIds || []).reduce((s2, ltId) => {
          const b = creditByKey[`${s.id}:${ltId}`];
          return s2 + (b ? Number(b.remaining_balance) || 0 : 0);
        }, 0);
      }, 0);
      const parentSubs = (subscriptions || []).filter(s => {
        if(s.subject_type === 'student' && pg.swimmers.some(sw => sw.id === s.subject_id)) return true;
        if(s.subject_type === 'family_group' && pg.swimmers.some(sw => (sw.familyGroupIds || []).includes(s.subject_id))) return true;
        return false;
      });
      // Distinct family groups that involve this parent's swimmers.
      const parentGroupsInPlay = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))]
        .map(gid => groupById?.[gid]).filter(Boolean);

      // Session indicator: true when at least one swimmer from this account
      // appears in any session scheduled for the currently-viewed week.
      const swimmerIdSet = new Set(pg.swimmers.map(s => s.id));
      const hasActiveSessions = (sessions || []).some(s =>
        s.weekStartDate === selectedWeekStart &&
        (s.students || []).some(st => st.studentId && swimmerIdSet.has(st.studentId))
      );

      return <div key={pg.key} className={`parent-card ${!pg.isActive?'is-archived':''}`}>
        <div className="parent-head" onClick={(e)=>{ if(e.target.closest('button,input,select')) return; setExpandedKey(isExpanded?null:pg.key); }}>
          <label style={{flexShrink:0,display:'flex',alignItems:'center'}} onClick={e=>e.stopPropagation()}>
            <input type="checkbox"
              checked={selectedAccountKeys.has(pg.key)}
              onChange={()=>{ const s=new Set(selectedAccountKeys); s.has(pg.key)?s.delete(pg.key):s.add(pg.key); setSelectedAccountKeys(s); }}
            />
          </label>
          <div className="parent-head-main">
            <div className="parent-name">
              {hasActiveSessions && <span className="acct-session-dot" title={`One or more swimmers in this account have sessions scheduled in the week of ${selectedWeekStart}`} />}
              {pg.name}
              {pg.displayCode && <span className="acct-display-code" title="Unique account ID">{pg.displayCode}</span>}
              {!pg.isActive && <span className="parent-archived-badge" title="All swimmers under this parent are archived">📦 Archived</span>}
            </div>
            <div className="parent-contact subtle small">
              {pg.email ? <span>📧 {pg.email}</span> : null}
              {pg.email && pg.phone ? <span> · </span> : null}
              {pg.phone ? <span>📞 {pg.phone}</span> : null}
              {!pg.email && !pg.phone ? <span>(no contact recorded)</span> : null}
              {pg.ic  ? <span className="parent-ic-tin"> · 🪪 {pg.ic}</span>  : null}
              {pg.tin ? <span className="parent-ic-tin"> · 🧾 TIN {pg.tin}</span> : null}
              {(pg.emergencyName || pg.emergencyPhone) && !pg.emergencySameAsGuardian ? <span> · 🚨 {pg.emergencyName || pg.emergencyPhone}{pg.emergencyName && pg.emergencyPhone ? ` ${pg.emergencyPhone}` : ''}{pg.emergencyRelationship ? ` (${pg.emergencyRelationship})` : ''}</span> : null}
              {parentGroupsInPlay.length > 0 && <span> · {parentGroupsInPlay.map(g => {
                const gp = g.packageId && packageById ? packageById(g.packageId) : null;
                return <span key={g.id} className="parent-group-tag" title={gp ? `${gp.name} package` : undefined}>{g.groupType==='bound'?'🔗':'👪'} {g.name}{gp ? ` · ${gp.name}` : ''}</span>;
              })}</span>}
            </div>
          </div>
          <div className="parent-head-stats">
            <span className="parent-stat"><strong>{swimmerCount}</strong> swimmer{swimmerCount===1?'':'s'}</span>
            <span className="parent-stat"><strong className={parentActiveCredits<=2?'credit-low':''}>{parentActiveCredits}</strong> credits total</span>
            {parentSubs.length > 0 && <span className="parent-stat subtle">{parentSubs.length} sub{parentSubs.length===1?'':'s'}</span>}
            {pg.key !== '__unassigned__' && <button
              className={`btn small parent-archive-btn ${pg.isActive ? 'btn-ghost' : 'btn-primary'}`}
              title={pg.isActive ? 'Archive this account and all its swimmers' : 'Restore this account'}
              onClick={(e)=>{ e.stopPropagation(); setParentArchived(pg, pg.isActive); }}>
              {pg.isActive ? '📦' : '↩ Restore'}
            </button>}
            <span className="parent-chev">{isExpanded ? '▴' : '▾'}</span>
          </div>
        </div>
        {isExpanded && <div className="parent-body">
          {/* Parent-level admin toolbar */}
          {pg.key !== '__unassigned__' && <div className="parent-admin-toolbar">
            <button className="btn btn-ghost small" onClick={()=>setContactEditKey(isEditingContact?null:pg.key)} style={isEditingContact?{background:'#EAB308',color:'#000',border:'1px solid #CA8A04'}:{}}>{isEditingContact?'✕ Close Edit':'✎ Edit Contact'}</button>
            <button className="btn btn-ghost small" onClick={()=>setAddingSwimmerFor(isAddingSwimmer?null:pg.key)}>{isAddingSwimmer?'Close':'+ Add Swimmer'}</button>
            {swimmerCount >= 2 && <button className="btn btn-ghost small" onClick={()=>setGroupPanelKey(isManagingGroup?null:pg.key)}>{isManagingGroup?'Close':'👪 Manage Group'}</button>}
            {/* 💳 Record Purchase removed — billing is now driven from
                🧾 Billing Preview which shows the actual amounts owed and
                records payment against precise line items. The legacy
                Record Purchase form was free-form and let staff record
                purchases that didn't match the swimmers' actual
                enrolments, leading to inconsistencies. */}
            <button className="btn btn-ghost small" onClick={()=>setBillingKey(billingKey===pg.key?null:pg.key)} title="Preview what this account would be billed based on current enrolments + family groups" style={billingKey===pg.key?{background:'#F97316',color:'#fff',border:'1px solid #EA580C'}:{}}>{billingKey===pg.key?'✕ Close Preview':'🧾 Billing Preview'}</button>
            <button className="btn btn-print small" onClick={()=>printAccountSummary(pg)} title="Print account summary with groups, enrolments, and class schedule">🖨 Print</button>
            <div style={{marginLeft:'auto',display:'flex',gap:6}}>
              <button className={`btn small ${pg.isActive?'btn-ghost':'btn-primary'}`} onClick={()=>setParentArchived(pg, pg.isActive)} title={pg.isActive ? 'Archive this parent and all their swimmers' : 'Restore this parent and all their swimmers'}>
                {pg.isActive ? '📦 Archive' : '✓ Restore'}
              </button>
              <button className="btn btn-danger small" onClick={(e)=>{ e.stopPropagation(); deleteAccount(pg); }} title="Permanently delete this account and all its swimmers from the database">
                🗑 Delete Account
              </button>
            </div>
          </div>}

          {/* T&C is an ACCOUNT-LEVEL status. Once any swimmer in this
              account has accepted, the whole account is covered — new
              swimmers added under it inherit the same acceptance. The
              intake form enforces T&C as a hard requirement for new
              accounts. Legacy accounts were backfilled. */}
          {pg.key !== '__unassigned__' && (() => {
            const accepted = pg.swimmers.find(sw => sw.tcAcceptedAt);
            return <div className="account-tc-summary">
              <span className="account-tc-label">Terms &amp; Conditions:</span>
              {accepted
                ? <span className="account-tc-badge tc-ok" title={`Accepted ${new Date(accepted.tcAcceptedAt).toLocaleDateString()} · ID ${accepted.tcAcceptanceId} · covers all swimmers in this account`}>✅ Accepted · {new Date(accepted.tcAcceptedAt).toLocaleDateString(undefined,{dateStyle:'medium'})}</span>
                : <span className="account-tc-badge tc-pending" title="No swimmer in this account has T&C acceptance recorded">⚠ Pending</span>}
            </div>;
          })()}

          {/* Billing preview — forward-looking invoice based on current
              enrolments + family group memberships. The user uses this to
              verify the billing logic is computing the right total. */}
          {billingKey === pg.key && <BillingPreviewPanel
            pg={pg}
            lessonTypes={lessonTypes}
            lessonTypeById={lessonTypeById}
            packages={packages}
            packageById={packageById}
            products={products}
            groupById={groupById}
            membersByGroup={membersByGroup}
            subscriptions={subscriptions}
            addSubscription={addSubscription}
            onClose={()=>setBillingKey(null)}
            onGenerateInvoice={async (lines, meta) => {
              const id = await createInvoice({ accountName:pg.name, accountEmail:pg.email, accountPhone:pg.phone, lines, ...meta });
              if(id){ setBillingKey(null); setAccountSection('invoices'); setView('accounts'); }
            }}
          />}

          {/* Contact editor */}
          {isEditingContact && <ParentContactEditor pg={pg} onSave={(patch)=>saveParentContact(pg, patch)} onCancel={()=>setContactEditKey(null)} />}

          {/* New-swimmer editor (account holder already known, so hide
              account/guardian/emergency sections — those propagate from
              the parent record automatically). */}
          {isAddingSwimmer && <div className="parent-add-swimmer">
            <div className="parent-sub-log-title">+ New swimmer under {pg.name}</div>
            <StudentEditor
              row={{ guardianName:pg.name, guardianEmail:pg.email, guardianPhone:pg.phone, emergencyName:pg.emergencyName, emergencyPhone:pg.emergencyPhone, emergencyRelationship:pg.emergencyRelationship, emergencySameAsGuardian:pg.emergencySameAsGuardian }}
              lessonTypes={lessonTypes} packages={packages}
              hideAccountSections={true}
              onSave={async (patch)=>{
                // New swimmer inherits the account's T&C acceptance: the
                // account holder already agreed to terms when the account
                // was opened (or via legacy backfill), and that consent
                // covers every swimmer under them.
                const accountTcSwimmer = pg.swimmers.find(s => s.tcAcceptedAt);
                await addStudent({
                  ...patch,
                  guardianName: pg.name,
                  guardianEmail: pg.email,
                  guardianPhone: pg.phone,
                  emergencyName: pg.emergencyName,
                  emergencyPhone: pg.emergencyPhone,
                  emergencyRelationship: pg.emergencyRelationship,
                  emergencySameAsGuardian: pg.emergencySameAsGuardian,
                  // Inherit account_id so the new swimmer stays in this account
                  accountId: pg.accountId || pg.swimmers[0]?.accountId || null,
                  // Inherit T&C from the account so the new swimmer is covered immediately
                  tcAcceptedAt: accountTcSwimmer?.tcAcceptedAt || null,
                  tcAcceptanceId: accountTcSwimmer?.tcAcceptanceId || null
                });
                setAddingSwimmerFor(null);
              }}
            />
          </div>}

          {/* Group management panel — package-driven creation flow */}
          {isManagingGroup && <ParentGroupManager
            pg={pg}
            familyGroups={familyGroups}
            groupById={groupById}
            membersByGroup={membersByGroup}
            groupIdsByStudent={groupIdsByStudent}
            lessonTypes={lessonTypes}
            packages={packages}
            packageById={packageById}
            addGroup={addGroup}
            updateGroup={updateGroup}
            deleteGroup={deleteGroup}
            setStudentGroup={setStudentGroup}
            addStudentToGroup={addStudentToGroup}
            removeStudentFromGroup={removeStudentFromGroup}
            onClose={()=>setGroupPanelKey(null)}
          />}

          {/* Swimmers */}
          {pg.swimmers.map((sw, swi) => {
            const grp = sw.familyGroupId && groupById ? groupById[sw.familyGroupId] : null;
            const isBound = !!(grp && grp.groupType === 'bound');
            const isEditingSwimmer = editingSwimmerId === sw.id;
            const acc = swimmerAccent(swi);
            return <div key={sw.id} className="parent-swimmer-section" style={{borderLeftColor:acc.accent}}>
              <div className="parent-swimmer-head">
                <div className="parent-swimmer-name">
                  <span style={{color:acc.accent,fontSize:14}}>●</span> <strong style={{color:acc.text}}>{sw.name}</strong>
                  {pg.displayCode && <span className="swimmer-display-code">{pg.displayCode}-{pg.swimmers.indexOf(sw)+1}</span>}
                  {sw.age != null ? <span className="subtle"> · {sw.age}y</span> : null}
                  {sw.gender ? <span className="subtle"> · {sw.gender==='female'?'♀':'♂'}</span> : null}
                  {grp ? <span className="subtle"> · {isBound ? '🔗' : '👪'} {grp.name}</span> : null}
                </div>
                <div className="parent-swimmer-actions">
                  <button className="btn btn-ghost small" onClick={()=>setEditingSwimmerId(isEditingSwimmer?null:sw.id)} style={isEditingSwimmer?{background:'#EAB308',color:'#000',border:'1px solid #CA8A04'}:{}}>{isEditingSwimmer?'✕ Close':'✎ Edit'}</button>
                  <button className="btn btn-danger small" onClick={()=>deleteStudent(sw)}>Del</button>
                </div>
              </div>

              {/* Inline swimmer editor — account/guardian/emergency are
                  hidden because those are owned at the account level. */}
              {isEditingSwimmer && <div style={{margin:'8px 0'}}><StudentEditor
                row={sw} lessonTypes={lessonTypes} packages={packages}
                hideAccountSections={true}
                onSave={async (patch)=>{ await updateStudent(sw.id, patch); setEditingSwimmerId(null); }}
              /></div>}

              {(sw.lessonTypeIds || []).length === 0
                ? <div className="parent-swimmer-empty subtle small">No lesson type enrolments yet — click ✎ Edit to add one.</div>
                : <table className="lt-mini-table">
                    <thead>
                      <tr>
                        <th>Lesson Type</th>
                        <th>Package</th>
                        <th>Scheduled Session</th>
                        <th>Credits</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(sw.lessonTypeIds || []).map(ltId => {
                        const lt = lessonTypeById ? lessonTypeById(ltId) : null;
                        if(!lt) return null;
                        const bal = creditByKey[`${sw.id}:${ltId}`];
                        const remaining = bal ? Number(bal.remaining_balance) || 0 : 0;
                        const initial = bal ? Number(bal.initial_balance) || 0 : 0;
                        const enrol = (sw.enrollments || []).find(e => e.lessonTypeId === ltId);
                        const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
                        const ltSessions = (sessions || []).filter(s =>
                          s.weekStartDate === selectedWeekStart &&
                          s.type === lt.name &&
                          (s.students || []).some(st => st.studentId === sw.id)
                        ).sort((a,b) => a.day - b.day || a.startMinute - b.startMinute);
                        const schedLabel = ltSessions.length
                          ? ltSessions.map(s => `${DAYS_F[s.day].slice(0,3)} ${shortTime(s.startMinute)}`).join(', ')
                          : null;
                        const quickAddSub = (n) => addSubscription({
                          subjectType: (grp && grp.groupType !== 'bound') ? 'family_group' : 'student',
                          subjectId: (grp && grp.groupType !== 'bound') ? grp.id : sw.id,
                          lessonTypeId: ltId, creditsPerSwimmer: n, quantity: 1,
                          source: 'subscription', notes: `Quick +${n} (accounts panel)`
                        });
                        return <tr key={ltId}>
                          <td><span className="lt-chip" style={{background:lt.bg_color,color:lt.text_color,borderColor:lt.border_color}}>{lt.name}</span></td>
                          <td className="col-pkg">{pkg ? pkg.name : <em className="subtle">—</em>}</td>
                          <td className={`col-session${schedLabel?'':' no-sched'}`}>
                            {ltSessions.length
                              ? ltSessions.map((s, si) => <span
                                  key={s.id}
                                  className="session-jump-link"
                                  title="Click to open this session in the Weekly View"
                                  onClick={() => onJumpToSession && onJumpToSession(s)}>
                                  {si > 0 ? ', ' : ''}{DAYS_F[s.day].slice(0,3)} {shortTime(s.startMinute)}
                                </span>)
                              : 'Not scheduled'}
                          </td>
                          <td className="col-credits">
                            {bal
                              ? <strong className={remaining<=2?'credit-low':''}>{remaining} cr</strong>
                              : <em className="subtle">—</em>}
                          </td>
                          <td className="col-actions">
                            {!isBound && adjustBalanceTo
                              ? <BalanceAdjuster currentBalance={remaining} onApply={(target, notes) => adjustBalanceTo(sw.id, ltId, target, notes)} />
                              : isBound ? <span className="subtle small">🔗 group</span> : null}
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table>
              }
            </div>;
          })}

          {/* Subscription log for this parent */}
          {parentSubs.length > 0 && <div className="parent-sub-log">
            <div className="parent-sub-log-title">Subscription log ({parentSubs.length})</div>
            <div className="parent-sub-log-list">
              {parentSubs.slice().sort((a,b)=>(b.subscription_date||'').localeCompare(a.subscription_date||'')).map(s => {
                const lt = lessonTypeById ? lessonTypeById(s.lesson_type_id) : null;
                return <div key={s.id} className={`credit-sub-row ${s.cancelled_at?'is-cancelled':''}`}>
                  <span className="credit-sub-date">{s.subscription_date}</span>
                  <span className="credit-sub-amount">+{s.credits_per_swimmer} × {s.swimmer_count}</span>
                  <span className="credit-sub-subject">{lt?.name || '—'}</span>
                  <span className="credit-sub-meta subtle">{s.source}{s.amount_paid != null ? ` · RM${s.amount_paid}` : ''}</span>
                  {s.cancelled_at ? <span className="credit-sub-cancelled-tag">Cancelled</span>
                    : cancelSubscription ? <button className="btn btn-ghost small" onClick={()=>cancelSubscription(s)}>Cancel</button> : null}
                </div>;
              })}
            </div>
          </div>}
        </div>}
      </div>;
    })}
    </>}
  </>;
}

// ============================================================================
// FamilyGroupsAdminView — system-wide family-groups admin panel.
// Lists EVERY family_groups row in the system, with member count, package
// context, member names, and the guardian/account each member belongs to.
// Use to audit and clean up legacy/test data without dropping to SQL.
// ============================================================================
function FamilyGroupsAdminView({ familyGroups, membersByGroup, lessonTypes, lessonTypeById, packages, packageById, deleteGroup, updateGroup, externalSearchQ }){
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [filter, setFilter] = useState('all');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editingNameId, setEditingNameId] = useState(null);
  const [editingNameVal, setEditingNameVal] = useState('');

  // Enrich each group with derived signals: package info, member rows, account names
  const enriched = (familyGroups || []).map(g => {
    const members = membersByGroup?.[g.id] || [];
    const pkg = g.packageId ? (typeof packageById === 'function' ? packageById(g.packageId) : packageById?.[g.packageId]) : null;
    const lt = pkg?.lesson_type_id ? (typeof lessonTypeById === 'function' ? lessonTypeById(pkg.lesson_type_id) : lessonTypeById?.[pkg.lesson_type_id]) : null;
    const accountNames = [...new Set(members.map(m => m.guardianName || m.guardian_name || '— No account —'))];
    return {
      ...g,
      memberRows: members,
      memberCount: members.length,
      pkg,
      pkgName: pkg?.name || null,
      ltName: lt?.name || null,
      accountNames,
      isEmpty: members.length === 0,
      isConfigured: !!pkg,
      isMisconfigured: !pkg  // group exists but no package set
    };
  });

  // Counts for the filter tab labels
  const counts = {
    all: enriched.length,
    empty: enriched.filter(g => g.isEmpty).length,
    configured: enriched.filter(g => g.isConfigured && !g.isEmpty).length,
    misconfigured: enriched.filter(g => g.isMisconfigured).length
  };

  // Apply filter + search
  const filtered = enriched.filter(g => {
    if(filter === 'empty' && !g.isEmpty) return false;
    if(filter === 'configured' && (!g.isConfigured || g.isEmpty)) return false;
    if(filter === 'misconfigured' && !g.isMisconfigured) return false;
    if(!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    if(g.name?.toLowerCase().includes(q)) return true;
    if(g.pkgName?.toLowerCase().includes(q)) return true;
    if(g.ltName?.toLowerCase().includes(q)) return true;
    if(g.accountNames.some(n => (n || '').toLowerCase().includes(q))) return true;
    if(g.memberRows.some(m => (m.name || '').toLowerCase().includes(q))) return true;
    return false;
  });
  // Sort: empty first (so cleanup is easy), then by name
  filtered.sort((a, b) => {
    if(a.isEmpty !== b.isEmpty) return a.isEmpty ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  async function bulkDeleteEmpty(){
    const empties = enriched.filter(g => g.isEmpty);
    if(empties.length === 0){ alert('No empty groups to delete.'); return; }
    if(!confirm(`Delete ALL ${empties.length} empty family group${empties.length === 1 ? '' : 's'}? This cannot be undone.\n\nGroups to delete:\n${empties.map(g => `• ${g.name}`).join('\n')}`)) return;
    setBulkBusy(true);
    try{
      for(const g of empties){
        // eslint-disable-next-line no-await-in-loop
        await deleteGroup(g, /*silentConfirm*/ true);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>👪 Family Groups — Administration</div>
          <div className="small subtle" style={{marginTop:3}}>Every family group in the system, with members and package context. Audit legacy or test data here; bulk-clean empty groups in one click.</div>
        </div>
        <div style={{display:'flex',gap:14,alignItems:'flex-end',flexWrap:'wrap'}}>
          <div><div className="small subtle">Total</div><div style={{fontSize:22,fontWeight:800,color:'var(--primary)'}}>{counts.all}</div></div>
          <div><div className="small subtle">Configured</div><div style={{fontSize:22,fontWeight:800,color:'#10B981'}}>{counts.configured}</div></div>
          <div><div className="small subtle">Empty</div><div style={{fontSize:22,fontWeight:800,color:'#94A3B8'}}>{counts.empty}</div></div>
          <div><div className="small subtle">Misconfigured</div><div style={{fontSize:22,fontWeight:800,color:'#F59E0B'}}>{counts.misconfigured}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        {externalSearchQ === undefined && <input className="input" style={{flex:1,minWidth:240,maxWidth:420}} placeholder="Search by group, package, lesson type, account, or member name…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />}
        <div className="tabs" style={{gap:2,padding:2}}>
          <button className={`tab ${filter==='all'?'active':''}`}            style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('all')}>All ({counts.all})</button>
          <button className={`tab ${filter==='configured'?'active':''}`}     style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('configured')}>Configured ({counts.configured})</button>
          <button className={`tab ${filter==='empty'?'active':''}`}          style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('empty')}>Empty ({counts.empty})</button>
          <button className={`tab ${filter==='misconfigured'?'active':''}`}  style={{padding:'4px 10px',fontSize:11}} onClick={()=>setFilter('misconfigured')}>Misconfigured ({counts.misconfigured})</button>
        </div>
        {counts.empty > 0 ? <button className="btn btn-danger small" onClick={bulkDeleteEmpty} disabled={bulkBusy} title={`Delete all ${counts.empty} groups with zero members`}>{bulkBusy ? 'Cleaning…' : `🧹 Clean ${counts.empty} empty`}</button> : null}
      </div>
    </div>

    {filtered.length === 0 ? <div className="card empty" style={{padding:30}}>No family groups match the current filter.</div> : null}

    <div style={{display:'flex',flexDirection:'column',gap:4}}>
      {filtered.map(g => {
        const isBound = g.groupType === 'bound';
        return <div key={g.id} className="fga-card">
          <div className="fga-head">
            <div className="fga-head-main">
              <div className="fga-name">
                {editingNameId === g.id
                  ? <span style={{display:'inline-flex',alignItems:'center',gap:6}}>
                      <input className="input" style={{width:180,padding:'3px 8px',fontSize:14}} value={editingNameVal} onChange={e=>setEditingNameVal(e.target.value)} onKeyDown={async e=>{ if(e.key==='Enter'&&editingNameVal.trim()){await updateGroup(g.id,{name:editingNameVal.trim()});setEditingNameId(null);} if(e.key==='Escape') setEditingNameId(null); }} autoFocus />
                      <button className="btn btn-primary small" onClick={async()=>{ if(editingNameVal.trim()) await updateGroup(g.id,{name:editingNameVal.trim()}); setEditingNameId(null); }}>Save</button>
                      <button className="btn btn-ghost small" onClick={()=>setEditingNameId(null)}>✕</button>
                    </span>
                  : <span style={{display:'inline-flex',alignItems:'center',gap:8}}>
                      {isBound ? '🔗' : '👪'} {g.name}
                      {updateGroup && <button className="btn btn-ghost small" title="Edit group name" style={{padding:'2px 7px',fontSize:11}} onClick={()=>{ setEditingNameId(g.id); setEditingNameVal(g.name||''); }}>✎</button>}
                    </span>
                }
              </div>
              <div className="fga-meta">
                {g.isConfigured
                  ? <span className="fga-pkg-tag">{g.ltName || '?'} · {g.pkgName}</span>
                  : <span className="fga-pkg-tag fga-pkg-warn">⚠ no package set</span>}
                <span className={`fga-count ${g.isEmpty ? 'is-empty' : ''}`}>{g.memberCount} member{g.memberCount === 1 ? '' : 's'}</span>
                {g.accountNames.length > 0 ? <span className="fga-accounts">{g.accountNames.join(', ')}</span> : null}
              </div>
            </div>
            <div className="fga-actions">
              <button className="btn btn-danger small" onClick={()=>deleteGroup(g)}>Delete</button>
            </div>
          </div>
          {g.memberCount > 0 ? <div className="fga-members">
            {g.memberRows.map(m => <span key={m.id} className="fga-member-chip">{m.name}{m.age != null ? ` · ${m.age}y` : ''}</span>)}
          </div> : null}
        </div>;
      })}
    </div>
  </>;
}


// ============================================================================

// Inline editor for an account's contact info + emergency contact.
// Two visually distinct sections — Account Holder (parent or self) on
// top, Emergency Contact below — both propagate to every child swimmer
// when saved. Emergency contact now carries name + phone + relationship
// (name was previously missing).
function ParentContactEditor({ pg, onSave, onCancel }){
  const [name, setName] = useState(pg.name === '— Unassigned —' || pg.name === '— No name —' ? '' : pg.name);
  const [email, setEmail] = useState(pg.email || '');
  const [phone, setPhone] = useState(pg.phone || '');
  const [ic,    setIc]    = useState(pg.ic    || '');
  const [tin,   setTin]   = useState(pg.tin   || '');
  const [emergencySame, setEmergencySame] = useState(!!pg.emergencySameAsGuardian);
  const [emergencyName, setEmergencyName] = useState(pg.emergencyName || '');
  const [emergencyPhone, setEmergencyPhone] = useState(pg.emergencyPhone || '');
  const [emergencyRel, setEmergencyRel] = useState(pg.emergencyRelationship || '');
  return <div className="parent-contact-edit">
    <div className="parent-sub-log-title">Edit account &amp; emergency contact (applies to all {pg.swimmers.length} swimmer{pg.swimmers.length===1?'':'s'})</div>

    {/* Account Holder section */}
    <div className="account-section">
      <div className="account-section-title">Parent / Guardian (Account Holder)</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Parent Name</label><input className="input" value={name} onChange={e=>setName(e.target.value)} onBlur={e=>setName(toTitleCase(e.target.value))} placeholder="Full name" /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+60 1X-XXXXXXX" /></div>
        <div className="field"><label>IC No. <span className="hint" style={{fontSize:9,display:'inline',color:'var(--text-3)'}}>optional</span></label><input className="input" value={ic} onChange={e=>setIc(e.target.value)} placeholder="e.g. 901231-14-5678" /></div>
        <div className="field"><label>TIN No. <span className="hint" style={{fontSize:9,display:'inline',color:'var(--text-3)'}}>optional</span></label><input className="input" value={tin} onChange={e=>setTin(e.target.value)} placeholder="e.g. IG12345678090" /></div>
      </div>
    </div>

    {/* Emergency Contact section */}
    <div className="account-section">
      <div className="account-section-title">Emergency Contact</div>
      <label className="gb-check" style={{marginBottom:7,display:'inline-flex',gap:6,alignItems:'center'}}><input type="checkbox" checked={emergencySame} onChange={e=>setEmergencySame(e.target.checked)} /> Same as account holder above</label>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Emergency Contact Name</label><input className="input" value={emergencySame ? name : emergencyName} onChange={e=>setEmergencyName(e.target.value)} disabled={emergencySame} placeholder="Full name" /></div>
        <div className="field"><label>Phone</label><input className="input" type="tel" value={emergencySame?phone:emergencyPhone} onChange={e=>setEmergencyPhone(e.target.value)} disabled={emergencySame} placeholder="+60 1X-XXXXXXX" /></div>
        <div className="field"><label>Relationship</label><input className="input" value={emergencySame?'Account Holder':emergencyRel} onChange={e=>setEmergencyRel(e.target.value)} disabled={emergencySame} placeholder="e.g. Mother, Father, Spouse, Sibling" /></div>
      </div>
    </div>

    <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:10}}>
      <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>
      <button className="btn btn-primary small" onClick={()=>onSave({
        guardianName:name, guardianEmail:email, guardianPhone:phone,
        guardianIc: ic.trim() || null, guardianTin: tin.trim() || null,
        emergencySameAsGuardian: emergencySame,
        emergencyName: emergencySame ? name : emergencyName,
        emergencyPhone: emergencySame ? phone : emergencyPhone,
        emergencyRelationship: emergencySame ? 'Account Holder' : emergencyRel
      })}>Save</button>
    </div>
  </div>;
}

// Family group management for a parent — pick existing group or create new
// from this parent's children, toggle membership per child, switch type.
// ============================================================================
// ── Shared billing-line computation ─────────────────────────────────────────
// Used by both BillingPreviewPanel (interactive preview) and the batch invoice
// generator so both produce identical line amounts.
function computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes){
  function ltName(id){
    const lt = typeof lessonTypeById === 'function' ? lessonTypeById(id) : null;
    return lt?.name || (lessonTypes||[]).find(x=>x.id===id)?.name || 'Lesson';
  }
  function pkgById2(id){ return typeof packageById === 'function' ? packageById(id) : null; }
  const groupItems = [];
  const individualItems = [];
  const unconfiguredGroups = [];
  const accountGroupIds = [...new Set((pg.swimmers||[]).flatMap(s => s.familyGroupIds || []))];
  accountGroupIds.forEach(gid => {
    const g = groupById?.[gid];
    if(!g) return;
    const pkg = g.packageId ? pkgById2(g.packageId) : null;
    if(!pkg){ const mems=(pg.swimmers||[]).filter(s=>(s.familyGroupIds||[]).includes(gid)); unconfiguredGroups.push({id:gid,name:g.name,groupType:g.groupType,memberCount:mems.length,memberNames:mems.map(m=>m.name).join(', ')}); return; }
    const members=(pg.swimmers||[]).filter(s=>(s.familyGroupIds||[]).includes(gid));
    const memberCount=members.length;
    const required=pkg.pax!=null?Number(pkg.pax):null;
    const bundle=pkg.amount!=null?Number(pkg.amount):0;
    const fb=pkg.fallback_per_pax!=null?Number(pkg.fallback_per_pax):null;
    let amount=bundle;
    if(required!=null&&memberCount>required&&fb!=null) amount=bundle+(memberCount-required)*fb;
    groupItems.push({
      key:`group:${gid}`,groupId:gid,groupName:g.name,groupType:g.groupType,
      lessonTypeId:pkg.lesson_type_id,packageId:pkg.id,
      lessonTypeName:ltName(pkg.lesson_type_id),packageName:pkg.name,
      familyGroupId:gid,familyGroupName:g.name,
      memberCount,memberIds:members.map(m=>m.id),
      memberNames:members.map(m=>m.name).join(', '),
      studentIds:members.map(m=>m.id).join(','),studentNames:members.map(m=>m.name).join(', '),
      bundle,amount,lineType:'group_bundle',
      billingMode:pkg.billing_mode||'monthly',billingCount:pkg.billing_count,
      creditsPerSwimmer:pkg.billing_count||4,
      description:`${g.groupType==='bound'?'🔗':'👪'} ${g.name} — ${ltName(pkg.lesson_type_id)} · ${pkg.name}`,
    });
  });
  (pg.swimmers||[]).forEach(sw=>{
    const coveredPkgIds=new Set();
    (sw.familyGroupIds||[]).forEach(gid=>{const grp=groupById?.[gid];if(grp?.packageId)coveredPkgIds.add(grp.packageId);});
    (sw.enrollments||[]).forEach(e=>{
      if(!e.lessonTypeId||!e.packageId||coveredPkgIds.has(e.packageId)) return;
      const pkg=pkgById2(e.packageId);
      if(!pkg) return;
      const qty=Math.max(1,Number(e.quantity)||1);
      const unit=pkg.amount!=null?Number(pkg.amount):0;
      individualItems.push({
        key:`ind:${sw.id}:${e.lessonTypeId}:${e.packageId}`,
        swimmerId:sw.id,swimmerName:sw.name,
        lessonTypeId:e.lessonTypeId,packageId:e.packageId,
        lessonTypeName:ltName(e.lessonTypeId),packageName:pkg.name,
        studentIds:sw.id,studentNames:sw.name,
        quantity:qty,
        amount:unit*qty,
        lineType:'individual',billingMode:pkg.billing_mode||'monthly',
        billingCount:pkg.billing_count,creditsPerSwimmer:(pkg.billing_count||4)*qty,
        description:`${sw.name} — ${ltName(e.lessonTypeId)} · ${pkg.name}${qty>1?` ×${qty}`:''}`,
      });
    });
  });
  return { groupItems, individualItems, allItems:[...groupItems,...individualItems], unconfiguredGroups };
}

// BillingPreviewPanel — invoice generator for an account.
// Detects billable items (group bundles + individual lessons).
// Per-line checkboxes let staff exclude any item before generating.
// "Generate Invoice" creates the invoice + lines + navigates to Admin > Invoices.
// The old per-line "💳 Record" flow has been superseded by the invoice path.
// ============================================================================
function BillingPreviewPanel({ pg, lessonTypes, lessonTypeById, packages, packageById, products, groupById, membersByGroup, subscriptions, addSubscription, onClose, onGenerateInvoice }){
  const ltById = lessonTypeById || ((id) => lessonTypes.find(x => x.id === id));
  const pkgById = packageById || ((id) => packages.find(p => p.id === id));
  function ltName(id){ const lt = typeof ltById === 'function' ? ltById(id) : ltById?.[id]; return lt?.name || 'Lesson'; }

  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoiceDueDate, setInvoiceDueDate] = useState('');
  const [checked, setChecked] = useState(new Set());    // initialised after items computed
  const [generating, setGenerating] = useState(false);

  // ── Compute line items via shared helper ────────────────────────────
  const { groupItems, individualItems, allItems, unconfiguredGroups } =
    React.useMemo(() => computeBillingLines(pg, groupById, packageById, lessonTypeById, lessonTypes),
    [pg.key, pg.swimmers?.length]);
  const allKeys = allItems.map(it=>it.key);

  // Initialise checked set when items first load
  React.useEffect(() => { setChecked(new Set(allKeys)); }, [allItems.length]);
  function toggleCheck(key){ setChecked(s=>{ const n=new Set(s); if(n.has(key)) n.delete(key); else n.add(key); return n; }); }
  function toggleAll(){ const c=allKeys.every(k=>checked.has(k)); setChecked(c?new Set():new Set(allKeys)); }

  const checkedItems = allItems.filter(it=>checked.has(it.key));
  const checkedTotal = checkedItems.reduce((s,it)=>s+it.amount,0);
  const hasAny = allItems.length > 0;
  const allChecked = allKeys.length > 0 && allKeys.every(k=>checked.has(k));

  // Product / goods lines (goggles, caps, swim diapers…) — billable with or without lessons.
  const [productLines,setProductLines]=useState([]);
  const [pDesc,setPDesc]=useState(''); const [pQty,setPQty]=useState(1); const [pPrice,setPPrice]=useState('');
  const productTotal = productLines.reduce((s,p)=> s + (Math.max(1,Number(p.quantity)||1)*(Number(p.unitPrice)||0)), 0);
  const grandTotal = checkedTotal + productTotal;
  const canGenerate = checkedItems.length>0 || productLines.length>0;
  function addProduct(){ const d=pDesc.trim(); const u=Number(pPrice)||0; const q=Math.max(1,Number(pQty)||1); if(!d||!(u>0)) return; setProductLines([...productLines,{id:Math.random().toString(36).slice(2),description:d,quantity:q,unitPrice:u}]); setPDesc(''); setPQty(1); setPPrice(''); }
  function removeProduct(id){ setProductLines(productLines.filter(p=>p.id!==id)); }

  async function handleGenerate(){
    if(!canGenerate){ alert('Add or select at least one line to include on the invoice.'); return; }
    setGenerating(true);
    try{
      const lessonLines = checkedItems.map(it=>({...it}));
      const prodLines = productLines.map(p=>({ description:p.description, amount:Math.max(1,Number(p.quantity)||1)*(Number(p.unitPrice)||0), quantity:Math.max(1,Number(p.quantity)||1), lineType:'product' }));
      await onGenerateInvoice([...lessonLines, ...prodLines], { notes:invoiceNotes, dueDate:invoiceDueDate });
    }
    catch(e){ alert(e?.message||'Failed to generate invoice'); }
    finally{ setGenerating(false); }
  }

  return <div className="parent-billing-panel">
    <div className="parent-sub-log-title" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:8}}>
      <span>🧾 Invoice Preview — {pg.name}</span>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>
    <div className="small subtle" style={{marginBottom:10}}>
      Tick the items to include on this invoice. Untick anything not being billed this cycle. Click <strong>Generate Invoice</strong> to create a draft invoice in Admin → Invoices.
    </div>

    {!hasAny && unconfiguredGroups.length===0 && <div className="empty" style={{padding:16}}>No lesson items to bill — you can still add products / goods below and generate a bill.</div>}

    {unconfiguredGroups.length > 0 && <div className="billing-warning-box">
      <div className="billing-warning-title">⚠ {unconfiguredGroups.length} group{unconfiguredGroups.length===1?'':'s'} missing a package</div>
      <div className="billing-warning-body">Open <strong>Manage Group</strong> and set a package on: {unconfiguredGroups.map(u=><strong key={u.id}> {u.name}</strong>)}.</div>
    </div>}

    {hasAny && <table className="billing-table">
        <thead>
          <tr>
            <th style={{width:32}}>
              <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Select all" />
            </th>
            <th>Description</th>
            <th>Type</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {groupItems.map(it => <tr key={it.key} className={checked.has(it.key)?'':'billing-row-muted'}>
            <td><input type="checkbox" checked={checked.has(it.key)} onChange={()=>toggleCheck(it.key)} /></td>
            <td>
              <div style={{fontWeight:700}}>{it.groupType==='bound'?'🔗':'👪'} {it.groupName}</div>
              <div className="small subtle">{it.lessonTypeName} · {it.packageName}</div>
              <div className="small subtle">{it.memberNames}</div>
            </td>
            <td><span className="billing-type-chip group">Group Bundle</span></td>
            <td className="num"><strong>RM{it.amount.toFixed(2)}</strong></td>
          </tr>)}
          {individualItems.map(it => <tr key={it.key} className={checked.has(it.key)?'':'billing-row-muted'}>
            <td><input type="checkbox" checked={checked.has(it.key)} onChange={()=>toggleCheck(it.key)} /></td>
            <td>
              <div style={{fontWeight:700}}>{it.swimmerName}</div>
              <div className="small subtle">{it.lessonTypeName} · {it.packageName}</div>
            </td>
            <td><span className="billing-type-chip individual">Individual</span></td>
            <td className="num"><strong>RM{it.amount.toFixed(2)}</strong></td>
          </tr>)}
        </tbody>
      </table>}

      {/* Products / goods — billable with or without lessons */}
      {unconfiguredGroups.length===0 && <div style={{marginTop:hasAny?14:6,padding:'10px 12px',border:'1px dashed var(--border)',borderRadius:10}}>
        <div style={{fontWeight:700,marginBottom:6}}>🛍 Products / goods <span className="small subtle">(optional — goggles, caps, swim diapers…)</span></div>
        {(products||[]).filter(p=>p.is_active!==false).length>0 && <div style={{marginBottom:8}}>
          <select className="select" value="" onChange={e=>{ const p=(products||[]).find(x=>x.id===e.target.value); if(p){ setPDesc(p.name); if(p.price!=null) setPPrice(String(p.price)); } }}>
            <option value="">Pick from catalogue…</option>
            {(products||[]).filter(p=>p.is_active!==false).map(p=><option key={p.id} value={p.id}>{p.name}{p.price!=null?` — RM${Number(p.price).toFixed(2)}`:''}</option>)}
          </select>
        </div>}
        {productLines.length>0 && <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:8}}>
          {productLines.map(p=>{ const q=Math.max(1,Number(p.quantity)||1); const u=Number(p.unitPrice)||0; return <div key={p.id} style={{display:'flex',alignItems:'center',gap:8,fontSize:13}}>
            <span style={{flex:1}}>{p.description}{q>1?` — Qty ${q} × RM${u.toFixed(2)}`:''}</span>
            <span style={{fontWeight:700}}>RM{(q*u).toFixed(2)}</span>
            <button className="btn btn-ghost small" style={{color:'#DC2626',padding:'0 6px'}} title="Remove" onClick={()=>removeProduct(p.id)}>×</button>
          </div>; })}
        </div>}
        <div style={{display:'grid',gridTemplateColumns:'1fr 58px 92px auto',gap:8,alignItems:'end'}}>
          <div className="field" style={{margin:0}}><label>Item</label><input className="input" value={pDesc} onChange={e=>setPDesc(e.target.value)} placeholder="e.g. Swim goggles" /></div>
          <div className="field" style={{margin:0}}><label>Qty</label><input className="input" type="number" min="1" step="1" value={pQty} onChange={e=>setPQty(Math.max(1,parseInt(e.target.value,10)||1))} /></div>
          <div className="field" style={{margin:0}}><label>Unit RM</label><input className="input" type="number" min="0" step="0.01" value={pPrice} onChange={e=>setPPrice(e.target.value)} placeholder="0.00" /></div>
          <button className="btn btn-ghost small" style={{height:34}} onClick={addProduct} disabled={!pDesc.trim()||!(Number(pPrice)>0)}>+ Add</button>
        </div>
      </div>}

      {(hasAny || productLines.length>0) && <>
      <div className="billing-total-row" style={{marginTop:12}}>
        <span className="billing-total-label">{checkedItems.length} lesson item{checkedItems.length===1?'':'s'}{productLines.length?` + ${productLines.length} product${productLines.length===1?'':'s'}`:''}</span>
        <span className="billing-total-value">RM{grandTotal.toFixed(2)}</span>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 180px',gap:10,marginTop:12}}>
        <div className="field"><label>Invoice Notes (optional)</label>
          <input className="input" value={invoiceNotes} onChange={e=>setInvoiceNotes(e.target.value)} placeholder="e.g. June 2026 monthly fee" /></div>
        <div className="field"><label>Due Date (optional)</label>
          <input className="input" type="date" value={invoiceDueDate} onChange={e=>setInvoiceDueDate(e.target.value)} /></div>
      </div>

      <div style={{display:'flex',justifyContent:'flex-end',marginTop:12}}>
        <button className="btn btn-primary" onClick={handleGenerate} disabled={generating||!canGenerate}>
          {generating ? 'Generating…' : `🧾 Generate Invoice — RM${grandTotal.toFixed(2)}`}
        </button>
      </div>
      </>}
  </div>;
}


// Flow:
//   1. Existing groups touching this family are listed at the top with
//      their package context, member checkboxes, and an inline type/name editor.
//      Only swimmers in this family who have an enrollment matching the
//      group's package are shown as eligible checkboxes.
//   2. Below, "Create new group" picks Lesson Type → Package → Type, and
//      live-previews which family swimmers are eligible (have that exact
//      package enrollment). The user ticks who to include and one click
//      creates the group and assigns members in a single transaction.
function ParentGroupManager({ pg, familyGroups, groupById, membersByGroup, groupIdsByStudent, lessonTypes, packages, packageById, addGroup, updateGroup, deleteGroup, setStudentGroup, addStudentToGroup, removeStudentFromGroup, onClose }){
  // ── Eligibility helpers ──────────────────────────────────────────────
  // (1) A swimmer is "package-eligible" for a (lessonTypeId, packageId)
  //     iff they have an enrolment row with that exact pair.
  // (2) But uniqueness also applies: a swimmer can only be in ONE group
  //     per unique (lesson_type, package). So if the swimmer is already
  //     in some OTHER group with the same package, they're not eligible
  //     for THIS one — they'd be hopping, which is what we're patching.
  //     We surface the conflicting group's name so the UI can explain why.
  function eligibleFor(lessonTypeId, packageId){
    if(!lessonTypeId || !packageId) return [];
    return pg.swimmers.filter(s => (s.enrollments || []).some(e => e.lessonTypeId === lessonTypeId && e.packageId === packageId));
  }
  // For a candidate package, return any OTHER group the swimmer is in with
  // the same package_id — null if they're free to join.
  function conflictingGroupFor(swimmerId, packageId, excludeGroupId){
    const ids = groupIdsByStudent?.[swimmerId];
    if(!ids) return null;
    for(const gid of ids){
      if(gid === excludeGroupId) continue;
      const g = familyGroups.find(x => x.id === gid);
      if(g && g.packageId === packageId) return g;
    }
    return null;
  }

  // ── State for the create form ────────────────────────────────────────
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [creatingName, setCreatingName] = useState('');
  const [creatingLtId, setCreatingLtId] = useState('');
  const [creatingPkgId, setCreatingPkgId] = useState('');
  const [creatingType, setCreatingType] = useState('discount');
  const [creatingMemberIds, setCreatingMemberIds] = useState(new Set());
  // ── State for editing an existing group's package ──────────────────
  // editPkgFor = group.id of the group whose package editor is open.
  // editPkgLtId / editPkgPkgId hold the in-progress selection.
  const [editPkgFor, setEditPkgFor] = useState(null);
  const [editPkgLtId, setEditPkgLtId] = useState('');
  const [editPkgPkgId, setEditPkgPkgId] = useState('');

  // Packages dropdown is filtered by selected lesson type — each package
  // belongs to exactly one lesson type by schema (packages.lesson_type_id).
  const eligiblePackages = creatingLtId
    ? packages.filter(p => p.lesson_type_id === creatingLtId)
    : [];

  // Live preview of who is eligible right now given the current pick.
  const previewEligible = eligibleFor(creatingLtId, creatingPkgId);

  function toggleMember(id){
    const next = new Set(creatingMemberIds);
    if(next.has(id)) next.delete(id); else next.add(id);
    setCreatingMemberIds(next);
  }
  function selectAllEligible(){ setCreatingMemberIds(new Set(previewEligible.map(s => s.id))); }
  function selectNone(){ setCreatingMemberIds(new Set()); }

  // When lessonType/package changes, default member selection to all
  // FREE eligible swimmers (excludes those already in another group with
  // the same package — they're locked out by the uniqueness rule).
  React.useEffect(() => {
    if(!creatingPkgId){ setCreatingMemberIds(new Set()); return; }
    const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
    setCreatingMemberIds(new Set(free.map(s => s.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creatingLtId, creatingPkgId]);

  async function handleCreate(){
    const name = creatingName.trim();
    if(!name){ alert('Group needs a name.'); return; }
    if(!creatingLtId || !creatingPkgId){ alert('Pick a Lesson Type and Package first.'); return; }
    const inserted = await addGroup({ name, packageId: creatingPkgId, groupType: creatingType });
    if(!inserted){ return; }  // addGroup already alerted on failure
    // The `inserted` row is a raw DB record (snake_case). Map it to the
    // familyGroups state shape (camelCase) so addStudentToGroup can use
    // it directly without needing the lookup — necessary because React
    // hasn't re-rendered yet within this same event handler, so our
    // closure's familyGroups doesn't include the brand-new group.
    const targetOverride = {
      id: inserted.id,
      name: inserted.name || '',
      packageId: inserted.package_id || null,
      groupType: inserted.group_type || 'discount'
    };
    // Bulk-assign each selected swimmer to the new group. addStudentToGroup
    // enforces uniqueness — a swimmer who's already in another group with
    // the same package will be filtered out in the UI before this point,
    // but the write API blocks duplicates as a defensive backstop.
    for(const sid of creatingMemberIds){
      // eslint-disable-next-line no-await-in-loop
      await addStudentToGroup(sid, inserted.id, targetOverride);
    }
    // Reset create form
    setCreatingName(''); setCreatingLtId(''); setCreatingPkgId(''); setCreatingType('discount'); setCreatingMemberIds(new Set()); setCreatingOpen(false);
  }

  // ── Existing groups touching this family ─────────────────────────────
  // Multi-group: a swimmer may be in several groups, so flatMap over the
  // familyGroupIds array. The Set dedupes.
  const involvedGroupIds = [...new Set(pg.swimmers.flatMap(s => s.familyGroupIds || []))];
  const involvedGroups = involvedGroupIds.map(gid => groupById?.[gid]).filter(Boolean);

  function packageLabel(pkgId){
    if(!pkgId) return null;
    const p = packageById ? packageById(pkgId) : null;
    if(!p) return null;
    const lt = lessonTypes.find(x => x.id === p.lesson_type_id);
    return { ltName: lt?.name || 'Unknown lesson type', pkgName: p.name || 'Package' };
  }

  return <div className="parent-group-panel">
    <div className="parent-sub-log-title">Family group management</div>

    {/* ── Existing groups ──────────────────────────────────────────── */}
    {involvedGroups.length > 0 && <div style={{marginBottom:14}}>
      {involvedGroups.map(g => {
        const isBound = g.groupType === 'bound';
        const pkgInfo = packageLabel(g.packageId);
        // Eligibility: swimmers with the group's exact package. Without
        // a package_id on the group (legacy data) we fall back to "all
        // swimmers in this family" so legacy groups remain editable.
        const eligibleHere = g.packageId ? eligibleFor(pkgInfo ? (packageById?.(g.packageId)?.lesson_type_id) : null, g.packageId) : pg.swimmers;
        // Multi-group: membership comes from the junction-derived Set on each swimmer.
        const memberSetForThisParent = pg.swimmers.filter(s => (s.familyGroupIds || []).includes(g.id));
        const isEditingPkg = editPkgFor === g.id;
        const editPkgChoices = editPkgLtId ? packages.filter(p => p.lesson_type_id === editPkgLtId) : [];
        return <div key={g.id} className="parent-group-block">
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}>
            <strong>{isBound ? '🔗' : '👪'} {g.name}</strong>
            {pkgInfo ? <span className="parent-group-tag" title="Group package — only swimmers with this package are eligible">{pkgInfo.ltName} · {pkgInfo.pkgName}</span> : <span className="parent-group-tag" style={{background:'#fef3c7',borderColor:'#fde68a',color:'#854d0e'}}>⚠ no package set</span>}
            <button className="btn btn-ghost small" onClick={()=>{
              if(isEditingPkg){ setEditPkgFor(null); return; }
              // Pre-fill the editor with current selection
              const cur = g.packageId ? packageById?.(g.packageId) : null;
              setEditPkgLtId(cur?.lesson_type_id || '');
              setEditPkgPkgId(g.packageId || '');
              setEditPkgFor(g.id);
            }}>{isEditingPkg ? 'Cancel' : (pkgInfo ? '✎ Change package' : '+ Set package')}</button>
            <button className="btn btn-ghost small" onClick={()=>updateGroup(g.id, { groupType: isBound?'discount':'bound' })}>
              {isBound ? 'Switch to Discount' : 'Switch to Bound'}
            </button>
            <button className="btn btn-danger small" onClick={()=>deleteGroup(g)}>Delete</button>
            <span className="subtle small" style={{marginLeft:'auto'}}>{memberSetForThisParent.length} of {eligibleHere.length} eligible</span>
          </div>

          {/* Inline package editor for this existing group */}
          {isEditingPkg && <div style={{padding:'9px 11px',background:'#F0F9FF',border:'1px solid #BFDBFE',borderRadius:6,marginBottom:8}}>
            <div className="parent-sub-log-title" style={{fontSize:10,marginBottom:6}}>
              {pkgInfo ? 'Change package for this group' : 'Set the package this group is billed under'}
            </div>
            <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr auto'}}>
              <div className="field">
                <label>Lesson Type</label>
                <select className="select" value={editPkgLtId} onChange={e=>{ setEditPkgLtId(e.target.value); setEditPkgPkgId(''); }}>
                  <option value="">— Select lesson type —</option>
                  {lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Package</label>
                <select className="select" value={editPkgPkgId} onChange={e=>setEditPkgPkgId(e.target.value)} disabled={!editPkgLtId}>
                  <option value="">{editPkgLtId ? '— Select package —' : 'Pick lesson type first'}</option>
                  {editPkgChoices.map(p => <option key={p.id} value={p.id}>{p.name}{p.amount != null ? ` · RM${p.amount}` : ''}</option>)}
                </select>
              </div>
              <div className="field" style={{justifyContent:'flex-end'}}>
                <button className="btn btn-primary small" disabled={!editPkgPkgId} onClick={async ()=>{
                  await updateGroup(g.id, { packageId: editPkgPkgId });
                  setEditPkgFor(null);
                }}>Save</button>
              </div>
            </div>
            <div className="hint" style={{marginTop:6}}>Setting the package activates bundle billing for this group — all members enrolled in this (lesson type, package) pair are billed once via the group bundle.</div>
          </div>}

          <div className="parent-group-members">
            {eligibleHere.length === 0 ? <span className="subtle small">No swimmers in this family have the matching package.</span> : eligibleHere.map(sw => {
              const inThis = (sw.familyGroupIds || []).includes(g.id);
              // If this swimmer is NOT already in this group but IS in
              // another group with the same package, lock them out — they
              // can't be moved without removing them from the other group
              // first (that's the patched "no hopping" rule).
              const other = !inThis && g.packageId ? conflictingGroupFor(sw.id, g.packageId, g.id) : null;
              const locked = !!other;
              return <label key={sw.id} className="parent-group-member" style={locked ? {opacity:.45} : null} title={locked ? `Already in "${other.name}" — remove from there first` : undefined}>
                <input type="checkbox" checked={inThis} disabled={locked} onChange={(e)=>{
                  if(e.target.checked){ addStudentToGroup(sw.id, g.id); }
                  else { removeStudentFromGroup(sw.id, g.id); }
                }} /> {sw.name}{locked ? <span className="subtle small"> · in {other.name}</span> : null}
              </label>;
            })}
            {/* Show any non-eligible swimmers as muted, so user understands why they can't be added */}
            {g.packageId && pg.swimmers.filter(s => !eligibleHere.includes(s)).map(sw => <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title="Does not have the matching package enrollment"><input type="checkbox" disabled /> {sw.name}</label>)}
          </div>
        </div>;
      })}
    </div>}

    {/* ── Create new group ──────────────────────────────────────────── */}
    <div className="parent-group-create">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:creatingOpen?8:0}}>
        <div className="parent-sub-log-title" style={{margin:0}}>Create a new family group</div>
        <button className={`btn small ${creatingOpen?'btn-ghost':'btn-primary'}`} onClick={()=>setCreatingOpen(o=>!o)}>{creatingOpen?'Cancel':'+ New Group'}</button>
      </div>

      {creatingOpen && <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:8}}>
        {/* Step 1: Lesson Type + Package (the eligibility filter) */}
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr'}}>
          <div className="field">
            <label>Lesson Type</label>
            <select className="select" value={creatingLtId} onChange={e=>{ setCreatingLtId(e.target.value); setCreatingPkgId(''); }}>
              <option value="">— Select lesson type —</option>
              {lessonTypes.map(lt => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Package</label>
            <select className="select" value={creatingPkgId} onChange={e=>setCreatingPkgId(e.target.value)} disabled={!creatingLtId}>
              <option value="">{creatingLtId ? '— Select package —' : 'Pick lesson type first'}</option>
              {eligiblePackages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        {/* Step 2: Group name + type */}
        <div className="form-grid" style={{gridTemplateColumns:'1fr auto'}}>
          <div className="field">
            <label>Group Name</label>
            <input className="input" value={creatingName} onChange={e=>setCreatingName(e.target.value)} placeholder={`${pg.name} family · ${eligiblePackages.find(p=>p.id===creatingPkgId)?.name || 'group'}`} />
          </div>
          <div className="field">
            <label>Type</label>
            <div className="tabs" style={{gap:2,padding:2}}>
              <button type="button" className={`tab ${creatingType==='discount'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setCreatingType('discount')}>👪 Discount</button>
              <button type="button" className={`tab ${creatingType==='bound'?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setCreatingType('bound')}>🔗 Bound</button>
            </div>
          </div>
        </div>

        {/* Step 3: Eligible swimmers (filtered by selected package +
             uniqueness check). Three buckets:
               • free       — checkable; package-eligible AND not in another group with same package
               • conflicted — disabled; package-eligible BUT already in another group with same package
               • ineligible — disabled; no matching enrolment */}
        {creatingPkgId && (() => {
          const free = previewEligible.filter(sw => !conflictingGroupFor(sw.id, creatingPkgId, null));
          const conflicted = previewEligible.filter(sw => !!conflictingGroupFor(sw.id, creatingPkgId, null));
          const lacking = pg.swimmers.filter(s => !previewEligible.includes(s));
          return <div className="parent-group-block" style={{background:'#F0F9FF',borderColor:'#BFDBFE'}}>
            <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:6}}>
              <strong>Eligible swimmers</strong>
              <span className="subtle small">{free.length} free · {conflicted.length} already in another group · {lacking.length} no matching enrolment</span>
              <div style={{marginLeft:'auto',display:'flex',gap:4}}>
                <button className="btn btn-ghost small" onClick={()=>setCreatingMemberIds(new Set(free.map(s => s.id)))} disabled={free.length===0}>All</button>
                <button className="btn btn-ghost small" onClick={selectNone} disabled={creatingMemberIds.size===0}>None</button>
              </div>
            </div>
            <div className="parent-group-members">
              {free.length === 0 && conflicted.length === 0 && lacking.length === pg.swimmers.length
                ? <span className="subtle small">No swimmers in this family have the selected package. Add the enrolment to a swimmer first via ✎ Edit on their row.</span>
                : null}
              {free.map(sw => {
                const checked = creatingMemberIds.has(sw.id);
                return <label key={sw.id} className="parent-group-member"><input type="checkbox" checked={checked} onChange={()=>toggleMember(sw.id)} /> {sw.name}</label>;
              })}
              {/* Conflicted: package matches BUT already in another group with same package. Tooltip names the conflicting group. */}
              {conflicted.map(sw => {
                const other = conflictingGroupFor(sw.id, creatingPkgId, null);
                return <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title={`Already in "${other?.name}" with the same package — one group per (lesson type, package) per swimmer`}><input type="checkbox" disabled /> {sw.name} <span className="subtle small">· already in {other?.name}</span></label>;
              })}
              {/* Ineligible: lacks the matching enrolment entirely. */}
              {lacking.map(sw => <label key={sw.id} className="parent-group-member" style={{opacity:.45}} title="Does not have the selected package — add the enrolment to make eligible"><input type="checkbox" disabled /> {sw.name}</label>)}
            </div>
          </div>;
        })()}

        <div style={{display:'flex',justifyContent:'flex-end',gap:6}}>
          <button className="btn btn-primary small" onClick={handleCreate} disabled={!creatingLtId || !creatingPkgId || !creatingName.trim()}>
            + Create &amp; Assign {creatingMemberIds.size > 0 ? `(${creatingMemberIds.size})` : ''}
          </button>
        </div>
      </div>}
    </div>

    <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}>
      <button className="btn btn-ghost small" onClick={onClose}>Close</button>
    </div>
  </div>;
}


function PendingCreditsView({ branches, pendingCredits, invoices, studentById, familyGroups, groupById, lessonTypeById, packageById, onConfirm, onReverse }){
  const [statusFilter,setStatusFilter]=useState('pending');
  const [confirmingAll,setConfirmingAll]=useState(false);
  const pendingCount=pendingCredits.filter(p=>p.status==='pending').length;
  const invById=useMemo(()=>Object.fromEntries((invoices||[]).map(i=>[i.id,i])),[invoices]);

  const filtered=pendingCredits.filter(pc=>statusFilter==='all'||pc.status===statusFilter);

  async function confirmAll(){
    const targets = pendingCredits.filter(p=>p.status==='pending');
    if(!targets.length){ alert('No pending credits to confirm.'); return; }
    if(!confirm(`Confirm all ${targets.length} pending credit${targets.length>1?'s':''}? This will allocate lesson credits to each swimmer immediately. This action cannot be undone.`)) return;
    setConfirmingAll(true);
    for(const pc of targets){ try{ await onConfirm(pc); }catch(_){} }
    setConfirmingAll(false);
  }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>⏳ Pending Credits</div>
          <div className="small subtle">Credits held in escrow after payment is recorded. Confirm to allocate lesson credits to the account. Reverse to reject (e.g. bounced payment).</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {pendingCount>0&&<div style={{fontSize:18,fontWeight:800,color:'var(--amber-tx)'}}>{pendingCount} awaiting</div>}
          {pendingCount>0&&<button className="btn btn-primary small" disabled={confirmingAll} onClick={confirmAll}>
            {confirmingAll ? 'Confirming…' : `✓ Confirm All (${pendingCount})`}
          </button>}
        </div>
      </div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginTop:4}}>
        <div style={{display:'flex',gap:3}}>
          {['pending','confirmed','reversed','all'].map(s=><button key={s} className={`tab ${statusFilter===s?'active':''}`} style={{padding:'5px 10px',fontSize:11,borderRadius:7}} onClick={()=>setStatusFilter(s)}>
            {s==='all'?`All (${pendingCredits.length})`:s.charAt(0).toUpperCase()+s.slice(1)+` (${pendingCredits.filter(p=>p.status===s).length})`}
          </button>)}
        </div>
      </div>
    </div>

    {filtered.length===0&&<div className="card empty" style={{padding:28}}>No credits in this status.</div>}

    <div style={{display:'flex',flexDirection:'column',gap:6}}>
      {filtered.map(pc=>{
        const inv=invById[pc.invoice_id];
        const lt=pc.lesson_type_id&&lessonTypeById?lessonTypeById(pc.lesson_type_id):null;
        const pkg=pc.package_id&&packageById?packageById(pc.package_id):null;
        const grp=pc.family_group_id&&groupById?groupById(pc.family_group_id):null;
        const stu=pc.student_id&&studentById?studentById[pc.student_id]:null;
        return <div key={pc.id} className={`pc-card status-${pc.status}`}>
          <div className="pc-card-body">
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700}}>{pc.description||'Credit Allocation'}</div>
              <div className="small subtle">
                {grp?`\ud83d\udc6a ${grp.name}`:stu?`\ud83d\udc64 ${stu.name}`:'Unknown recipient'}
                {lt?` \u00b7 ${lt.name}`:''}
                {pkg?` \u00b7 ${pkg.name}`:''}
              </div>
              <div className="small subtle">{pc.credits_per_swimmer} credit{pc.credits_per_swimmer===1?'':'s'} per swimmer{inv?` \u00b7 ${inv.invoice_number}`:''}{inv?` \u00b7 ${inv.account_name}`:''}</div>
              <div className="small subtle">{new Date(pc.created_at).toLocaleDateString(undefined,{dateStyle:'medium'})}</div>
            </div>
            <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5}}>
              <span className={`pc-status-chip status-${pc.status}`}>{pc.status==='pending'?'\u23f3 Pending':pc.status==='confirmed'?'\u2713 Confirmed':'\u2717 Reversed'}</span>
              {pc.status==='pending'&&<div style={{display:'flex',gap:5}}>
                <button className="btn btn-primary small" onClick={()=>onConfirm(pc)}>\u2713 Confirm Credits</button>
                <button className="btn btn-danger small" onClick={()=>onReverse(pc)}>\u2717 Reverse</button>
              </div>}
            </div>
          </div>
        </div>;
      })}
    </div>
  </>;
}


// ── ReportsView — Dashboard + Retention ─────────────────────────────────────
// Focused analytics for the swim school owner. Two tabs:
//  1. Dashboard — today's cash snapshot, deferred revenue, at-risk swimmers,
//     overdue invoices, low-utilization slots. Decision-ready.
//  2. Retention — cohort analysis, LTV, churn signals. The growth-vs-leak chart.
function ReportsView({ invoices, pmts, pendingCredits, students, sessions, creditBalances, branches, lessonTypes, lessonTypeById, currentBranchId }){
  const [tab, setTab] = useState('dashboard');
  const today = todayStr();
  const todayMs = new Date(today).getTime();
  const rm = v => `RM ${Number(v||0).toFixed(2)}`;
  const monthAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth()-n); return toDateStr(d); };

  // Branch filter — match the global selector unless we explicitly want everything
  const branchScope = currentBranchId && currentBranchId !== 'all' ? currentBranchId : null;
  const branchById2 = useMemo(()=>Object.fromEntries((branches||[]).map(b=>[b.id,b])),[branches]);
  const studentById2 = useMemo(()=>Object.fromEntries((students||[]).map(s=>[s.id,s])),[students]);

  // Scope-filtered datasets
  const scopedStudents = students.filter(s => !branchScope || !s.branchId || s.branchId === branchScope);
  const scopedInvoices = invoices.filter(i => !branchScope || !i.branch_id || i.branch_id === branchScope);
  const scopedPmts = pmts.filter(p => { const inv = invoices.find(i => i.id === p.invoice_id); return !branchScope || !inv?.branch_id || inv.branch_id === branchScope; });

  // ── Last attended date per swimmer (used by at-risk + retention) ─────────
  const lastAttendedByStu = useMemo(() => {
    const m = {};
    sessions.forEach(s => {
      const sessionDate = addDays(s.weekStartDate || '', s.day);
      if(!sessionDate || sessionDate > today) return; // future sessions don't count
      (s.students || []).forEach(st => {
        const sid = st.studentId;
        if(!sid) return;
        // Only count if attendance was recorded as 'present' OR not recorded
        // (legacy data has no attendance — assume attended)
        const att = st.attendance || st.attendance_status || 'pending';
        if(att === 'absent' || att === 'no_show') return;
        if(!m[sid] || sessionDate > m[sid]) m[sid] = sessionDate;
      });
    });
    return m;
  }, [sessions, today]);

  // ── Tab routing ─────────────────────────────────────────────────────────
  const tabs = [['dashboard','📊 Dashboard'],['retention','🔁 Retention & Churn']];

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>Reports & Analytics</div>
          <div className="small subtle">Focused, decision-ready views{branchScope ? ` · scoped to ${branchById2[branchScope]?.name || 'branch'}` : ' · all branches'}.</div>
        </div>
      </div>
      <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
        {tabs.map(([k,l])=><button key={k} className={`sub-tab ${tab===k?'active':''}`} style={{padding:'4px 14px',fontSize:12}} onClick={()=>setTab(k)}>{l}</button>)}
      </div>
    </div>

    {tab === 'dashboard' && <DashboardReport
      invoices={scopedInvoices} pmts={scopedPmts} students={scopedStudents}
      pendingCredits={pendingCredits} creditBalances={creditBalances}
      sessions={sessions} lastAttendedByStu={lastAttendedByStu}
      today={today} todayMs={todayMs} rm={rm} studentById2={studentById2}
      branchById2={branchById2} branchScope={branchScope}
    />}

    {tab === 'retention' && <RetentionReport
      students={scopedStudents} pmts={scopedPmts}
      lastAttendedByStu={lastAttendedByStu} sessions={sessions}
      today={today} todayMs={todayMs} rm={rm} studentById2={studentById2}
    />}
  </>;
}

// ── Dashboard tab ───────────────────────────────────────────────────────────
function DashboardReport({ invoices, pmts, students, pendingCredits, creditBalances, sessions, lastAttendedByStu, today, todayMs, rm, studentById2, branchById2, branchScope }){
  // Current month boundaries
  const monthStart = today.slice(0,7) + '-01';
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const dayOfMonth = now.getDate();

  // Cash collected this month
  const thisMonthPmts = pmts.filter(p => (p.payment_date||'') >= monthStart && (p.payment_date||'') <= today);
  const cashThisMonth = thisMonthPmts.reduce((s,p)=>s+Number(p.amount||0),0);

  // Same month last year — only if data exists going back that far
  const lastYearStart = `${now.getFullYear()-1}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const lastYearEnd   = `${now.getFullYear()-1}-${String(now.getMonth()+1).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;
  const lastYearSamePmts = pmts.filter(p => (p.payment_date||'') >= lastYearStart && (p.payment_date||'') <= lastYearEnd);
  const cashLastYear = lastYearSamePmts.reduce((s,p)=>s+Number(p.amount||0),0);
  const yoyDelta = cashLastYear > 0 ? Math.round((cashThisMonth - cashLastYear)/cashLastYear*100) : null;

  // Pace projection
  const projection = dayOfMonth > 0 ? Math.round(cashThisMonth / dayOfMonth * daysInMonth) : 0;

  // Outstanding receivables
  const outstanding = invoices.filter(i => i.status !== 'paid' && i.status !== 'void' && i.status !== 'refunded')
    .reduce((s,i) => s + Math.max(0, Number(i.total_amount||0) - Number(i.amount_paid||0)), 0);

  // Deferred revenue — sum of remaining credit balances multiplied by an estimated
  // per-credit value. We don't have a clean per-credit price, so use:
  //   per-credit value = total credit_purchases value / total credits purchased
  // This is the most defensible business approximation.
  const totalCreditsRemaining = (creditBalances||[]).reduce((s,c)=>s+Number(c.remaining_balance||0),0);
  // Approximate per-credit value from confirmed pending credits: amount / credits
  const confirmedCredits = (pendingCredits||[]).filter(p => p.status === 'confirmed');
  let perCreditValue = 0;
  if(confirmedCredits.length > 0){
    const totalValue = confirmedCredits.reduce((s,p)=>s+Number(p.amount||0),0);
    const totalCredits = confirmedCredits.reduce((s,p)=>s+Number(p.credits_per_swimmer||p.initial_balance||4),0);
    if(totalCredits > 0) perCreditValue = totalValue / totalCredits;
  }
  const deferredRevenue = totalCreditsRemaining * perCreditValue;

  // ── At-risk swimmers: last attended >30d ago AND credit ≤ 1 ──
  const balanceByStu = useMemo(()=>{
    const m = {};
    (creditBalances||[]).forEach(c => {
      const sid = c.student_id;
      if(!sid) return;
      m[sid] = (m[sid]||0) + Number(c.remaining_balance||0);
    });
    return m;
  },[creditBalances]);

  const atRisk = students.filter(s => s.isActive !== false).map(s => {
    const last = lastAttendedByStu[s.id];
    const daysSince = last ? Math.floor((todayMs - new Date(last).getTime())/86400000) : 999;
    const bal = balanceByStu[s.id] || 0;
    return { swimmer: s, daysSince, lastAttended: last, balance: bal };
  }).filter(r => r.daysSince >= 30 && r.balance <= 1)
    .sort((a,b) => b.daysSince - a.daysSince);

  // ── Overdue invoices ──
  const overdueInvs = invoices.filter(i =>
    i.status !== 'paid' && i.status !== 'void' && i.status !== 'refunded' &&
    i.due_date && i.due_date < today
  ).map(i => ({
    inv: i,
    owed: Math.max(0, Number(i.total_amount||0) - Number(i.amount_paid||0)),
    daysOverdue: Math.floor((todayMs - new Date(i.due_date).getTime())/86400000)
  })).sort((a,b)=>b.daysOverdue - a.daysOverdue);

  // ── Cash by payment method (last 30 days) ──
  const last30 = pmts.filter(p => (p.payment_date||'') >= monthAgoStr(30));
  const byMethod = {};
  last30.forEach(p => {
    const m = (p.payment_method||'unknown').toLowerCase();
    byMethod[m] = (byMethod[m]||0) + Number(p.amount||0);
  });
  const methodRows = Object.entries(byMethod).sort((a,b)=>b[1]-a[1]);
  const methodTotal = methodRows.reduce((s,[,v])=>s+v,0);

  return <>
    {/* ── KPI Row ── */}
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:12}}>
      <KpiCard
        label={`Cash · ${now.toLocaleDateString(undefined,{month:'long'})}`}
        value={rm(cashThisMonth)}
        color="var(--green-tx)"
        sub={yoyDelta !== null
          ? `${yoyDelta >= 0 ? '↑' : '↓'} ${Math.abs(yoyDelta)}% vs last year (${rm(cashLastYear)})`
          : `Day ${dayOfMonth} of ${daysInMonth}`}
      />
      <KpiCard
        label="Month-end projection"
        value={rm(projection)}
        color="var(--primary)"
        sub={`Pace: ${rm(cashThisMonth/Math.max(dayOfMonth,1))} per day`}
      />
      <KpiCard
        label="Outstanding (AR)"
        value={rm(outstanding)}
        color="var(--amber-tx)"
        sub={`${invoices.filter(i=>i.status!=='paid'&&i.status!=='void'&&i.status!=='refunded').length} open invoice${invoices.filter(i=>i.status!=='paid'&&i.status!=='void'&&i.status!=='refunded').length===1?'':'s'}`}
      />
      <KpiCard
        label="Deferred revenue"
        value={rm(deferredRevenue)}
        color="#7C3AED"
        sub={`${totalCreditsRemaining} credits unredeemed · ~${rm(perCreditValue)}/credit`}
      />
    </div>

    {/* ── Alert row: At-risk + Overdue ── */}
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12}}>
      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:8}}>
          <div style={{fontSize:13,fontWeight:800}}>⚠️ At-risk swimmers ({atRisk.length})</div>
          <div className="small subtle">No class in 30+ days · low credit</div>
        </div>
        {atRisk.length === 0 && <div className="small subtle" style={{padding:'12px 0'}}>None — every active swimmer attended recently or has credit remaining.</div>}
        {atRisk.length > 0 && <div className="table-wrap" style={{maxHeight:260,overflow:'auto'}}>
          <table>
            <thead><tr>
              <th>Swimmer</th>
              <th style={{textAlign:'right'}}>Days since</th>
              <th style={{textAlign:'right'}}>Balance</th>
            </tr></thead>
            <tbody>
              {atRisk.slice(0, 30).map(r => <tr key={r.swimmer.id}>
                <td><div style={{fontWeight:600}}>{r.swimmer.name}</div><div className="small subtle">{r.swimmer.guardianName||'—'} · {r.swimmer.guardianPhone||r.swimmer.guardianEmail||'—'}</div></td>
                <td style={{textAlign:'right',color:r.daysSince>=90?'var(--red-tx)':r.daysSince>=60?'#F97316':'var(--amber-tx)',fontWeight:700}}>{r.daysSince>=999?'never':`${r.daysSince}d`}</td>
                <td style={{textAlign:'right'}}>{r.balance} cr</td>
              </tr>)}
            </tbody>
          </table>
          {atRisk.length > 30 && <div className="small subtle" style={{padding:'8px 12px'}}>+ {atRisk.length-30} more</div>}
        </div>}
        <div className="small subtle" style={{marginTop:8,fontStyle:'italic'}}>📞 A friendly call this week recovers most of these. They haven't decided to quit yet — they just got busy.</div>
      </div>

      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:8}}>
          <div style={{fontSize:13,fontWeight:800}}>📋 Overdue invoices ({overdueInvs.length})</div>
          <div className="small subtle">{rm(overdueInvs.reduce((s,r)=>s+r.owed,0))} total</div>
        </div>
        {overdueInvs.length === 0 && <div className="small subtle" style={{padding:'12px 0'}}>None — all invoices either current or paid.</div>}
        {overdueInvs.length > 0 && <div className="table-wrap" style={{maxHeight:260,overflow:'auto'}}>
          <table>
            <thead><tr>
              <th>Account</th>
              <th style={{textAlign:'right'}}>Owed</th>
              <th style={{textAlign:'right'}}>Overdue</th>
            </tr></thead>
            <tbody>
              {overdueInvs.slice(0, 30).map(r => <tr key={r.inv.id}>
                <td><div style={{fontWeight:600}}>{r.inv.account_name}</div><div className="small subtle">{r.inv.invoice_number} · due {r.inv.due_date}</div></td>
                <td style={{textAlign:'right',fontWeight:700,color:'var(--red-tx)'}}>{rm(r.owed)}</td>
                <td style={{textAlign:'right'}}>{r.daysOverdue}d</td>
              </tr>)}
            </tbody>
          </table>
          {overdueInvs.length > 30 && <div className="small subtle" style={{padding:'8px 12px'}}>+ {overdueInvs.length-30} more</div>}
        </div>}
      </div>
    </div>

    {/* ── Cash by Payment Method ── */}
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>💰 Cash collected by method · last 30 days</div>
      {methodRows.length === 0 && <div className="small subtle">No payments recorded in the last 30 days.</div>}
      {methodRows.length > 0 && <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {methodRows.map(([m,v]) => <div key={m} style={{display:'grid',gridTemplateColumns:'150px 1fr 120px 60px',gap:10,alignItems:'center'}}>
          <span style={{fontSize:12,fontWeight:600,color:'var(--text-2)',textTransform:'capitalize'}}>{m}</span>
          <div style={{height:14,borderRadius:4,background:'var(--border)',overflow:'hidden'}}>
            <div style={{height:'100%',borderRadius:4,background:'var(--primary)',width:Math.round(v/methodTotal*100)+'%',minWidth:2}} />
          </div>
          <span style={{fontSize:12,fontWeight:700,textAlign:'right'}}>{rm(v)}</span>
          <span style={{fontSize:11,color:'var(--text-3)',textAlign:'right'}}>{Math.round(v/methodTotal*100)}%</span>
        </div>)}
      </div>}
    </div>
  </>;
}

// ── Retention tab ────────────────────────────────────────────────────────────
function RetentionReport({ students, pmts, lastAttendedByStu, sessions, today, todayMs, rm, studentById2 }){
  // Build attendance set per swimmer: months they were active in
  // "Active in month M" = attended a session OR was enrolled with positive balance
  const attendedMonthsByStu = useMemo(()=>{
    const m = {};
    sessions.forEach(s => {
      const sessionDate = addDays(s.weekStartDate || '', s.day);
      if(!sessionDate || sessionDate > today) return;
      const mk = sessionDate.slice(0,7);
      (s.students || []).forEach(st => {
        const sid = st.studentId;
        if(!sid) return;
        const att = st.attendance || st.attendance_status || 'pending';
        if(att === 'absent' || att === 'no_show') return;
        if(!m[sid]) m[sid] = new Set();
        m[sid].add(mk);
      });
    });
    return m;
  }, [sessions, today]);

  // Cohort: group students by month of created_at
  const cohorts = useMemo(() => {
    const c = {};
    students.forEach(s => {
      const created = (s.createdAt || s.created_at || '').slice(0,7);
      if(!created) return;
      if(!c[created]) c[created] = [];
      c[created].push(s);
    });
    return c;
  }, [students]);

  // For each cohort, % active at month N (where N=0..11 after signup)
  const cohortKeys = Object.keys(cohorts).sort();
  const lastCohort = cohortKeys.length ? cohortKeys[cohortKeys.length-1] : null;

  function monthsAfter(cohortMk, n){
    const [y,m] = cohortMk.split('-').map(Number);
    const d = new Date(y, m-1+n, 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  const cohortRows = cohortKeys.slice(-12).reverse().map(ck => {
    const members = cohorts[ck];
    const size = members.length;
    const buckets = Array.from({length:12}, (_, n) => {
      const targetMk = monthsAfter(ck, n);
      // Only count cells where target month has already occurred
      if(targetMk > today.slice(0,7)) return null;
      const activeCount = members.filter(s => {
        const mset = attendedMonthsByStu[s.id];
        return mset && mset.has(targetMk);
      }).length;
      return size > 0 ? Math.round(activeCount / size * 100) : 0;
    });
    return { cohort: ck, size, buckets };
  });

  // LTV calculation — per-account total payments × months active
  // Build account → { totalPaid, firstAct, lastAct, swimmerCount }
  const accountAgg = {};
  const swimmerToAccount = {};
  students.forEach(s => {
    const key = s.accountId || `__legacy__${s.guardianEmail||s.guardianName||s.id}`;
    swimmerToAccount[s.id] = key;
    if(!accountAgg[key]) accountAgg[key] = { swimmers:new Set(), name:s.guardianName||'?', firstAct:null, lastAct:null, totalPaid:0 };
    accountAgg[key].swimmers.add(s.id);
    const last = lastAttendedByStu[s.id];
    if(last){
      if(!accountAgg[key].firstAct || last < accountAgg[key].firstAct) accountAgg[key].firstAct = last;
      if(!accountAgg[key].lastAct  || last > accountAgg[key].lastAct)  accountAgg[key].lastAct  = last;
    }
  });

  // LTV summary
  const allAccounts = Object.values(accountAgg);
  const activeAccounts = allAccounts.filter(a => a.lastAct);
  const totalSwimmers = students.length;
  const totalActiveSwimmers = students.filter(s => {
    const last = lastAttendedByStu[s.id];
    if(!last) return false;
    return (todayMs - new Date(last).getTime())/86400000 <= 30;
  }).length;

  // Average months active across all accounts with both first and last
  const monthsActiveList = allAccounts.filter(a => a.firstAct && a.lastAct).map(a => {
    const months = (new Date(a.lastAct).getFullYear() - new Date(a.firstAct).getFullYear())*12 +
                   (new Date(a.lastAct).getMonth() - new Date(a.firstAct).getMonth()) + 1;
    return Math.max(1, months);
  });
  const avgMonthsActive = monthsActiveList.length ? Math.round(monthsActiveList.reduce((s,x)=>s+x,0)/monthsActiveList.length) : 0;

  // Total revenue ÷ total swimmers = avg revenue per swimmer
  const totalRevenue = pmts.reduce((s,p)=>s+Number(p.amount||0),0);
  const avgRevenuePerSwimmer = totalSwimmers > 0 ? totalRevenue / totalSwimmers : 0;
  const avgLTV = avgMonthsActive > 0 ? avgRevenuePerSwimmer : 0; // already cumulative
  const avgMonthlyValue = avgMonthsActive > 0 ? avgLTV / avgMonthsActive : 0;

  // Churn: never attended OR last attended >60 days ago
  const churnedSwimmers = students.filter(s => {
    const last = lastAttendedByStu[s.id];
    if(!last) return false; // never attended ≠ churned, they may be brand new
    return (todayMs - new Date(last).getTime())/86400000 > 60;
  });
  const churnRate = totalSwimmers > 0 ? Math.round(churnedSwimmers.length / totalSwimmers * 100) : 0;

  // Color cell by retention bucket
  function cellColor(pct){
    if(pct === null) return 'transparent';
    if(pct >= 75) return '#86EFAC';
    if(pct >= 50) return '#FDE68A';
    if(pct >= 25) return '#FCA5A5';
    return '#FECACA';
  }

  function fmtCohort(mk){
    try{ const [y,m]=mk.split('-'); return new Date(y,m-1,1).toLocaleDateString(undefined,{month:'short',year:'2-digit'}); }catch(_){return mk;}
  }

  return <>
    {/* LTV KPI row */}
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:12}}>
      <KpiCard label="Average LTV per swimmer" value={rm(avgLTV)} color="var(--primary)"
        sub={`${rm(avgMonthlyValue)}/mo · ${avgMonthsActive} mo avg lifetime`} />
      <KpiCard label="Active swimmers" value={`${totalActiveSwimmers} / ${totalSwimmers}`}
        color="var(--green-tx)" sub={`${Math.round(totalActiveSwimmers/Math.max(totalSwimmers,1)*100)}% attended in last 30d`} />
      <KpiCard label="Churned (60+d inactive)" value={churnedSwimmers.length} color="var(--red-tx)"
        sub={`${churnRate}% of total roster`} />
      <KpiCard label="Total accounts tracked" value={allAccounts.length}
        color="var(--text)" sub={`${activeAccounts.length} have attendance recorded`} />
    </div>

    {/* Cohort table */}
    <div className="card" style={{marginBottom:12,padding:0,overflow:'hidden'}}>
      <div style={{padding:'12px 14px',borderBottom:'1px solid var(--border)'}}>
        <div style={{fontSize:13,fontWeight:800}}>Cohort retention — % of swimmers still attending each month after signup</div>
        <div className="small subtle" style={{marginTop:3}}>
          Healthy benchmarks: 75%+ at month 3 (green) · 50–75% (yellow) · below 50% needs intervention (red). Last 12 cohorts shown.
        </div>
      </div>
      {cohortRows.length === 0 && <div className="empty" style={{padding:24}}>No cohort data yet — need swimmer signup dates and recorded attendance.</div>}
      {cohortRows.length > 0 && <div style={{overflow:'auto'}}>
        <table style={{width:'100%',borderCollapse:'separate',borderSpacing:0,fontSize:11}}>
          <thead>
            <tr style={{background:'var(--surface-2)'}}>
              <th style={{padding:'8px 10px',textAlign:'left',position:'sticky',left:0,background:'var(--surface-2)',zIndex:1,minWidth:90}}>Cohort</th>
              <th style={{padding:'8px 6px',textAlign:'right'}}>Size</th>
              {Array.from({length:12},(_,i)=><th key={i} style={{padding:'8px 4px',textAlign:'center',minWidth:42}}>M{i}</th>)}
            </tr>
          </thead>
          <tbody>
            {cohortRows.map(r => <tr key={r.cohort}>
              <td style={{padding:'6px 10px',fontWeight:600,position:'sticky',left:0,background:'var(--surface)',zIndex:1}}>{fmtCohort(r.cohort)}</td>
              <td style={{padding:'6px',textAlign:'right',fontWeight:600,color:'var(--text-2)'}}>{r.size}</td>
              {r.buckets.map((pct,i)=><td key={i} style={{padding:'6px 4px',textAlign:'center',background:cellColor(pct),color:pct===null?'transparent':'#000',fontWeight:600}}>
                {pct === null ? '—' : pct + '%'}
              </td>)}
            </tr>)}
          </tbody>
        </table>
      </div>}
    </div>

    {/* Activity distribution */}
    <div className="card">
      <div style={{fontSize:13,fontWeight:800,marginBottom:10}}>Roster activity distribution</div>
      <div className="small subtle" style={{marginBottom:12}}>How recently each currently-marked-active swimmer was seen in class.</div>
      {(()=>{ const buckets = { '0-7d':0, '8-30d':0, '31-60d':0, '61-90d':0, '90+d':0, 'never':0 };
        students.filter(s=>s.isActive!==false).forEach(s => {
          const last = lastAttendedByStu[s.id];
          if(!last){ buckets['never']++; return; }
          const days = Math.floor((todayMs - new Date(last).getTime())/86400000);
          if(days <= 7) buckets['0-7d']++;
          else if(days <= 30) buckets['8-30d']++;
          else if(days <= 60) buckets['31-60d']++;
          else if(days <= 90) buckets['61-90d']++;
          else buckets['90+d']++;
        });
        const max = Math.max(...Object.values(buckets), 1);
        const colors = { '0-7d':'var(--green-tx)', '8-30d':'#84CC16', '31-60d':'var(--amber-tx)', '61-90d':'#F97316', '90+d':'var(--red-tx)', 'never':'#9CA3AF' };
        return <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {Object.entries(buckets).map(([k,v])=><div key={k} style={{display:'grid',gridTemplateColumns:'90px 1fr 60px',gap:10,alignItems:'center'}}>
            <span style={{fontSize:12,fontWeight:600,color:'var(--text-2)'}}>{k}</span>
            <div style={{height:18,borderRadius:5,background:'var(--border)',overflow:'hidden'}}>
              <div style={{height:'100%',borderRadius:5,background:colors[k],width:Math.round(v/max*100)+'%',minWidth:2}} />
            </div>
            <span style={{fontSize:12,fontWeight:700,textAlign:'right'}}>{v}</span>
          </div>)}
        </div>;
      })()}
    </div>
  </>;
}

// ── KpiCard — reusable big-number tile ──────────────────────────────────────
function KpiCard({ label, value, color, sub }){
  return <div className="card" style={{padding:'12px 14px'}}>
    <div className="small subtle" style={{fontSize:11}}>{label}</div>
    <div style={{fontSize:24,fontWeight:800,color,marginTop:3,letterSpacing:'-.3px'}}>{value}</div>
    {sub && <div className="small subtle" style={{fontSize:10.5,marginTop:4}}>{sub}</div>}
  </div>;
}

// Helper used by Dashboard — defined at module scope
function monthAgoStr(n){ const d = new Date(); d.setDate(d.getDate()-n); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function AgingReportView({ invoices, pmts, branches }){
  const [sortBy,setSortBy]=useState('outstanding');
  const [dateFrom,setDateFrom]=useState('');
  const [dateTo,setDateTo]=useState('');
  const today=todayStr();
  const todayMs=new Date(today).getTime();

  // Filter invoices by date range (issue_date)
  const filteredInvs=invoices.filter(inv=>{
    if(dateFrom && inv.issue_date && inv.issue_date < dateFrom) return false;
    if(dateTo   && inv.issue_date && inv.issue_date > dateTo)   return false;
    return true;
  });

  const accountMap={};
  filteredInvs.forEach(inv=>{
    // Void and refunded invoices are excluded from EVERY column. The old
    // code summed them into Invoiced/Paid while the aging buckets skipped
    // them — a voided invoice with any recorded payment produced phantom
    // "Outstanding" that appeared in no bucket and had no open invoices.
    if(inv.status==='void'||inv.status==='refunded') return;
    const key=inv.account_name;
    if(!accountMap[key]) accountMap[key]={ account:key, invoices:[], totalInvoiced:0, totalPaid:0 };
    accountMap[key].invoices.push(inv);
    accountMap[key].totalInvoiced+=Number(inv.total_amount||0);
    accountMap[key].totalPaid+=Number(inv.amount_paid||0);
  });

  const rows=Object.values(accountMap).map(a=>{
    const outstanding=Math.max(0,a.totalInvoiced-a.totalPaid);
    let current=0,d1_30=0,d31_60=0,d60plus=0;
    a.invoices.forEach(inv=>{
      if(inv.status==='paid'||inv.status==='void'||inv.status==='refunded') return;
      const owed=Math.max(0,Number(inv.total_amount)-Number(inv.amount_paid));
      if(!owed) return;
      if(!inv.due_date){ current+=owed; return; }
      const age=Math.floor((todayMs-new Date(inv.due_date).getTime())/(86400000));
      if(age<=0) current+=owed;
      else if(age<=30) d1_30+=owed;
      else if(age<=60) d31_60+=owed;
      else d60plus+=owed;
    });
    const openInvs=a.invoices.filter(i=>i.status!=='paid'&&i.status!=='void'&&i.status!=='refunded');
    const oldestDue=openInvs.map(i=>i.due_date).filter(Boolean).sort()[0]||null;
    const isOverdue=d1_30>0||d31_60>0||d60plus>0;
    return { account:a.account, totalInvoiced:a.totalInvoiced, totalPaid:a.totalPaid, outstanding, current, d1_30, d31_60, d60plus, openCount:openInvs.length, oldestDue, isOverdue };
  }).filter(r=>r.totalInvoiced>0);

  rows.sort((a,b)=>{
    if(sortBy==='outstanding') return b.outstanding-a.outstanding;
    if(sortBy==='account') return a.account.localeCompare(b.account);
    if(sortBy==='oldest') return (a.oldestDue||'9999')>(b.oldestDue||'9999')?1:-1;
    return 0;
  });

  const totals=rows.reduce((s,r)=>({ invoiced:s.invoiced+r.totalInvoiced, paid:s.paid+r.totalPaid, outstanding:s.outstanding+r.outstanding, current:s.current+r.current, d1_30:s.d1_30+r.d1_30, d31_60:s.d31_60+r.d31_60, d60plus:s.d60plus+r.d60plus }),{ invoiced:0,paid:0,outstanding:0,current:0,d1_30:0,d31_60:0,d60plus:0 });

  const rm=(v)=>`RM ${v.toFixed(2)}`;

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>Aging Report</div>
          <div className="small subtle">Outstanding balances by account, bucketed by how overdue they are. As of {today}.</div>
        </div>
        <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
          <div><div className="small subtle">Total Outstanding</div><div style={{fontSize:20,fontWeight:800,color:'var(--amber-tx)'}}>{rm(totals.outstanding)}</div></div>
          <div><div className="small subtle" style={{color:'var(--red-tx)'}}>60+ Days</div><div style={{fontSize:20,fontWeight:800,color:'var(--red-tx)'}}>{rm(totals.d60plus)}</div></div>
        </div>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <span className="small subtle">Date range (issue date):</span>
        <input type="date" className="input" style={{width:150,padding:'4px 8px',fontSize:12}} value={dateFrom} onChange={e=>setDateFrom(e.target.value)} />
        <span className="small subtle">to</span>
        <input type="date" className="input" style={{width:150,padding:'4px 8px',fontSize:12}} value={dateTo} onChange={e=>setDateTo(e.target.value)} />
        {(dateFrom||dateTo)&&<button className="btn btn-ghost small" onClick={()=>{setDateFrom('');setDateTo('');}}>Clear</button>}
        <span style={{marginLeft:'auto',display:'flex',gap:6,alignItems:'center'}}>
          <span className="small subtle">Sort:</span>
          {[['outstanding','Outstanding'],['account','Account'],['oldest','Oldest Due']].map(([k,l])=><button key={k} className={`tab ${sortBy===k?'active':''}`} style={{padding:'4px 10px',fontSize:11,borderRadius:6}} onClick={()=>setSortBy(k)}>{l}</button>)}
        </span>
      </div>
    </div>

    {rows.length===0&&<div className="card empty" style={{padding:28}}>No invoiced accounts{dateFrom||dateTo?' in this date range':''} yet.</div>}

    {rows.length>0&&<div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Invoiced</th>
            <th className="num">Paid</th>
            <th className="num">Outstanding</th>
            <th className="num" title="Not yet due">Current</th>
            <th className="num" style={{color:'var(--amber-tx)'}}>1–30d</th>
            <th className="num" style={{color:'#F97316'}}>31–60d</th>
            <th className="num" style={{color:'var(--red-tx)'}}>60+d</th>
            <th className="num">Open Inv.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r=><tr key={r.account} style={{background:r.d60plus>0?'rgba(239,68,68,.06)':r.d31_60>0?'rgba(249,115,22,.04)':''}}>
            <td>
              <div style={{fontWeight:700}}>{r.account}</div>
              {r.isOverdue&&r.oldestDue&&<div style={{fontSize:10,color:'#EF4444'}}>Overdue since {r.oldestDue}</div>}
            </td>
            <td className="num">{rm(r.totalInvoiced)}</td>
            <td className="num" style={{color:'#10B981'}}>{rm(r.totalPaid)}</td>
            <td className="num" style={{fontWeight:800,color:r.outstanding>0?'#F59E0B':'#10B981'}}>{r.outstanding>0?rm(r.outstanding):'\u2713'}</td>
            <td className="num">{r.current>0?rm(r.current):'-'}</td>
            <td className="num" style={{color:r.d1_30>0?'#F59E0B':''}}>{r.d1_30>0?rm(r.d1_30):'-'}</td>
            <td className="num" style={{color:r.d31_60>0?'#F97316':''}}>{r.d31_60>0?rm(r.d31_60):'-'}</td>
            <td className="num" style={{fontWeight:r.d60plus>0?800:400,color:r.d60plus>0?'#EF4444':''}}>{r.d60plus>0?rm(r.d60plus):'-'}</td>
            <td className="num">{r.openCount}</td>
          </tr>)}
        </tbody>
        <tfoot>
          <tr style={{borderTop:'2px solid var(--border)',fontWeight:800}}>
            <td>Totals ({rows.length} accounts)</td>
            <td className="num">{rm(totals.invoiced)}</td>
            <td className="num" style={{color:'#10B981'}}>{rm(totals.paid)}</td>
            <td className="num" style={{color:'#F59E0B'}}>{rm(totals.outstanding)}</td>
            <td className="num">{totals.current>0?rm(totals.current):'-'}</td>
            <td className="num" style={{color:totals.d1_30>0?'#F59E0B':''}}>{totals.d1_30>0?rm(totals.d1_30):'-'}</td>
            <td className="num" style={{color:totals.d31_60>0?'#F97316':''}}>{totals.d31_60>0?rm(totals.d31_60):'-'}</td>
            <td className="num" style={{fontWeight:800,color:totals.d60plus>0?'#EF4444':''}}>{totals.d60plus>0?rm(totals.d60plus):'-'}</td>
            <td className="num"></td>
          </tr>
        </tfoot>
      </table>
    </div>}

    <div className="small subtle" style={{marginTop:10}}>
      Age buckets are calculated from invoice due dates. Invoices without a due date are counted as Current. Paid, voided, and refunded invoices are excluded.
    </div>
  </>;
}


function ReceiptsView({ pmts, invoices, branches, externalSearchQ }){
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [branchFilter, setBranchFilter] = useState(null);
  const [methodFilter, setMethodFilter] = useState('all');   // 'all' | code | '__others'
  const [monthFilter, setMonthFilter] = useState('all');     // 'all' | 'YYYY-MM' (payment date)
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;
  const invoiceById = {};
  (invoices || []).forEach(inv => { invoiceById[inv.id] = inv; });
  const knownCodes = new Set(allMethods().map(m=>m.code));
  const monthOptions = useMemo(()=>{
    const s=new Set();
    (pmts||[]).forEach(p=>{ if(p.payment_date) s.add(String(p.payment_date).slice(0,7)); });
    return [...s].sort().reverse();
  },[pmts]);
  const sorted = (pmts || []).slice().sort((a,b) => (b.payment_date||'').localeCompare(a.payment_date||''));
  const filtered = sorted.filter(p => {
    const inv = invoiceById[p.invoice_id] || {};
    if(branchFilter && inv.branch_id !== branchFilter) return false;
    if(monthFilter!=='all' && String(p.payment_date||'').slice(0,7)!==monthFilter) return false;
    if(methodFilter!=='all'){
      const mc=(p.payment_method||'').toLowerCase();
      if(methodFilter==='__others'){ if(knownCodes.has(mc)) return false; }
      else if(mc!==methodFilter) return false;
    }
    if(!searchQ.trim()) return true;
    const q = searchQ.toLowerCase();
    return (
      (p.receipt_number||'').toLowerCase().includes(q) ||
      (inv.invoice_number||'').toLowerCase().includes(q) ||
      (inv.account_name||'').toLowerCase().includes(q) ||
      (p.payment_method||'').toLowerCase().includes(q)
    );
  });
  const total = filtered.reduce((s,p)=>s+Number(p.amount||0),0);
  const pageCount = Math.max(1, Math.ceil(filtered.length/PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = filtered.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE);
  useEffect(()=>{ setPage(1); },[branchFilter,methodFilter,monthFilter,searchQ]);
  function fmtDate(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); } catch(_){ return d; } }
  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div><div style={{fontSize:18,fontWeight:800}}>💰 Receipts</div>
          <div className="small subtle" style={{marginTop:3}}>All recorded payments. Click 🖨 to print a receipt.</div>
        </div>
        <div><div className="small subtle">Total collected{branchFilter?' (filtered)':''}</div><div style={{fontSize:22,fontWeight:800,color:'var(--green-tx)'}}>RM{total.toFixed(2)}</div></div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        {externalSearchQ === undefined && <input className="input" style={{flex:1,maxWidth:320}} placeholder="Search receipt #, invoice #, account, method…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />}
        <BranchFilterPills branches={branches} value={branchFilter} onChange={setBranchFilter} />
        <select className="select" value={methodFilter} onChange={e=>setMethodFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',maxWidth:160}}>
          <option value="all">💳 All methods</option>
          {allMethods().map(m=><option key={m.code} value={m.code}>{m.label}</option>)}
          <option value="__others">Others / unknown</option>
        </select>
        <select className="select" value={monthFilter} onChange={e=>setMonthFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',maxWidth:140}}>
          <option value="all">📅 All months</option>
          {monthOptions.map(m=><option key={m} value={m}>{m}</option>)}
        </select>
        <span className="small subtle">{filtered.length} / {(pmts||[]).length}</span>
      </div>
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0,maxHeight:'70vh'}}>
        <table><thead><tr>
          <th style={{width:110}}>Date</th>
          <th style={{width:130}}>Receipt #</th>
          <th style={{width:130}}>Invoice #</th>
          <th>Account</th>
          <th style={{width:110}}>Method</th>
          <th style={{width:110,textAlign:'right'}}>Amount</th>
          <th style={{width:60}}></th>
        </tr></thead>
        <tbody>
          {filtered.length === 0 && <tr><td colSpan={7} className="empty">No receipts found.</td></tr>}
          {paged.map(p => {
            const inv = invoiceById[p.invoice_id] || {};
            const isRef = p.kind==='refund' || Number(p.amount)<0;
            return <tr key={p.id}>
              <td>{fmtDate(p.payment_date)}</td>
              <td style={{fontFamily:'monospace',fontSize:12}}>{p.receipt_number||'—'}</td>
              <td style={{fontFamily:'monospace',fontSize:12}}>{inv.invoice_number||'—'}</td>
              <td style={{fontWeight:600}}>{inv.account_name||'—'}</td>
              <td><MethodPill code={p.payment_method} small/>{isRef?<span className="small subtle"> · Refund</span>:null}</td>
              <td style={{textAlign:'right',fontWeight:700,color:isRef?'#DC2626':'var(--green-tx)'}}>{isRef?'−':''}RM{Math.abs(Number(p.amount)).toFixed(2)}</td>
              <td style={{textAlign:'center'}}>
                <button className="btn btn-ghost small" title="Print receipt" onClick={()=>printReceipt(p, inv)}>🖨</button>
              </td>
            </tr>;
          })}
        </tbody>
        </table>
      </div>
    </div>
    {pageCount>1&&<div style={{display:'flex',gap:4,justifyContent:'center',alignItems:'center',marginTop:14,flexWrap:'wrap'}}>
      <button className="btn btn-ghost small" disabled={safePage<=1} onClick={()=>setPage(safePage-1)}>‹ Prev</button>
      {Array.from({length:pageCount},(_,i)=>i+1)
        .filter(n=>n===1||n===pageCount||Math.abs(n-safePage)<=2)
        .reduce((acc,n,idx,arr)=>{ if(idx>0&&n-arr[idx-1]>1) acc.push('…'); acc.push(n); return acc; },[])
        .map((n,i)=> n==='…'
          ? <span key={'gap'+i} className="small subtle" style={{padding:'0 4px'}}>…</span>
          : <button key={n} className={`btn small ${n===safePage?'btn-primary':'btn-ghost'}`} style={{minWidth:34}} onClick={()=>setPage(n)}>{n}</button>)}
      <button className="btn btn-ghost small" disabled={safePage>=pageCount} onClick={()=>setPage(safePage+1)}>Next ›</button>
      <span className="small subtle" style={{marginLeft:8}}>Page {safePage} of {pageCount} · {filtered.length} receipts</span>
    </div>}
  </>;
}
function StudentsView({ students, lessonTypes, lessonTypeById, packages, packageById, groupById, familyGroups, membersByGroup, scheduleByStudent, sessions, jumpToWeek, creditByKey, purchasesByStudent, subscriptions, addCreditPurchase, deleteCreditPurchase, addSubscription, cancelSubscription, adjustBalanceTo, addStudent, updateStudent, deleteStudent, externalSearchQ }){
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState(null);
  const [enrollments, setEnrollments] = useState([{ lessonTypeId: '', packageId: '' }]);
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [sameAsGuardian, setSameAsGuardian] = useState(false);
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [emergencyRel, setEmergencyRel] = useState('');
  const [adultSelf, setAdultSelf] = useState(false);
  const [editId, setEditId] = useState(null);
  const [creditId, setCreditId] = useState(null);
  const [localQ, setLocalQ] = useState('');
  // Prefer the sticky sub-bar search when provided
  const q = externalSearchQ !== undefined ? externalSearchQ : localQ;
  const setQ = setLocalQ;
  const [sortBy, setSortBy] = useState('name');
  const [formExpanded, setFormExpanded] = useState(false);

  // nextScheduledByStudentLt: for each (studentId, lessonTypeId) and for
  // each (day, startMinute) slot the swimmer recurs in, find the earliest
  // weekStartDate (≥ current week) when an actual session exists for that
  // slot in that lesson type with that swimmer enrolled. Used to make each
  // Schedule cell entry a clickable link that jumps the Weekly view to
  // exactly the right week — current week if a session exists there,
  // otherwise the next upcoming scheduled week (handles forwards,
  // duplicates-into-future, etc.).
  const nextScheduledByStudentLt = useMemo(() => {
    const todayWs = weekStartStr(todayStr());
    const out = {};   // studentId → lessonTypeId → weekStartDate
    (sessions || []).forEach(s => {
      if(s.cancelledAt) return;                       // skip ghosts
      if(!s.weekStartDate || s.weekStartDate < todayWs) return;
      (s.students || []).forEach(st => {
        const sid = st.studentId; if(!sid) return;
        if(!out[sid]) out[sid] = {};
        const prev = out[sid][s.lessonTypeId];
        if(!prev || s.weekStartDate < prev) out[sid][s.lessonTypeId] = s.weekStartDate;
      });
    });
    return out;
  }, [sessions]);
  function nextWeekFor(studentId, lessonTypeName){
    const ltId = (lessonTypes.find(lt => lt.name === lessonTypeName) || {}).id;
    if(!ltId) return null;
    return (nextScheduledByStudentLt[studentId] || {})[ltId] || null;
  }

  function colorsForId(id){ const t = lessonTypeById(id); return t ? { bg:t.bg_color, bd:t.border_color, tx:t.text_color, name:t.name } : { bg:'#eee', bd:'#ccc', tx:'#333', name:'(removed)' }; }
  function packageLabel(s){
    const g = s.familyGroupId && groupById ? groupById[s.familyGroupId] : null;
    if(g){ const gp = g.packageId ? packageById(g.packageId) : null; return `👪 ${g.name}${gp ? ` · ${gp.name}` : ''}`; }
    const p = s.packageId ? packageById(s.packageId) : null;
    if(p){ const b = billingText(p.billing_mode, p.billing_count); return `${p.name}${p.amount != null ? ` · RM${p.amount}` : ''}${b ? ` · ${b}` : ''}`; }
    return s.package || '—';
  }
  function scheduleLines(id){
    const slots = scheduleByStudent[id] || [];
    if(!slots.length) return null;
    const byType = {};
    slots.forEach(sl => { (byType[sl.type] = byType[sl.type] || []).push(sl); });
    return Object.keys(byType).map(type => ({ type, times: byType[type].map(sl => `${DAYS_S[sl.day]} ${minuteToTime(sl.startMinute)}`) }));
  }
  function creditInfo(s){
    const pkg = s.packageId ? packageById(s.packageId) : null;
    if(!pkg || pkg.billing_mode !== 'credit') return null;
    const ltId = pkg.lesson_type_id;
    if(!ltId || !creditByKey) return null;
    const bal = creditByKey[`${s.id}:${ltId}`];
    if(!bal) return null;
    const scheduled = (scheduleByStudent[s.id] || []).filter(sl => sl.lessonTypeId === ltId).length;
    return { remaining: bal.remaining_balance, initial: bal.initial_balance, scheduled };
  }
  function handleAdultSelf(v){ setAdultSelf(v); if(v) setGuardianName(name); }
  function handleSameAsG(v){ setSameAsGuardian(v); if(v){ setEmergencyPhone(guardianPhone); setEmergencyRel('Parent / Guardian'); } }

  const filtered = students.filter(s => {
    if(!q) return true;
    const ql = q.toLowerCase();
    return (s.name||'').toLowerCase().includes(ql)
        || (s.guardianName||'').toLowerCase().includes(ql)
        || (s.guardianPhone||'').toLowerCase().includes(ql)
        || (s.guardianEmail||'').toLowerCase().includes(ql);
  });

  // Always flat list — no group separators. All swimmers listed individually
  // regardless of family group membership (Groups tab handles group admin).
  const displayList = useMemo(() => {
    const sorted = filtered.slice().sort((a, b) => {
      if(sortBy === 'name')    return a.name.localeCompare(b.name);
      if(sortBy === 'type'){
        const tA = (a.lessonTypeIds?.[0] ? lessonTypeById(a.lessonTypeIds[0])?.name : '') || '';
        const tB = (b.lessonTypeIds?.[0] ? lessonTypeById(b.lessonTypeIds[0])?.name : '') || '';
        return tA.localeCompare(tB) || a.name.localeCompare(b.name);
      }
      if(sortBy === 'package'){
        const pA = (a.packageId ? packageById(a.packageId)?.name : '') || '';
        const pB = (b.packageId ? packageById(b.packageId)?.name : '') || '';
        return pA.localeCompare(pB) || a.name.localeCompare(b.name);
      }
      if(sortBy === 'parent') return (a.guardianName||'').localeCompare(b.guardianName||'') || a.name.localeCompare(b.name);
      return 0;
    });
    return sorted.map(s => ({ kind: 'swimmer', s }));
  }, [filtered, sortBy]);

  const COLS = 9;

  function resetForm(){ setName(''); setDob(''); setGender(null); setEnrollments([{ lessonTypeId: '', packageId: '' }]); setGuardianName(''); setGuardianEmail(''); setGuardianPhone(''); setSameAsGuardian(false); setEmergencyPhone(''); setEmergencyRel(''); setAdultSelf(false); }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        {externalSearchQ === undefined && <input className="input" style={{flex:'1 1 240px',maxWidth:380}} placeholder="Search swimmer name, parent, phone…"
          value={q} onChange={e=>setQ(e.target.value)} />}
        <div style={{display:'flex',gap:4,alignItems:'center',flexShrink:0}}>
          <span className="small subtle">Sort:</span>
          {[['name','Name'],['type','Lesson Type'],['package','Package'],['parent','Parent']].map(([k,lbl])=>(
            <button key={k}
              className={`sub-tab${sortBy===k?' active':''}`}
              style={{height:30,padding:'0 12px',fontSize:12}}
              onClick={()=>setSortBy(k)}>{lbl}</button>
          ))}
        </div>
        <span className="small subtle" style={{marginLeft:'auto'}}>{displayList.length} / {students.length} swimmers</span>
      </div>
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0}}>
        <table><thead><tr>
          <th style={{width:'14%'}}>Name</th>
          <th style={{width:32}}>Age</th>
          <th style={{width:'13%'}}>Parent</th>
          <th style={{width:'10%'}}>Emergency</th>
          <th style={{width:'10%'}}>Lesson Type</th>
          <th style={{width:'17%'}}>Package</th>
          <th style={{width:'9%'}}>Credits</th>
          <th style={{width:'5%'}}>T&amp;C</th>
          <th>Schedule</th>
        </tr></thead>
        <tbody>{displayList.length ? displayList.map((row,ri)=>{
          const s=row.s; const sched=scheduleLines(s.id);
          const tcOk = !!s.tcAcceptedAt;
          // Per-LT credit summary — show each LT's remaining balance as a chip
          const ltCredits = (s.lessonTypeIds || []).map(ltId => {
            const lt = lessonTypeById ? lessonTypeById(ltId) : null;
            const bal = creditByKey[`${s.id}:${ltId}`];
            const rem = bal ? Number(bal.remaining_balance) || 0 : null;
            return { lt, rem };
          });
          // Parent + emergency display
          const parentBits = [s.guardianName, s.guardianPhone].filter(Boolean);
          const emergencyBits = s.emergencySameAsGuardian
            ? <span className="subtle small" title="Same as guardian">↗ as guardian</span>
            : (s.emergencyPhone ? <><span>{s.emergencyPhone}</span>{s.emergencyRelationship ? <><br/><span className="subtle small">{s.emergencyRelationship}</span></> : null}</> : <span className="subtle">—</span>);
          return <React.Fragment key={s.id}>
            <tr>
              <td style={{fontWeight:700}}>{s.name}{s.gender?<span style={{marginLeft:4,fontSize:10,color:'var(--text-3)'}}>{s.gender==='female'?'♀':'♂'}</span>:null}</td>
              <td>{s.age!=null?s.age:'—'}</td>
              <td style={{fontSize:11}}>{parentBits.length
                ? <><div style={{fontWeight:600}}>{s.guardianName || '—'}</div>{s.guardianPhone ? <div className="subtle">{s.guardianPhone}</div> : null}</>
                : <span className="subtle">—</span>}</td>
              <td style={{fontSize:11}}>{emergencyBits}</td>
              <td><div style={{display:'flex',flexWrap:'wrap',gap:3}}>{(s.lessonTypeIds||[]).length?s.lessonTypeIds.map(id=>{const c=colorsForId(id);return <span key={id} className="chip" style={{background:c.bg,borderColor:c.bd,color:c.tx,fontSize:10,padding:'2px 7px'}}>{c.name}</span>;}): <span className="subtle">—</span>}</div></td>
              <td style={{fontSize:12}}>{packageLabel(s)}</td>
              <td>{ltCredits.length
                ? <div style={{display:'flex',flexDirection:'column',gap:2}}>{ltCredits.map(({lt, rem}) => lt ? <span key={lt.id} className="swimmer-cred-chip"><span className="subtle" style={{fontSize:9}}>{lt.name.split(' ').slice(0,2).join(' ')}:</span> <strong className={rem!=null && rem<=2?'credit-low':''}>{rem!=null ? rem : '—'}</strong></span> : null)}</div>
                : <span className="subtle">—</span>}</td>
              <td>{tcOk?<span className="tc-badge-ok" title={`Accepted ${new Date(s.tcAcceptedAt).toLocaleDateString()} · ID: ${s.tcAcceptanceId}`}>✅</span>:<span className="tc-badge-pending" title="Terms & Conditions not yet accepted">⚠</span>}</td>
              <td style={{fontSize:11}}>{sched?sched.map((g,gi)=>{
                const targetWeek = jumpToWeek ? nextWeekFor(s.id, g.type) : null;
                const handleJump = (e) => { e.stopPropagation(); if(targetWeek) jumpToWeek(targetWeek, 0); };
                return targetWeek
                  ? <button key={gi} type="button" className="swimmer-sched-link" onClick={handleJump} title={`Jump to week of ${targetWeek}`}>
                      <span style={{fontWeight:700}}>{g.type}:</span> <span className="subtle">{g.times.join(', ')}</span>
                      <span className="swimmer-sched-arrow" aria-hidden="true">↗</span>
                    </button>
                  : <div key={gi} style={{marginBottom:2}}><span style={{fontWeight:700}}>{g.type}:</span> <span className="subtle">{g.times.join(', ')}</span></div>;
              }):<span className="subtle">Not scheduled</span>}</td>
            </tr>
          </React.Fragment>;
        }):<tr><td colSpan={COLS} className="empty">No swimmers found.</td></tr>}
        </tbody></table>
      </div>
    </div>
  </>;
}

// ============================================================================
// TCView — Terms & Conditions page with swimmer selection & email acceptance
// ============================================================================
const TC_COMPANY = 'Star Swim Sdn Bhd';
const TC_CONTENT = [
  { h: '1. Introduction', body: `These Terms and Conditions ("Agreement") govern the enrolment and participation of swimmers in swimming lessons and aquatic programmes offered by ${TC_COMPANY} ("the School", "we", "our"). By accepting this Agreement, the parent, legal guardian, or adult swimmer ("you") acknowledges having read, understood, and agreed to be bound by these terms. This Agreement constitutes a legally binding contract.` },
  { h: '2. Safeguarding & Child Protection', body: `${TC_COMPANY} is committed to providing a safe, inclusive, and supportive aquatic environment for all participants.\n\n2.1 The School adheres to the National Child Protection Principles and Malaysia's Child Act 2001. All instructors undergo background screening and hold current first aid and lifeguard certifications.\n\n2.2 Parents and guardians are required to remain within the facility premises during all sessions involving participants under 12 years of age, unless otherwise agreed in writing.\n\n2.3 Any concerns regarding the welfare of a child, safeguarding issues, or inappropriate conduct should be raised immediately with the School Administrator or reported to: Jabatan Kebajikan Masyarakat (Social Welfare Department) at 1-800-88-3900.\n\n2.4 Photography and video recording of any swimmer — including your own child — are prohibited within pool areas without prior written consent from ${TC_COMPANY} and the relevant guardian of every swimmer present.` },
  { h: '3. Class Cancellation & Attendance Policy', body: `3.1 Advance Notice: Cancellations must be communicated to the School no less than twenty-four (24) hours before the scheduled class start time. Cancellations received within this 24-hour window will be treated as an Absence unless a valid emergency and accompanying proof are provided.\n\n3.2 Medical Cancellation: Absences due to illness or medical conditions will be considered valid cancellations provided the School receives a copy of a certified Medical Certificate (MC) issued by a registered medical practitioner within 48 hours of the missed class. On receipt of a valid MC, the swimmer is entitled to one (1) replacement class.\n\n3.3 Absence (No Replacement): Where a swimmer is absent without valid 24-hour prior notice or a valid MC, the class will be recorded as "provided," credits will be deducted where applicable, and no replacement lesson will be offered.\n\n3.4 Last-Minute Emergencies: Genuine emergencies (e.g. hospitalisation, accident, bereavement) occurring within the 24-hour window may be considered at the School's discretion upon submission of appropriate supporting documentation.` },
  { h: '4. School-Initiated Cancellations', body: `4.1 Weather Conditions: Classes may be suspended or cancelled at the School's sole discretion during adverse weather — including lightning, heavy rainfall, or hazardous pool conditions. Participants will be notified as promptly as possible via WhatsApp or email. Any class cancelled due to weather entitles the swimmer to a full replacement lesson at no additional cost.\n\n4.2 Instructor Cancellation: Should a class be cancelled by ${TC_COMPANY} or by an assigned instructor for reasons within the School's control, all affected swimmers are entitled to a replacement lesson. The replacement will be scheduled within the same billing cycle where possible, or carried forward.` },
  { h: '5. Replacement Class Policy', body: `5.1 Group Classes: Replacement sessions for group classes may be attended in any currently active class of the same lesson type, provided a slot is available. Replacements must be arranged through the School and are subject to availability. Replacement swimmers are marked as "drop-in replacement" and are not carried forward in subsequent weeks.\n\n5.2 Personal & Private Classes (Personal 1, Personal 2, Personal Toddler, Stroke Lab, Premium Personal, Personal Clara): Replacement sessions for personal classes are to be arranged directly between the assigned instructor and the parent or guardian, subject to mutual time availability and pool space. The School will facilitate communication. Replacement credits will be applied and the rescheduled session logged.\n\n5.3 Validity: Replacement lessons must be utilised within 14 calendar days of the missed class, unless otherwise agreed in writing. Unused replacement entitlements expire at the end of the month in which they were granted.` },
  { h: '6. Credit System (Personal & Private Classes)', body: `6.1 Students enrolled in personal or private lesson programmes are allocated a credit balance corresponding to the number of sessions purchased in their package.\n\n6.2 One (1) credit is deducted for each scheduled and attended class. Credits are not deducted for classes cancelled by the School or for classes where a valid MC has been provided.\n\n6.3 Credits are non-refundable and non-transferable to another swimmer. Unused credits at the end of a package cycle are forfeited unless otherwise agreed in writing.\n\n6.4 The School reserves the right to apply a credit deduction when a replacement or rescheduled class is successfully attended.` },
  { h: '7. Fees & Payment', body: `7.1 All fees are due in accordance with the payment schedule indicated in your enrolment confirmation. Late payment may result in suspension from classes.\n\n7.2 Fees are non-refundable once a billing cycle has commenced, except in extraordinary circumstances at the School's discretion.\n\n7.3 The School reserves the right to revise fee structures with a minimum of 30 days' written notice.` },
  { h: '8. Health, Safety & Medical Disclosure', body: `8.1 Good Health Confirmation: You confirm that the swimmer is in good health and is medically fit to participate in aquatic activities.

8.2 Medical & Behavioural Declaration: You further declare that, to the best of your knowledge, the swimmer named in this registration:
  (a) does not have any known medical, physical, or psychological condition that would prevent safe participation in swimming lessons;
  (b) has not been advised by a medical professional to refrain from physical activity or aquatic programmes;
  (c) is not under any medication or treatment that would interfere with swim lesson participation;
  (d) does not require additional support unless previously disclosed.

8.3 Disclosure Obligation: Any pre-existing medical condition, allergy, behavioural consideration, or physical limitation must be disclosed to the School prior to the commencement of classes. If any such conditions exist, you confirm that you have disclosed them during registration or will inform the School's administrators before lessons commence.

8.4 Consequences of Non-Disclosure: You understand that failure to disclose relevant medical or behavioural information may affect the safety and quality of instruction and may result in withdrawal from the programme without refund.

8.5 Liability: The School is not liable for injuries or health events arising from undisclosed medical or behavioural conditions.

8.6 Emergency Authorisation: In the event of a medical emergency, the School is authorised to administer basic first aid and to contact emergency services. All reasonable effort will be made to contact the designated emergency contact immediately.` },
  { h: '9. Liability Waiver', body: `9.1 Participation in aquatic activities carries inherent risks. By accepting this Agreement, you acknowledge these risks and agree that ${TC_COMPANY}, its directors, instructors, and staff shall not be liable for any injury, loss, damage, or claim arising from participation in the School's programmes, except where caused by the School's gross negligence or wilful misconduct.\n\n9.2 The School maintains appropriate public liability insurance.` },
  { h: '10. Photography, Video & Marketing Consent', body: `10.1 By accepting these Terms, you consent to ${TC_COMPANY} taking photographs and video recordings of the swimmer during lessons, classes, and events for the purposes of instructor training, social media, advertising, school newsletters, and other marketing activities undertaken by the School.

10.2 Opt-Out: If you wish to withhold consent for the use of your swimmer's images in marketing materials, please notify the School in writing at the time of registration or thereafter. The School will then take reasonable steps to exclude the swimmer from marketing photography going forward; this opt-out does not retroactively remove already-published materials.

10.3 This School-led photography consent is distinct from the third-party photography restrictions described in clause 2.4. Visitors and other guardians remain prohibited from photographing or recording any swimmer (including their own child within shared pool areas) without prior written consent from ${TC_COMPANY} and the relevant guardians of every swimmer present.` },
  { h: '11. Acceptance & Governing Law', body: `This Agreement is governed by the laws of Malaysia. Any dispute shall be subject to the jurisdiction of the courts of Malaysia. By electronically accepting, you confirm you have read and agree to all clauses above on behalf of yourself and/or the enrolled swimmer.` }
];

// Flatten the structured default T&C into one editable text blob. Used to seed
// the per-branch editor and as the fallback when a branch has no custom terms.
function defaultTermsText(){ return TC_CONTENT.map(s => `${s.h}\n${s.body}`).join('\n\n').replace(/\\n/g, '\n'); }

// Settings › Terms — edit each branch's Terms & Conditions (one free-text blob).
// Empty/blank stores NULL and the branch falls back to the default wording.
function TermsAdminView({ branches, currentBranchId, defaultTerms, onSave }){
  const active = (branches||[]).filter(b => b.is_active !== false);
  const initialBranch = (currentBranchId && currentBranchId !== 'all') ? currentBranchId : (active[0]?.id || '');
  const [branchId, setBranchId] = useState(initialBranch);
  const [text, setText] = useState('');
  const [usingDefault, setUsingDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const branch = (branches||[]).find(b => b.id === branchId) || null;

  React.useEffect(() => {
    const b = (branches||[]).find(x => x.id === branchId);
    const hasCustom = !!(b && b.terms_content && b.terms_content.trim());
    setText(hasCustom ? b.terms_content : defaultTerms);
    setUsingDefault(!hasCustom);
  }, [branchId, branches]); // eslint-disable-line

  const dirty = (() => {
    const b = (branches||[]).find(x => x.id === branchId);
    const stored = (b && b.terms_content && b.terms_content.trim()) ? b.terms_content : defaultTerms;
    return text !== stored;
  })();

  async function save(){ setBusy(true); try{ await onSave(branchId, text); } finally { setBusy(false); } }
  async function reset(){ if(!confirm('Reset this branch to the default Terms & Conditions?')) return; setBusy(true); try{ await onSave(branchId, ''); } finally { setBusy(false); } }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>📄 Terms &amp; Conditions</div>
      <div className="small subtle" style={{marginBottom:14}}>Each branch has its own Terms &amp; Conditions, shown to parents on that branch's intake form. Leave it on the default wording, or customise the full text for this branch. Blank resets it to the shared default.</div>
      <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
        <div className="field" style={{margin:0,minWidth:220}}><label>Branch</label>
          <select className="select" value={branchId} onChange={e=>setBranchId(e.target.value)}>{active.map(b => <option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}</select>
        </div>
        <span className="pill" style={usingDefault?{background:'#FEF3C7',color:'#92400E'}:{background:'#D1FAE5',color:'#065F46'}}>{usingDefault ? 'Using default wording' : 'Custom terms set'}</span>
      </div>
    </div>

    <div className="settings-cols" style={{gridTemplateColumns:'1fr 1fr',gap:16}}>
      <div className="card">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div style={{fontWeight:800}}>Editor</div>
          <div className="small subtle">{(text||'').length} chars</div>
        </div>
        <textarea className="textarea" style={{minHeight:460,fontFamily:'inherit',lineHeight:1.5}} value={text} onChange={e=>setText(e.target.value)} placeholder="Enter this branch's full Terms & Conditions…" />
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:10,gap:8}}>
          <button className="btn btn-ghost small" onClick={reset} disabled={busy || usingDefault}>Reset to default</button>
          <div style={{display:'flex',gap:8}}>
            <button className="btn btn-ghost small" onClick={()=>setText(defaultTerms)} disabled={busy}>Load default text</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save terms'}</button>
          </div>
        </div>
      </div>
      <div className="card">
        <div style={{fontWeight:800,marginBottom:8}}>Preview <span className="small subtle" style={{fontWeight:400}}>· how parents will see it{branch?` · ${branch.name}`:''}</span></div>
        <div className="tc-doc-scroll" style={{maxHeight:480}}>
          <h1 className="tc-h1">{TC_COMPANY}</h1>
          <h2 className="tc-h2">Swimming Lesson Enrolment — Terms &amp; Conditions</h2>
          {(text||'').split('\n\n').map((para, i) => <p key={i} className="tc-para" style={{whiteSpace:'pre-wrap'}}>{para}</p>)}
        </div>
      </div>
    </div>
  </>;
}

function TCView({ students, lessonTypes, lessonTypeById, onSaveAcceptance }){
  const [studentId, setStudentId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [sigName, setSigName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { acceptanceId, studentName, email }
  const [scrolled, setScrolled] = useState(false);

  const student = students.find(s => s.id === studentId) || null;
  const lt = student?.lessonTypeIds?.[0] ? lessonTypeById(student.lessonTypeIds[0]) : null;
  const alreadySigned = !!student?.tcAcceptedAt;
  // Digital signature: the typed name must match the guardian name on file
  // (falls back to the swimmer's own name for adult self-enrolment).
  const onFileName = (student?.guardianName || student?.name || '').trim();
  const sigMatches = !!sigName.trim() && sigName.trim().toLowerCase() === onFileName.toLowerCase();

  function handleScroll(e){ if(e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 40) setScrolled(true); }

  async function handleAccept(){
    if(!student || !agreed || busy) return;
    if(!sigMatches){ alert(`To sign, type the guardian name exactly as on file: "${onFileName}".`); return; }
    try{
      setBusy(true);
      const acceptanceId = await onSaveAcceptance({ studentId: student.id, guardianName: student.guardianName || student.name, guardianEmail: student.guardianEmail || null, lessonTypeName: lt?.name || '—', signatureName: sigName.trim(), signedVia: 'app' });
      // Optional confirmation email — only when a guardian email is on file.
      // A missing email no longer blocks signing (the typed signature is the
      // binding record); we simply skip the mailto step.
      if(!student.guardianEmail){ setDone({ acceptanceId, studentName: student.name, email: null }); setAgreed(false); setScrolled(false); setSigName(''); return; }
      const subj = encodeURIComponent(`Swimming Lesson Terms & Conditions — ${student.name} — ${TC_COMPANY}`);
      const dateStr = new Date().toLocaleString('en-MY', { dateStyle:'long', timeStyle:'short' });
      const emailBody = encodeURIComponent(
`Dear ${student.guardianName || student.name},

This email confirms that the Terms and Conditions for ${TC_COMPANY} have been accepted for the following swimmer:

  Swimmer Name : ${student.name}
  Lesson Type  : ${lt?.name || 'Not specified'}
  Accepted By  : ${student.guardianName || student.name}
  Acceptance ID: ${acceptanceId}
  Date & Time  : ${dateStr}

This Acceptance ID is your unique reference. Please retain this email for your records.

─────────────────────────────────────────────────────
If you did NOT authorise this acceptance, or if you do not agree to the terms, please reply to this email immediately and we will resolve this with you. Failure to respond within 3 business days will be taken as confirmation of acceptance.
─────────────────────────────────────────────────────

Key Policy Highlights:
• Cancellations must be made ≥24 hrs in advance or a Medical Certificate must be provided.
• Absent without notice = class counted as provided; no replacement entitlement.
• School-cancelled classes (weather, instructor) entitle you to a replacement lesson.
• Group replacement: any active class of the same type with an available slot.
• Personal class replacement: by mutual arrangement with your instructor.

For the full Terms and Conditions, please contact us or request a copy from ${TC_COMPANY}.

Thank you for choosing ${TC_COMPANY}. We look forward to seeing ${student.name} in the pool!

Warm regards,
${TC_COMPANY} Administration`);
      window.open(`mailto:${encodeURIComponent(student.guardianEmail)}?subject=${subj}&body=${emailBody}`);
      setDone({ acceptanceId, studentName: student.name, email: student.guardianEmail });
      setAgreed(false); setScrolled(false); setSigName('');
    } catch(e){ alert(e?.message || 'Failed to record acceptance'); }
    finally{ setBusy(false); }
  }

  return <div style={{maxWidth:900,margin:'0 auto'}}>
    <div className="card" style={{marginBottom:16}}>
      <div style={{fontSize:22,fontWeight:800,marginBottom:4}}>Terms &amp; Conditions</div>
      <div className="small subtle">{TC_COMPANY} · Swimming Lesson Enrolment Agreement</div>
      <div style={{marginTop:14,display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap'}}>
        <div className="field" style={{margin:0,flex:'1 1 240px'}}>
          <label>Select Swimmer</label>
          <StudentSelect
            valueId={studentId || null}
            fallbackLabel={null}
            studentById={Object.fromEntries(students.map(s=>[s.id,s]))}
            candidates={students.filter(s=>!s.tcAcceptedAt).slice().sort((a,b)=>a.name.localeCompare(b.name))}
            onPick={(stu)=>{ setStudentId(stu?stu.id:''); setAgreed(false); setScrolled(false); setSigName(''); setDone(null); }}
            conflict={null}
          />
          <div className="hint" style={{marginTop:4}}>Only swimmers without a signed T&amp;C are shown. Already-signed swimmers are filtered out.</div>
        </div>
        {student && <div className="tc-student-summary">
          <div><span className="small subtle">Guardian:</span> <strong>{student.guardianName||'—'}</strong></div>
          <div><span className="small subtle">Email:</span> <strong>{student.guardianEmail||<span className="tc-warn">⚠ No email — add in Swimmers tab</span>}</strong></div>
          <div><span className="small subtle">Lesson Type:</span> <strong>{lt?.name||'—'}</strong></div>
        </div>}
      </div>
      {alreadySigned && <div className="tc-status-row tc-accepted" style={{marginTop:12}}>
        ✅ T&amp;C already accepted for {student.name} · ID: {student.tcAcceptanceId} · {new Date(student.tcAcceptedAt).toLocaleDateString(undefined,{dateStyle:'long'})}
      </div>}
    </div>

    <div className="card" style={{marginBottom:16}}>
      <div className="tc-doc-scroll" onScroll={handleScroll}>
        <h1 className="tc-h1">{TC_COMPANY}</h1>
        <h2 className="tc-h2">Swimming Lesson Enrolment — Terms &amp; Conditions</h2>
        {TC_CONTENT.map((sec,i)=><div key={i} className="tc-section">
          <h3 className="tc-h3">{sec.h}</h3>
          {sec.body.split('\n\n').map((p,j)=><p key={j} className="tc-para">{p}</p>)}
        </div>)}
        {!scrolled && <div className="tc-scroll-hint">↓ Scroll to the bottom to enable acceptance</div>}
      </div>
    </div>

    {done
      ? <div className="card tc-success">
          <div style={{fontSize:20,fontWeight:800,marginBottom:6}}>✅ Accepted — {done.studentName}</div>
          <div className="small">Acceptance ID: <strong>{done.acceptanceId}</strong></div>
          {done.email
            ? <div className="small subtle" style={{marginTop:4}}>Your email client has been opened with a confirmation email pre-addressed to <strong>{done.email}</strong>. Please review and click Send. The email instructs them to reply if they do not agree.</div>
            : <div className="small subtle" style={{marginTop:4}}>Signature recorded. No guardian email is on file, so no confirmation email was sent — add one in the Swimmers tab if you'd like a copy emailed on the next signing.</div>}
          <button className="btn btn-ghost small" style={{marginTop:10}} onClick={()=>setDone(null)}>Sign another swimmer</button>
        </div>
      : <div className="card">
          <label className="gb-check" style={{fontSize:14,display:'flex',gap:10,alignItems:'flex-start',opacity:scrolled?1:0.4,transition:'opacity .2s',cursor:scrolled?'pointer':'default'}}>
            <input type="checkbox" disabled={!scrolled||!student} checked={agreed} onChange={e=>setAgreed(e.target.checked)} style={{marginTop:3,flexShrink:0}} />
            <span>I have read and fully understood the Terms &amp; Conditions of {TC_COMPANY}. I agree to be bound by this Agreement on behalf of myself and/or the enrolled swimmer named above, and confirm all information provided is accurate.</span>
          </label>
          {!scrolled && <div className="small subtle" style={{marginTop:6,marginLeft:28}}>Please scroll through the full document above before accepting.</div>}
          {/* Digital signature — typed name must match the on-file guardian name. */}
          <div className="field" style={{marginTop:14,opacity:(scrolled&&agreed&&student)?1:0.4,transition:'opacity .2s'}}>
            <label>Digital signature — type the guardian's full name to sign</label>
            <input
              type="text"
              value={sigName}
              disabled={!scrolled||!agreed||!student}
              onChange={e=>setSigName(e.target.value)}
              placeholder={student?`Type "${onFileName}" to sign`:'Select a swimmer first'}
              style={{fontFamily:'"Segoe Script","Brush Script MT",cursive',fontSize:18}}
            />
            {student && sigName.trim() && !sigMatches && <div className="hint" style={{color:'var(--red-tx)',marginTop:4}}>⚠ Must match the guardian name on file: <strong>{onFileName}</strong></div>}
            {student && sigMatches && <div className="hint" style={{color:'var(--green-tx)',marginTop:4}}>✓ Signature matches — ready to accept.</div>}
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',marginTop:14}}>
            <button className="btn btn-primary" disabled={!agreed||!student||busy||!sigMatches} onClick={handleAccept} style={{padding:'10px 24px',fontSize:15}}>
              {busy ? 'Processing…' : '✍️ I Accept These Terms'}
            </button>
          </div>
          {student && !student.guardianEmail && <div className="hint" style={{marginTop:6,textAlign:'right'}}>No guardian email on file — signing still works; a confirmation email just won't be sent.</div>}
        </div>}
  </div>;
}

function SessionModal({ modal, setModal, saveBusy, saveSession, deleteSession, openAddAtTime, instructors, lessonTypes, pools, lessonTypeByName, poolById, packageById, students, studentById, weekEnrollments, familyGroups, membersByGroup, groupById, trialStudentIds, trialByLessonType, creditByKey, purchasesByKey, addCreditPurchase, adjustCredit, initCredit, pendingByKey, replacementPending, markForReplacement, forwardClassToNextWeek, startFullClassMove, duplicateSessionForward }){
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [cancelClassOpen, setCancelClassOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [reschedDay, setReschedDay] = useState(0);
  const [reschedMinute, setReschedMinute] = useState(480);
  const [initCreditInput, setInitCreditInput] = useState({});
  const [escWarn, setEscWarn] = useState(false);

  // Dirty-check: compare current form to snapshot taken when modal first opened
  const initialFormRef = React.useRef(null);
  React.useEffect(() => { initialFormRef.current = JSON.stringify(modal.form); }, []); // eslint-disable-line
  const isDirty = initialFormRef.current !== null && JSON.stringify(modal.form) !== initialFormRef.current;

  // ESC key: close immediately if clean, warn if dirty
  React.useEffect(() => {
    function onKey(e){
      if(e.key !== 'Escape') return;
      e.stopPropagation();
      if(escWarn){ setEscWarn(false); return; }  // ESC again dismisses warning
      if(isDirty) setEscWarn(true);
      else setModal(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDirty, escWarn]);

  const currentLt = lessonTypes.find(t => t.name === modal.form.type);
  const isPersonal = currentLt?.class_type === 'personal';
  const isRescheduled = modal.rescheduledFromDay != null;

  // M2: union of durations — common standards plus every lesson type's default
  // and the currently-selected duration so the dropdown always contains the
  // active value.
  const durationOptions = useMemo(() => {
    const all = new Set([30, 45, 50, 60]);
    lessonTypes.forEach(lt => { if(lt.default_duration_minutes) all.add(Number(lt.default_duration_minutes)); });
    if(modal?.form?.durationMinutes) all.add(Number(modal.form.durationMinutes));
    return [...all].sort((a,b)=>a-b);
  }, [lessonTypes, modal?.form?.durationMinutes]);

  function setForm(patch){ setModal(prev => prev ? { ...prev, form: { ...prev.form, ...patch } } : prev); }

  function onTypeChange(name){
    const lt = lessonTypes.find(t => t.name === name);
    const patch = { type: name, lessonTypeId: lt?.id || null };
    if(lt?.default_duration_minutes) patch.durationMinutes = Number(lt.default_duration_minutes);
    if(lt?.default_pool_id) patch.poolId = lt.default_pool_id;
    patch.studentRows = rebuildRowsForCap(modal.form.studentRows, lt?.students_per_instructor);
    setForm(patch);
  }

  function setRow(i, key, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], [key]: val }; setForm({ studentRows: rows }); }
  function addRow(){ setForm({ studentRows: [...(modal.form.studentRows || []), { studentId:null, name:'', age:'', remark:'', attendance:'pending' }] }); }
  function onInstructorChange(id){
    const inst = instructors.find(i => i.id === id);
    setForm({ instructorId: id || null, instructorName: inst?.name || '' });
  }

  // Pick a swimmer into a slot from the registry; snapshot name+age. null clears.
  // Bound-group auto-fill: if the picked swimmer is in a BOUND group whose
  // package matches this session's lesson type, also auto-add every other
  // member of that group that isn't already in the session. Bound members
  // must move through sessions together — this is the add counterpart of
  // the bound-removal guard in removeRow.
  function pickStudent(i, student){
    const rows = (modal.form.studentRows || []).slice();
    const keepRemark = student ? (rows[i]?.remark || '') : '';
    const keepAtt = student ? (rows[i]?.attendance || 'pending') : 'pending';
    rows[i] = student ? { studentId: student.id, name: student.name, age: (student.age === null || student.age === undefined ? '' : String(student.age)), remark: keepRemark, attendance: keepAtt } : { studentId:null, name:'', age:'', remark:'', attendance:'pending' };

    if(student && groupById && membersByGroup){
      const ltId = currentLt?.id;
      const stuFull = studentById[student.id] || student;
      const groupIds = stuFull.familyGroupIds || (stuFull.familyGroupId ? [stuFull.familyGroupId] : []);
      // Find a bound group whose package matches this session's lesson type.
      let boundGrp = null;
      for(const gid of groupIds){
        const g = groupById[gid];
        if(!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if(pkg && ltId && pkg.lesson_type_id === ltId){ boundGrp = g; break; }
      }
      if(boundGrp){
        const inSessionIds = new Set(rows.filter(r => r.studentId).map(r => r.studentId));
        const missingMembers = (membersByGroup[boundGrp.id] || []).filter(m => m.id !== student.id && !inSessionIds.has(m.id));
        if(missingMembers.length){
          // Fill empty rows first, then append for any remaining.
          let cursor = 0;
          for(const m of missingMembers){
            // Find next empty slot starting from cursor
            while(cursor < rows.length && rows[cursor].studentId) cursor++;
            const slot = { studentId: m.id, name: m.name, age: (m.age == null ? '' : String(m.age)), remark: '', attendance: 'pending' };
            if(cursor < rows.length){ rows[cursor] = slot; cursor++; }
            else { rows.push(slot); }
          }
        }
      }
    }

    setForm({ studentRows: rows });
  }
  function setRemark(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], remark: val }; setForm({ studentRows: rows }); }
  function setAttendance(i, val){ const rows = (modal.form.studentRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ studentRows: rows }); }
  function setReplAttendance(i, val){ const rows = (modal.form.replacementRows || []).slice(); rows[i] = { ...rows[i], attendance: val }; setForm({ replacementRows: rows }); }

  // Bind this session to a family group and drop ALL its members into the slots
  // at once (padded to the lesson-type ratio). groupId '' clears the binding.
  // ── quickAddGroup: add all lesson-type-eligible members of a family
  // group to the current session additively — does NOT replace or clear
  // any existing students. For bound groups every member must go in
  // together; the user is warned if the class would go over capacity.
  // For discount groups the add is soft-warned only.
  function quickAddGroup(group){
    const ltId = currentLt?.id || modal?.form?.lessonTypeId;
    const members = ((membersByGroup && membersByGroup[group.id]) || [])
      .filter(m => !ltId || (m.lessonTypeIds || []).includes(ltId));
    if(!members.length){
      alert(`No members of "${group.name}" are enrolled in this lesson type.`);
      return;
    }
    const currentRows = modal.form.studentRows || [];
    const alreadyIn = new Set(currentRows.filter(r => r.studentId).map(r => r.studentId));
    const toAdd = members.filter(m => !alreadyIn.has(m.id));
    if(!toAdd.length){
      alert(`All members of "${group.name}" are already in this session.`);
      return;
    }
    const currentFilled = currentRows.filter(r => r.studentId || (r.name||'').trim()).length;
    const cap = previewMax;
    const isBound = group.groupType === 'bound';
    if(cap > 0 && currentFilled + toAdd.length > cap){
      const msg = isBound
        ? `"${group.name}" is a bound group — all ${toAdd.length} member${toAdd.length===1?'':'s'} must be added together.\n\nThis would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?`
        : `Adding ${toAdd.length} member${toAdd.length===1?'':'s'} from "${group.name}" would put the class over capacity (${currentFilled + toAdd.length}/${cap}). Add anyway?`;
      if(!confirm(msg)) return;
    }
    // Fill empty slots first, then append new ones.
    const newRows = [...currentRows];
    const emptyIdx = [];
    newRows.forEach((r, i) => { if(!r.studentId && !(r.name||'').trim()) emptyIdx.push(i); });
    toAdd.forEach(m => {
      const row = { studentId:m.id, name:m.name, age:m.age != null ? String(m.age) : '', attendance:'pending', remark:'' };
      if(emptyIdx.length){ newRows[emptyIdx.shift()] = row; }
      else { newRows.push(row); }
    });
    setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
  }

  // ── Bound-group removal guard: when the user clears a slot that holds
  // a bound-group member, offer to remove all other members of the same
  // group from the session too. Multi-group aware: a swimmer can be in
  // several groups; we look for ANY bound group whose package matches the
  // current session's lesson type, because that's the group whose members
  // must move together for THIS class.
  function removeRow(i){
    const row = (modal.form.studentRows || [])[i];
    if(row?.studentId && groupById){
      const stu = studentById[row.studentId];
      const groupIds = stu?.familyGroupIds || (stu?.familyGroupId ? [stu.familyGroupId] : []);
      // Find a bound group of this swimmer that matches the session's lesson type
      const ltId = currentLt?.id;
      let boundGrp = null;
      for(const gid of groupIds){
        const g = groupById[gid];
        if(!g || g.groupType !== 'bound') continue;
        const pkg = g.packageId ? packageById?.(g.packageId) : null;
        if(pkg && ltId && pkg.lesson_type_id === ltId){ boundGrp = g; break; }
        // Fallback: if package isn't set or lesson type can't be confirmed,
        // still treat as bound-cascade candidate (defensive for legacy data).
        if(!boundGrp) boundGrp = g;
      }
      if(boundGrp){
        const groupMemberIds = new Set(((membersByGroup && membersByGroup[boundGrp.id]) || []).map(m => m.id));
        const otherBoundInSession = (modal.form.studentRows || []).filter((r, ri) => ri !== i && r.studentId && groupMemberIds.has(r.studentId));
        if(otherBoundInSession.length){
          if(confirm(`"${stu.name}" is in the bound group "${boundGrp.name}". Bound members must move through sessions together — remove all ${otherBoundInSession.length + 1} bound group members from this session?`)){
            const removeIds = new Set([row.studentId, ...otherBoundInSession.map(r => r.studentId)]);
            const newRows = (modal.form.studentRows || []).map(r => removeIds.has(r.studentId) ? { studentId:null, name:'', age:'', attendance:'pending', remark:'' } : r);
            setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
            return;
          }
        }
      }
    }
    // Default: just clear this one slot.
    const newRows = [...(modal.form.studentRows || [])];
    newRows[i] = { studentId:null, name:'', age:'', attendance:'pending', remark:'' };
    setModal({ ...modal, form: { ...modal.form, studentRows: newRows } });
  }

  // Capacity preview: counts the slots that hold a swimmer, against the
  // lesson type's ratio (assuming one instructor for now — splits come in M3).
  const previewStudents = (modal?.form?.studentRows || []).filter(r => r.studentId || (r.name || '').trim()).length;
  const previewLt = lessonTypeByName(modal?.form?.type);
  const previewMax = previewLt?.students_per_instructor ? Number(previewLt.students_per_instructor) : 0;
  const previewStatus = previewMax > 0
    ? (previewStudents > previewMax ? 'over' : previewStudents === previewMax ? 'full' : previewStudents/previewMax >= 0.8 ? 'tight' : 'open')
    : 'unknown';
  const previewChip = capacityChipColors(previewStatus);
  const previewPool = poolById(modal?.form?.poolId);

  // Candidates for the dropdowns: swimmers tagged for this lesson type; if none
  // are tagged yet, fall back to all active swimmers so the user isn't stuck.
  // Trial swimmers are always strictly lesson-type-scoped though — they're
  // never surfaced unless their enrolment includes the current lesson type,
  // even in fallback mode. Otherwise a trial LTS swimmer would appear as a
  // candidate when scheduling a Personal class, which makes no sense.
  const lessonTypeId = previewLt?.id || modal?.form?.lessonTypeId || null;
  const inBucket = (students || []).filter(s => s.isActive !== false && lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId));
  const candidates = (inBucket.length ? inBucket : (students || []).filter(s => s.isActive !== false))
    .filter(s => {
      if(!(trialStudentIds && trialStudentIds.has(s.id))) return true;
      // Trial swimmer: only keep if their enrollment matches this lesson type.
      return !!lessonTypeId && (s.lessonTypeIds || []).includes(lessonTypeId);
    });
  const bucketFallback = lessonTypeId && !inBucket.length;
  function rowConflict(row, idx){
    if(!row.studentId) return null;
    if((modal.form.studentRows || []).some((r, j) => j !== idx && r.studentId === row.studentId)) return 'twice in this class';
    const others = (weekEnrollments[row.studentId] || []).filter(e => e.sessionId !== modal.id);
    if(others.length){ const e = others[0]; return `${DAYS_S[e.day]} ${minuteToTime(e.startMinute)}`; }
    return null;
  }

  return <div className="modal-backdrop"><div className="modal-card">
    <div className="modal-head">
      <div style={{minWidth:0,flex:1}}>
        <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>{modal.id ? 'Edit' : 'Add'} Session</div>
        <div className="small subtle" style={{fontSize:10.5,marginTop:1}}>{DAYS_S[modal.day]} {minuteToTime(modal.startMinute)}{previewPool ? ` · ${previewPool.name}` : ''}</div>
      </div>
      <button className="btn btn-ghost small" onClick={() => { if(isDirty) setEscWarn(true); else setModal(null); }} aria-label="Close" title="Close (Esc)">✕</button>
    </div>
    {escWarn && <div className="esc-warn-bar">
      <span>⚠ You have unsaved changes.</span>
      <div style={{display:'flex',gap:6,flexShrink:0}}>
        <button className="btn btn-primary small" onClick={()=>{ setEscWarn(false); saveSession(); }}>Save & Close</button>
        <button className="btn btn-danger small" onClick={()=>{ setEscWarn(false); setModal(null); }}>Discard Changes</button>
        <button className="btn btn-ghost small" onClick={()=>setEscWarn(false)}>Keep Editing</button>
      </div>
    </div>}
    <div className="modal-body">
      <div className="form-grid form-grid-4">
        <div className="field"><label>Lesson Type</label><select className="select" value={modal.form.type} onChange={(e)=>onTypeChange(e.target.value)}>{lessonTypes.map(x => <option key={x.id} value={x.name}>{x.name}</option>)}</select></div>
        <div className="field"><label>Pool</label><select className="select" value={modal.form.poolId || ''} onChange={(e)=>setForm({ poolId: e.target.value || null })}><option value="">(no pool)</option>{pools.map(p => <option key={p.id} value={p.id}>{p.name} · cap {p.capacity_total}</option>)}</select></div>
        <div className="field"><label>Instructor</label><select className="select" value={modal.form.instructorId || ''} onChange={(e)=>onInstructorChange(e.target.value)}><option value="">(unassigned)</option>{instructors.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="field"><label>Duration</label><select className="select" value={String(modal.form.durationMinutes)} onChange={(e)=>setForm({ durationMinutes: Number(e.target.value) })}>{durationOptions.map(d => <option key={d} value={d}>{d} min</option>)}</select></div>
        {/* Plain inline meta line — replaces the boxed Time/Capacity fields. */}
        <div className="modal-meta-strip" style={{gridColumn:'1 / -1'}}>
          <span>⏱ <strong>{formatRange(modal.startMinute, modal.form.durationMinutes)}</strong></span>
          {previewMax > 0
            ? <span className={previewStatus==='over'?'meta-warn':''}>👥 <strong>{previewStudents} / {previewMax}</strong>{previewStatus==='over'?' Over':previewStatus==='full'?' Full':previewStatus==='tight'?' Tight':''}</span>
            : <span>👥 <strong>{previewStudents}</strong></span>}
        </div>
        <div style={{gridColumn:'1 / -1',display:'flex',alignItems:'flex-start',gap:10,background:modal.form.markedFull?'#FEF3C7':'var(--surface)',border:`1.5px solid ${modal.form.markedFull?'#FDE68A':'var(--border-2)'}`,borderRadius:11,padding:'9px 12px'}}>
          <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontWeight:800,fontSize:13,whiteSpace:'nowrap'}}>
            <input type="checkbox" checked={modal.form.markedFull===true} onChange={e=>setForm({markedFull:e.target.checked})}/>
            🔒 Mark as full
          </label>
          <span className="small subtle" style={{lineHeight:1.45}}>
            {modal.form.markedFull
              ? 'Locked — no new swimmers can be added, and the public schedule shows this class as Full regardless of headcount. Untick temporarily to slot in a trial, then re-lock.'
              : 'Lock this class when the instructor can\u2019t take more swimmers even under ratio (e.g. wide skill spread). Shows as Full publicly.'}
          </span>
        </div>
        <div className="field" style={{gridColumn:'1 / -1'}}>
          <label>Swimmers</label>
          <div className="stu-list">
            {(modal.form.studentRows || []).map((r, i) => {
              // Trial flag is per-lesson-type — only fires if this swimmer's
              // enrolment includes the current session's lesson type.
              const trialSetForLt = (trialByLessonType && currentLt?.id) ? trialByLessonType[currentLt.id] : null;
              const isTrial = !!(r.studentId && trialSetForLt && trialSetForLt.has(r.studentId));
              const wk = modal.weekStartDate;
              const ltId = currentLt?.id;
              const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
              const canMarkReplacement = !isPersonal && r.studentId && modal.id && currentLt && !isPending;
              // ── Package label (req #6) ──────────────────────────────
              // Show the swimmer's package for the current lesson type
              // subtly beside their name. Looks up:
              //   student.enrollments[ltId] → packageId → package.name
              let pkgLabel = null;
              if(r.studentId && packageById && currentLt?.id){
                const stu = studentById[r.studentId];
                const enrol = (stu?.enrollments || []).find(e => e.lessonTypeId === currentLt.id);
                const pkg = enrol?.packageId ? packageById(enrol.packageId) : null;
                if(pkg) pkgLabel = pkg.name;
              }
              return <div className="stu-row" key={i}>
                <span className="stu-num">{i+1}</span>
                <div className="stu-fields">
                  <StudentSelect valueId={r.studentId} fallbackLabel={r.studentId ? null : (r.name ? `${r.name}${r.age ? ` (${r.age})` : ''}` : '')} studentById={studentById} candidates={candidates} onPick={(stu)=>pickStudent(i, stu)} conflict={rowConflict(r, i)} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
                  {pkgLabel && !isTrial ? <span className="stu-pkg-label" title={`Enrolled package for ${currentLt?.name}`}>{pkgLabel}</span> : null}
                  {isTrial ? <span className="trial-pill" title="Trial package — one-off booking.">trial</span> : null}
                  {canMarkReplacement ? <button type="button" className="repl-mark-btn" title="Move this swimmer out for replacement" onClick={async ()=>{
                    const ok = await markForReplacement({ studentId:r.studentId, sessionId:modal.id, weekStartDate:wk, lessonTypeId:ltId, lessonTypeName:currentLt.name, day:modal.day, startMinute:modal.startMinute });
                    if(ok){ setModal(null); }
                  }}>→ R</button> : null}
                  {(r.studentId || (r.name || '').trim()) ? <div className="att-seg" role="group" aria-label="Attendance">
                    <button type="button" className={`att-btn att-pending ${(r.attendance||'pending')==='pending'?'is-on':''}`} onClick={()=>setAttendance(i,'pending')} title="Not yet marked">⏳</button>
                    <button type="button" className={`att-btn att-attended ${r.attendance==='attended'?'is-on':''}`} onClick={()=>setAttendance(i,'attended')} title="Attended — −1 credit on save">✓</button>
                    <button type="button" className={`att-btn att-absent ${r.attendance==='absent'?'is-on':''}`} onClick={()=>setAttendance(i,'absent')} title="Absent — −1 credit on save">✗</button>
                  </div> : null}
                  <input className="input stu-remark" placeholder="Remark" value={r.remark || ''} onChange={(e)=>setRemark(i, e.target.value)} />
                  {(r.studentId || (r.name||'').trim()) ? <button type="button" className="stu-x" title="Clear this slot (bound-group members prompt a group-remove)" onClick={()=>removeRow(i)}>×</button> : null}
                </div>
              </div>;
            })}
          </div>
        </div>
      </div>

      {/* ── GROUP: drop-in replacement section ── */}
      {!isPersonal && <div className="repl-section">
        <div className="repl-section-head">
          <div>
            <span className="repl-section-title">Replacement Students</span>
          </div>
          <button className="btn btn-ghost small" onClick={()=>{
            const filled = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
            const repl = (modal.form.replacementRows||[]).length;
            const cap = sessionCapacity({ students: Array(filled + repl), instructors: currentLt ? [{}] : [] }, currentLt);
            if(cap.max > 0 && (filled + repl) >= cap.max){
              if(!confirm(`Class is full (${filled + repl}/${cap.max}). Add another replacement slot anyway? The class will be over capacity.`)) return;
            }
            setModal({...modal,form:{...modal.form,replacementRows:[...(modal.form.replacementRows||[]),{studentId:null,name:'',age:null,replacementFrom:'',attendance:'pending'}]}});
          }}>+ Add replacement</button>
        </div>
        {(() => {
          // Surface quick-pick candidates above the manual selector:
          //  • TRIAL — students on a trial package with a positive credit balance
          //    for THIS lesson type (skip if balance is 0 or student is missing).
          //  • PENDING REPLACEMENT — every pending replacement record for THIS
          //    lesson type within a 4-week forward window from this session's
          //    week. (Used to be only "this week", which caused replacements
          //    to disappear from quick-pick after one week.)
          const wk = modal.weekStartDate;
          const ltId = currentLt?.id;
          if(!ltId) return null;
          // Forward window: this week plus the next 3. Past-week limbo
          // records are also included — they remain pending until placed,
          // so they must stay in quick-pick across weeks.
          const windowWeeks = new Set([0,1,2,3].map(n => addDays(wk, n*7)));
          const pendingCandidates = (replacementPending || []).filter(p =>
            p.lesson_type_id === ltId &&
            (windowWeeks.has(p.week_start_date) || p.week_start_date < wk) &&
            studentById[p.student_id] && // student must exist
            !(modal.form.replacementRows || []).some(r => r.studentId === p.student_id)
          );
          const trialCandidates = students.filter(s => {
            if(!trialStudentIds || !trialStudentIds.has(s.id)) return false;
            if(!(s.lessonTypeIds||[]).includes(ltId)) return false;
            // Must have credit balance > 0 for this lesson type
            const bal = creditByKey ? Number(creditByKey[`${s.id}:${ltId}`] || 0) : 0;
            if(bal <= 0) return false;
            if((modal.form.studentRows || []).some(r => r.studentId === s.id)) return false;
            if((modal.form.replacementRows || []).some(r => r.studentId === s.id)) return false;
            return true;
          });
          if(!pendingCandidates.length && !trialCandidates.length) return null;
          function addAsReplacement(studentId, fromLabel){
            const stu = studentById[studentId];
            if(!stu) return;
            // Cap check before adding (matches the "+ Add replacement" guard).
            const filled = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
            const repl = (modal.form.replacementRows||[]).length;
            const cap = sessionCapacity({ students: Array(filled + repl), instructors: currentLt ? [{}] : [] }, currentLt);
            if(cap.max > 0 && (filled + repl) >= cap.max){
              if(!confirm(`Class is full (${filled + repl}/${cap.max}). Add ${stu.name} as replacement anyway? The class will be over capacity.`)) return;
            }
            const rows = [...(modal.form.replacementRows||[]), { studentId, name:stu.name, age:stu.age, replacementFrom: fromLabel || '', attendance:'pending' }];
            setModal({ ...modal, form:{ ...modal.form, replacementRows: rows } });
          }
          // Compact name: truncate to 14 chars with ellipsis
          const trunc = (s, n=14) => { s = String(s||''); return s.length > n ? s.slice(0,n-1)+'…' : s; };
          return <div className="repl-quickpick">
            <div className="small subtle" style={{marginBottom:4,fontWeight:700,fontSize:11}}>Quick-pick ({pendingCandidates.length + trialCandidates.length}) <span style={{fontWeight:400}}>· trials need credit · pending shown for next 4 weeks</span></div>
            <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
              {pendingCandidates.map(p => { const stu = studentById[p.student_id]; if(!stu) return null;
                const weekTag = p.week_start_date === wk ? '' : ` (${p.week_start_date.slice(5)})`;
                return <button key={`p-${p.id}`} type="button" className="quickpick-chip quickpick-rpending" style={{padding:'2px 7px',fontSize:10.5,lineHeight:1.3}} onClick={()=>addAsReplacement(p.student_id, encodeReplacementFrom(p.original_session_id, p.original_session_label))} title={`Pending replacement from ${p.original_session_label}${weekTag?` · week of ${p.week_start_date}`:''}`}>
                  <span className="qp-tag qp-tag-r" style={{padding:'0 4px',fontSize:9}}>R</span> {trunc(stu.name)}{stu.age!=null?` ${stu.age}`:''}{weekTag}
                </button>;
              })}
              {trialCandidates.map(s => {
                const bal = creditByKey ? Number(creditByKey[`${s.id}:${ltId}`] || 0) : 0;
                return <button key={`t-${s.id}`} type="button" className="quickpick-chip quickpick-trial" style={{padding:'2px 7px',fontSize:10.5,lineHeight:1.3}} onClick={()=>addAsReplacement(s.id, '(trial)')} title={`Trial swimmer · ${bal} credit${bal===1?'':'s'} remaining`}>
                  <span className="qp-tag qp-tag-trial" style={{padding:'0 4px',fontSize:9}}>T</span> {trunc(s.name)}{s.age!=null?` ${s.age}`:''}
                </button>;
              })}
            </div>
          </div>;
        })()}
        {!(modal.form.replacementRows||[]).length && <div className="small subtle" style={{padding:'8px 0'}}>No replacement students this week.</div>}
        {(modal.form.replacementRows||[]).map((r,i) => {
          const wk = modal.weekStartDate;
          const ltId = currentLt?.id;
          const isPending = !!(r.studentId && ltId && pendingByKey && pendingByKey[`${r.studentId}:${ltId}:${wk}`]);
          const trialSetReplLt = (trialByLessonType && ltId) ? trialByLessonType[ltId] : null;
          const isTrialRow = !!(r.studentId && trialSetReplLt && trialSetReplLt.has(r.studentId));
          const replCandidates = students.filter(s => !(modal.form.studentRows || []).some(sr => sr.studentId === s.id) && !(modal.form.replacementRows || []).some((rr,ri) => ri !== i && rr.studentId === s.id));
          return <div key={i} className="repl-row">
            <span className="repl-badge-sm">R</span>
            <div style={{flex:'1.5',minWidth:0,position:'relative'}}>
              <StudentSelect valueId={r.studentId} fallbackLabel={r.name||''} studentById={studentById} candidates={replCandidates} onPick={(stu)=>{
                const rows=[...(modal.form.replacementRows||[])];
                const pendingHit = stu && ltId && pendingByKey && pendingByKey[`${stu.id}:${ltId}:${wk}`];
                rows[i]={ ...rows[i], studentId:stu?.id||null, name:stu?.name||'', age:stu?.age??null, replacementFrom: pendingHit ? encodeReplacementFrom(pendingHit.original_session_id, pendingHit.original_session_label) : (trialStudentIds && stu && trialStudentIds.has(stu.id) ? '(trial)' : rows[i].replacementFrom) };
                setModal({...modal,form:{...modal.form,replacementRows:rows}});
              }} conflict={null} trialStudentIds={trialStudentIds}
        trialByLessonType={trialByLessonType} pendingByKey={pendingByKey} weekStartDate={wk} lessonTypeId={ltId} />
              {isPending ? <span className="qp-tag qp-tag-r" style={{position:'absolute',top:-8,right:6,zIndex:1}}>R-pending</span> : (isTrialRow ? <span className="qp-tag qp-tag-trial" style={{position:'absolute',top:-8,right:6,zIndex:1}}>trial</span> : null)}
            </div>
            <input className="input" style={{flex:1}} placeholder="From class (e.g. Tue 10:00 AM)" value={replFromLabel(r.replacementFrom)||''} onChange={(e)=>{ const rows=[...(modal.form.replacementRows||[])]; rows[i]={...rows[i],replacementFrom:encodeReplacementFrom(rows[i].originalSessionId||null,e.target.value)}; setModal({...modal,form:{...modal.form,replacementRows:rows}}); }} />
            {(r.studentId || (r.name||'').trim()) ? <div className="att-seg" role="group" aria-label="Attendance">
              <button type="button" className={`att-btn att-pending ${(r.attendance||'pending')==='pending'?'is-on':''}`} onClick={()=>setReplAttendance(i,'pending')} title="Not yet marked — credit untouched">⏳</button>
              <button type="button" className={`att-btn att-attended ${r.attendance==='attended'?'is-on':''}`} onClick={()=>setReplAttendance(i,'attended')} title="Attended — lesson delivered (−1 credit on save)">✓</button>
              <button type="button" className={`att-btn att-absent ${r.attendance==='absent'?'is-on':''}`} onClick={()=>setReplAttendance(i,'absent')} title="Absent — counts as a delivered lesson, no replacement entitled (−1 credit on save)">✗</button>
            </div> : null}
            <button className="btn btn-ghost small" style={{flexShrink:0}} onClick={async ()=>{
              // If this is a real placed-replacement student, check whether
              // the session week has already passed before silently removing them.
              if(r.studentId){
                const sessionWeek = modal.weekStartDate || selectedWeekStart;
                const datePassed = sessionWeek < todayStr();
                const fromLabel = r.replacementFrom ? ` (placed from: ${r.replacementFrom})` : '';
                const passedNote = datePassed
                  ? `\n\n⚠️ Note: The session week (${sessionWeek}) has already passed. The student can still be restored to their original slot — it will be recorded in a past week.`
                  : '';
                const choice = datePassed
                  ? window.confirm(`Remove ${r.name} from this replacement slot${fromLabel}?\n\nThey will be returned to the pending replacement (limbo) state.${passedNote}\n\nClick OK to restore to limbo. Click Cancel to leave them in this session.`)
                  : true;
                if(!choice){ return; }
              }
              const rows=(modal.form.replacementRows||[]).filter((_,ri)=>ri!==i);
              setModal({...modal,form:{...modal.form,replacementRows:rows}});
            }}>×</button>
          </div>;
        })}
      </div>}

      {/* ── PERSONAL: reschedule this week only ── */}
      {isPersonal && <div className="repl-section">
        {isRescheduled && <div className="reschedule-notice">
          <span className="reschedule-from-badge">⇄ Rescheduled this week — was originally {DAYS_F[modal.rescheduledFromDay]} at {minuteToTime(modal.rescheduledFromStartMinute)}</span>
          <button className="btn btn-ghost small" onClick={()=>setModal({...modal,day:modal.rescheduledFromDay,startMinute:modal.rescheduledFromStartMinute,rescheduledFromDay:null,rescheduledFromStartMinute:null})}>Restore original slot</button>
        </div>}
        <div className="reschedule-head">
          <span className="repl-section-title">⇄ Reschedule this week only</span>
          <button className="btn btn-ghost small" onClick={()=>{ setReschedDay(modal.day); setReschedMinute(modal.startMinute); setRescheduleOpen(o=>!o); }}>{rescheduleOpen?'Cancel':'Change slot'}</button>
        </div>
        {rescheduleOpen && <div className="reschedule-form">
          <div className="field" style={{margin:0}}><label>New day</label>
            <select className="select" value={reschedDay} onChange={(e)=>setReschedDay(Number(e.target.value))}>
              {DAYS_F.map((d,i)=><option key={i} value={i}>{d}</option>)}
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>New start time</label>
            <select className="select" value={reschedMinute} onChange={(e)=>setReschedMinute(Number(e.target.value))}>
              {Array.from({length:25},(_,i)=>480+i*30).map(m=><option key={m} value={m}>{minuteToTime(m)}</option>)}
            </select>
          </div>
          <button className="btn btn-primary small" style={{alignSelf:'flex-end'}} onClick={()=>{
            setModal(prev=>({ ...prev,
              rescheduledFromDay: prev.rescheduledFromDay ?? prev.day,
              rescheduledFromStartMinute: prev.rescheduledFromStartMinute ?? prev.startMinute,
              day: reschedDay,
              startMinute: reschedMinute
            }));
            setRescheduleOpen(false);
          }}>Apply reschedule</button>
          <div className="hint" style={{gridColumn:'1/-1',marginTop:0}}>Returns to canonical slot from next week.</div>
        </div>}
      </div>}

      {/* ── ALL CLASS TYPES: Credit Balances ──────────────────────────────
          Every lesson type is credit-based now. Each enrolled swimmer who
          has been placed in the session shows their remaining balance for
          this lesson type; if they don't yet have a balance row, the seed
          UI lets you set the initial count (defaults to 4 = one lesson per
          week × four weeks of the month). */}
      {(modal.form.studentRows||[]).some(r=>r.studentId) && <div className="repl-section">
        <div className="repl-section-title" style={{marginBottom:6}}>Credit Balances</div>
        {(modal.form.studentRows||[]).filter(r=>r.studentId).map((r,i)=>{
          const bal = creditByKey && creditByKey[`${r.studentId}:${currentLt?.id}`];
          // Most recent purchase for this (swimmer, lesson type), used
          // to surface "purchased on" info inline so the scheduler can
          // confirm which batch the balance was seeded from.
          const purchases = purchasesByKey && currentLt?.id ? (purchasesByKey[`${r.studentId}:${currentLt.id}`] || []) : [];
          const lastPurchase = purchases[0] || null;
          const lastPurchaseLabel = lastPurchase
            ? `${Number(lastPurchase.credits_added) > 0 ? '+' : ''}${lastPurchase.credits_added} on ${lastPurchase.purchase_date}`
            : null;
          return <div key={r.studentId||i} className="credit-row">
            <span className="credit-row-name">{r.name || 'Student'}{lastPurchaseLabel ? <span className="credit-row-last"> · last {lastPurchaseLabel}</span> : null}</span>
            {bal
              ? <div className="credit-controls">
                  <span className={`credit-count ${bal.remaining_balance<=2?'credit-low':''}`}>{bal.remaining_balance} credits</span>
                  <button className="credit-btn" title="Deduct 1 credit (class attended)" onClick={()=>adjustCredit(r.studentId,currentLt.id,-1)}>−</button>
                  <button className="credit-btn" title="Add 1 credit (credit returned)" onClick={()=>adjustCredit(r.studentId,currentLt.id,+1)}>+</button>
                </div>
              : <div className="credit-init">
                  <input className="input" style={{width:64,fontSize:12}} type="number" min="1" placeholder="Credits" value={initCreditInput[r.studentId]||4} onChange={(e)=>setInitCreditInput(prev=>({...prev,[r.studentId]:e.target.value}))} />
                  <button className="btn btn-ghost small" title="Record this as a purchase (with today's date) and set the initial balance" onClick={async ()=>{
                    const n = Number(initCreditInput[r.studentId]||4);
                    if(!n || !currentLt?.id) return;
                    // Prefer addCreditPurchase so the seed shows up in the
                    // swimmer's purchase ledger with today's date. Falls
                    // back to initCredit if the purchases backend isn't
                    // available yet (e.g. migration not run).
                    if(addCreditPurchase){
                      await addCreditPurchase({
                        studentId: r.studentId, lessonTypeId: currentLt.id,
                        purchaseDate: toDateStr(new Date()), creditsAdded: n,
                        source: 'signup', notes: 'Seeded from session editor'
                      });
                    } else {
                      initCredit(r.studentId, currentLt.id, n);
                    }
                  }}>Record purchase</button>
                </div>
            }
          </div>;
        })}
      </div>}

      {/* ── Full Class Replacement (entire-class cancel) ────────────────
          Visible only on existing sessions (modal.id), since cancelling a
          new unsaved session isn't a meaningful action. Two routes — see
          App.forwardClassToNextWeek / App.startFullClassMove for the
          business logic. */}
      {modal.id && <div className="cancel-class-panel">
        <button type="button" className={`cancel-class-toggle ${cancelClassOpen?'is-open':''}`} onClick={()=>setCancelClassOpen(o=>!o)}>
          <span>🚫 Cancel entire class for this week</span>
          <span className="cancel-class-chev">{cancelClassOpen ? '▴' : '▾'}</span>
        </button>
        {cancelClassOpen && <div className="cancel-class-options">
          <div className="cancel-class-hint">All swimmers in this session are affected. Their credits will not be consumed for this cancellation.</div>
          <div className="cancel-class-buttons">
            <button type="button" className="cancel-class-opt" onClick={()=>{
              const label = `${currentLt?.name || modal.form.type} on ${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
              forwardClassToNextWeek && forwardClassToNextWeek(modal.id, label);
            }}>
              <div className="cancel-class-opt-title">⏭ Forward to next week</div>
              <div className="cancel-class-opt-sub">Cancels this week's run and recreates the same class next week (same day, time, swimmers). Any credits already consumed this week are refunded. If next week already has this class, it merges in instead of duplicating.</div>
            </button>
            <button type="button" className="cancel-class-opt" onClick={()=>{
              const label = `${DAYS_F[modal.day]} ${minuteToTime(modal.startMinute)}`;
              const swimmerCount = (modal.form.studentRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length + (modal.form.replacementRows||[]).filter(r=>r.studentId || (r.name||'').trim()).length;
              startFullClassMove && startFullClassMove({
                sessionId: modal.id,
                sourceLabel: label,
                lessonTypeName: currentLt?.name || modal.form.type,
                weekStartDate: modal.weekStartDate,
                originalDay: modal.day,
                originalStartMinute: modal.startMinute,
                swimmerCount
              });
            }}>
              <div className="cancel-class-opt-title">📅 Reschedule to another slot</div>
              <div className="cancel-class-opt-sub">Pick a day &amp; time on the weekly grid. Same swimmers, same instructor, same pool — just a different slot this week.</div>
            </button>
          </div>
        </div>}
      </div>}

      {/* ── Duplicate Forward — clone this session into N future weeks ──
          at the same slot. The session-wide complement to the existing
          week-wide "Duplicate Previous Week". Same swimmers, instructor,
          pool. Attendance resets per clone. Skips weeks that already
          have a matching session at the same slot. */}
      {modal.id && duplicateSessionForward && <div className="cancel-class-panel">
        <button type="button" className={`cancel-class-toggle ${dupOpen?'is-open':''}`} onClick={()=>setDupOpen(o=>!o)} style={{background:'#EFF6FF',borderColor:'#BFDBFE',color:'#1E40AF'}}>
          <span>⏩ Duplicate this session to future weeks</span>
          <span className="cancel-class-chev" style={{color:'#1E40AF'}}>{dupOpen ? '▴' : '▾'}</span>
        </button>
        {dupOpen && <div className="cancel-class-options" style={{background:'#EFF6FF',borderColor:'#BFDBFE'}}>
          <div className="cancel-class-hint" style={{color:'#1E40AF'}}>Clones this session into the next N weeks at the same day &amp; time, with the same swimmers, instructor, and pool. Existing matching sessions at those slots will be skipped.</div>
          <div className="dup-buttons">
            {[1, 2, 3, 4, 8, 12].map(n => <button key={n} type="button" className="dup-btn" onClick={()=>duplicateSessionForward(modal.id, n)}>
              {n === 1 ? 'Next week' : `Next ${n} weeks`}
            </button>)}
            <button type="button" className="dup-btn" onClick={()=>{
              const v = prompt('How many weeks ahead to duplicate? (1–52)', '4');
              const n = Math.max(1, Math.min(52, parseInt(v, 10) || 0));
              if(n > 0) duplicateSessionForward(modal.id, n);
            }}>Custom…</button>
          </div>
        </div>}
      </div>}
    </div>
    <div className="modal-foot">
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {modal.id ? <button className="btn btn-danger small" onClick={deleteSession}>Delete</button> : null}
        <button className="btn btn-ghost small" onClick={() => openAddAtTime(modal.day, modal.startMinute, modal.form.poolId)}>+ Same Time</button>
      </div>
      <button className="btn btn-primary" onClick={saveSession}>{saveBusy ? 'Saving…' : 'Save Session'}</button>
    </div>
  </div></div>;
}

// ============================================================================
// PrintWeeklyTableSection (M2: pool labels per session in cells)
// ============================================================================

function PrintWeeklyTableSection({ weekBlocksAllPools, wb, selectedWeekStart, gridSlots, gridBounds, slotToMinute, poolById, branchLabel }){
  const dayHeaders = DAYS_F.map((d, di) => {
    const dateObj = new Date(wb.start);
    dateObj.setDate(wb.start.getDate() + di);
    return { label: d, dateStr: dateObj.toLocaleDateString(undefined, { day:'2-digit', month:'2-digit', year:'numeric' }) };
  });

  // Each day is already a packed array of all-pool blocks; attach pool name.
  const flatBlocksByDay = Array.from({length:7}, (_, di) => {
    return (weekBlocksAllPools[di] || []).map(b => ({ ...b, _poolName: (poolById(b.poolId)?.name) || '' }));
  });

  const startMap = {};
  const coveredMap = {};
  flatBlocksByDay.forEach((dayBlocks, di) => {
    dayBlocks.forEach(block => {
      const sk = `${di}-${block.startMinute}`;
      if(!startMap[sk]) startMap[sk] = [];
      startMap[sk].push(block);
      for(let m = block.startMinute + SLOT_MIN; m < block.startMinute + block.durationMinutes; m += SLOT_MIN){
        coveredMap[`${di}-${m}`] = true;
      }
    });
  });

  const rows = Array.from({ length: gridSlots }, (_, si) => {
    const slotMin = slotToMinute(si);
    const isHour = slotMin % 60 === 0;
    return (
      <tr key={si} className={isHour ? 'wt-row wt-hour-row' : 'wt-row wt-half-row'}>
        <td className="wt-time-cell">{isHour ? <strong>{minuteToTime(slotMin)}</strong> : <span className="wt-half-label">{minuteToTime(slotMin)}</span>}</td>
        {Array.from({ length: 7 }, (_, di) => {
          const k = `${di}-${slotMin}`;
          const starts = startMap[k];
          const isCovered = coveredMap[k];
          if(starts && starts.length){
            return <td key={di} className="wt-cell wt-session-cell">
              {starts.map((block, idx) => (
                <div key={block.id} className={idx > 0 ? 'wt-sess wt-sess-sep' : 'wt-sess'}>
                  <div className="wt-sess-type">{block.type}</div>
                  <div className="wt-sess-meta">{(block.instructors[0]?.name) || block.legacyInstructor || '—'} &middot; {block.durationMinutes}&thinsp;min{block._poolName ? ` · ${block._poolName}` : ''}</div>
                  {block.students.length > 0 ? <div className="wt-sess-students">{block.students.map(studentLabel).join(', ')}</div> : null}
                </div>
              ))}
            </td>;
          }
          if(isCovered){
            return <td key={di} className="wt-cell wt-cont-cell"><span className="wt-cont-bar">|</span></td>;
          }
          return <td key={di} className="wt-cell wt-empty-cell"></td>;
        })}
      </tr>
    );
  });

  return <div className="print-weekly-table">
    <div className="wt-header">
      <div className="wt-title">Weekly Schedule{branchLabel ? ` — ${branchLabel}` : ''}</div>
      <div className="wt-meta">Week of {selectedWeekStart} &nbsp;&middot;&nbsp; {wb.start.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})} &ndash; {wb.end.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
    </div>
    <table className="wt-table">
      <thead>
        <tr>
          <th className="wt-th-time">Time</th>
          {dayHeaders.map((dh, i) => (
            <th key={i} className="wt-th-day">
              <div className="wt-th-dayname">{dh.label}</div>
              <div className="wt-th-daydate">{dh.dateStr}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows}
        <tr className="wt-row wt-hour-row">
          <td className="wt-time-cell"><strong>{minuteToTime(gridBounds.endMin)}</strong></td>
          {Array.from({length:7},(_,di) => <td key={di} className="wt-cell wt-empty-cell"></td>)}
        </tr>
      </tbody>
    </table>
  </div>;
}

// ============================================================================
// Global error trap + mount
// ============================================================================

// ── Error reporting ───────────────────────────────────────────────────
// Babel-transformed scripts can mask real errors as the generic "Script
// error." string. We capture as much detail as the runtime gives us
// (message, source, line:col, stack) and present it readably so issues
// can actually be diagnosed instead of dead-ending at "Script error." A
// "Copy details" button puts everything onto the clipboard for sharing.

function showDiagnosticError(label, detail){
  const root = document.getElementById('root');
  if(!root) return;
  const block = document.createElement('div');
  block.style.cssText = 'padding:24px 18px;max-width:880px;margin:24px auto;font-family:Inter,system-ui,sans-serif';
  block.innerHTML = `
    <div style="background:#FEE2E2;border:1px solid #FCA5A5;color:#7F1D1D;padding:20px 22px;border-radius:14px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
      <div style="font-size:18px;font-weight:800;margin-bottom:6px">⚠ ${label}</div>
      <div style="font-size:13px;margin-bottom:14px;color:#9B2B2B">The app caught an error. Please screenshot or copy the details below and share them.</div>
      <pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #FECACA;border-radius:10px;padding:12px 14px;font-size:12px;font-family:'SF Mono',Menlo,Consolas,monospace;color:#7F1D1D;max-height:280px;overflow:auto">${detail.replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</pre>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="err-copy" style="background:#7F1D1D;color:#fff;border:none;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Copy details</button>
        <button id="err-reload" style="background:#fff;color:#7F1D1D;border:1px solid #FCA5A5;padding:9px 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Reload</button>
      </div>
    </div>`;
  root.innerHTML = '';
  root.appendChild(block);
  const copyBtn = document.getElementById('err-copy');
  if(copyBtn) copyBtn.onclick = () => { try{ navigator.clipboard.writeText(`${label}\n\n${detail}`); copyBtn.textContent = 'Copied'; }catch(_){} };
  const reloadBtn = document.getElementById('err-reload');
  if(reloadBtn) reloadBtn.onclick = () => location.reload();
}
function formatErrEvent(ev){
  const lines = [];
  if(ev.error){
    lines.push(`Message: ${ev.error.message || '(none)'}`);
    if(ev.error.stack) lines.push(`\nStack:\n${ev.error.stack}`);
  } else {
    lines.push(`Message: ${ev.message || '(none)'}`);
  }
  if(ev.filename) lines.push(`\nSource: ${ev.filename}:${ev.lineno}:${ev.colno}`);
  if(navigator.userAgent) lines.push(`\nUA: ${navigator.userAgent}`);
  return lines.join('\n');
}
window.addEventListener('error', (ev) => { try{ console.error('[ssb] window error:', ev.error || ev); showDiagnosticError('App error', formatErrEvent(ev)); }catch(_){} });
window.addEventListener('unhandledrejection', (ev) => { try{
  const reason = ev.reason;
  const detail = (reason && reason.stack) ? `Message: ${reason.message || reason}\n\nStack:\n${reason.stack}` : String(reason);
  console.error('[ssb] unhandled promise rejection:', reason);
  showDiagnosticError('Async error', detail);
}catch(_){} });

// React Error Boundary — catches errors thrown during render or in
// lifecycle methods (event handlers still bubble to window.onerror).
class ErrorBoundary extends React.Component {
  constructor(props){ super(props); this.state = { err: null, info: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){ console.error('[ssb] render error:', err, info); this.setState({ info }); }
  render(){
    if(this.state.err){
      const lines = [`Message: ${this.state.err.message || this.state.err}`];
      if(this.state.err.stack) lines.push(`\nStack:\n${this.state.err.stack}`);
      if(this.state.info && this.state.info.componentStack) lines.push(`\nComponent stack:${this.state.info.componentStack}`);
      // Use setTimeout so we render normally first, then swap to the
      // diagnostic — avoids re-entering setState during render.
      setTimeout(() => showDiagnosticError('Render error', lines.join('\n')), 0);
      return null;
    }
    return this.props.children;
  }
}

// ============================================================================
// Invoicing helpers
// ============================================================================
// ── Replacement-from codec ───────────────────────────────────────────────────
// replacement_from in the DB encodes BOTH the original session UUID and the
// human-readable label so the student can be fully restored after being
// un-placed from a makeup slot.
// Format: "<uuid>||<label>"  — backward compat: bare strings without || are labels only.
function encodeReplacementFrom(sessionId, label){
  return sessionId ? `${sessionId}||${label||''}` : (label||'');
}
function decodeReplacementFrom(raw){
  if(!raw) return { sessionId: null, label: '' };
  const sepIdx = raw.indexOf('||');
  if(sepIdx < 0) return { sessionId: null, label: raw };
  return { sessionId: raw.slice(0, sepIdx) || null, label: raw.slice(sepIdx + 2) };
}
function replFromLabel(raw){ return decodeReplacementFrom(raw).label; }

function invoiceStatusLabel(s){ return({draft:'Draft',sent:'Sent',partial:'Part Paid',paid:'Paid',void:'Void',refunded:'Refunded'})[s]||s; }
function invoiceStatusColor(s){ return({draft:'#94A3B8',sent:'#3B82F6',partial:'#F59E0B',paid:'#10B981',void:'#EF4444',refunded:'#8B5CF6'})[s]||'#94A3B8'; }
function methodLabel(m){
  const d = methodDef(m);
  if(d) return d.label;
  return({cash:'Cash',bank_transfer:'Bank Transfer',duitnow:'DuitNow',card:'Card',cheque:'Cheque',other:'Other'})[m]||m;
}

// Helper: resolve swimmer names for a group line


function InvoicesView({ branches, invoices, invoiceLines, pmts, pendingCredits, lessonTypeById, packageById, studentById, products, membersByGroup, invoiceSettings, paymentMethods, onSaveSettings, formatInvoiceNumber, formatReceiptNumber, onVoid, onDelete, onRefund, onEditVoidReason, onUpdateStatus, onRecordPayment, onConfirmCredit, onReverseCredit, onAddLine, onUpdateLine, onDeleteLine, externalSearchQ }){
  const [statusFilter,setStatusFilter]=useState('all');
  const [localSearchQ, setLocalSearchQ] = useState('');
  const searchQ = externalSearchQ !== undefined ? externalSearchQ : localSearchQ;
  const setSearchQ = setLocalSearchQ;
  const [expandedId,setExpandedId]=useState(null);
  const [selectedIds,setSelectedIds]=useState(new Set());
  const [branchFilter,setBranchFilter]=useState(null);
  const [methodFilter,setMethodFilter]=useState('all');   // 'all' | code | '__others'
  const [monthFilter,setMonthFilter]=useState('all');     // 'all' | 'YYYY-MM' (issue date)
  const [itemFilter,setItemFilter]=useState('all');       // 'all' | 'lt:<name>' | 'prod:<desc>' | '__others'
  const [page,setPage]=useState(1);
  const PAGE_SIZE=50;
  const today=todayStr();

  // Payments grouped by invoice — used for the method filter and the row pills
  const pmtsByInvoice = useMemo(()=>{
    const m={};
    (pmts||[]).forEach(p=>{ (m[p.invoice_id]=m[p.invoice_id]||[]).push(p); });
    return m;
  },[pmts]);

  // Lines grouped by invoice — used for the item filter
  const linesByInvoice = useMemo(()=>{
    const m={};
    (invoiceLines||[]).forEach(l=>{ (m[l.invoice_id]=m[l.invoice_id]||[]).push(l); });
    return m;
  },[invoiceLines]);

  // Filter options derived from actual data
  const monthOptions = useMemo(()=>{
    const s=new Set();
    invoices.forEach(i=>{ const d=i.issue_date||i.created_at; if(d) s.add(String(d).slice(0,7)); });
    return [...s].sort().reverse();
  },[invoices]);
  const knownMethodCodes = useMemo(()=>new Set(allMethods().map(m=>m.code)),[paymentMethods]);
  const itemOptions = useMemo(()=>{
    const lts=new Set(), prods=new Set();
    (invoiceLines||[]).forEach(l=>{
      if(l.lesson_type_name) lts.add(l.lesson_type_name);
      else if(l.line_type==='product'&&l.description) prods.add(l.description);
    });
    return { lessonTypes:[...lts].sort(), products:[...prods].sort() };
  },[invoiceLines]);

  function lineMatchesItem(l, filter){
    if(filter.startsWith('lt:'))   return l.lesson_type_name===filter.slice(3);
    if(filter.startsWith('prod:')) return l.line_type==='product'&&l.description===filter.slice(5);
    if(filter==='__others')        return !l.lesson_type_name && l.line_type!=='product' && l.line_type!=='adjustment';
    return true;
  }

  function isOverdue(inv){ return inv.due_date && inv.due_date < today && inv.status !== 'paid' && inv.status !== 'void' && inv.status !== 'refunded'; }

  const counts = useMemo(()=>{
    const c={all:invoices.length,draft:0,sent:0,partial:0,paid:0,void:0,refunded:0,overdue:0};
    invoices.forEach(i=>{ if(c[i.status]!=null)c[i.status]++; if(isOverdue(i))c.overdue++; });
    return c;
  },[invoices]);

  const filtered = useMemo(()=>{
    let list = invoices.slice();
    if(branchFilter) list = list.filter(i => i.branch_id === branchFilter);
    if(statusFilter==='overdue') list = list.filter(i=>isOverdue(i));
    else if(statusFilter !== 'all') list = list.filter(i=>i.status===statusFilter);
    if(monthFilter!=='all') list = list.filter(i=>String(i.issue_date||i.created_at||'').slice(0,7)===monthFilter);
    if(methodFilter!=='all'){
      list = list.filter(i=>{
        const ps = pmtsByInvoice[i.id]||[];
        if(methodFilter==='__others') return ps.some(p=>!knownMethodCodes.has((p.payment_method||'').toLowerCase()));
        return ps.some(p=>(p.payment_method||'').toLowerCase()===methodFilter);
      });
    }
    if(itemFilter!=='all'){
      list = list.filter(i=>(linesByInvoice[i.id]||[]).some(l=>lineMatchesItem(l,itemFilter)));
    }
    if(searchQ.trim()){
      const q=searchQ.toLowerCase();
      list=list.filter(i=>(i.invoice_number||'').toLowerCase().includes(q)||(i.account_name||'').toLowerCase().includes(q));
    }
    return list.sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||''));
  },[invoices,statusFilter,searchQ,branchFilter,methodFilter,monthFilter,itemFilter,pmtsByInvoice,linesByInvoice,knownMethodCodes]);

  // Pagination — filters run first, then the current page is sliced out.
  const pageCount = Math.max(1, Math.ceil(filtered.length/PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(()=>filtered.slice((safePage-1)*PAGE_SIZE, safePage*PAGE_SIZE),[filtered,safePage]);
  useEffect(()=>{ setPage(1); },[statusFilter,branchFilter,searchQ,methodFilter,monthFilter,itemFilter]);

  function toggleSelect(id){ const s=new Set(selectedIds); s.has(id)?s.delete(id):s.add(id); setSelectedIds(s); }
  function toggleAll(){ setSelectedIds(selectedIds.size===filtered.length?new Set():new Set(filtered.map(i=>i.id))); }
  const selCount=selectedIds.size;
  const selDraft=filtered.filter(i=>selectedIds.has(i.id)&&i.status==='draft').length;
  async function bulkMarkSent(){
    const targets=filtered.filter(i=>selectedIds.has(i.id)&&i.status==='draft');
    for(const inv of targets) await onUpdateStatus(inv.id,'sent');
    setSelectedIds(new Set());
  }
  async function bulkPrint(){
    const targets=filtered.filter(i=>selectedIds.has(i.id));
    targets.forEach(inv=>{ const lines=invoiceLines.filter(l=>l.invoice_id===inv.id); printInvoice(inv,lines,membersByGroup); });
  }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:800}}>🧾 Invoices</div>
          <div className="small subtle" style={{marginTop:3}}>Create and manage invoices, record payments, and issue receipts.</div>
        </div>
      </div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:8}}>
        <BranchFilterPills branches={branches} value={branchFilter} onChange={setBranchFilter} />
        {[['all','All'],['draft','Draft'],['sent','Sent'],['partial','Part Paid'],['paid','Paid'],['void','Void'],['refunded','Refunded'],['overdue','Overdue']].map(([k,l])=>
          <button key={k} className={`tab ${statusFilter===k?'active':''}`} style={{padding:'4px 10px',fontSize:11}} onClick={()=>setStatusFilter(k)}>
            {l} {counts[k]!=null?`(${counts[k]})`:null}
          </button>)}
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        {externalSearchQ === undefined && <input className="input" style={{flex:1,maxWidth:340}} placeholder="Search invoice # or account…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />}
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,cursor:'pointer'}}>
          <input type="checkbox" checked={selCount===filtered.length&&filtered.length>0} onChange={toggleAll} /> Select all
        </label>
        <span className="small subtle">{filtered.length} / {invoices.length}</span>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginTop:8}}>
        <select className="select" value={methodFilter} onChange={e=>setMethodFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',maxWidth:170}}>
          <option value="all">💳 All methods</option>
          {allMethods().map(m=><option key={m.code} value={m.code}>{m.label}</option>)}
          <option value="__others">Others / unknown</option>
        </select>
        <select className="select" value={monthFilter} onChange={e=>setMonthFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',maxWidth:150}}>
          <option value="all">📅 All months</option>
          {monthOptions.map(m=><option key={m} value={m}>{m}</option>)}
        </select>
        <select className="select" value={itemFilter} onChange={e=>setItemFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',maxWidth:220}}>
          <option value="all">🏷 All items</option>
          {itemOptions.lessonTypes.length>0 && <optgroup label="Lesson Types">
            {itemOptions.lessonTypes.map(n=><option key={'lt:'+n} value={'lt:'+n}>{n}</option>)}
          </optgroup>}
          {itemOptions.products.length>0 && <optgroup label="Products">
            {itemOptions.products.map(n=><option key={'prod:'+n} value={'prod:'+n}>{n}</option>)}
          </optgroup>}
          <option value="__others">Others (custom lines)</option>
        </select>
        {(methodFilter!=='all'||monthFilter!=='all'||itemFilter!=='all')&&
          <button className="btn btn-ghost small" onClick={()=>{setMethodFilter('all');setMonthFilter('all');setItemFilter('all');}}>✕ Clear filters</button>}
      </div>
      {selCount>0&&<div className="inv-bulk-bar">
        <span className="small" style={{fontWeight:700}}>{selCount} selected</span>
        {selDraft>0&&<button className="btn btn-ghost small" onClick={bulkMarkSent}>Mark Sent ({selDraft})</button>}
        <button className="btn btn-ghost small" onClick={bulkPrint}>🖨 Print Selected</button>
        <button className="btn btn-ghost small" onClick={()=>setSelectedIds(new Set())}>Clear</button>
      </div>}
    </div>

    {filtered.length===0&&<div className="card empty" style={{padding:32}}>No invoices match the current filter.</div>}

    <div style={{display:'flex',flexDirection:'column',gap:4}}>
      {paged.map(inv=>{
        const overdue=isOverdue(inv);
        const isExpanded=expandedId===inv.id;
        const isSelected=selectedIds.has(inv.id);
        const invLines=linesByInvoice[inv.id]||[];
        const invPmts=pmtsByInvoice[inv.id]||[];
        const invPcs=pendingCredits.filter(pc=>pc.invoice_id===inv.id);
        const methodsUsed=[...new Set(invPmts.map(p=>(p.payment_method||'').toLowerCase()).filter(Boolean))];
        const total=Number(inv.total_amount)||0;
        const paid=Number(inv.amount_paid)||0;
        const outstanding=Math.max(0,total-paid);
        return <div key={inv.id} className={`inv-card${isExpanded?' is-expanded':''}${overdue?' is-overdue':''}`}>
          <div className="inv-card-head" onClick={()=>setExpandedId(isExpanded?null:inv.id)}>
            <label style={{display:'flex',alignItems:'center'}} onClick={e=>e.stopPropagation()}>
              <input type="checkbox" checked={isSelected} onChange={()=>toggleSelect(inv.id)} />
            </label>
            <span style={{fontFamily:'monospace',fontSize:11,fontWeight:700,minWidth:90,flexShrink:0}}>{inv.invoice_number||'#—'}</span>
            <span className={`inv-status-chip s-${inv.status||'draft'}`} title={inv.status==='void'&&inv.void_reason?`Void reason: ${inv.void_reason}`:undefined}>{invoiceStatusLabel(inv.status)}</span>
            {overdue&&<span className="inv-status-chip s-overdue">Overdue</span>}
            <span style={{flex:1,minWidth:0,fontSize:11.5,fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{inv.account_name||'—'}</span>
            <span className="small subtle" style={{fontSize:10.5,whiteSpace:'nowrap',flexShrink:0}}>{inv.issue_date||'—'}{inv.due_date?` → ${inv.due_date}`:''}</span>
            <span style={{fontWeight:700,fontSize:12,minWidth:80,textAlign:'right',flexShrink:0}}>RM {total.toFixed(2)}</span>
            {paid>0&&<span className="small subtle" style={{fontSize:10,minWidth:90,textAlign:'right',flexShrink:0,color:outstanding>0?'var(--amber-tx)':'var(--green-tx)'}}>{outstanding>0?`Owed ${outstanding.toFixed(2)}`:`Paid`}</span>}
            {methodsUsed.length>0&&<span style={{display:'flex',gap:3,flexShrink:0}}>{methodsUsed.map(mc=><MethodPill key={mc} code={mc} small/>)}</span>}
            <span style={{flexShrink:0,color:'var(--text-3)',fontSize:10,width:14,textAlign:'center'}}>{isExpanded?'▲':'▼'}</span>
          </div>
          {isExpanded&&<InvoiceDetailPanel
            invoice={inv} lines={invLines} pmts={invPmts} pendingCredits={invPcs}
            isOverdue={overdue} membersByGroup={membersByGroup} products={products}
            onVoid={(reason)=>onVoid(inv.id, reason)}
            onEditVoidReason={onEditVoidReason ? (reason)=>onEditVoidReason(inv.id, reason) : null}
            onDelete={onDelete ? ()=>onDelete(inv.id) : null}
            onRefund={onRefund ? (data)=>onRefund({invoiceId:inv.id,...data}) : null}
            onUpdateStatus={(s)=>onUpdateStatus(inv.id,s)}
            onRecordPayment={(data)=>onRecordPayment({invoiceId:inv.id,...data})}
            onConfirmCredit={onConfirmCredit} onReverseCredit={onReverseCredit}
            onAddLine={(data)=>onAddLine(inv.id,data)}
            onUpdateLine={onUpdateLine} onDeleteLine={onDeleteLine}
          />}
        </div>;
      })}
    </div>
    {pageCount>1&&<div style={{display:'flex',gap:4,justifyContent:'center',alignItems:'center',marginTop:14,flexWrap:'wrap'}}>
      <button className="btn btn-ghost small" disabled={safePage<=1} onClick={()=>setPage(safePage-1)}>‹ Prev</button>
      {Array.from({length:pageCount},(_,i)=>i+1)
        .filter(n=>n===1||n===pageCount||Math.abs(n-safePage)<=2)
        .reduce((acc,n,idx,arr)=>{ if(idx>0&&n-arr[idx-1]>1) acc.push('…'); acc.push(n); return acc; },[])
        .map((n,i)=> n==='…'
          ? <span key={'gap'+i} className="small subtle" style={{padding:'0 4px'}}>…</span>
          : <button key={n} className={`btn small ${n===safePage?'btn-primary':'btn-ghost'}`} style={{minWidth:34}} onClick={()=>setPage(n)}>{n}</button>)}
      <button className="btn btn-ghost small" disabled={safePage>=pageCount} onClick={()=>setPage(safePage+1)}>Next ›</button>
      <span className="small subtle" style={{marginLeft:8}}>Page {safePage} of {pageCount} · {filtered.length} invoices</span>
    </div>}
  </>;
}

function InvoiceDetailPanel({ invoice, lines, pmts, pendingCredits, isOverdue, membersByGroup, products, onVoid, onDelete, onRefund, onEditVoidReason, onUpdateStatus, onRecordPayment, onConfirmCredit, onReverseCredit, onAddLine, onUpdateLine, onDeleteLine }){
  const [showPayForm,setShowPayForm]=useState(false);
  const [lastReceipt,setLastReceipt]=useState(null);
  const outstanding=(invoice.status==='refunded'||invoice.status==='void')?0:Math.max(0,(Number(invoice.total_amount)||0)-(Number(invoice.amount_paid)||0));
  const [payAmt,setPayAmt]=useState('');
  const [payDate,setPayDate]=useState(todayStr());
  const [payMethod,setPayMethod]=useState('cash');
  const [payRef,setPayRef]=useState('');
  const [payNotes,setPayNotes]=useState('');
  const [payBusy,setPayBusy]=useState(false);
  // Refund state
  const [showRefundForm,setShowRefundForm]=useState(false);
  const [refAmt,setRefAmt]=useState('');
  const [refDate,setRefDate]=useState(todayStr());
  const [refMethod,setRefMethod]=useState('cash');
  const [refReason,setRefReason]=useState('');
  const [refBusy,setRefBusy]=useState(false);
  const paidTotal=Number(invoice.amount_paid)||0;

  // Void state
  const [showVoidForm,setShowVoidForm]=useState(false);
  const [voidReason,setVoidReason]=useState('');
  const [voidBusy,setVoidBusy]=useState(false);
  async function submitVoid(){
    if(!voidReason.trim()) return;
    setVoidBusy(true);
    try{ await onVoid(voidReason.trim()); setShowVoidForm(false); setVoidReason(''); }
    catch(err){ alert(err.message||'Failed to void'); }
    finally{ setVoidBusy(false); }
  }
  // Add/amend the reason on an already-voided invoice
  const [showReasonEdit,setShowReasonEdit]=useState(false);
  const [reasonDraft,setReasonDraft]=useState('');
  const [reasonBusy,setReasonBusy]=useState(false);
  async function submitReasonEdit(){
    setReasonBusy(true);
    try{ await onEditVoidReason(reasonDraft.trim()); setShowReasonEdit(false); }
    catch(err){ alert(err.message||'Failed to update reason'); }
    finally{ setReasonBusy(false); }
  }
  // Add a product / goods line to the invoice
  const [showItemForm,setShowItemForm]=useState(false);
  const [itemDesc,setItemDesc]=useState('');
  const [itemQty,setItemQty]=useState(1);
  const [itemPrice,setItemPrice]=useState('');
  const [itemBusy,setItemBusy]=useState(false);
  const itemTotal=(Math.max(1,Number(itemQty)||1))*(Number(itemPrice)||0);
  // Deduction / discount line — stored as a NEGATIVE 'adjustment' line.
  // Amount is entered positive (less error-prone) and negated on save.
  const [showDeductForm,setShowDeductForm]=useState(false);
  const [deductDesc,setDeductDesc]=useState('');
  const [deductAmt,setDeductAmt]=useState('');
  const [deductBusy,setDeductBusy]=useState(false);
  const DEDUCT_REASONS=['Pro-rata — late start','Goodwill adjustment','Sibling discount','Promo discount'];
  async function submitDeduct(){
    const desc=deductDesc.trim();
    const amt=Math.abs(Number(deductAmt)||0);
    if(!desc){ alert('Enter a reason for the deduction — it appears on the invoice.'); return; }
    if(!amt){ alert('Enter a deduction amount.'); return; }
    const curTotal=Number(invoice.total_amount)||0;
    if(amt>curTotal){ alert(`Deduction (RM ${amt.toFixed(2)}) exceeds the current invoice total (RM ${curTotal.toFixed(2)}). The total cannot go below zero.`); return; }
    setDeductBusy(true);
    try{ await onAddLine({ description:desc, amount:-amt, lineType:'adjustment' });
      setShowDeductForm(false); setDeductDesc(''); setDeductAmt('');
    }catch(err){ alert(err.message||'Failed to add deduction'); }
    finally{ setDeductBusy(false); }
  }
  async function submitItem(){
    const desc=itemDesc.trim(); const unit=Number(itemPrice)||0; const qty=Math.max(1,Number(itemQty)||1);
    if(!desc){ alert('Enter an item name.'); return; }
    if(!unit){ alert('Enter a unit price.'); return; }
    setItemBusy(true);
    try{ await onAddLine({ description:desc, quantity:qty, unitPrice:unit, lineType:'product' });
      setShowItemForm(false); setItemDesc(''); setItemQty(1); setItemPrice('');
    }catch(err){ alert(err.message||'Failed to add item'); }
    finally{ setItemBusy(false); }
  }
  const canEditLines = onAddLine && invoice.status!=='void' && invoice.status!=='refunded';

  async function submitRefund(){
    const amt=Math.abs(Number(refAmt)||0);
    if(!amt){ alert('Enter a valid refund amount.'); return; }
    setRefBusy(true);
    try{
      await onRefund({ amount:amt, refundDate:refDate, method:refMethod, reason:refReason.trim()||null });
      setShowRefundForm(false); setRefAmt(''); setRefReason('');
    }catch(err){ alert(err.message||'Failed to record refund'); }
    finally{ setRefBusy(false); }
  }

  async function submitPayment(){
    if(!payAmt||isNaN(Number(payAmt))||Number(payAmt)<=0){alert('Enter a valid amount.');return;}
    setPayBusy(true);
    try{
      const pmt=await onRecordPayment({ amount:Number(payAmt), payment_date:payDate, payment_method:payMethod, reference_number:payRef.trim()||null, notes:payNotes.trim()||null });
      setLastReceipt(pmt);
      setShowPayForm(false);
      setPayAmt(''); setPayRef(''); setPayNotes('');
    }catch(err){alert(err.message||'Failed to record payment');}
    finally{setPayBusy(false);}
  }

  return <div className="inv-detail">
    {isOverdue&&<div className="inv-overdue-banner">⚠ This invoice is overdue. Due date was {invoice.due_date}.</div>}
    <div className="inv-detail-head">
      <div>
        <div className="small subtle">Bill To</div>
        <div style={{fontWeight:700}}>{invoice.account_name||'—'}</div>
        {invoice.account_email&&<div className="small subtle">{invoice.account_email}</div>}
        {invoice.notes&&<div className="small subtle" style={{marginTop:4,fontStyle:'italic'}}>{invoice.notes}</div>}
        {invoice.status==='void'&&(showReasonEdit
          ? <div style={{marginTop:6,padding:'8px 10px',border:'1px solid var(--red-bd)',borderRadius:8,background:'#FFF5F5'}}>
              <div className="field-label" style={{color:'#B91C1C'}}>Void reason <span className="subtle">(max 100)</span></div>
              <textarea className="textarea" style={{minHeight:52}} maxLength={100} value={reasonDraft} onChange={e=>setReasonDraft(e.target.value.slice(0,100))} placeholder="e.g. Duplicate — reissued under correct parent" />
              <div className="small subtle" style={{textAlign:'right'}}>{reasonDraft.length}/100</div>
              <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:4}}>
                <button className="btn btn-ghost small" onClick={()=>setShowReasonEdit(false)}>Cancel</button>
                <button className="btn btn-primary small" onClick={submitReasonEdit} disabled={reasonBusy}>{reasonBusy?'Saving…':'Save reason'}</button>
              </div>
            </div>
          : <div className="small" style={{marginTop:4,color:'#B91C1C',fontWeight:600,display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <span>⊘ Voided{invoice.void_reason?`: ${invoice.void_reason}`:' — no reason recorded'}</span>
              {onEditVoidReason&&<button className="btn btn-ghost small" style={{fontWeight:600}} onClick={()=>{setReasonDraft(invoice.void_reason||'');setShowReasonEdit(true);}}>{invoice.void_reason?'✎ Edit reason':'+ Add reason'}</button>}
            </div>
        )}
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'flex-start'}}>
        {invoice.status==='draft'&&<button className="btn btn-ghost small" onClick={()=>onUpdateStatus('sent')}>Mark Sent</button>}
        {invoice.status==='sent'&&<button className="btn btn-ghost small" onClick={()=>onUpdateStatus('partial')}>Mark Part Paid</button>}
        <button className="btn btn-ghost small" onClick={()=>printInvoice(invoice,lines,membersByGroup)}>🖨 Print Invoice</button>
        {(invoice.status==='paid'||outstanding<=0)&&pmts&&pmts.length>0&&
          <button className="btn btn-primary small" onClick={()=>{
            const lastPmt=[...pmts].sort((a,b)=>(b.payment_date||'').localeCompare(a.payment_date||''))[0];
            printInvoiceAndReceipt(invoice,lines,lastPmt,membersByGroup);
          }}>🖨 Print Invoice &amp; Receipt</button>}
        {invoice.status!=='void'&&invoice.status!=='refunded'&&<button className="btn btn-danger small" onClick={()=>setShowVoidForm(true)}>Void</button>}
        {onRefund&&paidTotal>0&&invoice.status!=='void'&&invoice.status!=='refunded'&&<button className="btn btn-ghost small" style={{borderColor:'#C4B5FD',color:'#6D28D9'}} onClick={()=>{setRefAmt(paidTotal.toFixed(2));setShowRefundForm(true);}}>Refund</button>}
        {onDelete&&<button className="btn btn-danger small" onClick={onDelete} style={{marginLeft:'auto'}}>🗑 Delete Invoice</button>}
      </div>
    </div>
    <div className="table-wrap" style={{margin:'10px 0'}}>
      <table><thead><tr><th>Lesson Type &amp; Package</th><th style={{width:120}}>Swimmers</th><th style={{width:120,textAlign:'right'}}>Amount</th></tr></thead>
        <tbody>{lines.map(l=>{
          const swimmers=getSwimmerNames(l,membersByGroup);
          const isAdjustment=l.line_type==='adjustment';
          const isProduct=l.line_type==='product'||l.line_type==='other'||l.line_type==='custom';
          const ltName  = l.lesson_type_name || l.description || '—';
          const qty=Number(l.quantity)||1;
          const unit=qty>0?Number(l.amount||0)/qty:Number(l.amount||0);
          const amt=Number(l.amount)||0;
          const pkgName = isAdjustment ? 'Deduction'
            : isProduct
            ? (qty>1?`Qty ${qty} × RM${unit.toFixed(2)}`:'Product / goods')
            : (l.package_name || (l.line_type==='group_bundle' ? 'Group Bundle' : 'Individual'));
          return <tr key={l.id}>
            <td>
              <div style={{fontWeight:600,color:isAdjustment?'#DC2626':undefined}}>{isAdjustment?'💸 ':isProduct?'🛍 ':''}{ltName}</div>
              <div className="small subtle">{pkgName}</div>
            </td>
            <td className="small subtle">{swimmers.length>0 ? swimmers.join(', ') : '—'}</td>
            <td style={{textAlign:'right',fontWeight:600,whiteSpace:'nowrap',color:amt<0?'#DC2626':undefined}}>{amt<0?`−RM ${Math.abs(amt).toFixed(2)}`:`RM ${amt.toFixed(2)}`}{canEditLines&&(isProduct||isAdjustment)&&<button className="btn btn-ghost small" title={isAdjustment?'Remove deduction':'Remove item'} style={{marginLeft:6,color:'#DC2626',padding:'0 6px'}} onClick={()=>onDeleteLine(l.id)}>×</button>}</td>
          </tr>;
        })}</tbody>
        <tfoot><tr>
          <td colSpan={2} style={{textAlign:'right',fontWeight:700}}>Total</td>
          <td style={{textAlign:'right',fontWeight:800,fontSize:15}}>RM {Number(invoice.total_amount||0).toFixed(2)}</td>
        </tr></tfoot>
      </table>
      {canEditLines && showDeductForm && <div className="inv-pay-form" style={{marginTop:8,borderColor:'#FCA5A5'}}>
        <div style={{fontWeight:700,marginBottom:6,color:'#B91C1C'}}>− Add deduction <span className="small subtle" style={{fontWeight:400}}>(discount / pro-rata / goodwill — shows on the invoice)</span></div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:8}}>
          {DEDUCT_REASONS.map(r=><button key={r} className="btn btn-ghost small" style={{fontSize:11,borderColor:deductDesc===r?'#DC2626':undefined,color:deductDesc===r?'#DC2626':undefined}} onClick={()=>setDeductDesc(r)}>{r}</button>)}
        </div>
        <div className="form-grid" style={{gridTemplateColumns:'2fr 130px'}}>
          <div className="field"><label>Reason (appears on invoice)</label><input className="input" value={deductDesc} onChange={e=>setDeductDesc(e.target.value)} placeholder="e.g. Pro-rata — late start, month 2 of 4" /></div>
          <div className="field"><label>Amount (RM)</label><input className="input" type="number" min="0" step="0.01" value={deductAmt} onChange={e=>setDeductAmt(e.target.value)} placeholder="0.00" /></div>
        </div>
        {Number(deductAmt)>0&&<div className="small" style={{color:'#B91C1C',marginTop:4}}>Will add: <b>−RM {Math.abs(Number(deductAmt)||0).toFixed(2)}</b> → new total RM {Math.max(0,(Number(invoice.total_amount)||0)-Math.abs(Number(deductAmt)||0)).toFixed(2)}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
          <button className="btn btn-ghost small" onClick={()=>{setShowDeductForm(false);setDeductDesc('');setDeductAmt('');}}>Cancel</button>
          <button className="btn btn-danger small" onClick={submitDeduct} disabled={deductBusy||!deductDesc.trim()||!(Number(deductAmt)>0)}>{deductBusy?'Adding…':'Add deduction'}</button>
        </div>
      </div>}
      {canEditLines && (showItemForm
        ? <div className="inv-pay-form" style={{marginTop:8}}>
            <div style={{fontWeight:700,marginBottom:6}}>Add item <span className="small subtle">(goggles, cap, swim diaper…)</span></div>
            {(products||[]).filter(p=>p.is_active!==false).length>0 && <div style={{marginBottom:8}}>
              <select className="select" value="" onChange={e=>{ const p=(products||[]).find(x=>x.id===e.target.value); if(p){ setItemDesc(p.name); if(p.price!=null) setItemPrice(String(p.price)); } }}>
                <option value="">Pick from catalogue…</option>
                {(products||[]).filter(p=>p.is_active!==false).map(p=><option key={p.id} value={p.id}>{p.name}{p.price!=null?` — RM${Number(p.price).toFixed(2)}`:''}</option>)}
              </select>
            </div>}
            <div className="form-grid" style={{gridTemplateColumns:'2fr 70px 100px 90px'}}>
              <div className="field"><label>Item</label><input className="input" value={itemDesc} onChange={e=>setItemDesc(e.target.value)} placeholder="e.g. Swim goggles" /></div>
              <div className="field"><label>Qty</label><input className="input" type="number" min="1" step="1" value={itemQty} onChange={e=>setItemQty(Math.max(1,parseInt(e.target.value,10)||1))} /></div>
              <div className="field"><label>Unit (RM)</label><input className="input" type="number" min="0" step="0.01" value={itemPrice} onChange={e=>setItemPrice(e.target.value)} placeholder="0.00" /></div>
              <div className="field"><label>Total</label><input className="input" value={`RM ${itemTotal.toFixed(2)}`} disabled style={{fontWeight:700}} /></div>
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:8}}>
              <button className="btn btn-ghost small" onClick={()=>{setShowItemForm(false);setItemDesc('');setItemQty(1);setItemPrice('');}}>Cancel</button>
              <button className="btn btn-primary small" onClick={submitItem} disabled={itemBusy||!itemDesc.trim()||!(Number(itemPrice)>0)}>{itemBusy?'Adding…':'Add to invoice'}</button>
            </div>
          </div>
        : (!showDeductForm && <div style={{display:'flex',gap:8,marginTop:8}}>
            <button className="btn btn-ghost small" onClick={()=>setShowItemForm(true)}>+ Add item (product / goods)</button>
            <button className="btn btn-ghost small" style={{color:'#B91C1C',borderColor:'#FCA5A5'}} onClick={()=>setShowDeductForm(true)}>− Add deduction (discount)</button>
          </div>)
      )}
    </div>
    {pmts.length>0&&<div style={{marginBottom:10}}>
      <div style={{fontWeight:700,marginBottom:6}}>Payments</div>
      <div className="table-wrap">
        <table><thead><tr><th>Date</th><th>Receipt #</th><th>Method</th><th style={{textAlign:'right'}}>Amount</th><th></th></tr></thead>
          <tbody>{pmts.map(p=>{ const isRef=p.kind==='refund'||Number(p.amount)<0; return <tr key={p.id}>
            <td>{p.payment_date||'—'}</td>
            <td style={{fontFamily:'monospace',fontSize:11}}>{p.receipt_number||'—'}</td>
            <td><MethodPill code={p.payment_method} small/>{isRef?<span className="small subtle"> · Refund</span>:null}</td>
            <td style={{textAlign:'right',fontWeight:700,color:isRef?'#DC2626':'var(--green-tx)'}}>{isRef?'−':''}RM {Math.abs(Number(p.amount)).toFixed(2)}</td>
            <td><button className="btn btn-ghost small" title="Print receipt" onClick={()=>printReceipt(p,invoice)}>🖨 Receipt</button></td>
          </tr>; })}</tbody>
        </table>
      </div>
      <div className="small subtle" style={{marginTop:4}}>{invoice.status==='refunded' ? 'Refunded — payment returned to customer' : invoice.status==='void' ? 'Voided — no balance' : `Paid RM ${Number(invoice.amount_paid||0).toFixed(2)} · Outstanding RM ${outstanding.toFixed(2)}`}</div>
    </div>}
    {showVoidForm&&<div className="inv-pay-form" style={{borderColor:'var(--red-bd)',background:'#FFF5F5'}}>
      <div style={{fontWeight:700,marginBottom:6,color:'#B91C1C'}}>Void Invoice</div>
      <div className="small subtle" style={{marginBottom:8}}>{paidTotal>0 ? 'This invoice has a payment/receipt. Voiding deletes the payment(s) and receipt(s) and removes pending credits. The invoice stays on record as “Void”. This cannot be undone. For genuine money returned, use Refund instead.' : 'The invoice will be marked “Void” and its pending credits removed. This cannot be undone.'}</div>
      <div className="field"><label>Reason for voiding <span className="subtle">(required · max 100)</span></label>
        <textarea className="textarea" style={{minHeight:56}} maxLength={100} value={voidReason} onChange={e=>setVoidReason(e.target.value.slice(0,100))} placeholder="e.g. Duplicate — reissued under correct parent" />
        <div className="small subtle" style={{textAlign:'right'}}>{voidReason.length}/100</div>
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:6}}>
        <button className="btn btn-ghost small" onClick={()=>{setShowVoidForm(false);setVoidReason('');}}>Cancel</button>
        <button className="btn btn-danger small" disabled={!voidReason.trim()||voidBusy} onClick={submitVoid}>{voidBusy?'Voiding…':'Confirm Void'}</button>
      </div>
    </div>}
    {showRefundForm&&<div className="inv-pay-form" style={{borderColor:'#C4B5FD',background:'#FAF5FF'}}>
      <div style={{fontWeight:700,marginBottom:6,color:'#6D28D9'}}>Refund Payment</div>
      <div className="small subtle" style={{marginBottom:8}}>Records a refund receipt (money returned to the parent) and marks the invoice “Refunded”. For an invoice raised in error, use Void instead.</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Refund Amount (RM)</label><input className="input" type="number" step="0.01" min="0.01" value={refAmt} onChange={e=>setRefAmt(e.target.value)} /></div>
        <div className="field"><label>Date</label><input className="input" type="date" value={refDate} onChange={e=>setRefDate(e.target.value)} /></div>
        <div className="field"><label>Method</label><select className="select" value={refMethod} onChange={e=>setRefMethod(e.target.value)}>{activeMethods().map(m=><option key={m.code} value={m.code}>{m.label}</option>)}</select></div>
      </div>
      <div className="field" style={{marginTop:8}}><label>Reason (optional)</label><input className="input" value={refReason} onChange={e=>setRefReason(e.target.value)} placeholder="e.g. Parent withdrew, class cancelled" /></div>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:10}}>
        <button className="btn btn-ghost small" onClick={()=>setShowRefundForm(false)}>Cancel</button>
        <button className="btn btn-primary small" onClick={submitRefund} disabled={refBusy} style={{background:'#7C3AED',borderColor:'#7C3AED'}}>{refBusy?'Processing…':'Confirm Refund'}</button>
      </div>
    </div>}
    {!showPayForm&&outstanding>0&&invoice.status!=='void'&&invoice.status!=='refunded'&&
      <button className="btn btn-primary small" onClick={()=>{setPayAmt(outstanding.toFixed(2));setShowPayForm(true);}}>+ Record Payment</button>}
    {showPayForm&&<div className="inv-pay-form">
      <div style={{fontWeight:700,marginBottom:8}}>Record Payment</div>
      <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 1fr'}}>
        <div className="field"><label>Amount (RM)</label><input className="input" type="number" step="0.01" min="0.01" value={payAmt} onChange={e=>setPayAmt(e.target.value)} /></div>
        <div className="field"><label>Date</label><input className="input" type="date" value={payDate} onChange={e=>setPayDate(e.target.value)} /></div>
        <div className="field"><label>Method</label><select className="select" value={payMethod} onChange={e=>setPayMethod(e.target.value)}>
          {activeMethods().map(m=><option key={m.code} value={m.code}>{m.label}</option>)}
        </select></div>
        <div className="field"><label>Reference #</label><input className="input" value={payRef} onChange={e=>setPayRef(e.target.value)} placeholder="e.g. TXN-12345" /></div>
        <div className="field"><label>Notes</label><input className="input" value={payNotes} onChange={e=>setPayNotes(e.target.value)} /></div>
      </div>
      <div style={{display:'flex',gap:8,marginTop:10}}>
        <button className="btn btn-primary small" onClick={submitPayment} disabled={payBusy}>{payBusy?'Saving…':'Save Payment'}</button>
        <button className="btn btn-ghost small" onClick={()=>setShowPayForm(false)}>Cancel</button>
      </div>
    </div>}
  </div>;
}

// Settings → Website: controls what the public marketing site displays.
// Two halves: (1) Schedule Preview switchboard — which lesson types /
// branches surface in the sanitised public_schedule_preview view;
// (2) Pricing cards — marketing-owned, decoupled from internal packages.
function WebsitePanel({ settings, lessonTypes, branches, pricing, onSaveSettings, onAddCard, onUpdateCard, onDeleteCard, onMoveCard, onMoveCategory }){
  const migrated = settings!=null;
  const visLt = new Set(settings?.visible_lesson_type_ids||[]);
  const visBr = new Set(settings?.visible_branch_ids||[]);
  function toggleLt(id){
    const next = new Set(visLt); next.has(id)?next.delete(id):next.add(id);
    onSaveSettings({ visible_lesson_type_ids:[...next] });
  }
  function toggleBr(id){
    const next = new Set(visBr); next.has(id)?next.delete(id):next.add(id);
    onSaveSettings({ visible_branch_ids:[...next] });
  }
  // ── pricing editor state ──
  const emptyCard = { category:'Toddlers', title:'', subtitle:'', price:'', unit:'/month', features:'', badge:'', is_published:false };
  const [editing,setEditing] = useState(null); // null | 'new' | card id
  const [draft,setDraft] = useState(emptyCard);
  function startNew(){ setEditing('new'); setDraft(emptyCard); }
  function startEdit(c){ setEditing(c.id); setDraft({ category:c.category||'', title:c.title||'', subtitle:c.subtitle||'', price:String(c.price??''), unit:c.unit||'', features:(c.features||[]).join('\n'), badge:c.badge||'', is_published:c.is_published!==false }); }
  async function saveDraft(){
    const payload = {
      category:(draft.category||'General').trim()||'General',
      title:draft.title.trim(),
      subtitle:draft.subtitle.trim()||null,
      price:Number(draft.price)||0,
      unit:draft.unit.trim()||null,
      features:draft.features.split('\n').map(s=>s.trim()).filter(Boolean),
      badge:draft.badge.trim()||null,
      is_published:!!draft.is_published,
    };
    if(!payload.title){ alert('Card title is required'); return; }
    if(editing==='new') await onAddCard(payload); else await onUpdateCard(editing, payload);
    setEditing(null);
  }
  // Category order mirrors the website: lowest card sort_order first,
  // legacy Toddlers/LTS tie-break until the first manual reorder.
  const catMin={};
  pricing.forEach(p=>{ const k=p.category||'General'; const s=Number(p.sort_order)||0; if(!(k in catMin)||s<catMin[k]) catMin[k]=s; });
  const catPri = c => c==='Toddlers'?0 : c==='LTS Children'?1 : 2;
  const cats = Object.keys(catMin).sort((a,b)=> (catMin[a]-catMin[b]) || (catPri(a)-catPri(b)) || a.localeCompare(b));
  return <div style={{display:'flex',flexDirection:'column',gap:16}}>
    {!migrated && <div className="card" style={{background:'#FEF3C7',border:'1px solid #FDE68A',padding:'10px 14px',fontSize:12.5}}>
      ⚠ Website tables not found — run <code>supabase_public_website_migration.sql</code> first. Controls below will save once the migration is in.
    </div>}

    <div className="card">
      <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>🗓 Public Schedule Preview</div>
      <div className="small subtle" style={{marginBottom:12}}>
        Shows this week&apos;s timetable on the website as a Mon–Sun grid with availability chips (Available / Limited / Full).
        Public visitors see <b>lesson type, branch, day, time and availability only</b> — never student or instructor names.
        Sessions with zero swimmers show as fully available, so you can seed slots you want to promote.
      </div>
      <label style={{display:'flex',alignItems:'center',gap:8,fontWeight:700,marginBottom:14,cursor:'pointer'}}>
        <input type="checkbox" checked={settings?.enabled===true} disabled={!migrated} onChange={e=>onSaveSettings({enabled:e.target.checked})}/>
        Show schedule preview on the website
      </label>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
        <div>
          <div className="field-label" style={{marginBottom:6}}>Visible lesson types <span className="subtle">(explicit opt-in)</span></div>
          {(lessonTypes||[]).filter(t=>t.is_active!==false).map(t=>
            <label key={t.id} style={{display:'flex',alignItems:'center',gap:8,padding:'3px 0',cursor:'pointer',fontSize:13}}>
              <input type="checkbox" checked={visLt.has(t.id)} disabled={!migrated} onChange={()=>toggleLt(t.id)}/>
              {t.name}
            </label>)}
          {(lessonTypes||[]).length===0 && <div className="small subtle">No lesson types configured.</div>}
        </div>
        <div>
          <div className="field-label" style={{marginBottom:6}}>Visible branches <span className="subtle">(none ticked = all)</span></div>
          {(branches||[]).map(b=>
            <label key={b.id} style={{display:'flex',alignItems:'center',gap:8,padding:'3px 0',cursor:'pointer',fontSize:13}}>
              <input type="checkbox" checked={visBr.has(b.id)} disabled={!migrated} onChange={()=>toggleBr(b.id)}/>
              {b.name}{b.code?` (${b.code})`:''}
            </label>)}
        </div>
      </div>
    </div>

    <div className="card">
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
        <div style={{fontWeight:800,fontSize:18}}>💰 Public Pricing Cards</div>
        <button className="btn btn-primary small" style={{marginLeft:'auto'}} disabled={!migrated} onClick={startNew}>+ New card</button>
      </div>
      <div className="small subtle" style={{marginBottom:12}}>
        Marketing prices — deliberately separate from internal packages, so billing changes never leak to the website by accident.
        Only <b>published</b> cards appear publicly. Categories become tabs; Toddlers and LTS Children always lead.
      </div>
      {editing!=null && <div className="inv-pay-form" style={{marginBottom:14}}>
        <div style={{fontWeight:700,marginBottom:8}}>{editing==='new'?'New pricing card':'Edit pricing card'}</div>
        <div className="form-grid" style={{gridTemplateColumns:'1fr 1fr 110px 110px'}}>
          <div className="field"><label>Title</label><input className="input" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="e.g. Group Lessons"/></div>
          <div className="field"><label>Category (tab)</label><input className="input" list="pp-cats" value={draft.category} onChange={e=>setDraft({...draft,category:e.target.value})} placeholder="Toddlers"/>
            <datalist id="pp-cats"><option value="Toddlers"/><option value="LTS Children"/><option value="Private"/><option value="Adults"/></datalist></div>
          <div className="field"><label>Price (RM)</label><input className="input" type="number" min="0" step="1" value={draft.price} onChange={e=>setDraft({...draft,price:e.target.value})} placeholder="180"/></div>
          <div className="field"><label>Unit</label><input className="input" value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})} placeholder="/month"/></div>
        </div>
        <div className="form-grid" style={{gridTemplateColumns:'2fr 1fr'}}>
          <div className="field"><label>Subtitle</label><input className="input" value={draft.subtitle} onChange={e=>setDraft({...draft,subtitle:e.target.value})} placeholder="e.g. 4 lessons per month · max 4 per coach"/></div>
          <div className="field"><label>Badge (optional)</label><input className="input" value={draft.badge} onChange={e=>setDraft({...draft,badge:e.target.value})} placeholder="Most Popular"/></div>
        </div>
        <div className="field"><label>Features — one per line</label>
          <textarea className="textarea" style={{minHeight:80}} value={draft.features} onChange={e=>setDraft({...draft,features:e.target.value})} placeholder={'50-minute lessons\nCertified coaches\nProgress tracking with badges'}/>
        </div>
        <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13,marginBottom:8}}>
          <input type="checkbox" checked={draft.is_published} onChange={e=>setDraft({...draft,is_published:e.target.checked})}/>
          Published (visible on the website)
        </label>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button className="btn btn-ghost small" onClick={()=>setEditing(null)}>Cancel</button>
          <button className="btn btn-primary small" onClick={saveDraft}>{editing==='new'?'Add card':'Save changes'}</button>
        </div>
      </div>}
      {cats.length===0 && <div className="small subtle">No pricing cards yet.</div>}
      {cats.map((cat,ci)=>{
        const rows = pricing.filter(p=>(p.category||'General')===cat).sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
        return <div key={cat} style={{marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',gap:6,margin:'6px 0'}}>
            <button className="btn btn-ghost small" title="Move category earlier on the website" disabled={ci===0} onClick={()=>onMoveCategory(cat,-1)} style={{padding:'1px 6px'}}>↑</button>
            <button className="btn btn-ghost small" title="Move category later on the website" disabled={ci===cats.length-1} onClick={()=>onMoveCategory(cat,1)} style={{padding:'1px 6px'}}>↓</button>
            <span style={{fontWeight:700,fontSize:13,color:'var(--text-2)'}}>{cat}</span>
            <span className="small subtle">tab {ci+1} of {cats.length}</span>
          </div>
          <div className="table-wrap"><table><tbody>
            {rows.map((c,idx)=><tr key={c.id} style={{opacity:c.is_published?1:0.5}}>
              <td style={{whiteSpace:'nowrap',width:70}}>
                <button className="btn btn-ghost small" disabled={idx===0} onClick={()=>onMoveCard(c.id,-1)} style={{padding:'2px 6px'}}>↑</button>
                <button className="btn btn-ghost small" disabled={idx===rows.length-1} onClick={()=>onMoveCard(c.id,1)} style={{padding:'2px 6px'}}>↓</button>
              </td>
              <td><span style={{fontWeight:700}}>{c.title}</span>{c.badge&&<span className="pm-pill pm-amber" style={{marginLeft:6}}>{c.badge}</span>}
                {c.subtitle&&<div className="small subtle">{c.subtitle}</div>}</td>
              <td style={{whiteSpace:'nowrap',fontWeight:700}}>RM {Number(c.price).toFixed(0)}<span className="small subtle">{c.unit||''}</span></td>
              <td className="small subtle" style={{maxWidth:260}}>{(c.features||[]).join(' · ')}</td>
              <td style={{whiteSpace:'nowrap',textAlign:'right'}}>
                <label className="small" style={{marginRight:8,cursor:'pointer'}}>
                  <input type="checkbox" checked={c.is_published===true} onChange={e=>onUpdateCard(c.id,{is_published:e.target.checked})}/> live
                </label>
                <button className="btn btn-ghost small" onClick={()=>startEdit(c)}>Edit</button>
                <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>onDeleteCard(c.id)}>🗑</button>
              </td>
            </tr>)}
          </tbody></table></div>
        </div>;
      })}
    </div>
  </div>;
}

// Small coloured pill for a payment method — used on invoice rows, receipts and filters.
function MethodPill({ code, small }){
  if(!code) return null;
  const d = methodDef(code);
  const label = d ? d.label : code;
  return <span className={`pm-pill pm-${methodColor(code)}${small?' pm-sm':''}`}>{label}</span>;
}

// Settings → Payment Methods: global list powering every payment dropdown and pill.
// Methods are never deleted (historical payments must keep resolving) — only deactivated.
function PaymentMethodsPanel({ methods, onAdd, onUpdate, onMove }){
  const [newLabel,setNewLabel]=useState('');
  const [newCode,setNewCode]=useState('');
  const [editingId,setEditingId]=useState(null);
  const [editLabel,setEditLabel]=useState('');
  const usingDefaults = !methods || methods.length===0;
  const sorted = (methods||[]).slice().sort((a,b)=>(a.sort_order??0)-(b.sort_order??0));
  function startEdit(m){ setEditingId(m.id); setEditLabel(m.label||''); }
  async function saveEdit(){ if(editingId){ await onUpdate(editingId,{label:editLabel.trim()||undefined}); setEditingId(null);} }
  function suggestCode(label){ return (label||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }
  return <div className="card">
    <div style={{fontWeight:800,fontSize:18,marginBottom:4}}>💳 Payment Methods</div>
    <div className="small subtle" style={{marginBottom:14}}>
      These methods appear in every payment dropdown (invoice payments, refunds, shop checkout) and as coloured pills across invoices, receipts and reports.
      Deactivate a method to remove it from dropdowns — past payments keep their label. Methods cannot be deleted.
    </div>
    {usingDefaults && <div className="card" style={{background:'var(--amber-bg,#FEF3C7)',border:'1px solid var(--amber-bd,#FDE68A)',padding:'10px 14px',marginBottom:14,fontSize:12.5}}>
      ⚠ The <code>payment_methods</code> table has no rows yet (or the migration hasn't been run). The app is falling back to the built-in defaults below. Run the migration to customise.
      <div style={{marginTop:6,display:'flex',gap:6,flexWrap:'wrap'}}>{PM_DEFAULTS.map(m=><MethodPill key={m.code} code={m.code}/>)}</div>
    </div>}
    {!usingDefaults && <div className="table-wrap" style={{marginBottom:16}}>
      <table><thead><tr>
        <th style={{width:44}}></th>
        <th>Label</th>
        <th style={{width:150}}>Code</th>
        <th style={{width:90}}>Preview</th>
        <th style={{width:90,textAlign:'center'}}>Active</th>
        <th style={{width:110}}></th>
      </tr></thead><tbody>
        {sorted.map((m,idx)=><tr key={m.id} style={{opacity:m.is_active===false?0.5:1}}>
          <td style={{whiteSpace:'nowrap'}}>
            <button className="btn btn-ghost small" title="Move up" disabled={idx===0} onClick={()=>onMove(m.id,-1)} style={{padding:'2px 6px'}}>↑</button>
            <button className="btn btn-ghost small" title="Move down" disabled={idx===sorted.length-1} onClick={()=>onMove(m.id,1)} style={{padding:'2px 6px'}}>↓</button>
          </td>
          <td>
            {editingId===m.id
              ? <input className="input" value={editLabel} onChange={e=>setEditLabel(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')saveEdit(); if(e.key==='Escape')setEditingId(null);}} autoFocus style={{maxWidth:220}}/>
              : <span style={{fontWeight:600}}>{m.label}</span>}
          </td>
          <td style={{fontFamily:'monospace',fontSize:12}}>{m.code}</td>
          <td><MethodPill code={m.code}/></td>
          <td style={{textAlign:'center'}}>
            <input type="checkbox" checked={m.is_active!==false} onChange={e=>onUpdate(m.id,{is_active:e.target.checked})}/>
          </td>
          <td style={{textAlign:'right'}}>
            {editingId===m.id
              ? <><button className="btn btn-primary small" onClick={saveEdit}>Save</button> <button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>✕</button></>
              : <button className="btn btn-ghost small" onClick={()=>startEdit(m)}>Rename</button>}
          </td>
        </tr>)}
      </tbody></table>
    </div>}
    <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
      <div className="field" style={{margin:0}}><label>New method label</label>
        <input className="input" placeholder="e.g. TNG BlueTap" value={newLabel} onChange={e=>{setNewLabel(e.target.value); if(!newCode||newCode===suggestCode(newLabel)) setNewCode(suggestCode(e.target.value));}} style={{minWidth:200}}/>
      </div>
      <div className="field" style={{margin:0}}><label>Code (stored on payments)</label>
        <input className="input" placeholder="tng_bluetap" value={newCode} onChange={e=>setNewCode(e.target.value)} style={{minWidth:160,fontFamily:'monospace'}}/>
      </div>
      <button className="btn btn-primary" disabled={!newLabel.trim()||usingDefaults} onClick={async()=>{ await onAdd({code:newCode||suggestCode(newLabel), label:newLabel}); setNewLabel(''); setNewCode(''); }}>+ Add Method</button>
    </div>
  </div>;
}

function InvoiceSettingsPanel({ settings, onSave, formatInvoiceNumber, formatReceiptNumber }){
  const [form,setForm]=useState({
    invoice_prefix: settings.invoice_prefix||'INV',
    receipt_prefix: settings.receipt_prefix||'RCT',
    next_invoice_seq: String(settings.next_invoice_seq||1),
    next_receipt_seq: String(settings.next_receipt_seq||1),
    leading_zeros: String(settings.leading_zeros||3),
    include_date: settings.include_date !== false,
    date_format: settings.date_format||'YYYYMM',
    allow_delete_invoice: !!settings.allow_delete_invoice,
  });
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);

  React.useEffect(()=>{ setForm({
    invoice_prefix: settings.invoice_prefix||'INV',
    receipt_prefix: settings.receipt_prefix||'RCT',
    next_invoice_seq: String(settings.next_invoice_seq||1),
    next_receipt_seq: String(settings.next_receipt_seq||1),
    leading_zeros: String(settings.leading_zeros||3),
    include_date: settings.include_date !== false,
    date_format: settings.date_format||'YYYYMM',
    allow_delete_invoice: !!settings.allow_delete_invoice,
  }); },[settings]);

  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const draftSettings={...form,leading_zeros:Number(form.leading_zeros)||3,include_date:!!form.include_date};
  const invPreview=formatInvoiceNumber?formatInvoiceNumber(draftSettings,Number(form.next_invoice_seq)||1):'—';
  const rctPreview=formatReceiptNumber?formatReceiptNumber(draftSettings,Number(form.next_receipt_seq)||1):'—';

  async function handleSave(){
    setSaving(true); setSaved(false);
    await onSave({
      invoice_prefix:form.invoice_prefix.trim()||'INV',
      receipt_prefix:form.receipt_prefix.trim()||'RCT',
      next_invoice_seq:Math.max(1,Number(form.next_invoice_seq)||1),
      next_receipt_seq:Math.max(1,Number(form.next_receipt_seq)||1),
      leading_zeros:Math.min(8,Math.max(1,Number(form.leading_zeros)||3)),
      include_date:!!form.include_date,
      date_format:form.date_format,
      allow_delete_invoice:!!form.allow_delete_invoice,
    });
    setSaving(false); setSaved(true);
    setTimeout(()=>setSaved(false),2000);
  }

  return <div className="inv-settings-panel" style={{background:'var(--surface-2)',border:'1px solid var(--border)',borderRadius:10,padding:14,marginBottom:14}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
      <div style={{fontWeight:700}}>⚙ Invoice Numbering</div>
      <div style={{display:'flex',gap:8}}>
        <button className="btn btn-ghost small" onClick={()=>{if(confirm('Reset both counters to 1?')){{set('next_invoice_seq','1');set('next_receipt_seq','1');}}}}>↺ Reset</button>
        <button className="btn btn-primary small" onClick={handleSave} disabled={saving}>{saving?'Saving…':saved?'✓ Saved':'Save'}</button>
      </div>
    </div>
    <div className="form-grid" style={{gridTemplateColumns:'repeat(3,1fr)'}}>
      <div className="field"><label>Invoice Prefix</label><input className="input" value={form.invoice_prefix} onChange={e=>set('invoice_prefix',e.target.value.replace(/\s/g,''))} placeholder="INV" maxLength={12} /></div>
      <div className="field"><label>Receipt Prefix</label><input className="input" value={form.receipt_prefix} onChange={e=>set('receipt_prefix',e.target.value.replace(/\s/g,''))} placeholder="RCT" maxLength={12} /></div>
      <div className="field"><label>Date Segment</label><select className="select" value={form.include_date?form.date_format:'none'} onChange={e=>{ if(e.target.value==='none'){set('include_date',false);}else{set('include_date',true);set('date_format',e.target.value);} }}>
        <option value="YYYYMM">Year + Month (202606)</option>
        <option value="YYYY">Year only (2026)</option>
        <option value="MM">Month only (06)</option>
        <option value="none">None — sequence only</option>
      </select></div>
      <div className="field"><label>Leading Zeros</label><select className="select" value={form.leading_zeros} onChange={e=>set('leading_zeros',e.target.value)}>
        {[1,2,3,4,5].map(n=><option key={n} value={n}>{n} — e.g. {String(1).padStart(n,'0')}</option>)}
      </select></div>
      <div className="field"><label>Next Invoice #</label><input className="input" type="number" min="1" value={form.next_invoice_seq} onChange={e=>set('next_invoice_seq',e.target.value)} /></div>
      <div className="field"><label>Next Receipt #</label><input className="input" type="number" min="1" value={form.next_receipt_seq} onChange={e=>set('next_receipt_seq',e.target.value)} /></div>
    </div>
    <div style={{marginTop:10,padding:'8px 12px',background:'var(--surface)',borderRadius:8,border:'1px solid var(--border)'}}>
      <div className="small subtle" style={{marginBottom:4}}>Preview</div>
      <span style={{fontFamily:'monospace',fontWeight:700}}>Invoice: {invPreview}</span>
      <span style={{fontFamily:'monospace',fontWeight:700,marginLeft:24}}>Receipt: {rctPreview}</span>
    </div>
    {/* ── Permissions ── */}
    <div style={{marginTop:16,padding:'14px 16px',background:form.allow_delete_invoice?'linear-gradient(135deg,#FFF1F1,#FFF5F5)':'var(--surface-2)',border:`1px solid ${form.allow_delete_invoice?'var(--red-bd)':'var(--border)'}`,borderRadius:10,transition:'background .2s,border-color .2s'}}>
      <div style={{fontWeight:700,fontSize:13,marginBottom:4}}>🔐 Invoice Permissions</div>
      <div className="small subtle" style={{marginBottom:12}}>These controls will be tied to user roles in a future login phase. Keep Delete disabled unless actively cleaning up test data.</div>
      <label style={{display:'flex',alignItems:'center',gap:12,cursor:'pointer',userSelect:'none'}}>
        <div
          onClick={()=>set('allow_delete_invoice',!form.allow_delete_invoice)}
          style={{width:44,height:24,borderRadius:12,background:form.allow_delete_invoice?'var(--red-tx)':'var(--border-2)',position:'relative',cursor:'pointer',transition:'background .2s',flexShrink:0}}>
          <div style={{position:'absolute',top:3,left:form.allow_delete_invoice?22:3,width:18,height:18,borderRadius:'50%',background:'#fff',boxShadow:'0 1px 4px rgba(0,0,0,.25)',transition:'left .2s'}} />
        </div>
        <div>
          <div style={{fontWeight:600,fontSize:13,color:form.allow_delete_invoice?'var(--red-tx)':'var(--text-2)'}}>
            {form.allow_delete_invoice ? '🔓 Delete Invoice — ENABLED' : '🔒 Delete Invoice — Disabled'}
          </div>
          <div className="small subtle">{form.allow_delete_invoice ? 'The 🗑 Delete button is visible on all invoices. Deletions are permanent and cascade to payments and line items.' : 'The delete button is hidden on all invoices. Safe for normal operations.'}</div>
        </div>
      </label>
    </div>
  </div>;
}


function getSwimmerNames(line, membersByGroup){
  if(!line.family_group_id || !membersByGroup) return [];
  const members = membersByGroup[line.family_group_id] || [];
  return members.map(m => m.name || m.student_name || '').filter(Boolean);
}

function printInvoice(invoice, lines, membersByGroup){
  const billable = (lines||[]).filter(l=>l.is_billable);
  const paidAmt = Number(invoice.amount_paid)||0;
  const total = Number(invoice.total_amount)||0;
  const outstanding = Math.max(0, total - paidAmt);
  const isPaid = outstanding <= 0 && invoice.status !== 'void';
  const logoUrl = window.location.origin + '/logo.png';
  const linesHtml = billable.map(l=>{
    const isAdjustment = l.line_type==='adjustment';
    const amt = Number(l.amount)||0;
    const amtHtml = amt<0 ? `<span style="color:#DC2626">&minus;RM ${Math.abs(amt).toFixed(2)}</span>` : `RM ${amt.toFixed(2)}`;
    if(isAdjustment){
      return `<tr><td class="td-desc" style="color:#DC2626">${l.description||'Deduction'}</td><td class="td-type" style="color:#DC2626">Deduction</td><td class="td-amt">${amtHtml}</td></tr>`;
    }
    const swimmers = getSwimmerNames(l, membersByGroup);
    // Description = Lesson Type · Package (never the group name)
    const ltName  = l.lesson_type_name || l.description || '';
    const pkgName = l.package_name || (l.line_type==='group_bundle' ? 'Group Bundle' : 'Individual');
    const descText = [ltName, pkgName].filter(Boolean).join(' · ');
    const descHtml = swimmers.length
      ? `${descText}<div style="font-size:7pt;color:#777;margin-top:2pt;line-height:1.5">${swimmers.join(' &middot; ')}</div>`
      : descText;
    return `<tr><td class="td-desc">${descHtml}</td><td class="td-type">${pkgName}</td><td class="td-amt">${amtHtml}</td></tr>`;
  }).join('');
  const branchRow = (() => {
    try{
      const b = (window.__SSB_BRANCHES__||[]).find(x => x.id === invoice.branch_id);
      return b ? `<span>Branch: ${b.name}${b.code?' ('+b.code+')':''}</span>` : '';
    }catch(_){ return ''; }
  })();
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${invoice.invoice_number}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:8.5pt;color:#1a1a1a;background:#fff}
@page{size:A5 landscape;margin:6mm 9mm}
@media print{.page{padding:0}}
.page{width:210mm;height:148mm;padding:5mm 7mm;display:flex;flex-direction:column;overflow:hidden}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:5pt;border-bottom:1pt solid #1a1a1a;margin-bottom:6pt}
.brand-logo{height:28pt;width:auto;object-fit:contain;display:block}
.brand-text{font-size:6.5pt;color:#555;margin-top:4pt;line-height:1.5}
.inv-number{font-size:10pt;font-weight:400;letter-spacing:.5px;color:#1a1a1a}
.inv-meta{font-size:7pt;color:#777;margin-top:2pt;line-height:1.5;text-align:right}
.status-chip{display:inline-block;padding:1pt 5pt;border-radius:2pt;font-size:6.5pt;font-weight:600;margin-top:2pt}
.s-draft{background:#f1f5f9;color:#475569}.s-sent{background:#dbeafe;color:#1d4ed8}
.s-partial{background:#fef3c7;color:#92400e}.s-paid{background:#d1fae5;color:#065f46}.s-void{background:#fee2e2;color:#7f1d1d}
.bill-row{display:flex;gap:12pt;margin-bottom:5pt}
.bill-box{background:#f8f9fa;border-radius:2pt;padding:3pt 6pt;flex:1}
.bill-label{font-size:6pt;text-transform:uppercase;letter-spacing:.5px;color:#999;margin-bottom:1pt}
.bill-name{font-size:8.5pt;font-weight:600;line-height:1.3}
.bill-contact{font-size:7pt;color:#666;margin-top:1pt}
table{width:100%;border-collapse:collapse;margin-bottom:5pt}
thead th{font-size:6.5pt;text-transform:uppercase;letter-spacing:.5px;color:#999;font-weight:600;padding:3pt 4pt;border-bottom:1pt solid #e5e5e5;text-align:left}
thead th.td-amt{text-align:right}
.td-desc{padding:3pt 4pt;font-size:8pt;border-bottom:1pt solid #f0f0f0;line-height:1.4}
.td-type{padding:3pt 4pt;font-size:7pt;color:#777;border-bottom:1pt solid #f0f0f0;white-space:nowrap}
.td-amt{padding:3pt 4pt;font-size:8pt;font-weight:600;text-align:right;border-bottom:1pt solid #f0f0f0;white-space:nowrap}
.totals{margin-left:auto;min-width:120pt}
.tot-row{display:flex;justify-content:space-between;gap:10pt;padding:2pt 0;font-size:8pt;color:#555}
.tot-row.grand{font-size:9.5pt;font-weight:700;color:#1a1a1a;border-top:1pt solid #1a1a1a;margin-top:3pt;padding-top:4pt}
.tot-row.paid-line{color:#059669}
.notes{font-size:7pt;color:#666;background:#f8f9fa;border-radius:2pt;padding:3pt 6pt;margin-bottom:4pt}
.footer{margin-top:auto;padding-top:4pt;border-top:1pt solid #e5e5e5;font-size:6pt;color:#aaa;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body><div class="page">
<div class="hdr">
  <div>
    <img class="brand-logo" src="${logoUrl}" onerror="this.style.display='none'">
    <div class="brand-text">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak<br>TIN: C59796139050</div>
  </div>
  <div style="text-align:right">
    <div class="inv-number">INVOICE</div>
    <div style="font-size:12pt;font-weight:300;letter-spacing:1px;margin-top:1pt">${invoice.invoice_number||''}</div>
    <div class="inv-meta">Issued: ${invoice.issue_date||'—'}${invoice.due_date?`<br>Due: ${invoice.due_date}`:''}<br>
    <span class="status-chip s-${invoice.status||'draft'}">${invoiceStatusLabel(invoice.status)}</span></div>
  </div>
</div>
<div class="bill-row">
  <div class="bill-box">
    <div class="bill-label">Bill To</div>
    <div class="bill-name">${invoice.account_name||'—'}</div>
    ${invoice.account_email||invoice.account_phone?`<div class="bill-contact">${[invoice.account_email,invoice.account_phone].filter(Boolean).join(' &middot; ')}</div>`:''}
  </div>
</div>
${invoice.notes?`<div class="notes">${invoice.notes}</div>`:''}
<table>
  <thead><tr><th>Description &amp; Swimmers</th><th>Type</th><th class="td-amt">Amount</th></tr></thead>
  <tbody>${linesHtml}</tbody>
</table>
<div class="totals">
  <div class="tot-row"><span>Subtotal</span><span>RM ${total.toFixed(2)}</span></div>
  ${paidAmt>0?`<div class="tot-row paid-line"><span>Paid</span><span>− RM ${paidAmt.toFixed(2)}</span></div>`:''}
  <div class="tot-row grand">
    <span>${isPaid?'Paid in full ✓':'Outstanding'}</span>
    <span>${isPaid?'RM 0.00':'RM '+outstanding.toFixed(2)}</span>
  </div>
</div>
<div class="footer"><span>Thank you for choosing Star Swim Sdn Bhd${branchRow?' &middot; '+branchRow:''}</span><span>Generated ${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</span></div>
</div></body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}

function printReceipt(pmt, invoice){
  const logoUrl = window.location.origin + '/logo.png';
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt ${pmt.receipt_number||''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:9pt;color:#1a1a1a;background:#fff}
@page{size:A5 landscape;margin:6mm 9mm}
.page{width:210mm;height:148mm;padding:5mm 7mm;display:flex;flex-direction:column;overflow:hidden}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:5pt;border-bottom:1pt solid #1a1a1a;margin-bottom:8pt}
.brand-logo{height:28pt;object-fit:contain;display:block}
.brand-text{font-size:6.5pt;color:#555;margin-top:3pt;line-height:1.5}
.rct-title{font-size:10pt;font-weight:300;letter-spacing:.8px;color:#1a1a1a;margin-bottom:1pt}
.rct-num{font-size:12pt;font-weight:300;letter-spacing:1px}
.row{display:flex;justify-content:space-between;padding:4pt 0;border-bottom:1pt solid #f0f0f0;font-size:8.5pt}
.row-label{color:#777}
.row-val{font-weight:500}
.row.amount{border-bottom:none;border-top:1.5pt solid #1a1a1a;margin-top:6pt;padding-top:6pt;font-size:12pt;font-weight:700}
.paid-stamp{display:inline-block;border:1.5pt solid #059669;color:#059669;padding:3pt 10pt;border-radius:2pt;font-size:8.5pt;font-weight:600;letter-spacing:.5px;margin-top:8pt}
.footer{margin-top:auto;padding-top:4pt;border-top:1pt solid #e5e5e5;font-size:6pt;color:#aaa;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body><div class="page">
<div class="hdr">
  <div>
    <img class="brand-logo" src="${logoUrl}" onerror="this.style.display='none'">
    <div class="brand-text">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak<br>TIN: C59796139050</div>
  </div>
  <div style="text-align:right"><div class="rct-title">RECEIPT</div><div class="rct-num">${pmt.receipt_number||'—'}</div></div>
</div>
<div class="row"><span class="row-label">Invoice</span><span class="row-val">${invoice.invoice_number||'—'}</span></div>
<div class="row"><span class="row-label">Account</span><span class="row-val">${invoice.account_name||'—'}</span></div>
<div class="row"><span class="row-label">Date</span><span class="row-val">${pmt.payment_date||'—'}</span></div>
<div class="row"><span class="row-label">Payment Method</span><span class="row-val">${methodLabel(pmt.payment_method)}</span></div>
${pmt.reference_number?`<div class="row"><span class="row-label">Reference</span><span class="row-val">${pmt.reference_number}</span></div>`:''}
${pmt.notes?`<div class="row"><span class="row-label">Notes</span><span class="row-val">${pmt.notes}</span></div>`:''}
<div class="row amount"><span>Amount Paid</span><span>RM ${Number(pmt.amount).toFixed(2)}</span></div>
<div><span class="paid-stamp">PAID IN FULL</span></div>
<div class="footer"><span>Thank you for your payment · Star Swim Sdn Bhd</span><span>Generated ${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</span></div>
</div></body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}

function printInvoiceAndReceipt(invoice, lines, pmt, membersByGroup){
  const logoUrl = window.location.origin + '/logo.png';
  const billable = (lines||[]).filter(l=>l.is_billable);
  const paidAmt = Number(invoice.amount_paid)||0;
  const total = Number(invoice.total_amount)||0;
  const linesHtml = billable.map(l=>{
    const isAdjustment = l.line_type==='adjustment';
    const amt = Number(l.amount)||0;
    const amtHtml = amt<0 ? `<span style="color:#DC2626">&minus;RM ${Math.abs(amt).toFixed(2)}</span>` : `RM ${amt.toFixed(2)}`;
    if(isAdjustment){
      return `<tr><td class="td-d" style="color:#DC2626">${l.description||'Deduction'}</td><td class="td-t" style="color:#DC2626">Deduction</td><td class="td-a">${amtHtml}</td></tr>`;
    }
    const swimmers = getSwimmerNames(l, membersByGroup);
    const ltName  = l.lesson_type_name || l.description || '';
    const pkgName = l.package_name || (l.line_type==='group_bundle' ? 'Group Bundle' : 'Individual');
    const descText = [ltName, pkgName].filter(Boolean).join(' · ');
    const descHtml = swimmers.length
      ? `${descText}<div style="font-size:6.5pt;color:#666;margin-top:1pt">${swimmers.join(' &middot; ')}</div>`
      : descText;
    return `<tr><td class="td-d">${descHtml}</td><td class="td-t">${pkgName}</td><td class="td-a">${amtHtml}</td></tr>`;
  }).join('');
  const co = `<img class="logo" src="${logoUrl}" onerror="this.style.display='none'"><div class="co">Star Swim Sdn Bhd (1602674-U)<br>No.137 Jalan Sultan Abdul Jalil, 30000 Ipoh<br>TIN: C59796139050</div>`;
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice & Receipt</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:8pt;color:#1a1a1a;background:#fff}
@page{size:A4 portrait;margin:5mm}
.block{width:197mm;height:141mm;overflow:hidden;display:flex;flex-direction:column;padding:5mm 7mm}
.block+.block{border-top:1pt dashed #ccc}
.hdr{display:flex;justify-content:space-between;padding-bottom:4pt;border-bottom:1pt solid #1a1a1a;margin-bottom:5pt}
.logo{height:22pt;object-fit:contain}
.co{font-size:5.5pt;color:#666;margin-top:2pt;line-height:1.5}
.rtitle{font-size:8pt;font-weight:400;letter-spacing:.5px}
.rnum{font-size:9.5pt;font-weight:300;letter-spacing:.8px}
.rmeta{font-size:6pt;color:#888;margin-top:1pt;text-align:right;line-height:1.4}
.bill{background:#f8f9fa;border-radius:2pt;padding:2.5pt 5pt;margin-bottom:4pt;font-size:7pt}
.bill strong{font-size:7.5pt;display:block}
table{width:100%;border-collapse:collapse;margin-bottom:4pt}
th{font-size:5.5pt;text-transform:uppercase;letter-spacing:.4px;color:#999;font-weight:600;padding:2pt 3pt;border-bottom:1pt solid #e5e5e5;text-align:left}
.td-d,.td-t,.td-a{padding:2.5pt 3pt;font-size:7.5pt;border-bottom:1pt solid #f2f2f2;line-height:1.4}
.td-a{text-align:right;font-weight:600;white-space:nowrap}
.td-t{color:#888;white-space:nowrap}
.totals{margin-left:auto;min-width:90pt}
.tr{display:flex;justify-content:space-between;font-size:7pt;color:#666;padding:1.5pt 0}
.tr.grand{font-size:8.5pt;font-weight:700;color:#1a1a1a;border-top:1pt solid #1a1a1a;margin-top:2pt;padding-top:3pt}
.row{display:flex;justify-content:space-between;padding:3pt 0;border-bottom:1pt solid #f0f0f0;font-size:7.5pt}
.rl{color:#777}.rv{font-weight:500}
.row.big{border-top:1.5pt solid #1a1a1a;border-bottom:none;margin-top:3pt;padding-top:4pt;font-size:9.5pt;font-weight:700}
.stamp{display:inline-block;border:1pt solid #059669;color:#059669;padding:2pt 7pt;border-radius:2pt;font-size:7pt;font-weight:600;margin-top:5pt}
.foot{margin-top:auto;padding-top:3pt;border-top:1pt solid #eee;font-size:5.5pt;color:#bbb;display:flex;justify-content:space-between}
</style>
<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script>
</head><body>
<div class="block">
  <div class="hdr">
    <div>${co}</div>
    <div style="text-align:right">
      <div class="rtitle">INVOICE</div>
      <div class="rnum">${invoice.invoice_number||''}</div>
      <div class="rmeta">Issued: ${invoice.issue_date||'—'}${invoice.due_date?`<br>Due: ${invoice.due_date}`:''}</div>
    </div>
  </div>
  <div class="bill"><span style="font-size:5pt;text-transform:uppercase;letter-spacing:.4px;color:#999">Bill To</span><strong>${invoice.account_name||'—'}</strong>${invoice.account_email?`<span style="font-size:6.5pt;color:#666"> ${invoice.account_email}</span>`:''}</div>
  <table><thead><tr><th>Description &amp; Swimmers</th><th>Type</th><th style="text-align:right">Amount</th></tr></thead><tbody>${linesHtml}</tbody></table>
  <div class="totals">
    <div class="tr"><span>Subtotal</span><span>RM ${total.toFixed(2)}</span></div>
    ${paidAmt>0?`<div class="tr" style="color:#059669"><span>Paid</span><span>− RM ${paidAmt.toFixed(2)}</span></div>`:''}
    <div class="tr grand"><span>Paid in full</span><span>RM 0.00</span></div>
  </div>
  <div class="foot"><span>Thank you · Star Swim Sdn Bhd</span><span>${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</span></div>
</div>
${pmt?`<div class="block">
  <div class="hdr">
    <div>${co}</div>
    <div style="text-align:right"><div class="rtitle">RECEIPT</div><div class="rnum">${pmt.receipt_number||'—'}</div></div>
  </div>
  <div class="row"><span class="rl">Invoice</span><span class="rv">${invoice.invoice_number||'—'}</span></div>
  <div class="row"><span class="rl">Account</span><span class="rv">${invoice.account_name||'—'}</span></div>
  <div class="row"><span class="rl">Date</span><span class="rv">${pmt.payment_date||'—'}</span></div>
  <div class="row"><span class="rl">Method</span><span class="rv">${methodLabel(pmt.payment_method)}</span></div>
  ${pmt.reference_number?`<div class="row"><span class="rl">Reference</span><span class="rv">${pmt.reference_number}</span></div>`:''}
  <div class="row big"><span>Amount Paid</span><span>RM ${Number(pmt.amount).toFixed(2)}</span></div>
  <div><span class="stamp">PAID IN FULL</span></div>
  <div class="foot"><span>Thank you for your payment</span><span>${new Date().toLocaleDateString(undefined,{dateStyle:'long'})}</span></div>
</div>`:''}
</body></html>`;
  const w=window.open('','_blank'); if(w){w.document.write(html);w.document.close();}
}



// ============================================================================
// Programme module — event & workout planning calendar (Weekly + Monthly)
// ============================================================================

// Soft tint from a hex; falls back to a neutral slate card.
function programmeCardColors(hex){
  if(!hex) return { bg:'#F1F5F9', bd:'#CBD5E1', tx:'#0F172A' };
  return { bg: hex + '1A', bd: hex, tx:'#0F172A' };
}

function ProgrammeCard({ s, categoryById, poolById, instructorById, showPoolBadge, onEdit }){
  const cat = s.categoryId ? categoryById(s.categoryId) : null;
  const tint = s.color || (cat && cat.color) || null;
  const c = programmeCardColors(tint);
  const pool = s.poolId ? poolById(s.poolId) : null;
  const heading = s.title || (cat && cat.name) || 'Session';
  const instNames = (s.instructorIds || []).map(id => (instructorById && instructorById(id))?.name).filter(Boolean);
  return <div className="wa-card prog-card" onClick={(e)=>{ e.stopPropagation(); onEdit(s); }}
    style={{ background:c.bg, borderLeft:`3px solid ${c.bd}`, color:c.tx }}>
    <div className="wa-card-head"><span className="wa-card-title">{heading}</span></div>
    <div className="wa-card-line">{compactRange(s.startMinute, s.durationMinutes)}{showPoolBadge && pool ? <span className="event-pool-pill" style={{marginLeft:4}}>{pool.name}</span> : null}</div>
    {instNames.length ? <div className="wa-card-line prog-card-inst">👤 {instNames.join(', ')}</div> : null}
    {cat ? <div className="prog-cat-chip" style={{background:(cat.color||'#64748B')+'22', color:cat.color||'#475569', borderColor:cat.color||'#94A3B8'}}>{cat.name}</div> : null}
    {s.body ? <div className="prog-card-body">{s.body}</div> : <div className="wa-card-students-empty">— no notes yet —</div>}
  </div>;
}

function ProgrammeWeekView({ programmeWeekDays, pools, selectedPoolId, setSelectedPoolId, gridBounds, categoryById, poolById, instructorById, onAdd, onEdit, selectedWeekStart, currentWeekStart, onPrev, onNext, onToday, branchLabel }){
  const wb = weekBounds(selectedWeekStart);
  const startHour = Math.floor(gridBounds.startMin / 60) * 60;
  const hours = [];
  for(let h = startHour; h < gridBounds.endMin; h += 60) hours.push(h);
  const showPoolBadge = !selectedPoolId && pools.length > 1;
  return <div className="card" style={{marginBottom:16}}>
    <div className="view-head"><div>
      <div className="view-title">Programme — Weekly</div>
      <div className="small subtle">Structure workouts, teaching focus and activities per slot. Click any empty cell to add a session.{branchLabel ? ` · ${branchLabel}` : ''}</div>
    </div></div>
    <PeriodNav rangeLabel={weekRangeLabel(selectedWeekStart)} onPrev={onPrev} onNext={onNext} onToday={onToday} isCurrent={selectedWeekStart === currentWeekStart} />
    <div className="pool-tabs" style={{marginTop:12}}>
      <button className={`pool-tab ${selectedPoolId===null?'active':''}`} onClick={()=>setSelectedPoolId(null)}>All</button>
      {pools.map(p => <button key={p.id} className={`pool-tab ${selectedPoolId===p.id?'active':''}`} onClick={()=>setSelectedPoolId(p.id)}>{p.name}</button>)}
    </div>
    <div className="wagenda">
      <div className="wa-corner" />
      {DAYS_S.map((d,di) => {
        const dateObj = new Date(wb.start); dateObj.setDate(wb.start.getDate()+di);
        const dateStr = dateObj.toLocaleDateString(undefined,{month:'short', day:'numeric'});
        return <div key={'h'+di} className="wa-dayhead"><div>{d}</div><div style={{fontSize:'10px',fontWeight:600,color:'#94A3B8'}}>{dateStr}</div></div>;
      })}
      {hours.map(h => <React.Fragment key={h}>
        <div className="wa-time">{hourLabel(h)}</div>
        {DAYS_S.map((_,di) => {
          const cell = (programmeWeekDays[di] || []).filter(s => s.startMinute >= h && s.startMinute < h + 60);
          return <div key={di+'-'+h} className="wa-cell" onClick={()=>onAdd(di, h, selectedPoolId || undefined)}>
            {cell.map(s => <ProgrammeCard key={s.id} s={s} categoryById={categoryById} poolById={poolById} instructorById={instructorById} showPoolBadge={showPoolBadge} onEdit={onEdit} />)}
          </div>;
        })}
      </React.Fragment>)}
    </div>
  </div>;
}

function ProgrammeMonthView({ monthCursor, setMonthCursor, monthDates, selectedDate, setSelectedDate, programmeSessionsForDate, categoryById, instructorById, onAdd, onEdit }){
  const monthOpts = [];
  for(let y=2025;y<=2032;y++) for(let m=0;m<12;m++){ const d = new Date(y,m,1); monthOpts.push(<option key={`${y}-${m}`} value={monthKey(d)}>{d.toLocaleDateString(undefined,{month:'long', year:'numeric'})}</option>); }
  const items = programmeSessionsForDate(selectedDate);
  const di = (fromDateStr(selectedDate).getDay() + 6) % 7;
  function instLabel(s){ return (s.instructorIds || []).map(id => (instructorById && instructorById(id))?.name).filter(Boolean).join(', '); }
  return <>
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:14}}>
        <div><div style={{fontSize:18,fontWeight:800}}>Programme — Monthly</div><div className="small subtle">Monday-first overview. Click a day to view and edit its programme below.</div></div>
        <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <button className="btn btn-ghost" onClick={()=>setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()-1, 1))}>←</button>
          <select className="select" style={{width:240}} value={monthKey(monthCursor)} onChange={(e)=>{ const [y,m]=e.target.value.split('-').map(Number); setMonthCursor(new Date(y,m-1,1)); }}>{monthOpts}</select>
          <button className="btn btn-ghost" onClick={()=>setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth()+1, 1))}>→</button>
        </div>
      </div>
      <div className="month-grid">
        {DAYS_S.map(d => <div key={d} className="month-dow">{d}</div>)}
        {monthDates.map(d => {
          const ds = toDateStr(d), inMonth = d.getMonth() === monthCursor.getMonth(), dayItems = programmeSessionsForDate(ds);
          return <div key={ds} className={`day-box prog-day-box ${inMonth?'':'outside'} ${selectedDate===ds?'selected':''}`} onClick={()=>setSelectedDate(ds)}>
            <div className="day-top"><div className="day-num">{d.getDate()}</div></div>
            <div className="prog-mini-list">{dayItems.length ? dayItems.slice(0,3).map(s => { const cat = s.categoryId ? categoryById(s.categoryId) : null; const c = programmeCardColors(s.color || (cat && cat.color)); const inst = instLabel(s); return <div key={s.id} className="prog-mini-item" style={{background:c.bg,borderLeftColor:c.bd,color:c.tx}}>
              <div className="pmi-top">{s.title || (cat && cat.name) || 'Session'}</div>
              <div className="pmi-sub">{minuteToTime(s.startMinute)}{inst ? ` · ${inst}` : ''}</div>
            </div>; }) : <div className="small subtle">—</div>}{dayItems.length>3 ? <div className="small subtle" style={{marginTop:3}}>+{dayItems.length-3} more</div> : null}</div>
          </div>;
        })}
      </div>
    </div>
    <div className="card" style={{marginTop:16}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:12}}>
        <div><div style={{fontSize:18,fontWeight:800}}>{longDate(selectedDate)}</div><div className="small subtle">{items.length} session{items.length===1?'':'s'} planned</div></div>
        <button className="btn btn-primary small" onClick={()=>onAdd(di, 540, undefined)}>+ Create session</button>
      </div>
      {items.length ? <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {items.map(s => { const cat = s.categoryId ? categoryById(s.categoryId) : null; const c = programmeCardColors(s.color || (cat && cat.color)); const inst = instLabel(s); return <div key={s.id} className="prog-row" onClick={()=>onEdit(s)} style={{borderLeft:`3px solid ${c.bd}`}}>
          <div className="prog-row-time">{compactRange(s.startMinute, s.durationMinutes)}</div>
          <div className="prog-row-main">
            <div className="prog-row-title">{s.title || (cat && cat.name) || 'Session'}{cat ? <span className="prog-cat-chip" style={{marginLeft:6,background:(cat.color||'#64748B')+'22',color:cat.color||'#475569',borderColor:cat.color||'#94A3B8'}}>{cat.name}</span> : null}</div>
            {inst ? <div className="small subtle" style={{marginTop:2}}>👤 {inst}</div> : null}
            {s.body ? <div className="prog-row-body">{s.body}</div> : <div className="small subtle">— no notes —</div>}
          </div>
        </div>; })}
      </div> : <div className="empty">No programme sessions for this day. Click “+ Create session” to add one.</div>}
    </div>
  </>;
}

function ProgrammeSessionModal({ modal, setModal, busy, onSave, onDelete, onDuplicateForward, pools, categories, instructors, gridBounds }){
  const f = modal.form;
  function set(patch){ setModal({ ...modal, form:{ ...modal.form, ...patch } }); }

  // Esc / dirty-close — same behaviour as the scheduling session editor.
  const [escWarn, setEscWarn] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const initialFormRef = React.useRef(null);
  React.useEffect(() => { initialFormRef.current = JSON.stringify(modal.form); }, []); // eslint-disable-line
  const isDirty = initialFormRef.current !== null && JSON.stringify(modal.form) !== initialFormRef.current;
  function requestClose(){ if(isDirty) setEscWarn(true); else setModal(null); }
  React.useEffect(() => {
    function onKey(e){
      if(e.key !== 'Escape') return;
      e.stopPropagation();
      if(escWarn){ setEscWarn(false); return; }   // ESC again dismisses warning
      if(isDirty) setEscWarn(true); else setModal(null);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isDirty, escWarn]);

  const timeOpts = [];
  for(let m = gridBounds.startMin; m < gridBounds.endMin; m += 30) timeOpts.push(m);
  const durOpts = [30,45,60,75,90,105,120,150,180];
  const selectedInst = f.instructorIds || [];
  function toggleInstructor(id){
    const cur = f.instructorIds || [];
    if(cur.includes(id)) set({ instructorIds: cur.filter(x => x !== id) });
    else if(cur.length < 3) set({ instructorIds: [...cur, id] });
  }

  return <div className="modal-backdrop" onClick={requestClose}>
    <div className="modal-card" onClick={e=>e.stopPropagation()} style={{width:'min(560px,100%)'}}>
      <div style={{padding:'14px 18px',borderBottom:'1px solid var(--border)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{fontWeight:800,fontSize:16}}>{modal.mode==='edit' ? 'Edit Programme Session' : 'New Programme Session'}</div>
        <button className="btn btn-ghost small" onClick={requestClose} aria-label="Close" title="Close (Esc)">✕</button>
      </div>
      {escWarn && <div className="esc-warn-bar">
        <span>⚠ You have unsaved changes.</span>
        <div style={{display:'flex',gap:6,flexShrink:0}}>
          <button className="btn btn-primary small" onClick={()=>{ setEscWarn(false); onSave(); }}>Save &amp; Close</button>
          <button className="btn btn-danger small" onClick={()=>{ setEscWarn(false); setModal(null); }}>Discard Changes</button>
          <button className="btn btn-ghost small" onClick={()=>setEscWarn(false)}>Keep Editing</button>
        </div>
      </div>}
      <div style={{padding:'16px 18px',overflowY:'auto',display:'flex',flexDirection:'column',gap:14}}>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <label style={{flex:'1 1 130px'}}><div className="field-label">Day</div>
            <select className="select" value={f.weekday} onChange={e=>set({weekday:Number(e.target.value)})}>{DAYS_F.map((d,i)=><option key={i} value={i}>{d}</option>)}</select></label>
          <label style={{flex:'1 1 120px'}}><div className="field-label">Start time</div>
            <select className="select" value={f.startMinute} onChange={e=>set({startMinute:Number(e.target.value)})}>{timeOpts.map(m=><option key={m} value={m}>{minuteToTime(m)}</option>)}</select></label>
          <label style={{flex:'1 1 110px'}}><div className="field-label">Duration</div>
            <select className="select" value={f.durationMinutes} onChange={e=>set({durationMinutes:Number(e.target.value)})}>{durOpts.map(m=><option key={m} value={m}>{m} min</option>)}</select></label>
        </div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          <label style={{flex:'1 1 160px'}}><div className="field-label">Pool <span className="subtle">(optional)</span></div>
            <select className="select" value={f.poolId||''} onChange={e=>set({poolId:e.target.value||null})}><option value="">— None —</option>{pools.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label style={{flex:'1 1 160px'}}><div className="field-label">Swim Group Category <span className="subtle">(optional)</span></div>
            <select className="select" value={f.categoryId||''} onChange={e=>set({categoryId:e.target.value||null})}><option value="">— None —</option>{(categories||[]).filter(c=>c.is_active!==false).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <div>
          <div className="field-label">Instructors <span className="subtle">(up to 3 · {selectedInst.length}/3 selected)</span></div>
          <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
            {(instructors||[]).length === 0 ? <span className="small subtle">No instructors yet — add them in Settings › Instructors.</span> : (instructors||[]).map(inst => {
              const on = selectedInst.includes(inst.id);
              const disabled = !on && selectedInst.length >= 3;
              const gIcon = inst.gender === 'female' ? '♀ ' : (inst.gender === 'male' ? '♂ ' : '');
              return <button key={inst.id} type="button" className={`chip chip-instructor ${on?'is-on':''}`} onClick={()=>toggleInstructor(inst.id)} disabled={disabled} style={disabled?{opacity:.4,cursor:'not-allowed'}:undefined} title={on?`Remove ${inst.name}`:(disabled?'Up to 3 instructors':`Add ${inst.name}`)}>{gIcon}{inst.name}</button>;
            })}
          </div>
        </div>
        <label><div className="field-label">Title <span className="subtle">(shown on the card)</span></div>
          <input className="input" value={f.title} onChange={e=>set({title:e.target.value})} placeholder="e.g. Squad A — Endurance set" /></label>
        <label><div className="field-label">Programme notes</div>
          <textarea className="textarea" style={{minHeight:160}} value={f.body} onChange={e=>set({body:e.target.value})} placeholder="Free text for coaches — workout, teaching focus, drills, activities…" /></label>

        {modal.mode==='edit' && modal.id && onDuplicateForward && <div className="cancel-class-panel">
          <button type="button" className={`cancel-class-toggle ${dupOpen?'is-open':''}`} onClick={()=>setDupOpen(o=>!o)} style={{background:'#EFF6FF',borderColor:'#BFDBFE',color:'#1E40AF'}}>
            <span>⏩ Copy this session to future weeks</span>
            <span className="cancel-class-chev" style={{color:'#1E40AF'}}>{dupOpen ? '▴' : '▾'}</span>
          </button>
          {dupOpen && <div className="cancel-class-options" style={{background:'#EFF6FF',borderColor:'#BFDBFE'}}>
            <div className="cancel-class-hint" style={{color:'#1E40AF'}}>Copies this session into the next N weeks at the same day &amp; time, carrying the title, notes, pool, category and instructors. Weeks that already have a matching session at that slot are skipped.</div>
            <div className="dup-buttons">
              {[1,2,3,4,8,12].map(n => <button key={n} type="button" className="dup-btn" onClick={()=>onDuplicateForward(modal.id, n)}>{n===1 ? 'Next week' : `Next ${n} weeks`}</button>)}
              <button type="button" className="dup-btn" onClick={()=>{ const v = prompt('How many weeks ahead to copy? (1–52)', '4'); const n = Math.max(1, Math.min(52, parseInt(v,10)||0)); if(n>0) onDuplicateForward(modal.id, n); }}>Custom…</button>
            </div>
          </div>}
        </div>}
      </div>
      <div style={{padding:'12px 18px',borderTop:'1px solid var(--border)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div>{modal.mode==='edit' ? <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>onDelete(modal.id)}>Delete</button> : null}</div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-ghost" onClick={requestClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave} disabled={busy}>{busy ? 'Saving…' : 'Save session'}</button>
        </div>
      </div>
    </div>
  </div>;
}

// Settings › Billing Terms — per-branch named billing periods / school terms
// (e.g. "Term 1 2026") with start & end dates. Branch-scoped like Lesson Types.
// ============================================================================
// SalesView — point-of-sale for product/goods. Cash sale or against an
// existing account (all branches, not branch-filtered). Creates an invoice
// and, if paid now, an immediate receipt.
// ============================================================================
// Visual product picker popup for the Shop — cards with photo, title, SKU,
// description and price.
// Full-screen image viewer. Click the backdrop (anywhere outside the image),
// press Esc, or the ✕ to close.
// ── Messages: website contact-form enquiries ────────────────────────────────

// ── Admin & Procurement (System side) ─────────────────────────────────────
// These modules were merged in from the standalone ssb-admin app (Directory,
// Payment Vouchers, Crew). All read/write to the admin_* tables.

const ADMIN_COMPANY = {
  name: 'STAR SWIM SDN BHD',
  reg: '1602674-U',
  address: 'No.137, Jalan Sultan Abdul Jalil, 30000 Ipoh, Perak'
};
function adminFmtRM(n){ return 'RM ' + Number(n||0).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function adminFmtDate(d){ return d ? new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : ''; }
function adminIni(name){ return (name||'').split(' ').filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join(''); }
function adminPvNo(v){ return v && v.serial_no ? 'PV' + String(v.serial_no).padStart(4,'0') : '—'; }
// Malaysian Ringgit amount in words for printable vouchers
function adminAmountInWords(n){
  const ones=['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens=['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function w(num){
    if(num===0) return '';
    if(num<20) return ones[num];
    if(num<100) return tens[Math.floor(num/10)]+(num%10?' '+ones[num%10]:'');
    if(num<1000) return ones[Math.floor(num/100)]+' Hundred'+(num%100?' '+w(num%100):'');
    if(num<1000000) return w(Math.floor(num/1000))+' Thousand'+(num%1000?' '+w(num%1000):'');
    return w(Math.floor(num/1000000))+' Million'+(num%1000000?' '+w(num%1000000):'');
  }
  const rm=Math.floor(n), sen=Math.round((n-rm)*100);
  let s='Ringgit Malaysia '+(rm?w(rm):'Zero');
  if(sen) s+=' And Sen '+w(sen);
  return s+' Only';
}
// Escape HTML for print templates
function adminEsc(s){ return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Directory ─────────────────────────────────────────────────────────────
function AdminDirectoryView({ companies, contacts, categories, addCategory, updateCategory, deleteCategory, saveCompany, deleteCompany, saveContact, deleteContact, onRefresh }){
  const isMobileDir = useIsMobile();
  const [q,setQ]=useState('');
  const [filterCat,setFilterCat]=useState('all');
  const [openCos,setOpenCos]=useState(new Set());
  const [modal,setModal]=useState(null); // {kind, data?, coId?}
  const [scanBusy,setScanBusy]=useState(false);
  const [addMenuOpen,setAddMenuOpen]=useState(false);
  const addMenuRef = React.useRef(null);
  const fileInputRef = React.useRef(null);

  React.useEffect(()=>{
    function onDoc(e){ if(addMenuRef.current && !addMenuRef.current.contains(e.target)) setAddMenuOpen(false); }
    if(addMenuOpen) document.addEventListener('click', onDoc);
    return ()=>document.removeEventListener('click', onDoc);
  },[addMenuOpen]);

  const catById = useMemo(()=>{ const m={}; (categories||[]).forEach(c=>m[c.id]=c); return m; }, [categories]);

  // Colour palette used to tint company monograms based on category id.
  // Same category → same colour → subtle visual grouping in the list.
  const catColors = ['#0EA5E9','#22C55E','#F59E0B','#8B5CF6','#EF4444','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16','#06B6D4','#D946EF','#F43F5E','#0284C7','#65A30D'];
  function colorForCat(id){
    if(!id) return '#94A3B8';
    const idx = (categories||[]).findIndex(c=>c.id===id);
    return catColors[idx % catColors.length] || '#94A3B8';
  }

  const filteredCompanies = useMemo(()=>{
    const term=q.trim().toLowerCase();
    let rows=(companies||[]).slice();
    if(filterCat!=='all') rows=rows.filter(c=> filterCat==='none' ? !c.category_id : c.category_id===filterCat);
    if(term){
      const matchesCompany=c=> (c.name||'').toLowerCase().includes(term) || (c.email||'').toLowerCase().includes(term) || (c.phone||'').toLowerCase().includes(term) || (c.address||'').toLowerCase().includes(term);
      const contactMatches=(contacts||[]).filter(ct=> (ct.name||'').toLowerCase().includes(term) || (ct.title||'').toLowerCase().includes(term) || (ct.email||'').toLowerCase().includes(term) || (ct.phone||'').toLowerCase().includes(term));
      const coIds=new Set(contactMatches.map(ct=>ct.company_id).filter(Boolean));
      rows=rows.filter(c=> matchesCompany(c) || coIds.has(c.id));
    }
    return rows;
  }, [companies, contacts, q, filterCat]);

  const independentContacts = useMemo(()=>{
    const term=q.trim().toLowerCase();
    let rows=(contacts||[]).filter(ct=>!ct.company_id);
    if(filterCat!=='all' && filterCat!=='none') rows=[]; // categories don't apply to independent contacts
    if(term) rows=rows.filter(ct=> (ct.name||'').toLowerCase().includes(term) || (ct.title||'').toLowerCase().includes(term) || (ct.email||'').toLowerCase().includes(term) || (ct.phone||'').toLowerCase().includes(term));
    return rows;
  }, [contacts, q, filterCat]);

  const contactsByCo = useMemo(()=>{
    const m={};
    (contacts||[]).forEach(ct=>{ if(ct.company_id){ (m[ct.company_id]=m[ct.company_id]||[]).push(ct); } });
    Object.values(m).forEach(arr=>arr.sort((a,b)=>(a.name||'').localeCompare(b.name||'')));
    return m;
  }, [contacts]);

  function toggleCo(id){ const s=new Set(openCos); if(s.has(id)) s.delete(id); else s.add(id); setOpenCos(s); }

  // ── Business card scanner ──
  async function onScanFile(file){
    if(!file) return;
    setScanBusy(true);
    try{
      const b64 = await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=()=>rej(new Error('read fail')); r.readAsDataURL(file); });
      const resp = await fetch('/.netlify/functions/scan',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ image:b64, mime:file.type||'image/jpeg' }) });
      if(!resp.ok) throw new Error('Scan failed: HTTP '+resp.status);
      const data = await resp.json();
      setScanBusy(false);
      setModal({kind:'scan', data});
    } catch(err){ setScanBusy(false); alert('Scan failed: '+(err?.message||err)); }
  }
  async function acceptScan(data){
    let coId=null;
    if(data.company_name?.trim()){
      const existing=(companies||[]).find(c=> (c.name||'').toLowerCase()===data.company_name.trim().toLowerCase());
      if(existing) coId=existing.id;
      else{
        try{
          const rows=await insertRows('admin_companies',{ name:data.company_name.trim(), email:data.company_email||null, phone:data.company_phone||null, address:data.address||null });
          coId=rows?.[0]?.id;
        } catch(err){ alert('Company create failed: '+err.message); return; }
      }
    }
    if(data.name?.trim()){
      try{
        await insertRows('admin_contacts',{ name:data.name.trim(), title:data.title||null, email:data.email||null, phone:data.phone||null, company_id:coId });
      } catch(err){ alert('Contact create failed: '+err.message); return; }
    }
    setModal(null); onRefresh();
  }

  // ── Print directory (A4) ──
  function printDirectory(){
    const term=q.trim(), catName=filterCat==='all'?'':catById[filterCat]?.name;
    let heading='Company Directory';
    if(catName) heading+=' — '+catName;
    if(term) heading+=' — Search: "'+term+'"';
    const dateStr=new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    const blocks=filteredCompanies.map(c=>{
      const cts=contactsByCo[c.id]||[];
      const contactLines=cts.map(ct=>`<div style="margin-left:14pt;font-size:10pt">• ${adminEsc(ct.name)}${ct.title?' — <em>'+adminEsc(ct.title)+'</em>':''}${ct.email?' · '+adminEsc(ct.email):''}${ct.phone?' · '+adminEsc(ct.phone):''}</div>`).join('');
      return `<div style="margin-bottom:14pt;page-break-inside:avoid">
        <div style="font-weight:bold;font-size:12pt">${adminEsc(c.name)}</div>
        ${c.email?`<div style="font-size:10pt">✉ ${adminEsc(c.email)}</div>`:''}
        ${c.phone?`<div style="font-size:10pt">☎ ${adminEsc(c.phone)}</div>`:''}
        ${c.address?`<div style="font-size:10pt">${adminEsc(c.address)}</div>`:''}
        ${contactLines}
      </div>`;
    });
    if(independentContacts.length){
      const items=independentContacts.map(ct=>`<div style="margin-left:14pt;font-size:10pt">• ${adminEsc(ct.name)}${ct.title?' — <em>'+adminEsc(ct.title)+'</em>':''}${ct.email?' · '+adminEsc(ct.email):''}${ct.phone?' · '+adminEsc(ct.phone):''}</div>`).join('');
      blocks.push(`<div style="margin-bottom:14pt;page-break-inside:avoid"><div style="font-weight:bold;font-size:12pt">Independent Contacts</div>${items}</div>`);
    }
    const mid=Math.ceil(blocks.length/2);
    const printHTML=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${adminEsc(heading)}</title><style>@page{size:A4 portrait;margin:18mm 14mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:11pt;color:#000;background:#fff}h1{font-size:13pt;font-weight:bold;margin-bottom:2pt}.sub{font-size:9pt;color:#555;margin-bottom:10pt;border-bottom:1.5px solid #000;padding-bottom:5pt}.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 18pt;align-items:start}</style></head><body><h1>${adminEsc(heading)}</h1><div class="sub">${adminEsc(ADMIN_COMPANY.name)} (${adminEsc(ADMIN_COMPANY.reg)}) — Printed ${dateStr}</div><div class="cols"><div>${blocks.slice(0,mid).join('')}</div><div>${blocks.slice(mid).join('')}</div></div><scr` + `ipt>window.onload=function(){window.print();};</scr` + `ipt></body></html>`;
    const w=window.open('','_blank'); if(!w){ alert('Allow popups from this site to enable printing.'); return; } w.document.write(printHTML); w.document.close();
  }

  const totalContacts = (contacts||[]).length;
  const totalCompanies = (companies||[]).length;
  const uncategorisedCount = (companies||[]).filter(c=>!c.category_id).length;

  return <div style={{maxWidth:1200,margin:'18px auto 0'}}>
    {/* ── Toolbar band: title · totals · search · utilities · primary CTA ── */}
    <div className="dir-toolbar">
      <div className="dir-toolbar-title">
        <div className="t">📇 Directory</div>
        <div className="c">{totalCompanies} companies · {totalContacts} contacts</div>
      </div>
      <div className="dir-toolbar-search">
        <input className="input" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search company, contact, email, phone, address…" />
      </div>
      <div className="dir-toolbar-actions">
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{display:'none'}} onChange={e=>{ onScanFile(e.target.files?.[0]); e.target.value=''; }} disabled={scanBusy} />
        <button className="btn btn-ghost small" onClick={()=>fileInputRef.current?.click()} disabled={scanBusy} title="Scan a business card">📸 {scanBusy?'Scanning…':'Scan'}</button>
        <button className="btn btn-ghost small" onClick={printDirectory} title="Print A4 directory">🖨 Print</button>
        <div style={{position:'relative'}} ref={addMenuRef}>
          <div className="dir-splitbtn">
            <button onClick={()=>{ setAddMenuOpen(false); setModal({kind:'contact', data:{}}); }} title="Add a new contact">+ New Contact</button>
            <button onClick={()=>setAddMenuOpen(v=>!v)} aria-label="More add options" title="More">▾</button>
          </div>
          {addMenuOpen && <div className="dir-menu">
            <button onClick={()=>{ setAddMenuOpen(false); setModal({kind:'contact', data:{}}); }}>👤 New contact</button>
            <button onClick={()=>{ setAddMenuOpen(false); setModal({kind:'company', data:{}}); }}>🏢 New company</button>
            <button onClick={()=>{ setAddMenuOpen(false); setModal({kind:'categoryManager'}); }}>🏷 Manage categories</button>
            <button onClick={()=>{ setAddMenuOpen(false); fileInputRef.current?.click(); }}>📸 Scan business card</button>
          </div>}
        </div>
      </div>
    </div>

    {/* ── Two-column body: category sidebar + company list ── */}
    <div className="side-shell" style={{marginTop:0}}>
      {isMobileDir
        ? <div className="dir-cat-mobile">
            <select className="section-select" style={{marginBottom:0}} value={filterCat} onChange={e=>setFilterCat(e.target.value)} aria-label="Category filter">
              <option value="all">All companies ({totalCompanies})</option>
              {(categories||[]).map(c=>{
                const n=(companies||[]).filter(co=>co.category_id===c.id).length;
                return <option key={c.id} value={c.id}>{c.name} ({n})</option>;
              })}
              {uncategorisedCount>0 && <option value="none">Uncategorised ({uncategorisedCount})</option>}
            </select>
            <button className="btn btn-ghost small" style={{flexShrink:0}} onClick={()=>setModal({kind:'categoryManager'})}>⚙</button>
          </div>
        : <nav className="side-nav">
        <div className="dir-cat-heading">Categories</div>
        <button className={`side-nav-btn dir-cat-btn ${filterCat==='all'?'active':''}`} onClick={()=>setFilterCat('all')}>
          <span>All companies</span><span className="count">{totalCompanies}</span>
        </button>
        {(categories||[]).map(c=>{
          const n=(companies||[]).filter(co=>co.category_id===c.id).length;
          return <button key={c.id} className={`side-nav-btn dir-cat-btn ${filterCat===c.id?'active':''}`} onClick={()=>setFilterCat(c.id)}>
            <span style={{display:'inline-flex',alignItems:'center',gap:8,minWidth:0}}><span style={{width:8,height:8,borderRadius:'50%',background:colorForCat(c.id),flexShrink:0}} /><span style={{overflow:'hidden',textOverflow:'ellipsis'}}>{c.name}</span></span>
            <span className="count">{n}</span>
          </button>;
        })}
        {uncategorisedCount>0 && <button className={`side-nav-btn dir-cat-btn ${filterCat==='none'?'active':''}`} onClick={()=>setFilterCat('none')}>
          <span style={{color:'var(--text-3)',fontStyle:'italic'}}>Uncategorised</span><span className="count">{uncategorisedCount}</span>
        </button>}
        <div style={{borderTop:'1px solid var(--border)',marginTop:6,paddingTop:6}}>
          <button className="side-nav-btn" style={{color:'var(--text-3)'}} onClick={()=>setModal({kind:'categoryManager'})}>+ Manage categories</button>
        </div>
      </nav>}

      <div className="side-content">
        {filteredCompanies.length===0 && independentContacts.length===0
          ? <div className="empty" style={{padding:40,textAlign:'center'}}>
              <div style={{fontSize:32,marginBottom:8,opacity:.4}}>📇</div>
              <div style={{fontWeight:700,color:'var(--text-2)'}}>{(companies||[]).length===0 ? 'No companies yet' : 'No results'}</div>
              <div className="small subtle" style={{marginTop:4}}>{(companies||[]).length===0 ? 'Add a company or scan a business card to get started.' : 'Try a different search or filter.'}</div>
            </div>
          : <>
              {filteredCompanies.length>0 && <div className="dir-section">
                {filterCat==='all' ? 'All companies' : filterCat==='none' ? 'Uncategorised' : catById[filterCat]?.name} · {filteredCompanies.length}
              </div>}
              <div className="dir-list">
                {filteredCompanies.map(co=>{
                  const cts=contactsByCo[co.id]||[]; const open=openCos.has(co.id);
                  const catColor=colorForCat(co.category_id);
                  return <div key={co.id} className="dir-card">
                    <div className="dir-card-head" onClick={()=>toggleCo(co.id)}>
                      <div className="dir-mono" style={{background:catColor+'22',color:catColor}}>{adminIni(co.name)||'?'}</div>
                      <div className="dir-card-body">
                        <div className="dir-card-title">{co.name}<span className="n">· {cts.length} contact{cts.length===1?'':'s'}</span></div>
                        <div className="dir-card-meta">{[co.phone, co.email, co.address].filter(Boolean).join(' · ') || '—'}</div>
                      </div>
                      <div className="dir-card-actions">
                        {co.category_id&&catById[co.category_id]&&<span className="dir-tag" style={{background:catColor+'1a',color:catColor}}>{catById[co.category_id].name}</span>}
                        <span style={{color:'var(--text-3)',fontSize:14,marginLeft:4,transition:'transform .12s ease',display:'inline-block',transform:open?'rotate(90deg)':'rotate(0deg)'}}>▸</span>
                      </div>
                    </div>
                    {open && <div className="dir-card-expand">
                      <div style={{display:'flex',gap:6,padding:'10px 0 6px'}}>
                        <button className="btn btn-ghost small" onClick={e=>{ e.stopPropagation(); setModal({kind:'company',data:co}); }}>✎ Edit company</button>
                        <button className="btn btn-ghost small" onClick={e=>{ e.stopPropagation(); setModal({kind:'contact',data:{},coId:co.id}); }}>+ Add contact</button>
                        <button className="btn btn-ghost small" style={{color:'#DC2626',marginLeft:'auto'}} onClick={e=>{ e.stopPropagation(); deleteCompany(co.id); }}>Delete</button>
                      </div>
                      {cts.length===0
                        ? <div className="small subtle" style={{padding:'12px 10px',textAlign:'center'}}>No contacts yet. Click "+ Add contact" above.</div>
                        : <div style={{display:'flex',flexDirection:'column',gap:4,paddingTop:2}}>
                            {cts.map(ct=><div key={ct.id} className="dir-contact-row">
                              <div className="dir-contact-mono">{adminIni(ct.name)}</div>
                              <div className="dir-contact-body">
                                <div className="dir-contact-name">{ct.name}{ct.title&&<span className="role"> — {ct.title}</span>}</div>
                                <div className="dir-contact-meta">{[ct.phone,ct.email].filter(Boolean).join(' · ')||'—'}</div>
                              </div>
                              <button className="btn btn-ghost small" onClick={()=>setModal({kind:'contact',data:ct})}>✎</button>
                              <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteContact(ct.id)}>×</button>
                            </div>)}
                          </div>}
                    </div>}
                  </div>;
                })}
              </div>
              {independentContacts.length>0 && <>
                <div className="dir-section">Independent contacts · {independentContacts.length}</div>
                <div className="dir-list">
                  {independentContacts.map(ct=><div key={ct.id} className="dir-card">
                    <div className="dir-card-head" style={{cursor:'default'}}>
                      <div className="dir-contact-mono" style={{width:42,height:42,borderRadius:10,fontSize:14}}>{adminIni(ct.name)}</div>
                      <div className="dir-card-body">
                        <div className="dir-card-title">{ct.name}{ct.title&&<span className="n">— {ct.title}</span>}</div>
                        <div className="dir-card-meta">{[ct.phone,ct.email].filter(Boolean).join(' · ')||'—'}</div>
                      </div>
                      <div className="dir-card-actions">
                        <button className="btn btn-ghost small" onClick={()=>setModal({kind:'contact',data:ct})}>✎</button>
                        <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteContact(ct.id)}>×</button>
                      </div>
                    </div>
                  </div>)}
                </div>
              </>}
            </>}
      </div>
    </div>

    {/* Modals unchanged from original — the visual grammar around them is what got the facelift. */}
    {modal?.kind==='company' && <AdminCompanyModal existing={modal.data} categories={categories} onSave={async d=>{ await saveCompany(d, modal.data?.id); setModal(null); }} onClose={()=>setModal(null)} />}
    {modal?.kind==='contact' && <AdminContactModal existing={modal.data} companies={companies} preselectCompanyId={modal.coId} onSave={async d=>{ await saveContact(d, modal.data?.id); setModal(null); }} onClose={()=>setModal(null)} />}
    {modal?.kind==='categoryManager' && <AdminCategoryModal categories={categories} companies={companies} addCategory={addCategory} updateCategory={updateCategory} deleteCategory={deleteCategory} onClose={()=>setModal(null)} />}
    {modal?.kind==='scan' && <AdminScanReviewModal scanned={modal.data} onAccept={acceptScan} onClose={()=>setModal(null)} />}
  </div>;
}

function AdminCompanyModal({ existing, categories, onSave, onClose }){
  const [name,setName]=useState(existing?.name||'');
  const [email,setEmail]=useState(existing?.email||'');
  const [phone,setPhone]=useState(existing?.phone||'');
  const [address,setAddress]=useState(existing?.address||'');
  const [categoryId,setCategoryId]=useState(existing?.category_id||'');
  const [busy,setBusy]=useState(false);
  async function save(){ if(!name.trim()) return; setBusy(true); await onSave({ name:name.trim(), email:email.trim()||null, phone:phone.trim()||null, address:address.trim()||null, category_id:categoryId||null }); setBusy(false); }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:520}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>{existing?.id?'Edit company':'New company'}</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:10}}>
      <div className="field" style={{margin:0}}><label>Company name *</label><input className="input" autoFocus value={name} onChange={e=>setName(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Category</label><select className="select" value={categoryId} onChange={e=>setCategoryId(e.target.value)}><option value="">— None —</option>{(categories||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="field" style={{margin:0}}><label>Email</label><input className="input" value={email} onChange={e=>setEmail(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Phone</label><input className="input" value={phone} onChange={e=>setPhone(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Address</label><textarea className="textarea" value={address} onChange={e=>setAddress(e.target.value)} /></div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy||!name.trim()} onClick={save}>{busy?'Saving…':'Save'}</button>
      </div>
    </div>
  </div></div>;
}

function AdminContactModal({ existing, companies, preselectCompanyId, onSave, onClose }){
  const [name,setName]=useState(existing?.name||'');
  const [title,setTitle]=useState(existing?.title||'');
  const [email,setEmail]=useState(existing?.email||'');
  const [phone,setPhone]=useState(existing?.phone||'');
  const [companyId,setCompanyId]=useState(existing?.company_id||preselectCompanyId||'');
  const [busy,setBusy]=useState(false);
  async function save(){ if(!name.trim()) return; setBusy(true); await onSave({ name:name.trim(), title:title.trim()||null, email:email.trim()||null, phone:phone.trim()||null, company_id:companyId||null }); setBusy(false); }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:520}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>{existing?.id?'Edit contact':'New contact'}</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:10}}>
      <div className="field" style={{margin:0}}><label>Contact name *</label><input className="input" autoFocus value={name} onChange={e=>setName(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Title</label><input className="input" value={title} onChange={e=>setTitle(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Company</label><select className="select" value={companyId} onChange={e=>setCompanyId(e.target.value)}><option value="">— Independent —</option>{(companies||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="field" style={{margin:0}}><label>Email</label><input className="input" value={email} onChange={e=>setEmail(e.target.value)} /></div>
      <div className="field" style={{margin:0}}><label>Phone</label><input className="input" value={phone} onChange={e=>setPhone(e.target.value)} /></div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy||!name.trim()} onClick={save}>{busy?'Saving…':'Save'}</button>
      </div>
    </div>
  </div></div>;
}

function AdminCategoryModal({ categories, companies, addCategory, updateCategory, deleteCategory, onClose }){
  const [newName,setNewName]=useState('');
  const [editingId,setEditingId]=useState(null);
  const [editName,setEditName]=useState('');
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:480}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>🏷 Categories</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:12}}>
      <div style={{display:'flex',gap:8}}>
        <input className="input" value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New category name" />
        <button className="btn btn-primary small" disabled={!newName.trim()} onClick={async()=>{ await addCategory(newName); setNewName(''); }}>+ Add</button>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6,maxHeight:340,overflowY:'auto'}}>
        {(categories||[]).map(c=>{
          const n=(companies||[]).filter(co=>co.category_id===c.id).length;
          const isEditing=editingId===c.id;
          return <div key={c.id} style={{display:'flex',gap:6,alignItems:'center',padding:'6px 8px',background:'var(--surface-2)',borderRadius:6}}>
            {isEditing ? <input className="input" value={editName} onChange={e=>setEditName(e.target.value)} style={{flex:1}} />
                       : <div style={{flex:1,fontWeight:600}}>{c.name} <span className="small subtle" style={{fontWeight:400}}>· {n}</span></div>}
            {isEditing
              ? <>
                  <button className="btn btn-primary small" onClick={async()=>{ await updateCategory(c.id,{name:editName.trim()}); setEditingId(null); }}>Save</button>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>Cancel</button>
                </>
              : <>
                  <button className="btn btn-ghost small" onClick={()=>{ setEditingId(c.id); setEditName(c.name); }}>✎</button>
                  <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteCategory(c.id)}>×</button>
                </>}
          </div>;
        })}
        {(categories||[]).length===0 && <div className="small subtle" style={{padding:8}}>No categories yet.</div>}
      </div>
    </div>
  </div></div>;
}

function AdminScanReviewModal({ scanned, onAccept, onClose }){
  const [d,setD]=useState({
    name: scanned?.name||'', title: scanned?.title||'', email: scanned?.email||'', phone: scanned?.phone||'',
    company_name: scanned?.company_name||'', company_email: scanned?.company_email||'', company_phone: scanned?.company_phone||'', address: scanned?.address||''
  });
  const [busy,setBusy]=useState(false);
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:560}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>📸 Card scan — review</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:14}}>
      <div className="small subtle">Confirm the details before saving. A company will be created if it doesn't already exist, and the contact will be linked to it.</div>
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6}}>Contact</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="field" style={{margin:0}}><label>Name</label><input className="input" value={d.name} onChange={e=>setD({...d,name:e.target.value})} /></div>
          <div className="field" style={{margin:0}}><label>Title</label><input className="input" value={d.title} onChange={e=>setD({...d,title:e.target.value})} /></div>
          <div className="field" style={{margin:0}}><label>Email</label><input className="input" value={d.email} onChange={e=>setD({...d,email:e.target.value})} /></div>
          <div className="field" style={{margin:0}}><label>Phone</label><input className="input" value={d.phone} onChange={e=>setD({...d,phone:e.target.value})} /></div>
        </div>
      </div>
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6}}>Company</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="field" style={{margin:0,gridColumn:'1 / -1'}}><label>Name</label><input className="input" value={d.company_name} onChange={e=>setD({...d,company_name:e.target.value})} /></div>
          <div className="field" style={{margin:0}}><label>Email</label><input className="input" value={d.company_email} onChange={e=>setD({...d,company_email:e.target.value})} /></div>
          <div className="field" style={{margin:0}}><label>Phone</label><input className="input" value={d.company_phone} onChange={e=>setD({...d,company_phone:e.target.value})} /></div>
          <div className="field" style={{margin:0,gridColumn:'1 / -1'}}><label>Address</label><textarea className="textarea" value={d.address} onChange={e=>setD({...d,address:e.target.value})} /></div>
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy||(!d.name.trim()&&!d.company_name.trim())} onClick={async()=>{ setBusy(true); await onAccept(d); setBusy(false); }}>{busy?'Saving…':'Save'}</button>
      </div>
    </div>
  </div></div>;
}

// ── Payment Vouchers ─────────────────────────────────────────────────────
function AdminVouchersView({ vouchers, payees, savePayee, deletePayee, saveVoucher, setVoucherStatus, onRefresh, isSysadmin }){
  const [q,setQ]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [modal,setModal]=useState(null); // {kind:'edit'|'view'|'payees', data?}

  const filtered = useMemo(()=>{
    const term=q.trim().toLowerCase();
    let rows=(vouchers||[]).slice();
    if(statusFilter!=='all') rows=rows.filter(v=>v.status===statusFilter);
    if(term) rows=rows.filter(v=> (v.payee||'').toLowerCase().includes(term) || adminPvNo(v).toLowerCase().includes(term) || (v.remarks||'').toLowerCase().includes(term));
    return rows;
  }, [vouchers, q, statusFilter]);

  const totals = useMemo(()=>{
    const now=new Date(); const monthStart=new Date(now.getFullYear(),now.getMonth(),1).toISOString().slice(0,10);
    const thisMonth=(vouchers||[]).filter(v=>v.pv_date>=monthStart);
    return {
      count:(vouchers||[]).length,
      thisMonth:thisMonth.length,
      paidThisMonth:thisMonth.filter(v=>v.status==='Paid').reduce((s,v)=>s+Number(v.amount||0),0),
    };
  }, [vouchers]);

  function printPV(id){
    const v=(vouchers||[]).find(x=>x.id===id); if(!v) return;
    const itemRows=(v.items||[]).map(i=>`<tr><td style="padding:6pt 4pt;border-bottom:1px solid #ddd">${adminEsc(i.description)}</td><td style="padding:6pt 4pt;border-bottom:1px solid #ddd;text-align:right">${adminFmtRM(i.amount)}</td></tr>`).join('');
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Voucher ${adminPvNo(v)}</title><style>@page{size:A4 portrait;margin:20mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:11pt;color:#000}.hdr{text-align:center;margin-bottom:14pt;border-bottom:2px solid #000;padding-bottom:8pt}.hdr h1{font-size:16pt;font-weight:bold}.hdr .sub{font-size:9pt;color:#555;margin-top:2pt}.title{text-align:center;font-size:14pt;font-weight:bold;margin:14pt 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8pt;margin-bottom:10pt;font-size:11pt}.meta div{padding:2pt 0}.meta .label{font-weight:bold}table{width:100%;border-collapse:collapse;margin:10pt 0}th{background:#f4f4f4;padding:6pt 4pt;text-align:left;border-bottom:2px solid #000}.total{font-weight:bold;font-size:12pt;border-top:2px solid #000;padding-top:6pt}.words{margin-top:10pt;font-style:italic}.sig{margin-top:36pt;display:grid;grid-template-columns:1fr 1fr 1fr;gap:24pt;font-size:10pt}.sig div{border-top:1px solid #000;padding-top:4pt;text-align:center}.void{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120pt;color:#f001;font-weight:bold;pointer-events:none}</style></head><body>
      ${v.status==='Void'?'<div class="void">VOID</div>':''}
      <div class="hdr"><h1>${adminEsc(ADMIN_COMPANY.name)}</h1><div class="sub">(${adminEsc(ADMIN_COMPANY.reg)}) — ${adminEsc(ADMIN_COMPANY.address)}</div></div>
      <div class="title">PAYMENT VOUCHER</div>
      <div class="meta">
        <div><span class="label">No:</span> ${adminPvNo(v)}</div>
        <div style="text-align:right"><span class="label">Date:</span> ${adminEsc(adminFmtDate(v.pv_date))}</div>
        <div><span class="label">Pay to:</span> ${adminEsc(v.payee)}</div>
        <div style="text-align:right"><span class="label">Status:</span> ${adminEsc(v.status)}</div>
        ${v.payee_nric_roc?`<div><span class="label">NRIC/ROC:</span> ${adminEsc(v.payee_nric_roc)}</div>`:''}
        ${v.payee_contact?`<div><span class="label">Contact:</span> ${adminEsc(v.payee_contact)}</div>`:''}
        ${v.payee_detail?`<div style="grid-column:1/-1"><span class="label">Details:</span> ${adminEsc(v.payee_detail)}</div>`:''}
      </div>
      <table><thead><tr><th>Description</th><th style="text-align:right;width:120pt">Amount (RM)</th></tr></thead><tbody>${itemRows}<tr class="total"><td style="padding:6pt 4pt">TOTAL</td><td style="padding:6pt 4pt;text-align:right">${adminFmtRM(v.amount)}</td></tr></tbody></table>
      <div class="words"><span style="font-weight:bold">Amount in words:</span> ${adminEsc(adminAmountInWords(Number(v.amount||0)))}</div>
      ${v.payment_method?`<div style="margin-top:8pt"><span style="font-weight:bold">Payment:</span> ${adminEsc(v.payment_method)}${v.payment_ref?` — Ref: ${adminEsc(v.payment_ref)}`:''}</div>`:''}
      ${v.remarks?`<div style="margin-top:6pt"><span style="font-weight:bold">Remarks:</span> ${adminEsc(v.remarks)}</div>`:''}
      <div class="sig">
        <div>${adminEsc(v.prepared_by||'')}<br/><span style="font-weight:bold">Prepared by</span></div>
        <div>${adminEsc(v.approved_by||'')}<br/><span style="font-weight:bold">Approved by</span></div>
        <div><br/><span style="font-weight:bold">Received by</span></div>
      </div>
      <scr` + `ipt>window.onload=function(){window.print();};</scr` + `ipt></body></html>`;
    const w=window.open('','_blank'); if(!w){ alert('Allow popups from this site to enable printing.'); return; } w.document.write(html); w.document.close();
  }

  const statuses = ['Draft','Approved','Paid','Void'];
  const statusColor = { Draft:'#F59E0B', Approved:'#0EA5E9', Paid:'#22C55E', Void:'#94A3B8' };

  return <div style={{maxWidth:1120,margin:'18px auto 0'}}>
    <div className="card" style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:20,fontWeight:800}}>🧾 Payment Vouchers</div>
          <div className="small subtle">Serialized payment vouchers with running PV numbers, approval flow, amount-in-words, and printable A4 vouchers with signature blocks.</div>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <div className="small subtle"><strong>{totals.count}</strong> total · <strong>{totals.thisMonth}</strong> this month · <strong>{adminFmtRM(totals.paidThisMonth)}</strong> paid this month</div>
          <button className="btn btn-ghost small" onClick={()=>setModal({kind:'payees'})}>👥 Payees</button>
          <button className="btn btn-primary small" onClick={()=>setModal({kind:'edit',data:{}})}>+ New Voucher</button>
        </div>
      </div>
      <div style={{marginTop:10,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <input className="input" style={{flex:1,minWidth:200}} value={q} onChange={e=>setQ(e.target.value)} placeholder="Search PV number, payee, remarks…" />
        <button className={`btn small ${statusFilter==='all'?'btn-primary':'btn-ghost'}`} onClick={()=>setStatusFilter('all')}>All</button>
        {statuses.map(s=>{
          const n=(vouchers||[]).filter(v=>v.status===s).length;
          return <button key={s} className={`btn small ${statusFilter===s?'btn-primary':'btn-ghost'}`} onClick={()=>setStatusFilter(s)}>{s} ({n})</button>;
        })}
      </div>
    </div>

    {filtered.length===0 ? <div className="empty" style={{padding:30}}>No vouchers match. Try a different filter.</div>
      : <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap" style={{border:'none',borderRadius:0}}>
            <table>
              <thead><tr><th style={{width:90}}>PV #</th><th style={{width:110}}>Date</th><th>Payee</th><th style={{textAlign:'right',width:130}}>Amount</th><th style={{width:90}}>Status</th><th style={{textAlign:'right',width:250}}>Actions</th></tr></thead>
              <tbody>
                {filtered.map(v=><tr key={v.id}>
                  <td style={{fontFamily:'monospace',fontWeight:700}}>{adminPvNo(v)}</td>
                  <td>{adminFmtDate(v.pv_date)}</td>
                  <td style={{fontWeight:600}}>{v.payee}<div className="small subtle">{[v.payment_method,v.payment_ref].filter(Boolean).join(' · ')||'—'}</div></td>
                  <td style={{textAlign:'right',fontWeight:700}}>{adminFmtRM(v.amount)}</td>
                  <td><span style={{background:statusColor[v.status]+'22',color:statusColor[v.status],fontWeight:800,fontSize:11,padding:'3px 10px',borderRadius:999}}>{v.status}</span></td>
                  <td style={{textAlign:'right'}}>
                    <button className="btn btn-ghost small" onClick={()=>printPV(v.id)}>🖨</button>
                    {v.status==='Draft' && <button className="btn btn-ghost small" onClick={()=>setVoucherStatus(v.id,'Approved')}>Approve</button>}
                    {v.status==='Approved' && <button className="btn btn-ghost small" onClick={()=>setVoucherStatus(v.id,'Paid')}>Mark Paid</button>}
                    {v.status!=='Void' && (v.status!=='Paid' || isSysadmin) && <button className="btn btn-ghost small" title={v.status==='Paid'?'Amend paid voucher (sysadmin)':'Edit voucher'} onClick={()=>setModal({kind:'edit',data:v})}>✎</button>}
                    <button className="btn btn-ghost small" title="Amendment history" onClick={()=>setModal({kind:'history',data:v})}>🕘</button>
                    {v.status!=='Void' && <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>{ if(confirm(`Void voucher ${adminPvNo(v)}? The number stays in the sequence but the voucher becomes invalid.`)) setVoucherStatus(v.id,'Void'); }}>Void</button>}
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>}

    {modal?.kind==='edit' && <AdminVoucherModal existing={modal.data} payees={payees} savePayee={savePayee} onSave={async d=>{ await saveVoucher(d, modal.data?.id); setModal(null); }} onClose={()=>setModal(null)} />}
    {modal?.kind==='history' && <VoucherHistoryModal voucher={modal.data} onClose={()=>setModal(null)} />}
    {modal?.kind==='payees' && <AdminPayeesModal payees={payees} savePayee={savePayee} deletePayee={deletePayee} onClose={()=>setModal(null)} />}
  </div>;
}

// Read-only amendment trail for one voucher — fetches on open,
// diffs before/after on the fields that matter.
function VoucherHistoryModal({ voucher, onClose }){
  const [rows,setRows]=useState(null); // null = loading
  useEffect(()=>{
    let dead=false;
    selectRows('voucher_amendments','*',`&voucher_id=eq.${voucher.id}&order=created_at.desc`)
      .then(r=>{ if(!dead) setRows(r||[]); })
      .catch(()=>{ if(!dead) setRows([]); });
    return ()=>{ dead=true; };
  },[voucher.id]);
  const FIELDS=[
    ['pv_date','Date'], ['payee','Payee'], ['amount','Amount'],
    ['payment_method','Method'], ['payment_ref','Ref'],
    ['prepared_by','Prepared by'], ['approved_by','Approved by'], ['remarks','Remarks'],
  ];
  function fmtVal(k,v){
    if(v==null||v==='') return '—';
    if(k==='amount') return 'RM '+Number(v).toFixed(2);
    return String(v);
  }
  function diff(a){
    const b=a.before_data||{}, f=a.after_data||{};
    const out=[];
    FIELDS.forEach(([k,label])=>{
      const bv=b[k], fv=f[k];
      if(JSON.stringify(bv??null)!==JSON.stringify(fv??null)) out.push({label, from:fmtVal(k,bv), to:fmtVal(k,fv)});
    });
    const bi=(b.items||[]).length, fi=(f.items||[]).length;
    const bt=(b.items||[]).reduce((s,i)=>s+Number(i.amount||0),0);
    const ft=(f.items||[]).reduce((s,i)=>s+Number(i.amount||0),0);
    if(bi!==fi || bt!==ft) out.push({label:'Line items', from:`${bi} lines · RM ${bt.toFixed(2)}`, to:`${fi} lines · RM ${ft.toFixed(2)}`});
    return out;
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:620}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>🕘 Amendment history — {adminPvNo(voucher)}</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,maxHeight:'65vh',overflowY:'auto'}}>
      {rows===null && <div className="small subtle">Loading…</div>}
      {rows!==null && rows.length===0 && <div className="small subtle">No amendments recorded for this voucher. Edits made before the amendment log was introduced are not shown.</div>}
      {rows!==null && rows.map(a=>{
        const changes=diff(a);
        return <div key={a.id} style={{border:'1px solid var(--border)',borderRadius:10,padding:'10px 12px',marginBottom:10}}>
          <div style={{display:'flex',gap:8,alignItems:'baseline',flexWrap:'wrap',marginBottom:6}}>
            <span style={{fontWeight:700,fontSize:13}}>{new Date(a.created_at).toLocaleString()}</span>
            <span className="small subtle">by {a.edited_by||'—'}</span>
            {a.status_at_edit && <span className="pm-pill pm-slate pm-sm">was {a.status_at_edit}</span>}
          </div>
          {changes.length===0
            ? <div className="small subtle">Saved with no field changes.</div>
            : changes.map((c,i)=><div key={i} className="small" style={{padding:'2px 0'}}>
                <b>{c.label}:</b> <span style={{color:'#DC2626',textDecoration:'line-through'}}>{c.from}</span> → <span style={{color:'#166534',fontWeight:700}}>{c.to}</span>
              </div>)}
        </div>;
      })}
    </div>
  </div></div>;
}

function AdminVoucherModal({ existing, payees, savePayee, onSave, onClose }){
  const amendingPaid = existing?.status==='Paid';
  const [date,setDate]=useState(existing?.pv_date || new Date().toISOString().slice(0,10));
  const [payeeId,setPayeeId]=useState(existing?.payee_id||'');
  const [payeeName,setPayeeName]=useState(existing?.payee||'');
  const [nric,setNric]=useState(existing?.payee_nric_roc||'');
  const [contact,setContact]=useState(existing?.payee_contact||'');
  const [pdetail,setPdetail]=useState(existing?.payee_detail||'');
  const [items,setItems]=useState(existing?.items?.length ? existing.items : [{description:'',amount:0}]);
  const [method,setMethod]=useState(existing?.payment_method||'Cash');
  const [ref,setRef]=useState(existing?.payment_ref||'');
  const [prepared,setPrepared]=useState(existing?.prepared_by||'');
  const [approved,setApproved]=useState(existing?.approved_by||'');
  const [remarks,setRemarks]=useState(existing?.remarks||'');
  const [busy,setBusy]=useState(false);

  const total = items.reduce((s,i)=>s+Number(i.amount||0),0);

  function pickPayee(id){
    setPayeeId(id);
    if(!id){ return; }
    const p=(payees||[]).find(x=>x.id===id); if(!p) return;
    setPayeeName(p.name||''); setNric(p.nric_roc||''); setContact(p.contact||''); setPdetail(p.detail1||'');
  }
  function updateItem(i, patch){ setItems(items.map((x,idx)=>idx===i?{...x,...patch}:x)); }
  function addItem(){ setItems([...items,{description:'',amount:0}]); }
  function removeItem(i){ setItems(items.filter((_,idx)=>idx!==i)); }
  async function save(){
    if(!payeeName.trim()){ alert('Payee name is required'); return; }
    const validItems=items.filter(i=>i.description?.trim() && Number(i.amount)>0);
    if(validItems.length===0){ alert('At least one line item with description and amount is required'); return; }
    setBusy(true);
    let finalPayeeId=payeeId;
    if(!finalPayeeId && payeeName.trim()){
      // Offer to save as reusable payee
      if(confirm(`Save "${payeeName.trim()}" as a reusable payee for future vouchers?`)){
        const id=await savePayee({ name:payeeName.trim(), nric_roc:nric.trim()||null, contact:contact.trim()||null, detail1:pdetail.trim()||null });
        if(id) finalPayeeId=id;
      }
    }
    await onSave({
      pv_date: date,
      payee: payeeName.trim(),
      payee_id: finalPayeeId||null,
      payee_nric_roc: nric.trim()||null,
      payee_contact: contact.trim()||null,
      payee_detail: pdetail.trim()||null,
      items: validItems.map(i=>({description:i.description.trim(), amount:Number(i.amount)})),
      amount: validItems.reduce((s,i)=>s+Number(i.amount),0),
      payment_method: method,
      payment_ref: ref.trim()||null,
      prepared_by: prepared.trim()||null,
      approved_by: approved.trim()||null,
      remarks: remarks.trim()||null,
    });
    setBusy(false);
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:640}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>{existing?.id?`Edit ${adminPvNo(existing)}`:'New Payment Voucher'}</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:12,maxHeight:'70vh',overflowY:'auto'}}>
      {amendingPaid && <div style={{background:'#FEF3C7',border:'1px solid #FDE68A',borderRadius:10,padding:'8px 12px',fontSize:12.5,color:'#92400E'}}>
        ⚠ You are amending a voucher already marked <b>Paid</b>. Its status stays Paid; your changes overwrite the recorded details. Note the reason in Remarks for the audit trail.
      </div>}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div className="field" style={{margin:0}}><label>Date *</label><input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Existing payee</label><select className="select" value={payeeId} onChange={e=>pickPayee(e.target.value)}><option value="">— New payee or type below —</option>{(payees||[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      </div>
      <div className="field" style={{margin:0}}><label>Pay to *</label><input className="input" value={payeeName} onChange={e=>{ setPayeeName(e.target.value); setPayeeId(''); }} placeholder="Payee name" /></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div className="field" style={{margin:0}}><label>NRIC / ROC</label><input className="input" value={nric} onChange={e=>setNric(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Contact</label><input className="input" value={contact} onChange={e=>setContact(e.target.value)} /></div>
      </div>
      <div className="field" style={{margin:0}}><label>Bank details / address</label><input className="input" value={pdetail} onChange={e=>setPdetail(e.target.value)} /></div>
      <div>
        <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>Items</div>
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {items.map((it,i)=><div key={i} style={{display:'flex',gap:6,alignItems:'center'}}>
            <input className="input" style={{flex:1}} value={it.description} onChange={e=>updateItem(i,{description:e.target.value})} placeholder="Description" />
            <input className="input" style={{width:110}} type="number" step="0.01" min="0" value={it.amount} onChange={e=>updateItem(i,{amount:e.target.value})} placeholder="Amount" />
            <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>removeItem(i)} disabled={items.length===1}>×</button>
          </div>)}
          <button className="btn btn-ghost small" style={{alignSelf:'flex-start'}} onClick={addItem}>+ Add line</button>
        </div>
        <div style={{textAlign:'right',fontWeight:800,marginTop:8,fontSize:16}}>Total: {adminFmtRM(total)}</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div className="field" style={{margin:0}}><label>Payment method</label><select className="select" value={method} onChange={e=>setMethod(e.target.value)}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>DuitNow</option><option>Card</option><option>Other</option></select></div>
        <div className="field" style={{margin:0}}><label>Reference</label><input className="input" value={ref} onChange={e=>setRef(e.target.value)} placeholder="Cheque #, ref, etc." /></div>
        <div className="field" style={{margin:0}}><label>Prepared by</label><input className="input" value={prepared} onChange={e=>setPrepared(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Approved by</label><input className="input" value={approved} onChange={e=>setApproved(e.target.value)} /></div>
      </div>
      <div className="field" style={{margin:0}}><label>Remarks</label><textarea className="textarea" value={remarks} onChange={e=>setRemarks(e.target.value)} /></div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy?'Saving…':(existing?.id?'Save changes':'Issue Voucher')}</button>
      </div>
    </div>
  </div></div>;
}

function AdminPayeesModal({ payees, savePayee, deletePayee, onClose }){
  const [newP,setNewP]=useState({name:'',nric_roc:'',contact:'',detail1:''});
  const [editingId,setEditingId]=useState(null);
  const [editP,setEditP]=useState({});
  async function add(){
    if(!newP.name.trim()) return;
    await savePayee({ name:newP.name.trim(), nric_roc:newP.nric_roc.trim()||null, contact:newP.contact.trim()||null, detail1:newP.detail1.trim()||null });
    setNewP({name:'',nric_roc:'',contact:'',detail1:''});
  }
  async function saveEdit(id){
    if(!editP.name?.trim()) return;
    await savePayee({ name:editP.name.trim(), nric_roc:editP.nric_roc?.trim()||null, contact:editP.contact?.trim()||null, detail1:editP.detail1?.trim()||null }, id);
    setEditingId(null);
  }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:640}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>👥 Payees</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:12,maxHeight:'70vh',overflowY:'auto'}}>
      <div className="card" style={{padding:10}}>
        <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>+ New payee</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
          <input className="input" value={newP.name} onChange={e=>setNewP({...newP,name:e.target.value})} placeholder="Name *" />
          <input className="input" value={newP.nric_roc} onChange={e=>setNewP({...newP,nric_roc:e.target.value})} placeholder="NRIC / ROC" />
          <input className="input" value={newP.contact} onChange={e=>setNewP({...newP,contact:e.target.value})} placeholder="Contact" />
          <input className="input" value={newP.detail1} onChange={e=>setNewP({...newP,detail1:e.target.value})} placeholder="Bank / address" />
        </div>
        <button className="btn btn-primary small" style={{marginTop:8}} disabled={!newP.name.trim()} onClick={add}>+ Add payee</button>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {(payees||[]).length===0 && <div className="small subtle" style={{padding:8}}>No payees yet.</div>}
        {(payees||[]).map(p=>{
          const isE=editingId===p.id;
          return <div key={p.id} className="card" style={{padding:10}}>
            {isE ? <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                      <input className="input" value={editP.name||''} onChange={e=>setEditP({...editP,name:e.target.value})} placeholder="Name" />
                      <input className="input" value={editP.nric_roc||''} onChange={e=>setEditP({...editP,nric_roc:e.target.value})} placeholder="NRIC / ROC" />
                      <input className="input" value={editP.contact||''} onChange={e=>setEditP({...editP,contact:e.target.value})} placeholder="Contact" />
                      <input className="input" value={editP.detail1||''} onChange={e=>setEditP({...editP,detail1:e.target.value})} placeholder="Bank / address" />
                    </div>
                    <div style={{display:'flex',gap:6,justifyContent:'flex-end'}}>
                      <button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>Cancel</button>
                      <button className="btn btn-primary small" onClick={()=>saveEdit(p.id)}>Save</button>
                    </div>
                  </div>
                : <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700}}>{p.name}</div>
                      <div className="small subtle">{[p.nric_roc,p.contact,p.detail1].filter(Boolean).join(' · ')||'—'}</div>
                    </div>
                    <button className="btn btn-ghost small" onClick={()=>{ setEditingId(p.id); setEditP({name:p.name,nric_roc:p.nric_roc,contact:p.contact,detail1:p.detail1}); }}>✎</button>
                    <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deletePayee(p.id)}>×</button>
                  </div>}
          </div>;
        })}
      </div>
    </div>
  </div></div>;
}

// ── Attendance: Live board ───────────────────────────────────────────────
// Today across every location, refreshed on a timer. The question this screen
// answers is "is the right instructor at the right pool right now", so each
// card leads with the worker and shows the distance recorded at check-in —
// the geofence decision the server actually made, not a claim from the phone.
//
// Rejected attempts are shown too. Someone trying to check in from 2 km away
// is exactly what an admin wants to see, and it never reaches the punch list
// as an accepted row.
function AttendanceLiveView({ shifts, punches, locations, categories, employees, onRefresh, lastLoaded }){
  const now = new Date();
  const nowMin = now.getHours()*60 + now.getMinutes();
  const toMin = t => { const p=String(t).split(':'); return (+p[0])*60 + (+p[1]); };

  const empById = useMemo(()=>{ const m={}; (employees||[]).forEach(e=>{m[e.id]=e;}); return m; }, [employees]);
  const locById = useMemo(()=>{ const m={}; (locations||[]).forEach(l=>{m[l.id]=l;}); return m; }, [locations]);
  const catById = useMemo(()=>{ const m={}; (categories||[]).forEach(c=>{m[c.id]=c;}); return m; }, [categories]);

  // Group punches per shift: the accepted in/out, plus any rejected attempts.
  const byShift = useMemo(()=>{
    const m={};
    (punches||[]).forEach(p=>{
      const b = m[p.shift_id] = m[p.shift_id] || { rejected:[] };
      if(p.accepted) b[p.type] = p; else b.rejected.push(p);
    });
    return m;
  }, [punches]);

  const rows = useMemo(()=>(shifts||[]).map(s=>{
    const p = byShift[s.id] || { rejected:[] };
    const startMin = toMin(s.start_time), endMin = toMin(s.end_time);
    const phase = nowMin < startMin ? 'upcoming' : nowMin > endMin ? 'finished' : 'running';
    const state = p.out ? 'done'
                : p.in  ? 'in'
                : phase === 'upcoming' ? 'waiting'
                : 'missing';           // started (or over) with no check-in
    return { s, p, phase, state, startMin };
  }).sort((a,b)=>a.startMin-b.startMin), [shifts, byShift, nowMin]);

  const count = k => rows.filter(r=>r.state===k).length;
  const flagged = rows.filter(r=>r.p.rejected.length).length;

  const fmt = iso => new Date(iso).toLocaleTimeString('en-GB',{hour:'numeric',minute:'2-digit',hour12:true});
  const hhmm = t => String(t).slice(0,5);
  const metres = d => d==null ? '' : (d>=1000 ? (d/1000).toFixed(1)+' km' : Math.round(d)+' m');
  // The coordinates the SERVER stored, not what the phone claims now, with the
  // geofence verdict spelled out. The map link lets an admin see the exact
  // spot when a punch looks wrong.
  function Coords({ punch, loc }){
    if(punch.lat==null || punch.lng==null) return null;
    const ok = punch.inside_fence !== false;
    const ll = `${Number(punch.lat).toFixed(6)}, ${Number(punch.lng).toFixed(6)}`;
    return <div className="small" style={{marginTop:3,display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
      <span style={{color:ok?'#059669':'#DC2626',fontWeight:700}}>{ok?'✓':'✗'}</span>
      <a href={`https://www.google.com/maps?q=${punch.lat},${punch.lng}`} target="_blank" rel="noopener noreferrer"
         style={{fontFamily:'ui-monospace,monospace',fontSize:11.5,color:'var(--primary-on-soft,#0369A1)'}}>{ll}</a>
      <span className="subtle" style={{fontSize:11}}>
        {ok ? `inside the ${loc.radius_m||300} m area` : `outside the ${loc.radius_m||300} m area`}
        {punch.accuracy_m!=null && ` · GPS ±${Math.round(punch.accuracy_m)} m`}
      </span>
    </div>;
  }

  const TILES = [
    { k:'in',      label:'Checked in',  color:'#059669', bg:'#ECFDF5', bd:'#A7F3D0' },
    { k:'missing', label:'Not arrived', color:'#DC2626', bg:'#FFF1F1', bd:'#FCA5A5' },
    { k:'waiting', label:'Later today', color:'#475569', bg:'#F1F5F9', bd:'#CBD5E1' },
    { k:'done',    label:'Finished',    color:'#0369A1', bg:'#E0F2FE', bd:'#BAE6FD' },
  ];

  return <div className="card">
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:14,flexWrap:'wrap'}}>
      <div style={{fontWeight:800}}>Live — today</div>
      <div className="small subtle">
        {lastLoaded ? `as of ${fmt(lastLoaded)}` : ''} · refreshes every 45s
      </div>
      <button className="btn btn-ghost small" style={{marginLeft:'auto'}} onClick={onRefresh}>↻ Refresh</button>
    </div>

    <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:16}}>
      {TILES.map(t=><div key={t.k} style={{flex:'1 1 120px',minWidth:120,background:t.bg,border:`1px solid ${t.bd}`,borderRadius:10,padding:'10px 12px'}}>
        <div style={{fontSize:24,fontWeight:800,color:t.color,lineHeight:1.1}}>{count(t.k)}</div>
        <div className="small" style={{color:t.color,fontWeight:600}}>{t.label}</div>
      </div>)}
      {flagged>0 && <div style={{flex:'1 1 120px',minWidth:120,background:'#FFFBEB',border:'1px solid #FCD34D',borderRadius:10,padding:'10px 12px'}}>
        <div style={{fontSize:24,fontWeight:800,color:'#B45309',lineHeight:1.1}}>{flagged}</div>
        <div className="small" style={{color:'#B45309',fontWeight:600}}>Location flagged</div>
      </div>}
    </div>

    {!rows.length && <div className="small subtle" style={{padding:'24px 0'}}>
      No sessions scheduled today.
    </div>}

    {rows.map(({s,p,phase,state})=>{
      const emp = empById[s.crew_id] || {};
      const loc = locById[s.location_id] || {};
      const cat = catById[s.category_id] || {};
      const edge = state==='in' ? '#059669' : state==='missing' ? '#DC2626'
                 : state==='done' ? '#0369A1' : '#CBD5E1';
      return <div key={s.id} style={{border:'1px solid var(--border)',borderLeft:`5px solid ${edge}`,
                   borderRadius:10,padding:'11px 13px',marginBottom:9,
                   background: phase==='running' ? '#FCFEFF' : 'var(--surface)'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
          <div style={{fontWeight:700}}>{emp.full_name || 'Unknown worker'}</div>
          <div className="small subtle">{hhmm(s.start_time)}–{hhmm(s.end_time)} · {loc.name||'—'}</div>
          {cat.name && <span className="small subtle" style={{fontSize:10.5}}>{cat.name}</span>}
          {phase==='running' && <span className="small" style={{marginLeft:'auto',color:'#0369A1',fontWeight:700}}>in session now</span>}
        </div>

        <div className="small" style={{marginTop:5}}>
          {state==='in' && <span style={{color:'#059669',fontWeight:600}}>
            ✓ Checked in {fmt(p.in.punched_at)}{p.in.distance_m!=null && ` · ${metres(p.in.distance_m)} from ${loc.name||'the pool'}`}
            {s.late_min>0 && <span style={{color:'#DC2626'}}> · {s.late_min} min late</span>}
          </span>}
          {(state==='in'||state==='done') && <Coords punch={p.in} loc={loc} />}
          {state==='done' && <span style={{color:'#0369A1',fontWeight:600}}>
            Checked in {fmt(p.in.punched_at)} · out {fmt(p.out.punched_at)}
            {s.late_min>0 && <span style={{color:'#DC2626'}}> · {s.late_min} min late</span>}
            {s.early_min>0 && <span style={{color:'#DC2626'}}> · left {s.early_min} min early</span>}
          </span>}
          {state==='missing' && <span style={{color:'#DC2626',fontWeight:600}}>
            {phase==='finished' ? 'No check-in — session has ended' : 'Not checked in yet'}
          </span>}
          {state==='waiting' && <span className="subtle">Starts later today</span>}
        </div>

        {p.rejected.map((r,i)=><div key={i} style={{marginTop:4}}>
          <div className="small" style={{color:'#B45309'}}>
            ⚠ Tried to check in {fmt(r.punched_at)} from {metres(r.distance_m)} away — refused
          </div>
          <Coords punch={r} loc={loc} />
        </div>)}
      </div>;
    })}
  </div>;
}

// ── Attendance: Report ───────────────────────────────────────────────────
// Week or month, per worker, split by category — the figures a payroll run
// needs. Regular staff are on a monthly salary, so what matters for them is
// the unpaid-leave count; part-timers are paid per session, so what matters
// is sessions actually attended. Both are shown side by side rather than
// collapsed into one "hours" number that would suit neither.
//
// Rates themselves are Phase 5. Until they are configured this reports the
// inputs, which is deliberately where the money question stops: a payout
// figure computed from a rate nobody has entered would be worse than none.
function AttendanceReportView({ shifts, categories, employees, mode, setMode, anchor, setAnchor, rangeLabel, from, to }){
  const empById = useMemo(()=>{ const m={}; (employees||[]).forEach(e=>{m[e.id]=e;}); return m; }, [employees]);
  const catById = useMemo(()=>{ const m={}; (categories||[]).forEach(c=>{m[c.id]=c;}); return m; }, [categories]);

  const hoursOf = s => {
    const p=t=>{const a=String(t).split(':');return (+a[0])*60+(+a[1]);};
    return Math.max(0, p(s.end_time)-p(s.start_time))/60;
  };

  // One row per worker per category. A worker who does both Regular and
  // Part-time sessions gets a line for each, because they are paid differently.
  const rows = useMemo(()=>{
    const acc={};
    (shifts||[]).forEach(s=>{
      const key = s.crew_id+'|'+s.category_id;
      const r = acc[key] = acc[key] || {
        crew_id:s.crew_id, category_id:s.category_id,
        worker:(empById[s.crew_id]||{}).full_name || 'Unknown worker',
        category:(catById[s.category_id]||{}).name || '—',
        scheduled:0, attended:0, absent:0, lateCount:0, lateMin:0,
        earlyCount:0, earlyMin:0, hours:0, unpaidLeave:0, incomplete:0
      };
      r.scheduled += 1;
      if(s.status==='absent'){ r.absent += 1; }
      else { r.attended += 1; r.hours += hoursOf(s); }
      if(s.status==='incomplete') r.incomplete += 1;
      if(s.late_min>0){ r.lateCount += 1; r.lateMin += s.late_min; }
      if(s.early_min>0){ r.earlyCount += 1; r.earlyMin += s.early_min; }
      if(s.is_unpaid_leave) r.unpaidLeave += 1;
    });
    return Object.values(acc).sort((a,b)=>
      a.worker.localeCompare(b.worker) || a.category.localeCompare(b.category));
  }, [shifts, empById, catById]);

  const tot = k => rows.reduce((n,r)=>n+r[k],0);

  const FIELDS = [
    ['worker','Worker'],['category','Category'],['scheduled','Scheduled'],
    ['attended','Attended'],['absent','Absent'],['lateCount','Late'],
    ['lateMin','Late min'],['earlyCount','Left early'],['earlyMin','Early min'],
    ['hours','Hours'],['unpaidLeave','Unpaid leave']
  ];
  function exportRows(){
    return rows.map(r=>{ const o={}; FIELDS.forEach(([k,label])=>{
      o[label] = k==='hours' ? Number(r.hours.toFixed(2)) : r[k]; }); return o; });
  }
  function exportCSV(){
    const head = FIELDS.map(f=>f[1]);
    const esc = v => { const t=String(v??''); return /[",\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t; };
    const csv = [head.join(',')].concat(exportRows().map(o=>head.map(h=>esc(o[h])).join(','))).join('\n');
    const blob = new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=`attendance_${from}_to_${to}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  function exportXLSX(){
    if(typeof XLSX==='undefined'){ alert('Excel library not loaded — use CSV export.'); return; }
    const head = FIELDS.map(f=>f[1]);
    const ws = XLSX.utils.json_to_sheet(exportRows(),{header:head});
    ws['!cols'] = head.map(h=>({wch:Math.max(11,h.length+2)}));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, `attendance_${from}_to_${to}.xlsx`);
  }

  const step = n => {
    if(mode==='week') setAnchor(addDays(anchor, n*7));
    else { const d=fromDateStr(anchor); setAnchor(toDateStr(new Date(d.getFullYear(), d.getMonth()+n, 1))); }
  };

  return <div className="card">
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
      <div style={{fontWeight:800}}>Report</div>
      <div style={{display:'flex',gap:4}}>
        <button className={`btn ${mode==='week'?'btn-primary':'btn-ghost'} small`} onClick={()=>setMode('week')}>Week</button>
        <button className={`btn ${mode==='month'?'btn-primary':'btn-ghost'} small`} onClick={()=>setMode('month')}>Month</button>
      </div>
      <div className="period-stepper" style={{margin:0}}>
        <button className="step-btn" onClick={()=>step(-1)} aria-label="Previous period">‹</button>
        <div className="period-label" style={{fontSize:12}}>{rangeLabel}</div>
        <button className="step-btn" onClick={()=>step(1)} aria-label="Next period">›</button>
      </div>
      <button className="btn btn-ghost small" onClick={()=>setAnchor(todayStr())}>
        {mode==='week'?'This week':'This month'}
      </button>
      <div style={{marginLeft:'auto',display:'flex',gap:6}}>
        <button className="btn btn-ghost small" onClick={exportCSV} disabled={!rows.length}>⇣ CSV</button>
        <button className="btn btn-ghost small" onClick={exportXLSX} disabled={!rows.length}>⇣ Excel</button>
      </div>
    </div>

    {!rows.length && <div className="small subtle" style={{padding:'22px 0'}}>
      No sessions in this period.
    </div>}

    {!!rows.length && <>
      <div className="table-wrap"><table className="table">
        <thead><tr>
          <th>Worker</th><th>Category</th>
          <th className="num" style={{textAlign:'right'}}>Scheduled</th>
          <th className="num" style={{textAlign:'right'}}>Attended</th>
          <th className="num" style={{textAlign:'right'}}>Absent</th>
          <th className="num" style={{textAlign:'right'}}>Late</th>
          <th className="num" style={{textAlign:'right'}}>Left early</th>
          <th className="num" style={{textAlign:'right'}}>Hours</th>
          <th className="num" style={{textAlign:'right'}}>Unpaid leave</th>
        </tr></thead>
        <tbody>{rows.map(r=><tr key={r.crew_id+r.category_id}>
          <td style={{fontWeight:600}}>{r.worker}</td>
          <td>{r.category}</td>
          <td style={{textAlign:'right'}}>{r.scheduled}</td>
          <td style={{textAlign:'right',fontWeight:700}}>{r.attended}</td>
          <td style={{textAlign:'right',color:r.absent?'#DC2626':'inherit'}}>{r.absent||'—'}</td>
          <td style={{textAlign:'right',color:r.lateCount?'#DC2626':'inherit'}}>
            {r.lateCount ? `${r.lateCount} (${r.lateMin}m)` : '—'}</td>
          <td style={{textAlign:'right',color:r.earlyCount?'#DC2626':'inherit'}}>
            {r.earlyCount ? `${r.earlyCount} (${r.earlyMin}m)` : '—'}</td>
          <td style={{textAlign:'right'}}>{r.hours.toFixed(1)}</td>
          <td style={{textAlign:'right',color:r.unpaidLeave?'#B45309':'inherit'}}>{r.unpaidLeave||'—'}</td>
        </tr>)}</tbody>
        <tfoot><tr style={{fontWeight:800,borderTop:'2px solid var(--border)'}}>
          <td colSpan={2}>Total</td>
          <td style={{textAlign:'right'}}>{tot('scheduled')}</td>
          <td style={{textAlign:'right'}}>{tot('attended')}</td>
          <td style={{textAlign:'right'}}>{tot('absent')||'—'}</td>
          <td style={{textAlign:'right'}}>{tot('lateCount')||'—'}</td>
          <td style={{textAlign:'right'}}>{tot('earlyCount')||'—'}</td>
          <td style={{textAlign:'right'}}>{tot('hours').toFixed(1)}</td>
          <td style={{textAlign:'right'}}>{tot('unpaidLeave')||'—'}</td>
        </tr></tfoot>
      </table></div>

      <div className="small subtle" style={{marginTop:14,lineHeight:1.6}}>
        <b>Reading this for payroll.</b> Regular staff are on a fixed monthly
        salary — the column that matters is <b>Unpaid leave</b>, which is
        deducted outside this app. Part-time staff are paid per session, so
        theirs is <b>Attended</b>. Late and early-leave minutes are recorded
        for every session; whether any of them reduce pay is a decision you
        make per incident in the alerts, not something this report applies.
      </div>
    </>}
  </div>;
}

// ── Attendance: Alerts inbox ─────────────────────────────────────────────
// Everything that needs a human decision. Late and early-leave are raised by
// the punch function; absences and missed punches by the five-minute job.
//
// Resolving never erases what happened. The session keeps its status and its
// recorded minutes; the alert gains a decision and a remark alongside them.
// That is the §4 rule — "Late 12 min · No deduction · accident on Jalan Kuala
// Kangsar" is the whole record, not a correction of it.
function AttendanceAlertsView({ alerts, shifts, locations, employees, filter, setFilter, resolveAlert, enterPunch, onRefresh }){
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState(false);

  const empById = useMemo(()=>{ const m={}; (employees||[]).forEach(e=>{m[e.id]=e;}); return m; }, [employees]);
  const locById = useMemo(()=>{ const m={}; (locations||[]).forEach(l=>{m[l.id]=l;}); return m; }, [locations]);
  const shiftById = useMemo(()=>{ const m={}; (shifts||[]).forEach(x=>{m[x.id]=x;}); return m; }, [shifts]);

  const LABEL = {
    late:'Late check-in', early_leave:'Left early', no_checkin:'No check-in',
    no_checkout:'No check-out', absent:'Absent', geofence:'Wrong location'
  };
  // What resolving this alert actually involves. Missed punches need a time
  // entered; the rest need a pay decision.
  const NEEDS_TIME = { no_checkin:'in', no_checkout:'out' };

  const fmt = iso => new Date(iso).toLocaleString('en-GB',
    { day:'numeric', month:'short', hour:'numeric', minute:'2-digit', hour12:true });
  const hhmm = t => String(t||'').slice(0,5);

  // The alert's own copy of the session, taken when it was raised. The live
  // row is used only to tell whether the session has since been removed.
  const snap = a => a.shift_snapshot || {};
  function open(a){
    const s = shiftById[a.shift_id] || {};
    setModal({ a, s,
      pay_treatment: a.pay_treatment || 'none',
      remark: a.remark || '',
      time: NEEDS_TIME[a.type] === 'in' ? hhmm(snap(a).start_time) : hhmm(snap(a).end_time),
      markAbsent: false, markUnpaidLeave: false });
  }

  async function submit(){
    const { a, s } = modal;
    const remark = (modal.remark||'').trim();
    const needsTime = NEEDS_TIME[a.type] && !modal.markAbsent;
    // A manually entered punch is the one place an admin writes attendance
    // history by hand, so the reason is not optional.
    if(needsTime && !remark){ alert('A remark is required when you enter a time by hand.'); return; }
    if(a.type==='absent' && modal.markUnpaidLeave && !remark){ alert('A remark is required for unpaid leave.'); return; }
    setBusy(true);
    try{
      if(needsTime){
        if(!modal.time){ alert('Enter the time.'); setBusy(false); return; }
        await enterPunch(s, NEEDS_TIME[a.type], modal.time, remark);
      }
      await resolveAlert(a, {
        resolution_action: modal.markAbsent ? 'marked_absent'
                         : needsTime ? 'time_entered' : 'reviewed',
        pay_treatment: modal.pay_treatment,
        remark: remark || null,
        markAbsent: modal.markAbsent,
        markUnpaidLeave: modal.markUnpaidLeave
      });
      setModal(null);
    } catch(ex){ alert(ex.message || 'Could not resolve that.'); }
    finally{ setBusy(false); }
  }

  const openCount = (alerts||[]).filter(a=>a.status==='open').length;

  return <div className="card">
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
      <div style={{fontWeight:800}}>Alerts</div>
      {openCount>0 && <span className="small" style={{background:'#FFF1F1',color:'#DC2626',
        border:'1px solid #FCA5A5',borderRadius:999,padding:'1px 9px',fontWeight:800}}>{openCount} open</span>}
      <div style={{display:'flex',gap:4}}>
        <button className={`btn ${filter==='open'?'btn-primary':'btn-ghost'} small`} onClick={()=>setFilter('open')}>Open</button>
        <button className={`btn ${filter==='resolved'?'btn-primary':'btn-ghost'} small`} onClick={()=>setFilter('resolved')}>Resolved</button>
      </div>
      <button className="btn btn-ghost small" style={{marginLeft:'auto'}} onClick={onRefresh}>↻ Refresh</button>
    </div>

    {!(alerts||[]).length && <div className="small subtle" style={{padding:'22px 0'}}>
      {filter==='open' ? 'Nothing needs attention. Alerts appear here when someone is late, leaves early, misses a punch or checks in from the wrong place.'
                       : 'Nothing resolved yet.'}
    </div>}

    {(alerts||[]).map(a=>{
      const s = shiftById[a.shift_id] || {};
      const emp = empById[a.crew_id] || {};
      const loc = locById[s.location_id] || {};
      const bad = a.type==='absent' || a.type==='no_checkin';
      return <div key={a.id} style={{border:'1px solid var(--border)',
                   borderLeft:`5px solid ${bad?'#DC2626':'#B45309'}`,borderRadius:9,
                   padding:'10px 12px',marginBottom:8,background:'var(--surface)'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
          <b>{emp.full_name || 'Unknown worker'}</b>
          <span className="small" style={{fontWeight:700,color:bad?'#DC2626':'#B45309'}}>{LABEL[a.type]||a.type}</span>
          <span className="small subtle">
            {snap(a).shift_date||s.shift_date||''} · {hhmm(snap(a).start_time||s.start_time)}–{hhmm(snap(a).end_time||s.end_time)} · {snap(a).location_name||loc.name||'—'}
          </span>
          {s.is_void && <span className="small" style={{fontWeight:700,color:'#475569',
            background:'#F1F5F9',border:'1px solid #CBD5E1',borderRadius:999,padding:'0 7px'}}>
            session removed</span>}
          <span className="small subtle" style={{marginLeft:'auto'}}>raised {fmt(a.raised_at)}</span>
        </div>

        <div className="small" style={{marginTop:4}}>
          {s.late_min>0 && <span style={{color:'#DC2626',fontWeight:600}}>Late {s.late_min} min</span>}
          {s.late_min>0 && s.early_min>0 && <span className="subtle"> · </span>}
          {s.early_min>0 && <span style={{color:'#DC2626',fontWeight:600}}>Left {s.early_min} min early</span>}
        </div>

        {/* What the worker said. This is the thing being judged, so it leads. */}
        {a.worker_reason
          ? <div className="small" style={{marginTop:6,padding:'6px 9px',background:'#F8FAFC',
                 border:'1px solid var(--border)',borderRadius:7}}>
              <span className="subtle">{(emp.full_name||'They').split(' ')[0]} said:</span> <i>{a.worker_reason}</i>
            </div>
          : a.status==='open' && <div className="small subtle" style={{marginTop:6,fontStyle:'italic'}}>
              No reason given yet — they can add one from their app.
            </div>}

        {a.status==='open'
          ? <button className="btn btn-primary small" style={{marginTop:8}} onClick={()=>open(a)}>Review…</button>
          : <div className="small" style={{marginTop:6,color:'#059669'}}>
              ✓ {a.resolution_action==='time_entered' ? 'Time entered by admin'
                : a.resolution_action==='marked_absent' ? 'Marked absent' : 'Reviewed'}
              {a.pay_treatment && <> · {a.pay_treatment==='full' ? 'Full deduction'
                : a.pay_treatment==='half' ? 'Half deduction' : 'No deduction'}</>}
              {a.remark && <> · <i>{a.remark}</i></>}
              {s.is_void && <> · session removed</>}
            </div>}
      </div>;
    })}

    {modal && (()=>{
      const t = modal.a.type, needsTime = NEEDS_TIME[t] && !modal.markAbsent;
      return <div className="modal-backdrop"><div className="modal-card">
        <div className="modal-head">
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>Review — {LABEL[t]||t}</div>
            <div className="small subtle" style={{fontSize:10.5,marginTop:1}}>
              {(empById[modal.a.crew_id]||{}).full_name} · {snap(modal.a).shift_date||modal.s.shift_date} {hhmm(snap(modal.a).start_time||modal.s.start_time)}–{hhmm(snap(modal.a).end_time||modal.s.end_time)}
            </div>
          </div>
          <button className="btn btn-ghost small" onClick={()=>setModal(null)} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {t==='absent' && <label className="small" style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <input type="checkbox" checked={modal.markUnpaidLeave}
              onChange={e=>setModal({...modal,markUnpaidLeave:e.target.checked})} />
            Mark as unpaid leave <span className="subtle">(counted in the report; deducted outside this app)</span>
          </label>}

          {NEEDS_TIME[t] && <label className="small" style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <input type="checkbox" checked={modal.markAbsent}
              onChange={e=>setModal({...modal,markAbsent:e.target.checked})} />
            They did not work this session — mark absent instead
          </label>}

          {needsTime && <div className="field"><label>
            {NEEDS_TIME[t]==='in' ? 'Check-in time' : 'Check-out time'}
          </label>
            <input className="input" type="time" value={modal.time}
              onChange={e=>setModal({...modal,time:e.target.value})} />
            <div className="small subtle" style={{marginTop:4}}>
              Recorded as entered by you, with no location, and shown
              differently from a real punch.
            </div></div>}

          {t!=='absent' && <div className="field"><label>Pay treatment</label>
            <select className="input" value={modal.pay_treatment}
              onChange={e=>setModal({...modal,pay_treatment:e.target.value})}>
              <option value="none">No deduction</option>
              <option value="half">Deduct half</option>
              <option value="full">Deduct full</option>
            </select>
            <div className="small subtle" style={{marginTop:4}}>
              Recorded now so the history is complete. Nothing is calculated
              from it until pay rates are set up.
            </div></div>}

          {modal.a.worker_reason && <div className="field"><label>Their reason</label>
            <div className="small" style={{padding:'7px 10px',background:'#F8FAFC',
                 border:'1px solid var(--border)',borderRadius:8}}><i>{modal.a.worker_reason}</i></div>
            </div>}

          <div className="field"><label>
            Your note {(needsTime || (t==='absent' && modal.markUnpaidLeave)) && <span style={{color:'#DC2626'}}>*</span>}
          </label>
            <input className="input" value={modal.remark} autoFocus
              placeholder={modal.a.worker_reason ? 'Accepted, or why not' : 'What you found out'}
              onChange={e=>setModal({...modal,remark:e.target.value})} />
            <div className="small subtle" style={{marginTop:4}}>
              Kept alongside their reason, never replacing it.
            </div></div>

          <div style={{display:'flex',gap:8,marginTop:16}}>
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy?'Saving…':'Resolve'}</button>
            <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
          </div>
        </div>
      </div></div>;
    })()}
  </div>;
}

// ── Attendance: Locations ────────────────────────────────────────────────
// Geofence centres for the punch Edge Function. Radius is deliberately tight:
// a circle wide enough to cover a worker's home defeats the whole point, and
// overlapping branch circles let one punch satisfy two locations.
function AttendanceLocationsView({ locations, saveLocation, retireLocation, settings }){
  const [modal,setModal]=useState(null);   // {id?, name, lat, lng, radius_m, notes, is_active}
  const [busy,setBusy]=useState(false);
  const [geoErr,setGeoErr]=useState('');
  const defaultRadius = settings?.default_radius_m || 300;

  function openNew(){ setGeoErr(''); setModal({ name:'', lat:'', lng:'', radius_m:defaultRadius, notes:'', is_active:true }); }
  function openEdit(l){ setGeoErr(''); setModal({ id:l.id, name:l.name||'', lat:String(l.lat??''), lng:String(l.lng??''), radius_m:l.radius_m||defaultRadius, notes:l.notes||'', is_active:l.is_active!==false }); }

  // Standing at the pool with a phone is by far the easiest way to get the
  // coordinates right, so offer it rather than making someone copy from a map.
  function useMyLocation(){
    setGeoErr('');
    if(!navigator.geolocation){ setGeoErr('This device cannot provide a location.'); return; }
    navigator.geolocation.getCurrentPosition(
      p => setModal(m => ({ ...m, lat:p.coords.latitude.toFixed(6), lng:p.coords.longitude.toFixed(6) })),
      () => setGeoErr('Could not read your location. Check location permission for this site.'),
      { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
    );
  }

  async function submit(){
    const name=(modal.name||'').trim();
    const lat=Number(modal.lat), lng=Number(modal.lng), radius=Number(modal.radius_m);
    if(!name){ alert('Give the location a name.'); return; }
    if(!isFinite(lat)||lat<-90||lat>90){ alert('Latitude must be between -90 and 90.'); return; }
    if(!isFinite(lng)||lng<-180||lng>180){ alert('Longitude must be between -180 and 180.'); return; }
    if(!isFinite(radius)||radius<25||radius>2000){ alert('Radius must be between 25 and 2000 metres.'); return; }
    setBusy(true);
    await saveLocation({ name, lat, lng, radius_m:Math.round(radius), notes:(modal.notes||'').trim()||null, is_active:!!modal.is_active }, modal.id);
    setBusy(false); setModal(null);
  }

  return <div className="card">
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
      <div style={{fontWeight:800}}>Locations</div>
      <div className="small subtle">Check-in is accepted only inside a location's radius.</div>
      <button className="btn btn-primary small" style={{marginLeft:'auto'}} onClick={openNew}>+ Add location</button>
    </div>

    {!locations.length && <div className="small subtle" style={{padding:'18px 0'}}>No locations yet. Add the pools your instructors work at.</div>}

    {!!locations.length && <div className="table-wrap"><table className="table">
      <thead><tr><th>Name</th><th>Coordinates</th><th>Radius</th><th>Status</th><th></th></tr></thead>
      <tbody>{locations.map(l => <tr key={l.id}>
        <td style={{fontWeight:600}}>{l.name}</td>
        <td className="small subtle">{Number(l.lat).toFixed(5)}, {Number(l.lng).toFixed(5)}</td>
        <td>{l.radius_m} m</td>
        <td>{l.is_active===false
          ? <span className="small" style={{color:'var(--slate-tx,#475569)'}}>Retired</span>
          : <span className="small" style={{color:'#059669',fontWeight:700}}>Active</span>}</td>
        <td style={{textAlign:'right',whiteSpace:'nowrap'}}>
          <button className="btn btn-ghost small" onClick={()=>openEdit(l)}>Edit</button>
          {l.is_active!==false && <button className="btn btn-ghost small" style={{marginLeft:6}}
            onClick={()=>{ if(confirm(`Retire ${l.name}? Existing sessions keep their history.`)) retireLocation(l.id); }}>Retire</button>}
        </td>
      </tr>)}</tbody>
    </table></div>}

    {modal && <div className="modal-backdrop"><div className="modal-card">
      <div className="modal-head">
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>{modal.id?'Edit':'Add'} location</div>
        </div>
        <button className="btn btn-ghost small" onClick={()=>setModal(null)} aria-label="Close">✕</button>
      </div>
      <div className="modal-body">
        <div className="field"><label>Name</label>
          <input className="input" autoFocus value={modal.name} placeholder="Botani Pool"
            onChange={e=>setModal({...modal,name:e.target.value})} /></div>
        <div style={{display:'flex',gap:10}}>
          <div className="field" style={{flex:1}}><label>Latitude</label>
            <input className="input" inputMode="decimal" value={modal.lat} placeholder="4.597500"
              onChange={e=>setModal({...modal,lat:e.target.value})} /></div>
          <div className="field" style={{flex:1}}><label>Longitude</label>
            <input className="input" inputMode="decimal" value={modal.lng} placeholder="101.090100"
              onChange={e=>setModal({...modal,lng:e.target.value})} /></div>
        </div>
        <button className="btn btn-ghost small" onClick={useMyLocation}>📍 Use my current location</button>
        {geoErr && <div className="small" style={{color:'#DC2626',fontWeight:600,marginTop:6}}>{geoErr}</div>}
        <div className="field" style={{marginTop:10}}><label>Radius (metres)</label>
          <input className="input" inputMode="numeric" value={modal.radius_m}
            onChange={e=>setModal({...modal,radius_m:e.target.value})} />
          <div className="small subtle" style={{marginTop:4}}>300 m suits most pools. Too wide and a worker could check in from home.</div></div>
        <div className="field"><label>Notes</label>
          <input className="input" value={modal.notes} onChange={e=>setModal({...modal,notes:e.target.value})} /></div>
        <label className="small" style={{display:'flex',alignItems:'center',gap:8,marginTop:6}}>
          <input type="checkbox" checked={!!modal.is_active} onChange={e=>setModal({...modal,is_active:e.target.checked})} />
          Active
        </label>
        <div style={{display:'flex',gap:8,marginTop:16}}>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy?'Saving…':'Save'}</button>
          <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
        </div>
      </div>
    </div></div>}
  </div>;
}

// ── Attendance: Roster ───────────────────────────────────────────────────
// One week at a time, a row per worker. Sessions are dated rows (shifts);
// recurring patterns come in Phase 4, so everything here is an explicit date.
function AttendanceRosterView({ shifts, locations, categories, employees, weekStart, setWeekStart, saveShift, voidShift, copyPreviousWeek, addShiftSeries }){
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState(false);
  const [repeatWeeks,setRepeatWeeks]=useState(1);
  const DAY_NAMES=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const days = useMemo(()=>Array.from({length:7},(_,i)=>addDays(weekStart,i)), [weekStart]);
  const activeLocations = (locations||[]).filter(l=>l.is_active!==false);

  // Only show workers who are rostered this week, plus a picker to add anyone
  // else — a full staff list with mostly empty rows is harder to read.
  const byCrew = useMemo(()=>{
    const m={};
    (shifts||[]).forEach(s=>{ (m[s.crew_id]=m[s.crew_id]||[]).push(s); });
    return m;
  }, [shifts]);
  const rosteredIds = Object.keys(byCrew);
  const empById = useMemo(()=>{
    const m={}; (employees||[]).forEach(e=>{ m[e.id]=e; }); return m;
  }, [employees]);

  function openNew(crewId, date){
    setRepeatWeeks(1);
    setModal({ crew_id:crewId||'', shift_date:date||weekStart, start_time:'09:00', end_time:'11:00',
               location_id:activeLocations[0]?.id||'', category_id:(categories[0]||{}).id||'' });
  }
  function openEdit(s){
    setRepeatWeeks(1);
    setModal({ id:s.id, crew_id:s.crew_id, shift_date:s.shift_date,
               start_time:String(s.start_time).slice(0,5), end_time:String(s.end_time).slice(0,5),
               location_id:s.location_id, category_id:s.category_id });
  }

  async function submit(){
    if(!modal.crew_id){ alert('Choose a worker.'); return; }
    if(!modal.location_id){ alert('Choose a location.'); return; }
    if(!modal.category_id){ alert('Choose a category.'); return; }
    if(!(modal.end_time > modal.start_time)){ alert('The end time must be after the start time.'); return; }
    const base = {
      crew_id:modal.crew_id, shift_date:modal.shift_date,
      start_time:modal.start_time, end_time:modal.end_time,
      location_id:modal.location_id, category_id:modal.category_id
    };
    setBusy(true);
    if(!modal.id && repeatWeeks>1) await addShiftSeries(base, repeatWeeks);
    else await saveShift(base, modal.id);
    setBusy(false); setModal(null);
  }

  const locName = id => (locations.find(l=>l.id===id)||{}).name || '—';
  const catName = id => (categories.find(c=>c.id===id)||{}).name || '';

  // A session is planning until it starts, and history afterwards. Editing it
  // later would quietly rewrite what any alert against it was about, so the
  // roster only offers Edit beforehand — after that it can be voided, never
  // altered.
  function hasStarted(x){
    const now = new Date();
    const today = todayStr();
    if(x.shift_date < today) return true;
    if(x.shift_date > today) return false;
    const p = String(x.start_time).split(':');
    return (now.getHours()*60 + now.getMinutes()) >= ((+p[0])*60 + (+p[1]));
  }
  // What actually happened, short enough to sit on one line.
  function outcome(x){
    if(x.late_min>0 && x.early_min>0) return { t:`Late ${x.late_min}m, early ${x.early_min}m`, c:'#DC2626' };
    if(x.late_min>0)  return { t:`Late ${x.late_min}m`, c:'#DC2626' };
    if(x.early_min>0) return { t:`Early ${x.early_min}m`, c:'#DC2626' };
    switch(x.status){
      case 'absent':        return { t:'Absent',       c:'#DC2626' };
      case 'incomplete':    return { t:'No check-out', c:'#B45309' };
      case 'geofence_flag': return { t:'Flagged',      c:'#B45309' };
      case 'on_time':       return { t:'On time',      c:'#059669' };
      default:              return null;
    }
  }
  const EDGE = { absent:'#DC2626', late:'#DC2626', early_leave:'#DC2626',
                 incomplete:'#B45309', geofence_flag:'#B45309', on_time:'#059669' };

  return <div className="card">
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,flexWrap:'wrap'}}>
      <div style={{fontWeight:800}}>Roster</div>
      <div className="period-stepper" style={{margin:0}}>
        <button className="step-btn" onClick={()=>setWeekStart(addDays(weekStart,-7))} aria-label="Previous week">‹</button>
        <div className="period-label" style={{fontSize:12}}>{weekRangeLabel(weekStart)}</div>
        <button className="step-btn" onClick={()=>setWeekStart(addDays(weekStart,7))} aria-label="Next week">›</button>
      </div>
      <button className="btn btn-ghost small" onClick={()=>setWeekStart(weekStartStr(todayStr()))}>This week</button>
      <button className="btn btn-ghost small" onClick={copyPreviousWeek}
        title="Copy every session from the previous week into this one">⧉ Copy last week</button>
      <button className="btn btn-primary small" style={{marginLeft:'auto'}}
        disabled={!activeLocations.length}
        title={activeLocations.length?'':'Add a location first'}
        onClick={()=>openNew('', weekStart)}>+ Add session</button>
    </div>

    {!activeLocations.length && <div className="small" style={{color:'#B45309',fontWeight:600,marginBottom:10}}>
      Add at least one location before rostering — a session needs somewhere to check in.
    </div>}

    {!rosteredIds.length && <div className="small subtle" style={{padding:'18px 0'}}>
      No sessions rostered for this week.
    </div>}

    {!!rosteredIds.length && <div className="table-wrap"><table className="table">
      <thead><tr><th style={{minWidth:130,padding:'4px 6px'}}>Worker</th>
        {days.map((d,i)=><th key={d} style={{minWidth:138,padding:'4px 6px'}}>{DAY_NAMES[i]}<div className="small subtle" style={{fontWeight:400}}>{d.slice(8)}/{d.slice(5,7)}</div></th>)}
      </tr></thead>
      <tbody>{rosteredIds.map(cid => <tr key={cid}>
        <td style={{fontWeight:600,padding:'3px 6px'}}>{(empById[cid]||{}).full_name || 'Unknown worker'}</td>
        {days.map(d => {
          const cell=(byCrew[cid]||[]).filter(s=>s.shift_date===d)
            .sort((a,b)=>String(a.start_time).localeCompare(String(b.start_time)));
          // The cell itself is the add target, with a faint + pinned in the
          // corner so it costs no layout height. The old button sat on its own
          // line under the cards and added a row to every single cell.
          return <td key={d} style={{verticalAlign:'top',position:'relative',padding:'3px 4px',
                       cursor:activeLocations.length?'pointer':'default'}}
                     title={activeLocations.length?'Add a session':''}
                     onClick={()=>{ if(activeLocations.length) openNew(cid,d); }}>
            {cell.map(s => {
              // Two lines, never three: time and place up top, then category
              // and the actions. A week grid is read by scanning down a column,
              // so every extra line per session costs real legibility.
              const lk = { background:'none', border:0, padding:0, font:'inherit',
                           cursor:'pointer', textDecoration:'underline' };
              const out = outcome(s), started = hasStarted(s);
              const edge = out ? out.c : 'var(--border)';
              return <div key={s.id}
                           onClick={ev=>{ ev.stopPropagation(); if(!started) openEdit(s); }}
                           style={{border:'1px solid var(--border)',borderLeft:`3px solid ${edge}`,
                           borderRadius:6,padding:'2px 6px',marginBottom:3,
                           background:'var(--surface)',lineHeight:1.35}}>
                <div className="small" title={locName(s.location_id)}
                     style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                  <b>{String(s.start_time).slice(0,5)}–{String(s.end_time).slice(0,5)}</b>
                  <span className="subtle"> | </span>{locName(s.location_id)}
                </div>
                <div className="small subtle" style={{fontSize:10.5,whiteSpace:'nowrap'}}>
                  {out ? <><span style={{color:out.c,fontWeight:700}}>{out.t}</span> · </>
                       : (catName(s.category_id) && <><i>{catName(s.category_id)}</i> · </>)}
                  {!started && <>
                    <button style={{...lk,color:'var(--primary-on-soft,#0369A1)'}}
                      onClick={ev=>{ ev.stopPropagation(); openEdit(s); }}>Edit</button>
                    <span> · </span>
                  </>}
                  <button style={{...lk,color:'#DC2626'}}
                    title={started?'Remove this session. Any alert against it is kept.':'Remove this session'}
                    onClick={ev=>{ ev.stopPropagation();
                      if(confirm(started
                        ? 'Remove this session?\n\nIt disappears from the roster. Any alert, punch or reason recorded against it is kept in the log.'
                        : 'Remove this session?')) voidShift(s.id); }}>Remove</button>
                </div>
              </div>;
            })}
            {activeLocations.length>0 && <span aria-hidden="true"
              style={{position:'absolute',top:1,right:4,fontSize:12,lineHeight:1,
                      color:'#CBD5E1',fontWeight:800,pointerEvents:'none'}}>+</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table></div>}

    {modal && <div className="modal-backdrop"><div className="modal-card">
      <div className="modal-head">
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>{modal.id?'Edit':'Add'} session</div>
        </div>
        <button className="btn btn-ghost small" onClick={()=>setModal(null)} aria-label="Close">✕</button>
      </div>
      <div className="modal-body">
        <div className="field"><label>Worker</label>
          <select className="input" value={modal.crew_id} onChange={e=>setModal({...modal,crew_id:e.target.value})}>
            <option value="">Choose…</option>
            {(employees||[]).map(e=><option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select></div>
        <div className="field"><label>Date</label>
          <input className="input" type="date" value={modal.shift_date}
            onChange={e=>setModal({...modal,shift_date:e.target.value})} /></div>
        <div style={{display:'flex',gap:10}}>
          <div className="field" style={{flex:1}}><label>Start</label>
            <input className="input" type="time" value={modal.start_time}
              onChange={e=>setModal({...modal,start_time:e.target.value})} /></div>
          <div className="field" style={{flex:1}}><label>End</label>
            <input className="input" type="time" value={modal.end_time}
              onChange={e=>setModal({...modal,end_time:e.target.value})} /></div>
        </div>
        <div className="field"><label>Location</label>
          <select className="input" value={modal.location_id} onChange={e=>setModal({...modal,location_id:e.target.value})}>
            <option value="">Choose…</option>
            {activeLocations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        <div className="field"><label>Category</label>
          <select className="input" value={modal.category_id} onChange={e=>setModal({...modal,category_id:e.target.value})}>
            {(categories||[]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {!modal.id && <div className="field"><label>Repeat weekly</label>
          <select className="input" value={repeatWeeks} onChange={e=>setRepeatWeeks(Number(e.target.value))}>
            <option value={1}>Just this date</option>
            <option value={4}>4 weeks</option>
            <option value={8}>8 weeks</option>
            <option value={12}>12 weeks (a term)</option>
            <option value={26}>26 weeks (half a year)</option>
          </select>
          <div className="small subtle" style={{marginTop:4}}>
            Creates a separate session on each date, so any single week can be
            changed or voided later without affecting the rest.
          </div></div>}
        <div style={{display:'flex',gap:8,marginTop:16}}>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy?'Saving…':'Save'}</button>
          <button className="btn btn-ghost" onClick={()=>setModal(null)}>Cancel</button>
        </div>
      </div>
    </div></div>}
  </div>;
}

// ── Crew: attendance login ───────────────────────────────────────────────
// Creates and manages the Supabase Auth logins instructors use in the
// attendance app. Workers never see an email address — a staff ID maps to an
// unroutable internal one — so this form asks only for the ID and a password.
// All three actions go through the staff-auth Edge Function, which holds the
// service role; nothing privileged happens in the browser.
function CrewLoginModal({ employee, mode, provisionLogin, resetLogin, unlinkLogin, onClose }){
  const [staffId,setStaffId]=useState(employee.staff_id||employee.emp_no||'');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState('');
  const [done,setDone]=useState('');

  async function submit(){
    setErr('');
    if(mode!=='unlink'){
      if(mode==='provision' && !staffId.trim()){ setErr('Enter a staff ID.'); return; }
      if((password||'').length<8){ setErr('Password must be at least 8 characters.'); return; }
    }
    setBusy(true);
    try{
      if(mode==='provision'){
        await provisionLogin(employee.id, staffId.trim(), password);
        setDone(`Login created. Give ${employee.full_name} their staff ID and password.`);
      } else if(mode==='reset'){
        await resetLogin(employee.id, password);
        setDone('Password reset.');
      } else {
        await unlinkLogin(employee.id);
        setDone('Login removed. Attendance history is kept.');
      }
    } catch(ex){ setErr(ex.message||'Something went wrong.'); }
    finally{ setBusy(false); }
  }

  const title = mode==='provision' ? 'Create attendance login'
              : mode==='reset'     ? 'Reset password' : 'Remove login';

  return <div className="modal-backdrop"><div className="modal-card">
    <div className="modal-head">
      <div style={{minWidth:0,flex:1}}>
        <div style={{fontSize:13,fontWeight:800,lineHeight:1.1}}>{title}</div>
        <div className="small subtle" style={{fontSize:10.5,marginTop:1}}>{employee.full_name}</div>
      </div>
      <button className="btn btn-ghost small" onClick={onClose} aria-label="Close">✕</button>
    </div>
    <div className="modal-body">
      {done ? <>
        <div className="small" style={{color:'#059669',fontWeight:700,marginBottom:14}}>{done}</div>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </> : <>
        {mode==='unlink' && <div className="small" style={{marginBottom:14}}>
          This removes their sign-in only. The employee record and every past
          session, punch and alert stay exactly as they are.
        </div>}

        {mode==='provision' && <div className="field"><label>Staff ID</label>
          <input className="input" autoFocus value={staffId} placeholder="SS-012"
            onChange={ev=>setStaffId(ev.target.value)} />
          <div className="small subtle" style={{marginTop:4}}>
            This is what they type to sign in. Short and memorable works best.
          </div></div>}

        {mode!=='unlink' && <div className="field"><label>Password</label>
          <input className="input" type="text" value={password} placeholder="min 8 characters"
            autoFocus={mode==='reset'} onChange={ev=>setPassword(ev.target.value)} />
          <div className="small subtle" style={{marginTop:4}}>
            Shown as plain text so you can read it out. They cannot change it
            themselves — come back here to reset it.
          </div></div>}

        {err && <div className="small" style={{color:'#DC2626',fontWeight:600,marginTop:6}}>{err}</div>}
        <div style={{display:'flex',gap:8,marginTop:16}}>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Working…' : mode==='provision' ? 'Create login' : mode==='reset' ? 'Reset password' : 'Remove login'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </>}
    </div>
  </div></div>;
}

// ── Crew (Employees) ─────────────────────────────────────────────────────
function AdminCrewView({ employees, saveEmployee, deleteEmployee, onRefresh, loadFailed, importEmployees, canManageLogins, provisionLogin, resetLogin, unlinkLogin }){
  const [q,setQ]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [modal,setModal]=useState(null); // {kind:'edit', data?} | {kind:'importPreview', rows, fileName}
  const [importBusy,setImportBusy]=useState(false);
  const fileRef = React.useRef(null);

  // Canonical column set — export headers, template headers and import
  // parsing all share this list so export → edit → import round-trips.
  const CREW_FIELDS=['full_name','emp_no','ic_no','position','department','employment_type','start_date','status','phone','email','emergency_name','emergency_phone','bank_name','bank_account','notes'];

  function exportRows(){
    return (employees||[]).map(e=>{ const r={}; CREW_FIELDS.forEach(f=>{ r[f]=e[f]??''; }); return r; });
  }
  function stamp(){ return new Date().toISOString().slice(0,10); }
  function exportCSV(){
    const rows=exportRows();
    const esc=v=>{ const s=String(v??''); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
    const csv=[CREW_FIELDS.join(',')].concat(rows.map(r=>CREW_FIELDS.map(f=>esc(r[f])).join(','))).join('\n');
    const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`crew_export_${stamp()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  function exportXLSX(){
    if(typeof XLSX==='undefined'){ alert('Excel library not loaded — use CSV export.'); return; }
    const ws=XLSX.utils.json_to_sheet(exportRows(),{header:CREW_FIELDS});
    ws['!cols']=CREW_FIELDS.map(f=>({wch:Math.max(12,f.length+2)}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Crew');
    XLSX.writeFile(wb,`crew_export_${stamp()}.xlsx`);
  }
  function downloadTemplate(){
    if(typeof XLSX==='undefined'){ alert('Excel library not loaded.'); return; }
    const example={ full_name:'Aisyah Binti Rahman', emp_no:'SS-012', ic_no:'900101-08-1234', position:'Swim Instructor', department:'Coaching', employment_type:'Full-time', start_date:'2026-01-15', status:'Active', phone:'012-345 6789', email:'aisyah@example.com', emergency_name:'Rahman Bin Ali', emergency_phone:'013-222 1111', bank_name:'Maybank', bank_account:'1122 3344 5566', notes:'REACT Right + LSSM Bronze' };
    const ws=XLSX.utils.json_to_sheet([example],{header:CREW_FIELDS});
    ws['!cols']=CREW_FIELDS.map(f=>({wch:Math.max(14,f.length+2)}));
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Crew Import');
    XLSX.writeFile(wb,'crew_import_template.xlsx');
  }
  // Tolerant header mapping: "Full Name" / "full_name" / "FULLNAME" all resolve.
  function normHeader(h){ return String(h||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
  const HEADER_MAP={}; CREW_FIELDS.forEach(f=>{ HEADER_MAP[normHeader(f)]=f; });
  // A few friendly aliases
  Object.assign(HEADER_MAP,{ name:'full_name', employeename:'full_name', staffname:'full_name', empno:'emp_no', employeeno:'emp_no', staffno:'emp_no', ic:'ic_no', icnumber:'ic_no', nric:'ic_no', type:'employment_type', startdate:'start_date', datejoined:'start_date', tel:'phone', mobile:'phone', bank:'bank_name', account:'bank_account', accountno:'bank_account', bankaccountno:'bank_account', remark:'notes', remarks:'notes' });
  function normDate(v){
    if(v==null||v==='') return null;
    const s=String(v).trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); // d/m/yyyy (MY convention)
    if(m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    const d=new Date(s); return isNaN(d)?null:d.toISOString().slice(0,10);
  }
  function handleImportFile(file){
    if(!file) return;
    if(typeof XLSX==='undefined'){ alert('Excel library not loaded — cannot parse files.'); return; }
    const reader=new FileReader();
    reader.onload=e=>{
      try{
        const wb=XLSX.read(e.target.result,{type:'array'});
        const ws=wb.Sheets[wb.SheetNames[0]];
        const raw=XLSX.utils.sheet_to_json(ws,{raw:false,defval:''});
        if(!raw.length){ alert('No data rows found in the file.'); return; }
        const rows=raw.map(r=>{
          const out={};
          Object.keys(r).forEach(k=>{ const f=HEADER_MAP[normHeader(k)]; if(f) out[f]=r[k]; });
          if(out.start_date) out.start_date=normDate(out.start_date);
          return out;
        }).filter(r=>r.full_name&&String(r.full_name).trim());
        if(!rows.length){ alert('No rows with a full_name were found. Check the file matches the template headers.'); return; }
        setModal({kind:'importPreview', rows, fileName:file.name});
      }catch(err){ alert('Could not read the file: '+(err.message||err)); }
    };
    reader.readAsArrayBuffer(file);
  }
  async function confirmImport(){
    setImportBusy(true);
    try{
      const res=await importEmployees(modal.rows);
      setModal(null);
      alert(`Import complete — ${res.inserted} added, ${res.updated} updated${res.skipped?`, ${res.skipped} skipped`:''}.`);
    }catch(err){ alert(err.message||'Import failed'); }
    finally{ setImportBusy(false); }
  }

  const filtered = useMemo(()=>{
    const term=q.trim().toLowerCase();
    let rows=(employees||[]).slice();
    if(statusFilter!=='all') rows=rows.filter(e=>e.status===statusFilter);
    if(term) rows=rows.filter(e=> (e.full_name||'').toLowerCase().includes(term) || (e.emp_no||'').toLowerCase().includes(term) || (e.position||'').toLowerCase().includes(term) || (e.department||'').toLowerCase().includes(term) || (e.phone||'').toLowerCase().includes(term) || (e.email||'').toLowerCase().includes(term));
    return rows;
  }, [employees, q, statusFilter]);

  const counts = {
    active: (employees||[]).filter(e=>e.status==='Active').length,
    inactive: (employees||[]).filter(e=>e.status==='Inactive').length,
  };

  return <div style={{maxWidth:1120,margin:'18px auto 0'}}>
    <div className="card" style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:20,fontWeight:800}}>👥 Crew</div>
          <div className="small subtle">Employee records for the Star Swim team — positions, contact details, employment status, and payroll banking info in one place.</div>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <div className="small subtle"><strong>{counts.active}</strong> active · <strong>{counts.inactive}</strong> inactive</div>
          <button className="btn btn-ghost small" title="Download all crew records as CSV" onClick={exportCSV}>⬇ CSV</button>
          <button className="btn btn-ghost small" title="Download all crew records as Excel" onClick={exportXLSX}>⬇ Excel</button>
          <button className="btn btn-ghost small" title="Download the import template (Excel)" onClick={downloadTemplate}>📄 Template</button>
          <button className="btn btn-ghost small" title="Import crew from CSV or Excel" onClick={()=>fileRef.current&&fileRef.current.click()}>⬆ Import</button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{display:'none'}} onChange={e=>{ handleImportFile(e.target.files[0]); e.target.value=''; }}/>
          <button className="btn btn-primary small" onClick={()=>setModal({kind:'edit',data:{}})}>+ Add employee</button>
        </div>
      </div>
      {loadFailed && <div style={{marginTop:10,background:'#FEF3C7',border:'1px solid #FDE68A',borderRadius:10,padding:'8px 12px',fontSize:12.5,color:'#92400E'}}>
        ⚠ The crew list could not be loaded from the database just now — what you see below may be incomplete. This is a connection issue, <b>not</b> data loss.
        <button className="btn btn-ghost small" style={{marginLeft:8}} onClick={onRefresh}>↻ Retry</button>
      </div>}
      <div style={{marginTop:10,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        <input className="input" style={{flex:1,minWidth:200}} value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name, emp #, position…" />
        <button className={`btn small ${statusFilter==='all'?'btn-primary':'btn-ghost'}`} onClick={()=>setStatusFilter('all')}>All ({(employees||[]).length})</button>
        <button className={`btn small ${statusFilter==='Active'?'btn-primary':'btn-ghost'}`} onClick={()=>setStatusFilter('Active')}>Active ({counts.active})</button>
        <button className={`btn small ${statusFilter==='Inactive'?'btn-primary':'btn-ghost'}`} onClick={()=>setStatusFilter('Inactive')}>Inactive ({counts.inactive})</button>
      </div>
    </div>

    {filtered.length===0 ? <div className="empty" style={{padding:30}}>{(employees||[]).length===0 ? 'No employees yet. Click "+ Add employee" to add your first record.' : 'No employees match. Try a different search.'}</div>
      : <div className="card" style={{padding:0,overflow:'hidden'}}>
          <div className="table-wrap" style={{border:'none',borderRadius:0}}>
            <table>
              <thead><tr><th style={{width:36}}></th><th>Name</th><th style={{width:90}}>Emp #</th><th>Position</th><th>Department</th><th style={{width:110}}>Status</th>{canManageLogins && <th style={{width:190}}>Attendance login</th>}<th style={{textAlign:'right',width:100}}>Actions</th></tr></thead>
              <tbody>
                {filtered.map(e=><tr key={e.id}>
                  <td><div style={{width:30,height:30,borderRadius:'50%',background:'#0EA5E9',color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:11}}>{adminIni(e.full_name)}</div></td>
                  <td style={{fontWeight:700}}>{e.full_name}<div className="small subtle" style={{fontWeight:400}}>{[e.phone,e.email].filter(Boolean).join(' · ')||'—'}</div></td>
                  <td className="small">{e.emp_no||'—'}</td>
                  <td>{e.position||'—'}<div className="small subtle">{e.employment_type||''}</div></td>
                  <td>{e.department||'—'}</td>
                  <td>
                    <select className="select" style={{padding:'3px 6px',fontSize:12}} value={e.status||'Active'} onChange={ev=>saveEmployee({status:ev.target.value}, e.id)}>
                      <option>Active</option><option>Inactive</option>
                    </select>
                  </td>
                  {canManageLogins && <td>
                    {e.auth_user_id ? <>
                      <div className="small" style={{fontWeight:700}}>{e.staff_id||'—'}</div>
                      <button className="btn btn-ghost small" style={{padding:'1px 6px',fontSize:10}}
                        onClick={()=>setModal({kind:'login',data:e,mode:'reset'})}>Reset password</button>
                      <button className="btn btn-ghost small" style={{padding:'1px 6px',fontSize:10,marginLeft:4,color:'#DC2626'}}
                        onClick={()=>setModal({kind:'login',data:e,mode:'unlink'})}>Remove</button>
                    </> : <button className="btn btn-ghost small" style={{padding:'2px 8px',fontSize:11}}
                        onClick={()=>setModal({kind:'login',data:e,mode:'provision'})}>+ Create login</button>}
                  </td>}
                  <td style={{textAlign:'right'}}>
                    <button className="btn btn-ghost small" onClick={()=>setModal({kind:'edit',data:e})}>✎</button>
                    <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteEmployee(e.id)}>×</button>
                  </td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>}

    {modal?.kind==='edit' && <AdminEmployeeModal existing={modal.data} onSave={async d=>{ await saveEmployee(d, modal.data?.id); setModal(null); }} onClose={()=>setModal(null)} />}
    {modal?.kind==='login' && <CrewLoginModal
      employee={modal.data} mode={modal.mode}
      provisionLogin={provisionLogin} resetLogin={resetLogin} unlinkLogin={unlinkLogin}
      onClose={()=>setModal(null)} />}
    {modal?.kind==='importPreview' && (()=>{
      const byEmpNo={}, byName={};
      (employees||[]).forEach(e=>{ if(e.emp_no) byEmpNo[String(e.emp_no).trim().toLowerCase()]=true; if(e.full_name) byName[String(e.full_name).trim().toLowerCase()]=true; });
      const annotated=modal.rows.map(r=>{
        const isUpdate=(r.emp_no&&byEmpNo[String(r.emp_no).trim().toLowerCase()])||byName[String(r.full_name).trim().toLowerCase()];
        return {...r,_action:isUpdate?'update':'new'};
      });
      const nNew=annotated.filter(r=>r._action==='new').length;
      const nUpd=annotated.length-nNew;
      return <div className="modal-backdrop" onClick={()=>!importBusy&&setModal(null)}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:760}}>
        <div style={{fontWeight:800,fontSize:17,marginBottom:4}}>⬆ Import crew — {modal.fileName}</div>
        <div className="small subtle" style={{marginBottom:10}}>
          {annotated.length} row{annotated.length===1?'':'s'} parsed: <b style={{color:'#166534'}}>{nNew} new</b> · <b style={{color:'#1D4ED8'}}>{nUpd} update{nUpd===1?'':'s'}</b>.
          Rows match existing staff by <code>emp_no</code> first, then by name (case-insensitive). Matched rows overwrite the imported columns; blanks clear the field.
        </div>
        <div className="table-wrap" style={{maxHeight:340,overflow:'auto'}}>
          <table><thead><tr><th></th><th>Name</th><th>Emp #</th><th>Position</th><th>Dept</th><th>Status</th><th>Phone</th></tr></thead><tbody>
            {annotated.map((r,i)=><tr key={i}>
              <td><span className={`pm-pill ${r._action==='new'?'pm-green':'pm-blue'} pm-sm`}>{r._action}</span></td>
              <td style={{fontWeight:600}}>{r.full_name}</td>
              <td className="small subtle">{r.emp_no||'—'}</td>
              <td className="small subtle">{r.position||'—'}</td>
              <td className="small subtle">{r.department||'—'}</td>
              <td className="small subtle">{r.status||'Active'}</td>
              <td className="small subtle">{r.phone||'—'}</td>
            </tr>)}
          </tbody></table>
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:14}}>
          <button className="btn btn-ghost" disabled={importBusy} onClick={()=>setModal(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={importBusy} onClick={confirmImport}>{importBusy?'Importing…':`Import ${annotated.length} row${annotated.length===1?'':'s'}`}</button>
        </div>
      </div></div>;
    })()}
  </div>;
}

// ── Promotions module ─────────────────────────────────────────────────────
// Marketing banners for the public website. Each promo becomes a top bar +
// homepage hero card while its window (starts_at → ends_at) is live. Website
// reads from the promos table (public via anon key). Multiple concurrent
// promos are allowed; site picks the most-recently-updated active one.

function promoStatus(p){
  if(!p) return 'unknown';
  if(!p.is_active) return 'paused';
  const now = new Date();
  const s = p.starts_at ? new Date(p.starts_at) : null;
  const e = p.ends_at ? new Date(p.ends_at) : null;
  if(s && now < s) return 'scheduled';
  if(e && now > e) return 'expired';
  return 'live';
}

function fmtLocalDateTime(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// Convert an ISO timestamp to the value format needed for <input type="datetime-local">
function isoToLocalInput(iso){
  if(!iso) return '';
  const d = new Date(iso);
  const pad = n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(v){
  if(!v) return null;
  const d = new Date(v);
  return d.toISOString();
}

function AdminPromosView({ promos, savePromo, deletePromo, toggleActive, onRefresh }){
  const [editingId, setEditingId] = useState(null); // uuid or 'new'
  const [preview, setPreview] = useState(null);      // promo obj

  const sorted = useMemo(()=>{
    // Sort: live first (by ends_at asc), then scheduled (by starts_at asc),
    // then paused (by updated_at desc), then expired (by ends_at desc).
    const bucket = { live:0, scheduled:1, paused:2, expired:3, unknown:4 };
    const now = Date.now();
    return (promos||[]).slice().sort((a,b)=>{
      const sa=promoStatus(a), sb=promoStatus(b);
      if(sa!==sb) return bucket[sa]-bucket[sb];
      if(sa==='live')      return new Date(a.ends_at) - new Date(b.ends_at);
      if(sa==='scheduled') return new Date(a.starts_at) - new Date(b.starts_at);
      return new Date(b.updated_at||b.created_at||0) - new Date(a.updated_at||a.created_at||0);
    });
  }, [promos]);

  const liveCount = sorted.filter(p=>promoStatus(p)==='live').length;
  const scheduledCount = sorted.filter(p=>promoStatus(p)==='scheduled').length;

  return <div style={{maxWidth:1120,margin:'18px auto 0'}}>
    <div className="card" style={{marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:20,fontWeight:800}}>📢 Website Promotions</div>
          <div className="small subtle">Schedule marketing banners that appear on <strong>www.mystarswim.com</strong>. Each active promo shows as a top bar across every page plus a highlighted card on the homepage — both linking to a pre-filled WhatsApp message.</div>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          <div className="small subtle"><strong style={{color:'var(--green-tx)'}}>{liveCount}</strong> live · <strong style={{color:'#F59E0B'}}>{scheduledCount}</strong> scheduled</div>
          <button className="btn btn-primary small" onClick={()=>setEditingId('new')}>+ New Promo</button>
        </div>
      </div>
      {liveCount>1 && <div className="small" style={{marginTop:10,padding:'8px 12px',background:'#FEF3C7',border:'1px solid #FCD34D',borderRadius:8,color:'#78350F',fontWeight:600}}>⚠ Multiple promos are live at the same time. The website shows only the most-recently-updated one. Consider pausing older promos for a clean message.</div>}
    </div>

    {sorted.length===0
      ? <div className="empty" style={{padding:40,textAlign:'center'}}>
          <div style={{fontSize:32,marginBottom:8,opacity:.4}}>📢</div>
          <div style={{fontWeight:700,color:'var(--text-2)'}}>No promos yet</div>
          <div className="small subtle" style={{marginTop:4}}>Create your first promo — it will appear on the website during its scheduled window.</div>
        </div>
      : <div style={{display:'flex',flexDirection:'column',gap:10}}>
          {sorted.map(p=>{
            const status = promoStatus(p);
            const badge = {
              live:      { bg:'#DCFCE7', fg:'#15803D', label:'● LIVE' },
              scheduled: { bg:'#FEF3C7', fg:'#B45309', label:'⏱ SCHEDULED' },
              paused:    { bg:'#F1F5F9', fg:'#475569', label:'⏸ PAUSED' },
              expired:   { bg:'#F3F4F6', fg:'#6B7280', label:'⌛ EXPIRED' },
            }[status] || { bg:'#F3F4F6', fg:'#6B7280', label:'—' };
            return <div key={p.id} className="card" style={{padding:0,overflow:'hidden',borderLeft:`4px solid ${badge.fg}`}}>
              <div style={{padding:'14px 16px',display:'flex',alignItems:'flex-start',gap:14,flexWrap:'wrap'}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:4}}>
                    <span style={{background:badge.bg,color:badge.fg,fontSize:10.5,fontWeight:800,padding:'3px 10px',borderRadius:999,letterSpacing:'.3px'}}>{badge.label}</span>
                    <div style={{fontWeight:700,fontSize:15}}>{p.title || <span className="subtle">(untitled)</span>}</div>
                  </div>
                  {p.subtitle && <div className="small subtle" style={{marginBottom:4}}>{p.subtitle}</div>}
                  <div className="small subtle" style={{fontSize:12}}>
                    <strong>Runs</strong> {fmtLocalDateTime(p.starts_at)} → {fmtLocalDateTime(p.ends_at)}
                  </div>
                </div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  <button className="btn btn-ghost small" onClick={()=>setPreview(p)}>👁 Preview</button>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(p.id)}>✎ Edit</button>
                  <button className="btn btn-ghost small" onClick={()=>toggleActive(p.id, !p.is_active)}>{p.is_active?'⏸ Pause':'▶ Resume'}</button>
                  <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deletePromo(p.id)}>Delete</button>
                </div>
              </div>
            </div>;
          })}
        </div>}

    {editingId && <AdminPromoModal
      existing={editingId==='new' ? null : (promos||[]).find(p=>p.id===editingId)}
      onSave={async d => { await savePromo(d, editingId==='new'?null:editingId); setEditingId(null); }}
      onPreview={p=>setPreview(p)}
      onClose={()=>setEditingId(null)} />}
    {preview && <AdminPromoPreviewModal promo={preview} onClose={()=>setPreview(null)} />}
  </div>;
}

function AdminPromoModal({ existing, onSave, onPreview, onClose }){
  const now = new Date();
  const in7days = new Date(now.getTime() + 7*86400000);
  const [d,setD] = useState({
    slug: existing?.slug || '',
    title: existing?.title || '',
    subtitle: existing?.subtitle || '',
    body: existing?.body || '',
    bar_text: existing?.bar_text || '',
    cta_label: existing?.cta_label || 'WhatsApp Us',
    prefill_message: existing?.prefill_message || '',
    wa_number: existing?.wa_number || '60122539655',
    bar_dismissible: existing?.bar_dismissible ?? true,
    bar_color: existing?.bar_color || 'primary',
    is_active: existing?.is_active ?? true,
    starts_at: isoToLocalInput(existing?.starts_at || now.toISOString()),
    ends_at: isoToLocalInput(existing?.ends_at || in7days.toISOString()),
  });
  const [busy,setBusy] = useState(false);
  function up(k,v){ setD(prev=>({...prev,[k]:v})); }

  async function save(){
    if(!d.title.trim()){ alert('Title is required'); return; }
    if(!d.starts_at || !d.ends_at){ alert('Start and end times are required'); return; }
    const startIso = localInputToIso(d.starts_at);
    const endIso = localInputToIso(d.ends_at);
    if(new Date(endIso) <= new Date(startIso)){ alert('End time must be after start time'); return; }
    setBusy(true);
    await onSave({
      slug: d.slug.trim() || null,
      title: d.title.trim(),
      subtitle: d.subtitle.trim() || null,
      body: d.body.trim() || null,
      bar_text: d.bar_text.trim() || null,
      cta_label: d.cta_label.trim() || 'WhatsApp Us',
      prefill_message: d.prefill_message.trim() || null,
      wa_number: d.wa_number.replace(/[^0-9]/g,'') || '60122539655',
      bar_dismissible: !!d.bar_dismissible,
      bar_color: d.bar_color,
      is_active: !!d.is_active,
      starts_at: startIso,
      ends_at: endIso,
    });
    setBusy(false);
  }
  // Build a live preview payload from the current form state
  const previewPayload = {
    title: d.title,
    subtitle: d.subtitle,
    body: d.body,
    bar_text: d.bar_text,
    cta_label: d.cta_label,
    prefill_message: d.prefill_message,
    wa_number: d.wa_number,
    bar_dismissible: d.bar_dismissible,
    bar_color: d.bar_color,
  };

  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:720}}>
    <div className="modal-head">
      <div style={{fontWeight:800,fontSize:16}}>{existing?'Edit promo':'New promo'}</div>
      <button className="btn btn-ghost small" onClick={onClose}>×</button>
    </div>
    <div style={{padding:16,display:'flex',flexDirection:'column',gap:14,maxHeight:'70vh',overflowY:'auto'}}>
      <div style={{background:'var(--surface-2)',padding:'10px 12px',borderRadius:8,fontSize:12.5,color:'var(--text-2)'}}>
        Sections marked <strong>Bar</strong> appear in the site-wide top banner. Sections marked <strong>Hero card</strong> appear in the highlighted card on the homepage. WhatsApp fields drive both CTAs.
      </div>

      {/* — Bar — */}
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6,color:'var(--primary)'}}>Top Bar</div>
        <div className="field" style={{margin:0,marginBottom:8}}><label>Bar text</label><input className="input" value={d.bar_text} onChange={e=>up('bar_text',e.target.value)} placeholder="e.g. 🌟 Toddler Term Pass: 12 lessons for RM650. August enrolment open." /></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="field" style={{margin:0}}><label>Bar colour</label>
            <select className="select" value={d.bar_color} onChange={e=>up('bar_color',e.target.value)}>
              <option value="primary">Blue (primary)</option>
              <option value="coral">Coral</option>
              <option value="green">Green</option>
              <option value="navy">Navy</option>
            </select>
          </div>
          <div className="field" style={{margin:0}}><label>Dismissible?</label>
            <label style={{display:'flex',alignItems:'center',gap:8,padding:'8px 0'}}><input type="checkbox" checked={d.bar_dismissible} onChange={e=>up('bar_dismissible',e.target.checked)} /> <span className="small">Show ✕ close button</span></label>
          </div>
        </div>
      </div>

      {/* — Hero card — */}
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6,color:'var(--primary)'}}>Homepage Hero Card</div>
        <div className="field" style={{margin:0,marginBottom:8}}><label>Title *</label><input className="input" autoFocus value={d.title} onChange={e=>up('title',e.target.value)} placeholder="e.g. Toddler Term Pass — August Enrolment Open" /></div>
        <div className="field" style={{margin:0,marginBottom:8}}><label>Subtitle</label><input className="input" value={d.subtitle} onChange={e=>up('subtitle',e.target.value)} placeholder="e.g. 12 lessons · Ages 3–4 · Small groups · RM650" /></div>
        <div className="field" style={{margin:0}}><label>Body (multi-line supported)</label><textarea className="textarea" style={{minHeight:120}} value={d.body} onChange={e=>up('body',e.target.value)} placeholder="Full marketing copy. Use blank lines for paragraphs. Emojis welcome." /></div>
      </div>

      {/* — CTA — */}
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6,color:'var(--primary)'}}>WhatsApp CTA</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="field" style={{margin:0}}><label>Button label</label><input className="input" value={d.cta_label} onChange={e=>up('cta_label',e.target.value)} placeholder="WhatsApp Us" /></div>
          <div className="field" style={{margin:0}}><label>WhatsApp number (no +)</label><input className="input" value={d.wa_number} onChange={e=>up('wa_number',e.target.value)} placeholder="60122539655" /></div>
        </div>
        <div className="field" style={{margin:0,marginTop:8}}><label>Pre-filled message</label><textarea className="textarea" style={{minHeight:60}} value={d.prefill_message} onChange={e=>up('prefill_message',e.target.value)} placeholder="Hi! I'd like to know more about the Toddler Term Pass. My child is __ years old." /></div>
      </div>

      {/* — Schedule — */}
      <div>
        <div style={{fontWeight:800,fontSize:13,marginBottom:6,color:'var(--primary)'}}>Schedule</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
          <div className="field" style={{margin:0}}><label>Publish at *</label><input className="input" type="datetime-local" value={d.starts_at} onChange={e=>up('starts_at',e.target.value)} /></div>
          <div className="field" style={{margin:0}}><label>Expire at *</label><input className="input" type="datetime-local" value={d.ends_at} onChange={e=>up('ends_at',e.target.value)} /></div>
        </div>
        <label style={{display:'flex',alignItems:'center',gap:8,marginTop:10}}>
          <input type="checkbox" checked={d.is_active} onChange={e=>up('is_active',e.target.checked)} />
          <span className="small"><strong>Active</strong> — uncheck to keep the promo saved but hidden from the website, even during its scheduled window.</span>
        </label>
      </div>

      {/* Advanced */}
      <details>
        <summary style={{cursor:'pointer',fontWeight:700,fontSize:12.5,color:'var(--text-3)'}}>Advanced</summary>
        <div className="field" style={{margin:'8px 0 0'}}><label>Slug (internal name, optional)</label><input className="input" value={d.slug} onChange={e=>up('slug',e.target.value)} placeholder="e.g. toddler-term-pass-aug" /></div>
      </details>

      <div style={{display:'flex',justifyContent:'space-between',gap:8,paddingTop:8,borderTop:'1px solid var(--border)'}}>
        <button className="btn btn-ghost" onClick={()=>onPreview(previewPayload)}>👁 Preview</button>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy||!d.title.trim()} onClick={save}>{busy?'Saving…':'Save'}</button>
        </div>
      </div>
    </div>
  </div></div>;
}

function AdminPromoPreviewModal({ promo, onClose }){
  const colors = {
    primary: { bg:'#0EA5E9', fg:'#fff' },
    coral:   { bg:'#FB7185', fg:'#fff' },
    green:   { bg:'#22C55E', fg:'#fff' },
    navy:    { bg:'#0C4A6E', fg:'#fff' },
  };
  const barCol = colors[promo?.bar_color] || colors.primary;
  const wa = 'https://wa.me/' + (promo?.wa_number||'60122539655') + (promo?.prefill_message?('?text='+encodeURIComponent(promo.prefill_message)):'');
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:720}}>
    <div className="modal-head">
      <div style={{fontWeight:800,fontSize:16}}>👁 Preview</div>
      <button className="btn btn-ghost small" onClick={onClose}>×</button>
    </div>
    <div style={{padding:16,display:'flex',flexDirection:'column',gap:20,maxHeight:'70vh',overflowY:'auto',background:'#F8FAFC'}}>
      {/* Top bar preview */}
      <div>
        <div className="small subtle" style={{marginBottom:6,fontWeight:700}}>Top bar (every website page)</div>
        <div style={{background:barCol.bg,color:barCol.fg,padding:'10px 16px',display:'flex',alignItems:'center',gap:10,fontSize:13.5,fontWeight:600,borderRadius:8}}>
          <span style={{flex:1}}>{promo?.bar_text||'(no bar text — bar will be hidden)'}</span>
          <a href={wa} target="_blank" rel="noopener noreferrer" style={{background:'rgba(255,255,255,.25)',color:'#fff',textDecoration:'none',padding:'4px 12px',borderRadius:999,fontSize:12,fontWeight:800}}>{promo?.cta_label||'WhatsApp Us'} →</a>
          {promo?.bar_dismissible && <span style={{opacity:.7,cursor:'pointer',padding:'0 4px'}}>✕</span>}
        </div>
      </div>
      {/* Hero card preview */}
      <div>
        <div className="small subtle" style={{marginBottom:6,fontWeight:700}}>Hero card (homepage)</div>
        <div style={{background:'#fff',border:`2px solid ${barCol.bg}`,borderRadius:16,padding:'24px 28px',boxShadow:'0 6px 20px rgba(14,165,233,.14)'}}>
          <div style={{display:'inline-block',background:barCol.bg,color:barCol.fg,fontSize:11,fontWeight:800,padding:'4px 12px',borderRadius:999,letterSpacing:'.4px',marginBottom:12}}>LIMITED TIME</div>
          <div style={{fontSize:22,fontWeight:900,color:'#0C4A6E',marginBottom:6,lineHeight:1.15}}>{promo?.title||'(title)'}</div>
          {promo?.subtitle && <div style={{color:'#475569',fontSize:15,fontWeight:600,marginBottom:12}}>{promo.subtitle}</div>}
          {promo?.body && <div style={{color:'#475569',fontSize:14,whiteSpace:'pre-wrap',marginBottom:16,lineHeight:1.6}}>{promo.body}</div>}
          <a href={wa} target="_blank" rel="noopener noreferrer" style={{display:'inline-block',background:'#22C55E',color:'#fff',textDecoration:'none',padding:'12px 26px',borderRadius:12,fontWeight:700,fontSize:15}}>💬 {promo?.cta_label||'WhatsApp Us'}</a>
        </div>
      </div>
      <div className="small subtle" style={{fontStyle:'italic',textAlign:'center'}}>This is exactly how the promo will render on the website. Timing depends on the schedule you set.</div>
    </div>
  </div></div>;
}
function AdminEmployeeModal({ existing, onSave, onClose }){
  const [d,setD]=useState({
    full_name: existing?.full_name||'',
    emp_no: existing?.emp_no||'',
    ic_no: existing?.ic_no||'',
    position: existing?.position||'',
    department: existing?.department||'',
    employment_type: existing?.employment_type||'Full-time',
    start_date: existing?.start_date||'',
    status: existing?.status||'Active',
    phone: existing?.phone||'',
    email: existing?.email||'',
    emergency_name: existing?.emergency_name||'',
    emergency_phone: existing?.emergency_phone||'',
    bank_name: existing?.bank_name||'',
    bank_account: existing?.bank_account||'',
    notes: existing?.notes||''
  });
  const [busy,setBusy]=useState(false);
  async function save(){
    if(!d.full_name.trim()){ alert('Name is required'); return; }
    setBusy(true);
    const payload={};
    Object.keys(d).forEach(k=>{
      const v=typeof d[k]==='string'?d[k].trim():d[k];
      payload[k] = (v===''?null:v);
    });
    payload.full_name = d.full_name.trim();
    await onSave(payload);
    setBusy(false);
  }
  function up(k,v){ setD({...d,[k]:v}); }
  return <div className="modal-backdrop" onClick={onClose}><div className="modal-card" onClick={e=>e.stopPropagation()} style={{maxWidth:640}}>
    <div className="modal-head"><div style={{fontWeight:800,fontSize:16}}>{existing?.id?'Edit employee':'New employee'}</div><button className="btn btn-ghost small" onClick={onClose}>×</button></div>
    <div style={{padding:14,display:'flex',flexDirection:'column',gap:12,maxHeight:'70vh',overflowY:'auto'}}>
      <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:8}}>
        <div className="field" style={{margin:0}}><label>Full name *</label><input className="input" autoFocus value={d.full_name} onChange={e=>up('full_name',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Employee #</label><input className="input" value={d.emp_no} onChange={e=>up('emp_no',e.target.value)} /></div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div className="field" style={{margin:0}}><label>IC number</label><input className="input" value={d.ic_no} onChange={e=>up('ic_no',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Start date</label><input className="input" type="date" value={d.start_date} onChange={e=>up('start_date',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Position</label><input className="input" value={d.position} onChange={e=>up('position',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Department</label><input className="input" value={d.department} onChange={e=>up('department',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Employment type</label><select className="select" value={d.employment_type} onChange={e=>up('employment_type',e.target.value)}><option>Full-time</option><option>Part-time</option><option>Contract</option><option>Intern</option><option>Other</option></select></div>
        <div className="field" style={{margin:0}}><label>Status</label><select className="select" value={d.status} onChange={e=>up('status',e.target.value)}><option>Active</option><option>Inactive</option></select></div>
        <div className="field" style={{margin:0}}><label>Phone</label><input className="input" value={d.phone} onChange={e=>up('phone',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Email</label><input className="input" value={d.email} onChange={e=>up('email',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Emergency contact name</label><input className="input" value={d.emergency_name} onChange={e=>up('emergency_name',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Emergency contact phone</label><input className="input" value={d.emergency_phone} onChange={e=>up('emergency_phone',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Bank name</label><input className="input" value={d.bank_name} onChange={e=>up('bank_name',e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Bank account</label><input className="input" value={d.bank_account} onChange={e=>up('bank_account',e.target.value)} /></div>
      </div>
      <div className="field" style={{margin:0}}><label>Notes</label><textarea className="textarea" value={d.notes} onChange={e=>up('notes',e.target.value)} /></div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy||!d.full_name.trim()} onClick={save}>{busy?'Saving…':'Save'}</button>
      </div>
    </div>
  </div></div>;
}
function MessagesView({ messages, onMarkRead, onMarkAllRead, onDelete, onRefresh }){
  const [filter,setFilter]=useState('all'); // all | new
  const [openId,setOpenId]=useState(null);
  const list=(messages||[]).filter(m=>filter==='new'?m.status==='new':true);
  const newCount=(messages||[]).filter(m=>m.status==='new').length;
  function fmt(ts){ if(!ts) return '—'; try{ return new Date(ts).toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(_){ return ts; } }
  function openMsg(m){
    setOpenId(openId===m.id?null:m.id);
    if(m.status==='new') onMarkRead(m.id);
  }
  return <div style={{maxWidth:860,margin:'18px auto 0'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:14}}>
      <div>
        <div style={{fontSize:20,fontWeight:800}}>✉️ Messages</div>
        <div className="small subtle">Enquiries from the website contact form. Opening a message marks it read.</div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <button className={`btn small ${filter==='all'?'btn-primary':'btn-ghost'}`} onClick={()=>setFilter('all')}>All ({(messages||[]).length})</button>
        <button className={`btn small ${filter==='new'?'btn-primary':'btn-ghost'}`} onClick={()=>setFilter('new')}>New ({newCount})</button>
        {newCount>0 && <button className="btn btn-ghost small" onClick={onMarkAllRead}>Mark all read</button>}
        <button className="btn btn-ghost small" onClick={onRefresh} title="Refresh">⟳</button>
      </div>
    </div>
    {list.length===0
      ? <div className="empty" style={{padding:30}}>{filter==='new'?'No new messages.':'No messages yet — enquiries from the website contact form will appear here.'}</div>
      : <div style={{display:'flex',flexDirection:'column',gap:8}}>
          {list.map(m=><div key={m.id} className="card" style={{padding:0,overflow:'hidden',borderLeft:m.status==='new'?'4px solid var(--primary)':'4px solid transparent'}}>
            <div onClick={()=>openMsg(m)} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',cursor:'pointer',flexWrap:'wrap'}}>
              {m.status==='new'&&<span style={{background:'var(--primary)',color:'#fff',fontSize:10,fontWeight:800,borderRadius:999,padding:'2px 8px'}}>NEW</span>}
              <span style={{fontWeight:700}}>{m.name||'—'}</span>
              {m.topic&&<span className="lt-branch-tag" style={{fontSize:10.5}}>{m.topic}</span>}
              <span className="small subtle" style={{flex:1,minWidth:120,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{m.message}</span>
              <span className="small subtle" style={{whiteSpace:'nowrap'}}>{fmt(m.created_at)}</span>
            </div>
            {openId===m.id && <div style={{padding:'0 14px 14px',borderTop:'1px solid var(--border)'}}>
              <div style={{display:'flex',gap:16,flexWrap:'wrap',margin:'10px 0',fontSize:13}}>
                {m.phone&&<span>📞 <a href={`tel:${m.phone}`} style={{color:'var(--primary)',fontWeight:600}}>{m.phone}</a></span>}
                {m.email&&<span>✉️ <a href={`mailto:${m.email}`} style={{color:'var(--primary)',fontWeight:600}}>{m.email}</a></span>}
                {m.phone&&<a href={`https://wa.me/${String(m.phone).replace(/[^0-9]/g,'')}`} target="_blank" rel="noopener noreferrer" style={{color:'#16A34A',fontWeight:700}}>💬 WhatsApp them</a>}
              </div>
              <div style={{background:'var(--surface-2)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',fontSize:14,whiteSpace:'pre-wrap'}}>{m.message}</div>
              <div style={{display:'flex',justifyContent:'flex-end',marginTop:8}}>
                <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>onDelete(m.id)}>Delete</button>
              </div>
            </div>}
          </div>)}
        </div>}
  </div>;
}

// ── Settings › Users (sysadmin only): create logins, set passwords, roles ───
function UsersAdminView({ users, currentUser, createUser, setPassword, patchUser, deleteUser }){
  const [username,setUsername]=useState('');
  const [displayName,setDisplayName]=useState('');
  const [password,setPasswordVal]=useState('');
  const [role,setRole]=useState('schedule_admin');
  const [busy,setBusy]=useState(false);
  const [pwFor,setPwFor]=useState(null);
  const [pwVal,setPwVal]=useState('');
  function fmt(ts){ if(!ts) return '—'; try{ return new Date(ts).toLocaleString(undefined,{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }catch(_){ return ts; } }
  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>👥 Users & Logins</div>
      <div className="small subtle" style={{marginBottom:14}}>Create logins and manage passwords. <strong>Sysadmin</strong> — full access to both the scheduler and the Admin & Procurement system. <strong>Schedule Admin</strong> — this scheduler only (no Settings or Reports). <strong>Admin (Procurement)</strong> — signs in here but is redirected to the Admin & Procurement system.</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 130px auto',gap:10,alignItems:'end'}}>
        <div className="field" style={{margin:0}}><label>Username</label><input className="input" autoCapitalize="none" value={username} onChange={e=>setUsername(e.target.value)} placeholder="e.g. jsmith" /></div>
        <div className="field" style={{margin:0}}><label>Display name</label><input className="input" value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. John Smith" /></div>
        <div className="field" style={{margin:0}}><label>Password</label><input className="input" type="text" value={password} onChange={e=>setPasswordVal(e.target.value)} placeholder="min 8 chars" /></div>
        <div className="field" style={{margin:0}}><label>Role</label><select className="select" value={role} onChange={e=>setRole(e.target.value)}><option value="schedule_admin">Schedule Admin</option><option value="admin">Admin (Procurement)</option><option value="sysadmin">Sysadmin</option></select></div>
        <button className="btn btn-primary" style={{height:38}} disabled={busy||!username.trim()||password.length<8} onClick={async()=>{ setBusy(true); try{ await createUser({username,displayName,password,role}); setUsername('');setDisplayName('');setPasswordVal(''); } finally{ setBusy(false);} }}>+ Create User</button>
      </div>
      {password&&password.length<8&&<div className="small" style={{color:'#DC2626',marginTop:6}}>Password must be at least 8 characters.</div>}
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0}}>
        <table>
          <thead><tr><th>Username</th><th>Name</th><th style={{width:170}}>Role</th><th style={{width:90}}>Status</th><th style={{width:150}}>Last login</th><th style={{width:250,textAlign:'right'}}>Actions</th></tr></thead>
          <tbody>
            {(users||[]).map(u=>{ const me=u.username===currentUser?.username; return <React.Fragment key={u.id}>
              <tr>
                <td style={{fontWeight:700}}>{u.username}{me&&<span className="small subtle"> (you)</span>}</td>
                <td>{u.display_name||'—'}</td>
                <td>
                  <select className="select" style={{padding:'3px 6px',fontSize:12,minWidth:150}} value={u.role||'schedule_admin'} disabled={me} onChange={e=>patchUser(u.id,{role:e.target.value})}>
                    <option value="schedule_admin">Schedule Admin</option><option value="admin">Admin (Procurement)</option><option value="sysadmin">Sysadmin</option>
                  </select>
                </td>
                <td>{u.is_active!==false?<span style={{color:'var(--green-tx)',fontWeight:700,fontSize:12}}>Active</span>:<span style={{color:'#DC2626',fontWeight:700,fontSize:12}}>Disabled</span>}</td>
                <td className="small subtle">{fmt(u.last_login_at)}</td>
                <td style={{textAlign:'right'}}>
                  <button className="btn btn-ghost small" onClick={()=>{ setPwFor(pwFor===u.id?null:u.id); setPwVal(''); }}>🔑 Password</button>
                  {!me&&<button className="btn btn-ghost small" onClick={()=>patchUser(u.id,{is_active:!(u.is_active!==false)})}>{u.is_active!==false?'Disable':'Enable'}</button>}
                  {!me&&<button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteUser(u.id)}>Delete</button>}
                </td>
              </tr>
              {pwFor===u.id&&<tr><td colSpan={6} style={{background:'var(--surface-2)'}}>
                <div style={{display:'flex',gap:8,alignItems:'center',padding:'4px 0'}}>
                  <span className="small" style={{fontWeight:700}}>New password for {u.username}:</span>
                  <input className="input" type="text" style={{maxWidth:220}} value={pwVal} onChange={e=>setPwVal(e.target.value)} placeholder="min 8 chars" />
                  <button className="btn btn-primary small" disabled={pwVal.length<8} onClick={async()=>{ await setPassword(u.id,pwVal); setPwFor(null); setPwVal(''); }}>Save</button>
                  <button className="btn btn-ghost small" onClick={()=>setPwFor(null)}>Cancel</button>
                </div>
              </td></tr>}
            </React.Fragment>; })}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

function ImageLightbox({ src, onClose }){
  React.useEffect(()=>{ function onKey(e){ if(e.key==='Escape') onClose(); } window.addEventListener('keydown',onKey); return ()=>window.removeEventListener('keydown',onKey); },[onClose]);
  return <div onClick={onClose} style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,.82)',display:'flex',alignItems:'center',justifyContent:'center',padding:24,cursor:'zoom-out'}}>
    <img src={src} alt="" onClick={e=>e.stopPropagation()} style={{maxWidth:'92vw',maxHeight:'90vh',objectFit:'contain',borderRadius:8,boxShadow:'0 10px 40px rgba(0,0,0,.5)',cursor:'default'}} />
    <button onClick={onClose} aria-label="Close" style={{position:'absolute',top:16,right:20,background:'rgba(255,255,255,.92)',border:'none',borderRadius:'50%',width:38,height:38,fontSize:18,cursor:'pointer',fontWeight:700}}>✕</button>
  </div>;
}

function ProductPickerModal({ products, onPick, onClose }){
  const [q,setQ]=useState('');
  const term=q.trim().toLowerCase();
  const list=(products||[]).filter(p=>p.is_active!==false).filter(p=>!term || (p.name||'').toLowerCase().includes(term) || (p.sku||'').toLowerCase().includes(term) || (p.description||'').toLowerCase().includes(term));
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal-card" onClick={e=>e.stopPropagation()} style={{width:'min(780px,96vw)',maxHeight:'88vh',display:'flex',flexDirection:'column'}}>
      <div style={{padding:'14px 18px',borderBottom:'1px solid var(--border)',display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
        <div style={{fontWeight:800,fontSize:16}}>Choose a product</div>
        <button className="btn btn-ghost small" onClick={onClose}>✕</button>
      </div>
      <div style={{padding:'10px 18px'}}><input className="input" autoFocus value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name, SKU or description…" /></div>
      <div style={{padding:'0 18px 18px',overflowY:'auto',display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:12}}>
        {list.length===0 && <div className="empty" style={{gridColumn:'1/-1',padding:24}}>No products found.</div>}
        {list.map(p=><button key={p.id} onClick={()=>onPick(p)} style={{textAlign:'left',padding:0,border:'1px solid var(--border)',borderRadius:10,overflow:'hidden',background:'var(--surface)',cursor:'pointer',display:'flex',flexDirection:'column'}}>
          <div style={{height:118,background:'var(--surface-2)',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>{p.image_url?<img src={p.image_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} />:<span className="small subtle">No photo</span>}</div>
          <div style={{padding:'8px 10px',display:'flex',flexDirection:'column',gap:2}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:6,alignItems:'baseline'}}><span style={{fontWeight:700,fontSize:13}}>{p.name}</span><span style={{fontWeight:800,whiteSpace:'nowrap'}}>{p.price!=null?`RM${Number(p.price).toFixed(2)}`:'—'}</span></div>
            {p.sku&&<div className="small subtle" style={{fontFamily:'monospace',fontSize:10}}>{p.sku}</div>}
            {p.description&&<div className="small subtle" style={{fontSize:11,lineHeight:1.35,maxHeight:44,overflow:'hidden'}}>{p.description}</div>}
          </div>
        </button>)}
      </div>
    </div>
  </div>;
}

// Read an image file and return a small compressed JPEG data URL (keeps DB rows
// light — product thumbnails end up ~10–40 KB).
function fileToThumbnail(file, maxDim=340, quality=0.72){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        let w=img.width, h=img.height;
        if(w>h){ if(w>maxDim){ h=Math.round(h*maxDim/w); w=maxDim; } }
        else   { if(h>maxDim){ w=Math.round(w*maxDim/h); h=maxDim; } }
        const c=document.createElement('canvas'); c.width=w; c.height=h;
        c.getContext('2d').drawImage(img,0,0,w,h);
        try{ resolve(c.toDataURL('image/jpeg',quality)); }catch(err){ reject(err); }
      };
      img.onerror=reject; img.src=reader.result;
    };
    reader.onerror=reject; reader.readAsDataURL(file);
  });
}

function SalesView({ accounts, products, branches, currentBranchId, invoices, pmts, onRefund, onCreateSale, onViewInvoices }){
  const [tab,setTab]=useState('sale'); // 'sale' | 'returns'
  return <div style={{maxWidth:1120,margin:'18px auto 0'}}>
    <div style={{marginBottom:12}}>
      <div style={{fontSize:20,fontWeight:800}}>🛒 Shop</div>
      <div className="small subtle">Sell goods as a quick cash sale or billed to an account, and process product returns. Works across every branch.</div>
    </div>
    <div style={{marginBottom:14,display:'flex',gap:8}}>
      <button className={`btn small ${tab==='sale'?'btn-primary':'btn-ghost'}`} onClick={()=>setTab('sale')}>🛍 New Sale</button>
      <button className={`btn small ${tab==='returns'?'btn-primary':'btn-ghost'}`} onClick={()=>setTab('returns')}>↩︎ Returns / Refunds</button>
    </div>
    {tab==='sale'
      ? <ShopSale accounts={accounts} products={products} branches={branches} currentBranchId={currentBranchId} onCreateSale={onCreateSale} onViewInvoices={onViewInvoices} />
      : <ShopReturns invoices={invoices} pmts={pmts} onRefund={onRefund} onViewInvoices={onViewInvoices} />}
  </div>;
}

function ShopSale({ accounts, products, branches, currentBranchId, onCreateSale, onViewInvoices }){
  const [mode,setMode]=useState('cash');
  const [cashName,setCashName]=useState('');
  const [cashPhone,setCashPhone]=useState('');
  const [accountKey,setAccountKey]=useState('');
  const [acctQuery,setAcctQuery]=useState('');
  const acct=(accounts||[]).find(a=>a.key===accountKey)||null;
  const activeBranches=(branches||[]).filter(b=>b.is_active!==false);
  const [branchId,setBranchId]=useState(currentBranchId&&currentBranchId!=='all'?currentBranchId:'');
  const [cart,setCart]=useState([]);
  const [paidNow,setPaidNow]=useState(true);
  const [method,setMethod]=useState('cash');
  const [date,setDate]=useState(todayStr());
  const [notes,setNotes]=useState('');
  const [busy,setBusy]=useState(false);
  const [showPreview,setShowPreview]=useState(false);
  const [result,setResult]=useState(null);
  const [page,setPage]=useState(0);
  const [catQuery,setCatQuery]=useState('');
  const [lightboxSrc,setLightboxSrc]=useState(null);
  const [showCustom,setShowCustom]=useState(false);
  const [cDesc,setCDesc]=useState(''); const [cPrice,setCPrice]=useState(''); const [cQty,setCQty]=useState(1);

  const activeProducts=(products||[]).filter(p=>p.is_active!==false);
  const term=catQuery.trim().toLowerCase();
  const catFiltered = term ? activeProducts.filter(p=>(p.name||'').toLowerCase().includes(term)||(p.sku||'').toLowerCase().includes(term)||(p.description||'').toLowerCase().includes(term)) : activeProducts;
  const PAGE=25;
  const pageCount=Math.max(1,Math.ceil(catFiltered.length/PAGE));
  const curPage=Math.min(page,pageCount-1);
  const pageItems=catFiltered.slice(curPage*PAGE, curPage*PAGE+PAGE);

  const total=cart.reduce((s,c)=>s+(Math.max(1,Number(c.quantity)||1)*(Number(c.unitPrice)||0)),0);
  const buyerName = mode==='cash' ? (cashName.trim()||'Cash Sale') : (acct?.name||'');
  const buyerPhone = mode==='account' ? (acct?.phone||'') : cashPhone.trim();
  const canGenerate = cart.length>0 && (mode==='cash' || !!acct);
  const branchName=(activeBranches.find(b=>b.id===branchId)||{}).name;
  const filteredAccounts = acctQuery.trim() ? (accounts||[]).filter(a=>(a.name||'').toLowerCase().includes(acctQuery.trim().toLowerCase())) : (accounts||[]);

  function addFromCatalogue(p){
    const ex=cart.find(c=>c.productId===p.id);
    if(ex){ setCart(cart.map(c=>c.id===ex.id?{...c,quantity:c.quantity+1}:c)); }
    else{ setCart([...cart,{id:Math.random().toString(36).slice(2),productId:p.id,sku:p.sku||'',image:p.image_url||'',description:p.name,quantity:1,unitPrice:Number(p.price)||0}]); }
  }
  function addCustom(){ const d=cDesc.trim(); const u=Number(cPrice)||0; const q=Math.max(1,Number(cQty)||1); if(!d||!(u>0))return; setCart([...cart,{id:Math.random().toString(36).slice(2),productId:null,sku:'',image:'',description:d,quantity:q,unitPrice:u}]); setCDesc('');setCPrice('');setCQty(1);setShowCustom(false); }
  function setQty(id,q){ setCart(cart.map(c=>c.id===id?{...c,quantity:Math.max(1,q)}:c)); }
  function removeFromCart(id){ setCart(cart.filter(c=>c.id!==id)); }

  async function confirmSale(){
    setBusy(true);
    try{
      const lines=cart.map(c=>{ const q=Math.max(1,Number(c.quantity)||1); return { description: c.sku ? `${c.description} · SKU: ${c.sku}` : c.description, amount:q*(Number(c.unitPrice)||0), quantity:q, lineType:'product' }; });
      const res=await onCreateSale({ buyerName, buyerEmail: mode==='account'?(acct?.email||null):null, buyerPhone: buyerPhone||null, branchId: branchId||null, lines, paid:paidNow, paymentMethod:method, paymentDate:date, notes:notes.trim()||null });
      setResult(res); setShowPreview(false);
      if(res && res.payment){ setTimeout(()=>printReceipt(res.payment, res.invoice), 250); }
    }catch(e){ alert(e?.message||'Failed to create sale'); }
    finally{ setBusy(false); }
  }
  function reset(){ setResult(null); setShowPreview(false); setCart([]); setCashName(''); setCashPhone(''); setAccountKey(''); setAcctQuery(''); setNotes(''); setMode('cash'); setPage(0); setCatQuery(''); }

  if(result){
    const inv=result.invoice||{}; const pay=result.payment;
    return <div className="card" style={{textAlign:'center',borderColor:'#86EFAC',background:'#F0FDF4',maxWidth:640,margin:'0 auto'}}>
      <div style={{fontSize:34,marginBottom:6}}>✅</div>
      <div style={{fontSize:20,fontWeight:800,marginBottom:4}}>Sale complete</div>
      <div className="small subtle" style={{marginBottom:12}}>Billed to <strong>{inv.account_name||buyerName}</strong></div>
      <div style={{display:'inline-flex',flexDirection:'column',gap:4,textAlign:'left',background:'#fff',border:'1px solid var(--border)',borderRadius:10,padding:'12px 16px',marginBottom:14}}>
        <div><span className="small subtle">Invoice</span> <strong style={{fontFamily:'monospace'}}>{inv.invoice_number||'—'}</strong></div>
        <div><span className="small subtle">Total</span> <strong>RM{Number(inv.total_amount||total).toFixed(2)}</strong></div>
        {pay ? <div><span className="small subtle">Receipt</span> <strong style={{fontFamily:'monospace'}}>{pay.receipt_number||'—'}</strong> · <span style={{color:'var(--green-tx)',fontWeight:700}}>Paid</span></div>
             : <div><span className="small subtle">Status</span> <strong style={{color:'#F59E0B'}}>Unpaid invoice</strong></div>}
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
        {pay && <button className="btn btn-primary" onClick={()=>printReceipt(pay, inv)}>🖨 Print receipt</button>}
        <button className="btn btn-ghost" onClick={()=>onViewInvoices&&onViewInvoices()}>🧾 View in Invoices</button>
        <button className="btn btn-ghost" onClick={reset}>+ New sale</button>
      </div>
    </div>;
  }

  if(showPreview){
    return <div style={{maxWidth:640,margin:'0 auto'}}>
      <div className="card" style={{padding:'22px 26px'}}>
        <div style={{textAlign:'center',borderBottom:'2px solid var(--border)',paddingBottom:12,marginBottom:14}}>
          <div style={{fontSize:18,fontWeight:800}}>Star Swim Sdn Bhd</div>
          <div className="small subtle">Product Sale — Preview{branchName?` · ${branchName}`:''}</div>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:13,marginBottom:12,flexWrap:'wrap',gap:8}}>
          <div><div className="small subtle">Bill to</div><div style={{fontWeight:700}}>{buyerName}</div>{buyerPhone&&<div className="small subtle">{buyerPhone}</div>}{mode==='account'&&acct?.email&&<div className="small subtle">{acct.email}</div>}</div>
          <div style={{textAlign:'right'}}><div className="small subtle">Date</div><div style={{fontWeight:600}}>{date}</div><div className="small subtle" style={{marginTop:4}}>{paidNow?`Payment: ${methodLabel(method)}`:'Unpaid invoice'}</div></div>
        </div>
        <table style={{width:'100%',fontSize:13,borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:'1px solid var(--border)',textAlign:'left'}}>
            <th style={{padding:'6px 4px'}}>Item</th><th style={{padding:'6px 4px'}}>SKU</th><th style={{padding:'6px 4px',textAlign:'center'}}>Qty</th><th style={{padding:'6px 4px',textAlign:'right'}}>Unit</th><th style={{padding:'6px 4px',textAlign:'right'}}>Amount</th>
          </tr></thead>
          <tbody>
            {cart.map(c=>{ const q=Math.max(1,Number(c.quantity)||1); const u=Number(c.unitPrice)||0; return <tr key={c.id} style={{borderBottom:'1px solid #F1F5F9'}}>
              <td style={{padding:'6px 4px',fontWeight:600}}><div style={{display:'flex',alignItems:'center',gap:8}}>{c.image ? <img src={c.image} alt="" style={{width:34,height:34,borderRadius:6,objectFit:'cover',border:'1px solid var(--border)',flexShrink:0}} /> : null}<span>{c.description}</span></div></td>
              <td style={{padding:'6px 4px',fontFamily:'monospace',fontSize:11}}>{c.sku||'—'}</td>
              <td style={{padding:'6px 4px',textAlign:'center'}}>{q}</td>
              <td style={{padding:'6px 4px',textAlign:'right'}}>RM{u.toFixed(2)}</td>
              <td style={{padding:'6px 4px',textAlign:'right',fontWeight:700}}>RM{(q*u).toFixed(2)}</td>
            </tr>; })}
          </tbody>
          <tfoot><tr><td colSpan={4} style={{padding:'10px 4px',textAlign:'right',fontWeight:800}}>Total</td><td style={{padding:'10px 4px',textAlign:'right',fontWeight:800,fontSize:15}}>RM{total.toFixed(2)}</td></tr></tfoot>
        </table>
        <div className="small subtle" style={{marginTop:8,textAlign:'center'}}>This is a preview — nothing is saved until you confirm.</div>
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'center',marginTop:14,flexWrap:'wrap'}}>
        <button className="btn btn-ghost" onClick={()=>setShowPreview(false)}>← Back to edit</button>
        <button className="btn btn-primary" onClick={confirmSale} disabled={busy} style={{fontSize:15,padding:'10px 18px'}}>{busy?'Processing…':(paidNow?'✅ Confirm & Print Receipt':'✅ Confirm & Create Invoice')}</button>
      </div>
    </div>;
  }

  return <>
    <div className="shop-layout">
      {/* MAIN — product catalogue */}
      <div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
          <input className="input" style={{flex:1,minWidth:180}} value={catQuery} onChange={e=>{setCatQuery(e.target.value);setPage(0);}} placeholder="Search products by name, SKU or description…" />
          <button className="btn btn-ghost small" onClick={()=>setShowCustom(s=>!s)}>＋ Custom item</button>
        </div>
        {showCustom && <div className="card" style={{marginBottom:10,display:'flex',gap:8,alignItems:'end',flexWrap:'wrap'}}>
          <div className="field" style={{margin:0,flex:1,minWidth:140}}><label>Off-catalogue item</label><input className="input" value={cDesc} onChange={e=>setCDesc(e.target.value)} placeholder="e.g. Ear plugs" /></div>
          <div className="field" style={{margin:0,width:64}}><label>Qty</label><input className="input" type="number" min="1" value={cQty} onChange={e=>setCQty(Math.max(1,parseInt(e.target.value,10)||1))} /></div>
          <div className="field" style={{margin:0,width:96}}><label>Unit RM</label><input className="input" type="number" min="0" step="0.01" value={cPrice} onChange={e=>setCPrice(e.target.value)} placeholder="0.00" /></div>
          <button className="btn btn-primary small" onClick={addCustom} disabled={!cDesc.trim()||!(Number(cPrice)>0)}>Add to cart</button>
        </div>}
        {catFiltered.length===0
          ? <div className="empty" style={{padding:30}}>No products found. Add items in Settings › Products.</div>
          : <div className="shop-grid">
              {pageItems.map(p=><div key={p.id} className="card" style={{padding:0,overflow:'hidden',display:'flex',flexDirection:'column'}}>
                <div onClick={()=> p.image_url && setLightboxSrc(p.image_url)} title={p.image_url?'Click to enlarge':undefined} style={{height:104,background:'var(--surface-2)',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',cursor:p.image_url?'zoom-in':'default'}}>
                  {p.image_url ? <img src={p.image_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} /> : <span className="small subtle">No photo</span>}
                </div>
                <div onClick={()=>{ if(window.confirm('Add product to cart?')) addFromCatalogue(p); }} title="Add to cart" style={{padding:'8px 10px',cursor:'pointer',flex:1,display:'flex',flexDirection:'column',gap:2}}>
                  <div style={{fontWeight:700,fontSize:13,lineHeight:1.2}}>{p.name}</div>
                  {p.sku && <div className="small subtle" style={{fontFamily:'monospace',fontSize:10}}>{p.sku}</div>}
                  {p.description && <div className="small subtle" style={{fontSize:11,lineHeight:1.3,maxHeight:29,overflow:'hidden'}}>{p.description}</div>}
                  <div style={{fontWeight:800,marginTop:'auto',paddingTop:4}}>{p.price!=null?`RM${Number(p.price).toFixed(2)}`:'—'}</div>
                </div>
              </div>)}
            </div>}
        {pageCount>1 && <div style={{display:'flex',justifyContent:'center',alignItems:'center',gap:10,marginTop:14}}>
          <button className="btn btn-ghost small" disabled={curPage===0} onClick={()=>setPage(curPage-1)}>‹ Prev</button>
          <span className="small subtle">Page {curPage+1} of {pageCount} · {catFiltered.length} products</span>
          <button className="btn btn-ghost small" disabled={curPage>=pageCount-1} onClick={()=>setPage(curPage+1)}>Next ›</button>
        </div>}
      </div>

      {/* SIDEBAR — cart + checkout (fixed, does not change with pagination) */}
      <div className="shop-cart-col">
        <div className="card" style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontWeight:800,fontSize:15}}>🧾 Current Bill</div>

          <div>
            <div style={{display:'flex',gap:6,marginBottom:6}}>
              <button className={`btn small ${mode==='cash'?'btn-primary':'btn-ghost'}`} onClick={()=>setMode('cash')} style={{flex:1}}>💵 Cash</button>
              <button className={`btn small ${mode==='account'?'btn-primary':'btn-ghost'}`} onClick={()=>setMode('account')} style={{flex:1}}>👤 Account</button>
            </div>
            {mode==='cash'
              ? <input className="input" value={cashName} onChange={e=>setCashName(e.target.value)} placeholder="Name (default: Cash Sale)" />
              : <div>
                  <input className="input" value={acctQuery} onChange={e=>setAcctQuery(e.target.value)} placeholder="Search account…" style={{marginBottom:6}} />
                  <select className="select" value={accountKey} onChange={e=>setAccountKey(e.target.value)}>
                    <option value="">— Select account ({filteredAccounts.length}) —</option>
                    {filteredAccounts.slice(0,80).map(a=><option key={a.key} value={a.key}>{a.name}{a.phone?` · ${a.phone}`:''}</option>)}
                  </select>
                </div>}
          </div>

          <div style={{borderTop:'1px solid var(--border)',paddingTop:8}}>
            {cart.length===0
              ? <div className="small subtle" style={{textAlign:'center',padding:'10px 0'}}>Cart is empty — tap a product to add.</div>
              : <div style={{display:'flex',flexDirection:'column',gap:8,maxHeight:300,overflowY:'auto'}}>
                  {cart.map(c=>{ const q=Math.max(1,Number(c.quantity)||1); const u=Number(c.unitPrice)||0; return <div key={c.id} style={{display:'flex',gap:6,alignItems:'center'}}>
                    {c.image?<img src={c.image} alt="" style={{width:30,height:30,borderRadius:5,objectFit:'cover',flexShrink:0,border:'1px solid var(--border)'}} />:null}
                    <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.description}</div><div className="small subtle" style={{fontSize:10}}>RM{u.toFixed(2)} each</div></div>
                    <div style={{display:'flex',alignItems:'center',gap:2,flexShrink:0}}>
                      <button className="btn btn-ghost small" style={{padding:'0 6px'}} onClick={()=>setQty(c.id,q-1)}>−</button>
                      <span style={{minWidth:16,textAlign:'center',fontSize:12,fontWeight:700}}>{q}</span>
                      <button className="btn btn-ghost small" style={{padding:'0 6px'}} onClick={()=>setQty(c.id,q+1)}>+</button>
                    </div>
                    <div style={{width:58,textAlign:'right',fontWeight:700,fontSize:12,flexShrink:0}}>RM{(q*u).toFixed(2)}</div>
                    <button className="btn btn-ghost small" style={{color:'#DC2626',padding:'0 4px',flexShrink:0}} onClick={()=>removeFromCart(c.id)} title="Remove">×</button>
                  </div>; })}
                </div>}
          </div>

          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderTop:'1px solid var(--border)',paddingTop:8}}>
            <span style={{fontWeight:700}}>Total</span><span style={{fontWeight:800,fontSize:18}}>RM{total.toFixed(2)}</span>
          </div>

          {activeBranches.length>1 && <select className="select" value={branchId} onChange={e=>setBranchId(e.target.value)} title="Attribute to branch (optional)">
            <option value="">No specific branch</option>
            {activeBranches.map(b=><option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}
          </select>}

          <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13}}>
            <input type="checkbox" checked={paidNow} onChange={e=>setPaidNow(e.target.checked)} /> Payment received now (receipt)
          </label>
          {paidNow && <div style={{display:'flex',gap:6}}>
            <select className="select" value={method} onChange={e=>setMethod(e.target.value)} style={{flex:1}}>{activeMethods().map(m=><option key={m.code} value={m.code}>{m.label}</option>)}</select>
            <input className="input" type="date" value={date} onChange={e=>setDate(e.target.value)} style={{flex:1}} />
          </div>}

          <button className="btn btn-primary" disabled={!canGenerate} onClick={()=>setShowPreview(true)} style={{fontSize:15,padding:'10px'}}>👁 Preview Bill — RM{total.toFixed(2)}</button>
        </div>
      </div>
    </div>
    {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={()=>setLightboxSrc(null)} />}
  </>;
}

function ShopReturns({ invoices, pmts, onRefund, onViewInvoices }){
  const [q,setQ]=useState('');
  const [selId,setSelId]=useState('');
  const [reason,setReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(null);
  const refundable=(invoices||[]).filter(i=>Number(i.amount_paid)>0 && i.status!=='void' && i.status!=='refunded');
  const term=q.trim().toLowerCase();
  const matches=term
    ? refundable.filter(i=>(i.invoice_number||'').toLowerCase().includes(term)||(i.account_name||'').toLowerCase().includes(term)||(pmts||[]).some(p=>p.invoice_id===i.id&&(p.receipt_number||'').toLowerCase().includes(term)))
    : refundable.slice(0,8);
  const sel=(invoices||[]).find(i=>i.id===selId)||null;
  const selPaid=sel?Number(sel.amount_paid)||0:0;

  async function process(){
    if(!sel) return;
    setBusy(true);
    try{ await onRefund({ invoiceId:sel.id, amount:selPaid, refundDate:todayStr(), method:'cash', reference:null, reason:(reason.trim()||'Product return') }); setDone({ invoiceNumber:sel.invoice_number, amount:selPaid }); setSelId(''); setReason(''); }
    catch(e){ alert(e?.message||'Failed to process return'); }
    finally{ setBusy(false); }
  }

  if(done){
    return <div className="card" style={{textAlign:'center',borderColor:'#FCA5A5',background:'#FEF2F2',maxWidth:560,margin:'0 auto'}}>
      <div style={{fontSize:32,marginBottom:6}}>↩︎</div>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>Return processed</div>
      <div className="small subtle" style={{marginBottom:12}}>Refunded <strong>RM{done.amount.toFixed(2)}</strong> on invoice <strong style={{fontFamily:'monospace'}}>{done.invoiceNumber}</strong>. It's now marked <strong>Refunded</strong>.</div>
      <div style={{display:'flex',gap:8,justifyContent:'center'}}>
        <button className="btn btn-ghost" onClick={()=>onViewInvoices&&onViewInvoices()}>🧾 View in Invoices</button>
        <button className="btn btn-primary" onClick={()=>setDone(null)}>↩︎ New return</button>
      </div>
    </div>;
  }

  return <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <div className="card">
      <div style={{fontWeight:800,marginBottom:4}}>Find the sale to return</div>
      <div className="small subtle" style={{marginBottom:10}}>Search by receipt number, invoice number, or buyer name. Processing a return records a refund receipt (money back) and marks the invoice Refunded.</div>
      <input className="input" value={q} onChange={e=>{setQ(e.target.value);setSelId('');}} placeholder="e.g. RCT-000123, INV-000045, or a name…" />
      <div style={{marginTop:10,display:'flex',flexDirection:'column',gap:6,maxHeight:280,overflowY:'auto'}}>
        {matches.length===0 && <div className="empty" style={{padding:16}}>No matching paid sales found.</div>}
        {matches.map(i=>{ const rcpt=(pmts||[]).find(p=>p.invoice_id===i.id&&Number(p.amount)>0); return <div key={i.id} onClick={()=>setSelId(i.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:8,cursor:'pointer',border:`1px solid ${selId===i.id?'var(--primary)':'var(--border)'}`,background:selId===i.id?'#EFF6FF':'var(--surface)'}}>
          <div style={{flex:1,minWidth:0}}><div style={{fontWeight:700}}>{i.account_name||'—'}</div><div className="small subtle" style={{fontFamily:'monospace'}}>{i.invoice_number}{rcpt?` · ${rcpt.receipt_number}`:''} · {i.issue_date||''}</div></div>
          <div style={{fontWeight:700,whiteSpace:'nowrap'}}>RM{(Number(i.amount_paid)||0).toFixed(2)}</div>
        </div>; })}
      </div>
    </div>

    {sel && <div className="card">
      <div style={{fontWeight:800,marginBottom:8}}>Process return — {sel.account_name}</div>
      <div style={{background:'var(--surface-2)',border:'1px solid var(--border)',borderRadius:8,padding:'10px 12px',marginBottom:10,display:'flex',justifyContent:'space-between'}}>
        <span className="small subtle">Refund amount (full)</span><strong style={{fontSize:16,color:'#DC2626'}}>RM{selPaid.toFixed(2)}</strong>
      </div>
      <div className="field"><label>Reason (optional)</label><input className="input" value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. Wrong size, faulty goggles" /></div>
      <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginTop:12}}>
        <button className="btn btn-ghost small" onClick={()=>setSelId('')}>Cancel</button>
        <button className="btn btn-danger" onClick={process} disabled={busy}>{busy?'Processing…':`↩︎ Refund RM${selPaid.toFixed(2)}`}</button>
      </div>
      <div className="small subtle" style={{marginTop:8}}>Tip: for a partial return (some items kept), open the invoice under Accounts → Invoices and use its Refund action with a custom amount.</div>
    </div>}
  </div>;
}


// Settings › Products — product catalogue (photo, name, SKU, description, price).
// Stable, top-level edit card (defining it inside ProductsAdminView caused the
// inputs to remount and lose focus on every keystroke).
function ProductEditCard({ vals, setVals, onSave, onCancel, saveLabel }){
  const upBox={width:'100%',height:120,borderRadius:10,border:'1px dashed var(--border)',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',background:'var(--surface-2)',cursor:'pointer',fontSize:12,color:'var(--text-3)'};
  async function onPick(file){ if(!file) return; try{ const t=await fileToThumbnail(file); setVals({...vals,image:t}); }catch(_){ alert('Could not read that image.'); } }
  return <div className="card" style={{padding:12,display:'flex',flexDirection:'column',gap:8}}>
    <label style={upBox} title="Add / change photo">
      {vals.image ? <img src={vals.image} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} /> : <span>＋ Add photo</span>}
      <input type="file" accept="image/*" style={{display:'none'}} onChange={e=>{ onPick(e.target.files?.[0]); e.target.value=''; }} />
    </label>
    {vals.image && <button className="btn btn-ghost small" style={{alignSelf:'flex-start',color:'#DC2626',padding:'0 4px',fontSize:11}} onClick={()=>setVals({...vals,image:''})}>remove photo</button>}
    <input className="input" placeholder="Product name" value={vals.name} onChange={e=>setVals({...vals,name:e.target.value})} />
    <div style={{display:'flex',gap:8}}>
      <input className="input" placeholder="SKU (optional)" value={vals.sku} onChange={e=>setVals({...vals,sku:e.target.value})} style={{flex:1}} />
      <input className="input" type="number" min="0" step="0.01" placeholder="Price RM" value={vals.price} onChange={e=>setVals({...vals,price:e.target.value})} style={{width:110}} />
    </div>
    <textarea className="textarea" style={{minHeight:60}} placeholder="Description (optional)" value={vals.description} onChange={e=>setVals({...vals,description:e.target.value})} />
    <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
      {onCancel && <button className="btn btn-ghost small" onClick={onCancel}>Cancel</button>}
      <button className="btn btn-primary small" disabled={!vals.name.trim()} onClick={onSave}>{saveLabel}</button>
    </div>
  </div>;
}

function ProductsAdminView({ products, addProduct, updateProduct, deleteProduct, reorderProducts }){
  const blank={name:'',sku:'',price:'',image:'',description:''};
  const [form,setForm]=useState(blank);
  const [editingId,setEditingId]=useState(null);
  const [editForm,setEditForm]=useState(blank);
  const [dragId,setDragId]=useState(null);
  const [overId,setOverId]=useState(null);
  const [lightboxSrc,setLightboxSrc]=useState(null);
  function startEdit(p){ setEditingId(p.id); setEditForm({name:p.name||'',sku:p.sku||'',price:p.price!=null?String(p.price):'',image:p.image_url||'',description:p.description||''}); }
  async function saveEdit(){ if(!editForm.name.trim()) return; await updateProduct(editingId,{ name:editForm.name.trim(), sku:editForm.sku.trim()||null, price:(editForm.price===''?null:Number(editForm.price)), image_url:editForm.image||null, description:editForm.description.trim()||null }); setEditingId(null); }
  async function addNew(){ if(!form.name.trim()) return; await addProduct({ name:form.name.trim(), sku:form.sku.trim()||null, price:form.price, imageUrl:form.image||null, description:form.description.trim()||null }); setForm(blank); }
  function onDrop(targetId){
    if(dragId && dragId!==targetId && reorderProducts){
      const ids=(products||[]).map(p=>p.id);
      const from=ids.indexOf(dragId), to=ids.indexOf(targetId);
      if(from>-1 && to>-1){ ids.splice(to,0,ids.splice(from,1)[0]); reorderProducts(ids); }
    }
    setDragId(null); setOverId(null);
  }

  return <>
    <div className="card" style={{marginBottom:14}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>🛍 Product Catalogue</div>
      <div className="small subtle">Items you sell (goggles, caps, swim diapers…). Add a photo, SKU, description and price — the photo and details show in the Shop so staff pick the right item. Drag the ⠿ handle on a card to re-order the catalogue. Shared across all branches; price stays editable per sale.</div>
    </div>

    {/* Top row: new product entry */}
    <div style={{marginBottom:18,maxWidth:300}}>
      <div className="small subtle" style={{fontWeight:700,marginBottom:6}}>＋ New product</div>
      <ProductEditCard vals={form} setVals={setForm} onSave={addNew} onCancel={null} saveLabel="Add Product" />
    </div>

    {/* Catalogue grid (starts on the next row) */}
    {(products||[]).length>0 && <div className="small subtle" style={{fontWeight:700,marginBottom:8}}>Catalogue ({(products||[]).length})</div>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(230px,1fr))',gap:14,alignItems:'start'}}>
      {(products||[]).map(p => editingId===p.id
        ? <div key={p.id}><div className="small subtle" style={{fontWeight:700,marginBottom:6}}>Editing</div><ProductEditCard vals={editForm} setVals={setEditForm} onSave={saveEdit} onCancel={()=>setEditingId(null)} saveLabel="Save" /></div>
        : <div key={p.id} className="card"
            onDragOver={e=>{ e.preventDefault(); if(overId!==p.id) setOverId(p.id); }}
            onDrop={e=>{ e.preventDefault(); onDrop(p.id); }}
            style={{padding:0,overflow:'hidden',display:'flex',flexDirection:'column',position:'relative',opacity:dragId===p.id?0.4:1,outline:(overId===p.id&&dragId&&dragId!==p.id)?'2px solid var(--primary)':'none',outlineOffset:'-1px',transition:'opacity .12s'}}>
            <div draggable onDragStart={e=>{ setDragId(p.id); e.dataTransfer.effectAllowed='move'; }} onDragEnd={()=>{ setDragId(null); setOverId(null); }}
              title="Drag to re-order" aria-label="Drag to re-order"
              style={{position:'absolute',top:6,left:6,zIndex:2,display:'inline-grid',gridTemplateColumns:'5px 5px',gap:3,padding:6,borderRadius:6,background:'rgba(255,255,255,.85)',boxShadow:'0 1px 3px rgba(0,0,0,.18)',cursor:'grab'}}>
              {[0,1,2,3].map(i=><span key={i} style={{width:5,height:5,borderRadius:'50%',background:'#64748B'}} />)}
            </div>
            <div onClick={()=> p.image_url && setLightboxSrc(p.image_url)} title={p.image_url?'Click to enlarge':undefined} style={{height:130,background:'var(--surface-2)',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',cursor:p.image_url?'zoom-in':'default'}}>
              {p.image_url ? <img src={p.image_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}} /> : <span className="small subtle">No photo</span>}
            </div>
            <div style={{padding:'10px 12px',display:'flex',flexDirection:'column',gap:4,flex:1}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:8}}>
                <div style={{fontWeight:700,fontSize:14}}>{p.name}</div>
                <div style={{fontWeight:800,whiteSpace:'nowrap'}}>{p.price!=null?`RM${Number(p.price).toFixed(2)}`:'—'}</div>
              </div>
              {p.sku && <div className="small subtle" style={{fontFamily:'monospace',fontSize:11}}>SKU: {p.sku}</div>}
              {p.description && <div className="small subtle" style={{fontSize:12,lineHeight:1.4}}>{p.description}</div>}
              <div style={{display:'flex',gap:6,marginTop:'auto',paddingTop:8}}>
                <button className="btn btn-ghost small" onClick={()=>startEdit(p)}>✎ Edit</button>
                <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteProduct(p.id)}>Delete</button>
              </div>
            </div>
          </div>
      )}
    </div>
    {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={()=>setLightboxSrc(null)} />}
  </>;
}

function BillingTermsAdminView({ terms, branches, currentBranchId, addTerm, updateTerm, deleteTerm }){
  const activeBranches = (branches||[]).filter(b => b.is_active !== false);
  const branchById = id => (branches||[]).find(b => b.id === id) || null;
  const showBranchTag = !currentBranchId || currentBranchId === 'all';
  const defaultBranch = (currentBranchId && currentBranchId !== 'all') ? currentBranchId : (activeBranches[0]?.id || '');

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [branchId, setBranchId] = useState(defaultBranch);
  React.useEffect(() => { if(currentBranchId && currentBranchId !== 'all') setBranchId(currentBranchId); }, [currentBranchId]);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ name:'', startDate:'', endDate:'' });

  const visible = (currentBranchId && currentBranchId !== 'all')
    ? (terms||[]).filter(t => !t.branch_id || t.branch_id === currentBranchId)
    : (terms||[]);

  function startEdit(t){ setEditingId(t.id); setEditForm({ name:t.name||'', startDate:t.start_date||'', endDate:t.end_date||'' }); }
  async function saveEdit(){ if(!editForm.name.trim()) return; await updateTerm(editingId, { name:editForm.name.trim(), start_date:editForm.startDate||null, end_date:editForm.endDate||null }); setEditingId(null); }
  function fmt(d){ if(!d) return '—'; try{ return new Date(d).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); }catch(_){ return d; } }

  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>🗓 Billing Terms</div>
      <div className="small subtle" style={{marginBottom:14}}>Named billing periods / school terms (e.g. “Term 1 2026”) with a start and end date, per branch. The list shows the active branch's terms; switch branch in the header to manage another.</div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(0,1fr) 150px 150px 160px auto',gap:10,alignItems:'end'}}>
        <div className="field" style={{margin:0}}><label>Name</label><input className="input" placeholder="e.g. Term 1 2026" value={name} onChange={e=>setName(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Start date</label><input className="input" type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>End date</label><input className="input" type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} /></div>
        <div className="field" style={{margin:0}}><label>Branch</label><select className="select" value={branchId} onChange={e=>setBranchId(e.target.value)}>{activeBranches.map(b => <option key={b.id} value={b.id}>{b.name}{b.code?` (${b.code})`:''}</option>)}</select></div>
        <button className="btn btn-primary" style={{height:38}} disabled={!name.trim()||!branchId} onClick={async()=>{ if(!name.trim()||!branchId) return; await addTerm({ name:name.trim(), startDate, endDate, branchId }); setName(''); setStartDate(''); setEndDate(''); }}>+ Add Term</button>
      </div>
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0}}>
        <table>
          <thead><tr><th style={{width:'34%'}}>Name</th><th style={{width:140}}>Start</th><th style={{width:140}}>End</th>{showBranchTag?<th style={{width:90}}>Branch</th>:null}<th style={{width:180,textAlign:'right'}}>Actions</th></tr></thead>
          <tbody>
            {visible.length===0 && <tr><td colSpan={showBranchTag?5:4} className="empty">No billing terms yet. Add one above.</td></tr>}
            {visible.map(t => editingId===t.id ? (
              <tr key={t.id}>
                <td><input className="input" value={editForm.name} onChange={e=>setEditForm({...editForm,name:e.target.value})} /></td>
                <td><input className="input" type="date" value={editForm.startDate} onChange={e=>setEditForm({...editForm,startDate:e.target.value})} /></td>
                <td><input className="input" type="date" value={editForm.endDate} onChange={e=>setEditForm({...editForm,endDate:e.target.value})} /></td>
                {showBranchTag?<td className="small subtle">{branchById(t.branch_id)?.code||branchById(t.branch_id)?.name||'—'}</td>:null}
                <td style={{textAlign:'right'}}><button className="btn btn-primary small" onClick={saveEdit} style={{marginRight:6}}>Save</button><button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>Cancel</button></td>
              </tr>
            ) : (
              <tr key={t.id}>
                <td style={{fontWeight:600}}>{t.name}</td>
                <td>{fmt(t.start_date)}</td>
                <td>{fmt(t.end_date)}</td>
                {showBranchTag?<td>{t.branch_id?<span className="lt-branch-tag">{branchById(t.branch_id)?.code||branchById(t.branch_id)?.name}</span>:<span className="subtle">—</span>}</td>:null}
                <td style={{textAlign:'right'}}><button className="btn btn-ghost small" onClick={()=>startEdit(t)} style={{marginRight:6}}>✎ Edit</button><button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteTerm(t.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

function ProgrammeCategoriesView({ categories, addCategory, updateCategory, deleteCategory }){
  const [name,setName] = useState('');
  const [color,setColor] = useState('#0EA5E9');
  const [editingId,setEditingId] = useState(null);
  const [editForm,setEditForm] = useState({name:'', color:''});
  function startEdit(c){ setEditingId(c.id); setEditForm({ name:c.name||'', color:c.color||'#0EA5E9' }); }
  async function saveEdit(){ if(!editForm.name.trim()) return; await updateCategory(editingId, { name:editForm.name.trim(), color:editForm.color||null }); setEditingId(null); }
  return <>
    <div className="card" style={{marginBottom:12}}>
      <div style={{fontSize:18,fontWeight:800,marginBottom:4}}>🏊 Swim Group Categories</div>
      <div className="small subtle" style={{marginBottom:14}}>Categories for the Programme planner. They appear as a dropdown when creating a programme session and tint the session cards. Shared across all branches.</div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <input className="input" style={{flex:'1 1 220px',maxWidth:280}} placeholder="Category name (e.g. Squad, Learn-to-Swim)" value={name} onChange={e=>setName(e.target.value)} />
        <input type="color" className="input" style={{width:64,padding:2}} value={color} onChange={e=>setColor(e.target.value)} title="Category tint" />
        <button className="btn btn-primary small" disabled={!name.trim()} onClick={async()=>{ if(!name.trim()) return; await addCategory({ name:name.trim(), color }); setName(''); setColor('#0EA5E9'); }}>+ Add Category</button>
      </div>
    </div>
    <div className="card" style={{padding:0,overflow:'hidden'}}>
      <div className="table-wrap" style={{border:'none',borderRadius:0}}>
        <table>
          <thead><tr><th style={{width:'55%'}}>Name</th><th style={{width:90}}>Color</th><th style={{width:200,textAlign:'right'}}>Actions</th></tr></thead>
          <tbody>
            {(categories||[]).length === 0 && <tr><td colSpan={3} className="empty">No categories yet. Add one above to get started.</td></tr>}
            {(categories||[]).map(c => editingId === c.id ? (
              <tr key={c.id}>
                <td><input className="input" value={editForm.name} onChange={e=>setEditForm({...editForm, name:e.target.value})} /></td>
                <td><input type="color" className="input" style={{width:50,padding:2}} value={editForm.color} onChange={e=>setEditForm({...editForm, color:e.target.value})} /></td>
                <td style={{textAlign:'right'}}>
                  <button className="btn btn-primary small" onClick={saveEdit} style={{marginRight:6}}>Save</button>
                  <button className="btn btn-ghost small" onClick={()=>setEditingId(null)}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={c.id}>
                <td style={{fontWeight:600}}>{c.name}</td>
                <td>{c.color ? <span style={{display:'inline-block',width:24,height:24,borderRadius:6,background:c.color,border:'1px solid var(--border)'}} /> : <span className="subtle">—</span>}</td>
                <td style={{textAlign:'right'}}>
                  <button className="btn btn-ghost small" onClick={()=>startEdit(c)} style={{marginRight:6}}>✎ Edit</button>
                  <button className="btn btn-ghost small" style={{color:'#DC2626'}} onClick={()=>deleteCategory(c.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
// ── Application login gate ──────────────────────────────────────────────────
const AUTH_KEY='ssb.auth';
const AUTH_TTL_MS=7*24*60*60*1000; // 7-day session
// Admin & Procurement system (separate Netlify site, separate Supabase project,
// same app_users source of truth via the scheduler's Supabase).
const ADMIN_SYSTEM_URL='https://system.mystarswim.com/';
// Role rules:
//   sysadmin       — full access to BOTH apps.
//   schedule_admin — scheduler only (this app). Was 'admin' before.
//   admin          — Admin & Procurement system only.
function canUseScheduler(role){ return role==='sysadmin' || role==='schedule_admin'; }
function canUseAdminSystem(role){ return role==='sysadmin' || role==='admin'; }
// Legacy client-side hash — used ONLY by the login fallback below, for the
// window between shipping the edge-function wiring and deploying the `login`
// function. Once app_users is locked down (Phase 0 SQL), this path reads no
// rows and the server function is authoritative. Remove after Phase 0 lands.
async function sha256Hex(str){
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function readAuth(){
  try{
    const raw=localStorage.getItem(AUTH_KEY);
    if(!raw) return null;
    const a=JSON.parse(raw);
    if(!a || !a.id || !a.ts || (Date.now()-a.ts)>AUTH_TTL_MS){ localStorage.removeItem(AUTH_KEY); return null; }
    // Restore the Supabase session on reload so requests keep going out as
    // `authenticated`. Sessions stored before Phase 2 simply have no
    // `supabase` key, and those users fall back to the anon key until their
    // next sign-in mints one.
    setSbSession(a.supabase || null);
    return a;
  }catch(_){ return null; }
}
function clearAuth(){ setSbSession(null); try{ localStorage.removeItem(AUTH_KEY); }catch(_){} }

function LoginView({ onLogin }){
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  async function submit(e){
    if(e) e.preventDefault();
    const u=username.trim(); if(!u||!password){ setErr('Enter your username and password.'); return; }
    setBusy(true); setErr('');
    try{
      // Phase 0 (RLS hardening): credentials are verified server-side by the
      // `login` edge function (service role). The browser never reads password
      // material; it receives a safe profile + a signed session token.
      let user=null, token=null, viaFn=false, sb=null;
      try{
        const res=await fetch(`${cfg.supabaseUrl}/functions/v1/login`, {
          method:'POST',
          headers:{ 'Content-Type':'application/json', apikey: cfg.supabaseAnonKey },
          body: JSON.stringify({ username:u, password })
        });
        if(res.status===401){ setErr('Invalid username or password.'); setBusy(false); return; }
        if(res.ok){ const d=await res.json(); user=d.user; token=d.token; sb=d.supabase||null; viaFn=true; }
        // Any other status (e.g. 404 before the function is deployed) falls
        // through to the legacy path below.
      }catch(_){ /* function unreachable — fall through to legacy path */ }

      // Legacy fallback — active only until the `login` function is deployed.
      // After the Phase 0 SQL lock, this read returns no rows and is inert.
      if(!viaFn){
        const rows=await selectRows('app_users','*',`&username=eq.${encodeURIComponent(u)}&is_active=eq.true`).catch(()=>[]);
        const row=rows?.[0];
        if(row){
          const hash=await sha256Hex((row.password_salt||'')+password);
          if(hash===row.password_hash){
            user={ id:row.id, username:row.username, displayName:row.display_name||row.username, role:row.role||'staff' };
            patchRows('app_users',{id:row.id},{last_login_at:new Date().toISOString()}).catch(()=>{});
          }
        }
      }

      if(!user){ setErr('Invalid username or password.'); setBusy(false); return; }
      const role=user.role||'staff';
      // Post-merger: admins land in the System side of this same app; no
      // external redirect needed. Only reject roles that can access neither.
      if(!canUseScheduler(role) && !canUseAdminSystem(role)){
        setErr('This account is not permitted to sign in.');
        setBusy(false);
        return;
      }
      const auth={ id:user.id, username:user.username, displayName:user.displayName||user.username, role, token:token||null, supabase:sb, ts:Date.now() };
      // Start sending the JWT immediately; the legacy login path leaves this
      // null and the app keeps using the anon key, exactly as before.
      setSbSession(sb);
      try{ localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }catch(_){}
      onLogin(auth);
      return;
    }catch(ex){ setErr('Could not reach the server. Please try again.'); }
    finally{ setBusy(false); }
  }
  return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg)',padding:20}}>
    <form onSubmit={submit} style={{width:'min(380px,94vw)',background:'var(--surface)',border:'1px solid var(--border)',borderRadius:16,padding:'30px 28px',boxShadow:'0 8px 30px rgba(15,23,42,.08)'}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18}}>
        <img src="./logo.png" alt="" style={{height:38}} />
        <div>
          <div style={{fontWeight:800,fontSize:17,lineHeight:1.1}}>SSB Scheduler</div>
          <div className="small subtle">Star Swim Sdn Bhd</div>
        </div>
      </div>
      <div className="field"><label>Username</label><input className="input" autoFocus autoCapitalize="none" value={username} onChange={e=>setUsername(e.target.value)} /></div>
      <div className="field"><label>Password</label><input className="input" type="password" value={password} onChange={e=>setPassword(e.target.value)} /></div>
      {err && <div className="small" style={{color:'#DC2626',fontWeight:600,marginTop:6}}>{err}</div>}
      <button type="submit" className="btn btn-primary" disabled={busy} style={{width:'100%',marginTop:14,padding:'10px'}}>{busy?'Signing in…':'Sign in'}</button>
      <div className="small subtle" style={{marginTop:14,textAlign:'center'}}><a href="./index.html" style={{color:'var(--text-3)'}}>← Back to mystarswim.com</a></div>
    </form>
  </div>;
}

function Root(){
  const [authUser,setAuthUser]=useState(readAuth());
  if(!authUser) return <LoginView onLogin={setAuthUser} />;
  return <ErrorBoundary><App currentUser={authUser} onLogout={()=>{ clearAuth(); setAuthUser(null); }} /></ErrorBoundary>;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(Root)
);
