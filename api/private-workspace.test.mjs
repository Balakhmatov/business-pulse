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
  assert.match(personal,/request\('\/analysis\?'\+periodQuery\(\)\)/);
  assert.match(personal,/request\('\/import'/);
});

test('empty finance books are hidden instead of rendering disabled no-data cards',()=>{
  assert.match(personal,/const available=labels\.filter/);
  assert.match(personal,/holder\.hidden=available\.length===0/);
  assert.match(personal,/holder\.classList\.toggle\('single-book',available\.length===1\)/);
  assert.match(personal,/volumeCard\.hidden=!Number\.isFinite/);
  assert.match(personal,/averageCard\.hidden=!Number\.isFinite/);
  assert.match(index,/\.finance-books\.single-book/);
});
test('only cafe and store can select paid-and-fulfilled imports with explicit confirmation',()=>{
  assert.match(personal,/bothOption\.hidden=!\['cafe','store'\]\.includes\(industry\)/);
  assert.match(personal,/source_headers:state\.fileTable\.head\.slice\(0,80\)/);
  assert.match(personal,/bookChoice\.hidden=true/);
});

test('data deletion is named consistently, protected by in-page confirmation and works outside Telegram',()=>{
  assert.match(personal,/clearTests\.textContent='Очистить данные'/);
  assert.doesNotMatch(personal,/clearTests\.textContent='Очистить тестовые данные'/);
  assert.match(personal,/function confirmCompanyClear\(\)/);
  assert.match(personal,/field\.value\.trim\(\)\.toUpperCase\(\)!=='УДАЛИТЬ'/);
  assert.match(personal,/confirm:'DELETE_ALL_COMPANY_DATA'/);
  assert.match(personal,/tg\.initData&&typeof tg\.showConfirm==='function'/);
  assert.match(personal,/clearFeedback\.textContent='Не удалось очистить данные:/);
});
