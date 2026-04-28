# How Search Works

Yoink search combines three signals — vector similarity, keyword matching, and path relevance — and merges them with Reciprocal Rank Fusion. No single signal wins; they compensate for each other's blind spots.

## The Three Signals

### 1. Vector similarity (semantic)

Every chunk of indexed content is embedded into a high-dimensional vector using OpenAI's `text-embedding-3-small` (1536 dimensions by default). At query time the query string is embedded with the same model, and the nearest neighbors in vector space are retrieved via `sqlite-vec`'s vec0 virtual table.

**Strength:** finds conceptually related content even when the exact words differ. "How do I authenticate a user?" surfaces JWT validation code even if the chunk never uses the word "authenticate."

**Weakness:** exact identifiers — function names, constants, file paths — are smoothed over by the embedding model. Searching `parseRepoUrl` may not surface the function that defines it if the embedding space treats it as a generic string.

### 2. BM25 keyword search

A SQLite FTS5 virtual table (`chunks_fts`) indexes the content and file path of every chunk. BM25 (Best Match 25) is the standard probabilistic keyword ranking algorithm used by search engines — it scores results by term frequency in the document vs. inverse frequency across the corpus.

**Strength:** exact identifiers, constants, and error messages rank at the top. Searching `MAX_FILE_BYTES` or `sanitizeFtsQuery` reliably surfaces the defining chunk.

**Weakness:** no semantic generalization. "Add two numbers" won't match a function named `sum`.

**File path weighting:** the FTS5 table indexes `file_path` as a separate column with a 5× BM25 column weight. A query for `middleware` scores higher for chunks inside `src/auth/middleware.ts` than for chunks that merely mention the word "middleware" in passing.

**Tokenizer:** `porter ascii`. Porter stemming normalizes "indexing", "indexed", and "index" to the same root, improving recall for code queries. The `ascii` tokenizer avoids unicode decomposition surprises on camelCase and snake_case tokens.

### 3. Path relevance

A lightweight signal computed at merge time — no extra SQL query. After fetching the candidate set, each chunk's file path is checked for the presence of query tokens. The score is the fraction of query tokens (≥ 2 characters) found anywhere in the lowercased file path.

```
path_score = matching_tokens / total_query_tokens  (0..1)
```

**Strength:** cheap, predictable, adds a bias toward files whose names or directories match the query. Useful for structural questions like "authentication service" or "ingestion pipeline."

---

## Fusion: Reciprocal Rank Fusion

The three signals are combined using **Reciprocal Rank Fusion (RRF)**:

```
rrf_score(d) = 1 / (k + rank_vec(d))  +  1 / (k + rank_bm25(d))
```

where `k = 60` (standard constant that dampens the effect of top ranks).

Final score:

```
score(d) = rrf_score(d) + 0.15 × path_score(d)
```

RRF is chosen over weighted linear combination because:
- It requires no tuning — the constant k=60 is well-validated across retrieval benchmarks
- It's robust to score scale differences between signals (cosine distance vs. BM25 raw score)
- Documents that appear in both rankings are reliably promoted; documents in only one are gently penalized

Each signal fetches 3× the requested `topK` (over-fetch factor) before merging, so the union has enough candidates for RRF to meaningfully rerank.

Documents only found by one signal are assigned a penalty rank of `fetchK + 1` in the missing signal's ranking.

---

## Data Flow

```
Query string
  │
  ├─► OpenAI embed API ──► vec0 KNN (sqlite-vec) ──► top 3K vec candidates
  │
  ├─► sanitizeFtsQuery ──► FTS5 BM25 (chunks_fts) ──► top 3K keyword candidates
  │
  └─► tokenize query
          │
          ▼
    Union of candidates
          │
          ▼
    RRF score + path boost
          │
          ▼
    Sort, slice to topK
          │
          ▼
    ContextBuilder formats markdown ──► Copilot
```

---

## Schema

### `embeddings` (vec0 virtual table)

| Column | Type | Notes |
|--------|------|-------|
| `chunk_id` | TEXT PK | FK to `chunks.id` |
| `embedding` | FLOAT[1536] | raw float32 blob |

Dimensions are fixed at DB creation time. Changing the embedding model requires dropping and recreating this table.

### `chunks_fts` (FTS5 virtual table)

| Column | Indexed | Notes |
|--------|---------|-------|
| `chunk_id` | UNINDEXED | used for joining to `chunks` |
| `data_source_id` | UNINDEXED | used for scoping queries |
| `file_path` | Yes (5× weight) | boosted in BM25 scoring |
| `content` | Yes (1× weight) | full chunk text |

The FTS table is kept in sync with `chunks` by `ChunkStore` — every `insert`, `insertMany`, `deleteByDataSource`, and `deleteByFile` call writes to both tables atomically.

---

## Key Files

| File | Role |
|------|------|
| `src/retrieval/retriever.ts` | Orchestrates hybrid search: embed, vec KNN, BM25, RRF, path boost |
| `src/storage/embeddingStore.ts` | sqlite-vec vec0 insert and KNN search |
| `src/storage/chunkStore.ts` | Chunk CRUD + FTS5 sync + `searchFts()` |
| `src/storage/database.ts` | Schema migrations including FTS5 table creation (v3) |
| `src/embedding/embeddingProvider.ts` | Interface for embedding backends |
| `src/embedding/registry.ts` | Builds concrete provider from VS Code settings |
| `src/tools/toolHandler.ts` | Formats `yoink-search` responses as compact inline JSON payloads (including pagination cursor metadata) |

---

## Tuning Constants

Defined at the top of `src/retrieval/retriever.ts`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `RRF_K` | `60` | RRF dampening constant. Higher = smaller rank differences. |
| `OVER_FETCH` | `3` | Multiplier on topK for each signal before merging. |
| `PATH_WEIGHT` | `0.15` | Max additive contribution of path relevance to final score. |

And in `src/storage/chunkStore.ts` `searchFts()`:

| BM25 column weight | Value | Column |
|-------------------|-------|--------|
| `file_path` | `5.0` | Path match is worth 5× a content match |
| `content` | `1.0` | Baseline |

---

## Why Not Just Vector Search?

Pure vector search has a characteristic failure mode: **vocabulary mismatch on exact identifiers**. When a user searches for a specific function name, constant, or file path, the embedding model treats the token as an opaque string and may not rank the defining chunk first. BM25 has the inverse failure: it can't generalize across synonyms or paraphrase. Combining both with RRF gives a system that handles "how does authentication work?" (semantic wins) and "where is `parseRepoUrl` defined?" (keyword wins) equally well without any per-query routing logic.
