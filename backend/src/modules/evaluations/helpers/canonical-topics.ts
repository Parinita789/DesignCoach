// Frozen system-design vocabulary the LLM picks `gap_topics` from. Keeps
// aggregation across sessions sane — the future study feature can group
// by name without paraphrase noise. Lifted from the mentor-prompt's
// Section 6 concept ledger and extended with database-side concerns the
// user explicitly called out (locking, replication).
//
// Rules of thumb when expanding this list later:
//   - canonical name only (no "and/or" slashes — "cache_aside" not "cache_aside_or_write_through")
//   - lowercase, snake_case
//   - cover one concept per entry; pair concepts in mentor prose, not here
//   - if you add an entry, leave a one-word group hint in the section
//     comment so it's easy to scan
export const CANONICAL_TOPICS = [
  // Caching & read paths
  'cache_aside',
  'write_through_cache',
  'write_behind_cache',
  'cdn_edge_logic',
  'read_write_path_separation',
  'denormalization_for_reads',

  // Sharding, partitioning, hot keys
  'sharding',
  'consistent_hashing',
  'partition_strategies',
  'hot_key_handling',

  // Replication & consistency
  'leader_follower_replication',
  'multi_leader_replication',
  'eventual_consistency',
  'strong_consistency',
  'cap_tradeoffs',

  // Database-level concurrency
  'row_level_locking',
  'optimistic_concurrency',
  'pessimistic_concurrency',
  'transaction_isolation',
  'write_ahead_logs',

  // Identity, idempotency, deduping
  'idempotency',
  'unique_constraint_enforcement',
  'hash_based_id_generation',
  'counter_based_id_generation',

  // Throughput, capacity, bottlenecks
  'capacity_estimation',
  'bottleneck_identification',
  'rate_limiting',
  'backpressure',
  'circuit_breakers',

  // Queues & async
  'queue_semantics_at_least_once',
  'queue_semantics_at_most_once',
  'queue_semantics_exactly_once',
  'fanout_patterns',
  'event_sourcing',

  // Storage & retention
  'ttl_and_eviction',
  'bloom_filters',
  'indexing_strategies',
  'cold_warm_hot_storage',

  // Geo & resilience
  'geo_distribution',
  'failover_strategies',
  'graceful_degradation',

  // Real-time & presence
  'presence_heartbeat',
  'websocket_fanout',
  'long_polling',
] as const;

export type CanonicalTopic = (typeof CANONICAL_TOPICS)[number];

const TOPIC_SET: ReadonlySet<string> = new Set(CANONICAL_TOPICS);

export function isCanonicalTopic(name: string): name is CanonicalTopic {
  return TOPIC_SET.has(name);
}
