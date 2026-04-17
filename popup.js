/**
 * popup.js — Competition Tracker
 *
 * Screens: onboarding → main list → add form
 * No automatic scraping — user clicks "Sync from Unstop" to inject content.js.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const HR = 3_600_000;
const DETAIL_RE = /unstop\.com\/(quiz|competitions|hackathons|p|challenges?|internships?|jobs|scholarships|workshops|conferences)\//i;

// ─── Screen Router ────────────────────────────────────────────────────────────
function showScreen(id) {
  ['screen-onboarding', 'screen-main', 'screen-add'].forEach(s => {
    document.getElementById(s).hidden = (s !== id);
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────
async function init() {
  const { hasOnboarded, competitions = [], lastSynced } =
    await chrome.storage.local.get(['hasOnboarded', 'competitions', 'lastSynced']);

  if (!hasOnboarded) {
    showScreen('screen-onboarding');
    bindOnboarding();
  } else {
    showScreen('screen-main');
    renderMain(competitions, lastSynced);
    bindMain();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 1 — ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════

function bindOnboarding() {
  document.getElementById('ob-goto-unstop').addEventListener('click', async () => {
    await chrome.storage.local.set({ hasOnboarded: true });
    chrome.tabs.create({ url: 'https://unstop.com' });
    window.close();
  });

  document.getElementById('ob-add-manual').addEventListener('click', async () => {
    await chrome.storage.local.set({ hasOnboarded: true });
    showScreen('screen-add');
    bindAddForm(/* returnTo */ 'screen-main');
    addDeadlineRow(); // start with one empty row
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 2 — MAIN LIST
// ═══════════════════════════════════════════════════════════════════════════

let tickInterval = null;

function bindMain() {
  // Sync button
  document.getElementById('syncBtn').addEventListener('click', handleSync);

  // Add New button
  document.getElementById('addNewBtn').addEventListener('click', () => {
    showScreen('screen-add');
    bindAddForm('screen-main');
    addDeadlineRow();
  });

  // Live countdown tick
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(tick, 1000);

  // Re-render when storage changes (content.js may have written new data)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.competitions || changes.lastSynced)) {
      chrome.storage.local.get(['competitions', 'lastSynced'], ({ competitions = [], lastSynced }) => {
        renderMain(competitions, lastSynced);
      });
    }
  });
}

// ── Sync ──────────────────────────────────────────────────────────────────────
async function handleSync() {
  const btn = document.getElementById('syncBtn');
  const msgEl = document.getElementById('syncMsg');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';

  if (!DETAIL_RE.test(url)) {
    setMsg(msgEl,
      !url.includes('unstop.com')
        ? 'Please navigate to unstop.com first, then click Sync.'
        : 'Navigate to a specific competition page on Unstop, then click Sync.',
      'error'
    );
    return;
  }

  btn.classList.add('syncing');
  document.querySelector('.sync-label').textContent = 'Reading page…';
  setMsg(msgEl, 'Extracting competition details…', '');

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (e) {
    btn.classList.remove('syncing');
    document.querySelector('.sync-label').textContent = 'Sync from Unstop';
    setMsg(msgEl, 'Could not inject script. Try reloading the page.', 'error');
    return;
  }

  // Wait for storage update (content.js writes within ~4s)
  const timeout = setTimeout(() => {
    btn.classList.remove('syncing');
    document.querySelector('.sync-label').textContent = 'Sync from Unstop';
    setMsg(msgEl, 'Timed out — make sure you are registered for this competition.', 'error');
  }, 9000);

  const listener = (changes, area) => {
    if (area !== 'local') return;
    if (changes.competitions || changes.lastSynced) {
      clearTimeout(timeout);
      chrome.storage.onChanged.removeListener(listener);
      btn.classList.remove('syncing');
      document.querySelector('.sync-label').textContent = 'Sync from Unstop';
      setMsg(msgEl, '✓ Competition synced!', 'success');
      setTimeout(() => setMsg(msgEl, '', ''), 3000);
    }
  };
  chrome.storage.onChanged.addListener(listener);
}

function setMsg(el, text, type) {
  el.textContent = text;
  el.className = 'sync-msg' + (type ? ' ' + type : '');
}

