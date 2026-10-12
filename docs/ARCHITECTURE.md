# Architecture

Vue d’ensemble de SidMultiClaude pour qui veut lire ou modifier le code. Les détails de conception, en anglais, sont dans [docs/design/](design/) : la [spécification d’architecture](design/SPEC.md) (citée « SPEC §x » dans le code), la [spécification UX](design/UX.md) (« ux §x ») et la [recherche sur la parité de tokens](design/TOKEN-RESEARCH.md).

## Composants

| Composant | Rôle | Emplacement |
|---|---|---|
| Serveur local | Processus Node 24 caché, seul à piloter Claude Code. Écoute uniquement `127.0.0.1` (port 41731 par défaut). | `src/server/` |
| Fenêtre | Microsoft Edge en mode `--app`, avec un profil dédié. Simple vue, reliée au serveur par un WebSocket authentifié. | `src/web/` |
| Moteur | Le `claude.exe` officiel, piloté par l’Agent SDK d’Anthropic (`query()` en mode d’entrée continue). | `src/server/engine/` |
| Lanceur (facultatif) | `SidMultiClaude.exe`, sans console : démarre ou réutilise le serveur et le relance après un arrêt inattendu. | `launcher/` |
| Isolation (facultative) | `jobrun.exe` place chaque `claude.exe` dans un *Job* Windows. | `launcher/jobrun.cs` |

Le serveur est écrit en TypeScript à syntaxe effaçable, exécuté directement par Node sans compilation. L’interface est en JavaScript + JSDoc (Preact, htm, signals), servie telle quelle, sans étape de build.

### Modules du serveur

| Dossier | Contenu |
|---|---|
| `engine/` | Constructeur d’options unique (`options.ts`), processus par chat, file d’envoi, autorisations, pool de processus, lancement et arrêt des processus. |
| `model/` | Code pur (sans E/S ni minuterie) : transforme les trames du SDK et les lignes des transcriptions en tours et blocs d’interface identiques, état de chaque chat, comptabilité des tokens. |
| `claude/` | Lecture seule des profils Claude Code : comptes, index des sessions, lecture des transcriptions (début/fin, lecture depuis la fin), registre des sessions actives, usage, connexion. |
| `app/` | Orchestration : commandes, métadonnées de l’application, durée de vie du serveur. |
| `http/`, `ws/` | Fichiers statiques depuis une liste blanche, garde HTTP, hub WebSocket, validation stricte des messages. |
| `platform/` | Fenêtre Edge, terminal, fichiers, chemins confinés, processus orphelins. |
| `util/` | Stockage JSON atomique, garde d’écriture (`fs-guard`), journaux expurgés, horloge, verrous. |

Les contrats partagés sont `src/shared/protocol.ts` (protocole WebSocket), `src/server/contracts.ts` (modules du serveur), `src/web/contract.d.ts` (interface) et `src/shared/limits.ts` (constantes numériques).

## Modèle de processus

- **Un processus `claude.exe` par chat actif**, pas par onglet. Il est créé à la demande (première frappe dans un chat froid, ou envoi) et reste vivant pour garder le cache du modèle chaud.
- **Limite** : 4 processus actifs par défaut (réglable de 2 à 8). Sous 1,5 Go de mémoire libre, un nouveau processus impose d’en mettre un autre en veille.
- **Mise en veille** : un chat inactif est arrêté une fois son cache expiré (1 h par défaut). Un chat en cours, avec une demande en attente, des tâches de fond, des messages en file, visible ou marqué *Garder actif* n’est jamais arrêté.
- **Plafond atteint** : sans victime silencieuse possible (jamais utilisé, ou cache expiré), l’application demande quel chat mettre en veille, avec l’estimation de recréation du cache.
- **Pannes** : pas de relance automatique d’un chat ; les messages non partis reviennent dans la zone de saisie. Trois pannes en 10 minutes exigent une action de l’utilisateur.
- **Arbre de processus** : avec `jobrun.exe`, tous les sous-processus (hooks, outils) meurent avec leur `claude.exe` ; sans lui, arrêt par `taskkill /T /F`.
- **Durée de vie du serveur** : il reste actif tant qu’un processus ou une demande d’autorisation existe, et s’arrête 10 minutes après la fermeture de la dernière fenêtre quand plus rien n’est actif.

## Données

