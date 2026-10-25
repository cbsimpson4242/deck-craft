import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS } from '../src/catalog.js';
import { createSession, reduceSession, serializeSession, restoreSession } from '../src/session.js';

test('saved preference and musical data restore, but transport never auto-starts', () => {
  let state=createSession();
  state=reduceSession(state,{type:'layout',value:'studio-linear'});
  state=reduceSession(state,{type:'deck',deck:'D',field:'position',value:123.5});
  state=reduceSession(state,{type:'deck',deck:'D',field:'playing',value:true});
  state=reduceSession(state,{type:'setCue',deck:'D',index:2});
  const restored=restoreSession(serializeSession(state));
  assert.equal(restored.state.layout,'studio-linear');
  assert.equal(restored.state.decks.D.position,123.5);
  assert.equal(restored.state.decks.D.cues[2],123.5);
  assert.equal(restored.state.decks.D.playing,false);
  assert.deepEqual(restored.state.mixer,state.mixer);
});

test('invalid layout/action cannot corrupt a valid session', () => {
  const state=createSession();
  assert.equal(reduceSession(state,{type:'layout',value:'unknown'}),state);
  assert.equal(reduceSession(state,{type:'deck',deck:'Z',field:'position',value:10}),state);
  assert.equal(reduceSession(state,{type:'deck',deck:'A',field:'__proto__',value:{bad:true}}),state);
  assert.equal(reduceSession(state,{type:'deck',deck:'A',field:'pitch',value:NaN}),state);
  assert.equal(reduceSession(state,{type:'load',deck:'B',trackId:'not-a-track'}),state);
  assert.equal(reduceSession(state,{type:'library',field:'target',value:'Z'}),state);
});

test('bounds, cue editing and track loading affect only the intended deck', () => {
  let state=createSession();const others=structuredClone([state.decks.B,state.decks.C,state.decks.D]);
  state=reduceSession(state,{type:'deck',deck:'A',field:'position',value:99999});
  assert.equal(state.decks.A.position,384);
  state=reduceSession(state,{type:'deck',deck:'A',field:'pitch',value:-100});
  assert.equal(state.decks.A.pitch,-8);
  state=reduceSession(state,{type:'deck',deck:'A',field:'level',value:200});
  assert.equal(state.decks.A.level,100);
  state=reduceSession(state,{type:'load',deck:'A',trackId:'low-orbit'});
  assert.equal(state.decks.A.trackId,'low-orbit');assert.equal(state.decks.A.position,0);
  assert.deepEqual([state.decks.B,state.decks.C,state.decks.D],others);
  state=reduceSession(state,{type:'deck',deck:'A',field:'position',value:77.2});
  state=reduceSession(state,{type:'setCue',deck:'A',index:1});
  state=reduceSession(state,{type:'deck',deck:'A',field:'position',value:10});
  state=reduceSession(state,{type:'hotCue',deck:'A',index:1});assert.equal(state.decks.A.position,77.2);
});

test('malformed, unknown-version and hostile saved state recover safely', () => {
  for(const text of ['not json','null','[]','{"version":999}', '{"version":1,"layout":"unknown","decks":{"A":{"trackId":"unknown","position":"x"}}}']){
    const result=restoreSession(text);assert.equal(result.state.layout,'studio-sync');assert.equal(Object.keys(result.state.decks).length,4);assert.equal(result.recovered,true);
  }
  const malicious=JSON.stringify({...createSession(),layout:'studio-grid',decks:{A:{trackId:'afterlight',position:Infinity,cues:['x',-4,100000,44],playing:true}},__proto__:{polluted:true}});
  const result=restoreSession(malicious);assert.equal(result.state.decks.A.playing,false);assert.equal(result.state.decks.A.position,92.4);assert.equal({}.polluted,undefined);
});

test('all layout transitions preserve the same four decks, mixer and collection state', () => {
  let state=createSession();
  state.decks.C={...state.decks.C,playing:true,position:177.3,loopEnabled:true,pitch:2.5};
  state.decks.A.cues=[0,33.5,101,230];
  state.mixer.crossfader=29;
  state.mixer.effects.echo={enabled:true,wet:63};
  state.library.query='Orbit';
  const musicalState=structuredClone({decks:state.decks,mixer:state.mixer,library:state.library});
  for (const from of LAYOUTS) {
    state=reduceSession(state,{type:'layout',value:from.id});
    assert.equal(state.layout,from.id,'requested layout must become active');
    for (const to of LAYOUTS) {
      const before=state;
      state=reduceSession(state,{type:'layout',value:to.id});
      assert.equal(state.layout,to.id);
      assert.deepEqual({decks:state.decks,mixer:state.mixer,library:state.library},musicalState);
      assert.deepEqual({decks:before.decks,mixer:before.mixer,library:before.library},musicalState,'no mutation of previous snapshot');
    }
  }
});
