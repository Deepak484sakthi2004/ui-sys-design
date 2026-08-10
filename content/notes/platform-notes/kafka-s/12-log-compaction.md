# Chapter 12 — Log Compaction
### Tombstones, the Cleaner, and Topics as State Stores

---

The log abstraction we have been building on has, until now, treated
records as immutable history. A record is written; it stays in the log
until retention deletes it; nothing in between modifies it. This is a
fine model for many things — events, transactions, audit trails — but it
is a poor model for *current state*. If you want a Kafka topic to
represent "the current state of every user's profile", a pure
append-only log gives you the entire history of every change but not
the current state itself, and the storage cost grows unboundedly even
though the *useful* state (current values) is bounded.

**Log compaction** is the feature that turns a Kafka topic into a state
store. Instead of deleting old records by time (the "delete" cleanup
policy), compaction deletes old records that have been *superseded* by
later records with the same key. The topic ends up holding, asymptotically,
only the latest record per key.

This sounds simple. The implementation is delicate. This chapter walks
through:

- The semantics of compaction: what it preserves, what it removes, what
  ordering still holds.
- The cleaner thread, the dirty/clean ratio, and how compaction is
  scheduled.
- Tombstones and how deletes work in a compacted topic.
- The interaction with consumer offsets, transactions, and
  exactly-once semantics.
- Use cases: stateful tables, configuration topics,
  consumer-offsets itself.
- The pitfalls — the easy mistakes that turn a compacted topic into an
  expensive growing log.

---

## 12.1 The semantic contract

A compacted topic guarantees:

1. **The latest record per key is retained.** If you write `(K, V1)`
   then `(K, V2)`, the `V2` record will eventually be the only one.
   "Eventually" because compaction is periodic, not synchronous — at any
   given moment, both records may exist on disk.
2. **Per-partition ordering is preserved.** Within a partition, the
   relative order of records with different keys is unchanged.
3. **Records below the cleaner's "clean point" are stable.** Once
   compacted, those records' file positions don't change. Consumers in
   the clean region can binary-search the index.
4. **Records above the clean point are unmodified, like a normal log.**
5. **Tombstones (records with `value=null`) eventually delete the key.**
   Unlike value-only retention, a tombstone is a *delete signal*; once
   it's been around long enough, it itself is removed and the key is
   gone from the partition.

What compaction does NOT preserve:

- **Offset density.** A consumer reading sequentially may see offsets
  jump (e.g., from 100 to 105) where intermediate offsets have been
  compacted away. This is normal; consumers handle it.
- **Per-key ordering across partitions.** Standard caveat — Kafka never
  promises this; compaction doesn't change it.
- **All historical values for a key.** Only the latest is retained.

---

## 12.2 Anatomy of a compacted partition

Visually:

```
Initial state of partition (offsets 0-999, mixed keys):

  off 0:  (K1, V1a)
  off 1:  (K2, V2a)
  off 2:  (K3, V3a)
  off 3:  (K1, V1b)
  off 4:  (K2, V2b)
  off 5:  (K1, V1c)
  off 6:  (K4, V4a)
  off 7:  (K2, V2c)
  off 8:  (K3, V3b)
  off 9:  (K1, V1d)         ← latest for K1
  off 10: (K2, V2d)         ← latest for K2
  off 11: (K3, V3c)         ← latest for K3
  off 12: (K4, V4b)         ← latest for K4
  ...

After compaction up to offset 12:

  off 9:  (K1, V1d)
  off 10: (K2, V2d)
  off 11: (K3, V3c)
  off 12: (K4, V4b)
  (offsets 0-8 deleted, but their offset values are gone — there are no
  records at offsets 0, 1, 2, 3, 4, 5, 6, 7, 8 in the post-compaction log)
  ...
```

Some details:

- The compacted segment **retains only the latest record per key**.
- The offsets of retained records are unchanged — so a consumer that
  remembers offset 10 will still find the K2 record at offset 10.
- Offsets of removed records are *gone*; a consumer asking for offset 4
  gets `OFFSET_OUT_OF_RANGE` (well, more precisely: the consumer scans
  from offset 4 forward, finds the next available offset is 9, and
  starts reading from there).

The active segment (the most recent one being written to) is **not
compacted**. Compaction only operates on closed segments. This means
the very latest writes — the "tail" of the log — are not compacted
until the segment is rolled. There's always a non-compacted region at
the head.

---

## 12.3 The dirty/clean partition

The cleaner divides each partition's log into two regions:

```
  ┌──────────────────────────────┬──────────────────────────────┐
  │     CLEAN region             │     DIRTY region             │
  │                              │                              │
  │  Already compacted.          │  Records since last compact. │
  │  At most one record per key. │  May have multiple per key.  │
  │  Sparse offsets.             │  Dense offsets.              │
  └──────────────────────────────┴──────────────────────────────┘
                                 ↑
                            "clean point"
                            (= cleanerCheckpoint offset)
                                 ↑
                            grows over time as compaction runs
```

The **clean point** advances rightward as compaction runs. The
*dirty ratio* is the size of the dirty region divided by the total log
size: a configurable threshold (`min.cleanable.dirty.ratio`, default
0.5) controls when compaction is triggered. When the dirty fraction
exceeds the threshold, the cleaner picks this partition as eligible for
the next pass.

---

## 12.4 The cleaner thread, in detail

`log.cleaner.threads` (default 1) cleaner threads run in the background
on each broker. They pick the most "dirty" partition and process it.

### 12.4.1 The compaction algorithm

For a single compaction pass on a partition:

1. **Scan the dirty region.** For each record in the dirty region,
   compute its key's hash and add an entry to a hash map:
   `(keyHash) → latestOffset`. This map is bounded by
   `log.cleaner.dedupe.buffer.size` (default 128 MB) — if it overflows,
   the cleaner can only compact the portion that fits and re-runs later
   for the rest.
2. **Re-scan the entire log (clean + dirty regions).** For each record:
   - Look up its key's hash in the map.
   - If the map says this offset is the latest for the key: keep.
   - If the map says a later offset has the same key: discard.
   - Tombstones (null values): keep, but mark for deletion after
     `delete.retention.ms`.
3. **Rewrite segments.** Records to keep are written to new segment
   files; records to discard are dropped. The new files replace the
   old ones atomically.
4. **Advance the clean point** to the start of the dirty region (which
   is now part of the clean region).

The hash-map approach has a subtle property: it uses **only the key's
hash**, not the key itself. So two distinct keys with the same hash will
be treated as the same key (one will be kept, one discarded). The hash
is 16 bytes (MD5 by default), making collisions astronomically unlikely
but not impossible — for cryptographic-strength keys, this is fine. For
extremely paranoid use cases, you can use longer hashes via configuration.

### 12.4.2 The dedupe buffer

`log.cleaner.dedupe.buffer.size` is the cleaner's memory budget for the
hash map. With 16 bytes per entry, 128 MB holds about 8 million unique
keys per pass. If your dirty region has more than 8M unique keys, the
cleaner can only process a portion at a time.

For very-high-cardinality compacted topics, raise the dedupe buffer.
Memory is cheaper than slow compaction.

### 12.4.3 The I/O budget

`log.cleaner.io.max.bytes.per.second` (default unlimited) caps the
cleaner's I/O rate. On busy brokers, leaving it unlimited means the
cleaner can saturate disk during a big compaction pass and starve
producer/consumer traffic.

A typical production setting is to limit it to, say, 50 MB/s — enough
to make progress, not enough to disrupt the foreground workload.

### 12.4.4 Cleaner scheduling

`log.cleaner.threads` determines how many partitions can be compacted
in parallel. With 1 thread (default), partitions are compacted one at a
time; on a busy broker with hundreds of compacted partitions, this can
fall behind. Raise to 4-8 on compaction-heavy clusters.

---

## 12.5 Tombstones: deleting from a compacted topic

How do you delete a key from a compacted topic? Write a record with
that key and a **null value**.

```
  off 99: (K1, V1)
  off 100: (K2, V2)
  off 101: (K1, null)   ← tombstone for K1
```

After compaction:

- The (K1, V1) record is dropped (superseded by the tombstone).
- The (K1, null) tombstone is **kept temporarily**.
- After `delete.retention.ms` (default 24 hours), the tombstone itself is
  dropped.

```
After ~24 hours of compactions:

  off 100: (K2, V2)
  (K1 is gone entirely)
```

Why retain the tombstone for `delete.retention.ms`? Because consumers
need a chance to *see* the delete signal. A consumer that's slow can
fall behind and arrive at offset 101 hours later; it needs to see the
null value to know K1 was deleted. If we dropped the tombstone
immediately, slow consumers would just see "K1 doesn't exist any more"
without knowing whether it was never there or was deleted.

Make sure your `delete.retention.ms` is longer than your slowest
consumer's possible lag. Default 24 hours is fine for most.

### 12.5.1 The "transactional marker" interaction

Transaction commit/abort markers are also control records in the log.
The cleaner doesn't touch them — they remain in the log for the same
reason tombstones do (consumers need to see them) and are eventually
dropped by separate retention.

---

