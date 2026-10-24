// ─────────────────────────────────────────────────────────────────────────
// Edge Function: admin-users  (Phase 0 of RLS hardening)
//
// Owner-seat management of the app_users table, executed with the SERVICE
// ROLE so the browser never touches app_users directly once Phase 0's RLS lock
// is applied. Every request must carry a valid session token (issued by the
// `login` function) belonging to a `sysadmin` or a `center_owner`.
//
// Actions (POST body { action, ... }):
//   list                                        → users without password fields
//   create   { username, password, displayName, role }
//   reset    { id, newPassword }
//   patch    { id, patch: { role?, is_active?, display_name? } }
//   delete   { id }
//
// Deploy:  supabase functions deploy admin-users
// Secrets: SESSION_JWT_SECRET (same value the login function signs with).
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SESSION_SECRET = Deno.env.get("SESSION_JWT_SECRET")!;

// sysadmin and center_owner are one tier: the same reach under two names,
// because one of them owns the centre and the other keeps the system.
// Anything one may do here, the other may.
const OWNER_ROLES = ["sysadmin", "center_owner"];

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

function randomSalt(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "ss-" + Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Verify an HS256 session token signed by the login function. Returns the
// decoded claims on success, or null on any failure (bad signature, expired).
async function verifySession(token: string): Promise<Record<string, unknown> | null> {
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return null;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (typeof claims.exp === "number" && Math.floor(Date.now() / 1000) >= claims.exp) return null;
    return claims;
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Authorize: valid session token belonging to an owner seat ──
  // sysadmin and center_owner are one tier: same reach, two names, because
  // one of them is the person who owns the centre and the other is the
  // person who keeps the system. Anything one may do here, the other may.
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const claims = token ? await verifySession(token) : null;
  if (!claims) return json({ error: "Not authenticated." }, 401);
  if (!OWNER_ROLES.includes(String(claims.role))) {
    return json({ error: "Sysadmin or Centre Owner access required." }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  try {
    const body = await req.json().catch(() => ({}));
    const action = (body.action ?? "").toString();

    if (action === "list") {
      const { data, error } = await admin
        .from("app_users")
        .select("id, username, display_name, role, is_active, created_at, last_login_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return json({ users: data ?? [] }, 200);
    }

    if (action === "create") {
      const username = (body.username ?? "").toString().trim();
      const password = (body.password ?? "").toString();
      if (!username || !password) return json({ error: "Username and password are required." }, 400);
      const salt = randomSalt();
      const hash = await sha256Hex(salt + password);
      const { error } = await admin.from("app_users").insert({
        username,
        password_salt: salt,
        password_hash: hash,
        display_name: (body.displayName ?? "").toString().trim() || username,
        role: (body.role ?? "admin").toString(),
        is_active: true,
      });
      if (error) throw error;
      return json({ ok: true }, 200);
    }

    if (action === "reset") {
      const id = body.id;
      const newPassword = (body.newPassword ?? "").toString();
      if (!id || !newPassword) return json({ error: "id and newPassword are required." }, 400);
      const salt = randomSalt();
      const hash = await sha256Hex(salt + newPassword);
      const { error } = await admin
        .from("app_users")
        .update({ password_salt: salt, password_hash: hash })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true }, 200);
    }

    if (action === "patch") {
      const id = body.id;
      const patch = body.patch ?? {};
      if (!id || typeof patch !== "object") return json({ error: "id and patch are required." }, 400);
      // Whitelist mutable fields — never let the client patch password material
      // or arbitrary columns through this path.
      const allowed: Record<string, unknown> = {};
      if (typeof patch.role === "string") allowed.role = patch.role;
      if (typeof patch.is_active === "boolean") allowed.is_active = patch.is_active;
      if (typeof patch.display_name === "string") allowed.display_name = patch.display_name;
      if (Object.keys(allowed).length === 0) return json({ error: "No permitted fields to update." }, 400);
      const { error } = await admin.from("app_users").update(allowed).eq("id", id);
      if (error) throw error;
      return json({ ok: true }, 200);
    }

    if (action === "delete") {
      const id = body.id;
      if (!id) return json({ error: "id is required." }, 400);
      // Guard: never let a sysadmin delete their own account out from under them.
      if (id === claims.sub) return json({ error: "You cannot delete your own account." }, 400);
      const { error } = await admin.from("app_users").delete().eq("id", id);
      if (error) throw error;
      return json({ ok: true }, 200);
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ error: (e as Error)?.message || "Request failed." }, 500);
  }
});
