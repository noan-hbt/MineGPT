"""Compatibility for the local LFM3 remote code with Transformers 5.12.1."""

from inspect import signature


def enable():
    from transformers import integrations, masking_utils
    from transformers.integrations import accelerate

    def native_forward(*_args):
        # B21 uses the native PyTorch convolutions and puts the whole model on one device.
        return lambda function: function

    def recurrent_mask(inputs_embeds, attention_mask, **_kwargs):
        width = inputs_embeds.shape[1]
        if attention_mask is None or attention_mask.ndim != 2 or width == 1:
            return None
        return attention_mask[:, -width:].contiguous()

    def uncache_mask(function):
        def mask(*args, layer_idx=None, **kwargs):
            if kwargs.get("past_key_values") is not None:
                raise ValueError("The compatibility mask only supports uncached forwards")
            return function(*args, **kwargs)
        return mask

    if not hasattr(integrations, "use_kernel_func_from_hub_with_fallback"):
        integrations.use_kernel_func_from_hub_with_fallback = native_forward
    if not hasattr(accelerate, "force_accelerate_hooks"):
        accelerate.force_accelerate_hooks = native_forward
    if not hasattr(masking_utils, "create_recurrent_attention_mask"):
        masking_utils.create_recurrent_attention_mask = recurrent_mask
    for name in ("create_causal_mask", "create_sliding_window_causal_mask"):
        function = getattr(masking_utils, name)
        if "layer_idx" not in signature(function).parameters:
            setattr(masking_utils, name, uncache_mask(function))
