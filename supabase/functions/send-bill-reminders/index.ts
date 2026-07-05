import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fit-cron-secret",
};

type PortalRow = {
  owner_id: string;
  owner_email: string;
  role: "user" | "coach";
  coach_email?: string | null;
  state?: Record<string, any>;
};

type ProfileRow = {
  id: string;
  email: string;
  role: "user" | "coach";
};

type BillReminder = {
  id: string;
  name: string;
  dueDate: string;
  type: string;
  source: string;
  targetType: string;
};

const normalizeEmail = (value: unknown) => String(value || "").trim().toLowerCase();

const escapeHtml = (value: unknown) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const currencyValue = (value: unknown) => {
  if (typeof value === "string") return Number(value.replaceAll(",", "")) || 0;
  return Number(value) || 0;
};

function normalizedReminderDays(value: unknown, fallback = 5) {
  const numeric = Math.round(Number(value));
  if (numeric >= 1 && numeric <= 7) return numeric;
  const fallbackNumeric = Math.round(Number(fallback));
  return fallbackNumeric >= 1 && fallbackNumeric <= 7 ? fallbackNumeric : 5;
}

function reminderDaysForAccount(account: Record<string, any>, fallbackDaysAhead: number) {
  return normalizedReminderDays(account?.preferences?.billReminderDaysAhead, fallbackDaysAhead);
}

function reminderDaysLabel(daysAhead: number) {
  const normalizedDays = normalizedReminderDays(daysAhead);
  return normalizedDays === 1 ? "1 day" : `${normalizedDays} days`;
}

function dateOnly(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function readableDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function dateValue(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : dateOnly(date);
}

function nextMonthlyDueDate(dueDay: unknown, fromDate = new Date()) {
  const raw = String(dueDay || "").trim();
  if (!raw) return "";
  const start = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
  const dateForMonth = (year: number, month: number) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const day = raw === "last" ? lastDay : Math.min(Math.max(Number(raw) || 1, 1), lastDay);
    return new Date(Date.UTC(year, month, day));
  };
  let dueDate = dateForMonth(start.getUTCFullYear(), start.getUTCMonth());
  if (dueDate < start) dueDate = dateForMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return dateOnly(dueDate);
}

function accountName(account: Record<string, any> | null | undefined, fallbackEmail: string) {
  const name = String(account?.name || "").trim();
  return name || fallbackEmail.split("@")[0] || "F.I.T. member";
}

function accountFromRow(row: PortalRow) {
  const ownerEmail = normalizeEmail(row.owner_email);
  return row.state?.accounts?.[ownerEmail] || {};
}

function connectedCoachEmail(row: PortalRow, account: Record<string, any>) {
  return normalizeEmail(account.coachRequestStatus === "approved" ? account.coachEmail || row.coach_email : "");
}

function recurringBillDueDate(bill: Record<string, any>, fromDate: Date) {
  return bill?.dueDay ? nextMonthlyDueDate(bill.dueDay, fromDate) : dateValue(bill?.nextDueDate);
}

function recurringBillIsPaidForDueDate(bill: Record<string, any>, dueDate: string) {
  return wasPaidForDueDate(bill, dueDate);
}

function wasPaidForDueDate(item: Record<string, any>, dueDate: string) {
  if (!dueDate) return false;
  const paidDueDates = Array.isArray(item?.paidDueDates) ? item.paidDueDates.map(dateValue) : [];
  return Boolean(
    dateValue(item?.paidDueDate) === dueDate ||
      dateValue(item?.lastPaidDueDate) === dueDate ||
      paidDueDates.includes(dueDate),
  );
}

