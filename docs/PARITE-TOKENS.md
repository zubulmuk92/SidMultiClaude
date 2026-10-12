# Parité de tokens avec Claude Code

SidMultiClaude promet de ne jamais consommer plus de tokens que Claude Code pour le même travail. Ce document donne les mesures réelles de l’application finale, la méthode suivie et les mécanismes qui garantissent la parité dans la durée.

## Résultats

Mesures du 9 octobre 2026 : un compte Team, modèle `haiku`, Claude Code 2.1.295 natif.

| Mesure | Application | Référence | Résultat |
|---|---|---|---|
| Premier message d’un nouveau chat (tokens d’entrée) | **37 276** | **37 343** avec `claude -p`, même dossier | 67 tokens de moins que Claude Code |
| Deuxième message, même processus | **37 274** lus depuis le cache, **2 203** écrits | — | Seul le nouveau tour est écrit dans le cache |
| Appels cachés (titre par IA, appels hors boucle principale) | **aucun** | — | Sentinelle `auxTokens` à 0 |
| Interruption pendant la réponse | **0** token | — | Le processus reste vivant |

Lecture des résultats :

- L’application envoie les mêmes requêtes que Claude Code. Le léger écart en sa faveur vient très probablement de l’exclusion, par défaut sur les comptes autres que le profil par défaut, du `CLAUDE.md` du profil par défaut que Claude Code charge comme instructions d’un dossier parent ; les 3 outils d’interaction ajoutés (voir plus bas) le compensent en partie.
- Au deuxième message, la quasi-totalité du contexte est relue depuis le cache : garder le processus vivant évite de recréer le cache à chaque tour.

## Méthode

### Mesure réelle (manuelle et volontaire)

Le script `scripts/smoke.ts` (`npm run smoke`) n’est jamais lancé par les tests automatisés. Il exige `$env:SMC_SMOKE='1'`, utilise un vrai profil (variable `SMC_SMOKE_CONFIG_DIR`), le modèle `haiku`, et un fichier de budget qui interrompt tout au-delà de **8 requêtes d’API**. Les dossiers de travail sont temporaires, jamais le projet.

Scénario de parité (S1) :

1. Nouveau chat lancé par le moteur de l’application, dans un dossier temporaire : relevé de `usage`. Les « tokens d’entrée » comparés sont la somme des tokens d’entrée, lus depuis le cache et écrits dans le cache.
2. Deuxième message dans le **même** processus : la lecture du cache doit dépasser 30 000 tokens et l’écriture rester sous 4 000 tokens (le nouveau tour seulement, jamais une recréation du préfixe d’environ 37 000 tokens).
3. Une requête `claude -p` dans le **même** dossier, avec le même profil : écart toléré de 100 tokens d’entrée au plus.
4. Journal de débogage de Claude Code (`--debug-file`) : une ligne `[API REQUEST]` par requête, ce qui permet de vérifier qu’aucune requête de titre ou autre appel caché n’a lieu.
5. Sentinelle `auxTokens` = somme des tokens de tous les modèles (`modelUsage`) moins l’usage de la boucle principale : elle doit valoir 0.

Le scénario S2 interrompt une réponse en cours et vérifie un usage nul et un processus toujours vivant.

### Vérification continue sans token

Ces tests tournent avec `npm run test:parity` et ne consomment **aucun** token d’abonnement :

| Test | Principe |
|---|---|
| T-P1 | Instantané des options du SDK pour chaque type de lancement (nouveau, reprise, bifurcation, retour en arrière), profil par défaut ou non, mode contournement ou non. Toute dérive fait échouer le test. |
| T-P2 | Un faux `claude.exe` (`test/fakes/fake-claude.mjs`) derrière le **vrai** SDK enregistre les arguments, les **noms** des variables d’environnement et le message d’initialisation. |
| T-P3 | Une fausse API Messages capture le corps complet des requêtes de l’application et de `claude.exe -p` dans le même dossier, avec une configuration temporaire sans identifiants, puis les compare. |
| T-P4 | La sentinelle `auxTokens` signale un appel de titre enregistré et vaut 0 sur les enregistrements ordinaires. |

La référence de T-P3 est Claude Code quand il répond lui-même aux demandes d’autorisation (le terminal interactif, ou `claude -p --output-format stream-json --input-format stream-json --permission-prompt-tool stdio`). Le corps de requête de l’application doit lui être identique, à l’en-tête de facturation près et aux durées maximales citées dans la description des outils Bash, PowerShell et Monitor. Par rapport à `claude -p` sans hôte, l’application ajoute exactement les 3 outils d’interaction (AskUserQuestion, EnterPlanMode, ExitPlanMode) : avec un abonnement, ils sont différés derrière ToolSearch, soit environ +17 tokens par requête ; avec une clé d’API, ils sont décrits en entier.

## Ce qui garantit la parité

- **Un seul constructeur d’options** (`src/server/engine/options.ts`) : invite système `claude_code`, sources de réglages `user`, `project` et `local`, mode de permission explicite, aucune option qui changerait les requêtes sans choix de l’utilisateur.
- **Pas de titre par IA** : `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` dans l’environnement de chaque processus, sauf si *Réglages › Titres IA* est activé.
- **Cache chaud** : un processus vivant par chat actif, mis en veille seulement après expiration de son cache (1 h par défaut) ; jamais de mise en veille d’un cache chaud sans accord.
- **Coûts annoncés** : réveiller un chat endormi recrée son cache (de l’ordre de tout l’historique) ; l’estimation s’affiche avant. Les actions qui coûtent volontairement des tokens portent la mention « ↯ modèle ».
- **Contrat avec le vrai `claude.exe`** (`npm run test:contract`) : à relancer après chaque mise à jour de Claude Code pour détecter une dérive des options acceptées ou des messages d’initialisation.

## Limites

- La parité porte sur Claude Code en mode hôte (`-p` / SDK), pas sur l’interface interactive du terminal, dont la ligne d’identité diffère et qui fait davantage d’appels cachés (suggestions de prompt, titres).
- Sur un profil dont les hooks `SessionStart` injectent un texte qui varie à chaque lancement (par exemple des plugins d’organisation), chaque nouveau processus recrée le cache après ces hooks. Le terminal paie le même coût ; seul le maintien du processus vivant l’évite.

## Pour aller plus loin

La recherche initiale, en anglais, détaille la répartition des tokens, chaque différence entre `claude -p` et le SDK, le comportement du cache et les leviers d’économie : [design/TOKEN-RESEARCH.md](design/TOKEN-RESEARCH.md).
