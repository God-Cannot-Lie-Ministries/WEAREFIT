const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const backendSource = fs.readFileSync(path.join(root, "backend.js"), "utf8");
const functionSource = fs.readFileSync(
  path.join(root, "supabase/functions/analyze-bill-screenshot/index.ts"),
  "utf8",
);
const deployWorkflow = fs.readFileSync(
  path.join(root, ".github/workflows/deploy-secure-functions.yml"),
  "utf8",
);

test("bill screenshot scanning is exposed from profile and upcoming bills", () => {
  assert.match(appSource, /function billScanPanel/);
  assert.match(appSource, /function showBillScanUploadModal/);
  assert.match(appSource, /function showBillScanReviewModal/);
  assert.match(appSource, /data-open-bill-scan/);
  assert.match(appSource, /id="bill-scan-confirm-form"/);
});

test("confirmed screenshot scan updates only next payment fields and scan history", () => {
  const updateBlock = appSource.match(/async function applyBillScanUpdate\(formElement\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(updateBlock, /bill\.amount = amountDue\.toFixed\(2\)/);
  assert.match(updateBlock, /bill\.nextDueDate = dueDate/);
  assert.match(updateBlock, /bill\.paidDueDate = ""/);
  assert.match(updateBlock, /bill\.billScanHistory\.unshift/);
  assert.match(updateBlock, /bill\.lastBillScan = bill\.billScanHistory\[0\]/);
  assert.doesNotMatch(updateBlock, /bill\.dueDay =/);
  assert.doesNotMatch(updateBlock, /bill\.monthlyAmount =/);
  assert.doesNotMatch(updateBlock, /bill\.scheduleEnabled =/);
});

test("bill screenshot upload uses private storage and a server-side analyzer", () => {
  assert.match(backendSource, /analyzeBillScreenshot/);
  assert.match(backendSource, /functions\.invoke\("analyze-bill-screenshot"/);
  assert.match(backendSource, /safeCategory === "bill-screenshots"/);
  assert.match(appSource, /uploadPrivateFile\("financial-documents", file, "bill-screenshots"\)/);
  assert.match(functionSource, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.match(functionSource, /response_format/);
  assert.match(functionSource, /matchedBillId/);
  assert.doesNotMatch(functionSource, /from\("portal_states"\)\.update/);
});

test("secure function deployment includes bill screenshot analyzer", () => {
  assert.match(deployWorkflow, /supabase functions deploy analyze-bill-screenshot/);
});
