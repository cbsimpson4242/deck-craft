import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_IDS, LAYOUTS } from '../src/catalog.js';
import { createSession, reduceSession } from '../src/session.js';
import { deckColor, wave } from '../src/components.js';
import { createViewOptions, renderSession } from '../src/views.js';

const colors = { A: '#d2fa69', B: '#64d8fa', C: '#ffbc70', D: '#c6a0ff' };

test('Performance console deck identities remain consistent in all five layouts', () => {
  const state = createSession();
  for (const layout of LAYOUTS) {
    const selected = reduceSession(state, { type: 'layout', value: layout.id });
    const before = structuredClone(selected);
    const html = renderSession(selected, createViewOptions());
    for (const id of DECK_IDS) {
      assert.equal(deckColor(id, selected), colors[id], `${layout.id} deck ${id}`);
      assert.ok(wave(id, selected).includes(`stop-color="${colors[id]}"`));
      if (layout.decks === 4 || ['A', 'B'].includes(id)) {
        assert.ok(html.includes(`style="--deck:${colors[id]}"`));
        assert.ok(html.includes(`data-deck="${id}"`));
      }
    }
    assert.deepEqual(selected, before, 'visual rendering must not change the session');
  }
});
