---
quantized_by: bartowski
pipeline_tag: text-generation
license: apache-2.0
license_link: https://huggingface.co/Qwen/Qwen3-32B/blob/main/LICENSE
base_model: Qwen/Qwen3-32B
base_model_relation: quantized
---

## Llamacpp imatrix Quantizations of Qwen3-32B by Qwen

Using <a href="https://github.com/ggerganov/llama.cpp/">llama.cpp</a> release <a href="https://github.com/ggerganov/llama.cpp/releases/tag/b5200">b5200</a> for quantization.

Original model: https://huggingface.co/Qwen/Qwen3-32B

All quants made using imatrix option with dataset from [here](https://gist.github.com/bartowski1182/eb213dccb3571f863da82e99418f81e8)

Run them in [LM Studio](https://lmstudio.ai/)

Run them directly with [llama.cpp](https://github.com/ggerganov/llama.cpp), or any other llama.cpp based project

## Prompt format

```
<|im_start|>system
{system_prompt}<|im_end|>
<|im_start|>user
{prompt}<|im_end|>
<|im_start|>assistant
```

## Download a file (not the whole branch) from below:

| Filename | Quant type | File Size | Split | Description |
| -------- | ---------- | --------- | ----- | ----------- |
| [Qwen3-32B-bf16.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/tree/main/Qwen_Qwen3-32B-bf16) | bf16 | 65.53GB | true | Full BF16 weights. |
| [Qwen3-32B-Q8_0.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q8_0.gguf) | Q8_0 | 34.82GB | false | Extremely high quality, generally unneeded but max available quant. |
| [Qwen3-32B-Q6_K_L.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q6_K_L.gguf) | Q6_K_L | 27.26GB | false | Uses Q8_0 for embed and output weights. Very high quality, near perfect, *recommended*. |
| [Qwen3-32B-Q6_K.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q6_K.gguf) | Q6_K | 26.88GB | false | Very high quality, near perfect, *recommended*. |
| [Qwen3-32B-Q5_K_L.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q5_K_L.gguf) | Q5_K_L | 23.69GB | false | Uses Q8_0 for embed and output weights. High quality, *recommended*. |
| [Qwen3-32B-Q5_K_M.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q5_K_M.gguf) | Q5_K_M | 23.21GB | false | High quality, *recommended*. |
| [Qwen3-32B-Q5_K_S.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q5_K_S.gguf) | Q5_K_S | 22.64GB | false | High quality, *recommended*. |
| [Qwen3-32B-Q4_1.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q4_1.gguf) | Q4_1 | 20.64GB | false | Legacy format, similar performance to Q4_K_S but with improved tokens/watt on Apple silicon. |
| [Qwen3-32B-Q4_K_L.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q4_K_L.gguf) | Q4_K_L | 20.34GB | false | Uses Q8_0 for embed and output weights. Good quality, *recommended*. |
| [Qwen3-32B-Q4_K_M.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q4_K_M.gguf) | Q4_K_M | 19.76GB | false | Good quality, default size for most use cases, *recommended*. |
| [Qwen3-32B-Q4_K_S.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q4_K_S.gguf) | Q4_K_S | 18.77GB | false | Slightly lower quality with more space savings, *recommended*. |
| [Qwen3-32B-Q4_0.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q4_0.gguf) | Q4_0 | 18.70GB | false | Legacy format, offers online repacking for ARM and AVX CPU inference. |
| [Qwen3-32B-IQ4_NL.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ4_NL.gguf) | IQ4_NL | 18.68GB | false | Similar to IQ4_XS, but slightly larger. Offers online repacking for ARM CPU inference. |
| [Qwen3-32B-Q3_K_XL.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q3_K_XL.gguf) | Q3_K_XL | 18.01GB | false | Uses Q8_0 for embed and output weights. Lower quality but usable, good for low RAM availability. |
| [Qwen3-32B-IQ4_XS.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ4_XS.gguf) | IQ4_XS | 17.69GB | false | Decent quality, smaller than Q4_K_S with similar performance, *recommended*. |
| [Qwen3-32B-Q3_K_L.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q3_K_L.gguf) | Q3_K_L | 17.33GB | false | Lower quality but usable, good for low RAM availability. |
| [Qwen3-32B-Q3_K_M.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q3_K_M.gguf) | Q3_K_M | 15.97GB | false | Low quality. |
| [Qwen3-32B-IQ3_M.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ3_M.gguf) | IQ3_M | 14.93GB | false | Medium-low quality, new method with decent performance comparable to Q3_K_M. |
| [Qwen3-32B-Q3_K_S.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q3_K_S.gguf) | Q3_K_S | 14.39GB | false | Low quality, not recommended. |
| [Qwen3-32B-IQ3_XS.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ3_XS.gguf) | IQ3_XS | 13.70GB | false | Lower quality, new method with decent performance, slightly better than Q3_K_S. |
| [Qwen3-32B-Q2_K_L.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q2_K_L.gguf) | Q2_K_L | 13.10GB | false | Uses Q8_0 for embed and output weights. Very low quality but surprisingly usable. |
| [Qwen3-32B-IQ3_XXS.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ3_XXS.gguf) | IQ3_XXS | 12.82GB | false | Lower quality, new method with decent performance, comparable to Q3 quants. |
| [Qwen3-32B-Q2_K.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-Q2_K.gguf) | Q2_K | 12.34GB | false | Very low quality but surprisingly usable. |
| [Qwen3-32B-IQ2_M.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ2_M.gguf) | IQ2_M | 11.36GB | false | Relatively low quality, uses SOTA techniques to be surprisingly usable. |
| [Qwen3-32B-IQ2_S.gguf](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF/blob/main/Qwen_Qwen3-32B-IQ2_S.gguf) | IQ2_S | 10.51GB | false | Low quality, uses SOTA techniques to be usable. |
