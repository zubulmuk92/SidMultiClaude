// test/unit/web-shell/derived.test.ts — derived.js: « À traiter » order, counters, window title, favicon priority, sidebar
// rows (grouping, « Afficher plus », filter, hidden accounts), quick-switcher prefixes and ranking.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup.ts';
import { accountView, cid, state, summary } from './fixtures.ts';
// @ts-expect-error browser module without declarations (checked by tsconfig.web.json)
import * as derivedM from '../../../src/web/derived.js';
import { budget } from '../../helpers/perf.ts';

const d: any = derivedM;
const ext = (status: 'busy' | 'idle' | 'waiting' | 'blocked') => ({ pid: 1, kind: 'cli', entrypoint: 'cli', status });

test('attention: needs (oldest first) › terminal waiting › error › rate_limited › unread; idle/running/cold excluded', () => {
  const list = [
    summary(1, { state: state('idle', 50, { unread: true }) }),
    summary(2, { state: state('error', 10) }),
    summary(3, { state: { ...state('needs_permission', 300), pending: { count: 1, oldestAt: 300, kind: 'permission' } } }),
    summary(4, { state: { ...state('needs_plan', 100), pending: { count: 1, oldestAt: 100, kind: 'plan' } } }),
    summary(5, { state: state('rate_limited', 5, { limit: { resetsAt: 9e12, kind: 'five_hour' } }) }),
    summary(6, { state: state('cold', 1, { external: ext('waiting') }) }),
    summary(7, { state: state('running', 1) }),
    summary(8, { state: state('cold', 1, { external: ext('busy') }) }),
    summary(9, { state: { ...state('needs_answer', 200), pending: { count: 1, oldestAt: 200, kind: 'question' } } }),
  ];
  assert.deepEqual(d.attentionList(list).map((s: any) => s.title), ['Chat 4', 'Chat 9', 'Chat 3', 'Chat 6', 'Chat 2', 'Chat 5', 'Chat 1']);
  const c = d.counts(list);
  assert.deepEqual(c, { needs: 3, errors: 2, done: 1, running: 1 });
  assert.equal(d.windowTitle(c), '!3 ✕2 ✓1 · SidMultiClaude');
  assert.equal(d.windowTitle({ needs: 0, errors: 0, done: 0 }), 'SidMultiClaude');
});

test('favicon priority: needs count (9+) › error › unread › running › none', () => {
  assert.deepEqual(d.faviconSpec({ needs: 12, errors: 1, done: 1, running: 1 }), { kind: 'needs', text: '9+' });
  assert.deepEqual(d.faviconSpec({ needs: 2, errors: 1, done: 0, running: 0 }), { kind: 'needs', text: '2' });
  assert.equal(d.faviconSpec({ needs: 0, errors: 1, done: 1, running: 1 }).kind, 'error');
  assert.equal(d.faviconSpec({ needs: 0, errors: 0, done: 1, running: 1 }).kind, 'done');
  assert.equal(d.faviconSpec({ needs: 0, errors: 0, done: 0, running: 1 }).kind, 'running');
  assert.equal(d.faviconSpec({ needs: 0, errors: 0, done: 0, running: 0 }).kind, 'none');
});

test('state glyphs: every state has a glyph shape and a French label', () => {
  const phases = ['cold', 'starting', 'idle', 'running', 'needs_permission', 'needs_answer', 'needs_plan', 'rate_limited', 'error'];
  for (const p of phases) { const g = d.stateGlyph(summary(1, { state: state(p as any) })); assert.ok(g.label && !g.label.includes('.'), p); }
  assert.equal(d.stateGlyph(summary(1, { state: state('idle', 1, { unread: true }) })).glyph, '✓');
  assert.equal(d.stateGlyph(summary(1, { state: { ...state('cold'), flags: { ...state('cold').flags, notStarted: true } } })).label, 'Pas encore démarré');
});

const accts = [accountView('perso', 'Perso', 1), accountView('pro', 'ACME', 2)];
const base = { accounts: accts, grouping: 'account', showArchived: false, showOther: true, filter: '', collapsed: new Set(), expanded: new Set(), asks: [], now: 10_000 };