// ── Render main list ───────────────────────────────────────────────────────────
function renderMain(allComps, lastSynced) {
  renderSyncTime(lastSynced);

  const now = Date.now();

  // Build display groups: each comp + its future deadlines
  const groups = allComps
    .map(comp => ({ comp, deadlines: getDeadlines(comp).filter(d => new Date(d.datetime).getTime() > now) }))
    .filter(g => g.deadlines.length > 0)
    .sort((a, b) => {
      // Sort by soonest deadline across the group
      const aMin = Math.min(...a.deadlines.map(d => new Date(d.datetime).getTime()));
      const bMin = Math.min(...b.deadlines.map(d => new Date(d.datetime).getTime()));
      return aMin - bMin;
    });

  const totalDeadlines = groups.reduce((s, g) => s + g.deadlines.length, 0);
  document.getElementById('activeCount').textContent = totalDeadlines;
  document.getElementById('footerCount').textContent = `${totalDeadlines} active`;

  const listEl = document.getElementById('competitionList');
  const emptyEl = document.getElementById('emptyState');

  if (groups.length === 0) {
    listEl.innerHTML = '';
    listEl.style.display = 'none';
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;
  listEl.style.display = 'flex';
  listEl.innerHTML = '';

  for (const { comp, deadlines } of groups) {
    listEl.appendChild(buildGroupCard(comp, deadlines));
  }
}

function buildGroupCard(comp, deadlines) {
  const now = Date.now();

  const group = document.createElement('div');
  group.className = 'comp-group';
  group.dataset.compId = comp.id;

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'comp-group-header';

  const infoEl = document.createElement('div');
  infoEl.className = 'comp-group-info';
  infoEl.innerHTML = `
    <div class="comp-group-name">${escHtml(comp.name)}</div>
    ${comp.host ? `<div class="comp-group-host">${escHtml(comp.host)}</div>` : ''}
  `;

  const actionsEl = document.createElement('div');
  actionsEl.className = 'comp-group-actions';

  if (comp.url) {
    const gotoBtn = document.createElement('button');
    gotoBtn.className = 'btn-goto-sm';
    gotoBtn.textContent = 'Open ↗';
    gotoBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: comp.url });
      window.close();
    });
    actionsEl.appendChild(gotoBtn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove';
  removeBtn.title = 'Remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => removeComp(comp.id));
  actionsEl.appendChild(removeBtn);

  headerEl.appendChild(infoEl);
  headerEl.appendChild(actionsEl);
  group.appendChild(headerEl);

  // Deadline rows
  const rowsEl = document.createElement('div');
  rowsEl.className = 'deadline-rows';

  const sorted = [...deadlines].sort((a, b) =>
    new Date(a.datetime).getTime() - new Date(b.datetime).getTime()
  );

  for (const dl of sorted) {
    rowsEl.appendChild(buildDeadlineRow(dl, now));
  }

  group.appendChild(rowsEl);
  return group;
}

function buildDeadlineRow(dl, now) {
  const ms      = new Date(dl.datetime).getTime() - now;
  const urgency = getUrgency(ms);
  const label   = LABELS[urgency];

  const row = document.createElement('div');
  row.className = `deadline-row urgency-${urgency}`;
  row.dataset.datetime = dl.datetime;

  row.innerHTML = `
    <div class="dl-dot"></div>
    <div class="dl-label">${escHtml(dl.label)}</div>
    <div class="dl-countdown">
      <div class="dl-prefix">${dl.prefix || ''}</div>
      <div class="dl-value">${formatCountdown(ms)}</div>
    </div>
    <div class="dl-badge ${label.cls}">${label.text}</div>
  `;
  return row;
}

// ── Live tick ─────────────────────────────────────────────────────────────────
function tick() {
  const now = Date.now();
  document.querySelectorAll('.deadline-row').forEach(row => {
    const ms = new Date(row.dataset.datetime).getTime() - now;
    if (ms <= 0) { row.closest('.comp-group')?.remove(); return; }

    const urgency = getUrgency(ms);
    const label   = LABELS[urgency];

    const valEl = row.querySelector('.dl-value');
    if (valEl) valEl.textContent = formatCountdown(ms);

    const cls = `urgency-${urgency}`;
    if (!row.classList.contains(cls)) {
      ['urgency-critical','urgency-high','urgency-medium','urgency-low','urgency-normal']
        .forEach(c => row.classList.remove(c));
      row.classList.add(cls);
    }

    const badgeEl = row.querySelector('.dl-badge');
    if (badgeEl) { badgeEl.textContent = label.text; badgeEl.className = `dl-badge ${label.cls}`; }
  });

  // If all groups gone, show empty state
  if (document.querySelectorAll('.comp-group').length === 0) {
    document.getElementById('competitionList').style.display = 'none';
    document.getElementById('emptyState').hidden = false;
    document.getElementById('activeCount').textContent = '0';
    document.getElementById('footerCount').textContent = '0 active';
  }
}

// ── Remove competition ─────────────────────────────────────────────────────────
function removeComp(id) {
  chrome.storage.local.get(['competitions'], ({ competitions = [] }) => {
    const filtered = competitions.filter(c => c.id !== id);
    chrome.storage.local.set({ competitions: filtered });
  });
}

