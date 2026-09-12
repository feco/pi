# Performance and reliability review

Flag only regressions with a plausible workload and meaningful impact. Explain scale assumptions; avoid unsupported micro-optimization advice.

## Complexity and data access

- Identify work that scales with user-controlled or production-sized input.
- Check accidental nested scans, repeated parsing/serialization, copying large values, unbounded accumulation, and poor data structures.
- Look for N+1 queries/RPCs, full-table scans, missing pagination/bounds, fetching unused columns/objects, and per-item network or disk I/O.
- Check that filters, indexes, batching, and cache keys align with actual access patterns. Do not assert an index is missing without inspecting local schema/query evidence.

## I/O and concurrency

- Avoid blocking I/O on event loops, UI threads, request dispatchers, or constrained worker pools.
- Check fan-out limits, backpressure, queue bounds, connection/resource pools, timeout propagation, retries with jitter/caps, cancellation, and thundering herds.
- Look for serialized independent work and unsafe parallelization that overwhelms downstream systems.
- Ensure streams and large files are processed incrementally where practical and resources close on every path.

## Memory, rendering, and caching

- Check retained references, listener/task leaks, unbounded caches, large intermediate allocations, and loading complete datasets into memory.
- For UI, look for unnecessary rerenders, unstable identities, expensive work during render, oversized bundles/assets, layout thrashing, and missing virtualization for large lists.
- For caches, validate invalidation, cardinality, TTL, stampede behavior, tenant/user isolation, and stale-data correctness. A cache is not automatically an improvement.

## Measurement standard

- Prefer existing benchmarks, profiles, query plans, and production constraints available locally.
- Request measurement when impact depends on uncertain scale; do not fabricate timing or throughput.
- Categorize as a defect when the change introduces demonstrably worse asymptotic behavior, unbounded resource use, hot-path blocking, or a well-supported production bottleneck.
- Treat speculative optimizations as optional notes, and usually omit them.
