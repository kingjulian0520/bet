import * as Auth from "./auth.js";

const UNIT_VALUE_KEY = "closeCallsUnitValue";
const TIMEZONE_KEY = "closeCallsTimeZone";
const DISPLAY_MODE_KEY = "closeCallsDisplayMode";

// "units" or "dollars" - global toggle for whether unit/dollar amounts
// across the site show as units or as $ (computed from unit size). Instant,
// no reload - every render function checks this directly.
let displayMode = localStorage.getItem(DISPLAY_MODE_KEY) === "dollars" ? "dollars" : "units";

function wireDisplayModeToggle() {
  const btn = document.getElementById("display-mode-toggle");
  if (!btn) return;
  updateDisplayModeButton();
  btn.addEventListener("click", () => {
    displayMode = displayMode === "units" ? "dollars" : "units";
    localStorage.setItem(DISPLAY_MODE_KEY, displayMode);
    updateDisplayModeButton();
    renderAll();
  });
}

function updateDisplayModeButton() {
  const btn = document.getElementById("display-mode-toggle");
  if (!btn) return;
  btn.textContent = displayMode === "units" ? "U" : "$";
  btn.setAttribute(
    "aria-label",
    displayMode === "units" ? "Showing units — click to show dollars" : "Showing dollars — click to show units"
  );
}

// Formspree form ID for "Report an Issue" in the account menu. This ID
// only identifies which Formspree form relays the message - it does NOT
// reveal the destination email (that's set privately in the Formspree
// dashboard), so unlike a mailto: link this is safe to leave in public page
// source. Find/create it at formspree.io ("Forms" -> your form -> the
// f/xxxxxx part of its endpoint). Left as a placeholder until set.
const FORMSPREE_FORM_ID = "xnpndvzq";

const COMMON_TIME_ZONES = [
  { value: "auto", label: "Match my device" },
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "UTC", label: "UTC" },
];

let rawPicks = [];
let rawPrizePicks = [];
let currentPicks = [];
let currentPrizePicks = [];
let currentSettled = [];
let currentLadder = [];

// currentUser/profileCache are set once Supabase resolves the login state.
// Until then (and always, if accounts aren't configured or the visitor
// isn't signed in) everything reads/writes localStorage - "guest mode",
// which is exactly how the site behaved before accounts existed.
let currentUser = null;
let profileCache = null;
let generatedAt = null;
let avatarCropper = null;
let unlockedThisSession = false;
let unlockedWithCode = null;

// ---------- storage ----------

// Exact dollar amount, not rounded to a whole number - "$7.50", not "~$8".
// Trims a trailing zero cent (7.50 -> "7.5") but keeps whole numbers plain.
function formatMoney(n) {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
}

function getUnitValue() {
  if (currentUser) return (profileCache && profileCache.unitValue) || null;
  const stored = localStorage.getItem(UNIT_VALUE_KEY);
  return stored ? parseFloat(stored) : null;
}

function setUnitValue(value) {
  if (currentUser) {
    if (profileCache) profileCache.unitValue = value;
    Auth.saveMyProfile(currentUser.id, { unitValue: value }).catch((err) => {
      console.warn("Couldn't sync unit size to your account.", err);
    });
    return;
  }
  try {
    localStorage.setItem(UNIT_VALUE_KEY, String(value));
  } catch (err) {
    // ignore — localStorage may be unavailable (private browsing etc.)
  }
}

// ---------- accounts ----------

function renderAccountBar() {
  const loggedOutEl = document.getElementById("account-logged-out");
  const loggedInEl = document.getElementById("account-logged-in");
  if (!loggedOutEl || !loggedInEl) return;

  const unitValueInput = document.getElementById("unit-value-input");

  if (currentUser && profileCache) {
    loggedOutEl.hidden = true;
    loggedInEl.hidden = false;
    document.getElementById("account-username").textContent = `@${profileCache.username || "you"}`;
    unitValueInput.value = profileCache.unitValue || "";
  } else {
    loggedOutEl.hidden = false;
    loggedInEl.hidden = true;
    const stored = localStorage.getItem(UNIT_VALUE_KEY);
    unitValueInput.value = stored || "";
  }
}

async function applyAuthState(user) {
  currentUser = user;

  if (!user) {
    profileCache = null;
    unlockedThisSession = false;
    unlockedWithCode = null;
    renderAccountBar();
    renderAll();
    return;
  }

  try {
    let profile = await Auth.getMyProfile(user.id);
    if (!profile) profile = { username: user.email, unitValue: null };

    // First login on this browser with an existing guest unit size already
    // set and nothing in the cloud yet - bring it along instead of silently
    // losing it.
    const localUnitValue = parseFloat(localStorage.getItem(UNIT_VALUE_KEY));
    if (!profile.unitValue && !isNaN(localUnitValue) && localUnitValue > 0) {
      profile.unitValue = localUnitValue;
      await Auth.saveMyProfile(user.id, { unitValue: localUnitValue });
    }

    profileCache = profile;
  } catch (err) {
    console.warn("Couldn't load your account data.", err);
    profileCache = { username: user.email, unitValue: null };
  }

  renderAccountBar();
  renderAll();
}

// ---------- picks lock ----------

// Deliberately in-memory only, not saved to the profile or localStorage -
// resets on every page load/reopen so the passcode has to be re-entered
// each time, even though the login itself stays signed in (Supabase
// persists that separately).
function isUnlocked() {
  return !!(currentUser && unlockedThisSession);
}

function renderLockOverlays() {
  ["picks", "prizepicks", "ladder"].forEach((prefix) => renderLockOverlay(prefix));
}

function renderLockOverlay(prefix) {
  const overlay = document.getElementById(`${prefix}-lock-overlay`);
  const lockable = document.getElementById(`${prefix}-lockable`);
  const bodyEl = document.getElementById(`${prefix}-lock-body`);
  if (!overlay || !lockable || !bodyEl) return;

  if (isUnlocked()) {
    overlay.hidden = true;
    lockable.classList.remove("locked");
    return;
  }

  lockable.classList.add("locked");
  overlay.hidden = false;
  overlay.classList.remove("fading");

  if (!currentUser) {
    bodyEl.innerHTML = `
      <p class="lock-note">Sign in to unlock today's picks.</p>
      <button class="pill-btn lock-signin-btn">Sign In / Sign Up</button>
    `;
    bodyEl.querySelector(".lock-signin-btn").addEventListener("click", () => {
      document.getElementById("open-auth-btn").click();
    });
    return;
  }

  bodyEl.innerHTML = `
    <p class="lock-note">Enter today's passcode to unlock.</p>
    <input type="text" class="auth-input lock-passcode-input" placeholder="Passcode" autocomplete="off">
    <button class="primary-btn lock-unlock-btn">Unlock</button>
    <p class="lock-error" hidden></p>
    <a class="lock-discord-link" href="https://discord.gg/zpaWeTPy8" target="_blank" rel="noopener">Don't have a code? Join our Discord</a>
  `;

  const input = bodyEl.querySelector(".lock-passcode-input");
  const btn = bodyEl.querySelector(".lock-unlock-btn");
  const errEl = bodyEl.querySelector(".lock-error");

  const attempt = async () => {
    const code = input.value.trim();
    if (!code) return;
    errEl.hidden = true;
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const ok = await Auth.verifyAccessCode(code);
      if (ok) {
        unlockedThisSession = true;
        unlockedWithCode = code;
        unlockOverlaysWithFade();
      } else {
        errEl.textContent = "Wrong passcode — try again.";
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Unlock";
      }
    } catch (err) {
      errEl.textContent = "Couldn't check that — try again.";
      errEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  };

  btn.addEventListener("click", attempt);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") attempt();
  });
}

function unlockOverlaysWithFade() {
  ["picks", "prizepicks", "ladder"].forEach((prefix) => {
    const overlay = document.getElementById(`${prefix}-lock-overlay`);
    const lockable = document.getElementById(`${prefix}-lockable`);
    if (!overlay || !lockable) return;
    overlay.classList.add("fading");
    lockable.classList.remove("locked");
    setTimeout(() => {
      overlay.hidden = true;
    }, 400);
  });
}

