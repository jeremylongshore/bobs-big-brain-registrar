import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { inventory, verifyLayout } from '../../packages/qmd-runtime/lib/runtime-inventory.mjs';

const roots: string[] = [];
const modulePath = fileURLToPath(
  new URL('../../packages/qmd-runtime/lib/runtime-inventory.mjs', import.meta.url),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bbb-inventory-cost-'));
  roots.push(root);
  const path = join(root, 'built-native-shaped.bin');
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0xa7);
  writeFileSync(path, bytes);
  chmodSync(path, 0o640);
  return { root, path, bytes };
}
function child(mode: string, root: string, path: string) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import fs from 'node:fs';
       import {syncBuiltinESMExports} from 'node:module';
       import {pathToFileURL} from 'node:url';
       const [mode,root,path,modulePath]=process.argv.slice(1);
       const original={open:fs.openSync,close:fs.closeSync,read:fs.readSync,whole:fs.readFileSync};
       const owned=new Set();let opens=0,closes=0,maxRead=0,reads=0,mutated=false;
       fs.openSync=function(p,...args){const fd=original.open.call(this,p,...args);if(p===path&&args[0]==='r'){owned.add(fd);opens++;}return fd;};
       fs.closeSync=function(fd){if(owned.delete(fd))closes++;return original.close.call(this,fd);};
       fs.readFileSync=function(p,...args){if(p===path)throw new Error('Whole-file allocation refused');return original.whole.call(this,p,...args);};
       fs.readSync=function(fd,buffer,offset,length,position){
         if(owned.has(fd)){
           reads++;maxRead=Math.max(maxRead,length);assert(length<=1024*1024,'Read exceeded bounded buffer');
           if(!mutated&&reads===2&&mode!=='bounded'){
             mutated=true;
             if(mode==='truncate')fs.truncateSync(path,17);
             else if(mode==='replace'){fs.renameSync(path,path+'.old');fs.writeFileSync(path,'replacement');}
             else if(mode==='grow')fs.appendFileSync(path,Buffer.alloc(1024,0xbb));
             else if(mode==='read-error')throw new Error('Injected read failure');
           }
         }
         return original.read.call(this,fd,buffer,offset,length,position);
       };
       syncBuiltinESMExports();
       const {inventory}=await import(pathToFileURL(modulePath));let result,error;
       try{result=inventory(root);}catch(e){error=e.message;}
       if(mode==='bounded')assert.equal(error,undefined,'Whole-file payload allocation must not be required');
       assert.equal(owned.size,0,'Owned descriptors must close on success and failure');
       assert.equal(opens,closes);
       assert(opens>0,'Payload must be hashed through a bounded file descriptor');
       if(mode==='bounded'){assert.equal(error,undefined);assert(maxRead>0);}
       else {assert(error,'Changed/read-failed file must not publish an inventory');assert.equal(result,undefined);}
       console.log(JSON.stringify({result,error,opens,closes,maxRead,reads,mutated}));`,
      mode,
      root,
      path,
      modulePath,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  );
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('runtime verification cost without integrity shortcuts', () => {
  it('hashes every byte through bounded reads with identical size, mode and SHA256', () => {
    const f = fixture();
    const expected = inventory(f.root);
    const result = child('bounded', f.root, f.path);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.result).toEqual(expected);
    expect(observed.result.entries['built-native-shaped.bin']).toEqual({
      kind: 'file',
      bytes: f.bytes.length,
      mode: 0o640,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    });
  });
  it.each(['truncate', 'replace', 'grow', 'read-error'])(
    'rejects a payload %s while closing its descriptor',
    (mode) => {
      const f = fixture();
      const result = child(mode, f.root, f.path);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ opens: 1, closes: 1, mutated: true });
    },
  );
  it('preserves original layout decisions across package boundaries and adversarial prefixes', () => {
    const graph = {
      directories: {
        a: ['node_modules/.pnpm/hash/node_modules/@scope/pkg'],
        b: ['node_modules/x'],
      },
    };
    // Explicit old-policy outcomes, including strict-graph preconditions for module links.
    const cases: Array<[string, string[]]> = [
      ['', ['directory']],
      ['package.json', ['file', 'directory', 'link']],
      ['README.md', ['file', 'directory', 'link']],
      ['bin', ['directory']],
      ['lib/runtime-inventory.mjs', ['file', 'directory', 'link']],
      ['node_modules', ['directory']],
      ['node_modules/.pnpm/hash/node_modules/@scope', ['directory', 'link']],
      ['node_modules/.pnpm/hash/node_modules/@scope/pkg', ['file', 'directory', 'link']],
      ['node_modules/.pnpm/hash/node_modules/@scope/pkg/built.node', ['file', 'directory', 'link']],
      ['node_modules/.pnpm/hash/node_modules/@scope/pkg-evil/file', ['link']],
      ['node_modules/x/file', ['file', 'directory', 'link']],
      ['node_modules/xx/file', ['link']],
      ['node_modules/.pnpm/node_modules/extra', ['directory', 'link']],
      ['node_modules/.bin/tool', ['file', 'directory', 'link']],
      ['node_modules/.modules.yaml', ['file', 'directory', 'link']],
      ['node_modules/.pnpm/lock.yaml', ['file', 'directory', 'link']],
      ['node_modules/@scope', ['directory', 'link']],
      ['node_modules/@scope/alias', ['link']],
      ['bin/extra', []],
      ['README.md/extra', []],
      ['other', []],
    ];
    const baseline = {
      'node_modules/@scope/alias': {
        kind: 'link',
        target: '../.pnpm/hash/node_modules/@scope/pkg',
      },
    };
    for (const [path, allowedKinds] of cases) {
      for (const kind of ['file', 'directory', 'link']) {
        const files = { entries: { ...baseline, [path]: { kind, target: 'x' } } };
        const check = () => verifyLayout(files, graph);
        if (allowedKinds.includes(kind)) expect(check, `${kind}:${path}`).not.toThrow();
        else expect(check, `${kind}:${path}`).toThrow(/Unrecognized/);
      }
    }
  });
  it('retains rejection of unrecognized files beside valid scoped package ancestors', () => {
    const f = fixture();
    mkdirSync(join(f.root, 'node_modules/@scope'), { recursive: true });
    const files = inventory(f.root);
    expect(() => verifyLayout(files, { directories: {} })).toThrow(/Unrecognized/);
  });
});
