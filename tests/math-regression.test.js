const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../app-20260626-recurring-bill-restore.js"), "utf8");
const ctx = vm.createContext({ rolloverTypes: ["debt", "credit_card", "student_loan", "savings"] });
for (const name of ["currencyValue", "allocationTotalFor", "shouldPayThisCheck", "effectiveContribution", "plannedContribution", "remainingAfterPlannedPayment", "calculate"]) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
  assert.ok(match, `production function ${name}`);
  vm.runInContext(match[0], ctx);
}
const { calculate, remainingAfterPlannedPayment, currencyValue } = ctx;

function sampleForm() {
  return {
    data: {
      overview: { thisCheck: "1522.05", additionalIncome: "125.75" },
      bills: {
        housing: [{ amount: "500.10", coachDecision: "this_check" }],
        utilities: [{ amount: "80.20", coachDecision: "next_check" }],
        insurance: [],
        subscriptions: [],
        other: [],
      },
      creditCards: [
        { account: "Capital One", totalBalance: "1000.00", contribution: "75.25", coachDecision: "this_check" },
        { account: "Discover", totalBalance: "300.00", contribution: "40.00", coachDecision: "next_check" },
      ],
      debts: [{ account: "Medical", totalOwed: "500.00", coachDecision: "this_check", contribution: "25.50" }],
      studentLoans: [{ account: "Federal Loan", totalOwed: "900.00", coachDecision: "this_check", contribution: "50.25" }],
      mortgage: { currentBalance: "200000.00", coachDecision: "this_check", contribution: "250.00" },
      housingPaymentType: "mortgage",
      savings: { current: "1000.00", coachDecision: "this_check", contribution: "100.00" },
      allocations: [
        { coachDecision: "this_check", type: "credit_card", account: "Capital One", amount: "100.00" },
        { coachDecision: "this_check", type: "credit_card", account: "Discover", amount: "20.00" },
        { coachDecision: "this_check", type: "debt", account: "Medical", amount: "10.00" },
        { coachDecision: "this_check", type: "student_loan", account: "Federal Loan", amount: "15.00" },
        { coachDecision: "this_check", type: "savings", account: "Emergency Fund", amount: "30.00" },
      ],
      variableSpending: [{ coachDecision: "this_check", budgeted: "200.55" }],
    },
  };
}

test("worksheet math includes additional income in tithe and keeps cents everywhere else", () => {
  const calc = calculate(sampleForm());
  assert.equal(calc.totalIncome, 1647.8);
  assert.equal(calc.tithe, 165);
  assert.equal(calc.fixedBills, 500.1);
  assert.equal(calc.creditCards, 75.25);
  assert.equal(calc.debtContributions, 25.5);
  assert.equal(calc.studentLoanContributions, 50.25);
  assert.equal(calc.mortgageContribution, 250);
  assert.equal(calc.savingsContribution, 100);
  assert.equal(calc.allocationTotal, 175);
  assert.equal(calc.variableBudget, 200.55);
  assert.equal(calc.available, 106.15);
});

test("currency helper accepts comma-formatted values and keeps two-decimal math", () => {
  assert.equal(currencyValue("1,522.05"), 1522.05);
  assert.equal(currencyValue("1,000.105"), 1000.11);
  assert.equal(currencyValue(""), 0);
});

test("budgeted categories reduce left-to-budget without rounding to whole dollars", () => {
  const form = sampleForm();
  form.data.variableSpending = [
    { memberSuggestion: "this_check", category: "Groceries", budgeted: "50.25" },
    { memberSuggestion: "this_check", category: "Gas", budgeted: "25.10" },
  ];
  const calc = calculate(form);
  assert.equal(calc.variableBudget, 75.35);
  assert.equal(calc.available, 231.35);
});

test("wait-for-next-check skips the regular card payment but still honors rollover payment", () => {
  const form = sampleForm();
  const calc = calculate(form);
  assert.equal(calc.totalCreditCardBalanceAfter, 1104.75);
  assert.equal(remainingAfterPlannedPayment(form.data.creditCards[0], form, "credit_card"), 824.75);
  assert.equal(remainingAfterPlannedPayment(form.data.creditCards[1], form, "credit_card"), 280);
});

test("member next-check selection immediately excludes payments before coach review", () => {
  const form = sampleForm();
  form.data.bills.housing[0].coachDecision = "";
  form.data.bills.housing[0].memberSuggestion = "next_check";
  form.data.creditCards[0].coachDecision = "";
  form.data.creditCards[0].memberSuggestion = "next_check";
  let calc = calculate(form);
  assert.equal(calc.fixedBills, 0);
  assert.equal(calc.creditCards, 0);

  form.data.bills.housing[0].coachDecision = form.data.bills.housing[0].memberSuggestion;
  form.data.creditCards[0].coachDecision = form.data.creditCards[0].memberSuggestion;
  calc = calculate(form);
  assert.equal(calc.fixedBills, 0);
  assert.equal(calc.creditCards, 0);
});

