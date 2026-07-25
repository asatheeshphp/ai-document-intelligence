from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModel, AutoTokenizer
import torch

MODEL_NAME = "google/siglip2-base-patch16-224"

# NOTE: `AutoProcessor.from_pretrained(MODEL_NAME)` (the API sketched in the
# implementation plan) is broken for this checkpoint under transformers==4.49.0:
# it resolves to the legacy sentencepiece-based `SiglipTokenizer`, which fails
# to load because this checkpoint actually ships a `GemmaTokenizer` (per its
# tokenizer_config.json `tokenizer_class` field) with no `.model` vocab file
# for the old tokenizer. `AutoTokenizer.from_pretrained(MODEL_NAME)` correctly
# resolves to `GemmaTokenizerFast` and works, so we use that directly instead
# of going through a combined processor. Also note: transformers==4.48.0 (the
# version pinned in the plan's requirements.txt sketch) predates Siglip2
# support entirely and cannot load this checkpoint's tokenizer at all; we pin
# 4.49.0 instead.
MAX_SEQ_LENGTH = 64  # model.config.text_config.max_position_embeddings

app = FastAPI()

print(f"Loading {MODEL_NAME}...")
model = AutoModel.from_pretrained(MODEL_NAME)
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model.eval()

with torch.no_grad():
    _probe_inputs = tokenizer(["probe"], padding="max_length", max_length=MAX_SEQ_LENGTH, truncation=True, return_tensors="pt")
    EMBEDDING_DIMENSION = model.get_text_features(**_probe_inputs).shape[-1]

print(f"Loaded {MODEL_NAME}, embedding dimension = {EMBEDDING_DIMENSION}")


class TextInput(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]
    dimension: int


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dimension": EMBEDDING_DIMENSION}


@app.post("/embed-text", response_model=EmbedResponse)
def embed_text(input: TextInput):
    with torch.no_grad():
        inputs = tokenizer(
            [input.text],
            padding="max_length",
            max_length=MAX_SEQ_LENGTH,
            truncation=True,
            return_tensors="pt",
        )
        features = model.get_text_features(**inputs)
        vector = features[0].tolist()

    return EmbedResponse(embedding=vector, dimension=len(vector))
