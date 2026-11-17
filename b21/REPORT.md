# B21 · LFM3-1.7B et bot Minecraft

**Verdict provisoire**. Privilégier l'injection B4 pour les repères du monde. Le QAD d'origine choisit plus souvent l'action attendue quand on lui fournit le fait pertinent. L'avantage éventuel de l'écriture de poids ou de la LoRA reste à mesurer après export Q4_0.

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

## Comparaison complète et seuil de décision

| Méthode | Phase QAD/BF16 | Phase Q4_0 après édition | Coût d'édition et VRAM |
|---|---|---|---|
| Baseline et injection B4 | Pilote QAD mesuré, référence BF16 en attente | QAD ci-dessus | Aucun entraînement |
| ROME | Écriture BF16 contrôlée, efficacité factuelle en attente | En attente | En attente |
| MEMIT-10 et MEMIT-40 | En attente | En attente | En attente |
| LoRA rang 8 | En attente | En attente | En attente |

Le seuil post-Q4_0 exige au moins 90 % sur les prompts d'édition, 70 % sur les paraphrases, 95 % sur les voisins, 278/300 accords si la référence reste 281/300, et une perplexité au plus de 32,74 sur le même corpus. Il faut aussi chiffrer l'avantage de latence, de longueur de prompt ou de coût de mise à jour. B21 reste ouvert.

Les [résultats agrégés](results-qad.json) et le [protocole](README.md) accompagnent ce rapport. Les sorties individuelles sont dans `b21/runs/`.
