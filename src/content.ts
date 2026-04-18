/**
 * content.js — Competition Tracker
 *
 * Runs only on Unstop competition DETAIL pages.
 *
 * Extraction order:
 *   1. Unstop REST API  (/api/public/{type}/{id})  — most reliable
 *   2. __NEXT_DATA__ JSON (Next.js SSR, may or may not be present)
 *   3. DOM / innerText fallback
 *
 * Only stores competitions where the user is registered.
 */

'use strict';

(async function () {
  const path = window.location.pathname;

  const DETAIL_RE = /\/(quiz|competitions|hackathons|p|challenges?|internships?|jobs|scholarships|workshops|conferences)\//i;
  if (!DETAIL_RE.test(path)) return;

  console.log('[Competition Tracker] Running on', path);

  // ── URL ID (e.g. 1666558) ─────────────────────────────────────────────────
  const urlId = (path.match(/(\d{5,})(?:\/?$|\?)/) || [])[1] || '';
  if (!urlId) {
    console.log('[Competition Tracker] No numeric URL id, aborting');
    return;
  }

  // ── Determine API type from URL segment ───────────────────────────────────
  const segment = path.split('/').filter(Boolean)[0].toLowerCase();
  // Always try all types — Unstop uses the same numeric ID space across types
  const apiTypes =
    /hackathon/.test(segment) ? ['hackathon', 'competition', 'quiz'] :
    /quiz/.test(segment)      ? ['quiz', 'competition', 'hackathon'] :
                                ['competition', 'hackathon', 'quiz'];

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Try Unstop REST API (cookies included automatically — same origin)
  // ═══════════════════════════════════════════════════════════════════════════
  let extracted = await fetchFromApi(urlId, apiTypes);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Fall back to __NEXT_DATA__ (present on some page types)
  // ═══════════════════════════════════════════════════════════════════════════
  if (!extracted?.name) {
    extracted = extractFromNextData();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Fall back to DOM / innerText (requires hydration — wait first)
  // ═══════════════════════════════════════════════════════════════════════════
  if (!extracted?.name) {
    await sleep(3500);
    extracted = extractFromDom();
  }

  if (!extracted?.name) {
    console.log('[Competition Tracker] Could not extract competition name');
    return;
  }

  // ── Registration check ────────────────────────────────────────────────────
  // API may tell us; fall back to page text (wait for hydration if needed)
  let isRegistered = extracted.isRegistered === true;
  if (!isRegistered) {
    // Wait for page hydration so registration status text is visible
    await sleep(3500);
    const pageText = document.body.innerText || '';
    isRegistered =
      /you'?ve\s+registered|registration\s+complete|registered\s+successfully|you\s+are\s+registered/i.test(pageText);
  }

  const existingMatch = await findExistingByUrlId(urlId);

  if (!isRegistered && !existingMatch) {
    console.log('[Competition Tracker] Not registered — skipping', extracted.name);
    return;
  }

  // ── Round processing ───────────────────────────────────────────────────────
  const now = Date.now();
  const allRounds = (extracted.rounds || [])
    .map(r => ({
      name:  String(r.name || '').slice(0, 120),
      start: r.start && !isNaN(new Date(r.start)) ? new Date(r.start).toISOString() : null,
      end:   r.end   && !isNaN(new Date(r.end))   ? new Date(r.end).toISOString()   : null,
    }))
    .filter(r => r.end)                                              // must have an end
    .filter(r => new Date(r.end).getTime() > now)                   // not yet finished
    .sort((a, b) => {                                               // sort by start asc
      const aMs = a.start ? new Date(a.start).getTime() : new Date(a.end).getTime();
      const bMs = b.start ? new Date(b.start).getTime() : new Date(b.end).getTime();
      return aMs - bMs;
    });

  // Next round = first one whose start is still in the future;
  // if all have already started, take the first (ongoing) one.
  const nextRound =
    allRounds.find(r => r.start && new Date(r.start).getTime() > now) ||
    allRounds[0] ||
    null;

  if (!nextRound) {
    console.log('[Competition Tracker] No upcoming rounds for', extracted.name);
  }

  // deadline drives the countdown — use start when available (show when it begins),
  // fall back to end for ongoing rounds that have no future start.
  const deadlineForCountdown = nextRound
    ? (nextRound.start && new Date(nextRound.start).getTime() > now
        ? nextRound.start
        : nextRound.end)
    : null;

  const comp = {
    id:        urlId,
    name:      extracted.name.slice(0, 200),
    host:      (extracted.host || '').slice(0, 120),
    url:       window.location.href.split('?')[0],
    rounds:    allRounds,
    nextRound: nextRound,
    deadline:  deadlineForCountdown,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── Helpers ───────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function findExistingByUrlId(id) {
    return new Promise(resolve => {
      chrome.storage.local.get(['competitions'], r => {
        const list = r.competitions || [];
        resolve(list.find(c => c.id === id) || null);
      });
    });
  }

  // ── API extraction ────────────────────────────────────────────────────────
  // Calls /api/public/{type}/{id} — runs in page context so user cookies
  // are sent automatically, which gives us registration status too.

  async function fetchFromApi(id, types) {
    for (const type of types) {
      try {
        const res = await fetch(`https://unstop.com/api/public/${type}/${id}`, {
          credentials: 'include',
        });
        if (!res.ok) continue;

        const json = await res.json();
        const parsed = parseApiJson(json, type);
        if (parsed?.name) {
          parsed._source = 'api';
          console.log(`[Competition Tracker] API hit: /api/public/${type}/${id}`);
          return parsed;
        }
      } catch (e) {
        console.warn(`[Competition Tracker] API fetch failed (${type}/${id}):`, e.message);
      }
    }
    return null;
  }

  function parseApiJson(json, type) {
    // Unstop API wraps in data.{type} or data.opportunity
    const comp =
      json?.data?.[type] ||
      json?.data?.opportunity ||
      json?.data?.hackathon ||
      json?.data?.competition ||
      json?.data ||
      json;

    if (!comp || typeof comp !== 'object' || Array.isArray(comp)) return null;

    const name = comp.title || comp.name || '';
    if (!name) return null;

    const host =
      comp.organisation?.name ||
      comp.organization?.name  ||
      comp.college?.name       ||
      comp.company?.name       || '';

    // ── Rounds ──────────────────────────────────────────────────────────────
    const rounds = [];
    const rawRounds = Array.isArray(comp.rounds)  ? comp.rounds  :
                      Array.isArray(comp.stages)  ? comp.stages  :
                      Array.isArray(comp.phases)  ? comp.phases  : [];

    rawRounds.forEach((r, i) => {
      // Round name: check multiple levels
      const roundName =
        r.title  || r.name  || r.round_name  || r.stage_name  ||
        r.details?.[0]?.title || r.details?.[0]?.name ||
        `Round ${i + 1}`;

      // Start / end: check top-level then details[0]
      const start =
        r.start_date || r.start_dt || r.starts_at || r.from_date ||
        r.details?.[0]?.start_date || r.details?.[0]?.start_dt || null;

      const end =
        r.end_date   || r.end_dt   || r.ends_at   || r.to_date  ||
        r.last_date  || r.deadline  ||
        r.details?.[0]?.end_date   || r.details?.[0]?.end_dt   || null;

      if (end) rounds.push({ name: String(roundName).slice(0, 120), start, end });
    });

    // If no rounds array, derive one from competition-level dates
    if (rounds.length === 0) {
      const end =
        comp.end_date ||
        comp.regnRequirements?.end_regn_dt ||
        comp.regn_requirements?.end_regn_dt;
      const start =
        comp.start_date ||
        comp.regnRequirements?.start_regn_dt ||
        comp.regn_requirements?.start_regn_dt;
      if (end) rounds.push({ name: 'Competition', start: start || null, end });
    }

    // Registration status (only reliable when user is logged in)
    let isRegistered = null;
    for (const k of ['is_registered', 'isRegistered', 'user_registered', 'registered']) {
      if (comp[k] === true || comp[k] === 1) { isRegistered = true; break; }
    }

    return { name, host, rounds, isRegistered };
  }

  // ── __NEXT_DATA__ extraction ──────────────────────────────────────────────

  function extractFromNextData() {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;

    let root;
    try { root = JSON.parse(el.textContent); }
    catch (e) { return null; }

    const targetId = parseInt(urlId, 10);
    let opportunity = null;

    (function walk(node) {
      if (opportunity || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.id === targetId && typeof node.title === 'string') {
        opportunity = node; return;
      }
      for (const v of Object.values(node)) walk(v);
    })(root);

    if (!opportunity) return null;

    const ROUND_NAME_KEYS = ['name', 'title', 'round_name', 'roundName', 'stage_name', 'stageName', 'phase_name'];
    const START_KEYS      = ['start_dt', 'startDt', 'start_date', 'startDate', 'start_time', 'startTime', 'starts_at', 'from_date'];
    const END_KEYS        = ['end_dt', 'endDt', 'end_date', 'endDate', 'end_time', 'endTime', 'ends_at', 'to_date', 'last_date', 'lastDate', 'deadline'];

    function pick(obj, keys) {
      for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
      return null;
    }

    const rounds = [];
    (function findRounds(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
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

    if (rounds.length === 0) {
      const end = opportunity.end_date || opportunity?.regnRequirements?.end_regn_dt;
      if (end) {
        rounds.push({
          name:  'Competition',
          start: opportunity?.regnRequirements?.start_regn_dt || opportunity.start_date || null,
          end,
        });
      }
    }

    let isRegistered = null;
    for (const k of ['is_registered', 'isRegistered', 'user_registered', 'registered']) {
      if (opportunity[k] === true || opportunity[k] === 1) { isRegistered = true; break; }
    }

    return {
      name:  opportunity.title || '',
      host:  opportunity?.organisation?.name || opportunity?.organization?.name || '',
      rounds,
      isRegistered,
      _source: 'next_data',
    };
  }

  // ── DOM / innerText fallback ──────────────────────────────────────────────

  function extractFromDom() {
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

    let host = '';
    const hostEl = document.querySelector('a[href*="/c/"], .org-name, .organisation-name, .institute');
    if (hostEl) host = hostEl.textContent.trim().slice(0, 120);

    // ── Primary: parse "Stages and Timelines" date-range rows ────
    const rounds = extractFromStagesSection();

    // ── Secondary: classic round-keyword + nearby date ───────────
    if (rounds.length === 0) {
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      const ROUND_RE = /^(round\s*\d+|stage\s*\d+|phase\s*\d+|(?:semi[\s-]?)?final|grand\s*final|qualif\w*|prelim\w*|submission|registration)[:\s\-–]*(.*)$/i;
      const DATE_RE  = /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+\d{2,4}(?:[,\s]+\d{1,2}:\d{2}\s*(?:AM|PM)?(?:\s*IST)?)?)/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(ROUND_RE);
        if (!m) continue;
        const roundName = (m[0].length < 80 ? m[0] : m[1]).trim();
        let end = null;
        for (let k = i; k <= Math.min(lines.length - 1, i + 6); k++) {
          const dm = lines[k].match(DATE_RE);
          if (dm) { end = parseLooseDate(dm[1]); if (end) break; }
        }
        if (end) rounds.push({ name: roundName, start: null, end: end.toISOString() });
      }
    }

    // ── Tertiary: "X hours/days left" anywhere on page ──────────
    if (rounds.length === 0) {
      const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        const lm = line.match(/(\d+)\s*(hours?|days?|min(?:utes?)?)\s*left/i);
        if (lm) {
          const d = new Date();
          const n = parseInt(lm[1], 10);
          if (/hour/i.test(lm[2]))     d.setHours(d.getHours() + n);
          else if (/day/i.test(lm[2])) d.setDate(d.getDate() + n);
          else                         d.setMinutes(d.getMinutes() + n);
          rounds.push({ name: 'Current Round', start: null, end: d.toISOString() });
          break;
        }
      }
    }

    return { name, host, rounds, isRegistered: null, _source: 'dom' };
  }

  // Parses the "Stages and Timelines" section by finding lines like:
  //   "18 Apr 26, 12:00 AM IST → 19 Apr 26, 04:00 PM IST"
  // and pairing each with the card title that follows on subsequent lines.
  function extractFromStagesSection() {
    const rounds = [];
    const lines = (document.body.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

    const DT = String.raw`\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{2,4},\s*\d{1,2}:\d{2}\s*[AP]M(?:\s+IST)?`;
    const RANGE_RE = new RegExp(`(${DT})\\s*[→–—-]+\\s*(${DT})`, 'i');
    const SKIP_RE  = /^\d{1,2}\s+\w{3}|\bstarts?\s+in\b|\bends?\s+in\b|\bon\s+unstop\b|^(started|ended|live|upcoming|closed)$/i;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(RANGE_RE);
      if (!m) continue;

      const start = parseLooseDate(m[1]);
      const end   = parseLooseDate(m[2]);
      if (!end) continue;

      // Scan forward for a round title — skip noise lines
      let roundName = '';
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 6); j++) {
        const line = lines[j];
        if (SKIP_RE.test(line) || line.length < 4 || RANGE_RE.test(line)) break;
        roundName = line.slice(0, 120);
        break;
      }

      rounds.push({
        name:  roundName || `Round ${rounds.length + 1}`,
        start: start ? start.toISOString() : null,
        end:   end.toISOString(),
      });
    }

    console.log(`[Competition Tracker] DOM stages found: ${rounds.length}`);
    return rounds;
  }

  function stripSiteSuffix(t) {
    return (t || '').replace(/\s*\|.*$/, '').replace(/\s*[–—].*$/, '').trim();
  }

  function parseLooseDate(raw) {
    if (!raw) return null;
    const t = raw.trim();
    const m = t.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+(\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
    if (m) {
      const day  = parseInt(m[1], 10);
      const mon  = m[2];
      let year   = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      let hour   = m[4] ? parseInt(m[4], 10) : 23;
      const min  = m[5] ? parseInt(m[5], 10) : 59;
      const ampm = m[6];
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