function wireAuthUI() {
  const backdrop = document.getElementById("auth-modal-backdrop");
  const openBtn = document.getElementById("open-auth-btn");

  const tabs = document.querySelectorAll(".auth-tab-btn");
  const authTabsEl = document.getElementById("auth-tabs");
  const panels = {
    signin: document.getElementById("auth-signin-panel"),
    signup: document.getElementById("auth-signup-panel"),
    reset: document.getElementById("auth-reset-panel"),
  };

  const titleEl = document.getElementById("auth-modal-title");
  const subtitleEl = document.getElementById("auth-modal-subtitle");
  const copy = {
    signin: ["Welcome back", "Sign in to unlock today's picks and sync your unit size."],
    signup: ["Create your account", "Create an account to unlock daily picks."],
    reset: ["Reset your password", "We'll email you a link to set a new one."],
  };

  function showTab(name) {
    authTabsEl.hidden = name === "reset";
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.authtab === name));
    panels.signin.hidden = name !== "signin";
    panels.signup.hidden = name !== "signup";
    panels.reset.hidden = name !== "reset";
    titleEl.textContent = copy[name][0];
    subtitleEl.textContent = copy[name][1];
  }

  tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.authtab)));

  openBtn.addEventListener("click", async () => {
    if (!(await Auth.isAccountsReady())) {
      alert("Accounts aren't set up on this site yet.");
      return;
    }
    document.getElementById("signin-error").hidden = true;
    const signupErrEl = document.getElementById("signup-error");
    signupErrEl.hidden = true;
    signupErrEl.classList.remove("auth-notice");
    showTab("signin");
    backdrop.hidden = false;
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target.id === "auth-modal-backdrop") backdrop.hidden = true;
  });
  document.querySelectorAll(".auth-cancel").forEach((btn) => {
    btn.addEventListener("click", () => (backdrop.hidden = true));
  });

  document.getElementById("signin-submit").addEventListener("click", async () => {
    const email = document.getElementById("signin-email").value.trim();
    const password = document.getElementById("signin-password").value;
    const errEl = document.getElementById("signin-error");
    errEl.hidden = true;
    try {
      await Auth.signIn(email, password);
      backdrop.hidden = true;
    } catch (err) {
      errEl.textContent = err.message || "Couldn't sign in.";
      errEl.hidden = false;
    }
  });

  document.getElementById("signup-submit").addEventListener("click", async () => {
    const username = document.getElementById("signup-username").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const errEl = document.getElementById("signup-error");
    errEl.hidden = true;
    try {
      const { needsEmailConfirmation } = await Auth.signUp(username, email, password);
      if (needsEmailConfirmation) {
        errEl.textContent = "Account created — check your email to confirm it, then sign in.";
        errEl.hidden = false;
        errEl.classList.add("auth-notice");
      } else {
        backdrop.hidden = true;
      }
    } catch (err) {
      errEl.classList.remove("auth-notice");
      errEl.textContent = err.message || "Couldn't sign up.";
      errEl.hidden = false;
    }
  });

  document.getElementById("forgot-password-link").addEventListener("click", () => {
    document.getElementById("reset-error").hidden = true;
    document.getElementById("reset-email").value = document.getElementById("signin-email").value;
    showTab("reset");
  });

  document.getElementById("reset-back").addEventListener("click", () => showTab("signin"));

  document.getElementById("reset-submit").addEventListener("click", async () => {
    const email = document.getElementById("reset-email").value.trim();
    const errEl = document.getElementById("reset-error");
    errEl.classList.remove("auth-notice");
    errEl.hidden = true;
    if (!email) {
      errEl.textContent = "Enter your email first.";
      errEl.hidden = false;
      return;
    }
    try {
      await Auth.sendPasswordReset(email);
      errEl.textContent = "Check your email for a link to reset your password.";
      errEl.classList.add("auth-notice");
      errEl.hidden = false;
    } catch (err) {
      errEl.textContent = err.message || "Couldn't send that — try again.";
      errEl.hidden = false;
    }
  });

  Auth.onAuthChange(applyAuthState);
}

function wirePasswordRecovery() {
  const backdrop = document.getElementById("new-password-backdrop");
  const input = document.getElementById("new-password-input");
  const errEl = document.getElementById("new-password-error");
  const submitBtn = document.getElementById("new-password-submit");

  Auth.onPasswordRecovery(() => {
    document.getElementById("auth-modal-backdrop").hidden = true;
    input.value = "";
    errEl.hidden = true;
    backdrop.hidden = false;
  });

  submitBtn.addEventListener("click", async () => {
    const newPassword = input.value;
    errEl.hidden = true;
    if (newPassword.length < 6) {
      errEl.textContent = "Password must be at least 6 characters.";
      errEl.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await Auth.updatePassword(newPassword);
      backdrop.hidden = true;
    } catch (err) {
      errEl.textContent = err.message || "Couldn't update your password — try again.";
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Save new password";
    }
  });
}

// ---------- account menu / panels ----------

function getTimeZone() {
  return localStorage.getItem(TIMEZONE_KEY) || "auto";
}

function setTimeZone(tz) {
  try {
    localStorage.setItem(TIMEZONE_KEY, tz);
  } catch (err) {
    // ignore
  }
}

function refreshLastUpdatedLabel() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  if (!generatedAt) {
    el.textContent = "Not run yet.";
    return;
  }
  const tz = getTimeZone();
  const options = { dateStyle: "short", timeStyle: "short" };
  if (tz !== "auto") options.timeZone = tz;
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat(undefined, options).format(new Date(generatedAt));
  } catch (err) {
    formatted = new Date(generatedAt).toLocaleString();
  }
  el.textContent = "Last updated " + formatted;
}

function openAccountPanel(type) {
  const backdrop = document.getElementById("account-panel-backdrop");
  const titleEl = document.getElementById("account-panel-title");
  const contentEl = document.getElementById("account-panel-content");

  const renderers = {
    profile: renderProfilePanel,
    report: renderReportPanel,
    timezone: renderTimezonePanel,
  };
  const titles = {
    profile: "Your profile",
    report: "Report an issue",
    timezone: "Change time zone",
  };

  titleEl.textContent = titles[type] || "";
  contentEl.innerHTML = "";
  (renderers[type] || (() => {}))(contentEl);
  backdrop.hidden = false;
}

function closeAccountPanel() {
  document.getElementById("account-panel-backdrop").hidden = true;
}

function renderProfilePanel(root) {
  if (!currentUser || !profileCache) {
    root.innerHTML = `<p class="account-panel-note">Sign in to see your profile.</p>`;
    return;
  }
  const initial = (profileCache.username || "?").charAt(0).toUpperCase();
  const avatarInner = profileCache.avatarUrl
    ? `<img src="${escapeAttr(profileCache.avatarUrl)}" alt="">`
    : escapeHtml(initial);

  root.innerHTML = `
    <div class="profile-avatar-row">
      <div class="profile-avatar" id="profile-avatar">${avatarInner}</div>
      <div class="profile-avatar-actions">
        <button id="profile-avatar-upload-btn" class="secondary-btn">Change photo</button>
        <input type="file" id="profile-avatar-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
        <p id="profile-avatar-status" class="account-panel-note" hidden></p>
      </div>
    </div>
  `;

  const fileInput = document.getElementById("profile-avatar-input");
  const statusEl = document.getElementById("profile-avatar-status");
  document.getElementById("profile-avatar-upload-btn").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      statusEl.textContent = "Image must be 2MB or smaller.";
      statusEl.hidden = false;
      return;
    }
    statusEl.hidden = true;
    openAvatarCropModal(file, root);
  });
}

function openAvatarCropModal(file, profileRoot) {
  const backdrop = document.getElementById("avatar-crop-backdrop");
  const imgEl = document.getElementById("avatar-crop-image");
  const cancelBtn = document.getElementById("avatar-crop-cancel");
  const saveBtn = document.getElementById("avatar-crop-save");

  const cleanup = () => {
    if (avatarCropper) {
      avatarCropper.destroy();
      avatarCropper = null;
    }
    backdrop.hidden = true;
  };

  const reader = new FileReader();
  reader.onload = () => {
    imgEl.src = reader.result;
    backdrop.hidden = false;
    if (avatarCropper) avatarCropper.destroy();
    avatarCropper = new Cropper(imgEl, {
      aspectRatio: 1,
      viewMode: 1,
      autoCropArea: 1,
      background: false,
    });
  };
  reader.readAsDataURL(file);

  cancelBtn.onclick = cleanup;
  backdrop.onclick = (e) => {
    if (e.target.id === "avatar-crop-backdrop") cleanup();
  };

  saveBtn.onclick = () => {
    if (!avatarCropper) return;
    avatarCropper.getCroppedCanvas({ width: 400, height: 400 }).toBlob(
      async (blob) => {
        cleanup();
        const statusEl = document.getElementById("profile-avatar-status");
        if (statusEl) {
          statusEl.textContent = "Uploading…";
          statusEl.hidden = false;
        }
        try {
          const url = await Auth.uploadAvatar(currentUser.id, blob);
          if (profileCache) profileCache.avatarUrl = url;
          renderProfilePanel(profileRoot);
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = "Upload failed — try a different image.";
            statusEl.hidden = false;
          }
        }
      },
      "image/jpeg",
      0.9
    );
  };
}

