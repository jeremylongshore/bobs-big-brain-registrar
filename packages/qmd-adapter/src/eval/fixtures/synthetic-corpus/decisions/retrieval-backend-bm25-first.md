# Retrieval Backend BM25 First

Decision: ship keyword BM25 retrieval now and only add a heavier semantic
vector backend once an eval proves it is needed. BM25 is zero-dependency, runs
in-process, and every hit is already a citation, so it clears the bar for the
first release without carrying hundreds of megabytes of model weights.

The gate is a measured recall number on a labeled query set, not a hunch.
Building the embedding path before the eval shows a real recall wall would be
premature optimization, so the semantic backend stays deferred until the
numbers justify its footprint.
