import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('approved stylesheet is copied without tool-output truncation or omitted rules',()=>{
 const source=readFileSync(new URL('../designs/round-three/signal-one/index.html',import.meta.url),'utf8');
 const expected=source.match(/<style>([\s\S]*?)<\/style>/)[1];
 const actual=readFileSync(new URL('../src/approved.css',import.meta.url),'utf8').replace(/^\/\* Preserved visual system[^\n]*\n/,'');
 const hash=value=>createHash('sha256').update(value).digest('hex');
 assert.ok(hash(actual)===hash(expected),`Stylesheet differs from the approved source: ${actual.length} versus ${expected.length} characters`);
});
