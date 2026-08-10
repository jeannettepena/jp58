const CLIENT_ID = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const REDIRECT_URI = 'https://jp58.netlify.app/auth/callback';

exports.handler = async (event) => {
  const { code } = event.queryStringParameters || {};
  if (!code) return { statusCode: 400, body: 'No code' };

  // Exchange code for tokens
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await res.json();
  if (!tokens.refresh_token) {
    return {
      statusCode: 302,
      headers: { Location: `/?error=no_refresh_token` },
    };
  }

  // Redirect back to JP58 with tokens in hash (never in URL params)
  const params = new URLSearchParams({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  });

  return {
    statusCode: 302,
    headers: { Location: `/?gcal=1#${params.toString()}` },
  };
};