function renderReportPanel(root) {
  if (FORMSPREE_FORM_ID.startsWith("REPLACE_")) {
    root.innerHTML = `<p class="account-panel-note">Reporting isn't set up yet — add a Formspree form ID (FORMSPREE_FORM_ID) in script.js to turn this on.</p>`;
    return;
  }
  root.innerHTML = `
    <p class="account-panel-note">Found a bug or a bad pick? Let us know what happened.</p>
    <label class="modal-label" for="report-message">What happened?</label>
    <textarea id="report-message" class="auth-input report-textarea" rows="4" placeholder="Describe the issue..."></textarea>
    <label class="modal-label" for="report-email">Your email (optional, so we can follow up)</label>
    <input id="report-email" class="auth-input" type="email" placeholder="you@example.com">
    <p id="report-status" class="account-panel-note" hidden></p>
    <button id="report-submit" class="primary-btn account-panel-cta">Send report</button>
  `;

  document.getElementById("report-submit").addEventListener("click", async () => {
    const messageEl = document.getElementById("report-message");
    const emailEl = document.getElementById("report-email");
    const statusEl = document.getElementById("report-status");
    const message = messageEl.value.trim();

    if (!message) {
      statusEl.textContent = "Describe the issue before sending.";
      statusEl.hidden = false;
      return;
    }

    statusEl.textContent = "Sending…";
    statusEl.hidden = false;

    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_FORM_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          email: emailEl.value.trim() || undefined,
          message,
          _subject: "Close Calls issue report",
        }),
      });
      if (res.ok) {
        statusEl.textContent = "Sent — thanks for the report.";
        messageEl.value = "";
        emailEl.value = "";
      } else {
        statusEl.textContent = "Couldn't send that — try again in a moment.";
      }
    } catch (err) {
      statusEl.textContent = "Couldn't send that — try again in a moment.";
    }
  });
}

function renderTimezonePanel(root) {
  const current = getTimeZone();
  const options = COMMON_TIME_ZONES.map(
    (z) => `<option value="${z.value}" ${z.value === current ? "selected" : ""}>${escapeHtml(z.label)}</option>`
  ).join("");
  root.innerHTML = `
    <label class="modal-label" for="timezone-select">Time zone</label>
    <select id="timezone-select" class="timezone-select">${options}</select>
    <p class="account-panel-note">Used for the "last updated" timestamp. Game dates are shown as-is for now, not yet adjusted per time zone.</p>
    <button id="timezone-save" class="primary-btn account-panel-cta">Save</button>
  `;
  document.getElementById("timezone-save").addEventListener("click", () => {
    const select = document.getElementById("timezone-select");
    setTimeZone(select.value);
    refreshLastUpdatedLabel();
    closeAccountPanel();
  });
}

function wireAccountMenu() {
  const menuBtn = document.getElementById("account-menu-btn");
  const dropdown = document.getElementById("account-menu-dropdown");

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.hidden;
    dropdown.hidden = isOpen;
    menuBtn.setAttribute("aria-expanded", String(!isOpen));
  });

  dropdown.querySelectorAll(".account-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      dropdown.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
      const action = item.dataset.action;
      if (action === "signout") {
        Auth.signOutUser();
      } else {
        openAccountPanel(action);
      }
    });
  });

  document.getElementById("account-panel-close").addEventListener("click", closeAccountPanel);
  document.getElementById("account-panel-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "account-panel-backdrop") closeAccountPanel();
  });
}

// ---------- boot ----------

async function main() {
  wireTabs();
  wireCalendar();
  wireLadderNav();
  wireDisplayModeToggle();
  wireBreakdownModal();
  wireAuthUI();
  wireAccountMenu();
  wirePasswordRecovery();
  wireSportFilter();
  wireSortDropdown();
  wirePPPlatformSelect();
  applyPPPlatformLabel();

  document.addEventListener("click", (e) => {
    const accountDropdown = document.getElementById("account-menu-dropdown");
    if (accountDropdown && !accountDropdown.hidden && !e.target.closest(".account-menu-wrap")) {
      accountDropdown.hidden = true;
      document.getElementById("account-menu-btn").setAttribute("aria-expanded", "false");
    }
    const sortDropdown = document.getElementById("sort-dropdown");
    if (sortDropdown && !sortDropdown.hidden && !e.target.closest(".picks-sort-wrap")) {
      sortDropdown.hidden = true;
    }
    const ppDropdown = document.getElementById("prizepicks-platform-dropdown");
    if (ppDropdown && !ppDropdown.hidden && !e.target.closest(".tab-picker-wrap")) {
      ppDropdown.hidden = true;
      document.getElementById("prizepicks-tab-btn")?.setAttribute("aria-expanded", "false");
    }
  });

  const unitValueInput = document.getElementById("unit-value-input");
  const savedUnitValue = getUnitValue();
  if (savedUnitValue) unitValueInput.value = savedUnitValue;
  unitValueInput.addEventListener("input", () => {
    const val = parseFloat(unitValueInput.value);
    if (!isNaN(val) && val > 0) setUnitValue(val);
    renderAll();
  });

  const root = document.getElementById("picks-root");

  let data;
  try {
    const res = await fetch("data/picks.json", { cache: "no-store" });
    data = await res.json();
  } catch (err) {
    root.innerHTML = '<p class="empty-state">Could not load picks data.</p>';
    return;
  }

  generatedAt = data.generated_at || null;
  refreshLastUpdatedLabel();

  rawPicks = data.picks || [];
  rawPrizePicks = data.prizepicks || [];
  currentSettled = data.settled || [];
  currentLadder = data.ladder || [];
  prunePicks();

  const todayStr = todayDateStr();
  if (currentPicks.some((p) => p.date === todayStr)) {
    selectedDayFilter = todayStr;
  }
  if (currentPrizePicks.some((p) => p.date === todayStr)) {
    selectedPrizePicksDayFilter = todayStr;
  }

  renderAll();

  setInterval(async () => {
    const hadPicks = currentPicks.length;
    prunePicks();
    if (currentPicks.length !== hadPicks) {
      renderAll();
    }

    // The tab might have been left open across a code rotation - re-check
    // the code that unlocked it is still today's code, not just whether a
    // reload happened. Re-locks immediately (no reload needed) the moment
    // it no longer matches.
    if (unlockedThisSession && unlockedWithCode) {
      const stillValid = await Auth.verifyAccessCode(unlockedWithCode);
      if (!stillValid) {
        unlockedThisSession = false;
        unlockedWithCode = null;
        renderLockOverlays();
      }
    }
  }, 60000);
}

// A pick with a known start_time disappears from the browsable list once
// that time passes - you can't act on something already underway.
// Settlement (once the result is known) is separate and still handled via
// the "settled" array regardless of this filter.
function hasStarted(pick) {
  return !!pick.start_time && new Date(pick.start_time).getTime() <= Date.now();
}

function prunePicks() {
  currentPicks = rawPicks.filter((p) => !hasStarted(p));
  currentPrizePicks = rawPrizePicks.filter((p) => !hasStarted(p));
}

function renderAll() {
  prunePicks();
  renderDayFilterBar();
  renderPicks();
  renderPrizePicks();
  renderCalendar();
  renderLadder();
  renderLockOverlays();
}

// ---------- tabs ----------

function wireTabs() {
  document.querySelectorAll(".tab-btn:not(#prizepicks-tab-btn)").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });
}

// ---------- picks ----------

let selectedDayFilter = "all";
let selectedPrizePicksDayFilter = "all";

// Which platform this tab is filtered to - the site owner places these
// picks across several apps (PrizePicks, Courtside, BetMGM, FanDuel,
// Underdog, Kalshi). The tab bubble is a button that opens a small
// dropdown (matching the sort/account menus elsewhere on the site);
// picking an option both switches to this tab and filters
// currentPrizePicks down to entries tagged with that platform.
const PP_PLATFORM_STORAGE_KEY = "ppPlatformNameV2";
let ppPlatformName = localStorage.getItem(PP_PLATFORM_STORAGE_KEY) || "PrizePicks";

function applyPPPlatformLabel() {
  const label = document.getElementById("prizepicks-tab-label");
  if (label) label.textContent = ppPlatformName;

  const dropdown = document.getElementById("prizepicks-platform-dropdown");
  if (dropdown) {
    dropdown.querySelectorAll(".tab-picker-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.platform === ppPlatformName);
    });
  }

  const intro = document.getElementById("prizepicks-intro");
  if (intro) {
    intro.textContent = `Picks built specifically for ${ppPlatformName}, packaged as ${ppPlatformName}-style player prop parlays. Held empty until there's a reliable stats source backing them — no picks here are guesses.`;
  }
}

