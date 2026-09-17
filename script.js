const UNIT_VALUE_KEY = "closeCallsUnitValue";
const BETS_KEY = "closeCallsBets";

let currentPicks = [];
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

  const profitText =
    bet.status === "pending"
      ? ""
      : `<div class="bet-profit ${bet.profitUnits >= 0 ? "positive" : "negative"}">${bet.profitUnits >= 0 ? "+" : ""}${bet.profitUnits.toFixed(2)} units</div>`;

  const removeBtn = bet.status === "pending" ? `<button class="bet-remove" data-id="${bet.id}">Remove</button>` : "";

  card.innerHTML = `
    <div class="bet-top">
      <span class="bet-matchup">${escapeHtml(bet.matchup)} — backing ${escapeHtml(bet.side)}</span>
      <span class="bet-status ${bet.status}">${bet.status}</span>
    </div>
    <div class="bet-detail">${escapeHtml(bet.sport)} · ${escapeHtml(bet.date)} · ${bet.stakeUnits} units @ ${bet.multiplier}x · EV was ${bet.evPercent >= 0 ? "+" : ""}${bet.evPercent.toFixed(1)}%</div>
    ${bet.finalScore ? `<div class="bet-detail">Final: ${escapeHtml(bet.finalScore)}</div>` : ""}
    ${profitText}
    ${removeBtn}
  `;

  const removeButton = card.querySelector(".bet-remove");
  if (removeButton) {
    removeButton.addEventListener("click", () => {
      myBets = myBets.filter((b) => b.id !== bet.id);
      saveBets();
      renderAll();
    });
  }

  return card;
}

function renderMyBets() {
  const root = document.getElementById("mybets-root");
  if (myBets.length === 0) {
    root.innerHTML = '<p class="empty-state">No bets placed yet. Click a pick on the Picks tab to log one.</p>';
    return;
  }

  const sorted = [...myBets].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  root.innerHTML = "";
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
