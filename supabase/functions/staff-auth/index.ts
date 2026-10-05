// ─────────────────────────────────────────────────────────────────────────
// Edge Function: staff-auth  (Star Swim Attendance)
//
// Creates and manages the Supabase Auth logins behind staff IDs. Workers sign
// in with a staff ID and a password; Supabase Auth needs an email, so each
// staff ID maps to a hidden internal address that nobody ever types or sees:
//
//     SS-012  ->  ss-012@staff.mystarswim.internal
//
// Those addresses are deliberately unroutable. They exist only to satisfy
// Auth's schema — no mail is ever sent to them, and email confirmation is
// bypassed at creation, so a worker never needs an inbox or a phone.
//
// Admin-only. Every action verifies that the CALLER is an admin by checking
// their own JWT against the worker list; the service role is used only after
// that check passes.
//
// Actions:
//   provision { crew_id, staff_id, password }  create the login and link it
//   reset     { crew_id, password }            set a new password
//   unlink    { crew_id }                      delete the login, keep the worker
//
// Deploy:  supabase functions deploy staff-auth
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_DOMAIN = "staff.mystarswim.internal";

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

let crewTableCache: string | null = null;
async function crewTable(): Promise<string> {
  if (crewTableCache) return crewTableCache;
  for (const t of ["crew", "admin_employees"]) {
    const { error } = await db.from(t).select("id").limit(1);
    if (!error) { crewTableCache = t; return t; }
  }
  throw new Error("No worker table found (looked for crew, admin_employees)");
}

function emailFor(staffId: string): string {
  return `${String(staffId).trim().toLowerCase().replace(/\s+/g, "")}@${EMAIL_DOMAIN}`;
}

// Workers key in a password on a phone, often one-handed at a poolside. Eight
// characters is the floor; the admin chooses what they hand out.
function badPassword(p: unknown): string | null {
  if (typeof p !== "string" || p.length < 8) return "Password must be at least 8 characters.";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ── Authenticate and authorise the CALLER ───────────────────────────
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Not signed in." }, 401);

    const { data: userData, error: userErr } = await db.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "Not signed in." }, 401);

    const tbl = await crewTable();
    const { data: caller } = await db
      .from(tbl).select("id, is_admin").eq("auth_user_id", userData.user.id).maybeSingle();
    if (!caller?.is_admin) return json({ error: "Admins only." }, 403);

    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Bad request." }, 400);
    const { action, crew_id, staff_id, password } = body as Record<string, string>;
    if (!crew_id) return json({ error: "crew_id is required." }, 400);

    const { data: worker } = await db
      .from(tbl).select("id, staff_id, auth_user_id").eq("id", crew_id).maybeSingle();
    if (!worker) return json({ error: "Worker not found." }, 404);

    // ── provision ───────────────────────────────────────────────────────
    if (action === "provision") {
      const sid = (staff_id ?? worker.staff_id ?? "").trim();
      if (!sid) return json({ error: "This worker has no staff ID yet." }, 400);
      const bad = badPassword(password);
      if (bad) return json({ error: bad }, 400);
      if (worker.auth_user_id) {
        return json({ error: "This worker already has a login. Use reset instead." }, 409);
      }

      const { data: created, error: createErr } = await db.auth.admin.createUser({
        email: emailFor(sid),
        password,
        email_confirm: true,            // no inbox exists; confirm immediately
        user_metadata: { staff_id: sid, crew_id },
      });
      if (createErr || !created?.user) {
        return json({ error: "Could not create the login.", detail: createErr?.message }, 400);
      }

      // Link it back to the worker row, and store the staff ID if it was
      // supplied here. If this fails we would strand an orphan auth user, so
      // delete it and report honestly rather than leaving a half-made login.
      const { error: linkErr } = await db
        .from(tbl).update({ auth_user_id: created.user.id, staff_id: sid }).eq("id", crew_id);
      if (linkErr) {
        await db.auth.admin.deleteUser(created.user.id);
        return json({ error: "Could not link the login to the worker.", detail: linkErr.message }, 500);
      }
      return json({ ok: true, staff_id: sid, auth_user_id: created.user.id }, 200);
    }

    // ── reset ───────────────────────────────────────────────────────────
    if (action === "reset") {
      const bad = badPassword(password);
      if (bad) return json({ error: bad }, 400);
      if (!worker.auth_user_id) {
        return json({ error: "This worker has no login yet. Use provision first." }, 409);
      }
      const { error } = await db.auth.admin.updateUserById(worker.auth_user_id, { password });
      if (error) return json({ error: "Could not reset the password.", detail: error.message }, 400);
      return json({ ok: true }, 200);
    }

    // ── unlink ──────────────────────────────────────────────────────────
    // Removes the login but keeps the worker row and all their attendance
    // history — void-not-delete applies to people too.
    if (action === "unlink") {
      if (!worker.auth_user_id) return json({ ok: true, note: "No login to remove." }, 200);
      const { error } = await db.auth.admin.deleteUser(worker.auth_user_id);
      if (error) return json({ error: "Could not remove the login.", detail: error.message }, 400);
      await db.from(tbl).update({ auth_user_id: null }).eq("id", crew_id);
      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: "Unexpected error.", detail: String(e) }, 500);
  }
});
