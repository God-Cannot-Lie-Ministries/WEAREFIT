import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const normalizePhone = (value: unknown) => {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  return "";
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) throw new Error("Authentication required.");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
    const twilioFrom = normalizePhone(Deno.env.get("TWILIO_FROM_NUMBER"));
    if (!twilioSid || !twilioToken || !twilioFrom) throw new Error("Secure text delivery is not configured yet.");

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Authentication required.");
    const coachEmail = normalizeEmail(authData.user.email);
    const { sessionId, formId, recipients = [] } = await request.json();
    if (!sessionId || !formId || !Array.isArray(recipients)) throw new Error("Completed session details are required.");

    const { data: coachRow, error: coachError } = await admin.from("portal_states").select("role, state").eq("owner_email", coachEmail).single();
    if (coachError || coachRow?.role !== "coach") throw new Error("Only the assigned coach can send completed session summaries.");
    const coachAccount = coachRow.state?.accounts?.[coachEmail];
    const { data: memberRow, error: memberError } = await admin.from("portal_states").select("owner_email, coach_email, state").eq("coach_email", coachEmail);
    if (memberError) throw memberError;
    const memberRecord = (memberRow || []).find((row) => row.state?.sessions?.some((session: any) => session.id === sessionId && session.formId === formId));
    if (!memberRecord) throw new Error("This completed session is not assigned to the signed-in coach.");
    const memberAccount = memberRecord.state?.accounts?.[memberRecord.owner_email];
    const appUrl = Deno.env.get("APP_URL") || "https://fit-training.org/";
    const summaryUrl = new URL(appUrl);
    summaryUrl.searchParams.set("sessionReview", String(sessionId));
    const targets = [
      ...(recipients.includes("member") ? [normalizePhone(memberAccount?.profile?.phone)] : []),
      ...(recipients.includes("coach") ? [normalizePhone(coachAccount?.profile?.phone)] : []),
    ].filter(Boolean);
    const uniqueTargets = [...new Set(targets)];
    if (!uniqueTargets.length) throw new Error("Add a valid phone number before requesting a summary text.");
    const body = `Your completed F.I.T. session summary is ready. Sign in to view it and open the printable PDF: ${summaryUrl.toString()}`;
    let sent = 0;
    for (const to of uniqueTargets) {
      const payload = new URLSearchParams({ To: to, From: twilioFrom, Body: body });
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${twilioSid}:${twilioToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload,
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.message || "Text provider rejected the completed summary message.");
      }
      sent += 1;
    }
    return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "Text delivery failed." }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
