const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const names = ['currencyValue', 'dateValueFromLocal', 'nextMonthlyDueDate', 'fixedPaymentSchedule', 'nextPaymentPeriod', 'paymentPeriodSummary', 'recordPeriodPayment', 'mortgageWorksheetPayment', 'recurringBillNextDueDate', 'recurringBillToWorksheetBill', 'recurringBillIsPaidForDueDate', 'isUpcomingRecurringBill', 'isDateWithinNextDays', 'addDays', 'matchingProfileBills', 'syncWorksheetBillsWithProfile'];
const ctx = vm.createContext({ todayValue: () => '2026-10-01', blankBill: () => ({ id: 'new-row' }), clone: (v) => structuredClone(v), WORKSHEET_BILL_LOOKAHEAD_DAYS: 15 });
for (const name of names) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `production function ${name}`);
  vm.runInContext(match[0], ctx);
}
const bill = (extras = {}) => ({ id: 'rent', name: 'Rent', category: 'housing', amount: '1200', nextDueDate: '2026-10-01', scheduleEnabled: true, monthlyAmount: '1200', dueDay: '1', ...extras });

test('rent payments accumulate across three worksheets and reset only on completion', () => {
  const b = bill();
  ctx.recordPeriodPayment(b, '2026-10-01', 400, 'form-1');
  assert.equal(ctx.recurringBillToWorksheetBill(b).amount, '800');
  assert.equal(ctx.recurringBillToWorksheetBill(b).paidBefore, '400');
  ctx.recordPeriodPayment(b, '2026-10-01', 350, 'form-2');
  assert.equal(ctx.recurringBillToWorksheetBill(b).amount, '450');
  ctx.recordPeriodPayment(b, '2026-10-01', 450, 'form-3');
  const next = ctx.recurringBillToWorksheetBill(b);
  assert.equal(next.dueDate, '2026-11-01');
  assert.equal(next.amount, '1200');
  assert.equal(next.paidBefore, '0');
  assert.equal(b.paymentHistory.length, 3);
});
test('repeated approval source cannot double count a payment', () => {
  const b = bill();
  ctx.recordPeriodPayment(b, b.nextDueDate, 400, 'same-form');
  ctx.recordPeriodPayment(b, b.nextDueDate, 400, 'same-form');
  assert.equal(ctx.paymentPeriodSummary(b, b.nextDueDate).paid, 400);
});
test('unpaid overdue periods remain on new worksheets', () => {
  const b = bill({ nextDueDate: '2026-09-01' });
  ctx.recordPeriodPayment(b, b.nextDueDate, 400, 'old-payment');
  assert.equal(ctx.isUpcomingRecurringBill(b), true);
  assert.equal(ctx.recurringBillToWorksheetBill(b).dueDate, '2026-09-01');
  assert.equal(ctx.recurringBillToWorksheetBill(b).amount, '800');
});
test('variable bills remain paid until a new due date is entered', () => {
  const b = bill({ scheduleEnabled: false, dueDay: '', monthlyAmount: '' });
  ctx.recordPeriodPayment(b, b.nextDueDate, 1200, 'paid');
  assert.equal(ctx.recurringBillToWorksheetBill(b).amount, '0');
  assert.equal(ctx.isUpcomingRecurringBill(b), false);
  b.nextDueDate = '2026-11-01';
  assert.equal(ctx.recurringBillToWorksheetBill(b).amount, '1200');
});
test('fixed day alone does not reset a bill without a fixed price', () => {
  const b = bill({ monthlyAmount: '' });
  ctx.recordPeriodPayment(b, b.nextDueDate, 1200, 'paid');
  assert.equal(b.nextDueDate, '2026-10-01');
});
test('monthly dates clamp February then restore the original day', () => {
  assert.equal(ctx.nextPaymentPeriod('2028-01-31', '31'), '2028-02-29');
  assert.equal(ctx.nextPaymentPeriod('2028-02-29', '31'), '2028-03-31');
  assert.equal(ctx.nextPaymentPeriod('2026-12-31', '31'), '2027-01-31');
});
test('mortgage partial payments use the remaining monthly amount, preserving principal', () => {
  const mortgage = bill({ paymentAmount: '1200', currentBalance: '150000' });
  ctx.recordPeriodPayment(mortgage, mortgage.nextDueDate, 500, 'form-1:mortgage', mortgage.paymentAmount);
  assert.equal(ctx.mortgageWorksheetPayment(mortgage).paymentAmount, '700');
  assert.equal(ctx.mortgageWorksheetPayment(mortgage).paidBefore, '500');
  assert.equal(mortgage.currentBalance, '150000');
  ctx.recordPeriodPayment(mortgage, mortgage.nextDueDate, 700, 'form-2:mortgage', mortgage.paymentAmount);
  assert.equal(ctx.mortgageWorksheetPayment(mortgage).paymentAmount, '1200');
  assert.equal(ctx.mortgageWorksheetPayment(mortgage).nextDueDate, '2026-11-01');
});
test('decimal and excessive payments cannot produce a negative remainder', () => {
  const b = bill({ amount: '0.30', monthlyAmount: '', scheduleEnabled: false });
  ctx.recordPeriodPayment(b, b.nextDueDate, '0.10', 'a');
  assert.equal(ctx.paymentPeriodSummary(b, b.nextDueDate).remaining, 0.2);
  ctx.recordPeriodPayment(b, b.nextDueDate, 2, 'b');
  assert.equal(ctx.paymentPeriodSummary(b, b.nextDueDate).remaining, 0);
  assert.equal(b.paymentHistory[1].amount, '0.20');
});
test('profile synchronization preserves an entered partial payment and row identity', () => {
  const b = bill();
  const row = ctx.recurringBillToWorksheetBill(b);
  row.amount = '200';
  const synced = ctx.syncWorksheetBillsWithProfile([row], [b])[0];
  assert.equal(synced.amount, '200');
  assert.equal(synced.id, row.id);
});
test('search is case insensitive, trims spaces, and only uses the selected profile', () => {
  const account = { financialInventory: { recurringBills: [bill(), bill({ id: 'power', name: 'Power & Light' })] } };
  assert.equal(ctx.matchingProfileBills(account, '  POW ')[0].id, 'power');
  assert.equal(ctx.matchingProfileBills(account, 'missing').length, 0);
  assert.equal(ctx.matchingProfileBills(account, ' ').length, 0);
});
