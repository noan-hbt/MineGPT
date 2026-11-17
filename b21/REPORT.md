# B21 · LFM3-1.7B et bot Minecraft

## Verdict (2026-11-17) : non, B21 fermé

1. Édition de poids **rejetée** pour le bot. Les faits du monde (base, coffres, repères) vont en contexte (B4) ; les recettes viennent du planificateur B2 (`minecraft-data`).
2. Injection en contexte : scénarios liés aux faits 15 → 26/40 pour +21 tokens de prompt, zéro dégât sur les décisions réelles.
3. MEMIT-40 (couches 0-3) : 24/40 faits appris mais décisions réelles 276 → 205/300 (−24 pts) et scénarios 15 → 13/40.
4. LoRA r8 sur 80 exemples de faits : 33/40 faits, mais décisions 276 → 166/300 (−37 pts) → oubli du format de décision.
5. ROME 1 fait : gain de log-prob qui survit partiellement à Q4_0, mais la réponse et l'action restent fausses.
6. Les deux éditions larges échouent déjà les seuils en BF16 → rejeu Q4_0 inutile, non fait.
7. Limites de ce banc : « format exact » et « voisins inchangés » (comparaison de texte greedy) mesurent le format, pas la connaissance ; le score de consignes (6/30 en baseline) est suspect ; la localisation est un balayage de gain, pas du causal tracing.
8. **À réutiliser** : le rejeu des 300 décisions loguées (argmax log-prob sur les options, `eval.py:compare`) = éval hors-ligne d'un modèle sans Minecraft → B6 / B15.
9. Leçon pour B15 : une LoRA doit s'entraîner sur des **décisions** (format prod, volume, diversité), pas sur des faits isolés, et être jugée avec ce rejeu.
10. Modèles édités supprimés (`models/edited/`, 8,5 Go).

Détail des mesures ci-dessous.

## Mesures sur le modèle QAD Q4_0 d'origine

llama.cpp b12445, RTX 4070 Laptop, mode greedy, thinking désactivé. Le pilote utilise les 52 candidats, dont 32 recettes Java 1.21.11 et 20 repères synthétiques. Les quantités des recettes ont été vérifiées contre `minecraft-data` installé dans le projet. Les 40 faits retenus dans `data/facts.jsonl` pour la suite sont les 20 premiers échecs Minecraft au double criblage QAD et les 20 repères synthétiques. Les scores ci-dessous concernent le pilote de 52 faits.

| Mesure | QAD sans ajout | QAD avec fait injecté |
|---|---:|---:|
| Réponse au format exact | 0/52 · 0,0 % | 13/52 · 25,0 % |
| Réponse au format exact sur paraphrases | 0/156 · 0,0 % | 9/156 · 5,8 % |
| Réponse classée première parmi les choix | 7/52 · 13,5 % | 43/52 · 82,7 % |
| Texte inchangé sur les prompts voisins | Référence | 0/156 · 0,0 % |
| Action attendue sur scénario lié au fait | 21/52 · 40,4 % | 32/52 · 61,5 % |
| Accord avec les actions réussies des journaux | 281/300 · 93,7 % | 281/300 · 93,7 % (contrôle sans fait injecté) |
| Perplexité FR+EN (260 tokens) | 31,79 | Même corpus nu |
| Suivi de consigne simple | 6/30 · 20,0 % | Même prompt nu |
| Tokens de prompt, moyenne des scénarios liés aux faits | 331,0 | 352,3 |

L'injection ajoute en moyenne 21,3 tokens. Fournir le bon fait d'avance améliore le choix d'action de 21,2 points. Le taux de 0 % sur les voisins correspond à une comparaison du texte produit et à une injection systématique, y compris sur des questions qui n'en ont pas besoin. Le gain de 69,2 points en choix forcé, contre 25 points en génération au format exact, montre que le format de sortie pèse sur la mesure. Le passage CPU indépendant a également obtenu 0/52 au format exact.

L'accord sur les 300 décisions compare l'argmax de la log-probabilité totale des tokens à une action réussie enregistrée. Il mesure la reproduction de ces actions. Le rejeu utilise le SYSTEM de chaque session et inclut les recommandations déjà présentes dans les observations. Le passage complet de référence prend 409 s, dont le criblage des scénarios, les scores sur les options des 300 décisions et la santé générale. Ce temps de benchmark ne mesure pas la latence d'une décision en production.

