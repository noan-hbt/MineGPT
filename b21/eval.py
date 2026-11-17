"""Compare frozen prompts and valid-action sequence log-probabilities."""

import argparse
import hashlib
import json
import math
import os
import re
import time
import urllib.request
from functools import lru_cache
from itertools import batched, zip_longest
from pathlib import Path

from prepare import B21, DATA, ROOT, read_jsonl, write_jsonl

FACT_SYSTEM = "Answer the question with only the requested number or direction."
HF_MODEL = ROOT / "models" / "LFM3-1.7B-hf"


def matches(text, answer):
    return text.strip().casefold().rstrip(".!") == answer.casefold()


def messages(system, prompt, memory=None):
    if memory:
        system += "\nRelevant fact: " + memory
    return [{"role": "system", "content": system}, {"role": "user", "content": prompt}]


class GGUF:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.model = self.post("/props")["model_path"]

    def post(self, route, body=None):
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + route, data=payload,
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    @lru_cache(maxsize=4096)
    def tokenize(self, content, chat=False):
        return self.post("/tokenize", dict(content=content, add_special=chat,
                                           parse_special=chat))["tokens"]

    def render(self, turns):
        rendered = self.post("/apply-template", dict(
            messages=turns, chat_template_kwargs={"enable_thinking": False}))["prompt"]
        if not rendered.endswith("<think></think>"):
            raise ValueError("Expected a generation prompt with thinking disabled")
        return self.tokenize(rendered, chat=True)

    def complete(self, ids, max_tokens, **kwargs):
        result = self.post("/completion", dict(
            prompt=ids, n_predict=max_tokens, temperature=0, repeat_penalty=1,
            top_k=1, cache_prompt=True, **kwargs))
        if result["truncated"]:
            raise ValueError("GGUF context exceeded")
        return result

    def generate(self, ids):
        return self.complete(ids, 20)["content"]

    def generate_many(self, prompts):
        return [self.generate(ids) for ids in prompts]

    def score(self, ids, target):
        # Force precisely these token IDs, but read log-probability before sampling.
        grammar = "root ::= " + " ".join(f"<[{token}]>" for token in target)
        result = self.complete(ids, len(target), grammar=grammar, return_tokens=True,
                               n_probs=1, post_sampling_probs=False, ignore_eos=True)
        tokens = result["completion_probabilities"]
        if [row["id"] for row in tokens] != target:
            raise ValueError("Forced GGUF completion differed from target IDs")
        return sum(row["logprob"] for row in tokens)

    def score_options(self, ids, options):
        return {option: self.score(ids, self.tokenize(option)) for option in options}


class HF:
    def __init__(self, path, device):
        os.environ.setdefault("HF_HOME", str(B21 / "runs" / "hf-cache"))
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from lfm3_compat import enable

        enable()

        self.torch = torch
        self.device = device
        self.model = str(path.resolve())
        self.tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True,
                                                        trust_remote_code=True)
        self.network = AutoModelForCausalLM.from_pretrained(
            path, local_files_only=True, trust_remote_code=True,
            dtype=torch.bfloat16, device_map={"": device}).eval().requires_grad_(False)

    def tokenize(self, text, chat=False):
        return self.tokenizer.encode(text, add_special_tokens=chat)

    def render(self, turns):
        return self.tokenizer.apply_chat_template(
            turns, tokenize=True, add_generation_prompt=True,
            enable_thinking=False, return_dict=False)

    def tensor(self, ids):
        return self.torch.tensor([ids], device=self.device)

    def generate(self, ids):
        return self.generate_many([ids])[0]

    def generate_many(self, prompts):
        by_length = {}
        for index, ids in enumerate(prompts):
            by_length.setdefault(len(ids), []).append((index, ids))
        texts = [""] * len(prompts)
        with self.torch.inference_mode():
            for length, bucket in by_length.items():
                for chunk in batched(bucket, 8):
                    token_ids = self.torch.tensor([ids for _, ids in chunk], device=self.device)
                    out = self.network.generate(
                        token_ids, do_sample=False, max_new_tokens=20,
                        pad_token_id=self.tokenizer.pad_token_id, repetition_penalty=1.0,
                        temperature=None, top_k=None, use_cache=False)
                    for (index, _), sequence in zip(chunk, out, strict=True):
                        texts[index] = self.tokenizer.decode(sequence[length:], skip_special_tokens=True)
        return texts

    def loss(self, ids, target):
        logits = self.network(input_ids=self.tensor(ids + target[:-1]), use_cache=False,
                              logits_to_keep=len(target)).logits[0].float()
        return self.torch.nn.functional.cross_entropy(
            logits, self.tensor(target)[0], reduction="sum")

    def score(self, ids, target):
        with self.torch.inference_mode():
            return -self.loss(ids, target).item()

    def score_options(self, ids, options):
        torch = self.torch
        by_length = {}
        for option in options:
            target = self.tokenize(option)
            by_length.setdefault(len(target), []).append((option, target))
        scores = {}
        with torch.inference_mode():
            for length, bucket in by_length.items():
                for chunk in batched(bucket, 8):
                    inputs = torch.tensor([ids + target[:-1] for _, target in chunk],
                                          device=self.device)
                    labels = torch.tensor([target for _, target in chunk], device=self.device)
                    logits = self.network(input_ids=inputs, use_cache=False,
                                          logits_to_keep=length).logits.float()
                    selected = logits.gather(-1, labels.unsqueeze(-1)).squeeze(-1)
                    log_probs = (selected - logits.logsumexp(dim=-1)).sum(dim=-1)
                    scores.update({opt: score for (opt, _), score in
                                   zip(chunk, log_probs.tolist(), strict=True)})
        return scores