function wirePPPlatformSelect() {
  const trigger = document.getElementById("prizepicks-tab-btn");
  const dropdown = document.getElementById("prizepicks-platform-dropdown");
  if (!trigger || !dropdown) return;

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    trigger.classList.add("active");
    trigger.setAttribute("aria-selected", "true");
    document.getElementById(trigger.dataset.tab).classList.add("active");

    const isOpen = !dropdown.hidden;
    dropdown.hidden = isOpen;
    trigger.setAttribute("aria-expanded", String(!isOpen));
  });

  dropdown.querySelectorAll(".tab-picker-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      ppPlatformName = opt.dataset.platform;
      localStorage.setItem(PP_PLATFORM_STORAGE_KEY, ppPlatformName);
      dropdown.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      applyPPPlatformLabel();
      renderPrizePicks();
    });
  });
}

// Sport filter: applied (activeSportFilters) vs staged-in-the-modal
// (pendingSportFilters) - selecting chips doesn't change what's shown until
// "Adjust filters" is clicked. Empty set means no filter (show every sport).
let activeSportFilters = new Set();
let pendingSportFilters = new Set();

// "featured" (existing sport-grouped/original-order layout), "closest"
// (soonest start_time first), or "confidence" (highest recommended_units
// first). Applies immediately on selection, unlike the staged filters.
let picksSortMode = "featured";

// Strips trailing qualifiers so prop/total/spread variants of a league
// group under the same filter chip as its moneyline (e.g. "WNBA Player
// Props" and "WNBA" both become "WNBA").
function sportGroup(sport) {
  const s = String(sport || "").trim();
  return s.replace(/\s+(Player Props|Totals|Spreads)$/i, "").trim() || s;
}

const SPORT_ICON_SVGS = {
  football: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><path d="M12 8v8M9.5 9.5h5M9.5 12h5M9.5 14.5h5"/>',
  basketball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8"/>',
  baseball: '<circle cx="12" cy="12" r="9"/><path d="M7 5c3 3 3 11 0 14M17 5c-3 3-3 11 0 14"/>',
  hockey: '<circle cx="6" cy="18" r="2"/><path d="M9 4v11h11"/>',
  soccer: '<circle cx="12" cy="12" r="9"/><path d="M12 8l3.5 2.5-1.3 4.1h-4.4L8.5 10.5z"/>',
  mma: '<path d="M7 10V7a2 2 0 0 1 4 0v.5M11 7.5V6a2 2 0 0 1 4 0v2M15 8v1a2 2 0 0 1 4 0v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5v-3l1.5-1.5"/>',
  tennis: '<circle cx="12" cy="12" r="9"/><path d="M4 8c4 2 4 6 0 8M20 8c-4 2-4 6 0 8"/>',
  darts: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  tabletennis: '<circle cx="10" cy="9" r="5"/><path d="M13 13l6 6"/>',
  generic: '<path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L12 16.9 6.4 20l1.4-6.2L3 9.5l6.4-.6z"/>',
};

function sportIconSvg(group) {
  const g = group.toLowerCase();
  let key = "generic";
  if (g.includes("football") || g === "nfl" || g === "cfb") key = "football";
  else if (g.includes("wnba") || g.includes("nba") || g.includes("basketball")) key = "basketball";
  else if (g.includes("mlb") || g.includes("baseball")) key = "baseball";
  else if (g.includes("nhl") || g.includes("hockey")) key = "hockey";
  else if (g.includes("wta") || g.includes("atp") || g.includes("tennis")) key = "tennis";
  else if (g.includes("ufc") || g.includes("mma")) key = "mma";
  else if (g.includes("dart")) key = "darts";
  else if (g.includes("table tennis") || g.includes("wtt") || g.includes("ittf")) key = "tabletennis";
  else if (/soccer|premier|la liga|mls|champions league|uefa|bundesliga|serie a|ligue 1|efl/.test(g)) key = "soccer";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SPORT_ICON_SVGS[key]}</svg>`;
}

// Bet-type filter: same staged-then-apply pattern as the sport filter,
// sharing the one "Adjust filters" button in the same modal.
let activeMarketFilters = new Set();
let pendingMarketFilters = new Set();

const MARKET_TYPES = ["Moneyline", "Over/Under", "Yes/No"];
const MARKET_ICON_SVGS = {
  Moneyline: '<path d="M6 21V4M6 4h11l-2 3.5L17 11H6"/>',
  "Over/Under": '<path d="M12 3v18M7 8l5-5 5 5M7 16l5 5 5-5"/>',
  "Yes/No": '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
};

function marketIconSvg(type) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${MARKET_ICON_SVGS[type] || SPORT_ICON_SVGS.generic}</svg>`;
}

// Classifies a pick by its estimated_probability key shape rather than its
// sport, so it works the same across every league without a lookup table.
function pickMarketType(pick) {
  const keys = Object.keys(pick.estimated_probability || {});
  if (keys.length === 2 && keys.includes("Yes") && keys.includes("No")) return "Yes/No";
  if (keys.some((k) => /^(over|under)\b/i.test(k))) return "Over/Under";
  return "Moneyline";
}

function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function renderDayFilterBar() {
  const bar = document.getElementById("day-filter-bar");
  if (!bar) return;

  const todayStr = todayDateStr();
  // Always show today + the next 2 days as selectable, even before any picks
  // exist for them yet - so it's clear those days are coming, not missing.
  const windowDates = [todayStr, addDaysStr(todayStr, 1), addDaysStr(todayStr, 2)];
  const pickDates = currentPicks.map((p) => p.date).filter(Boolean);
  const dates = [...new Set([...windowDates, ...pickDates])].sort();

  if (selectedDayFilter !== "all" && !dates.includes(selectedDayFilter)) {
    selectedDayFilter = "all";
  }

  const options = [{ value: "all", label: "All days" }].concat(
    dates.map((d) => ({ value: d, label: d === todayStr ? "Today" : d }))
  );

  bar.innerHTML = "";
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "day-chip" + (opt.value === selectedDayFilter ? " active" : "");
    chip.textContent = opt.label;
    chip.addEventListener("click", () => {
      selectedDayFilter = opt.value;
      renderDayFilterBar();
      renderPicks();
    });
    bar.appendChild(chip);
  }
}

function renderPrizePicksDayFilterBar() {
  const bar = document.getElementById("prizepicks-day-filter-bar");
  if (!bar) return;

  const todayStr = todayDateStr();
  const windowDates = [todayStr, addDaysStr(todayStr, 1), addDaysStr(todayStr, 2)];
  const pickDates = currentPrizePicks.map((p) => p.date).filter(Boolean);
  const dates = [...new Set([...windowDates, ...pickDates])].sort();

  if (selectedPrizePicksDayFilter !== "all" && !dates.includes(selectedPrizePicksDayFilter)) {
    selectedPrizePicksDayFilter = "all";
  }

  const options = [{ value: "all", label: "All days" }].concat(
    dates.map((d) => ({ value: d, label: d === todayStr ? "Today" : d }))
  );

  bar.innerHTML = "";
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "day-chip" + (opt.value === selectedPrizePicksDayFilter ? " active" : "");
    chip.textContent = opt.label;
    chip.addEventListener("click", () => {
      selectedPrizePicksDayFilter = opt.value;
      renderPrizePicksDayFilterBar();
      renderPrizePicks();
    });
    bar.appendChild(chip);
  }
}

function updateSportFilterCount() {
  const badge = document.getElementById("sport-filter-count");
  if (!badge) return;
  const total = activeSportFilters.size + activeMarketFilters.size;
  if (total > 0) {
    badge.textContent = String(total);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderChipGrid(gridId, options, pendingSet) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (options.length === 0) {
    grid.innerHTML = '<p class="account-panel-note">No picks to filter yet.</p>';
    return;
  }

  grid.innerHTML = "";
  for (const { value, label, icon } of options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sport-chip" + (pendingSet.has(value) ? " selected" : "");
    chip.innerHTML = `
      <span class="sport-chip-icon">${icon}</span>
      <span class="sport-chip-label">${escapeHtml(label)}</span>
    `;
    chip.addEventListener("click", () => {
      if (pendingSet.has(value)) {
        pendingSet.delete(value);
      } else {
        pendingSet.add(value);
      }
      chip.classList.toggle("selected");
    });
    grid.appendChild(chip);
  }
}

function renderSportFilterGrid() {
  const groups = [...new Set(currentPicks.map((p) => sportGroup(p.sport)).filter(Boolean))].sort();
  renderChipGrid(
    "sport-filter-grid",
    groups.map((g) => ({ value: g, label: g, icon: sportIconSvg(g) })),
    pendingSportFilters
  );
}

function renderMarketFilterGrid() {
  const types = MARKET_TYPES.filter((t) => currentPicks.some((p) => pickMarketType(p) === t));
  renderChipGrid(
    "market-filter-grid",
    types.map((t) => ({ value: t, label: t, icon: marketIconSvg(t) })),
    pendingMarketFilters
  );
}

function wireSportFilter() {
  const openBtn = document.getElementById("open-sport-filter-btn");
  const backdrop = document.getElementById("sport-filter-backdrop");
  const closeBtn = document.getElementById("sport-filter-close");
  const applyBtn = document.getElementById("sport-filter-apply");
  if (!openBtn || !backdrop || !closeBtn || !applyBtn) return;

  openBtn.addEventListener("click", () => {
    pendingSportFilters = new Set(activeSportFilters);
    pendingMarketFilters = new Set(activeMarketFilters);
    renderSportFilterGrid();
    renderMarketFilterGrid();
    backdrop.hidden = false;
  });

  const close = () => (backdrop.hidden = true);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target.id === "sport-filter-backdrop") close();
  });

  applyBtn.addEventListener("click", () => {
    activeSportFilters = new Set(pendingSportFilters);
    activeMarketFilters = new Set(pendingMarketFilters);
    updateSportFilterCount();
    close();
    renderPicks();
  });
}