test('sidebar: À traiter, Épinglés, Account › Folder › Chat with 5 shown then « Afficher plus »', () => {
  const list = [
    ...Array.from({ length: 8 }, (_, i) => summary(10 + i, { cwd: 'C:\\proj\\alpha', updatedAt: 100 + i })),
    summary(30, { pinned: true, cwd: 'C:\\proj\\beta' }),
    summary(31, { archived: true, cwd: 'C:\\proj\\beta' }),
    summary(32, { cwd: 'C:\\work\\alpha' }, 'pro'),
    summary(33, { state: { ...state('needs_permission', 5), pending: { count: 1, oldestAt: 5 } }, cwd: 'C:\\proj\\beta' }),
  ];
  const rows = d.buildSidebar({ ...base, list });
  const kinds = rows.map((r: any) => r.kind + (r.kind === 'section' ? ':' + r.key : ''));
  assert.deepEqual(kinds.slice(0, 4), ['section:sec:att', 'chat', 'section:sec:pin', 'chat']);
  const perso = rows.findIndex((r: any) => r.kind === 'account' && r.a.id === 'perso');
  assert.equal(rows[perso + 1].kind, 'folder');
  const alpha = rows.find((r: any) => r.kind === 'folder' && r.path === 'C:\\proj\\alpha');
  assert.equal(alpha.count, 8);
  const more = rows.find((r: any) => r.kind === 'more');
  assert.equal(more.n, 3);
  assert.equal(rows.filter((r: any) => r.kind === 'chat' && r.key.startsWith('t:') && r.s.cwd === 'C:\\proj\\alpha').length, 5);
  assert.ok(!rows.some((r: any) => r.kind === 'chat' && r.s.archived), 'archived hidden');
  const exp = d.buildSidebar({ ...base, list, expanded: new Set([more.group]) });
  assert.equal(exp.filter((r: any) => r.kind === 'chat' && r.key.startsWith('t:') && r.s.cwd === 'C:\\proj\\alpha').length, 8);
  const col = d.buildSidebar({ ...base, list, collapsed: new Set(['acc:perso']) });
  assert.ok(!col.some((r: any) => r.kind === 'folder' && r.path.startsWith('C:\\proj')));
  const hidden = d.buildSidebar({ ...base, list, accounts: [accts[0], { ...accts[1], hidden: true }] });
  assert.ok(!hidden.some((r: any) => r.kind === 'chat' && r.s.accountId === 'pro'));
  const filtered = d.buildSidebar({ ...base, list, filter: 'beta' });
  assert.ok(filtered.filter((r: any) => r.kind === 'chat').every((r: any) => r.s.cwd.includes('beta')));
  assert.equal(d.buildSidebar({ ...base, list, grouping: 'folder' }).filter((r: any) => r.kind === 'account').length, 0);
  assert.ok(d.buildSidebar({ ...base, list, grouping: 'state' }).some((r: any) => r.key === 'st:needs'));
});

test('sidebar: 1,000 rows build in well under 50 ms', () => {
  const list = Array.from({ length: 1000 }, (_, i) => summary(i, { cwd: `C:\\proj\\p${i % 40}`, updatedAt: i }, i % 2 ? 'pro' : 'perso'));
  d.buildSidebar({ ...base, list, expanded: new Set(Array.from({ length: 80 }, (_, i) => `${i % 2 ? 'pro' : 'perso'}|c:\\proj\\p${i % 40}`)) });
  // best of 3 (auditor, M2): one run can be preempted by the other test files running in parallel (npm test)
  let ms = Infinity;
  for (let k = 0; k < 3 && ms >= 50; k++) {
    const t0 = performance.now();
    const rows = d.buildSidebar({ ...base, list, grouping: 'folder', expanded: new Set(Array.from({ length: 40 }, (_, i) => `all|c:\\proj\\p${i}`)) });
    ms = Math.min(ms, performance.now() - t0);
    assert.ok(rows.filter((r: any) => r.kind === 'chat').length === 1000);
  }
  assert.ok(ms < budget(50), `${ms} ms`);
});

test('switcher: prefixes > c: d: e: combine; attention first; folders and actions groups', () => {
  const list = [
    summary(1, { title: 'Fix CI', cwd: 'C:\\proj\\api-gateway', state: { ...state('needs_permission', 5), pending: { count: 1, oldestAt: 5 } } }, 'pro'),
    summary(2, { title: 'Fix flaky test', cwd: 'C:\\proj\\api-gateway', updatedAt: 9000 }, 'pro'),
    summary(3, { title: 'Refacto auth (fix)', cwd: 'C:\\proj\\SidMultiClaude', updatedAt: 8000 }),
  ];
  const actions = [{ label: 'Nouveau chat sur ACME' }, { label: 'Thème sombre' }];
  const all = d.switcherResults('fix', list, accts, actions);
  assert.equal(all[0].group, 'attention');
  assert.equal(all[0].s.title, 'Fix CI');
  assert.deepEqual(all.filter((h: any) => h.group === 'chats').map((h: any) => h.s.title).sort(), ['Fix flaky test', 'Refacto auth (fix)']);
  assert.deepEqual(d.switcherResults('c:acme e:attente', list, accts, actions).map((h: any) => h.s.title), ['Fix CI']);
  assert.deepEqual(d.switcherResults('c:perso', list, accts, actions).map((h: any) => h.s.title), ['Refacto auth (fix)']);
  assert.ok(d.switcherResults('d:gateway', list, accts, actions).every((h: any) => h.s.cwd.includes('api-gateway')));
  assert.deepEqual(d.switcherResults('>sombre', list, accts, actions).map((h: any) => h.action.label), ['Thème sombre']);
  assert.ok(d.switcherResults('gateway', list, accts, actions).some((h: any) => h.group === 'folders'));
  assert.deepEqual(d.parseQuery('> c:a d:b e:Cours texte libre'), { actions: true, account: ['a'], folder: ['b'], state: ['cours'], text: 'texte libre' });
});