def choose(scores):
    return max(sorted(scores), key=scores.__getitem__)


def compare(engine, facts, sample, bot_system, inject=False, exact_only=False,
            choice_facts=False):
    rows = []
    requests = []
    for fact in facts:
        memory = fact["memory"] if inject else None
        groups = {"exact": [fact["prompt"]]}
        if not exact_only:
            groups.update(paraphrases=fact["paraphrases"], neighbors=fact["neighbors"])
        for group, prompts in groups.items():
            for index, prompt in enumerate(prompts):
                ids = engine.render(messages(FACT_SYSTEM if group != "neighbors" else
                                             "Answer briefly.", prompt, memory))
                requests.append((group, fact, index, tuple(ids)))
    unique_prompts = list(dict.fromkeys(ids for _, _, _, ids in requests))
    texts = dict(zip(unique_prompts, engine.generate_many(unique_prompts), strict=True))
    for group, fact, index, key in requests:
        text = texts[key]
        rows.append(dict(group=group, fact=fact["id"], index=index, text=text,
                         exact=matches(text, fact["object"]), prompt_tokens=len(key)))
        if choice_facts and group != "neighbors":
            options = (list("123456789") if fact["family"] == "minecraft"
                       else ["north", "south", "east", "west"])
            scores = engine.score_options(list(key), options)
            chosen = choose(scores)
            rows.append(dict(group="choice_" + group, fact=fact["id"], index=index,
                             text=chosen, exact=chosen == fact["object"], scores=scores,
                             prompt_tokens=len(key)))
    for fact in facts:
        if not exact_only:
            for index, bot in enumerate(fact["bot"]):
                memory = fact["memory"] if inject else None
                ids = engine.render(messages(bot_system, bot["prompt"], memory))
                scores = engine.score_options(ids, bot["options"])
                chosen = choose(scores)
                rows.append(dict(group="bot_fact", fact=fact["id"], index=index, text=chosen,
                                 exact=chosen == bot["expected"], scores=scores,
                                 prompt_tokens=len(ids)))
    if sample and rows:
        factual = summarize(rows, {})
        progress = ", ".join(f"{group} {metric['correct']}/{metric['total']}"
                             for group, metric in factual.items())
        print(f"Fact evaluation complete: {progress}", flush=True)
    for index, decision in enumerate(sample, start=1):
        # This control sample has no attachment to the synthetic world fixtures.
        ids = engine.render(messages(decision["system"], decision["prompt"]))
        scores = engine.score_options(ids, decision["options"])
        chosen = choose(scores)
        rows.append(dict(group="bot_log", fact=decision["log"], index=decision["tick"],
                         text=chosen, exact=chosen in decision["references"], scores=scores,
                         prompt_tokens=len(ids)))
        if index % 50 == 0:
            print(f"Scored {index}/{len(sample)} logged decisions", flush=True)
    return rows