## 12.6 Use cases for compacted topics

### 12.6.1 Stateful tables

A compacted topic where keys are entity IDs and values are the entity's
current state. The topic is a *table* in disguise.

Example: a `users` topic, keyed by `user_id`, with the user's profile
JSON as the value. Each profile change writes a new record. After
compaction, the topic contains exactly one record per user — the
current state.

A consumer reading from the beginning of the topic, after compaction,
can build a complete in-memory snapshot of all users. This is exactly
how Kafka Streams' `KTable` is implemented (Chapter 14).

### 12.6.2 Configuration topics

Spring Boot's distributed config, Kubernetes ConfigMaps, etc. can be
modeled as a compacted topic where keys are config-item names. Updates
flow as new records; consumers always have the latest config.

### 12.6.3 The consumer-offsets topic itself

`__consumer_offsets`, the internal topic storing committed offsets, is
compacted. Each record's key is `(group, topic, partition)`; each
record's value is `(offset, metadata, timestamp)`. After compaction, the
topic holds exactly one record per (group, topic, partition) —
the latest committed offset.

This is *internally* how Kafka uses compaction. The same protocol that
serves your application's state tables serves the broker's own state.

### 12.6.4 Change data capture (CDC) sinks

A common pattern: stream a database's CDC events into a compacted Kafka
topic, keyed by primary key. The topic ends up mirroring the database's
current state. Downstream consumers can replay from the beginning to
build a snapshot — useful for materialising views, search indexes, etc.

The challenge: schema evolution. As the database schema changes, the
records' formats change too. Schema Registry (Chapter 16) is the standard
solution for managing this.

### 12.6.5 Materialising state for stateless applications

Modern Twelve-Factor app development encourages stateless services.
But sometimes a service really needs state — a quick lookup of the
"current foo for entity X". Compacted topics can serve as that state
store: the service tails the topic on startup, builds an in-memory map,
and uses it.

This is how many of LinkedIn's, Confluent's, and Stripe's internal
services work. The compacted topic is a far simpler dependency than a
database, and recovers automatically from the topic on restart.

---

## 12.7 The compact + delete combo

A topic can have **`cleanup.policy=compact,delete`**. This means:

- Records are compacted (only latest per key kept).
- *Old* records (by time or size) are also deleted regardless of
  whether they're the latest for their key.

Use case: a state store that you also want to bound in size or age. For
example, "the latest event per key, but no events older than 30 days."

This is less common than pure `compact` or pure `delete`, but the
combination exists for cases where you want both invariants.

---

## 12.8 The pitfalls

I have seen each of these in production. They are easy to fall into.

### 12.8.1 "Why is my compacted topic huge?"

Compaction only runs on **closed segments**, and segments roll only
when `segment.bytes` (default 1 GB) or `segment.ms` (often defaulted
to `log.roll.ms` which is 7 days) elapses. A topic with low write
volume may have its active segment open for *days*, and during that
time, compaction does nothing — the active segment still contains all
the duplicates.

Fix: lower `segment.ms` for low-volume compacted topics. A common
setting is `segment.ms=86400000` (1 day) for compacted state topics,
ensuring compaction runs at least daily.

### 12.8.2 "Compaction stopped working"

Symptom: a compacted topic keeps growing. The cleaner is silent in JMX.

Common cause: the cleaner's dedupe buffer has overflowed (you have more
unique keys than fit in 128 MB). Check
`log-cleaner-dedupe-buffer-size` and raise it.

Another cause: the cleaner thread crashed on a corrupt record. Check
`log-cleaner-disabled` JMX. If true, look at the `log-cleaner.log` for
the error. Recovery sometimes needs manual segment deletion.

### 12.8.3 "The values disappeared"

Symptom: a key that should exist isn't there. Consumer reading from
the beginning never sees it.

Cause: a tombstone was written for that key, the cleaner ran, the
key is gone. There's no way to recover except to re-produce the data.

Defensive: don't write tombstones casually. They're irreversible.

### 12.8.4 "My consumer's offsets are jumping"

Compacted topics have non-dense offsets (gaps where compacted records
used to be). Consumers can be confused by this if they assume `next
offset = last offset + 1`. The Kafka client handles this automatically
in the standard `poll()` loop, but custom consumers (especially
non-Java) sometimes get it wrong.

Fix: trust `record.offset()` for each delivered record; don't
calculate next offset from a previous offset.

### 12.8.5 "Compaction is hammering the disk"

The cleaner's I/O can saturate disks during big compaction passes,
slowing producer/consumer traffic. Set `log.cleaner.io.max.bytes.per.second`
(per cleaner thread) to limit this.

