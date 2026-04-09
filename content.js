/**
 * content.js — Competition Tracker
 *
 * Two modes:
 *
 * 1. REGISTRATIONS page  (/user/registrations*)
 *    Scrolls to load all cards, parses innerText to find each competition's
 *    name + deadline, stores them.
 *
 * 2. COMPETITION DETAIL page  (/quiz/*, /competitions/*, /hackathons/*, /p/*, ...)
 *    Reads the current round deadline ("X Hours Left", round timeline, etc.)
 *    and upserts it for the matching competition in storage.
 */

'use strict';

(async function () {
  const path = window.location.pathname;

  const IS_REGISTRATIONS = /\/user\/registrations/i.test(path);
  const IS_DETAIL_PAGE   = /\/(quiz|competitions|hackathons|p|challenges?|internships?|jobs|scholarships|workshops)\//i.test(path);

  if (!IS_REGISTRATIONS && !IS_DETAIL_PAGE) return;

  console.log('[Competition Tracker] Running on', path);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Shared utilities ──────────────────────────────────────────────────────────

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    return Math.abs(h).toString(36);
  }

  function parseDeadline(raw) {
    if (!raw) return null;
    const t = raw.trim();

    // For date-only strings (no time component), default to end of day so that
    // deadlines falling on today aren't incorrectly treated as expired due to
    // UTC midnight being in the past for IST (+5:30) and other ahead-of-UTC zones.
    function endOfDay(d) { d.setHours(23, 59, 59, 0); return d; }

    const dmy = t.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+(\d{4})/i);
    if (dmy) { const d = new Date(`${dmy[2]} ${dmy[1]}, ${dmy[3]}`); if (!isNaN(d)) return endOfDay(d); }

    const mdy = t.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i);
    if (mdy) { const d = new Date(`${mdy[1]} ${mdy[2]}, ${mdy[3]}`); if (!isNaN(d)) return endOfDay(d); }

    const iso = t.match(/\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?/);
    if (iso) {
      const d = new Date(iso[0]);
      if (!isNaN(d)) return iso[1] ? d : endOfDay(d); // only end-of-day if no time part
    }

    const dl = t.match(/(\d+)\s*days?\s*left/i);
    if (dl) { const d = new Date(); d.setDate(d.getDate() + +dl[1]); return d; }

    const hl = t.match(/(\d+)\s*hours?\s*left/i);
    if (hl) { const d = new Date(); d.setHours(d.getHours() + +hl[1]); return d; }

    const ml = t.match(/(\d+)\s*min(?:utes?)?\s*left/i);
    if (ml) { const d = new Date(); d.setMinutes(d.getMinutes() + +ml[1]); return d; }

    const fb = new Date(t);
    return isNaN(fb) ? null : fb;
  }

  function isJunk(t) {
    if (!t || t.length < 3 || t.length > 250) return true;
    if (/@/.test(t))   return true;
    if (/^(registered|deadline|by[:\s]|you\s*\(|email|notification|completed|pending|ongoing|registration\s*form|sort\s*by|search|my\s*applic|all\b|competitions\b|quizzes\b|hackathons\b|scholarships\b|internships\b|jobs\b|workshops\b|for\s+business|talent|mentor|recruiter)/i.test(t)) return true;
    if (/^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
    if (/^\d+$/.test(t)) return true;
    return false;
  }

  function persist(competitions) {
    chrome.storage.local.get(['competitions'], result => {
      const existing = result.competitions || [];
      const map = new Map(existing.map(c => [c.id, c]));
      for (const c of competitions) map.set(c.id, c);
      const merged = Array.from(map.values());
      chrome.storage.local.set({ competitions: merged, lastSynced: Date.now() }, () => {
        console.log(`[Competition Tracker] Stored ${merged.length} total`);
        chrome.runtime.sendMessage({ action: 'scraped', count: competitions.length });
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE 1 — REGISTRATIONS PAGE
  // ════════════════════════════════════════════════════════════════════════════

  if (IS_REGISTRATIONS) {
    await sleep(3000);
    console.log('[Competition Tracker] Scrolling to load all cards…');

    let prevH = 0, stable = 0;
    for (let i = 0; i < 40; i++) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await sleep(700);
      const h = document.body.scrollHeight;
      if (h === prevH) { if (++stable >= 3) break; } else { stable = 0; prevH = h; }
    }
    window.scrollTo({ top: 0 });
    await sleep(600);

    const lines = (document.body.innerText || '')
      .split('\n').map(l => l.trim()).filter(Boolean);

    console.log('[Competition Tracker] Visible lines:', lines.length);

    // Debug: log every line mentioning "Registered on" or "Deadline"
    lines.forEach((l, i) => {
      if (/registered\s+on|deadline/i.test(l))
        console.log(`  [line ${i}] ${l}`);
    });

    const competitions = [];
    const seenNames   = new Set();

    for (let i = 0; i < lines.length; i++) {
      if (!/^registered\s+on\s*:/i.test(lines[i])) continue;

      // ── Name: collect all non-junk lines above, pick the LONGEST ──
      // (competition titles are long; team names like "Nexus" are short)
      const candidates = [];
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (!isJunk(lines[j])) candidates.push(lines[j]);
      }
      const name = candidates.sort((a, b) => b.length - a.length)[0] || '';

      if (!name || seenNames.has(name)) continue;

      // ── Deadline: next "Deadline:" line before the next card ──
      let deadline = null;
      for (let k = i + 1; k < Math.min(lines.length, i + 30); k++) {
        if (k > i + 2 && /^registered\s+on\s*:/i.test(lines[k])) break;
        const m = lines[k].match(/^deadline\s*:\s*(.+)/i);
        if (m) { deadline = parseDeadline(m[1].trim()); break; }
      }

      // Skip if already expired
      if (deadline && deadline < new Date()) { seenNames.add(name); continue; }

      seenNames.add(name);

      // ── URL: find a link whose href matches known competition path patterns ──
      let url = window.location.href;
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        if (!/\/(quiz|competitions|hackathons|p|challenges?|internships?|jobs|scholarships|workshops)\//.test(href)) continue;
        const linkText = a.textContent.trim().toLowerCase();
        const nameWords = name.toLowerCase().split(/\s+/).slice(0, 3).join(' ');
        if (linkText.includes(nameWords) || href.toLowerCase().includes(nameWords.replace(/\s+/g, '-'))) {
          url = href.startsWith('http') ? href : `https://unstop.com${href}`;
          break;
        }
      }

      const id = hashString(name);

      competitions.push({
        id,
        name:     name.slice(0, 200),
        host:     '',
        deadline: deadline ? deadline.toISOString() : null,
        url,
        round:    null,
        site:     'unstop',
      });

      console.log(`[Competition Tracker] ✓ "${name}" | ${deadline ? deadline.toDateString() : 'no deadline'}`);
    }

    console.log(`[Competition Tracker] Found ${competitions.length} competitions`);
    persist(competitions);
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MODE 2 — COMPETITION DETAIL PAGE
  // Detects the competition name + current round deadline, then upserts it
  // into storage (merges with existing entry if already tracked, or creates
  // a new entry so visiting the page is enough to start tracking it).
  // ════════════════════════════════════════════════════════════════════════════

  if (IS_DETAIL_PAGE) {
    await sleep(4000);  // extra time for Next.js hydration + countdown rendering

    const pageText = document.body.innerText || '';
    const lines    = pageText.split('\n').map(l => l.trim()).filter(Boolean);
    const url      = window.location.href;

    // ── Name extraction (priority order) ─────────────────────────────────────
    // "supervisor_account" and similar junk appear in h1 because Unstop puts
    // a user-role h1 in the nav. We skip anything that looks like a code token.

    function looksLikeJunkName(t) {
      if (!t || t.length < 3 || t.length > 200) return true;
      if (/^[a-z_]+$/.test(t))          return true; // snake_case = UI role token
      if (/@/.test(t))                   return true; // email
      if (/^\d+$/.test(t))               return true; // pure number
      return false;
    }

    let name = '';

    // Strip only trailing site-suffix separators: " | Unstop", " | ..." or " – ..."
    // Do NOT strip bare hyphens — they appear inside competition names like "UX-Wars".
    function stripSiteSuffix(t) {
      return t
        .replace(/\s*\|.*$/, '')          // strip " | anything" (pipe separator)
        .replace(/\s*[–—].*$/, '')         // strip " – anything" (em/en-dash)
        .replace(/\s*-\s*(unstop|iim|iit|nit|bits|vit|srm|manipal|lpu|amity)\b.*/i, '') // strip "- IIM Rohtak" style suffixes
        .trim();
    }

    // 1. og:title meta tag (most reliable — set by the server for each page)
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const t = stripSiteSuffix(ogTitle.getAttribute('content') || '');
      if (!looksLikeJunkName(t)) name = t;
    }

    // 2. document.title
    if (!name) {
      const t = stripSiteSuffix(document.title);
      if (!looksLikeJunkName(t)) name = t;
    }

    // 3. All h1/h2/h3 — pick the longest that isn't junk
    if (!name) {
      const headings = [...document.querySelectorAll('h1,h2,h3')];
      const candidates = headings
        .map(h => h.textContent.trim())
        .filter(t => !looksLikeJunkName(t))
        .sort((a, b) => b.length - a.length);
      if (candidates[0]) name = candidates[0];
    }

    // 4. URL slug fallback: /competitions/nexus-iit-kanpur-1666628 → "Nexus Iit Kanpur"
    if (!name) {
      const slug = path.split('/').pop()           // "nexus-iit-kanpur-1666628"
        .replace(/-?\d{5,}$/, '')                  // strip trailing numeric ID
        .replace(/-/g, ' ').trim();
      name = slug.replace(/\b\w/g, c => c.toUpperCase()); // Title Case
    }

    if (!name || name.length < 3) {
      console.log('[Competition Tracker] Detail page: could not determine name, aborting');
      return;
    }

    console.log('[Competition Tracker] Detail page name:', name);

    // ── Deadline extraction ───────────────────────────────────────────────────
    // Also handles Unstop's "10 Apr 26" (2-digit year) format.

    function parseDeadlineExtended(raw) {
      if (!raw) return null;
      const t = raw.trim();

      // "10 Apr 26, 12:01 AM IST"  — 2-digit year
      const dmy2 = t.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s,]+(\d{2})(?!\d)/i);
      if (dmy2) {
        const year = 2000 + parseInt(dmy2[3], 10);
        const d = new Date(`${dmy2[2]} ${dmy2[1]}, ${year}`);
        if (!isNaN(d)) return d;
      }

      return parseDeadline(raw); // fall back to the shared parser
    }

    let deadline = null;
    const now = new Date();

    // 1. "X Hours Left" / "X Days Left" banners
    // Unstop often splits the number and "Hours Left" into separate <span>s,
    // so we also scan pairs of adjacent lines joined together.
    const bannerRe = /\d+\s*(hours?|days?|min(?:utes?)?)\s*left/i;
    for (let i = 0; i < lines.length; i++) {
      // Check single line, then joined with next line (handles split spans)
      const candidates = [lines[i]];
      if (i + 1 < lines.length) candidates.push(lines[i] + ' ' + lines[i + 1]);
      if (i + 2 < lines.length) candidates.push(lines[i] + ' ' + lines[i + 1] + ' ' + lines[i + 2]);

      for (const cand of candidates) {
        if (bannerRe.test(cand)) {
          deadline = parseDeadline(cand);
          if (deadline && deadline > now) { console.log('[CT] Deadline from banner:', cand); break; }
          deadline = null;
        }
      }
      if (deadline) break;
    }

    // 2. Lines explicitly labelled as a deadline
    if (!deadline) {
      for (const line of lines) {
        const m = line.match(/(?:deadline|last\s*date|submit\s*by|closes?)\s*[:\-–]\s*(.+)/i);
        if (!m) continue;
        const d = parseDeadlineExtended(m[1]);
        if (d && d > now) { deadline = d; console.log('[CT] Deadline from label:', line); break; }
      }
    }

    // 3. Date strings near "registration" / "round" / "submission" keywords
    if (!deadline) {
      for (let i = 0; i < lines.length; i++) {
        if (!/registration|round|submission|stage|phase/i.test(lines[i])) continue;
        for (let k = i; k <= Math.min(lines.length - 1, i + 4); k++) {
          const d = parseDeadlineExtended(lines[k]);
          if (d && d > now) { deadline = d; console.log('[CT] Deadline from context:', lines[k]); break; }
        }
        if (deadline) break;
      }
    }

    if (!deadline) {
      console.log('[Competition Tracker] Detail page: no upcoming deadline found');
      return;
    }

    // ── Round info ────────────────────────────────────────────────────────────
    let round = null;
    for (const line of lines) {
      if (/round\s*\d+|submission\s*round|qualifying|semi.?final|grand\s*final/i.test(line) && line.length < 80) {
        round = line; break;
      }
    }

    // ── Numeric ID from URL (e.g. 1666628) for matching stored competitions ──
    const urlId = path.match(/(\d{5,})$/)?.[1] || '';

    // ── Upsert into storage ───────────────────────────────────────────────────
    // If we already have a competition whose URL contains this numeric ID, update it.
    // Otherwise create a new entry keyed by name hash.

    chrome.storage.local.get(['competitions'], result => {
      const existing = result.competitions || [];

      // Try to find a match by URL ID or name similarity
      let match = null;
      if (urlId) match = existing.find(c => c.url && c.url.includes(urlId));
      if (!match) {
        const nameLower = name.toLowerCase();
        match = existing.find(c => {
          const stored = (c.name || '').toLowerCase();
          return stored.includes(nameLower.slice(0, 12)) || nameLower.includes(stored.slice(0, 12));
        });
      }

      const id = match ? match.id : hashString(name);

      const comp = {
        ...(match || {}),          // keep any existing fields (host, etc.)
        id,
        name:     name.slice(0, 200),
        deadline: deadline.toISOString(),
        url,
        round:    round || (match?.round || null),
        site:     'unstop',
      };

      const map = new Map(existing.map(c => [c.id, c]));
      map.set(id, comp);
      const merged = Array.from(map.values());

      chrome.storage.local.set({ competitions: merged, lastSynced: Date.now() }, () => {
        console.log(`[Competition Tracker] Detail page stored: "${name}" → ${deadline.toDateString()}`);
        chrome.runtime.sendMessage({ action: 'scraped', count: 1 });
      });
    });
  }
})();
