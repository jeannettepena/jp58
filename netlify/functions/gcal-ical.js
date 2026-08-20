// Reads Google Calendar iCal feeds and returns upcoming events as JSON.
//
// The previous version only ever returned one-off events: it read DTSTART and
// ignored RRULE entirely, so every recurring entry (weekly prospecting blocks,
// the accountability group, standing coffees) was represented only by its
// original DTSTART — usually months in the past — and then dropped by the
// "next 30 days" filter. This version expands recurrence rules, honours
// EXDATE cancellations and RECURRENCE-ID overrides, and unescapes iCal text.

const ICAL_URLS = [
  { url:'https://calendar.google.com/calendar/ical/jcantu.realtor%40gmail.com/private-f865956c4df8ffb0289c1acd75a13668/basic.ics', name:'Me Time' },
  { url:'https://calendar.google.com/calendar/ical/50m18sp2p36a9526b7btjaui0s%40group.calendar.google.com/private-80e59f455c7b016fb03f0c273da1082f/basic.ics', name:'58 Group' },
  { url:'https://calendar.google.com/calendar/ical/1a0dc40bcd1923094e1df9e636f270e0f5aadebb98deddde19859e93681da557%40group.calendar.google.com/private-02f1786a9ef4bd4bb0b05d2e75e18bf1/basic.ics', name:"Jeannette's Travel" },
  { url:'https://calendar.google.com/calendar/ical/cf2aa5bc1d2ddcaded7192e315ea99532f16ff00c52a076b4b9c3478c308c52f%40group.calendar.google.com/private-30a9c2af4669cfd9b7c2d9ffa3994d8c/basic.ics', name:'Real Estate' },
  { url:'https://calendar.google.com/calendar/ical/55dbffe828b72daee60d64c1c701d335e2dceaf3c1d5bb352d84a817f20e492b%40group.calendar.google.com/private-d1c981014f6f09049804a8243e5d6680/basic.ics', name:'Family' },
  { url:'https://calendar.google.com/calendar/ical/1k58e0tkmdh03qbdij4dtsqtl0%40group.calendar.google.com/private-e5c9d7d761b47f9295d467ecabea0719/basic.ics', name:'Fifty Eight Degrees' },
  { url:'https://calendar.google.com/calendar/ical/1b4ae7aaa5385e1168d0ec8bbe1e9aaf4971a96f09558980e308d842c7651edf%40group.calendar.google.com/private-0fab0e6861d90c0f109cfb808f840e49/basic.ics', name:'RenaSer' },
];

// Warm-instance cache. Every page load previously triggered seven fresh
// round-trips to Google; on a cold start that could push past Netlify's
// 10s function limit and surface in the browser as "Failed to fetch".
let CACHE = { at: 0, body: null };
const CACHE_MS = 5 * 60 * 1000;

exports.handler = async () => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  if (CACHE.body && Date.now() - CACHE.at < CACHE_MS) {
    return { statusCode: 200, headers, body: CACHE.body };
  }

  try {
    // Per-calendar timeout kept well under Netlify's 10s ceiling, so a single
    // unreachable feed is skipped rather than taking the whole response down.
    const results = await Promise.allSettled(ICAL_URLS.map(async (cal) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(cal.url, { signal: controller.signal });
        if (!res.ok) return [];
        const text = await res.text();
        const events = parseICal(text);
        events.forEach(e => { e.calendar = cal.name; });
        return events;
      } catch (err) {
        return [];
      } finally {
        clearTimeout(timer);
      }
    }));

    const raw = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);

    // Window: from the start of today (so events earlier today still show)
    // through 30 days out. The old filter used `>= now`, which quietly hid
    // everything that had already happened today.
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);

    const expanded = expandAll(raw, from, to);
    expanded.sort((a, b) => String(a.start).localeCompare(String(b.start)));

    const body = JSON.stringify(expanded);
    CACHE = { at: Date.now(), body };
    return { statusCode: 200, headers, body };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