- **Conversations** : uniquement dans le stockage de Claude Code (fichiers JSONL du profil). Supprimer les données de l’application ne fait perdre aucune conversation.
- **Données de l’application** : `%LOCALAPPDATA%\SidMultiClaude\` contient `config.json`, `state\` (état de l’interface, brouillons, métadonnées des chats, jeton d’appareil), `cache\` (index des sessions par compte), `run\`, `logs\` et `edge-profile\`. Écritures atomiques (fichier temporaire, `fsync`, renommage) avec une copie `.bak`.
- **Profils Claude** : lus en lecture seule (transcriptions, configuration globale, réglages, catalogue de modèles, registre des sessions, historique). `.credentials.json` n’est consulté que par `stat` ; les fichiers `*.key` ne sont jamais ouverts.
- **Écritures dans un profil** : uniquement par Claude Code lui-même (CLI, fonctions du SDK pour renommer, supprimer ou bifurquer, `claude.exe auth login|logout`). `fs-guard` lève une erreur sur toute autre écriture de l’application sous un profil.

## Protocole

- **Authentification** : au lancement de la fenêtre, le serveur crée un code d’amorçage (24 octets, 60 s, usage unique) passé dans le fragment de l’URL puis effacé. Le serveur répond par un jeton d’appareil (32 octets, comparaison à temps constant) utilisé pour les reconnexions. Aucun cookie.
- **Contrôles** : `Host` et `Origin` exacts, chemin `/ws`, sous-protocole `smc.v1`. Chaque message client est validé (champs requis, champs inconnus refusés, tailles bornées).
- **Trames** : le serveur envoie des tableaux JSON de messages ; chaque requête du client reçoit exactement un `ack`.
- **Séquencement** : un numéro `seq` par chat ; en cas de trou, le client redemande la vue et reçoit un instantané. Pas de tampon de rejeu : les tours terminés viennent du disque, le tour en cours de l’instantané, et les identifiants de blocs stables rendent la fusion idempotente.
- **Débit** : deltas regroupés toutes les 50 ms par chat (seulement si quelqu’un regarde ce chat) ; contre-pression par connexion (pause au-delà de 4 Mio en attente, fermeture au-delà de 32 Mio).

## Sécurité

- Écoute de `127.0.0.1` uniquement ; HTTP limité à `GET`/`HEAD` ; fichiers servis depuis une liste blanche construite au démarrage.
- CSP stricte avec Trusted Types et empreinte de l’import map ; un seul point d’injection HTML (`src/web/lib/md.js` : marked puis DOMPurify), tout le reste en nœuds texte.
- Aucun shell : `spawn`/`execFile` avec des tableaux d’arguments et des chemins absolus.
- Politique des dossiers de travail (dossier personnel entier, dossiers de configuration de Claude et de l’application refusés) et confinement des chemins (UNC, noms réservés, flux alternatifs…).
- Environnement des processus enfants nettoyé (`CLAUDE*`, `ANTHROPIC*`, `OTEL*`, `NODE_OPTIONS`…) ; `process.env` n’atteint jamais la page.
- Journaux expurgés (clés, jetons, codes d’amorçage), sans contenu de message ; notifications minimales.
- Profil de navigateur dédié, extensions désactivées, jamais de port de débogage distant.

Chaque exigence correspond à un test (SPEC §10). Voir aussi [SECURITY.md](../SECURITY.md).

## Parité de tokens : comment elle est garantie

Objectif : ne jamais consommer plus de tokens que Claude Code pour le même travail. Mesures et méthode : [PARITE-TOKENS.md](PARITE-TOKENS.md).

1. **Un seul constructeur d’options** (`src/server/engine/options.ts`) : invite système `claude_code`, sources de réglages `user`, `project` et `local`, mode de permission explicite, rien d’autre sauf choix explicite de l’utilisateur.
2. **Aucun appel caché** : génération de titre par IA désactivée (`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`), sauf réglage contraire ; l’application n’appelle jamais de modèle d’elle-même.
3. **Cache chaud** : un processus vivant par chat actif ; la mise en veille ne touche jamais un cache encore chaud sans accord.
4. **Tests de parité, sans aucun token d’abonnement** :
   - T-P1 : instantané des options pour chaque type de lancement (nouveau, reprise, bifurcation, retour en arrière) ;
   - T-P2 : un faux `claude.exe` derrière le vrai SDK enregistre les arguments, les noms de variables d’environnement et l’initialisation ;
   - T-P3 : une fausse API Messages compare le corps des requêtes de l’application à celui de `claude -p` dans le même dossier ;
   - T-P4 : la sentinelle `auxTokens` (tokens hors boucle principale) doit rester à 0 sur un tour simple.

## Tests

| Niveau | Commande | Ce qui est vérifié |
|---|---|---|
| Types | `npm run check` | TypeScript 7 sur le serveur et l’interface (JSDoc) |
| Unitaires | `npm test` | Modules isolés, horloge simulée |
| Intégration | `npm run test:int` | Vrai SDK + faux Claude Code (`test/fakes/fake-claude.mjs`) |
| Parité | `npm run test:parity` | T-P1 à T-P4 |
| Contrat | `npm run test:contract` | Vrai `claude.exe` sur un profil temporaire déconnecté |
| Navigateur | `npm run test:browser` | Composants de l’interface dans Edge |
| Bout en bout | `npm run test:e2e` | Vrai serveur + faux Claude Code + Edge piloté par playwright-core |
| Dépendances | `npm run vendor-audit` | Fichiers servis au navigateur = graphe d’imports |

Aucun test automatisé n’appelle de modèle ni ne touche un vrai profil Claude : les profils sont créés sous `%TEMP%` et supprimés ensuite. Les enregistrements de référence (`test/fixtures/`) ne gardent que la structure de vraies sessions.
