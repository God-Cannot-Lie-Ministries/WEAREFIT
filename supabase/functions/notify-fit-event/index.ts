import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const eventSubjects: Record<string, { member: string; coach: string }> = {
  worksheet_opened: {
    member: "Your F.I.T. worksheet was opened",
    coach: "A member's F.I.T. worksheet was opened",
  },
  milestone_reached: {
    member: "Your F.I.T. milestone was reached",
    coach: "A member reached a F.I.T. milestone",
  },
  document_available: {
    member: "A F.I.T. document is ready to view",
    coach: "A member's F.I.T. document is ready",
  },
  fit_session_completed: {
    member: "Your F.I.T. session is complete",
    coach: "A member's F.I.T. session is complete",
  },
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();
const escapeHtml = (value: unknown) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function safeEventType(value: unknown) {
  const eventType = String(value || "");
  if (!Object.hasOwn(eventSubjects, eventType)) throw new Error("Unsupported notification event.");
  return eventType;
}

function accountName(account: Record<string, unknown> | null | undefined, fallbackEmail: string) {
  const name = String(account?.name || "").trim();
  return name || fallbackEmail.split("@")[0] || "F.I.T. member";
}

function readableDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const date = raw.includes("T") ? new Date(raw) : new Date(`${raw}T12:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function eventCopy(eventType: string, role: "member" | "coach", payload: Record<string, unknown>) {
  const memberName = escapeHtml(payload.memberName || "your member");
  const openedByName = escapeHtml(payload.openedByName || payload.actorName || "an authorized user");
  const openedByRole = escapeHtml(payload.openedByRole || "user");
  const milestoneName = escapeHtml(payload.milestoneName || "Financial milestone");
  const documentTitle = escapeHtml(payload.documentTitle || "F.I.T. document");
  const documentType = escapeHtml(payload.documentType || "Document");
  const sessionDate = escapeHtml(readableDate(payload.sessionDate));
  if (eventType === "worksheet_opened") {
    return role === "member"
      ? {
          headline: "Your F.I.T. worksheet was opened",
          body: `${documentTitle} was opened by ${openedByName} (${openedByRole}). Sign in to F.I.T. to view the worksheet securely.`,
          cta: "Open worksheet",
        }
      : {
          headline: "A member worksheet was opened",
          body: `${memberName}'s ${documentTitle} was opened by ${openedByName} (${openedByRole}). Sign in to review the worksheet through your coach access.`,
          cta: "Open worksheet",
        };
  }
  if (eventType === "milestone_reached") {
    return role === "member"
      ? {
          headline: "A F.I.T. milestone was reached",
          body: `You reached the milestone: ${milestoneName}. Keep building steady financial integrity one step at a time.`,
          cta: "Open F.I.T.",
        }
      : {
          headline: "A member reached a F.I.T. milestone",
          body: `${memberName} reached the milestone: ${milestoneName}. Log in to review progress and offer encouragement.`,
          cta: "Review member progress",
        };
  }
  if (eventType === "document_available") {
    return role === "member"
      ? {
          headline: "A F.I.T. document is ready",
          body: `${documentType}: ${documentTitle} is ready to view. Sign in to F.I.T. to open the secure document.`,
          cta: "View document",
        }
      : {
          headline: "A member document is ready",
          body: `${memberName} has a ${documentType} ready in F.I.T. Sign in to view it through your secure coach access.`,
          cta: "Open document",
        };
  }
  return role === "member"
    ? {
        headline: "Your F.I.T. session is complete",
        body: `Your ${sessionDate} F.I.T. session is complete. Sign in to view the review and next steps.`,
        cta: "View session review",
      }
    : {
        headline: "A member's F.I.T. session is complete",
        body: `${memberName}'s ${sessionDate} F.I.T. session is complete. Sign in to view the review and follow-up notes.`,
        cta: "View session review",
      };
}

