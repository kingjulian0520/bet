import * as Auth from "./auth.js";

const UNIT_VALUE_KEY = "closeCallsUnitValue";
const BETS_KEY = "closeCallsBets";
const TIMEZONE_KEY = "closeCallsTimeZone";

// Fill in a real contact address to turn on "Report an Issue" in the
// account menu - left as a placeholder so nobody's personal email ends up
// hardcoded into public page source without them choosing that.
const SUPPORT_EMAIL = "REPLACE_WITH_YOUR_EMAIL";

const COMMON_TIME_ZONES = [
  { value: "auto", label: "Match my device" },
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "UTC", label: "UTC" },
];

let rawPicks = [];
let rawLongShots = [];
let currentPicks = [];
let currentLongShots = [];
let currentSettled = [];
let myBets = [];
let activeModalPick = null;
let activeModalSide = null;
let openBetMenuId = null;

// currentUser/profileCache are set once Supabase resolves the login state.
// Until then (and always, if accounts aren't configured or the visitor
// isn't signed in) everything reads/writes localStorage - "guest mode",
// which is exactly how the site behaved before accounts existed.
let currentUser = null;
let profileCache = null;
let generatedAt = null;

// ---------- storage ----------

// The $ value locked in when a bet was placed. Falls back to the current
// global unit size for bets placed before this field existed, so old bets
// keep behaving exactly as they did before.
function betUnitValue(bet) {
  return bet.unitValue || getUnitValue();
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

function loadLocalBets() {
  try {
    const raw = localStorage.getItem(BETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveLocalBets() {
  try {
    localStorage.setItem(BETS_KEY, JSON.stringify(myBets));
  } catch (err) {
    // ignore
  }
}

// Boots from local/guest data - applyAuthState() swaps in cloud data once
// (and if) the sign-in state resolves.
function loadBets() {
  return loadLocalBets();
}

function saveBets() {
  if (currentUser) {
    if (profileCache) profileCache.bets = myBets;
    Auth.saveMyProfile(currentUser.id, { bets: myBets }).catch((err) => {
      console.warn("Couldn't sync bets to your account, saved locally only.", err);
    });
    return;
  }
  saveLocalBets();
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
    myBets = loadLocalBets();
    renderAccountBar();
    renderAll();
    return;
  }

  try {
    let profile = await Auth.getMyProfile(user.id);
    if (!profile) profile = { username: user.email, isPublic: false, unitValue: null, bets: [] };

    // First login on this browser with existing guest data already here
    // and nothing in the cloud yet - bring it along instead of silently
    // losing it.
    const localBets = loadLocalBets();
    const localUnitValue = parseFloat(localStorage.getItem(UNIT_VALUE_KEY));
    const migrated = {};
    if ((!profile.bets || profile.bets.length === 0) && localBets.length > 0) {
      profile.bets = localBets;
      migrated.bets = localBets;
    }
    if (!profile.unitValue && !isNaN(localUnitValue) && localUnitValue > 0) {
      profile.unitValue = localUnitValue;
      migrated.unitValue = localUnitValue;
    }
    if (Object.keys(migrated).length > 0) {
      await Auth.saveMyProfile(user.id, migrated);
    }

    profileCache = profile;
    myBets = Array.isArray(profile.bets) ? profile.bets : [];
  } catch (err) {
    console.warn("Couldn't load your account data, falling back to this browser's local bets.", err);
    profileCache = { username: user.email, isPublic: false, unitValue: null, bets: [] };
    myBets = loadLocalBets();
  }

  renderAccountBar();
  renderAll();
}

function wireAuthUI() {
  const backdrop = document.getElementById("auth-modal-backdrop");
  const openBtn = document.getElementById("open-auth-btn");

  const tabs = document.querySelectorAll(".auth-tab-btn");
  const panels = {
    signin: document.getElementById("auth-signin-panel"),
    signup: document.getElementById("auth-signup-panel"),
  };

  const titleEl = document.getElementById("auth-modal-title");
  const subtitleEl = document.getElementById("auth-modal-subtitle");
  const copy = {
    signin: ["Welcome back", "Sign in to sync your bets across devices."],
    signup: ["Create your account", "Track your bets and pick history anywhere you sign in."],
  };

  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.authtab === name));
    panels.signin.hidden = name !== "signin";
    panels.signup.hidden = name !== "signup";
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

  Auth.onAuthChange(applyAuthState);
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

function myBetStats() {
  const settled = myBets.filter((b) => b.status !== "pending");
  const wins = settled.filter((b) => b.status === "won").length;
  const losses = settled.filter((b) => b.status === "lost").length;
  const netUnits = settled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);
  return { wins, losses, netUnits, settledCount: settled.length };
}

function openAccountPanel(type) {
  const backdrop = document.getElementById("account-panel-backdrop");
  const titleEl = document.getElementById("account-panel-title");
  const contentEl = document.getElementById("account-panel-content");

  const renderers = {
    profile: renderProfilePanel,
    leaderboard: renderLeaderboardPanel,
    report: renderReportPanel,
    timezone: renderTimezonePanel,
  };
  const titles = {
    profile: "Your profile",
    leaderboard: "Leaderboard",
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
  const stats = myBetStats();
  root.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat">
        <div class="profile-stat-value">${stats.wins}-${stats.losses}</div>
        <div class="profile-stat-label">Record</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-value ${stats.netUnits >= 0 ? "positive" : "negative"}">${stats.netUnits >= 0 ? "+" : ""}${stats.netUnits.toFixed(2)}</div>
        <div class="profile-stat-label">Net units</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-value">${stats.settledCount}</div>
        <div class="profile-stat-label">Settled</div>
      </div>
    </div>
    <div class="profile-public-row">
      <label>
        <input type="checkbox" id="profile-public-checkbox" ${profileCache.isPublic ? "checked" : ""}>
        Make my bets public
      </label>
    </div>
    <p class="account-panel-note">Public shows your username, record, and net units on the leaderboard. Your email is never shown.</p>
  `;

  document.getElementById("profile-public-checkbox").addEventListener("change", (e) => {
    const isPublic = e.target.checked;
    if (profileCache) profileCache.isPublic = isPublic;
    Auth.saveMyProfile(currentUser.id, { isPublic }).catch((err) => {
      console.warn("Couldn't update public/private setting.", err);
    });
  });
}

async function renderLeaderboardPanel(root) {
  root.innerHTML = `<p class="account-panel-note">Loading…</p>`;
  try {
    const rows = await Auth.getPublicLeaderboard();
    if (!rows.length) {
      root.innerHTML = `<p class="account-panel-note">Nobody's made their bets public yet.</p>`;
      return;
    }
    root.innerHTML = rows
      .map(
        (r, i) => `
        <div class="leaderboard-row">
          <span class="leaderboard-rank">${i + 1}.</span>
          <span class="leaderboard-name">@${escapeHtml(r.username)}</span>
          <span class="leaderboard-units ${r.netUnits >= 0 ? "positive" : "negative"}">${r.netUnits >= 0 ? "+" : ""}${r.netUnits.toFixed(2)}u</span>
        </div>
      `
      )
      .join("");
  } catch (err) {
    root.innerHTML = `<p class="account-panel-note">Couldn't load the leaderboard right now.</p>`;
  }
}

