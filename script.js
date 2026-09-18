const UNIT_VALUE_KEY = "closeCallsUnitValue";
const BETS_KEY = "closeCallsBets";

let currentPicks = [];
let currentLongShots = [];
let currentSettled = [];
let myBets = [];
let activeModalPick = null;
let activeModalSide = null;

// ---------- storage ----------

function getUnitValue() {
  const stored = localStorage.getItem(UNIT_VALUE_KEY);
  return stored ? parseFloat(stored) : null;
}

function setUnitValue(value) {
  try {
    localStorage.setItem(UNIT_VALUE_KEY, String(value));
  } catch (err) {
    // ignore — localStorage may be unavailable (private browsing etc.)
  }
}

function loadBets() {
  try {
    const raw = localStorage.getItem(BETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveBets() {
  try {
    localStorage.setItem(BETS_KEY, JSON.stringify(myBets));
  } catch (err) {
    // ignore
  }
}

// ---------- boot ----------

async function main() {
  wireTabs();
  wireModal();
  wireCalendar();

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
  const lastUpdatedEl = document.getElementById("last-updated");

  let data;
  try {
    const res = await fetch("data/picks.json", { cache: "no-store" });
    data = await res.json();
  } catch (err) {
    root.innerHTML = '<p class="empty-state">Could not load picks data.</p>';
    return;
  }

  if (data.generated_at) {
    lastUpdatedEl.textContent = "Last updated " + new Date(data.generated_at).toLocaleString();
  }

  currentPicks = data.picks || [];
  currentLongShots = data.long_shots || [];
  currentSettled = data.settled || [];

  const todayStr = todayDateStr();
  if (currentPicks.some((p) => p.date === todayStr)) {
    selectedDayFilter = todayStr;
  }

  settlePendingBets();
  renderAll();
}

function renderAll() {
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

function renderDayFilterBar() {
  const bar = document.getElementById("day-filter-bar");
  if (!bar) return;

  const dates = [...new Set(currentPicks.map((p) => p.date).filter(Boolean))].sort();
  if (dates.length === 0) {
    bar.innerHTML = "";
    return;
  }

  const todayStr = todayDateStr();
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

  if (currentPicks.length === 0) {
    root.innerHTML = '<p class="empty-state">No picks yet — the first automated research run hasn\'t happened.</p>';
    return;
  }

  const visiblePicks =
    selectedDayFilter === "all" ? currentPicks : currentPicks.filter((p) => p.date === selectedDayFilter);

  if (visiblePicks.length === 0) {
    root.innerHTML = '<p class="empty-state">No picks for this day.</p>';
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
      : `<span class="dollars">set unit size above for $ amount</span>`;
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
    <div class="bet-detail">Click to log a bet on this matchup →</div>
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
      updateModalEv();
    });
    toggle.appendChild(btn);
  });

  document.getElementById("bet-modal-backdrop").hidden = false;
  updateModalEv();
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

  evBox.innerHTML =
    `Our estimate: <strong>${(p * 100).toFixed(0)}%</strong> · ` +
    `Market implies: <strong>${impliedProb.toFixed(0)}%</strong> · ` +
    `EV: <strong>${evPercent >= 0 ? "+" : ""}${evPercent.toFixed(1)}%</strong>`;
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
  const probs = activeModalPick.estimated_probability || {};
  const p = probs[activeModalSide] ?? 50;
  const evPercent = ((p / 100) * multiplier - 1) * 100;

  myBets.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sport: activeModalPick.sport,
    matchup: activeModalPick.matchup,
    date: activeModalPick.date,
    key: pickKey(activeModalPick),
    side: activeModalSide,
    stakeUnits: stake,
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
  const unitValue = getUnitValue();
  const stakeDollars = unitValue ? bet.stakeUnits * unitValue : null;
  const potentialProfitDollars = unitValue ? stakeDollars * (bet.multiplier - 1) : null;

  const statusBadge = isSettled ? `<span class="bet-status ${bet.status}">${bet.status}</span>` : "";

  const profitText = isSettled
    ? `<div class="bet-profit ${bet.profitUnits >= 0 ? "positive" : "negative"}">${bet.profitUnits >= 0 ? "+" : ""}${bet.profitUnits.toFixed(2)} units${unitValue ? ` (${bet.profitUnits >= 0 ? "+" : ""}$${(bet.profitUnits * unitValue).toFixed(0)})` : ""}</div>`
    : "";

  const moneyLine = !isSettled
    ? `<div class="bet-money">
        <span>In: ${bet.stakeUnits} units${stakeDollars !== null ? ` (~$${stakeDollars.toFixed(0)})` : ""}</span>
        <span>Potential: +${(bet.stakeUnits * (bet.multiplier - 1)).toFixed(2)} units${potentialProfitDollars !== null ? ` (~$${potentialProfitDollars.toFixed(0)})` : ""}</span>
      </div>`
    : "";

  const removeBtn = !isSettled ? `<button class="bet-remove" data-id="${bet.id}">Remove</button>` : "";
  const liveBlockId = `live-${bet.id}`;

  const liveBlock = !isSettled
    ? `<div class="live-block">
        <div class="live-status" id="${liveBlockId}-status"></div>
        <div class="live-prob-line" id="${liveBlockId}-prob">${formatBaselineProb(bet)}</div>
      </div>`
    : "";

  card.innerHTML = `
    <div class="bet-top">
      <span class="bet-matchup">${escapeHtml(bet.matchup)} — backing ${escapeHtml(bet.side)}</span>
      ${statusBadge}
    </div>
    <div class="bet-detail">${escapeHtml(bet.sport)} · ${escapeHtml(bet.date)} · ${bet.stakeUnits} units @ ${bet.multiplier}x · EV was ${bet.evPercent >= 0 ? "+" : ""}${bet.evPercent.toFixed(1)}%</div>
    ${bet.finalScore ? `<div class="bet-detail">Final: ${escapeHtml(bet.finalScore)}</div>` : ""}
    ${moneyLine}
    ${profitText}
    ${liveBlock}
    ${removeBtn}
  `;

  const removeButton = card.querySelector(".bet-remove");
  if (removeButton) {
    removeButton.addEventListener("click", () => {
      stopLiveTracking(bet.id);
      myBets = myBets.filter((b) => b.id !== bet.id);
      saveBets();
      renderAll();
    });
  }

  if (!isSettled) {
    startLiveTracking(bet, liveBlockId);
  }

  return card;
}

function renderMyBets() {
  const root = document.getElementById("mybets-root");
  clearAllLiveTracking();

  if (myBets.length === 0) {
    root.innerHTML = '<p class="empty-state">No bets placed yet. Click a pick on the Picks tab to log one.</p>';
    return;
  }

  const unitValue = getUnitValue();
  const pending = myBets.filter((b) => b.status === "pending");
  root.innerHTML = "";

  if (pending.length > 0) {
    const totalStakeUnits = pending.reduce((sum, b) => sum + b.stakeUnits, 0);
    const totalPotentialUnits = pending.reduce((sum, b) => sum + b.stakeUnits * (b.multiplier - 1), 0);
    const summary = document.createElement("div");
    summary.className = "bets-summary";
    summary.innerHTML = `
      <div><span class="summary-label">In play</span> ${totalStakeUnits.toFixed(2)} units${unitValue ? ` (~$${(totalStakeUnits * unitValue).toFixed(0)})` : ""} across ${pending.length} bet${pending.length === 1 ? "" : "s"}</div>
      <div><span class="summary-label">Potential earnings</span> +${totalPotentialUnits.toFixed(2)} units${unitValue ? ` (~$${(totalPotentialUnits * unitValue).toFixed(0)})` : ""} if everything hits</div>
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
  const unitValue = getUnitValue();
  const todayStr = todayDateStr();

  const todaySettled = settled.filter((b) => b.date === todayStr);
  const todayUnits = todaySettled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);
  const allTimeUnits = settled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);

  const formatLine = (label, units, count) => {
    let text = `${label}: ${units >= 0 ? "+" : ""}${units.toFixed(2)} units`;
    if (unitValue) text += ` (${units >= 0 ? "+" : ""}$${(units * unitValue).toFixed(0)})`;
    if (count === 0) text = `${label}: no settled bets`;
    return text;
  };

  todayEl.textContent = formatLine("Today", todayUnits, todaySettled.length);
  todayEl.className = "net-today " + (todaySettled.length === 0 ? "zero" : todayUnits > 0 ? "positive" : todayUnits < 0 ? "negative" : "zero");

  allTimeEl.textContent = formatLine("All time", allTimeUnits, settled.length);
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
