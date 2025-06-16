const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PROXY_PORT = 8086;
const TARGET_HOST = 'localhost';
const TARGET_PORT = 8085;

// Helper function to get content type
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

// Helper function to serve static files
function serveStaticFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        
        const contentType = getContentType(filePath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Serve static files for development
    if (req.method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
            serveStaticFile('./index.html', res);
            return;
        } else if (pathname === '/client.js') {
            serveStaticFile('./client.js', res);
            return;
        } else if (pathname === '/client.d.ts') {
            serveStaticFile('./client.d.ts', res);
            return;
        } else if (pathname === '/openapi.json') {
            serveStaticFile('./openapi.json', res);
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
        
        // Remove host header to avoid issues
        delete options.headers.host;
        
        const proxy = http.request(options, (proxyRes) => {
            // Copy status code and headers
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            
            // Pipe the response
            proxyRes.pipe(res);
        });
        
        proxy.on('error', (err) => {
            console.error('Proxy error:', err);
            res.writeHead(500);
            res.end('Proxy error: ' + err.message);
        });
        
        // Pipe the request body
        req.pipe(proxy);
    } else {
        // 404 for other paths
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PROXY_PORT, () => {
    console.log(`CORS proxy server running on http://localhost:${PROXY_PORT}`);
    console.log(`Proxying requests to http://${TARGET_HOST}:${TARGET_PORT}`);
    console.log('\nUpdate your index.html base URL to: http://localhost:8086/api/v1');
});