function renderReportPanel(root) {
  if (SUPPORT_EMAIL.startsWith("REPLACE_")) {
    root.innerHTML = `<p class="account-panel-note">Reporting isn't set up yet — add a contact email (SUPPORT_EMAIL) in script.js to turn this on.</p>`;
    return;
  }
  root.innerHTML = `
    <p class="account-panel-note">Found a bug or a bad pick? Let us know what happened.</p>
    <a class="primary-btn account-panel-cta"
       href="mailto:${escapeAttr(SUPPORT_EMAIL)}?subject=${encodeURIComponent("Close Calls issue report")}">
      Email us
    </a>
  `;
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
  wireModal();
  wireCalendar();
  wireAuthUI();
  wireAccountMenu();

  document.addEventListener("click", (e) => {
    if (openBetMenuId && !e.target.closest(".bet-menu-wrap") && !e.target.closest(".bet-adjust-form")) {
      closeBetMenu();
    }
    const accountDropdown = document.getElementById("account-menu-dropdown");
    if (accountDropdown && !accountDropdown.hidden && !e.target.closest(".account-menu-wrap")) {
      accountDropdown.hidden = true;
      document.getElementById("account-menu-btn").setAttribute("aria-expanded", "false");
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

  myBets = loadBets();

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
  rawLongShots = data.long_shots || [];
  currentSettled = data.settled || [];
  prunePicks();

  const todayStr = todayDateStr();
  if (currentPicks.some((p) => p.date === todayStr)) {
    selectedDayFilter = todayStr;
  }

  settlePendingBets();
  renderAll();

  setInterval(() => {
    const hadPicks = currentPicks.length;
    const hadLongShots = currentLongShots.length;
    prunePicks();
    if (currentPicks.length !== hadPicks || currentLongShots.length !== hadLongShots) {
      renderAll();
    }
  }, 60000);
}

// A pick/long shot with a known start_time disappears from the browsable
// list once that time passes - you can't place a fresh bet on something
// already underway. Settlement (once the result is known) is separate and
// still handled via the "settled" array regardless of this filter.
function hasStarted(pick) {
  return !!pick.start_time && new Date(pick.start_time).getTime() <= Date.now();
}

// Once you've already placed a bet on a pick, it disappears from the
// browsable Picks/Long Shots list - seeing the same matchup there again
// after you've already acted on it is just confusing. Removing the bet
// (via the 3-dot menu) brings the pick back into view automatically,
// since this is re-evaluated against myBets on every render.
function hasBet(pick) {
  const key = pickKey(pick);
  return myBets.some((b) => b.key === key);
}

function prunePicks() {
  currentPicks = rawPicks.filter((p) => !hasStarted(p) && !hasBet(p));
  currentLongShots = rawLongShots.filter((p) => !hasStarted(p) && !hasBet(p));
}

function renderAll() {
  prunePicks();
  renderDayFilterBar();
  renderPicks();
  renderLongShots();
  renderExposureSummary();
  renderMyBets();
  renderNetCounter();
  renderCalendar();
}

// ---------- tabs ----------

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
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

function renderPicks() {
  const root = document.getElementById("picks-root");

  const visiblePicks =
    selectedDayFilter === "all" ? currentPicks : currentPicks.filter((p) => p.date === selectedDayFilter);

  if (visiblePicks.length === 0) {
    const todayStr = todayDateStr();
    const msg =
      selectedDayFilter === "all"
        ? "No picks yet - the research hasn't turned up anything real yet. Check back soon."
        : selectedDayFilter === todayStr
        ? "No picks for today yet - check back soon."
        : "No picks for this day yet - check back closer to the date.";
    root.innerHTML = `<p class="empty-state">${msg}</p>`;
    return;
  }

  root.innerHTML = "";

  if (selectedDayFilter === "all") {
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

function renderLongShots() {
  const root = document.getElementById("longshots-root");
  if (!root) return;

  if (currentLongShots.length === 0) {
    root.innerHTML = '<p class="empty-state">No long shots yet.</p>';
    return;
  }

  root.innerHTML = "";
  for (const pick of currentLongShots) {
    root.appendChild(renderCard(pick));
  }
}

function renderExposureSummary() {
  const el = document.getElementById("exposure-summary");
  const unitValue = getUnitValue();

  const visiblePicks =
    selectedDayFilter === "all" ? currentPicks : currentPicks.filter((p) => p.date === selectedDayFilter);
  const totalUnits = visiblePicks.reduce((sum, p) => sum + (p.recommended_units || 0), 0);
  if (totalUnits === 0) {
    el.hidden = true;
    return;
  }

  const scope = selectedDayFilter === "all" ? "Current picks" : "This day's picks";
  let text = `${scope} add up to ${totalUnits.toFixed(2)} units if you took every one`;
  if (unitValue) {
    text += ` — about $${(totalUnits * unitValue).toFixed(0)}`;
  }
  el.textContent = text + ".";
  el.hidden = false;
  el.classList.toggle("hot", totalUnits >= 8);
}

function pickKey(pick) {
  return `${pick.sport}__${pick.matchup}__${pick.date}`;
}

function extractLineFromSide(sideStr) {
  const match = String(sideStr || "").match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function rebuildSideWithLine(sideStr, newLine) {
  const match = String(sideStr || "").match(/([+-]?)(\d+(?:\.\d+)?)/);
  if (!match) return sideStr;
  const sign = match[1] === "-" ? "-" : match[1] === "+" ? "+" : "";
  return sideStr.replace(match[0], `${sign}${newLine}`);
}

function renderCard(pick) {
  const card = document.createElement("div");
  card.className = "pick-card";
  card.addEventListener("click", () => openBetModal(pick));

  const probs = pick.estimated_probability || {};
  const teams = Object.keys(probs);
  const favTeam = pick.favorite || teams.sort((a, b) => probs[b] - probs[a])[0];
  const favPct = probs[favTeam] ?? 50;
  const dogTeam = teams.find((t) => t !== favTeam);
  const dogPct = dogTeam ? probs[dogTeam] : 100 - favPct;

  const confClass = favPct >= 65 ? "high" : favPct >= 58 ? "mid" : "low";
  const confLabel = pick.confidence_label || (favPct >= 65 ? "Lean" : favPct >= 58 ? "Slight lean" : "Coin flip");

  const reasoningItems = (pick.reasoning || []).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  const sourceLinks = (pick.sources || [])
    .map((s, i) => `<a href="${escapeAttr(s)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">[${i + 1}]</a>`)
    .join(" ");

  const units = pick.recommended_units;
  const unitValue = getUnitValue();
  let stakeRow = "";
  if (units) {
    const dollarsText = unitValue
      ? `<span class="dollars">≈ $${(units * unitValue).toFixed(0)}</span>`
      : `<span class="dollars">add a unit size above to see $</span>`;
    stakeRow = `
      <div class="stake-row">
        <span class="units">Suggested: ${units} unit${units === 1 ? "" : "s"}</span>
        ${dollarsText}
      </div>
    `;
  }

  card.innerHTML = `
    <div class="matchup-row">
      <span class="matchup">${escapeHtml(pick.matchup || "")}</span>
      <span class="date">${escapeHtml(pick.date || "")}</span>
    </div>
    <span class="confidence-tag ${confClass}">${escapeHtml(confLabel)} — favors ${escapeHtml(favTeam || "?")}</span>
    <div class="prob-bar">
      <div class="fav" style="width:${favPct}%"></div>
      <div class="dog" style="width:${dogPct}%"></div>
    </div>
    <div class="prob-labels">
      <span>${escapeHtml(favTeam || "")} ${favPct}%</span>
      <span>${escapeHtml(dogTeam || "")} ${dogPct}%</span>
    </div>
    <ul class="reasoning">${reasoningItems}</ul>
    ${sourceLinks ? `<div class="sources">Sources: ${sourceLinks}</div>` : ""}
    ${stakeRow}
    <div class="pick-cta">Log this bet →</div>
  `;

  return card;
}

// ---------- bet modal ----------

function wireModal() {
  document.getElementById("modal-cancel").addEventListener("click", closeBetModal);
  document.getElementById("bet-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "bet-modal-backdrop") closeBetModal();
  });
  document.getElementById("modal-stake").addEventListener("input", updateModalEv);
  document.getElementById("modal-multiplier").addEventListener("input", updateModalEv);
  document.getElementById("modal-line").addEventListener("input", updateModalEv);
  document.getElementById("modal-override").addEventListener("change", updateModalEv);
  document.getElementById("modal-place").addEventListener("click", placeBet);
}

function openBetModal(pick) {
  activeModalPick = pick;
  const probs = pick.estimated_probability || {};
  const teams = Object.keys(probs);
  const favTeam = pick.favorite || teams.sort((a, b) => probs[b] - probs[a])[0];
  const dogTeam = teams.find((t) => t !== favTeam);
  activeModalSide = favTeam;

  document.getElementById("modal-matchup").textContent = pick.matchup || "";
  document.getElementById("modal-date").textContent = `${pick.sport || ""} · ${pick.date || ""}`;
  document.getElementById("modal-stake").value = pick.recommended_units || "";
  document.getElementById("modal-unit-value").value = getUnitValue() || "";
  document.getElementById("modal-multiplier").value = "";
  document.getElementById("modal-override").checked = false;
  document.getElementById("modal-override-wrap").hidden = true;

  const toggle = document.getElementById("side-toggle");
  toggle.innerHTML = "";
  [favTeam, dogTeam].filter(Boolean).forEach((team) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "side-btn" + (team === activeModalSide ? " selected" : "");
    btn.textContent = `${team} (${probs[team]}%)`;
    btn.addEventListener("click", () => {
      activeModalSide = team;
      toggle.querySelectorAll(".side-btn").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      syncLineInputToSide();
      updateModalEv();
    });
    toggle.appendChild(btn);
  });

  syncLineInputToSide();
  document.getElementById("bet-modal-backdrop").hidden = false;
  updateModalEv();
}

function syncLineInputToSide() {
  const wrap = document.getElementById("modal-line-wrap");
  const input = document.getElementById("modal-line");
  const note = document.getElementById("modal-line-note");
  const line = extractLineFromSide(activeModalSide);

  if (line === null) {
    wrap.hidden = true;
    return;
  }

  wrap.hidden = false;
  input.value = line;
  input.dataset.originalLine = line;
  note.textContent = `Our line: ${line}`;
}

function closeBetModal() {
  document.getElementById("bet-modal-backdrop").hidden = true;
  activeModalPick = null;
  activeModalSide = null;
}

function updateModalEv() {
  const evBox = document.getElementById("modal-ev");
  const placeBtn = document.getElementById("modal-place");
  const overrideWrap = document.getElementById("modal-override-wrap");
  const override = document.getElementById("modal-override").checked;

  const stake = parseFloat(document.getElementById("modal-stake").value);
  const multiplier = parseFloat(document.getElementById("modal-multiplier").value);

  if (!activeModalPick || !activeModalSide || isNaN(multiplier) || multiplier <= 1) {
    evBox.textContent = "Enter the multiplier you're being offered to see expected value.";
    evBox.className = "modal-ev";
    placeBtn.disabled = true;
    overrideWrap.hidden = true;
    return;
  }

  const probs = activeModalPick.estimated_probability || {};
  const p = (probs[activeModalSide] ?? 50) / 100;
  const impliedProb = (1 / multiplier) * 100;
  const evPercent = (p * multiplier - 1) * 100;

  const lineInput = document.getElementById("modal-line");
  const lineWrap = document.getElementById("modal-line-wrap");
  let lineCaveat = "";
  if (!lineWrap.hidden) {
    const currentLine = parseFloat(lineInput.value);
    const originalLine = parseFloat(lineInput.dataset.originalLine);
    if (!isNaN(currentLine) && !isNaN(originalLine) && currentLine !== originalLine) {
      lineCaveat = ` <br><span class="modal-ev-caveat">Adjusted to ${currentLine} (from ${originalLine}) — the probability above is still our estimate for ${originalLine}, not recalculated for your number.</span>`;
    }
  }

  evBox.innerHTML =
    `Our estimate: <strong>${(p * 100).toFixed(0)}%</strong> · ` +
    `Market implies: <strong>${impliedProb.toFixed(0)}%</strong> · ` +
    `EV: <strong>${evPercent >= 0 ? "+" : ""}${evPercent.toFixed(1)}%</strong>` +
    lineCaveat;
  evBox.className = "modal-ev " + (evPercent >= 0 ? "positive" : "negative");

  const validStake = !isNaN(stake) && stake > 0;

  if (evPercent < 0) {
    overrideWrap.hidden = false;
    placeBtn.disabled = !(validStake && override);
  } else {
    overrideWrap.hidden = true;
    placeBtn.disabled = !validStake;
  }
}

function placeBet() {
  const stake = parseFloat(document.getElementById("modal-stake").value);
  const multiplier = parseFloat(document.getElementById("modal-multiplier").value);
  const enteredUnitValue = parseFloat(document.getElementById("modal-unit-value").value);
  const betUnitValueAtPlacement = !isNaN(enteredUnitValue) && enteredUnitValue > 0 ? enteredUnitValue : null;
  const probs = activeModalPick.estimated_probability || {};
  const p = probs[activeModalSide] ?? 50;
  const evPercent = ((p / 100) * multiplier - 1) * 100;

  const lineWrap = document.getElementById("modal-line-wrap");
  const originalLine = extractLineFromSide(activeModalSide);
  let finalSide = activeModalSide;
  let line = null;

  if (!lineWrap.hidden) {
    const enteredLine = parseFloat(document.getElementById("modal-line").value);
    line = !isNaN(enteredLine) ? enteredLine : originalLine;
    finalSide = rebuildSideWithLine(activeModalSide, line);
  }

  myBets.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sport: activeModalPick.sport,
    matchup: activeModalPick.matchup,
    date: activeModalPick.date,
    key: pickKey(activeModalPick),
    side: finalSide,
    line,
    originalLine,
    stakeUnits: stake,
    unitValue: betUnitValueAtPlacement,
    multiplier,
    modelProbability: p,
    evPercent,
    legs: Array.isArray(activeModalPick.legs) ? activeModalPick.legs : null,
    placedAt: new Date().toISOString(),
    status: "pending",
    profitUnits: null,
  });

  saveBets();
  closeBetModal();
  renderAll();
}

// ---------- settlement ----------

function extractNumberFromText(text) {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

function favoriteTeamName(favoriteStr) {
  return String(favoriteStr || "").replace(/\s[-+]\d+(?:\.\d+)?$/, "").trim();
}

function gradeOverUnder(bet, actual) {
  if (actual === bet.line) return { status: "push", profitUnits: 0 };
  const isOver = /^over/i.test(bet.side);
  const won = isOver ? actual > bet.line : actual < bet.line;
  return {
    status: won ? "won" : "lost",
    profitUnits: won ? bet.stakeUnits * (bet.multiplier - 1) : -bet.stakeUnits,
  };
}

// Settlement from the automated routine's (or manually-verified) "settled"
// data. This is the authoritative grading path — it uses structured numeric
// fields (actual_value / actual_total / actual_margin) the research process
// records alongside each result, not freeform text parsing, so it correctly
// handles a line the user adjusted in the bet modal and isn't thrown off by
// which number happens to appear first in a prose recap. Client-side live
// self-settlement (pollLiveDisplay/determineOutcome) can also grade a bet
// sooner, straight from live ESPN data, but this is the fallback that always
// works once a result is recorded here — it doesn't depend on the ESPN proxy
// or the tab having been open when the game ended.
function settlePendingBets() {
  const settledByKey = {};
  for (const s of currentSettled) {
    settledByKey[pickKey(s)] = s;
  }

  let changed = false;
  for (const bet of myBets) {
    if (bet.status !== "pending") continue;
    const result = settledByKey[bet.key];
    if (!result || !result.winner) continue;

    const isOverUnder = /^(over|under)/i.test(bet.side);

    if (isOverUnder && bet.line != null && typeof result.actual_value === "number") {
      const graded = gradeOverUnder(bet, result.actual_value);
      Object.assign(bet, graded);
      bet.finalScore = result.final_score || null;
      changed = true;
      continue;
    }

    if (isOverUnder && bet.line != null && typeof result.actual_total === "number") {
      const graded = gradeOverUnder(bet, result.actual_total);
      Object.assign(bet, graded);
      bet.finalScore = result.final_score || null;
      changed = true;
      continue;
    }

    if (bet.line != null && typeof result.actual_margin === "number" && result.favorite) {
      const favTeam = favoriteTeamName(result.favorite);
      const betTeam = favoriteTeamName(bet.side);
      const signedMargin = betTeam === favTeam ? result.actual_margin : -result.actual_margin;
      const covers = signedMargin + bet.line;
      const status = covers > 0 ? "won" : covers < 0 ? "lost" : "push";
      bet.status = status;
      bet.profitUnits =
        status === "won" ? bet.stakeUnits * (bet.multiplier - 1) : status === "push" ? 0 : -bet.stakeUnits;
      bet.finalScore = result.final_score || null;
      changed = true;
      continue;
    }

    if (bet.line != null) {
      // No structured numeric field recorded for this result (older data,
      // or the routine couldn't confirm exact numbers) — freeform text is
      // too unreliable to grade an adjusted-line bet safely. Client-side
      // self-settlement can still catch this from live data; otherwise it
      // stays pending rather than risk a wrong grade.
      continue;
    }

    if (result.winner === "push") {
      // Draw No Bet (or any other voided moneyline) — stake returned
      // regardless of which side was picked.
      bet.status = "push";
      bet.profitUnits = 0;
      bet.finalScore = result.final_score || null;
      changed = true;
      continue;
    }

    const won = result.winner === bet.side;
    bet.status = won ? "won" : "lost";
    bet.profitUnits = won ? bet.stakeUnits * (bet.multiplier - 1) : -bet.stakeUnits;
    bet.finalScore = result.final_score || null;
    changed = true;
  }

  if (changed) saveBets();
}

// ---------- my bets ----------

function buildBetCard(bet) {
  const card = document.createElement("div");
  card.className = "bet-card";

  const isSettled = bet.status !== "pending";
  const unitValue = betUnitValue(bet);
  const stakeDollars = unitValue ? bet.stakeUnits * unitValue : null;
  const potentialProfitDollars = unitValue ? stakeDollars * (bet.multiplier - 1) : null;

  const statusBadge = isSettled ? `<span class="bet-status ${bet.status}">${bet.status}</span>` : "";

  const profitText = isSettled
    ? bet.status === "push"
      ? `<div class="bet-profit">Push — stake returned, no gain or loss.</div>`
      : `<div class="bet-profit ${bet.profitUnits >= 0 ? "positive" : "negative"}">${bet.profitUnits >= 0 ? "+" : ""}${bet.profitUnits.toFixed(2)} units${unitValue ? ` (${bet.profitUnits >= 0 ? "+" : ""}$${(bet.profitUnits * unitValue).toFixed(0)})` : ""}</div>`
    : "";

  const moneyLine = !isSettled
    ? `<div class="bet-money">
        <span>In: ${bet.stakeUnits} units${stakeDollars !== null ? ` (~$${stakeDollars.toFixed(0)})` : ""}</span>
        <span>Potential: +${(bet.stakeUnits * (bet.multiplier - 1)).toFixed(2)} units${potentialProfitDollars !== null ? ` (~$${potentialProfitDollars.toFixed(0)})` : ""}</span>
      </div>`
    : "";

  const liveBlockId = `live-${bet.id}`;

  const liveBlock = !isSettled
    ? `<div class="live-block">
        <div class="live-status" id="${liveBlockId}-status"></div>
        <div class="live-prob-line" id="${liveBlockId}-prob">${formatBaselineProb(bet)}</div>
      </div>`
    : "";

  const isMenuOpen = openBetMenuId === bet.id;
  const menuHtml = `
    <div class="bet-menu-wrap">
      <button class="bet-menu-btn" data-id="${bet.id}" aria-label="Bet options" aria-expanded="${isMenuOpen}">&#8942;</button>
      <div class="bet-menu-dropdown" ${isMenuOpen ? "" : "hidden"}>
        <button class="bet-menu-item" data-action="adjust" data-id="${bet.id}">Adjust odds / unit size</button>
        <button class="bet-menu-item danger" data-action="remove" data-id="${bet.id}">Remove</button>
      </div>
    </div>
  `;

  const adjustFormHtml =
    isMenuOpen && bet.__adjusting
      ? `<div class="bet-adjust-form">
          <label>New multiplier / decimal odds</label>
          <input type="number" min="1" step="0.01" class="bet-adjust-input" value="${bet.multiplier}">
          <label>Unit size for this bet ($)</label>
          <input type="number" min="0" step="1" class="bet-adjust-unitvalue" value="${bet.unitValue || ""}" placeholder="e.g. 30">
          <div class="bet-adjust-actions">
            <button class="secondary-btn bet-adjust-cancel">Cancel</button>
            <button class="primary-btn bet-adjust-save">Save</button>
          </div>
        </div>`
      : "";

  card.innerHTML = `
    <div class="bet-top">
      <span class="bet-call">${escapeHtml(String(bet.side || "").toUpperCase())}</span>
      ${statusBadge}
      ${menuHtml}
    </div>
    <div class="bet-matchup-sub">${escapeHtml(bet.matchup)}</div>
    <div class="bet-detail">${escapeHtml(bet.sport)} · ${escapeHtml(bet.date)} · ${bet.stakeUnits} units @ ${bet.multiplier}x · EV was ${bet.evPercent >= 0 ? "+" : ""}${bet.evPercent.toFixed(1)}%</div>
    ${bet.finalScore ? `<div class="bet-detail">Final: ${escapeHtml(bet.finalScore)}</div>` : ""}
    ${moneyLine}
    ${profitText}
    ${liveBlock}
    ${adjustFormHtml}
  `;

  const menuBtn = card.querySelector(".bet-menu-btn");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openBetMenuId === bet.id) {
      closeBetMenu();
    } else {
      openBetMenuId = bet.id;
      bet.__adjusting = false;
      renderMyBets();
    }
  });

  const removeItem = card.querySelector('[data-action="remove"]');
  if (removeItem) {
    removeItem.addEventListener("click", () => {
      if (!confirm(`Remove this bet (${bet.matchup} — ${bet.side})? This can't be undone.`)) return;
      stopLiveTracking(bet.id);
      myBets = myBets.filter((b) => b.id !== bet.id);
      saveBets();
      openBetMenuId = null;
      renderAll();
    });
  }

  const adjustItem = card.querySelector('[data-action="adjust"]');
  if (adjustItem) {
    adjustItem.addEventListener("click", () => {
      bet.__adjusting = true;
      renderMyBets();
    });
  }

  const adjustCancel = card.querySelector(".bet-adjust-cancel");
  if (adjustCancel) {
    adjustCancel.addEventListener("click", () => {
      bet.__adjusting = false;
      renderMyBets();
    });
  }

  const adjustSave = card.querySelector(".bet-adjust-save");
  if (adjustSave) {
    adjustSave.addEventListener("click", () => {
      const input = card.querySelector(".bet-adjust-input");
      const newMultiplier = parseFloat(input.value);
      if (isNaN(newMultiplier) || newMultiplier < 1) {
        alert("Enter a valid multiplier (1 or higher).");
        return;
      }
      const unitValueInput = card.querySelector(".bet-adjust-unitvalue");
      const newUnitValue = parseFloat(unitValueInput.value);
      bet.unitValue = !isNaN(newUnitValue) && newUnitValue > 0 ? newUnitValue : null;

      bet.multiplier = newMultiplier;
      bet.evPercent = ((bet.modelProbability / 100) * newMultiplier - 1) * 100;
      if (bet.status === "won") {
        bet.profitUnits = bet.stakeUnits * (newMultiplier - 1);
      }
      delete bet.__adjusting;
      saveBets();
      openBetMenuId = null;
      renderAll();
    });
  }

  if (!isSettled) {
    startLiveTracking(bet, liveBlockId);
  }

  return card;
}

