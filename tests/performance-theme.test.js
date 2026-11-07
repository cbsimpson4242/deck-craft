import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_IDS } from '../src/catalog.js';
import { createSession } from '../src/session.js';
import { deckColor, lane, deck, mixer } from '../src/components.js';
import { createViewOptions, renderSession } from '../src/views.js';

test('deck identities stay consistent across the waveform lane, deck panel and mixer channel', () => {
  const state = createSession();
  const before = structuredClone(state);
  const html = renderSession(state, createViewOptions());
  for (const [i, id] of DECK_IDS.entries()) {
    const token = 'var(--' + 'abcd'[i] + ')';
    assert.equal(deckColor(id), token);
    for (const markup of [lane(id, state), deck(id, state)]) assert.ok(markup.includes(`style="--deck:${token}`), `${id} ${markup.slice(0, 40)}`);
    assert.ok(mixer(state).includes(`data-channel="${id}" style="--deck:${token}"`));
    assert.ok(html.includes(`data-deck="${id}"`));
  }
  assert.deepEqual(state, before, 'visual rendering must not change the session');
});
