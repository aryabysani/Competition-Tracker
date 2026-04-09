/**
 * popup.js — Competition Tracker
 * Reads competitions from storage, renders cards, runs live countdowns.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let competitions   = [];   // active (future deadline) competitions
let tickInterval   = null; // setInterval handle for countdown ticks

// ─── Entry Point ──────────────────────────────────────────────────────────────
async function init() {
  const { competitions: stored = [], lastSynced } = await chrome.storage.local.get(['competitions', 'lastSynced']);

  const now = new Date();

  // Keep only competitions with a parseable future deadline
  competitions = stored
    .filter(c => {
      if (!c.deadline) return false;
      const dl = new Date(c.deadline);
      return !isNaN(dl) && dl > now;
    })
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline)); // soonest first

  renderSyncTime(lastSynced);
  updateHeader(competitions.length);

  if (competitions.length === 0) {
    showEmpty();
  } else {
    renderCards();
    startTick();
  }
}

// ─── Header / Meta ────────────────────────────────────────────────────────────
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

  if (diffMins < 1)    el.textContent = 'Last synced: just now';
  else if (diffHrs < 1) el.textContent = `Last synced: ${diffMins}m ago`;
  else if (diffDays < 1) el.textContent = `Last synced: ${diffHrs}h ago`;
  else                  el.textContent = `Last synced: ${diffDays}d ago`;
}

// ─── Urgency Helpers ──────────────────────────────────────────────────────────
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
  const d  = Math.floor(totalSecs / 86400);
  const h  = Math.floor((totalSecs % 86400) / 3600);
  const m  = Math.floor((totalSecs % 3600)  / 60);
  const s  = totalSecs % 60;

  if (d > 0)    return `${d}d ${h}h ${m}m`;
  if (h > 0)    return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

// ─── Card Rendering ───────────────────────────────────────────────────────────
function renderCards() {
  const list = document.getElementById('competitionList');
  list.innerHTML = '';
  document.getElementById('emptyState').style.display = 'none';
  list.style.display = 'flex';

  for (const comp of competitions) {
    const card = buildCard(comp);
    list.appendChild(card);
  }
}

function buildCard(comp) {
  const msLeft  = new Date(comp.deadline).getTime() - Date.now();
  const urgency = getUrgency(msLeft);
  const label   = LABELS[urgency];

  const card = document.createElement('a');
  card.className       = `comp-card urgency-${urgency}`;
  card.href            = comp.url || 'https://unstop.com';
  card.target          = '_blank';
  card.rel             = 'noopener noreferrer';
  card.dataset.compId  = comp.id;
  card.dataset.deadline = comp.deadline;
  card.setAttribute('role', 'listitem');

  // Host line
  const hostHtml = comp.host
    ? `<div class="card-host">${escHtml(comp.host)}</div>`
    : '';

  // Round badge
  const roundHtml = comp.round
    ? `<span class="card-round">${escHtml(comp.round)}</span>`
    : '';

  card.innerHTML = `
    <div class="card-info">
      <div class="card-name">${escHtml(comp.name)}</div>
      ${hostHtml}
      ${roundHtml}
    </div>
    <div class="card-countdown">
      <div class="countdown-value">${formatCountdown(msLeft)}</div>
      <div class="countdown-label ${label.cls}">${label.text}</div>
    </div>
  `;

  return card;
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
    const dl = new Date(card.dataset.deadline).getTime();
    const msLeft = dl - now;

    if (msLeft <= 0) {
      // Competition just expired — fade out and remove
      card.style.opacity = '0';
      card.style.transition = 'opacity 0.4s';
      setTimeout(() => card.remove(), 400);
      return;
    }

    anyVisible = true;
    const urgency = getUrgency(msLeft);
    const label   = LABELS[urgency];

    // Update countdown value
    const valEl = card.querySelector('.countdown-value');
    if (valEl) valEl.textContent = formatCountdown(msLeft);

    // Update urgency class (only if changed — avoids reflow thrash)
    const cls = `urgency-${urgency}`;
    if (!card.classList.contains(cls)) {
      ['urgency-critical', 'urgency-high', 'urgency-medium', 'urgency-low', 'urgency-normal']
        .forEach(c => card.classList.remove(c));
      card.classList.add(cls);
    }

    // Update label
    const lblEl = card.querySelector('.countdown-label');
    if (lblEl) {
      lblEl.textContent = label.text;
      lblEl.className   = `countdown-label ${label.cls}`;
    }
  });

  // If all cards expired, show empty state
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
document.getElementById('goToUnstop').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://unstop.com/user/registrations/all/all?search=&page=1&sort=' });
  window.close();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