function closeBetMenu() {
  if (openBetMenuId) {
    const bet = myBets.find((b) => b.id === openBetMenuId);
    if (bet) delete bet.__adjusting;
  }
  openBetMenuId = null;
  renderMyBets();
}

function renderMyBets() {
  const root = document.getElementById("mybets-root");
  clearAllLiveTracking();

  if (myBets.length === 0) {
    root.innerHTML = '<p class="empty-state">No bets placed yet. Click a pick on the Picks tab to log one.</p>';
    return;
  }

  const pending = myBets.filter((b) => b.status === "pending");
  root.innerHTML = "";

  if (pending.length > 0) {
    const totalStakeUnits = pending.reduce((sum, b) => sum + b.stakeUnits, 0);
    const totalPotentialUnits = pending.reduce((sum, b) => sum + b.stakeUnits * (b.multiplier - 1), 0);
    // Dollar totals sum each bet's own locked-in unit size, not the current
    // global one, so a mid-stream unit size change doesn't inflate/deflate
    // bets placed at a different size.
    const totalStakeDollars = pending.reduce((sum, b) => sum + b.stakeUnits * betUnitValue(b), 0);
    const totalPotentialDollars = pending.reduce((sum, b) => sum + b.stakeUnits * (b.multiplier - 1) * betUnitValue(b), 0);
    const hasAnyUnitValue = pending.some((b) => betUnitValue(b));
    const summary = document.createElement("div");
    summary.className = "bets-summary";
    summary.innerHTML = `
      <div><span class="summary-label">In play</span> ${totalStakeUnits.toFixed(2)} units${hasAnyUnitValue ? ` (~$${totalStakeDollars.toFixed(0)})` : ""} across ${pending.length} bet${pending.length === 1 ? "" : "s"}</div>
      <div><span class="summary-label">Potential earnings</span> +${totalPotentialUnits.toFixed(2)} units${hasAnyUnitValue ? ` (~$${totalPotentialDollars.toFixed(0)})` : ""} if everything hits</div>
    `;
    root.appendChild(summary);
  }

  const sorted = [...myBets].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  for (const bet of sorted) {
    root.appendChild(buildBetCard(bet));
  }
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function renderNetCounter() {
  const todayEl = document.getElementById("net-today");
  const allTimeEl = document.getElementById("net-alltime");
  const settled = myBets.filter((b) => b.status !== "pending");
  const todayStr = todayDateStr();

  const todaySettled = settled.filter((b) => b.date === todayStr);
  const todayUnits = todaySettled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);
  const allTimeUnits = settled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);

  // Each bet's dollar contribution uses the unit size locked in when it was
  // placed, not today's global unit size — changing your unit size shouldn't
  // rewrite the dollar value of bets made at a different size.
  const dollarSum = (bets) => bets.reduce((sum, b) => sum + (b.profitUnits || 0) * betUnitValue(b), 0);
  const todayDollars = dollarSum(todaySettled);
  const allTimeDollars = dollarSum(settled);
  const hasAnyUnitValue = settled.some((b) => betUnitValue(b));

  const formatLine = (label, units, dollars, count) => {
    let text = `${label}: ${units >= 0 ? "+" : ""}${units.toFixed(2)} units`;
    if (hasAnyUnitValue) text += ` (${dollars >= 0 ? "+" : ""}$${dollars.toFixed(0)})`;
    if (count === 0) text = `${label}: no settled bets`;
    return text;
  };

  todayEl.textContent = formatLine("Today", todayUnits, todayDollars, todaySettled.length);
  todayEl.className = "net-today " + (todaySettled.length === 0 ? "zero" : todayUnits > 0 ? "positive" : todayUnits < 0 ? "negative" : "zero");

  allTimeEl.textContent = formatLine("All time", allTimeUnits, allTimeDollars, settled.length);
  allTimeEl.className = "net-alltime " + (settled.length === 0 ? "" : allTimeUnits > 0 ? "positive" : allTimeUnits < 0 ? "negative" : "");
}