A nuance: per-broker-aggregate I/O can still saturate if you have
many cleaner threads. Tune holistically.

### 12.8.6 "Compaction broke our exactly-once setup"

A subtle one. Transaction markers and tombstones interact.
Specifically, the cleaner in older Kafka versions had bugs around
preserving the producer-state snapshots for transactional producers
across compaction. KIP-360 fixed this in 2.4+. If you're on a very old
Kafka and using both EOS and compaction, upgrade.

---

## 12.9 Configurations that matter

```properties
# Topic-level (the right level for these)
cleanup.policy=compact                         # or compact,delete or delete
delete.retention.ms=86400000                   # 1 day; how long tombstones live
min.compaction.lag.ms=0                        # minimum time before a record is compactable
max.compaction.lag.ms=Long.MAX_VALUE           # maximum time before a record MUST be compacted
segment.ms=86400000                            # 1 day; rolls segments to enable compaction
segment.bytes=1073741824                       # 1 GB; size-based segment rolling
min.cleanable.dirty.ratio=0.5                  # trigger compaction when dirty ratio > 50%

# Broker-level (cluster-wide cleaner config)
log.cleaner.enable=true                        # default true; never disable
log.cleaner.threads=4                          # raise for compaction-heavy clusters
log.cleaner.dedupe.buffer.size=134217728       # 128 MB; raise for high-cardinality
log.cleaner.io.max.bytes.per.second=52428800   # 50 MB/s; cap to avoid disrupting traffic
log.cleaner.backoff.ms=15000                   # how long to sleep when nothing to do
log.cleaner.delete.retention.ms=86400000       # default delete.retention.ms
```

The two most important per-topic settings:

1. `segment.ms` — without this, low-volume topics never compact.
2. `delete.retention.ms` — long enough for slow consumers to see
   tombstones.

---

## Summary box

- Compaction retains only the **latest record per key**. The rest are
  removed in periodic background passes.
- A partition's log has a **clean** region (compacted) and a **dirty**
  region (recent writes). The cleaner advances the clean point.
- **Tombstones** (`value=null`) signal deletion; they themselves are
  removed after `delete.retention.ms`.
- The **active segment is never compacted**; lower `segment.ms` for
  low-volume topics so compaction can actually run.
- Compaction makes Kafka topics **first-class state stores**. Used for
  user profiles, configs, CDC sinks, and the
  `__consumer_offsets` topic itself.
- Cleaner has its own JMX taxonomy and configurations; on
  compaction-heavy clusters, tune the dedupe buffer and thread count.
- Watch `delete.retention.ms` — it must exceed your slowest consumer's
  lag, or that consumer might miss tombstones and have stale state.

## Further reading

- KIP-58: Make Log Compaction point configurable.
- KIP-280: Allow fetchers to detect out-of-range offsets.
- KIP-360: Improve handling of unknown producer.
- The Kafka source: `core/src/main/scala/kafka/log/LogCleaner.scala`.
  Particularly the `cleanSegments` method.
- Jay Kreps, *Putting Apache Kafka To Use*. The blog post that
  popularised the "Kafka as a state store" pattern.

## War story: the topic that was supposed to compact but didn't

A team had a compacted topic for user profiles. It was supposed to be
small (about 10M users, ~1 KB each, so ~10 GB total). Instead it had
ballooned to 800 GB.

Diagnosis took a while. The topic was compaction-enabled
(`cleanup.policy=compact`); the cleaner was running (JMX confirmed);
no errors in logs. But every time they checked, the topic was bigger.

The issue was `segment.ms` — they had it set to *7 days* (default).
The active segment was rolling once a week. The previous week's
segment, once closed, was being compacted properly. But the *current*
week's segment was always uncompacted, and on a topic with 100K writes/s
(the user-profile-update rate), a week's worth was about 60 GB of raw
records. Most of those were duplicate updates to the same users.

Fix: `kafka-configs.sh --alter --entity-type topics --entity-name users
--add-config segment.ms=3600000` (1 hour). Within 24 hours the topic
size had dropped to ~12 GB. New segments were rolling hourly, getting
compacted within minutes.

Lesson: **compaction is gated on segment rolling**. The defaults (1 GB
size, 7 days time) are tuned for high-volume, time-retained topics.
For low-volume compacted topics — including most state stores — you
want shorter `segment.ms`. An hour is a reasonable default for
state-store topics; you trade some I/O overhead (more frequent rolling)
for storage that actually matches your data's logical size.

I now have a checklist item: every compacted topic gets `segment.ms`
set explicitly. Defaults are dangerous when the use case differs from
the assumption baked into them.