test("coach wait decision skips every contribution section for this check", () => {
  const form = sampleForm();
  form.data.debts[0].coachDecision = "next_check";
  form.data.studentLoans[0].coachDecision = "next_check";
  form.data.mortgage.coachDecision = "next_check";
  form.data.savings.coachDecision = "next_check";
  form.data.allocations.forEach((item) => {
    item.coachDecision = "next_check";
  });
  form.data.variableSpending[0].coachDecision = "next_check";
  const calc = calculate(form);
  assert.equal(calc.debtContributions, 0);
  assert.equal(calc.studentLoanContributions, 0);
  assert.equal(calc.mortgageContribution, 0);
  assert.equal(calc.savingsContribution, 0);
  assert.equal(calc.allocationTotal, 0);
  assert.equal(calc.variableBudget, 0);
  assert.equal(calc.savingsAfter, 1000);
  assert.equal(calc.mortgageAfter, 200000);
});

test("rollovers reduce debts and student loans", () => {
  const form = sampleForm();
  const calc = calculate(form);
  assert.equal(calc.totalDebtBalanceAfter, 464.5);
  assert.equal(calc.totalStudentLoanBalanceAfter, 834.75);
});

test("mortgage and savings balances calculate after this check", () => {
  const calc = calculate(sampleForm());
  assert.equal(calc.mortgageAfter, 199750);
  assert.equal(calc.savingsAfter, 1130);
});

test("rent selection excludes mortgage from planned outflow and balance changes", () => {
  const form = sampleForm();
  form.data.housingPaymentType = "rent";
  const calc = calculate(form);
  assert.equal(calc.mortgageContribution, 0);
  assert.equal(calc.mortgageAfter, 200000);
  assert.equal(calc.available, 356.15);
});

test("clearing a bill choice excludes it and restores available money without deleting its amount", () => {
  const form = sampleForm();
  const row = form.data.bills.housing[0];
  row.coachDecision = "";
  row.memberSuggestion = "this_check";
  const selected = calculate(form);
  row.memberSuggestion = "";
  const cleared = calculate(form);
  assert.equal(cleared.fixedBills, 0);
  assert.equal(cleared.totalBills, currencyValue(selected.totalBills - 500.1));
  assert.equal(cleared.available, currencyValue(selected.available + 500.1));
  assert.equal(row.amount, "500.10");
  row.memberSuggestion = "next_check";
  assert.equal(calculate(form).fixedBills, 0);
  row.coachDecision = "this_check";
  assert.equal(calculate(form).fixedBills, 500.1);
  row.coachDecision = "next_check";
  row.memberSuggestion = "this_check";
  assert.equal(calculate(form).fixedBills, 0);
});

test("visible category subtotals, bill summary and available balance refresh when choices change", () => {
  const elements = {
    "[data-live-fixed-bills]": [{ textContent: "" }, { textContent: "" }],
    "[data-live-bill-subtotal]": [{ dataset: { liveBillSubtotal: "housing" }, textContent: "" }],
    "[data-live-total-planned]": [{ textContent: "" }],
    "[data-live-available]": [{ textContent: "" }],
  };
  ctx.document = { querySelectorAll: (selector) => elements[selector] || [] };
  ctx.money = (value) => currencyValue(value).toFixed(2);
  ctx.titheMoney = ctx.money;
  vm.runInContext(source.match(/^function refreshLiveAvailable\([^]*?^}/m)[0], ctx);
  const form = sampleForm();
  const row = form.data.bills.housing[0];
  row.coachDecision = "";
  for (const decision of ["this_check", "next_check", "", "this_check"]) {
    row.memberSuggestion = decision;
    ctx.refreshLiveAvailable(form);
    const calc = calculate(form);
    assert.equal(elements["[data-live-fixed-bills]"][0].textContent, calc.fixedBills.toFixed(2));
    assert.equal(elements["[data-live-fixed-bills]"][1].textContent, calc.fixedBills.toFixed(2));
    assert.equal(elements["[data-live-bill-subtotal]"][0].textContent, calc.fixedBills.toFixed(2));
    assert.equal(elements["[data-live-total-planned]"][0].textContent, calc.totalPlanned.toFixed(2));
    assert.equal(elements["[data-live-available]"][0].textContent, calc.available.toFixed(2));
  }
});