// ---------- live tracking ----------
// Best-effort, unofficial: uses ESPN's public (undocumented) scoreboard/summary
// endpoints. No API key, no guarantees — fails quietly to "unavailable" if
// anything doesn't match or the endpoint changes shape.

const LIVE_SCORE_INTERVAL_MS = 15000;
const LIVE_PROB_INTERVAL_MS = 30000;
const liveTimers = {};

const ESPN_LEAGUE_PATHS = {
  NFL: "football/nfl",
  "College Football": "football/college-football",
  MLB: "baseball/mlb",
  NBA: "basketball/nba",
  WNBA: "basketball/wnba",
  NHL: "hockey/nhl",
};

function leagueEspnPath(sport) {
  for (const key of Object.keys(ESPN_LEAGUE_PATHS)) {
    if (sport.startsWith(key)) return ESPN_LEAGUE_PATHS[key];
  }
  return null;
}

function espnDateParam(dateStr) {
  return dateStr.replace(/-/g, "");
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

// ESPN's undocumented API doesn't send Access-Control-Allow-Origin for
// arbitrary sites, so direct browser fetches get blocked by CORS. Route
// through a public CORS-relay proxy that fetches server-side and re-adds
// permissive headers. This is a best-effort workaround, not guaranteed —
// if the proxy itself is ever down or rate-limited, live tracking will
// just show "unavailable" rather than break anything else on the page.
const CORS_PROXY = "https://api.allorigins.win/raw?url=";

async function espnFetch(url) {
  return fetchJsonSafe(CORS_PROXY + encodeURIComponent(url));
}

function normalizeTeamKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z]/g, "");
}

