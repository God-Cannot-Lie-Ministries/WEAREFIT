const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const names = ['currencyValue', 'dateValueFromLocal', 'nextMonthlyDueDate', 'fixedPaymentSchedule', 'nextPaymentPeriod', 'paymentPeriodSummary', 'advancePaidRecurringBill', 'recordPeriodPayment', 'mortgageWorksheetPayment', 'recurringBillNextDueDate', 'recurringBillToWorksheetBill', 'recurringBillIsPaidForDueDate', 'isUpcomingRecurringBill', 'isDateWithinNextDays', 'addDays', 'matchingProfileBills', 'syncWorksheetBillsWithProfile', 'markUpcomingBillPaid', 'normalizeRestoredRecurringBill', 'blankRecurringBill', 'recurringScheduleEnabledFromBill'];
const ctx = vm.createContext({ todayValue: () => '2026-10-01', blankBill: () => ({ id: 'new-row' }), clone: (v) => structuredClone(v), uid: () => 'generated-id', ensureFinancialInventory: () => {}, WORKSHEET_BILL_LOOKAHEAD_DAYS: 15 });
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
  assert.equal(ctx.nextPaymentPeriod('2028-01-31', 'last'), '2028-02-29');
  assert.equal(ctx.nextPaymentPeriod('2028-02-29', 'last'), '2028-03-31');
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

test('marking a fixed bill paid saves next month and cannot advance twice for the same payment', () => {
  const b = bill();
  const account = { financialInventory: { recurringBills: [b] } };
  assert.equal(ctx.markUpcomingBillPaid(account, 'recurringBills', b.id, '2026-10-01'), 'Rent');
  assert.equal(b.nextDueDate, '2026-11-01');
  assert.equal(b.paidDueDate, '2026-10-01');
  assert.equal(b.amount, '1200');
  ctx.markUpcomingBillPaid(account, 'recurringBills', b.id, '2026-10-01');
  assert.equal(b.nextDueDate, '2026-11-01');
  assert.equal(b.paymentHistory.length, 1);
});

test('marking a variable bill paid does not invent its next due date', () => {
  const b = bill({ scheduleEnabled: false, dueDay: '', monthlyAmount: '' });
  ctx.markUpcomingBillPaid({ financialInventory: { recurringBills: [b] } }, 'recurringBills', b.id, b.nextDueDate);
  assert.equal(b.nextDueDate, '');
  assert.equal(b.paidDueDate, '2026-10-01');
});

test('loading saved fixed bills repairs paid and cleared dates without skipping an unpaid month', () => {
  for (const nextDueDate of ['2026-09-01', '']) {
    const restored = ctx.normalizeRestoredRecurringBill(bill({ nextDueDate, paidDueDate: '2026-09-01' }));
    assert.equal(restored.nextDueDate, '2026-10-01');
    assert.equal(ctx.normalizeRestoredRecurringBill(restored).nextDueDate, '2026-10-01');
  }
  const overdue = ctx.normalizeRestoredRecurringBill(bill({ nextDueDate: '2026-08-01' }));
  assert.equal(overdue.nextDueDate, '2026-08-01');
});

test('saved partial payments retain their month while fully paid history advances it', () => {
  const partial = bill({ paymentHistory: [{ dueDate: '2026-10-01', amount: '400.00' }] });
  assert.equal(ctx.normalizeRestoredRecurringBill(partial).nextDueDate, '2026-10-01');
  partial.paymentHistory.push({ dueDate: '2026-10-01', amount: '800.00' });
  const restored = ctx.normalizeRestoredRecurringBill(partial);
  assert.equal(restored.nextDueDate, '2026-11-01');
  assert.equal(restored.paymentHistory.length, 2);
});

test('a fixed last-day bill rolls through February only after full payment', () => {
  const b = bill({ dueDay: 'last', nextDueDate: '2028-01-31' });
  ctx.recordPeriodPayment(b, '2028-01-31', 500, 'first');
  assert.equal(b.nextDueDate, '2028-01-31');
  ctx.recordPeriodPayment(b, '2028-01-31', 700, 'second');
  assert.equal(b.nextDueDate, '2028-02-29');
  ctx.recordPeriodPayment(b, '2028-02-29', 1200, 'third');
  assert.equal(b.nextDueDate, '2028-03-31');
});

test('drafts drop paid old periods when next month is outside the worksheet window', () => {
  const b = bill();
  const oldRow = ctx.recurringBillToWorksheetBill(b);
  ctx.recordPeriodPayment(b, oldRow.dueDate, 1200, 'paid');
  const rows = ctx.syncWorksheetBillsWithProfile([oldRow], [b]);
  assert.equal(rows.filter(row => row.name).length, 0);
});

test('drafts use the next monthly date with fresh payment choices when it is due soon', () => {
  const b = bill({ nextDueDate: '2026-09-05', dueDay: '5' });
  const oldRow = ctx.recurringBillToWorksheetBill(b);
  oldRow.memberSuggestion = 'this_check';
  oldRow.coachDecision = 'this_check';
  ctx.recordPeriodPayment(b, oldRow.dueDate, 1200, 'paid');
  const next = ctx.syncWorksheetBillsWithProfile([oldRow], [b])[0];
  assert.equal(next.dueDate, '2026-10-05');
  assert.equal(next.amount, '1200');
  assert.equal(next.paidBefore, '0');
  assert.equal(next.memberSuggestion, '');
  assert.equal(next.coachDecision, '');
});

test('draft payments are preserved when no saved bill total or payment proves they are paid', () => {
  const b = bill({ amount: '', monthlyAmount: '', scheduleEnabled: false, dueDay: '' });
  const row = { id: 'draft-row', profileBillId: b.id, name: b.name, dueDate: b.nextDueDate, amount: '200' };
  const next = ctx.syncWorksheetBillsWithProfile([row], [b])[0];
  assert.equal(next.id, 'draft-row');
  assert.equal(next.amount, '200');
  assert.equal(next.dueDate, '2026-10-01');
});
