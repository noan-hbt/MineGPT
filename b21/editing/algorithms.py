"""LFM3 adaptations of ROME and MEMIT, plus a rank-8 LoRA control."""

import shutil

from eval import FACT_SYSTEM, HF_MODEL, messages
from prepare import DATA, ROOT


def inputs(engine, fact, prompt):
    turns = messages(FACT_SYSTEM, prompt)
    rendered = engine.tokenizer.apply_chat_template(
        turns, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    encoded = engine.tokenizer(rendered, add_special_tokens=False,
                               return_offsets_mapping=True)
    ids = engine.render(turns)
    if ids != encoded.input_ids:
        raise ValueError("Cannot align subject offsets with chat token IDs")
    end = rendered.rindex(fact["subject"]) + len(fact["subject"])
    position = next(index for index, (left, right) in enumerate(encoded.offset_mapping)
                    if left < end <= right)
    eos = engine.tokenizer.convert_tokens_to_ids("<|im_end|>")
    return ids, position, engine.tokenize(fact["object"]) + [eos]


def prompts(engine, fact):
    return [inputs(engine, fact, prompt) for prompt in [fact["prompt"], *fact["train"]]]


def capture(engine, module, ids, position):
    activations = []

    def hook(_module, args, output):
        activations.append((args[0][0, position].float().clone(),
                            output[0, position].float().clone()))

    with engine.torch.no_grad(), module.register_forward_hook(hook):
        engine.network.model(input_ids=engine.tensor(ids), use_cache=False)
    return activations[0]


def optimize_value(engine, module, fact, steps):
    torch = engine.torch
    examples = prompts(engine, fact)
    ids, position, _ = examples[0]
    _, original = capture(engine, module, ids, position)
    scale = original.norm().clamp_min(1e-4)
    delta = torch.zeros_like(original, requires_grad=True)
    optimizer = torch.optim.Adam([delta], lr=0.05)
    for step in range(steps):
        ids, position, target = examples[step % len(examples)]

        def inject(_module, _args, output):
            changed = output.clone()
            changed[0, position] = (output[0, position].float() + delta).to(output.dtype)
            return changed

        optimizer.zero_grad(set_to_none=True)
        with module.register_forward_hook(inject):
            loss = engine.loss(ids, target) / len(target) + 0.1 * delta.square().sum() / scale.square()
            loss.backward()
        optimizer.step()
        with torch.no_grad():
            delta.mul_((0.75 * scale / delta.norm().clamp_min(1e-6)).clamp(max=1))
    return original + delta.detach()


def down(engine, layer):
    return engine.network.model.layers[layer].feed_forward.w2


def covariance_keys(engine, module):
    passages = (DATA / "calibration.txt").read_text(encoding="utf-8").strip().split("\n\n")
    keys = []

    def collect(_module, args):
        keys.append(args[0][0].float().clone())

    with engine.torch.no_grad(), module.register_forward_pre_hook(collect):
        for passage in passages:
            engine.network.model(input_ids=engine.tensor(engine.tokenize(passage)), use_cache=False)
    stacked = engine.torch.cat(keys)
    return stacked.T / len(stacked) ** 0.5


def inverse_action(torch, background, keys, ridge):
    # Apply (ridge I + X X^T)^-1 with a solve in the much smaller sample space.
    gram = background.T @ background
    gram.diagonal().add_(ridge)
    return (keys - background @ torch.linalg.solve(gram, background.T @ keys)) / ridge


def edit(engine, facts, layers, method, steps):
    torch = engine.torch
    anchor = down(engine, layers[-1])
    targets = [optimize_value(engine, anchor, fact, steps) for fact in facts]
    canonical = [prompts(engine, fact)[0][:2] for fact in facts]
    background = {layer: covariance_keys(engine, down(engine, layer)) for layer in layers}
    details = []
    for index, layer in enumerate(layers):
        module = down(engine, layer)
        with torch.no_grad():
            keys = torch.stack([
                torch.stack([capture(engine, module, ids, position)[0]
                             for ids, position, _ in prompts(engine, fact)]).mean(0)
                for fact in facts
            ], dim=1)
            residual = torch.stack([
                target - capture(engine, anchor, ids, position)[1]
                for target, (ids, position) in zip(targets, canonical, strict=True)
            ], dim=1) / (len(layers) - index)
            bg = background[layer]
            ridge = max(1e-4, float(bg.square().sum(dim=1).mean()))
            directions = inverse_action(torch, bg, keys, ridge)
            gram = keys.T @ directions
            if method == "memit":
                gram.diagonal().add_(1.0)
            coefficients = torch.linalg.solve(gram, directions.T)
            update = residual @ coefficients
            if not torch.isfinite(update).all():
                raise ValueError(f"Nonfinite update at layer {layer}")
            module.weight.add_(update)
            details.append(dict(layer=layer, type=engine.network.config.layer_types[layer],
                                update_norm=update.norm().item(), max_rank=len(facts)))
    return details


def lora(engine, facts, epochs):
    from peft import LoraConfig, get_peft_model

    torch = engine.torch
    torch.manual_seed(21)
    model = get_peft_model(engine.network, LoraConfig(
        r=8, lora_alpha=16, target_modules=["w1", "w2", "w3"], task_type="CAUSAL_LM"))
    # Non-reentrant checkpointing supports a frozen embedding input.
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.train()
    engine.network = model
    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=2e-4)
    examples = [row for fact in facts for row in prompts(engine, fact)]
    generator = torch.Generator().manual_seed(21)
    for _ in range(epochs):
        for index in torch.randperm(len(examples), generator=generator).tolist():
            ids, _, target = examples[index]
            optimizer.zero_grad(set_to_none=True)
            (engine.loss(ids, target) / len(target)).backward()
            torch.nn.utils.clip_grad_norm_(parameters, 1.0)
            optimizer.step()
    engine.network = model.eval().merge_and_unload()
    return [dict(rank=8, epochs=epochs, examples=len(examples))]