function teamsMatch(nameA, nameB) {
  const a = normalizeTeamKey(nameA);
  const b = normalizeTeamKey(nameB);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function parseTeamsFromBet(bet) {
  const parenMatch = bet.matchup.match(/\(([^)]+)\)\s*$/);
  const teamsPart = parenMatch ? parenMatch[1] : bet.matchup;
  const parts = teamsPart.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  return [parts[0].trim(), parts[1].trim()];
}

function parsePropInfo(bet) {
  const dashMatch = bet.matchup.match(/^(.+?)\s+—\s+(.+?)\s+O\/U\s+(-?\d+(?:\.\d+)?)/);
  if (!dashMatch) return null;
  return {
    player: dashMatch[1].trim(),
    statLabel: dashMatch[2].trim().toLowerCase(),
    line: parseFloat(dashMatch[3]),
    isOver: /^over/i.test(bet.side),
  };
}

async function findEspnEvent(espnPath, dateStr, teamA, teamB) {
  for (const candidateDate of [dateStr, shiftDate(dateStr, 1), shiftDate(dateStr, -1)]) {
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard?dates=${espnDateParam(candidateDate)}`
    );
    if (!data || !Array.isArray(data.events)) continue;

    for (const event of data.events) {
      const competitors = event.competitions?.[0]?.competitors || [];
      if (competitors.length !== 2) continue;
      const names = competitors.map((c) => c.team?.displayName || c.team?.name || "");
      if (names.some((n) => teamsMatch(n, teamA)) && names.some((n) => teamsMatch(n, teamB))) {
        return event;
      }
    }
  }
  return null;
}

function espnEventScoreText(event) {
  const competitors = event.competitions?.[0]?.competitors || [];
  if (competitors.length !== 2) return null;
  const parts = competitors.map(
    (c) => `${c.team?.shortDisplayName || c.team?.abbreviation || c.team?.displayName}: ${c.score ?? "-"}`
  );
  const status = event.status?.type?.shortDetail || event.status?.type?.description || "";
  return { text: parts.join("   ·   "), status };
}

function estimateGameProgress(event, sport) {
  const status = event.status;
  if (!status) return 0.5;
  if (status.type?.state === "post") return 1;
  if (status.type?.state === "pre") return 0;

  const period = status.period || 1;
  const clock = status.displayClock || "0:00";
  const clockParts = clock.split(":").map(Number);
  const secsLeftInPeriod = (clockParts[0] || 0) * 60 + (clockParts[1] || 0);

  if (sport.startsWith("NFL") || sport.startsWith("College Football")) {
    const periodLen = 15 * 60;
    const elapsedInPeriod = periodLen - secsLeftInPeriod;
    return Math.min(1, Math.max(0, ((period - 1) * periodLen + elapsedInPeriod) / (4 * periodLen)));
  }
  if (sport.startsWith("MLB")) {
    const half = (status.type?.detail || "").toLowerCase().includes("bot") ? 0.5 : 0;
    return Math.min(1, Math.max(0, (period - 1 + half) / 9));
  }
  if (sport.startsWith("NBA") || sport.startsWith("WNBA")) {
    const periodLen = 12 * 60;
    const elapsedInPeriod = periodLen - secsLeftInPeriod;
    return Math.min(1, Math.max(0, ((period - 1) * periodLen + elapsedInPeriod) / (4 * periodLen)));
  }
  return 0.5;
}

function scoreDiffForBetSide(event, bet, teamA, teamB) {
  const competitors = event.competitions?.[0]?.competitors || [];
  if (competitors.length !== 2) return null;

  const sideTeamGuess = bet.side.replace(/[-+]\d+(\.\d+)?$/, "").trim();
  const backedTeamName = teamsMatch(sideTeamGuess, teamA) ? teamA : teamsMatch(sideTeamGuess, teamB) ? teamB : null;
  if (!backedTeamName) return null;

  const backedComp = competitors.find((c) => teamsMatch(c.team?.displayName || "", backedTeamName));
  const otherComp = competitors.find((c) => c !== backedComp);
  if (!backedComp || !otherComp) return null;
  return (parseFloat(backedComp.score) || 0) - (parseFloat(otherComp.score) || 0);
}

const STAT_LABEL_MAP = {
  "passing yards": { categories: ["passing"], labels: ["YDS"] },
  "rushing yards": { categories: ["rushing"], labels: ["YDS"] },
  "receiving yards": { categories: ["receiving"], labels: ["YDS"] },
  receptions: { categories: ["receiving"], labels: ["REC"] },
  "earned runs allowed": { categories: ["pitching"], labels: ["ER"] },
  hits: { categories: ["batting"], labels: ["H"] },
  runs: { categories: ["batting"], labels: ["R"] },
  "rbi's": { categories: ["batting"], labels: ["RBI"] },
  rbis: { categories: ["batting"], labels: ["RBI"] },
  "home runs": { categories: ["batting"], labels: ["HR"] },
  strikeouts: { categories: ["pitching", "batting"], labels: ["SO", "K"] },
  goals: { categories: ["skaters"], labels: ["G"] },
  assists: { categories: ["skaters"], labels: ["A"] },
  "shots on goal": { categories: ["skaters"], labels: ["SOG", "S"] },
  saves: { categories: ["goalies"], labels: ["SV"] },
  "passing tds": { categories: ["passing"], labels: ["TD"] },
};

async function fetchPlayerStatValue(espnPath, eventId, playerName, statLabel) {
  const spec = STAT_LABEL_MAP[statLabel];
  if (!spec) return null;

  const data = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/summary?event=${eventId}`);
  if (!data || !data.boxscore || !Array.isArray(data.boxscore.players)) return null;

  for (const teamBlock of data.boxscore.players) {
    for (const statCat of teamBlock.statistics || []) {
      if (!spec.categories.includes(statCat.name)) continue;
      const labelIdx = (statCat.labels || []).findIndex((l) => spec.labels.includes(String(l).toUpperCase()));
      if (labelIdx < 0) continue;
      const athleteRow = (statCat.athletes || []).find(
        (a) => normalizeTeamKey(a.athlete?.displayName) === normalizeTeamKey(playerName)
      );
      if (athleteRow?.stats?.[labelIdx] !== undefined) {
        const val = parseFloat(athleteRow.stats[labelIdx]);
        if (!isNaN(val)) return val;
      }
    }
  }
  return null;
}

