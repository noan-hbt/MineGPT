# ROADMAP — Bot Minecraft spécialisé, vocal, entraîné (décidé 2026-11-17)

État actuel du projet : voir `HANDOFF.md`. Ce fichier = plan découpé en blocs. Cocher au fur et à mesure.

## Décisions prises
- **Option A** : 1 seul llama-server, base LFM3-1.7B + **2 adaptateurs LoRA** (`decider`, `chat`) choisis par requête
  (llama-server `--lora ... --lora-init-without-apply` + champ `lora` par requête — à vérifier sur b12445).
  Pas de 2e process GPU (3 instances = 0 tok/s, déjà testé).
- Contrôle moteur reste dans **mineflayer** (pas de RL pixels/VPT). Modèle apprend *quoi faire / quand / pourquoi*.
- Bot = joueur mineflayer (pas PNJ moddé).
- **Modèle prof autorisé** : DeepSeek API (rapide, pas cher → favori pour génération en masse)
  ou ChatGPT via l'abonnement de l'utilisateur (passe maintenant par l'API). Choix final à B12.
- **Modèle de base confirmé : LFM3-1.7B** (comparatif 2026-11-17, carte HF) : meilleur BFCL V4 (71.4 vs Qwen3.5-4B 55.1,
  MiniCPM5-2B 62.7, Gemma 4 E4B 48.3) et IFEval (96.7), τ³ ≈ MiniCPM5-2B, 2x plus petit que Qwen3.5-4B → plus rapide.
  Faiblesses : savoir (GPQA 63 vs 76 Qwen3.5-4B) et long contexte (RULER128K 66) → compensés par mémoire + LoRA.
  Fine-tune officiel via TRL (notebooks SFT/DPO/GRPO/CPT), `trust_remote_code=True`. Poids HF bf16 dans
  `models/LFM3-1.7B-hf/` (model.safetensors 3,46 Go).
- Voix : pipeline modulaire STT → LLM → TTS (pas speech-to-speech de bout en bout).
- Sortie finale : **app de contrôle** (prioritaire) + **mod Fabric** (option, plus tard).

- **Référence d'architecture : Mindcraft-CE** (bot mineflayer + LLM open source : skills, mémoire, chat). S'en inspirer pour
  B3/B4/B7, mais **pas de fork** : prompts longs + génération de code JS = trop lent en local vs notre grammaire (~150 ms).

## Architecture cible
```
voix ─► STT ─► LLM[chat LoRA] ─► TTS ─► haut-parleurs
                  │ (intention → goal)
                  ▼
réflexes (code) ► LLM[decider LoRA] choisit skill ► planif recettes + skills (code) ► mineflayer
                  ▲                                         │
                  └──── mémoire (world.json, épisodes, pile tâches) ◄─ résultats
tout ─► logs JSONL ─► dataset ─► LoRA (rounds nocturnes) ─► éval RCON
```

---

## Blocs

Format : **ID — nom** · priorité (P1 haut) · dépend de · livrables · critère « fini ».

### Fondations bot
- [ ] **B1 — Log des décisions** · P1 · —
  Chaque tick → `mcbot/logs/*.jsonl` : obs structurée + obs texte, options valides, action choisie, source (llm/réflexe/hint), résultat, durée, état après.
  Fini : 1 h de jeu = fichier exploitable, script `stats.py` qui résume taux de réussite par action.
- [x] **B2 — Planificateur de recettes** · P1 · —
  Solveur sur `minecraft-data` (recettes, fours, tiers d'outils) : objectif item → liste ordonnée de sous-tâches. Remplace la progression codée en dur.
  Fini : `plan("iron_pickaxe")` depuis inventaire vide donne plan correct ; bot l'exécute.
  ✔ 2026-11-17 : test live paisible (inventaire vidé) → stone pickaxe en 25 actions, plan suivi. Exécution imparfaite → B3.
- [ ] **B3 — Bibliothèque de skills** · P1 · B2
  Skills paramétrés robustes (timeout, retry, raison d'échec) : `gather(item,n)`, `craft`, `smelt`, `mineOre(type)`, `buildShelter`, `sleep`, `farm`, `eat`, `fight`, `flee`, `explore`, `goHome`, `storeInChest`, `follow`, `come`.
  Fini : chaque skill a un test RCON (B6) qui passe.
  ⏳ 2026-11-17 : branche `b3-skills`, `skills.js` + `test_skills.js` (19/19 en arène, mine réel ~2/3), branché dans bot.js, reste test live.
- [x] **B4 — Mémoire longue** · P1 · B1
  `world.json` (base, lit, coffres+contenu, minerais vus, morts, biomes), journal d'épisodes résumé toutes les N actions (résumé par LLM), pile de tâches. Injection sélective (<2k tokens de prompt).
  Fini : redémarrage du bot → il retrouve sa base et reprend sa tâche.
  ⏳ 2026-11-17 : branche `b4-memory` (depuis `b3-skills`). `mcbot/memory.js` → `mcbot/memory/<nom>.json` : home (sethome ou 1re table posée),
  pile de tâches (goal interrompu repris quand le nouveau est fini), minerais/stations/lits/coffres vus (+ contenu déposé), morts,
  épisodes (résumé LLM toutes les 20 actions, async). Prompt : lignes Home/Remembered/Chest/Earlier. Verbe `goto <ore>` (minerai mémorisé
  non visible). Chat `tasks`, `memory`. `test_memory.js` OK. Live : redémarrage sans `--goal` → reprend iron_pickaxe + home vu. Reste : session longue.
  Session longue auto (`localai-b4run/mcbot/longrun.js`, joueur spectateur « Tester », 30 min avant arrêt mémoire système) :
  ✔ `tasks`/`memory` en chat, ✔ pile (`goal 3 torch` → atteint → reprend iron_pickaxe), ✔ `sethome` + kill → « back online » +
  home retrouvé, ✔ 20 épisodes résumés LLM, ✔ iron_pickaxe atteint. Pas vu : mémoire coffre, `goto` minerai. Bug corrigé : faux
  « resuming » au redémarrage quand la pile est vide.
- [ ] **B5 — Boucle décision hiérarchique** · P1 · B2 B3 B4
  Réflexes (code) > LLM décideur appelé seulement sur fin/échec de tâche ou événement > exécution skill. Le décideur choisit un *skill+arg*, plus une action unitaire. Grammaire dynamique conservée.
  Fini : session 1 h autonome sans boucle infinie, progression au-delà de stone pickaxe.
  ⏳ 2026-11-17 : `mcbot/control.js` (+ `test_control.js` 7/7). Tâche = skill+arg ; collect/mine répétés sans LLM tant que
  l'étape du plan ne change pas (max 6) ; fin sur échec / événement (danger, nuit, nouveau goal, PV −4). Bans glissants
  (échec 3× sur 12 actions → 5 min, pas seulement consécutifs) ; watchdog progrès = coût restant du plan, 20 actions sans
  baisse → ban de l'action dominante 10 min + rotation explore. Hint/grammaire ignorent les actions bannies. Réflexe noyade `surface`.
  Live (bot LFM5, inventaire vide, paisible) : iron_pickaxe en 22 actions / 4,6 min, puis diamond_pickaxe en 26 actions / 7 min
  (1 mort lave en explore). Run « 1 h » (`--goals` = file de 6 objectifs) : bans live OK (explore bloqué, `place crafting_table`
  refusé 3× → `goto crafting_table` mémorisé → iron_helmet, puis torches). Ajouts : `explore up` (escalier vers le ciel, nage si
  eau, creuse à la main pour le passage), `goto crafting_table|furnace`, `--goals a,b,c`. Arrêté par manque de RAM avant 1 h.
  Watchdog « no progress » jamais déclenché en live. Reste : vraie session 1 h (1 seul bot, RAM libre).
  Bug B3 vu : 2 morts soudaines (PV 20→0) en `explore` souterrain (lave ?).
  ⏳ Run 1 h n°2 (session 3, bot B5RUN, worktree `localai-b5run`) : 6 objectifs atteints en 27 min (dont diamond_pickaxe),
  watchdog déclenché 2× en live, redémarrage OK. Bugs corrigés sur `b6-b7` : bois (acacia vs chêne), case de pose
  refusée, marche interrompue par un danger (la « mort lave » = zombie). Reste : fin du run → stats → cocher.
  Vu sur l'ancien code (session B4) : boucle `collect coal_ore` (« no reachable ») ↔ `explore south` 123×, sous l'eau → motivé bans + `surface`.

### Évaluation
- [ ] **B6 — Banc d'éval RCON** · P1 · B1
  Scénarios scriptés (RCON :25575) : reset/tp/clear inventaire/give, puis mesure. Ex : temps → iron pickaxe, survie 1re nuit (difficulté normale), retrouver base, obéir à 10 ordres chat. Sortie : tableau score par version de modèle.
  Fini : `python eval.py --model X` → rapport reproductible.
  ⏳ 2026-11-17 : `mcbot/eval.js` (Node : joueur « Judge » nécessaire) sur branche `b6-b7`, 4 scénarios iron/night/home/orders,
  `--report`. Pas encore lancé en live.
- [ ] **B6b — Comparatif de modèles sur le banc** · P2 · B6
  Mêmes scénarios pour : LFM3-1.7B (base puis + LoRA), MiniCPM5-2B, Qwen3.5-4B, **Mindcraft-CE/Andy-4.2-Air** (4B, spécialisé
  Minecraft, GGUF Q4 ~2,7 Go). Attention : Andy = entraîné au format de commandes Mindcraft (`!collectBlocks`...) → prévoir un
  adaptateur de prompt, sinon comparaison injuste. Télécharger les GGUF Q4 seulement à ce moment-là (réseau lent).
  Changer de base seulement si un modèle bat LFM3+LoRA nettement, avec une latence acceptable.
  Écartés (vérifié 2026-11-17) : Andy-4.2 Micro (non testé, 2 748 ex.), Andy-4.1 (boucles signalées), MineMA-8B (trop gros),
  NanoAndy-350M (anglais seul, base LFM2.5-350M → éventuel candidat B19), « Minecraftism 4B » (introuvable).

### Chat & voix
- [ ] **B7 — Chat LLM (texte)** · P1 · B4
  Slot séparé, async, ne bloque pas la boucle. Répond en jeu, peut émettre une intention (`goal ...`, `stop`, `follow`...). Personnalité + mémoire (B4). Thinking autorisé pour le chat.
  Fini : conversation naturelle FR en jeu + ordres exécutés.
  ⏳ 2026-11-17 : `mcbot/chat.js` (JSON {intent,arg,say}, slot 1) sur `b6-b7`. test_chat 18/22 (inédits 6/10). Pas encore testé en jeu.
- [ ] **B8 — STT** · P2 · —
  whisper.cpp / faster-whisper (`small` ou `large-v3-turbo`, FR), VAD Silero ou push-to-talk. Préférer CPU pour libérer le GPU ; mesurer.
  Fini : <500 ms après fin de phrase, FR correct.
- [ ] **B9 — TTS** · P2 · —
  Kokoro ou Piper (voix FR), CPU, streaming par phrase.
  Fini : 1er son <300 ms après 1re phrase LLM.
- [ ] **B10 — Pipeline vocal** · P2 · B7 B8 B9
  Micro → STT → chat → TTS, interruption (barge-in) si je reparle. Mesurer latence bout-en-bout (cible ≤1,5 s).

### Données & entraînement
- [ ] **B11 — Vérif faisabilité fine-tune** · P1 · —
  Vérifier support LFM3 dans transformers/Unsloth/PEFT, télécharger poids HF bf16 (~3,4 Go, downloads lents → lancer tôt), test LoRA jouet sur 4070, conversion LoRA → GGUF (`convert_lora_to_gguf.py`), chargement dans llama-server avec base QAD-Q4_0 (sinon base Q8_0/Q4_K_M ; re-mesurer tps).
  Fini : un LoRA bidon entraîné, servi, appliqué par requête.
- [ ] **B12 — Client modèle prof** · P2 · —
  Wrapper DeepSeek API (clé en variable d'env, jamais en dur), cache disque, budget max. ChatGPT = manuel seulement.
- [ ] **B13 — Dataset décideur** · P2 · B1 B5 B12
  Sources : (a) logs bot filtrés réussites, (b) prof qui relabel les obs avec meilleure décision + raison, (c) mes parties (B17),
  (d) **datasets Andy/Mindcraft** (Sweaterdog / Mindcraft-CE, Andy-4.1 annonce ~130k ex.) convertis du format commandes
  Mindcraft vers nos skills — vérifier publication + licence avant. Format chat identique au prompt de prod. Dédoublonnage, split éval.
- [ ] **B14 — Dataset chat** · P2 · B7 B12
  Q&R Minecraft (minecraft-data + wiki + **`Aiwensile2/Minecraft_QA-pairs_Instruction_Dataset`**, CC-BY-4.0, celui de MineMA),
  dialogues ordre→intention, small talk FR avec personnalité, générés par prof + relus. Traduire/adapter en FR si besoin.
- [ ] **B15 — Entraînement LoRA** · P2 · B11 B13 B14
  Scripts Unsloth : `decider` et `chat`, export GGUF, hot-swap dans llama-server. Éval B6 avant/après obligatoire.
- [ ] **B16 — Boucle d'amélioration continue** · P3 · B6 B15
  Rounds nocturnes : logs du jour → filtrage (expert iteration) / paires préférées (DPO) → LoRA → éval B6 → garder seulement si meilleur.

### Produit
- [ ] **B17 — Mod Fabric** · P3 · B10
  Push-to-talk en jeu, HUD état bot, **enregistrement de mes actions** (haut niveau : craft, minage, placement, combat) → dataset behavior cloning.
- [ ] **B18 — App de contrôle** · P2 · B1 B10
  Python backend + UI web locale (ou Tauri plus tard). Lance/surveille llama-server, serveur MC, bot, voix ; dashboard (objectif, mémoire, logs, latences) ; boutons dataset/entraînement/éval.

### Plus tard / option
- [ ] **B19 — Décideur non-LLM** · P3 · B13 — classifieur (MLP/GBT) sur état structuré, <1 ms CPU, comparé au LoRA décideur via B6.
- [x] **B21 — Test écriture directe dans les poids (knowledge editing)** · P3 · B6 B11 — **FERMÉ 2026-11-17 : non.** Voir `b21/REPORT.md` (MEMIT −24 pts / LoRA-faits −37 pts sur décisions réelles ; contexte B4 gagne). Garder le rejeu de décisions comme éval hors-ligne.
  Tester ROME / MEMIT / AlphaEdit (EasyEdit) sur LFM3 bf16 : injecter des faits Minecraft (ex. recettes, position de la base)
  sans entraînement. Mesurer : fait appris ? généralise aux reformulations ? dégâts ailleurs (éval B6 + IFEval mini) ?
  Comparer à LoRA et à la mémoire B4. Attention : archi hybride LFM (conv + attention) → adapter le choix des couches MLP.
- [ ] **B20 — Construction par plans** · P3 · B3 — maisons/structures via schémas, le LLM choisit/adapte le plan.

---

## Ordre d'attaque conseillé
1. B1 → B2 → B3 → B4 → B5 (bot solide + données)  · lancer **B11 download en parallèle** (lent)
2. B6 (éval) + B7 (chat texte)
3. B8 → B9 → B10 (voix)
4. B12 → B13/B14 → B15 (1er LoRA)
5. B18 (app) → B16 → B17 → B19/B20
