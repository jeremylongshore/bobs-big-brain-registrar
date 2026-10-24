// Only a synthetic loopback server; import testcontainers' actual HTTP client
// without importing testcontainers itself or contacting a Docker daemon.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireRepo = createRequire(join(repo, 'package.json'));
const requireContainers = createRequire(requireRepo.resolve('testcontainers'));
const { fetch } = requireContainers('undici');
const requireUndici = createRequire(requireContainers.resolve('undici'));
const sockets = new Set();
let requests = 0;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.once('data', () => {
    requests++;
    if (requests === 1)
      socket.end(
        [
          'HTTP/1.1 200 OK',
          'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip',
          'Content-Length: 100',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
    else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
  });
});
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  await assert.rejects(fetch(url), TypeError);
  assert.equal(await (await fetch(url)).text(), 'ok');
  assert.equal(requests, 2);
  console.log(
    JSON.stringify({
      version: requireUndici('./package.json').version,
      excessiveEncodingsRefused: true,
      subsequentRequestAlive: true,
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolveClose) => server.close(resolveClose));
}
