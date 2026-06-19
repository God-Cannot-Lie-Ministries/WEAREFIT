import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) throw new Error("Authentication required.");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
    const emailFrom = Deno.env.get("EMAIL_FROM") || "WEAREFIT <verification@notifications.fit-training.org>";
    const appUrl = Deno.env.get("APP_URL") || "https://fit-training.org/";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Authentication required.");

    const email = normalizeEmail(authData.user.email);
    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile || !["user", "coach"].includes(profile.role)) {
      throw new Error("This account type cannot be deleted.");
    }
    const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
    const tokenHash = await sha256(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await adminClient
      .from("account_deletion_requests")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", authData.user.id)
      .is("used_at", null);
    const { error: insertError } = await adminClient.from("account_deletion_requests").insert({
      user_id: authData.user.id,
      email,
      account_role: profile.role,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    if (insertError) throw insertError;

    const verifyUrl = new URL(appUrl);
    verifyUrl.searchParams.set("verifyDeleteAccount", "1");
    verifyUrl.searchParams.set("email", email);
    verifyUrl.searchParams.set("token", token);
    const safeUrl = escapeHtml(verifyUrl.toString());
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: emailFrom,
        to: [email],
        subject: "Confirm your F.I.T. account deletion",
        text: `You asked to delete your F.I.T. account. Open this secure link to confirm. If you did not request this, ignore this email and your account will remain active.\n\n${verifyUrl.toString()}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033;line-height:1.6">
          <h1 style="font-size:22px;color:#0d2859">Confirm account deletion</h1>
          <p>You asked to delete your F.I.T. account. Open the secure link below to confirm.</p>
          <p><a href="${safeUrl}" style="display:inline-block;background:#0d2859;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Confirm deletion</a></p>
          <p style="font-size:12px;color:#647084">If you did not request this, ignore this email and your account will remain active.</p>
          <p style="font-size:12px;color:#647084">This one-time link expires in 30 minutes.</p>
        </div>`,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Deletion verification email could not be sent.");

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
