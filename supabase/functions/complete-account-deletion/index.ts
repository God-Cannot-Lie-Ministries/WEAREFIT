import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendDeletionEmail(email: string, token: string) {
  const appUrl = Deno.env.get("APP_URL") || "https://fit-training.org/";
  const emailFrom = Deno.env.get("EMAIL_FROM") || "WEAREFIT <verification@notifications.fit-training.org>";
  const verifyUrl = new URL(appUrl);
  verifyUrl.searchParams.set("verifyDeleteAccount", "1");
  verifyUrl.searchParams.set("email", email);
  verifyUrl.searchParams.set("token", token);
  const safeUrl = escapeHtml(verifyUrl.toString());
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [email],
      subject: "Confirm your F.I.T. account deletion",
      text: `Use this secure link to confirm deletion of your F.I.T. account. If you did not request this, ignore this email and your account will remain active.\n\n${verifyUrl.toString()}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033;line-height:1.6">
        <h1 style="font-size:22px;color:#0d2859">Confirm account deletion</h1>
        <p>Use this secure link to confirm deletion of your F.I.T. account.</p>
        <p><a href="${safeUrl}" style="display:inline-block;background:#0d2859;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Confirm deletion</a></p>
        <p style="font-size:12px;color:#647084">If you did not request this, ignore this email and your account will remain active.</p>
        <p style="font-size:12px;color:#647084">Only the newest link will work. This link expires in 30 minutes.</p>
      </div>`,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "A new deletion verification email could not be sent.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { action, email: rawEmail, token } = await request.json();
    const email = normalizeEmail(rawEmail);
    if (!email || !token || String(token).length < 60) throw new Error("This verification link is invalid.");
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const tokenHash = await sha256(String(token));
    const { data: deletionRequest, error: lookupError } = await adminClient
      .from("account_deletion_requests")
      .select("id, user_id, email, account_role, expires_at, used_at")
      .eq("email", email)
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!deletionRequest) throw new Error("This verification link is invalid.");
    if (deletionRequest.used_at) throw new Error("This verification link has already been used.");
    if (new Date(deletionRequest.expires_at) <= new Date()) throw new Error("This verification link has expired.");
    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", deletionRequest.user_id)
      .eq("email", email)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile || !["user", "coach"].includes(profile.role)) {
      throw new Error("This account could not be verified.");
    }
    if (deletionRequest.account_role && deletionRequest.account_role !== profile.role) {
      throw new Error("This verification link does not match the account.");
    }

    if (action === "resend") {
      const replacementToken = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
      const replacementHash = await sha256(replacementToken);
      const replacementExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { error: replacementError } = await adminClient
        .from("account_deletion_requests")
        .update({ token_hash: replacementHash, expires_at: replacementExpiry, used_at: null })
        .eq("id", deletionRequest.id);
      if (replacementError) throw replacementError;
      try {
        await sendDeletionEmail(email, replacementToken);
      } catch (error) {
        await adminClient
          .from("account_deletion_requests")
          .update({ token_hash: tokenHash, expires_at: deletionRequest.expires_at, used_at: null })
          .eq("id", deletionRequest.id);
        throw error;
      }
      return new Response(JSON.stringify({ ok: true, resent: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    for (const bucket of ["profile-photos", "financial-documents"]) {
      const { data: categories } = await adminClient.storage.from(bucket).list(deletionRequest.user_id, {
        limit: 1000,
      });
      for (const category of categories || []) {
        const categoryPath = `${deletionRequest.user_id}/${category.name}`;
        const { data: files } = await adminClient.storage.from(bucket).list(categoryPath, { limit: 1000 });
        if (files?.length) {
          await adminClient.storage.from(bucket).remove(files.map((file) => `${categoryPath}/${file.name}`));
        }
      }
    }
    const { data: connectedMembers } = await adminClient
      .from("portal_states")
      .select("owner_id, owner_email, state")
      .eq("coach_email", email);
    for (const row of connectedMembers || []) {
      const state = row.state || {};
      const member = state.accounts?.[row.owner_email];
      if (member) {
        member.coachEmail = null;
        member.coachName = "";
        member.coachRequestStatus = null;
      }
      state.coachRequests = (state.coachRequests || []).filter(
        (item: { coachEmail?: string }) => normalizeEmail(item.coachEmail) !== email,
      );
      state.coachInvites = (state.coachInvites || []).filter(
        (item: { coachEmail?: string }) => normalizeEmail(item.coachEmail) !== email,
      );
      await adminClient
        .from("portal_states")
        .update({ coach_email: null, state, updated_at: new Date().toISOString() })
        .eq("owner_id", row.owner_id);
    }
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(deletionRequest.user_id);
    if (deleteError && !/not found|does not exist/i.test(deleteError.message || "")) throw deleteError;

    return new Response(JSON.stringify({ ok: true, deleted: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
