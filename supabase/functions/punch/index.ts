// ─────────────────────────────────────────────────────────────────────────
// Edge Function: punch  (Star Swim Attendance, Phase 2)
//
// The ONLY writer of the punches table. Workers have no INSERT policy on
// punches, so every check-in/out must come through here. That is deliberate:
// it means the timestamp, the geofence decision and the resulting status are
// all computed server-side and cannot be forged by a crafted request.
//
// Three rules this function exists to enforce:
//   1. SERVER CLOCK. punched_at is the database default now() — the device
//      clock is never trusted, never even read.
//   2. GEOFENCE. Distance is computed here from the location's stored centre.
//      Out-of-radius attempts are REJECTED but still written (accepted=false)
//      so the audit trail shows them.
//   3. OWNERSHIP. The shift must belong to the authenticated caller.
//
// Auth: Supabase Auth JWT in the Authorization header (staff log in with a
// staff ID that maps to a hidden internal email). The anon key alone gets
// nothing — we resolve the caller via auth.getUser() and match the worker row.
//
// Deploy:  supabase functions deploy punch
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the
//          platform. No extra secrets needed.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// The worker list is `crew` in some projects and `admin_employees` in others.
// Resolve once per cold start rather than hard-coding the wrong one.
let crewTableCache: string | null = null;
async function crewTable(): Promise<string> {
  if (crewTableCache) return crewTableCache;
  for (const t of ["crew", "admin_employees"]) {
    const { error } = await db.from(t).select("id").limit(1);
    if (!error) {
      crewTableCache = t;
      return t;
    }
  }
  throw new Error("No worker table found (looked for crew, admin_employees)");
}

// Haversine distance in metres — a sphere, so it reads ~0.5% longer than
// PostGIS ST_Distance, which uses the WGS84 ellipsoid (measured: 1000.0 m here
// vs 994.5 m there). At a 300 m fence that is under 2 m, far inside GPS noise,
// and it saves a database round-trip on the hot path.
//
// Because the two disagree slightly, the number this function computes is
// written to punches.distance_m and THAT is the record. When auditing a
// rejected punch, read the stored column — do not recompute with PostGIS and
// expect the same figure.
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8; // IUGG mean Earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function minutesBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 60000);
}

// Build a real instant from a shift's date + local time in the configured zone.
// Asia/Kuala_Lumpur is a fixed +08:00 with no DST, which keeps this exact.
function zonedInstant(dateStr: string, timeStr: string, offset: string): Date {
  const t = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
  return new Date(`${dateStr}T${t}${offset}`);
}

