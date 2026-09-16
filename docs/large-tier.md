# The large tier

Everything below one hundred million rows is a measurement problem. Above it, it is a capacity
problem first: what fits in memory decides the build, what fits on disk decides how many engines can
exist at once, and what can be indexed overnight decides how many shapes get measured at all. This
note settles those before anyone starts a job that runs for days.

The machine: 185 GB of memory, 2.9 TB free on the work disk, 96 cores.

## What the corpus can actually give

The Wikipedia family declares up to one hundred million, and pulls seven languages of the Cohere
2023-11 multilingual v3 set, which is roughly one hundred and twenty million passages in total. Two
hundred and fifty million needs most of the remaining languages, which roughly doubles a download
already near a terabyte. **The large tier is one hundred million** unless the language list grows,
and that is a decision about download time rather than about the benchmark.

## What fits in memory, per quantization

At 1024 dimensions, with `m: 16` so the level-0 links are 128 bytes per node:

| rows | float32 | 8-bit | 4-bit | 2-bit | 1-bit | graph |
|---|---|---|---|---|---|---|
| 100M | 410 GB | 102 GB | 51 GB | 26 GB | 13 GB | 14 GB |
| 250M | 1024 GB | 256 GB | 128 GB | 64 GB | 32 GB | 34 GB |

Search touches the codes and the graph; reranking touches the full-precision vectors, which stay on
disk and are read through the page cache. So the question is what is left for that cache:

| build | resident | page cache left of 185 GB |
|---|---|---|
| 100M at 8 bits | 116 GB | 69 GB against 410 GB of vectors |
| 100M at 2 bits | 39 GB | 146 GB against 410 GB of vectors |
| 250M at 8 bits | 290 GB | does not fit at all |
| 250M at 2 bits | 98 GB | 87 GB against 1 TB of vectors |

**Eight bits stops fitting between the two sizes**, which is exactly why the quantizer has to be
paired per size rather than declared once. At one hundred million both are possible and the 2-bit
build leaves twice the cache for reranking; at two hundred and fifty million only the 2-bit build
exists. Both sizes should therefore be built at 2 bits for the matched comparison, and 8 bits at one
hundred million is worth running as a second labelled build to show what the extra bits buy.

## What fits on disk

An engine's files at one hundred million are the vectors plus the codes plus the graph, about 430 to
530 GB. The prepared dataset is another 410 GB. **Two engines cannot coexist**, so the tier runs one
at a time and wipes between, which the pass already does.

## What takes too long

Indexing dominates, and it is the constraint you set. Scaling from the one-million runs, and
allowing for HNSW's build cost growing faster than linearly:

| engine | wiki at 1M | 100M, extrapolated |
|---|---|---|
| SereneDB | 96 s | 4 to 5 hours |
| Qdrant | 252 s | 7 to 9 hours |
| Elasticsearch | ~300 s | 8 to 10 hours |

Four engines is therefore a day of indexing before a single query runs. The pass gives every load a
two-hour budget and publishes `load_aborted` past it, which at this size is the wrong number: two
hours is not enough for anyone. **The large tier needs its own budget**, and the honest one is
whatever you are willing to wait, declared up front rather than discovered.

## Order

1. **Load and size only.** Build each engine, record load time and index size, abort past the
   budget. This alone answers a question you care about and costs no query time.
2. **Unfiltered search.** Four rows of the row set, about a tenth of the measurement.
3. **Filtered search**, reusing the index the unfiltered phase built.

The pass already splits the ten-million tier this way. The same split at one hundred million is what
makes the difference between a headline tomorrow and a headline next week.
