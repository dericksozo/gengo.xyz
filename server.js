const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const YT_TRANSCRIPT_AUTH = 'Basic 68e5cdd226d92e0a63f6b424';

function send(res, status, body, headers = {}) {
  const defaultHeaders = { 'content-type': 'text/plain; charset=utf-8' };
  res.writeHead(status, { ...defaultHeaders, ...headers });
  res.end(body);
}

function handleOptions(req, res) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end();
}

async function handleTranscriptProxy(req, res) {
  if (req.method === 'OPTIONS') return handleOptions(req, res);
  if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    const ids = Array.isArray(body?.ids) ? body.ids : body?.id ? [String(body.id)] : [];
    if (!ids.length) {
      return send(
        res,
        400,
        JSON.stringify({ error: "Missing 'id' or 'ids'" }),
        { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
      );
    }

    const upstream = await fetch('https://www.youtube-transcript.io/api/transcripts', {
      method: 'POST',
      headers: {
        authorization: YT_TRANSCRIPT_AUTH,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ids }),
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'access-control-allow-origin': '*',
    });
    res.end(text);
  } catch (err) {
    return send(
      res,
      502,
      JSON.stringify({ error: 'Upstream request failed' }),
      { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const filePath = path.resolve(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 500, 'index.html not found');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (pathname === '/api/transcript') {
    return handleTranscriptProxy(req, res);
  }

  send(res, 404, 'Not Found');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server running on http://localhost:${PORT}`);
});


