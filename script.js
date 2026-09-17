const UNIT_PCT = 0.03; // 1 unit = 3% of capital
const BANKROLL_KEY = "closeCallsBankroll";

let currentPicks = [];

function getBankroll() {
  const stored = localStorage.getItem(BANKROLL_KEY);
  return stored ? parseFloat(stored) : null;
}

function setBankroll(value) {
  try {
    localStorage.setItem(BANKROLL_KEY, String(value));
  } catch (err) {
    // localStorage unavailable (private browsing etc.) — ignore, dollar amounts just won't show
  }
}

async function main() {
  const root = document.getElementById("picks-root");
  const lastUpdatedEl = document.getElementById("last-updated");
  const bankrollInput = document.getElementById("bankroll-input");

  const savedBankroll = getBankroll();
  if (savedBankroll) bankrollInput.value = savedBankroll;

  bankrollInput.addEventListener("input", () => {
    const val = parseFloat(bankrollInput.value);
    if (!isNaN(val) && val > 0) setBankroll(val);
    renderPicks();
    renderExposureSummary();
  });

  let data;
  try {
    const res = await fetch("data/picks.json", { cache: "no-store" });
    data = await res.json();
  } catch (err) {
    root.innerHTML = '<p class="empty-state">Could not load picks data.</p>';
    return;
  }

  if (data.generated_at) {
    const d = new Date(data.generated_at);
    lastUpdatedEl.textContent = "Last updated " + d.toLocaleString();
  }

  currentPicks = data.picks || [];
  renderPicks();
  renderExposureSummary();
}

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
    const dollars = (totalUnits * UNIT_PCT * bankroll).toFixed(0);
    text += ` — about $${dollars}`;
  }
  el.textContent = text + ".";
  el.hidden = false;
  el.classList.toggle("hot", totalUnits * UNIT_PCT > 0.2);
}

function renderCard(pick) {
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

  const reasoningItems = (pick.reasoning || [])
    .map((r) => `<li>${escapeHtml(r)}</li>`)
    .join("");

  const sourceLinks = (pick.sources || [])
    .map((s, i) => `<a href="${escapeAttr(s)}" target="_blank" rel="noopener noreferrer">[${i + 1}]</a>`)
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
        <span class="units">${units} unit${units === 1 ? "" : "s"} (${(units * UNIT_PCT * 100).toFixed(1)}% of capital)</span>
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
  `;

  return card;
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
