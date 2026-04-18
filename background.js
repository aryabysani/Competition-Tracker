/**
 * background.js — Competition Tracker Service Worker
 *
 * Listens for messages from content.js, refreshes alarms,
 * and updates the action badge.
 */

'use strict';

const ALARM_PREFIX = 'comp_';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Competition Tracker] Installed');
  refreshAlarms();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Competition Tracker] Started');
  refreshAlarms();
});

// ─── Storage Change Listener ─────────────────────────────────────────────────
// Keeps badge + alarms in sync whenever competitions are added or removed.
// This covers all writes: content.js scrapes, manual adds, and deletions.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.competitions) {
    refreshAlarms();
    updateBadge();
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'scraped') {
    console.log(`[Competition Tracker] Received ${msg.count} competition(s) from content script`);
    // storage.onChanged already handles refresh — just ack the message
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Alarm Trigger ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  const lastUnderscore = alarm.name.lastIndexOf('_');
  const urgency = alarm.name.slice(lastUnderscore + 1);
  const id      = alarm.name.slice(ALARM_PREFIX.length, lastUnderscore);

  chrome.storage.local.get(['competitions'], ({ competitions = [] }) => {
    const comp = competitions.find(c => c.id === id);
    if (!comp) return;

    const roundLabel = comp.nextRound?.name ? ` — ${comp.nextRound.name}` : '';

    const NOTIFS = {
      '48h': { title: '⏰ Competition in 2 Days',  msg: `${comp.name}${roundLabel} is due in 48 hours!`, prio: 1 },
      '24h': { title: '🚨 Competition Tomorrow!',  msg: `${comp.name}${roundLabel} is due TOMORROW. Submit now!`, prio: 1 },
      '1h':  { title: '🔥 1 HOUR LEFT!',           msg: `${comp.name}${roundLabel} — 1 hour to go. GO GO GO!`, prio: 2 },
    };

    const n = NOTIFS[urgency];
    if (!n) return;

    chrome.notifications.create(`notif_${id}_${urgency}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icon128.png'),
      title: n.title, message: n.msg, priority: n.prio,
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns the soonest upcoming deadline ms for any comp type (scraped or manual).
function getSoonestDeadlineMs(comp, now) {
  // Scraped comps store a pre-computed deadline string
  if (comp.deadline) {
    const ms = new Date(comp.deadline).getTime();
    return !isNaN(ms) && ms > now ? ms : null;
  }
  // Manual comps store deadlines[] with start/end per round
  if (comp.source === 'manual' && Array.isArray(comp.deadlines)) {
    const times = comp.deadlines.flatMap(d => {
      const candidates = [];
      if (d.start) candidates.push(new Date(d.start).getTime());
      if (d.end)   candidates.push(new Date(d.end).getTime());
      if (d.datetime) candidates.push(new Date(d.datetime).getTime());
      return candidates.filter(t => !isNaN(t) && t > now);
    });
    return times.length > 0 ? Math.min(...times) : null;
  }
  return null;
}

// ─── Alarm Management ─────────────────────────────────────────────────────────

async function refreshAlarms() {
  const { competitions = [] } = await chrome.storage.local.get(['competitions']);
  const now = Date.now();

  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing.filter(a => a.name.startsWith(ALARM_PREFIX)).map(a => chrome.alarms.clear(a.name))
  );

  let created = 0;
  for (const comp of competitions) {
    const deadlineMs = getSoonestDeadlineMs(comp, now);
    if (!deadlineMs) continue;

    for (const [label, offset] of [['48h', 48 * 3600000], ['24h', 24 * 3600000], ['1h', 3600000]]) {
      const at = deadlineMs - offset;
      if (at > now) {
        await chrome.alarms.create(`${ALARM_PREFIX}${comp.id}_${label}`, { when: at });
        created++;
      }
    }
  }

  console.log(`[Competition Tracker] ${created} alarm(s) set for ${competitions.length} competition(s)`);
}

// ─── Badge ────────────────────────────────────────────────────────────────────
// Count: active (future) competitions
// Colour: red ≤48h, orange ≤72h, purple otherwise

async function updateBadge() {
  const { competitions = [] } = await chrome.storage.local.get(['competitions']);
  const now = Date.now();

  const activeTimes = competitions
    .map(c => getSoonestDeadlineMs(c, now))
    .filter(Boolean);

  if (activeTimes.length === 0) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const minLeft = Math.min(...activeTimes) - now;
  const colour  =
    minLeft <= 48 * 3_600_000 ? '#ff3b3b' :
    minLeft <= 72 * 3_600_000 ? '#ff8c00' :
                                '#764ba2';

  await chrome.action.setBadgeText({ text: String(activeTimes.length) });
  await chrome.action.setBadgeBackgroundColor({ color: colour });
}
