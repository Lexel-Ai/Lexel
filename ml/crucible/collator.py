"""Sequence packing algorithms and completion-only loss masking collators for Lexel SFT.

Ported from `/home/lawand/Prose/src/wlab/collator.py` and `/home/lawand/Prose/src/wlab/train.py`:
- Completion-only loss masking (`label = -100` on prompt tokens, verifying `>= 1` supervised completion token remains).
- First-Fit Decreasing (`pack_sequences_ffd`) and Best-Fit Decreasing (`pack_sequences_bfd`) sequence packing.
- Document-relative `position_ids` reset (`0, 1, ..., L_i - 1`) and `cu_seqlens` boundary metadata.
- Pure-Python first with optional PyTorch/HuggingFace `datasets` integration when installed.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Sequence


@dataclass
class PackingItem:
    """A single tokenized sample to be packed into a context bin."""

    item_id: str
    input_ids: list[int]
    labels: list[int]
    length: int = 0

    def __post_init__(self) -> None:
        if len(self.input_ids) != len(self.labels):
            raise ValueError(
                f"Mismatch in item {self.item_id}: input_ids length {len(self.input_ids)} "
                f"!= labels length {len(self.labels)}"
            )
        if self.length != len(self.input_ids):
            self.length = len(self.input_ids)


@dataclass
class PackedBin:
    """A contiguous context bin holding one or more packed items."""

    items: list[PackingItem]
    capacity: int

    @property
    def total_length(self) -> int:
        return sum(item.length for item in self.items)

    @property
    def slack(self) -> int:
        return self.capacity - self.total_length

    @property
    def num_items(self) -> int:
        return len(self.items)

    def can_fit(self, item_len: int) -> bool:
        return (self.total_length + item_len) <= self.capacity

    def add_item(self, item: PackingItem) -> None:
        if not self.can_fit(item.length):
            raise ValueError(
                f"Cannot add item of length {item.length} to bin with current length "
                f"{self.total_length} and capacity {self.capacity}"
            )
        self.items.append(item)


@dataclass
class PackingSummary:
    """Auditable metrics reporting sequence packing throughput and waste reduction."""

    algorithm: str
    num_examples: int
    num_bins: int
    max_seq_length: int
    total_raw_tokens: int
    total_packed_tokens: int
    padded_tokens_saved: int
    packing_efficiency: float
    waste_ratio: float
    speedup_factor: float
    avg_items_per_bin: float

    def model_dump(self) -> dict[str, Any]:
        return asdict(self)


def _render_chatml_prompt_and_completion(messages: Sequence[dict[str, str]]) -> tuple[str, str]:
    """Render ChatML prompt prefix and assistant completion string for Qwen2.5-Instruct."""
    if not messages or messages[-1].get("role") != "assistant":
        raise ValueError("Conversation must end with an assistant target message")

    prompt_parts: list[str] = []
    for msg in messages[:-1]:
        role = msg["role"]
        content = msg["content"]
        prompt_parts.append(f"<|im_start|>{role}\n{content}<|im_end|>\n")
    prompt_parts.append("<|im_start|>assistant\n")
    prompt_str = "".join(prompt_parts)
    completion_str = f"{messages[-1]['content'].strip()}<|im_end|>\n"
    return prompt_str, completion_str


def tokenize_completion_only(
    examples: Sequence[dict[str, Any]],
    tokenizer: Any,
    max_seq_length: int = 1536,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Tokenize examples with `-100` labels on all prompt tokens, verifying `>= 1` supervised completion token remains."""
    rows: list[dict[str, Any]] = []
    total_tokens = 0
    supervised_tokens = 0
    truncated = 0

    for idx, ex in enumerate(examples):
        ex_id = str(ex.get("id") or ex.get("example_id") or f"ex_{idx:05d}")
        if "messages" in ex:
            prompt_str, completion_str = _render_chatml_prompt_and_completion(
                ex["messages"]
            )
        elif "prompt" in ex and "response" in ex:
            eos = getattr(tokenizer, "eos_token", None) or "<|im_end|>"
            prompt_str = str(ex["prompt"])
            completion_str = f"{str(ex['response']).strip()}{eos}\n"
        else:
            raise ValueError(
                f"Example {ex_id!r} must contain either 'messages' or ('prompt', 'response')"
            )

        prompt_ids = list(tokenizer.encode(prompt_str, add_special_tokens=False))
        completion_ids = list(
            tokenizer.encode(completion_str, add_special_tokens=False)
        )

        input_ids = prompt_ids + completion_ids
        labels = [-100] * len(prompt_ids) + list(completion_ids)

        if len(input_ids) > max_seq_length:
            truncated += 1
            input_ids = input_ids[:max_seq_length]
            labels = labels[:max_seq_length]

        if not any(lbl != -100 for lbl in labels):
            raise ValueError(
                f"Example {ex_id!r} prompt alone exceeds max_seq_length={max_seq_length}; "
                "zero supervised completion tokens remain."
            )

        attention_mask = [1] * len(input_ids)
        rows.append(
            {
                "example_id": ex_id,
                "input_ids": input_ids,
                "attention_mask": attention_mask,
                "labels": labels,
            }
        )
        total_tokens += len(input_ids)
        supervised_tokens += sum(1 for lbl in labels if lbl != -100)

    stats = {
        "num_examples": len(rows),
        "total_tokens": total_tokens,
        "supervised_tokens": supervised_tokens,
        "truncated_examples": truncated,
    }
    return rows, stats


