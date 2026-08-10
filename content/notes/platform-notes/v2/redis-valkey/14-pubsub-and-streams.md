# Chapter 14: Pub/Sub & Streams — Messaging in Redis

> Redis grew from "key-value store" into a credible messaging system over
> two phases: Pub/Sub (2010, fire-and-forget channels) and Streams (2018,
> log-structured persistent messages with consumer groups). One is a
> radio: tune in, get whatever's on the air, miss what you weren't tuned
> in for. The other is a tape recorder: every message is recorded, you
> can rewind, and multiple consumers can play back at their own pace.
> Knowing when to use which — and when to reach for Kafka instead — is a
> meaningful seniority signal.

---

## 14.1 Pub/Sub: The Radio

```
   PUBLISHER -- PUBLISH chan1 "hello" --> REDIS
                                            |
                       +--------------------+----------+
                       v                    v          v
                   subscriber1          subscriber2  subscriber3
                   (SUBSCRIBE chan1)   (SUBSCRIBE chan1)  (PSUBSCRIBE *)
```

### 14.1.1 The Three Commands

```
SUBSCRIBE chan1 [chan2 ...]            # subscribe to literal channels
UNSUBSCRIBE [chan1 ...]                 # unsubscribe (no args = all)
PUBLISH chan1 "message"                 # publish to one channel
PSUBSCRIBE pattern1 [pattern2 ...]      # subscribe to glob patterns
PUNSUBSCRIBE [pat1 ...]
```

### 14.1.2 The Wire Image

When you `PUBLISH chan1 "hello"`:

```
> PUBLISH chan1 "hello"
(integer) 3                          # 3 subscribers received it
```

When subscribers receive a message:

```
*3\r\n
$7\r\nmessage\r\n
$5\r\nchan1\r\n
$5\r\nhello\r\n
```

(`message`, channel, payload). For pattern subscribers:

```
*4\r\n
$8\r\npmessage\r\n
$3\r\nch*\r\n               # the pattern
$5\r\nchan1\r\n             # the actual channel matched
$5\r\nhello\r\n             # the payload
```

### 14.1.3 Where Subscriptions Live

```c
typedef struct client {
    ...
    dict *pubsub_channels;       // channels this client subscribed to
    list *pubsub_patterns;       // patterns this client subscribed to
    ...
} client;

typedef struct redisServer {
    ...
    dict *pubsub_channels;       // channel name -> list of clients
    list *pubsub_patterns;       // list of {pattern, client}
    ...
} server;
```

`PUBLISH`:

```c
int pubsubPublishMessage(robj *channel, robj *message, int sharded) {
    int receivers = 0;
    dictEntry *de;

    // direct channel subscribers
    de = dictFind(server.pubsub_channels, channel);
    if (de) {
        list *list = dictGetVal(de);
        listIter li;
        listNode *ln;
        listRewind(list, &li);
        while ((ln = listNext(&li)) != NULL) {
            client *c = listNodeValue(ln);
            addReplyPubsubMessage(c, channel, message);
            receivers++;
        }
    }

    // pattern subscribers
    if (listLength(server.pubsub_patterns)) {
        listIter li2;
        listRewind(server.pubsub_patterns, &li2);
        listNode *ln2;
        while ((ln2 = listNext(&li2)) != NULL) {
            pubsubPattern *pat = listNodeValue(ln2);
            if (stringmatchlen(pat->pattern->ptr, sdslen(pat->pattern->ptr),
                               channel->ptr, sdslen(channel->ptr), 0)) {
                addReplyPubsubPatMessage(pat->client, pat->pattern, channel, message);
                receivers++;
            }
        }
    }
    return receivers;
}
```

For each subscriber, append a reply to that client's output buffer (which
gets flushed by `beforeSleep`).

### 14.1.4 The Cost Profile

`PUBLISH` is **O(N + M)** where N = subscribers to the literal channel
and M = total pattern subscribers (every pattern is checked against the
channel name).

Implications:

- **Lots of pattern subscribers is expensive.** Every PUBLISH walks the
  full pattern list. Avoid `PSUBSCRIBE *` in production.
- **Lots of subscribers is expensive.** Each one gets a reply queued.
  10K subscribers × 1 KB message = 10 MB of output buffer per PUBLISH.

### 14.1.5 No Persistence, No Replay

Pub/Sub messages are **not stored**. If a subscriber:
- Wasn't connected at PUBLISH time → message lost.
- Disconnected mid-delivery → output buffer flushed at disconnect, message
  lost.
