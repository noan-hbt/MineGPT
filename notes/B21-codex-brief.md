# Brief Codex — B21 : écriture directe dans les poids (knowledge editing) sur LFM3-1.7B

À coller tel quel dans Codex, lancé depuis `C:\Users\noanh\Desktop\Dev\localai`.

---

## Objectif

Déterminer si l'édition directe des poids (ROME / MEMIT / AlphaEdit) **vaut le coup** pour notre bot Minecraft,
comparée à (a) l'injection en contexte (mémoire, bloc B4) et (b) une petite LoRA. Livrer un rapport chiffré
avec une recommandation claire « oui / non / seulement pour X ».

## Contexte (à lire d'abord)

- `ROADMAP.md` (bloc B21), `HANDOFF.md`, `mcbot/bot.js` (format de prompt du bot : SYSTEM + observation texte → `verbe arg`).
- Modèle : `models/LFM3-1.7B-hf/` (bf16, safetensors 3.4 Go, `trust_remote_code=True`, `modeling_lfm3.py`).
  Archi **hybride** : 24 couches, `layer_types` alterne `conv` (conv courte) et attention (`full_attention` / `sliding_attention`),
  hidden 2048, MLP intermediate 7680, embeddings liés. Chaque couche a un bloc MLP/feed-forward → ce sont les cibles d'édition.
  Lis `modeling_lfm3.py` pour trouver les noms exacts des modules (proj up/gate/down) et les mettre dans les hparams.
- Modèle servi en prod : `models/LFM3-1.7B-QAD-Q4_0.gguf` (Q4_0 *quantization-aware*) via `llama.cpp/llama-server.exe` sur :8080.
- Logs de décisions réels du bot : `mcbot/logs/*.jsonl` (champs `obs_text`, `options`, `action`, `result`, `hint`). Format décrit dans `mcbot/logger.js`.
- Machine : RTX 4070 Laptop **8 Go VRAM**, 16 Go RAM, Windows 11. Pas de torch installé. Réseau HF lent.

## Contraintes

- **Un seul process GPU à la fois.** llama-server occupe la VRAM : avant tout calcul GPU, demande à l'utilisateur
  d'arrêter llama-server et le bot (ne les tue pas toi-même). Si OOM : gradient seulement sur la couche éditée, bf16, batch 1.
- Ne modifie pas `mcbot/`, ni les fichiers dans `models/`. Tout ton travail va dans `b21/`, les modèles édités dans `models/edited/`
  (3.4 Go chacun : garde-en 2 max, vérifie l'espace disque).
- Environnement isolé : `b21/.venv` (torch CUDA compatible driver CUDA 13.x, `transformers==5.12.1` comme dans `config.json`, peft, accelerate).
- EasyEdit ne connaît probablement pas `lfm3`. Essaie-le si l'adaptation tient en quelques hparams ; sinon écris une
  implémentation minimale et lisible de ROME (update rang 1 sur la proj *down* du MLP) et MEMIT (multi-couches, batch) dans `b21/editing/`.
  AlphaEdit (projection dans le null-space) en option si ROME/MEMIT marchent.
- Travaille sur une branche `b21-knowledge-editing`, commits petits. Pas de push sans demander.

## Étapes

1. **Setup + sanity** : charger le modèle HF, vérifier que la génération HF ≈ le GGUF sur 5 prompts du bot (même chat template, thinking off).
2. **Jeu de faits** `b21/data/facts.jsonl` (~40 faits), 2 familles :
   - *Faits Minecraft vrais que le modèle rate* : mesure d'abord la baseline et garde ceux qu'il rate
     (ex. combien de cobblestone pour un four, quel outil mine le fer, à quel Y chercher les diamants, recettes).
   - *Faits propres à notre monde* (contrefactuels du point de vue du modèle) : position de la base, contenu d'un coffre,
     nom du joueur ami, où est le lit, etc.
   Pour chaque fait : `prompt` d'édition (sujet / relation / objet), **≥3 paraphrases**, **≥3 prompts voisins** qui ne doivent PAS changer,
   et **1–2 prompts au format bot** (obs texte + options, la bonne action dépend du fait).
3. **Localisation** : causal tracing (ou au moins balayage de couches) pour choisir les couches MLP à éditer — attention,
   archi hybride : compare couches `conv` et couches attention, ne recopie pas les couches par défaut de GPT-J/Llama.
4. **Méthodes comparées, mêmes faits** :
   - baseline (rien)
   - in-context : fait injecté dans le prompt (= ce que fera B4)
   - ROME (un fait à la fois) et MEMIT (tous les faits en batch : 10, 40)
   - LoRA rang 8 entraînée sur les mêmes faits + paraphrases d'entraînement (pas celles de test)
   - (option) AlphaEdit
5. **Métriques** (script `b21/eval.py`, résultats en JSON) :
   - efficacité (prompt exact), généralisation (paraphrases), spécificité (voisins inchangés)
   - **décisions du bot** : sur ~300 décisions tirées de `mcbot/logs`, scorer chaque option valide par log-prob et prendre l'argmax
     (équivalent à la grammaire) → taux d'accord avec les actions réussies. Ne doit pas baisser.
   - santé générale : perplexité sur un petit corpus FR+EN fixe, + 30 prompts d'instruction-following simples
   - coût : temps d'édition, VRAM max
6. **Survie à la quantif** (critique, c'est ce qui tourne en prod) : exporter le meilleur modèle édité →
   GGUF (`llama.cpp/convert_hf_to_gguf.py`) → Q4_0 (`llama-quantize`). Re-mesurer efficacité + décisions via llama-server.
   Comparer au QAD Q4_0 d'origine : la requantification d'un bf16 édité perd-elle l'édition et/ou la qualité QAD ?
7. **Rapport** `b21/REPORT.md` : tableau méthodes × métriques, courbes si utile, coûts, et verdict.

## Critère « ça vaut le coup »

Oui seulement si, **après quantif Q4_0** : efficacité ≥ 90 %, paraphrases ≥ 70 %, spécificité ≥ 95 %,
accord décisions bot ≥ baseline − 1 pt, perplexité ≤ +3 %, et un avantage net sur l'in-context (prompt plus court / latence)
ou sur la LoRA (coût, rapidité de mise à jour). Sinon, conclure lequel d'in-context / LoRA est meilleur et pourquoi.

## À la fin

Résume en 10 lignes : verdict, chiffres clés, ce qui a cassé, et ce qu'il faudrait pour aller plus loin.
Mets à jour la case B21 dans `ROADMAP.md` uniquement si le rapport est complet.
