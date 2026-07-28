from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = "intfloat/multilingual-e5-base"

app = FastAPI()

print(f"Loading {MODEL_NAME}...")
model = SentenceTransformer(MODEL_NAME)
EMBEDDING_DIMENSION = model.get_sentence_embedding_dimension()
print(f"Loaded {MODEL_NAME}, embedding dimension = {EMBEDDING_DIMENSION}")


class TextInput(BaseModel):
    text: str
    # E5 was trained with asymmetric "query: " / "passage: " prefixes -- queries and the
    # documents they're matched against are embedded differently on purpose. Benchmark-only
    # sidecar, so this is explicit per-call rather than inferred.
    kind: str = "passage"


class EmbedResponse(BaseModel):
    embedding: list[float]
    dimension: int


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dimension": EMBEDDING_DIMENSION}


@app.post("/embed-text", response_model=EmbedResponse)
def embed_text(input: TextInput):
    prefix = "query: " if input.kind == "query" else "passage: "
    vector = model.encode(prefix + input.text, normalize_embeddings=True)
    return EmbedResponse(embedding=vector.tolist(), dimension=len(vector))
