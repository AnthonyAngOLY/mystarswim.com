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
// RATE LIMITED, AND LOGGED, IN THE DATABASE
// The check is cheap but not free, and a known number could still be
// used to spray messages at a real customer. A cooldown between codes,
// a cap per hour and a cap per day, all counted in parent_otp_sends
// where they survive this function being recycled, and all adjustable
// from the admin screen. Every attempt is a row, refusals included:
// a run of them against numbers that are not ours is what probing
// looks like, and it is invisible if only successes are written.
//
// Deploy:  supabase functions deploy parent-signin
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, both injected by
//          the platform. No others.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// How the code travels. SMS, because SMS is what is registered: an
// international long code, a Messaging Service, and a Supabase Phone
// provider holding Twilio credentials. There is no WhatsApp sender.
//
// This said "whatsapp" for months, which was the intention at the time
// and never became true. Asking Twilio for a channel it has no sender
// for does not fail cleanly — the request can be accepted and dropped
// after the fact, so Supabase answers 200, this function reports
// success, the app tells a parent their code is on its way, and nothing
// ever arrives. A default that lies is worse than one that is merely
// wrong, because the failure it produces looks like somebody else's.
//
// Set PARENT_OTP_CHANNEL to "whatsapp" to switch, once a WhatsApp sender
// is actually registered and tested. Not before.
const CHANNEL = (Deno.env.get("PARENT_OTP_CHANNEL") ?? "sms").toLowerCase();

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

// The gate and the caps live in the database now, in
// parent_signin_check(). They were here, in a Map held in this
// instance's memory, and Supabase recycles instances: the count went
// with them, so "six an hour" was really six per instance lifetime,
// which can be minutes. A limit that resets when the platform feels
// like it is not a limit.
//
// Moving it also put the gate and the log in the same transaction as
// the decision, so two requests arriving together cannot both read a
// count below the cap and both send.

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

  // One call decides everything and records the attempt: the active
  // number only, on an account with at least one active swimmer, inside
  // the cooldown and the hourly and daily caps. The words of every
  // refusal come from there too, so the rule and what a parent is told
  // cannot drift apart.
  const { data: gate, error } = await db.rpc("parent_signin_check", { p_phone: phone });

  if (error) {
    console.error("gate failed", error.message);
    return reply({ error: "We could not check that just now. Please try again." }, 500);
  }
  if (!gate || gate.ok !== true) {
    // An unknown number and an archived account answer identically, by
    // design: telling them apart tells somebody trying numbers which
    // ones are real. 429 only where waiting is the remedy.
    const status = gate && gate.known === true ? 429 : 200;
    return reply({
      known: (gate && gate.known) === true,
      wait_sec: gate ? gate.wait_sec : undefined,
      error: (gate && gate.error) ||
        "We could not send a code just now. Please try again shortly.",
    }, status);
  }

  // Known, and allowed. Now ask Supabase to send the code. create_user is
  // true here and only here: this request has already been checked
  // against the centre's own records, which is the thing Supabase cannot
  // do for us.
  async function send(channel: string) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: ANON || SERVICE_ROLE, "Content-Type": "application/json" },
      body: JSON.stringify({ phone, create_user: true, channel }),
    });
    return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
  }

  let out = await send(CHANNEL);

  // Only ever a fallback OUT of WhatsApp, never into it. A parent with no
  // WhatsApp is uncommon in Ipoh and not imaginary, and one SMS costs
  // more than one WhatsApp and far less than a family locked out.
  //
  // With the default above this branch does not run at all, and that is
  // correct: there is nowhere to fall back to from SMS. If SMS fails,
  // the send failed, and saying so is the only honest answer.
  let usedChannel = CHANNEL;
  if (!out.ok && CHANNEL === "whatsapp") {
    console.error("whatsapp send failed, falling back to sms", out.status, out.text);
    out = await send("sms");
    usedChannel = "sms";
  }

  // What Twilio was actually asked to do, against the row the gate
  // wrote. Without this the log says a message was allowed and never
  // whether it went, which is the half that explains a bill.
  //
  // try/catch, NOT .catch() on the builder. db.rpc() returns a thenable
  // that implements then and nothing else, so .catch is undefined and
  // calling it throws -- after the message has gone. The function then
  // died on the line below the send, the platform returned a 500 with
  // none of the CORS headers above it, and a phone reported that it
  // could not reach us. The parent got their code and was told the
  // opposite.
  //
  // Recording this must never be able to fail the request: the message
  // has already left, and losing the log line is better than telling a
  // parent nothing was sent.
  try {
    await db.rpc("parent_signin_sent", {
      p_log: gate.log_id,
      p_ok: out.ok,
      p_channel: usedChannel,
      p_error: out.ok ? null : `${out.status} ${out.text}`.slice(0, 500),
    });
  } catch (e) {
    console.error("could not record the send", e);
  }

  if (!out.ok) {
    console.error("otp send failed", out.status, out.text);
    return reply({
      known: true,
      error: "We could not send a code just now. Please try again shortly.",
    }, 502);
  }

  return reply({ known: true, phone, channel: usedChannel,
                 cooldown_sec: gate.cooldown_sec });
});