function formatBaselineProb(bet) {
  const pct = Math.round(bet.modelProbability);
  return `Estimate: ${pct}% chance (pre-game research estimate)`;
}

function renderLiveUnavailable(statusEl) {
  statusEl.innerHTML = `<div class="live-note">No live score/stat feed found for this bet yet.</div>`;
}

function renderLiveScore(statusEl, scoreInfo) {
  statusEl.innerHTML = `
    <div class="live-score-line">
      <span class="live-dot"></span>
      <span>${escapeHtml(scoreInfo.text)}</span>
      <span class="live-status">${escapeHtml(scoreInfo.status)}</span>
    </div>
  `;
}

function renderLiveProp(statusEl, currentValue, line) {
  const pct = Math.min(100, Math.max(0, Math.round((currentValue / line) * 100)));
  statusEl.innerHTML = `
    <div class="live-progress-wrap">
      <div class="live-progress-track">
        <div class="live-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="live-progress-labels">
        <span>${currentValue} so far</span>
        <span>${pct}% of ${line}</span>
      </div>
    </div>
  `;
}

function resolveLegState(leg) {
  const settledByKey = {};
  for (const s of currentSettled) settledByKey[pickKey(s)] = s;
  const result = settledByKey[pickKey(leg)];
  if (!result) return { state: "pending", detail: "" };
  const won = result.winner === leg.side;
  return { state: won ? "won" : "lost", detail: result.final_score || "" };
}

