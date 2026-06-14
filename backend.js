(() => {
  const config = window.WEAREFIT_CONFIG || {};
  const configured =
    Boolean(config.production) &&
    Boolean(config.supabaseUrl) &&
    Boolean(config.supabasePublishableKey) &&
    !config.supabaseUrl.includes("YOUR_PROJECT");
  const client = configured
    ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.sessionStorage,
        },
      })
    : null;
  let accessibleStateRows = new Map();
  let saveTimer = null;
  let realtimeChannel = null;

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function usableDisplayName(value, email = "") {
    const name = String(value || "").trim();
    return name && normalizeEmail(name) !== normalizeEmail(email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)
      ? name
      : "";
  }

  async function throwFunctionError(error, fallback) {
    if (!error) return;
    let message = "";
    try {
      const payload = await error.context?.json();
      message = payload?.error || "";
    } catch {}
    throw new Error(message || error.message || fallback);
  }

  function cleanAccount(account) {
    const cleaned = structuredClone(account);
    delete cleaned.password;
    delete cleaned.verificationCode;
    cleaned.verified = true;
    return cleaned;
  }

  function stateForOwner(state, ownerEmail) {
    const owner = state.accounts[ownerEmail];
    if (!owner) return null;
    const connectedCoach = owner.coachEmail ? state.accounts[owner.coachEmail] : null;
    return {
      accounts: {
        [ownerEmail]: cleanAccount(owner),
        ...(connectedCoach ? { [connectedCoach.email]: { name: connectedCoach.name, email: connectedCoach.email, role: "coach", profilePhoto: connectedCoach.profilePhoto || null, lastActiveAt: connectedCoach.lastActiveAt || null } } : {}),
      },
      forms: Object.fromEntries(
        Object.entries(state.forms).filter(([, form]) => form.ownerEmail === ownerEmail),
      ),
      coachRequests: state.coachRequests.filter((item) => item.memberEmail === ownerEmail),
      coachInvites: state.coachInvites.filter(
        (item) => item.memberEmail === ownerEmail || item.coachEmail === ownerEmail,
      ),
      withdrawals: state.withdrawals.filter((item) => item.memberEmail === ownerEmail),
      sessions: state.sessions.filter((item) => item.memberEmail === ownerEmail),
      notifications: (state.notifications || []).filter((item) => item.memberEmail === ownerEmail),
      dismissedMilestoneKeys: state.dismissedMilestoneKeys || [],
      milestoneResetVersion: state.milestoneResetVersion || null,
      dateAutofillDisabled: true,
      sessionEmail: null,
    };
  }

  function mergeStates(rows, sessionEmail) {
    const merged = {
      accounts: {},
      forms: {},
      coachRequests: [],
      coachInvites: [],
      withdrawals: [],
      sessions: [],
      notifications: [],
      dismissedMilestoneKeys: [],
      milestoneResetVersion: null,
      dateAutofillDisabled: true,
      sessionEmail,
    };
    rows.forEach((row) => {
      const state = row.state || {};
      Object.assign(merged.accounts, state.accounts || {});
      Object.assign(merged.forms, state.forms || {});
      if (state.milestoneResetVersion) merged.milestoneResetVersion = state.milestoneResetVersion;
      merged.dismissedMilestoneKeys = [
        ...new Set([...(merged.dismissedMilestoneKeys || []), ...(state.dismissedMilestoneKeys || [])]),
      ];
      ["coachRequests", "coachInvites", "withdrawals", "sessions", "notifications"].forEach((key) => {
        const seen = new Set(merged[key].map((item) => item.id));
        (state[key] || []).forEach((item) => {
          if (!seen.has(item.id)) merged[key].push(item);
        });
      });
    });
    return merged;
  }

  async function session() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async function validateActiveAccount() {
    if (!client) return true;
    const { data, error } = await client.auth.getUser();
    if (!error && data.user) return true;
    const status = Number(error?.status || 0);
    const message = String(error?.message || "");
    if (status === 401 || status === 403 || /user not found|invalid.*jwt|jwt.*invalid|session.*missing|not authenticated/i.test(message)) {
      await client.auth.signOut({ scope: "local" }).catch(() => {});
      return false;
    }
    throw error;
  }

  async function hydrate() {
    if (!(await validateActiveAccount())) return null;
    const currentSession = await session();
    if (!currentSession) return null;
    const email = normalizeEmail(currentSession.user.email);
    const { data: rows, error } = await client
      .from("portal_states")
      .select("owner_id, owner_email, role, coach_email, state");
    if (error) throw error;
    accessibleStateRows = new Map(rows.map((row) => [row.owner_email, row]));
    if (!accessibleStateRows.has(email)) {
      const metadata = currentSession.user.user_metadata || {};
      const account = {
        name: metadata.name || email.split("@")[0],
        email,
        role: metadata.role === "coach" ? "coach" : "user",
        verified: true,
        profileCompleted: false,
        coachEmail: null,
        coachRequestStatus: null,
        preferences: { theme: "light" },
        profilePhoto: null,
        spousePhoto: null,
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
        savingsInvestmentAccounts: [],
        financialInventory: { recurringBills: [], creditCards: [], debts: [], studentLoans: [], mortgage: {} },
      };
      const state = {
        accounts: { [email]: account },
        forms: {},
        coachRequests: [],
        coachInvites: [],
        withdrawals: [],
        sessions: [],
        notifications: [],
        dateAutofillDisabled: true,
        sessionEmail: null,
      };
      const { error: insertError } = await client.from("portal_states").insert({
        owner_id: currentSession.user.id,
        owner_email: email,
        role: account.role,
        coach_email: null,
        state,
      });
      if (insertError) throw insertError;
      const createdState = { ...state, sessionEmail: email };
      await refreshFileUrls(createdState);
      return createdState;
    }
    const merged = mergeStates(rows, email);
    const { data: presenceRows, error: presenceError } = await client
      .from("account_presence")
      .select("email, last_active_at");
    if (presenceError && !/account_presence/i.test(presenceError.message || "")) throw presenceError;
    (presenceRows || []).forEach((presence) => {
      const presenceEmail = normalizeEmail(presence.email);
      merged.accounts[presenceEmail] ||= {
        name: "",
        email: presenceEmail,
        role: "coach",
        profilePhoto: null,
      };
      merged.accounts[presenceEmail].lastActiveAt = presence.last_active_at;
    });
    const currentAccount = merged.accounts[email];
    if (
      currentAccount?.role === "user" &&
      currentAccount.coachEmail &&
      !(
        usableDisplayName(currentAccount.coachName, currentAccount.coachEmail) ||
        usableDisplayName(merged.accounts[currentAccount.coachEmail]?.name, currentAccount.coachEmail)
      )
    ) {
      try {
        const { data: refreshedCoach, error: refreshError } = await client.functions.invoke("connect-coach", {
          body: { coachEmail: currentAccount.coachEmail, refreshOnly: true },
        });
        await throwFunctionError(refreshError, "The connected coach name could not be refreshed.");
        if (refreshedCoach?.coachName) {
          currentAccount.coachName = refreshedCoach.coachName;
          merged.accounts[currentAccount.coachEmail] = {
            ...(merged.accounts[currentAccount.coachEmail] || {}),
            name: refreshedCoach.coachName,
            email: currentAccount.coachEmail,
            role: "coach",
          };
        }
      } catch (refreshError) {
        console.warn("Could not refresh connected coach name", refreshError);
      }
    }
    await refreshFileUrls(merged);
    return merged;
  }

  async function refreshFileUrls(state) {
    for (const account of Object.values(state.accounts || {})) {
      for (const photo of [account.profilePhoto, account.spousePhoto]) {
        if (!photo?.storagePath) continue;
        const { data } = await client.storage.from("profile-photos").createSignedUrl(photo.storagePath, 3600);
        if (data?.signedUrl) photo.dataUrl = data.signedUrl;
      }
      for (const paystub of account.paystubs || []) {
        if (!paystub?.storagePath) continue;
        const { data } = await client.storage.from("financial-documents").createSignedUrl(paystub.storagePath, 3600);
        if (data?.signedUrl) paystub.dataUrl = data.signedUrl;
      }
    }
  }

  async function persist(state) {
    if (!(await validateActiveAccount())) return;
    const currentSession = await session();
    if (!currentSession) return;
    const currentEmail = normalizeEmail(currentSession.user.email);
    const current = state.accounts[currentEmail];
    if (!current) return;
    const { error: profileError } = await client
      .from("profiles")
      .update({ full_name: current.name || "", updated_at: new Date().toISOString() })
      .eq("id", currentSession.user.id);
    if (profileError) throw profileError;
    await updatePresence(current.lastActiveAt || null);
    const allowedOwners = Object.values(state.accounts).filter(
      (account) =>
        account.email === currentEmail ||
        (current.role === "coach" &&
          account.role === "user" &&
          account.coachEmail === currentEmail &&
          account.coachRequestStatus === "approved"),
    );
    for (const account of allowedOwners) {
      const existing = accessibleStateRows.get(account.email);
      const payload = {
        owner_id: existing?.owner_id || currentSession.user.id,
        owner_email: account.email,
        role: account.role,
        coach_email: account.coachEmail || null,
        state: stateForOwner(state, account.email),
        updated_at: new Date().toISOString(),
      };
      const { error } = await client.from("portal_states").upsert(payload, {
        onConflict: "owner_id",
      });
      if (error) throw error;
    }
  }

  async function updatePresence(lastActiveAt) {
    const currentSession = await session();
    if (!currentSession) return;
    const currentEmail = normalizeEmail(currentSession.user.email);
    const { error: presenceError } = await client.from("account_presence").upsert(
      {
        user_id: currentSession.user.id,
        email: currentEmail,
        last_active_at: lastActiveAt || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (presenceError && !/account_presence/i.test(presenceError.message || "")) throw presenceError;
  }

  function queuePersist(state) {
    if (!client) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist(state).catch(console.error), 800);
  }

  async function signUp({ name, email, password, role }) {
    const normalizedEmail = normalizeEmail(email);
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: { name, role },
        emailRedirectTo: config.appUrl,
      },
    });
    if (error) throw error;
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error("An account already exists for this email. Sign in or reset your password.");
    }
    return data;
  }

  async function signIn({ email, password }) {
    const { data, error } = await client.auth.signInWithPassword({
      email: normalizeEmail(email),
      password,
    });
    if (error) throw error;
    return data;
  }

  async function verifyOtp(email, token) {
    const { data, error } = await client.auth.verifyOtp({ email, token, type: "signup" });
    if (error) throw error;
    return data;
  }

  async function resendVerification(email) {
    const { error } = await client.auth.resend({
      type: "signup",
      email: normalizeEmail(email),
      options: { emailRedirectTo: config.appUrl },
    });
    if (error) throw error;
  }

  async function requestPasswordReset(email) {
    const redirectUrl = new URL(config.appUrl);
    redirectUrl.searchParams.set("passwordReset", "1");
    const { error } = await client.auth.resetPasswordForEmail(normalizeEmail(email), {
      redirectTo: redirectUrl.toString(),
    });
    if (error) throw error;
  }

  async function updatePassword(password) {
    const { error } = await client.auth.updateUser({ password });
    if (error) throw error;
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }

  async function sendCoachInvite(memberEmail) {
    const { data, error } = await client.functions.invoke("send-coach-invite", {
      body: { memberEmail: normalizeEmail(memberEmail), appUrl: config.appUrl },
    });
    if (error) throw error;
    return data;
  }

  async function connectCoach(coachEmail, invite = null) {
    const { data, error } = await client.functions.invoke("connect-coach", {
      body: { coachEmail, invite },
    });
    if (error) throw error;
    return data;
  }

  async function removeMentee(memberEmail) {
    const { data, error } = await client.functions.invoke("remove-mentee", {
      body: { memberEmail: normalizeEmail(memberEmail) },
    });
    await throwFunctionError(error, "The mentee relationship could not be removed.");
    return data;
  }

  async function sendSessionSummarySms(payload) {
    const { data, error } = await client.functions.invoke("send-session-summary-sms", {
      body: payload,
    });
    await throwFunctionError(error, "The completed session summary text could not be sent.");
    return data;
  }

  async function subscribeToPortalChanges(onChange) {
    if (!client) return;
    if (realtimeChannel) await client.removeChannel(realtimeChannel);
    realtimeChannel = client
      .channel("fit-portal-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "portal_states" }, () => onChange())
      .subscribe();
  }

  async function requestAccountDeletion() {
    const { data, error } = await client.functions.invoke("request-account-deletion");
    await throwFunctionError(error, "Deletion verification email could not be sent.");
    return data;
  }

  async function completeAccountDeletion(email, token) {
    const { data, error } = await client.functions.invoke("complete-account-deletion", {
      body: { email: normalizeEmail(email), token },
    });
    await throwFunctionError(error, "This deletion verification link is invalid or expired.");
    return data;
  }

  async function resendAccountDeletion(email, token) {
    const { data, error } = await client.functions.invoke("complete-account-deletion", {
      body: { action: "resend", email: normalizeEmail(email), token },
    });
    await throwFunctionError(error, "A new deletion verification email could not be sent.");
    return data;
  }

  async function uploadPrivateFile(bucket, file, category) {
    const currentSession = await session();
    if (!currentSession) throw new Error("Sign in before uploading a file.");
    const supportedTypes = {
      "profile-photos": ["image/png", "image/jpeg", "image/webp"],
      "financial-documents": ["application/pdf", "image/png", "image/jpeg"],
    };
    const sizeLimits = {
      "profile-photos": 1024 * 1024,
      "financial-documents": 2 * 1024 * 1024,
    };
    if (!supportedTypes[bucket]?.includes(file.type)) {
      throw new Error(
        bucket === "profile-photos"
          ? "Choose a PNG, JPG, or WebP profile photo."
          : "Choose a PDF, PNG, or JPG paystub.",
      );
    }
    if (file.size > sizeLimits[bucket]) {
      throw new Error(
        bucket === "profile-photos"
          ? "Profile photos must be 1 MB or smaller."
          : "Paystubs must be 2 MB or smaller.",
      );
    }
    const extension = file.name.split(".").pop()?.toLowerCase() || "bin";
    const safeCategory = category.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const path = `${currentSession.user.id}/${safeCategory}/${crypto.randomUUID()}.${extension}`;
    const { error } = await client.storage.from(bucket).upload(path, file, {
      contentType: file.type,
      upsert: false,
    });
    if (error) {
      if (/bucket not found/i.test(error.message || "")) {
        throw new Error("Secure file storage is being configured. Please try again shortly.");
      }
      if (/row-level security|policy/i.test(error.message || "")) {
        throw new Error("Your account does not have permission to upload this file.");
      }
      throw error;
    }
    const { data, error: signedError } = await client.storage.from(bucket).createSignedUrl(path, 3600);
    if (signedError) throw signedError;
    return { storagePath: path, dataUrl: data.signedUrl };
  }

  window.WEAREFIT_BACKEND = {
    enabled: configured,
    client,
    config,
    hydrate,
    queuePersist,
    saveNow: persist,
    updatePresence,
    validateActiveAccount,
    signUp,
    signIn,
    verifyOtp,
    resendVerification,
    requestPasswordReset,
    updatePassword,
    signOut,
    sendCoachInvite,
    connectCoach,
    removeMentee,
    sendSessionSummarySms,
    subscribeToPortalChanges,
    requestAccountDeletion,
    completeAccountDeletion,
    resendAccountDeletion,
    uploadPrivateFile,
  };
})();