function wireSortDropdown() {
  const wrap = document.getElementById("picks-sort-wrap");
  const openBtn = document.getElementById("open-sort-btn");
  const dropdown = document.getElementById("sort-dropdown");
  const labelEl = document.getElementById("sort-current-label");
  if (!wrap || !openBtn || !dropdown || !labelEl) return;

  const labels = { featured: "Featured", closest: "Closest Upcoming", confidence: "By Confidence" };

  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });

  dropdown.querySelectorAll(".sort-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      picksSortMode = btn.dataset.sort;
      labelEl.textContent = labels[picksSortMode];
      dropdown.querySelectorAll(".sort-option").forEach((b) => b.classList.toggle("active", b === btn));
      dropdown.hidden = true;
      renderPicks();
    });
  });
}

function sortPicksForDisplay(picks, mode) {
  if (mode === "closest") {
    return [...picks].sort((a, b) => {
      const ta = a.start_time ? new Date(a.start_time).getTime() : Infinity;
      const tb = b.start_time ? new Date(b.start_time).getTime() : Infinity;
      return ta - tb;
    });
  }
  if (mode === "confidence") {
    return [...picks].sort((a, b) => (b.recommended_units || 0) - (a.recommended_units || 0));
  }
  return picks;
}

function renderPicks() {
  const root = document.getElementById("picks-root");

  let visiblePicks =
    selectedDayFilter === "all" ? currentPicks : currentPicks.filter((p) => p.date === selectedDayFilter);
  if (activeSportFilters.size > 0) {
    visiblePicks = visiblePicks.filter((p) => activeSportFilters.has(sportGroup(p.sport)));
  }
  if (activeMarketFilters.size > 0) {
    visiblePicks = visiblePicks.filter((p) => activeMarketFilters.has(pickMarketType(p)));
  }

  const hasActiveFilters = activeSportFilters.size > 0 || activeMarketFilters.size > 0;

  if (visiblePicks.length === 0) {
    const todayStr = todayDateStr();
    const msg = hasActiveFilters
      ? "No picks match your filters right now - try adjusting them."
      : selectedDayFilter === "all"
      ? "No picks yet - the research hasn't turned up anything real yet. Check back soon."
      : selectedDayFilter === todayStr
      ? "No picks for today yet - check back soon."
      : "No picks for this day yet - check back closer to the date.";
    root.innerHTML = `<p class="empty-state">${msg}</p>`;
    return;
  }

  root.innerHTML = "";

  if (picksSortMode !== "featured") {
    // Closest Upcoming / By Confidence: always a flat list across every
    // visible pick, regardless of day filter - sport-grouping would defeat
    // the point of sorting by time or confidence.
    for (const pick of sortPicksForDisplay(visiblePicks, picksSortMode)) {
      root.appendChild(renderCard(pick));
    }
  } else if (selectedDayFilter === "all") {
    const bySport = {};
    for (const pick of visiblePicks) {
      const sport = pick.sport || "Other";
      if (!bySport[sport]) bySport[sport] = [];
      bySport[sport].push(pick);
    }

    for (const sport of Object.keys(bySport).sort()) {
      const group = document.createElement("div");
      group.className = "sport-group";

      const heading = document.createElement("h2");
      heading.textContent = sport;
      group.appendChild(heading);

      for (const pick of bySport[sport]) {
        group.appendChild(renderCard(pick));
      }

      root.appendChild(group);
    }
  } else {
    // Single-day view: flat list, no sport grouping, so pick types stay
    // interleaved instead of clustering all moneylines first.
    for (const pick of visiblePicks) {
      root.appendChild(renderCard(pick));
    }
  }
}

function renderPrizePicks() {
  const root = document.getElementById("prizepicks-root");
  if (!root) return;

  renderPrizePicksDayFilterBar();

  const platformItems = currentPrizePicks.filter(
    (p) => (p.platform || "PrizePicks") === ppPlatformName
  );
  const items =
    selectedPrizePicksDayFilter === "all"
      ? platformItems
      : platformItems.filter((p) => p.date === selectedPrizePicksDayFilter);

  if (items.length === 0) {
    const todayStr = todayDateStr();
    const label = ppPlatformName === "PrizePicks" ? "picks" : `${ppPlatformName} picks`;
    const msg =
      selectedPrizePicksDayFilter === "all"
        ? `No ${label} yet — waiting on a reliable stats source.`
        : selectedPrizePicksDayFilter === todayStr
        ? `No ${label} for today yet.`
        : `No ${label} for this day yet.`;
    root.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
    return;
  }

  root.innerHTML = "";
  for (const pick of items) {
    root.appendChild(renderCard(pick));
  }
}

// One leg of any pick: a circle showing the market itself (ML, a spread
// number, an Over/Under line + its stat, or a Yes/No + its stat), and to
// the right the name being picked with the opponent as a subtitle
// underneath - replaces the old plain "name pick + name pick" matchup
// string, for every tab, not just PrizePicks.
function legOpponentText(leg) {
  return leg.opponent ? `vs ${leg.opponent}` : "";
}

function renderLegRow(leg) {
  if (leg.type === "moneyline") {
    return `
      <div class="leg-row">
        <div class="leg-circle leg-circle-ml">
          <span class="leg-circle-main">ML</span>
        </div>
        <div class="leg-info">
          <div class="leg-primary">${escapeHtml(leg.team || "")}</div>
          <div class="leg-secondary">${escapeHtml(legOpponentText(leg))}</div>
        </div>
      </div>`;
  }
  if (leg.type === "spread") {
    return `
      <div class="leg-row">
        <div class="leg-circle leg-circle-spread">
          <span class="leg-circle-main">${escapeHtml(leg.spread || "")}</span>
          <span class="leg-circle-sub">SPREAD</span>
        </div>
        <div class="leg-info">
          <div class="leg-primary">${escapeHtml(leg.team || "")}</div>
          <div class="leg-secondary">${escapeHtml(legOpponentText(leg))}</div>
        </div>
      </div>`;
  }
  if (leg.type === "binary") {
    return `
      <div class="leg-row">
        <div class="leg-circle leg-circle-ou">
          <span class="leg-circle-main">${escapeHtml((leg.side || "").toUpperCase())}</span>
          <span class="leg-circle-sub">${escapeHtml(leg.stat || "")}</span>
        </div>
        <div class="leg-info">
          <div class="leg-primary">${escapeHtml(leg.player || "")}</div>
          <div class="leg-secondary">${escapeHtml(legOpponentText(leg))}</div>
        </div>
      </div>`;
  }
  const lineText = `${leg.side === "Under" ? "U" : "O"} ${leg.line}`;
  return `
    <div class="leg-row">
      <div class="leg-circle leg-circle-ou">
        <span class="leg-circle-main">${escapeHtml(lineText)}</span>
        <span class="leg-circle-sub">${escapeHtml(leg.stat || "")}</span>
      </div>
      <div class="leg-info">
        <div class="leg-primary">${escapeHtml(leg.player || "")}</div>
        <div class="leg-secondary">${escapeHtml(legOpponentText(leg))}</div>
      </div>
    </div>`;
}

