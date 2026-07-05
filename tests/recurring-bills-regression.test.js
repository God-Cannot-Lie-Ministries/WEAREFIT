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
  assert.doesNotMatch(appSource, /scheduleEnabled:\s*Boolean\(bill\.amount \|\| bill\.dueDate\)/);
  assert.doesNotMatch(appSource, /bill\.scheduleEnabled = Boolean\(bill\.amount \|\| bill\.monthlyAmount \|\| bill\.dueDay \|\| bill\.nextDueDate\)/);
  assert.doesNotMatch(appSource, /bill\.scheduleEnabled \|\|\s*amount \|\|\s*dueDay \|\|\s*nextDueDate/);
});
