const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PROXY_PORT = 8086;
const TARGET_HOST = 'localhost';
const TARGET_PORT = 8085;

// Resolve the plaid-client-js package relative to this file
const CLIENT_PKG = path.resolve(__dirname, '../../plaid-client-js');

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.ts': 'text/plain'
    };
    return types[ext] || 'text/plain';
}

function serveStaticFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': getContentType(filePath),
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Serve static files
    if (req.method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
            serveStaticFile(path.join(__dirname, 'index.html'), res);
            return;
        } else if (pathname === '/sse-test.js') {
            serveStaticFile(path.join(__dirname, 'sse-test.js'), res);
            return;
        } else if (pathname.startsWith('/plaid-client/')) {
            // Serve JS client package files
            const clientPath = path.join(CLIENT_PKG, pathname.replace('/plaid-client/', ''));
            serveStaticFile(clientPath, res);
            return;
        }
    }

    // Forward API requests to the target server
    if (pathname.startsWith('/api/')) {
        console.log(`Proxying ${req.method} ${req.url} to ${TARGET_HOST}:${TARGET_PORT}`);
        const options = {
            hostname: TARGET_HOST,
            port: TARGET_PORT,
            path: req.url,
            method: req.method,
            headers: req.headers
        };
        delete options.headers.host;

        const proxy = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxy.on('error', (err) => {
            console.error('Proxy error:', err);
            res.writeHead(500);
            res.end('Proxy error: ' + err.message);
        });

        req.pipe(proxy);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PROXY_PORT, () => {
    console.log(`CORS proxy server running on http://localhost:${PROXY_PORT}`);
    console.log(`Proxying API requests to http://${TARGET_HOST}:${TARGET_PORT}`);
    console.log(`Serving JS client from ${CLIENT_PKG}`);
});
