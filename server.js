const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { performFullScan } = require('./lib/scanner');
const snapshotEngine = require('./lib/snapshotEngine');
const restoreEngine = require('./lib/restoreEngine');

const PORT = process.env.PORT || 4242;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Global SSE clients
let sseClients = [];

function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (e) {}
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE Stream Endpoint
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    sseClients.push(res);

    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // API Endpoints
  if (pathname === '/api/scan' && req.method === 'GET') {
    try {
      const scanData = await performFullScan();
      return sendJson(res, 200, scanData);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/snapshot/status' && req.method === 'GET') {
    return sendJson(res, 200, snapshotEngine.getStatus());
  }

  if (pathname === '/api/snapshot/start' && req.method === 'POST') {
    try {
      const options = await parseBody(req);
      if (snapshotEngine.isBusy()) {
        return sendJson(res, 400, { error: 'Snapshot already in progress' });
      }

      // Run asynchronously and stream progress via SSE
      snapshotEngine.createSnapshot(options, (progress) => {
        broadcastSSE({ type: 'snapshot_progress', data: progress });
      }).then(result => {
        broadcastSSE({ type: 'snapshot_done', data: result });
      }).catch(err => {
        broadcastSSE({ type: 'snapshot_error', error: err.message });
      });

      return sendJson(res, 200, { status: 'started' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/snapshot/cancel' && req.method === 'POST') {
    const cancelled = snapshotEngine.cancel();
    return sendJson(res, 200, { cancelled });
  }

  if (pathname === '/api/snapshots' && req.method === 'GET') {
    try {
      const list = restoreEngine.findSnapshots();
      return sendJson(res, 200, list);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/restore/start' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.snapshotPath) {
        return sendJson(res, 400, { error: 'snapshotPath is required' });
      }
      if (restoreEngine.isBusy()) {
        return sendJson(res, 400, { error: 'Restoration already in progress' });
      }

      restoreEngine.restoreSnapshot(body.snapshotPath, body.options || {}, (progress) => {
        broadcastSSE({ type: 'restore_progress', data: progress });
      }).then(result => {
        broadcastSSE({ type: 'restore_done', data: result });
      }).catch(err => {
        broadcastSSE({ type: 'restore_error', error: err.message });
      });

      return sendJson(res, 200, { status: 'started' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Serve Static Files from public/
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check: stay inside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA-style routing if needed
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`\n======================================================`);
      console.log(`  SnapShift Studio is LIVE at http://127.0.0.1:${port}`);
      console.log(`======================================================\n`);
      resolve(server);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} is already in use, reusing running instance...`);
        resolve(server);
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = { server, startServer };