function computeParlayLiveProb(bet) {
  if (!Array.isArray(bet.legs) || bet.legs.length === 0) return null;
  let product = 1;
  for (const leg of bet.legs) {
    const { state } = resolveLegState(leg);
    if (state === "lost") return 0;
    if (state === "pending") product *= (leg.probability ?? 50) / 100;
  }
  return product * 100;
}

function renderParlayStatus(statusEl, bet) {
  if (!Array.isArray(bet.legs) || bet.legs.length === 0) {
    statusEl.innerHTML = `<div class="live-note">No leg-by-leg data saved for this parlay (it was placed before this feature existed) — it'll still settle normally.</div>`;
    return;
  }

  const rows = bet.legs.map((leg) => ({ leg, ...resolveLegState(leg) }));
  const wonCount = rows.filter((r) => r.state === "won").length;
  const lostCount = rows.filter((r) => r.state === "lost").length;
  const pendingCount = rows.filter((r) => r.state === "pending").length;

  const summaryLine =
    lostCount > 0
      ? `Already missed — ${lostCount} leg${lostCount === 1 ? "" : "s"} lost.`
      : `${wonCount}/${rows.length} legs hit so far, ${pendingCount} still pending.`;

  statusEl.innerHTML = `
    <div class="parlay-summary ${lostCount > 0 ? "dead" : ""}">${escapeHtml(summaryLine)}</div>
    <ul class="parlay-legs">
      ${rows
        .map(
          (r, i) => `
        <li class="parlay-leg ${r.state}" data-leg-index="${i}">
          <span class="parlay-leg-name">${escapeHtml(r.leg.matchup)} — ${escapeHtml(r.leg.side)}</span>
          <span class="parlay-leg-state">${escapeHtml(r.state)}${r.detail ? ` (${escapeHtml(r.detail)})` : ""}</span>
        </li>`
        )
        .join("")}
    </ul>
  `;

  // Only fetch/show a live score for legs whose game is actually in progress right now.
  rows.forEach((r, i) => {
    if (r.state !== "pending") return;
    const espnPath = leagueEspnPath(r.leg.sport);
    const teams = parseTeamsFromBet({ matchup: r.leg.matchup });
    if (!espnPath || !teams) return;
    findEspnEvent(espnPath, r.leg.date, teams[0], teams[1]).then((event) => {
      if (!event || event.status?.type?.state !== "in") return;
      const scoreInfo = espnEventScoreText(event);
      if (!scoreInfo) return;
      const stateEl = statusEl.querySelector(`li[data-leg-index="${i}"] .parlay-leg-state`);
      if (stateEl) stateEl.textContent = `live — ${scoreInfo.text} (${scoreInfo.status})`;
    });
  });
}

// Determines win/lost/push for a single-event bet directly from live ESPN
// data once the event is final — this is what lets settlement happen within
// ~15s of the game ending instead of waiting for the hourly research
// routine. Uses bet.line (which reflects any adjustment the user made at
// placement) rather than the pick's original line, so an adjusted line still
// grades correctly. Returns null if it can't confidently determine anything
// (unsupported bet shape, stat not found, etc.) — the bet is left pending
// for the routine's own settlement pass to catch instead.
async function determineOutcome(event, bet, espnPath, teams) {
  const prop = parsePropInfo(bet);

  if (prop) {
    const value = await fetchPlayerStatValue(espnPath, event.id, prop.player, prop.statLabel);
    if (value === null) return null;
    const finalText = `${prop.player}: ${value} (line ${prop.line})`;
    if (value === prop.line) return { result: "push", finalText };
    const won = prop.isOver ? value > prop.line : value < prop.line;
    return { result: won ? "won" : "lost", finalText };
  }

  const scoreInfo = espnEventScoreText(event);
  const finalText = scoreInfo?.text || "";

  if (bet.sport.includes("Spreads")) {
    if (bet.line == null) return null;
    const margin = scoreDiffForBetSide(event, bet, teams[0], teams[1]);
    if (margin === null) return null;
    const covers = margin + bet.line;
    return { result: covers > 0 ? "won" : covers < 0 ? "lost" : "push", finalText };
  }

  if (bet.sport.includes("Totals")) {
    if (bet.line == null) return null;
    const competitors = event.competitions?.[0]?.competitors || [];
    if (competitors.length !== 2) return null;
    const total = (parseFloat(competitors[0].score) || 0) + (parseFloat(competitors[1].score) || 0);
    const isOver = /^over/i.test(bet.side);
    if (total === bet.line) return { result: "push", finalText };
    const won = isOver ? total > bet.line : total < bet.line;
    return { result: won ? "won" : "lost", finalText };
  }

  // Moneyline / match winner: bet.side should be one of the two team names.
  const diff = scoreDiffForBetSide(event, bet, teams[0], teams[1]);
  if (diff === null) return null;
  return { result: diff > 0 ? "won" : diff < 0 ? "lost" : "push", finalText };
}