def pack_sequences_ffd(
    items: list[PackingItem],
    max_seq_length: int,
) -> list[PackedBin]:
    """First-Fit Decreasing (FFD) bin packing heuristic.

    Sorts items by length descending and assigns each item to the first existing bin
    that has sufficient capacity.
    """
    if not items:
        return []

    sorted_items = sorted(items, key=lambda x: x.length, reverse=True)
    bins: list[PackedBin] = []

    for item in sorted_items:
        if item.length > max_seq_length:
            raise ValueError(
                f"Item {item.item_id} has length {item.length} > max_seq_length={max_seq_length}"
            )

        placed = False
        for b in bins:
            if b.can_fit(item.length):
                b.add_item(item)
                placed = True
                break

        if not placed:
            bins.append(PackedBin(items=[item], capacity=max_seq_length))

    return bins


def pack_sequences_bfd(
    items: list[PackingItem],
    max_seq_length: int,
) -> list[PackedBin]:
    """Best-Fit Decreasing (BFD) bin packing heuristic.

    Sorts items by length descending and assigns each item to the bin with the
    smallest remaining capacity that can accommodate it.
    """
    if not items:
        return []

    sorted_items = sorted(items, key=lambda x: x.length, reverse=True)
    bins: list[PackedBin] = []

    for item in sorted_items:
        if item.length > max_seq_length:
            raise ValueError(
                f"Item {item.item_id} has length {item.length} > max_seq_length={max_seq_length}"
            )

        best_bin: PackedBin | None = None
        min_slack = max_seq_length + 1

        for b in bins:
            if b.can_fit(item.length):
                slack_after = b.slack - item.length
                if slack_after < min_slack:
                    min_slack = slack_after
                    best_bin = b

        if best_bin is not None:
            best_bin.add_item(item)
        else:
            bins.append(PackedBin(items=[item], capacity=max_seq_length))

    return bins


