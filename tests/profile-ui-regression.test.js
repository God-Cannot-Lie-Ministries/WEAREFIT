const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("saving the financial profile clears focus instead of reopening recurring bill controls", () => {
  assert.match(appSource, /function\s+settleFinancialProfileSaveFocus/);
  const saveButtonBlock = appSource.match(
    /const saveProfileButton = event\.target\.closest\("\[data-save-financial-profile\]"\);[\s\S]*?return;\n  \}/,
  )?.[0] || "";
  assert.match(saveButtonBlock, /event\.preventDefault\(\)/);
  assert.match(saveButtonBlock, /settleFinancialProfileSaveFocus\(saveProfileButton\)/);
  assert.match(saveButtonBlock, /await saveFinancialProfileNow\(\)/);
  assert.doesNotMatch(saveButtonBlock, /revealNewEntry/);
  assert.doesNotMatch(saveButtonBlock, /data-recurring-schedule-toggle/);
});

test("mobile profile photos keep a fixed circular aspect ratio", () => {
  assert.match(stylesSource, /Final avatar aspect lock/);
  assert.match(stylesSource, /--fit-avatar-size/);
  assert.match(stylesSource, /aspect-ratio:\s*1\s*\/\s*1\s*!important/);
  assert.match(stylesSource, /border-radius:\s*50%\s*!important/);
  assert.match(stylesSource, /object-fit:\s*cover\s*!important/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*768px\)/);
});

test("floating calculator keeps a clean collapsed and fixed-ratio open layout", () => {
  assert.match(stylesSource, /Final calculator view repair/);
  assert.match(stylesSource, /\.draggable-calculator:not\(\.minimized\)[\s\S]*aspect-ratio:\s*11\s*\/\s*16\s*!important/);
  assert.match(stylesSource, /\.draggable-calculator:not\(\.minimized\)[\s\S]*resize:\s*horizontal\s*!important/);
  assert.match(stylesSource, /\.draggable-calculator\.minimized \.calculator-history-toggle[\s\S]*display:\s*none\s*!important/);
  assert.match(stylesSource, /\.draggable-calculator\.minimized[\s\S]*height:\s*48px\s*!important/);
});