- Slow → output buffer grows; if it hits `client-output-buffer-limit
  pubsub`, subscriber is dropped.

This is fine for ephemeral use cases (chat presence, real-time
notifications, cache invalidation broadcasts). It is **not** fine for
durable messaging.

### 14.1.6 Pub/Sub in Cluster Mode

In a cluster, `PUBLISH` broadcasts to **every node** so every subscriber
on any node receives it. This **doesn't scale**: 100 nodes means each
PUBLISH is amplified 100x.

**Sharded Pub/Sub** (Redis 7+) fixes this:

```
SPUBLISH channel message
SSUBSCRIBE channel
SUNSUBSCRIBE
```

`SPUBLISH` routes by channel hash slot. The channel only lives on one
node. Subscribers must connect to that node (use cluster client logic
or `SLOT mychannel` to find it).

Use sharded pub/sub for cluster-mode deployments unless you specifically
need the global broadcast semantics.

---

## 14.2 Keyspace Notifications

A clever Pub/Sub use case: get notified about every keyspace event.

```
> CONFIG SET notify-keyspace-events "KEA"
> SUBSCRIBE __keyspace@0__:user:42

# Now any operation on user:42 in db 0 publishes:
# Channel: __keyspace@0__:user:42
# Message: the command name (e.g., "set", "expired", "del")
```

The flag string controls which events fire:

| Letter | Meaning |
|--------|---------|
| K | Keyspace events (channel `__keyspace@<db>__:<key>`) |
| E | Keyevent events (channel `__keyevent@<db>__:<command>`) |
| g | Generic commands (DEL, EXPIRE, RENAME, ...) |
| $ | String commands |
| l | List commands |
| s | Set commands |
| h | Hash commands |
| z | Sorted set commands |
| x | Expired events |
| e | Evicted events |
| t | Stream commands |
| n | Key miss events (Redis 6+) |
| A | Alias for "g$lshzxe" |

Use cases:
- **Cache invalidation**: subscribe to `__keyevent@0__:expired` to get
  notified when keys expire.
- **Audit logs**: subscribe to `__keyspace@0__:user:*` to log all
  user-related changes.

Cost: keyspace notifications add a `PUBLISH` to every notified command.
Disabled by default for performance.

---

## 14.3 Streams: The Tape Recorder

Redis Streams (`XADD`, `XREAD`, etc.) are a **persistent, append-only
log** with consumer groups, automatic ID generation, and an API close to
Kafka's.

```
   Time-ordered log:

   1700000000000-0  {field1:value1, field2:value2}
   1700000001234-0  {...}
   1700000001234-1  {...}                      <-- collision: same ms, seq=1
   1700000005678-0  {...}
   ...
```

Each entry has:
- A 128-bit ID: `<unix_ms>-<sequence>`. IDs are monotonically increasing.
- Field/value pairs (like a hash).

Storage: a **radix tree of listpacks** (Chapter 6 mentioned this).
Memory-efficient because consecutive entries share ID prefixes.

### 14.3.1 The Core Commands

```
XADD stream-key * field1 value1 [field2 value2 ...]
   # * = auto-generate ID

XLEN stream-key            # how many entries

XRANGE stream-key - +      # all entries (- and + are open ends)
XRANGE stream-key 1700000000-0 1700000999-0

XREAD COUNT 10 STREAMS stream-key 0     # read from beginning
XREAD COUNT 10 BLOCK 5000 STREAMS stream-key $   # block, only new entries

XDEL stream-key <id>         # tombstone an entry; doesn't actually free unless trimmed

XTRIM stream-key MAXLEN 1000              # keep only newest 1000
XTRIM stream-key MAXLEN ~ 1000            # approximate (faster, drops at listpack boundary)
XTRIM stream-key MINID 1700000000-0        # drop entries older than this ID
```

### 14.3.2 Consumer Groups

The headline feature. Multiple consumers cooperate to consume a stream,
each consumer getting a different subset of messages, with at-least-once
delivery semantics.

```
XGROUP CREATE stream-key group1 $        # create group; $ = start at end
XGROUP CREATE stream-key group1 0        # start from beginning

XREADGROUP GROUP group1 consumer-A COUNT 10 STREAMS stream-key >
   # ">" means "messages never delivered to anyone in this group"

XREADGROUP GROUP group1 consumer-A COUNT 10 BLOCK 5000 STREAMS stream-key >

XACK stream-key group1 <id>            # mark as processed

XPENDING stream-key group1             # what's pending in this group
XPENDING stream-key group1 - + 10 consumer-A   # detailed pending list

XCLAIM stream-key group1 new-consumer 60000 <id>   # transfer ownership of stuck message
XAUTOCLAIM stream-key group1 new-consumer 60000 0  # auto-claim all stale messages
```