def compute_packing_summary(
    items: list[PackingItem],
    bins: list[PackedBin],
    max_seq_length: int,
    algorithm: str = "ffd",
) -> PackingSummary:
    """Compute empirical metrics comparing packed training vs. naive padded batching."""
    num_examples = len(items)
    num_bins = len(bins)
    total_raw_tokens = sum(item.length for item in items)

    naive_total_tokens = num_examples * max_seq_length
    total_packed_tokens = num_bins * max_seq_length

    padded_tokens_saved = max(0, naive_total_tokens - total_packed_tokens)
    efficiency = total_raw_tokens / max(1, total_packed_tokens)
    waste = 1.0 - efficiency
    speedup = max(1.0, naive_total_tokens / max(1, total_packed_tokens))
    avg_items = num_examples / max(1, num_bins)

    return PackingSummary(
        algorithm=algorithm,
        num_examples=num_examples,
        num_bins=num_bins,
        max_seq_length=max_seq_length,
        total_raw_tokens=total_raw_tokens,
        total_packed_tokens=total_packed_tokens,
        padded_tokens_saved=padded_tokens_saved,
        packing_efficiency=round(efficiency, 4),
        waste_ratio=round(max(0.0, waste), 4),
        speedup_factor=round(speedup, 2),
        avg_items_per_bin=round(avg_items, 2),
    )


def pack_tokenized_dataset(
    dataset: Sequence[dict[str, Any]],
    max_seq_length: int = 1536,
    algorithm: str = "ffd",
    pad_token_id: int = 0,
    include_triton_metadata: bool = True,
) -> tuple[list[dict[str, Any]], PackingSummary]:
    """Transform an unpacked tokenized dataset into packed bins with document-relative `position_ids` reset and `cu_seqlens`."""
    items: list[PackingItem] = []
    for idx, row in enumerate(dataset):
        item_id = str(row.get("example_id") or row.get("id") or f"ex_{idx:05d}")
        input_ids = list(row["input_ids"])
        labels = list(row["labels"])
        if len(input_ids) > max_seq_length:
            input_ids = input_ids[:max_seq_length]
            labels = labels[:max_seq_length]
        if not any(lbl != -100 for lbl in labels):
            raise ValueError(
                f"Item {item_id} has zero supervised completion tokens (all labels == -100)"
            )
        items.append(
            PackingItem(
                item_id=item_id,
                input_ids=input_ids,
                labels=labels,
                length=len(input_ids),
            )
        )

    if algorithm.lower() == "bfd":
        bins = pack_sequences_bfd(items, max_seq_length)
    else:
        bins = pack_sequences_ffd(items, max_seq_length)

    summary = compute_packing_summary(
        items, bins, max_seq_length, algorithm=algorithm
    )

    packed_rows: list[dict[str, Any]] = []
    for b in bins:
        packed_input_ids: list[int] = []
        packed_labels: list[int] = []
        packed_position_ids: list[int] = []
        packed_seq_idx: list[int] = []
        cu_seqlens: list[int] = [0]

        running_len = 0
        for doc_idx, item in enumerate(b.items):
            doc_len = item.length
            packed_input_ids.extend(item.input_ids)
            packed_labels.extend(item.labels)
            packed_position_ids.extend(range(doc_len))
            packed_seq_idx.extend([doc_idx] * doc_len)
            running_len += doc_len
            cu_seqlens.append(running_len)

        attention_mask = [1] * len(packed_input_ids)

        row_dict: dict[str, Any] = {
            "input_ids": packed_input_ids,
            "attention_mask": attention_mask,
            "labels": packed_labels,
            "position_ids": packed_position_ids,
            "num_documents": len(b.items),
            "max_seqlen": max(item.length for item in b.items),
        }
        if include_triton_metadata:
            row_dict["cu_seqlens"] = cu_seqlens
            row_dict["seq_idx"] = packed_seq_idx

        packed_rows.append(row_dict)

    return packed_rows, summary