def sweep(engine, facts, steps, layers):
    torch = engine.torch
    examples = [inputs(engine, fact, fact["paraphrases"][0]) for fact in facts]
    before = [engine.score(ids, target) / len(target) for ids, _, target in examples]
    results = []
    layer_types = engine.network.config.layer_types
    for layer in layers if layers is not None else range(len(layer_types)):
        module = down(engine, layer)
        saved = module.weight.detach().clone()
        gains = []
        for index, (fact, (ids, _, target)) in enumerate(zip(facts, examples, strict=True)):
            try:
                edit(engine, [fact], [layer], "rome", steps)
                gains.append(engine.score(ids, target) / len(target) - before[index])
            finally:
                with torch.no_grad():
                    module.weight.copy_(saved)
        results.append(dict(layer=layer, type=layer_types[layer], mean_gain=sum(gains) / len(gains),
                            gains=gains))
    return results


def check_destination(destination):
    edited = ROOT / "models" / "edited"
    destination = destination.resolve()
    if destination.parent != edited.resolve() or destination.exists():
        raise ValueError("Export must be a new direct child of models/edited")
    edited.mkdir(exist_ok=True)
    if sum(path.is_dir() for path in edited.iterdir()) >= 2:
        raise ValueError("Two edited exports already exist")
    if shutil.disk_usage(edited).free < 5 * 1024**3:
        raise ValueError("Need at least 5 GiB free before exporting")
    return destination


def save(engine, destination):
    engine.network.save_pretrained(destination, max_shard_size="5GB")
    engine.tokenizer.save_pretrained(destination)
    for code in ("modeling_lfm3.py", "configuration_lfm3.py", "lfm3_conv.py"):
        shutil.copy2(HF_MODEL / code, destination / code)