function applySelfSettlement(bet, outcome) {
  bet.status = outcome.result;
  bet.profitUnits = outcome.result === "won" ? bet.stakeUnits * (bet.multiplier - 1) : outcome.result === "push" ? 0 : -bet.stakeUnits;
  bet.finalScore = outcome.finalText;
  saveBets();
  renderAll();
}

async function pollLiveDisplay(bet, containerId) {
  const statusEl = document.getElementById(`${containerId}-status`);
  if (!statusEl) return;

  if (bet.sport === "Parlays") {
    renderParlayStatus(statusEl, bet);
    return;
  }

  const espnPath = leagueEspnPath(bet.sport);
  const teams = parseTeamsFromBet(bet);
  if (!espnPath || !teams) {
    renderLiveUnavailable(statusEl);
    return;
  }

  const event = await findEspnEvent(espnPath, bet.date, teams[0], teams[1]);
  if (!document.getElementById(`${containerId}-status`)) return;
  if (!event) {
    renderLiveUnavailable(statusEl);
    return;
  }

  if (event.status?.type?.state === "post") {
    const outcome = await determineOutcome(event, bet, espnPath, teams);
    if (bet.status === "pending" && outcome) {
      applySelfSettlement(bet, outcome);
      return; // card re-renders as settled; nothing left to display here
    }
    if (bet.status !== "pending") return; // got settled by another concurrent poll
    // Couldn't confidently grade it yet (e.g. final box score not posted) — show final score, keep as pending.
    const scoreInfo = espnEventScoreText(event);
    if (scoreInfo) renderLiveScore(statusEl, scoreInfo);
    return;
  }

  const prop = parsePropInfo(bet);
  if (prop) {
    const value = await fetchPlayerStatValue(espnPath, event.id, prop.player, prop.statLabel);
    if (!document.getElementById(`${containerId}-status`)) return;
    if (value === null) {
      renderLiveUnavailable(statusEl);
      return;
    }
    renderLiveProp(statusEl, value, prop.line);
  } else {
    const scoreInfo = espnEventScoreText(event);
    if (!scoreInfo) {
      renderLiveUnavailable(statusEl);
      return;
    }
    renderLiveScore(statusEl, scoreInfo);
  }
}

async function pollLiveProbability(bet, containerId) {
  const probEl = document.getElementById(`${containerId}-prob`);
  if (!probEl) return;

  if (bet.sport === "Parlays") {
    const liveProb = computeParlayLiveProb(bet);
    if (liveProb !== null) {
      probEl.textContent = `Current chance: ~${liveProb.toFixed(0)}% (updates as legs settle; still a rough estimate for pending legs)`;
    }
    return;
  }

  const espnPath = leagueEspnPath(bet.sport);
  const teams = parseTeamsFromBet(bet);
  if (!espnPath || !teams) return;

  const event = await findEspnEvent(espnPath, bet.date, teams[0], teams[1]);
  if (!document.getElementById(`${containerId}-prob`)) return;
  if (!event || event.status?.type?.state === "pre") return; // baseline estimate already shown, leave it as-is

  const progress = estimateGameProgress(event, bet.sport);
  const prop = parsePropInfo(bet);
  let liveProb;

  if (prop) {
    const value = await fetchPlayerStatValue(espnPath, event.id, prop.player, prop.statLabel);
    if (!document.getElementById(`${containerId}-prob`)) return;
    if (value === null) return;
    const remaining = Math.max(0, 1 - progress);
    const pace = progress > 0.05 ? value / progress : value;
    const paceMargin = (pace - prop.line) / Math.max(prop.line, 1);
    let signal = 0.5 + paceMargin * 0.6;
    if (!prop.isOver) signal = 1 - signal;
    signal = Math.min(0.97, Math.max(0.03, signal));
    liveProb = (bet.modelProbability / 100) * remaining + signal * (1 - remaining);
  } else {
    const diff = scoreDiffForBetSide(event, bet, teams[0], teams[1]);
    if (diff === null) return;
    const remaining = Math.max(0, 1 - progress);
    const swingPoints = bet.sport.startsWith("MLB")
      ? 4
      : bet.sport.startsWith("NFL") || bet.sport.startsWith("College Football")
        ? 14
        : 10;
    let signal = 0.5 + (diff / swingPoints) * 0.5;
    signal = Math.min(0.97, Math.max(0.03, signal));
    liveProb = (bet.modelProbability / 100) * remaining + signal * (1 - remaining);
  }

  liveProb = Math.min(97, Math.max(3, liveProb * 100));
  if (document.getElementById(`${containerId}-prob`)) {
    probEl.textContent = `Live estimate: ~${liveProb.toFixed(0)}% (rough model based on pace/score + time left — not a guarantee)`;
  }
}

function startLiveTracking(bet, containerId) {
  // Deferred, not called directly: this runs before the card has been
  // appended to the document (buildBetCard calls this before returning
  // the element to renderMyBets, which appends it), so an immediate
  // document.getElementById lookup here would always fail.
  setTimeout(() => pollLiveDisplay(bet, containerId), 50);
  setTimeout(() => pollLiveProbability(bet, containerId), 2500);
  const scoreTimer = setInterval(() => pollLiveDisplay(bet, containerId), LIVE_SCORE_INTERVAL_MS);
  const probTimer = setInterval(() => pollLiveProbability(bet, containerId), LIVE_PROB_INTERVAL_MS);
  liveTimers[bet.id] = { scoreTimer, probTimer };
}

function stopLiveTracking(betId) {
  const timers = liveTimers[betId];
  if (timers) {
    clearInterval(timers.scoreTimer);
    clearInterval(timers.probTimer);
    delete liveTimers[betId];
  }
}

function clearAllLiveTracking() {
  for (const id of Object.keys(liveTimers)) {
    stopLiveTracking(id);
  }
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

function betsByDate() {
  const map = {};
  for (const bet of myBets) {
    if (bet.status === "pending" || !bet.date) continue;
    if (!map[bet.date]) map[bet.date] = [];
    map[bet.date].push(bet);
  }
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

  const byDate = betsByDate();
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
    const dayBets = byDate[dateStr] || [];
    const netUnits = dayBets.reduce((sum, b) => sum + (b.profitUnits || 0), 0);

    const cell = document.createElement("div");
    cell.className = "calendar-day " + (netUnits > 0 ? "win" : netUnits < 0 ? "loss" : "neutral");
    if (dateStr === calSelectedDate) cell.classList.add("selected");

    cell.innerHTML = `
      <span>${day}</span>
      ${dayBets.length ? `<span class="day-net">${netUnits >= 0 ? "+" : ""}${netUnits.toFixed(2)}</span>` : ""}
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

  const dayBets = betsByDate()[calSelectedDate] || [];
  const heading = document.createElement("h3");
  heading.textContent = `Bets for ${calSelectedDate}`;
  root.innerHTML = "";
  root.appendChild(heading);

  if (dayBets.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No settled bets on this day.";
    root.appendChild(p);
    return;
  }

  for (const bet of dayBets) {
    root.appendChild(buildBetCard(bet));
  }
}

// ---------- utils ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

main();