// Best-effort derivation of one visual leg from an existing pick's own
// fields (sport/matchup/favorite/estimated_probability), following the
// site's own standing schema conventions (sport suffix Totals/Spreads/
// Player Props, "Over X.5"/"Under X.5" or "Team -3.5" keys, "A vs B"
// matchup phrasing) - used for every pick that wasn't hand-authored with
// a structured legs array already (i.e. everything except PrizePicks).
function deriveSingleLeg(sport, matchup, favoriteKey, keys) {
  const s = String(sport || "");
  const m = String(matchup || "");
  const fav = String(favoriteKey || "");

  if (/\bTotals$/i.test(s)) {
    const parts = /^(.*?)\s+—\s+(.*?)\s+O\/U\s+([\d.]+)/i.exec(m);
    const sideMatch = /^(Over|Under)/i.exec(fav);
    const side = sideMatch ? sideMatch[1] : "Over";
    const line = parts ? parts[3] : fav.replace(/[^\d.]/g, "");
    const stat = parts ? parts[2].trim() : "Total";
    const teamsPart = parts ? parts[1] : m;
    const teams = teamsPart.split(/\s+vs\s+/i).map((t) => t.trim());
    return { type: "over_under", player: teams[0] || teamsPart, opponent: teams[1] || "", side, line, stat };
  }

  if (/\bPlayer Props$/i.test(s)) {
    const ouParts = /^(.*?)\s+—\s+(.*?)\s+O\/U\s+([\d.]+)/i.exec(m);
    if (ouParts) {
      const player = ouParts[1].trim();
      const stat = ouParts[2].trim();
      const sideMatch = /^(Over|Under)/i.exec(fav);
      return { type: "over_under", player, opponent: "", side: sideMatch ? sideMatch[1] : "Over", line: ouParts[3], stat };
    }
    const binParts = /^(.*?)\s+—\s+(.*?)$/i.exec(m);
    if (binParts) {
      const player = binParts[1].trim();
      const stat = binParts[2].replace(/\s*\([^)]*\)\s*$/, "").trim();
      return { type: "binary", player, opponent: "", side: fav === "Yes" ? "Yes" : "No", stat };
    }
  }

  if (/\bSpreads$/i.test(s)) {
    const sm = /^(.*?)\s*([+-]\s?[\d.]+)$/.exec(fav);
    const team = sm ? sm[1].trim() : fav;
    const spread = sm ? sm[2].replace(/\s+/g, "") : "";
    const teams = m.split(/\s+vs\s+/i).map((t) => t.trim());
    const opponent = teams.find((t) => t && t !== team) || teams.find((t) => t) || "";
    return { type: "spread", team, opponent, spread };
  }

  // Moneyline / match-winner / tennis-darts-table-tennis set betting default.
  const teams = keys && keys.length === 2 ? keys : m.split(/\s+vs\s+/i).map((t) => t.trim());
  const team = fav || teams[0] || "";
  const opponent = teams.find((t) => t && t !== team) || "";
  return { type: "moneyline", team, opponent };
}

function deriveLegsFromPick(pick) {
  try {
    const probs = pick.estimated_probability || {};
    const keys = Object.keys(probs);
    if (keys.includes("Hits") && keys.includes("Doesn't Hit") && Array.isArray(pick.legs) && pick.legs.length) {
      const legs = pick.legs.map((leg) => deriveSingleLeg(leg.sport, leg.matchup, leg.side, [])).filter(Boolean);
      return legs.length ? legs : null;
    }
    const leg = deriveSingleLeg(pick.sport, pick.matchup, pick.favorite, keys);
    return leg ? [leg] : null;
  } catch (e) {
    return null;
  }
}

