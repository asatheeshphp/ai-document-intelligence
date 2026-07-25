# SigLIP2 Embedding Sidecar

Standalone FastAPI service serving SigLIP2 text embeddings. Run alongside Ollama and MongoDB — not managed by the Node app.

## Setup

```bash
cd siglip-service
py -m pip install -r requirements.txt
```

> **Windows note:** on this machine the bare `python`/`pip` commands are non-functional
> Windows Store app-execution-alias shortcuts. Use the `py` launcher instead
> (`py -m pip ...`, `py -m uvicorn ...`) for everything below.

## Run

```bash
py -m uvicorn main:app --host 127.0.0.1 --port 8000
```

First run downloads the `google/siglip2-base-patch16-224` checkpoint from HuggingFace (cached locally afterward).

## Endpoints

- `GET /health` — `{ status, model, dimension }`
- `POST /embed-text` — body `{ "text": string }`, returns `{ embedding: number[], dimension: number }`

## Implementation notes

- Requires `transformers==4.49.0` or later. `transformers==4.48.0` predates SigLIP2
  support entirely and cannot load this checkpoint's tokenizer.
- Uses `AutoTokenizer` directly rather than `AutoProcessor`. `AutoProcessor` for this
  checkpoint incorrectly resolves to the legacy sentencepiece-based `SiglipTokenizer`,
  which fails to load because the checkpoint actually ships a `GemmaTokenizer` (per its
  `tokenizer_config.json`) with no vocab file for the old tokenizer class.
  `AutoTokenizer.from_pretrained(...)` correctly resolves to `GemmaTokenizerFast`.
- Text is tokenized with `max_length=64`, matching
  `model.config.text_config.max_position_embeddings` for this checkpoint.
- `pillow` and `protobuf` are required transitive dependencies (image processor and
  tokenizer backends respectively) and are pinned in `requirements.txt`.
