# B21 · Rejouer le benchmark

Les commandes ci-dessous partent de la racine du dépôt. Les deux poids d'origine sont lus depuis `models/`. Les résultats bruts et les observations du bot restent dans `b21/runs/`, ignoré par Git.

## Préparation

```powershell
uv venv --python 3.13 b21/.venv
$py = 'b21/.venv/Scripts/python.exe'
uv pip install --python $py --index https://download.pytorch.org/whl/cu130 'torch==2.13.0' 'transformers==5.12.1' 'peft==0.21.3' 'accelerate==1.16.0'
python b21/prepare.py
python b21/candidates.py
```

`prepare.py` échantillonne 300 observations distinctes, graine 21. Chaque observation conserve le SYSTEM de sa session, le tick et les actions réussies observées pour cette combinaison d'observation et d'options. Conserver ce fichier pour les mesures suivantes.

Le test `python b21/smoke_weight.py` vérifie l'écriture et la relecture BF16 d'une mise à jour de rang 1 sur une copie de la projection `w2` du modèle réel. Il ne nécessite pas PyTorch.

Le code LFM3 du checkpoint appelle des fonctions ajoutées après Transformers 5.12.1. `lfm3_compat.py` sélectionne les convolutions PyTorch, adapte les masques et suppose un seul appareil. La génération HF tourne sans cache pour éviter les différences de représentation des états de convolution. Les fichiers du checkpoint original restent en lecture seule.

## Baseline QAD et contrôle HF

Pendant une session GPU B21, réserver la carte à un seul processus. Démarrer le serveur d'évaluation sur un autre port avec le QAD original, puis l'arrêter après la capture de référence et l'évaluation. Il faut le redémarrer seul pour toute autre mesure GGUF GPU.

```powershell
llama.cpp/llama-server.exe -m models/LFM3-1.7B-QAD-Q4_0.gguf --port 18081 --host 127.0.0.1 -ngl 99 -np 1 -c 2048 --jinja --reasoning off
```

```powershell
python b21/sanity.py --gguf http://127.0.0.1:18081 --output b21/runs/sanity-qad.json
# Après l'arrêt du serveur d'évaluation.
& $py b21/sanity.py --reference b21/runs/sanity-qad.json --device cuda
& $py b21/eval.py --hf --device cuda --facts b21/data/candidates.jsonl --decision-limit 0 --exact-only --choice-facts --select b21/data/facts.jsonl --output b21/runs/hf-screen.json
& $py b21/eval.py --hf --device cuda --facts b21/data/facts.jsonl --health --output b21/runs/hf-baseline.json
& $py b21/eval.py --hf --device cuda --facts b21/data/facts.jsonl --in-context --baseline b21/runs/hf-baseline.json --decision-limit 0 --output b21/runs/hf-context.json
```

Le criblage garde jusqu'à 20 recettes en échec en génération et parmi les neuf réponses numériques classées par log-probabilité. Il alterne ces recettes et les 20 faits de navigation synthétiques pour que MEMIT-10 couvre les deux familles. Si le criblage produit moins de 40 faits, compléter les candidats Minecraft puis répéter le criblage avant MEMIT-40. Les repères sont fictifs et calibrés à cinq exemples par direction. `--choice-facts` donne aussi un diagnostic sur l'écart entre rappel et respect du format.

L'indicateur d'efficacité utilise le prompt d'édition et la génération libre. Les paraphrases de test sont distinctes des prompts de LoRA. La spécificité compare le texte généré sur les voisins à celui de la baseline du même backend après normalisation de la casse et des espaces. Le score bot somme les log-probabilités des tokens de chaque action valide, hors token de fin. L'argmax porte sur l'action complète. L'accord sur les journaux indique la reproduction d'une action réussie déjà observée. Les cas synthétiques mesurent le choix d'action qui dépend directement du fait. L'injection simule une récupération idéale du fait et son coût en tokens de prompt.

## Édition BF16

```powershell
& $py b21/edit.py sweep --device cuda --facts b21/data/sweep.jsonl --steps 12 --output b21/runs/layers.json
```

Comparer le gain moyen en log-probabilité de la paraphrase de calibration par couche, pour `conv`, `full_attention` et `sliding_attention`. Choisir une couche pour ROME et plusieurs couches en ordre croissant pour MEMIT. Les quatre faits du balayage sont distincts du jeu d'évaluation.

```powershell
# Remplacer les valeurs d'exemple par les couches issues du balayage.
& $py b21/edit.py rome --device cuda --facts b21/data/facts.jsonl --layers 8 --evaluate --baseline b21/runs/hf-baseline.json --health --output b21/runs/rome.json
& $py b21/edit.py memit --device cuda --facts b21/data/facts.jsonl --limit 10 --layers 8 9 10 --evaluate --baseline b21/runs/hf-baseline.json --health --output b21/runs/memit10.json
& $py b21/edit.py memit --device cuda --facts b21/data/facts.jsonl --layers 8 9 10 --evaluate --baseline b21/runs/hf-baseline.json --health --output b21/runs/memit40.json
& $py b21/edit.py lora --device cuda --facts b21/data/facts.jsonl --evaluate --baseline b21/runs/hf-baseline.json --health --output b21/runs/lora.json
```

ROME restaure la projection d'origine entre les faits. Les 300 décisions et 30 consignes sont réparties en tourniquet entre ces éditions indépendantes. La perplexité agrège la log-vraisemblance du corpus répété pour chaque édition. Ajouter `--fact-id` pour isoler une édition et l'évaluer sur l'échantillon entier. Comparer MEMIT-10 à la même tranche de dix faits pour les autres méthodes. Les trois projections sont `model.layers.{i}.feed_forward.w1` (gate), `w3` (up) et `w2` (down). ROME et MEMIT ajustent uniquement `w2`. Leurs adaptations utilisent une covariance empirique régularisée, une cible optimisée sur deux formulations et une pénalité sur la déviation du vecteur. LoRA utilise le rang 8 et les trois projections. ROME/MEMIT sont des adaptations minimales des implémentations publiées. [ROME](https://arxiv.org/abs/2202.05262), [MEMIT](https://arxiv.org/abs/2210.07229).

## Réexport et comparaison Q4_0

Relancer la meilleure configuration avec `--save models/edited/<nom>`. Le script limite les exports à deux sous-dossiers et contrôle l'espace disque. Le dépôt binaire local ne contient pas le convertisseur Python. Le tag source `b12445` contient un [convertisseur LFM3](https://github.com/ggml-org/llama.cpp/blob/b12445/conversion/lfm3.py).

```powershell
git clone --depth 1 --branch b12445 https://github.com/ggml-org/llama.cpp.git b21/runs/llama-src
uv pip install --python $py 'sentencepiece>=0.1.98,<0.3.0' 'protobuf>=4.21,<5'
$edited = 'models/edited/memit40'
Measure-Command { & $py b21/runs/llama-src/convert_hf_to_gguf.py $edited --outtype bf16 --outfile b21/runs/edited-bf16.gguf }
Measure-Command { llama.cpp/llama-quantize.exe b21/runs/edited-bf16.gguf "$edited/model-Q4_0.gguf" Q4_0 }
```

Rejouer `eval.py --gguf ... --facts b21/data/facts.jsonl --health` sur le QAD et sur le Q4_0 édité, avec `--baseline` pointant vers le JSON QAD pour le test de spécificité. Une quantification Q4_0 du BF16 d'origine, gardée dans `b21/runs/`, permet d'attribuer séparément la dégradation liée à la perte du checkpoint QAD. On compare ainsi les trois GGUF avec le même jeu de faits et les mêmes 300 décisions.
