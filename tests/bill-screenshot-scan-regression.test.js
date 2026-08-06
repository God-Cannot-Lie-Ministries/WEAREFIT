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

test("bill document reading is exposed from profile and upcoming bills", () => {
  assert.match(appSource, /function billScanPanel/);
  assert.match(appSource, /function showBillScanUploadModal/);
  assert.match(appSource, /function showBillScanReviewModal/);
  assert.match(appSource, /data-open-bill-scan/);
  assert.match(appSource, /id="bill-scan-confirm-form"/);
  assert.match(appSource, /Read bill PDF/);
  assert.match(appSource, /accept="application\/pdf,image\/png,image\/jpeg,image\/webp,\.pdf,\.png,\.jpg,\.jpeg,\.webp"/);
});

test("confirmed bill document read updates only next payment fields and scan history", () => {
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

test("bill document reader uses PDF text first with OCR backup", () => {
  assert.match(appSource, /function loadPdfTextLibrary/);
  assert.match(appSource, /pdfjs-dist@3\.11\.174\/build\/pdf\.min\.js/);
  assert.match(appSource, /async function extractPdfBillDocumentText/);
  assert.match(appSource, /function extractBillDocumentAmountDue/);
  assert.match(appSource, /function extractBillDocumentDueDate/);
  assert.match(appSource, /scanMethod: "pdf_text"/);
  assert.match(appSource, /function loadTesseractOcrLibrary/);
  assert.match(appSource, /tesseract\.js@5\/dist\/tesseract\.min\.js/);
  assert.match(appSource, /async function runBrowserBillOcr/);
  assert.match(appSource, /function combineBillDocumentScans/);
  assert.match(appSource, /"pdf_ocr_backup"/);
  assert.match(appSource, /"image_ocr"/);
  const scanBlock = appSource.match(/async function analyzeBillDocumentFile\(file\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(scanBlock, /application\/pdf/);
  assert.match(scanBlock, /\\.pdf\$/);
  assert.match(scanBlock, /image\/png/);
  assert.match(scanBlock, /image\/jpeg/);
  assert.match(scanBlock, /image\/webp/);
  assert.match(scanBlock, /billScanNeedsOcrBackup\(pdfTextScan\)/);
  assert.doesNotMatch(scanBlock, /productionBackend\.analyzeBillScreenshot/);
  assert.doesNotMatch(scanBlock, /uploadPrivateFile\("financial-documents", file, "bill-screenshots"\)/);
});

test("legacy server-side analyzer no longer calls paid AI services", () => {
  assert.match(backendSource, /analyzeBillScreenshot/);
  assert.match(backendSource, /functions\.invoke\("analyze-bill-screenshot"/);
  assert.match(functionSource, /scanMethod: "hybrid_document_reader"/);
  assert.match(functionSource, /status: 410/);
  assert.doesNotMatch(functionSource, /OPENAI_API_KEY/);
  assert.doesNotMatch(functionSource, /api\.openai\.com/);
  assert.doesNotMatch(functionSource, /from\("portal_states"\)\.update/);
});

test("secure function deployment keeps the legacy bill document compatibility endpoint", () => {
  assert.match(deployWorkflow, /supabase functions deploy analyze-bill-screenshot/);
});