function emailHtml(copy: { headline: string; body: string; cta: string }, url: string) {
  const safeUrl = escapeHtml(url);
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0;background:#f5f7fb;font-family:Arial,sans-serif;color:#172033">
      <tr><td align="center" style="padding:24px 12px">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #d9c16f;border-radius:14px;overflow:hidden">
          <tr><td style="padding:24px 24px 8px;background:#0d2859;color:#ffffff">
            <div style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#f2c94c;font-weight:700">F.I.T. Financial Integrity Training</div>
            <h1 style="font-size:24px;line-height:1.25;margin:10px 0 0;color:#ffffff">${escapeHtml(copy.headline)}</h1>
          </td></tr>
          <tr><td style="padding:24px;color:#172033;font-size:16px;line-height:1.55">
            <p style="margin:0 0 18px">${copy.body}</p>
            <p style="margin:0 0 18px"><a href="${safeUrl}" style="display:inline-block;background:#0d2859;color:#ffffff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${escapeHtml(copy.cta)}</a></p>
            <p style="margin:0;color:#647084;font-size:13px">For your privacy, financial details are not included in this email. Sign in to F.I.T. to view authorized details.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  `;
}

async function sendAndLog(
  adminClient: ReturnType<typeof createClient>,
  resendApiKey: string,
  emailFrom: string,
  logPayload: Record<string, unknown>,
  emailPayload: Record<string, unknown>,
) {
  let logTable = "fit_email_logs";
  let { data: log, error: logError } = await adminClient
    .from("fit_email_logs")
    .insert(logPayload)
    .select("id")
    .single();
  if (logError) {
    logTable = "email_audit";
    const fallback = await adminClient
      .from("email_audit")
      .insert({
        actor_id: logPayload.user_id || null,
        email_type: logPayload.event_type,
        recipient: logPayload.recipient_email,
        status: "pending",
      })
      .select("id")
      .single();
    if (fallback.error) throw logError;
    log = fallback.data;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: emailFrom, ...emailPayload }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Email provider rejected the message.");
    if (logTable === "fit_email_logs") {
      await adminClient
        .from("fit_email_logs")
        .update({ status: "sent", resend_email_id: result.id || null, sent_at: new Date().toISOString() })
        .eq("id", log.id);
    } else {
      await adminClient
        .from("email_audit")
        .update({ status: "sent", provider_id: result.id || null })
        .eq("id", log.id);
    }
    return { ok: true, id: result.id };
  } catch (error) {
    if (logTable === "fit_email_logs") {
      await adminClient
        .from("fit_email_logs")
        .update({ status: "failed", error_message: error.message || "Email failed" })
        .eq("id", log.id);
    } else {
      await adminClient
        .from("email_audit")
        .update({ status: "failed" })
        .eq("id", log.id);
    }
    return { ok: false, error: error.message || "Email failed" };
  }
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
    const emailFrom = Deno.env.get("EMAIL_FROM") || "WEAREFIT <notifications@notifications.fit-training.org>";
    const appUrl = Deno.env.get("APP_URL") || "https://fit-training.org/";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user?.email) throw new Error("Authentication required.");

    const actorEmail = normalizeEmail(authData.user.email);
    const body = await request.json();
    const eventType = safeEventType(body.eventType);
    const memberEmail = normalizeEmail(body.memberEmail || actorEmail);
    if (!memberEmail) throw new Error("Member email is required.");

    const { data: memberRow, error: memberError } = await adminClient
      .from("portal_states")
      .select("owner_id, owner_email, coach_email, state")
      .eq("owner_email", memberEmail)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) throw new Error("Member account was not found.");

    const memberAccount = memberRow.state?.accounts?.[memberRow.owner_email] || {};
    const connectedCoachEmail = normalizeEmail(
      memberAccount.coachRequestStatus === "approved" ? memberAccount.coachEmail || memberRow.coach_email : "",
    );
    const actorIsMember = actorEmail === memberEmail;
    const actorIsCoach = connectedCoachEmail && actorEmail === connectedCoachEmail;
    if (!actorIsMember && !actorIsCoach) throw new Error("You do not have permission to send this notification.");

    const emails = [memberEmail];
    if (connectedCoachEmail) emails.push(connectedCoachEmail);
    const { data: profiles } = await adminClient
      .from("profiles")
      .select("id, email, role")
      .in("email", emails);
    const profileByEmail = new Map((profiles || []).map((profile) => [normalizeEmail(profile.email), profile]));
    const coachProfile = connectedCoachEmail ? profileByEmail.get(connectedCoachEmail) : null;
    const memberProfile = profileByEmail.get(memberEmail);
    const viewUrl = new URL(appUrl);
    if (eventType === "fit_session_completed") viewUrl.searchParams.set("session", String(body.relatedSessionId || body.sessionId || ""));
    if (eventType === "document_available" || eventType === "worksheet_opened") {
      viewUrl.searchParams.set("document", String(body.relatedDocumentId || body.documentId || ""));
    }
    if (eventType === "milestone_reached") viewUrl.searchParams.set("notifications", "1");

    const payload = {
      ...body,
      memberName: accountName(memberAccount, memberEmail),
      openedByName: body.openedByName || (actorEmail === memberEmail ? accountName(memberAccount, memberEmail) : actorEmail),
      openedByRole: body.openedByRole || (actorEmail === memberEmail ? "member" : "coach"),
      sessionDate: readableDate(body.sessionDate || new Date()),
    };
    const recipients = [
      { email: memberEmail, role: "member" as const, profile: memberProfile },
      ...(connectedCoachEmail ? [{ email: connectedCoachEmail, role: "coach" as const, profile: coachProfile }] : []),
    ];
    const results = [];
    for (const recipient of recipients) {
      const copy = eventCopy(eventType, recipient.role, payload);
      const subject = eventSubjects[eventType][recipient.role];
      results.push(await sendAndLog(
        adminClient,
        resendApiKey,
        emailFrom,
        {
          user_id: memberRow.owner_id,
          coach_id: coachProfile?.id || null,
          recipient_user_id: recipient.profile?.id || null,
          recipient_role: recipient.role,
          event_type: eventType,
          recipient_email: recipient.email,
          subject,
          status: "pending",
          related_session_id: body.relatedSessionId || body.sessionId || null,
          related_document_id: body.relatedDocumentId || body.documentId || null,
        },
        {
          to: [recipient.email],
          subject,
          text: `${copy.headline}\n\n${copy.body}\n\n${copy.cta}: ${viewUrl.toString()}\n\nFor your privacy, financial details are not included in this email.`,
          html: emailHtml(copy, viewUrl.toString()),
        },
      ));
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
