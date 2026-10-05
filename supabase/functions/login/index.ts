// ─────────────────────────────────────────────────────────────────────────
// Edge Function: login  (Phase 0 of RLS hardening)
//
// Verifies staff credentials against app_users using the SERVICE ROLE, so the
// browser never reads password_hash / password_salt. Returns a safe profile
// plus a signed session token (HS256, HMAC over SESSION_JWT_SECRET) that the
// admin-users function checks for privileged operations.
//
// Deploy:  supabase functions deploy login
// Secrets: SESSION_JWT_SECRET (long random). SUPABASE_URL and
//          SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
//
// This function is PUBLIC (it takes credentials); it must be callable with the
// anon key. It performs its own credential check — the anon key grants nothing.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SESSION_SECRET = Deno.env.get("SESSION_JWT_SECRET")!;
const SESSION_TTL_S = 7 * 24 * 60 * 60; // 7 days — matches AUTH_TTL_MS in app.js

// Phase 2: scheduler logins are mirrored into Supabase Auth so the app can
// send a real JWT instead of the shared anon key. Usernames map to the same
// unroutable internal domain the worker app uses; no mail is ever sent there.
const EMAIL_DOMAIN = "staff.mystarswim.internal";
const ADMIN_ROLES = ["sysadmin", "schedule_admin", "admin"];

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

async function sha256Hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

// Sign a compact JWT (HS256). Kept dependency-free via Web Crypto.
async function signSession(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...claims, iat: now, exp: now + SESSION_TTL_S };
  const data = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}

// ── Phase 2: mirror this login into Supabase Auth ────────────────────────
//
// Called only AFTER the app_users credentials have already been verified, so
// the password handed in here is known-good. That is what makes a lazy
// migration possible: existing hashes cannot be reversed, but at this exact
// moment we hold the plaintext the user just typed, so we can stand up their
// Auth user without resetting anything.
//
// Self-healing: if an admin changes the app_users password through the
// user-management panel, the two drift apart. The next successful login
// detects the failed Auth sign-in and resets the Auth password to match.
//
// Every failure path returns null. A login must NEVER fail because the Auth
// mirror had a problem — the caller falls back to a session without a JWT,
// and only the newer RLS-protected screens are unavailable.
async function mirrorToSupabaseAuth(
  admin: ReturnType<typeof createClient>,
  user: { id: string; username: string; role: string; auth_user_id?: string | null },
  password: string,
): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const email = `${user.username.toLowerCase().replace(/\s+/g, "")}@${EMAIL_DOMAIN}`;
    const appMeta = { ssb_role: user.role, app_user_id: user.id };
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

    // Fast path: the Auth user already exists and the passwords still agree.
    if (user.auth_user_id) {
      const first = await anon.auth.signInWithPassword({ email, password: password });
      if (first.data?.session) {
        // Keep the role claim current; a promotion must reach the JWT.
        await admin.auth.admin.updateUserById(user.auth_user_id, { app_metadata: appMeta });
        return {
          access_token: first.data.session.access_token,
          refresh_token: first.data.session.refresh_token,
        };
      }
      // Passwords drifted — realign Auth to app_users, then retry once.
      await admin.auth.admin.updateUserById(user.auth_user_id, {
        password: password,
        app_metadata: appMeta,
      });
      const retry = await anon.auth.signInWithPassword({ email, password: password });
      return retry.data?.session
        ? {
          access_token: retry.data.session.access_token,
          refresh_token: retry.data.session.refresh_token,
        }
        : null;
    }

    // First login since Phase 2 shipped: create the Auth user now.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password: password,
      email_confirm: true, // the address is unroutable; there is no inbox to confirm
      app_metadata: appMeta,
      user_metadata: { username: user.username },
    });

    let authUserId = created?.user?.id ?? null;

    // An Auth user may already exist from an earlier partial run even though
    // app_users never recorded it. Recover by finding and realigning it
    // rather than leaving this person permanently unable to get a JWT.
    if (createErr || !authUserId) {
      const found = await findAuthUserByEmail(admin, email);
      if (!found) return null;
      authUserId = found;
      await admin.auth.admin.updateUserById(authUserId, {
        password: password,
        app_metadata: appMeta,
      });
    }

    await admin.from("app_users").update({ auth_user_id: authUserId }).eq("id", user.id);

    const { data: signed } = await anon.auth.signInWithPassword({
      email,
      password: password,
    });
    return signed?.session
      ? {
        access_token: signed.session.access_token,
        refresh_token: signed.session.refresh_token,
      }
      : null;
  } catch (_e) {
    return null; // never block the login
  }
}

// listUsers is paginated and has no email filter in supabase-js v2, so page
// through it. Staff counts are in the dozens; this stops well short of abuse.
async function findAuthUserByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { username, password } = await req.json().catch(() => ({}));
    const u = (username ?? "").toString().trim();
    if (!u || !password) return json({ error: "Enter your username and password." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: rows } = await admin
      .from("app_users")
      .select("id, username, display_name, role, is_active, password_salt, password_hash, auth_user_id")
      .eq("username", u)
      .eq("is_active", true)
      .limit(1);

    const user = rows?.[0];
    // Always compute a hash (even when the user is missing) to flatten the
    // timing difference between "no such user" and "wrong password".
    const salt = user?.password_salt ?? "";
    const hash = await sha256Hex(salt + password);
    if (!user || hash !== user.password_hash) {
      return json({ error: "Incorrect username or password." }, 401);
    }

    // Best-effort last-login stamp; awaited so it actually runs before the
    // isolate returns, but a failure here never blocks the login result.
    try {
      await admin.from("app_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);
    } catch (_e) { /* ignore — stamping last_login is non-critical */ }

    const profile = {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role || "staff",
    };
    const token = await signSession({ sub: user.id, username: user.username, role: profile.role });

    // Phase 2: hand back a real Supabase session alongside the legacy one, so
    // the app can talk to RLS-protected tables as `authenticated` instead of
    // as the shared anon key. `supabase` is null when the mirror could not be
    // completed; the app treats that as "logged in, newer screens disabled"
    // rather than as a failed login.
    const supabase = await mirrorToSupabaseAuth(
      admin,
      {
        id: user.id,
        username: user.username,
        role: profile.role,
        auth_user_id: user.auth_user_id,
      },
      password,
    );

    return json({ user: profile, token, supabase, isAdmin: ADMIN_ROLES.includes(profile.role) }, 200);
  } catch (_e) {
    return json({ error: "Login failed." }, 500);
  }
});
