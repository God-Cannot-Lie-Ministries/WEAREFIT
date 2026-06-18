const test = require("node:test");
const assert = require("node:assert/strict");

function currencyValue(value) {
  const numericValue = typeof value === "string" ? value.replaceAll(",", "") : value;
  return Math.round(((Number(numericValue) || 0) + Number.EPSILON) * 100) / 100;
}

function allocationTotalFor(form, type, accountName) {
  const normalizedAccount = String(accountName || "").trim().toLowerCase();
  if (!normalizedAccount) return 0;
  return currencyValue((form.data.allocations || [])
    .filter((item) => item.type === type && String(item.account || "").trim().toLowerCase() === normalizedAccount)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
}

function plannedContribution(row, form, type) {
  const regularContribution =
    type === "credit_card" && row.coachDecision === "next_check"
      ? 0
      : Number(row.contribution) || 0;
  return currencyValue(regularContribution + allocationTotalFor(form, type, row.account));
}

function remainingAfterPlannedPayment(row, form, type) {
  return currencyValue(Math.max(0, (Number(row.totalBalance ?? row.totalOwed) || 0) - plannedContribution(row, form, type)));
}

function calculate(form) {
  const data = form.data;
  const thisCheck = currencyValue(data.overview.thisCheck);
  const additionalIncome = currencyValue(data.overview.additionalIncome);
  const totalIncome = currencyValue(thisCheck + additionalIncome);
  const tithe = Math.round(totalIncome * 0.1);
  const fixedBills = currencyValue(Object.values(data.bills)
    .flat()
    .filter((item) => item.coachDecision !== "next_check")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const creditCards = currencyValue(data.creditCards.reduce(
    (sum, item) => sum + (item.coachDecision === "next_check" ? 0 : Number(item.contribution) || 0),
    0,
  ));
  const debtContributions = currencyValue(data.debts.reduce(
    (sum, item) => sum + (Number(item.contribution) || 0),
    0,
  ));
  const studentLoanContributions = currencyValue((data.studentLoans || []).reduce(
    (sum, item) => sum + (Number(item.contribution) || 0),
    0,
  ));
  const mortgageContribution = currencyValue(data.housingPaymentType === "mortgage" ? Number(data.mortgage.contribution) || 0 : 0);
  const savingsContribution = currencyValue(data.savings.contribution);
  const savingsRolloverTotal = currencyValue((data.allocations || [])
    .filter((item) => item.type === "savings")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const savingsAfter = currencyValue((Number(data.savings.current) || 0) + (Number(data.savings.contribution) || 0) + savingsRolloverTotal);
  const mortgageAfter = currencyValue(Math.max(0, (Number(data.mortgage.currentBalance || data.mortgage.remainingBefore) || 0) - mortgageContribution));
  const allocationTotal = currencyValue((data.allocations || [])
    .filter((item) => ["debt", "credit_card", "student_loan", "savings"].includes(item.type))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const variableBudget = currencyValue(data.variableSpending.reduce(
    (sum, item) => sum + (Number(item.budgeted) || 0),
    0,
  ));
  const plannedBeforeBudget = currencyValue(
    fixedBills +
    creditCards +
    debtContributions +
    studentLoanContributions +
    mortgageContribution +
    savingsContribution,
  );
  const remainingBeforeAllocations = currencyValue(totalIncome - tithe - plannedBeforeBudget);
  const remainingBeforeBudget = currencyValue(remainingBeforeAllocations - allocationTotal);
  const totalBills = currencyValue(plannedBeforeBudget + variableBudget);
  const totalPlanned = currencyValue(totalBills + allocationTotal);
  const available = currencyValue(totalIncome - tithe - totalPlanned);
  return {
    totalIncome,
    tithe,
    fixedBills,
    creditCards,
    debtContributions,
    studentLoanContributions,
    mortgageContribution,
    savingsContribution,
    plannedBeforeBudget,
    remainingBeforeBudget,
    variableBudget,
    allocationTotal,
    totalPlanned,
    available,
    savingsAfter,
    mortgageAfter,
    totalCreditCardBalanceAfter: currencyValue(data.creditCards.reduce(
      (sum, item) => sum + remainingAfterPlannedPayment(item, form, "credit_card"),
      0,
    )),
    totalDebtBalanceAfter: currencyValue(data.debts.reduce(
      (sum, item) => sum + remainingAfterPlannedPayment(item, form, "debt"),
      0,
    )),
    totalStudentLoanBalanceAfter: currencyValue((data.studentLoans || []).reduce(
      (sum, item) => sum + remainingAfterPlannedPayment(item, form, "student_loan"),
      0,
    )),
  };
}

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
        { account: "Capital One", totalBalance: "1000.00", contribution: "75.25", coachDecision: "" },
        { account: "Discover", totalBalance: "300.00", contribution: "40.00", coachDecision: "next_check" },
      ],
      debts: [{ account: "Medical", totalOwed: "500.00", contribution: "25.50" }],
      studentLoans: [{ account: "Federal Loan", totalOwed: "900.00", contribution: "50.25" }],
      mortgage: { currentBalance: "200000.00", contribution: "250.00" },
      housingPaymentType: "mortgage",
      savings: { current: "1000.00", contribution: "100.00" },
      allocations: [
        { type: "credit_card", account: "Capital One", amount: "100.00" },
        { type: "credit_card", account: "Discover", amount: "20.00" },
        { type: "debt", account: "Medical", amount: "10.00" },
        { type: "student_loan", account: "Federal Loan", amount: "15.00" },
        { type: "savings", account: "Emergency Fund", amount: "30.00" },
      ],
      variableSpending: [{ budgeted: "200.55" }],
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

test("wait-for-next-check skips the regular card payment but still honors rollover payment", () => {
  const form = sampleForm();
  const calc = calculate(form);
  assert.equal(calc.totalCreditCardBalanceAfter, 1104.75);
  assert.equal(remainingAfterPlannedPayment(form.data.creditCards[0], form, "credit_card"), 824.75);
  assert.equal(remainingAfterPlannedPayment(form.data.creditCards[1], form, "credit_card"), 280);
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