/* -- parsing ------------------------------------------------ */

function unescapeICal(v) {
  if (!v) return v;
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .replace(/&amp;/g, '&')
    .trim();
}

// Split "DTSTART;TZID=America/Chicago:20260820T093000" into its parts.
function splitLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = left.indexOf(';');
  const name = semi < 0 ? left : left.slice(0, semi);
  const params = {};
  if (semi >= 0) {
    left.slice(semi + 1).split(';').forEach(p => {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    });
  }
  return { name: name.toUpperCase(), params, value };
}

// Returns { date:'YYYY-MM-DD', time:'HH:MM:SS'|null, utc:bool }.
// The old code decided all-day via line.includes('T'), which was always true —
// "DTSTART" and "VALUE=DATE" both contain a T — so every all-day event came
// back with allDay:false.
function parseDT(part) {
  if (!part) return null;
  const v = String(part.value).trim();
  const params = part.params || {};
  const isDate = params.VALUE === 'DATE' || /^\d{8}$/.test(v);
  if (isDate) {
    return { date: v.slice(0,4) + '-' + v.slice(4,6) + '-' + v.slice(6,8), time: null, utc: false };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  return {
    date: m[1] + '-' + m[2] + '-' + m[3],
    time: m[4] + ':' + m[5] + ':' + m[6],
    utc: m[7] === 'Z',
  };
}

function parseICal(text) {
  // Unfold RFC 5545 continuation lines before splitting.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.dtstart && cur.title) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;

    const p = splitLine(line);
    if (!p) continue;

    switch (p.name) {
      case 'SUMMARY':       cur.title = unescapeICal(p.value); break;
      case 'LOCATION':      cur.location = unescapeICal(p.value); break;
      case 'DESCRIPTION':   cur.description = unescapeICal(p.value); break;
      case 'UID':           cur.uid = p.value.trim(); break;
      case 'STATUS':        cur.status = p.value.trim().toUpperCase(); break;
      case 'DTSTART':       cur.dtstart = parseDT(p); break;
      case 'DTEND':         cur.dtend = parseDT(p); break;
      case 'RRULE':         cur.rrule = parseRRule(p.value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDT(p); break;
      case 'EXDATE':
        p.value.split(',').forEach(v => {
          const d = parseDT({ value: v, params: p.params });
          if (d) cur.exdates.push(d.date);
        });
        break;
      default: break;
    }
  }
  return events;
}

function parseRRule(v) {
  const r = {};
  String(v).split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    r[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  if (!r.FREQ) return null;
  let until = null;
  if (r.UNTIL && /^\d{8}/.test(r.UNTIL)) {
    until = r.UNTIL.slice(0,4) + '-' + r.UNTIL.slice(4,6) + '-' + r.UNTIL.slice(6,8);
  }
  return {
    freq: r.FREQ.toUpperCase(),
    interval: parseInt(r.INTERVAL || '1', 10) || 1,
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: until,
    byday: r.BYDAY ? r.BYDAY.split(',').map(d => d.trim().toUpperCase()) : null,
  };
}

/* -- recurrence expansion ----------------------------------- */

const DAYS = ['SU','MO','TU','WE','TH','FR','SA'];

// Date maths runs on UTC-noon anchors so daylight-saving shifts can never
// nudge an occurrence onto the wrong calendar day.
function toAnchor(dateStr) {
  const parts = String(dateStr).split('-');
  return Date.UTC(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0);
}
function fromAnchor(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function expandAll(raw, from, to) {
  const fromStr = fromAnchor(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate(), 12));
  const toStr = fromAnchor(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate(), 12));

  // Modified single occurrences of a recurring series arrive as separate
  // VEVENTs carrying RECURRENCE-ID; index them so they replace the generated
  // occurrence instead of appearing twice.
  const overrides = new Map();
  raw.forEach(e => {
    if (e.recurrenceId && e.uid) overrides.set(e.uid + '|' + e.recurrenceId.date, e);
  });
  const usedOverrides = new Set();

  const out = [];
  const push = (ev, dateStr) => {
    if (ev.status === 'CANCELLED') return;
    if (dateStr < fromStr || dateStr > toStr) return;
    const start = ev.dtstart.time
      ? dateStr + 'T' + ev.dtstart.time + (ev.dtstart.utc ? 'Z' : '')
      : dateStr;
    let end = null;
    if (ev.dtend) {
      // Preserve the original duration in whole days for multi-day entries.
      const spanDays = Math.round((toAnchor(ev.dtend.date) - toAnchor(ev.dtstart.date)) / 86400000);
      const endDate = fromAnchor(toAnchor(dateStr) + spanDays * 86400000);
      end = ev.dtend.time ? endDate + 'T' + ev.dtend.time + (ev.dtend.utc ? 'Z' : '') : endDate;
    }
    out.push({
      start: start,
      end: end,
      allDay: !ev.dtstart.time,
      title: ev.title,
      location: ev.location,
      description: ev.description,
      calendar: ev.calendar,
    });
  };

  raw.forEach(ev => {
    if (ev.recurrenceId) return; // emitted via the override pass
    if (!ev.rrule) { push(ev, ev.dtstart.date); return; }

    const rule = ev.rrule;
    const startAnchor = toAnchor(ev.dtstart.date);
    const limitAnchor = toAnchor(toStr);
    const untilAnchor = rule.until ? toAnchor(rule.until) : null;
    const exset = new Set(ev.exdates || []);
    const MAX = 3000; // safety valve against malformed infinite rules

    const emit = (ds) => {
      if (exset.has(ds)) return;
      const key = ev.uid ? ev.uid + '|' + ds : null;
      const ov = key ? overrides.get(key) : null;
      if (ov) { usedOverrides.add(key); push(ov, ov.dtstart.date); return; }
      push(ev, ds);
    };

    let emitted = 0, guard = 0;

    if (rule.freq === 'WEEKLY' && rule.byday && rule.byday.length) {
      const startDow = new Date(startAnchor).getUTCDay();
      const weekStart = startAnchor - startDow * 86400000;
      for (let w = 0; guard++ < MAX; w++) {
        const base = weekStart + w * rule.interval * 7 * 86400000;
        if (base > limitAnchor + 7 * 86400000) break;
        let stop = false;
        for (const code of rule.byday) {
          const idx = DAYS.indexOf(code.replace(/^[+-]?\d+/, ''));
          if (idx < 0) continue;
          const occ = base + idx * 86400000;
          if (occ < startAnchor) continue;
          if (untilAnchor && occ > untilAnchor) continue;
          if (rule.count && emitted >= rule.count) { stop = true; break; }
          emitted++;
          emit(fromAnchor(occ));
        }
        if (stop) break;
      }
    } else {
      let occ = startAnchor;
      while (guard++ < MAX) {
        if (occ > limitAnchor) break;
        if (untilAnchor && occ > untilAnchor) break;
        if (rule.count && emitted >= rule.count) break;
        emitted++;
        emit(fromAnchor(occ));
        const d = new Date(occ);
        if (rule.freq === 'DAILY') occ += rule.interval * 86400000;
        else if (rule.freq === 'WEEKLY') occ += rule.interval * 7 * 86400000;
        else if (rule.freq === 'MONTHLY') occ = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + rule.interval, d.getUTCDate(), 12);
        else if (rule.freq === 'YEARLY') occ = Date.UTC(d.getUTCFullYear() + rule.interval, d.getUTCMonth(), d.getUTCDate(), 12);
        else break;
      }
    }
  });

  // An override moved to a date its parent series never generates still
  // deserves to appear.
  overrides.forEach((ov, key) => {
    if (usedOverrides.has(key)) return;
    push(ov, ov.dtstart.date);
  });

  return out;
}
