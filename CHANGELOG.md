# Historique des versions

Ce fichier suit le format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- **Tableau de bord** : vue d’accueil du volet vide (et dialogue depuis le nom de l’application ou `Ctrl+K`) avec quatre chiffres clés, une carte par compte (jauges d’usage, chats par jour de dernière activité sur 14 jours), les chats à traiter et les plus récents. Calculé à partir des données déjà reçues par la fenêtre : aucune requête, aucun token.

### Modifié

- **Nouvelle présentation de l’interface**, en thème clair et sombre : volets en feuilles arrondies sur un fond teinté, barre latérale et onglets allégés, texte des conversations limité à une largeur de lecture, dialogues et menus redessinés.
- **Icônes vectorielles partout** à la place des emojis et des pictogrammes texte (cloche, réglages, états des chats, étoile, dossiers, flèches de menu…) : un seul jeu d’icônes au trait, qui suit la couleur du texte et le thème. Les raccourcis s’écrivent en toutes lettres (« Entrée »).
- **La couleur du compte devient le fil conducteur** : bulle de vos messages, bouton *Envoyer*, contour du volet actif et de la zone de saisie.
- Lignes de la barre latérale un peu plus hautes (30 px, 44 px en densité confortable) ; libellés de section et noms de compte sans majuscules forcées.

### Corrigé

- Une palette `/` ou `@` qui s’ouvre sous le pointeur immobile ne change plus la sélection faite au clavier.
- Les pastilles de compte restent lisibles en thème sombre.

## [0.1.0] - 2026-10-12

Première version publique.

### Ajouté

- **Multi-comptes** : un compte par profil Claude Code (`~\.claude`, `~\.claude-<nom>`), avec nom, couleur et monogramme ; fenêtre de bienvenue et panneau *Comptes* ; connexion par `claude.exe auth login`.
- **Chats côte à côte** : onglets, volets, barre latérale groupée par compte et par dossier, sélecteur rapide (`Ctrl+K`).
- **File « À traiter »** : demandes d’autorisation, questions et plans en attente, tous comptes confondus.
- **Zone de saisie** : file de messages, palette de commandes `/`, mentions `@`, pièces jointes, historique, brouillons conservés.
- **Cycle de vie des chats** : reprise de sessions existantes, renommage, épinglage, retour en arrière, bifurcation, *Continuer sur un autre compte*, *Ouvrir dans le terminal*.
- **Suivi de l’usage** : jauges par compte, contexte et état du cache de chaque chat, coût estimé des actions qui consomment des tokens.
- **Parité de tokens** avec Claude Code : mêmes requêtes, aucun appel caché, cache gardé chaud, sentinelle par tour (voir [docs/PARITE-TOKENS.md](docs/PARITE-TOKENS.md)).
- **Sécurité** : serveur limité à `127.0.0.1`, code d’amorçage à usage unique puis jeton d’appareil, aucune lecture de jeton ni écriture dans un profil Claude.
- **Installation** : raccourcis Bureau et menu Démarrer, lanceur sans console et isolation par *Job* Windows facultatifs (`npm run install-app`).
- **Tests** : unitaires, intégration, parité, contrat, navigateur et bout en bout, sans aucun appel de modèle.

[0.1.0]: https://github.com/zubulmuk92/SidMultiClaude/releases/tag/v0.1.0
