import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const personal=fs.readFileSync(new URL('../personal.js',import.meta.url),'utf8');

test('authenticated dashboard does not construct demo datasets or render public demo automatically',()=>{
  assert.match(index,/const showPublicDemo=!authenticatedShell\|\|demoRequested;/);
  assert.match(index,/if\(showPublicDemo\)Object\.keys\(configs\)\.forEach\(k=>state\.datasets\[k\]=demo\(configs\[k\]\)\);/);
  assert.match(index,/if\(showPublicDemo\)render\(\);/);
  assert.match(index,/const state=\{business:showPublicDemo\?'clinic':'mine'/);
});
test('only explicit demo URL bypasses private workspace and has a return control',()=>{
  assert.match(personal,/new URLSearchParams\(location\.search\)\.get\('demo'\)==='1'/);
  assert.match(index,/returnLink\.href='\.\x2findex\.html'/);
  assert.match(index,/returnLink\.textContent='К моим показателям'/);
});
test('private workspace hides sector selector and teaches first import without sample operations',()=>{
  assert.match(personal,/body\.private-workspace \.switchbar\{display:none!important\}/);
  assert.match(personal,/body\.private-workspace #downloadSample\{display:none!important\}/);
  assert.match(personal,/privateFirstImport/);
  assert.match(personal,/classList\.toggle\('private-empty-view',noData\)/);
  assert.doesNotMatch(personal,/quickDemoImport|function sampleRows\(\)|Синтетический тестовый отчёт/);
});
test('customer import/history and AI remain intact',()=>{
  assert.match(personal,/request\('\/import\/history'\)/);
  assert.match(personal,/request\('\/report'/);
  assert.match(personal,/request\('\/analysis'/);
  assert.match(personal,/request\('\/import'/);
});