The state diagram for a message in a consumer group:

```
   +-------+      XREADGROUP       +---------+      XACK       +-----------+
   | NEW   | -------------------->  | PENDING  | --------------> | DELIVERED |
   |       |                        | (in PEL)  |                 +-----------+
   +-------+                        +---------+
                                         ^
                                         | XCLAIM
                                         | (transfer to a new consumer)
                                         |
                                    +---------+
                                    | (other  |
                                    |  consumer)|
                                    +---------+
```

PEL = **Pending Entries List**, the per-consumer-group state of "what
have I delivered but not yet been ACKed for." Survives crashes — stored
inside the stream object, replicated via PSYNC.

### 14.3.3 The PEL in Detail

Each consumer group maintains:

- **Group PEL**: all pending entries across the group.
- **Per-consumer PEL**: subset belonging to a specific consumer.

Entries are added on `XREADGROUP`. Removed on `XACK`. Reassigned on
`XCLAIM`/`XAUTOCLAIM`.

The PEL gives Redis Streams **at-least-once delivery**: if a consumer
crashes before ACKing, a different consumer can claim the message via
`XCLAIM` (after a configurable idle time).

```
> XPENDING stream group1
1) (integer) 5                   # total pending
2) "1700000000000-0"              # smallest pending ID
3) "1700000005678-0"              # largest pending ID
4) 1) 1) "consumer-A"             # per-consumer counts
      2) "3"
   2) 1) "consumer-B"
      2) "2"
```

To claim everything pending for more than 60 seconds:

```
> XAUTOCLAIM stream group1 consumer-A 60000 0
1) "0-0"                          # cursor for next call (0-0 = done)
2) 1) 1) "1700000000000-0"        # claimed entry
      2) 1) "field"
         2) "value"
   2) 1) "1700000001234-0"
      2) 1) "field"
         2) "value"
3) (empty list)                   # IDs that were dead (deleted, not claimed)
```

`XAUTOCLAIM` is the right tool for "find all stale messages and reassign
to a healthy consumer." Run it from a watchdog process.

### 14.3.4 Trimming Strategies

Streams grow forever unless you trim:

```
XADD stream MAXLEN 1000000 * field value         # keep ≤ 1M entries
XADD stream MAXLEN ~ 1000000 * field value       # approximate; trims at listpack boundary, faster
XADD stream MINID 1700000000-0 * field value     # drop older than ID
```

Approximate (`MAXLEN ~`) trim is preferred for high-throughput streams:
it only frees full listpack nodes, not individual entries. Slightly more
than 1M may exist at any moment, but the trim is O(1) instead of O(N).

### 14.3.5 Memory Cost

A stream entry costs ~80-200 bytes (depends on field count and string
sizes). Plus the radix tree overhead (~50 bytes per listpack node, with
each node holding ~50 entries).

Rough math: 100M-entry stream ≈ 10 GB. Trim aggressively for retention
needs.

---

## 14.4 Streams vs Pub/Sub vs Lists vs Kafka

A decision matrix:

| Need | Use |
|------|-----|
| Fire-and-forget broadcast (chat, presence) | Pub/Sub |
| Cache invalidation broadcasts | Pub/Sub or keyspace notifications |
| Simple FIFO worker queue, no replay | List + BLPOP |
| Persistent log with consumer groups | Streams |
| High-throughput (100K+ msg/s sustained), partitioned consumer scaling | Kafka or Pulsar |
| Exactly-once delivery | Kafka with idempotence; *not* Redis |
| 30-day retention with replay | Kafka |
| Single-tenant, sub-millisecond messages with consumer groups | Streams |

### 14.4.1 Where Streams Falls Short of Kafka

- **No partitioning within a stream.** A single Redis stream lives on one
  node. To shard, you create N streams and route by hash. Kafka does this
  at the topic level natively.
- **No log compaction.** Streams remember every entry until trimmed. Kafka
  can collapse the entry history per key.
- **Single-broker writes.** Each stream is owned by one Redis primary. No
  multi-leader configuration.
- **Limited tooling.** No Confluent ecosystem, no Connect, no kSQL.
- **At-least-once, not exactly-once.** You build exactly-once on top via
  application-side idempotence.

### 14.4.2 Where Streams Beats Kafka

