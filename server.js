const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const INDEX_FILE = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Method Not Allowed\n');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (url.pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
    return;
  }

  try {
    const html = await fs.readFile(INDEX_FILE);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(html);
  } catch (error) {
    console.error('Failed to serve index.html:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