// Resolve a tz name to a fixed UTC offset string. Malaysia has no DST; if the
// setting is ever changed to a DST zone this needs a real tz library.
function offsetFor(tz: string): string {
  const fixed: Record<string, string> = {
    "Asia/Kuala_Lumpur": "+08:00",
    "Asia/Singapore": "+08:00",
    "UTC": "+00:00",
  };
  return fixed[tz] ?? "+08:00";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ── 1. Authenticate the caller ──────────────────────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in." }, 401);

    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401);
    const authUserId = userData.user.id;

    // ── 2. Validate the request body ────────────────────────────────────
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Bad request." }, 400);

    const { shift_id, type, lat, lng, accuracy_m } = body as {
      shift_id?: string; type?: string;
      lat?: number; lng?: number; accuracy_m?: number;
    };

    if (!shift_id || (type !== "in" && type !== "out")) {
      return json({ error: "shift_id and type ('in'|'out') are required." }, 400);
    }
    if (typeof lat !== "number" || typeof lng !== "number" ||
        !Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return json({ error: "Location unavailable. Turn on location and try again." }, 400);
    }

    // ── 3. Resolve the caller's worker row ──────────────────────────────
    const tbl = await crewTable();
    const { data: crew } = await db
      .from(tbl).select("id").eq("auth_user_id", authUserId).maybeSingle();
    if (!crew) return json({ error: "Your login is not linked to a worker record." }, 403);

    // ── 4. Load the shift — and prove it is this caller's ───────────────
    const { data: shift } = await db
      .from("shifts")
      .select("id, crew_id, shift_date, start_time, end_time, location_id, status, late_min, early_min, is_void")
      .eq("id", shift_id)
      .maybeSingle();

    if (!shift || shift.is_void) return json({ error: "Session not found." }, 404);
    if (shift.crew_id !== crew.id) return json({ error: "That is not your session." }, 403);

    const [{ data: settings }, { data: loc }] = await Promise.all([
      db.from("attendance_settings").select("*").single(),
      db.from("locations").select("id, name, lat, lng, radius_m").eq("id", shift.location_id).single(),
    ]);
    if (!settings || !loc) return json({ error: "Session is misconfigured — tell your admin." }, 500);

    const offset  = offsetFor(settings.timezone);
    const startsAt = zonedInstant(shift.shift_date, shift.start_time, offset);
    const endsAt   = zonedInstant(shift.shift_date, shift.end_time, offset);
    const now = new Date();

    // ── 5. Window and duplicate checks ──────────────────────────────────
    const { data: existing } = await db
      .from("punches").select("id, type").eq("shift_id", shift_id).eq("accepted", true);
    const hasIn  = (existing ?? []).some((p) => p.type === "in");
    const hasOut = (existing ?? []).some((p) => p.type === "out");

    if (type === "in") {
      if (hasIn) return json({ error: "You have already checked in for this session." }, 409);
      const opensAt = new Date(startsAt.getTime() - settings.checkin_window_min * 60000);
      if (now < opensAt) {
        return json({
          error: `Check-in opens ${settings.checkin_window_min} minutes before the session starts.`,
          opens_at: opensAt.toISOString(),
        }, 409);
      }
      // After the session has ended there is nothing to check into; the admin
      // enters a missed punch instead (source='admin', remark required).
      if (now > new Date(endsAt.getTime() + settings.no_checkout_alert_min * 60000)) {
        return json({ error: "This session has ended. Ask your admin to record your time." }, 409);
      }
    } else {
      if (!hasIn)  return json({ error: "Check in before you check out." }, 409);
      if (hasOut)  return json({ error: "You have already checked out for this session." }, 409);
      // A check-out records when the tap happened, not when they left. Someone
      // who finishes at 11:00 and remembers at 14:00 would bank three hours
      // they did not work — and the geofence waves it through, because they
      // may well still be at the pool for a later session. Past the grace
      // window it goes to the admin, same as a missed check-in.
      if (now > new Date(endsAt.getTime() + settings.no_checkout_alert_min * 60000)) {
        return json({
          error: "Too long after the session ended. Ask your admin to record your check-out time.",
        }, 409);
      }
    }

    // ── 6. Geofence ─────────────────────────────────────────────────────
    const dist = distanceM(lat, lng, loc.lat, loc.lng);
    const radius = loc.radius_m ?? settings.default_radius_m;
    const inside = dist <= radius;

    // Kept for the audit trail: a reported accuracy of exactly 0 is not a
    // thing real GPS hardware produces and suggests a mocked location.
    const suspiciousAccuracy = typeof accuracy_m === "number" && accuracy_m <= 0;

    const punchRow = {
      shift_id,
      crew_id: crew.id,
      type,
      lat, lng,
      accuracy_m: typeof accuracy_m === "number" ? accuracy_m : null,
      distance_m: Math.round(dist * 10) / 10,
      inside_fence: inside,
      accepted: inside,
      source: "worker",
      created_by: authUserId,
      remark: suspiciousAccuracy ? "Reported GPS accuracy was 0 m — possible mocked location." : null,
      // punched_at deliberately omitted: the column default is the server clock.
    };

    const { data: punch, error: punchErr } = await db
      .from("punches").insert(punchRow).select("id, punched_at").single();
    if (punchErr) return json({ error: "Could not record the punch.", detail: punchErr.message }, 500);

    if (!inside) {
      // Rejected, but logged above. Raise one open geofence alert per shift.
      await db.from("alerts")
        .insert({ shift_id, crew_id: crew.id, type: "geofence" })
        .select().maybeSingle();          // unique partial index dedupes
      await db.from("shifts")
        .update({ status: "geofence_flag", updated_at: new Date().toISOString() })
        .eq("id", shift_id).eq("status", "scheduled");

      return json({
        ok: false,
        reason: "outside_geofence",
        error: `You are ${dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : Math.round(dist) + " m"} from ${loc.name}. Move closer and try again.`,
        distance_m: Math.round(dist),
        radius_m: radius,
        location_name: loc.name,
      }, 403);
    }

    // ── 7. Status + alerts (server clock from the inserted row) ─────────
    const at = new Date(punch.punched_at);
    const grace = settings.grace_min;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let raise: string | null = null;

    if (type === "in") {
      const lateMin = Math.max(0, minutesBetween(at, new Date(startsAt.getTime() + grace * 60000)));
      patch.late_min = lateMin;
      patch.status = lateMin > 0 ? "late" : "scheduled"; // final status set on check-out
      if (lateMin > 0) raise = "late";
    } else {
      const earlyMin = Math.max(0, minutesBetween(new Date(endsAt.getTime() - grace * 60000), at));
      patch.early_min = earlyMin;
      // A session can be both late and early. `status` carries the headline;
      // late_min and early_min carry the facts, and reports read the minutes.
      const wasLate = (shift.late_min ?? 0) > 0;
      patch.status = wasLate ? "late" : earlyMin > 0 ? "early_leave" : "on_time";
      if (earlyMin > 0) raise = "early_leave";
    }

    await db.from("shifts").update(patch).eq("id", shift_id);

    if (raise) {
      await db.from("alerts")
        .insert({ shift_id, crew_id: crew.id, type: raise })
        .select().maybeSingle();          // unique partial index dedupes
    }

    return json({
      ok: true,
      punch_id: punch.id,
      punched_at: punch.punched_at,
      type,
      distance_m: Math.round(dist),
      status: patch.status,
      late_min: patch.late_min ?? shift.late_min ?? 0,
      early_min: patch.early_min ?? shift.early_min ?? 0,
    }, 200);

  } catch (e) {
    return json({ error: "Unexpected error.", detail: String(e) }, 500);
  }
});
