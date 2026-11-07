import test from 'node:test';
import assert from 'node:assert/strict';
import {LAYOUTS,DECK_IDS} from '../src/catalog.js';
import {createSession,reduceSession} from '../src/session.js';
import {createViewOptions,renderSession} from '../src/views.js';

test('the console renders four lanes, four deck panels and one mixer from one model without iframe or a separate document',()=>{
 let state=createSession();state=reduceSession(state,{type:'deck',deck:'C',field:'position',value:165.5});
 const original=structuredClone(state);
 assert.deepEqual(LAYOUTS.map(l=>l.id),['console']);
 const html=renderSession(state,createViewOptions());
 assert.equal((html.match(/<section class="deck deck-lane"/g)||[]).length,4);
 assert.equal((html.match(/<section class="deck deck-panel"/g)||[]).length,4);
 assert.equal((html.match(/<section class="mixer"/g)||[]).length,1);
 for(const id of DECK_IDS)assert.ok(html.includes(`data-deck="${id}"`),id);
 for(const label of ['Perform','Library','Build'])assert.ok(html.includes(`>${label}<`),label);
 assert.ok(html.includes('class="theme-picker"'));
 assert.ok(!html.includes('layout-picker'),'there is one layout, so no picker');
 assert.ok(!/<iframe|<html|<script/i.test(html));
 assert.ok(html.includes('audio engine'));
 assert.deepEqual(state,original);
});

test('restored HTML-like search text is escaped when the console is rendered',()=>{
 let state=createSession();state=reduceSession(state,{type:'library',field:'query',value:'"><img src=x onerror=alert(1)>'});
 const html=renderSession(state,createViewOptions());
 assert.ok(html.includes('&quot;&gt;&lt;img'));
 assert.ok(!html.includes('<img src=x'));
});

test('the pair selector and pad modes are presentation state only',()=>{
 const state=createSession();
 const html=renderSession(state,createViewOptions());
 assert.equal((html.match(/data-action="pair"/g)||[]).length,2);
 assert.equal((html.match(/data-action="pad-mode"/g)||[]).length,8);
 assert.equal(reduceSession(state,{type:'pad-mode',deck:'A',value:'loop'}),state,'pad mode is not a session action');
 assert.equal(reduceSession(state,{type:'pair',value:'cd'}).decks.A,state.decks.A);
});
