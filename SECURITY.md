# Politique de sécurité

## Versions prises en charge

| Version | Prise en charge |
|---|---|
| 0.1.x | Oui |

## Signaler une vulnérabilité

Merci de **ne pas ouvrir de ticket public** pour une faille de sécurité.

Utilisez les avis de sécurité privés de GitHub : onglet **Security › Advisories › Report a vulnerability** du dépôt ([lien direct](https://github.com/zubulmuk92/SidMultiClaude/security/advisories/new)). Indiquez :

- la version (ou le commit) concernée et votre version de Windows, de Node.js et de Claude Code ;
- une description du problème et de son impact ;
- les étapes pour le reproduire, si possible minimales.

Ne joignez jamais de jeton, d’identifiant ni de transcription contenant des données personnelles. Vous recevrez un accusé de réception dès que possible ; le correctif et l’avis public seront coordonnés avec vous.

## Modèle de menace (résumé)

SidMultiClaude est une application **locale, mono-utilisateur**. Les protections visent avant tout les autres sites ouverts dans un navigateur, les autres processus de la machine et le contenu non fiable affiché dans l’interface (réponses du modèle, sorties d’outils, fichiers).

| Risque | Protection |
|---|---|
| Accès au serveur depuis le réseau | Écoute de `127.0.0.1` uniquement ; refus de `::1` et du réseau local. |
| Site web malveillant qui contacte le serveur local | `Host` et `Origin` exacts, aucun en-tête CORS, aucun cookie ; WebSocket authentifié par un code d’amorçage à usage unique (60 s) puis un jeton d’appareil comparé à temps constant. |
| Injection de code dans l’interface (Markdown, sorties d’outils) | CSP stricte avec Trusted Types ; un seul point d’injection HTML (marked puis DOMPurify) ; tout le reste en nœuds texte ; images distantes retirées. |
| Messages du client malformés | Validation stricte de chaque message (champs inconnus refusés, tailles bornées, formats d’identifiants vérifiés). |
| Exécution de commandes | Aucun shell : `spawn`/`execFile` avec des tableaux d’arguments et des chemins absolus. |
| Accès à des fichiers hors du périmètre | Politique des dossiers de travail et confinement des chemins (UNC, périphériques, noms réservés, flux alternatifs, liens). |
| Fuite de secrets | `.credentials.json` jamais ouvert (simple `stat`), fichiers `*.key` jamais lus, environnement du serveur jamais transmis à la page, journaux expurgés et sans contenu de message. |
| Modification des profils Claude | Aucune écriture de l’application dans un profil ; seul Claude Code y écrit. Une garde d’écriture le vérifie dans les tests. |
| Chaîne d’approvisionnement | Versions épinglées, `package-lock.json`, `npm ci --ignore-scripts --omit=optional`, contrôle des fichiers servis (`npm run vendor-audit`), utilitaires `.exe` compilés depuis les sources du dépôt avec empreinte SHA-256. |
| Actions dangereuses | Le mode contournement des autorisations exige une saisie explicite et n’est jamais restauré automatiquement ; jamais de bouton « Autoriser » dans les notifications. |

Hors périmètre : un attaquant qui contrôle déjà la session Windows de l’utilisateur, et le comportement de Claude Code lui-même (à signaler à Anthropic).

Le détail des exigences et des tests associés figure dans la [spécification](docs/design/SPEC.md) (§10) et dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
