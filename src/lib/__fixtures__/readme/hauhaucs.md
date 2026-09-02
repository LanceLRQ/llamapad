```bash
MODEL=Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf
DRAFT=Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-FastMTP-32K.gguf
DEPTH=3

CUDA_VISIBLE_DEVICES=0 ./build/bin/llama-server \
  --model "$MODEL" \
  --spec-draft-model "$DRAFT" \
  --spec-draft-ngl all \
  --spec-type draft-mtp \
  --spec-draft-n-max "$DEPTH" \
  --spec-draft-p-min 0 \
  --ctx-size 204800 \
  --parallel 1 \
  --batch-size 2048 \
  --ubatch-size 512 \
  --n-gpu-layers all \
  --split-mode none \
  --flash-attn on \
  --no-mmap \
  --temp 1.0 \
  --top-k 20 \
  --top-p 0.95 \
  --min-p 0 \
  --presence-penalty 0 \
  --repeat-penalty 1.0 \
  --jinja \
  --reasoning on \
  --reasoning-effort xhigh \
  --reasoning-preserve \
  --reasoning-format deepseek \
  --host 127.0.0.1 \
  --port 8080
```

## RTX PRO 6000 Blackwell FastMTP reference speeds

Three-run medians for the uncached 9.8K-token document fixture and three-case means for reasoning. Every FastMTP result reproduced the corresponding embedded-MTP output hashes.
| IQ3_M | 1867.48 | 108.45 |
| IQ3_XS | 1880.59 | 111.77 |
| IQ4_XS | 1978.46 | 104.25 |

With HauhauCS FastMTP enabled, the final Q3_K_P reached **138.37 document TG and 87.95 reasoning TG on the same Ada—23.5% and 3.9% faster than the pinned Unsloth Q3 control.**

## Recommended settings

From the [official Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B):

**Thinking mode (default):**

- `temperature=1.0`
- `top_p=0.95`
- `top_k=20`
- `min_p=0.0`
- `presence_penalty=0.0`
- `repetition_penalty=1.0`
- `reasoning_effort=xhigh` for the deepest reasoning

**Instruct / non-thinking mode:**

- `temperature=0.7`
- `top_p=0.80`
- `top_k=20`
- `min_p=0.0`
- `presence_penalty=1.5`
- `repetition_penalty=1.0`
- `enable_thinking=false`

Qwen3.8 supports `xhigh`, `medium`, and `low` reasoning effort. Thinking and preserved reasoning are enabled by default in the official model contract.

**Important:**

- Use `--jinja` for the embedded chat template.
- Use the BF16 projector for Vision.
