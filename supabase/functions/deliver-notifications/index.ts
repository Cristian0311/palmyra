import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function localMinutes(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

function isQuietNow(date: Date, timezone: string, start: string, end: string) {
  const now = localMinutes(date, timezone);
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const from = sh * 60 + sm;
  const to = eh * 60 + em;
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

function nextQuietEnd(date: Date, timezone: string, end: string) {
  const [eh, em] = end.split(":").map(Number);
  const target = eh * 60 + em;
  for (let offset = 1; offset <= 26 * 60; offset++) {
    const candidate = new Date(date.getTime() + offset * 60_000);
    if (localMinutes(candidate, timezone) === target) return candidate.toISOString();
  }
  return new Date(date.getTime() + 8 * 60 * 60_000).toISOString();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return response({ error: "Supabase worker credentials are unavailable." }, 503);
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: secrets, error: secretError } = await supabase.rpc("get_notification_worker_secrets");
  if (secretError || !secrets) return response({ error: "Could not load notification secrets from Vault." }, 503);
  const workerSecret = secrets.worker_secret;
  if (!workerSecret || req.headers.get("x-worker-secret") !== workerSecret) return response({ error: "Worker authentication failed." }, 401);
  const publicKey = secrets.vapid_public_key;
  const privateKey = secrets.vapid_private_key;
  const subject = secrets.vapid_subject || "mailto:support@palmyracrm.com";
  if (!publicKey || !privateKey) return response({ error: "VAPID keys are not configured." }, 503);
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const now = new Date();
  const { data: jobs, error: queueError } = await supabase
    .from("notification_outbox")
    .select("id,company_id,recipient_user_id,notification_id,event_type,payload,dedupe_key,priority,attempts")
    .in("status", ["pending", "failed"])
    .lte("available_at", now.toISOString())
    .lte("scheduled_at", now.toISOString())
    .order("created_at", { ascending: true })
    .limit(50);
  if (queueError) return response({ error: "Could not read notification queue.", detail: queueError.message }, 500);

  let sent = 0;
  let suppressed = 0;
  let deferred = 0;
  let failed = 0;

  for (const job of jobs || []) {
    const { data: claim, error: claimError } = await supabase
      .from("notification_outbox")
      .update({ status: "processing", locked_at: now.toISOString(), attempts: (job.attempts || 0) + 1, updated_at: now.toISOString() })
      .eq("id", job.id)
      .in("status", ["pending", "failed"])
      .select("id")
      .maybeSingle();
    if (claimError || !claim) continue;

    try {
      const [{ data: preference }, { data: subscriptions, error: subscriptionError }] = await Promise.all([
        supabase.from("notification_preferences").select("*")
          .eq("company_id", job.company_id).eq("user_id", job.recipient_user_id).maybeSingle(),
        supabase.from("push_subscriptions").select("id,endpoint,p256dh,auth_secret")
          .eq("company_id", job.company_id).eq("user_id", job.recipient_user_id).eq("enabled", true),
      ]);
      if (subscriptionError) throw subscriptionError;

      const critical = job.priority === "critical";
      if (preference?.push_enabled === false || (critical && preference?.critical_push_enabled === false)) {
        await supabase.from("notification_outbox").update({ status: "suppressed", updated_at: new Date().toISOString() }).eq("id", job.id);
        suppressed++;
        continue;
      }

      const timezone = preference?.timezone || "America/Havana";
      if (!critical && preference?.quiet_hours_enabled !== false && isQuietNow(new Date(), timezone, preference?.quiet_hours_start || "22:00", preference?.quiet_hours_end || "08:00")) {
        const scheduled = nextQuietEnd(new Date(), timezone, preference?.quiet_hours_end || "08:00");
        await supabase.from("notification_outbox").update({ status: "pending", scheduled_at: scheduled, available_at: scheduled, locked_at: null, updated_at: new Date().toISOString() }).eq("id", job.id);
        deferred++;
        continue;
      }

      if (!subscriptions?.length) {
        await supabase.from("notification_outbox").update({ status: "sent", sent_at: new Date().toISOString(), last_error: "No active push subscriptions; notification remains in the in-app center.", updated_at: new Date().toISOString() }).eq("id", job.id);
        suppressed++;
        continue;
      }

      const payload = {
        ...(job.payload || {}),
        title: job.payload?.title || (critical ? "¡AY, PAPÁ! 🚨" : "¡Ey, jefe! 😂"),
        body: job.payload?.body || "Tienes un aviso nuevo en PALMYRA.",
        notification_id: job.notification_id,
        url: "/notifications",
        tag: job.dedupe_key || job.id,
      };
      let delivered = false;
      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_secret },
          }, JSON.stringify(payload), { TTL: critical ? 300 : 3600, urgency: critical ? "high" : "normal" });
          delivered = true;
        } catch (error) {
          const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
          if (statusCode === 404 || statusCode === 410) {
            await supabase.from("push_subscriptions").update({ enabled: false, updated_at: new Date().toISOString() }).eq("id", sub.id);
          } else {
            console.error("[notification-worker] push delivery failed", statusCode);
          }
        }
      }
      if (delivered) {
        await supabase.from("notification_outbox").update({ status: "sent", sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", job.id);
        sent++;
      } else if ((job.attempts || 0) >= 5) {
        await supabase.from("notification_outbox").update({ status: "failed", last_error: "Push failed after multiple attempts.", updated_at: new Date().toISOString() }).eq("id", job.id);
        failed++;
      } else {
        const retryAt = new Date(Date.now() + Math.min(60, 2 ** ((job.attempts || 0) + 1)) * 60_000).toISOString();
        await supabase.from("notification_outbox").update({ status: "failed", available_at: retryAt, scheduled_at: retryAt, locked_at: null, last_error: "Temporary push delivery failure.", updated_at: new Date().toISOString() }).eq("id", job.id);
        failed++;
      }
    } catch (error) {
      const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await supabase.from("notification_outbox").update({
        status: "failed", available_at: retryAt, scheduled_at: retryAt, locked_at: null,
        last_error: String((error as Error)?.message || "Unexpected delivery error").slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      failed++;
    }
  }

  return response({ processed: jobs?.length || 0, sent, suppressed, deferred, failed });
});
