// Only a synthetic loopback server; import testcontainers' actual HTTP client
// without importing testcontainers itself or contacting a Docker daemon.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireRepo = createRequire(join(repo, 'package.json'));
const requireContainers = createRequire(requireRepo.resolve('testcontainers'));
const { fetch } = requireContainers('undici');
const requireUndici = createRequire(requireContainers.resolve('undici'));
const sockets = new Set();
let requests = 0;
let nestedGzip = Buffer.from('owned fixture');
for (let i = 0; i < 6; i++) nestedGzip = gzipSync(nestedGzip);
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
    else if (requests === 2)
      socket.end(
        Buffer.concat([
          Buffer.from(
            [
              'HTTP/1.1 200 OK',
              'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip',
              'Content-Length: ' + nestedGzip.length,
              'Connection: close',
              '',
              '',
            ].join('\r\n'),
          ),
          nestedGzip,
        ]),
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
  const encodingLimit = (error) => {
    assert.ok(error instanceof TypeError);
    assert.equal(
      error.cause?.message,
      'too many content-encodings in response: 6, maximum allowed is 5',
    );
    return true;
  };
  // Retain the advisory's truncated-body crash reproduction, and require its
  // encoding-limit cause rather than accepting an unrelated premature EOF.
  await assert.rejects(fetch(url), encodingLimit);
  // Independent complete, valid six-layer gzip control cannot fail from EOF.
  await assert.rejects(fetch(url), encodingLimit);
  assert.equal(await (await fetch(url)).text(), 'ok');
  assert.equal(requests, 3);
  console.log(
    JSON.stringify({
      version: requireUndici('./package.json').version,
      excessiveEncodingsRefused: true,
      completeEncodedBodyRefused: true,
      encodingLimitCauseVerified: true,
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
