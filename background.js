/**
 * background.js — Competition Tracker Service Worker
 *
 * Receives a list of { name, url } from content.js, fetches each competition's
 * detail page on Unstop, extracts the next upcoming round/submission deadline,
 * stores results in chrome.storage.local, sets alarms, and updates the badge.
 *
 * Deadline extraction order:
 *   1. __NEXT_DATA__ JSON blob (Next.js SSR) — most reliable
 *   2. Any <script> tag JSON that mentions "lastDate" / "deadline"
 *   3. Raw HTML regex scan as last resort
 */

'use strict';

const ALARM_PREFIX = 'comp_';

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Competition Tracker] Installed');
  refreshAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Competition Tracker] Started');
  refreshAlarms();
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'scraped') {
    console.log(`[Competition Tracker] Received ${msg.count} competitions from content script`);
    refreshAlarms();
    updateBadge();
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

    const NOTIFS = {
      '48h': { title: '⏰ Competition in 2 Days',  msg: `${comp.name} is due in 48 hours. Don't miss it!`, prio: 1 },
      '24h': { title: '🚨 Competition Tomorrow!',  msg: `${comp.name} is due TOMORROW. Submit now!`,       prio: 1 },
      '1h':  { title: '🔥 1 HOUR LEFT!',           msg: `${comp.name} deadline is in 1 hour. GO GO GO!`,   prio: 2 },
    };

    const n = NOTIFS[urgency];
    if (!n) return;

    chrome.notifications.create(`notif_${id}_${urgency}`, {
      type: 'basic', iconUrl: 'icon128.png', title: n.title, message: n.msg, priority: n.prio,
    });
  });
});

// ─── Core: fetch each competition page and extract next deadline ──────────────

async function handleResolveDeadlines(rawComps) {
  console.log(`[Competition Tracker] Resolving deadlines for ${rawComps.length} competitions…`);

  const resolved = [];

  for (const raw of rawComps) {
    try {
      const info = await fetchCompetitionInfo(raw.url);
      resolved.push({
        id:       hashUrl(raw.url),
        name:     (info.name  || raw.name).slice(0, 200),
        host:     (info.host  || '').slice(0, 100),
        round:    (info.round || null),
        deadline: info.nextDeadline || null,
        url:      raw.url,
        site:     'unstop',
      });
      console.log(`[Competition Tracker] ✓ ${raw.name} → ${info.nextDeadline || 'no deadline found'}`);
    } catch (err) {
      console.warn(`[Competition Tracker] ✗ ${raw.url}:`, err.message);
      // Keep the entry with no deadline rather than silently dropping it
      resolved.push({
        id:       hashUrl(raw.url),
        name:     raw.name,
        host:     '',
        round:    null,
        deadline: null,
        url:      raw.url,
        site:     'unstop',
      });
    }
  }

  // Merge: entries from this sync overwrite entries with the same id
  const { competitions: existing = [] } = await chrome.storage.local.get(['competitions']);
  const map = new Map(existing.map(c => [c.id, c]));
  for (const c of resolved) map.set(c.id, c);

  const merged = Array.from(map.values());
  await chrome.storage.local.set({ competitions: merged, lastSynced: Date.now() });

  console.log(`[Competition Tracker] Stored ${merged.length} competitions`);
  await refreshAlarms();
  await updateBadge();
}

// ─── Fetch + Parse a Single Competition Detail Page ───────────────────────────

async function fetchCompetitionInfo(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();

  // Strategy 1: __NEXT_DATA__ (Next.js SSR — very common on Unstop)
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const info = parseJsonTree(data);
      if (info.nextDeadline) return info;
    } catch (e) {
      console.warn('[Competition Tracker] __NEXT_DATA__ parse failed:', e.message);
    }
  }

  // Strategy 2: any inline JSON that mentions deadline-like keys
  const scriptTags = [...html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, body] of scriptTags) {
    if (!/lastDate|deadline|endDate|submissionDate/i.test(body)) continue;
    // extract the first {...} block that looks like JSON
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try {
      const data = JSON.parse(m[0]);
      const info = parseJsonTree(data);
      if (info.nextDeadline) return info;
    } catch (_) {}
  }

  // Strategy 3: raw HTML regex scan
  return parseRawHtml(html);
}

// ─── JSON Tree Parser ─────────────────────────────────────────────────────────
// Recursively walks any JSON object, collecting:
//   • values of keys that sound like deadlines
//   • values of keys that sound like names / hosts / rounds

const DEADLINE_KEYS = new Set([
  'lastdate','deadline','enddate','end_date','submissiondeadline',
  'duedate','closingdate','registrationenddate','lastregistrationdate',
  'roundenddate','stageenddate','submissiondate','registrationlastdate',
]);

