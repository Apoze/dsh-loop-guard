# dsh-loop-guard

Protection anti-boucle complémentaire pour DeepSeek Harness **0.2.0-rc.1**, testée avec le fournisseur NInfer natif. Elle ne remplace ni le comptage exact ni `dsh-generation-recovery`, et ne modifie pas NInfer.

## Comportement

- Interrompt les répétitions de réflexion ou de réponse pendant le streaming : texte consécutif et paragraphes identiques, y compris avec numérotation différente.
- Détecte la stagnation entre étapes par similarité des mots et une réflexion rejetée puis reproduite. Ce n'est pas un classificateur sémantique.
- Refuse avant exécution les cycles d'outils (appel identique ou séquence répétée), les relectures identiques devenues majoritaires, et les recherches du même motif dans trop d'emplacements.
- Une tentative de génération rejetée reste intégralement dans `assistant/attempt` mais n'entre pas dans le contexte suivant. Aucun outil de cette tentative n'est exécuté. Les actions antérieures sont préservées.
- Le transport est fermé avant la reprise. Deux reprises de flux et trois blocages d'outils au maximum par séquence utilisateur ; l'épuisement termine explicitement le travail en erreur, sans prétendre avoir réussi.
- Une annulation utilisateur ne déclenche aucune reprise. Un nouveau message utilisateur réinitialise les compteurs. Les agents sont indépendants ; le rechargement du plugin réinitialise son état local.
- Les notices ne contiennent ni arguments d'outils ni extraits de réflexion. Le journal DSH original conserve naturellement les contenus du modèle, selon sa politique habituelle.

## Faux positifs et contrôles

Les blocs de code clôturés par ``` ou ~~~ sont exclus des détecteurs de texte. Les plages de lecture différentes ne sont pas des relectures identiques. Une écriture/édition réussie invalide les lectures mémorisées ; un résultat nouveau réinitialise l'historique de stagnation. Les outils de polling déclarés dans `exemptTools` ne sont pas bloqués. Les exemptions continuent de casser l'adjacence des cycles d'autres outils.

`/loop-guard` ou `/loop-guard status` affiche les compteurs. `/loop-guard reset`, `/loop-guard off`, `/loop-guard on` agissent uniquement sur la conversation courante, lorsqu'elle est inactive. Le réglage on/off dure jusqu'au déchargement de l'agent/processus ; il est enregistré comme commande DSH mais n'est pas restauré après redémarrage. Un nouveau message remet les compteurs à zéro sans annuler off.

Une répétition volontaire de prose peut déclencher la protection : utiliser off pour ce travail. Les appels shell ne sont pas interprétés pour deviner leurs lectures/écritures ; les cycles exacts de `bash` restent détectables. Les appels PTC passent dans le pipeline natif, mais le texte interne d'un programme PTC n'est pas analysé. La protection ne prouve pas l'absence de toute boucle. Les blocs antérieurs déjà acceptés ne sont pas réécrits ; seule la tentative rejetée est retirée du contexte.

## Configuration

Le bundle apporte l’entrée Cordis. Personnaliser uniquement sa configuration :

```yaml
- id: loop-guard
  config:
    providers: [ninfer-local]
    maxRecoveriesPerTurn: 2
    maxToolBlocksPerTurn: 3
