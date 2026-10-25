import test from 'node:test';
import assert from 'node:assert/strict';
import {LAYOUTS} from '../src/catalog.js';
import {createSession,reduceSession} from '../src/session.js';
import {createViewOptions,renderSession} from '../src/views.js';

test('every layout uses the same model without iframe or a separate document',()=>{
 let state=createSession();state=reduceSession(state,{type:'deck',deck:'C',field:'position',value:165.5});
 const original=structuredClone(state);
 for(const layout of LAYOUTS){
  const selected=reduceSession(state,{type:'layout',value:layout.id});
  const html=renderSession(selected,createViewOptions());
  assert.equal((html.match(/<section class="deck /g)||[]).length,layout.decks);
  assert.ok(html.includes('class="layout-picker"'));
  assert.ok(!/<iframe|<html|<script/i.test(html));
  assert.ok(html.includes('audio engine'));
  if(layout.decks===2)assert.ok(html.includes('C / D PRESERVED'));
 }
 assert.deepEqual(state,original);
});

test('restored HTML-like search text is escaped when a layout is rendered',()=>{
 let state=createSession();state=reduceSession(state,{type:'library',field:'query',value:'"><img src=x onerror=alert(1)>'});
 for(const layout of LAYOUTS){
  const html=renderSession(reduceSession(state,{type:'layout',value:layout.id}),createViewOptions());
  assert.ok(html.includes('&quot;&gt;&lt;img'));
  assert.ok(!html.includes('<img src=x'));
 }
});
