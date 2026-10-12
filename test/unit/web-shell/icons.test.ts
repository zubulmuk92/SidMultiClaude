// test/unit/web-shell/icons.test.ts — lib/icons.js: every state character the pure model functions return is drawn as an
// icon (no pictographic character reaches the screen), and an unknown icon name renders nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
import { state, summary } from './fixtures.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as iconsM from '../../../src/web/lib/icons.js';
// @ts-expect-error browser module
import * as derivedM from '../../../src/web/derived.js';
// @ts-expect-error browser module
import * as modelM from '../../../src/web/components/chat/model.js';

const icons: any = iconsM, d: any = derivedM, M: any = modelM;
const drawn = (g: string): boolean => typeof icons.GlyphIcon({ g }) === 'object';

test('icons: the glyph of every chat state, in the sidebar and in the pane header, has its icon', () => {
  const ext = { pid: 1, kind: 'cli', entrypoint: 'cli', status: 'waiting' } as const;
  const states = [
    ...(['cold', 'starting', 'idle', 'running', 'needs_permission', 'needs_answer', 'needs_plan', 'rate_limited', 'error'] as const).map((p) => state(p, 0)),
    state('idle', 0, { unread: true }), state('idle', 0, { external: ext }),
    { ...state('idle', 0), flags: { ...state('idle', 0).flags, bgTasks: 2 } },
  ];
  for (const st of states) {
    for (const g of [d.stateGlyph(summary(1, { state: st })).glyph, M.stateView(st, 0).glyph]) assert.ok(g === '' || drawn(g), `${st.phase}: « ${g} »`);
  }
});

test('icons: tool, task and permission-mode characters are drawn too; an unknown name renders nothing', () => {
  for (const g of ['◐', '!', '?', '✓', '✕', '⊘', '■', '☐', '☑', '≡', '⇄', '‖', '✎', '◇', '✦', '⚠']) assert.ok(drawn(g), g);
  assert.equal(icons.GlyphIcon({ g: '·' }), '·', 'a plain character stays text');
  assert.equal(icons.Icon({ n: 'nope' }), null);
  assert.equal(typeof icons.Icon({ n: 'settings' }), 'object');
});
