import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const types = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};
export async function serveDirectory(directory, { notFoundFile = '' } = {}) {
  const root = path.resolve(directory);
  const server = http.createServer((request, response) => {
    let file;
    try {
      file = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      const fallback = notFoundFile ? path.join(root, notFoundFile) : '';
      if (fallback && fs.existsSync(fallback)) {
        response.writeHead(404, { 'Content-Type': 'text/html' });
        fs.createReadStream(fallback).pipe(response);
        return;
      }
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
