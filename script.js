const UNIT_PCT = 0.03; // 1 unit = 3% of capital
const BANKROLL_KEY = "closeCallsBankroll";
const BETS_KEY = "closeCallsBets";

let currentPicks = [];
let currentSettled = [];
let myBets = [];
let activeModalPick = null;
let activeModalSide = null;

// ---------- storage ----------

function getBankroll() {
  const stored = localStorage.getItem(BANKROLL_KEY);
  return stored ? parseFloat(stored) : null;
}

function setBankroll(value) {
  try {
    localStorage.setItem(BANKROLL_KEY, String(value));
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

  const bankrollInput = document.getElementById("bankroll-input");
  const savedBankroll = getBankroll();
  if (savedBankroll) bankrollInput.value = savedBankroll;
  bankrollInput.addEventListener("input", () => {
    const val = parseFloat(bankrollInput.value);
    if (!isNaN(val) && val > 0) setBankroll(val);
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

  settlePendingBets();
  renderAll();
}

function renderAll() {
  renderPicks();
  renderExposureSummary();
  renderMyBets();
  renderNetCounter();
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

function renderPicks() {
  const root = document.getElementById("picks-root");

  if (currentPicks.length === 0) {
    root.innerHTML = '<p class="empty-state">No picks yet — the first automated research run hasn\'t happened.</p>';
    return;
  }

  const bySport = {};
  for (const pick of currentPicks) {
    const sport = pick.sport || "Other";
    if (!bySport[sport]) bySport[sport] = [];
    bySport[sport].push(pick);
  }

  root.innerHTML = "";
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
}

function renderExposureSummary() {
  const el = document.getElementById("exposure-summary");
  const bankroll = getBankroll();

  const totalUnits = currentPicks.reduce((sum, p) => sum + (p.recommended_units || 0), 0);
  if (totalUnits === 0) {
    el.hidden = true;
    return;
  }

  const totalPct = (totalUnits * UNIT_PCT * 100).toFixed(1);
  let text = `Current picks add up to ${totalUnits.toFixed(2)} units (${totalPct}% of capital) if you took every one`;
  if (bankroll) {
    text += ` — about $${(totalUnits * UNIT_PCT * bankroll).toFixed(0)}`;
  }
  el.textContent = text + ".";
  el.hidden = false;
  el.classList.toggle("hot", totalUnits * UNIT_PCT > 0.2);
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
  const bankroll = getBankroll();
  let stakeRow = "";
  if (units) {
    const dollarsText = bankroll
      ? `<span class="dollars">≈ $${(units * UNIT_PCT * bankroll).toFixed(0)}</span>`
      : `<span class="dollars">enter capital above for $ amount</span>`;
    stakeRow = `
      <div class="stake-row">
        <span class="units">Suggested: ${units} unit${units === 1 ? "" : "s"} (${(units * UNIT_PCT * 100).toFixed(1)}%)</span>
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

function renderMyBets() {
  const root = document.getElementById("mybets-root");
  if (myBets.length === 0) {
    root.innerHTML = '<p class="empty-state">No bets placed yet. Click a pick on the Picks tab to log one.</p>';
    return;
  }

  const sorted = [...myBets].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
  root.innerHTML = "";

  for (const bet of sorted) {
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

    root.appendChild(card);
  }

  root.querySelectorAll(".bet-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      myBets = myBets.filter((b) => b.id !== btn.dataset.id);
      saveBets();
      renderAll();
    });
  });
}

function renderNetCounter() {
  const el = document.getElementById("net-counter");
  const settled = myBets.filter((b) => b.status !== "pending");
  const netUnits = settled.reduce((sum, b) => sum + (b.profitUnits || 0), 0);
  const bankroll = getBankroll();

  let text = `Net: ${netUnits >= 0 ? "+" : ""}${netUnits.toFixed(2)} units`;
  if (bankroll) {
    text += ` (${netUnits >= 0 ? "+" : ""}$${(netUnits * UNIT_PCT * bankroll).toFixed(0)})`;
  }
  if (settled.length === 0) text = "Net: 0.00 units — no settled bets yet";

  el.textContent = text;
  el.className = "net-counter " + (netUnits > 0 ? "positive" : netUnits < 0 ? "negative" : "zero");
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