```

Le rappel natif `repeat-tool-reminder` reste actif. Son contexte additionnel est retiré uniquement lorsqu'il doublerait un refus de ce plugin. Les autres fournisseurs et plugins ne sont pas affectés. Les limites de `generation-recovery` restent indépendantes et inchangées.

| Réglage | Défaut | Usage |
|---|---:|---|
| thinkingMinChars / outputMinChars | 120 / 200 | Taille minimale d'un motif |
| textRepeats | 3 | Répétitions consécutives |
| maxTextWindow / checkStride | 16000 / 64 | Mémoire texte bornée / intervalle de contrôle |
| paragraphMinChars / paragraphRepeats | 120 / 3 | Paragraphes complets normalisés |
| stagnationSteps / stagnationMinChars / similarity | 4 / 600 / 0.92 | Historique de réflexion ; 0 étapes désactive |
| toolCycleRepeats / maxCycleLength | 3 / 8 | Cycles d'appels complets |
| toolHistorySize / evidenceHistorySize | 64 / 256 | Limites des historiques |
| rereadWindow / rereadRatio | 12 / 0.75 | Plages identiques relues ; fenêtre 0 désactive |
| searchScopeLimit | 8 | Emplacements déjà visités pour un motif ; 0 désactive |
| fileReadLimit | 0 | Plafond par chemin désactivé : ne pas pénaliser la pagination |
| readTools / searchTools / mutationTools | read / grep,glob / write,edit,apply_patch | Noms exacts, configurables |
| exemptTools | job_wait, job_status, terminal_read, terminal_wait, sleep | Polling explicite |

Les noms de fichier sont comparés tels que fournis : aucun accès disque additionnel ni normalisation dépendante du Mac, afin de respecter les environnements distants. Les compteurs d'évidence bornés peuvent oublier les plus anciennes entrées. Les numéros de ligne ne sont pas supprimés des arguments. Tous les réglages sont validés ; une configuration incohérente échoue au chargement.

## Développement et validation

Node 24.19.0 et TypeScript 6.0.3 utilisés localement. Les dépendances DSH sont les versions de l'installation existante, sans nouvelle chaîne d'exécution. `npm run build` compile strictement ; `npm test` exécute les détecteurs et le pipeline SDK réel, avec seulement le serveur HTTP modèle simulé. `DSH_INSTALL` permet de sélectionner le runtime installé pour ces tests. Les tests créent des homes/workspaces temporaires, ferment leurs serveurs et conservent les sessions pour diagnostic.

`scripts/live-smoke.mjs` utilise explicitement le NInfer de l'utilisateur et le bundle du profil SDK ; il n'arrête aucun service. `LOOP_GUARD_ARTIFACT` peut remplacer l'entrée existante pour un essai isolé, sans seconde insertion. `LOOP_GUARD_OUTPUT` choisit le dossier des preuves. `scripts/deploy.mjs` fabrique un snapshot versionné depuis les fichiers compilés, sans modifier les configurations. L'activation et son rollback sont documentés dans le rapport local de déploiement.

Les tests de pipeline chargent les trois bundles dans un profil SDK temporaire. `DSH_NINFER_PACKAGE`, `DSH_RECOVERY_PACKAGE` et `LOOP_GUARD_PACKAGE` permettent de vérifier les paquets déployés exacts ; sinon ils utilisent les dépôts sources voisins et le dépôt courant.

Les détecteurs sont des fonctions/classes pures dans `detectors.ts`. `index.ts` possède la politique, les compteurs par agent et les événements DSH. Aucun fork du convertisseur, du moteur GPU, de la boucle DSH ou du plugin de reprise.

## Gestionnaire de plugins DSH

Le paquet déclare un bundle natif (`dsh.bundle.patch`) : il apparaît dans **Plugins → Installed**, avec activation/désactivation et désinstallation du profil. Installer le dossier construit avec `dsh plugin --profile web add /chemin/du/paquet`. Aucune publication GitHub ou npm n’est nécessaire.

Le bundle est le seul propriétaire de l’entrée `loop-guard`. Ne pas conserver une ancienne directive `insert` pour cette même entrée : remplacer celle-ci par un patch `id`/`config`, sans `name`. Les réglages utilisateur restent hors du paquet. Les interrupteurs agissent sur le profil sélectionné ; ne pas désactiver pendant une génération.

Le bundle cible `ninfer-local` par défaut. Désactiver ce bundle retire cette protection, sans désactiver les autres protections ni changer leurs budgets. `/loop-guard off` reste un contrôle par conversation, distinct du bouton global du bundle anti-boucle.
