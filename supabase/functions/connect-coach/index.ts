import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) throw new Error("Authentication required.");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Authentication required.");
    if (authData.user.user_metadata?.role === "coach") {
      throw new Error("Coach accounts cannot designate another coach.");
    }

    const body = await request.json();
    const acceptedCoachInvite = body.invite === true;
    const refreshOnly = body.refreshOnly === true;
    const coachEmail = String(body.coachEmail || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(coachEmail)) {
      throw new Error("Enter a valid coach email.");
    }
    const { data: coachRow, error: coachError } = await adminClient
      .from("portal_states")
      .select("owner_id, owner_email, state")
      .eq("owner_email", coachEmail)
      .eq("role", "coach")
      .maybeSingle();
    if (coachError) throw coachError;
    if (!coachRow) throw new Error("No coach account exists for that email yet.");
    const { data: coachProfile, error: coachProfileError } = await adminClient
      .from("profiles")
      .select("full_name")
      .eq("email", coachEmail)
      .maybeSingle();
    if (coachProfileError) throw coachProfileError;
    const { data: coachAuthData, error: coachAuthError } = await adminClient.auth.admin.getUserById(
      coachRow.owner_id
    );
    if (coachAuthError) throw coachAuthError;

    const memberEmail = authData.user.email.toLowerCase();
    const { data: memberRow, error: memberError } = await adminClient
      .from("portal_states")
      .select("state")
      .eq("owner_id", authData.user.id)
      .single();
    if (memberError || !memberRow) throw new Error("Complete your financial profile before connecting a coach.");

    const state = memberRow.state || {};
    const member = state.accounts?.[memberEmail] || {};
    const coachAccount = coachRow.state?.accounts?.[coachEmail] || {};
    if (refreshOnly && member.coachEmail !== coachEmail) {
      throw new Error("This coach is not connected to your account.");
    }
    const profileName = String(coachProfile?.full_name || "").trim();
    const stateName = String(coachAccount.name || "").trim();
    const metadataName = String(coachAuthData.user?.user_metadata?.name || "").trim();
    const coachName =
      (profileName && profileName.toLowerCase() !== coachEmail ? profileName : "") ||
      (stateName && stateName.toLowerCase() !== coachEmail ? stateName : "") ||
      (metadataName && metadataName.toLowerCase() !== coachEmail ? metadataName : "") ||
      "F.I.T. coach";
    const coachStoredPhoto = coachAccount.profilePhoto || null;
    const coachProfilePhoto = coachStoredPhoto ? { ...coachStoredPhoto } : null;
    if (coachProfilePhoto?.storagePath) {
      const { data: signedPhoto } = await adminClient.storage
        .from("profile-photos")
        .createSignedUrl(coachProfilePhoto.storagePath, 86400);
      if (signedPhoto?.signedUrl) coachProfilePhoto.dataUrl = signedPhoto.signedUrl;
    }
    member.coachEmail = coachEmail;
    member.coachName = coachName;
    member.coachPhotoCheckedAt = new Date().toISOString();
    if (!refreshOnly) member.coachRequestStatus = acceptedCoachInvite ? "approved" : "pending";
    state.accounts = {
      ...(state.accounts || {}),
      [memberEmail]: member,
      [coachEmail]: {
        name: coachName,
        email: coachEmail,
        role: "coach",
        profilePhoto: coachStoredPhoto,
      },
    };
    if (!refreshOnly) {
      state.coachRequests = (state.coachRequests || []).map((item: Record<string, unknown>) =>
        item.memberEmail === memberEmail && item.status === "pending"
          ? { ...item, status: "replaced" }
          : item
      );
      state.coachRequests.push({
        id: crypto.randomUUID(),
        memberEmail,
        coachEmail,
        status: acceptedCoachInvite ? "approved" : "pending",
        createdAt: new Date().toISOString(),
        respondedAt: acceptedCoachInvite ? new Date().toISOString() : null,
      });
    }

    const { error: updateError } = await adminClient
      .from("portal_states")
      .update({ coach_email: coachEmail, state, updated_at: new Date().toISOString() })
      .eq("owner_id", authData.user.id);
    if (updateError) throw updateError;

    return new Response(JSON.stringify({ ok: true, coachEmail, coachName, coachProfilePhoto }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