def health(engine, instruction_indices=None):
    rows = []
    nll = n_tokens = 0
    for passage in (DATA / "corpus.txt").read_text(encoding="utf-8").strip().split("\n\n"):
        ids = engine.tokenize(passage)
        nll -= engine.score(ids[:1], ids[1:])
        n_tokens += len(ids) - 1
    instructions = list(enumerate(read_jsonl(DATA / "instructions.jsonl")))
    if instruction_indices is not None:
        instructions = [(index, item) for index, item in instructions if index in instruction_indices]
    prompts = [engine.render(messages("Follow the user's instructions exactly.", item["prompt"]))
               for _, item in instructions]
    for (index, item), text in zip(instructions, engine.generate_many(prompts), strict=True):
        rows.append(dict(group="instruction", fact="health", index=index, text=text,
                         exact=text.strip() == item["answer"]))
    return rows, dict(perplexity=math.exp(nll / n_tokens), ppl_tokens=n_tokens)


def summarize(rows, baseline):
    metrics = {}
    for row in rows:
        group = row["group"]
        if group == "neighbors":
            reference = baseline.get((row["fact"], row["index"]))
            if reference is None:
                continue
            correct = re.sub(r"\s+", " ", row["text"].strip().casefold()) == reference
        else:
            correct = row["exact"]
        metric = metrics.setdefault(group, dict(correct=0, total=0))
        metric["correct"] += correct
        metric["total"] += 1
    for metric in metrics.values():
        metric["rate"] = metric["correct"] / metric["total"]
    return metrics


def neighbor_references(path):
    if path is None:
        return {}
    return {(row["fact"], row["index"]): re.sub(r"\s+", " ", row["text"].strip().casefold())
            for row in json.loads(path.read_text(encoding="utf-8"))["rows"]
            if row["group"] == "neighbors"}


def main():
    parser = argparse.ArgumentParser()
    backend = parser.add_mutually_exclusive_group(required=True)
    backend.add_argument("--gguf", help="llama-server URL")
    backend.add_argument("--hf", nargs="?", type=Path, const=HF_MODEL)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--facts", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, default=B21 / "runs" / "decisions.jsonl")
    parser.add_argument("--decision-limit", type=int, default=300)
    parser.add_argument("--exact-only", action="store_true")
    parser.add_argument("--choice-facts", action="store_true")
    parser.add_argument("--in-context", action="store_true")
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--select", type=Path, help="Write synthetic facts and failed Minecraft candidates")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.select and args.in_context:
        parser.error("--select requires an unassisted baseline")
    if args.decision_limit < 0:
        parser.error("--decision-limit must be nonnegative")
    start = time.perf_counter()
    engine = GGUF(args.gguf) if args.gguf else HF(args.hf, args.device)
    facts = read_jsonl(args.facts)
    sample = read_jsonl(args.decisions)
    bot_system = max(sample, key=lambda row: row["log"])["system"]
    rows = compare(engine, facts, sample[:args.decision_limit], bot_system,
                   args.in_context, args.exact_only, args.choice_facts)
    extra = {}
    if args.health:
        health_rows, extra = health(engine)
        rows.extend(health_rows)
    baseline = neighbor_references(args.baseline)
    if args.select:
        correct = {row["fact"] for row in rows
                   if row["group"] in {"exact", "choice_exact"} and row["exact"]}
        failed = [fact for fact in facts if fact["family"] == "minecraft" and fact["id"] not in correct]
        world = [fact for fact in facts if fact["family"] != "minecraft"]
        interleaved = [fact for pair in zip_longest(failed[:20], world) for fact in pair if fact]
        write_jsonl(args.select, interleaved)
    result = dict(model=engine.model, backend="gguf" if args.gguf else args.device,
                  in_context=args.in_context, fact_sha256=hashlib.sha256(args.facts.read_bytes()).hexdigest(),
                  decision_sha256=hashlib.sha256(args.decisions.read_bytes()).hexdigest(),
                  elapsed_s=time.perf_counter() - start, metrics=summarize(rows, baseline),
                  rows=rows, **extra)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result["metrics"], indent=2))


if __name__ == "__main__":
    main()
