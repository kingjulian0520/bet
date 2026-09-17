async function main() {
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
    const d = new Date(data.generated_at);
    lastUpdatedEl.textContent = "Last updated " + d.toLocaleString();
  }

  if (!data.picks || data.picks.length === 0) {
    root.innerHTML = '<p class="empty-state">No picks yet — the first automated research run hasn\'t happened.</p>';
    return;
  }

  const bySport = {};
  for (const pick of data.picks) {
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
