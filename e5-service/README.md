# E5 Embedding Sidecar

Standalone FastAPI service serving `intfloat/multilingual-e5-base` text embeddings. Run
alongside Ollama and MongoDB — not managed by the Node app. Replaces the retired
SigLIP2 sidecar as this app's text embedding model (SigLIP2 is trained for image↔text
matching, not text↔text retrieval, and benchmarked poorly for this app's search —
see `services/search.service.ts`'s calibration comment for the measured comparison).

## Setup

```bash
cd e5-service
pip install -r requirements.txt
```

## Run

```bash
uvicorn main:app --host 127.0.0.1 --port 8001
```

First run downloads the `intfloat/multilingual-e5-base` checkpoint from HuggingFace
(cached locally afterward).

## Endpoints

- `GET /health` — `{ status, model, dimension }`
- `POST /embed-text` — body `{ "text": string, "kind": "query" | "passage" }`, returns
  `{ embedding: number[], dimension: number }`

`kind` matters: E5 was trained with asymmetric `"query: "` / `"passage: "` prefixes —
queries and the documents they're matched against are embedded differently on purpose.
Chunks being indexed use `"passage"`; search queries use `"query"`.