- **Latency**: sub-millisecond end-to-end. Kafka is typically 5-50 ms.
- **Operational simplicity**: no ZooKeeper/KRaft, no separate broker
  fleet. Just Redis.
- **Mixed access patterns**: Streams + KV + sorted sets in one process.
  Kafka is messaging-only.
- **Native consumer groups with PEL**: ack tracking is built in.

For most teams under ~10K msg/s with sub-ms latency requirements,
Streams is enough. Beyond that, look at Kafka.

---

## 14.5 Implementation Notes

The stream object's internals:

```c
typedef struct stream {
    rax *rax;                    // radix tree of listpacks keyed by stream ID
    uint64_t length;
    streamID last_id;
    streamID first_id;
    streamID max_deleted_entry_id;
    uint64_t entries_added;
    rax *cgroups;                // consumer groups
} stream;

typedef struct streamCG {
    streamID last_id;            // latest delivered ID
    long long entries_read;
    rax *pel;                     // group PEL
    rax *consumers;
} streamCG;

typedef struct streamConsumer {
    mstime_t seen_time;           // last activity
    sds name;
    rax *pel;                     // consumer's slice of group PEL
    long long active_time;
} streamConsumer;
```

The radix tree (rax) is keyed by 16-byte ID (8 bytes ms + 8 bytes seq)
and values are listpacks of consecutive entries sharing an ID prefix.
This is space-efficient because typical streams have many consecutive
entries with the same millisecond — they compress to one rax leaf.

---

## 14.6 The Hidden Trap: XADD Doesn't Persist Until AOF

Streams are stored in the keyspace, so RDB snapshots include them and
AOF logs `XADD` commands. **But**: between AOF flushes (with default
`appendfsync everysec`), up to 1 second of streams could be lost on a
crash.

For "true" persistence guarantees, run `WAIT 1 timeout` after critical
`XADD`s, just like other writes. Or `appendfsync always`.

This is the same durability story as everything else in Redis — see
Chapter 10.

---

## 14.7 Worked Example: A Job Queue

Build a job queue where multiple workers process jobs at-least-once,
with failures auto-recovered:

```
# Producer
XADD jobs * type "send_email" recipient "u@example.com" body "..."

# On startup, each worker:
XGROUP CREATE jobs workers $ MKSTREAM         # idempotent (errors if exists, ignore)

# Worker loop
while True:
    msgs = XREADGROUP GROUP workers consumer-id COUNT 10 BLOCK 5000 STREAMS jobs >
    for id, fields in msgs:
        try:
            process(fields)
            XACK jobs workers id
        except Exception:
            # don't ack -> message stays pending -> XAUTOCLAIM picks it up later
            log.error(...)

# Watchdog (separate process)
while True:
    XAUTOCLAIM jobs workers watchdog 60000 0 COUNT 100
    # any messages pending > 60s get reassigned
    # the watchdog can either re-XACK them (drop) or process them itself
```

This pattern is the production-quality "Redis as a job queue."

---

## 14.8 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `t_stream.c` | All stream commands and consumer group logic |
| `pubsub.c` | Pub/Sub commands and dispatch |
| `notify.c` | Keyspace notification fan-out |
| `rax.c` | The radix tree underlying streams |
| `cluster.c` | Sharded Pub/Sub routing |

---

## Practice Questions

1. You PSUBSCRIBE 100 patterns and PUBLISH 1M messages/sec. What's the
   CPU cost? What's the alternative if you need this throughput?
2. A pub/sub subscriber is slow and accumulates a 100 MB output buffer
   on the primary. The default `client-output-buffer-limit pubsub` is
   `32mb 8mb 60`. What happens?
3. Sketch the difference between `XADD jobs MAXLEN 1000` and `XADD jobs
   MAXLEN ~ 1000` in terms of cost and behavior.
4. A consumer group has 10 consumers; one crashes. There are 50 messages
   in its PEL. Walk through the recovery using `XAUTOCLAIM`.
5. Why doesn't Pub/Sub persist messages? Sketch what would change in
   Redis to add even-modest persistence to Pub/Sub. Why might the
   designers have chosen not to?
6. Streams use a radix tree of listpacks. Estimate memory for 10M
   entries each with 200 bytes of fields.
7. You want exactly-once semantics on a payment-processing stream. How
   do you get there with at-least-once delivery from XREADGROUP?
8. Sharded Pub/Sub uses CRC16 % 16384 on the channel name. What goes
   wrong if all your channels are named `chan-{user}` with the same
   hash tag?

(Answers at end of Chapter 22.)