function billRemindersForAccount(account: Record<string, any>, targetDate: string, fromDate: Date): BillReminder[] {
  const financialInventory = account.financialInventory || {};
  const reminders: BillReminder[] = [];
  const addReminder = (item: Record<string, any>) => {
    const dueDate = dateValue(item.dueDate);
    if (!item.name || dueDate !== targetDate || !currencyValue(item.amount)) return;
    reminders.push({
      id: String(item.id || `${item.targetType}-${item.name}-${dueDate}`),
      name: String(item.name),
      dueDate,
      type: String(item.type || "Bill"),
      source: String(item.source || ""),
      targetType: String(item.targetType || ""),
    });
  };

  const categoryLabel: Record<string, string> = {
    housing: "Housing",
    utilities: "Utilities",
    insurance: "Insurance",
    subscriptions: "Subscriptions / Services",
    other: "Other Bills",
  };

  (financialInventory.recurringBills || []).forEach((bill: Record<string, any>) => {
    const dueDate = recurringBillDueDate(bill, fromDate);
    if (!dueDate || recurringBillIsPaidForDueDate(bill, dueDate)) return;
    addReminder({
      id: bill.id,
      name: bill.name,
      dueDate,
      amount: bill.amount,
      type: "Recurring bill",
      source: categoryLabel[bill.category] || "Other Bills",
      targetType: "recurringBills",
    });
  });

  (financialInventory.creditCards || []).forEach((card: Record<string, any>) => {
    const dueDate = dateValue(card.dueDate);
    if (wasPaidForDueDate(card, dueDate)) return;
    addReminder({
      id: card.id,
      name: card.account,
      dueDate,
      amount: card.paymentDue,
      type: "Credit card",
      source: "Card payment",
      targetType: "creditCards",
    });
  });

  (financialInventory.debts || []).forEach((debt: Record<string, any>) => {
    const dueDate = dateValue(debt.dueDate);
    if (wasPaidForDueDate(debt, dueDate)) return;
    addReminder({
      id: debt.id,
      name: debt.account,
      dueDate,
      amount: debt.minimumPayment,
      type: "Debt",
      source: "Minimum payment",
      targetType: "debts",
    });
  });

  (financialInventory.studentLoans || []).forEach((loan: Record<string, any>) => {
    const dueDate = dateValue(loan.dueDate);
    if (wasPaidForDueDate(loan, dueDate)) return;
    addReminder({
      id: loan.id,
      name: loan.account,
      dueDate,
      amount: loan.paymentDue,
      type: "Student loan",
      source: loan.loanType ? String(loan.loanType).replaceAll("_", " ") : "Student loan payment",
      targetType: "studentLoans",
    });
  });

  const mortgage = financialInventory.mortgage || {};
  if (financialInventory.housingPaymentType !== "rent") {
    const dueDate = dateValue(mortgage.nextDueDate);
    if (!wasPaidForDueDate(mortgage, dueDate)) {
      addReminder({
        id: "mortgage-payment",
        name: "Mortgage payment",
        dueDate,
        amount: mortgage.paymentAmount,
        type: "Mortgage",
        source: "Housing",
        targetType: "mortgage",
      });
    }
  }

  return reminders.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

function reminderCopy(role: "member" | "coach", memberName: string, bill: BillReminder, daysAhead: number) {
  const due = readableDate(bill.dueDate);
  const daysLabel = reminderDaysLabel(daysAhead);
  if (role === "coach") {
    return {
      headline: `A member has a bill due in ${daysLabel}`,
      body: `${escapeHtml(memberName)} has a saved ${escapeHtml(bill.type.toLowerCase())} due on ${escapeHtml(due)}. Sign in to F.I.T. to view the amount and details securely.`,
      cta: "View upcoming bills",
    };
  }
  return {
    headline: `A bill is due in ${daysLabel}`,
    body: `Your saved ${escapeHtml(bill.type.toLowerCase())} is due on ${escapeHtml(due)}. Sign in to F.I.T. to view the amount and plan the payment securely.`,
    cta: "View upcoming bills",
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

async function alreadyReminded(
  adminClient: ReturnType<typeof createClient>,
  recipientEmail: string,
  reminderKey: string,
) {
  const { data, error } = await adminClient
    .from("fit_email_logs")
    .select("id")
    .eq("event_type", "bill_due_soon")
    .eq("recipient_email", recipientEmail)
    .eq("related_document_id", reminderKey)
    .in("status", ["pending", "sent"])
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
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
    return { ok: true, id: result.id || null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email failed";
    if (logTable === "fit_email_logs") {
      await adminClient
        .from("fit_email_logs")
        .update({ status: "failed", error_message: message })
        .eq("id", log.id);
    } else {
      await adminClient.from("email_audit").update({ status: "failed" }).eq("id", log.id);
    }
    return { ok: false, error: message };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const configuredCronSecret = Deno.env.get("BILL_REMINDER_CRON_SECRET") || "";
    const requestCronSecret = request.headers.get("x-fit-cron-secret") || "";
    if (configuredCronSecret && requestCronSecret !== configuredCronSecret) {
      return new Response(JSON.stringify({ error: "Reminder job is not authorized." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY")!;
    const emailFrom = Deno.env.get("EMAIL_FROM") || "WEAREFIT <notifications@notifications.fit-training.org>";
    const appUrl = Deno.env.get("APP_URL") || "https://fit-training.org/";
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const fromDate = body.fromDate ? new Date(`${dateValue(body.fromDate)}T00:00:00Z`) : new Date();
    const defaultDaysAhead = normalizedReminderDays(body.daysAhead || Deno.env.get("BILL_REMINDER_DAYS_AHEAD") || 5);
    const forcedTargetDate = body.targetDate ? dateValue(body.targetDate) : "";
    if (body.targetDate && !forcedTargetDate) throw new Error("A valid target date is required.");

    const { data: rows, error: rowsError } = await adminClient
      .from("portal_states")
      .select("owner_id, owner_email, role, coach_email, state");
    if (rowsError) throw rowsError;

    const rowList = (rows || []) as PortalRow[];
    const emailSet = new Set<string>();
    rowList.forEach((row) => {
      const account = accountFromRow(row);
      const ownerEmail = normalizeEmail(row.owner_email);
      if (ownerEmail) emailSet.add(ownerEmail);
      const coachEmail = connectedCoachEmail(row, account);
      if (coachEmail) emailSet.add(coachEmail);
    });

    const { data: profiles, error: profileError } = emailSet.size
      ? await adminClient.from("profiles").select("id, email, role").in("email", [...emailSet])
      : { data: [], error: null };
    if (profileError) throw profileError;
    const profilesByEmail = new Map((profiles || []).map((profile: ProfileRow) => [normalizeEmail(profile.email), profile]));

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const results: Record<string, unknown>[] = [];
    const viewUrl = new URL(appUrl);
    viewUrl.searchParams.set("view", "upcoming-bills");

    for (const row of rowList) {
      const ownerEmail = normalizeEmail(row.owner_email);
      if (!ownerEmail) continue;
      const account = accountFromRow(row);
      const accountDaysAhead = reminderDaysForAccount(account, defaultDaysAhead);
      const targetDate = forcedTargetDate || dateOnly(addDays(fromDate, accountDaysAhead));
      const reminders = billRemindersForAccount(account, targetDate, fromDate);
      if (!reminders.length) continue;
      const memberName = accountName(account, ownerEmail);
      const connectedCoach = connectedCoachEmail(row, account);
      const coachProfile = connectedCoach ? profilesByEmail.get(connectedCoach) : null;
      const ownerProfile = profilesByEmail.get(ownerEmail) || null;
      const recipients = [
        {
          email: ownerEmail,
          role: row.role === "coach" ? "coach" as const : "member" as const,
          profile: ownerProfile,
        },
        ...(connectedCoach
          ? [
              {
                email: connectedCoach,
                role: "coach" as const,
                profile: coachProfile || null,
              },
            ]
          : []),
      ];

      for (const bill of reminders) {
        for (const recipient of recipients) {
          const reminderKey = `bill-reminder:${ownerEmail}:${bill.targetType}:${bill.id}:${bill.dueDate}:${recipient.role}:${accountDaysAhead}d`;
          if (await alreadyReminded(adminClient, recipient.email, reminderKey)) {
            skipped += 1;
            results.push({ ok: true, skipped: true, recipient: recipient.email, bill: bill.name, dueDate: bill.dueDate, daysAhead: accountDaysAhead });
            continue;
          }
          const copy = reminderCopy(recipient.role, memberName, bill, accountDaysAhead);
          const daysLabel = reminderDaysLabel(accountDaysAhead);
          const subject =
            recipient.role === "coach" && recipient.email !== ownerEmail
              ? `A member has a F.I.T. bill due in ${daysLabel}`
              : `Your F.I.T. bill is due in ${daysLabel}`;
          const logPayload = {
            user_id: row.owner_id,
            coach_id: coachProfile?.id || null,
            recipient_user_id: recipient.profile?.id || null,
            recipient_role: recipient.role,
            event_type: "bill_due_soon",
            recipient_email: recipient.email,
            subject,
            status: "pending",
            related_session_id: null,
            related_document_id: reminderKey,
          };
          const emailResult = await sendAndLog(adminClient, resendApiKey, emailFrom, logPayload, {
            to: [recipient.email],
            subject,
            text: `${copy.headline}\n\n${copy.body}\n\n${copy.cta}: ${viewUrl.toString()}\n\nFor your privacy, financial details are not included in this email.`,
            html: emailHtml(copy, viewUrl.toString()),
          });
          if (emailResult.ok) sent += 1;
          else failed += 1;
          results.push({ ...emailResult, recipient: recipient.email, bill: bill.name, dueDate: bill.dueDate, daysAhead: accountDaysAhead });
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, targetDate: forcedTargetDate || "per-account", sent, skipped, failed, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bill reminders failed.";
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
