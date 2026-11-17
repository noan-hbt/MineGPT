# Run B5 (1 h) + pistes d'architecture — 2026-11-17

## Résultat du run B5 (`localai-b5run`, `longrun.js` 60 min)

Objectifs atteints (6/10), tous avant 27 min :
3 torch (10.6 min) · iron_pickaxe (12.7) · 16 torch (13.4) · shield (13.5) · bucket (14.8) · diamond_pickaxe (26.9).
`diamond_sword` jamais obtenu → `golden_apple` jamais commencé.

- **Blocage 27 → 60 min** : 47 diamants ramassés (l'épée en demande 2), `craft diamond_sword` jamais tenté.
  Le LLM a fait 48× `wait 1` (dont 17 d'affilée) et a tourné entre les minerais (diamant 25×, fer 13×, lapis 10×, or 6×).
- **Watchdog** : 5 événements `stuck`, escalade jusqu'à 4 — n'a jamais débloqué le bot. Rien de spécial ne se passe
  quand les escalades s'accumulent (chaque escalade = un nouveau ban de 10 min, l'objectif n'est jamais abandonné).
  Les bans retirent les actions préférées du LLM sans lui donner de meilleure option → il se rabat sur `wait 1`.
- Premier déclenchement (`collect oak_log`, ~25 collectes) : bûches en trop, `planCost` ne baisse plus quand le
  besoin est couvert. Le déclenchement `deepslate_diamond_ore` n'était **pas** dû à un minerai inaccessible
  (contrairement à HANDOFF.md) : sur-collecte, chaque collecte rapportait des diamants.
- 2 morts (zombie) ; le correctif e75bb50 n'était pas dans cette copie. Le test de redémarrage a fonctionné (2 redémarrages, l'objectif est bien repris).
- Échecs principaux : `collect` arrêté par timeout ×9, furnace refusé par le serveur ×3.
- Ordre du log : la ligne `[ctl] banned` s'affiche *avant* la ligne de l'action qui l'a provoquée (le ban est
  calculé dans `act()`, la ligne d'action est écrite après). Les bans sont bien respectés.

**Verdict** : B5 non validé (critère « pas de boucle infinie » raté). B1/B5 non cochés.
Logs gardés dans `..\localai-b5run\mcbot\logs` = bon matériau pour des paires DPO (mauvaise action ↔ `craft diamond_sword`).

## Décision de l'utilisateur

**Ne pas ajouter de règles en dur** (ex. retirer `collect X` quand le plan n'en a plus besoin). L'utilisateur veut que les
modèles décident ; le code ne garde que les réflexes de survie et la sécurité. Le blocage vient d'un LLM
trop faible pour décider seul, pas d'un manque de liberté.

## Pistes discutées

### Fine-tuning (cf. B11–B16)
- Partir des poids HF bf16 (pas du GGUF Q4) ; LoRA via TRL/PEFT ou Unsloth ; rank 16–32, lr 1e-4–2e-4, 1–3 epochs,
  loss uniquement sur la réponse ; 2–5k exemples suffisent pour le comportement.
- Distillation par un gros modèle : pertinente. Le jeu sert de juge (on garde uniquement les actions de l'enseignant qui
  réussissent en jeu). Pour un 1.7B : entraîner sur l'action seule ou une raison d'une ligne, pas sur un long raisonnement.
- Replay 5–30 % (réponses du modèle de base à des prompts variés) pour limiter l'oubli. Format de prompt = prod exacte.
- Ce qu'on peut attendre : comportement et tool calling = gain fort ; connaissances = gain faible (garder le planner/RAG).

### Spécialisation complète Minecraft
- Possible, mais l'oubli ne libère pas de capacité utile : ce sont les données Minecraft qui spécialisent.
- À garder absolument : compréhension du chat FR/EN (intents B7), suivi d'instructions, format, raisonnement minimal.
- Pipeline : (opt.) pré-entraînement continu sur du texte MC → SFT → DPO / RL avec le banc B6 comme récompense.
  C'est la voie pour supprimer à terme le watchdog et les bans.

### Architecture en couches (idée de l'utilisateur)
| Couche | Rôle | Fréquence | Modèle |
|---|---|---|---|
| Stratège | Chat, ordres, découpage en sous-objectifs, déblocage | Rare | LLM 7–8B Q4 (~5 Go) en local, ou API |
| Exécutant | Sous-objectif + état → action | Chaque action | Petit réseau de politique créé de zéro (= B19) ou LFM + LoRA |
| Réflexes | Fuir, manger, remonter respirer | Immédiat | Code |

- **Le watchdog appelle le stratège au lieu de bannir** des actions (contexte : « 20 actions sans progrès,
  inventaire… »). Remplace l'escalade codée en dur par une vraie décision.
- Le planner B2 reste un outil du stratège (recettes exactes).
- Un exécutant entraîné de zéro ne comprend pas de texte : c'est un classifieur sur `obs.state` + sous-objectif,
  qui score les options légales de la grammaire. Il fait de 100k à quelques M de paramètres, s'entraîne en minutes
  sur 8 Go et répond en moins d'1 ms sur CPU. Il a besoin de beaucoup d'exemples propres (>10k idéal) et ne
  généralise pas à de l'inédit, d'où le stratège.
- 3 niveaux de LLM = probablement trop. Avec un exécutant de zéro, LFM ne servirait plus qu'au chat rapide si le 7–8B est trop lent.
- Contrainte : 8 Go de VRAM. Tient : 7–8B Q4 + LFM Q4 (~6,5 Go, contexte court), LoRA/QLoRA 1.7B, réseau de politique.
  Ne tient pas : fine-tune complet d'un 1.7B. Attention si le client MC utilise aussi le GPU.
- Points à trancher : choix du stratège (local ou API) ; format stratège → exécutant (texte libre ou liste structurée).

### Rappel B21
L'écriture directe dans les poids a déjà été testée et **fermée** (MEMIT −24 pts, LoRA-faits −37 pts, `b21/REPORT.md`).
Raison de fond : une compétence est distribuée dans les poids, une modification locale a des effets partout, et
le gradient trouve mieux la bonne direction que nous.

### Données pour l'exécutant (décidé, protocole dans ROADMAP B19)
- Cible : 100k–1M exemples. Le temps de jeu réel est le facteur limitant (~15 s par action, 1 bot à la fois →
  ~2-3k états réels par nuit) → le gros du volume viendra d'états synthétiques ou de variantes des logs.
- Comparer 4 sources : (A) DeepSeek synthétique, (B) LFM seul en essais-erreurs (avis de l'utilisateur : « pas ouf »,
  gardé comme référence), (C) LFM joue + DeepSeek étiquette (DAgger), (D) A puis C.
- Enseignant : **probablement Command Code avec `deepseek-v4.1-flash-1017`**, via l'abonnement de l'utilisateur au
  lieu de l'API payante (voir B12).
- Faire d'abord un pilote de 10k exemples pour mesurer la qualité et le débit avant de monter en volume.

## Prochaine étape proposée
Script d'extraction : logs → triplets (état, sous-objectif, action) filtrés + comptage des exemples exploitables.
Sert pour tous les scénarios (LoRA, DPO, réseau de politique B19).
