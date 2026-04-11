/**
 * content.js — Competition Tracker
 *
 * Runs only on Unstop competition DETAIL pages.
 *
 * Behaviour:
 *   1. Confirms the user is registered for this competition
 *      (looks for "You've Registered" / "Registered" status text).
 *   2. Extracts the competition name, host, and ALL rounds with their
 *      start/end timestamps — preferring __NEXT_DATA__ JSON over DOM text.
 *   3. Stores everything in chrome.storage.local under the competition's
 *      numeric URL ID, so the popup can show the next round and the full
 *      timeline.
 *
 * NOTE: there is no longer a "registrations page" mode. The popup now has
 * a button that simply navigates to /user/registrations — the user opens
 * each competition they want to track manually.
 */

'use strict';

(async function () {
  const path = window.location.pathname;

  const DETAIL_RE = /\/(quiz|competitions|hackathons|p|challenges?|internships?|jobs|scholarships|workshops|conferences)\//i;
  if (!DETAIL_RE.test(path)) return;

  console.log('[Competition Tracker] Running on', path);

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(3500); // wait for Next.js hydration + countdown render

  // ── URL ID (e.g. 1661482) ──────────────────────────────────────────────────
  const urlId = (path.match(/(\d{5,})(?:\/?$|\?)/) || [])[1] || '';
  if (!urlId) {
    console.log('[Competition Tracker] No numeric URL id, aborting');
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  // 1. Try __NEXT_DATA__ first (most reliable — server-rendered JSON)
  // ════════════════════════════════════════════════════════════════════════

  let extracted = extractFromNextData();

  // ════════════════════════════════════════════════════════════════════════
  // 2. Fall back to DOM/innerText scraping
  // ════════════════════════════════════════════════════════════════════════

  if (!extracted || !extracted.name) {
    extracted = extractFromDom();
  }

  if (!extracted || !extracted.name) {
    console.log('[Competition Tracker] Could not extract competition name');
    return;
  }

  // ── Registration check ────────────────────────────────────────────────────
  const pageText = document.body.innerText || '';
  const isRegistered =
    extracted.isRegistered === true ||
    /you'?ve\s+registered|registration\s+complete|registered\s+successfully|you\s+are\s+registered/i.test(pageText);

  // Also accept it if we already track this competition (popup may revisit)
  const existingMatch = await findExistingByUrlId(urlId);

  if (!isRegistered && !existingMatch) {
    console.log('[Competition Tracker] Not registered — skipping', extracted.name);
    return;
  }

  // ── Round filter: only future or currently-open rounds ────────────────────
  const now = Date.now();
  const allRounds = (extracted.rounds || [])
    .map(r => ({
      name:  String(r.name || '').slice(0, 120),
      start: r.start ? new Date(r.start).toISOString() : null,
      end:   r.end   ? new Date(r.end).toISOString()   : null,
    }))
    .filter(r => r.end && !isNaN(new Date(r.end)))
    .sort((a, b) => new Date(a.end) - new Date(b.end));

  // Pick the next upcoming round (end > now)
  const nextRound = allRounds.find(r => new Date(r.end).getTime() > now) || null;

  if (!nextRound) {
    console.log('[Competition Tracker] No upcoming rounds for', extracted.name);
    // Still store basic info so the popup knows about it
  }

  const comp = {
    id:        urlId,
    name:      extracted.name.slice(0, 200),
    host:      (extracted.host || '').slice(0, 120),
    url:       window.location.href.split('?')[0],
    rounds:    allRounds,
    nextRound: nextRound,                    // convenience field for popup
    deadline:  nextRound ? nextRound.end : null,
    site:      'unstop',
    updatedAt: now,
  };

  // ── Persist (upsert by id) ────────────────────────────────────────────────
  chrome.storage.local.get(['competitions'], result => {
    const existing = result.competitions || [];
    const map = new Map(existing.map(c => [c.id, c]));
    map.set(comp.id, comp);
    const merged = Array.from(map.values());

    chrome.storage.local.set({ competitions: merged, lastSynced: now }, () => {
      console.log(`[Competition Tracker] ✓ Stored "${comp.name}" with ${allRounds.length} round(s)`);
      chrome.runtime.sendMessage({ action: 'scraped', count: 1 });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // ─── Helpers ────────────────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  function findExistingByUrlId(id) {
    return new Promise(resolve => {
      chrome.storage.local.get(['competitions'], r => {
        const list = r.competitions || [];
        resolve(list.find(c => c.id === id) || null);
      });
    });
  }

  // ── __NEXT_DATA__ extraction ──────────────────────────────────────────────
  // Walks the JSON tree looking for the opportunity object that matches the
  // current URL id, then pulls out title, host, and any rounds/stages array.

  function extractFromNextData() {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;

    let root;
    try { root = JSON.parse(el.textContent); }
    catch (e) { console.warn('[Competition Tracker] __NEXT_DATA__ parse failed', e); return null; }

    const targetId = parseInt(urlId, 10);
    let opportunity = null;

    // DFS for an object whose id matches the URL id and which looks like an opportunity
    (function walk(node) {
      if (opportunity || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.id === targetId && typeof node.title === 'string') {
        opportunity = node;
        return;
      }
      for (const v of Object.values(node)) walk(v);
    })(root);

    if (!opportunity) return null;

    // ── Rounds: look for any nested array of objects that have date-like keys
    const rounds = [];
    const ROUND_NAME_KEYS = ['name', 'title', 'round_name', 'roundName', 'stage_name', 'stageName', 'phase_name'];
    const START_KEYS      = ['start_dt', 'startDt', 'start_date', 'startDate', 'start_time', 'startTime', 'starts_at', 'from_date'];
    const END_KEYS        = ['end_dt',   'endDt',   'end_date',   'endDate',   'end_time',   'endTime',   'ends_at',   'to_date', 'last_date', 'lastDate', 'deadline'];

    function pick(obj, keys) {
      for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
      return null;
    }

    (function findRounds(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        // Is this an array of round-like objects?
        const looksLikeRounds = node.length > 0 && node.every(item =>
          item && typeof item === 'object' && !Array.isArray(item) &&
          (pick(item, START_KEYS) || pick(item, END_KEYS))
        );
        if (looksLikeRounds) {
          for (const item of node) {
            const end = pick(item, END_KEYS);
            if (!end) continue;
            rounds.push({
              name:  pick(item, ROUND_NAME_KEYS) || `Round ${rounds.length + 1}`,
              start: pick(item, START_KEYS),
              end,
            });
          }
        }
        node.forEach(findRounds);
      } else {
        Object.values(node).forEach(findRounds);
      }
    })(opportunity);

    // Fallback: derive a single "round" from end_date / end_regn_dt
    if (rounds.length === 0) {
      const end = opportunity.end_date || opportunity?.regnRequirements?.end_regn_dt;
      if (end) {
        rounds.push({
          name:  'Submission Deadline',
          start: opportunity?.regnRequirements?.start_regn_dt || null,
          end,
        });
      }
    }

    // Registration status — Unstop sometimes exposes a flag
    let isRegistered = null;
    const regHints = ['is_registered', 'isRegistered', 'user_registered', 'userRegistered', 'registered'];
    for (const k of regHints) {
      if (opportunity[k] === true || opportunity[k] === 1) { isRegistered = true; break; }
    }

    return {
      name:         opportunity.title || '',
      host:         opportunity?.organisation?.name || opportunity?.organization?.name || '',
      rounds,
      isRegistered,
    };
  }

  // ── DOM/innerText fallback ────────────────────────────────────────────────
  // Used when __NEXT_DATA__ is missing or doesn't contain a matching opportunity.
  // Extracts: name from og:title or h1, rounds from "Stages & Timeline" text.

  function extractFromDom() {
    // Name
    let name = '';
    const og = document.querySelector('meta[property="og:title"]');
    if (og) name = stripSiteSuffix(og.getAttribute('content') || '');
    if (!name) name = stripSiteSuffix(document.title);

    if (!name) {
      const h = [...document.querySelectorAll('h1,h2')]
        .map(e => e.textContent.trim())
        .filter(t => t && t.length >= 3 && t.length <= 200 && !/^[a-z_]+$/.test(t))
        .sort((a, b) => b.length - a.length);
      if (h[0]) name = h[0];
    }

    // Host
    let host = '';
    const hostEl = document.querySelector('a[href*="/c/"], .org-name, .organisation-name, .institute');
    if (hostEl) host = hostEl.textContent.trim().slice(0, 120);

    // Rounds — scan body text for "Round N" / "Stage N" / "Phase N" patterns
    // and extract any nearby date strings.
    const rounds = [];
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

    const ROUND_RE = /^(round\s*\d+|stage\s*\d+|phase\s*\d+|(?:semi[\s-]?)?final|grand\s*final|qualif\w*|prelim\w*|submission|registration)[:\s\-–]*(.*)$/i;
    const DATE_RE  = /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+\d{2,4}(?:[,\s]+\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s*IST)?)?)/i;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ROUND_RE);
      if (!m) continue;
      const roundName = (m[0].length < 80 ? m[0] : m[1]).trim();

      // Look forward up to 6 lines for a date
      let end = null;
      for (let k = i; k <= Math.min(lines.length - 1, i + 6); k++) {
        const dm = lines[k].match(DATE_RE);
        if (dm) { end = parseLooseDate(dm[1]); if (end) break; }
      }
      if (end) rounds.push({ name: roundName, start: null, end: end.toISOString() });
    }

    // If we found nothing, look for any "X Hours Left" / "X Days Left" banner
    if (rounds.length === 0) {
      for (const line of lines) {
        const lm = line.match(/(\d+)\s*(hours?|days?|min(?:utes?)?)\s*left/i);
        if (lm) {
          const d = new Date();
          const n = parseInt(lm[1], 10);
          if (/hour/i.test(lm[2]))      d.setHours(d.getHours() + n);
          else if (/day/i.test(lm[2]))  d.setDate(d.getDate() + n);
          else                          d.setMinutes(d.getMinutes() + n);
          rounds.push({ name: 'Current Round', start: null, end: d.toISOString() });
          break;
        }
      }
    }

    return { name, host, rounds, isRegistered: null };
  }

  function stripSiteSuffix(t) {
    return (t || '')
      .replace(/\s*\|.*$/, '')
      .replace(/\s*[–—].*$/, '')
      .trim();
  }

  function parseLooseDate(raw) {
    if (!raw) return null;
    const t = raw.trim();

    // "10 Apr 2026, 11:30 PM IST" or "10 Apr 26"
    const m = t.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
    if (m) {
      const day   = parseInt(m[1], 10);
      const mon   = m[2];
      let year    = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      let hour    = m[4] ? parseInt(m[4], 10) : 23;
      const min   = m[5] ? parseInt(m[5], 10) : 59;
      const ampm  = m[6];
      if (ampm) {
        if (/pm/i.test(ampm) && hour < 12) hour += 12;
        if (/am/i.test(ampm) && hour === 12) hour = 0;
      }
      const d = new Date(`${mon} ${day}, ${year} ${hour}:${min}:00`);
      return isNaN(d) ? null : d;
    }

    const fb = new Date(t);
    return isNaN(fb) ? null : fb;
  }
})();
