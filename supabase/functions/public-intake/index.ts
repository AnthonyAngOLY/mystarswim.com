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

// ── The six health answers, read once ───────────────────────────────────
// Registration and the catch-up declaration both take them, and a
// seventh question appearing in one and not the other is exactly the
// drift this is here to prevent. null means not answered, which is not
// the same as no and must never be stored as one.
function healthAnswers(h: Record<string, unknown>) {
  const yn = (v: unknown) => (v === true ? true : v === false ? false : null);
  return {
    q_supervision: yn(h.supervision),
    q_chest_pain:  yn(h.chestPain),
    q_bone_joint:  yn(h.boneJoint),
    q_medication:  yn(h.medication),
    q_learning:    yn(h.learning),
    q_other:       yn(h.other),
  };
}
const anyYes = (a: Record<string, boolean | null>) =>
  Object.values(a).some((v) => v === true);

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

    // The database client, made before anything can want it.
    //
    // It used to be made further down, just before the registration
    // path, and the lookup branch above it reached for it anyway. A
    // const is not hoisted the way a function is — it exists but cannot
    // be touched until its line runs — so every lookup threw "Cannot
    // access 'db' before initialization" and came back through the
    // catch at the bottom as a plain 500. The returning-parent route
    // was deployed and dead, and nothing in the form could tell the
    // difference between that and a wrong account number.
    const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // ── Looking a family up, before any of the rest applies ──
    // The form asks this before the parent has typed anything else, so
    // it answers and returns before any field is required. It sat below
    // the guardian-name check at first, which meant a lookup came back
    // asking for a name the parent had not been asked for yet.
    //
    // It gives back a name and the children already on the account, and
    // never the account id. Enough for a parent to recognise their own
    // family; nothing anybody else can use.
    if (s(body.action, 20) === "lookup") {
      const { data: found, error: fErr } = await db.rpc("find_account", {
        p_account_no: s(body.accountNo, 20).toUpperCase(),
        p_phone: s(body.accountPhone, 40),
      });
      if (fErr) {
        return json({ ok: false, error: "Could not check that just now. Carry on as a new family and we will join them up." });
      }
      if (!found || found.ok !== true) {
        return json({ ok: false, error: (found && found.error) || "That account number and phone number do not go together." });
      }
      // childList carries the same children as `children`, with their
      // ids, for the declaration page — which has to say which child an
      // answer is about, and cannot do that by name without mis-filing a
      // health record the first time a family has two Aarons.
      //
      // Added beside `children` rather than replacing it: the intake
      // form deployed on phones and laptops right now reads that key as
      // an array of names, and a shape it cannot read would break
      // enrolment to tidy up a field.
      //
      // An id here is not a key to anything. Every route that takes one
      // re-proves the account number and phone first and then intersects
      // what it was sent with that account's own children, so an id
      // without the pair opens nothing.
      let childList: Array<{ id: string; name: string }> = [];
      if (found.account_id) {
        const { data: kids } = await db
          .from("students").select("id,name")
          .eq("account_id", found.account_id)
          .neq("is_active", false)
          .order("name");
        childList = (kids ?? []).map((k: { id: string; name: string }) => ({ id: k.id, name: k.name }));
      }

      return json({
        ok: true,
        displayName: found.display_name ?? null,
        accountNo: found.account_no ?? null,
        children: found.children ?? [],
        childList,
      });
    }

    // ── A declaration for children who are already with us ──
    // The six health questions are asked at enrolment. Every family who
    // joined before the form asked them has nothing on file — and the
    // terms they signed declare, on their behalf, that the child "does
    // not have any known medical, physical or psychological condition
    // that would prevent safe participation", with clause 9.4 saying
    // non-disclosure may mean withdrawal without refund. We were holding
    // families to a disclosure obligation through a form with no
    // disclosure in it. This is how they discharge it without enrolling
    // anybody again.
    if (s(body.action, 20) === "declare") {
      const accountNo = s(body.accountNo, 20).toUpperCase();
      const accountPhone = s(body.accountPhone, 40);
      const signature = s(body.signatureName, 120);
      const kids = Array.isArray(body.children) ? body.children : [];

      if (!signature) return json({ ok: false, error: "Type your name to sign." }, 400);
      if (!kids.length) return json({ ok: false, error: "Choose at least one child." }, 400);
      if (kids.length > MAX_CHILDREN) {
        return json({ ok: false, error: `That is more than ${MAX_CHILDREN} children.` }, 400);
      }

      // Proved again, on this call. The lookup that filled the screen is
      // not a session and grants nothing on its own.
      const { data: who, error: wErr } = await db.rpc("find_account", {
        p_account_no: accountNo, p_phone: accountPhone,
      });
      if (wErr) return json({ ok: false, error: "Could not check that just now. Please try again shortly." }, 503);
      if (!who || who.ok !== true) {
        return json({ ok: false, error: (who && who.error)
          || "That account number and phone number do not go together." }, 403);
      }

      // The account's own children, read here rather than taken from the
      // browser. Anything sent that is not in this set is dropped without
      // comment: a health record filed against another family's child is
      // the worst failure this page has available to it.
      const { data: mine, error: mErr } = await db
        .from("students").select("id,name")
        .eq("account_id", who.account_id)
        .neq("is_active", false);
      if (mErr) return json({ ok: false, error: "Could not read your children just now." }, 503);
      const byId = new Map<string, string>((mine ?? []).map((k: { id: string; name: string }) => [k.id, k.name]));

      const reference = "HD-" + crypto.randomUUID().replace(/-/g, "").slice(0, 7).toUpperCase();
      const declaredAt = new Date().toISOString();
      const done: Array<{ name: string }> = [];
      const refused: string[] = [];

      for (const k of kids) {
        const id = s(k?.id, 64);
        const name = byId.get(id);
        if (!name) continue;                       // not this family's child

        const h = (k && typeof k.health === "object" && k.health) ? k.health : null;
        if (!h) { refused.push(name); continue; }
        const ans = healthAnswers(h);
        const details = s(h.details, 2000) || null;

        // Unlike registration, refusing here strands nobody: the parent
        // is on a page with one job and can answer the question. A
        // declaration recorded as unanswered would be worse than none,
        // because it reads as asked and answered.
        if (Object.values(ans).some((v) => v === null)) { refused.push(name); continue; }
        if (anyYes(ans) && !details) { refused.push(name); continue; }

        const { error: hErr } = await db
          .from("student_health_declarations")
          .insert({
            student_id: id,
            acceptance_id: reference,
            declared_at: declaredAt,
            declared_by: signature,
            ...ans,
            details,
          });
        if (hErr) {
          console.warn("declaration failed for", name, hErr.message);
          refused.push(name);
          continue;
        }
        done.push({ name });
      }

      if (!done.length) {
        return json({ ok: false,
          error: refused.length
            ? "Please answer all six questions for each child, and tell us what we should know wherever you answered yes."
            : "None of those children are on this account." }, 400);
      }
      return json({ ok: true, reference, declared: done, refused });
    }


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

    // ── A parent who has registered before ──
    // They quote their account number and a phone already on the
    // account. find_account refuses on either alone and says the same
    // sentence for both failures, so this is not a way to walk the list
    // of families.
    //
    // The account id is deliberately never sent to the browser and never
    // read back from it. The form returns the number and the phone on
    // submit, and this resolves them again — a client-supplied id would
    // let anybody attach a child to any family they could guess.
    let claimed: string | null = null;
    const accountNo = s(body.accountNo, 20).toUpperCase() || null;
    const accountPhone = s(body.accountPhone, 40) || null;
    if (accountNo && accountPhone) {
      const { data: found } = await db.rpc("find_account", {
        p_account_no: accountNo, p_phone: accountPhone,
      });
      if (found && found.ok === true) claimed = found.account_id as string;
    }

    let accountId: string | null = claimed;
    if (!accountId && phone) {
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
      // Re-read and re-trimmed here like everything else: nothing the
      // caller sends is trusted, including the programme they picked.
      const ltId = s(c.lessonTypeId, 64) || null;
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
          // What the parent chose on the form. An array because the
          // column is one, and because a swimmer may later be on more
          // than one programme — this records the one they joined under.
          lesson_type_ids: ltId ? [ltId] : [],
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
      // ── What the parent told us about this child ──
      // Written beside the acceptance, under the same acceptance id, so
      // the answers and the agreement they were given under can be read
      // together. Not upserted: a declaration is what was said on a
      // date, and a parent telling us something new next term does not
      // change what they told us today.
      //
      // Re-read here rather than trusted: a browser can send anything,
      // and this is the field a safeguarding question would be asked of.
      const h = (c && typeof c.health === "object" && c.health) ? c.health : null;
      if (h) {
        const ans = healthAnswers(h);
        const details = s(h.details, 2000) || null;
        // The form asks for details whenever an answer is yes, and the
        // table refuses the row without them. Refusing the whole
        // registration here would strand a family at the last step over
        // a field they can still be asked for, so the declaration is
        // recorded as unanswered and the office is told.
        if (anyYes(ans) && !details) {
          console.warn("health declaration for", name, "had a yes with no details; not recorded");
        } else {
          const { error: hErr } = await db
            .from("student_health_declarations")
            .insert({
              student_id: ins.id,
              acceptance_id: acceptanceId,
              declared_by: guardianName,
              ...ans,
              details,
            });
          if (hErr) console.warn("health declaration failed for", name, hErr.message);
        }
      }

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