## Écriture BF16

Le test d'écriture et de relecture a vérifié la projection `model.layers.8.feed_forward.w2.weight` du vrai checkpoint. La modification contrôlée a touché 64 valeurs sur une seule ligne de la copie BF16 de dimensions 2048 × 7680. La première valeur est passée de 0,00546265 à 0,03662109. Source, en-tête et octets hors de cette ligne ont été comparés. Durée mesurée, 0,15 s, pour un tenseur de 30 Mio extrait du modèle. Ce test contrôle l'écriture et la sérialisation. Il ne mesure ni l'apprentissage d'un fait, ni la sauvegarde du modèle complet.

## Premier essai factuel ROME

Le fait synthétique indique que Copperwick est au nord du hub. Un balayage sur un autre repère a donné +3,07 nats par token à la couche 8 (`sliding_attention`), +3,16 à la couche 9 (`conv`) et +2,80 à la couche 10 (`full_attention`). L'essai a modifié uniquement `w2` de la couche 9, avec 30 pas d'optimisation de la cible, en 1,96 s et avec 3,67 Gio de mémoire GPU réservée par PyTorch. La sauvegarde des poids prend 16,84 s.

| Mesure sur Copperwick | BF16 d'origine | BF16 ROME | Q4_0 sans édition | Q4_0 ROME |
|---|---:|---:|---:|---:|
| Réponse au format exact | 0/1 | 0/1 | 0/1 | 0/1 |
| Direction classée première | sud | **nord** | sud | sud |
| Log-probabilité de « north » au prompt exact | −21,00 | −6,87 | −15,07 | −5,80 |
| Paraphrases au format exact | 0/3 | 0/3 | 0/3 | 0/3 |
| Paraphrases, direction classée première | 0/3 | 1/3 | 2/3 | 1/3 |
| Voisins inchangés dans le même format de poids | Référence | 2/3 | Référence | 1/3 |
| Action attendue `explore north` | 0/1 | 0/1 | 0/1 | 0/1 |

La log-probabilité de la cible gagne 14,13 nats en BF16 et 9,27 nats en Q4_0 par rapport au modèle de référence du même format. Après quantification, « nord » est deuxième derrière « sud » de 0,22 nat. Le bot choisit l'est dans les quatre conditions. La différence d'accord sur 300 décisions n'a pas été mesurée pour cette édition.

Le checkpoint édité de 3,46 Go se convertit en GGUF BF16 en 43,5 s. La quantification Q4_0 avec huit threads prend 13,9 s et produit 1,05 Go. Le contrôle sans édition prend respectivement 48,8 s et 13,4 s. La mesure de conversion exclut la sauvegarde des poids et le rejeu des décisions.

Sur les cinq prompts de contrôle du bot, HF et QAD reçoivent les mêmes IDs (5/5). Aucune des cinq sorties greedy n'est identique. Le chargement BF16 a nécessité un adaptateur local pour les APIs absentes de Transformers 5.12.1 et la désactivation du cache HF. PyTorch 2.13.0+cu130 a bien exécuté les essais sur la RTX. Les sorties et mesures de l'essai sont dans [results-rome-pilot.json](results-rome-pilot.json).

## Référence BF16 et localisation

Le criblage BF16 retient exactement les mêmes 40 faits que le criblage QAD. Sur cette cohorte, le BF16 d'origine réussit 0/40 au format exact, 0/120 sur les paraphrases et 15/40 sur les scénarios liés aux faits. L'injection BF16 donne respectivement 2/40, 6/120 et 26/40, avec 5/120 textes voisins inchangés. Sur les 300 décisions, le BF16 retrouve 276 actions réussies (92,0 %). La perplexité est de 30,60 et le suivi de consigne de 8/30. Le passage complet dure 322 s.

Le balayage indépendant de 24 couches et quatre faits de calibration dure 109 s. Le gain moyen des couches `conv` est de 1,99 nat par token, celui des couches `full_attention` de 1,76 et celui des couches `sliding_attention` de 1,65. Les meilleures couches par type sont respectivement 1 (+3,65), 2 (+3,70) et 4 (+2,09). Le meilleur groupe contigu de quatre couches est `0, 1, 2, 3`. Il est retenu pour l'édition MEMIT-40 à 60 pas par fait.

