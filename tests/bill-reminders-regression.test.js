const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const reminderFunction = fs.readFileSync(
  path.join(root, "supabase/functions/send-bill-reminders/index.ts"),
  "utf8",
);
const deployWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/deploy-secure-functions.yml"),
  "utf8",
);
const reminderWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/send-bill-reminders.yml"),
  "utf8",
);

test("bill reminders scan profile due dates and send due-in-five-day notifications", () => {
  assert.match(reminderFunction, /function billRemindersForAccount/);
  assert.match(reminderFunction, /recurringBills/);
  assert.match(reminderFunction, /creditCards/);
  assert.match(reminderFunction, /studentLoans/);
  assert.match(reminderFunction, /mortgage/);
  assert.match(reminderFunction, /"bill_due_soon"/);
  assert.match(reminderFunction, /BILL_REMINDER_DAYS_AHEAD/);
  assert.match(reminderFunction, /body\.daysAhead \|\| defaultDaysAhead \|\| 5/);
});

test("bill reminders notify members and connected coaches without exposing amounts", () => {
  assert.match(reminderFunction, /connectedCoachEmail/);
  assert.match(reminderFunction, /recipient\.role === "coach"/);
  assert.match(reminderFunction, /financial details are not included in this email/i);
  assert.doesNotMatch(reminderFunction, /money\(/);
});

test("bill reminders are deduped and logged per recipient", () => {
  assert.match(reminderFunction, /function alreadyReminded/);
  assert.match(reminderFunction, /\.from\("fit_email_logs"\)/);
  assert.match(reminderFunction, /related_document_id: reminderKey/);
  assert.match(reminderFunction, /recipient_email: recipient\.email/);
  assert.match(reminderFunction, /\.in\("status", \["pending", "sent"\]\)/);
});

test("paid bills are suppressed even when old due dates remain in profile data", () => {
  assert.match(reminderFunction, /function wasPaidForDueDate/);
  assert.match(reminderFunction, /paidDueDate/);
  assert.match(reminderFunction, /lastPaidDueDate/);
  assert.match(reminderFunction, /paidDueDates/);
  assert.match(reminderFunction, /if \(wasPaidForDueDate\(card, dueDate\)\) return/);
  assert.match(reminderFunction, /if \(wasPaidForDueDate\(debt, dueDate\)\) return/);
  assert.match(reminderFunction, /if \(wasPaidForDueDate\(loan, dueDate\)\) return/);
  assert.match(reminderFunction, /if \(!wasPaidForDueDate\(mortgage, dueDate\)\)/);
});

test("bill reminder function deploys and runs from the daily workflow", () => {
  assert.match(deployWorkflow, /supabase functions deploy send-bill-reminders/);
  assert.match(reminderWorkflow, /send-bill-reminders/);
  assert.match(reminderWorkflow, /BILL_REMINDER_DAYS_AHEAD/);
  assert.match(reminderWorkflow, /reminder_days="\$\{BILL_REMINDER_DAYS_AHEAD:-5\}"/);
  assert.match(reminderWorkflow, /x-fit-cron-secret/);
  assert.match(reminderWorkflow, /schedule:/);
});
