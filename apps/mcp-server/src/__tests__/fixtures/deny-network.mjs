// Used only in owned qmd subprocesses, never in the test runner or a live service.
import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';

const record = (value) =>
  appendFileSync(process.env.BBB_QMD_RUNTIME_LOG, JSON.stringify(value) + '\n');
record({
  kind: 'runtime',
  pid: process.pid,
  ppid: process.ppid,
  entry: process.argv[1],
  node: process.versions.node,
  bun: Boolean(process.versions.bun),
});
const deny = (operation) => {
  record({ kind: 'denied', operation });
  throw new Error('Network disabled in qmd validator contract');
};
globalThis.fetch = async () => deny('fetch');
net.Socket.prototype.connect = () => deny('tcp');
net.Server.prototype.listen = () => deny('listen');
http.request = http.get = () => deny('http');
https.request = https.get = () => deny('https');
dgram.createSocket = () => deny('udp');
dns.lookup = dns.resolve = () => deny('dns');
syncBuiltinESMExports();
