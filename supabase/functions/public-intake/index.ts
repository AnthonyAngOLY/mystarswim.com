// ─────────────────────────────────────────────────────────────────────────
// Edge Function: public-intake
//
// The ONLY writer of students and tc_acceptances from the public website.
// The intake form used to do three writes of its own with the anon key —
// insert the children, upsert the T&C acceptance, then patch the children
// back with the acceptance id. That meant anyone holding the anon key,
// which is printed in every page we serve, could create and edit student
// records at will. It also meant students could never be locked down,
// because locking it would have taken enrolment down with it.
//
// Everything that form did now happens here, behind the service role, in
// one call. The public key keeps no write access to either table.
//
// It also fixes something the form got wrong in a quieter way. It minted
// a fresh random account_id for every submission, so a parent enrolling a
// second child months later became a second family. That was harmless
// while account_id grouped rows on a screen. It is not harmless now that
// a parent account decides who may see which children, so this looks for
// an existing account by phone number and joins the children to it.
//
// What it will not do: trust anything about the caller. Every field is
// re-read and re-trimmed here, the acceptance timestamp is the server's,
// and the account_id the browser sends is ignored entirely.
//
// Deploy:  supabase functions deploy public-intake
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, both injected by
//          the platform. No others.
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

const s = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

// A form submitted by hand holds at most a handful of children. A request
// claiming forty is not a family.
const MAX_CHILDREN = 10;

function ageFromDob(dob: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 120 ? a : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Nothing to register." }, 400);

    const guardianName = s(body.guardianName, 120);
    const guardianPhone = s(body.guardianPhone, 120);
    const children = Array.isArray(body.children) ? body.children : [];

    if (!guardianName) return json({ error: "Enter the parent's full name." }, 400);
    if (!guardianPhone) return json({ error: "Enter a contact number." }, 400);
    if (children.length === 0) return json({ error: "Add at least one swimmer." }, 400);
    if (children.length > MAX_CHILDREN) {
      return json({ error: `That is more than ${MAX_CHILDREN} swimmers in one form.` }, 400);
    }
    for (const c of children) {
      if (!s(c?.name, 120)) return json({ error: "Every swimmer needs a name." }, 400);
    }

    const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ── Which family is this? ──
    // ss_normalise_phone is the database's own reading of a number, so the
    // answer here and the answer the parent app gives at sign-in are the
    // same answer. A number it cannot read means a new account, which is
    // the same as today — and the worklist will pick it up.
    let phone: string | null = null;
    try {
      const { data } = await db.rpc("ss_normalise_phone", { p_raw: guardianPhone });
      phone = typeof data === "string" && data ? data : null;
    } catch (_e) {
      phone = null; // the phone migration has not run; fall through to a new account
    }

    let accountId: string | null = null;
    if (phone) {
      const { data: hit } = await db
        .from("parent_accounts")
        .select("id")
        .or(`phone_primary.eq.${phone},phone_secondary.eq.${phone}`)
        .limit(1)
        .maybeSingle();
      accountId = hit?.id ?? null;
    }

    if (!accountId) {
      const { data: made, error: mkErr } = await db
        .from("parent_accounts")
        .insert({
          display_name: guardianName,
          email: s(body.guardianEmail, 160) || null,
          phone_primary: phone,
        })
        .select("id")
        .single();
      // A race, or a number another account already owns: look again
      // rather than failing the family in front of the form.
      if (mkErr || !made) {
        if (phone) {
          const { data: again } = await db
            .from("parent_accounts").select("id")
            .eq("phone_primary", phone).limit(1).maybeSingle();
          accountId = again?.id ?? null;
        }
        if (!accountId) {
          return json({ error: "Could not start your account. Please call the centre." }, 500);
        }
      } else {
        accountId = made.id;
      }
    }

    // ── The children ──
    const acceptedAt = new Date().toISOString();           // the server's clock
    const ua = s(req.headers.get("user-agent") ?? "", 300) || null;
    const sameAsGuardian = !!body.emergencySameAsGuardian;
    const registered: Array<{ name: string; age: number | null; acceptanceId: string }> = [];

    for (const c of children) {
      const name = s(c.name, 120);
      const dob = s(c.dob, 10) || null;
      const acceptanceId = "TC-" + crypto.randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase();

      const { data: ins, error: insErr } = await db
        .from("students")
        .insert({
          name,
          date_of_birth: dob,
          age: ageFromDob(dob),
          gender: s(c.gender, 20) || null,
          is_active: true,
          account_id: accountId,
          branch_id: s(body.branchId, 64) || null,
          guardian_name: guardianName,
          guardian_email: s(body.guardianEmail, 160),
          guardian_phone: guardianPhone,
          guardian_ic: s(body.guardianIc, 40) || null,
          guardian_tin: s(body.guardianTin, 40) || null,
          emergency_name: s(body.emergencyName, 120),
          emergency_phone: s(body.emergencyPhone, 60),
          emergency_relationship: s(body.emergencyRelationship, 60),
          emergency_same_as_guardian: sameAsGuardian,
          referral_code: s(body.referralCode, 40) || null,
          lesson_type_ids: [],
          // Written here rather than patched afterwards, which is what the
          // third of the form's three writes was for.
          tc_accepted_at: acceptedAt,
          tc_acceptance_id: acceptanceId,
        })
        .select("id")
        .single();

      if (insErr || !ins) {
        return json({
          error: "Could not register " + name + ". Please call the centre.",
          detail: insErr?.message,
          registered,
        }, 500);
      }

      const row: Record<string, unknown> = {
        student_id: ins.id,
        acceptance_id: acceptanceId,
        accepted_at: acceptedAt,
        guardian_name: guardianName,
        guardian_email: s(body.guardianEmail, 160),
        lesson_type_name: null,
        signature_name: s(body.signatureName, 120) || guardianName,
        signed_via: "intake",
        user_agent: ua,
      };
      let { error: tcErr } = await db
        .from("tc_acceptances").upsert(row, { onConflict: "student_id" });
      if (tcErr) {
        // Before the digital-signature migration those three columns do
        // not exist. The acceptance itself still has to be recorded.
        delete row.signature_name; delete row.signed_via; delete row.user_agent;
        ({ error: tcErr } = await db
          .from("tc_acceptances").upsert(row, { onConflict: "student_id" }));
      }
      // A missing acceptance row is worth knowing about, but the child is
      // registered and their acceptance is stamped on their own record.
      if (tcErr) console.warn("tc_acceptances failed for", name, tcErr.message);

      registered.push({ name, age: ageFromDob(dob), acceptanceId });
    }

    return json({ ok: true, registered }, 200);
  } catch (e) {
    return json({ error: (e as Error)?.message || "Registration failed." }, 500);
  }
});
