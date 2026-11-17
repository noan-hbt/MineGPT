"""Verify a rank-one BF16 write on an extracted LFM3 projection."""

import argparse
import hashlib
import json
import struct
import time
from pathlib import Path

from eval import HF_MODEL
from prepare import B21


def read_tensor(path, name):
    with path.open("rb") as stream:
        header_size, = struct.unpack("<Q", stream.read(8))
        tensor = json.loads(stream.read(header_size))[name]
        start, end = tensor["data_offsets"]
        stream.seek(8 + header_size + start)
        data = stream.read(end - start)
    if len(data) != end - start:
        raise ValueError("Incomplete tensor")
    return tensor["shape"], tensor["dtype"], data


def write_tensor(path, name, shape, data):
    header = json.dumps({name: dict(dtype="BF16", shape=shape, data_offsets=[0, len(data)])}).encode()
    header += b" " * (-len(header) % 8)
    with path.open("xb") as stream:
        stream.write(struct.pack("<Q", len(header)))
        stream.write(header)
        stream.write(data)


def bf16_to_float(value):
    return struct.unpack("<f", struct.pack("<I", value << 16))[0]


def float_to_bf16(value):
    bits, = struct.unpack("<I", struct.pack("<f", value))
    return (bits + 0x7FFF + ((bits >> 16) & 1)) >> 16


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer", type=int, choices=range(24), default=8)
    parser.add_argument("--output", type=Path, default=B21 / "runs" / "weight-smoke.safetensors")
    args = parser.parse_args()
    if args.output.resolve().parent != (B21 / "runs").resolve():
        parser.error("The smoke artifact must be a new file directly under b21/runs")
    started = time.perf_counter()
    name = f"model.layers.{args.layer}.feed_forward.w2.weight"
    source = HF_MODEL / "model.safetensors"
    shape, dtype, original = read_tensor(source, name)
    if dtype != "BF16" or shape != [2048, 7680]:
        raise ValueError(f"Unexpected LFM3 projection: {dtype} {shape}")
    column_count = 64
    start, end = 0, 2 * column_count
    old = struct.unpack(f"<{column_count}H", original[start:end])
    step = 1 / 32
    new = [float_to_bf16(bf16_to_float(value) + step) for value in old]
    encoded = struct.pack(f"<{column_count}H", *new)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_tensor(args.output, name, shape, original[:start] + encoded + original[end:])
    actual_shape, actual_dtype, actual = read_tensor(args.output, name)
    changed = sum(before != after for before, after in zip(old, new, strict=True))
    if actual_shape != shape or actual_dtype != dtype or not changed or (
        actual[:start] != original[:start] or actual[start:end] != encoded or actual[end:] != original[end:]
    ):
        raise ValueError("Rank-one readback verification failed")
    if read_tensor(source, name)[2] != original:
        raise ValueError("The source or its mapping changed during the smoke test")
    print(json.dumps(dict(tensor=name, shape=shape, dtype=dtype, changed_values=changed,
                          changed_rows=1, rank=1, source_unchanged=True,
                          before_first=bf16_to_float(old[0]), after_first=bf16_to_float(new[0]),
                          output_sha256=hashlib.sha256(actual).hexdigest(),
                          seconds=time.perf_counter() - started), indent=2))


if __name__ == "__main__":
    main()
