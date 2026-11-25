// ─────────────────────────────────────────────────────────────────────────
// parent-login — a number and a password, instead of a message.
//
// WHY THIS EXISTS RATHER THAN THE APP CALLING SUPABASE DIRECTLY
// Supabase will verify a phone and password on its own, from the browser,
// with the anon key. Three things it will not do for us:
//
//   The gate. parent-signin refuses a number that is not the active one
//   on its account, or whose family has been archived. A password sign-in
//   straight to Supabase walks around that entirely — an archived family
//   would keep a working password forever, and the sixteen archived
//   accounts would quietly still be customers as far as the app was
//   concerned.
//
//   The count. The anon key is printed in every page we serve, so anyone
//   can post guesses at Supabase's token endpoint. Until there was a
//   password there was nothing to guess. Counting attempts per number,
//   and pushing a number back to SMS after too many, needs somewhere the
//   count survives — which is the database, not this instance's memory.
//
//   The record. The spend log is how "why was the Twilio bill that"
//   gets an answer. A sign-in that costs nothing still belongs in it:
//   the ratio of passwords to codes is the whole point of the exercise.
//
// WHAT IT DELIBERATELY DOES NOT SAY
// One sentence for every refusal that is not "wrong password": unknown
// number, archived account, no account at all. Different answers would
// let somebody learn which numbers belong to Star Swim customers by
// typing them in one at a time.
//
// NOT A LOCKOUT
// After enough wrong tries that number must use a code for its next
// sign-in. The parent is never stranded — the code always works — and
// somebody guessing cannot read it.
//
// Deploy:  supabase functions deploy parent-login
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, both injected by
//          the platform. No others.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// The same three shapes the database accepts, so a parent typing their
// number the way they always write it is the same number either side.
function e164(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("60")) return "+" + d;
  if (d.startsWith("0")) return "+60" + d.slice(1);
  return "+60" + d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let phone = "";
  let password = "";
  try {
    const body = await req.json();
    phone = e164(body?.phone);
    password = String(body?.password ?? "");
  } catch {
    return reply({ error: "Could not read that request." }, 400);
  }

  if (!password) {
    return reply({ error: "Enter your password, or ask us for a code." }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data: gate, error: gErr } = await db.rpc("parent_login_check", { p_phone: phone });
  if (gErr) {
    console.error("gate failed", gErr.message);
    return reply({ error: "We could not sign you in just now. Please try again." }, 500);
  }
  if (!gate || gate.ok !== true) {
    return reply({
      must_use_code: gate?.must_use_code === true,
      error: gate?.error ?? "That number and password do not match.",
    }, gate?.must_use_code === true ? 429 : 401);
  }

  // Supabase verifies the password. We never see or store one, and no
  // hashing happens here — that is exactly the part worth not writing.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON || SERVICE_ROLE, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });

  if (!res.ok) {
    const { data: rec } = await db.rpc("parent_login_record", { p_phone: phone, p_ok: false });
    // How many tries are left, so the screen can warn before the last
    // one rather than surprising a parent with "ask us for a code".
    return reply({
      error: "That number and password do not match. If this is your first "
           + "time, or you have forgotten it, ask us for a code.",
      tries_left: rec?.left,
      must_use_code: rec?.must_use_code === true,
    }, 401);
  }

  const session = await res.json();
  // try/catch, not .catch() on the builder: db.rpc() returns a thenable
  // with a then and no catch, so calling .catch throws -- and it would
  // throw here after the sign-in had already succeeded, losing the
  // session the parent just earned.
  try {
    await db.rpc("parent_login_record", { p_phone: phone, p_ok: true });
  } catch (e) {
    console.error("could not record the sign-in", e);
  }

  // Only the two tokens. The rest of what Supabase returns is about the
  // auth user, and the app reads the family through my_family() with the
  // session it is handed.
  return reply({
    ok: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
});
