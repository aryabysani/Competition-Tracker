/**
 * popup.js — Competition Tracker
 * Reads competitions from storage, renders cards with round timelines,
 * runs live countdowns.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let competitions = [];   // competitions with a future deadline, sorted soonest first
let tickInterval = null;

// ─── Entry Point ──────────────────────────────────────────────────────────────
async function init() {
  const { competitions: stored = [], lastSynced } =
    await chrome.storage.local.get(['competitions', 'lastSynced']);

  const now = new Date();

  // Keep only competitions whose deadline is in the future
  competitions = stored
    .filter(c => {
      if (!c.deadline) return false;
      const dl = new Date(c.deadline);
      return !isNaN(dl) && dl > now;
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  renderSyncTime(lastSynced);
  updateHeader(competitions.length);

  if (competitions.length === 0) {
    showEmpty();
  } else {
    renderCards();
    startTick();
  }
}

// ─── Header ───────────────────────────────────────────────────────────────────
function updateHeader(count) {
  document.getElementById('activeCount').textContent = count;
  document.getElementById('footerCount').textContent = `${count} active`;
}

function renderSyncTime(lastSynced) {
  const el = document.getElementById('syncTime');
  if (!lastSynced) { el.textContent = 'Never synced'; return; }

  const diffMs   = Date.now() - lastSynced;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHrs  = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1)     el.textContent = 'Last synced: just now';
  else if (diffHrs < 1) el.textContent = `Last synced: ${diffMins}m ago`;
  else if (diffDays < 1) el.textContent = `Last synced: ${diffHrs}h ago`;
  else                  el.textContent = `Last synced: ${diffDays}d ago`;
}

// ─── Urgency ──────────────────────────────────────────────────────────────────
const HR = 3_600_000;

function getUrgency(msLeft) {
  if (msLeft <       HR) return 'critical';
  if (msLeft <  24 * HR) return 'high';
  if (msLeft <  48 * HR) return 'medium';
  if (msLeft <  72 * HR) return 'low';
  return 'normal';
}

const LABELS = {
  critical: { text: '🔥 CRITICAL',  cls: 'label-critical' },
  high:     { text: '🚨 Due Today', cls: 'label-high'     },
  medium:   { text: '⚠️ Tomorrow',  cls: 'label-medium'   },
  low:      { text: '📅 This Week', cls: 'label-low'      },
  normal:   { text: '✅ On Track',  cls: 'label-normal'   },
};

// ─── Countdown Formatter ──────────────────────────────────────────────────────
function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  const totalSecs = Math.floor(ms / 1000);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ─── Date Formatter ───────────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ─── Card Rendering ───────────────────────────────────────────────────────────
function renderCards() {
  const list = document.getElementById('competitionList');
  list.innerHTML = '';
  document.getElementById('emptyState').style.display = 'none';
  list.style.display = 'flex';

  for (const comp of competitions) {
    list.appendChild(buildCard(comp));
  }
}

function buildCard(comp) {
  const now     = Date.now();
  const msLeft  = new Date(comp.deadline).getTime() - now;
  const urgency = getUrgency(msLeft);
  const label   = LABELS[urgency];

  const card = document.createElement('div');
  card.className      = `comp-card urgency-${urgency}`;
  card.dataset.compId  = comp.id;
  card.dataset.deadline = comp.deadline;

  // Next round name (from comp.nextRound or fallback)
  const nextRoundName = comp.nextRound?.name || '';
  const nextRoundHtml = nextRoundName
    ? `<span class="card-next-round" title="${escHtml(nextRoundName)}">${escHtml(nextRoundName)}</span>`
    : '';

  // Host
  const hostHtml = comp.host
    ? `<div class="card-host">${escHtml(comp.host)}</div>`
    : '';

  // Rounds count
  const rounds = Array.isArray(comp.rounds) ? comp.rounds : [];
  const expandLabel = rounds.length > 0
    ? `${rounds.length} round${rounds.length > 1 ? 's' : ''} ▾`
    : '';
  const expandBtnHtml = rounds.length > 0
    ? `<button class="btn-expand" data-comp-id="${escHtml(comp.id)}">${expandLabel}</button>`
    : '';

  card.innerHTML = `
    <div class="card-top">
      <div class="card-info">
        <div class="card-name">${escHtml(comp.name)}</div>
        ${hostHtml}
        ${nextRoundHtml}
      </div>
      <div class="card-countdown">
        <div class="countdown-value">${formatCountdown(msLeft)}</div>
        <div class="countdown-label ${label.cls}">${label.text}</div>
      </div>
    </div>
    <div class="card-actions">
      ${expandBtnHtml}
      <button class="btn-goto" data-url="${escHtml(comp.url || 'https://unstop.com')}">
        Go to Competition ↗
      </button>
    </div>
    ${rounds.length > 0 ? buildRoundsPanel(rounds, comp.nextRound) : ''}
  `;

  // "Go to Competition" button
  card.querySelector('.btn-goto').addEventListener('click', e => {
    e.stopPropagation();
    chrome.tabs.create({ url: e.currentTarget.dataset.url });
    window.close();
  });

  // Expand / collapse rounds
  const expandBtn = card.querySelector('.btn-expand');
  if (expandBtn) {
    const panel = card.querySelector('.rounds-panel');
    expandBtn.addEventListener('click', e => {
      e.stopPropagation();
      const open = panel.classList.toggle('open');
      expandBtn.textContent = open
        ? `${rounds.length} round${rounds.length > 1 ? 's' : ''} ▴`
        : `${rounds.length} round${rounds.length > 1 ? 's' : ''} ▾`;
    });
  }

  return card;
}

function buildRoundsPanel(rounds, nextRound) {
  const now = Date.now();
  const nextEnd = nextRound?.end ? new Date(nextRound.end).getTime() : null;

  const items = rounds.map(r => {
    const endMs   = r.end ? new Date(r.end).getTime() : null;
    const isPast  = endMs && endMs <= now;
    const isNext  = nextEnd && endMs === nextEnd;

    let cls = '';
    if (isNext)     cls = 'round-next';
    else if (isPast) cls = 'round-past';

    const startStr = formatDate(r.start);
    const endStr   = formatDate(r.end);

    let datesHtml = '';
    if (startStr && endStr) {
      datesHtml = `<div class="round-dates">${startStr} → ${endStr}</div>`;
    } else if (endStr) {
      datesHtml = `<div class="round-dates">Ends: ${endStr}</div>`;
    } else if (startStr) {
      datesHtml = `<div class="round-dates">Starts: ${startStr}</div>`;
    }

    return `
      <div class="round-item ${cls}">
        <div class="round-dot"></div>
        <div class="round-body">
          <div class="round-name">${escHtml(r.name || 'Round')}</div>
          ${datesHtml}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="rounds-panel">
      <div class="rounds-title">All Rounds</div>
      ${items}
    </div>`;
}

// ─── Live Countdown Tick ──────────────────────────────────────────────────────
function startTick() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, 1000);
}

function tick() {
  const now = Date.now();
  let anyVisible = false;

  document.querySelectorAll('.comp-card').forEach(card => {
    const dl     = new Date(card.dataset.deadline).getTime();
    const msLeft = dl - now;

    if (msLeft <= 0) {
      card.style.opacity    = '0';
      card.style.transition = 'opacity 0.4s';
      setTimeout(() => card.remove(), 400);
      return;
    }

    anyVisible = true;
    const urgency = getUrgency(msLeft);
    const label   = LABELS[urgency];

    const valEl = card.querySelector('.countdown-value');
    if (valEl) valEl.textContent = formatCountdown(msLeft);

    const cls = `urgency-${urgency}`;
    if (!card.classList.contains(cls)) {
      ['urgency-critical','urgency-high','urgency-medium','urgency-low','urgency-normal']
        .forEach(c => card.classList.remove(c));
      card.classList.add(cls);
    }

    const lblEl = card.querySelector('.countdown-label');
    if (lblEl) {
      lblEl.textContent = label.text;
      lblEl.className   = `countdown-label ${label.cls}`;
    }
  });

  if (!anyVisible) {
    clearInterval(tickInterval);
    showEmpty();
    updateHeader(0);
  }
}

// ─── Empty State ──────────────────────────────────────────────────────────────
function showEmpty() {
  document.getElementById('competitionList').style.display = 'none';
  document.getElementById('emptyState').style.display = 'flex';
}

// ─── XSS-safe HTML Escaping ───────────────────────────────────────────────────
function escHtml(str) {
  const node = document.createElement('span');
  node.appendChild(document.createTextNode(String(str)));
  return node.innerHTML;
}

// ─── Events ───────────────────────────────────────────────────────────────────
document.getElementById('goToRegistrations').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://unstop.com/user/registrations' });
  window.close();
});

document.getElementById('goToUnstop').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://unstop.com' });
  window.close();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
