const CLIENT_ID = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  return res.json();
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': 'https://jp58.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { refresh_token, access_token, timeMin, timeMax, calendarId } = event.queryStringParameters || {};

  let token = access_token;

  // If no access token or expired, refresh
  if (!token && refresh_token) {
    const refreshed = await refreshAccessToken(refresh_token);
    token = refreshed.access_token;
    if (!token) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_failed' }) };
    }
  }

  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'no_token' }) };
  }

  // Fetch calendar events
  const cal = calendarId || 'primary';
  const tMin = timeMin || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const tMax = timeMax || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events?timeMin=${tMin}&timeMax=${tMax}&singleEvents=true&orderBy=startTime&maxResults=50`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    return { statusCode: res.status, headers, body: JSON.stringify({ error: 'calendar_fetch_failed', status: res.status }) };
  }

  const data = await res.json();
  return { statusCode: 200, headers, body: JSON.stringify(data) };
};
