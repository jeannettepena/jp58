// Reads Google Calendar iCal and returns upcoming events as JSON
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const ICAL_URLS = [
    { url:'https://calendar.google.com/calendar/ical/50m18sp2p36a9526b7btjaui0s%40group.calendar.google.com/private-80e59f455c7b016fb03f0c273da1082f/basic.ics', name:'58 Group' },
    { url:'https://calendar.google.com/calendar/ical/1a0dc40bcd1923094e1df9e636f270e0f5aadebb98deddde19859e93681da557%40group.calendar.google.com/private-02f1786a9ef4bd4bb0b05d2e75e18bf1/basic.ics', name:"Jeannette's Travel" },
    // Pending: Me Time, Real Estate, Family, Fifty Eight Degrees, RenaSer
  ];

  try {
    const allEvents = [];

    for (const cal of ICAL_URLS) {
      const res = await fetch(cal.url);
      if (!res.ok) continue;
      const text = await res.text();
      const events = parseICal(text);
      events.forEach(e => e.calendar = cal.name);
      allEvents.push(...events);
    }

    // Sort by start date
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    // Filter to next 30 days
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const filtered = allEvents.filter(e => {
      const d = new Date(e.start);
      return d >= now && d <= future;
    });

    return { statusCode: 200, headers, body: JSON.stringify(filtered) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n /g, '').replace(/\r\n\t/g, '').split(/\r\n|\n/);

  let current = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
    } else if (line === 'END:VEVENT' && current) {
      if (current.start && current.title) events.push(current);
      current = null;
    } else if (current) {
      if (line.startsWith('SUMMARY:')) {
        current.title = line.replace('SUMMARY:', '').trim();
      } else if (line.startsWith('DTSTART')) {
        current.start = parseICalDate(line.split(':')[1]);
        current.allDay = !line.includes('T');
      } else if (line.startsWith('DTEND')) {
        current.end = parseICalDate(line.split(':')[1]);
      } else if (line.startsWith('LOCATION:')) {
        current.location = line.replace('LOCATION:', '').trim();
      } else if (line.startsWith('DESCRIPTION:')) {
        current.description = line.replace('DESCRIPTION:', '').trim();
      }
    }
  }
  return events;
}

function parseICalDate(str) {
  if (!str) return null;
  str = str.trim();
  // All day: 20260810
  if (str.length === 8) {
    return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
  }
  // DateTime: 20260810T150000Z or 20260810T150000
  const y = str.slice(0,4), mo = str.slice(4,6), d = str.slice(6,8);
  const h = str.slice(9,11), mi = str.slice(11,13), s = str.slice(13,15);
  const utc = str.endsWith('Z') ? 'Z' : '';
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${utc}`;
}
