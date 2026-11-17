# B21 · LFM3-1.7B et bot Minecraft

**Verdict provisoire**. Privilégier l'injection B4 pour les repères du monde. Le QAD d'origine choisit plus souvent l'action attendue quand on lui fournit le fait pertinent. Le premier essai ROME améliore le score du fait en BF16 et conserve une partie du gain en Q4_0, mais le bot rate toujours l'action.

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

## Comparaison complète et seuil de décision

| Méthode | Phase QAD/BF16 | Phase Q4_0 après édition | Coût d'édition et VRAM |
|---|---|---|---|
| Baseline et injection B4 | Pilote QAD mesuré, référence BF16 en attente | QAD ci-dessus | Aucun entraînement |
| ROME | Pilote sur un fait mesuré | Gain de score partiel, réponse et action incorrectes | 1,96 s et 3,67 Gio (pilote) |
| MEMIT-10 et MEMIT-40 | En attente | En attente | En attente |
| LoRA rang 8 | En attente | En attente | En attente |

Le seuil post-Q4_0 exige au moins 90 % sur les prompts d'édition, 70 % sur les paraphrases, 95 % sur les voisins, 278/300 accords si la référence reste 281/300, et une perplexité au plus de 32,74 sur le même corpus. Il faut aussi chiffrer l'avantage de latence, de longueur de prompt ou de coût de mise à jour. B21 reste ouvert.

Les [résultats agrégés](results-qad.json) et le [protocole](README.md) accompagnent ce rapport. Les sorties individuelles sont dans `b21/runs/`.
