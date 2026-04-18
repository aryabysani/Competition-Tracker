/**
 * popup.js — Competition Tracker
 *
 * Screens: onboarding → main list → add form
 * No automatic scraping — user clicks "Sync from Unstop" to inject content.js.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const HR = 3_600_000;

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
  // Quick links
  document.getElementById('qlUnstop').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://unstop.com' });
    window.close();
  });
  document.getElementById('qlRegistrations').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://unstop.com/user/registrations/all/all' });
    window.close();
  });

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

  // Bind buttons synchronously — always works regardless of auto-fill timing
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

  // Auto-fill in background — fields update when data arrives, doesn't block buttons
  autoFillForm();
}

async function autoFillForm() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('unstop.com')) return;

    const cleanUrl = tab.url.split('?')[0];
    document.getElementById('f-url').value = cleanUrl;

    if (tab.title) {
      const name = tab.title.replace(/\s*[|–—].*$/, '').trim();
      if (name && name.length > 2) document.getElementById('f-name').value = name;
    }

    const urlId = (cleanUrl.match(/(\d{5,})(?:\/?$)/) || [])[1];
    if (!urlId) return;

    for (const type of ['competition', 'hackathon', 'quiz']) {
      try {
        const res = await fetch(`https://unstop.com/api/public/${type}/${urlId}`);
        if (!res.ok) continue;
        const json = await res.json();
        const comp = json?.data?.[type] || json?.data?.competition || json?.data;
        const host = comp?.organisation?.name || comp?.organization?.name ||
                     comp?.college?.name || comp?.company?.name || '';
        if (host) { document.getElementById('f-host').value = host; break; }
      } catch (_) {}
    }
  } catch (_) {}
}

function buildTimePicker(defaultHour = 12, defaultMin = 0, defaultAmPm = 'AM') {
  const wrap = document.createElement('div');
  wrap.className = 'time-picker';

  const hourSel = document.createElement('select');
  hourSel.className = 'tp-hour';
  for (let h = 1; h <= 12; h++) {
    const o = document.createElement('option');
    o.value = h; o.textContent = h;
    if (h === defaultHour) o.selected = true;
    hourSel.appendChild(o);
  }

  const sep = document.createElement('span');
  sep.className = 'tp-sep'; sep.textContent = ':';

  const minSel = document.createElement('select');
  minSel.className = 'tp-min';
  for (let m = 0; m < 60; m += 5) {
    const o = document.createElement('option');
    o.value = m; o.textContent = String(m).padStart(2, '0');
    if (m === defaultMin) o.selected = true;
    minSel.appendChild(o);
  }
  const o59 = document.createElement('option');
  o59.value = 59; o59.textContent = '59';
  if (defaultMin === 59) o59.selected = true;
  minSel.appendChild(o59);

  const ampmWrap = document.createElement('div');
  ampmWrap.className = 'ampm-toggle';
  ['AM', 'PM'].forEach(v => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ampm-btn'; btn.textContent = v; btn.dataset.val = v;
    if (v === defaultAmPm) btn.classList.add('active');
    btn.addEventListener('click', () => {
      ampmWrap.querySelectorAll('.ampm-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    ampmWrap.appendChild(btn);
  });

  wrap.appendChild(hourSel); wrap.appendChild(sep);
  wrap.appendChild(minSel); wrap.appendChild(ampmWrap);
  return wrap;
}

function getTimeFrom(timePicker) {
  let h = parseInt(timePicker.querySelector('.tp-hour').value);
  const m = parseInt(timePicker.querySelector('.tp-min').value);
  const ampm = timePicker.querySelector('.ampm-btn.active').dataset.val;
  if (ampm === 'AM') { if (h === 12) h = 0; }
  else               { if (h !== 12) h += 12; }
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function addDeadlineRow() {
  const list = document.getElementById('deadlines-list');
  const entry = document.createElement('div');
  entry.className = 'deadline-entry';

  // Header: round name + remove
  const headerRow = document.createElement('div');
  headerRow.className = 'dl-entry-header';

  const labelInput = document.createElement('input');
  labelInput.type = 'text'; labelInput.className = 'dl-entry-label';
  labelInput.placeholder = 'e.g. Round 1 Submission';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'dl-entry-remove'; removeBtn.textContent = '×'; removeBtn.type = 'button';
  removeBtn.addEventListener('click', () => entry.remove());

  headerRow.appendChild(labelInput); headerRow.appendChild(removeBtn);

  // Starts row
  const startsRow = document.createElement('div');
  startsRow.className = 'dl-entry-row';
  const startsLbl = document.createElement('span');
  startsLbl.className = 'dl-entry-rowlabel';
  startsLbl.innerHTML = 'Starts <span class="req">*</span>';
  const startDate = document.createElement('input');
  startDate.type = 'date'; startDate.className = 'dl-entry-date dl-start-date';
  const startTP = buildTimePicker(12, 0, 'AM');
  startTP.classList.add('dl-start-time');
  startsRow.appendChild(startsLbl); startsRow.appendChild(startDate); startsRow.appendChild(startTP);

  // Ends row
  const endsRow = document.createElement('div');
  endsRow.className = 'dl-entry-row';
  const endsLbl = document.createElement('span');
  endsLbl.className = 'dl-entry-rowlabel';
  endsLbl.innerHTML = 'Ends <span class="opt">(opt)</span>';
  const endDate = document.createElement('input');
  endDate.type = 'date'; endDate.className = 'dl-entry-date dl-end-date';
  const endTP = buildTimePicker(11, 59, 'PM');
  endTP.classList.add('dl-end-time');
  endsRow.appendChild(endsLbl); endsRow.appendChild(endDate); endsRow.appendChild(endTP);

  entry.appendChild(headerRow); entry.appendChild(startsRow); entry.appendChild(endsRow);
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
    const label     = entry.querySelector('.dl-entry-label').value.trim() || 'Deadline';
    const startDate = entry.querySelector('.dl-start-date').value;
    const startTime = getTimeFrom(entry.querySelector('.dl-start-time'));
    const endDate   = entry.querySelector('.dl-end-date').value;
    const endTime   = endDate ? getTimeFrom(entry.querySelector('.dl-end-time')) : '23:59';
    if (startDate) {
      const start = new Date(`${startDate}T${startTime}`).toISOString();
      const end   = endDate ? new Date(`${endDate}T${endTime}`).toISOString() : null;
      deadlines.push({ label, start, end });
    }
  });

  if (deadlines.length === 0) {
    errorEl.textContent = 'Add at least one deadline with a start date.';
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

// Normalise a competition into a flat list of {label, datetime, prefix?} deadlines.
function getDeadlines(comp) {
  if (comp.source === 'manual') {
    const now = Date.now();
    return (comp.deadlines || []).flatMap(d => {
      // Legacy format: single datetime
      if (d.datetime) return [{ label: d.label, datetime: d.datetime }];

      const startMs = d.start ? new Date(d.start).getTime() : null;
      const endMs   = d.end   ? new Date(d.end).getTime()   : null;
      const items = [];

      if (startMs && startMs > now) {
        items.push({ label: d.label, datetime: d.start, prefix: 'Starts' });
        if (endMs && endMs > now) {
          items.push({ label: d.label, datetime: d.end, prefix: 'Ends' });
        }
      } else if (endMs && endMs > now) {
        items.push({ label: d.label, datetime: d.end, prefix: 'Ends' });
      }

      return items;
    });
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