function renderCard(pick, options = {}) {
  const card = document.createElement("div");
  card.className = "pick-card";

  const probs = pick.estimated_probability || {};
  const teams = Object.keys(probs);
  const favTeam = pick.favorite || teams.sort((a, b) => probs[b] - probs[a])[0];
  const favPct = probs[favTeam] ?? 50;
  const dogTeam = teams.find((t) => t !== favTeam);
  const dogPct = dogTeam ? probs[dogTeam] : 100 - favPct;

  const confClass = favPct >= 65 ? "high" : favPct >= 58 ? "mid" : "low";
  const confLabel = pick.confidence_label || (favPct >= 65 ? "Lean" : favPct >= 58 ? "Slight lean" : "Coin flip");

  // PrizePicks and Ladder never show a probability/confidence read - PrizePicks
  // goes purely off the real multiplier you supply, and Ladder is deliberately
  // presented as a lock with no percentage attached either.
  const isPP = isPrizePicksPick(pick);
  const hideProbability = options.hideProbability || isPP;

  const probabilityBlock = hideProbability
    ? ""
    : `
    <span class="confidence-tag ${confClass}">${escapeHtml(confLabel)} — favors ${escapeHtml(favTeam || "?")}</span>
    <div class="prob-bar">
      <div class="fav" style="width:${favPct}%"></div>
      <div class="dog" style="width:${dogPct}%"></div>
    </div>
    <div class="prob-labels">
      <span>${escapeHtml(favTeam || "")} ${favPct}%</span>
      <span>${escapeHtml(dogTeam || "")} ${dogPct}%</span>
    </div>`;

  // PrizePicks shows its real multiplier exactly once, as big plain text in
  // a circle sitting beside the leg rows (vertically centered against them)
  // - never as a plain percentage or a second time in the stake row below.
  const multiplierBadgeBlock =
    isPP && typeof pick.actual_multiplier === "number" && pick.actual_multiplier > 0
      ? `<div class="multiplier-badge">${formatMoney(pick.actual_multiplier)}x</div>`
      : "";

  // PrizePicks entries with structured legs (type: "moneyline"/"over_under")
  // render as circle+name+subtitle rows instead of the plain matchup title.
  const structuredLegs =
    Array.isArray(pick.legs) && pick.legs.length > 0 && pick.legs.every((l) => l.type)
      ? pick.legs
      : deriveLegsFromPick(pick);
  const hasStructuredLegs = Array.isArray(structuredLegs) && structuredLegs.length > 0;
  const legRowsBlock = hasStructuredLegs ? `<div class="leg-rows">${structuredLegs.map(renderLegRow).join("")}</div>` : "";
  // The multiplier badge sits beside the leg rows, not stacked below them -
  // wrap both in a row together so the badge centers against their full height.
  const bodyBlock = multiplierBadgeBlock
    ? `<div class="pp-body">${legRowsBlock}${multiplierBadgeBlock}</div>`
    : legRowsBlock;

  const reasoningItems = (pick.reasoning || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const sourceLinks = (pick.sources || [])
    .map((s, i) => `<a href="${escapeAttr(s)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">[${i + 1}]</a>`)
    .join(" ");

  const units = pick.recommended_units;
  const unitValue = getUnitValue();
  let stakeRow = "";
  if (units) {
    let stakeText;
    if (displayMode === "dollars") {
      stakeText = unitValue
        ? `Suggested: $${formatMoney(units * unitValue)}`
        : `Suggested: ${units} unit${units === 1 ? "" : "s"} (add a unit size above to see $)`;
    } else {
      stakeText = `Suggested: ${units} unit${units === 1 ? "" : "s"}`;
    }
    // The multiplier already gets its own dedicated spot (the PrizePicks
    // lock keyhole above) - never repeat it here for those picks.
    const multiplierText =
      !isPP && typeof pick.actual_multiplier === "number" && pick.actual_multiplier > 0
        ? `<span class="multiplier">${formatMoney(pick.actual_multiplier)}x</span>`
        : "";
    stakeRow = `
      <div class="stake-row">
        <span class="units">${stakeText}</span>
        ${multiplierText}
      </div>
    `;
  }

  // Settled picks (only ever reached from the Calendar tab - live/upcoming
  // picks never carry a "winner" field) get a result badge instead of the
  // stake row's live implication, plus - right under that original
  // suggested-stake line - an estimate of the actual $ won/lost, using the
  // same fair-odds/actual_multiplier convention as the Calendar's net units.
  let resultRow = "";
  let resultDollarsRow = "";
  if (pick.winner) {
    const isPush = pick.winner === "push" || pick.winner === "Push";
    const isWin = !isPush && pick.winner === pick.favorite;
    const label = isPush ? "Push" : isWin ? "Won" : "Lost";
    const resultClass = isPush ? "push" : isWin ? "won" : "lost";
    resultRow = `
      <div class="pick-result ${resultClass}">
        ${label}${pick.final_score ? ` — ${escapeHtml(pick.final_score)}` : ""}
      </div>
    `;
    if (units) {
      const netText =
        displayMode === "dollars" && unitValue
          ? formatDollarsSigned(pickNetUnits(pick) * unitValue, pickUnitsAreExact(pick))
          : `${formatUnitsSigned(pickNetUnits(pick), pickUnitsAreExact(pick))}u`;
      resultDollarsRow = `<div class="result-dollars ${resultClass}">${netText}</div>`;
    }
  }

  card.innerHTML = `
    <div class="matchup-row">
      ${hasStructuredLegs ? "" : `<span class="matchup">${escapeHtml(pick.matchup || "")}</span>`}
      <span class="date">${escapeHtml(pick.date || "")}</span>
    </div>
    ${bodyBlock}
    ${probabilityBlock}
    <ul class="reasoning">${reasoningItems}</ul>
    ${sourceLinks ? `<div class="sources">Sources: ${sourceLinks}</div>` : ""}
    ${stakeRow}
    ${resultDollarsRow}
    ${resultRow}
  `;

  return card;
}

// ---------- calendar ----------

const today = new Date();
let calViewYear = today.getFullYear();
let calViewMonth = today.getMonth(); // 0-indexed
let calSelectedDate = null;

function wireCalendar() {
  document.getElementById("cal-prev").addEventListener("click", () => {
    calViewMonth -= 1;
    if (calViewMonth < 0) {
      calViewMonth = 11;
      calViewYear -= 1;
    }
    renderCalendar();
  });

  document.getElementById("cal-next").addEventListener("click", () => {
    calViewMonth += 1;
    if (calViewMonth > 11) {
      calViewMonth = 0;
      calViewYear += 1;
    }
    renderCalendar();
  });
}

// Groups every pick/long shot the site has ever published by the date it
// was for - settled ones (win/loss known) plus any still-live ones for
// today/upcoming days, so a day's cell is complete the moment it's picked,
// not only once it resolves.
// Units result for a single settled pick. A loss is always just the
// stake back, no estimate needed there. For a win, prefer a real
// sportsbook multiplier (pick.actual_multiplier - long shots especially,
// where a real book's combined parlay odds are nothing like a naive
// fair-odds estimate) when one's been recorded; otherwise fall back to
// whatever multiplier would make the estimated probability "fair"
// (100 / probability), e.g. a 50% pick implies 2x, a 25% long shot
// implies 4x - only ever an estimate of what a book would pay, not a
// quoted line. Use pickUnitsAreExact() to know which case applied.
function pickNetUnits(pick) {
  const units = pick.recommended_units || 0;
  if (pick.winner === "push" || pick.winner === "Push") return 0;
  if (pick.winner !== pick.favorite) return -units;
  if (typeof pick.actual_multiplier === "number" && pick.actual_multiplier > 0) {
    return units * (pick.actual_multiplier - 1);
  }
  const favProb = (pick.estimated_probability || {})[pick.favorite];
  if (!favProb) return units;
  const multiplier = 100 / favProb;
  return units * (multiplier - 1);
}

// Whether pickNetUnits() used a real number (loss/push, or a win graded
// against a recorded actual_multiplier) or had to fall back to the
// probability-implied estimate. Callers use this to decide "=" vs "~".
function pickUnitsAreExact(pick) {
  if (pick.winner === "push" || pick.winner === "Push") return true;
  if (pick.winner !== pick.favorite) return true;
  return typeof pick.actual_multiplier === "number" && pick.actual_multiplier > 0;
}

// "~+2.43" when it's a probability-implied estimate (see pickNetUnits),
// "=+2.43" when every contributing pick graded off a real actual_multiplier
// (or was a loss/push, which need no odds at all).
function formatUnitsSigned(n, isExact) {
  return `${isExact ? "=" : "~"}${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

// Same "=+$7.50" / "~+$7.50" convention as formatUnitsSigned, but in
// dollars (net units * unit size) for a settled pick card's result.
function formatDollarsSigned(n, isExact) {
  return `${isExact ? "=" : "~"}${n >= 0 ? "+" : "-"}$${formatMoney(Math.abs(n))}`;
}

// PrizePicks entries live in their own "prizepicks" array while live, and
// carry this flag into "settled" once resolved - not tied to any
// particular sport, since PrizePicks picks can be any sport, not just
// esports.
function isPrizePicksPick(pick) {
  return pick.is_prizepicks === true;
}

// Groups a list of picks (any mix of picks/prizepicks, settled or not)
// into the tab categories plus a per-sport net total, for the
// Calendar's compact "Total winnings" + "see full detailed breakdown"
// bubble. Only settled entries (a winner is known) contribute - unsettled
// ones have no result yet, so they're excluded rather than counted as 0.
// Collapses a specific competition/tour name (e.g. "ATP Hangzhou", "WTA",
// "Soccer - EPL") down to its broad sport ("Tennis", "Soccer") for the
// breakdown modal's "By sport" section - "By competition" below it keeps
// the granular names.
function broadSportGroup(sport) {
  const s = sportGroup(sport || "Other");
  if (/^(ATP|WTA)\b/i.test(s) || /tennis/i.test(s) || /^laver cup$/i.test(s) || /challenger/i.test(s)) {
    return "Tennis";
  }
  if (/^soccer\b/i.test(s)) return "Soccer";
  return s;
}

function computeBreakdown(picksList) {
  const settled = picksList.filter((p) => p.winner);

  const sumBucket = (arr) => ({
    net: arr.reduce((sum, p) => sum + pickNetUnits(p), 0),
    isExact: arr.length ? arr.every(pickUnitsAreExact) : true,
    count: arr.length,
  });

  const picksOnly = [];
  const prizepicks = [];
  for (const p of settled) {
    if (isPrizePicksPick(p)) prizepicks.push(p);
    else picksOnly.push(p);
  }

  const bySport = {};
  const byCompetition = {};
  for (const p of settled) {
    const sport = broadSportGroup(p.sport);
    if (!bySport[sport]) bySport[sport] = [];
    bySport[sport].push(p);

    const competition = p.sport || "Other";
    if (!byCompetition[competition]) byCompetition[competition] = [];
    byCompetition[competition].push(p);
  }
  const sportRows = Object.keys(bySport)
    .map((sport) => ({ sport, ...sumBucket(bySport[sport]) }))
    .sort((a, b) => b.net - a.net);
  const competitionRows = Object.keys(byCompetition)
    .map((competition) => ({ sport: competition, ...sumBucket(byCompetition[competition]) }))
    .sort((a, b) => b.net - a.net);

  return {
    total: sumBucket(settled),
    picks: sumBucket(picksOnly),
    prizepicks: sumBucket(prizepicks),
    bySport: sportRows,
    byCompetition: competitionRows,
    hasAny: settled.length > 0,
  };
}

function formatBreakdownAmount(bucket, unitValue, showDollars) {
  if (bucket.count === 0) return showDollars ? "$0" : "0 units";
  return showDollars
    ? formatDollarsSigned(bucket.net * unitValue, bucket.isExact)
    : `${formatUnitsSigned(bucket.net, bucket.isExact)}u`;
}

function wireBreakdownModal() {
  document.getElementById("breakdown-modal-close").addEventListener("click", closeBreakdownModal);
  document.getElementById("breakdown-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "breakdown-modal-backdrop") closeBreakdownModal();
  });
}

function closeBreakdownModal() {
  document.getElementById("breakdown-modal-backdrop").hidden = true;
}

function openBreakdownModal(title, breakdown) {
  const backdrop = document.getElementById("breakdown-modal-backdrop");
  const titleEl = document.getElementById("breakdown-modal-title");
  const contentEl = document.getElementById("breakdown-modal-content");
  titleEl.textContent = title;

  if (!breakdown.hasAny) {
    contentEl.innerHTML = `<p class="empty-state">Nothing settled yet in this window.</p>`;
    backdrop.hidden = false;
    return;
  }

  const unitValue = getUnitValue();
  const showDollars = displayMode === "dollars" && unitValue;
  const amtClass = (net) => (net > 0 ? "won-amt" : net < 0 ? "lost-amt" : "neutral-amt");

  const byTypeRows = [
    ["Picks", breakdown.picks],
    [ppPlatformName, breakdown.prizepicks],
  ]
    .filter(([, b]) => b.count > 0)
    .map(
      ([label, b]) => `
        <div class="breakdown-row">
          <span>${label} (${b.count})</span>
          <span class="amount ${amtClass(b.net)}">${formatBreakdownAmount(b, unitValue, showDollars)}</span>
        </div>`
    )
    .join("");

  const sportRows = breakdown.bySport
    .map(
      (row) => `
        <div class="breakdown-row">
          <span>${escapeHtml(row.sport)} (${row.count})</span>
          <span class="amount ${amtClass(row.net)}">${formatBreakdownAmount(row, unitValue, showDollars)}</span>
        </div>`
    )
    .join("");

  const competitionRows = breakdown.byCompetition
    .map(
      (row) => `
        <div class="breakdown-row">
          <span>${escapeHtml(row.sport)} (${row.count})</span>
          <span class="amount ${amtClass(row.net)}">${formatBreakdownAmount(row, unitValue, showDollars)}</span>
        </div>`
    )
    .join("");

  contentEl.innerHTML = `
    <div class="breakdown-section">
      <h4>By type</h4>
      ${byTypeRows}
    </div>
    <div class="breakdown-section">
      <h4>By sport (highest first)</h4>
      ${sportRows}
    </div>
    <div class="breakdown-section">
      <h4>By competition (highest first)</h4>
      ${competitionRows}
    </div>
  `;

  backdrop.hidden = false;
}

function picksByDate() {
  const map = {};
  const add = (p) => {
    if (!p.date) return;
    if (!map[p.date]) map[p.date] = [];
    map[p.date].push(p);
  };
  currentSettled.forEach(add);
  currentPicks.forEach(add);
  currentPrizePicks.forEach(add);
  return map;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function renderCalendar() {
  const grid = document.getElementById("calendar-grid");
  const label = document.getElementById("cal-month-label");
  if (!grid || !label) return;

  label.textContent = `${MONTH_NAMES[calViewMonth]} ${calViewYear}`;

  const byDate = picksByDate();
  const unitValue = getUnitValue();
  const showDollars = displayMode === "dollars" && unitValue;

  const monthPrefix = `${calViewYear}-${pad2(calViewMonth + 1)}-`;
  const monthPicks = [...currentSettled, ...currentPicks, ...currentPrizePicks].filter((p) =>
    (p.date || "").startsWith(monthPrefix)
  );
  const monthBreakdown = computeBreakdown(monthPicks);
  const summaryEl = document.getElementById("cal-month-summary");
  if (summaryEl) {
    if (monthBreakdown.hasAny) {
      summaryEl.innerHTML = `
        <span class="summary-total">Total winnings this month: ${formatBreakdownAmount(monthBreakdown.total, unitValue, showDollars)}</span>
        <button class="breakdown-btn" type="button">See full detailed breakdown</button>
      `;
      summaryEl.querySelector(".breakdown-btn").addEventListener("click", () => {
        openBreakdownModal(`Breakdown for ${MONTH_NAMES[calViewMonth]} ${calViewYear}`, monthBreakdown);
      });
    } else {
      summaryEl.innerHTML = "";
    }
  }

  const firstWeekday = new Date(calViewYear, calViewMonth, 1).getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

  grid.innerHTML = "";

  WEEKDAY_LABELS.forEach((w) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = w;
    grid.appendChild(el);
  });

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement("div");
    blank.className = "calendar-day blank";
    grid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${calViewYear}-${pad2(calViewMonth + 1)}-${pad2(day)}`;
    const dayPicks = byDate[dateStr] || [];
    const dayBreakdown = computeBreakdown(dayPicks);
    const settledCount = dayBreakdown.picks.count + dayBreakdown.prizepicks.count;
    const wins = dayPicks.filter((p) => p.winner && p.winner === p.favorite).length;
    const losses = dayPicks.filter((p) => p.winner && p.winner !== p.favorite && p.winner !== "push").length;

    const cell = document.createElement("div");
    cell.className =
      "calendar-day " + (dayBreakdown.total.net > 0 ? "win" : dayBreakdown.total.net < 0 ? "loss" : "neutral");
    if (dateStr === calSelectedDate) cell.classList.add("selected");

    const summary = settledCount
      ? `${wins}-${losses}`
      : dayPicks.length
        ? `${dayPicks.length} pick${dayPicks.length === 1 ? "" : "s"}`
        : "";
    const unitsText = settledCount ? formatBreakdownAmount(dayBreakdown.total, unitValue, showDollars) : "";

    cell.innerHTML = `
      <span>${day}</span>
      ${unitsText ? `<span class="day-units">${unitsText}</span>` : ""}
      ${summary ? `<span class="day-net">${summary}</span>` : ""}
    `;

    cell.addEventListener("click", () => {
      calSelectedDate = dateStr === calSelectedDate ? null : dateStr;
      renderCalendar();
      renderDayDetail();
    });

    grid.appendChild(cell);
  }

  renderDayDetail();
}