## Comparaison sur les mêmes 40 faits

| Méthode | Exact | Paraphrases | Voisins inchangés | Scénarios bot | Décisions réelles | Perplexité | Consignes | Édition et VRAM |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| QAD Q4_0 d'origine | 0/40 | 0/120 | Référence | 15/40 | 281/300 | 31,79 | 6/30 | — |
| QAD + fait injecté | 11/40 | 6/120 | 0/120 | 26/40 | Référence sans injection | 31,79 | 6/30 | — |
| HF BF16 d'origine | 0/40 | 0/120 | Référence | 15/40 | 276/300 | 30,60 | 8/30 | — |
| HF BF16 + fait injecté | 2/40 | 6/120 | 5/120 | 26/40 | Référence sans injection | 30,60 | 8/30 | — |
| MEMIT-40 BF16 | 24/40 | 25/120 | 1/120 | 13/40 | 205/300 | 29,86 | 10/30 | 224,56 s · 3,56 Gio |
| LoRA BF16 rang 8 | 33/40 | 88/120 | 0/120 | 16/40 | 166/300 | 30,61 | 20/30 | 56,25 s · 3,47 Gio |

Les contrôles des 300 décisions, du corpus de perplexité et du suivi de consigne ne reçoivent aucun fait injecté. Les scores de spécificité sont comparés à la baseline du même format. Le test de génération libre exige le nombre ou la direction attendus. Le diagnostic de choix forcé de MEMIT-40 atteint 28/40 et 53/120 sur les paraphrases. La LoRA atteint 32/40 et 89/120.

Dans le lot MEMIT-40, les réponses exactes passent de 0/20 à 11/20 sur les recettes, et de 0/20 à 13/20 sur les repères. Le score des actions liées aux faits passe de 10/20 à 8/20 sur les recettes et reste à 5/20 sur les repères. À titre de comparaison, l'injection BF16 porte ce dernier score à 16/20. L'amélioration de la perplexité avec MEMIT coïncide avec une perte de 23,7 points d'accord sur les décisions réelles.

La LoRA fusionne des adaptateurs de rang 8 sur les 72 projections MLP après trois époques de 80 exemples. Elle apprend davantage de faits en un quart du temps de MEMIT-40 et améliore le suivi de consigne. Sur les décisions réelles, 117 actions précédemment retrouvées sont perdues et sept sont gagnées. Le gain est d'un seul scénario synthétique par rapport au BF16 d'origine. MEMIT-40 est retenu pour le rejeu Q4_0 parmi les deux éditions larges, vu ses 205/300 décisions retrouvées contre 166/300 pour la LoRA.

Le pilote ROME ci-dessus couvre une édition isolée. Le lot MEMIT-10 et la série ROME sur 40 sont restés hors du plan après la priorité donnée au lot large.

### Données et transfert vers le jeu

Les 80 exemples uniques de LoRA sont des questions-réponses factuelles. Les scénarios synthétiques et les 300 décisions réelles servent uniquement à l'évaluation. Les scénarios de repères se limitent à des directions fictives depuis un hub. Les contrôles montrent un écart entre reconnaître le fait et l'appliquer au format du bot. Une prochaine expérience peut isoler l'effet de la taille et celui du format d'entraînement en croisant deux volumes et deux mélanges, avec davantage de situations où le même état requiert une action différente si le fait change. Un test sur des sessions entières réservées et des repères tenus à l'écart permettrait de mesurer le transfert et la conservation des compétences. Les essais B21 ne mesurent pas cet effet.

## Seuils Q4_0

Le seuil post-Q4_0 exige au moins 90 % sur les prompts d'édition, 70 % sur les paraphrases, 95 % sur les voisins, 278/300 accords si la référence reste 281/300, et une perplexité au plus de 32,74 sur le même corpus. Non atteint en BF16 (voir verdict) : rejeu Q4_0 non fait.

Les [résultats agrégés](results-qad.json) et le [protocole](README.md) accompagnent ce rapport. Les sorties individuelles sont dans `b21/runs/`.