test('switcher: 5,000 chats ranked for a two-word query in a few ms (ux §10.1: < 5 ms; generous bound for a busy CI)', () => {
  const titles = ['Fix CI', 'Réparer le démarrage Edge', 'Migration DB', 'Refacto auth'];
  const list = Array.from({ length: 5000 }, (_, i) => summary(i, { title: `${titles[i % 4]} ${i}`, cwd: `C:\\proj\\p${i % 40}`, firstPrompt: `Regarde le module ${i}` }, i % 2 ? 'pro' : 'perso'));
  d.switcherResults('demarrage edge', list, accts, []);              // warm: haystacks are cached per summary object
  // best of 3: one run can be preempted by the other test files running in parallel (npm test)
  let hits: any[] = [];
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    hits = d.switcherResults('demarrage edge', list, accts, []);
    ms = Math.min(ms, performance.now() - t0);
  }
  console.log(`# switcher: 5,000 chats in ${ms.toFixed(2)} ms`);
  assert.ok(hits.length > 0 && hits.every((h: any) => h.group !== 'chats' || /démarrage/.test(h.s.title)));
  assert.ok(ms < budget(25), `${ms} ms`);
  const renamed = list.map((s, i) => (i === 1 ? { ...s, title: 'Tout autre sujet' } : s));
  assert.ok(!d.switcherResults('demarrage edge', renamed, accts, []).some((h: any) => h.s?.chatId === list[1]?.chatId), 'a changed summary is searched afresh');
});

test('attention reasons are deterministic French one-liners', () => {
  const ask = { chatId: cid(1), requestId: 'r', toolUseId: 't', kind: 'permission', toolName: 'Bash', input: { command: 'npm ci\nnpm test' }, offerAlways: false, alwaysRules: [], offerAuto: false, defaultToNo: false, since: 1 };
  assert.equal(d.attentionReason(summary(1, { state: state('needs_permission') }), ask, 0), 'Bash · npm ci');
  assert.match(d.attentionReason(summary(1, { state: state('rate_limited', 1, { limit: { resetsAt: Date.UTC(2026, 0, 1, 14, 45), kind: 'x' } }) }), undefined, 0), /^Limite · reprise \d\d:\d\d$/);
  assert.equal(d.attentionReason(summary(1, { state: state('cold', 1, { external: ext('blocked') }) }), undefined, 0), 'Attend une réponse dans le terminal');
  assert.match(d.attentionReason(summary(1, { state: state('idle', 1000, { unread: true }) }), undefined, 1000 + 180_000), /^Terminé il y a 3 minutes$/);
});

test('a cold limit already reset (stale transcript tail) leaves « À traiter », the title counts and the favicon', () => {
  const now = Date.UTC(2026, 9, 9, 12);
  const list = [
    summary(1, { state: state('rate_limited', 5, { limit: { resetsAt: Date.UTC(2026, 7, 27, 15, 30), kind: 'five_hour' } }) }),
    summary(2, { state: state('rate_limited', 6, { limit: { resetsAt: now + 3_600_000, kind: 'five_hour' } }) }),
  ];
  assert.equal(d.isStaleLimit(list[0], now), true);
  assert.equal(d.isStaleLimit(list[1], now), false);
  assert.deepEqual(d.attentionList(list, now).map((s: any) => s.title), ['Chat 2']);
  const c = d.counts(list, now);
  assert.equal(c.errors, 1);
  assert.equal(d.windowTitle(d.counts([list[0]], now)), 'SidMultiClaude');
  assert.equal(d.faviconSpec(d.counts([list[0]], now)).kind, 'none');
  const rows = d.buildSidebar({ list: [list[0]], accounts: [accountView('perso', 'Perso', 1)], grouping: 'account', showArchived: false, showOther: true,
    filter: '', collapsed: new Set(), expanded: new Set(), asks: [], now });
  assert.equal(rows.some((r: any) => r.key === 'sec:att'), false);
});
