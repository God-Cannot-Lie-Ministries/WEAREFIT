const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.resolve(__dirname, "..", "app.js"), "utf8");

test("marking upcoming recurring bills paid keeps the profile bill record", () => {
  const markPaidBlock = appSource.match(
    /if \(targetType === "recurringBills"\) \{[\s\S]*?return bill\.name \|\| "Recurring bill";\n  \}/,
  )?.[0] || "";
  assert.match(markPaidBlock, /bill\.paidDueDate =/);
  assert.match(markPaidBlock, /bill\.nextDueDate = ""/);
  assert.doesNotMatch(markPaidBlock, /\.splice\(/);
  assert.doesNotMatch(markPaidBlock, /\.filter\(/);
});

test("session approval merges worksheet bills instead of replacing saved recurring bills", () => {
  assert.match(appSource, /member\.financialInventory\.recurringBills = mergeRecurringBills\(existingRecurringBills, worksheetRecurringBills\)/);
  assert.doesNotMatch(appSource, /member\.financialInventory\.recurringBills = billGroups\.flatMap/);
});

test("recurring bill restoration uses saved forms and carry-forward history without duplicates", () => {
  assert.match(appSource, /function restoreRecurringBillsFromHistory/);
  assert.match(appSource, /account\.carryForward\?\.bills/);
  assert.match(appSource, /Object\.values\(state\.forms \|\| \{\}\)/);
  assert.match(appSource, /function mergeRecurringBills/);
  assert.match(appSource, /recurringBillKey/);
});

test("recurring bill details stay off when only amount or next due date are present", () => {
  assert.match(appSource, /function recurringScheduleEnabledFromBill/);
  assert.match(appSource, /function recurringScheduleExplicitlyDisabled/);
  assert.doesNotMatch(appSource, /scheduleEnabled:\s*Boolean\(bill\.amount \|\| bill\.dueDate\)/);
  assert.doesNotMatch(appSource, /bill\.scheduleEnabled = Boolean\(bill\.amount \|\| bill\.monthlyAmount \|\| bill\.dueDay \|\| bill\.nextDueDate\)/);
  assert.doesNotMatch(appSource, /bill\.scheduleEnabled \|\|\s*amount \|\|\s*dueDay \|\|\s*nextDueDate/);
});

test("explicitly unchecked recurring bill details are not restored by older history", () => {
  const mergeBlock = appSource.match(/function mergeRecurringBills\(existingBills = \[\], candidateBills = \[\]\) \{[\s\S]*?return removePartialNameDuplicates\(merged, "name"\);\n\}/)?.[0] || "";
  const approvalBlock = appSource.match(/const previousScheduleDisabled = recurringScheduleExplicitlyDisabled\(previousBill\);[\s\S]*?monthlyAmount: scheduleEnabled \? previousBill\?\.monthlyAmount \|\| bill\.monthlyAmount \|\| bill\.amount \|\| "" : "",/)?.[0] || "";
  const syncBlock = appSource.match(/function syncRecurringBillScheduleState\(bill, changedField = ""\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(mergeBlock, /recurringScheduleExplicitlyDisabled\(existing\)/);
  assert.match(mergeBlock, /existing\.scheduleEnabled = false;/);
  assert.match(mergeBlock, /existing\.dueDay = "";/);
  assert.match(mergeBlock, /existing\.monthlyAmount = "";/);
  assert.match(approvalBlock, /previousScheduleDisabled\s*\?\s*false/);
  assert.match(syncBlock, /if \(!bill\.scheduleEnabled\)/);
  assert.match(syncBlock, /bill\.dueDay = "";/);
  assert.match(syncBlock, /bill\.monthlyAmount = "";/);
  assert.doesNotMatch(mergeBlock, /existing\.scheduleEnabled = Boolean\(existing\.scheduleEnabled \|\| bill\.scheduleEnabled \|\| existing\.dueDay \|\| bill\.dueDay\)/);
});

test("new worksheet recurring bill prefill is limited to bills due within 15 days", () => {
  assert.match(appSource, /const WORKSHEET_BILL_LOOKAHEAD_DAYS = 15/);
  const upcomingBlock = appSource.match(/function isUpcomingRecurringBill\(bill\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(upcomingBlock, /isDateWithinNextDays\(dueDate, WORKSHEET_BILL_LOOKAHEAD_DAYS\)/);
  assert.doesNotMatch(upcomingBlock, /isDateWithinNextMonth\(dueDate\)/);
  assert.match(appSource, /function isDateWithinNextMonth\(value\) \{\s*return isDateWithinNextDays\(value, 31\);/);
});

test("upcoming bill labels compare date-only values so tomorrow is not rounded to two days", () => {
  const labelBlock = appSource.match(/function daysUntilLabel\(value\) \{[\s\S]*?\n\}/)?.[0] || "";
  const dateValueBlock = appSource.match(/function daysUntilDateValue\(value\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(labelBlock, /if \(difference === 1\) return "Due tomorrow"/);
  assert.match(dateValueBlock, /`\$\{todayValue\(\)\}T00:00:00`/);
  assert.match(dateValueBlock, /`\$\{value\}T00:00:00`/);
  assert.doesNotMatch(dateValueBlock, /T12:00:00/);
});
