# Historique des versions

Ce fichier suit le format [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

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