const NAME_KEYS = new Set([
  'title','name','opportunitytitle','hackathontitle','competitionname',
  'eventtitle','heading',
]);

const HOST_KEYS = new Set([
  'organizationname','collegename','college','organization','host',
  'organisationname','institutename','companyname','organizer',
]);

const ROUND_KEYS = new Set([
  'roundname','stagename','currentstage','currentround','phasename',
  'activestage','activeround',
]);

function parseJsonTree(root) {
  const now   = new Date();
  const dates  = [];  // { date, key }
  const names  = [];
  const hosts  = [];
  const rounds = [];

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }

    for (const [k, v] of Object.entries(node)) {
      const kl = k.toLowerCase().replace(/[_\s-]/g, '');

      if (DEADLINE_KEYS.has(kl) && v) {
        const d = new Date(v);
        if (!isNaN(d)) dates.push({ date: d, key: k });
      }

      if (NAME_KEYS.has(kl)  && typeof v === 'string' && v.length > 2)  names.push(v);
      if (HOST_KEYS.has(kl)  && typeof v === 'string' && v.length > 1)  hosts.push(v);
      if (ROUND_KEYS.has(kl) && typeof v === 'string' && v.length > 1)  rounds.push(v);

      walk(v);
    }
  }

  walk(root);

  // Pick the soonest FUTURE deadline
  const future = dates.filter(d => d.date > now).sort((a, b) => a.date - b.date);

  return {
    nextDeadline: future.length ? future[0].date.toISOString() : null,
    name:  names[0]  || '',
    host:  hosts[0]  || '',
    round: rounds[0] || null,
  };
}

// ─── Raw HTML Regex Fallback ──────────────────────────────────────────────────

function parseRawHtml(html) {
  const now    = new Date();
  const found  = [];

  // Match ISO date strings near deadline-flavoured keys in any JSON-like text
  const pattern = /"(?:lastDate|deadline|endDate|end_date|submissionDate|closingDate|dueDate|registrationLastDate|roundEndDate)"\s*:\s*"([^"]{8,30})"/gi;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const d = new Date(m[1]);
    if (!isNaN(d) && d > now) found.push(d);
  }

  found.sort((a, b) => a - b);
  return { nextDeadline: found[0] ? found[0].toISOString() : null, name: '', host: '', round: null };
}

// ─── Alarm Management ─────────────────────────────────────────────────────────

async function refreshAlarms() {
  const { competitions = [] } = await chrome.storage.local.get(['competitions']);
  const now = Date.now();

  // Clear old competition alarms
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing.filter(a => a.name.startsWith(ALARM_PREFIX)).map(a => chrome.alarms.clear(a.name))
  );

  let created = 0;
  for (const comp of competitions) {
    if (!comp.deadline) continue;
    const deadlineMs = new Date(comp.deadline).getTime();
    if (isNaN(deadlineMs) || deadlineMs <= now) continue;

    for (const [label, offset] of [['48h', 48*3600000], ['24h', 24*3600000], ['1h', 3600000]]) {
      const at = deadlineMs - offset;
      if (at > now) {
        await chrome.alarms.create(`${ALARM_PREFIX}${comp.id}_${label}`, { when: at });
        created++;
      }
    }
  }

  console.log(`[Competition Tracker] ${created} alarms set for ${competitions.length} competitions`);
}

// ─── Badge ────────────────────────────────────────────────────────────────────
// Always shows total active competitions count.
// Colour:
//   🔴 red    — at least one deadline within 48 h
//   🟠 orange — at least one within 72 h
//   🟣 purple — all deadlines > 72 h away
//   (no badge) — no tracked competitions

async function updateBadge() {
  const { competitions = [] } = await chrome.storage.local.get(['competitions']);
  const now = Date.now();

  const active = competitions.filter(c => {
    if (!c.deadline) return false;
    return new Date(c.deadline).getTime() > now;
  });

  const total = active.length;

  if (total === 0) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  // Determine urgency colour from the most urgent competition
  const minLeft = Math.min(...active.map(c => new Date(c.deadline).getTime() - now));
  let colour;
  if      (minLeft <= 48 * 3600_000) colour = '#ff3b3b'; // red   — due within 48 h
  else if (minLeft <= 72 * 3600_000) colour = '#ff8c00'; // orange — due within 72 h
  else                                colour = '#764ba2'; // purple — all fine

  await chrome.action.setBadgeText({ text: String(total) });
  await chrome.action.setBadgeBackgroundColor({ color: colour });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function hashUrl(url) {
  // Stable ID from the URL path (strips query params for stability)
  const clean = url.split('?')[0];
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = Math.imul(31, h) + clean.charCodeAt(i) | 0;
  return Math.abs(h).toString(36);
}
