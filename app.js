const STORAGE_KEY = "fit-financial-portal-v1";
const productionBackend = window.WEAREFIT_BACKEND || { enabled: false };

const billGroups = [
  ["housing", "Housing"],
  ["utilities", "Utilities"],
  ["insurance", "Insurance"],
  ["subscriptions", "Subscriptions / Services"],
  ["other", "Other Bills"],
];
const rolloverTypes = ["debt", "credit_card", "student_loan", "savings"];
const billReminderDayOptions = [1, 2, 3, 4, 5, 6, 7];
const WORKSHEET_BILL_LOOKAHEAD_DAYS = 15;

let appState = loadState();
let activeView = "dashboard";
let activeFormId = null;
let loginRole = "user";
let loginMode = "signin";
let pendingVerificationEmail = null;
let confirmationResendNeeded = false;
let toastTimer = null;
let pendingPaystubUpload = null;
let pendingBillScanUpload = null;
let formAutosaveTimer = null;
let lastLocalSaveAt = 0;
let lastUserActivityAt = Date.now();
let lastPresenceUpdateAt = 0;
let inactivityLogoutInProgress = false;
let calculatorDragState = null;
let calculatorInteractionUntil = 0;
let calculatorResizeObserver = null;
let pageLoadingTimer = null;
let pageLoadingHideTimer = null;
let portalInitializationInProgress = false;
let portalDataReady = !productionBackend.enabled;
let portalLoadError = null;
let lastTemporaryErrorNoticeAt = 0;
let portalRefreshTimer = null;
let portalRefreshQueued = false;
let lastPortalRefreshAt = 0;
const INACTIVITY_LIMIT_MS = 15 * 60 * 1000;
const MILESTONE_RESET_VERSION = "2026-06-13-withdrawal-repair";
const MILESTONE_RESET_CUTOFF = new Date("2026-06-13T16:00:00Z").getTime();
const urlParameters = new URLSearchParams(window.location.search);
const inviteCoachFromUrl = urlParameters.get("coachInvite");
const passwordResetFromUrl = urlParameters.get("passwordReset") === "1";
const verifyDeleteAccountFromUrl = urlParameters.get("verifyDeleteAccount") === "1";
const clearSiteDataFromUrl =
  urlParameters.get("clearFitSiteData") === "1" || urlParameters.get("clearSiteData") === "1";
const deleteVerificationEmail = normalizeEmail(urlParameters.get("email"));
const deleteVerificationToken = String(urlParameters.get("token") || "");
if (inviteCoachFromUrl) sessionStorage.setItem("fit-pending-coach-invite", normalizeEmail(inviteCoachFromUrl));
if (!clearSiteDataFromUrl && passwordResetFromUrl) loginMode = "reset";
if (!clearSiteDataFromUrl && verifyDeleteAccountFromUrl) loginMode = "delete-verify";

const app = document.getElementById("app");
const toast = document.getElementById("toast");

applyTheme();

async function clearFitSiteDataFromBrowser() {
  try {
    await productionBackend.signOut?.();
  } catch (error) {
    console.warn("Could not sign out while clearing F.I.T. browser data", error);
  }

  try {
    localStorage.clear();
  } catch (error) {
    console.warn("Could not clear local F.I.T. browser data", error);
  }

  try {
    sessionStorage.clear();
  } catch (error) {
    console.warn("Could not clear temporary F.I.T. browser data", error);
  }

  try {
    if ("caches" in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn("Could not clear F.I.T. cache data", error);
  }

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch (error) {
    console.warn("Could not clear F.I.T. service workers", error);
  }

  try {
    if ("indexedDB" in window && indexedDB.databases) {
      const databases = await indexedDB.databases();
      await Promise.all(
        databases
          .map((database) => database.name)
          .filter(Boolean)
          .map(
            (name) =>
              new Promise((resolve) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = request.onerror = request.onblocked = resolve;
              }),
          ),
      );
    }
  } catch (error) {
    console.warn("Could not clear F.I.T. indexed browser data", error);
  }

  appState = loadState();
  activeView = "dashboard";
  activeFormId = null;
  loginRole = "user";
  loginMode = "signin";
  pendingVerificationEmail = null;
  confirmationResendNeeded = false;
  pendingPaystubUpload = null;
  pendingBillScanUpload = null;
  portalDataReady = !productionBackend.enabled;
  portalLoadError = null;

  const cleanUrl = `${window.location.origin}${window.location.pathname}`;
  window.history.replaceState({}, "", cleanUrl);
  app.innerHTML = `
    <main class="login-shell">
      <section class="auth-panel fit-data-cleared-panel">
        <div class="auth-logo-wrap">
          <img class="auth-logo" src="assets/fit-logo-exact-transparent.png" alt="F.I.T. Financial Integrity Training" />
        </div>
        <p class="eyebrow">Browser data cleared</p>
        <h1>F.I.T. is ready for a fresh sign in.</h1>
        <p class="muted">Saved website data for this browser was cleared. Your secure account data is still protected on the server.</p>
        <button class="primary-action" type="button" data-clear-data-signin>Go to sign in</button>
      </section>
    </main>
  `;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function portalContentSignature(state) {
  return JSON.stringify(state, (key, value) => {
    if (["dataUrl", "lastActiveAt", "sessionEmail", "coachPhotoCheckedAt"].includes(key)) return undefined;
    return value;
  });
}

function stabilizeMediaUrls(currentState, nextState) {
  let mediaBecameAvailable = false;
  Object.entries(nextState.accounts || {}).forEach(([email, nextAccount]) => {
    const currentAccount = currentState.accounts?.[email];
    if (!currentAccount) return;
    ["profilePhoto", "spousePhoto"].forEach((field) => {
      const currentPhoto = currentAccount[field];
      const nextPhoto = nextAccount[field];
      if (!currentPhoto?.storagePath || !nextPhoto?.storagePath) return;
      if (currentPhoto.storagePath !== nextPhoto.storagePath) return;
      if (currentPhoto.dataUrl) {
        nextPhoto.dataUrl = currentPhoto.dataUrl;
      } else if (nextPhoto.dataUrl) {
        currentPhoto.dataUrl = nextPhoto.dataUrl;
        mediaBecameAvailable = true;
      }
    });
  });
  return mediaBecameAvailable;
}

function usableDisplayName(value, email = "") {
  const name = String(value || "").trim();
  return name && normalizeEmail(name) !== normalizeEmail(email) && !validEmail(name) ? name : "";
}

function coachDisplayName(member, coach, fallback = "F.I.T. coach") {
  return (
    usableDisplayName(coach?.name, coach?.email || member?.coachEmail) ||
    usableDisplayName(member?.coachName, member?.coachEmail) ||
    fallback
  );
}

function validEmail(value) {
  const email = normalizeEmail(value);
  const [localPart = "", domain = ""] = email.split("@");
  return (
    email.length <= 254 &&
    localPart.length > 0 &&
    localPart.length <= 64 &&
    domain.includes(".") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

function authErrorMessage(error, action = "continue") {
  const message = String(error?.message || "");
  if (/rate limit|too many requests/i.test(message)) {
    return "Too many email attempts were made. Wait a few minutes, then try again.";
  }
  if (/already registered|already exists|user already/i.test(message)) {
    return "An account already exists for this email. Sign in or reset your password.";
  }
  if (/invalid.*email|email.*invalid/i.test(message)) {
    return "Enter a valid email address. Gmail, Yahoo, Outlook, iCloud, AOL, Proton, and business email addresses are supported.";
  }
  if (/email.*not confirmed/i.test(message)) {
    return "Confirm your email before signing in. Check your inbox and spam folder, or resend the confirmation email.";
  }
  if (/sending|smtp|provider|email.*failed/i.test(message)) {
    return "The email provider could not deliver this message yet. Check the address, then try again in a few minutes.";
  }
  return message || `Unable to ${action}. Please try again.`;
}

function emailConfirmationRequired(error) {
  const details = `${error?.code || ""} ${error?.message || ""}`.replaceAll("_", " ");
  return /email.*not confirmed|not.*confirmed/i.test(details);
}

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function todayValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function blankBill() {
  return { id: uid("bill"), name: "", dueDate: "", amount: "", memberSuggestion: "", coachDecision: "" };
}

function blankCreditCard() {
  return {
    id: uid("card"),
    account: "",
    dueDate: "",
    totalBalance: "",
    lastStatementBalance: "",
    paymentDue: "",
    allowance: "",
    contribution: "",
    apr: "",
    promoType: "none",
    purchasePromoRate: "",
    purchasePromoExpiration: "",
    balanceTransferPromoRate: "",
    balanceTransferPromoExpiration: "",
    memberSuggestion: "",
    coachDecision: "",
  };
}

function blankVariable() {
  return { id: uid("variable"), category: "", budgeted: "", memberSuggestion: "", coachDecision: "" };
}

function defaultBudgetRows() {
  return ["Grocery", "Gas", "Toiletries", "Entertainment"].map((category) => ({
    ...blankVariable(),
    category,
  }));
}

function blankDebt() {
  return {
    id: uid("debt"),
    account: "",
    totalOwed: "",
    minimumPayment: "",
    contribution: "",
    apr: "",
    promotionalRateApplied: false,
    promotionalRate: "",
    promotionExpiration: "",
    notes: "",
    memberSuggestion: "",
    coachDecision: "",
  };
}

function blankRecurringBill(category = "other") {
  return {
    id: uid("recurring"),
    category,
    name: "",
    scheduleEnabled: false,
    dueDay: "",
    nextDueDate: "",
    paidDueDate: "",
    amount: "",
    monthlyAmount: "",
  };
}

function recurringScheduleEnabledFromBill(bill = {}, dueDay = bill.dueDay || "", monthlyAmount = bill.monthlyAmount || "") {
  if (Object.hasOwn(bill, "scheduleEnabled")) return Boolean(bill.scheduleEnabled);
  return Boolean(dueDay || monthlyAmount);
}

function recurringScheduleExplicitlyDisabled(bill = {}) {
  return Object.hasOwn(bill, "scheduleEnabled") && bill.scheduleEnabled === false;
}

function blankProfileCard() {
  return {
    id: uid("profile-card"),
    account: "",
    dueDate: "",
    totalBalance: "",
    lastStatementBalance: "",
    paymentDue: "",
    allowance: "",
    apr: "",
    promoType: "none",
    purchasePromoRate: "",
    purchasePromoExpiration: "",
    balanceTransferPromoRate: "",
    balanceTransferPromoExpiration: "",
  };
}

function blankProfileDebt() {
  return {
    id: uid("profile-debt"),
    account: "",
    totalOwed: "",
    minimumPayment: "",
    dueDate: "",
    apr: "",
    promotionalRateApplied: false,
    promotionalRate: "",
    promotionExpiration: "",
    notes: "",
  };
}

function blankStudentLoan() {
  return {
    id: uid("student-loan"),
    account: "",
    loanType: "",
    totalOwed: "",
    apr: "",
    paymentDue: "",
    dueDate: "",
    contribution: "",
    memberSuggestion: "",
    coachDecision: "",
  };
}

function blankSavingsInvestmentAccount() {
  return {
    id: uid("asset-account"),
    name: "",
    type: "savings",
    balance: "",
    updatedAt: todayValue(),
    notes: "",
    history: [],
  };
}

function removePartialNameDuplicates(rows = [], key = "name") {
  const named = rows.filter((row) => String(row?.[key] || "").trim());
  return rows.filter((row) => {
    const value = String(row?.[key] || "").trim().toLowerCase();
    if (!value) return true;
    return !named.some((other) => {
      const candidate = String(other?.[key] || "").trim().toLowerCase();
      return candidate.length > value.length && candidate.startsWith(value);
    });
  });
}

function ensureFinancialInventory(account) {
  account.financialInventory ||= {
    recurringBills: [],
    creditCards: [],
    debts: [],
    studentLoans: [],
    mortgage: {},
  };
  account.financialInventory.recurringBills ||= [];
  account.financialInventory.creditCards ||= [];
  account.financialInventory.debts ||= [];
  account.financialInventory.studentLoans ||= [];
  account.financialInventory.mortgage ||= {};
  account.financialInventory.housingPaymentType ||= "mortgage";
  account.financialInventory.recurringBills = removePartialNameDuplicates(account.financialInventory.recurringBills, "name");
  account.financialInventory.creditCards = removePartialNameDuplicates(account.financialInventory.creditCards, "account");
  account.financialInventory.debts = removePartialNameDuplicates(account.financialInventory.debts, "account");
  account.financialInventory.studentLoans = removePartialNameDuplicates(account.financialInventory.studentLoans, "account");
}

function normalizedBillReminderDays(value, fallback = 5) {
  const numeric = Math.round(Number(value));
  if (numeric >= 1 && numeric <= 7) return numeric;
  const fallbackNumeric = Math.round(Number(fallback));
  return fallbackNumeric >= 1 && fallbackNumeric <= 7 ? fallbackNumeric : 5;
}

function billReminderDaysLabel(value) {
  const days = normalizedBillReminderDays(value);
  return days === 1 ? "1 day" : `${days} days`;
}

function billReminderDayButtons(account) {
  const selectedDays = normalizedBillReminderDays(account?.preferences?.billReminderDaysAhead);
  return billReminderDayOptions
    .map((days) => {
      const active = selectedDays === days ? "active" : "";
      return `<button class="type-choice ${active}" type="button" data-settings-bill-reminder-days="${days}">${days}</button>`;
    })
    .join("");
}

function ensureAccountModel(account) {
  ensureFinancialInventory(account);
  account.preferences ||= { theme: "light" };
  account.preferences.theme ||= "light";
  account.preferences.billReminderDaysAhead = normalizedBillReminderDays(account.preferences.billReminderDaysAhead);
  account.preferences.notifications ||= {};
  account.preferences.notifications.milestones ??= true;
  account.preferences.notifications.documents ??= true;
  account.preferences.notifications.sessions ??= true;
  account.profile ||= {};
  account.profile.maritalStatus ||= "";
  account.profile.spouseName ||= "";
  account.profile.spouseEmployer ||= "";
  account.profile.spousePhone ||= "";
  account.profile.spousePayFrequency ||= "";
  account.profile.phone ||= "";
  account.profile.address ||= "";
  account.profile.employer ||= "";
  account.profile.payFrequency ||= "";
  if (/twice monthly/i.test(account.profile.payFrequency)) account.profile.payFrequency = "Biweekly";
  if (/twice monthly/i.test(account.profile.spousePayFrequency)) account.profile.spousePayFrequency = "Biweekly";
  account.profilePhoto ||= null;
  account.spousePhoto ||= null;
  account.coachName ||= "";
  account.lastActiveAt ||= null;
  account.profileCompleted = Object.hasOwn(account, "profileCompleted")
    ? Boolean(account.profileCompleted)
    : true;
  account.paystubs ||= [];
  account.paystubs.forEach((paystub) => {
    paystub.submittedAt ||= paystub.uploadedAt || new Date().toISOString();
    paystub.archiveDate ||= paystub.submittedAt.slice(0, 10);
  });
  account.savingsInvestmentAccounts ||= [];
  account.savingsInvestmentAccounts.forEach((assetAccount) => {
    assetAccount.id ||= uid("asset-account");
    assetAccount.type ||= "savings";
    assetAccount.updatedAt ||= todayValue();
    assetAccount.notes ||= "";
    assetAccount.history ||= [];
    if (!assetAccount.history.length && assetAccount.balance !== "") {
      assetAccount.history.push({
        id: uid("balance"),
        balance: String(assetAccount.balance),
        date: assetAccount.updatedAt,
      });
    }
  });
  account.financialInventory.recurringBills.forEach((bill) => {
    if (!bill.dueDay && bill.dueDate) bill.dueDay = String(Number(bill.dueDate.slice(-2)));
    bill.scheduleEnabled = recurringScheduleEnabledFromBill(bill);
    bill.dueDay ||= "";
    bill.nextDueDate ||= "";
    bill.paidDueDate ||= "";
    if (bill.scheduleEnabled) bill.monthlyAmount ||= bill.amount || "";
    else {
      bill.dueDay = "";
      bill.monthlyAmount = "";
    }
    delete bill.dueDate;
  });
  account.financialInventory.creditCards.forEach(migratePromoCard);
  account.financialInventory.studentLoans = account.financialInventory.studentLoans.map((loan) => ({
    ...blankStudentLoan(),
    ...loan,
  }));
  const mortgage = account.financialInventory.mortgage;
  mortgage.totalAmount ||= "";
  mortgage.interestRate ||= "";
  mortgage.currentBalance ||= "";
  mortgage.paymentAmount ||= "";
  mortgage.nextDueDate ||= "";
}

function reconcileReportedWithdrawals(state, account) {
  const accountWithdrawals = (state.withdrawals || [])
    .filter((withdrawal) => withdrawal.memberEmail === account.email)
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  accountWithdrawals.forEach((withdrawal) => {
    withdrawal.amount = currencyValue(withdrawal.amount);
    withdrawal.reason = String(withdrawal.reason || "").trim() || "Reason not provided";
    const savingsAccount = account.savingsInvestmentAccounts.find(
      (item) =>
        item.type === "savings" &&
        (item.id === withdrawal.assetAccountId ||
          (!withdrawal.assetAccountId &&
            withdrawal.savingsAccountName &&
            String(item.name || "").trim().toLowerCase() ===
              String(withdrawal.savingsAccountName).trim().toLowerCase())),
    );
    if (!savingsAccount) return;
    withdrawal.assetAccountId = savingsAccount.id;
    withdrawal.savingsAccountName = savingsAccount.name || "Savings account";
    const hasPreviousBalance = Number.isFinite(Number(withdrawal.previousBalance));
    const previousBalance = hasPreviousBalance ? currencyValue(withdrawal.previousBalance) : null;
    const reportedNewBalance = hasPreviousBalance
      ? currencyValue(Math.max(0, previousBalance - withdrawal.amount))
      : currencyValue(withdrawal.newBalance ?? withdrawal.updatedSavings);
    if (hasPreviousBalance) withdrawal.previousBalance = previousBalance;
    withdrawal.newBalance = reportedNewBalance;
    const currentBalance = currencyValue(savingsAccount.balance);
    if (!withdrawal.profileApplied && hasPreviousBalance && currentBalance === previousBalance) {
      savingsAccount.balance = String(reportedNewBalance);
      savingsAccount.updatedAt = String(withdrawal.createdAt || todayValue()).slice(0, 10);
    }
    if (currencyValue(savingsAccount.balance) === reportedNewBalance) {
      withdrawal.profileApplied = true;
      if (!savingsAccount.history.some((entry) => entry.withdrawalId === withdrawal.id)) {
        savingsAccount.history.push({
          id: uid("balance"),
          withdrawalId: withdrawal.id,
          balance: String(reportedNewBalance),
          date: String(withdrawal.createdAt || todayValue()).slice(0, 10),
          recordedAt: withdrawal.createdAt || new Date().toISOString(),
        });
      }
    }
  });
}

function sessionTimestamp(session) {
  const value = new Date(session.sessionDate || session.createdAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function autoArchivePreviousSessionReviews(state) {
  const byMember = new Map();
  (state.sessions || []).forEach((session) => {
    session.archivedAt ||= null;
    session.archiveReason ||= "";
    const memberEmail = normalizeEmail(session.memberEmail || "");
    if (!memberEmail) return;
    if (!byMember.has(memberEmail)) byMember.set(memberEmail, []);
    byMember.get(memberEmail).push(session);
  });

  byMember.forEach((sessions) => {
    sessions
      .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
      .slice(1)
      .forEach((session) => {
        if (session.archivedAt) return;
        session.archivedAt = session.sessionDate || session.createdAt || new Date().toISOString();
        session.archiveReason = "auto_previous_review";
      });
  });
}

function recurringBillKey(bill = {}) {
  return [
    String(bill.category || "other").trim().toLowerCase(),
    String(bill.name || "").trim().replace(/\s+/g, " ").toLowerCase(),
  ].join("|");
}

function normalizeRestoredRecurringBill(bill = {}, category = bill.category || "other") {
  const nextDueDate = bill.nextDueDate || bill.dueDate || "";
  const dueDay = bill.dueDay || (bill.dueDate ? String(Number(bill.dueDate.slice(-2))) : "");
  const amount = bill.amount || bill.monthlyAmount || "";
  const scheduleEnabled = recurringScheduleEnabledFromBill(bill, dueDay, bill.monthlyAmount || "");
  const normalizedDueDay = scheduleEnabled ? dueDay : "";
  const normalizedMonthlyAmount = scheduleEnabled ? bill.monthlyAmount || amount : "";
  return {
    ...blankRecurringBill(category),
    ...clone(bill),
    id: bill.id || uid("recurring"),
    category,
    name: String(bill.name || "").trim(),
    amount,
    nextDueDate,
    dueDay: normalizedDueDay,
    monthlyAmount: normalizedMonthlyAmount,
    scheduleEnabled,
    paidDueDate: bill.paidDueDate || "",
  };
}

function mergeRecurringBills(existingBills = [], candidateBills = []) {
  const merged = [];
  const byKey = new Map();
  const addOrMerge = (candidate, source = "history") => {
    const bill = normalizeRestoredRecurringBill(candidate, candidate.category);
    if (!bill.name) return;
    bill.__recurringMergeSource = source;
    const key = recurringBillKey(bill);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, bill);
      merged.push(bill);
      return;
    }
    if (existing.__recurringMergeSource === "profile") {
      existing.scheduleEnabled = recurringScheduleEnabledFromBill(
        existing,
        existing.dueDay || "",
        existing.monthlyAmount || "",
      );
      if (!existing.scheduleEnabled) {
        existing.dueDay = "";
        existing.monthlyAmount = "";
      }
      return;
    }
    existing.id ||= bill.id;
    existing.amount ||= bill.amount;
    existing.nextDueDate ||= bill.nextDueDate;
    existing.paidDueDate ||= bill.paidDueDate;
    existing.lastPaidAt ||= bill.lastPaidAt;
    if (recurringScheduleExplicitlyDisabled(existing)) {
      existing.scheduleEnabled = false;
      existing.dueDay = "";
      existing.monthlyAmount = "";
      return;
    }
    existing.monthlyAmount ||= bill.monthlyAmount || bill.amount;
    existing.dueDay ||= bill.dueDay;
    existing.scheduleEnabled = recurringScheduleEnabledFromBill(
      existing,
      existing.dueDay || bill.dueDay || "",
      existing.monthlyAmount || bill.monthlyAmount || "",
    );
  };
  existingBills.forEach((bill) => addOrMerge(bill, "profile"));
  candidateBills.forEach((bill) => addOrMerge(bill, "history"));
  return removePartialNameDuplicates(
    merged.map(({ __recurringMergeSource, ...bill }) => bill),
    "name",
  );
}

function recurringBillCandidatesFromState(state, account) {
  const candidates = [];
  Object.entries(account.carryForward?.bills || {}).forEach(([category, bills]) => {
    (bills || []).forEach((bill) => {
      if (bill?.name) candidates.push(normalizeRestoredRecurringBill(bill, category));
    });
  });
  Object.values(state.forms || {})
    .filter((form) => form.ownerEmail === account.email)
    .forEach((form) => {
      billGroups.forEach(([category]) => {
        (form.data?.bills?.[category] || []).forEach((bill) => {
          if (!bill?.name) return;
          candidates.push(
            normalizeRestoredRecurringBill(
              {
                ...bill,
                id: bill.profileBillId || bill.id || "",
                scheduleEnabled: recurringScheduleEnabledFromBill(bill, bill.dueDay || "", bill.monthlyAmount || ""),
                dueDay: bill.dueDay || "",
                nextDueDate: bill.nextDueDate || bill.dueDate || "",
                monthlyAmount: bill.monthlyAmount || bill.amount || "",
              },
              category,
            ),
          );
        });
      });
    });
  return candidates;
}

function restoreRecurringBillsFromHistory(state, account) {
  const restored = mergeRecurringBills(
    account.financialInventory?.recurringBills || [],
    recurringBillCandidatesFromState(state, account),
  );
  account.financialInventory.recurringBills = restored;
}

function normalizeStateModels(state) {
  state.withdrawals ||= [];
  state.sessions ||= [];
  state.withdrawals = state.withdrawals.filter((withdrawal, index, withdrawals) => {
    const signature = [
      withdrawal.memberEmail,
      withdrawal.assetAccountId || withdrawal.savingsAccountName,
      withdrawal.formId || "",
      currencyValue(withdrawal.amount),
      String(withdrawal.reason || "").trim().toLowerCase(),
    ].join("|");
    return !withdrawals.slice(0, index).some((other) => {
      const otherSignature = [
        other.memberEmail,
        other.assetAccountId || other.savingsAccountName,
        other.formId || "",
        currencyValue(other.amount),
        String(other.reason || "").trim().toLowerCase(),
      ].join("|");
      return (
        signature === otherSignature &&
        Math.abs(new Date(withdrawal.createdAt || 0) - new Date(other.createdAt || 0)) < 10000
      );
    });
  });
  state.notifications ||= [];
  const validWithdrawalIds = new Set(state.withdrawals.map((withdrawal) => withdrawal.id));
  state.notifications = state.notifications.filter(
    (notification) => !notification.withdrawalId || validWithdrawalIds.has(notification.withdrawalId),
  );
  state.notifications.forEach((notification) => {
    if (notification.type !== "savings_withdrawal" || !notification.withdrawalId) return;
    const withdrawal = state.withdrawals.find((item) => item.id === notification.withdrawalId);
    if (!withdrawal) return;
    notification.title = "Savings withdrawal recorded";
    notification.message = `${money(withdrawal.amount)} withdrawn from ${withdrawal.savingsAccountName || "Savings"}. Reason: ${withdrawal.reason || "Reason not provided"}`;
  });
  state.dismissedMilestoneKeys ||= [];
  const resetMilestones = state.notifications.filter(
    (notification) =>
      notification.milestoneKey &&
      (!notification.createdAt || new Date(notification.createdAt).getTime() <= MILESTONE_RESET_CUTOFF),
  );
  if (resetMilestones.length || state.milestoneResetVersion !== MILESTONE_RESET_VERSION) {
    state.dismissedMilestoneKeys = [
      ...new Set([
        ...state.dismissedMilestoneKeys,
        ...resetMilestones.map((notification) => notification.milestoneKey),
      ]),
    ];
    state.notifications = state.notifications.filter((notification) => !resetMilestones.includes(notification));
    state.milestoneResetVersion = MILESTONE_RESET_VERSION;
  }
  Object.values(state.accounts || {}).forEach((account) => {
    ensureAccountModel(account);
    restoreRecurringBillsFromHistory(state, account);
    reconcileReportedWithdrawals(state, account);
    if (account.savingsInvestmentAccounts.some((item) => item.type === "savings")) {
      account.carryForward ||= {};
      account.carryForward.savings = {
        ...(account.carryForward.savings || {}),
        current: String(profileSavingsTotal(account)),
      };
    }
  });
  Object.values(state.forms || {}).forEach((form) => {
    form.archivedAt ||= null;
    form.archivedBy ||= null;
    if (form.assignedPerson === "both") {
      form.assignedName = formAssigneeName(state.accounts?.[form.ownerEmail], "both") || form.assignedName;
    }
    form.data ||= {};
    form.data.bills ||= {};
    billGroups.forEach(([key]) => {
      form.data.bills[key] = removePartialNameDuplicates(form.data.bills[key] || [], "name");
      while (form.data.bills[key].length < 3) form.data.bills[key].push(blankBill());
    });
    form.data.creditCards = removePartialNameDuplicates(form.data.creditCards || [], "account").map((card) => {
      const migrated = { ...blankCreditCard(), ...card };
      migratePromoCard(migrated);
      return migrated;
    });
    form.data.debts = removePartialNameDuplicates(form.data.debts || [], "account").map((debt) => ({ ...blankDebt(), ...debt }));
    form.data.studentLoans = removePartialNameDuplicates(form.data.studentLoans || [], "account").map((loan) => ({ ...blankStudentLoan(), ...loan }));
    form.data.mortgage = { totalAmount: "", interestRate: "", currentBalance: "", paymentAmount: "", nextDueDate: "", mustPayBy: "", remainingBefore: "", contribution: "", memberSuggestion: "", coachDecision: "", ...(form.data.mortgage || {}) };
    form.data.housingPaymentType ||= "mortgage";
    form.data.calculatorHistory ||= [];
    form.data.calculatorDraft ||= "";
    form.data.calculatorJustEvaluated ||= false;
    form.data.calculatorPosition ||= null;
    form.data.calculatorSize ||= null;
    form.data.calculatorMinimized ||= false;
    form.data.calculatorHistoryOpen ||= false;
    form.data.allocations = (form.data.allocations || [])
      .filter((item) => rolloverTypes.includes(item.type))
      .map((item) => ({ id: uid("allocation"), type: "", account: "", amount: "", memberSuggestion: "", coachDecision: "", ...item }));
    form.data.variableSpending = (form.data.variableSpending || []).map((item) => ({ ...blankVariable(), ...item }));
    form.data.savings = { goal: "", current: "", contribution: "", memberSuggestion: "", coachDecision: "", ...(form.data.savings || {}) };
    const owner = state.accounts?.[form.ownerEmail];
    if (
      form.status === "draft" &&
      owner?.savingsInvestmentAccounts?.some((item) => item.type === "savings")
    ) {
      form.data.savings.current = String(profileSavingsTotal(owner));
    }
    form.data.overview ||= { checkDate: "", thisCheck: "", additionalIncome: "" };
    form.data.notes ||= "";
  });
  autoArchivePreviousSessionReviews(state);
  return state;
}

function migratePromoCard(card) {
  if (!Object.hasOwn(card, "totalBalance")) card.totalBalance = card.amountDue || "";
  if (!Object.hasOwn(card, "lastStatementBalance")) card.lastStatementBalance = card.amountDue || "";
  if (!Object.hasOwn(card, "paymentDue")) card.paymentDue = card.amountDue || "";
  delete card.amountDue;
  if (!card.promoType) {
    card.promoType = card.promotionalRateApplied ? "purchases" : "none";
  }
  card.purchasePromoRate ||= card.promotionalRate || "";
  card.purchasePromoExpiration ||= card.promotionExpiration || "";
  card.balanceTransferPromoRate ||= "";
  card.balanceTransferPromoExpiration ||= "";
}

function profileIsComplete(account) {
  if (!account) return false;
  if (account.role === "coach") {
    return Boolean(account.name && account.profile.phone);
  }
  return Boolean(
    account.name &&
      account.profile.phone &&
      account.profile.address &&
      account.profile.employer &&
      account.profile.payFrequency &&
      account.profile.maritalStatus &&
      (account.profile.maritalStatus !== "married" || account.profile.spouseName),
  );
}

function formAssigneeName(owner, assignedPerson = "account_holder") {
  if (assignedPerson === "both" && owner?.profile?.spouseName) {
    return `${owner.name} & ${owner.profile.spouseName}`;
  }
  if (assignedPerson === "spouse" && owner?.profile?.spouseName) {
    return owner.profile.spouseName;
  }
  return owner?.name || "";
}

function formAssigneeAvatar(owner, assignedPerson = "account_holder", className = "") {
  if (assignedPerson === "both" && owner?.profile?.spouseName) {
    return `<span class="joint-avatar-stack ${className}">${avatarMarkup(owner)}${spouseAvatarMarkup(owner)}</span>`;
  }
  return assignedPerson === "spouse"
    ? spouseAvatarMarkup(owner, className)
    : avatarMarkup(owner, className);
}

function applyTheme() {
  const account = currentAccount();
  document.documentElement.dataset.theme = account?.preferences?.theme || "light";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dueDateForDay(dueDay) {
  if (!dueDay) return "";
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day =
    dueDay === "last"
      ? new Date(year, month + 1, 0).getDate()
      : Math.min(Number(dueDay), new Date(year, month + 1, 0).getDate());
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateValueFromLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function nextMonthlyDueDate(dueDay, fromDate = new Date()) {
  if (!dueDay) return "";
  const dateForMonth = (year, month) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const day = dueDay === "last" ? lastDay : Math.min(Number(dueDay), lastDay);
    return new Date(year, month, day, 12, 0, 0, 0);
  };
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), 0, 0, 0, 0);
  let dueDate = dateForMonth(start.getFullYear(), start.getMonth());
  if (dueDate < start) {
    dueDate = dateForMonth(start.getFullYear(), start.getMonth() + 1);
  }
  return dateValueFromLocal(dueDate);
}

function isDateWithinNextDays(value, days) {
  if (!value) return false;
  const start = new Date(`${todayValue()}T00:00:00`);
  const end = addDays(start, days);
  const dueDate = new Date(`${value}T12:00:00`);
  return dueDate >= start && dueDate <= end;
}

function isDateWithinNextMonth(value) {
  return isDateWithinNextDays(value, 31);
}

function recurringBillToWorksheetBill(bill) {
  const dueDate = recurringBillNextDueDate(bill);
  return {
    ...blankBill(),
    profileBillId: bill.id || "",
    name: bill.name,
    dueDate,
    amount: dueDate ? bill.amount : "",
    memberSuggestion: "",
    coachDecision: "",
  };
}

function recurringBillNextDueDate(bill) {
  return bill?.dueDay ? nextMonthlyDueDate(bill.dueDay) : bill?.nextDueDate || "";
}

function recurringBillIsPaidForDueDate(bill, dueDate = recurringBillNextDueDate(bill)) {
  return Boolean(dueDate && bill?.paidDueDate === dueDate);
}

function recurringBillDisplayDueDate(bill) {
  const dueDate = recurringBillNextDueDate(bill);
  return recurringBillIsPaidForDueDate(bill, dueDate) ? "" : dueDate;
}

function upcomingProfilePayment(row, amountKey, dueDateKey = "dueDate") {
  const amount = currencyValue(row?.[amountKey]);
  return amount && isDateWithinNextMonth(row?.[dueDateKey]) ? amount.toFixed(2) : "";
}

function isUpcomingRecurringBill(bill) {
  if (!bill?.name) return false;
  const dueDate = recurringBillNextDueDate(bill);
  return Boolean(
    dueDate &&
    currencyValue(bill.amount) &&
    isDateWithinNextDays(dueDate, WORKSHEET_BILL_LOOKAHEAD_DAYS) &&
    !recurringBillIsPaidForDueDate(bill, dueDate),
  );
}

function worksheetBillsFromUpcomingProfile(profileBills = []) {
  const rows = profileBills
    .filter(isUpcomingRecurringBill)
    .map((bill) => recurringBillToWorksheetBill(bill));
  while (rows.length < 3) rows.push(blankBill());
  return rows;
}

function syncWorksheetBillsWithProfile(existingBills = [], profileBills = []) {
  const profileRows = profileBills
    .filter(isUpcomingRecurringBill)
    .map((bill) => recurringBillToWorksheetBill(bill));
  const profileById = new Map(profileRows.filter((bill) => bill.profileBillId).map((bill) => [bill.profileBillId, bill]));
  const profileByName = new Map(
    profileRows.map((bill) => [String(bill.name).trim().toLowerCase(), bill]),
  );
  const usedProfileIds = new Set();
  const usedNames = new Set();
  const synced = existingBills
    .map((bill) => {
      const isEmpty = !bill.name && !bill.amount && !bill.dueDate && !bill.memberSuggestion && !bill.coachDecision;
      if (isEmpty) return null;
      const nameKey = String(bill.name || "").trim().toLowerCase();
      const profileBill = profileById.get(bill.profileBillId) || profileByName.get(nameKey);
      if (!profileBill) {
        if (nameKey) usedNames.add(nameKey);
        return clone(bill);
      }
      if (profileBill.profileBillId) usedProfileIds.add(profileBill.profileBillId);
      usedNames.add(String(profileBill.name || "").trim().toLowerCase());
      return {
        ...blankBill(),
        ...clone(bill),
        ...profileBill,
        memberSuggestion: bill.memberSuggestion || "",
        coachDecision: bill.coachDecision || "",
      };
    })
    .filter(Boolean);
  profileRows.forEach((profileBill) => {
    const nameKey = String(profileBill.name || "").trim().toLowerCase();
    if (
      (profileBill.profileBillId && usedProfileIds.has(profileBill.profileBillId)) ||
      usedNames.has(nameKey)
    ) {
      return;
    }
    synced.push(profileBill);
    if (profileBill.profileBillId) usedProfileIds.add(profileBill.profileBillId);
    usedNames.add(nameKey);
  });
  while (synced.length < 3) synced.push(blankBill());
  return synced;
}

function syncWorksheetAccountsWithProfile(existingRows = [], profileRows = [], blankFactory, minimumRows, paymentPlan = null) {
  const existingByAccount = new Map(
    existingRows
      .filter((row) => row.account)
      .map((row) => [String(row.account).trim().toLowerCase(), row]),
  );
  const synced = profileRows
    .filter((row) => row.account)
    .map((profileRow) => {
      const existingRow = existingByAccount.get(String(profileRow.account).trim().toLowerCase());
      return {
        ...blankFactory(),
        ...clone(profileRow),
        contribution: existingRow?.contribution || (paymentPlan ? upcomingProfilePayment(profileRow, paymentPlan.amountKey, paymentPlan.dueDateKey) : ""),
        memberSuggestion: existingRow?.memberSuggestion || "",
        coachDecision: existingRow?.coachDecision || "",
      };
    });
  while (synced.length < minimumRows) synced.push(blankFactory());
  return synced;
}

function syncDraftFormsWithFinancialProfile(account) {
  ensureFinancialInventory(account);
  const savingsTotal = profileSavingsTotal(account);
  Object.values(appState.forms)
    .filter((form) => form.ownerEmail === account.email && form.status === "draft")
    .forEach((form) => {
      form.ownerName = account.name;
      form.assignedName = formAssigneeName(account, form.assignedPerson);
      billGroups.forEach(([key]) => {
        const profileBills = account.financialInventory.recurringBills.filter(
          (bill) => bill.category === key,
        );
        form.data.bills[key] = syncWorksheetBillsWithProfile(form.data.bills[key], profileBills);
      });
      form.data.creditCards = syncWorksheetAccountsWithProfile(
        form.data.creditCards,
        account.financialInventory.creditCards,
        blankCreditCard,
        2,
        { amountKey: "paymentDue", dueDateKey: "dueDate" },
      );
      form.data.creditCards.forEach(migratePromoCard);
      form.data.studentLoans = syncWorksheetAccountsWithProfile(
        form.data.studentLoans || [],
        account.financialInventory.studentLoans,
        blankStudentLoan,
        0,
        { amountKey: "paymentDue", dueDateKey: "dueDate" },
      );
      form.data.debts = syncWorksheetAccountsWithProfile(
        form.data.debts,
        account.financialInventory.debts,
        blankDebt,
        3,
        { amountKey: "minimumPayment", dueDateKey: "dueDate" },
      );
      if (account.savingsInvestmentAccounts.some((item) => item.type === "savings")) {
        form.data.savings.current = String(savingsTotal);
      }
      form.data.mortgage = {
        ...form.data.mortgage,
        totalAmount: account.financialInventory.mortgage.totalAmount || form.data.mortgage.totalAmount || "",
        interestRate: account.financialInventory.mortgage.interestRate || form.data.mortgage.interestRate || "",
        currentBalance: account.financialInventory.mortgage.currentBalance || form.data.mortgage.currentBalance || "",
        paymentAmount: account.financialInventory.mortgage.paymentAmount || form.data.mortgage.paymentAmount || "",
        nextDueDate: account.financialInventory.mortgage.nextDueDate || form.data.mortgage.nextDueDate || "",
      };
      form.data.housingPaymentType = account.financialInventory.housingPaymentType || "mortgage";
      form.generatedFromProfile = true;
      form.updatedAt = new Date().toISOString();
    });
}

function saveFinancialProfileMutation(account) {
  syncDraftFormsWithFinancialProfile(account);
  notifyProfileMilestones(account);
  saveState();
}

function blankForm(owner, carryForward = owner.carryForward || {}, assignedPerson = "account_holder") {
  ensureFinancialInventory(owner);
  const inventory = owner.financialInventory;
  const sourceCards = carryForward.creditCards?.length
    ? carryForward.creditCards
    : inventory.creditCards;
  const sourceDebts = carryForward.debts?.length ? carryForward.debts : inventory.debts;
  const mortgageSource = {
    ...(carryForward.mortgage || {}),
    ...(inventory.mortgage || {}),
  };
  const now = new Date().toISOString();
  const readableDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());

  return {
    id: uid("form"),
    ownerEmail: owner.email,
    ownerName: owner.name,
    title: `Financial Worksheet - ${readableDate}`,
    createdAt: now,
    updatedAt: now,
    sharedWith: [],
    submittedAt: null,
    status: "draft",
    approvedAt: null,
    approvedBy: null,
    archivedAt: null,
    archivedBy: null,
    assignedPerson,
    assignedName: formAssigneeName(owner, assignedPerson),
    generatedFromProfile: true,
    data: {
      overview: { checkDate: "", thisCheck: "", additionalIncome: "" },
      bills: Object.fromEntries(
        billGroups.map(([key]) => [
          key,
          worksheetBillsFromUpcomingProfile(
            inventory.recurringBills.filter((bill) => bill.category === key),
          ),
        ]),
      ),
      mortgage: {
        totalAmount: mortgageSource.totalAmount || "",
        interestRate: mortgageSource.interestRate || "",
        currentBalance: mortgageSource.currentBalance || "",
        paymentAmount: mortgageSource.paymentAmount || "",
        nextDueDate: mortgageSource.nextDueDate || "",
        mustPayBy: carryForward.mortgage?.mustPayBy || "",
        remainingBefore: carryForward.mortgage?.remainingBefore || "",
        contribution: "",
        memberSuggestion: "",
        coachDecision: "",
      },
      housingPaymentType: inventory.housingPaymentType || "mortgage",
      creditCards: sourceCards?.length
        ? clone(sourceCards).map((card) => {
            const nextCard = {
              ...blankCreditCard(),
              ...card,
              contribution: "",
              memberSuggestion: "",
              coachDecision: "",
            };
            migratePromoCard(nextCard);
            nextCard.contribution = upcomingProfilePayment(nextCard, "paymentDue", "dueDate");
            return nextCard;
          })
        : [blankCreditCard(), blankCreditCard()],
      variableSpending: defaultBudgetRows(),
      savings: {
        goal: carryForward.savings?.goal || "",
        current: carryForward.savings?.current || "",
        contribution: "",
        memberSuggestion: "",
        coachDecision: "",
      },
      debts: sourceDebts?.length
        ? clone(sourceDebts).map((debt) => ({
            ...blankDebt(),
            ...debt,
            contribution: upcomingProfilePayment(debt, "minimumPayment", "dueDate"),
            memberSuggestion: "",
            coachDecision: "",
          }))
        : [blankDebt(), blankDebt(), blankDebt()],
      studentLoans: inventory.studentLoans?.length
        ? clone(inventory.studentLoans).map((loan) => ({
            ...blankStudentLoan(),
            ...loan,
            contribution: upcomingProfilePayment(loan, "paymentDue", "dueDate"),
            memberSuggestion: "",
            coachDecision: "",
          }))
        : [],
      calculatorHistory: [],
      calculatorDraft: "",
      calculatorPosition: null,
      calculatorSize: null,
      calculatorMinimized: false,
      calculatorHistoryOpen: false,
      allocations: [],
      notes: "",
    },
  };
}

function loadState() {
  if (productionBackend.enabled) {
    localStorage.removeItem(STORAGE_KEY);
    return {
      accounts: {},
      forms: {},
      coachRequests: [],
      coachInvites: [],
      withdrawals: [],
      sessions: [],
      notifications: [],
      dateAutofillDisabled: true,
      sessionEmail: null,
    };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (stored?.accounts && stored?.forms) {
      stored.coachRequests ||= [];
      stored.coachInvites ||= [];
      stored.withdrawals ||= [];
      stored.sessions ||= [];
      stored.notifications ||= [];
      Object.values(stored.accounts).forEach((account) => {
        account.password ||= account.email?.endsWith("@fitdemo.com") ? "demo123" : "";
        if (!Object.hasOwn(account, "verified")) account.verified = true;
        account.coachEmail ||= null;
        account.coachRequestStatus ||= null;
        account.carryForward ||= {};
        ensureAccountModel(account);
        if (
          !account.financialInventory.creditCards.length &&
          account.carryForward.creditCards?.length
        ) {
          account.financialInventory.creditCards = clone(account.carryForward.creditCards);
          account.financialInventory.creditCards.forEach(migratePromoCard);
        }
        if (!account.financialInventory.debts.length && account.carryForward.debts?.length) {
          account.financialInventory.debts = clone(account.carryForward.debts);
        }
        if (
          !account.financialInventory.recurringBills.length &&
          account.carryForward.bills
        ) {
          account.financialInventory.recurringBills = Object.entries(
            account.carryForward.bills,
          ).flatMap(([category, bills]) =>
            bills.map((bill) => ({
              ...blankRecurringBill(category),
              ...clone(bill),
              category,
              scheduleEnabled: recurringScheduleEnabledFromBill(bill, bill.dueDay || "", bill.monthlyAmount || ""),
              dueDay: bill.dueDate ? String(Number(bill.dueDate.slice(-2))) : bill.dueDay || "",
              monthlyAmount: bill.monthlyAmount || bill.amount || "",
            })),
          );
        }
      });
      if (stored.accounts["alex@fitdemo.com"] && stored.accounts["coach@fitdemo.com"]) {
        stored.accounts["alex@fitdemo.com"].coachEmail ||= "coach@fitdemo.com";
        stored.accounts["alex@fitdemo.com"].coachRequestStatus ||= "approved";
      }
      Object.values(stored.forms).forEach((form) => {
        form.assignedPerson ||= "account_holder";
        form.assignedName =
          form.assignedPerson === "both"
            ? formAssigneeName(stored.accounts[form.ownerEmail], "both")
            : form.assignedName || form.ownerName;
        form.generatedFromProfile = Object.hasOwn(form, "generatedFromProfile")
          ? Boolean(form.generatedFromProfile)
          : false;
        if (!Object.hasOwn(form.data.overview, "checkDate")) form.data.overview.checkDate = "";
        if (form.sharedWith?.length && !form.submittedAt) form.submittedAt = form.updatedAt;
        form.status ||= form.sharedWith?.length ? "submitted" : "draft";
        form.approvedAt ||= null;
        form.approvedBy ||= null;
        form.archivedAt ||= null;
        form.archivedBy ||= null;
        billGroups.forEach(([key]) => {
          form.data.bills[key] ||= [blankBill(), blankBill(), blankBill()];
          form.data.bills[key] = removePartialNameDuplicates(form.data.bills[key], "name");
          while (form.data.bills[key].length < 3) form.data.bills[key].push(blankBill());
        });
        form.data.creditCards = removePartialNameDuplicates(form.data.creditCards, "account");
        form.data.debts = removePartialNameDuplicates(form.data.debts, "account");
        form.data.studentLoans = removePartialNameDuplicates(form.data.studentLoans, "account");
        Object.values(form.data.bills)
          .flat()
          .forEach((bill) => {
            bill.memberSuggestion ||= "";
            bill.coachDecision ||= "";
          });
        form.data.creditCards.forEach((card) => {
          card.memberSuggestion ||= "";
          card.coachDecision ||= "";
          card.apr ||= "";
          card.promotionalRateApplied = Boolean(card.promotionalRateApplied);
          card.promotionalRate ||= "";
          card.promotionExpiration ||= "";
          migratePromoCard(card);
        });
        form.data.studentLoans ||= [];
        form.data.studentLoans = form.data.studentLoans.map((loan) => ({
          ...blankStudentLoan(),
          ...loan,
        }));
        form.data.mortgage ||= {};
        form.data.mortgage.totalAmount ||= "";
        form.data.mortgage.interestRate ||= "";
        form.data.mortgage.currentBalance ||= form.data.mortgage.remainingBefore || "";
        form.data.variableSpending.forEach((item) => {
          delete item.actual;
        });
        form.data.debts.forEach((debt) => {
          debt.contribution ||= "";
          debt.apr ||= "";
          debt.promotionalRateApplied = Boolean(debt.promotionalRateApplied);
          debt.promotionalRate ||= "";
          debt.promotionExpiration ||= "";
        });
      });
      if (!stored.dateAutofillDisabled) {
        Object.values(stored.forms).forEach((form) => {
          if (form.data.overview.checkDate === todayValue()) form.data.overview.checkDate = "";
          Object.values(form.data.bills)
            .flat()
            .filter((bill) => !bill.name && !bill.amount && bill.dueDate === todayValue())
            .forEach((bill) => {
              bill.dueDate = "";
            });
          form.data.creditCards
            .filter((card) => !card.account && !card.paymentDue && card.dueDate === todayValue())
            .forEach((card) => {
              card.dueDate = "";
            });
        });
        stored.dateAutofillDisabled = true;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      return stored;
    }
  } catch (error) {
    console.warn("Could not read saved portal data", error);
  }
  return seedState();
}

function seedState() {
  const member = {
    name: "Alex Morgan",
    email: "alex@fitdemo.com",
    role: "user",
    password: "demo123",
    verified: true,
    coachEmail: "coach@fitdemo.com",
    coachRequestStatus: "approved",
    carryForward: {},
    profile: {
      maritalStatus: "married",
      spouseName: "Jamie Morgan",
      phone: "",
      address: "",
      employer: "FIT Demo Employer",
      payFrequency: "Biweekly",
    },
    paystubs: [],
    financialInventory: {
      recurringBills: [],
      creditCards: [],
      debts: [],
    },
  };
  const coach = {
    name: "Jordan Coach",
    email: "coach@fitdemo.com",
    role: "coach",
    password: "demo123",
    verified: true,
    coachEmail: null,
    coachRequestStatus: null,
    carryForward: {},
    profile: {
      maritalStatus: "",
      spouseName: "",
      spouseEmployer: "",
      spousePhone: "",
      spousePayFrequency: "",
      phone: "",
      address: "",
      employer: "",
      payFrequency: "",
    },
    paystubs: [],
    financialInventory: {
      recurringBills: [],
      creditCards: [],
      debts: [],
      studentLoans: [],
      mortgage: {},
    },
  };
  const form = blankForm(member);
  form.title = "June Paycheck Plan";
  form.sharedWith = [coach.email];
  form.submittedAt = nowForSeed();
  form.status = "submitted";
  form.data.overview = { checkDate: "", thisCheck: "2450", additionalIncome: "250" };
  form.data.bills.housing[0] = {
    ...form.data.bills.housing[0],
    name: "Rent",
    dueDate: "2026-06-15",
    amount: "1100",
  };
  form.data.bills.utilities[0] = {
    ...form.data.bills.utilities[0],
    name: "Electric",
    dueDate: "2026-06-18",
    amount: "125",
  };
  form.data.bills.utilities[1] = {
    ...form.data.bills.utilities[1],
    name: "Internet",
    dueDate: "2026-06-20",
    amount: "70",
  };
  form.data.creditCards[0] = {
    ...form.data.creditCards[0],
    account: "Everyday Card",
    dueDate: "2026-06-21",
    totalBalance: "850",
    lastStatementBalance: "850",
    paymentDue: "300",
    contribution: "300",
    apr: "19.99",
  };
  form.data.savings = { goal: "5000", current: "1900", contribution: "200" };
  form.data.debts[0] = {
    ...form.data.debts[0],
    account: "Student Loan",
    totalOwed: "12600",
    minimumPayment: "180",
    contribution: "180",
    apr: "5.5",
    notes: "Rollovers after card payoff",
  };
  member.financialInventory = {
    recurringBills: [
      {
        id: uid("recurring"),
        category: "housing",
        name: "Rent",
        dueDate: "2026-06-15",
        amount: "1100",
      },
      {
        id: uid("recurring"),
        category: "utilities",
        name: "Electric",
        dueDate: "2026-06-18",
        amount: "125",
      },
    ],
    creditCards: [
      {
        ...blankProfileCard(),
        account: "Everyday Card",
        dueDate: "2026-06-21",
        totalBalance: "850",
        lastStatementBalance: "850",
        paymentDue: "300",
        apr: "19.99",
      },
    ],
    debts: [
      {
        ...blankProfileDebt(),
        account: "Student Loan",
        totalOwed: "12600",
        minimumPayment: "180",
        dueDate: "2026-06-25",
        apr: "5.5",
        notes: "Rollovers after card payoff",
      },
    ],
    studentLoans: [
      {
        ...blankStudentLoan(),
        account: "Federal Student Loan",
        loanType: "federal_unsubsidized",
        totalOwed: "8200",
        paymentDue: "95",
        dueDate: "2026-07-01",
        apr: "4.75",
      },
    ],
    mortgage: {
      totalAmount: "240000",
      interestRate: "5.25",
      currentBalance: "228500",
      paymentAmount: "1650",
      nextDueDate: "2026-07-01",
    },
    housingPaymentType: "mortgage",
  };
  member.savingsInvestmentAccounts = [
    {
      ...blankSavingsInvestmentAccount(),
      name: "Emergency Fund",
      type: "savings",
      balance: "2100",
      updatedAt: todayValue(),
      notes: "Three-month starter goal",
      history: [
        { id: uid("balance"), date: "2026-05-15", balance: "1800" },
        { id: uid("balance"), date: todayValue(), balance: "2100" },
      ],
    },
    {
      ...blankSavingsInvestmentAccount(),
      name: "Starter Investment",
      type: "investment",
      balance: "650",
      updatedAt: todayValue(),
      notes: "Manual balance tracking",
      history: [
        { id: uid("balance"), date: "2026-05-15", balance: "590" },
        { id: uid("balance"), date: todayValue(), balance: "650" },
      ],
    },
  ];
  ensureAccountModel(member);
  ensureAccountModel(coach);

  return {
    accounts: {
      [member.email]: member,
      [coach.email]: coach,
    },
    forms: { [form.id]: form },
    coachRequests: [],
    coachInvites: [],
    withdrawals: [],
    sessions: [],
    notifications: [],
    sessionEmail: null,
  };
}

function nowForSeed() {
  return new Date().toISOString();
}

function saveState() {
  lastLocalSaveAt = Date.now();
  if (productionBackend.enabled) {
    localStorage.removeItem(STORAGE_KEY);
    productionBackend.queuePersist?.(appState);
    return true;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
    productionBackend.queuePersist?.(appState);
    return true;
  } catch (error) {
    console.warn("Could not save portal data", error);
    showToast("This browser does not have enough storage for that document.");
    return false;
  }
}

async function saveFinancialProfileNow() {
  const account = currentAccount();
  commitFinancialProfileInputs(account);
  const profileForm = document.getElementById("profile-form");
  if (account && profileForm) {
    const data = new FormData(profileForm);
    account.name = data.get("name").trim();
    account.profile.phone = data.get("phone").trim();
    account.profile.employer = data.get("employer").trim();
    account.profile.address = data.get("address").trim();
    account.profile.payFrequency = data.get("payFrequency");
    account.profile.maritalStatus = data.get("maritalStatus");
    account.profile.spouseName =
      account.profile.maritalStatus === "married" ? data.get("spouseName").trim() : "";
    account.profile.spouseEmployer = account.profile.maritalStatus === "married" ? String(data.get("spouseEmployer") || "").trim() : "";
    account.profile.spousePhone = account.profile.maritalStatus === "married" ? String(data.get("spousePhone") || "").trim() : "";
    account.profile.spousePayFrequency = account.profile.maritalStatus === "married" ? String(data.get("spousePayFrequency") || "") : "";
    account.profileCompleted = profileIsComplete(account);
  }
  if (account) {
    syncDraftFormsWithFinancialProfile(account);
    notifyProfileMilestones(account);
    Object.values(appState.forms)
      .filter((form) => form.ownerEmail === account.email)
      .forEach(notifyFormMilestones);
  }
  if (!saveState()) return;
  try {
    await productionBackend.saveNow?.(appState);
    showToast("Financial profile data saved.");
  } catch (error) {
    showToast(error.message || "Financial profile could not be saved.");
  }
}

function settleFinancialProfileSaveFocus(trigger = null) {
  const active = document.activeElement;
  if (active?.matches?.("input, select, textarea, button, [tabindex]")) active.blur();
  if (trigger?.blur && trigger !== active) trigger.blur();
}

function commitFinancialProfileInputs(account = currentAccount()) {
  if (!account) return;
  document.querySelectorAll("[data-profile-path]").forEach((input) => {
    if (validateControlledInput(input)) {
      setAtPath(account, input.dataset.profilePath, currencyInputStorageValue(input));
    }
  });
  document.querySelectorAll("[data-asset-path]").forEach((input) => {
    const [index, field] = input.dataset.assetPath.split(".");
    const asset = account.savingsInvestmentAccounts[Number(index)];
    if (asset) asset[field] = currencyInputStorageValue(input);
  });
  account.savingsInvestmentAccounts.forEach((_, index) => saveAssetHistoryEntry(account, index));
}

function syncRecurringBillScheduleState(bill, changedField = "") {
  if (!bill) return;
  if (["amount", "dueDay", "monthlyAmount", "nextDueDate"].includes(changedField)) {
    bill.paidDueDate = "";
  }
  if (!bill.scheduleEnabled) {
    bill.dueDay = "";
    bill.monthlyAmount = "";
    return;
  }
  if (bill.dueDay) bill.nextDueDate = nextMonthlyDueDate(bill.dueDay);
  if (bill.scheduleEnabled && bill.monthlyAmount && changedField !== "amount") {
    bill.amount = bill.monthlyAmount;
  }
}

function currentAccount() {
  return appState.accounts[appState.sessionEmail] || null;
}

function clearProtectedPortalMemory() {
  clearTimeout(portalRefreshTimer);
  portalRefreshTimer = null;
  portalRefreshQueued = false;
  removePortalRetryBanner();
  hidePageLoading();
  productionBackend.unsubscribeFromPortalChanges?.().catch((error) => {
    console.warn("Could not close live updates cleanly", error);
  });
  if (!productionBackend.enabled) {
    appState.sessionEmail = null;
    return;
  }
  appState = {
    accounts: {},
    forms: {},
    coachRequests: [],
    coachInvites: [],
    withdrawals: [],
    sessions: [],
    notifications: [],
    dateAutofillDisabled: true,
    sessionEmail: null,
  };
  localStorage.removeItem(STORAGE_KEY);
}

function activityStatus(account) {
  const lastActive = account?.lastActiveAt ? new Date(account.lastActiveAt).getTime() : 0;
  const elapsed = Date.now() - lastActive;
  if (lastActive && elapsed < 2 * 60 * 1000) return { label: "Online", className: "online" };
  if (lastActive && elapsed < 24 * 60 * 60 * 1000) return { label: "Last active recently", className: "recent" };
  return { label: "Offline", className: "offline" };
}

function activityBadge(account) {
  if (!productionBackend.config?.presenceEnabled) return "";
  const status = activityStatus(account);
  return `<span class="activity-status ${status.className}"><i aria-hidden="true"></i>${status.label}</span>`;
}

function touchActivity() {
  const account = currentAccount();
  if (!account) return;
  const now = Date.now();
  if (now - lastPresenceUpdateAt < 60 * 1000) return;
  lastPresenceUpdateAt = now;
  account.lastActiveAt = new Date().toISOString();
  if (!productionBackend.config?.presenceEnabled) return;
  productionBackend.updatePresence?.(account.lastActiveAt).catch((error) => {
    console.warn("Could not update activity status", error);
  });
}

function recordUserActivity() {
  lastUserActivityAt = Date.now();
  touchActivity();
}

async function logoutDueToInactivity() {
  if (inactivityLogoutInProgress || !currentAccount()) return;
  inactivityLogoutInProgress = true;
  clearTimeout(formAutosaveTimer);
  try {
    saveState();
    await productionBackend.saveNow?.(appState);
  } catch (error) {
    console.warn("Could not save pending changes before inactivity logout", error);
  }
  try {
    await productionBackend.updatePresence?.(null);
    await productionBackend.signOut?.();
  } catch (error) {
    console.warn("Could not complete remote inactivity logout", error);
  }
  clearProtectedPortalMemory();
  activeView = "dashboard";
  activeFormId = null;
  pendingPaystubUpload = null;
  pendingBillScanUpload = null;
  loginMode = "signin";
  localStorage.removeItem(STORAGE_KEY);
  history.replaceState({}, "", window.location.pathname);
  renderLogin();
  showToast("You were logged out due to inactivity.");
  inactivityLogoutInProgress = false;
}

function checkInactivityLogout() {
  if (currentAccount() && Date.now() - lastUserActivityAt >= INACTIVITY_LIMIT_MS) {
    logoutDueToInactivity();
  }
}

async function completePendingCoachInvite() {
  if (!productionBackend.enabled) return;
  const coachEmail = sessionStorage.getItem("fit-pending-coach-invite");
  const member = currentAccount();
  if (!coachEmail || !member || member.role !== "user") return;
  const result = await productionBackend.connectCoach(coachEmail, true);
  member.coachEmail = result.coachEmail;
  member.coachName = result.coachName || "F.I.T. coach";
  member.coachRequestStatus = "approved";
  appState.accounts[result.coachEmail] = {
    ...(appState.accounts[result.coachEmail] || {}),
    name: member.coachName,
    email: result.coachEmail,
    role: "coach",
    profilePhoto: result.coachProfilePhoto || appState.accounts[result.coachEmail]?.profilePhoto || null,
  };
  sessionStorage.removeItem("fit-pending-coach-invite");
  window.history.replaceState({}, "", window.location.pathname);
  saveState();
  showToast("Coach invitation accepted. You are now connected.");
}

function currencyValue(value) {
  const numericValue = typeof value === "string" ? value.replaceAll(",", "") : value;
  return Math.round(((Number(numericValue) || 0) + Number.EPSILON) * 100) / 100;
}

function money(value) {
  const number = currencyValue(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function titheMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.round(Number(value) || 0));
}

function moneyInputValue(value) {
  return value === "" || value === null || value === undefined
    ? ""
    : new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(currencyValue(value));
}

function currencyInputStorageValue(input) {
  if (!input?.matches?.("[data-currency-input]")) return input?.value ?? "";
  const clean = String(input.value || "").replaceAll(",", "").trim();
  return clean === "" || !Number.isFinite(Number(clean)) ? "" : currencyValue(clean).toFixed(2);
}

function sanitizeCurrencyInput(input) {
  if (!input?.matches?.("[data-currency-input]")) return;
  const clean = String(input.value || "").replace(/[^\d.]/g, "");
  const [whole = "", ...decimalParts] = clean.split(".");
  input.value = decimalParts.length ? `${whole}.${decimalParts.join("").slice(0, 2)}` : whole;
}

function profileSavingsTotal(account) {
  return (account.savingsInvestmentAccounts || [])
    .filter((item) => item.type === "savings")
    .reduce((sum, item) => sum + (Number(item.balance) || 0), 0);
}

function reportedSavingsTotal(account) {
  if (!account) return 0;
  const savingsAccounts = (account.savingsInvestmentAccounts || []).filter(
    (item) => item.type === "savings",
  );
  if (savingsAccounts.length) return currencyValue(profileSavingsTotal(account));
  const latest = memberForms(account.email)[0];
  return currencyValue(account.carryForward?.savings?.current ?? (latest ? calculate(latest).savingsAfter : 0));
}

function profileInvestmentTotal(account) {
  return (account.savingsInvestmentAccounts || [])
    .filter((item) => item.type === "investment")
    .reduce((sum, item) => sum + (Number(item.balance) || 0), 0);
}

function profileDebtTotal(account) {
  return [...(account.financialInventory?.debts || []), ...(account.financialInventory?.studentLoans || [])].reduce(
    (sum, debt) => sum + (Number(debt.totalOwed) || 0),
    0,
  );
}

function allocationTotalFor(form, type, accountName) {
  const normalizedAccount = String(accountName || "").trim().toLowerCase();
  if (!normalizedAccount) return 0;
  return currencyValue((form.data.allocations || [])
    .filter((item) => shouldPayThisCheck(item) && item.type === type && String(item.account || "").trim().toLowerCase() === normalizedAccount)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
}

function shouldPayThisCheck(row = {}) {
  return row.coachDecision !== "next_check";
}

function effectiveContribution(row = {}) {
  return shouldPayThisCheck(row) ? currencyValue(row.contribution) : 0;
}

function plannedContribution(row, form, type) {
  const regularContribution = effectiveContribution(row);
  return currencyValue(regularContribution + allocationTotalFor(form, type, row.account));
}

function remainingAfterPlannedPayment(row, form, type) {
  return currencyValue(Math.max(0, (Number(row.totalBalance ?? row.totalOwed) || 0) - plannedContribution(row, form, type)));
}

function applySavingsRollovers(member, form) {
  const savingsAccounts = (member.savingsInvestmentAccounts || []).filter((item) => item.type === "savings");
  if (!savingsAccounts.length) return;
  (form.data.allocations || [])
    .filter((item) => shouldPayThisCheck(item) && item.type === "savings" && item.account && Number(item.amount))
    .forEach((rollover) => {
      const account = savingsAccounts.find(
        (item) => String(item.name || "").trim().toLowerCase() === String(rollover.account || "").trim().toLowerCase(),
      );
      if (!account) return;
      const amount = currencyValue(rollover.amount);
      const nextBalance = currencyValue((Number(account.balance) || 0) + amount);
      account.balance = nextBalance.toFixed(2);
      account.updatedAt = todayValue();
      account.history ||= [];
      account.history.push({
        id: uid("balance"),
        balance: account.balance,
        date: todayValue(),
        note: `Rollover from ${form.title}`,
      });
    });
}

function refreshFinancialProfileSummary(account = currentAccount()) {
  if (!account) return;
  const values = {
    "Current savings": money(profileSavingsTotal(account)),
    "Tracked assets": money(profileInvestmentTotal(account)),
    "Remaining debt": money(profileDebtTotal(account)),
  };
  document.querySelectorAll("[data-metric-label]").forEach((metricElement) => {
    const value = values[metricElement.dataset.metricLabel];
    const output = metricElement.querySelector("strong");
    if (value && output) output.textContent = value;
  });
}

function dateLabel(value) {
  if (!value) return "Not selected";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function monthYearLabel(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function updatedLabel(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function avatarMarkup(accountOrName, className = "") {
  const account =
    typeof accountOrName === "string" ? { name: accountOrName, profilePhoto: null } : accountOrName;
  const name = account?.name || "FIT";
  const fallback = `<span class="avatar-fallback" aria-hidden="true">${initials(name)}</span>`;
  if (account?.profilePhoto?.dataUrl) {
    return `<span class="avatar avatar-photo ${className}">${fallback}<img src="${escapeHtml(account.profilePhoto.dataUrl)}" alt="${escapeHtml(name)} profile photo" data-avatar-image></span>`;
  }
  return `<span class="avatar ${className}">${initials(name)}</span>`;
}

function spouseAvatarMarkup(account, className = "") {
  const name = account?.profile?.spouseName || "Spouse";
  const fallback = `<span class="avatar-fallback" aria-hidden="true">${initials(name)}</span>`;
  if (account?.spousePhoto?.dataUrl) {
    return `<span class="avatar avatar-photo ${className}">${fallback}<img src="${escapeHtml(account.spousePhoto.dataUrl)}" alt="${escapeHtml(name)} profile photo" data-avatar-image></span>`;
  }
  return `<span class="avatar ${className}">${initials(name)}</span>`;
}

function memberForms(email) {
  return Object.values(appState.forms)
    .filter((form) => form.ownerEmail === email)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getMemberCarryForward(account) {
  if (Object.keys(account.carryForward || {}).length) {
    const carried = clone(account.carryForward);
    const savingsTotal = profileSavingsTotal(account);
    if (account.savingsInvestmentAccounts?.some((item) => item.type === "savings")) {
      carried.savings ||= {};
      carried.savings.current = String(savingsTotal);
    }
    if (account.financialInventory?.debts?.length) carried.debts = clone(account.financialInventory.debts);
    if (account.financialInventory?.creditCards?.length) {
      carried.creditCards = clone(account.financialInventory.creditCards);
    }
    if (account.financialInventory?.studentLoans?.length) {
      carried.studentLoans = clone(account.financialInventory.studentLoans);
    }
    return carried;
  }
  const latest = memberForms(account.email)[0];
  if (!latest) {
    const savingsTotal = profileSavingsTotal(account);
    return account.savingsInvestmentAccounts?.some((item) => item.type === "savings")
      ? { savings: { current: String(savingsTotal), goal: "" } }
      : {};
  }
  const latestCalc = calculate(latest);
  const latestMortgagePaymentRemaining = currencyValue(Math.max(
    0,
    (Number(latest.data.mortgage.paymentAmount) || 0) - latestCalc.mortgageContribution,
  ));
  const profileSavings = account.savingsInvestmentAccounts?.some((item) => item.type === "savings")
    ? String(profileSavingsTotal(account))
    : String(latestCalc.savingsAfter || "");
  return {
    bills: Object.fromEntries(
      billGroups.map(([key]) => [
        key,
        latest.data.bills[key]
          .filter((bill) => bill.coachDecision === "next_check")
          .map((bill) => clone(bill)),
      ]),
    ),
    mortgage: {
      totalAmount: latest.data.mortgage.totalAmount || "",
      interestRate: latest.data.mortgage.interestRate || "",
      currentBalance: String(latestCalc.mortgageAfter || latest.data.mortgage.currentBalance || ""),
      paymentAmount: latest.data.mortgage.paymentAmount,
      nextDueDate: latest.data.mortgage.nextDueDate,
      mustPayBy: latest.data.mortgage.mustPayBy,
      remainingBefore: String(latestMortgagePaymentRemaining),
    },
    creditCards: account.financialInventory.creditCards.length
      ? clone(account.financialInventory.creditCards)
      : latest.data.creditCards
          .filter((card) => card.account)
          .map((card) => ({
            account: card.account,
            dueDate: card.dueDate,
            totalBalance: String(remainingAfterPlannedPayment(card, latest, "credit_card")),
            lastStatementBalance: card.lastStatementBalance || "",
            paymentDue: card.paymentDue || "",
            apr: card.apr,
            promoType: card.promoType || "none",
            purchasePromoRate: card.purchasePromoRate || "",
            purchasePromoExpiration: card.purchasePromoExpiration || "",
            balanceTransferPromoRate: card.balanceTransferPromoRate || "",
            balanceTransferPromoExpiration: card.balanceTransferPromoExpiration || "",
          })),
    savings: {
      goal: latest.data.savings.goal,
      current: profileSavings,
    },
    debts: account.financialInventory.debts.length
      ? clone(account.financialInventory.debts)
      : latest.data.debts
          .filter((debt) => debt.account)
          .map((debt) => ({
            ...clone(debt),
            totalOwed: String(remainingAfterPlannedPayment(debt, latest, "debt")),
            contribution: "",
          })),
    studentLoans: account.financialInventory.studentLoans.length
      ? clone(account.financialInventory.studentLoans)
      : (latest.data.studentLoans || [])
          .filter((loan) => loan.account)
          .map((loan) => ({
            ...clone(loan),
            totalOwed: String(remainingAfterPlannedPayment(loan, latest, "student_loan")),
            contribution: "",
          })),
  };
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
    (sum, item) => sum + effectiveContribution(item),
    0,
  ));
  const debtContributions = currencyValue(data.debts.reduce(
    (sum, item) => sum + effectiveContribution(item),
    0,
  ));
  const studentLoanContributions = currencyValue((data.studentLoans || []).reduce(
    (sum, item) => sum + effectiveContribution(item),
    0,
  ));
  const mortgageContribution = currencyValue(data.housingPaymentType === "mortgage" ? effectiveContribution(data.mortgage) : 0);
  const savingsContribution = effectiveContribution(data.savings);
  const totalDebt = [...data.debts, ...(data.studentLoans || [])].reduce(
    (sum, item) => sum + (Number(item.totalOwed) || 0),
    0,
  );
  const savingsRolloverTotal = currencyValue((data.allocations || [])
    .filter((item) => shouldPayThisCheck(item) && item.type === "savings")
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const savingsAfter = currencyValue(
    (Number(data.savings.current) || 0) + savingsContribution + savingsRolloverTotal,
  );
  const mortgageAfter = currencyValue(Math.max(
    0,
    (Number(data.mortgage.currentBalance || data.mortgage.remainingBefore) || 0) -
      mortgageContribution,
  ));
  const allocationTotal = currencyValue((data.allocations || [])
    .filter((item) => shouldPayThisCheck(item) && rolloverTypes.includes(item.type))
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0));
  const totalCreditCardBalanceAfter = currencyValue(data.creditCards.reduce(
    (sum, item) => sum + remainingAfterPlannedPayment(item, form, "credit_card"),
    0,
  ));
  const totalDebtBalanceAfter = currencyValue(data.debts.reduce(
    (sum, item) => sum + remainingAfterPlannedPayment(item, form, "debt"),
    0,
  ));
  const totalStudentLoanBalanceAfter = currencyValue((data.studentLoans || []).reduce(
    (sum, item) => sum + remainingAfterPlannedPayment(item, form, "student_loan"),
    0,
  ));
  const variableBudget = currencyValue(data.variableSpending.reduce(
    (sum, item) => sum + (shouldPayThisCheck(item) ? Number(item.budgeted) || 0 : 0),
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
  const savingsGoal = Number(data.savings.goal) || 0;
  const savingsRemaining = Math.max(0, savingsGoal - savingsAfter);
  const savingsProgress = savingsGoal
    ? Math.min(100, Math.max(0, (savingsAfter / savingsGoal) * 100))
    : 0;
  const approvedBills = Object.values(data.bills)
    .flat()
    .filter((bill) => bill.coachDecision === "this_check")
    .reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);

  return {
    thisCheck,
    additionalIncome,
    totalIncome,
    tithe,
    fixedBills,
    creditCards,
    debtContributions,
    studentLoanContributions,
    mortgageContribution,
    savingsContribution,
    savingsRolloverTotal,
    plannedBeforeBudget,
    remainingBeforeAllocations,
    remainingBeforeBudget,
    totalBills,
    totalPlanned,
    allocationTotal,
    available,
    totalDebt,
    totalCreditCardBalanceAfter,
    totalDebtBalanceAfter,
    totalStudentLoanBalanceAfter,
    savingsAfter,
    mortgageAfter,
    variableBudget,
    savingsGoal,
    savingsRemaining,
    savingsProgress,
    approvedBills,
  };
}

function visibleNotifications(account) {
  return (appState.notifications || [])
    .filter((notification) => {
      if (normalizeEmail(notification.recipientEmail) !== normalizeEmail(account.email)) return false;
      if (account.role !== "coach") return true;
      const member = appState.accounts[notification.memberEmail];
      return (
        member?.coachEmail === account.email &&
        member?.coachRequestStatus === "approved"
      );
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function addMilestoneNotifications(member, milestoneKey, title, message, type) {
  appState.notifications ||= [];
  appState.dismissedMilestoneKeys ||= [];
  if (appState.dismissedMilestoneKeys.includes(milestoneKey)) return false;
  if (
    appState.notifications.some(
      (notification) =>
        notification.milestoneKey === milestoneKey &&
        notification.memberEmail === member.email,
    )
  ) {
    return false;
  }
  if (!window.confirm(`${title}\n\n${message}\n\nMark this milestone complete and notify the connected accounts?`)) {
    return false;
  }
  const recipients = [member.email];
  if (member.coachEmail && member.coachRequestStatus === "approved") {
    recipients.push(member.coachEmail);
  }
  recipients.forEach((recipientEmail) => {
    appState.notifications.push({
      id: uid("notification"),
      milestoneKey,
      memberEmail: member.email,
      recipientEmail,
      type,
      title,
      message,
      createdAt: new Date().toISOString(),
      readAt: null,
    });
  });
  sendMilestoneEmail(member, milestoneKey, title).then((emailResult) => {
    const emailStatus = emailDeliveryMessage(emailResult, notificationEmailsForMember(member));
    if (emailStatus) showToast(`Milestone notification sent.${emailStatus}`);
  });
  return true;
}

async function notifyFitEventEmail(payload) {
  if (!productionBackend.enabled || !productionBackend.notifyFitEvent) return null;
  try {
    return await productionBackend.notifyFitEvent(payload);
  } catch (error) {
    console.warn("F.I.T. event notification could not be sent", error);
    return null;
  }
}

function notificationEmailsForMember(member) {
  if (!member) return [];
  const emails = [member.email];
  if (member.coachEmail && member.coachRequestStatus === "approved") {
    emails.push(member.coachEmail);
  }
  return [...new Set(emails.map(normalizeEmail).filter(validEmail))];
}

function notificationEmailsForForm(form) {
  return notificationEmailsForMember(appState.accounts[form?.ownerEmail] || { email: form?.ownerEmail });
}

function formatEmailList(emails = []) {
  const cleanEmails = [...new Set(emails.map(normalizeEmail).filter(validEmail))];
  if (!cleanEmails.length) return "";
  if (cleanEmails.length === 1) return cleanEmails[0];
  if (cleanEmails.length === 2) return `${cleanEmails[0]} and ${cleanEmails[1]}`;
  return `${cleanEmails.slice(0, -1).join(", ")}, and ${cleanEmails.at(-1)}`;
}

function emailDeliveryMessage(result, emails = []) {
  if (!productionBackend.enabled) return "";
  const cleanEmails = [...new Set(emails.map(normalizeEmail).filter(validEmail))];
  if (!cleanEmails.length) return "";
  const results = Array.isArray(result?.results) ? result.results : [];
  const textCount = results.filter((item) => item?.textOk).length;
  const textMessage = textCount
    ? ` Text sent to ${textCount === 1 ? "1 saved phone number" : `${textCount} saved phone numbers`}.`
    : "";
  if (results.length && results.every((item) => item?.ok)) {
    return ` Email sent to ${formatEmailList(cleanEmails)}.${textMessage}`;
  }
  const sentEmails = cleanEmails.filter((_, index) => results[index]?.ok);
  if (sentEmails.length) {
    return ` Email sent to ${formatEmailList(sentEmails)}.${textMessage} Some recipients may need a retry.`;
  }
  return textMessage || " Email notification could not be confirmed.";
}

function sendMilestoneEmail(member, milestoneKey, title) {
  return notifyFitEventEmail({
    eventType: "milestone_reached",
    memberEmail: member.email,
    milestoneName: title,
    relatedDocumentId: milestoneKey,
  });
}

function sendDocumentAvailableEmail(form, documentType = "Worksheet") {
  return notifyFitEventEmail({
    eventType: "document_available",
    memberEmail: form.ownerEmail,
    relatedDocumentId: form.id,
    documentTitle: form.title || "F.I.T. worksheet",
    documentType,
  });
}

function sendSessionCompletedEmail(form, sessionReview) {
  return notifyFitEventEmail({
    eventType: "fit_session_completed",
    memberEmail: form.ownerEmail,
    relatedSessionId: sessionReview.id,
    relatedDocumentId: form.id,
    sessionDate: dateLabel((sessionReview.sessionDate || sessionReview.createdAt || new Date().toISOString()).slice(0, 10)),
  });
}

function sendWorksheetOpenedEmail(form) {
  const actor = currentAccount();
  if (!form || !actor) return null;
  return notifyFitEventEmail({
    eventType: "worksheet_opened",
    memberEmail: form.ownerEmail,
    relatedDocumentId: form.id,
    documentTitle: form.title || "F.I.T. worksheet",
    documentType: "Worksheet",
    openedByEmail: actor.email,
    openedByName: actor.name || actor.email,
    openedByRole: actor.role === "coach" ? "coach" : "member",
  });
}

function sendSavingsWithdrawalNotification(member, withdrawal) {
  return notifyFitEventEmail({
    eventType: "savings_withdrawal",
    memberEmail: member.email,
    relatedDocumentId: withdrawal.id,
    documentTitle: withdrawal.savingsAccountName || "Savings withdrawal",
    documentType: "Savings withdrawal",
  });
}

function notifyFormMilestones(form) {
  const member = appState.accounts[form.ownerEmail];
  if (!member) return false;
  const calc = calculate(form);
  let created = false;
  if (calc.savingsGoal > 0 && calc.savingsAfter >= calc.savingsGoal) {
    created =
      addMilestoneNotifications(
        member,
        `${form.id}:savings-goal:${currencyValue(calc.savingsGoal)}`,
        "Savings goal reached",
        `${form.assignedName || member.name} reached the ${money(calc.savingsGoal)} savings goal.`,
        "savings_goal",
      ) || created;
  }
  form.data.creditCards.forEach((card) => {
    const totalBalance = Number(card.totalBalance) || 0;
    const remaining = currencyValue(totalBalance - (Number(card.contribution) || 0));
    if (card.account && totalBalance > 0 && remaining <= 0) {
      created =
        addMilestoneNotifications(
          member,
          `${form.id}:card-paid:${card.id}:${currencyValue(totalBalance)}`,
          "Credit card paid off",
          `${form.assignedName || member.name} paid off ${card.account}.`,
          "card_paid",
        ) || created;
    }
  });
  return created;
}

function notifyProfileMilestones(member) {
  let created = false;
  const savingsGoal = Number(member.carryForward?.savings?.goal) || 0;
  const savingsTotal = profileSavingsTotal(member);
  if (savingsGoal > 0 && savingsTotal >= savingsGoal) {
    created =
      addMilestoneNotifications(
        member,
        `profile-savings-goal:${currencyValue(savingsGoal)}`,
        "Savings goal reached",
        `${member.name} reached the ${money(savingsGoal)} savings goal.`,
        "savings_goal",
      ) || created;
  }
  member.financialInventory.creditCards.forEach((card) => {
    if (card.account && card.totalBalance !== "" && Number(card.totalBalance) <= 0) {
      created =
        addMilestoneNotifications(
          member,
          `profile-card-paid:${card.id}`,
          "Credit card paid off",
          `${member.name} paid off ${card.account}.`,
          "card_paid",
        ) || created;
    }
  });
  return created;
}

function render() {
  hidePageLoading();
  const account = currentAccount();
  applyTheme();
  if (loginMode === "reset" || loginMode === "delete-verify" || loginMode === "delete-success") {
    renderLogin();
    return;
  }
  if (!account) {
    renderLogin();
    return;
  }

  if (!account.profileCompleted && activeView !== "profile" && activeView !== "settings") {
    activeView = "profile";
    activeFormId = null;
    showToast("Create your profile first to unlock financial forms.");
  }

  if (activeView === "editor" && activeFormId) {
    renderEditor();
    return;
  }

  if (activeView === "about") {
    renderAbout();
    return;
  }

  if (activeView === "coach-connection") {
    renderCoachConnection();
    return;
  }

  if (activeView === "upcoming-bills") {
    renderUpcomingBills();
    return;
  }

  if (activeView === "profile") {
    renderProfile();
    return;
  }

  if (activeView === "sessions") {
    renderSessions();
    return;
  }

  if (activeView === "settings") {
    renderSettings();
    return;
  }

  renderDashboard();
}

function portalStatusMessage(kind) {
  const messages = {
    loading: {
      title: "Loading your page…",
      description: "We are securely checking your session and loading your F.I.T. workspace.",
    },
    temporary: {
      title: "We had trouble loading this page.",
      description: "Your page is still available. Please try again.",
    },
    expired: {
      title: "Your session expired.",
      description: "Please log in again to continue.",
    },
    permission: {
      title: "You do not have permission to view this page.",
      description: "Return to your workspace or ask the account owner for access.",
    },
    unavailable: {
      title: "This page is no longer available.",
      description: "It may have been removed or is no longer shared with your account.",
    },
  };
  return messages[kind] || messages.temporary;
}

function renderPortalStatusPage(kind, options = {}) {
  hidePageLoading();
  const message = portalStatusMessage(kind);
  const canRetry = kind === "temporary";
  const canReturn = Boolean(currentAccount()) && kind !== "expired";
  app.innerHTML = `
    <main class="portal-status-page">
      <section class="portal-status-card" role="${kind === "loading" ? "status" : "alert"}" aria-live="polite">
        ${kind === "loading" ? `<span class="page-loader-spinner" aria-hidden="true"></span>` : `<span class="portal-status-mark" aria-hidden="true">!</span>`}
        <p class="eyebrow">F.I.T. secure portal</p>
        <h1>${message.title}</h1>
        <p>${escapeHtml(options.description || message.description)}</p>
        <div class="button-row">
          ${canRetry ? `<button class="btn btn-primary" type="button" data-retry-page>Try again</button>` : ""}
          ${canReturn ? `<button class="btn btn-secondary" type="button" data-view="dashboard">Return to workspace</button>` : ""}
          ${kind === "expired" ? `<button class="btn btn-primary" type="button" data-login-mode="signin">Log in</button>` : ""}
        </div>
      </section>
    </main>
  `;
}

function clearAccountForAuthEnd(reason) {
  clearProtectedPortalMemory();
  activeView = "dashboard";
  activeFormId = null;
  pendingPaystubUpload = null;
  loginMode = "signin";
  document.querySelectorAll(".modal-backdrop").forEach((modal) => modal.remove());
  renderLogin();
  showToast(reason === "deleted" ? "This page is no longer available." : "Your session expired. Please log in again.");
}

function showPortalRetryBanner(message = "We had trouble loading this page. Your current page is still available.") {
  let banner = document.getElementById("portal-retry-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "portal-retry-banner";
    banner.className = "portal-retry-banner";
    banner.setAttribute("role", "alert");
    banner.innerHTML = `<span></span><button class="btn btn-secondary btn-small" type="button" data-retry-live-page>Try again</button>`;
    document.body.appendChild(banner);
  }
  banner.querySelector("span").textContent = message;
  banner.classList.add("show");
}

function removePortalRetryBanner() {
  document.getElementById("portal-retry-banner")?.remove();
}

function renderLogin() {
  hidePageLoading();
  if (loginMode === "delete-success") {
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-brand">
          <div class="brand-lockup"><img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" /></div>
          <div class="brand-statement"><div class="brand-rule"></div><h1>Your account has been deleted.</h1><p>Your F.I.T. account and saved portal data are no longer available.</p></div>
          <div class="login-footer-meta"><span class="login-caption">Account deletion complete</span><span>Privacy &amp; Security</span></div>
        </section>
        <section class="login-panel">
          <div class="login-box">
            <p class="eyebrow">Deletion confirmed</p>
            <h2>Account successfully deleted</h2>
            <p>The account for <strong>${escapeHtml(deleteVerificationEmail)}</strong> was permanently deleted. You may close this page or return to sign in.</p>
            <button class="btn btn-primary" type="button" data-login-mode="signin">Return to sign in</button>
          </div>
        </section>
      </main>
    `;
    return;
  }

  if (loginMode === "delete-verify") {
    const validLink = validEmail(deleteVerificationEmail) && deleteVerificationToken.length >= 60;
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-brand">
          <div class="brand-lockup"><img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" /></div>
          <div class="brand-statement"><div class="brand-rule"></div><h1>Protecting your account comes first.</h1><p>Account deletion only proceeds after a secure, one-time verification.</p></div>
          <div class="login-footer-meta"><span class="login-caption">Secure account verification</span><span>Privacy &amp; Security</span></div>
        </section>
        <section class="login-panel">
          <div class="login-box">
            <p class="eyebrow">Account deletion verification</p>
            <h2>${validLink ? "Permanently delete this account?" : "This verification link is invalid"}</h2>
            <p>${validLink ? `This will permanently delete the F.I.T. account for <strong>${escapeHtml(deleteVerificationEmail)}</strong>. This cannot be undone.` : "The link is incomplete or invalid. Request a new deletion link from account settings."}</p>
            ${validLink ? `<form id="complete-account-deletion-form" class="form-stack"><button class="btn btn-danger" type="submit">Permanently delete account</button><button class="btn btn-secondary" type="button" data-resend-delete-verification>Email a new verification link</button><button class="btn btn-secondary" type="button" data-cancel-delete-verification>Keep my account</button></form>` : `<button class="btn btn-secondary" type="button" data-cancel-delete-verification>Return to sign in</button>`}
          </div>
        </section>
      </main>
    `;
    return;
  }

  if (loginMode === "forgot") {
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-brand">
          <div class="brand-lockup"><img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" /></div>
          <div class="brand-statement"><div class="brand-rule"></div><h1>Return to your financial plan.</h1><p>We will send a secure password reset link to your email address.</p></div>
          <div class="login-footer-meta"><span class="login-caption">Secure account recovery</span><span>Privacy &amp; Security</span></div>
        </section>
        <section class="login-panel">
          <div class="login-box">
            <p class="eyebrow">Account recovery</p>
            <h2>Reset your password</h2>
            <p>Enter the email used for your member or coach account.</p>
            <form id="password-reset-request-form" class="form-stack">
              <div class="field"><label for="reset-email">Email address</label><input id="reset-email" name="email" type="email" autocomplete="email" required /></div>
              <button class="btn btn-primary" type="submit">Send password reset link</button>
              <button class="btn btn-secondary" type="button" data-login-mode="signin">Return to sign in</button>
            </form>
          </div>
        </section>
      </main>
    `;
    return;
  }

  if (loginMode === "reset") {
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-brand">
          <div class="brand-lockup"><img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" /></div>
          <div class="brand-statement"><div class="brand-rule"></div><h1>Create a secure new password.</h1><p>Your updated password will protect your F.I.T. financial workspace.</p></div>
          <div class="login-footer-meta"><span class="login-caption">Secure account recovery</span><span>Privacy &amp; Security</span></div>
        </section>
        <section class="login-panel">
          <div class="login-box">
            <p class="eyebrow">Account recovery</p>
            <h2>Choose a new password</h2>
            <form id="password-update-form" class="form-stack">
              <div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" minlength="8" autocomplete="new-password" required /></div>
              <div class="field"><label for="confirm-password">Confirm new password</label><input id="confirm-password" name="confirmation" type="password" minlength="8" autocomplete="new-password" required /></div>
              <button class="btn btn-primary" type="submit">Update password</button>
            </form>
          </div>
        </section>
      </main>
    `;
    return;
  }

  if (loginMode === "verify" && pendingVerificationEmail) {
    app.innerHTML = `
      <main class="login-shell">
        <section class="login-brand">
          <div class="brand-lockup">
            <img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" />
          </div>
          <div class="brand-statement">
            <div class="brand-rule"></div>
            <h1>Confirm your email to continue.</h1>
            <p>Email verification protects member financial information and coach access.</p>
          </div>
          <div class="login-footer-meta"><span class="login-caption">${productionBackend.enabled ? "Secure email confirmation" : "Local preview account ready"}</span><span>Privacy &amp; Security</span></div>
        </section>
        <section class="login-panel">
          <div class="login-box">
            <p class="eyebrow">Confirm your email</p>
            <h2>Check your inbox</h2>
            <p>Click the confirmation link sent to <strong>${escapeHtml(pendingVerificationEmail)}</strong>, then proceed to login. Delivery can take a few minutes; check spam or junk folders too.</p>
            <div class="form-stack">
              <button class="btn btn-primary" type="button" data-login-mode="signin">Proceed to login</button>
              ${
                productionBackend.enabled && confirmationResendNeeded
                  ? `<button class="btn btn-secondary" type="button" data-resend-verification>Resend confirmation email</button>`
                  : ""
              }
            </div>
          </div>
        </section>
      </main>
    `;
    return;
  }

  const isSignup = loginMode === "signup";
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-brand">
        <div class="brand-lockup">
          <img src="assets/fit-logo-exact-transparent.png" alt="FIT Financial Integrity Training" />
        </div>
        <div class="brand-statement">
          <div class="brand-rule"></div>
          <h1>Build clarity into every paycheck.</h1>
          <p>One secure place for members and coaches to plan, review, and move forward together.</p>
        </div>
        <div class="login-footer-meta"><span class="login-caption">${productionBackend.enabled ? "Secure member and coach portal" : "Local preview · Financial data stays in this browser"}</span><span>Privacy &amp; Security</span></div>
      </section>
      <section class="login-panel">
        <div class="login-box">
          <p class="eyebrow">Welcome to FIT</p>
          <h2>${isSignup ? "Create your account" : "Sign in to your portal"}</h2>
          <p>${isSignup ? "Set up a secure member or coach account." : "Enter your password to open the right workspace."}</p>
          <div class="role-switch" role="tablist" aria-label="Account type">
            <button class="role-option ${loginRole === "user" ? "active" : ""}" data-login-role="user" type="button">Member</button>
            <button class="role-option ${loginRole === "coach" ? "active" : ""}" data-login-role="coach" type="button">Coach</button>
          </div>
          <form id="${isSignup ? "signup-form" : "login-form"}" class="form-stack">
            ${
              isSignup
                ? `<div class="field">
                    <label for="signup-name">Full name</label>
                    <input id="signup-name" name="name" autocomplete="name" required />
                  </div>`
                : ""
            }
            <div class="field">
              <label for="login-email">Email address</label>
              <input id="login-email" name="email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="login-password">Password</label>
              <input id="login-password" name="password" type="password" minlength="${isSignup ? "8" : "6"}" autocomplete="${isSignup ? "new-password" : "current-password"}" required />
            </div>
            <button class="btn btn-primary" type="submit">${isSignup ? "Create account" : `Sign in as ${loginRole === "coach" ? "coach" : "member"}`} <span aria-hidden="true">→</span></button>
            <button class="btn btn-secondary" type="button" data-login-mode="${isSignup ? "signin" : "signup"}">${isSignup ? "Already have an account? Sign in" : "New user? Create an account"}</button>
            ${isSignup || !productionBackend.enabled ? "" : `<button class="btn btn-secondary" type="button" data-login-mode="forgot">Forgot password?</button>`}
          </form>
          ${productionBackend.enabled ? "" : `<div class="login-demo">or open a preview</div><div class="demo-buttons"><button class="btn btn-secondary" type="button" data-demo="alex@fitdemo.com">Member preview · demo123</button><button class="btn btn-secondary" type="button" data-demo="coach@fitdemo.com">Coach preview · demo123</button></div>`}
        </div>
      </section>
    </main>
  `;
}

function shell(content, options = {}) {
  const account = currentAccount();
  const isCoach = account.role === "coach";
  const activeNavigationView = activeView === "editor" ? "dashboard" : activeView;
  const navButton = (view, glyph, label) => `
    <button
      class="nav-btn ${activeNavigationView === view ? "active" : ""}"
      type="button"
      data-view="${view}"
      ${activeNavigationView === view ? 'aria-current="page"' : ""}
    >
      <span class="nav-glyph" aria-hidden="true">${glyph}</span>
      <span class="nav-label">${label}</span>
    </button>
  `;
  const pageTitle = options.title || (isCoach ? "Coach workspace" : "My worksheets");
  const pageSubtitle =
    options.subtitle ||
    (isCoach ? "Finished worksheets sent by your members" : "Your financial worksheet history");
  const topActions = options.actions || "";

  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="assets/fit-logo-exact-transparent.png" alt="FIT" />
        </div>
        <nav class="side-nav" aria-label="Primary navigation">
          ${navButton("dashboard", isCoach ? "◎" : "▤", isCoach ? "Forms & Reviews" : "Worksheets & Planning")}
          ${
            isCoach
              ? ""
              : `<button class="nav-btn" type="button" data-new-form>
                  <span class="nav-glyph" aria-hidden="true">＋</span>
                  <span class="nav-label">Create Worksheet</span>
                </button>`
          }
          ${navButton("upcoming-bills", "◷", "Upcoming bills")}
          ${navButton("coach-connection", "↗", isCoach ? "Mentee Management" : "Coach Connection")}
          ${navButton("profile", "◉", "My Financial Profile")}
          ${navButton("sessions", "✦", isCoach ? "Mentee Session Reviews" : "Session History")}
          ${navButton("about", "i", "About F.I.T.")}
          ${navButton("settings", "⚙", isCoach ? "Settings" : "Account Settings")}
        </nav>
        <div class="sidebar-account">
          <div class="account-block">
            ${avatarMarkup(account)}
            <div>
              <strong>${escapeHtml(account.name)}</strong>
              <span>${account.role}</span>
            </div>
          </div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <p class="fit-kicker">F.I.T. Financial Integrity Training</p>
            <h1>${escapeHtml(pageTitle)}</h1>
            <p>${escapeHtml(pageSubtitle)}</p>
          </div>
          <div class="button-row topbar-actions">
            ${topActions}
            <button class="btn btn-secondary btn-small topbar-signout" type="button" data-sign-out aria-label="Sign out">Sign out</button>
          </div>
        </header>
        ${
          !account.profileCompleted
            ? `<div class="onboarding-banner"><strong>Finish your F.I.T. profile</strong><span>Complete the required details below to unlock worksheets and collaboration.</span></div>`
            : ""
        }
        ${content}
        ${communityFooter()}
      </main>
    </div>
  `;
}

function daysUntilLabel(value) {
  if (!value) return "No due date";
  const difference = daysUntilDateValue(value);
  if (difference < 0) return "Past due";
  if (difference === 0) return "Due today";
  if (difference === 1) return "Due tomorrow";
  return `Due in ${difference} days`;
}

function daysUntilDateValue(value) {
  const today = new Date(`${todayValue()}T00:00:00`);
  const dueDate = new Date(`${value}T00:00:00`);
  return Math.round((dueDate - today) / 86400000);
}

function dueUrgencyClass(value) {
  if (!value) return "no-date";
  const difference = daysUntilDateValue(value);
  if (difference <= 3) return "urgent";
  if (difference <= 10) return "soon";
  return "steady";
}

function upcomingBillItems(account) {
  ensureFinancialInventory(account);
  const categoryLabel = Object.fromEntries(billGroups);
  const addItem = (items, item) => {
    const amount = currencyValue(item.amount);
    if (!item.name || !item.dueDate || !amount || !isDateWithinNextMonth(item.dueDate)) return;
    items.push({
      id: item.id || uid("upcoming"),
      name: item.name,
      amount,
      dueDate: item.dueDate,
      type: item.type,
      source: item.source,
      targetType: item.targetType,
    });
  };
  const items = [];

  account.financialInventory.recurringBills.forEach((bill) => {
    const dueDate = recurringBillNextDueDate(bill);
    if (!dueDate || recurringBillIsPaidForDueDate(bill, dueDate)) return;
    addItem(items, {
      id: bill.id,
      name: bill.name,
      amount: bill.amount,
      dueDate,
      type: "Recurring bill",
      source: categoryLabel[bill.category] || "Other Bills",
      targetType: "recurringBills",
    });
  });

  account.financialInventory.creditCards.forEach((card) => {
    addItem(items, {
      id: card.id,
      name: card.account,
      amount: card.paymentDue,
      dueDate: card.dueDate,
      type: "Credit card",
      source: "Card payment",
      targetType: "creditCards",
    });
  });

  account.financialInventory.debts.forEach((debt) => {
    addItem(items, {
      id: debt.id,
      name: debt.account,
      amount: debt.minimumPayment,
      dueDate: debt.dueDate,
      type: "Debt",
      source: "Minimum payment",
      targetType: "debts",
    });
  });

  account.financialInventory.studentLoans.forEach((loan) => {
    addItem(items, {
      id: loan.id,
      name: loan.account,
      amount: loan.paymentDue,
      dueDate: loan.dueDate,
      type: "Student loan",
      source: loan.loanType ? loan.loanType.replaceAll("_", " ") : "Student loan payment",
      targetType: "studentLoans",
    });
  });

  const mortgage = account.financialInventory.mortgage || {};
  if (account.financialInventory.housingPaymentType !== "rent") {
    addItem(items, {
      id: "mortgage-payment",
      name: "Mortgage payment",
      amount: mortgage.paymentAmount,
      dueDate: mortgage.nextDueDate,
      type: "Mortgage",
      source: "Housing",
      targetType: "mortgage",
    });
  }

  return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

function renderUpcomingBills() {
  const account = currentAccount();
  if (!account) {
    activeView = "dashboard";
    renderDashboard();
    return;
  }
  activeView = "upcoming-bills";
  const items = upcomingBillItems(account);
  const total = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const content = `
    <div class="content upcoming-bills-view">
      <div class="page-heading">
        <div>
          <p class="eyebrow">Next 31 days</p>
          <h2>Upcoming bills</h2>
          <p>Bills due within a month based on ${account.role === "coach" ? "your private coach financial profile" : "your saved financial profile"}.</p>
        </div>
        <div class="button-row">
          <button class="btn btn-secondary" type="button" data-open-bill-scan>Read bill PDF</button>
          <button class="btn btn-primary" type="button" data-view="profile">Update financial profile</button>
        </div>
      </div>
      <section class="upcoming-summary-grid" aria-label="Upcoming bill summary">
        ${metric("Bills coming up", String(items.length))}
        ${metric("Amount due soon", money(total))}
        ${metric("Next due", items[0] ? dateLabel(items[0].dueDate) : "None")}
      </section>
      <section class="panel upcoming-bills-panel">
        <div class="panel-heading">
          <div><h3>Due within a month</h3><p>Includes recurring bills, cards, debts, student loans, and mortgage when selected.</p></div>
          <span class="badge green">${money(total)} total</span>
        </div>
        <div class="upcoming-bill-list">
          ${
            items.length
              ? items.map(upcomingBillCard).join("")
              : emptyState("◷", "No bills due within a month", "Add due dates and amounts in your financial profile to see reminders here.", `<button class="btn btn-primary" type="button" data-view="profile">Go to financial profile</button>`)
          }
        </div>
      </section>
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "Upcoming bills",
    subtitle: "Bills and payments due within the next month",
  });
}

function upcomingBillCard(item) {
  return `
    <article class="upcoming-bill-card ${dueUrgencyClass(item.dueDate)}">
      <div class="upcoming-date-badge"><strong>${new Date(`${item.dueDate}T12:00:00`).getDate()}</strong><span>${new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${item.dueDate}T12:00:00`))}</span></div>
      <div class="upcoming-bill-main">
        <div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.type)} · ${escapeHtml(item.source)}</p></div>
        <span class="badge">${daysUntilLabel(item.dueDate)}</span>
      </div>
      <div class="upcoming-bill-actions">
        <strong class="upcoming-amount">${money(item.amount)}</strong>
        <button class="btn btn-secondary btn-small" type="button" data-mark-upcoming-paid="${escapeHtml(item.targetType)}:${escapeHtml(item.id)}" data-upcoming-due-date="${escapeHtml(item.dueDate)}">Mark paid</button>
      </div>
    </article>
  `;
}

function markUpcomingBillPaid(account, targetType, targetId, dueDate) {
  ensureFinancialInventory(account);
  const paidAt = new Date().toISOString();
  if (targetType === "recurringBills") {
    const bill = account.financialInventory.recurringBills.find((item) => item.id === targetId);
    if (!bill) return null;
    bill.paidDueDate = dueDate || recurringBillNextDueDate(bill);
    bill.nextDueDate = "";
    bill.lastPaidAt = paidAt;
    return bill.name || "Recurring bill";
  }
  if (targetType === "creditCards") {
    const card = account.financialInventory.creditCards.find((item) => item.id === targetId);
    if (!card) return null;
    card.lastPaidDueDate = card.dueDate || dueDate;
    card.dueDate = "";
    card.lastPaidAt = paidAt;
    return card.account || "Credit card";
  }
  if (targetType === "debts") {
    const debt = account.financialInventory.debts.find((item) => item.id === targetId);
    if (!debt) return null;
    debt.lastPaidDueDate = debt.dueDate || dueDate;
    debt.dueDate = "";
    debt.lastPaidAt = paidAt;
    return debt.account || "Debt";
  }
  if (targetType === "studentLoans") {
    const loan = account.financialInventory.studentLoans.find((item) => item.id === targetId);
    if (!loan) return null;
    loan.lastPaidDueDate = loan.dueDate || dueDate;
    loan.dueDate = "";
    loan.lastPaidAt = paidAt;
    return loan.account || "Student loan";
  }
  if (targetType === "mortgage") {
    const mortgage = account.financialInventory.mortgage;
    mortgage.lastPaidDueDate = mortgage.nextDueDate || dueDate;
    mortgage.nextDueDate = "";
    mortgage.lastPaidAt = paidAt;
    return "Mortgage payment";
  }
  return null;
}

function renderProfile() {
  const account = currentAccount();
  ensureAccountModel(account);
  activeView = "profile";

  if (account.role === "coach") {
    const mentees = Object.values(appState.accounts).filter(
      (member) =>
        member.role === "user" &&
        member.coachEmail === account.email &&
        member.coachRequestStatus === "approved",
    );
    const content = `
      <div class="content financial-profile-view">
        <div class="page-heading"><div><p class="eyebrow">Coach financial profile</p><h2>My F.I.T. financial profile</h2><p>Your private finances are separate from every mentee profile.</p></div><button class="btn btn-primary" type="button" data-save-financial-profile>Save profile data</button></div>
        <section class="profile-overview">
          <div class="profile-photo-row">${profilePhotoPanel(account, true)}</div>
          <div class="profile-overview-metrics">
            ${metric("Current savings", money(profileSavingsTotal(account)))}
            ${metric("Tracked assets", money(profileInvestmentTotal(account)))}
            ${metric("Remaining debt", money(profileDebtTotal(account)))}
          </div>
        </section>
        ${personalProfilePanel(account)}
        ${financialProfileSections(account, true)}
        <section class="dashboard-band">
          <div class="page-heading"><div><h2>Mentee financial profiles</h2><p>Only accepted, active mentees appear here.</p></div></div>
          ${
            mentees.length
              ? `<section class="profile-list">${mentees.map(coachProfileCard).join("")}</section>`
              : emptyState("◉", "No mentees assigned", "Invite a member or accept a request to see their shared profile.", `<button class="btn btn-primary" type="button" data-view="coach-connection">Manage mentees</button>`)
          }
        </section>
      </div>
    `;
    app.innerHTML = shell(content, {
      title: "Financial profile",
      subtitle: "Your private finances and assigned mentee profiles",
    });
    return;
  }

  const currentSavings = profileSavingsTotal(account);
  const totalDebt = profileDebtTotal(account);
  const assetTotal = profileInvestmentTotal(account);
  const content = `
    <div class="content financial-profile-view">
      <div class="page-heading"><div><p class="eyebrow">Your financial foundation</p><h2>My F.I.T. financial profile</h2><p>Profile data becomes the starting point for every new worksheet.</p></div><button class="btn btn-primary" type="button" data-save-financial-profile>Save profile data</button></div>
      <section class="profile-overview">
        <div class="profile-photo-row">
          ${profilePhotoPanel(account, true)}
          ${account.profile.maritalStatus === "married" ? spousePhotoPanel(account, true) : ""}
        </div>
        <div class="profile-overview-metrics">
          ${metric("Current savings", money(currentSavings))}
          ${metric("Tracked assets", money(assetTotal))}
          ${metric("Remaining debt", money(totalDebt))}
        </div>
      </section>
      ${personalProfilePanel(account)}
      ${financialProfileSections(account, true)}
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "Financial profile",
    subtitle: "Saved household, financial, and paystub archive",
  });
}

function financialProfileSections(account, includePaystubs) {
  return `
    <nav class="profile-jump-nav" aria-label="Financial profile sections">
      <span>Jump to section</span>
      <a href="#profile-savings">Savings & investments</a>
      ${includePaystubs ? `<a href="#profile-paystubs">Paystubs</a>` : ""}
      <a href="#profile-housing">Housing</a>
      <a href="#profile-bills">Recurring bills</a>
      <a href="#profile-cards">Cards</a>
      <a href="#profile-debts">Debts</a>
      <a href="#profile-student-loans">Student loans</a>
    </nav>
    ${assetAccountsSection(account)}
    ${includePaystubs ? paystubVault(account, false) : ""}
    ${mortgageProfileSection(account)}
    <section class="panel profile-inventory" id="profile-bills">
      <div class="panel-heading"><div><h3>Recurring bills</h3><p>Save recurring bills and optional monthly schedule details.</p></div><button class="btn btn-secondary btn-small" type="button" data-add-profile-item="recurringBills"><span aria-hidden="true">＋</span> Add recurring bill</button></div>
      ${billScanPanel(account)}
      <div class="profile-inventory-list">
        ${account.financialInventory.recurringBills.length ? account.financialInventory.recurringBills.map((bill, index) => recurringBillProfileCard(bill, index)).join("") : emptyInline("No recurring bills", "Add recurring bills to organize your private financial profile.")}
      </div>
    </section>
    <section class="panel profile-inventory" id="profile-cards">
      <div class="panel-heading"><div><h3>Card accounts</h3><p>Track standard APR and separate purchase or balance-transfer promotional offers.</p></div><button class="btn btn-secondary btn-small" type="button" data-add-profile-item="creditCards"><span aria-hidden="true">＋</span> Add card account</button></div>
      <div class="profile-inventory-list">
        ${account.financialInventory.creditCards.length ? account.financialInventory.creditCards.map((card, index) => creditCardProfileCard(card, index)).join("") : emptyInline("No card accounts", "Add a card account to track balances and APR details.")}
      </div>
    </section>
    <section class="panel profile-inventory" id="profile-debts">
      <div class="panel-heading"><div><h3>Saved debts</h3><p>Track debt balances, payments, and rates.</p></div><button class="btn btn-secondary btn-small" type="button" data-add-profile-item="debts"><span aria-hidden="true">＋</span> Add debt</button></div>
      <div class="profile-inventory-list">
        ${account.financialInventory.debts.length ? account.financialInventory.debts.map((debt, index) => debtProfileCard(debt, index)).join("") : emptyInline("No debts saved", "Add debt accounts to track balances privately.")}
      </div>
    </section>
    <section class="panel profile-inventory" id="profile-student-loans">
      <div class="panel-heading"><div><h3>Student loans</h3><p>Track each student loan separately for payoff planning.</p></div><button class="btn btn-secondary btn-small" type="button" data-add-profile-item="studentLoans"><span aria-hidden="true">＋</span> Add student loan</button></div>
      <div class="profile-inventory-list">
        ${account.financialInventory.studentLoans.length ? account.financialInventory.studentLoans.map((loan, index) => studentLoanProfileCard(loan, index)).join("") : emptyInline("No student loans saved", "Add student loans to track payoff progress.")}
      </div>
    </section>
  `;
}

function personalProfilePanel(account) {
  const isCoach = account.role === "coach";
  return `
    <details class="panel profile-details-panel" ${account.profileCompleted ? "" : "open"}>
      <summary class="panel-heading profile-details-summary"><div><h3>Personal and household details</h3><p>${isCoach ? "Your name and phone number are required." : "Names, contact details, household information, and spouse details."}</p></div><div class="profile-details-status">${account.profileCompleted ? `<span class="badge green">Profile ready</span>` : `<span class="badge">Required</span>`}<span class="profile-details-action" aria-hidden="true"></span><span class="profile-details-chevron" aria-hidden="true">⌄</span></div></summary>
      <form id="profile-form" class="panel-body profile-form-grid">
        <div class="field"><label for="profile-name">Full name</label><input id="profile-name" class="input" name="name" value="${escapeHtml(account.name)}" required></div>
        <div class="field"><label>Email address</label><input class="input" value="${escapeHtml(account.email)}" disabled></div>
        <div class="field"><label for="profile-phone">Phone number</label><input id="profile-phone" class="input" name="phone" value="${escapeHtml(account.profile.phone)}" inputmode="tel" required></div>
        ${
          isCoach
            ? `<div class="field"><label for="profile-employer">Ministry / organization</label><input id="profile-employer" class="input" name="employer" value="${escapeHtml(account.profile.employer)}" placeholder="Optional"></div>
               <input type="hidden" name="address" value="${escapeHtml(account.profile.address)}">
               <input type="hidden" name="payFrequency" value="${escapeHtml(account.profile.payFrequency)}">
               <input type="hidden" name="maritalStatus" value="${escapeHtml(account.profile.maritalStatus)}">
               <input type="hidden" name="spouseName" value="${escapeHtml(account.profile.spouseName)}">`
            : `<div class="field"><label for="profile-employer">Employer</label><input id="profile-employer" class="input" name="employer" value="${escapeHtml(account.profile.employer)}" required></div>
               <div class="field"><label for="profile-address">Home address</label><input id="profile-address" class="input" name="address" value="${escapeHtml(account.profile.address)}" required></div>
               <div class="field"><label for="pay-frequency">Pay frequency</label><select id="pay-frequency" class="input" name="payFrequency" required>
                 ${selectOption("", "Select frequency", account.profile.payFrequency)}
                 ${selectOption("Weekly", "Weekly", account.profile.payFrequency)}
                 ${selectOption("Biweekly", "Biweekly", account.profile.payFrequency)}
                 ${selectOption("Monthly", "Monthly", account.profile.payFrequency)}
               </select></div>
               <div class="field"><label for="marital-status">Marital status</label><select id="marital-status" class="input" name="maritalStatus" required>
                 ${selectOption("", "Select status", account.profile.maritalStatus)}
                 ${selectOption("single", "Single", account.profile.maritalStatus)}
                 ${selectOption("married", "Married", account.profile.maritalStatus)}
               </select></div>
               <div class="field spouse-field ${account.profile.maritalStatus === "married" ? "" : "hidden"}"><label for="spouse-name">Spouse name</label><input id="spouse-name" class="input" name="spouseName" value="${escapeHtml(account.profile.spouseName)}" placeholder="Spouse full name" ${account.profile.maritalStatus === "married" ? "required" : ""}></div>
               <div class="field spouse-field ${account.profile.maritalStatus === "married" ? "" : "hidden"}"><label for="spouse-employer">Spouse employer</label><input id="spouse-employer" class="input" name="spouseEmployer" value="${escapeHtml(account.profile.spouseEmployer)}"></div>
               <div class="field spouse-field ${account.profile.maritalStatus === "married" ? "" : "hidden"}"><label for="spouse-phone">Phone Number</label><input id="spouse-phone" class="input" name="spousePhone" value="${escapeHtml(account.profile.spousePhone)}" inputmode="tel"></div>
               <div class="field spouse-field ${account.profile.maritalStatus === "married" ? "" : "hidden"}"><label for="spouse-pay-frequency">Spouse pay frequency</label><select id="spouse-pay-frequency" class="input" name="spousePayFrequency">
                 ${selectOption("", "Select frequency", account.profile.spousePayFrequency)}
                 ${selectOption("Weekly", "Weekly", account.profile.spousePayFrequency)}
                 ${selectOption("Biweekly", "Biweekly", account.profile.spousePayFrequency)}
                 ${selectOption("Monthly", "Monthly", account.profile.spousePayFrequency)}
               </select></div>`
        }
        <button class="btn btn-primary profile-save" type="submit">Save financial profile</button>
      </form>
    </details>
  `;
}

function profilePhotoPanel(account, canEdit) {
  return `
    <section class="profile-photo-panel">
      ${avatarMarkup(account, "avatar-xl")}
      <div><strong>${escapeHtml(account.name)}</strong><span>${account.role === "coach" ? "F.I.T. coach" : "F.I.T. member"}</span></div>
      ${
        canEdit
          ? `<button class="btn btn-secondary btn-small profile-photo-button" type="button" data-change-photo="account-holder">Change photo</button>
             <input class="profile-photo-input" type="file" data-profile-photo-upload accept="image/png,image/jpeg,image/webp">`
          : ""
      }
    </section>
  `;
}

function spousePhotoPanel(account, canEdit) {
  return `
    <section class="profile-photo-panel spouse-photo-panel">
      ${spouseAvatarMarkup(account, "avatar-xl")}
      <div><strong>${escapeHtml(account.profile.spouseName || "Spouse")}</strong><span>Spouse profile photo</span></div>
      ${
        canEdit
          ? `<button class="btn btn-secondary btn-small profile-photo-button" type="button" data-change-photo="spouse">Change photo</button>
             <input class="profile-photo-input" type="file" data-spouse-photo-upload accept="image/png,image/jpeg,image/webp">`
          : ""
      }
    </section>
  `;
}

function emptyInline(title, description) {
  return `<div class="inline-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
}

function assetAccountsSection(account) {
  const savings = account.savingsInvestmentAccounts.filter((item) => item.type === "savings");
  const investments = account.savingsInvestmentAccounts.filter((item) => item.type === "investment");
  return `
    <section class="panel profile-inventory asset-section" id="profile-savings">
      <div class="panel-heading"><div><h3>Savings and investment tracking</h3><p>Manually record balances and build a history of progress over time.</p></div><button class="btn btn-secondary btn-small" type="button" data-add-asset-account><span aria-hidden="true">＋</span> Add account</button></div>
      <div class="asset-summary-strip">
        ${profileFact("Total savings", money(savings.reduce((sum, item) => sum + (Number(item.balance) || 0), 0)))}
        ${profileFact("Total investments", money(investments.reduce((sum, item) => sum + (Number(item.balance) || 0), 0)))}
        ${profileFact("Combined total", money(account.savingsInvestmentAccounts.reduce((sum, item) => sum + (Number(item.balance) || 0), 0)))}
      </div>
      <div class="asset-chart-wrap">${assetHistoryChart(account.savingsInvestmentAccounts)}</div>
      <div class="profile-inventory-list">
        ${account.savingsInvestmentAccounts.length ? account.savingsInvestmentAccounts.map((assetAccount, index) => assetAccountCard(assetAccount, index, account.role !== "coach")).join("") : emptyInline("No savings or investment accounts added", "Add an account to begin tracking balances and history.")}
      </div>
    </section>
  `;
}

function assetAccountCard(assetAccount, index, canRecordWithdrawal) {
  const typeLabel = assetAccount.type === "investment" ? "Investment" : "Savings";
  return `
    <article class="profile-inventory-card asset-account-card">
      <div class="asset-type-choice" aria-label="Account type">
        <button class="type-choice ${assetAccount.type === "savings" ? "active" : ""}" type="button" data-asset-type="${index}.savings">Savings</button>
        <button class="type-choice ${assetAccount.type === "investment" ? "active" : ""}" type="button" data-asset-type="${index}.investment">Investment</button>
      </div>
      <div class="profile-inventory-grid">
        <div class="field"><label>Account name</label><input class="input" data-asset-path="${index}.name" value="${escapeHtml(assetAccount.name)}" placeholder="${typeLabel} account"></div>
        <div class="field"><label>Current balance</label><div class="money-input-wrap"><input class="input" type="text" inputmode="decimal" data-currency-input data-asset-path="${index}.balance" value="${moneyInputValue(assetAccount.balance)}" placeholder="0.00"></div></div>
        <div class="field"><label>Date updated</label><input class="input" type="date" data-asset-path="${index}.updatedAt" value="${assetAccount.updatedAt || todayValue()}"></div>
        <div class="field"><label>Optional notes</label><input class="input" data-asset-path="${index}.notes" value="${escapeHtml(assetAccount.notes)}" placeholder="Purpose or goal"></div>
      </div>
      <div class="entry-footer"><span class="badge ${assetAccount.type === "investment" ? "" : "green"}">${typeLabel}</span><span>${assetAccount.history.length} historical update${assetAccount.history.length === 1 ? "" : "s"}</span></div>
      ${assetAccount.type === "savings" && canRecordWithdrawal ? `<button class="btn btn-secondary btn-small" type="button" data-withdraw-profile-savings="${index}">Record withdrawal</button>` : ""}
      <button class="icon-btn danger profile-remove" type="button" aria-label="Remove tracked account" title="Remove tracked account" data-remove-asset-account="${index}">×</button>
    </article>
  `;
}

function assetHistoryChart(accounts) {
  const datedEntries = accounts
    .flatMap((account) => account.history.map((entry) => ({ ...entry, account })))
    .filter((entry) => entry.date && Number.isFinite(Number(entry.balance)));
  if (!datedEntries.length) {
    return emptyInline("No savings or investment history yet", "Update an account balance to create the first graph entry.");
  }
  const dates = [...new Set(datedEntries.map((entry) => entry.date))].sort();
  const accountPalette = ["#16825d", "#315fc4", "#c25d24", "#7b4bb7", "#008aa6", "#b33f72", "#7a761c", "#5b6f91"];
  const colorForAccount = (account, index) => {
    const seed = [...String(account.id || account.name || index)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return accountPalette[seed % accountPalette.length];
  };
  const series = accounts
    .filter((account) => account.history.length)
    .map((account, index) => ({
      id: `account-${index}`,
      name: account.name || (account.type === "investment" ? "Investment" : "Savings"),
      type: account.type,
      color: colorForAccount(account, index),
      values: dates.map((date) => {
        const latest = account.history
          .filter((entry) => entry.date <= date)
          .sort((a, b) => a.date.localeCompare(b.date))
          .at(-1);
        return Number(latest?.balance) || 0;
      }),
    }));
  series.push({
    id: "combined",
    name: "Combined",
    type: "combined",
    color: "#d9a62e",
    values: dates.map((_, index) => series.reduce((sum, item) => sum + item.values[index], 0)),
  });
  const rawMax = Math.max(1, ...series.flatMap((item) => item.values));
  const roughStep = rawMax / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep || 1));
  const normalizedStep = roughStep / magnitude;
  const scaleStep = (normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10) * magnitude;
  const max = Math.max(scaleStep, Math.ceil(rawMax / scaleStep) * scaleStep);
  const width = 720;
  const height = 292;
  const padLeft = 72;
  const padRight = 24;
  const padTop = 22;
  const padBottom = 52;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const yTicks = Array.from({ length: Math.round(max / scaleStep) + 1 }, (_, index) => index * scaleStep);
  const visibleDateIndexes = dates.length <= 5
    ? dates.map((_, index) => index)
    : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
  const pointArrayFor = (values) =>
    values.map((value, index) => {
      const x = padLeft + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth);
      const y = padTop + plotHeight - (value / max) * plotHeight;
      return { x, y, value };
    });
  const pointsFor = (values) => pointArrayFor(values).map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const combined = series.at(-1);
  const combinedChange = combined.values.at(-1) - combined.values[0];
  const changeClass = combinedChange > 0 ? "positive" : combinedChange < 0 ? "negative" : "neutral";
  const changeLabel = combinedChange === 0 ? "No change" : `${combinedChange > 0 ? "+" : "−"}${money(Math.abs(combinedChange))}`;
  const combinedAreaPoints = [`${padLeft},${padTop + plotHeight}`, pointsFor(combined.values), `${width - padRight},${padTop + plotHeight}`].join(" ");
  return `
    <div class="asset-chart-header">
      <div><span>Portfolio trend</span><strong>${money(combined.values.at(-1))}</strong></div>
      <div class="asset-chart-change ${changeClass}"><span>${dates.length > 1 ? `${monthYearLabel(dates[0])} – ${monthYearLabel(dates.at(-1))}` : "Current snapshot"}</span><strong>${changeLabel}</strong></div>
    </div>
    <div class="chart-legend" aria-label="Chart series controls">${series.map((item) => `
      <button type="button" data-chart-toggle="${item.id}" aria-pressed="true" title="Show or hide ${escapeHtml(item.name)}">
        <i style="background:${item.color}"></i><span>${escapeHtml(item.name)}</span><strong>${money(item.values.at(-1))}</strong>
      </button>`).join("")}
    </div>
    <svg class="asset-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Savings and investment account history">
      ${yTicks.map((value) => {
        const y = padTop + plotHeight - (value / max) * plotHeight;
        return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" class="chart-grid-line"></line><text x="${padLeft - 10}" y="${y + 4}" text-anchor="end" class="chart-axis-label">${money(value)}</text>`;
      }).join("")}
      <polygon data-chart-series="combined" class="chart-combined-area" points="${combinedAreaPoints}" fill="${combined.color}"></polygon>
      ${series.map((item) => `
        <g data-chart-series="${item.id}" class="chart-series ${item.type === "combined" ? "combined" : ""}">
          <polyline points="${pointsFor(item.values)}" fill="none" stroke="${item.color}" stroke-width="${item.type === "combined" ? 4 : 2.5}" stroke-linecap="round" stroke-linejoin="round"></polyline>
          ${pointArrayFor(item.values).map(({ x, y, value }, index) => `<circle cx="${x}" cy="${y}" r="${item.type === "combined" ? 4.5 : 3.5}" fill="${item.color}"><title>${escapeHtml(item.name)} · ${dateLabel(dates[index])} · ${money(value)}</title></circle>`).join("")}
        </g>`).join("")}
      ${visibleDateIndexes.map((index) => {
        const x = padLeft + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth);
        return `<text x="${x}" y="${height - 18}" text-anchor="middle" class="chart-date">${escapeHtml(monthYearLabel(dates[index]))}</text>`;
      }).join("")}
      <text x="${padLeft + plotWidth / 2}" y="${height - 2}" text-anchor="middle" class="chart-axis-title">Balance history</text>
    </svg>
  `;
}

function paystubVault(account, coachView) {
  const recent = account.paystubs[0];
  return `
    <section class="panel profile-vault" id="profile-paystubs">
      <div class="panel-heading"><div><h3>Paystub archive</h3><p>Submitted paystubs are organized by date and kept out of the main view.</p></div><span class="badge green">${account.paystubs.length} archived</span></div>
      <div class="panel-body">
        <div class="vault-notice"><strong>Secure storage standard</strong><span>${productionBackend.enabled ? "Files are stored in private Supabase Storage and protected by account permissions." : "Local preview files stay in this browser. Production mode uses private Supabase Storage."}</span></div>
        ${
          coachView
            ? ""
            : `<form id="paystub-submit-form" class="paystub-submit-grid">
                <label class="paystub-upload">
                  <input type="file" data-paystub-upload accept=".pdf,.png,.jpg,.jpeg">
                  <span>${pendingPaystubUpload ? escapeHtml(pendingPaystubUpload.name) : "Choose a paystub"}</span>
                  <small>${pendingPaystubUpload ? `${formatFileSize(pendingPaystubUpload.size)} ready to submit` : "PDF, PNG, or JPG up to 2 MB"}</small>
                </label>
                <button class="btn btn-primary" type="submit" ${pendingPaystubUpload ? "" : "disabled"}>Submit to archive</button>
              </form>`
        }
        <div class="recent-document-summary">
          <span>Most recent paystub</span>
          ${recent ? paystubCard(recent, coachView) : emptyInline("No paystubs uploaded", "Submitted paystubs will appear here and in the archive.")}
        </div>
        <details class="archive-details">
          <summary>Open paystub archive <span>${account.paystubs.length}</span></summary>
          <div class="paystub-list">
            ${account.paystubs.length ? account.paystubs.map((paystub) => paystubCard(paystub, coachView)).join("") : emptyInline("No archived paystubs", "There are no submitted paystubs to display.")}
          </div>
        </details>
      </div>
    </section>
  `;
}

function selectOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function profileRelationship(account) {
  if (account.profile.maritalStatus === "married") {
    return `Married${account.profile.spouseName ? ` to ${account.profile.spouseName}` : ""}`;
  }
  if (account.profile.maritalStatus === "single") return "Single";
  return "Not provided";
}

function coachProfileCard(member) {
  const currentSavings = reportedSavingsTotal(member);
  const totalDebt = profileDebtTotal(member);
  return `
    <article class="panel coach-profile">
      <div class="panel-heading"><div class="profile-heading-person">${avatarMarkup(member, "avatar-lg")}<div><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.email)}</p>${activityBadge(member)}</div></div><span class="badge green">${escapeHtml(profileRelationship(member))}</span></div>
      <div class="profile-facts">
        ${profileFact("Spouse", member.profile.spouseName || "Not provided")}
        ${profileFact("Employer", member.profile.employer || "Not provided")}
        ${profileFact("Pay frequency", member.profile.payFrequency || "Not provided")}
        ${profileFact("Current savings", money(currentSavings))}
        ${profileFact("Remaining debt", money(totalDebt))}
        ${profileFact("Paystubs", String(member.paystubs.length))}
      </div>
      <div class="coach-profile-actions"><button class="btn btn-secondary btn-small" type="button" data-open-mentee-profile="${member.email}">View shared details</button></div>
    </article>
  `;
}

function showMenteeProfileModal(email) {
  const coach = currentAccount();
  const member = appState.accounts[email];
  if (
    !member ||
    coach.role !== "coach" ||
    member.coachEmail !== coach.email ||
    member.coachRequestStatus !== "approved"
  ) {
    showToast("That mentee profile is not available.");
    return;
  }
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="mentee-profile-title">
      <div class="modal-header"><div class="profile-heading-person">${avatarMarkup(member, "avatar-lg")}<div><h3 id="mentee-profile-title">${escapeHtml(member.name)}</h3><p>${escapeHtml(member.email)}</p></div></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        ${
          member.profile.maritalStatus === "married"
            ? `<div class="household-photo-row"><div>${avatarMarkup(member, "avatar-lg")}<span>Account holder</span></div><div>${spouseAvatarMarkup(member, "avatar-lg")}<span>${escapeHtml(member.profile.spouseName || "Spouse")}</span></div></div>`
            : ""
        }
        <div class="profile-facts">
          ${profileFact("Spouse", member.profile.spouseName || "Not provided")}
          ${profileFact("Spouse employer", member.profile.spouseEmployer || "Not provided")}
          ${profileFact("Spouse phone", member.profile.spousePhone || "Not provided")}
          ${profileFact("Spouse pay frequency", member.profile.spousePayFrequency || "Not provided")}
          ${profileFact("Employer", member.profile.employer || "Not provided")}
          ${profileFact("Pay frequency", member.profile.payFrequency || "Not provided")}
          ${profileFact("Recurring bills", String(member.financialInventory.recurringBills.length))}
          ${profileFact("Card accounts", String(member.financialInventory.creditCards.length))}
          ${profileFact("Student loans", String(member.financialInventory.studentLoans.length))}
          ${profileFact("Mortgage balance", money(member.financialInventory.mortgage.currentBalance))}
          ${profileFact("Current savings", money(reportedSavingsTotal(member)))}
          ${profileFact("Tracked investment assets", money(profileInvestmentTotal(member)))}
        </div>
        ${assetHistoryChart(member.savingsInvestmentAccounts)}
        ${paystubVault(member, true)}
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function profileFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function paystubCard(paystub, coachView) {
  return `
    <article class="paystub-card">
      <div><strong>${escapeHtml(paystub.name)}</strong><span>${updatedLabel(paystub.submittedAt || paystub.uploadedAt)} · ${formatFileSize(paystub.size)}</span></div>
      <div class="button-row">
        <a class="btn btn-secondary btn-small" href="${paystub.dataUrl}" target="_blank" rel="noopener">View</a>
        ${coachView ? "" : `<button class="icon-btn danger" type="button" title="Delete paystub" aria-label="Delete paystub" data-delete-paystub="${paystub.id}">×</button>`}
      </div>
    </article>
  `;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function recurringBillProfileCard(bill, index) {
  const nextDueDate = recurringBillDisplayDueDate(bill);
  return `
    <article class="profile-inventory-card">
      <div class="profile-inventory-grid recurring-bill-grid">
        ${textField("Bill name", `financialInventory.recurringBills.${index}.name`, bill.name, false, "Bill name")}
        <div class="field">
          <label>Category</label>
          <select class="input" data-profile-path="financialInventory.recurringBills.${index}.category">
            ${billGroups.map(([value, label]) => selectOption(value, label, bill.category)).join("")}
          </select>
        </div>
        ${dateField("Next due date", `financialInventory.recurringBills.${index}.nextDueDate`, nextDueDate, false)}
        ${moneyField("Next payment amount", `financialInventory.recurringBills.${index}.amount`, bill.amount, false)}
      </div>
      <label class="schedule-toggle"><input type="checkbox" data-recurring-schedule-toggle="${index}" ${bill.scheduleEnabled ? "checked" : ""}><span>Recurring bill details</span></label>
      ${
        bill.scheduleEnabled
          ? `<div class="schedule-fields">
              <p class="schedule-help">Selecting a fixed monthly day fills the next due date above. Leave it blank when the due date changes.</p>
              <div class="field"><label>Fixed monthly due day</label><select class="input" data-profile-path="financialInventory.recurringBills.${index}.dueDay">${dueDayOptions(bill.dueDay)}</select></div>
              ${moneyField("Monthly amount", `financialInventory.recurringBills.${index}.monthlyAmount`, bill.monthlyAmount || bill.amount, false)}
            </div>`
          : ""
      }
      <button class="icon-btn danger profile-remove" type="button" aria-label="Remove recurring bill" title="Remove recurring bill" data-remove-profile-item="recurringBills.${index}">×</button>
    </article>
  `.replaceAll("data-path=", "data-profile-path=");
}

function billScanPanel(account) {
  const billCount = billScanSourceBills(account).length;
  return `
    <div class="bill-scan-panel">
      <div>
        <h4>Read new bill document</h4>
        <p>Upload the original PDF bill for the best result. If needed, F.I.T. uses OCR as a backup and asks before updating a saved bill.</p>
      </div>
      <button class="btn btn-secondary btn-small" type="button" data-open-bill-scan>
        <span aria-hidden="true">↗</span> Read bill
      </button>
      <span class="bill-scan-meta">${billCount ? `${billCount} saved bill${billCount === 1 ? "" : "s"} available` : "Saved bills can be added during review"}</span>
    </div>
  `;
}

function billScanSourceBills(account = currentAccount()) {
  if (!account) return [];
  ensureFinancialInventory(account);
  return (account?.financialInventory?.recurringBills || [])
    .filter((bill) => String(bill.name || "").trim())
    .map((bill) => ({
      id: bill.id || "",
      name: bill.name,
      category: bill.category || "other",
    }));
}

function billScanCategoryOptions(selected = "other") {
  return billGroups.map(([value, label]) => selectOption(value, label, selected || "other")).join("");
}

function billScanMatchOptions(account, selectedId = "") {
  const categoryLabel = Object.fromEntries(billGroups);
  const bills = billScanSourceBills(account).sort((a, b) => a.name.localeCompare(b.name));
  return [
    `<option value="__new__" ${selectedId ? "" : "selected"}>Add as a new saved bill</option>`,
    ...bills.map((bill) => `
      <option value="${escapeHtml(bill.id)}" ${bill.id === selectedId ? "selected" : ""}>
        ${escapeHtml(bill.name)} · ${escapeHtml(categoryLabel[bill.category] || "Other Bills")}
      </option>
    `),
  ].join("");
}

function showBillScanUploadModal() {
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="bill-scan-upload-title">
      <div class="modal-header">
        <div><p class="document-label">Bill update</p><h3 id="bill-scan-upload-title">Read a new bill document</h3></div>
        <button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button>
      </div>
      <form id="bill-scan-upload-form" class="modal-body bill-scan-upload-form">
        <p>Use this for a new bill amount and due date only. F.I.T. reads PDF text first, then uses OCR as a backup when needed.</p>
        <label class="bill-scan-upload">
          <input type="file" name="billDocument" accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp" required>
          <span>Choose bill PDF, screenshot, or photo</span>
          <small>Best: original PDF · OCR backup for images or scanned PDFs</small>
        </label>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Read bill</button>
          <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        </div>
      </form>
    </section>
  `;
  document.body.appendChild(modal);
}

function showBillScanReviewModal(scan = {}, uploadMeta = {}) {
  const account = currentAccount();
  const selectedBill = billScanSourceBills(account).find((bill) => bill.id === scan.matchedBillId);
  const selectedCategory = selectedBill?.category || "other";
  pendingBillScanUpload = {
    scan,
    uploadMeta,
  };
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal modal-wide bill-scan-review-modal" role="dialog" aria-modal="true" aria-labelledby="bill-scan-review-title">
      <div class="modal-header">
        <div><p class="document-label">Confirm bill update</p><h3 id="bill-scan-review-title">Is this the bill you want to update?</h3></div>
        <button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button>
      </div>
      <form id="bill-scan-confirm-form" class="modal-body">
        <div class="bill-scan-result">
          <div><span>Suggested bill</span><strong>${escapeHtml(selectedBill?.name || scan.vendorName || "Review needed")}</strong></div>
          <div><span>Amount found</span><strong>${scan.amountDue ? money(scan.amountDue) : "Needs review"}</strong></div>
          <div><span>Due date found</span><strong>${scan.dueDate ? dateLabel(scan.dueDate) : "Needs review"}</strong></div>
          <div><span>Reader confidence</span><strong>${Math.round((Number(scan.confidence) || 0) * 100)}%</strong></div>
        </div>
        ${scan.notes ? `<p class="bill-scan-note">${escapeHtml(scan.notes)}</p>` : ""}
        <div class="bill-scan-confirm-grid">
          <div class="field">
            <label>Bill to update</label>
            <select class="input" name="billId" data-bill-scan-select>
              ${billScanMatchOptions(account, scan.matchedBillId || "")}
            </select>
          </div>
          <div class="field bill-scan-new-field">
            <label>New bill name</label>
            <input class="input" name="newBillName" value="${escapeHtml(scan.vendorName || "")}" placeholder="Bill name">
          </div>
          <div class="field bill-scan-new-field">
            <label>Category</label>
            <select class="input" name="newBillCategory">${billScanCategoryOptions(selectedCategory)}</select>
          </div>
          <div class="field">
            <label>New payment amount</label>
            <div class="money-input-wrap"><input class="input" type="text" inputmode="decimal" data-currency-input name="amountDue" value="${moneyInputValue(scan.amountDue)}" placeholder="0.00" required></div>
          </div>
          <div class="field">
            <label>New due date</label>
            <input class="input" type="date" name="dueDate" value="${escapeHtml(scan.dueDate || "")}" required>
          </div>
        </div>
        <div class="vault-notice"><strong>Review before saving</strong><span>Document readers can misread bills. Confirm the bill, amount, and date before updating the saved bill.</span></div>
        <div class="button-row">
          <button class="btn btn-primary" type="submit">Update saved bill</button>
          <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        </div>
      </form>
    </section>
  `;
  document.body.appendChild(modal);
  toggleBillScanNewFields(modal.querySelector("[data-bill-scan-select]"));
}

function toggleBillScanNewFields(select) {
  const modal = select?.closest(".modal-backdrop");
  const showNewFields = !select || select.value === "__new__";
  modal?.querySelectorAll(".bill-scan-new-field").forEach((field) => {
    field.classList.toggle("hidden", !showNewFields);
  });
}

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("This bill document could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("This bill image could not be read."));
    reader.readAsDataURL(file);
  });
}

function cloneArrayBuffer(buffer) {
  if (buffer?.slice) return buffer.slice(0);
  return new Uint8Array(buffer || []).slice().buffer;
}

async function loadPdfTextLibrary() {
  if (window.pdfjsLib?.getDocument) return window.pdfjsLib;
  if (window.__fitPdfTextLoadPromise) return window.__fitPdfTextLoadPromise;
  window.__fitPdfTextLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.pdfjsLib?.getDocument) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      } else {
        reject(new Error("The PDF document reader could not start."));
      }
    };
    script.onerror = () => reject(new Error("The PDF document reader could not load."));
    document.head.appendChild(script);
  });
  return window.__fitPdfTextLoadPromise;
}

async function loadTesseractOcrLibrary() {
  if (window.Tesseract?.createWorker) return window.Tesseract;
  if (window.__fitTesseractLoadPromise) return window.__fitTesseractLoadPromise;
  window.__fitTesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (window.Tesseract?.createWorker) {
        resolve(window.Tesseract);
      } else {
        reject(new Error("The OCR backup reader could not start."));
      }
    };
    script.onerror = () => reject(new Error("The OCR backup reader could not load."));
    document.head.appendChild(script);
  });
  return window.__fitTesseractLoadPromise;
}

function normalizeBillDocumentText(text = "") {
  return String(text || "")
    .replace(/[|]+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function billDocumentWordSet(value = "") {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}

function scoreBillDocumentMatch(text, bill) {
  const sourceWords = billDocumentWordSet(text);
  const billWords = billDocumentWordSet(bill.name);
  if (!sourceWords.size || !billWords.size) return 0;
  const overlap = [...billWords].filter((word) => sourceWords.has(word)).length;
  const exactBonus = normalizeBillDocumentText(text).toLowerCase().includes(normalizeBillDocumentText(bill.name).toLowerCase()) ? 0.35 : 0;
  return Math.min(1, overlap / billWords.size + exactBonus);
}

function bestBillDocumentMatch(text, bills = []) {
  return bills.reduce(
    (best, bill) => {
      const confidence = scoreBillDocumentMatch(text, bill);
      return confidence > best.confidence ? { id: bill.id, name: bill.name, confidence } : best;
    },
    { id: "", name: "", confidence: 0 },
  );
}

function parseBillDocumentDateValue(rawDate) {
  const cleaned = normalizeBillDocumentText(rawDate).replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  if (!cleaned) return "";
  const numeric = cleaned.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  let parsed;
  if (numeric) {
    const currentYear = new Date().getFullYear();
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const rawYear = numeric[3] ? Number(numeric[3]) : currentYear;
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    parsed = new Date(year, month, day, 12, 0, 0, 0);
    if (!numeric[3] && parsed < new Date(`${todayValue()}T00:00:00`)) {
      parsed = new Date(currentYear + 1, month, day, 12, 0, 0, 0);
    }
  } else {
    parsed = new Date(cleaned);
  }
  if (!parsed || Number.isNaN(parsed.getTime())) return "";
  const today = new Date(`${todayValue()}T00:00:00`);
  const earliest = addDays(today, -14);
  const latest = addDays(today, 370);
  if (parsed < earliest || parsed > latest) return "";
  return dateValueFromLocal(parsed);
}

function extractBillDocumentDueDate(text) {
  const candidates = [];
  const context = "(?:due date|date due|payment due date|payment due|due by|pay by|must pay by|autopay date|scheduled payment date)";
  const monthDate = "((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{2,4})?)";
  const numericDate = "(\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)";
  const contextualMonthPattern = new RegExp(`\\b${context}\\D{0,45}${monthDate}`, "gi");
  const contextualNumericPattern = new RegExp(`\\b${context}\\D{0,45}${numericDate}`, "gi");
  const monthPattern = new RegExp(`\\b${monthDate}`, "gi");
  const numericPattern = new RegExp(`\\b${numericDate}\\b`, "gi");
  let match;
  while ((match = contextualMonthPattern.exec(text))) {
    candidates.push({ raw: match[1], score: 5 });
  }
  while ((match = contextualNumericPattern.exec(text))) {
    candidates.push({ raw: match[1], score: 5 });
  }
  while ((match = monthPattern.exec(text))) {
    candidates.push({ raw: match[1], score: 1 });
  }
  while ((match = numericPattern.exec(text))) {
    candidates.push({ raw: match[1], score: 1 });
  }
  return candidates
    .map((candidate) => ({ ...candidate, value: parseBillDocumentDateValue(candidate.raw) }))
    .filter((candidate) => candidate.value)
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))[0]?.value || "";
}

function extractBillDocumentAmountDue(text) {
  const candidates = [];
  const amountValue = "(\\$?\\s*\\d{1,3}(?:,\\d{3})*(?:\\.\\d{2})?|\\$?\\s*\\d+(?:\\.\\d{2})?)";
  const strongestContext = "(?:amount due|total amount due|current amount due|payment amount due|please pay|total due|balance due)";
  const weakerContext = "(?:new charges|current charges|total new charges|auto pay amount|automatic payment amount|minimum payment due|payment due)";
  const strongestAfterPattern = new RegExp(`\\b${strongestContext}\\D{0,55}${amountValue}`, "gi");
  const strongestBeforePattern = new RegExp(`${amountValue}\\D{0,45}\\b${strongestContext}`, "gi");
  const weakerAfterPattern = new RegExp(`\\b${weakerContext}\\D{0,55}${amountValue}`, "gi");
  const moneyPattern = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;
  let match;
  while ((match = strongestAfterPattern.exec(text))) {
    candidates.push({ value: currencyValue(match[1]), score: 6 });
  }
  while ((match = strongestBeforePattern.exec(text))) {
    candidates.push({ value: currencyValue(match[1]), score: 5 });
  }
  while ((match = weakerAfterPattern.exec(text))) {
    candidates.push({ value: currencyValue(match[1]), score: 3 });
  }
  while ((match = moneyPattern.exec(text))) {
    candidates.push({ value: currencyValue(match[1]), score: 1 });
  }
  return candidates
    .filter((candidate) => candidate.value > 0 && candidate.value < 100000)
    .sort((a, b) => b.score - a.score || b.value - a.value)[0]?.value.toFixed(2) || "";
}

function extractBillDocumentVendorName(text, bills = [], fileName = "") {
  const bestMatch = bestBillDocumentMatch(text, bills);
  if (bestMatch.confidence >= 0.35) return bestMatch.name;
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => normalizeBillDocumentText(line))
    .filter((line) => line && !/amount|total|due|balance|account|statement|payment|\$|\d{1,2}[/-]\d{1,2}/i.test(line));
  return lines[0]?.slice(0, 80) || fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 80);
}

function analyzeBillDocumentText(text, file, bills = [], options = {}) {
  const normalizedText = normalizeBillDocumentText(text);
  const match = bestBillDocumentMatch(normalizedText, bills);
  const amountDue = extractBillDocumentAmountDue(normalizedText);
  const dueDate = extractBillDocumentDueDate(normalizedText);
  const confidence = Math.min(
    1,
    (match.confidence || 0) * 0.5 + (amountDue ? 0.25 : 0) + (dueDate ? 0.2 : 0) + (normalizedText ? 0.05 : 0),
  );
  return {
    vendorName: extractBillDocumentVendorName(text, bills, file.name),
    amountDue,
    dueDate,
    matchedBillId: match.confidence >= 0.35 ? match.id : "",
    confidence,
    notes: options.notes || (
      normalizedText
        ? "F.I.T. read this bill and found a suggested update. Review the amount and due date before saving."
        : "F.I.T. could not find readable bill text. Enter the new amount and due date manually."
    ),
    scannedAt: new Date().toISOString(),
    scanMethod: options.scanMethod || "document_text",
  };
}

function billScanHasSuggestion(scan = {}) {
  return Boolean(scan.matchedBillId || scan.amountDue || scan.dueDate || normalizeBillDocumentText(scan.vendorName));
}

function billScanNeedsOcrBackup(scan = {}) {
  return !scan.amountDue || !scan.dueDate || !scan.matchedBillId || Number(scan.confidence || 0) < 0.75;
}

function combineBillDocumentScans(primaryScan, backupScan) {
  if (!primaryScan || !billScanHasSuggestion(primaryScan)) return backupScan || primaryScan;
  if (!backupScan || !billScanHasSuggestion(backupScan)) return primaryScan;

  const matchSource =
    backupScan.matchedBillId && Number(backupScan.confidence || 0) > Number(primaryScan.confidence || 0)
      ? backupScan
      : primaryScan;
  const amountSource = primaryScan.amountDue ? primaryScan : backupScan;
  const dueDateSource = primaryScan.dueDate ? primaryScan : backupScan;
  const vendorSource =
    matchSource.vendorName || primaryScan.vendorName ? matchSource : backupScan.vendorName ? backupScan : primaryScan;
  const fieldBoost =
    (primaryScan.amountDue && backupScan.amountDue ? 0.03 : 0) +
    (primaryScan.dueDate && backupScan.dueDate ? 0.03 : 0) +
    (primaryScan.matchedBillId && backupScan.matchedBillId ? 0.04 : 0);

  return {
    ...primaryScan,
    vendorName: vendorSource.vendorName || primaryScan.vendorName || backupScan.vendorName || "",
    amountDue: amountSource.amountDue || backupScan.amountDue || "",
    dueDate: dueDateSource.dueDate || backupScan.dueDate || "",
    matchedBillId: matchSource.matchedBillId || primaryScan.matchedBillId || backupScan.matchedBillId || "",
    confidence: Math.min(1, Math.max(Number(primaryScan.confidence || 0), Number(backupScan.confidence || 0)) + fieldBoost),
    notes: "F.I.T. compared PDF text with OCR backup and combined the strongest suggestion. Review the bill, amount, and date before saving.",
    scanMethod: `${primaryScan.scanMethod || "pdf_text"}+${backupScan.scanMethod || "ocr_backup"}`,
    sourceSuggestions: [primaryScan, backupScan].map((scan) => ({
      scanMethod: scan.scanMethod || "",
      vendorName: scan.vendorName || "",
      amountDue: scan.amountDue || "",
      dueDate: scan.dueDate || "",
      matchedBillId: scan.matchedBillId || "",
      confidence: Number(scan.confidence || 0),
    })),
  };
}

async function extractPdfBillDocumentText(file, data) {
  const pdfjsLib = await loadPdfTextLibrary();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneArrayBuffer(data)) });
  const pdf = await loadingTask.promise;
  const pageLimit = Math.min(pdf.numPages || 0, 12);
  const lines = [];
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    showPageLoading(`Reading PDF page ${pageNumber} of ${pageLimit}...`);
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = (content.items || [])
      .map((item) => String(item.str || "").trim())
      .filter(Boolean)
      .join(" ");
    if (pageText) lines.push(pageText);
  }
  const text = lines.join("\n");
  if (!normalizeBillDocumentText(text)) {
    throw new Error("This PDF does not contain selectable bill text. Upload the original PDF bill or enter the amount and due date manually.");
  }
  return text;
}

async function renderPdfBillPagesForOcr(file, data) {
  const pdfjsLib = await loadPdfTextLibrary();
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(cloneArrayBuffer(data)) });
  const pdf = await loadingTask.promise;
  const pageLimit = Math.min(pdf.numPages || 0, 2);
  const images = [];
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    showPageLoading(`Preparing OCR backup page ${pageNumber} of ${pageLimit}...`);
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, Math.max(1.4, 1500 / Math.max(baseViewport.width, 1)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    images.push(canvas.toDataURL("image/png"));
  }
  if (!images.length) throw new Error("This PDF could not be prepared for OCR backup.");
  return images;
}

async function readBillTextWithOcr(imageDataUrls, label = "bill") {
  const urls = Array.isArray(imageDataUrls) ? imageDataUrls : [imageDataUrls];
  const Tesseract = await loadTesseractOcrLibrary();
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: (message) => {
      if (message?.status === "recognizing text" && Number.isFinite(message.progress)) {
        showPageLoading(`Reading ${label} with OCR... ${Math.round(message.progress * 100)}%`);
      }
    },
  });
  try {
    const texts = [];
    for (let index = 0; index < urls.length; index += 1) {
      if (urls.length > 1) showPageLoading(`Reading ${label} OCR page ${index + 1} of ${urls.length}...`);
      const result = await worker.recognize(urls[index]);
      texts.push(result?.data?.text || "");
    }
    return texts.join("\n");
  } finally {
    await worker.terminate();
  }
}

async function runBrowserBillOcr(imageDataUrls, file, bills = [], scanMethod = "ocr_backup") {
  const text = await readBillTextWithOcr(imageDataUrls, file.name || "bill");
  return analyzeBillDocumentText(text, file, bills, {
    scanMethod,
    notes: text
      ? "OCR backup found a suggested bill update. Review the amount and due date before saving."
      : "OCR backup could not find clear bill text. Enter the new amount and due date manually.",
  });
}

async function analyzeBillDocumentFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  const isImage = ["image/png", "image/jpeg", "image/webp"].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || "");
  if (!isPdf && !isImage) throw new Error("Choose a bill PDF, PNG, JPG, or WebP file.");
  if (isPdf && file.size > 10 * 1024 * 1024) throw new Error("Bill PDFs must be 10 MB or smaller.");
  if (isImage && file.size > 5 * 1024 * 1024) throw new Error("Bill images must be 5 MB or smaller.");

  const account = currentAccount();
  const bills = billScanSourceBills(account);
  const uploadMeta = {
    name: file.name,
    type: file.type,
    size: file.size,
    scanMethod: isPdf ? "pdf_text" : "image_ocr",
  };
  try {
    if (isImage) {
      const imageDataUrl = await imageFileToDataUrl(file);
      const scan = await runBrowserBillOcr(imageDataUrl, file, bills, "image_ocr");
      return { uploadMeta: { ...uploadMeta, scanMethod: scan.scanMethod }, scan };
    }

    const data = await fileToArrayBuffer(file);
    let pdfTextScan = null;
    let ocrScan = null;
    try {
      const text = await extractPdfBillDocumentText(file, data);
      pdfTextScan = analyzeBillDocumentText(text, file, bills, {
        scanMethod: "pdf_text",
        notes: "F.I.T. read selectable PDF text from this bill. Review the amount and due date before saving.",
      });
    } catch (textError) {
      pdfTextScan = {
        vendorName: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
        amountDue: "",
        dueDate: "",
        matchedBillId: "",
        confidence: 0,
        notes: `${textError?.message || "PDF text could not be read."} Trying OCR backup where possible.`,
        scannedAt: new Date().toISOString(),
        scanMethod: "pdf_text_unreadable",
      };
    }

    if (billScanNeedsOcrBackup(pdfTextScan)) {
      try {
        const pdfImages = await renderPdfBillPagesForOcr(file, data);
        ocrScan = await runBrowserBillOcr(pdfImages, file, bills, "pdf_ocr_backup");
      } catch (ocrError) {
        if (!billScanHasSuggestion(pdfTextScan)) {
          pdfTextScan.notes = `${pdfTextScan.notes || "PDF text was not enough."} OCR backup also could not read this bill. Enter the new amount and due date manually.`;
        }
      }
    }

    const scan = combineBillDocumentScans(pdfTextScan, ocrScan) || pdfTextScan;
    uploadMeta.scanMethod = scan.scanMethod || uploadMeta.scanMethod;
    return { uploadMeta, scan };
  } catch (error) {
    return {
      uploadMeta,
      scan: {
        vendorName: file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
        amountDue: "",
        dueDate: "",
        matchedBillId: "",
        confidence: 0,
        notes: error?.message
          ? `${error.message} Enter the new amount and due date manually.`
          : "The bill document could not be read. Enter the new amount and due date manually.",
        scannedAt: new Date().toISOString(),
        scanMethod: "manual_entry",
      },
    };
  }
}

async function applyBillScanUpdate(formElement) {
  const account = currentAccount();
  ensureFinancialInventory(account);
  const data = new FormData(formElement);
  const amountDue = currencyValue(data.get("amountDue"));
  const dueDate = String(data.get("dueDate") || "").trim();
  if (!amountDue || !dueDate) {
    showToast("Confirm a payment amount and due date before saving.");
    return false;
  }

  let bill;
  const selectedBillId = String(data.get("billId") || "");
  if (selectedBillId === "__new__" || !selectedBillId) {
    const name = String(data.get("newBillName") || pendingBillScanUpload?.scan?.vendorName || "").trim();
    if (!name) {
      showToast("Enter a bill name before saving.");
      return false;
    }
    bill = {
      ...blankRecurringBill(String(data.get("newBillCategory") || "other")),
      name,
    };
    account.financialInventory.recurringBills.unshift(bill);
  } else {
    bill = account.financialInventory.recurringBills.find((item) => item.id === selectedBillId);
  }
  if (!bill) {
    showToast("Choose a saved bill before updating.");
    return false;
  }

  const previousAmount = bill.amount || "";
  const previousDueDate = bill.nextDueDate || "";
  bill.amount = amountDue.toFixed(2);
  bill.nextDueDate = dueDate;
  bill.paidDueDate = "";
  bill.billScanHistory ||= [];
  bill.billScanHistory.unshift({
    id: uid("bill-scan"),
    vendorName: pendingBillScanUpload?.scan?.vendorName || bill.name,
    amountDue: bill.amount,
    dueDate,
    previousAmount,
    previousDueDate,
    confidence: Number(pendingBillScanUpload?.scan?.confidence) || 0,
    scanMethod: pendingBillScanUpload?.scan?.scanMethod || pendingBillScanUpload?.uploadMeta?.scanMethod || "",
    notes: pendingBillScanUpload?.scan?.notes || "",
    fileName: pendingBillScanUpload?.uploadMeta?.name || "",
    storagePath: pendingBillScanUpload?.uploadMeta?.storagePath || "",
    scannedAt: pendingBillScanUpload?.scan?.scannedAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
  });
  bill.billScanHistory = bill.billScanHistory.slice(0, 10);
  bill.lastBillScan = bill.billScanHistory[0];

  saveFinancialProfileMutation(account);
  await productionBackend.saveNow?.(appState);
  pendingBillScanUpload = null;
  showToast(`${bill.name} updated with the new amount and due date.`);
  return true;
}

function creditCardProfileCard(card, index) {
  migratePromoCard(card);
  const purchasePromo = card.promoType === "purchases" || card.promoType === "both";
  const balancePromo = card.promoType === "balance_transfers" || card.promoType === "both";
  const hasPromo = card.promoType && card.promoType !== "none";
  return `
    <article class="profile-inventory-card">
      <div class="profile-inventory-grid">
        ${textField("Card / account", `financialInventory.creditCards.${index}.account`, card.account, false, "Account name")}
        ${moneyField("Total balance", `financialInventory.creditCards.${index}.totalBalance`, card.totalBalance, false)}
        ${moneyField("Last statement balance", `financialInventory.creditCards.${index}.lastStatementBalance`, card.lastStatementBalance, false)}
        ${moneyField("Payment due", `financialInventory.creditCards.${index}.paymentDue`, card.paymentDue, false)}
        ${moneyField("Credit card allowance", `financialInventory.creditCards.${index}.allowance`, card.allowance, false)}
        ${dateField("Due date", `financialInventory.creditCards.${index}.dueDate`, card.dueDate, false)}
        ${hasPromo ? "" : percentField("Annual APR", `financialInventory.creditCards.${index}.apr`, card.apr, false)}
      </div>
      <div class="field promo-type-field">
        <label>Promotional APR</label>
        <select class="input" data-profile-promo-type="${index}">
          ${selectOption("none", "No promotional APR", card.promoType)}
          ${selectOption("purchases", "Promotional APR on purchases", card.promoType)}
          ${selectOption("balance_transfers", "Promotional APR on balance transfers", card.promoType)}
          ${selectOption("both", "Promotional APR on both", card.promoType)}
        </select>
      </div>
      ${
        purchasePromo
          ? `<div class="promo-fields"><div class="promo-heading">Purchase promotion</div>
              ${profilePercentField("Promotional purchase APR", `financialInventory.creditCards.${index}.purchasePromoRate`, card.purchasePromoRate)}
              ${profileFutureDateField("Purchase promotion expiration", `financialInventory.creditCards.${index}.purchasePromoExpiration`, card.purchasePromoExpiration)}
            </div>`
          : ""
      }
      ${
        balancePromo
          ? `<div class="promo-fields"><div class="promo-heading">Balance transfer promotion</div>
              ${profilePercentField("Promotional balance transfer APR", `financialInventory.creditCards.${index}.balanceTransferPromoRate`, card.balanceTransferPromoRate)}
              ${profileFutureDateField("Balance transfer promotion expiration", `financialInventory.creditCards.${index}.balanceTransferPromoExpiration`, card.balanceTransferPromoExpiration)}
            </div>`
          : ""
      }
      <button class="icon-btn danger profile-remove" type="button" aria-label="Remove credit card" title="Remove credit card" data-remove-profile-item="creditCards.${index}">×</button>
    </article>
  `.replaceAll("data-path=", "data-profile-path=");
}

function mortgageProfileSection(account) {
  const mortgage = account.financialInventory.mortgage;
  const housingType = account.financialInventory.housingPaymentType === "rent" ? "rent" : "mortgage";
  const housingLabel = housingType === "rent" ? "Rent" : "Mortgage";
  const total = Number(mortgage.totalAmount) || 0;
  const current = Number(mortgage.currentBalance) || 0;
  const progress = total ? Math.min(100, Math.max(0, ((total - current) / total) * 100)) : 0;
  return `
    <section class="panel profile-inventory" id="profile-housing">
      <div class="panel-heading housing-profile-heading"><div><h3>${housingLabel}</h3><p>${housingType === "rent" ? "Your worksheets use rent-based housing planning." : "Track your mortgage balance and payoff progress."}</p></div></div>
      <div class="panel-body">
        ${housingType === "rent" ? `<p class="quiet-message">Mortgage details are preserved but hidden and excluded from worksheets.</p>` : ""}
        <div class="${housingType === "rent" ? "hidden" : ""}">
        <div class="profile-inventory-grid">
          ${moneyField("Total mortgage amount", "financialInventory.mortgage.totalAmount", mortgage.totalAmount, false)}
          ${percentField("Mortgage interest rate", "financialInventory.mortgage.interestRate", mortgage.interestRate, false)}
          ${moneyField("Current mortgage balance", "financialInventory.mortgage.currentBalance", mortgage.currentBalance, false)}
          ${moneyField("Monthly mortgage payment", "financialInventory.mortgage.paymentAmount", mortgage.paymentAmount, false)}
          ${dateField("Next mortgage due date", "financialInventory.mortgage.nextDueDate", mortgage.nextDueDate, false)}
        </div>
        <div class="savings-progress-block"><div class="savings-progress-copy"><strong>${money(Math.max(0, total - current))} paid</strong><span>${money(current)} remaining</span></div>${progressBar(progress, `${Math.round(progress)}% paid`)}</div>
        </div>
      </div>
    </section>
  `.replaceAll("data-path=", "data-profile-path=");
}

function studentLoanProfileCard(loan, index) {
  return `
    <article class="profile-inventory-card">
      <div class="profile-inventory-grid">
        ${textField("Loan name", `financialInventory.studentLoans.${index}.account`, loan.account, false, "Student loan name")}
        ${studentLoanTypeField(`financialInventory.studentLoans.${index}.loanType`, loan.loanType, false, true)}
        ${moneyField("Balance", `financialInventory.studentLoans.${index}.totalOwed`, loan.totalOwed, false)}
        ${percentField("Interest rate", `financialInventory.studentLoans.${index}.apr`, loan.apr, false)}
        ${moneyField("Payment due", `financialInventory.studentLoans.${index}.paymentDue`, loan.paymentDue, false)}
        ${dateField("Due date", `financialInventory.studentLoans.${index}.dueDate`, loan.dueDate, false)}
      </div>
      <button class="icon-btn danger profile-remove" type="button" aria-label="Remove student loan" title="Remove student loan" data-remove-profile-item="studentLoans.${index}">×</button>
    </article>
  `.replaceAll("data-path=", "data-profile-path=");
}

function dueDayOptions(selected) {
  const suffix = (day) => {
    if ([11, 12, 13].includes(day)) return "th";
    if (day % 10 === 1) return "st";
    if (day % 10 === 2) return "nd";
    if (day % 10 === 3) return "rd";
    return "th";
  };
  return [
    selectOption("", "Select due day", selected),
    ...Array.from({ length: 31 }, (_, index) => {
      const day = index + 1;
      return selectOption(String(day), `The ${day}${suffix(day)} of each month`, selected);
    }),
    selectOption("last", "The last day of each month", selected),
  ].join("");
}

function dueDayLabel(dueDay) {
  if (dueDay === "last") return "Last day of each month";
  const day = Number(dueDay);
  if (!day) return "Monthly schedule";
  const suffix = [11, 12, 13].includes(day) ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix} of each month`;
}

function profilePercentField(label, path, value) {
  return `<div class="field"><label>${label}</label><div class="percent-input-wrap"><input class="input" type="text" inputmode="decimal" data-profile-path="${path}" data-percent-validation value="${value}" placeholder="0.00"></div></div>`;
}

function profileFutureDateField(label, path, value) {
  return `<div class="field"><label>${label}</label><input class="input" type="date" min="${todayValue()}" data-profile-path="${path}" data-future-date-validation value="${value || ""}"></div>`;
}

function studentLoanTypeField(path, value, readOnly, profile = false) {
  const attribute = profile ? "data-profile-path" : "data-path";
  return `<div class="field"><label>Student loan type</label><select class="input" ${attribute}="${path}" ${readOnly ? "disabled" : ""}>
    ${selectOption("", "Select loan type", value)}
    ${selectOption("federal_subsidized", "Federal Direct Subsidized", value)}
    ${selectOption("federal_unsubsidized", "Federal Direct Unsubsidized", value)}
    ${selectOption("federal_plus", "Federal PLUS", value)}
    ${selectOption("federal_perkins", "Federal Perkins", value)}
    ${selectOption("private", "Private student loan", value)}
    ${selectOption("consolidation", "Consolidation loan", value)}
    ${selectOption("refinanced", "Refinanced student loan", value)}
    ${selectOption("other", "Other", value)}
  </select></div>`;
}

function debtProfileCard(debt, index) {
  return `
    <article class="profile-inventory-card">
      <div class="profile-inventory-grid">
        ${textField("Debt / account", `financialInventory.debts.${index}.account`, debt.account, false, "Account name")}
        ${moneyField("Current balance", `financialInventory.debts.${index}.totalOwed`, debt.totalOwed, false)}
        ${moneyField("Minimum payment", `financialInventory.debts.${index}.minimumPayment`, debt.minimumPayment, false)}
        ${dateField("Due date", `financialInventory.debts.${index}.dueDate`, debt.dueDate, false)}
        ${debt.promotionalRateApplied ? "" : percentField("Annual APR", `financialInventory.debts.${index}.apr`, debt.apr, false)}
      </div>
      <label class="check-control">
        <input type="checkbox" data-profile-promo-toggle="debts.${index}" ${debt.promotionalRateApplied ? "checked" : ""}>
        <span>Promotional rate applied</span>
      </label>
      ${
        debt.promotionalRateApplied
          ? `<div class="promo-fields">
              ${percentField("Promotional APR", `financialInventory.debts.${index}.promotionalRate`, debt.promotionalRate, false)}
              ${dateField("Promotion expiration date", `financialInventory.debts.${index}.promotionExpiration`, debt.promotionExpiration, false)}
            </div>`
          : ""
      }
      ${textField("Notes", `financialInventory.debts.${index}.notes`, debt.notes, false, "Optional note")}
      <button class="icon-btn danger profile-remove" type="button" aria-label="Remove debt" title="Remove debt" data-remove-profile-item="debts.${index}">×</button>
    </article>
  `.replaceAll("data-path=", "data-profile-path=");
}

function renderCoachConnection() {
  const account = currentAccount();
  activeView = "coach-connection";

  if (account.role === "coach") {
    const requests = appState.coachRequests
      .filter((request) => request.coachEmail === account.email)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const invites = appState.coachInvites
      .filter((invite) => invite.coachEmail === account.email)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const approvedMembers = Object.values(appState.accounts).filter(
      (member) =>
        member.role === "user" &&
        member.coachEmail === account.email &&
        member.coachRequestStatus === "approved",
    );
    const content = `
      <div class="content">
        <div class="page-heading">
          <div><p class="eyebrow">Coach connections</p><h2>Manage mentees</h2><p>Invite members, review requests, and manage active connections.</p></div>
        </div>
        <section class="panel invite-panel">
          <div class="panel-heading"><div><h3>Invite a mentee</h3><p>${productionBackend.enabled ? "Sends a secure connection invitation to the member email." : "Creates a protected preview invite link for the member email."}</p></div><span class="badge">${invites.filter((item) => item.status === "pending").length} pending</span></div>
          <div class="panel-body">
            <form id="coach-invite-form" class="coach-request-form">
              <div class="field"><label for="mentee-invite-email">Mentee email address</label><input id="mentee-invite-email" class="input" name="email" type="email" required placeholder="member@example.com"></div>
              <button class="btn btn-primary" type="submit">Send secure invite</button>
            </form>
            <div class="invite-list">${invites.length ? invites.map(inviteCard).join("") : emptyInline("No invitations sent", "Invite a mentee by email to begin a connection.")}</div>
          </div>
        </section>
        <section class="request-layout">
          <div class="panel">
            <div class="panel-heading"><div><h3>Pending requests</h3><p>Accept or decline new mentees</p></div><span class="badge">${requests.filter((item) => item.status === "pending").length}</span></div>
            <div class="request-list">
              ${
                requests.filter((item) => item.status === "pending").length
                  ? requests
                      .filter((item) => item.status === "pending")
                      .map((request) => requestCard(request))
                      .join("")
                  : `<p class="quiet-message">No pending mentee requests.</p>`
              }
            </div>
          </div>
          <div class="panel">
            <div class="panel-heading"><div><h3>Current mentees</h3><p>Members connected to your coach account</p></div><span class="badge green">${approvedMembers.length}</span></div>
            <div class="request-list">
              ${
                approvedMembers.length
                  ? approvedMembers.map((member) => memberConnectionCard(member)).join("")
                  : emptyInline("No mentees assigned", "Accepted invitations and requests appear here.")
              }
            </div>
          </div>
        </section>
      </div>
    `;
    app.innerHTML = shell(content, {
      title: "Mentee requests",
      subtitle: "Manage member connections",
    });
    return;
  }

  const coach = account.coachEmail ? appState.accounts[account.coachEmail] : null;
  const connectedCoachName = coachDisplayName(account, coach);
  const coachAvatar = avatarMarkup(
    coach ? { ...coach, name: connectedCoachName } : connectedCoachName,
  );
  const invites = appState.coachInvites.filter(
    (invite) => invite.memberEmail === account.email && invite.status === "pending",
  );
  const content = `
    <div class="content">
      <div class="page-heading">
        <div><h2>My financial coach</h2><p>Designate the coach who will receive and review your worksheets.</p></div>
      </div>
      <section class="connection-panel">
        ${
          invites.length
            ? `<div class="member-invites"><p class="eyebrow">Coach invitations</p>${invites.map(memberInviteCard).join("")}</div>`
            : ""
        }
        ${
          account.coachEmail && account.coachRequestStatus === "approved"
            ? `<div class="connection-current">
                ${coachAvatar}
                <div><p class="eyebrow">Connected coach</p><h3>${escapeHtml(connectedCoachName)}</h3><p>${escapeHtml(account.coachEmail)}</p>${activityBadge(coach)}</div>
                <span class="badge green">Approved</span>
              </div>`
            : account.coachEmail
              ? `<div class="connection-current">
                  ${coachAvatar}
                  <div><p class="eyebrow">Coach request</p><h3>${escapeHtml(coachDisplayName(account, coach, "Pending coach"))}</h3><p>${escapeHtml(account.coachEmail)}</p></div>
                  <span class="badge">${escapeHtml(account.coachRequestStatus || "pending")}</span>
                </div>`
              : `<div class="empty-connection"><h3>No coach designated</h3><p>Enter your coach's account email to send a connection request.</p></div>`
        }
        <form id="coach-request-form" class="coach-request-form">
          <div class="field">
            <label for="designated-coach-email">Coach email address</label>
            <input id="designated-coach-email" name="email" type="email" required placeholder="coach@example.com">
          </div>
          <button class="btn btn-primary" type="submit">Send coach request</button>
        </form>
      </section>
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "My financial coach",
    subtitle: "Choose who reviews your financial worksheets",
  });
}

function requestCard(request) {
  const member = appState.accounts[request.memberEmail] || {
    name: request.memberEmail,
    email: request.memberEmail,
  };
  return `
    <article class="request-card">
      <div class="person-row">${avatarMarkup(member)}<div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.email)}</span></div></div>
      <div class="button-row">
        <button class="btn btn-primary btn-small" type="button" data-coach-request-action="approved" data-request-id="${request.id}">Accept</button>
        <button class="btn btn-danger btn-small" type="button" data-coach-request-action="declined" data-request-id="${request.id}">Decline</button>
      </div>
    </article>
  `;
}

function memberConnectionCard(member) {
  return `
    <article class="request-card">
      <div class="person-row">${avatarMarkup(member)}<div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.email)}</span>${activityBadge(member)}</div></div>
      <div class="button-row"><span class="badge green">Connected</span><button class="btn btn-danger btn-small" type="button" data-remove-mentee="${member.email}">Remove</button></div>
    </article>
  `;
}

function inviteCard(invite) {
  return `<article class="invite-card"><div><strong>${escapeHtml(invite.memberEmail)}</strong><span>${escapeHtml(invite.status)} · Sent ${updatedLabel(invite.createdAt)}</span><code>${escapeHtml(invite.inviteUrl)}</code></div><div class="button-row"><span class="badge ${invite.status === "accepted" ? "green" : ""}">${escapeHtml(invite.status)}</span>${invite.status === "pending" ? `<button class="btn btn-danger btn-small" type="button" data-delete-coach-invite="${invite.id}">Delete request</button>` : ""}</div></article>`;
}

function memberInviteCard(invite) {
  const coach = appState.accounts[invite.coachEmail];
  const coachName = coachDisplayName({ coachEmail: invite.coachEmail }, coach);
  return `<article class="request-card"><div class="person-row">${avatarMarkup(coach ? { ...coach, name: coachName } : coachName)}<div><strong>${escapeHtml(coachName)}</strong><span>Invited you to connect as a mentee</span></div></div><div class="button-row"><button class="btn btn-primary btn-small" type="button" data-invite-action="accepted" data-invite-id="${invite.id}">Accept</button><button class="btn btn-danger btn-small" type="button" data-invite-action="declined" data-invite-id="${invite.id}">Decline</button></div></article>`;
}

function renderAbout() {
  activeView = "about";
  const content = `
    <div class="content about-page">
      <section class="about-hero">
        <img class="about-hero-logo" src="assets/fit-logo-exact-transparent.png" alt="Financial Integrity Training" />
        <div>
          <p class="eyebrow">The FIT story</p>
          <h2>Financial wisdom made practical, personal, and shareable.</h2>
          <p>Financial Integrity Training equips members to bring discipline and clarity to each paycheck through a repeatable model of planning, accountability, and steady progress.</p>
        </div>
      </section>
      <section class="about-origin">
        <img src="assets/god-cannot-lie-logo.png" alt="God Cannot Lie Ministries" />
        <div>
          <p class="eyebrow">Founded in ministry</p>
          <h3>F.I.T. was created by Pastor A. Griffith of God Cannot Lie Ministries</h3>
          <p>Pastor A. Griffith created Financial Integrity Training as a practical stewardship program for the members of God Cannot Lie Ministries. His model translated financial wisdom into a clear worksheet, helping members understand their income, plan each bill, address debt, build savings, and move forward with accountability.</p>
          <p>F.I.T. is built to help individuals and families use creative financial strategies to advance financially while keeping biblical priorities in order, including honoring God through tithing first.</p>
          <p>Inspired by the impact of Pastor A. Griffith's financial wisdom, this financial training interface was later developed to carry his original model into an accessible digital experience. Members can preserve their financial history, prepare new plans, and securely share progress with a trusted financial coach.</p>
        </div>
      </section>
      <section class="about-model">
        <p class="eyebrow">The model</p>
        <h3>From teaching to an ongoing practice</h3>
        <div class="story-steps">
          <article class="story-step">
            <span>01</span>
            <h4>Wisdom</h4>
            <p>Financial principles are taught in a way that connects stewardship to everyday choices.</p>
          </article>
          <article class="story-step">
            <span>02</span>
            <h4>Structure</h4>
            <p>The FIT worksheet turns those principles into a consistent paycheck-by-paycheck plan.</p>
          </article>
          <article class="story-step">
            <span>03</span>
            <h4>Accountability</h4>
            <p>The digital portal keeps each plan accessible and allows members to share progress with their coach.</p>
          </article>
        </div>
      </section>
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "About Financial Integrity Training",
    subtitle: "The ministry foundation and model behind the portal",
  });
}

function communityFooter() {
  return `
    <footer class="community-footer">
      <div><strong>Your information is protected</strong><span>Financial records are saved securely and shared only with your approved coach.</span></div>
      <div class="footer-links">
        <button class="footer-privacy-link" type="button" data-view="settings">Privacy &amp; Security</button>
        <a class="btn btn-secondary btn-small" href="https://www.facebook.com/share/1D3VquSEb6/?mibextid=wwXIfr" target="_blank" rel="noopener noreferrer">Visit Our Church Facebook Page ↗</a>
      </div>
    </footer>
  `;
}

function renderSettings() {
  const account = currentAccount();
  activeView = "settings";
  const content = `
    <div class="content settings-page">
      <div class="page-heading"><div><p class="eyebrow">Interface settings</p><h2>Make F.I.T. feel right for you</h2><p>Choose the appearance that works best for you.</p></div></div>
      <section class="panel settings-control-panel">
        <div class="panel-heading"><div><h3>Preferences</h3><p>Manage how your account looks and handles housing information.</p></div></div>
        <div class="settings-control-list">
          <div class="settings-control-row">
            <div><strong>Appearance</strong><span>Your theme choice is saved to this account.</span></div>
            <div class="settings-segmented-control theme-grid" role="group" aria-label="Appearance">
              <button class="theme-choice ${account.preferences.theme === "light" ? "active" : ""}" type="button" data-theme-choice="light"><strong>Light</strong></button>
              <button class="theme-choice ${account.preferences.theme === "dark" ? "active" : ""}" type="button" data-theme-choice="dark"><strong>Dark</strong></button>
            </div>
          </div>
          <div class="settings-control-row">
            <div><strong>Housing</strong><span>Controls the housing details used in your profile and worksheets.</span></div>
            <div class="asset-type-choice settings-housing-choice settings-segmented-control" role="group" aria-label="Housing format">
              <button class="type-choice ${account.financialInventory.housingPaymentType === "mortgage" ? "active" : ""}" type="button" data-settings-housing-type="mortgage">Mortgage</button>
              <button class="type-choice ${account.financialInventory.housingPaymentType === "rent" ? "active" : ""}" type="button" data-settings-housing-type="rent">Rent</button>
            </div>
          </div>
          <div class="settings-control-row settings-notification-row">
            <div><strong>Notifications</strong><span>Choose general update categories. Notices are sent by email and to saved phone numbers when available.</span></div>
            <div class="settings-check-list" aria-label="Notification preferences">
              <label class="check-control"><input type="checkbox" data-notification-pref="milestones" ${account.preferences.notifications.milestones ? "checked" : ""}><span>Milestones</span></label>
              <label class="check-control"><input type="checkbox" data-notification-pref="documents" ${account.preferences.notifications.documents ? "checked" : ""}><span>Documents</span></label>
              <label class="check-control"><input type="checkbox" data-notification-pref="sessions" ${account.preferences.notifications.sessions ? "checked" : ""}><span>Sessions</span></label>
            </div>
          </div>
          <div class="settings-control-row">
            <div><strong>Bill reminders</strong><span>Email reminders ${billReminderDaysLabel(account.preferences.billReminderDaysAhead)} before saved bill due dates.</span></div>
            <div class="settings-segmented-control settings-reminder-days" role="group" aria-label="Bill reminder days before due date">
              ${billReminderDayButtons(account)}
            </div>
          </div>
        </div>
      </section>
      <section class="panel danger-zone">
        <div class="panel-heading"><div><h3>Delete account</h3><p>Permanently remove your account and saved information.</p></div></div>
        <div class="panel-body danger-zone-body"><p>For your protection, we will email a confirmation link to <strong>${escapeHtml(account.email)}</strong>. Nothing is deleted until you open that link.${productionBackend.config?.accountDeletionEnabled ? "" : " This option is not available yet."}</p><button class="btn btn-danger" type="button" data-request-account-deletion ${productionBackend.config?.accountDeletionEnabled ? "" : "disabled"}>Start account deletion</button></div>
      </section>
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "Settings",
    subtitle: "Appearance and account preferences",
  });
}

function showDeleteAccountModal() {
  if (!productionBackend.config?.accountDeletionEnabled) {
    showToast("Account deletion is not available yet.");
    return;
  }
  const account = currentAccount();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
      <div class="modal-header"><div><p class="eyebrow">Account deletion</p><h3 id="delete-account-title">Delete your account?</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        <p>We will email a secure link to <strong>${escapeHtml(account.email)}</strong>. Open it to confirm deletion.</p>
        <form id="request-account-deletion-form" class="form-stack">
          <label class="check-control"><input type="checkbox" name="understood" required><span>I understand this cannot be undone.</span></label>
          <button class="btn btn-danger" type="submit">Email deletion link</button>
          <button class="btn btn-secondary" type="button" data-close-modal>Cancel</button>
        </form>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function renderSessions() {
  const account = currentAccount();
  activeView = "sessions";
  const sessions = appState.sessions
    .filter((session) =>
      account.role === "coach"
        ? session.coachEmail === account.email &&
          appState.accounts[session.memberEmail]?.coachEmail === account.email &&
          appState.accounts[session.memberEmail]?.coachRequestStatus === "approved"
        : session.memberEmail === account.email,
    )
    .sort((a, b) => new Date(b.sessionDate) - new Date(a.sessionDate));
  const activeSessions = sessions.filter((session) => !session.archivedAt);
  const archivedSessions = sessions.filter((session) => session.archivedAt);
  const content = `
    <div class="content">
      <div class="page-heading"><div><p class="eyebrow">F.I.T. session history</p><h2>Session reviews and next steps</h2><p>Coach notes stay original; the F.I.T. review appears separately as a clear summary.</p></div><span class="badge green">${sessions.length} completed</span></div>
      ${
        activeSessions.length
          ? `<section class="session-list">${activeSessions.map((session) => sessionReviewCard(session, account)).join("")}</section>`
          : emptyState("✦", archivedSessions.length ? "No current session reviews" : "No completed session reviews yet", archivedSessions.length ? "Open the archived section below to review previous F.I.T. sessions." : account.role === "coach" ? "Approve a submitted worksheet to complete a session and generate its review." : "Your completed F.I.T. sessions will appear here after coach review.", "")
      }
      ${
        archivedSessions.length
          ? `<details class="archive-details session-archive-details"><summary><span>Archived session reviews</span><strong>${archivedSessions.length}</strong></summary><section class="session-list">${archivedSessions.map((session) => sessionReviewCard(session, account)).join("")}</section></details>`
          : ""
      }
    </div>
  `;
  app.innerHTML = shell(content, {
    title: "Session reviews",
    subtitle: "AI-style summaries, coach feedback, and member responses",
  });
}

function sessionReviewCard(session, viewer) {
  const feedback = session.feedback || [];
  const canDelete =
    normalizeEmail(session.memberEmail) === normalizeEmail(viewer.email) ||
    (viewer.role === "coach" &&
      normalizeEmail(session.coachEmail) === normalizeEmail(viewer.email));
  return `
    <article class="session-review-card">
      <div class="session-review-top">
        <div><p class="document-label">Completed F.I.T. session</p><h3>${dateLabel(session.sessionDate.slice(0, 10))}</h3><p>${escapeHtml(session.coachName)} with ${escapeHtml(session.memberName)}</p></div>
        <div class="button-row"><button class="btn btn-secondary btn-small" type="button" data-print-form="${session.formId}">Open summary PDF</button><span class="badge green">${session.archivedAt ? "Archived" : "Review ready"}</span></div>
      </div>
      <section class="ai-review">
        <div class="ai-review-heading"><span>✦</span><div><strong>F.I.T. AI session review</strong><small>Generated from the worksheet, bill decisions, coach notes, and action steps.</small></div></div>
        <p>${escapeHtml(polishReviewText(session.aiSummary))}</p>
      </section>
      <div class="session-review-grid">
        ${sessionDetail("Coach feedback notes", session.coachNotes || "N/A")}
        ${sessionDetail("Action steps before next session", session.actionSteps || "Continue following the approved worksheet.")}
        ${sessionListDetail("Bills to Pay This Check", session.billsToPayThisCheck || session.billsPaid)}
        ${sessionListDetail("Future Bills / Waiting for Next Check", session.futureBills || session.billsLeft)}
        ${sessionListDetail("Rollovers", session.allocations)}
        ${sessionListDetail("Savings withdrawals", session.savingsWithdrawals)}
        ${sessionDetail("Member notes", session.memberNotes || "N/A")}
      </div>
      <section class="feedback-thread">
        <strong>Member feedback and questions</strong>
        ${feedback.length ? feedback.map((item) => `<div class="feedback-message"><span>${escapeHtml(item.authorName)} · ${updatedLabel(item.createdAt)}</span><p>${escapeHtml(item.message)}</p></div>`).join("") : `<p class="quiet-message">No feedback or questions yet.</p>`}
        ${
          viewer.role === "user"
            ? `<form class="feedback-form" data-session-feedback-form="${session.id}"><input class="input" name="message" required placeholder="Respond with feedback, a question, or confirmation"><button class="btn btn-primary btn-small" type="submit">Send response</button></form>`
            : ""
        }
      </section>
      ${
        canDelete
          ? `<div class="session-review-actions"><button class="btn btn-danger" type="button" data-delete-session-review="${session.id}">Delete session review</button></div>`
          : ""
      }
    </article>
  `;
}

function polishReviewText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .map((sentence) => {
      const cleaned = sentence.charAt(0).toUpperCase() + sentence.slice(1);
      return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
    })
    .join(" ");
}

function sessionDetail(label, value) {
  return `<div class="session-detail"><span>${escapeHtml(label)}</span><p>${escapeHtml(value)}</p></div>`;
}

function sessionListDetail(label, items = []) {
  items = Array.isArray(items) ? items : [];
  return `<div class="session-detail"><span>${escapeHtml(label)}</span>${items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p>None recorded.</p>`}</div>`;
}

function showSessionCompletionModal(formId) {
  const form = appState.forms[formId];
  const coach = currentAccount();
  if (!form || coach.role !== "coach" || appState.accounts[form.ownerEmail]?.coachEmail !== coach.email) return;
  const member = appState.accounts[form.ownerEmail];
  const notificationEmails = notificationEmailsForMember(member);
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.formId = formId;
  modal.innerHTML = `
    <section class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="session-complete-title">
      <div class="modal-header"><div><p class="document-label">Complete session</p><h3 id="session-complete-title">Approve worksheet and generate review</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        <p>Your original notes remain separate. The F.I.T. review will summarize these notes with the worksheet and bill decisions.</p>
        <form id="session-completion-form" class="form-stack">
          <div class="field"><label for="coach-session-notes">Add notes for your mentee (optional)</label><textarea id="coach-session-notes" class="input notes-area compact-notes" name="coachNotes" placeholder="Feedback, patterns noticed, and encouragement"></textarea></div>
          <div class="field"><label for="session-action-steps">Action steps before the next session (optional)</label><textarea id="session-action-steps" class="input notes-area compact-notes" name="actionSteps" placeholder="Specific next steps for the member"></textarea></div>
          <fieldset class="summary-delivery-options"><legend>Email the completed F.I.T. summary</legend>
            <div class="email-recipient-list">
              ${notificationEmails.map((email) => `<span class="badge">${escapeHtml(email)}</span>`).join("")}
            </div>
            <p>The message contains a secure sign-in link to the completed summary and printable PDF.</p>
          </fieldset>
          <button class="btn btn-gold" type="submit">Approve and complete F.I.T. session</button>
        </form>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function createSessionReview(form, coach, coachNotes, actionSteps) {
  const member = appState.accounts[form.ownerEmail];
  const paid = Object.values(form.data.bills)
    .flat()
    .filter((bill) => bill.name && bill.coachDecision === "this_check")
    .map((bill) => `${bill.name} (${money(bill.amount)})`);
  const left = Object.values(form.data.bills)
    .flat()
    .filter((bill) => bill.name && bill.coachDecision !== "this_check")
    .map((bill) => `${bill.name} (${money(bill.amount)})`);
  const calc = calculate(form);
  const allocations = (form.data.allocations || [])
    .filter((item) => item.account || Number(item.amount))
    .map((item) => `${item.account || item.type.replaceAll("_", " ")} (${money(item.amount)})`);
  const savingsWithdrawals = appState.withdrawals
    .filter((item) => item.formId === form.id)
    .map((item) => `${item.savingsAccountName || "Savings"}: ${money(item.amount)} - ${item.reason}`);
  const normalizedCoachNotes = coachNotes || "N/A";
  const normalizedActionSteps = actionSteps || "N/A";
  const memberNotes = form.data.notes || "N/A";
  const aiSummary = `${form.assignedName || member.name} completed a F.I.T. paycheck-planning session with ${coach.name}. Total income for this check was ${money(calc.totalIncome)}, including ${money(calc.additionalIncome)} in additional income. The rounded tithe was ${titheMoney(calc.tithe)}, planned before bills and rollovers. Bills to Pay This Check: ${paid.length ? paid.join("; ") : "none"}. Future Bills / Waiting for Next Check: ${left.length ? left.join("; ") : "none"}. Rollovers total ${money(calc.allocationTotal)}, leaving ${money(calc.available)} available. ${savingsWithdrawals.length ? `Savings withdrawals recorded: ${savingsWithdrawals.join("; ")}.` : "No savings withdrawals were recorded for this form."} Coach notes: ${normalizedCoachNotes}. Member notes: ${memberNotes}.`;
  return {
    id: uid("session"),
    formId: form.id,
    sessionDate: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    archivedAt: null,
    archiveReason: "",
    coachEmail: coach.email,
    coachName: coach.name,
    memberEmail: member.email,
    memberName: member.name,
    assignedName: form.assignedName || member.name,
    coachNotes: normalizedCoachNotes,
    actionSteps: normalizedActionSteps,
    billsPaid: paid,
    billsLeft: left,
    billsToPayThisCheck: paid,
    futureBills: left,
    allocations,
    savingsWithdrawals,
    memberNotes,
    aiSummary,
    feedback: [],
  };
}

function renderDashboard() {
  const account = currentAccount();
  const isCoach = account.role === "coach";
  const notifications = visibleNotifications(account);
  const unreadNotifications = notifications.filter((notification) => !notification.readAt);
  activeView = "dashboard";

  if (isCoach) {
    const sharedForms = Object.values(appState.forms)
      .filter((form) => appState.accounts[form.ownerEmail]?.coachEmail === account.email)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const reviewForms = sharedForms.filter((form) => form.status !== "approved" && !form.archivedAt);
    const approvedForms = sharedForms.filter((form) => form.status === "approved" && !form.archivedAt);
    const archivedApprovedForms = sharedForms.filter((form) => form.status === "approved" && form.archivedAt);
    const mentees = Object.values(appState.accounts).filter(
      (member) =>
        member.role === "user" &&
        member.coachEmail === account.email &&
        member.coachRequestStatus === "approved",
    );
    const withdrawals = appState.withdrawals
      .filter(
        (withdrawal) =>
          withdrawal.coachEmail === account.email &&
          appState.accounts[withdrawal.memberEmail]?.coachEmail === account.email &&
          appState.accounts[withdrawal.memberEmail]?.coachRequestStatus === "approved",
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const pendingRequests = appState.coachRequests.filter(
      (request) => request.coachEmail === account.email && request.status === "pending",
    );
    const content = `
      <div class="content">
        ${dashboardBanner(account, true)}
        <section class="metric-grid" aria-label="Coach overview">
          ${metric("Mentees", mentees.length)}
          ${metric("Documents to review", reviewForms.length)}
          ${metric("Mentee requests", pendingRequests.length)}
          ${metric("Milestone alerts", unreadNotifications.length)}
        </section>
        ${notificationCenter(account, notifications)}
        <div class="page-heading">
          <div>
            <h2>Documents to review</h2>
            <p>Select bill timing and approve finished member worksheets.</p>
          </div>
        </div>
        ${
          reviewForms.length
            ? `<section class="inbox-grid">${reviewForms.map(coachFormCard).join("")}</section>`
            : emptyState("◎", "No documents waiting for review", "New finished worksheets sent by your mentees will appear here.", "")
        }
        <section class="dashboard-band">
          <div class="page-heading"><div><h2>Mentees and savings goals</h2><p>Current savings progress for connected members.</p></div></div>
          ${mentees.length ? `<div class="inbox-grid">${mentees.map(menteeSavingsCard).join("")}</div>` : `<p class="quiet-message">No connected mentees yet.</p>`}
        </section>
        <section class="dashboard-band">
          <div class="page-heading"><div><h2>Savings withdrawals</h2><p>Withdrawal reasons sent by your mentees.</p></div></div>
          ${withdrawals.length ? `<div class="withdrawal-list">${withdrawals.map(withdrawalCard).join("")}</div>` : `<p class="quiet-message">No savings withdrawals have been submitted.</p>`}
        </section>
        <section class="dashboard-band">
          <div class="page-heading"><div><h2>Approved documents</h2><p>Previously reviewed worksheets.</p></div></div>
          ${approvedForms.length ? `<section class="inbox-grid">${approvedForms.map(coachFormCard).join("")}</section>` : `<p class="quiet-message">No approved documents yet.</p>`}
          ${
            archivedApprovedForms.length
              ? `<details class="archive-details form-archive-details"><summary><span>Archived approved documents</span><strong>${archivedApprovedForms.length}</strong></summary><section class="inbox-grid">${archivedApprovedForms.map(coachFormCard).join("")}</section></details>`
              : ""
          }
        </section>
      </div>
    `;
    app.innerHTML = shell(content);
    return;
  }

  const allForms = Object.values(appState.forms)
    .filter((form) => form.ownerEmail === account.email)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const forms = allForms.filter((form) => !form.archivedAt);
  const archivedForms = allForms.filter((form) => form.archivedAt);
  const latest = allForms[0];
  const latestCalc = latest ? calculate(latest) : null;
  const content = `
    <div class="content">
      ${dashboardBanner(account, false)}
      <section class="metric-grid" aria-label="Financial overview">
        ${metric("Saved forms", allForms.length)}
        ${metric("Latest paycheck", latestCalc ? money(latestCalc.thisCheck) : "$0")}
        ${metric("Latest total debt", money(profileDebtTotal(account)))}
        ${metric("Milestone alerts", unreadNotifications.length)}
      </section>
      ${notificationCenter(account, notifications)}
      <div class="page-heading">
        <div>
          <h2>Form history</h2>
          <p>Open an existing worksheet or start a new paycheck plan.</p>
        </div>
        <button class="btn btn-primary" type="button" data-new-form><span aria-hidden="true">＋</span> New form</button>
      </div>
      ${
        forms.length
          ? `<section class="form-grid">${forms.map(memberFormCard).join("")}</section>`
          : emptyState("▤", archivedForms.length ? "All completed worksheets are archived" : "No financial worksheets yet", archivedForms.length ? "Open the archived section below to review completed worksheets." : "Create your first form to begin planning this paycheck.", archivedForms.length ? "" : `<button class="btn btn-primary" type="button" data-new-form>New form</button>`)
      }
      ${
        archivedForms.length
          ? `<details class="archive-details form-archive-details"><summary><span>Archived completed forms</span><strong>${archivedForms.length}</strong></summary><section class="form-grid">${archivedForms.map(memberFormCard).join("")}</section></details>`
          : ""
      }
    </div>
  `;
  app.innerHTML = shell(content, {
    actions: `<button class="btn btn-primary" type="button" data-new-form><span aria-hidden="true">＋</span> New form</button>`,
  });
}

function dashboardBanner(account, isCoach) {
  return `
    <section class="fit-dashboard-banner">
      <div>
        ${isCoach ? "" : `<p class="eyebrow">F.I.T. member workspace</p>`}
        <h2>${isCoach ? "Coach with clarity. Lead with accountability." : `Welcome back, ${escapeHtml(account.name.split(" ")[0])}.`}</h2>
        <p>${isCoach ? "Review plans, celebrate progress, and keep every next step visible." : "Every paycheck is another opportunity to build financial integrity and momentum."}</p>
      </div>
      <img src="assets/fit-logo-exact-transparent.png" alt="Financial Integrity Training">
    </section>
  `;
}

function metric(label, value, className = "") {
  return `
    <article class="metric ${className}" data-metric-label="${escapeHtml(label)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </article>
  `;
}

function memberFormCard(form) {
  const calc = calculate(form);
  return `
    <article class="form-card">
      <div class="form-card-top">
        <div>
          <h3>${escapeHtml(form.title)}</h3>
          <p>Assigned to ${escapeHtml(form.assignedName || form.ownerName)} · Created ${updatedLabel(form.createdAt)}</p>
        </div>
        ${formStatusBadge(form)}
      </div>
      ${form.generatedFromProfile ? "" : `<div class="form-origin"><span>Legacy worksheet</span></div>`}
      <div class="card-stats">
        <div><span>This check</span><strong>${money(calc.thisCheck)}</strong></div>
        <div><span>Available</span><strong>${money(calc.available)}</strong></div>
      </div>
      <div class="button-row">
        <button class="btn btn-primary btn-small" type="button" data-open-form="${form.id}">Open</button>
        <button class="btn btn-secondary btn-small" type="button" data-save-form="${form.id}">Save</button>
        ${currentAccount()?.coachEmail && currentAccount()?.coachRequestStatus === "approved" ? `<button class="btn btn-secondary btn-small" type="button" data-share-form="${form.id}"><span aria-hidden="true">↗</span> Send to coach</button>` : ""}
        <button class="btn btn-secondary btn-small" type="button" data-print-form="${form.id}">Print PDF</button>
        ${
          form.archivedAt
            ? `<span class="badge">Archived</span>`
            : `<button class="btn btn-secondary btn-small" type="button" ${form.status === "approved" ? "" : 'disabled title="Available after coach approval"'} data-archive-form="${form.id}">Archive</button>`
        }
        <button class="icon-btn danger" type="button" title="Delete form" aria-label="Delete form" data-delete-form="${form.id}">×</button>
      </div>
    </article>
  `;
}

function coachFormCard(form) {
  const calc = calculate(form);
  return `
    <article class="form-card coach-document-card">
      <div class="form-card-top">
        <div>
          <p class="document-label">Received worksheet</p>
          <h3>${escapeHtml(form.ownerName)}</h3>
          <p>Assigned to ${escapeHtml(form.assignedName || form.ownerName)} · ${escapeHtml(profileRelationship(appState.accounts[form.ownerEmail]))}</p>
        </div>
        ${formStatusBadge(form)}
      </div>
      <div class="coach-document-meta">
        <div><span>Check date</span><strong>${dateLabel(form.data.overview.checkDate)}</strong></div>
        <div><span>Amount paid</span><strong>${money(calc.thisCheck)}</strong></div>
        <div><span>Tithe</span><strong>${titheMoney(calc.tithe)}</strong></div>
      </div>
      <div class="button-row">
        <button class="btn btn-primary btn-small" type="button" data-open-form="${form.id}">${form.status === "approved" ? "View approved form" : "Review form"}</button>
        ${
          form.archivedAt
            ? `<span class="badge">Archived</span>`
            : `<button class="btn btn-secondary btn-small" type="button" ${form.status === "approved" ? "" : 'disabled title="Available after approval"'} data-archive-form="${form.id}">Archive</button>`
        }
        <span class="autosave">${form.status === "approved" ? "Approved" : "Sent"} ${updatedLabel(form.approvedAt || form.submittedAt || form.updatedAt)}</span>
      </div>
    </article>
  `;
}

function formStatusBadge(form) {
  if (form.archivedAt) return `<span class="badge">Archived</span>`;
  if (form.status === "approved") return `<span class="badge green">Approved</span>`;
  if (form.status === "submitted") return `<span class="badge">Awaiting review</span>`;
  return `<span class="badge">Draft</span>`;
}

function menteeSavingsCard(member) {
  const latest = memberForms(member.email)[0];
  const calc = latest ? calculate(latest) : null;
  const goal = Number(member.carryForward?.savings?.goal || calc?.savingsGoal || 0);
  const current = reportedSavingsTotal(member);
  const pendingContribution =
    latest?.status === "draft" || latest?.status === "submitted"
      ? currencyValue(latest?.data?.savings?.contribution)
      : 0;
  const savingsAccounts = (member.savingsInvestmentAccounts || []).filter(
    (account) => account.type === "savings",
  );
  const progress = goal ? Math.min(100, (current / goal) * 100) : 0;
  return `
    <article class="form-card">
      <div class="form-card-top"><div class="person-row">${avatarMarkup(member)}<div><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.email)} · ${escapeHtml(profileRelationship(member))}</p>${activityBadge(member)}</div></div><span class="badge green">Mentee</span></div>
      <div class="savings-mini-stats"><strong>${money(current)}</strong><span>of ${money(goal)} saved</span></div>
      ${
        savingsAccounts.length
          ? `<div class="coach-savings-breakdown">${savingsAccounts.map((account) => `<span>${escapeHtml(account.name || "Savings account")} <strong>${money(account.balance)}</strong></span>`).join("")}</div>`
          : ""
      }
      ${pendingContribution ? `<p class="savings-pending-note">${money(pendingContribution)} planned in the latest worksheet, not yet included above.</p>` : ""}
      ${progressBar(progress, `${money(Math.max(0, goal - current))} left`)}
    </article>
  `;
}

function withdrawalCard(withdrawal) {
  const member = appState.accounts[withdrawal.memberEmail];
  return `
    <article class="withdrawal-card">
      <div>
        <strong>${escapeHtml(member?.name || withdrawal.memberEmail)}</strong>
        <span>${updatedLabel(withdrawal.createdAt)} · ${escapeHtml(withdrawal.savingsAccountName || "Savings")} · ${money(withdrawal.amount)} withdrawn</span>
        <p>${escapeHtml(withdrawal.reason)}</p>
      </div>
      <strong class="withdrawal-amount">-${money(withdrawal.amount)}</strong>
    </article>
  `;
}

function notificationCenter(account, notifications = visibleNotifications(account)) {
  const recent = notifications.slice(0, 5);
  if (!recent.length) return "";
  return `
    <section class="panel milestone-center">
      <div class="panel-heading">
        <div><h3>Notifications</h3><p>Milestones, savings withdrawals, and important F.I.T. updates.</p></div>
        <span class="badge green">${notifications.filter((notification) => !notification.readAt).length} new</span>
      </div>
      <div class="milestone-list">
        ${recent.map((notification) => `
          <article class="milestone-notification ${notification.readAt ? "" : "unread"} notification-${notificationCategory(notification.type).key}">
            <span class="milestone-icon" aria-hidden="true">${notificationIcon(notification.type)}</span>
            <div><span class="notification-type">${escapeHtml(notificationCategory(notification.type).label)}</span><strong>${escapeHtml(notification.title)}</strong><p>${escapeHtml(notification.message)}</p><small>${updatedLabel(notification.createdAt)}</small></div>
            <div class="milestone-actions">
              ${notification.readAt ? `<span class="badge green">Seen</span>` : `<button class="btn btn-secondary btn-small" type="button" data-read-notification="${notification.id}">Mark seen</button>`}
              <button class="icon-btn danger milestone-delete" type="button" title="Delete notification" aria-label="Delete notification" data-delete-notification="${notification.id}">×</button>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function notificationIcon(type) {
  if (type === "card_paid") return "✓";
  if (type === "savings_withdrawal") return "$";
  return "★";
}

function notificationCategory(type) {
  if (type === "card_paid" || type === "savings_goal") return { key: "milestone", label: "Milestone" };
  if (type === "savings_withdrawal") return { key: "coach", label: "Coach update" };
  if (type === "document_available") return { key: "document", label: "Document" };
  if (type === "fit_session_completed") return { key: "session", label: "Session" };
  return { key: "account", label: "F.I.T. update" };
}

function emptyState(symbol, title, description, action) {
  return `
    <section class="empty-state">
      <div>
        <span class="empty-state-symbol" aria-hidden="true">${symbol}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
        ${action}
      </div>
    </section>
  `;
}

function worksheetJumpNav(form) {
  return `
    <nav class="profile-jump-nav worksheet-jump-nav" aria-label="Worksheet sections">
      <span>Jump to section</span>
      <a href="#overview">Paycheck overview</a>
      ${form.data.housingPaymentType === "mortgage" ? `<a href="#mortgage">Mortgage</a>` : ""}
      <a href="#bills">Fixed bills</a>
      <a href="#cards">Credit cards</a>
      <a href="#savings">Savings</a>
      <a href="#debt">Debt</a>
      <a href="#student-loans">Student loans</a>
      <a href="#allocations">Rollovers</a>
      <a href="#spending">Budgeting</a>
      <a href="#notes">Notes</a>
    </nav>
  `;
}

function renderEditor() {
  const account = currentAccount();
  const form = appState.forms[activeFormId];
  if (!form) {
    renderPortalStatusPage(
      portalInitializationInProgress || !portalDataReady ? "loading" : "unavailable",
    );
    return;
  }

  const assignedCoach = account.role === "coach" && appState.accounts[form.ownerEmail]?.coachEmail === account.email;
  const isCoachReview = assignedCoach && form.status !== "approved";
  const readOnly = form.ownerEmail !== account.email && !assignedCoach;
  const authorized =
    (account.role === "user" && form.ownerEmail === account.email) ||
    assignedCoach;
  if (!authorized) {
    renderPortalStatusPage("permission");
    return;
  }

  const ownerHousingType = appState.accounts[form.ownerEmail]?.financialInventory?.housingPaymentType || "mortgage";
  if (form.status !== "approved" && form.data.housingPaymentType !== ownerHousingType) {
    form.data.housingPaymentType = ownerHousingType;
    form.updatedAt = new Date().toISOString();
    saveState();
  }

  const calc = calculate(form);
  const actions = account.role === "coach"
    ? `${isCoachReview ? `<button class="btn btn-gold" type="button" data-approve-form="${form.id}">Complete session & approve</button>` : ""}
       <button class="btn btn-secondary" type="button" data-print-form="${form.id}">Print PDF</button>
       <button class="btn btn-secondary" type="button" data-view="dashboard">Back to coach workspace</button>`
    : `
      ${account.coachEmail && account.coachRequestStatus === "approved" ? `<button class="btn btn-gold" type="button" data-share-form="${form.id}"><span aria-hidden="true">↗</span> Send to coach</button>` : ""}
      <button class="btn btn-primary" type="button" data-save-form="${form.id}">Save form</button>
      <button class="btn btn-secondary" type="button" data-print-form="${form.id}">Print PDF</button>
      <button class="btn btn-primary" type="button" data-view="dashboard">Done</button>
    `;

  const content = `
    <div class="content worksheet-content">
      ${
        readOnly
          ? `<div class="readonly-banner"><strong>${isCoachReview ? "Coach review required" : "Approved document"}</strong><span>${isCoachReview ? "Choose bill timing, then complete the session with coach notes and action steps." : `This form belongs to ${escapeHtml(form.ownerName)}.`}</span></div>`
          : ""
      }
      ${worksheetJumpNav(form)}
      <div class="editor-layout" style="margin-top: ${readOnly ? "16px" : "0"}">
        <div class="editor-main">
          ${overviewPanel(form, calc, readOnly)}
          ${form.data.housingPaymentType === "mortgage" ? mortgagePanel(form, calc, readOnly, isCoachReview) : ""}
          ${billsPanel(form, calc, readOnly, isCoachReview)}
          ${creditCardPanel(form, calc, readOnly, isCoachReview)}
          ${savingsPanel(form, calc, readOnly, isCoachReview)}
          ${debtPanel(form, calc, readOnly, isCoachReview)}
          ${studentLoanPanel(form, calc, readOnly, isCoachReview)}
          ${allocationPanel(form, calc, readOnly, isCoachReview)}
          ${variablePanel(form, calc, readOnly, isCoachReview)}
          ${notesPanel(form, readOnly)}
        </div>
        <aside class="editor-aside">
          ${summaryPanel(calc)}
        </aside>
      </div>
      ${calculatorPanel(form, readOnly)}
    </div>
  `;

  app.innerHTML = shell(content, {
    title: readOnly ? form.title : "Edit worksheet",
    subtitle: readOnly
      ? `${form.assignedName || form.ownerName} · ${form.status === "approved" ? "Approved document" : "Ready for coach review"}`
      : `Autosaved · Last updated ${updatedLabel(form.updatedAt)}`,
    actions,
  });
  observeCalculatorSize(app.querySelector("[data-draggable-calculator]"));
}

function overviewPanel(form, calc, readOnly) {
  const owner = appState.accounts[form.ownerEmail];
  const assignedAvatar = formAssigneeAvatar(owner || form.ownerName, form.assignedPerson, "avatar-lg");
  return `
    <section class="panel" id="overview">
      <div class="panel-heading">
        <div class="profile-heading-person">${assignedAvatar}<div><h3>Paycheck overview</h3><p>${escapeHtml(form.assignedName || form.ownerName)} · Income and bill summary</p></div></div>
        <span class="autosave"><span class="autosave-dot"></span>${readOnly ? "Read only" : "Autosaved"}</span>
      </div>
      <div class="panel-body overview-grid">
        ${dateField("Check date", "overview.checkDate", form.data.overview.checkDate, readOnly)}
        ${moneyField("This check", "overview.thisCheck", form.data.overview.thisCheck, readOnly)}
        ${moneyField("Additional income", "overview.additionalIncome", form.data.overview.additionalIncome, readOnly)}
        ${computedField("Total income", money(calc.totalIncome), "total-income")}
        ${computedField("Tithe (10%)", titheMoney(calc.tithe), "tithe")}
      </div>
    </section>
  `;
}

function billsPanel(form, calc, readOnly, isCoachReview) {
  return `
    <section class="panel" id="bills">
      <div class="panel-heading">
        <div><h3>Fixed bills</h3><p>Housing, utilities, subscriptions, and other bills</p></div>
        <span class="badge">${money(calc.fixedBills)} total</span>
      </div>
      <div class="panel-body bill-sections">
        ${billGroups.map(([key, label]) => billGroup(form, key, label, readOnly, isCoachReview)).join("")}
      </div>
    </section>
  `;
}

function billGroup(form, key, label, readOnly, isCoachReview) {
  const rows = form.data.bills[key];
  const subtotal = rows.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `
    <section class="subpanel">
      <div class="subpanel-heading">
        <h4>${label}</h4>
        ${readOnly ? "" : `<button class="icon-btn" type="button" title="Add ${label} bill" aria-label="Add ${label} bill" data-add-row="bills.${key}">＋</button>`}
      </div>
      <div class="data-table-wrap">
        <table class="data-table compact bills-table ${isCoachReview ? "coach-review" : ""}">
          <thead><tr><th style="width:${isCoachReview ? "30%" : "42%"}">Bill</th><th style="width:${isCoachReview ? "22%" : "26%"}">Due date</th><th style="width:${isCoachReview ? "18%" : "22%"}">Amount</th>${isCoachReview ? `<th style="width:22%">Coach plan</th>` : ""}<th style="width:${isCoachReview ? "8%" : "10%"}"></th></tr></thead>
          <tbody>
            ${rows.map((row, index) => `
              <tr>
                <td data-mobile-label="Bill">
                  <div class="bill-selector-wrap"><input class="table-input" data-bill-suggestion="${key}.${index}" data-path="bills.${key}.${index}.name" value="${escapeHtml(row.name)}" placeholder="Choose or enter bill" ${readOnly ? "disabled" : ""}>${readOnly ? "" : `<button class="bill-selector-button" type="button" data-open-bill-selector aria-label="Choose a saved bill" title="Choose a saved bill">⌄</button>`}</div>
                  ${isCoachReview ? "" : `<div class="member-suggestion-inline"><span>Your suggestion</span>${memberSuggestionControl(`bills.${key}.${index}.memberSuggestion`, row.memberSuggestion, canSuggest)}${row.coachDecision ? `<small>Coach plan: ${paymentTimingLabel(row.coachDecision, "Not reviewed")}</small>` : ""}</div>`}
                </td>
                <td data-mobile-label="Due date"><input class="table-input" type="date" data-current-calendar data-path="bills.${key}.${index}.dueDate" value="${row.dueDate}" ${readOnly ? "disabled" : ""}></td>
                <td data-mobile-label="Amount"><div class="money-input-wrap"><input class="table-input" type="text" inputmode="decimal" data-currency-input data-path="bills.${key}.${index}.amount" value="${moneyInputValue(row.amount)}" placeholder="0.00" ${readOnly ? "disabled" : ""}></div></td>
                ${isCoachReview ? `<td data-mobile-label="Coach plan">${billDecisionControl(`bills.${key}.${index}.coachDecision`, row.coachDecision, true, row.memberSuggestion, `bills.${key}.${index}`)}</td>` : ""}
                <td class="mobile-row-action">${readOnly ? "" : `<button class="icon-btn danger" type="button" title="Remove row" aria-label="Remove row" data-remove-row="bills.${key}.${index}">×</button>`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="table-total"><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
    </section>
  `;
}

function mortgagePanel(form, calc, readOnly, isCoachReview) {
  const mortgage = form.data.mortgage;
  const total = Number(mortgage.totalAmount) || 0;
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  const paymentRemaining = currencyValue(Math.max(0, (Number(mortgage.paymentAmount) || 0) - calc.mortgageContribution));
  const progress = total ? Math.min(100, Math.max(0, ((total - calc.mortgageAfter) / total) * 100)) : 0;
  return `
    <section class="panel" id="mortgage">
      <div class="panel-heading"><div><h3>Mortgage payment tracker</h3><p>Track the monthly payment due and the long-term mortgage balance separately.</p></div></div>
      <div class="panel-body tracker-grid">
        ${moneyField("Total mortgage amount", "mortgage.totalAmount", mortgage.totalAmount, readOnly)}
        ${percentField("Mortgage interest rate", "mortgage.interestRate", mortgage.interestRate, readOnly)}
        ${moneyField("Current mortgage balance", "mortgage.currentBalance", mortgage.currentBalance, readOnly)}
        ${moneyField("Payment amount", "mortgage.paymentAmount", mortgage.paymentAmount, readOnly)}
        ${dateField("Next due date", "mortgage.nextDueDate", mortgage.nextDueDate, readOnly)}
        ${dateField("Must pay by", "mortgage.mustPayBy", mortgage.mustPayBy, readOnly)}
        ${moneyField("This check's contribution", "mortgage.contribution", mortgage.contribution, readOnly)}
        ${isCoachReview ? "" : memberSuggestionField("mortgage", mortgage, canSuggest)}
        ${coachPlanField("mortgage", mortgage, isCoachReview)}
        ${computedField("Payment still needed", money(paymentRemaining), "mortgage-payment-needed")}
      </div>
      <div class="savings-progress-block">${progressBar(progress, `${Math.round(progress)}% of mortgage paid`)}</div>
    </section>
  `;
}

function creditCardPanel(form, calc, readOnly, isCoachReview) {
  return `
    <section class="panel" id="cards">
      <div class="panel-heading">
        <div><h3>Credit card contribution tracker</h3><p>Plan contributions from this paycheck</p></div>
        ${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-add-row="creditCards"><span aria-hidden="true">＋</span> Add card</button>`}
      </div>
      <div class="debt-card-list">
        ${form.data.creditCards.map((row, index) => creditCardCard(form, row, index, readOnly, isCoachReview)).join("")}
      </div>
      <div class="table-total"><span>This check's credit card subtotal</span><strong>${money(calc.creditCards)}</strong></div>
    </section>
  `;
}

function creditCardCard(form, row, index, readOnly, isCoachReview) {
  migratePromoCard(row);
  const remaining = remainingAfterPlannedPayment(row, form, "credit_card");
  const extraPayment = allocationTotalFor(form, "credit_card", row.account);
  const purchasePromo = row.promoType === "purchases" || row.promoType === "both";
  const balancePromo = row.promoType === "balance_transfers" || row.promoType === "both";
  const hasPromo = row.promoType && row.promoType !== "none";
  return `
    <article class="debt-entry credit-card-entry">
      <div class="debt-entry-heading">
        <div><strong>${escapeHtml(row.account || "New credit card")}</strong><span class="entry-balance">${money(remaining)} remaining${extraPayment ? ` · ${money(extraPayment)} rolled over` : ""}</span></div>
        ${readOnly ? "" : `<button class="icon-btn danger" type="button" title="Remove card" aria-label="Remove card" data-remove-row="creditCards.${index}">×</button>`}
      </div>
      <div class="debt-entry-grid">
        ${textField("Card / account", `creditCards.${index}.account`, row.account, readOnly, "Account name")}
        ${moneyField("Total balance", `creditCards.${index}.totalBalance`, row.totalBalance, readOnly)}
        ${moneyField("Last statement balance", `creditCards.${index}.lastStatementBalance`, row.lastStatementBalance, readOnly)}
        ${moneyField("Payment due", `creditCards.${index}.paymentDue`, row.paymentDue, readOnly)}
        ${moneyField("Credit card allowance", `creditCards.${index}.allowance`, row.allowance, readOnly)}
        ${dateField("Due date", `creditCards.${index}.dueDate`, row.dueDate, readOnly)}
        ${moneyField("This check's contribution", `creditCards.${index}.contribution`, row.contribution, readOnly)}
        ${hasPromo ? "" : percentField("Annual APR", `creditCards.${index}.apr`, row.apr, readOnly)}
        ${isCoachReview ? "" : `<div class="field"><label>Your suggestion</label>${memberSuggestionControl(`creditCards.${index}.memberSuggestion`, row.memberSuggestion, !readOnly && form.status !== "approved")}</div>`}
        <div class="field"><label>Coach plan</label>${billDecisionControl(`creditCards.${index}.coachDecision`, row.coachDecision, isCoachReview, row.memberSuggestion, `creditCards.${index}`)}</div>
        <div class="field"><label>Promotional APR</label><select class="input" data-card-promo-type="${index}" ${readOnly ? "disabled" : ""}>
          ${selectOption("none", "No promotional APR", row.promoType)}
          ${selectOption("purchases", "Purchases", row.promoType)}
          ${selectOption("balance_transfers", "Balance transfers", row.promoType)}
          ${selectOption("both", "Purchases and balance transfers", row.promoType)}
        </select></div>
      </div>
      ${
        purchasePromo
          ? `<div class="promo-fields"><div class="promo-heading">Purchase promotion</div>
              ${percentField("Promotional purchase APR", `creditCards.${index}.purchasePromoRate`, row.purchasePromoRate, readOnly)}
              ${dateField("Purchase promotion expiration", `creditCards.${index}.purchasePromoExpiration`, row.purchasePromoExpiration, readOnly)}
            </div>`
          : ""
      }
      ${
        balancePromo
          ? `<div class="promo-fields"><div class="promo-heading">Balance transfer promotion</div>
              ${percentField("Promotional balance transfer APR", `creditCards.${index}.balanceTransferPromoRate`, row.balanceTransferPromoRate, readOnly)}
              ${dateField("Balance transfer promotion expiration", `creditCards.${index}.balanceTransferPromoExpiration`, row.balanceTransferPromoExpiration, readOnly)}
            </div>`
          : ""
      }
    </article>
  `;
}

function variablePanel(form, calc, readOnly, isCoachReview) {
  const overBudget = calc.available < 0;
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `
    <section class="panel final-budget-panel ${overBudget ? "over-budget" : ""}" id="spending">
      <div class="panel-heading">
        <div><p class="eyebrow">Final step</p><h3>Budget remaining funds</h3><p>Use only what remains after bills, contributions, and rollovers.</p></div>
        ${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-add-row="variableSpending"><span aria-hidden="true">＋</span> Add category</button>`}
      </div>
      <div class="budget-remaining-strip">
        ${computedField("Ready to budget", money(calc.available), "remaining-before-budget")}
        ${computedField("Budgeted", money(calc.variableBudget), "variable-budget")}
        ${computedField("Left to budget", money(calc.available), "available")}
      </div>
      <div class="data-table-wrap">
        <table class="data-table final-budget-table">
          <tbody>
            ${form.data.variableSpending.map((row, index) => `
              <tr>
                <td><input class="table-input" data-path="variableSpending.${index}.category" value="${escapeHtml(row.category)}" placeholder="Category" ${readOnly ? "disabled" : ""}>
                  ${isCoachReview ? "" : `<div class="member-suggestion-inline"><span>Your suggestion</span>${memberSuggestionControl(`variableSpending.${index}.memberSuggestion`, row.memberSuggestion, canSuggest)}${row.coachDecision ? `<small>Coach plan: ${paymentTimingLabel(row.coachDecision, "Not reviewed")}</small>` : ""}</div>`}
                </td>
                <td><div class="money-input-wrap"><input class="table-input" type="text" inputmode="decimal" data-currency-input data-path="variableSpending.${index}.budgeted" value="${moneyInputValue(row.budgeted)}" placeholder="0.00" ${readOnly ? "disabled" : ""}></div></td>
                ${isCoachReview ? `<td>${billDecisionControl(`variableSpending.${index}.coachDecision`, row.coachDecision, true, row.memberSuggestion, `variableSpending.${index}`)}</td>` : ""}
                <td class="mobile-row-action">${readOnly ? "" : `<button class="icon-btn danger" type="button" title="Remove category" aria-label="Remove category" data-remove-row="variableSpending.${index}">×</button>`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="table-total"><span>Left to budget</span><strong>${money(calc.available)}</strong></div>
    </section>
  `;
}

function savingsPanel(form, calc, readOnly, isCoachReview) {
  const savings = form.data.savings;
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `
    <section class="panel" id="savings">
      <div class="panel-heading">
        <div><h3>Savings contribution</h3><p>Track progress toward your savings goal</p></div>
        ${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-withdraw-savings="${form.id}">Withdraw savings</button>`}
      </div>
      <div class="panel-body savings-grid">
        ${moneyField("Savings goal", "savings.goal", savings.goal, readOnly)}
        ${moneyField("Current savings", "savings.current", savings.current, readOnly)}
        ${moneyField("This check's contribution", "savings.contribution", savings.contribution, readOnly)}
        ${isCoachReview ? "" : memberSuggestionField("savings", savings, canSuggest)}
        ${coachPlanField("savings", savings, isCoachReview)}
        ${computedField("Total savings after contribution", money(calc.savingsAfter), "savings-after")}
      </div>
      <div class="savings-progress-block">
        <div class="savings-progress-copy"><strong data-live-savings-after-copy>${money(calc.savingsAfter)} saved</strong><span data-live-savings-remaining-copy>${money(calc.savingsRemaining)} left to reach ${money(calc.savingsGoal)}</span></div>
        ${progressBar(calc.savingsProgress, `${Math.round(calc.savingsProgress)}% complete`)}
      </div>
    </section>
  `;
}

function debtPanel(form, calc, readOnly, isCoachReview) {
  return `
    <section class="panel" id="debt">
      <div class="panel-heading">
        <div><h3>Debt section</h3><p>Keep all current debts visible in one place</p></div>
        ${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-add-row="debts"><span aria-hidden="true">＋</span> Add debt</button>`}
      </div>
      <div class="debt-card-list">
        ${form.data.debts.map((row, index) => debtCard(form, row, index, readOnly, isCoachReview)).join("")}
      </div>
      <div class="table-total"><span>Remaining debt after planned payments</span><strong>${money(calc.totalDebtBalanceAfter)}</strong></div>
    </section>
  `;
}

function debtCard(form, row, index, readOnly, isCoachReview) {
  const remaining = remainingAfterPlannedPayment(row, form, "debt");
  const extraPayment = allocationTotalFor(form, "debt", row.account);
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `
    <article class="debt-entry debt-tracker-entry">
      <div class="debt-entry-heading">
        <div><strong>${escapeHtml(row.account || "New debt account")}</strong><span class="entry-balance">${money(remaining)} remaining${extraPayment ? ` · ${money(extraPayment)} rolled over` : ""}</span></div>
        ${readOnly ? "" : `<button class="icon-btn danger" type="button" title="Remove debt" aria-label="Remove debt" data-remove-row="debts.${index}">×</button>`}
      </div>
      <div class="debt-entry-grid">
        ${textField("Debt / account", `debts.${index}.account`, row.account, readOnly, "Account name")}
        ${moneyField("Total owed", `debts.${index}.totalOwed`, row.totalOwed, readOnly)}
        ${moneyField("Minimum payment", `debts.${index}.minimumPayment`, row.minimumPayment, readOnly)}
        ${moneyField("This check's contribution", `debts.${index}.contribution`, row.contribution, readOnly)}
        ${row.promotionalRateApplied ? "" : percentField("Annual APR", `debts.${index}.apr`, row.apr, readOnly)}
        ${isCoachReview ? "" : memberSuggestionField(`debts.${index}`, row, canSuggest)}
        ${coachPlanField(`debts.${index}`, row, isCoachReview)}
      </div>
      <label class="check-control">
        <input type="checkbox" data-promo-toggle="${index}" ${row.promotionalRateApplied ? "checked" : ""} ${readOnly ? "disabled" : ""}>
        <span>Promotional rate applied</span>
      </label>
      ${
        row.promotionalRateApplied
          ? `<div class="promo-fields">
              ${percentField("Promotional APR", `debts.${index}.promotionalRate`, row.promotionalRate, readOnly)}
              ${dateField("Promotion expiration date", `debts.${index}.promotionExpiration`, row.promotionExpiration, readOnly)}
            </div>`
          : ""
      }
      ${textField("Notes", `debts.${index}.notes`, row.notes, readOnly, "Optional note")}
    </article>
  `;
}

function studentLoanPanel(form, calc, readOnly, isCoachReview) {
  return `
    <section class="panel" id="student-loans">
      <div class="panel-heading"><div><h3>Student loans</h3><p>Plan payments while tracking each remaining balance.</p></div>${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-add-row="studentLoans"><span aria-hidden="true">＋</span> Add student loan</button>`}</div>
      <div class="debt-card-list">${(form.data.studentLoans || []).map((loan, index) => studentLoanCard(form, loan, index, readOnly, isCoachReview)).join("") || emptyInline("No student loans", "Add a student loan from the form or financial profile.")}</div>
      <div class="table-total"><span>This check's student loan subtotal</span><strong>${money(calc.studentLoanContributions)}</strong></div>
      <div class="table-total"><span>Remaining student loan balance after planned payments</span><strong>${money(calc.totalStudentLoanBalanceAfter)}</strong></div>
    </section>
  `;
}

function studentLoanCard(form, loan, index, readOnly, isCoachReview) {
  const remaining = remainingAfterPlannedPayment(loan, form, "student_loan");
  const extraPayment = allocationTotalFor(form, "student_loan", loan.account);
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `<article class="debt-entry student-loan-entry"><div class="debt-entry-heading"><div><strong>${escapeHtml(loan.account || "New student loan")}</strong><span class="entry-balance">${money(remaining)} remaining${extraPayment ? ` · ${money(extraPayment)} rolled over` : ""}</span></div>${readOnly ? "" : `<button class="icon-btn danger" type="button" title="Remove student loan" aria-label="Remove student loan" data-remove-row="studentLoans.${index}">×</button>`}</div><div class="debt-entry-grid">
    ${textField("Loan name", `studentLoans.${index}.account`, loan.account, readOnly, "Student loan name")}
    ${studentLoanTypeField(`studentLoans.${index}.loanType`, loan.loanType, readOnly)}
    ${moneyField("Balance", `studentLoans.${index}.totalOwed`, loan.totalOwed, readOnly)}
    ${percentField("Interest rate", `studentLoans.${index}.apr`, loan.apr, readOnly)}
    ${moneyField("Payment due", `studentLoans.${index}.paymentDue`, loan.paymentDue, readOnly)}
    ${dateField("Due date", `studentLoans.${index}.dueDate`, loan.dueDate, readOnly)}
    ${moneyField("This check's contribution", `studentLoans.${index}.contribution`, loan.contribution, readOnly)}
    ${isCoachReview ? "" : memberSuggestionField(`studentLoans.${index}`, loan, canSuggest)}
    ${coachPlanField(`studentLoans.${index}`, loan, isCoachReview)}
  </div></article>`;
}

function allocationTargetOptions(form, selectedType, selectedAccount) {
  const owner = appState.accounts[form.ownerEmail];
  const groups = [
    ["debt", "Debts", form.data.debts || []],
    ["credit_card", "Credit cards", form.data.creditCards || []],
    ["student_loan", "Student loans", form.data.studentLoans || []],
    ["savings", "Savings accounts", (owner?.savingsInvestmentAccounts || []).filter((item) => item.type === "savings")],
  ];
  const selectedValue = `${selectedType || ""}|${selectedAccount || ""}`;
  return `<option value="">Select a rollover target</option>${groups
    .map(([type, label, rows]) => {
      const options = rows
        .filter((row) => row.account || row.name)
        .map((row) => {
          const accountName = row.account || row.name || "Savings account";
          const value = `${type}|${accountName}`;
          return `<option value="${escapeHtml(value)}" ${value === selectedValue ? "selected" : ""}>${escapeHtml(accountName)}</option>`;
        })
        .join("");
      return options ? `<optgroup label="${label}">${options}</optgroup>` : "";
    })
    .join("")}`;
}

function allocationPanel(form, calc, readOnly, isCoachReview) {
  const rows = form.data.allocations || [];
  const canSuggest = !readOnly && !isCoachReview && form.status !== "approved";
  return `
    <section class="panel debt-routing-panel" id="allocations">
      <div class="panel-heading">
        <div><h3>Rollovers</h3><p>Move remaining money to savings, debt, credit cards, or student loans.</p></div>
        ${readOnly ? "" : `<button class="btn btn-secondary btn-small" type="button" data-add-row="allocations"><span aria-hidden="true">＋</span> Add rollover</button>`}
      </div>
      <div class="routing-list">
        ${
          rows.length
            ? rows.map((row, index) => `
              <article class="routing-row">
                <div class="field"><label>Rollover target</label><button class="input selection-field-button" type="button" data-open-allocation-selector="${index}" ${readOnly ? "disabled" : ""}><span>${escapeHtml(row.account || "Choose a rollover target")}</span><i aria-hidden="true">⌄</i></button></div>
                ${moneyField("Rollover amount", `allocations.${index}.amount`, row.amount, readOnly)}
                ${isCoachReview ? "" : memberSuggestionField(`allocations.${index}`, row, canSuggest)}
                ${coachPlanField(`allocations.${index}`, row, isCoachReview)}
                ${readOnly ? "" : `<button class="icon-btn danger routing-remove" type="button" aria-label="Remove rollover" title="Remove rollover" data-remove-row="allocations.${index}">×</button>`}
              </article>
            `).join("")
            : emptyInline("No rollovers added", "Add a rollover to move remaining money to savings, debt, credit cards, or student loans.")
        }
      </div>
      <div class="table-total"><span>Total rollovers</span><strong data-live-allocation-total>${money(calc.allocationTotal)}</strong></div>
    </section>
  `;
}

function calculatorPanel(form, readOnly) {
  const keys = [
    ["⌫", "utility"], ["AC", "utility"], ["%", "utility"], ["÷", "operator"],
    ["7", "number"], ["8", "number"], ["9", "number"], ["×", "operator"],
    ["4", "number"], ["5", "number"], ["6", "number"], ["−", "operator"],
    ["1", "number"], ["2", "number"], ["3", "number"], ["+", "operator"],
    ["+/-", "utility"], ["0", "number"], [".", "number"], ["=", "operator"],
  ];
  const position = form.data.calculatorPosition;
  const savedSize = form.data.calculatorSize || {};
  const compactViewport = window.innerWidth <= 620;
  const viewportWidth = Math.max(220, window.innerWidth - 24);
  const minWidth = Math.min(compactViewport ? 184 : 190, viewportWidth);
  const calculatorAspectRatio = 11 / 16;
  const heightLimitedWidth = Math.max(minWidth, (window.innerHeight - 24) * calculatorAspectRatio);
  const maxWidth = Math.max(minWidth, Math.min(compactViewport ? 360 : 430, viewportWidth, heightLimitedWidth));
  const defaultWidth = Math.min(compactViewport ? 268 : 292, maxWidth);
  const savedWidth = Number(savedSize.width);
  const calculatorWidth = savedWidth ? Math.min(Math.max(minWidth, savedWidth), maxWidth) : defaultWidth;
  const calculatorHeight = calculatorWidth / calculatorAspectRatio;
  const safeLeft = position
    ? Math.min(Math.max(8, Number(position.left) || 8), Math.max(8, window.innerWidth - calculatorWidth - 8))
    : 0;
  const safeTop = position
    ? Math.min(Math.max(8, Number(position.top) || 8), Math.max(8, window.innerHeight - calculatorHeight - 8))
    : 0;
  const sizeStyle = `width:${calculatorWidth}px;height:auto;aspect-ratio:11 / 16;`;
  const positionStyle = `${sizeStyle}${position ? `left:${safeLeft}px;top:${safeTop}px;right:auto;bottom:auto;` : ""}`;
  return `<aside class="calculator-widget fit-calculator ${form.data.calculatorMinimized ? "minimized" : ""} ${form.data.calculatorHistoryOpen ? "history-open" : ""}" data-draggable-calculator="${form.id}" style="${positionStyle}">
    <div class="calculator-heading" data-calculator-drag-handle>
      <div class="calculator-title-group">
        <strong class="calculator-title">Calculator</strong>
      </div>
      <div class="calculator-tools">
        <button class="calculator-history-toggle" type="button" data-toggle-calculator-history="${form.id}" aria-label="${form.data.calculatorHistoryOpen ? "Hide recent calculations" : "Show recent calculations"}" title="${form.data.calculatorHistoryOpen ? "Hide recent calculations" : "Show recent calculations"}" aria-expanded="${form.data.calculatorHistoryOpen ? "true" : "false"}"><span class="calculator-clock-symbol" aria-hidden="true">◴</span></button>
        <button class="calculator-minimize" type="button" data-toggle-calculator-minimize="${form.id}" aria-label="${form.data.calculatorMinimized ? "Restore calculator" : "Minimize calculator"}" title="${form.data.calculatorMinimized ? "Restore calculator" : "Minimize calculator"}">${form.data.calculatorMinimized ? "□" : "−"}</button>
      </div>
    </div>
    <output class="calculator-display" aria-live="polite">${escapeHtml(form.data.calculatorDraft || "0")}</output>
    <div class="calculator-keypad" aria-label="Calculator keypad">
      ${keys.map(([key, kind]) => `<button class="calculator-key ${kind}" type="button" data-calculator-key="${escapeHtml(key)}" data-calculator-form-id="${form.id}" ${readOnly ? "disabled" : ""}>${escapeHtml(key)}</button>`).join("")}
    </div>
    <section class="calculator-history" aria-label="Recent calculations">
      <div class="calculator-history-heading"><strong>Recent calculations</strong><span>Last 10</span></div>
      <div class="calculator-history-list">${calculatorHistoryMarkup(form)}</div>
    </section>
  </aside>`;
}

function calculatorHistoryMarkup(form) {
  const history = (form.data.calculatorHistory || []).slice(-10).reverse();
  return history.length
    ? history
        .map(
          (item) =>
            `<div><span>${escapeHtml(item.expression)}</span><strong>${escapeHtml(moneyInputValue(item.result))}</strong></div>`,
        )
        .join("")
    : `<p class="calculator-empty">Recent calculations appear here.</p>`;
}

function refreshCalculatorDisplay(calculator, form) {
  if (!calculator || !form) return;
  const display = calculator.querySelector(".calculator-display");
  const historyPanel = calculator.querySelector(".calculator-history-list");
  if (display) display.textContent = form.data.calculatorDraft || "0";
  if (historyPanel) historyPanel.innerHTML = calculatorHistoryMarkup(form);
}

function evaluateCalculatorExpression(expression) {
  const normalized = String(expression || "")
    .replaceAll("×", "*")
    .replaceAll("÷", "/")
    .replaceAll("−", "-")
    .replace(/[+\-*/.\s]+$/, "");
  if (!normalized || !/^[\d\s()+\-*/.]+$/.test(normalized)) throw new Error("Invalid expression");
  const result = Function(`"use strict"; return (${normalized})`)();
  if (!Number.isFinite(result)) throw new Error("Invalid result");
  return currencyValue(result);
}

function applyCalculatorKey(form, key) {
  let draft = String(form.data.calculatorDraft || "");
  const isDigit = /^\d$/.test(key);
  if (key === "AC") {
    form.data.calculatorDraft = "";
    form.data.calculatorJustEvaluated = false;
    return false;
  }
  if (key === "⌫") {
    form.data.calculatorDraft = draft.slice(0, -1);
    form.data.calculatorJustEvaluated = false;
    return false;
  }
  if (key === "=") {
    const result = evaluateCalculatorExpression(draft);
    form.data.calculatorHistory ||= [];
    form.data.calculatorHistory.push({
      id: uid("calculation"),
      expression: draft,
      result,
      createdAt: new Date().toISOString(),
      authorEmail: currentAccount().email,
    });
    form.data.calculatorHistory = form.data.calculatorHistory.slice(-10);
    form.data.calculatorDraft = String(result);
    form.data.calculatorJustEvaluated = true;
    return true;
  }
  if (isDigit || key === ".") {
    if (form.data.calculatorJustEvaluated) draft = "";
    const currentNumber = draft.split(/[+×÷−]/).at(-1) || "";
    if (key === "." && currentNumber.includes(".")) return false;
    draft += key;
    form.data.calculatorJustEvaluated = false;
  } else if (["+", "−", "×", "÷"].includes(key)) {
    if (!draft) {
      if (key === "−") draft = "−";
      else return false;
    } else if (/[+−×÷]$/.test(draft)) {
      draft = `${draft.slice(0, -1)}${key}`;
    } else {
      draft += key;
    }
    form.data.calculatorJustEvaluated = false;
  } else if (key === "+/-") {
    const match = draft.match(/(-?\d*\.?\d+)$/);
    if (!match) return false;
    const value = match[1].startsWith("-") ? match[1].slice(1) : `-${match[1]}`;
    draft = `${draft.slice(0, -match[1].length)}${value}`;
  } else if (key === "%") {
    const match = draft.match(/(-?\d*\.?\d+)$/);
    if (!match) return false;
    const value = currencyValue(Number(match[1]) / 100);
    draft = `${draft.slice(0, -match[1].length)}${value}`;
  }
  form.data.calculatorDraft = draft.slice(0, 32);
  return false;
}

function updateCalculatorKeyScale(calculator) {
  if (!calculator) return;
  const compactHeight = calculator.clientHeight < 390;
  const horizontalReserve = compactHeight ? 18 : 22;
  const verticalReserve = compactHeight ? 126 : 136;
  const gapRatio = 0.13;
  const widthBound = (calculator.clientWidth - horizontalReserve) / (4 + (3 * gapRatio));
  const heightBound = (calculator.clientHeight - verticalReserve) / (5 + (4 * gapRatio));
  const keySize = Math.max(
    27,
    Math.min(104, widthBound, heightBound),
  );
  const keyGap = Math.max(4, Math.min(14, keySize * gapRatio));
  calculator.style.setProperty("--calculator-key-size", `${keySize.toFixed(2)}px`);
  calculator.style.setProperty("--calculator-key-gap", `${keyGap.toFixed(2)}px`);
}

function observeCalculatorSize(calculator) {
  calculatorResizeObserver?.disconnect();
  calculatorResizeObserver = null;
  if (!calculator) return;
  updateCalculatorKeyScale(calculator);
  if (!("ResizeObserver" in window)) return;
  calculatorResizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => updateCalculatorKeyScale(calculator));
  });
  calculatorResizeObserver.observe(calculator);
}

function beginCalculatorDrag(event) {
  if (event.target.closest("button, input, select, textarea, a")) return;
  const handle = event.target.closest("[data-calculator-drag-handle]");
  const calculator = handle?.closest("[data-draggable-calculator]");
  if (!calculator || calculator.classList.contains("minimized") || event.button !== 0) return;
  const rect = calculator.getBoundingClientRect();
  calculator.style.left = `${rect.left}px`;
  calculator.style.top = `${rect.top}px`;
  calculator.style.right = "auto";
  calculator.style.bottom = "auto";
  calculator.style.transform = "translate3d(0, 0, 0)";
  calculator.classList.add("dragging");
  handle.setPointerCapture?.(event.pointerId);
  calculatorDragState = {
    calculator,
    handle,
    pointerId: event.pointerId,
    formId: calculator.dataset.draggableCalculator,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: rect.left,
    originTop: rect.top,
    maxLeft: Math.max(8, window.innerWidth - rect.width - 8),
    maxTop: Math.max(8, window.innerHeight - rect.height - 8),
    left: rect.left,
    top: rect.top,
    frameId: null,
  };
  event.preventDefault();
}

function moveCalculator(event) {
  const drag = calculatorDragState;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.left = Math.min(drag.maxLeft, Math.max(8, drag.originLeft + event.clientX - drag.startX));
  drag.top = Math.min(drag.maxTop, Math.max(8, drag.originTop + event.clientY - drag.startY));
  if (drag.frameId) return;
  drag.frameId = requestAnimationFrame(() => {
    if (calculatorDragState !== drag) return;
    drag.frameId = null;
    drag.calculator.style.transform =
      `translate3d(${drag.left - drag.originLeft}px, ${drag.top - drag.originTop}px, 0)`;
  });
}

function endCalculatorDrag(event) {
  const drag = calculatorDragState;
  if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
  const { calculator, handle, pointerId, left, top, frameId } = drag;
  if (frameId) cancelAnimationFrame(frameId);
  calculator.style.left = `${left}px`;
  calculator.style.top = `${top}px`;
  calculator.style.transform = "";
  calculator.classList.remove("dragging");
  if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
  calculatorDragState = null;
  saveCalculatorGeometry(calculator);
}

function saveCalculatorGeometry(calculator) {
  const formId = calculator?.dataset?.draggableCalculator;
  const form = appState.forms[formId];
  if (!form) return;
  const rect = calculator.getBoundingClientRect();
  form.data.calculatorPosition = {
    left: Math.round(rect.left || 8),
    top: Math.round(rect.top || 8),
  };
  form.data.calculatorSize = {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  form.updatedAt = new Date().toISOString();
  saveState();
}

function handleCalculatorPointerEnd(event) {
  if (calculatorDragState) {
    endCalculatorDrag(event);
    return;
  }
  if (event.target?.closest?.("button")) return;
  const calculator = event.target?.closest?.("[data-draggable-calculator]");
  if (calculator) saveCalculatorGeometry(calculator);
}

async function prepareProfilePhoto(file) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    throw new Error("Choose a PNG, JPG, or WebP profile photo.");
  }
  if (file.size <= 1024 * 1024) return file;
  if (file.size > 12 * 1024 * 1024) {
    throw new Error("Choose a profile photo smaller than 12 MB.");
  }
  const image = await loadProfilePhotoImage(file);
  const maxDimension = 1200;
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  let quality = 0.86;
  let blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  while (blob?.size > 1024 * 1024 && quality > 0.5) {
    quality -= 0.08;
    blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }
  if (!blob || blob.size > 1024 * 1024) {
    throw new Error("This photo could not be prepared. Choose a smaller image.");
  }
  const baseName = file.name.replace(/\.[^.]+$/, "") || "profile-photo";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

async function loadProfilePhotoImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file);
    } catch {}
  }
  const dataUrl = await fileDataUrl(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This photo could not be opened."));
    image.src = dataUrl;
  });
}

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("This photo could not be read."));
    reader.readAsDataURL(file);
  });
}

async function saveUploadedProfilePhoto(account, field, file, uploaded) {
  const activeAccount = appState.accounts[account.email] || account;
  activeAccount[field] = {
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    ...uploaded,
  };
  if (productionBackend.enabled) {
    await productionBackend.saveNow(appState);
  } else if (!saveState()) {
    throw new Error("The photo could not be saved.");
  }
}

let profilePhotoUpdateInProgress = false;

async function updateProfilePhoto(input, field, category, label) {
  const account = currentAccount();
  if (!account || !input?.files?.[0]) return;
  const previousPhoto = account[field] ? clone(account[field]) : null;
  let file;
  profilePhotoUpdateInProgress = true;
  try {
    showToast(`Preparing ${label.toLowerCase()}...`);
    file = await prepareProfilePhoto(input.files[0]);
    const previewUrl = await fileDataUrl(file);
    account[field] = {
      name: file.name,
      type: file.type,
      size: file.size,
      uploadedAt: new Date().toISOString(),
      dataUrl: previewUrl,
    };
    renderProfile();

    if (productionBackend.enabled) {
      const uploaded = await productionBackend.uploadPrivateFile("profile-photos", file, category);
      await saveUploadedProfilePhoto(account, field, file, uploaded);
    } else {
      await saveUploadedProfilePhoto(account, field, file, { dataUrl: previewUrl });
    }
    renderProfile();
    showToast(`${label} securely updated.`);
  } catch (error) {
    const activeAccount = appState.accounts[account.email] || account;
    activeAccount[field] = previousPhoto;
    renderProfile();
    showToast(error.message || `${label} upload failed.`);
  } finally {
    profilePhotoUpdateInProgress = false;
    input.value = "";
  }
}

function notesPanel(form, readOnly) {
  return `
    <section class="panel" id="notes">
      <div class="panel-heading"><div><h3>Notes</h3><p>Context, questions, and next steps</p></div></div>
      <div class="panel-body field">
        <label class="hidden" for="worksheet-notes">Notes</label>
        <textarea id="worksheet-notes" class="input notes-area" data-path="notes" placeholder="Add notes for yourself or your coach..." ${readOnly ? "disabled" : ""}>${escapeHtml(form.data.notes)}</textarea>
      </div>
    </section>
  `;
}

function summaryPanel(calc) {
  return `
    <div class="summary-panel">
      <h3>Bill summary</h3>
      <div class="summary-list">
        ${summaryRow("This check", money(calc.thisCheck))}
        ${summaryRow("Additional income", money(calc.additionalIncome))}
        ${summaryRow("Total income", money(calc.totalIncome), false, "total-income")}
        ${summaryRow("Tithe (10%)", titheMoney(calc.tithe), false, "tithe")}
        ${summaryRow("Fixed bills", money(calc.fixedBills))}
        ${summaryRow("Credit cards", money(calc.creditCards))}
        ${summaryRow("Debt contributions", money(calc.debtContributions))}
        ${summaryRow("Student loan contributions", money(calc.studentLoanContributions))}
        ${summaryRow("Mortgage contribution", money(calc.mortgageContribution))}
        ${summaryRow("Savings contribution", money(calc.savingsContribution))}
        ${summaryRow("Rollovers", money(calc.allocationTotal), false, "allocation-total")}
        ${summaryRow("Ready to budget", money(calc.available))}
        ${summaryRow("Budgeted", money(calc.variableBudget))}
        ${summaryRow("Total planned outflow", money(calc.totalPlanned))}
        ${calc.approvedBills ? summaryRow("Coach selected this check", money(calc.approvedBills)) : ""}
        ${summaryRow("Left to budget", money(calc.available), true, "available")}
      </div>
    </div>
  `;
}

function summaryRow(label, value, total = false, key = "") {
  return `<div class="summary-row ${total ? "total" : ""}"><span>${label}</span><strong ${key ? `data-live-${key}` : ""}>${value}</strong></div>`;
}

function moneyField(label, path, value, readOnly) {
  return `
    <div class="field">
      <label>${label}</label>
      <div class="money-input-wrap">
        <input class="input" type="text" inputmode="decimal" data-currency-input data-path="${path}" value="${moneyInputValue(value)}" placeholder="0.00" ${readOnly ? "disabled" : ""}>
      </div>
    </div>
  `;
}

function dateField(label, path, value, readOnly) {
  const futurePromoDate = path.toLowerCase().includes("promo") && path.toLowerCase().includes("expiration");
  return `
    <div class="field">
      <label>${label}</label>
      <input class="input" type="date" data-current-calendar ${futurePromoDate ? `min="${todayValue()}" data-future-date-validation` : ""} data-path="${path}" value="${value || ""}" ${readOnly ? "disabled" : ""}>
    </div>
  `;
}

function computedField(label, value, key = "") {
  return `<div class="computed-field"><span>${label}</span><strong ${key ? `data-live-${key}` : ""}>${value}</strong></div>`;
}

function textField(label, path, value, readOnly, placeholder = "") {
  return `
    <div class="field">
      <label>${label}</label>
      <input class="input" data-path="${path}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${readOnly ? "disabled" : ""}>
    </div>
  `;
}

function percentField(label, path, value, readOnly) {
  return `
    <div class="field">
      <label>${label}</label>
      <div class="percent-input-wrap">
        <input class="input" type="text" inputmode="decimal" data-percent-validation data-path="${path}" value="${value}" placeholder="0.00" ${readOnly ? "disabled" : ""}>
      </div>
    </div>
  `;
}

function paymentTimingLabel(value, fallback = "No suggestion") {
  if (value === "this_check") return "Pay this check";
  if (value === "next_check") return "Wait for next check";
  return fallback;
}

function paymentTimingBadge(value, fallback = "No suggestion") {
  return `<span class="decision-label ${value || ""}">${paymentTimingLabel(value, fallback)}</span>`;
}

function memberSuggestionControl(path, value, canEdit) {
  if (!canEdit) return paymentTimingBadge(value, "No suggestion");
  return `
    <select class="table-input member-suggestion-select" data-path="${path}" aria-label="Member payment suggestion">
      <option value="" ${!value ? "selected" : ""}>Suggest plan</option>
      <option value="this_check" ${value === "this_check" ? "selected" : ""}>Pay this check</option>
      <option value="next_check" ${value === "next_check" ? "selected" : ""}>Wait for next check</option>
    </select>
  `;
}

function coachSuggestionReview(rowPath, memberSuggestion, coachDecision) {
  if (!memberSuggestion) {
    return `<div class="member-suggestion-review empty"><span>Member suggestion</span><strong>None yet</strong></div>`;
  }
  const approved = memberSuggestion === coachDecision;
  return `
    <div class="member-suggestion-review ${approved ? "approved" : "pending"}">
      <span>Member suggested</span>
      ${paymentTimingBadge(memberSuggestion)}
      ${
        approved
          ? `<strong>Approved</strong>`
          : `<button class="btn btn-secondary btn-micro" type="button" data-approve-member-suggestion="${rowPath}">Approve</button>`
      }
    </div>
  `;
}

function billDecisionControl(path, value, canEdit, memberSuggestion = "", rowPath = "") {
  if (!canEdit) {
    return paymentTimingBadge(value, "Not reviewed");
  }
  return `
    <div class="decision-stack">
      ${coachSuggestionReview(rowPath, memberSuggestion, value)}
      <select class="table-input" data-path="${path}" aria-label="Coach payment plan">
        <option value="" ${!value ? "selected" : ""}>Choose plan</option>
        <option value="this_check" ${value === "this_check" ? "selected" : ""}>Pay this check</option>
        <option value="next_check" ${value === "next_check" ? "selected" : ""}>Wait for next check</option>
      </select>
    </div>
  `;
}

function memberSuggestionField(path, row, canSuggest) {
  return `<div class="field"><label>Your suggestion</label>${memberSuggestionControl(`${path}.memberSuggestion`, row?.memberSuggestion || "", canSuggest)}</div>`;
}

function coachPlanField(path, row, isCoachReview) {
  return `<div class="field"><label>Coach plan</label>${billDecisionControl(`${path}.coachDecision`, row?.coachDecision || "", isCoachReview, row?.memberSuggestion || "", path)}</div>`;
}

function progressBar(progress, label) {
  return `
    <div class="progress-wrap" aria-label="${escapeHtml(label)}">
      <div class="progress-track"><span style="width:${Math.min(100, Math.max(0, progress))}%"></span></div>
      <small>${escapeHtml(label)}</small>
    </div>
  `;
}

function getAtPath(object, path) {
  return path.split(".").reduce((current, key) => current?.[key], object);
}

function setAtPath(object, path, value) {
  const keys = path.split(".");
  const finalKey = keys.pop();
  const target = keys.reduce((current, key) => current[key], object);
  target[finalKey] = value;
}

function removeAtPath(object, path) {
  const keys = path.split(".");
  const index = Number(keys.pop());
  const target = keys.reduce((current, key) => current[key], object);
  target.splice(index, 1);
}

function applyRecurringBillSuggestion(input, form) {
  const account = appState.accounts[form.ownerEmail];
  const suggestion = account.financialInventory?.recurringBills.find(
    (bill) => bill.name.toLowerCase() === input.value.trim().toLowerCase(),
  );
  if (!suggestion) return;
  const [category, index] = input.dataset.billSuggestion.split(".");
  const bill = form.data.bills[category][Number(index)];
  bill.profileBillId = suggestion.id || "";
  bill.name = suggestion.name;
  bill.dueDate = recurringBillDisplayDueDate(suggestion);
  bill.amount = bill.dueDate ? suggestion.amount : "";
  const dueDateInput = document.querySelector(
    `input[data-path="bills.${category}.${index}.dueDate"]`,
  );
  if (dueDateInput) dueDateInput.value = bill.dueDate;
  const amountInput = document.querySelector(
    `input[data-path="bills.${category}.${index}.amount"]`,
  );
  if (amountInput) amountInput.value = bill.amount;
}

function showBillSelectorModal(form, category, rowIndex) {
  const account = appState.accounts[form.ownerEmail];
  const suggestions = (account?.financialInventory?.recurringBills || [])
    .filter((bill) => bill.name)
    .sort((a, b) => Number(b.category === category) - Number(a.category === category) || a.name.localeCompare(b.name));
  const categoryLabel = Object.fromEntries(billGroups);
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal selector-modal" role="dialog" aria-modal="true" aria-labelledby="bill-selector-title">
      <div class="modal-header"><div><p class="document-label">Saved bills</p><h3 id="bill-selector-title">Choose a bill</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        <div class="selector-option-list">
          ${
            suggestions.length
              ? suggestions.map((bill) => `
                <button class="selector-option" type="button" data-select-bill-target="${category}.${rowIndex}" data-select-bill-id="${escapeHtml(bill.id)}">
                  <span><strong>${escapeHtml(bill.name)}</strong><small>${escapeHtml(categoryLabel[bill.category] || "Other Bills")} · ${recurringBillNextDueDate(bill) ? `${dateLabel(recurringBillNextDueDate(bill))} · ${money(bill.amount)}` : "No due date saved"}</small></span>
                  <i aria-hidden="true">→</i>
                </button>`).join("")
              : emptyInline("No saved bills yet", "Add recurring bills in your financial profile, or type a bill name directly.")
          }
        </div>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function showAllocationSelectorModal(form, allocationIndex) {
  const owner = appState.accounts[form.ownerEmail];
  const groups = [
    ["debt", "Debts", form.data.debts || []],
    ["credit_card", "Credit cards", form.data.creditCards || []],
    ["student_loan", "Student loans", form.data.studentLoans || []],
    ["savings", "Savings accounts", (owner?.savingsInvestmentAccounts || []).filter((item) => item.type === "savings")],
  ];
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal selector-modal" role="dialog" aria-modal="true" aria-labelledby="allocation-selector-title">
      <div class="modal-header"><div><p class="document-label">Rollover</p><h3 id="allocation-selector-title">Choose a rollover target</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        <div class="selector-option-groups">
          ${groups.map(([type, label, rows]) => {
            const available = rows.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => row.account || row.name);
            if (!available.length) return "";
            return `<section><h4>${label}</h4><div class="selector-option-list">${available.map(({ row, rowIndex }) => `
              <button class="selector-option" type="button" data-select-allocation="${allocationIndex}.${type}.${rowIndex}">
                <span><strong>${escapeHtml(row.account || row.name || "Savings account")}</strong><small>${money(row.totalOwed || row.totalBalance || row.paymentDue || row.balance || 0)} tracked</small></span>
                <i aria-hidden="true">→</i>
              </button>`).join("")}</div></section>`;
          }).join("") || emptyInline("No rollover targets available", "Add savings accounts, debts, credit cards, or student loans first.")}
        </div>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function refreshLiveAvailable(form) {
  const calc = calculate(form);
  const mortgagePaymentRemaining = currencyValue(Math.max(
    0,
    (Number(form.data.mortgage.paymentAmount) || 0) - calc.mortgageContribution,
  ));
  document.querySelectorAll("[data-live-available]").forEach((element) => {
    element.textContent = money(calc.available);
  });
  document.querySelectorAll("[data-live-total-income]").forEach((element) => {
    element.textContent = money(calc.totalIncome);
  });
  document.querySelectorAll("[data-live-tithe]").forEach((element) => {
    element.textContent = titheMoney(calc.tithe);
  });
  document.querySelectorAll("[data-live-remaining-before-budget]").forEach((element) => {
    element.textContent = money(calc.available);
  });
  document.querySelectorAll("[data-live-variable-budget]").forEach((element) => {
    element.textContent = money(calc.variableBudget);
  });
  document.querySelectorAll("[data-live-allocation-total]").forEach((element) => {
    element.textContent = money(calc.allocationTotal);
  });
  document.querySelectorAll("[data-live-mortgage-payment-needed]").forEach((element) => {
    element.textContent = money(mortgagePaymentRemaining);
  });
  document.querySelectorAll("[data-live-savings-after]").forEach((element) => {
    element.textContent = money(calc.savingsAfter);
  });
  document.querySelectorAll("[data-live-savings-after-copy]").forEach((element) => {
    element.textContent = `${money(calc.savingsAfter)} saved`;
  });
  document.querySelectorAll("[data-live-savings-remaining-copy]").forEach((element) => {
    element.textContent = `${money(calc.savingsRemaining)} left to reach ${money(calc.savingsGoal)}`;
  });
}

function validateControlledInput(input) {
  if (input.matches("[data-percent-validation]")) {
    const value = Number(input.value);
    const valid = input.value === "" || (Number.isFinite(value) && value >= 0 && value <= 100);
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid) showToast("APR rates must be between 0% and 100%.");
    return valid;
  }
  if (input.matches("[data-future-date-validation]")) {
    const valid = input.value === "" || input.value > todayValue();
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid) showToast("Promotional APR expiration dates must be in the future.");
    return valid;
  }
  return true;
}

function normalizeCurrencyInput(input) {
  if (
    !input?.matches?.("[data-currency-input]") ||
    input.matches("[data-percent-validation]") ||
    input.value === "" ||
    !Number.isFinite(Number(String(input.value).replaceAll(",", "")))
  ) {
    return;
  }
  input.value = moneyInputValue(input.value);
}

function saveAssetHistoryEntry(account, index) {
  const assetAccount = account.savingsInvestmentAccounts[Number(index)];
  if (!assetAccount || assetAccount.balance === "" || !assetAccount.updatedAt) return;
  const existingEntry = [...assetAccount.history]
    .reverse()
    .find((entry) => entry.date === assetAccount.updatedAt);
  if (existingEntry) {
    existingEntry.balance = String(assetAccount.balance);
    existingEntry.recordedAt = new Date().toISOString();
    return;
  }
  assetAccount.history.push({
    id: uid("balance"),
    balance: String(assetAccount.balance),
    date: assetAccount.updatedAt,
    recordedAt: new Date().toISOString(),
  });
}

function recordSavingsWithdrawal(member, savingsAccount, amount, reason, formId = null) {
  const normalizedAmount = currencyValue(amount);
  const normalizedReason = String(reason).trim();
  const duplicate = appState.withdrawals.find(
    (withdrawal) =>
      withdrawal.memberEmail === member.email &&
      withdrawal.assetAccountId === savingsAccount.id &&
      currencyValue(withdrawal.amount) === normalizedAmount &&
      String(withdrawal.reason || "").trim() === normalizedReason &&
      Date.now() - new Date(withdrawal.createdAt || 0).getTime() < 10000,
  );
  if (duplicate) return duplicate;
  const previousBalance = currencyValue(savingsAccount.balance);
  const newBalance = currencyValue(Math.max(0, previousBalance - normalizedAmount));
  const createdAt = new Date().toISOString();
  const withdrawal = {
    id: uid("withdrawal"),
    formId,
    memberEmail: member.email,
    coachEmail: member.coachEmail || null,
    assetAccountId: savingsAccount.id,
    savingsAccountName: savingsAccount.name || "Savings account",
    previousBalance,
    newBalance,
    amount: normalizedAmount,
    reason: normalizedReason,
    createdAt,
    profileApplied: true,
  };
  savingsAccount.balance = String(newBalance);
  savingsAccount.updatedAt = todayValue();
  savingsAccount.history.push({
    id: uid("balance"),
    withdrawalId: withdrawal.id,
    balance: String(newBalance),
    date: todayValue(),
    recordedAt: createdAt,
  });
  withdrawal.updatedSavings = profileSavingsTotal(member);
  appState.withdrawals.push(withdrawal);
  addWithdrawalNotifications(member, withdrawal);
  member.carryForward ||= {};
  member.carryForward.savings = {
    ...(member.carryForward.savings || {}),
    current: String(withdrawal.updatedSavings),
  };
  syncDraftFormsWithFinancialProfile(member);
  return withdrawal;
}

function addWithdrawalNotifications(member, withdrawal) {
  appState.notifications ||= [];
  if (appState.notifications.some((notification) => notification.withdrawalId === withdrawal.id)) return;
  const recipients = [member.email];
  if (member.coachEmail && member.coachRequestStatus === "approved") recipients.push(member.coachEmail);
  recipients.forEach((recipientEmail) => {
    appState.notifications.push({
      id: uid("notification"),
      withdrawalId: withdrawal.id,
      memberEmail: member.email,
      recipientEmail,
      type: "savings_withdrawal",
      title: "Savings withdrawal recorded",
      message: `${money(withdrawal.amount)} withdrawn from ${withdrawal.savingsAccountName}. Reason: ${withdrawal.reason}`,
      createdAt: withdrawal.createdAt,
      readAt: null,
    });
  });
  sendSavingsWithdrawalNotification(member, withdrawal).catch((error) => {
    console.warn("Savings withdrawal notification could not be sent", error);
  });
}

function createForm(assignedPerson = "account_holder") {
  const account = currentAccount();
  if (!account || account.role !== "user") return;
  if (!account.profileCompleted) {
    activeView = "profile";
    render();
    showToast("Complete your financial profile before creating a worksheet.");
    return;
  }
  const form = blankForm(account, getMemberCarryForward(account), assignedPerson);
  appState.forms[form.id] = form;
  saveState();
  activeFormId = form.id;
  activeView = "editor";
  render();
  showToast("New worksheet created");
}

function showNewFormModal() {
  const account = currentAccount();
  if (!account || account.role !== "user") return;
  if (!account.profileCompleted) {
    activeView = "profile";
    render();
    showToast("Complete your financial profile before creating a worksheet.");
    return;
  }
  if (account.profile.maritalStatus !== "married" || !account.profile.spouseName) {
    createForm();
    return;
  }
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="assignment-title">
      <div class="modal-header"><div><p class="document-label">New worksheet</p><h3 id="assignment-title">Who will complete this form?</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
      <div class="modal-body">
        <form id="new-form-assignment-form" class="form-stack">
          <div class="assignment-solo-grid">
            <label class="assignment-choice individual-assignment-choice"><input type="radio" name="assignedPerson" value="account_holder" checked><span>${avatarMarkup(account)}<strong>${escapeHtml(account.name)}</strong><small>Account holder</small><i aria-hidden="true">✓</i></span></label>
            <label class="assignment-choice individual-assignment-choice"><input type="radio" name="assignedPerson" value="spouse"><span>${spouseAvatarMarkup(account)}<strong>${escapeHtml(account.profile.spouseName)}</strong><small>Spouse</small><i aria-hidden="true">✓</i></span></label>
          </div>
          <label class="assignment-choice"><input type="radio" name="assignedPerson" value="both"><span>${formAssigneeAvatar(account, "both")}<strong>${escapeHtml(formAssigneeName(account, "both"))}</strong><small>Complete together</small></span></label>
          <button class="btn btn-primary" type="submit">Create assigned worksheet</button>
        </form>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function showShareModal(formId) {
  const form = appState.forms[formId];
  if (!form) return;
  const calc = calculate(form);
  if (calc.available < 0) {
    showOverBudgetDialog(calc);
    return;
  }
  const account = currentAccount();
  const coach = account.coachEmail ? appState.accounts[account.coachEmail] : null;
  const coachName = coachDisplayName(account, coach);
  const canSend = account.coachEmail && account.coachRequestStatus === "approved";
  const review = worksheetSubmitReview(form, calc);

  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.modal = "share";
  modal.innerHTML = `
    <section class="modal modal-wide submit-review-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div class="modal-header">
        <div><p class="document-label">Final review</p><h3 id="share-title">Review before sending</h3></div>
        <button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <p>Confirm the main numbers below before this worksheet is sent to your coach for review.</p>
        <section class="submit-review-grid" aria-label="Worksheet summary">
          ${metric("Assigned to", form.assignedName || form.ownerName)}
          ${metric("Check date", dateLabel(form.data.overview.checkDate))}
          ${metric("Paycheck", money(calc.thisCheck))}
          ${metric("Tithe", titheMoney(calc.tithe))}
          ${metric("Bills this check", money(review.payNowTotal))}
          ${metric("Left to budget", money(calc.available))}
        </section>
        <div class="submit-review-columns">
          <div class="submit-review-list"><h4>Bills to pay this check</h4>${reviewList(review.payNow, "No bills selected for this check.")}</div>
          <div class="submit-review-list"><h4>Waiting for next check</h4>${reviewList(review.waiting, "No bills are waiting for the next check.")}</div>
          <div class="submit-review-list"><h4>Budget layout</h4>${reviewList(review.budget, "No budget categories entered.")}</div>
          <div class="submit-review-list"><h4>Rollovers</h4>${reviewList(review.rollovers, "No rollovers entered.")}</div>
        </div>
        ${
          canSend
            ? `<div class="share-person designated-coach">
                <div><strong>${escapeHtml(coachName)}</strong><span>${escapeHtml(account.coachEmail)} · Designated coach</span></div>
                <span class="badge green">Connected</span>
              </div>
              <form id="share-form" class="form-stack">
                <input type="hidden" name="email" value="${escapeHtml(account.coachEmail)}">
                <button class="btn btn-primary" type="submit">Confirm and send to coach <span aria-hidden="true">↗</span></button>
              </form>`
            : `<div class="empty-connection">
                <h3>Designate a coach first</h3>
                <p>Your coach must accept your connection request before you can send a finished worksheet.</p>
                <button class="btn btn-primary" type="button" data-open-coach-connection>Go to My coach</button>
              </div>`
        }
      </div>
    </section>
  `;
  modal.dataset.formId = formId;
  document.body.appendChild(modal);
}

function reviewList(items, emptyText) {
  return items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(emptyText)}</p>`;
}

function worksheetDecisionItems(form) {
  const payNow = [];
  const waiting = [];
  const pushItem = (row, label, amount, dueDate = "") => {
    const value = currencyValue(amount);
    if (!label || !value) return;
    const item = { label, amount: value, dueDate };
    (row?.coachDecision === "next_check" ? waiting : payNow).push(item);
  };
  Object.values(form.data.bills || {})
    .flat()
    .filter((bill) => bill.name)
    .forEach((bill) => pushItem(bill, bill.name, bill.amount, bill.dueDate));
  (form.data.creditCards || [])
    .filter((card) => card.account)
    .forEach((card) => pushItem(card, `Credit card: ${card.account}`, card.contribution, card.dueDate));
  (form.data.debts || [])
    .filter((debt) => debt.account)
    .forEach((debt) => pushItem(debt, `Debt: ${debt.account}`, debt.contribution, debt.dueDate));
  (form.data.studentLoans || [])
    .filter((loan) => loan.account)
    .forEach((loan) => pushItem(loan, `Student loan: ${loan.account}`, loan.contribution, loan.dueDate));
  if (form.data.housingPaymentType === "mortgage") {
    const mortgage = form.data.mortgage || {};
    pushItem(mortgage, "Mortgage contribution", mortgage.contribution, mortgage.mustPayBy || mortgage.nextDueDate);
  }
  pushItem(form.data.savings, "Savings contribution", form.data.savings?.contribution);
  (form.data.allocations || [])
    .filter((item) => item.account || item.amount)
    .forEach((item) => pushItem(item, `Rollover to ${item.account || item.type?.replaceAll("_", " ") || "selected account"}`, item.amount));
  return { payNow, waiting };
}

function paymentItemLine(item) {
  return `${item.label} - ${money(item.amount)}${item.dueDate ? ` due ${dateLabel(item.dueDate)}` : ""}`;
}

function worksheetSubmitReview(form, calc) {
  const decisionItems = worksheetDecisionItems(form);
  const payNow = decisionItems.payNow.map(paymentItemLine);
  const waiting = decisionItems.waiting.map(paymentItemLine);
  const budget = (form.data.variableSpending || [])
    .filter((item) => item.category || currencyValue(item.budgeted))
    .map((item) => `${item.category || "Budget item"} - ${money(item.budgeted)} · ${paymentTimingLabel(item.coachDecision, "Pay this check")}`);
  const rollovers = (form.data.allocations || [])
    .filter((item) => item.account || currencyValue(item.amount))
    .map((item) => `${item.account || item.type?.replaceAll("_", " ") || "Rollover"} - ${money(item.amount)}`);
  return {
    payNow,
    waiting,
    budget,
    rollovers,
    payNowTotal: decisionItems.payNow.reduce((sum, item) => sum + item.amount, 0),
    totalPlanned: calc.totalPlanned,
  };
}

function showOverBudgetDialog(calc) {
  document.querySelectorAll('[data-modal="over-budget"]').forEach((modal) => modal.remove());
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.modal = "over-budget";
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="over-budget-title">
      <div class="modal-header">
        <div><p class="document-label">Worksheet needs adjustment</p><h3 id="over-budget-title">Reduce the budget first</h3></div>
        <button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <p>Your worksheet cannot be sent while planned expenses are higher than the money available for this check.</p>
        <div class="over-budget-summary">
          <div><span>Amount to reduce</span><strong>${money(Math.abs(calc.available))}</strong></div>
          <div><span>Total planned outflow</span><strong>${money(calc.totalPlanned)}</strong></div>
        </div>
        <p>Reduce budget categories, bills, contributions, or rollovers until <strong>Left to budget</strong> is $0.00 or higher.</p>
        <button class="btn btn-primary" type="button" data-close-modal>Review worksheet</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function printList(items, emptyText = "None recorded") {
  return items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p>${escapeHtml(emptyText)}</p>`;
}

function printWorksheetSummary(formId) {
  const form = appState.forms[formId];
  const member = form ? appState.accounts[form.ownerEmail] : null;
  if (!form || !member) {
    showToast("That worksheet is not available to print.");
    return;
  }
  const calc = calculate(form);
  const latestSession = appState.sessions
    .filter((session) => session.formId === form.id)
    .sort((a, b) => new Date(b.sessionDate) - new Date(a.sessionDate))[0];
  const decisionItems = worksheetDecisionItems(form);
  const billsPaid = decisionItems.payNow.map(paymentItemLine);
  const billsRemaining = decisionItems.waiting.map(paymentItemLine);
  const mortgagePaymentRemaining = currencyValue(Math.max(
    0,
    (Number(form.data.mortgage.paymentAmount) || 0) - calc.mortgageContribution,
  ));
  const budgetRows = (form.data.variableSpending || [])
    .filter((item) => item.category || Number(item.budgeted))
    .map((item) => `${item.category || "Budget item"} - ${money(item.budgeted)} · ${paymentTimingLabel(item.coachDecision, "Pay this check")}`);
  const allocations = (form.data.allocations || [])
    .filter((item) => item.account || Number(item.amount))
    .map((item) => `${item.account || item.type.replaceAll("_", " ")} - ${money(item.amount)}`);
  const savingsWithdrawals = appState.withdrawals
    .filter((item) => item.formId === form.id)
    .map((item) => `${item.savingsAccountName || "Savings"} - ${money(item.amount)}: ${item.reason}`);
  const report = window.open("", "_blank");
  if (!report) {
    showToast("Allow pop-ups to open the printable PDF summary.");
    return;
  }
  report.opener = null;
  report.document.open();
  report.document.write(`<!doctype html><html><head><title>F.I.T. Summary - ${escapeHtml(form.assignedName || member.name)}</title>
    <style>
      @page{size:letter;margin:.55in}*{box-sizing:border-box}html,body{background:#fff!important}body{margin:0;color:#17233a;font:10.5pt Arial,sans-serif;line-height:1.42;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1,h2,h3{color:#0d2859;margin:0}h1{font-size:21pt}h2{margin:18px 0 8px;border-bottom:2px solid #c99a27;padding-bottom:5px;font-size:14pt}.header{display:flex;justify-content:space-between;gap:20px;border-bottom:4px solid #0d2859;padding-bottom:14px}.brand{color:#a87913;font-weight:800;letter-spacing:.08em}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.fact{border:1px solid #d8dee8;background:#fff;padding:8px;break-inside:avoid}.fact span{display:block;color:#68758a;font-size:7.5pt;font-weight:700;text-transform:uppercase}.fact strong{display:block;margin-top:3px;font-size:10.5pt}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}.three{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.section{break-inside:avoid}.section ul{margin:0;padding-left:18px}.note{border-left:4px solid #c99a27;background:#f7f4ec;padding:9px;white-space:pre-wrap}.footer{margin-top:22px;border-top:1px solid #d8dee8;padding-top:8px;color:#68758a;font-size:8pt}@media print{html,body{background:#fff!important}button{display:none}}
    </style></head><body>
    <header class="header"><div><div class="brand">F.I.T. FINANCIAL INTEGRITY TRAINING</div><h1>Session Summary</h1><p>${escapeHtml(form.title)}</p></div><div><strong>Prepared</strong><br>${escapeHtml(dateLabel((latestSession?.sessionDate || form.updatedAt || form.createdAt).slice(0,10)))}</div></header>
    <h2>Paycheck details</h2><div class="grid">
      <div class="fact"><span>Name</span><strong>${escapeHtml(form.assignedName || member.name)}</strong></div>
      <div class="fact"><span>Check date</span><strong>${escapeHtml(dateLabel(form.data.overview.checkDate))}</strong></div>
      <div class="fact"><span>Paycheck amount</span><strong>${money(calc.thisCheck)}</strong></div>
      <div class="fact"><span>Additional income</span><strong>${money(calc.additionalIncome)}</strong></div>
      <div class="fact"><span>Total income</span><strong>${money(calc.totalIncome)}</strong></div>
      <div class="fact"><span>Tithe</span><strong>${titheMoney(calc.tithe)}</strong></div>
      <div class="fact"><span>Budgeted</span><strong>${money(calc.variableBudget)}</strong></div>
      <div class="fact"><span>Ready to budget</span><strong>${money(calc.available)}</strong></div>
      ${
        form.data.housingPaymentType === "mortgage"
          ? `<div class="fact"><span>Mortgage payment</span><strong>${money(form.data.mortgage.paymentAmount)}</strong></div>
             <div class="fact"><span>Mortgage contribution</span><strong>${money(calc.mortgageContribution)}</strong></div>
             <div class="fact"><span>Mortgage still needed</span><strong>${money(mortgagePaymentRemaining)}</strong></div>`
          : ""
      }
    </div>
    <div class="two"><section class="section"><h2>Bills to Pay This Check</h2>${printList(billsPaid)}</section><section class="section"><h2>Future Bills / Waiting for Next Check</h2>${printList(billsRemaining)}</section></div>
    <section class="section"><h2>Budget layout</h2>${printList(budgetRows, "No budget categories recorded")}</section>
    <div class="two"><section class="section"><h2>Rollovers</h2>${printList(allocations)}</section><section class="section"><h2>Savings Withdrawals</h2>${printList(savingsWithdrawals)}</section></div>
    <h2>Session notes</h2><div class="three">
      <section class="section"><h3>Coach notes</h3><div class="note">${escapeHtml(latestSession?.coachNotes || "N/A")}</div></section>
      <section class="section"><h3>Next steps</h3><div class="note">${escapeHtml(latestSession?.actionSteps || "N/A")}</div></section>
      <section class="section"><h3>Worksheet notes</h3><div class="note">${escapeHtml(form.data.notes || "N/A")}</div></section>
    </div>
    <footer class="footer">F.I.T. was created by Pastor A. Griffith of God Cannot Lie Ministries.</footer>
    <script>window.addEventListener("load",()=>setTimeout(()=>window.print(),300));<\/script></body></html>`);
  report.document.close();
}

function showWithdrawalModal(formId) {
  const form = appState.forms[formId];
  if (!form) return;
  const member = appState.accounts[form.ownerEmail];
  const savingsAccounts = (member?.savingsInvestmentAccounts || []).filter(
    (account) => account.type === "savings",
  );
  const calc = calculate(form);
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.modal = "withdrawal";
  modal.dataset.formId = formId;
  modal.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="withdraw-title">
      <div class="modal-header">
        <h3 id="withdraw-title">Savings withdrawal</h3>
        <button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <p>Available savings: <strong>${money(calc.savingsAfter)}</strong>. Your designated coach will receive the reason and updated savings amount.</p>
        <form id="withdrawal-form" class="form-stack">
          ${
            savingsAccounts.length
              ? `<div class="field"><label for="withdrawal-account">Savings account</label><select id="withdrawal-account" class="input" name="assetAccountId" required><option value="">Select savings account</option>${savingsAccounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name || "Savings account")} · ${money(account.balance)}</option>`).join("")}</select></div>`
              : `<p class="quiet-message">This withdrawal will update worksheet savings only because no savings account exists in the Financial Profile.</p>`
          }
          ${moneyField("Withdrawal amount", "modal.withdrawal", "", false).replace('data-path="modal.withdrawal"', 'name="amount"')}
          <div class="field">
            <label for="withdrawal-reason">Reason for withdrawal</label>
            <textarea id="withdrawal-reason" class="input" name="reason" required placeholder="Explain why these savings are needed"></textarea>
          </div>
          <button class="btn btn-primary" type="submit">Record withdrawal and notify coach</button>
        </form>
      </div>
    </section>
  `;
  document.body.appendChild(modal);
}

function showProfileWithdrawalModal(index) {
  const account = currentAccount();
  const savingsAccount = account.savingsInvestmentAccounts[Number(index)];
  if (!savingsAccount || savingsAccount.type !== "savings") return;
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.dataset.assetIndex = String(index);
  modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><h3>Savings withdrawal</h3><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div><div class="modal-body"><p><strong>${escapeHtml(savingsAccount.name || "Savings account")}</strong> currently has ${money(savingsAccount.balance)}.</p><form id="profile-withdrawal-form" class="form-stack"><div class="field"><label>Withdrawal amount</label><input class="input" name="amount" type="number" min=".01" step=".01" required></div><div class="field"><label>Withdrawal reason</label><textarea class="input" name="reason" required></textarea></div><button class="btn btn-primary" type="submit">Save withdrawal</button></form></div></section>`;
  document.body.appendChild(modal);
}

async function approveForm(formId, coachNotes = "", actionSteps = "") {
  const coach = currentAccount();
  const form = appState.forms[formId];
  if (!form || coach.role !== "coach" || appState.accounts[form.ownerEmail]?.coachEmail !== coach.email) return;
  const member = appState.accounts[form.ownerEmail];
  const calc = calculate(form);
  form.status = "approved";
  form.approvedAt = new Date().toISOString();
  form.approvedBy = coach.email;
  const mortgagePaymentRemaining = currencyValue(Math.max(
    0,
    (Number(form.data.mortgage.paymentAmount) || 0) - calc.mortgageContribution,
  ));
  member.carryForward = {
    bills: Object.fromEntries(
      billGroups.map(([key]) => [
        key,
        form.data.bills[key]
          .filter((bill) => bill.coachDecision === "next_check")
          .map((bill) => clone(bill)),
      ]),
    ),
    mortgage: {
      totalAmount: form.data.mortgage.totalAmount,
      interestRate: form.data.mortgage.interestRate,
      currentBalance: calc.mortgageAfter === 0 ? "0.00" : String(calc.mortgageAfter || ""),
      paymentAmount: form.data.mortgage.paymentAmount,
      nextDueDate: form.data.mortgage.nextDueDate,
      mustPayBy: form.data.mortgage.mustPayBy,
      remainingBefore: String(mortgagePaymentRemaining),
    },
    creditCards: form.data.creditCards
      .filter((card) => card.account)
      .map((card) => ({
        account: card.account,
        dueDate: card.dueDate,
        totalBalance: String(remainingAfterPlannedPayment(card, form, "credit_card")),
        lastStatementBalance: card.lastStatementBalance || "",
        paymentDue: card.paymentDue || "",
        allowance: card.allowance || "",
        apr: card.apr,
        promoType: card.promoType || "none",
        purchasePromoRate: card.purchasePromoRate || "",
        purchasePromoExpiration: card.purchasePromoExpiration || "",
        balanceTransferPromoRate: card.balanceTransferPromoRate || "",
        balanceTransferPromoExpiration: card.balanceTransferPromoExpiration || "",
      })),
    savings: {
      goal: form.data.savings.goal,
      current: calc.savingsAfter === 0 ? "0.00" : String(calc.savingsAfter || ""),
    },
    debts: form.data.debts
      .filter((debt) => debt.account)
      .map((debt) => ({
        ...clone(debt),
        totalOwed: String(remainingAfterPlannedPayment(debt, form, "debt")),
        contribution: "",
      })),
    studentLoans: (form.data.studentLoans || [])
      .filter((loan) => loan.account)
      .map((loan) => ({
        ...clone(loan),
        totalOwed: String(remainingAfterPlannedPayment(loan, form, "student_loan")),
        contribution: "",
      })),
  };
  const existingRecurringBills = member.financialInventory.recurringBills || [];
  applySavingsRollovers(member, form);
  const worksheetRecurringBills = billGroups.flatMap(([key]) =>
    form.data.bills[key]
      .filter((bill) => bill.name)
      .map((bill) => {
        const previousBill = existingRecurringBills.find(
          (item) =>
            item.category === key &&
            String(item.name || "").trim().toLowerCase() === String(bill.name || "").trim().toLowerCase(),
        );
        const billWasPaidThisCheck = bill.coachDecision !== "next_check";
        const previousScheduleDisabled = recurringScheduleExplicitlyDisabled(previousBill);
        const scheduleEnabled = previousScheduleDisabled
          ? false
          : recurringScheduleEnabledFromBill(
              bill,
              previousBill?.dueDay || bill.dueDay || "",
              previousBill?.monthlyAmount || bill.monthlyAmount || "",
            );
        return normalizeRestoredRecurringBill(
          {
            ...bill,
            id: bill.profileBillId || bill.id || previousBill?.id || "",
            scheduleEnabled,
            dueDay: scheduleEnabled ? previousBill?.dueDay || bill.dueDay || "" : "",
            nextDueDate: billWasPaidThisCheck ? "" : previousBill?.nextDueDate || bill.dueDate || "",
            paidDueDate: billWasPaidThisCheck ? bill.dueDate || previousBill?.paidDueDate || "" : previousBill?.paidDueDate || "",
            monthlyAmount: scheduleEnabled ? previousBill?.monthlyAmount || bill.monthlyAmount || bill.amount || "" : "",
          },
          key,
        );
      }),
  );
  member.financialInventory.recurringBills = mergeRecurringBills(existingRecurringBills, worksheetRecurringBills);
  member.financialInventory.creditCards = clone(member.carryForward.creditCards || []);
  member.financialInventory.debts = clone(member.carryForward.debts || []);
  member.financialInventory.studentLoans = clone(member.carryForward.studentLoans || []);
  member.financialInventory.mortgage = clone(member.carryForward.mortgage || {});
  const sessionReview = createSessionReview(form, coach, coachNotes, actionSteps);
  appState.sessions.push(sessionReview);
  autoArchivePreviousSessionReviews(appState);
  saveState();
  await productionBackend.saveNow?.(appState);
  const emailResult = await sendSessionCompletedEmail(form, sessionReview);
  const emailStatus = emailDeliveryMessage(emailResult, notificationEmailsForForm(form));
  activeFormId = null;
  activeView = "dashboard";
  render();
  showToast(`Session completed. Review generated and balances carried forward.${emailStatus}`);
}

function showToast(message) {
  hidePageLoading();
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function hidePageLoading() {
  clearTimeout(pageLoadingTimer);
  clearTimeout(pageLoadingHideTimer);
  pageLoadingTimer = null;
  pageLoadingHideTimer = null;
  document.getElementById("page-loader")?.classList.remove("show");
  document.body.removeAttribute("aria-busy");
}

function showPageLoading(message = "Updating your F.I.T. workspace...") {
  hidePageLoading();
  let loader = document.getElementById("page-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "page-loader";
    loader.className = "page-loader";
    loader.setAttribute("role", "status");
    loader.setAttribute("aria-live", "polite");
    loader.innerHTML = `<span class="page-loader-spinner" aria-hidden="true"></span><strong></strong>`;
    document.body.appendChild(loader);
  }
  loader.querySelector("strong").textContent = message;
  pageLoadingTimer = setTimeout(() => {
    loader.classList.add("show");
    document.body.setAttribute("aria-busy", "true");
    pageLoadingHideTimer = setTimeout(hidePageLoading, 8000);
  }, 180);
}

function verificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function beginVerification(email) {
  const normalizedEmail = normalizeEmail(email);
  if (productionBackend.enabled) {
    if (!validEmail(normalizedEmail)) {
      showToast("Enter a valid email address first.");
      return;
    }
    try {
      await productionBackend.resendVerification(normalizedEmail);
      pendingVerificationEmail = normalizedEmail;
      confirmationResendNeeded = false;
      loginMode = "verify";
      renderLogin();
      showToast("Confirmation link sent. Check your email.");
    } catch (error) {
      showToast(authErrorMessage(error, "send the confirmation email"));
    }
    return;
  }
  const account = appState.accounts[normalizedEmail];
  if (!account) {
    showToast("Create an account before requesting verification.");
    return;
  }
  account.verified = true;
  account.verificationCode = null;
  loginMode = "signin";
  saveState();
  renderLogin();
  showToast("Preview account is ready. Proceed to login.");
}

async function signIn(email, password, role) {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) {
    showToast("Enter a valid email address.");
    return;
  }
  if (productionBackend.enabled) {
    try {
      const { user } = await productionBackend.signIn({ email: normalizedEmail, password });
      const registeredRole = user?.user_metadata?.role || "user";
      if (registeredRole !== role) {
        await productionBackend.signOut();
        showToast(`This account is registered as a ${registeredRole === "coach" ? "coach" : "member"}.`);
        return;
      }
      portalDataReady = false;
      renderPortalStatusPage("loading");
      appState = await productionBackend.hydrate({ requireSession: true });
      portalDataReady = true;
      await completePendingCoachInvite();
      activeView = currentAccount()?.profileCompleted ? "dashboard" : "profile";
      activeFormId = null;
      render();
    } catch (error) {
      if (error?.code === "FIT_ACCOUNT_DELETED") {
        clearAccountForAuthEnd("deleted");
        return;
      }
      if (error?.code === "FIT_SESSION_EXPIRED") {
        clearAccountForAuthEnd("expired");
        return;
      }
      if (emailConfirmationRequired(error)) {
        pendingVerificationEmail = normalizedEmail;
        confirmationResendNeeded = true;
        loginMode = "verify";
        renderLogin();
      } else if (portalDataReady === false) {
        portalLoadError = error;
        renderPortalStatusPage("temporary");
      }
      showToast(authErrorMessage(error, "sign in"));
    }
    return;
  }
  const existing = appState.accounts[normalizedEmail];
  if (!existing || existing.role !== role || existing.password !== password) {
    showToast("Email, password, or account type is incorrect.");
    return;
  }
  if (!existing.verified) {
    beginVerification(normalizedEmail);
    return;
  }
  if (existing.role !== role) {
    showToast(`This email is already registered as a ${existing.role}.`);
    return;
  }
  appState.sessionEmail = normalizedEmail;
  ensureAccountModel(existing);
  activeView = existing.profileCompleted ? "dashboard" : "profile";
  activeFormId = null;
  saveState();
  render();
}

async function createAccount(name, email, password, role) {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) {
    showToast("Enter a valid email address. Yahoo and other major email providers are supported.");
    return;
  }
  if (String(password || "").length < 8) {
    showToast("Create a password with at least 8 characters.");
    return;
  }
  if (productionBackend.enabled) {
    try {
      await productionBackend.signUp({ name: name.trim(), email: normalizedEmail, password, role });
      pendingVerificationEmail = normalizedEmail;
      confirmationResendNeeded = false;
      loginMode = "verify";
      renderLogin();
      showToast("Click the confirmation link in your email, then sign in.");
    } catch (error) {
      showToast(authErrorMessage(error, "create the account"));
    }
    return;
  }
  if (appState.accounts[normalizedEmail]) {
    showToast("An account already exists for this email.");
    return;
  }
  appState.accounts[normalizedEmail] = {
    name: name.trim(),
    email: normalizedEmail,
    password,
    role,
    verified: true,
    verificationCode: null,
    coachEmail: null,
    coachRequestStatus: null,
    profileCompleted: false,
    preferences: { theme: "light", billReminderDaysAhead: 5 },
    profilePhoto: null,
    carryForward: {},
    profile: {
      maritalStatus: "",
      spouseName: "",
      phone: "",
      address: "",
      employer: "",
      payFrequency: "",
    },
    paystubs: [],
    savingsInvestmentAccounts: [],
    financialInventory: {
      recurringBills: [],
      creditCards: [],
      debts: [],
    },
  };
  saveState();
  pendingVerificationEmail = normalizedEmail;
  confirmationResendNeeded = false;
  loginMode = "verify";
  renderLogin();
}

document.addEventListener("click", (event) => {
  const remoteAction = event.target.closest(
    [
      "[data-save-form]",
      "[data-save-financial-profile]",
      "[data-mark-upcoming-paid]",
      "[data-confirm-remove-mentee]",
      "[data-coach-request-action]",
      "[data-invite-action]",
    ].join(","),
  );
  if (remoteAction) showPageLoading();
}, true);

document.addEventListener("submit", (event) => {
  const remoteForm = event.target.closest(
    [
      "#coach-invite-form",
      "#coach-request-form",
      "#session-completion-form",
      "#withdrawal-form",
      "#profile-withdrawal-form",
      "#request-account-deletion-form",
      "#complete-account-deletion-form",
      "#password-reset-request-form",
      "#password-update-form",
      "#bill-scan-upload-form",
      "#bill-scan-confirm-form",
    ].join(","),
  );
  if (remoteForm) showPageLoading();
}, true);

function revealNewEntry(path, profile = false) {
  const attribute = profile ? "data-profile-path" : "data-path";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const firstField = document.querySelector(`[${attribute}^="${path}.0."]`);
      const entry = firstField?.closest(
        ".profile-inventory-card, .debt-entry, .routing-row, tr",
      );
      (entry || firstField)?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (firstField?.matches("input, select, textarea")) {
        firstField.focus({ preventScroll: true });
      }
    });
  });
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-clear-data-signin]")) {
    initializePortal();
    return;
  }

  if (event.target.closest("[data-retry-page]")) {
    portalDataReady = false;
    await initializePortal();
    return;
  }

  if (event.target.closest("[data-retry-live-page]")) {
    removePortalRetryBanner();
    await refreshPortalFromBackend();
    return;
  }

  const changePhotoButton = event.target.closest("[data-change-photo]");
  if (changePhotoButton) {
    const selector = changePhotoButton.dataset.changePhoto === "spouse"
      ? "[data-spouse-photo-upload]"
      : "[data-profile-photo-upload]";
    const input = changePhotoButton.closest(".profile-photo-panel")?.querySelector(selector);
    input?.click();
    return;
  }

  const calculatorKey = event.target.closest("[data-calculator-key]");
  if (calculatorKey) {
    const form = appState.forms[calculatorKey.dataset.calculatorFormId];
    if (!form) return;
    const calculator = calculatorKey.closest("[data-draggable-calculator]");
    calculatorInteractionUntil = Date.now() + 2500;
    saveCalculatorGeometry(calculator);
    try {
      const completed = applyCalculatorKey(form, calculatorKey.dataset.calculatorKey);
      form.updatedAt = new Date().toISOString();
      saveState();
      refreshCalculatorDisplay(calculator, form);
      if (completed) showToast("Calculation saved to the recent list.");
    } catch {
      showToast("That calculation could not be completed.");
    }
    return;
  }

  const calculatorMinimize = event.target.closest("[data-toggle-calculator-minimize]");
  if (calculatorMinimize) {
    const form = appState.forms[calculatorMinimize.dataset.toggleCalculatorMinimize];
    if (!form) return;
    if (!form.data.calculatorMinimized) {
      saveCalculatorGeometry(calculatorMinimize.closest("[data-draggable-calculator]"));
    }
    form.data.calculatorMinimized = !form.data.calculatorMinimized;
    if (form.data.calculatorMinimized) form.data.calculatorHistoryOpen = false;
    saveState();
    renderEditor();
    return;
  }

  const calculatorHistoryToggle = event.target.closest("[data-toggle-calculator-history]");
  if (calculatorHistoryToggle) {
    const form = appState.forms[calculatorHistoryToggle.dataset.toggleCalculatorHistory];
    const calculator = calculatorHistoryToggle.closest("[data-draggable-calculator]");
    if (!form || !calculator) return;
    form.data.calculatorHistoryOpen = !form.data.calculatorHistoryOpen;
    calculator.classList.toggle("history-open", form.data.calculatorHistoryOpen);
    calculatorHistoryToggle.setAttribute("aria-expanded", form.data.calculatorHistoryOpen ? "true" : "false");
    calculatorHistoryToggle.setAttribute("aria-label", form.data.calculatorHistoryOpen ? "Hide recent calculations" : "Show recent calculations");
    calculatorHistoryToggle.title = form.data.calculatorHistoryOpen ? "Hide recent calculations" : "Show recent calculations";
    saveState();
    return;
  }

  const readNotification = event.target.closest("[data-read-notification]");
  if (readNotification) {
    const account = currentAccount();
    const notification = (appState.notifications || []).find(
      (item) =>
        item.id === readNotification.dataset.readNotification &&
        normalizeEmail(item.recipientEmail) === normalizeEmail(account.email),
    );
    if (!notification) return;
    notification.readAt = new Date().toISOString();
    saveState();
    renderDashboard();
    return;
  }

  const deleteNotification = event.target.closest("[data-delete-notification]");
  if (deleteNotification) {
    const account = currentAccount();
    const notificationIndex = (appState.notifications || []).findIndex(
      (item) =>
        item.id === deleteNotification.dataset.deleteNotification &&
        normalizeEmail(item.recipientEmail) === normalizeEmail(account.email),
    );
    if (notificationIndex < 0) return;
    const [notification] = appState.notifications.splice(notificationIndex, 1);
    if (notification.milestoneKey) {
      appState.dismissedMilestoneKeys ||= [];
      if (!appState.dismissedMilestoneKeys.includes(notification.milestoneKey)) {
        appState.dismissedMilestoneKeys.push(notification.milestoneKey);
      }
    }
    saveState();
    renderDashboard();
    showToast("Notification deleted.");
    return;
  }

  if (event.target.closest("[data-cancel-delete-verification]")) {
    history.replaceState({}, "", window.location.pathname);
    loginMode = "signin";
    render();
    return;
  }

  const loginModeButton = event.target.closest("[data-login-mode]");
  if (loginModeButton) {
    loginMode = loginModeButton.dataset.loginMode;
    if (loginMode !== "verify") {
      pendingVerificationEmail = null;
      confirmationResendNeeded = false;
    }
    renderLogin();
    return;
  }

  const roleButton = event.target.closest("[data-login-role]");
  if (roleButton) {
    loginRole = roleButton.dataset.loginRole;
    renderLogin();
    return;
  }

  if (event.target.closest("[data-resend-verification]") && pendingVerificationEmail) {
    await beginVerification(pendingVerificationEmail);
    return;
  }

  const demoButton = event.target.closest("[data-demo]");
  if (demoButton) {
    appState.sessionEmail = demoButton.dataset.demo;
    activeView = "dashboard";
    lastUserActivityAt = Date.now();
    saveState();
    render();
    return;
  }

  const coachRequestAction = event.target.closest("[data-coach-request-action]");
  if (coachRequestAction) {
    const request = appState.coachRequests.find(
      (item) => item.id === coachRequestAction.dataset.requestId,
    );
    if (!request) return;
    request.status = coachRequestAction.dataset.coachRequestAction;
    request.respondedAt = new Date().toISOString();
    const member = appState.accounts[request.memberEmail];
    member.coachRequestStatus = request.status;
    member.coachEmail = request.status === "approved" ? request.coachEmail : null;
    saveState();
    renderCoachConnection();
    showToast(request.status === "approved" ? "Mentee request accepted" : "Mentee request declined");
    return;
  }

  const approveButton = event.target.closest("[data-approve-form]");
  if (approveButton) {
    showSessionCompletionModal(approveButton.dataset.approveForm);
    return;
  }

  const withdrawalButton = event.target.closest("[data-withdraw-savings]");
  if (withdrawalButton) {
    const member = currentAccount();
    showWithdrawalModal(withdrawalButton.dataset.withdrawSavings);
    return;
  }

  const profileWithdrawalButton = event.target.closest("[data-withdraw-profile-savings]");
  if (profileWithdrawalButton) {
    showProfileWithdrawalModal(profileWithdrawalButton.dataset.withdrawProfileSavings);
    return;
  }

  if (event.target.closest("[data-open-bill-scan]")) {
    showBillScanUploadModal();
    return;
  }

  const promoToggle = event.target.closest("[data-promo-toggle]");
  if (promoToggle && activeFormId) {
    const form = appState.forms[activeFormId];
    form.data.debts[Number(promoToggle.dataset.promoToggle)].promotionalRateApplied =
      promoToggle.checked;
    form.updatedAt = new Date().toISOString();
    saveState();
    renderEditor();
    return;
  }

  const deletePaystub = event.target.closest("[data-delete-paystub]");
  if (deletePaystub) {
    const account = currentAccount();
    account.paystubs = account.paystubs.filter(
      (paystub) => paystub.id !== deletePaystub.dataset.deletePaystub,
    );
    saveState();
    renderProfile();
    showToast("Paystub deleted");
    return;
  }

  const addProfileItem = event.target.closest("[data-add-profile-item]");
  if (addProfileItem) {
    const account = currentAccount();
    ensureFinancialInventory(account);
    const type = addProfileItem.dataset.addProfileItem;
    if (type === "recurringBills") account.financialInventory.recurringBills.unshift(blankRecurringBill());
    if (type === "creditCards") account.financialInventory.creditCards.unshift(blankProfileCard());
    if (type === "debts") account.financialInventory.debts.unshift(blankProfileDebt());
    if (type === "studentLoans") account.financialInventory.studentLoans.unshift(blankStudentLoan());
    saveState();
    renderProfile();
    revealNewEntry(`financialInventory.${type}`, true);
    return;
  }

  const saveProfileButton = event.target.closest("[data-save-financial-profile]");
  if (saveProfileButton) {
    event.preventDefault();
    settleFinancialProfileSaveFocus(saveProfileButton);
    await saveFinancialProfileNow();
    settleFinancialProfileSaveFocus(saveProfileButton);
    return;
  }

  if (event.target.closest("[data-request-account-deletion]")) {
    showDeleteAccountModal();
    return;
  }

  const deleteSessionReview = event.target.closest("[data-delete-session-review]");
  if (deleteSessionReview) {
    const account = currentAccount();
    const session = appState.sessions.find(
      (item) =>
        item.id === deleteSessionReview.dataset.deleteSessionReview &&
        (normalizeEmail(item.memberEmail) === normalizeEmail(account.email) ||
          (account.role === "coach" &&
            normalizeEmail(item.coachEmail) === normalizeEmail(account.email))),
    );
    if (!session) {
      showToast("This session review is not available.");
      return;
    }
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.dataset.sessionId = session.id;
    modal.innerHTML = `
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-session-review-title">
        <div class="modal-header"><div><p class="eyebrow">Session history</p><h3 id="delete-session-review-title">Delete this session review?</h3></div><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div>
        <div class="modal-body"><p>This removes the review, coach notes, action steps, and feedback from the shared session history. This cannot be undone.</p><button class="btn btn-danger" type="button" data-confirm-delete-session-review>Delete review</button><button class="btn btn-secondary" type="button" data-close-modal>Cancel</button></div>
      </section>
    `;
    document.body.appendChild(modal);
    return;
  }

  if (event.target.closest("[data-confirm-delete-session-review]")) {
    const modal = event.target.closest(".modal-backdrop");
    const account = currentAccount();
    const session = appState.sessions.find(
      (item) =>
        item.id === modal?.dataset.sessionId &&
        (normalizeEmail(item.memberEmail) === normalizeEmail(account.email) ||
          (account.role === "coach" &&
            normalizeEmail(item.coachEmail) === normalizeEmail(account.email))),
    );
    if (!session) {
      modal?.remove();
      showToast("This session review is not available.");
      return;
    }
    appState.sessions = appState.sessions.filter((item) => item.id !== session.id);
    saveState();
    modal.remove();
    renderSessions();
    showToast("Session review deleted");
    return;
  }

  if (event.target.closest("[data-resend-delete-verification]")) {
    const resendButton = event.target.closest("[data-resend-delete-verification]");
    resendButton.disabled = true;
    try {
      await productionBackend.resendAccountDeletion(deleteVerificationEmail, deleteVerificationToken);
      showToast("A new deletion verification link was sent. Use the newest email.");
    } catch (error) {
      resendButton.disabled = false;
      showToast(authErrorMessage(error, "send a new deletion verification link"));
    }
    return;
  }

  if (event.target.closest("[data-add-asset-account]")) {
    const account = currentAccount();
    account.savingsInvestmentAccounts.unshift(blankSavingsInvestmentAccount());
    saveState();
    renderProfile();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const firstField = document.querySelector('[data-asset-path="0.name"]');
        const entry = firstField?.closest(".asset-account-card");
        (entry || firstField)?.scrollIntoView({ behavior: "smooth", block: "start" });
        firstField?.focus({ preventScroll: true });
      });
    });
    return;
  }

  const removeAssetAccount = event.target.closest("[data-remove-asset-account]");
  if (removeAssetAccount) {
    const account = currentAccount();
    account.savingsInvestmentAccounts.splice(Number(removeAssetAccount.dataset.removeAssetAccount), 1);
    saveFinancialProfileMutation(account);
    renderProfile();
    showToast("Tracked account removed");
    return;
  }

  const assetTypeButton = event.target.closest("[data-asset-type]");
  if (assetTypeButton) {
    const account = currentAccount();
    const [index, type] = assetTypeButton.dataset.assetType.split(".");
    account.savingsInvestmentAccounts[Number(index)].type = type;
    saveFinancialProfileMutation(account);
    renderProfile();
    return;
  }

  const chartToggle = event.target.closest("[data-chart-toggle]");
  if (chartToggle) {
    const chart = chartToggle.closest(".asset-chart-wrap");
    const seriesId = chartToggle.dataset.chartToggle;
    const shouldShow = chartToggle.getAttribute("aria-pressed") !== "true";
    chartToggle.setAttribute("aria-pressed", String(shouldShow));
    chartToggle.classList.toggle("muted", !shouldShow);
    chart?.querySelectorAll(`[data-chart-series="${seriesId}"]`).forEach((seriesElement) => {
      seriesElement.classList.toggle("hidden", !shouldShow);
    });
    return;
  }

  const settingsHousingType = event.target.closest("[data-settings-housing-type]");
  if (settingsHousingType) {
    const account = currentAccount();
    account.financialInventory.housingPaymentType = settingsHousingType.dataset.settingsHousingType;
    saveFinancialProfileMutation(account);
    renderSettings();
    showToast(`${settingsHousingType.textContent.trim()} housing format saved.`);
    return;
  }

  const settingsBillReminderDays = event.target.closest("[data-settings-bill-reminder-days]");
  if (settingsBillReminderDays) {
    const account = currentAccount();
    account.preferences.billReminderDaysAhead = normalizedBillReminderDays(
      settingsBillReminderDays.dataset.settingsBillReminderDays,
    );
    saveState();
    await productionBackend.saveNow?.(appState);
    renderSettings();
    showToast(`Bill reminders set to ${billReminderDaysLabel(account.preferences.billReminderDaysAhead)} before due dates.`);
    return;
  }

  const markUpcomingPaid = event.target.closest("[data-mark-upcoming-paid]");
  if (markUpcomingPaid) {
    const account = currentAccount();
    if (!account) return;
    const [targetType, ...targetIdParts] = markUpcomingPaid.dataset.markUpcomingPaid.split(":");
    const targetId = targetIdParts.join(":");
    const paidName = markUpcomingBillPaid(account, targetType, targetId, markUpcomingPaid.dataset.upcomingDueDate);
    if (!paidName) {
      showToast("That upcoming bill could not be found.");
      return;
    }
    markUpcomingPaid.disabled = true;
    try {
      saveFinancialProfileMutation(account);
      await productionBackend.saveNow?.(appState);
      renderUpcomingBills();
      showToast(`${paidName} marked paid and removed from upcoming bills.`);
    } catch (error) {
      markUpcomingPaid.disabled = false;
      showToast(error.message || "Could not mark this bill paid.");
    }
    return;
  }

  const billScanSelect = event.target.closest("[data-bill-scan-select]");
  if (billScanSelect) {
    toggleBillScanNewFields(billScanSelect);
    return;
  }

  const scheduleToggle = event.target.closest("[data-recurring-schedule-toggle]");
  if (scheduleToggle) {
    const account = currentAccount();
    const bill = account.financialInventory.recurringBills[Number(scheduleToggle.dataset.recurringScheduleToggle)];
    bill.scheduleEnabled = scheduleToggle.checked;
    if (bill.scheduleEnabled) {
      bill.monthlyAmount ||= bill.amount || "";
      syncRecurringBillScheduleState(bill);
    } else {
      bill.dueDay = "";
      bill.monthlyAmount = "";
      bill.paidDueDate = "";
    }
    scheduleToggle.disabled = true;
    try {
      saveFinancialProfileMutation(account);
      await productionBackend.saveNow?.(appState);
      renderProfile();
    } catch (error) {
      scheduleToggle.disabled = false;
      showToast(error.message || "Could not save recurring bill details.");
      renderProfile();
    }
    return;
  }

  if (event.target.closest("[data-remove-profile-photo]")) {
    const account = currentAccount();
    account.profilePhoto = null;
    saveState();
    renderProfile();
    showToast("Default avatar restored");
    return;
  }

  if (event.target.closest("[data-remove-spouse-photo]")) {
    const account = currentAccount();
    account.spousePhoto = null;
    saveState();
    renderProfile();
    showToast("Default spouse avatar restored");
    return;
  }

  const billSelectorButton = event.target.closest("[data-open-bill-selector]");
  if (billSelectorButton && activeFormId) {
    const input = billSelectorButton.closest(".bill-selector-wrap")?.querySelector("[data-bill-suggestion]");
    if (input) {
      const [category, rowIndex] = input.dataset.billSuggestion.split(".");
      showBillSelectorModal(appState.forms[activeFormId], category, Number(rowIndex));
    }
    return;
  }

  const selectedBill = event.target.closest("[data-select-bill-id]");
  if (selectedBill && activeFormId) {
    const [category, rowIndex] = selectedBill.dataset.selectBillTarget.split(".");
    const form = appState.forms[activeFormId];
    const account = appState.accounts[form.ownerEmail];
    const suggestion = (account?.financialInventory?.recurringBills || []).find(
      (bill) => bill.id === selectedBill.dataset.selectBillId,
    );
    const bill = form.data.bills[category]?.[Number(rowIndex)];
    if (suggestion && bill) {
      bill.name = suggestion.name;
      bill.profileBillId = suggestion.id || "";
      bill.dueDate = recurringBillDisplayDueDate(suggestion);
      bill.amount = bill.dueDate ? suggestion.amount : "";
      form.updatedAt = new Date().toISOString();
      saveState();
      selectedBill.closest(".modal-backdrop")?.remove();
      renderEditor();
      showToast(`${suggestion.name} added to this worksheet.`);
    }
    return;
  }

  const allocationSelectorButton = event.target.closest("[data-open-allocation-selector]");
  if (allocationSelectorButton && activeFormId) {
    showAllocationSelectorModal(appState.forms[activeFormId], Number(allocationSelectorButton.dataset.openAllocationSelector));
    return;
  }

  const selectedAllocation = event.target.closest("[data-select-allocation]");
  if (selectedAllocation && activeFormId) {
    const [allocationIndex, type, sourceIndex] = selectedAllocation.dataset.selectAllocation.split(".");
    const form = appState.forms[activeFormId];
    const sourceGroups = {
      debt: form.data.debts || [],
      credit_card: form.data.creditCards || [],
      student_loan: form.data.studentLoans || [],
      savings: (appState.accounts[form.ownerEmail]?.savingsInvestmentAccounts || []).filter((item) => item.type === "savings"),
    };
    const source = sourceGroups[type]?.[Number(sourceIndex)];
    const row = form.data.allocations?.[Number(allocationIndex)];
    const sourceName = source?.account || source?.name;
    if (sourceName && row) {
      row.type = type;
      row.account = sourceName;
      form.updatedAt = new Date().toISOString();
      saveState();
      selectedAllocation.closest(".modal-backdrop")?.remove();
      renderEditor();
      showToast(`${sourceName} selected.`);
    }
    return;
  }

  const themeChoice = event.target.closest("[data-theme-choice]");
  if (themeChoice) {
    const account = currentAccount();
    account.preferences.theme = themeChoice.dataset.themeChoice;
    saveState();
    applyTheme();
    renderSettings();
    showToast(`${account.preferences.theme === "dark" ? "Dark" : "Light"} mode applied`);
    return;
  }

  const menteeProfileButton = event.target.closest("[data-open-mentee-profile]");
  if (menteeProfileButton) {
    showMenteeProfileModal(menteeProfileButton.dataset.openMenteeProfile);
    return;
  }

  const removeMenteeButton = event.target.closest("[data-remove-mentee]");
  if (removeMenteeButton) {
    const member = appState.accounts[removeMenteeButton.dataset.removeMentee];
    if (!member) return;
    const modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.dataset.memberEmail = member.email;
    modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true"><div class="modal-header"><h3>Remove ${escapeHtml(member.name)}?</h3><button class="icon-btn" type="button" aria-label="Close" data-close-modal>×</button></div><div class="modal-body"><p>This ends the coach connection without deleting the member's personal data.</p><button class="btn btn-danger" type="button" data-confirm-remove-mentee>Remove mentee</button><button class="btn btn-secondary" type="button" data-close-modal>Cancel</button></div></section>`;
    document.body.appendChild(modal);
    return;
  }

  const confirmRemoveMentee = event.target.closest("[data-confirm-remove-mentee]");
  if (confirmRemoveMentee) {
    const modal = event.target.closest(".modal-backdrop");
    const memberEmail = modal?.dataset.memberEmail;
    confirmRemoveMentee.disabled = true;
    try {
      if (productionBackend.enabled) await productionBackend.removeMentee(memberEmail);
      const member = appState.accounts[memberEmail];
      if (member) {
        member.coachEmail = null;
        member.coachName = "";
        member.coachRequestStatus = null;
      }
      await refreshPortalFromBackend();
      modal?.remove();
      renderCoachConnection();
      showToast("Mentee connection removed.");
    } catch (error) {
      confirmRemoveMentee.disabled = false;
      showToast(error.message || "Mentee could not be removed.");
    }
    return;
  }

  const inviteAction = event.target.closest("[data-invite-action]");
  if (inviteAction) {
    const invite = appState.coachInvites.find((item) => item.id === inviteAction.dataset.inviteId);
    const member = currentAccount();
    if (!invite || invite.memberEmail !== member.email) return;
    invite.status = inviteAction.dataset.inviteAction;
    invite.respondedAt = new Date().toISOString();
    if (invite.status === "accepted") {
      member.coachEmail = invite.coachEmail;
      member.coachRequestStatus = "approved";
      appState.coachRequests.push({
        id: uid("request"),
        memberEmail: member.email,
        coachEmail: invite.coachEmail,
        status: "approved",
        createdAt: invite.createdAt,
        respondedAt: new Date().toISOString(),
      });
    }
    saveState();
    renderCoachConnection();
    showToast(invite.status === "accepted" ? "Coach invite accepted" : "Coach invite declined");
    return;
  }

  const deleteCoachInvite = event.target.closest("[data-delete-coach-invite]");
  if (deleteCoachInvite) {
    const coach = currentAccount();
    const invite = appState.coachInvites.find(
      (item) => item.id === deleteCoachInvite.dataset.deleteCoachInvite,
    );
    if (!invite || coach.role !== "coach" || invite.coachEmail !== coach.email || invite.status !== "pending") {
      showToast("That pending invitation is no longer available.");
      return;
    }
    appState.coachInvites = appState.coachInvites.filter((item) => item.id !== invite.id);
    saveState();
    renderCoachConnection();
    showToast("Pending mentee invitation deleted.");
    return;
  }

  const removeProfileItem = event.target.closest("[data-remove-profile-item]");
  if (removeProfileItem) {
    const account = currentAccount();
    const [type, index] = removeProfileItem.dataset.removeProfileItem.split(".");
    account.financialInventory[type].splice(Number(index), 1);
    saveFinancialProfileMutation(account);
    renderProfile();
    return;
  }

  if (event.target.closest("[data-open-coach-connection]")) {
    event.target.closest(".modal-backdrop")?.remove();
    activeView = "coach-connection";
    activeFormId = null;
    render();
    return;
  }

  if (event.target.closest("[data-sign-out]")) {
    const account = currentAccount();
    if (account) {
      account.lastActiveAt = null;
      try {
        await productionBackend.updatePresence?.(null);
      } catch (error) {
        console.warn("Could not update offline status", error);
      }
    }
    if (productionBackend.enabled) {
      try {
        await productionBackend.signOut();
      } catch (error) {
        showToast(error.message || "Could not sign out.");
        return;
      }
    }
    clearProtectedPortalMemory();
    activeView = "dashboard";
    activeFormId = null;
    pendingPaystubUpload = null;
    pendingBillScanUpload = null;
    saveState();
    history.replaceState({}, "", window.location.pathname);
    render();
    return;
  }

  if (event.target.closest("[data-new-form]")) {
    showNewFormModal();
    return;
  }

  const viewButton = event.target.closest("[data-view]");
  if (viewButton) {
    activeView = viewButton.dataset.view;
    activeFormId = null;
    render();
    return;
  }

  const openButton = event.target.closest("[data-open-form]");
  if (openButton) {
    const form = appState.forms[openButton.dataset.openForm];
    activeFormId = openButton.dataset.openForm;
    activeView = "editor";
    render();
    if (form) {
      const emailResult = await sendWorksheetOpenedEmail(form);
      const emailStatus = emailDeliveryMessage(emailResult, notificationEmailsForForm(form));
      if (emailStatus) showToast(`Worksheet opened.${emailStatus}`);
    }
    return;
  }

  const shareButton = event.target.closest("[data-share-form]");
  if (shareButton) {
    showShareModal(shareButton.dataset.shareForm);
    return;
  }

  const printButton = event.target.closest("[data-print-form]");
  if (printButton) {
    printWorksheetSummary(printButton.dataset.printForm);
    return;
  }

  const approveMemberSuggestionButton = event.target.closest("[data-approve-member-suggestion]");
  if (approveMemberSuggestionButton && activeFormId) {
    const coach = currentAccount();
    const form = appState.forms[activeFormId];
    const member = form ? appState.accounts[form.ownerEmail] : null;
    if (!form || coach?.role !== "coach" || member?.coachEmail !== coach.email) {
      showToast("Only the assigned coach can approve member suggestions.");
      return;
    }
    if (form.status === "approved") {
      showToast("This worksheet has already been approved.");
      return;
    }
    const row = getAtPath(form.data, approveMemberSuggestionButton.dataset.approveMemberSuggestion);
    if (!row?.memberSuggestion) {
      showToast("There is no member suggestion to approve.");
      return;
    }
    row.coachDecision = row.memberSuggestion;
    row.suggestionApprovedAt = new Date().toISOString();
    row.suggestionApprovedBy = coach.email;
    form.updatedAt = new Date().toISOString();
    saveState();
    try {
      await productionBackend.saveNow?.(appState);
    } catch (error) {
      console.warn("Could not immediately save member suggestion approval", error);
    }
    renderEditor();
    showToast("Member suggestion approved.");
    return;
  }

  const saveFormButton = event.target.closest("[data-save-form]");
  if (saveFormButton) {
    const form = appState.forms[saveFormButton.dataset.saveForm];
    if (!form || form.ownerEmail !== currentAccount()?.email) return;
    form.updatedAt = new Date().toISOString();
    const milestoneCreated = notifyFormMilestones(form);
    if (saveState()) {
      try {
        await productionBackend.saveNow?.(appState);
        showToast(milestoneCreated ? "Form saved and milestone alerts shared." : "Form saved.");
      } catch (error) {
        showToast(error.message || "Form could not be saved.");
      }
    }
    return;
  }

  const archiveButton = event.target.closest("[data-archive-form]");
  if (archiveButton) {
    const account = currentAccount();
    const form = appState.forms[archiveButton.dataset.archiveForm];
    const member = form ? appState.accounts[form.ownerEmail] : null;
    const canArchive =
      form &&
      (normalizeEmail(form.ownerEmail) === normalizeEmail(account?.email) ||
        (account?.role === "coach" &&
          normalizeEmail(member?.coachEmail) === normalizeEmail(account.email) &&
          member?.coachRequestStatus === "approved"));
    if (!canArchive) {
      showToast("This worksheet is not available to archive.");
      return;
    }
    if (form.status !== "approved") {
      showToast("Archive is available after the session is approved.");
      return;
    }
    if (form.archivedAt) {
      showToast("This worksheet is already archived.");
      return;
    }
    form.archivedAt = new Date().toISOString();
    form.archivedBy = account.email;
    form.updatedAt = new Date().toISOString();
    saveState();
    try {
      await productionBackend.saveNow?.(appState);
      render();
      showToast("Completed worksheet archived.");
    } catch (error) {
      showToast(error.message || "Worksheet could not be archived.");
    }
    return;
  }

  const deleteButton = event.target.closest("[data-delete-form]");
  if (deleteButton) {
    const form = appState.forms[deleteButton.dataset.deleteForm];
    if (form && window.confirm(`Delete "${form.title}"? This cannot be undone.`)) {
      delete appState.forms[form.id];
      saveState();
      render();
      showToast("Worksheet deleted");
    }
    return;
  }

  const addButton = event.target.closest("[data-add-row]");
  if (addButton && activeFormId) {
    const form = appState.forms[activeFormId];
    const path = addButton.dataset.addRow;
    const target = getAtPath(form.data, path);
    if (path.startsWith("bills.")) target.unshift(blankBill());
    if (path === "creditCards") target.unshift(blankCreditCard());
    if (path === "variableSpending") target.unshift(blankVariable());
    if (path === "debts") target.unshift(blankDebt());
    if (path === "studentLoans") target.unshift(blankStudentLoan());
    if (path === "allocations") target.unshift({ id: uid("allocation"), type: "", account: "", amount: "", memberSuggestion: "", coachDecision: "" });
    form.updatedAt = new Date().toISOString();
    saveState();
    renderEditor();
    revealNewEntry(path);
    return;
  }

  const removeButton = event.target.closest("[data-remove-row]");
  if (removeButton && activeFormId) {
    const form = appState.forms[activeFormId];
    removeAtPath(form.data, removeButton.dataset.removeRow);
    form.updatedAt = new Date().toISOString();
    saveState();
    renderEditor();
    return;
  }

  const closeModal = event.target.closest("[data-close-modal]");
  if (closeModal || event.target.matches(".modal-backdrop")) {
    event.target.closest(".modal-backdrop")?.remove();
    return;
  }

  const unshareButton = event.target.closest("[data-unshare]");
  if (unshareButton) {
    const modal = event.target.closest(".modal-backdrop");
    const form = appState.forms[modal.dataset.formId];
    form.sharedWith = form.sharedWith.filter((email) => email !== unshareButton.dataset.unshare);
    form.updatedAt = new Date().toISOString();
    saveState();
    modal.remove();
    showShareModal(form.id);
    showToast("Coach access removed");
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "login-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    await signIn(data.get("email"), data.get("password"), loginRole);
    return;
  }

  if (event.target.id === "signup-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    await createAccount(data.get("name"), data.get("email"), data.get("password"), loginRole);
    return;
  }

  if (event.target.id === "password-reset-request-form") {
    event.preventDefault();
    const email = normalizeEmail(new FormData(event.target).get("email"));
    if (!validEmail(email)) {
      showToast("Enter a valid email address.");
      return;
    }
    try {
      await productionBackend.requestPasswordReset(email);
      loginMode = "signin";
      renderLogin();
      showToast("Password reset link sent. Check your inbox and spam folder.");
    } catch (error) {
      showToast(authErrorMessage(error, "send the password reset link"));
    }
    return;
  }

  if (event.target.id === "password-update-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const password = String(data.get("password") || "");
    if (password.length < 8 || password !== data.get("confirmation")) {
      showToast(password.length < 8 ? "Use at least 8 characters." : "The passwords do not match.");
      return;
    }
    try {
      await productionBackend.updatePassword(password);
      await productionBackend.signOut();
      history.replaceState({}, "", window.location.pathname);
      loginMode = "signin";
      renderLogin();
      showToast("Password updated. Sign in with your new password.");
    } catch (error) {
      showToast(authErrorMessage(error, "update the password"));
    }
    return;
  }

  if (event.target.id === "request-account-deletion-form") {
    event.preventDefault();
    if (!productionBackend.enabled) {
      showToast("Account deletion verification is only available on the secure live site.");
      return;
    }
    const submitButton = event.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      await productionBackend.requestAccountDeletion();
      event.target.closest(".modal-backdrop")?.remove();
      showToast("F.I.T. deletion verification link sent. Your account remains active.");
    } catch (error) {
      submitButton.disabled = false;
      showToast(authErrorMessage(error, "send the deletion verification email"));
    }
    return;
  }

  if (event.target.id === "complete-account-deletion-form") {
    event.preventDefault();
    const submitButton = event.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      await productionBackend.completeAccountDeletion(deleteVerificationEmail, deleteVerificationToken);
      localStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem("fit-pending-coach-invite");
      appState = {
        accounts: {},
        forms: {},
        coachRequests: [],
        coachInvites: [],
        withdrawals: [],
        sessions: [],
        notifications: [],
        dateAutofillDisabled: true,
        sessionEmail: null,
      };
      history.replaceState({}, "", window.location.pathname);
      loginMode = "delete-success";
      renderLogin();
    } catch (error) {
      submitButton.disabled = false;
      showToast(error.message || "Deletion could not be completed. Try again or request a new verification link.");
    }
    return;
  }

  if (event.target.id === "verification-form") {
    event.preventDefault();
    if (productionBackend.enabled) {
      try {
        const code = new FormData(event.target).get("code").trim();
        await productionBackend.verifyOtp(pendingVerificationEmail, code);
        appState = await productionBackend.hydrate();
        pendingVerificationEmail = null;
        loginMode = "signin";
        activeView = "profile";
        render();
        showToast("Email verified.");
      } catch (error) {
        showToast(error.message || "That verification code does not match.");
      }
      return;
    }
    const account = appState.accounts[pendingVerificationEmail];
    const code = new FormData(event.target).get("code").trim();
    if (!account || account.verificationCode !== code) {
      showToast("That verification code does not match.");
      return;
    }
    account.verified = true;
    account.verificationCode = null;
    appState.sessionEmail = account.email;
    pendingVerificationEmail = null;
    loginMode = "signin";
    activeView = "dashboard";
    saveState();
    render();
    showToast("Email verified");
    return;
  }

  if (event.target.id === "coach-invite-form") {
    event.preventDefault();
    const coach = currentAccount();
    if (coach.role !== "coach") return;
    const memberEmail = normalizeEmail(new FormData(event.target).get("email"));
    if (!validEmail(memberEmail)) {
      showToast("Enter a valid mentee email address.");
      return;
    }
    const duplicate = appState.coachInvites.some(
      (invite) =>
        invite.coachEmail === coach.email &&
        invite.memberEmail === memberEmail &&
        invite.status === "pending",
    );
    if (duplicate) {
      showToast("A pending invitation already exists for that email.");
      return;
    }
    const token = `${uid("fit-invite")}-${Math.random().toString(36).slice(2, 12)}`;
    appState.coachInvites.push({
      id: uid("invite"),
      coachEmail: coach.email,
      memberEmail,
      status: "pending",
      token,
      inviteUrl: `https://fit.example/invite/${token}`,
      createdAt: new Date().toISOString(),
    });
    saveState();
    if (productionBackend.enabled) {
      try {
        await productionBackend.sendCoachInvite(memberEmail);
      } catch (error) {
        showToast(error.message || "Invite saved, but the email could not be sent.");
        return;
      }
    }
    renderCoachConnection();
    showToast(`Secure invitation sent to ${memberEmail}`);
    return;
  }

  if (event.target.id === "coach-request-form") {
    event.preventDefault();
    const member = currentAccount();
    const coachEmail = normalizeEmail(new FormData(event.target).get("email"));
    if (!validEmail(coachEmail)) {
      showToast("Enter a valid coach email address.");
      return;
    }
    let coach = appState.accounts[coachEmail];
    if (productionBackend.enabled) {
      try {
        const result = await productionBackend.connectCoach(coachEmail);
        coach = {
          name: result.coachName || "F.I.T. coach",
          email: result.coachEmail,
          role: "coach",
          profilePhoto: result.coachProfilePhoto || null,
        };
        appState.accounts[coach.email] = coach;
        member.coachName = coach.name;
      } catch (error) {
        showToast(error.message || "That coach account could not be found.");
        return;
      }
    } else if (!coach || coach.role !== "coach") {
      showToast("No coach account exists for that email yet.");
      return;
    }
    appState.coachRequests
      .filter((request) => request.memberEmail === member.email && request.status === "pending")
      .forEach((request) => {
        request.status = "replaced";
      });
    appState.coachRequests.push({
      id: uid("request"),
      memberEmail: member.email,
      coachEmail,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    member.coachEmail = coach.email;
    member.coachRequestStatus = "pending";
    saveState();
    renderCoachConnection();
    showToast(`Coach request sent to ${coach.email}`);
    return;
  }

  if (event.target.id === "profile-form") {
    event.preventDefault();
    settleFinancialProfileSaveFocus(event.submitter || event.target);
    const account = currentAccount();
    const data = new FormData(event.target);
    account.name = data.get("name").trim();
    account.profile.phone = data.get("phone").trim();
    account.profile.employer = data.get("employer").trim();
    account.profile.address = data.get("address").trim();
    account.profile.payFrequency = data.get("payFrequency");
    account.profile.maritalStatus = data.get("maritalStatus");
    account.profile.spouseName =
      account.profile.maritalStatus === "married" ? data.get("spouseName").trim() : "";
    account.profile.spouseEmployer = account.profile.maritalStatus === "married" ? String(data.get("spouseEmployer") || "").trim() : "";
    account.profile.spousePhone = account.profile.maritalStatus === "married" ? String(data.get("spousePhone") || "").trim() : "";
    account.profile.spousePayFrequency = account.profile.maritalStatus === "married" ? String(data.get("spousePayFrequency") || "") : "";
    if (account.profile.maritalStatus !== "married") account.spousePhoto = null;
    Object.values(appState.forms)
      .filter((form) => form.ownerEmail === account.email)
      .forEach((form) => {
        form.ownerName = account.name;
      });
    account.profileCompleted = profileIsComplete(account);
    syncDraftFormsWithFinancialProfile(account);
    notifyProfileMilestones(account);
    Object.values(appState.forms)
      .filter((form) => form.ownerEmail === account.email)
      .forEach(notifyFormMilestones);
    saveState();
    if (account.profileCompleted) {
      activeView = "dashboard";
      render();
      showToast("Financial profile saved. Your F.I.T. workspace is unlocked.");
    } else {
      renderProfile();
      showToast("Complete every required profile field to unlock forms.");
    }
    settleFinancialProfileSaveFocus(event.submitter || event.target);
    return;
  }

  if (event.target.id === "new-form-assignment-form") {
    event.preventDefault();
    const assignedPerson = new FormData(event.target).get("assignedPerson");
    event.target.closest(".modal-backdrop")?.remove();
    createForm(assignedPerson);
    return;
  }

  if (event.target.id === "bill-scan-upload-form") {
    event.preventDefault();
    const submitButton = event.target.querySelector('button[type="submit"]');
    const file = new FormData(event.target).get("billDocument");
    if (!(file instanceof File) || !file.size) {
      showToast("Choose a bill PDF, screenshot, or photo before reading.");
      hidePageLoading();
      return;
    }
    submitButton.disabled = true;
    try {
      const { scan, uploadMeta } = await analyzeBillDocumentFile(file);
      event.target.closest(".modal-backdrop")?.remove();
      showBillScanReviewModal(scan, uploadMeta);
      showToast("Review the suggested bill update before saving.");
    } catch (error) {
      submitButton.disabled = false;
      showToast(error.message || "The bill document could not be read.");
    } finally {
      hidePageLoading();
    }
    return;
  }

  if (event.target.id === "bill-scan-confirm-form") {
    event.preventDefault();
    const submitButton = event.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const saved = await applyBillScanUpdate(event.target);
      if (!saved) {
        submitButton.disabled = false;
        hidePageLoading();
        return;
      }
      event.target.closest(".modal-backdrop")?.remove();
      if (activeView === "upcoming-bills") {
        renderUpcomingBills();
      } else {
        renderProfile();
      }
    } catch (error) {
      submitButton.disabled = false;
      showToast(error.message || "The bill update could not be saved.");
    } finally {
      hidePageLoading();
    }
    return;
  }

  if (event.target.id === "paystub-submit-form") {
    event.preventDefault();
    if (!pendingPaystubUpload) {
      showToast("Choose a paystub before submitting.");
      return;
    }
    const account = currentAccount();
    account.paystubs.unshift({
      ...pendingPaystubUpload,
      id: uid("paystub"),
      submittedAt: new Date().toISOString(),
      uploadedAt: new Date().toISOString(),
      archiveDate: todayValue(),
    });
    const submittedPaystub = account.paystubs[0];
    pendingPaystubUpload = null;
    if (saveState()) {
      await productionBackend.saveNow?.(appState);
      const emailResult = await notifyFitEventEmail({
        eventType: "document_available",
        memberEmail: account.email,
        relatedDocumentId: submittedPaystub.id,
        documentTitle: submittedPaystub.name || "Paystub",
        documentType: "Paystub",
      });
      renderProfile();
      showToast(`Paystub submitted to the archive.${emailDeliveryMessage(emailResult, notificationEmailsForMember(account))}`);
    }
    return;
  }

  if (event.target.id === "session-completion-form") {
    event.preventDefault();
    const modal = event.target.closest(".modal-backdrop");
    const data = new FormData(event.target);
    await approveForm(
      modal.dataset.formId,
      data.get("coachNotes").trim(),
      data.get("actionSteps").trim(),
    );
    modal.remove();
    return;
  }

  const sessionFeedbackForm = event.target.closest("[data-session-feedback-form]");
  if (sessionFeedbackForm) {
    event.preventDefault();
    const account = currentAccount();
    const session = appState.sessions.find(
      (item) =>
        item.id === sessionFeedbackForm.dataset.sessionFeedbackForm &&
        item.memberEmail === account.email,
    );
    if (!session) return;
    session.feedback ||= [];
    session.feedback.push({
      id: uid("feedback"),
      authorEmail: account.email,
      authorName: account.name,
      message: new FormData(sessionFeedbackForm).get("message").trim(),
      createdAt: new Date().toISOString(),
    });
    saveState();
    renderSessions();
    showToast("Your response was shared with your coach");
    return;
  }

  if (event.target.id === "share-form") {
    event.preventDefault();
    const modal = event.target.closest(".modal-backdrop");
    const form = appState.forms[modal.dataset.formId];
    const email = normalizeEmail(new FormData(event.target).get("email"));
    const account = currentAccount();
    if (email !== account.coachEmail || account.coachRequestStatus !== "approved") {
      showToast("Connect with an approved coach before sharing this worksheet.");
      return;
    }
    const calc = calculate(form);
    if (calc.available < 0) {
      showOverBudgetDialog(calc);
      return;
    }
    form.sharedWith = [email];
    form.status = "submitted";
    form.submittedAt = new Date().toISOString();
    form.updatedAt = new Date().toISOString();
    saveState();
    await productionBackend.saveNow?.(appState);
    const emailResult = await sendDocumentAvailableEmail(form, "Worksheet");
    modal.remove();
    render();
    showToast(`Finished worksheet sent for coach review.${emailDeliveryMessage(emailResult, notificationEmailsForForm(form))}`);
    return;
  }

  if (event.target.id === "withdrawal-form") {
    event.preventDefault();
    const modal = event.target.closest(".modal-backdrop");
    const form = appState.forms[modal.dataset.formId];
    const data = new FormData(event.target);
    const amount = Number(data.get("amount")) || 0;
    const reason = data.get("reason").trim();
    const member = currentAccount();
    const savingsAccounts = member.savingsInvestmentAccounts.filter((account) => account.type === "savings");
    const savingsAccount = savingsAccounts.find((account) => account.id === data.get("assetAccountId"));
    const calc = calculate(form);
    const availableBalance = savingsAccount ? Number(savingsAccount.balance) || 0 : calc.savingsAfter;
    if (!reason || amount <= 0 || amount > availableBalance || (savingsAccounts.length && !savingsAccount)) {
      showToast("Enter a withdrawal amount within the available savings balance.");
      return;
    }
    const withdrawal = savingsAccount
      ? recordSavingsWithdrawal(member, savingsAccount, amount, reason, form.id)
      : {
          id: uid("withdrawal"),
          formId: form.id,
          memberEmail: member.email,
          coachEmail: member.coachEmail || null,
          amount: currencyValue(amount),
          reason,
          savingsAccountName: "Worksheet savings",
          previousBalance: calc.savingsAfter,
          newBalance: currencyValue(calc.savingsAfter - amount),
          updatedSavings: currencyValue(calc.savingsAfter - amount),
          createdAt: new Date().toISOString(),
          profileApplied: false,
        };
    if (!savingsAccount) appState.withdrawals.push(withdrawal);
    if (!savingsAccount) addWithdrawalNotifications(member, withdrawal);
    form.data.savings.current = String(withdrawal.updatedSavings);
    form.data.savings.contribution = "";
    form.updatedAt = new Date().toISOString();
    member.carryForward ||= {};
    member.carryForward.savings = {
      goal: form.data.savings.goal,
      current: String(withdrawal.updatedSavings),
    };
    saveState();
    await productionBackend.saveNow?.(appState);
    modal.remove();
    renderEditor();
    showToast(member.coachEmail ? "Savings withdrawal recorded and sent to your coach" : "Savings withdrawal recorded");
    return;
  }

  if (event.target.id === "profile-withdrawal-form") {
    event.preventDefault();
    const modal = event.target.closest(".modal-backdrop");
    const member = currentAccount();
    const savingsAccount = member.savingsInvestmentAccounts[Number(modal.dataset.assetIndex)];
    const data = new FormData(event.target);
    const amount = Number(data.get("amount")) || 0;
    const reason = String(data.get("reason") || "").trim();
    const previousBalance = Number(savingsAccount?.balance) || 0;
    if (!savingsAccount || savingsAccount.type !== "savings" || amount <= 0 || amount > previousBalance || !reason) {
      showToast("Enter a valid withdrawal amount and reason.");
      return;
    }
    recordSavingsWithdrawal(member, savingsAccount, amount, reason);
    saveState();
    await productionBackend.saveNow?.(appState);
    modal.remove();
    renderProfile();
    showToast(member.coachEmail ? "Withdrawal saved and shared with your coach." : "Withdrawal saved.");
    return;
  }
});

document.addEventListener("input", (event) => {
  sanitizeCurrencyInput(event.target);
  const assetInput = event.target.closest("[data-asset-path]");
  if (assetInput) {
    // Keep profile typing local to the input until change/blur or explicit Save.
    return;
  }

  const profileInput = event.target.closest("[data-profile-path]");
  if (profileInput) {
    validateControlledInput(profileInput);
    return;
  }

  const input = event.target.closest("[data-path]");
  if (!input || !activeFormId) return;
  const form = appState.forms[activeFormId];
  setAtPath(form.data, input.dataset.path, currencyInputStorageValue(input));
  const billSuggestion = input.closest("[data-bill-suggestion]");
  if (billSuggestion) {
    applyRecurringBillSuggestion(input, form);
  }
  form.updatedAt = new Date().toISOString();
  refreshLiveAvailable(form);
  clearTimeout(formAutosaveTimer);
  formAutosaveTimer = setTimeout(() => saveState(), 700);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.target.matches("textarea")) return;
  if (event.target.matches("[data-profile-path], [data-asset-path], [data-path]")) {
    event.preventDefault();
    event.target.blur();
  }
});

document.addEventListener("focusin", (event) => {
  const input = event.target.closest("[data-currency-input]");
  if (input) input.value = input.value.replaceAll(",", "");
});

document.addEventListener("focusout", (event) => {
  normalizeCurrencyInput(event.target);
  if (productionBackend.enabled && event.target.matches("input, textarea, select")) {
    schedulePortalRefresh(1700);
  }
});

document.addEventListener("change", async (event) => {
  normalizeCurrencyInput(event.target);
  const billScanSelect = event.target.closest("[data-bill-scan-select]");
  if (billScanSelect) {
    toggleBillScanNewFields(billScanSelect);
    return;
  }

  const notificationPreference = event.target.closest("[data-notification-pref]");
  if (notificationPreference) {
    const account = currentAccount();
    account.preferences.notifications[notificationPreference.dataset.notificationPref] =
      notificationPreference.checked;
    saveState();
    await productionBackend.saveNow?.(appState);
    showToast("Notification preference saved.");
    return;
  }

  const assetInput = event.target.closest("[data-asset-path]");
  if (assetInput) {
    const account = currentAccount();
    const [index, field] = assetInput.dataset.assetPath.split(".");
    account.savingsInvestmentAccounts[Number(index)][field] = currencyInputStorageValue(assetInput);
    if (field === "balance" || field === "updatedAt") saveAssetHistoryEntry(account, index);
    saveFinancialProfileMutation(account);
    if (field === "balance" || field === "updatedAt") renderProfile();
    return;
  }

  const profilePromoType = event.target.closest("[data-profile-promo-type]");
  if (profilePromoType) {
    const account = currentAccount();
    account.financialInventory.creditCards[Number(profilePromoType.dataset.profilePromoType)].promoType =
      profilePromoType.value;
    saveFinancialProfileMutation(account);
    renderProfile();
    return;
  }

  const profileInput = event.target.closest("[data-profile-path]");
  if (profileInput) {
    if (!validateControlledInput(profileInput)) return;
    const account = currentAccount();
    setAtPath(account, profileInput.dataset.profilePath, currencyInputStorageValue(profileInput));
    const recurringMatch = profileInput.dataset.profilePath.match(/^financialInventory\.recurringBills\.(\d+)\.(\w+)$/);
    if (recurringMatch) {
      const [, indexValue, field] = recurringMatch;
      const bill = account.financialInventory.recurringBills[Number(indexValue)];
      syncRecurringBillScheduleState(bill, field);
      saveFinancialProfileMutation(account);
      try {
        await productionBackend.saveNow?.(appState);
      } catch (error) {
        showToast(error.message || "Could not save recurring bill details.");
      }
      if (field === "dueDay" || field === "monthlyAmount") renderProfile();
      return;
    }
    saveFinancialProfileMutation(account);
    return;
  }

  const profilePromoInput = event.target.closest("[data-profile-promo-toggle]");
  if (profilePromoInput) {
    const account = currentAccount();
    const [type, index] = profilePromoInput.dataset.profilePromoToggle.split(".");
    account.financialInventory[type][Number(index)].promotionalRateApplied =
      profilePromoInput.checked;
    saveFinancialProfileMutation(account);
    renderProfile();
    return;
  }

  const paystubInput = event.target.closest("[data-paystub-upload]");
  if (paystubInput?.files?.[0]) {
    const file = paystubInput.files[0];
    const allowedTypes = ["application/pdf", "image/png", "image/jpeg"];
    if (!allowedTypes.includes(file.type) || file.size > 2 * 1024 * 1024) {
      showToast("Upload a PDF, PNG, or JPG no larger than 2 MB.");
      paystubInput.value = "";
      return;
    }
    if (productionBackend.enabled) {
      try {
        const uploaded = await productionBackend.uploadPrivateFile(
          "financial-documents",
          file,
          "paystubs",
        );
        pendingPaystubUpload = {
          name: file.name,
          type: file.type,
          size: file.size,
          ...uploaded,
        };
        renderProfile();
        showToast("Paystub securely uploaded and ready to submit.");
      } catch (error) {
        showToast(error.message || "Paystub upload failed.");
      }
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingPaystubUpload = {
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: reader.result,
      };
      renderProfile();
      showToast("Paystub ready to submit");
    };
    reader.readAsDataURL(file);
    return;
  }

  const profilePhotoInput = event.target.closest("[data-profile-photo-upload]");
  if (profilePhotoInput?.files?.[0]) {
    await updateProfilePhoto(profilePhotoInput, "profilePhoto", "account-holder", "Profile photo");
    return;
  }

  const spousePhotoInput = event.target.closest("[data-spouse-photo-upload]");
  if (spousePhotoInput?.files?.[0]) {
    await updateProfilePhoto(spousePhotoInput, "spousePhoto", "spouse", "Spouse photo");
    return;
  }

  const maritalStatus = event.target.closest("#marital-status");
  if (maritalStatus) {
    document.querySelectorAll(".spouse-field").forEach((field) => {
      field.classList.toggle("hidden", maritalStatus.value !== "married");
    });
    return;
  }

  const allocationTarget = event.target.closest("[data-allocation-target]");
  if (allocationTarget && activeFormId) {
    const form = appState.forms[activeFormId];
    const row = form.data.allocations[Number(allocationTarget.dataset.allocationTarget)];
    if (!row) return;
    const [type, ...accountParts] = allocationTarget.value.split("|");
    row.type = type || "";
    row.account = accountParts.join("|");
    form.updatedAt = new Date().toISOString();
    saveState();
    refreshLiveAvailable(form);
    return;
  }

  const cardPromoType = event.target.closest("[data-card-promo-type]");
  if (cardPromoType && activeFormId) {
    const form = appState.forms[activeFormId];
    form.data.creditCards[Number(cardPromoType.dataset.cardPromoType)].promoType =
      cardPromoType.value;
    form.updatedAt = new Date().toISOString();
    saveState();
    renderEditor();
    return;
  }

  const promoInput = event.target.closest("[data-promo-toggle]");
  if (promoInput && activeFormId) {
    const form = appState.forms[activeFormId];
    form.data.debts[Number(promoInput.dataset.promoToggle)].promotionalRateApplied =
      promoInput.checked;
    form.updatedAt = new Date().toISOString();
    saveState();
    renderEditor();
    return;
  }

  const input = event.target.closest("[data-path]");
  if (!input || !activeFormId) return;
  const form = appState.forms[activeFormId];
  setAtPath(form.data, input.dataset.path, currencyInputStorageValue(input));
  const billSuggestion = input.closest("[data-bill-suggestion]");
  if (billSuggestion) {
    applyRecurringBillSuggestion(input, form);
  }
  form.updatedAt = new Date().toISOString();
  saveState();
  refreshLiveAvailable(form);
});

async function initializePortal() {
  if (portalInitializationInProgress) return;
  portalInitializationInProgress = true;
  portalLoadError = null;
  if (productionBackend.enabled) renderPortalStatusPage("loading");
  if (productionBackend.enabled) {
    localStorage.removeItem(STORAGE_KEY);
    try {
      const hydrated = await productionBackend.hydrate();
      if (hydrated) {
        appState = hydrated;
        portalDataReady = true;
        if (new URLSearchParams(window.location.search).get("sessionReview")) activeView = "sessions";
      } else {
        clearProtectedPortalMemory();
        portalDataReady = true;
        loginMode = "signin";
      }
    } catch (error) {
      console.error(error);
      if (error?.code === "FIT_ACCOUNT_DELETED") {
        portalDataReady = true;
        clearAccountForAuthEnd("deleted");
        return;
      }
      if (error?.code === "FIT_SESSION_EXPIRED") {
        portalDataReady = true;
        clearAccountForAuthEnd("expired");
        return;
      }
      portalLoadError = error;
      renderPortalStatusPage("temporary");
      return;
    } finally {
      portalInitializationInProgress = false;
    }
  }
  portalInitializationInProgress = false;
  normalizeStateModels(appState);
  if (currentAccount()) saveState();
  if (productionBackend.enabled && currentAccount()) {
    productionBackend.subscribeToPortalChanges?.(() => {
      schedulePortalRefresh(250);
    });
  }
  touchActivity();
  render();
}

let portalRefreshInProgress = false;
function portalRefreshBlocked() {
  return (
    navigator.onLine === false ||
    profilePhotoUpdateInProgress ||
    Date.now() < calculatorInteractionUntil ||
    document.visibilityState !== "visible" ||
    document.querySelector(".modal-backdrop") ||
    calculatorDragState ||
    Date.now() - lastLocalSaveAt < 1500 ||
    document.activeElement?.matches("input, textarea, select")
  );
}

function schedulePortalRefresh(delay = 250) {
  if (!productionBackend.enabled || !currentAccount()) return;
  clearTimeout(portalRefreshTimer);
  const minimumDelay = Math.max(0, 600 - (Date.now() - lastPortalRefreshAt));
  portalRefreshTimer = setTimeout(() => refreshPortalFromBackend(), Math.max(delay, minimumDelay));
}

async function refreshPortalFromBackend() {
  if (!productionBackend.enabled || !currentAccount()) return;
  if (portalRefreshInProgress) {
    portalRefreshQueued = true;
    return;
  }
  if (portalRefreshBlocked()) return;
  portalRefreshInProgress = true;
  lastPortalRefreshAt = Date.now();
  try {
    const hydrated = await productionBackend.hydrate({ requireSession: true });
    if (!hydrated) return;
    const currentEmail = appState.sessionEmail;
    const refreshedState = normalizeStateModels(hydrated);
    refreshedState.sessionEmail = currentEmail;
    if (activeView === "editor" && activeFormId && appState.forms[activeFormId] && !refreshedState.forms[activeFormId]) {
      throw new Error("The current worksheet has not finished loading.");
    }
    const mediaBecameAvailable = stabilizeMediaUrls(appState, refreshedState);
    const contentChanged = portalContentSignature(appState) !== portalContentSignature(refreshedState);
    if (!contentChanged) {
      Object.entries(refreshedState.accounts || {}).forEach(([email, account]) => {
        if (appState.accounts[email]) appState.accounts[email].lastActiveAt = account.lastActiveAt || null;
      });
      portalDataReady = true;
      removePortalRetryBanner();
      if (mediaBecameAvailable) render();
      return;
    }
    appState = refreshedState;
    portalDataReady = true;
    removePortalRetryBanner();
    localStorage.removeItem(STORAGE_KEY);
    render();
  } catch (error) {
    console.warn("Could not refresh live portal data", error);
    if (error?.code === "FIT_ACCOUNT_DELETED") {
      clearAccountForAuthEnd("deleted");
      return;
    }
    if (error?.code === "FIT_SESSION_EXPIRED") {
      clearAccountForAuthEnd("expired");
      return;
    }
    if (Date.now() - lastTemporaryErrorNoticeAt > 60 * 1000) {
      lastTemporaryErrorNoticeAt = Date.now();
      showToast("We had trouble refreshing this page. Your current page is still available.");
    }
    showPortalRetryBanner();
  } finally {
    portalRefreshInProgress = false;
    if (portalRefreshQueued) {
      portalRefreshQueued = false;
      schedulePortalRefresh(300);
    }
  }
}

let accountValidationInProgress = false;
async function validateCurrentAccount() {
  if (!productionBackend.enabled || accountValidationInProgress || !currentAccount()) return;
  accountValidationInProgress = true;
  try {
    const status = await productionBackend.validateActiveAccount();
    if (status.active) {
      removePortalRetryBanner();
      return;
    }
    clearAccountForAuthEnd(status.reason);
  } catch (error) {
    console.warn("Could not verify the active account", error);
    if (Date.now() - lastTemporaryErrorNoticeAt > 60 * 1000) {
      lastTemporaryErrorNoticeAt = Date.now();
      showToast("We had trouble checking your session. You can keep working while we retry.");
    }
    showPortalRetryBanner("We had trouble checking your session. You can keep working while we retry.");
  } finally {
    accountValidationInProgress = false;
  }
}

if (clearSiteDataFromUrl) {
  clearFitSiteDataFromBrowser().catch((error) => {
    console.error("Could not clear F.I.T. browser data", error);
    app.innerHTML = `
      <main class="login-shell">
        <section class="auth-panel">
          <p class="eyebrow">Browser data</p>
          <h1>We had trouble clearing this browser.</h1>
          <p class="muted">Refresh this page and try again, or sign out normally from F.I.T.</p>
          <button class="primary-action" type="button" data-clear-data-signin>Go to sign in</button>
        </section>
      </main>
    `;
  });
} else {
  initializePortal();
}
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches("[data-avatar-image]")) return;
    image.closest(".avatar-photo")?.classList.add("avatar-photo-failed");
  },
  true,
);
document.addEventListener(
  "load",
  (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches("[data-avatar-image]")) return;
    image.closest(".avatar-photo")?.classList.remove("avatar-photo-failed");
  },
  true,
);
document.addEventListener("pointerdown", beginCalculatorDrag);
document.addEventListener("pointermove", moveCalculator);
document.addEventListener("pointerup", handleCalculatorPointerEnd);
document.addEventListener("pointercancel", handleCalculatorPointerEnd);
setInterval(() => {
  checkInactivityLogout();
  validateCurrentAccount();
}, 15 * 1000);
setInterval(() => {
  schedulePortalRefresh(0);
}, 45 * 1000);
["mousemove", "mousedown", "keydown", "scroll", "touchstart", "pointerdown"].forEach((eventName) => {
  document.addEventListener(eventName, recordUserActivity, { passive: true });
});
window.addEventListener("focus", () => {
  checkInactivityLogout();
  if (currentAccount()) recordUserActivity();
  validateCurrentAccount();
  schedulePortalRefresh(300);
});
window.addEventListener("popstate", recordUserActivity);
window.addEventListener("offline", () => {
  showPortalRetryBanner("You are offline. Keep working; changes will sync when your connection returns.");
});
window.addEventListener("online", () => {
  removePortalRetryBanner();
  productionBackend.flushPending?.().catch((error) => {
    console.warn("Pending changes will retry automatically", error);
  });
  schedulePortalRefresh(200);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkInactivityLogout();
    validateCurrentAccount();
    schedulePortalRefresh(300);
  } else if (currentAccount()) {
    productionBackend.flushPending?.().catch((error) => {
      console.warn("Pending changes will retry automatically", error);
    });
  }
});
window.addEventListener("pagehide", () => {
  if (!currentAccount()) return;
  productionBackend.flushPending?.().catch(() => {});
});
