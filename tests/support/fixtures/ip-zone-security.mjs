import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// All instrumentation is confined to this owned child and restored explicitly.
const [entry] = process.argv.slice(2);
const require = createRequire(entry);
const { Address6, AddressError } = require(entry);
const constants = require(join(dirname(entry), 'v6/constants.js'));
const pattern = constants.RE_ZONE_STRING;
assert.equal(pattern.source, '%.*$');
const original = pattern.exec;
const input = '%'.repeat(64) + '\n';
let forbiddenScans = 0;
let constructorAddressError = false;
let invalidRejected = false;
pattern.exec = function (value) {
  if (value === input) {
    forbiddenScans++;
    throw new Error('Forbidden unanchored zone scan');
  }
  return original.call(this, value);
};
try {
  try {
    new Address6(input);
  } catch (error) {
    constructorAddressError = error instanceof AddressError;
  }
  invalidRejected = Address6.isValid(input) === false;
} finally {
  pattern.exec = original;
}
const report = {
  forbiddenScans,
  constructorAddressError,
  invalidRejected,
  restored: pattern.exec === original,
  normalZone: new Address6('fe80::1%fixture').zone === '%fixture',
};
console.log(JSON.stringify(report));
process.exitCode = Object.values(report).every((value) => value === true || value === 0) ? 0 : 1;
