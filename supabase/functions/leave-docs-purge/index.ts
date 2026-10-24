// ─────────────────────────────────────────────────────────────────────────
// Edge Function: leave-docs-purge  (Star Swim)
//
// Deletes medical certificates and death certificates once their retention
// period has passed. The leave RECORD stays — dates, kind, who decided it,
// their note. Only the image goes, because only the image is sensitive.
//
// Deletion goes through the storage API rather than SQL. Removing a row from
// storage.objects makes a file unreachable but leaves the bytes sitting in
// the bucket, and "unreachable" is not what the PDPA means by deleted.
//
// Two things are cleaned:
//   1. Documents attached to an application older than the retention period.
//      The application keeps everything except its document_path.
//   2. Uploads with no application behind them. An upload happens before the
//      form is submitted, so a worker who changes their mind leaves a file
//      nobody will ever look at. Given a month's grace, then removed.
//
// Dry run by default. Pass { "commit": true } to actually delete.
//
// WHO MAY CALL IT. Leave "Verify JWT" ON in the dashboard, but do not mistake
// that for the gate: it is satisfied by the anon key, which ships to every
// browser in config.js. A function that permanently deletes records has to
// know who is asking, so it checks for itself — the service role key, which
// is what the cron job presents, or a signed-in sysadmin or Centre Owner —
// one tier under two names. Nobody else, and a
// dry run is no exception: what it reports is a map of what is held.
//
// Deploy:  supabase functions deploy leave-docs-purge
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected.
// ─────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "leave-docs";
const ORPHAN_GRACE_DAYS = 30;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Every object in the bucket, walked folder by folder. The API lists one
// prefix at a time, and each worker's documents live under their crew id.
async function listAll(): Promise<{ path: string; created_at: string }[]> {
  const out: { path: string; created_at: string }[] = [];
  const { data: folders, error } = await db.storage.from(BUCKET)
    .list("", { limit: 1000 });
  if (error) throw new Error(`Could not list the bucket: ${error.message}`);

  for (const f of folders ?? []) {
    // A folder entry has no id; a file at the root would have one.
    if (f.id) { out.push({ path: f.name, created_at: f.created_at }); continue; }
    let offset = 0;
    for (;;) {
      const { data: files, error: e2 } = await db.storage.from(BUCKET)
        .list(f.name, { limit: 1000, offset });
      if (e2) throw new Error(`Could not list ${f.name}: ${e2.message}`);
      for (const x of files ?? []) out.push({ path: `${f.name}/${x.name}`, created_at: x.created_at });
      if (!files || files.length < 1000) break;
      offset += files.length;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // ── Who is asking ───────────────────────────────────────────────────
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer) return json({ error: "Not signed in." }, 401);

    let allowed = false;
    // The scheduled job, presenting the service role key.
    if (bearer === SERVICE_ROLE) {
      allowed = true;
    } else {
      const { data: userData } = await db.auth.getUser(bearer);
      const role = String(
        (userData?.user?.app_metadata as Record<string, unknown> | null)?.ssb_role ?? "");
      allowed = role === "sysadmin" || role === "center_owner";
    }
    if (!allowed) {
      return json({ error: "Only a sysadmin, the Centre Owner, or the scheduled job, "
                          + "can run this." }, 403);
    }

    const body = await req.json().catch(() => ({})) as { commit?: boolean };
    const commit = body.commit === true;

    // How long documents are kept, from the settings row so it is changed in
    // one place rather than in this file.
    const { data: settings } = await db
      .from("attendance_settings").select("leave_doc_retention_months").single();
    const months = Number(settings?.leave_doc_retention_months ?? 60);
    if (!Number.isFinite(months) || months < 1) {
      return json({ error: "leave_doc_retention_months is not a sensible number." }, 500);
    }

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const orphanCutoff = new Date(Date.now() - ORPHAN_GRACE_DAYS * 86400000);

    // 1. Documents whose application is past its retention.
    const { data: expired, error: qErr } = await db
      .from("leave_requests")
      .select("id, document_path, applied_at")
      .not("document_path", "is", null)
      .lt("applied_at", cutoff.toISOString());
    if (qErr) return json({ error: "Could not read the applications.", detail: qErr.message }, 500);

    const expiredPaths = (expired ?? []).map((r) => r.document_path as string);

    // 2. Uploads no application ever claimed.
    const everything = await listAll();
    const { data: live } = await db
      .from("leave_requests").select("document_path").not("document_path", "is", null);
    const claimed = new Set((live ?? []).map((r) => r.document_path as string));
    const orphans = everything
      .filter((o) => !claimed.has(o.path) && new Date(o.created_at) < orphanCutoff)
      .map((o) => o.path);

    const toDelete = Array.from(new Set([...expiredPaths, ...orphans]));

    if (!commit) {
      return json({
        dry_run: true,
        retention_months: months,
        cutoff: cutoff.toISOString().slice(0, 10),
        in_bucket: everything.length,
        expired: expiredPaths.length,
        orphaned: orphans.length,
        would_delete: toDelete.length,
        note: 'Nothing was deleted. Send { "commit": true } to carry it out.',
      }, 200);
    }

    let removed = 0;
    // In batches: one oversized request that fails takes the whole run with it.
    for (let i = 0; i < toDelete.length; i += 100) {
      const batch = toDelete.slice(i, i + 100);
      const { error } = await db.storage.from(BUCKET).remove(batch);
      if (error) return json({ error: "Deletion stopped.", removed, detail: error.message }, 500);
      removed += batch.length;
    }

    // Only once the files are actually gone. Clearing the path first would
    // leave a file nothing points at if the deletion then failed.
    let cleared = 0;
    for (const r of expired ?? []) {
      const { error } = await db.from("leave_requests")
        .update({ document_path: null, updated_at: new Date().toISOString() })
        .eq("id", r.id);
      if (!error) cleared++;
    }

    return json({
      dry_run: false,
      retention_months: months,
      cutoff: cutoff.toISOString().slice(0, 10),
      deleted: removed,
      applications_cleared: cleared,
      orphans_removed: orphans.length,
    }, 200);
  } catch (e) {
    return json({ error: "Unexpected error.", detail: String(e) }, 500);
  }
});