function renderDayDetail() {
  const root = document.getElementById("day-detail");
  if (!calSelectedDate) {
    root.innerHTML = "";
    return;
  }

  const dayPicks = picksByDate()[calSelectedDate] || [];
  const breakdown = computeBreakdown(dayPicks);
  const unitValue = getUnitValue();
  const showDollars = displayMode === "dollars" && unitValue;

  const heading = document.createElement("h3");
  heading.textContent = `Picks for ${calSelectedDate}`;
  root.innerHTML = "";
  root.appendChild(heading);

  if (breakdown.hasAny) {
    const summaryBar = document.createElement("div");
    summaryBar.className = "summary-bar";
    summaryBar.innerHTML = `
      <span class="summary-total">Total winnings: ${formatBreakdownAmount(breakdown.total, unitValue, showDollars)}</span>
      <button class="breakdown-btn" type="button">See full detailed breakdown</button>
    `;
    summaryBar.querySelector(".breakdown-btn").addEventListener("click", () => {
      openBreakdownModal(`Breakdown for ${calSelectedDate}`, breakdown);
    });
    root.appendChild(summaryBar);
  }

  if (dayPicks.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No picks entered on this day.";
    root.appendChild(p);
    return;
  }

  for (const pick of dayPicks) {
    root.appendChild(renderCard(pick));
  }
}

// ---------- ladder ----------

// A single day-at-a-time view (not a month grid): one moneyline "lock" per
// day, compounding forward from 1 unit. A win rolls the payout (via that
// entry's own actual_multiplier - a real sportsbook price, never an
// estimate) into the next day's stake; a loss resets the climb back to 1
// unit. Days with no entry just carry the running stake forward unchanged.

let ladderViewDate = null;

function wireLadderNav() {
  document.getElementById("ladder-prev").addEventListener("click", () => shiftLadderView(-1));
  document.getElementById("ladder-next").addEventListener("click", () => shiftLadderView(1));
}

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function shiftLadderView(days) {
  const bounds = ladderBounds();
  const next = addDaysToDateStr(ladderViewDate || bounds.defaultDate, days);
  if (next < bounds.earliest || next > bounds.latest) return;
  ladderViewDate = next;
  renderLadder();
}

function ladderBounds() {
  const today = todayDateStr();
  const dates = currentLadder.map((e) => e.date).filter(Boolean);
  const earliest = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : today;
  const latestEntry = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : today;
  // defaultDate is what the view should open on - today, or a future-dated
  // entry already on the board if that's later than today. latest is how far
  // Next may go - a couple of days past defaultDate, so the visitor can still
  // page forward into an empty upcoming day rather than getting stuck once
  // the newest entry (or today) is reached.
  const defaultDate = latestEntry > today ? latestEntry : today;
  const latest = addDaysToDateStr(defaultDate, 2);
  return { earliest, defaultDate, latest };
}

// Walks every ladder entry in date order, compounding the stake: a win
// multiplies the running stake by that entry's real actual_multiplier and
// carries it into the next entry; a loss resets the next entry back to 1
// unit; a push carries the same stake forward unchanged. Returns entries
// augmented with stakeIn/stakeOut/busted.
function ladderProgression() {
  const sorted = [...currentLadder].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = 1;
  const out = [];
  for (const entry of sorted) {
    const stakeIn = running;
    let stakeOut = null;
    let busted = false;
    if (entry.winner) {
      const isPush = entry.winner === "push" || entry.winner === "Push";
      const isWin = !isPush && entry.winner === entry.favorite;
      if (isWin) {
        stakeOut = stakeIn * (entry.actual_multiplier || 1);
        running = stakeOut;
      } else if (isPush) {
        stakeOut = stakeIn;
      } else {
        stakeOut = 0;
        busted = true;
        running = 1;
      }
    }
    out.push({ entry, stakeIn, stakeOut, busted });
  }
  return out;
}

function renderLadder() {
  const label = document.getElementById("ladder-date-label");
  const root = document.getElementById("ladder-root");
  const prevBtn = document.getElementById("ladder-prev");
  const nextBtn = document.getElementById("ladder-next");
  if (!label || !root) return;

  const bounds = ladderBounds();
  if (!ladderViewDate) ladderViewDate = bounds.defaultDate;
  if (ladderViewDate < bounds.earliest) ladderViewDate = bounds.earliest;
  if (ladderViewDate > bounds.latest) ladderViewDate = bounds.latest;

  const [y, m, d] = ladderViewDate.split("-").map(Number);
  label.textContent = `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
  prevBtn.disabled = ladderViewDate <= bounds.earliest;
  nextBtn.disabled = ladderViewDate >= bounds.latest;

  const progression = ladderProgression();
  const row = progression.find((r) => r.entry.date === ladderViewDate);

  root.innerHTML = "";

  if (!row) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No ladder pick this day.";
    root.appendChild(p);
    return;
  }

  // No unit amounts on the card itself - the bio explains the 1-unit-start,
  // compounding mechanic once; individual days just show the pick and,
  // once settled, whether it won (renderCard's own result badge).
  const card = renderCard(row.entry, { hideProbability: true });

  root.appendChild(card);
}

// ---------- utils ----------

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

main();
