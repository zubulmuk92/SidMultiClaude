// scripts/screenshots.ts — regenerates the README screenshots (docs/images/*.png) in the installed Edge, headless,
// against test/fakes/mock-server.mjs: synthetic accounts and chats only, no real profile, no model call.
// Usage: node scripts/screenshots.ts
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from '../test/e2e/harness.ts';
// @ts-expect-error plain ESM test fake without declarations
import { startMockServer } from '../test/fakes/mock-server.mjs';

const OUT = path.resolve(import.meta.dirname, '..', 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });
const shot = (name: string) => path.join(OUT, `${name}.png`);

const m = await startMockServer({ chats: 40 });
const chatIdOf = (title: string): string => [...m.world.chats.values()].find((s: { title: string }) => s.title === title).chatId;
let n = 0;
const turn = (text: string, md: string) => {
  const uuid = `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`;
  const user = { uuid, text, origin: 'human' };
  return { id: `u:${uuid}`, at: Date.now() - (20 - n) * 60_000, user,
    blocks: [{ k: 'user', id: `u:${uuid}`, msg: user }, { k: 'text', id: `a:msg_${n}:0`, md }],
    footer: { input: 12, cacheRead: 37_274, cacheWrite: 2_203, output: 180, models: ['claude-test'] } };
};
// last activity spread over two weeks (the mock world is all « today »), and a second usage window, for the dashboard
[...m.world.chats.values()].forEach((s: { updatedAt: number }, i: number) => { if (i > 5) s.updatedAt = Date.now() - Math.round((i * i * 0.2 + (i % 5)) * 3_600_000); });
m.world.accounts[0].usage.rows.push({ key: 'seven_day', label: 'Semaine', pct: 71, severity: 'warning', headline: false, resetsAt: Date.now() + 3 * 86_400_000 });
const LEFT = chatIdOf('Refacto auth'), RIGHT = chatIdOf('Revue PR');   // one chat per account
m.world.turns = new Map([
  [LEFT, [
    turn('Le jeton est vérifié à deux endroits (routeur HTTP et WebSocket). Tu peux regrouper ça ?',
      'La vérification était dupliquée dans `router.ts` et `ws.ts`. Je l’ai regroupée dans une seule fonction :\n\n'
      + '```ts\nexport function verifyToken(header: string | undefined): Session | null {\n  const token = header?.replace(/^Bearer /, \'\');\n'
      + '  return token ? sessions.get(token) ?? null : null;\n}\n```\n\nLes deux appelants passent maintenant par elle. Les 12 tests d’authentification restent verts.'),
    turn('Parfait. Ajoute un test pour le jeton expiré.',
      'Ajouté dans `auth.test.ts` : un jeton expiré renvoie **401** et ferme la session.\n\n- `npm test` : 13 tests, 13 réussis\n- aucun autre fichier modifié'),
  ]],
  [RIGHT, [
    turn('Relis la PR sur la pagination et dis-moi ce qui bloque.',
      'Deux points bloquants :\n\n1. **Limite non bornée** : `limit` vient de la requête sans maximum, une valeur de 100 000 charge toute la table.\n'
      + '2. **Tri instable** : le tri sur `created_at` seul peut répéter ou sauter une ligne entre deux pages ; il faut ajouter `id` comme second critère.\n\n'
      + 'Le reste est correct : les index existent et les tests couvrent la première et la dernière page.'),
    turn('Propose le correctif pour le tri.',
      '```sql\nSELECT * FROM orders\nWHERE (created_at, id) < ($1, $2)\nORDER BY created_at DESC, id DESC\nLIMIT $3;\n```\n\n'
      + 'Le curseur porte alors les deux valeurs de la dernière ligne lue.'),
  ]],
]);

const { browser, context } = await openBrowser(m.origin, { viewport: { width: 1400, height: 900 } });
try {
  const page = await context.newPage();
  await page.goto(m.url());
  await page.locator('.chat-row[data-chat]').first().waitFor();
  const settle = () => page.waitForTimeout(500);

  await page.locator('.dash-tile').first().waitFor();  // no chat open yet: the home view
  await settle();
  await page.screenshot({ path: shot('tableau-de-bord') });

  await page.setViewportSize({ width: 1000, height: 700 });
  await page.keyboard.press('Alt+a');                 // oldest pending request first
  await settle();
  await page.screenshot({ path: shot('a-traiter') });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.keyboard.press('Alt+c');
  await page.locator('.acc-card').first().waitFor();
  await settle();
  await page.locator('.dlg').screenshot({ path: shot('comptes') });
  await page.keyboard.press('Escape');

  await page.locator(`.chat-row[data-chat="${LEFT}"]`).first().click();
  await page.locator(`.chat-row[data-chat="${RIGHT}"]`).first().click({ modifiers: ['Control'] });
  await page.locator('.panegrid.layout-2').waitFor();
  await page.locator('.side-list').evaluate((el) => { el.scrollTop = 0; });
  await settle();
  await page.screenshot({ path: shot('apercu') });
} finally {
  await browser.close();
  await m.close();
}
