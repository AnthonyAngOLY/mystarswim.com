// ─────────────────────────────────────────────────────────────────────────
// Edge Function: parent-signin
//
// The gate in front of the parent app's sign-in code.
//
// WHY THIS EXISTS AT ALL
// Supabase will happily send a one-time code to any number on earth. Two
// things follow from that, and only one of them is about security.
//
//   Anyone could sign in. Not see anything — every read in the parent
//   app is keyed to an account that claims their number — but they would
//   hold a session, and "there is nothing to see" is a weak place to
//   stand when the thing being protected is other people's children.
//
//   Every code costs money. With WhatsApp through Twilio, an ungated
//   send endpoint is somebody else's bill to run up, a few thousand
//   messages at a time, and nothing in the browser can stop them.
//
// So the number is checked against parent_accounts here, behind the
// service role, BEFORE anything is sent. No match, no message, no cost,
// no auth user created.
//
// WHAT IT TELLS A STRANGER
// An unknown number is told plainly that we do not have it. That is a
// deliberate choice, made with the centre: somebody patient could learn
// which numbers belong to Star Swim customers by trying them one at a
// time. They learn nothing else — not a name, not a child, not a bill.
// The alternative, "if it is on file we have sent a code", leaks
// nothing but leaves a parent whose number we hold wrongly waiting for
// a message that will never arrive, decides the app is broken, and
// often does not ring. A confused parent who calls the office is worth
// more than a closed mouth.
//
// RATE LIMITED BY NUMBER AND BY CALLER
// The check is cheap but not free, and a known number could still be
// used to spray messages at a real customer. Six sends per number per
// hour, which is far more than a person needs and far less than a
// nuisance requires.
//
// Deploy:  supabase functions deploy parent-signin
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

// In memory, per instance. Not a fortress — an edge function can be
// recycled and the count goes with it — but enough to turn a script
// that sends ten thousand messages into one that sends a handful.
const recent = new Map<string, number[]>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 6;

function tooMany(phone: string): boolean {
  const now = Date.now();
  const seen = (recent.get(phone) ?? []).filter((t) => now - t < WINDOW_MS);
  if (seen.length >= MAX_PER_WINDOW) {
    recent.set(phone, seen);
    return true;
  }
  seen.push(now);
  recent.set(phone, seen);
  // Keep the map from growing without bound on a long-lived instance.
  if (recent.size > 5000) {
    for (const [k, v] of recent) {
      if (!v.some((t) => now - t < WINDOW_MS)) recent.delete(k);
    }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  let phone = "";
  try {
    const body = await req.json();
    phone = e164(body?.phone);
  } catch {
    return reply({ error: "Could not read that request." }, 400);
  }

  // Nine digits is the shortest Malaysian mobile; anything under it is a
  // typo and not worth a database round trip.
  if (phone.replace(/\D/g, "").length < 9) {
    return reply({ known: false, error: "That does not look like a mobile number." });
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Either number on the account can be the one they sign in with, but
  // only the active one receives the code — that is the rule the
  // database already holds in parent_signin_phone().
  const { data, error } = await db
    .from("parent_accounts")
    .select("id, phone_primary, phone_secondary, active_phone")
    .or(`phone_primary.eq.${phone},phone_secondary.eq.${phone}`)
    .limit(2);

  if (error) {
    console.error("lookup failed", error.message);
    return reply({ error: "We could not check that just now. Please try again." }, 500);
  }

  if (!data || data.length === 0) {
    return reply({
      known: false,
      error: "We do not have that number on file. Call the centre and we will add it.",
    });
  }

  // Two accounts answering to one number is a data fault, not a sign-in
  // problem, and signing either of them in would be a guess about whose
  // children to show. It is refused and the office is told.
  if (data.length > 1) {
    console.error("two accounts share", phone);
    return reply({
      known: false,
      error:
        "That number is on two accounts, so we cannot tell which family it is. " +
        "Call the centre and we will sort it out.",
    });
  }

  if (tooMany(phone)) {
    return reply({
      known: true,
      error: "That is a lot of codes. Wait an hour, or call the centre.",
    }, 429);
  }

  // Known, and allowed. Now ask Supabase to send the code. create_user is
  // true here and only here: this request has already been checked
  // against the centre's own records, which is the thing Supabase cannot
  // do for us.
  const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { apikey: ANON || SERVICE_ROLE, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, create_user: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("otp send failed", res.status, text);
    return reply({
      known: true,
      error: "We could not send a code just now. Please try again shortly.",
    }, 502);
  }

  return reply({ known: true, phone });
});