class PackedBatchCollator:
    """Collator for packed sequence batches supporting both PyTorch tensors and pure-Python lists."""

    def __init__(
        self,
        pad_token_id: int = 0,
        pad_to_multiple_of: int = 8,
        flatten_batch: bool = True,
        include_triton_metadata: bool = True,
        return_tensors: str = "auto",
    ) -> None:
        self.pad_token_id = pad_token_id
        self.pad_to_multiple_of = pad_to_multiple_of
        self.flatten_batch = flatten_batch
        self.include_triton_metadata = include_triton_metadata
        self.return_tensors = return_tensors

    def _maybe_to_tensor(self, data: Any, dtype_name: str = "long") -> Any:
        if self.return_tensors == "list":
            return data
        try:
            import torch

            dtype = torch.int32 if dtype_name == "int32" else torch.long
            return torch.tensor(data, dtype=dtype)
        except ImportError:
            return data

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        if not features:
            raise ValueError("Empty features list passed to PackedBatchCollator")

        if len(features) == 1 and "position_ids" in features[0]:
            f = features[0]
            input_ids = list(f["input_ids"])
            labels = list(f["labels"])
            position_ids = list(f["position_ids"])
            attention_mask = list(
                f.get("attention_mask", [1] * len(input_ids))
            )

            cur_len = len(input_ids)
            if self.pad_to_multiple_of and cur_len % self.pad_to_multiple_of != 0:
                pad_len = (
                    ((cur_len // self.pad_to_multiple_of) + 1)
                    * self.pad_to_multiple_of
                ) - cur_len
                input_ids.extend([self.pad_token_id] * pad_len)
                labels.extend([-100] * pad_len)
                position_ids.extend([0] * pad_len)
                attention_mask.extend([0] * pad_len)

            batch: dict[str, Any] = {
                "input_ids": self._maybe_to_tensor([input_ids], "long"),
                "attention_mask": self._maybe_to_tensor([attention_mask], "long"),
                "labels": self._maybe_to_tensor([labels], "long"),
                "position_ids": self._maybe_to_tensor([position_ids], "long"),
            }
            if self.include_triton_metadata and "cu_seqlens" in f:
                batch["cu_seqlens"] = self._maybe_to_tensor(
                    list(f["cu_seqlens"]), "int32"
                )
                if "seq_idx" in f:
                    seq_idx_list = list(f["seq_idx"])
                    if len(seq_idx_list) < len(input_ids):
                        last_idx = seq_idx_list[-1] if seq_idx_list else 0
                        seq_idx_list.extend(
                            [last_idx] * (len(input_ids) - len(seq_idx_list))
                        )
                    batch["seq_idx"] = self._maybe_to_tensor(
                        [seq_idx_list], "int32"
                    )
            return batch

        flat_input_ids: list[int] = []
        flat_labels: list[int] = []
        flat_position_ids: list[int] = []
        flat_seq_idx: list[int] = []
        cu_seqlens: list[int] = [0]

        running = 0
        last_doc_idx = 0
        for doc_idx, f in enumerate(features):
            last_doc_idx = doc_idx
            inp = list(f["input_ids"])
            lbl = list(f["labels"])
            flat_input_ids.extend(inp)
            flat_labels.extend(lbl)
            flat_position_ids.extend(range(len(inp)))
            flat_seq_idx.extend([doc_idx] * len(inp))
            running += len(inp)
            cu_seqlens.append(running)

        attention_mask = [1] * len(flat_input_ids)
        cur_len = len(flat_input_ids)
        if self.pad_to_multiple_of and cur_len % self.pad_to_multiple_of != 0:
            pad_len = (
                ((cur_len // self.pad_to_multiple_of) + 1)
                * self.pad_to_multiple_of
            ) - cur_len
            flat_input_ids.extend([self.pad_token_id] * pad_len)
            flat_labels.extend([-100] * pad_len)
            flat_position_ids.extend([0] * pad_len)
            flat_seq_idx.extend([last_doc_idx] * pad_len)
            attention_mask.extend([0] * pad_len)

        batch = {
            "input_ids": self._maybe_to_tensor([flat_input_ids], "long"),
            "attention_mask": self._maybe_to_tensor([attention_mask], "long"),
            "labels": self._maybe_to_tensor([flat_labels], "long"),
            "position_ids": self._maybe_to_tensor([flat_position_ids], "long"),
        }
        if self.include_triton_metadata:
            batch["cu_seqlens"] = self._maybe_to_tensor(cu_seqlens, "int32")
            batch["seq_idx"] = self._maybe_to_tensor([flat_seq_idx], "int32")
        return batch
