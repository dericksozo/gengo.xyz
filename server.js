const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('Method Not Allowed\n');
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  // Map URL → file
  let fileName;
  if (url.pathname === '/') {
    fileName = 'index.html';
  } else {
    // remove leading "/" and append ".html"
    fileName = url.pathname.slice(1) + '.html';
  }

  const filePath = path.join(__dirname, fileName);

  try {
    const html = await fs.readFile(filePath);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': html.length,
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') return res.end();
    res.end(html);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found\n');
    }

    console.error('Server error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});