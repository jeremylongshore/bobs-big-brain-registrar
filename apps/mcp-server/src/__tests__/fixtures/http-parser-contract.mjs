// Isolated process: a decoder crash must fail the contract, not kill Vitest.
import assert from 'node:assert/strict';
import { createServer, request, get } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, gzipSync } from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const requireApp = createRequire(join(repo, 'apps/mcp-server/package.json'));
const requireQmd = createRequire(import.meta.resolve('@tobilu/qmd'));
const requireSdk = createRequire(
  (process.argv[2] === 'qmd' ? requireQmd : requireApp).resolve(
    '@modelcontextprotocol/sdk/server/mcp.js',
  ),
);
const requireExpress = createRequire(requireSdk.resolve('express'));
const requireParser = createRequire(requireExpress.resolve('body-parser'));
const bodyParser = requireExpress('body-parser');
const onFinished = requireParser('on-finished');
let client;
let parsed;
const parser = bodyParser.json();
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.end('alive');
    return;
  }
  parser(req, res, (error) => {
    if (error) {
      res.statusCode = error.status ?? 400;
      res.end('refused');
      return;
    }
    parsed = req.body;
    if (req.url === '/trailing') {
      onFinished(req, () => res.end(JSON.stringify(req.body)));
      // Send the tail AFTER the valid compressed frame has been parsed. This
      // tests the upstream decoder lifecycle, rather than a timing-based guess.
      client.end(Buffer.alloc(1024));
    } else res.end(JSON.stringify(req.body));
  });
});
function post(path, encoding, body, trailing = 0) {
  return new Promise((resolveResponse, reject) => {
    client = request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': encoding,
          'Content-Length': body.length + trailing,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolveResponse({ status: res.statusCode, text }));
        res.on('error', reject);
      },
    );
    client.on('error', reject);
    client.setTimeout(3000, () => client.destroy(new Error('Owned HTTP fixture timed out')));
    if (trailing) client.write(body);
    else client.end(body);
  });
}
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const first = Buffer.concat([deflateSync('{"fixture":1}'), Buffer.from([0])]);
  assert.deepEqual(await post('/trailing', 'deflate', first, 1024), {
    status: 200,
    text: '{"fixture":1}',
  });
  assert.deepEqual(parsed, { fixture: 1 });
  assert.deepEqual(await post('/valid', 'gzip', gzipSync('{"fixture":2}')), {
    status: 200,
    text: '{"fixture":2}',
  });
  const bad = await post('/invalid', 'gzip', Buffer.from('invalid gzip'));
  assert.equal(bad.status, 400);
  const health = await new Promise((resolveHealth, reject) => {
    get(
      { hostname: '127.0.0.1', port: server.address().port, path: '/health', agent: false },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolveHealth(text));
      },
    ).on('error', reject);
  });
  assert.equal(health, 'alive');
  console.log(
    JSON.stringify({
      parserVersion: requireParser('./package.json').version,
      trailingFrameSurvives: true,
      validGzip: true,
      malformedRefused: true,
      subsequentRequestAlive: true,
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  client?.destroy();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
