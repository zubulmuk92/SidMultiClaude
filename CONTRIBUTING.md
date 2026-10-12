# Contribuer à SidMultiClaude

Merci de votre intérêt ! Ce guide résume ce qu’il faut savoir avant de proposer une modification.

## Prérequis

- Windows 10 ou 11 (x64), Node.js **24.16 ou plus récent**, npm 11.
- Claude Code natif installé, pour les suites qui utilisent le vrai `claude.exe`.
- Microsoft Edge, pour les suites navigateur et bout en bout.

```powershell
npm ci --omit=optional --ignore-scripts
npm run dev    # serveur relancé à chaque modification, fenêtre ouverte
```

## Niveaux de tests

| Commande | Quand la lancer |
|---|---|
| `npm run check` | Toujours (0 erreur exigée) |
| `npm test` | Toujours : tests unitaires |
| `npm run test:int` | Modification du moteur, du serveur ou du protocole |
| `npm run test:parity` | Modification de `src/server/engine/` (options, environnement, lancement) |
| `npm run test:contract` | Après une mise à jour de Claude Code (vrai `claude.exe`, profil temporaire déconnecté) |
| `npm run test:browser` | Modification de l’interface |
| `npm run test:e2e` | Modification transversale (serveur + interface) |
| `npm run vendor-audit` | Ajout ou modification d’un import côté navigateur |

La CI exécute `check`, `npm test`, `test:int` et `vendor-audit`. Lancez les autres suites en local quand votre modification les concerne.

Après une modification visible de l’interface, régénérez les captures du README avec `node scripts/screenshots.ts` (serveur simulé, données fictives, aucun appel de modèle).

## Règles pour les tests

- **Aucun test automatisé n’appelle de modèle.** Utilisez les faux fournis : `test/fakes/fake-claude.mjs` (faux Claude Code derrière le vrai SDK), la fausse API Messages des tests de parité, le serveur simulé pour l’interface. Seul `npm run smoke`, manuel et volontaire, envoie de vraies requêtes.
- **Aucun test ne touche un vrai profil Claude** : utilisez `test/helpers/tmp-profile.ts`, qui crée des profils jetables sous `%TEMP%`.
- Ports aléatoires, dossiers temporaires, et arrêt de chaque processus lancé.
- Les enregistrements de référence (`test/fixtures/`) ne contiennent que la structure de vraies sessions. Ne committez jamais de transcription, de chemin personnel, d’adresse e-mail ni d’identifiant réel ; `node scripts/sanitize-frames.mjs --check` le vérifie.

## Style de code

- **Serveur** (`src/server/`, `src/shared/`) : TypeScript à **syntaxe effaçable uniquement** (`erasableSyntaxOnly`), exécuté directement par Node. Pas d’`enum`, de `namespace` ni de propriétés de paramètres.
- **Interface** (`src/web/`) : JavaScript + JSDoc, vérifié par TypeScript, sans étape de build. Pas de nouvelle dépendance navigateur sans mise à jour de la liste blanche (`vendor-audit`).
- **Textes de l’interface en français** (`src/web/i18n/`) ; commentaires du code en anglais.
- Toute constante numérique partagée va dans `src/shared/limits.ts`.
- **Parité de tokens** : toute option transmise au SDK passe par `src/server/engine/options.ts`. Une modification qui change le corps des requêtes doit être justifiée et accompagnée de la mise à jour des tests de parité.
- Les commentaires « SPEC §x » et « ux §x » renvoient à [docs/design/SPEC.md](docs/design/SPEC.md) et [docs/design/UX.md](docs/design/UX.md).

## Proposer une modification

1. Ouvrez d’abord un ticket pour toute modification importante.
2. Une branche par sujet, des commits courts et explicites.
3. Vérifiez que `npm run check` et les suites concernées sont vertes.
4. Décrivez dans la pull request ce qui change, pourquoi, et comment vous l’avez testé.

Pour une faille de sécurité, suivez [SECURITY.md](SECURITY.md) au lieu d’ouvrir un ticket public.