// ── Sync time label ───────────────────────────────────────────────────────────
function renderSyncTime(lastSynced) {
  const el = document.getElementById('syncTime');
  if (!el) return;
  if (!lastSynced) { el.textContent = 'Never synced'; return; }
  const diff = Date.now() - lastSynced;
  const mins = Math.floor(diff / 60_000);
  const hrs  = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1)     el.textContent = 'Synced: just now';
  else if (hrs < 1) el.textContent = `Synced: ${mins}m ago`;
  else if (days < 1) el.textContent = `Synced: ${hrs}h ago`;
  else               el.textContent = `Synced: ${days}d ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN 3 — ADD FORM
// ═══════════════════════════════════════════════════════════════════════════

function bindAddForm(returnTo) {
  // Reset form
  document.getElementById('f-name').value = '';
  document.getElementById('f-host').value = '';
  document.getElementById('f-url').value  = '';
  document.getElementById('deadlines-list').innerHTML = '';
  document.getElementById('formError').textContent = '';

  document.getElementById('backBtn').onclick = () => {
    showScreen(returnTo);
    if (returnTo === 'screen-main') {
      chrome.storage.local.get(['competitions', 'lastSynced'], ({ competitions = [], lastSynced }) => {
        renderMain(competitions, lastSynced);
        bindMain();
      });
    }
  };

  document.getElementById('addDeadlineBtn').onclick = () => addDeadlineRow();

  document.getElementById('saveBtn').onclick = saveManualComp;
}

function addDeadlineRow() {
  const list = document.getElementById('deadlines-list');

  const entry = document.createElement('div');
  entry.className = 'deadline-entry';

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'dl-entry-label';
  labelInput.placeholder = 'e.g. Round 1 Submission';

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'dl-entry-date';

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'dl-entry-time';
  timeInput.value = '23:59';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'dl-entry-remove';
  removeBtn.textContent = '×';
  removeBtn.type = 'button';
  removeBtn.addEventListener('click', () => entry.remove());

  entry.appendChild(labelInput);
  entry.appendChild(dateInput);
  entry.appendChild(timeInput);
  entry.appendChild(removeBtn);
  list.appendChild(entry);
}

async function saveManualComp() {
  const errorEl = document.getElementById('formError');
  errorEl.textContent = '';

  const name = document.getElementById('f-name').value.trim();
  const host = document.getElementById('f-host').value.trim();
  const url  = document.getElementById('f-url').value.trim();

  if (!name) {
    errorEl.textContent = 'Competition name is required.';
    return;
  }

  // Collect deadlines
  const deadlines = [];
  document.querySelectorAll('.deadline-entry').forEach(entry => {
    const label = entry.querySelector('.dl-entry-label').value.trim() || 'Deadline';
    const date  = entry.querySelector('.dl-entry-date').value;
    const time  = entry.querySelector('.dl-entry-time').value || '23:59';
    if (date) {
      const datetime = new Date(`${date}T${time}`).toISOString();
      deadlines.push({ label, datetime });
    }
  });

  if (deadlines.length === 0) {
    errorEl.textContent = 'Add at least one deadline with a date.';
    return;
  }

  const comp = {
    id:        'manual_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name:      name.slice(0, 200),
    host:      host.slice(0, 120),
    url:       url || '',
    deadlines,
    source:    'manual',
    updatedAt: Date.now(),
  };

  const { competitions = [] } = await chrome.storage.local.get(['competitions']);
  competitions.push(comp);
  await chrome.storage.local.set({ competitions, lastSynced: Date.now() });

  showScreen('screen-main');
  chrome.storage.local.get(['competitions', 'lastSynced'], ({ competitions = [], lastSynced }) => {
    renderMain(competitions, lastSynced);
    bindMain();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Shared Helpers ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Normalise a competition into a flat list of {label, datetime} deadlines.
function getDeadlines(comp) {
  if (comp.source === 'manual') {
    return (comp.deadlines || []).filter(d => d.datetime);
  }

  // Scraped: derive from rounds — use start date when upcoming, else end date
  const now = Date.now();
  return (comp.rounds || [])
    .map(r => {
      const startMs = r.start ? new Date(r.start).getTime() : null;
      const endMs   = r.end   ? new Date(r.end).getTime()   : null;
      const datetime = (startMs && startMs > now) ? r.start : r.end;
      return { label: r.name || 'Round', datetime };
    })
    .filter(d => d.datetime);
}

function getUrgency(ms) {
  if (ms <       HR) return 'critical';
  if (ms <  24 * HR) return 'high';
  if (ms <  48 * HR) return 'medium';
  if (ms <  72 * HR) return 'low';
  return 'normal';
}

const LABELS = {
  critical: { text: '🔥 CRITICAL',  cls: 'label-critical' },
  high:     { text: '🚨 Due Today', cls: 'label-high'     },
  medium:   { text: '⚠️ Tomorrow',  cls: 'label-medium'   },
  low:      { text: '📅 This Week', cls: 'label-low'      },
  normal:   { text: '✅ On Track',  cls: 'label-normal'   },
};

function formatCountdown(ms) {
  if (ms <= 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sc}s`;
  return `${m}m ${sc}s`;
}

function escHtml(str) {
  const n = document.createElement('span');
  n.appendChild(document.createTextNode(String(str)));
  return n.innerHTML;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();
