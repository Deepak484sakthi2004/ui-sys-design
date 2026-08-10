# Round 2 — Systems Internals

> **The panel:** Two staff engineers, one from the storage org, one from the runtime
> team. This is the round where "I've used it" stops being enough. Every answer gets
> pulled down to the bytes. The candidate's job is not to recite — it's to show that
> when the abstraction leaks (and it always leaks), they know what's underneath.

Difficulty band: ★★★★ — ★★★★★. Ten exchanges, all multi-turn.

Domains touched: `NET` `DB` `JVM` `PS`.

---

### [R2.Q1] "MySQL rides on TCP — what's the application protocol?"  ·  `NET` · ★★★☆☆

**Interviewer:** A JDBC client connects to MySQL over TCP/IP. TCP is the transport
layer. What's the application-layer protocol sitting on top?

**Candidate:** There isn't a named, public one like HTTP — and that's the point. MySQL
defines its **own** binary, stateful "Client/Server Protocol" (the "classic protocol";
MySQL 8 also ships the Protobuf-based X Protocol on port 33060). It runs directly on
TCP:3306, with no HTTP underneath.

Because TCP is a byte stream with no message boundaries, the protocol does its own
framing. Every packet is a 4-byte header then a payload:

```
 byte:   0      1      2        3
       ┌──────────────────────┬─────────┐
       │ payload_len (LE, 24b) │ seq_id  │
       ├──────────────────────┴─────────┤
       │ payload (payload_len bytes) ... │
       └─────────────────────────────────┘
```

`payload_len` is **little-endian** and capped at 2²⁴−1 (16 MB); a logical message
larger than that is split across multiple packets, each with its own header, and the
reader keeps concatenating until it sees a packet with length < 16 MB. `seq_id` resets
to 0 at the start of each command and increments per packet, so each side can detect a
desync. After the TCP handshake there's a second, *application-level* handshake: the
server speaks first with a Handshake packet (protocol version, server version, a 20-byte
auth salt, the auth-plugin name, capability flags), the client replies with username +
auth response + its own capability flags + default schema, and only then does the
command phase begin (`COM_QUERY`, `COM_STMT_PREPARE`, `COM_PING`, …).

**Interviewer:** You said little-endian. "Network byte order" is big-endian by
convention — why does MySQL go against the grain, and where would that bite someone?

**Candidate:** "Network byte order" is big-endian only for the *IP and TCP headers* —
the fields the network stack itself parses. Above the transport, an application protocol
picks whatever's cheapest for its dominant hardware. MySQL was authored on x86, which is
little-endian, so storing lengths LE means **zero byte-swapping on the hot path** —
you read the integer straight out of the buffer with no `bswap`. It bites you only if
you hand-roll a parser and reach for `ntohl()` out of habit: you'll read the 24-bit
length with the bytes reversed and slice the stream at the wrong offset, which then
cascades into reading the *next* packet's header as payload. It also means you can't
`memcmp` a captured MySQL frame against a dump from a big-endian protocol — the same
number looks different on the wire.

**Interviewer:** Now — same `mysql` client, same protocol, but connecting to localhost.
Is TCP even in the picture?

**Candidate:** Often not. On localhost the default transport is a **Unix domain socket**
(`/var/run/mysqld/mysqld.sock`), not TCP at all — no IP, no port, no loopback checksum,
no TCP state machine. The kernel just copies bytes between two file descriptors in the
same host. The *application* protocol is byte-for-byte identical; only the transport
changed. That's the whole lesson — "application protocol" and "transport" are
independent axes. On Windows the local transport can be a named pipe or shared memory.
You force TCP with `--protocol=TCP` or by connecting to `-h 127.0.0.1` instead of
`localhost`. And this is exactly why a pooled connection's *post-handshake* state is the
expensive thing to keep warm: HikariCP isn't caching a socket, it's caching an
authenticated, mid-session protocol state machine — the TCP handshake, the TLS handshake,
the auth round-trips, and the session variables are all already paid for.

──────────
> **[BANK]** Datastores don't ride on HTTP — each defines a custom binary application
> protocol directly on TCP (or a Unix socket): MySQL Client/Server, Postgres FE/BE,
> Redis RESP, MongoDB Wire, Kafka's binary protocol.
> **[TRAP]** Saying "it uses TCP" and stopping — that names the transport, not the
> application protocol. Second trap: forgetting that localhost may bypass TCP entirely.
> **[GO DEEPER]** [R2.Q2] TLS handshake bytes · [R1.Q1] OSI layering · pool internals in
> `../platform-notes/`.

---

### [R2.Q2] "Walk me through a TLS 1.3 handshake — bytes, not buzzwords"  ·  `NET` · ★★★★☆

**Interviewer:** Your service dials a database over TLS 1.3. Walk me through the
handshake. I want round-trips and what's actually on the wire, not "it's encrypted."

**Candidate:** TLS 1.3's headline feature is **1-RTT** to first application data (down
from 2-RTT in TLS 1.2), because the client gambles on the key exchange up front.

Round-trip zero, client speaks first — `ClientHello`:
- supported TLS versions (the `supported_versions` extension; the legacy `version` field
  lies and says 1.2 for middlebox compatibility),
- a list of named groups (e.g. `x25519`, `secp256r1`),
- and crucially a **`key_share`**: the client's ephemeral public key for its *guessed*
  group. This is the gamble — it sends a DH public before knowing if the server likes
  that group.

The server replies in one flight — `ServerHello` (its own `key_share`, completing the
ECDHE), and from here **everything is encrypted**: `EncryptedExtensions`, `Certificate`,
`CertificateVerify` (a signature over the transcript proving it owns the cert's private
key), and `Finished` (an HMAC over the whole handshake transcript). The moment the
server sends its `key_share`, both sides can derive the shared secret via HKDF, so the
server's own certificate is already encrypted — a privacy win over 1.2.

The client verifies the cert chain and the `CertificateVerify` signature, sends its own
`Finished`, and can **piggyback application data in that same flight**. So: one RTT of
handshake, then data.

```
 Client                                  Server
   │ ClientHello (+key_share) ─────────────▶│   RTT 0
   │◀───────────── ServerHello (+key_share) │
   │        {EncryptedExtensions, Cert,     │   (encrypted)
   │         CertVerify, Finished}          │
   │ {Finished} + Application Data ────────▶│   RTT 1 → data flowing
```

**Interviewer:** You said the client *guesses* the group. What happens when it guesses
wrong, and why does that detail matter for tail latency?

**Candidate:** If the client's `key_share` group isn't one the server supports, the
server can't complete the key exchange from the first flight, so it sends a
**`HelloRetryRequest`** naming a group it *does* support. The client then resends
`ClientHello` with a fresh `key_share` for that group. That adds a full extra
round-trip — you've degraded to effectively 2-RTT. For a service opening connections
across regions, that's an extra ~40–150 ms on the *p99 of connection establishment*,
which shows up as latency spikes whenever a pool grows under load. The fix is to make
the client offer the group the server actually prefers up front (usually `x25519`), so
HRR never fires. It's a classic case where a "correctness-neutral" misconfiguration only
ever hurts the tail.

**Interviewer:** And 0-RTT — you didn't mention it. Why might a careful engineer turn it
off?

**Candidate:** 0-RTT (early data) lets a *resuming* client send application data in the
very first flight, encrypted under a pre-shared key from the previous session — zero
round-trips to first byte. The catch is that early data is **replayable**: it's not
covered by the server's fresh `Finished`/nonce, so an attacker who captures the 0-RTT
packets can resend them, and the server will process them again. That's fine for
idempotent GETs, but catastrophic for a non-idempotent request — imagine replaying a
"transfer ₹10,000" call. So the discipline is: only allow 0-RTT for provably idempotent,
side-effect-free operations, or don't enable it at all. Most database and write-path
clients leave it off. It's a latency-vs-safety knob, and for anything stateful you pick
safety.

──────────
> **[BANK]** TLS 1.3 = 1-RTT because the client sends an ephemeral `key_share` in
> `ClientHello`; everything after `ServerHello` is encrypted. Wrong-group guess → an
> extra RTT via `HelloRetryRequest`. 0-RTT early data is replayable — idempotent only.
> **[TRAP]** Describing the TLS 1.2 two-RTT flow and calling it 1.3, or claiming the
> server cert is sent in cleartext (it isn't in 1.3).
> **[GO DEEPER]** [R2.Q1] the protocol that runs *inside* this tunnel · [R5] "why not
> just use HTTP."

---

### [R2.Q3] "Two machines, a 40-millisecond stall, no packet loss. Why?"  ·  `NET` · ★★★★☆

**Interviewer:** A client sends a small request, the server is healthy, the network is
clean — and yet you measure a reproducible ~40 ms stall before some responses. No
retransmits. What's happening?

**Candidate:** That 40 ms is the fingerprint of **Nagle's algorithm fighting TCP delayed
ACKs** — a classic pathological interaction. Both are individually reasonable; together
they deadlock for a tick of the delayed-ACK timer.

- **Nagle (`TCP_NODELAY` off, the default):** "Don't send a small segment if there's
  already unacknowledged data in flight — coalesce small writes until the outstanding
  data is ACKed or you have a full MSS." Its goal is to stop a telnet session from
  sending one packet per keystroke.
- **Delayed ACK:** "Don't ACK immediately — wait up to ~40 ms (Linux) hoping to
  piggyback the ACK on a response, or to ACK two segments at once."

Now picture a request that doesn't fit in one segment, or a request/response loop where
the app does two small `write()`s. The sender ships segment 1, then Nagle holds
segment 2 because segment 1 is unacked. The receiver has segment 1 but, under delayed
ACK, sits on the ACK waiting for either a second segment or a response to piggyback on —
and the response can't be produced because the app is still waiting for segment 2. Stalemate. It breaks only when the receiver's ~40 ms delayed-ACK timer fires, the ACK
finally arrives, Nagle releases segment 2, and everything lurches forward.

```
 Sender                         Receiver
  │ seg1 ───────────────────────▶│  has seg1, app needs seg2 too
  │ (Nagle holds seg2: seg1 unacked)
  │                              │  delayed-ACK: waits to piggyback...
  │            ......~40ms idle......
  │◀──────────────────── ACK seg1│  timer fires
  │ seg2 ───────────────────────▶│  now app can act
```

**Interviewer:** Good. So which knob do you turn, and what's the cost of turning it?

**Candidate:** The standard fix is **`TCP_NODELAY`** — disable Nagle on the socket. For
request/response protocols (database clients, RPC, Redis), latency matters far more than
saving a few small-packet headers, so you almost always want it off. Redis, the MySQL
connectors, gRPC, and most RPC frameworks set `TCP_NODELAY` by default for exactly this
reason. The cost: you give up Nagle's coalescing, so a chatty app that does many tiny
`write()`s will emit more, smaller packets — more per-packet overhead (40 bytes of
IP+TCP header each) and more syscalls. The *better* fix when you control the app is to
not make many small writes in the first place — build the full message in a buffer and
do one `write()`. Then Nagle has nothing to coalesce and nothing to stall, and you keep
its benefit for the cases you didn't think about. Disabling Nagle treats the symptom;
batching your writes treats the cause.

**Interviewer:** You mentioned the timer is ~40 ms on Linux. Why does that number exist
at all — why not ACK instantly and avoid the whole problem?

**Candidate:** Because instant ACKs waste the network. An ACK is a 40-byte packet
carrying no data; if you ACK every segment immediately, on a bulk transfer you double
your packet count in the reverse direction. Delayed ACK exists to (a) piggyback the ACK
on data the receiver was about to send anyway — free — and (b) ACK two full-MSS segments
with a single ACK, halving ACK traffic. The ~40 ms (Linux caps it lower than the RFC's
500 ms max) is a bet that *something* worth piggybacking on will happen within that
window. For streaming bulk data the bet pays off constantly. It's only the small,
synchronous request/response pattern — where there's nothing to piggyback and Nagle is
simultaneously holding the other side hostage — where the bet loses and you eat the full
timer. So neither algorithm is "wrong"; they were each designed for a workload, and the
stall is what happens when both assumptions are violated at once.

──────────
> **[BANK]** A reproducible ~40 ms stall with no loss = Nagle (sender holds small segment
> until prior data is ACKed) deadlocking with delayed ACK (receiver holds ACK ~40 ms to
> piggyback). Fix: `TCP_NODELAY`, or better, coalesce your own writes.
> **[TRAP]** Blaming the network/GC for a stall that's always almost-exactly 40 ms — the
> suspicious *constancy* of the number is the tell.
> **[GO DEEPER]** [R2.Q1] why RPC protocols set `TCP_NODELAY` · [R3] head-of-line
> blocking.

---

### [R2.Q4] "Draw me an InnoDB page"  ·  `DB` · ★★★★★

**Interviewer:** InnoDB stores everything in 16 KB pages. Draw one. What's inside, and
why is it a B+tree and not a B-tree or a hash?

**Candidate:** A 16 KB InnoDB page (the default `innodb_page_size`) has a fixed
skeleton:

```
┌────────────────────────────────────────────┐ 0
│ FIL header (38 B): page no, prev/next page, │   doubly-linked leaf list
│   LSN, page type, checksum                  │
├────────────────────────────────────────────┤ 38
│ Page header + index header: n_records,      │
│   heap top, free list, level in tree, ...   │
├────────────────────────────────────────────┤
│ Infimum + Supremum (boundary pseudo-records)│
├────────────────────────────────────────────┤
│ User records (heap), each with a record     │
│   header + the row, singly linked in        │   ← rows grow downward
│   ascending key order via "next" offsets    │
│            ...                               │
│            (free space)                      │
│            ...                               │
│ Page directory: sparse slots → records      │   ← grows upward
├────────────────────────────────────────────┤
│ FIL trailer (8 B): LSN low + checksum       │   detects torn pages
└────────────────────────────────────────────┘ 16384
```

The key structural facts: pages are linked **prev/next at the leaf level** (the FIL
header), so a range scan after a point lookup is a linked-list walk, not a re-descent of
the tree. Inside a page, records form a singly-linked list in key order, and the **page
directory** is a sparse array of slots (one per ~6 records) that lets a lookup binary-
search to the right neighbourhood and then linearly scan ~6 records — so within-page
lookup is roughly O(log n) not O(n).

Why a **B+tree**: three reasons, all about the disk.
1. **High fan-out, shallow tree.** Internal nodes store only keys + child pointers, no
   row data, so one 16 KB page holds hundreds of keys → fan-out of hundreds → a billion
   rows fit in a tree of height ~3–4. Each level is one page read, so a point lookup is
   3–4 I/Os worst case (and the top levels are always cached).
2. **All data in the leaves, leaves linked** → range scans and `ORDER BY` are sequential
   leaf-list walks. A plain B-tree scatters data across internal nodes, so ranges thrash.
3. **Page-sized nodes** match the unit the OS and storage move anyway. A hash index gives
   O(1) point lookups but **cannot do ranges or ordering at all** — useless for `WHERE
   ts BETWEEN …` or `ORDER BY`, which is most of OLTP. That's why InnoDB's primary access
   path is the B+tree and the hash index (the adaptive hash) is only an opportunistic
   cache on top.

**Interviewer:** You said the primary key *is* the tree. Spell out what that means for a
secondary index lookup, in I/Os.

**Candidate:** InnoDB tables are **index-organized** (clustered): the primary key B+tree
*is* the table — the leaf pages contain the full rows, in PK order. There is no separate
heap. A **secondary index** is its own B+tree, but its leaves don't store the row; they
store the indexed columns plus the **primary key value** as the row locator.

So a query like `SELECT * FROM t WHERE email = ?` with an index on `email` does a
**double lookup**:
1. Descend the `email` B+tree → find the leaf entry → get the PK value. (~1–3 I/Os.)
2. Take that PK and descend the **clustered** B+tree to fetch the actual row. (~1–3
   I/Os.) This second step is the **bookmark lookup** / "back to the clustered index."

That's why a **covering index** is such a big win: if the secondary index already
contains every column the query needs (`SELECT email, name` with an index on
`(email, name)`), step 2 is skipped entirely — you answer from the secondary index leaf
and never touch the clustered tree. It's also why a **fat primary key is expensive in two
directions**: every secondary index silently stores the whole PK in *every* leaf entry,
so a UUID PK (16 bytes, or 36 as a string) bloats every secondary index and every
bookmark lookup. A monotonic `BIGINT` PK keeps secondary indexes lean and keeps inserts
appending to the rightmost leaf instead of splitting random interior pages.

**Interviewer:** That last point — monotonic vs random PK and page splits. Why does a
random UUID actually hurt write throughput, mechanically?

**Candidate:** Because of **where the insert lands in the tree and what it does to the
buffer pool.** With a monotonic `BIGINT AUTO_INCREMENT`, every new row's key is larger
than all existing keys, so it always inserts into the **rightmost leaf page**. That page
is hot, already in the buffer pool, and fills sequentially; when it's full InnoDB does a
cheap "append" split (a special-cased optimization for ascending inserts) and moves on.
Sequential, cache-friendly, minimal splits.

With a **random UUID v4**, each insert lands in a *random* leaf somewhere in the tree:
1. That leaf is probably **not in the buffer pool**, so you take a read I/O just to bring
   the page in before you can write to it (a read-before-write on the insert path).
2. The random page is likely partially full, so the insert frequently triggers a
   **mid-page split** — allocate a new page, move half the records, fix up the sibling
   links and parent pointers — far more expensive than an append.
3. Over millions of inserts your writes are scattered across the whole keyspace, so the
   working set of dirty pages explodes, the buffer pool churns, and **page fill factor
   drops** (split pages are ~50% full), so the table is physically larger and less of it
   fits in RAM. More splits, more I/O, lower cache hit rate — a compounding loss.

The fix when you need UUIDs is **UUID v7** (or otherwise time-ordered UUIDs): the high
bits are a timestamp, so keys are *roughly* monotonic and inserts cluster at the right
edge again, recovering most of the `AUTO_INCREMENT` behaviour while keeping global
uniqueness. This is the single most common "my inserts got slow as the table grew"
root cause in production MySQL.

──────────
> **[BANK]** InnoDB tables are clustered B+trees keyed by PK — leaves hold full rows.
> Secondary index → PK → clustered tree (double lookup) unless the index is covering.
> Random PKs cause read-before-write + mid-page splits; monotonic PKs append. Use UUIDv7.
> **[TRAP]** Saying "InnoDB uses B-trees" (it's B+, data only in leaves), or thinking a
> secondary index points directly at a row on disk (it points at the PK).
> **[GO DEEPER]** [R2.Q5] the LSM alternative · [R2.Q6] MVCC on top of these pages · [R4]
> designing a TSDB.

---

### [R2.Q5] "B+tree vs LSM — when does Cassandra beat MySQL on writes, and what does it cost?"  ·  `DB` · ★★★★★

**Interviewer:** You just described a B+tree storage engine. RocksDB, Cassandra, and
ScyllaDB use an LSM tree instead. Why, and what's the catch?

**Candidate:** The B+tree's weakness is **random writes**: as we just discussed, an
update lands wherever its key lives, which means a read-before-write and possible page
split at a random spot on disk. On a spinning disk that's a seek; even on SSD it's
read-modify-write amplification at the flash level.

The **LSM tree (Log-Structured Merge tree)** flips this: it turns all writes into
**sequential** writes by never updating in place.

1. A write goes to an in-memory sorted structure, the **memtable** (a skip list or
   balanced tree), plus an append to a **write-ahead log** for durability. The WAL append
   is sequential; the memtable insert is RAM-speed. So a write is ~O(1) and never touches
   a random disk location.
2. When the memtable fills, it's frozen and flushed to disk as an immutable, sorted file —
   an **SSTable** (Sorted String Table). This flush is one big **sequential** write.
3. SSTables accumulate in levels. A background **compaction** process merges them,
   discarding overwritten and deleted keys.

So the LSM converts random writes into sequential appends + background merges. On
write-heavy workloads it crushes the B+tree — Cassandra ingesting time-series or event
data, for instance.

```
 write → WAL (append) + memtable (RAM, sorted)
            │ memtable full
            ▼
   flush → SSTable L0  (immutable, sorted)
            │ compaction merges & sorts
            ▼
        L1 ... L2 ... (larger, fewer, non-overlapping)
```

**Interviewer:** "Background merges" sounds free. It isn't. Give me the three
amplifications and which one the LSM trades away to win on writes.

**Candidate:** Right — the LSM doesn't escape work, it *reshapes* it. Three
amplifications, and every storage engine is a point in this trade space (the "RUM
conjecture": you can optimize for two of Read, Update, Memory, never all three):

1. **Write amplification:** one logical write gets physically rewritten many times,
   because compaction reads and rewrites the same key as it moves down the levels. A
   leveled LSM might write each byte ~10–30× over its lifetime. The B+tree's write amp is
   lower per-write but does it as expensive random I/O. **The LSM accepts high write
   amplification (sequential) to avoid random writes.**
2. **Read amplification:** a read may have to check the memtable, then *several* SSTables
   across levels, because a key could live in any of them. The B+tree reads one path,
   ~3–4 pages. The LSM mitigates with **Bloom filters** per SSTable (skip files that
   definitely don't contain the key) and a block cache, but worst case it touches many
   files. **This is the cost the LSM pays to win on writes — reads get harder.**
3. **Space amplification:** stale, overwritten versions of a key sit on disk until
   compaction reclaims them, so an LSM can temporarily use more disk than the live data
   size. Tunable via compaction strategy.

So the headline: **LSM trades read and space amplification (and a lot of background CPU/
I/O for compaction) to turn writes sequential.** Pick it when ingest dominates and reads
are mostly recent-data or point lookups with good Bloom-filter hit rates. Pick a B+tree
when reads — especially range scans over the whole keyspace — and read latency
*predictability* dominate.

**Interviewer:** Compaction is the hidden tax. Name the two main strategies and the
specific failure mode each one causes in production.

**Candidate:** The two canonical strategies, and they sit at opposite ends:

- **Leveled compaction (LCS):** each level Lₙ holds non-overlapping SSTables, and Lₙ is
  ~10× the size of Lₙ₋₁. A key exists in at most one SSTable per level, so **reads are
  tighter** (fewer files to check) and **space amplification is low** (less duplication).
  The cost is **high write amplification** — merging into a level rewrites overlapping
  data repeatedly. Failure mode: on a write-heavy box, compaction can't keep up, L0
  SSTables pile up faster than they're merged, read amplification spikes (now you're
  checking many overlapping L0 files), and you get **compaction backlog** — latency
  climbs and, if it runs away, writes stall to apply backpressure.

- **Size-tiered compaction (STCS):** merge SSTables of *similar size* into one bigger
  one. **Low write amplification** (you rewrite data fewer times), great for write-heavy
  ingest. The cost is **high space amplification and read amplification**: many
  overlapping SSTables of similar size coexist, so a read may probe many of them, and at
  the moment of a big merge you can transiently need **~2× the disk** of the data being
  merged (you can't free the inputs until the output is durable). Failure mode: a node
  fills its disk during a large compaction and the whole node wedges — the classic
  Cassandra "ran out of space at 55% full" incident, because you must keep headroom for
  the biggest possible merge.

The deeper point for the panel: **choosing a storage engine is choosing which
amplification you can afford given your workload and your hardware.** There's no free
lunch — the B+tree, leveled LSM, and tiered LSM are three different answers to the same
RUM trade-off, and a senior engineer picks the one whose *failure mode* they can live
with, not just the one with the best happy-path number.

──────────
> **[BANK]** B+tree = in-place updates, random-write cost, predictable reads. LSM =
> append-only (WAL + memtable → immutable SSTables + compaction), turns writes sequential
> at the cost of read + space amplification. Leveled = low space/read, high write-amp;
> size-tiered = low write-amp, high space/read-amp.
> **[TRAP]** Calling the LSM "faster" with no qualifier. It's faster *on writes*, and
> only if compaction keeps up; it can be slower and disk-hungrier on reads.
> **[GO DEEPER]** [R2.Q4] the B+tree side · [R5.Q?] "defend LSM for read-heavy OLTP" ·
> RUM conjecture.

---

### [R2.Q6] "How does a SELECT see a consistent snapshot while others are writing?"  ·  `DB` · ★★★★★

**Interviewer:** In `REPEATABLE READ`, a long transaction runs `SELECT` twice and sees
the same data both times, even though other transactions committed changes in between —
and without taking read locks. Mechanically, how?

**Candidate:** That's **MVCC — Multi-Version Concurrency Control** — and in InnoDB it's
built from three pieces: hidden row columns, the **undo log**, and a per-transaction
**read view**.

Every clustered-index row carries two hidden system columns:
- `DB_TRX_ID` (6 bytes): the transaction id that last modified this row.
- `DB_ROLL_PTR` (7 bytes): a "roll pointer" to the **undo log record** that can
  reconstruct the row's *previous* version.

When a transaction updates a row, InnoDB doesn't destroy the old version. It writes the
new values in place, stamps `DB_TRX_ID` with its own id, and points `DB_ROLL_PTR` at an
undo record holding the *before-image*. The undo records form a **version chain** —
follow the roll pointers backward and you walk the row's history.

```
 current row ──roll_ptr──▶ undo: prev version ──roll_ptr──▶ undo: older version ──▶ ...
 trx_id=50                 trx_id=42                          trx_id=17
```

When a `SELECT` starts (under REPEATABLE READ, at the first read of the transaction), it
builds a **read view**: essentially a snapshot of *which transaction ids were active
(uncommitted) at that instant.* Concretely it captures the set of in-progress trx ids and
the low/high watermarks. Then, for each row it considers, it walks the version chain and
applies a visibility rule:

- If the row version's `DB_TRX_ID` committed **before** the read view was taken → visible,
  use it.
- If it was created by a transaction still **active** in the read view, or by a
  transaction that started **after** the view → not visible, follow `DB_ROLL_PTR` to the
  older version and test again.

So the reader reconstructs the database *as of its snapshot instant*, walking back through
the undo log to skip versions it shouldn't see. No read locks are taken — **readers don't
block writers and writers don't block readers** — which is the whole point of MVCC.
REPEATABLE READ reuses the *same* read view for the whole transaction (hence repeatable);
READ COMMITTED takes a *fresh* read view at the start of each statement (hence it sees
newly committed data on the next statement).

**Interviewer:** You said old versions live in the undo log. What stops it from growing
forever, and what's the famous failure when that goes wrong?

**Candidate:** Old versions are reclaimed by the **purge** process: a background thread
that deletes undo records once **no existing read view could still need them** — i.e.
once the oldest active read view has advanced past the version. The mechanism that decides
this is the **read view low-water mark**: the oldest transaction id any open snapshot
still cares about. Purge can only free history older than that.

The famous failure is a **long-running transaction holding back purge** — "**history list
length** explodes." If you `BEGIN` a transaction and leave it open (an idle REPEATABLE
READ transaction, a forgotten `autocommit=0` session, an analytics query that runs for an
hour), its read view pins the low-water mark. Purge can't advance past it, so undo log
records accumulate for *every row changed by every other transaction* in the meantime. The
undo tablespace bloats, the **version chains get longer**, and now *every other*
transaction's reads get slower because they have to walk longer chains back to their
snapshot. It compounds: one forgotten transaction taxes the read path of the entire
server. The symptoms are a growing `History list length` (visible in `SHOW ENGINE INNODB
STATUS`), rising undo tablespace, and creeping read latency. The fix is to kill or commit
the offending long transaction, and operationally to set `innodb_max_undo_log_size` /
monitor history list length and put statement timeouts on analytics connections.

**Interviewer:** One more. MVCC gives readers a clean snapshot — but it does *not* by
itself prevent two transactions from both reading a row, both deciding to write, and one
silently clobbering the other. What's that gap called, and how does SQL close it?

**Candidate:** That gap is the **lost update / write skew** family — MVCC's snapshot
isolation protects *reads*, but two transactions reading the same snapshot and writing
based on it can violate an invariant that neither's snapshot revealed. Classic example:
two transactions both read "account balance = 100," both subtract 100, both commit →
balance is −100, an invariant only visible by considering both writes together. Snapshot
isolation (and InnoDB's REPEATABLE READ, which is snapshot-based) doesn't catch this by
default because neither transaction's read view saw the other's write.

SQL closes it in a few ways, escalating in cost:
1. **Explicit locking reads** — `SELECT ... FOR UPDATE` — takes a write lock on the rows
   you read, so the second transaction blocks until the first commits, then re-reads the
   *new* value. This converts the optimistic snapshot read into a pessimistic locked read
   for the rows that matter. (InnoDB also uses **gap/next-key locks** here to prevent
   *phantoms* — new rows appearing in a range — which is how its REPEATABLE READ avoids
   the phantom anomaly that the SQL standard allows at that level.)
2. **`SERIALIZABLE`** isolation — InnoDB implicitly adds shared next-key locks to plain
   reads, so conflicting schedules block or deadlock and get serialized. Correct, but
   lower concurrency.
3. **Application-level optimistic concurrency** — a version column and a
   `UPDATE ... WHERE version = ?`; if zero rows match, someone else won, retry. No held
   locks, scales better under low contention, but you must handle the retry.

The interview-grade summary: **MVCC gives you snapshot isolation cheaply, but snapshot
isolation is not serializability.** Knowing *which* anomalies your isolation level still
permits — lost update, write skew, phantoms — and reaching for `FOR UPDATE` or optimistic
versioning exactly where an invariant spans rows, is the line between "I set the isolation
level" and "I understand what it guarantees."

──────────
> **[BANK]** MVCC = hidden `DB_TRX_ID`/`DB_ROLL_PTR` + undo-log version chains + a
> per-txn read view. Readers walk back the chain to their snapshot; no read locks. Purge
> reclaims old versions once no read view needs them — a long-running txn stalls purge and
> bloats history. Snapshot isolation ≠ serializable; close write-skew/lost-update gaps
> with `FOR UPDATE` or version columns.
> **[TRAP]** Thinking REPEATABLE READ prevents all anomalies, or that MVCC means "no
> locks ever" (writes still lock; gap locks exist).
> **[GO DEEPER]** [R2.Q4] the pages the versions live in · [R3] distributed isolation /
> 2PC · [R5] isolation-vs-throughput.

---

### [R2.Q7] "Why does `new Object()` cost 16 bytes when it holds nothing?"  ·  `JVM` · ★★★★☆

**Interviewer:** On a 64-bit HotSpot JVM, a bare `new Object()` consumes 16 bytes of
heap and an empty `HashMap` already costs ~48. Where does the weight come from?

**Candidate:** Every Java object on the heap has a fixed **object header** before any of
its fields. On 64-bit HotSpot the header is two words for most objects:

```
 ┌───────────────────────────────┐
 │ mark word (8 bytes)           │  identity hashCode, GC age,
 │                               │  lock state / monitor ptr, biased-lock owner
 ├───────────────────────────────┤
 │ klass pointer (4 bytes,       │  → which class this is (the Klass metadata)
 │   compressed oops)            │
 ├───────────────────────────────┤
 │ (length, 4 bytes — arrays only)│
 ├───────────────────────────────┤
 │ instance fields ...           │
 └───────────────────────────────┘
```

For a bare `Object`: 8-byte **mark word** + 4-byte **compressed klass pointer** = 12
bytes, and HotSpot aligns every object to an **8-byte boundary**, so it rounds up to
**16** — those last 4 bytes are pure padding. The object holds no fields and still costs
16 because the header and alignment are unavoidable.

The **mark word** is the busy one: it's a union that, depending on the object's lock
state, holds the identity hashCode (computed lazily on first `hashCode()` / `identity-
HashCode` call and then cached here), the GC age bits (how many young-gen collections it
survived, which drives promotion to old gen), and the lock bits — biased/thin/fat lock
state and, when inflated, a pointer to a monitor. The **klass pointer** is "compressed":
on heaps under ~32 GB the JVM stores 32-bit references (compressed oops / compressed
class pointers) and shifts them, so it can address more memory than 4 raw bytes would
allow while halving pointer footprint.

The empty `HashMap` at ~48 bytes is just composition: the `HashMap` object's own header +
fields (size, threshold, load factor, the `table` reference, modCount, the entrySet
cache), and depending on construction the backing `Node[]` array — each of which also
carries a header. The "empty" map isn't empty; it's an object graph.

**Interviewer:** You said compressed oops cut off around 32 GB. Why exactly 32, and why
is a 31 GB heap sometimes *worse* than a 30 GB one?

**Candidate:** Because of the **shift trick.** A compressed oop is a 32-bit value, which
addresses 2³² = ~4 billion distinct values. If you treat that as a count of *bytes*, you
cap at 4 GB. But objects are 8-byte aligned, so the low 3 bits of every real address are
always zero — they carry no information. The JVM exploits this: it stores the address
**shifted right by 3 bits**, and shifts left by 3 on every dereference. Now each 32-bit
value indexes an 8-byte-aligned slot, so you address 2³² × 8 = **32 GB** with 4-byte
pointers. Above 32 GB the shift can't stretch any further and the JVM falls back to full
8-byte oops.

The cruel part: crossing 32 GB **doubles the size of every reference field in every
object**, so your *effective* live-data capacity *drops*. A heap configured at 31 GB can
hold **more actual objects** than one at 33 GB, because at 33 GB you've turned off
compressed oops and every pointer just got twice as fat — more memory per object, more
cache pressure, worse GC throughput. So the standard guidance is: stay at or below ~32 GB
(`-Xmx31g` to leave headroom) to keep compressed oops, and if you genuinely need more
heap, jump *well* past 32 GB so the extra raw capacity outweighs the per-pointer tax —
the zone from ~32 to ~40 GB is a dead loss.

**Interviewer:** Modern JDKs are shrinking this header. What changed, and why does it
matter at scale?

**Candidate:** The big change is **Project Lilliput** (JEP 450, "Compact Object Headers,"
landing experimentally in JDK 24). It compresses the header from two words down toward a
**single 64-bit word** by packing the klass pointer *into* the mark word, reclaiming the
4 bytes that biased locking and the old layout wasted. Biased locking itself was
**deprecated and disabled by default in JDK 15+** (JEP 374) — it caused safepoint and
revocation costs that stopped paying off on modern hardware, and removing it freed up
mark-word bits.

Why it matters at scale: object headers are **pure overhead repeated per object**. A
service with hundreds of millions of small live objects — think a large cache, or a graph
of tiny domain objects — spends a *meaningful fraction of its heap on headers alone*.
Shaving 4–8 bytes off every object can cut total heap by 10–20% for header-dominated
workloads, which directly improves cache locality and GC pause times (less to scan) and
can mean the difference between fitting under the 32 GB compressed-oops ceiling or not.
For a fleet of thousands of JVMs, that's real money in RAM. It's the kind of "boring"
runtime change that quietly pays for itself across an entire org.

──────────
> **[BANK]** 64-bit object = 8 B mark word (hashCode/GC age/lock state) + 4 B compressed
> klass ptr, padded to 16. Compressed oops shift addresses by 3 bits → 32 GB ceiling;
> just over 32 GB is *worse* than just under. Lilliput (JDK 24) packs the header toward
> one word.
> **[TRAP]** Saying the header is "12 bytes" and forgetting 8-byte alignment rounds it to
> 16, or recommending a 40 GB heap without knowing you lost compressed oops at 32.
> **[GO DEEPER]** [R2.Q8] GC age bits → promotion · [R2.Q10] false sharing on these
> objects.

---

### [R2.Q8] "G1 says low pause. ZGC says single-digit-millisecond. What changed?"  ·  `JVM` · ★★★★★

**Interviewer:** G1 is the default collector; ZGC and Shenandoah claim sub-10ms,
sub-millisecond pauses even on huge heaps. What did they fundamentally change to get
there?

**Candidate:** The fundamental shift is from **"stop the world to move objects"** to
**"move objects while the application keeps running"** — concurrent compaction. To
understand the leap you have to see what bounds G1's pauses.

**G1 (Garbage-First):** divides the heap into ~2048 equal **regions** and tags each as
eden, survivor, or old. It's mostly concurrent in *marking* (figuring out what's live),
but the actual **evacuation** — copying live objects out of a region to compact it — is
done in a **stop-the-world pause**. G1 picks the regions with the most garbage first
(hence "garbage-first") to maximize bang-per-pause, and it tries to hit a pause-time
*target* (`-XX:MaxGCPauseMillis`, default 200 ms) by collecting only as many regions as
fit in the budget. But the pause still scales with **how much live data it has to copy in
that pause** plus root scanning. On a big heap with a large live set, G1's pauses grow —
you can't evacuate 4 GB of survivors in 1 ms. That's the ceiling.

**ZGC (and Shenandoah):** make **evacuation itself concurrent** — they relocate objects
while application threads run. The two enabling tricks:

1. **Colored pointers (ZGC):** ZGC stores metadata *in the unused high bits of the 64-bit
   pointer itself* — marked, remapped, finalizable bits. The GC state travels with the
   reference.
2. **Load barriers:** every time the application *loads* an object reference, a small
   barrier checks those colored bits. If the object has been (or is being) relocated, the
   barrier **fixes up the reference on the fly** — it follows the forwarding info to the
   new location and "self-heals" the pointer so the next load is free. This is how the app
   can keep dereferencing objects that the GC is concurrently moving: nobody ever sees a
   stale pointer, because the barrier repairs it on access.

The result: in ZGC the stop-the-world pauses are reduced to tiny, *fixed-cost* operations
(mark start, relocate start) that **don't scale with heap size or live-set size** — hence
sub-millisecond pauses on multi-terabyte heaps. Shenandoah does the same with a
**Brooks forwarding pointer** (an extra indirection word per object) plus a write barrier
instead of colored pointers, but the principle is identical: concurrent relocation behind
a read/write barrier.

```
 G1:   [ concurrent mark ] ──▶ [ STW: evacuate/copy live objects ] ← pause ∝ live data
 ZGC:  [ concurrent mark ] ──▶ [ concurrent relocate, app running ]
                                   load barrier heals refs on access
                                   STW only for tiny fixed phases
```

**Interviewer:** Nothing is free. What does ZGC pay to get those flat pauses?

**Candidate:** Three costs, and they're the reason G1 is still the *default*:

1. **Throughput tax from the load barrier.** Every reference load now runs a barrier
   check. It's cheap individually, but it's on the hottest path in the language —
   reference loads are everywhere — so ZGC typically gives up a few percent of raw
   throughput versus a collector that can move objects freely during a STW pause. You're
   trading **average throughput for tail latency**.
2. **Memory overhead.** ZGC needs headroom to relocate concurrently (it relocates into
   free regions while the app still allocates), and historically used **multi-mapped
   memory** (the same physical page mapped at several virtual addresses for the colored-
   pointer scheme), which complicates RSS accounting. Shenandoah's forwarding pointer adds
   a word per object. You buy low pauses with extra RAM/CPU.
3. **It optimizes latency, not throughput.** For a **batch job** — a Spark stage, an
   offline ETL — you don't care about a 200 ms pause; you care about finishing fastest. There a throughput collector (Parallel GC, or G1) wins, because it doesn't pay the barrier
   tax. ZGC shines for **latency-sensitive services** with large heaps where a multi-
   hundred-ms G1 pause would blow your p99 SLA.

So the decision rule: **G1 by default; ZGC/Shenandoah when pause time is your SLA and the
heap is large; Parallel/throughput GC for batch.** And the modern ZGC is *generational*
(JDK 21+) — it brought back the weak generational hypothesis (most objects die young) so
it doesn't have to concurrently relocate the whole heap every cycle, recovering much of
the throughput it used to lose. That generational version is what makes ZGC viable as a
general low-latency default now, not just a niche.

**Interviewer:** You keep saying "stop the world." Mechanically, how does the JVM even
*stop* all the threads at a consistent point — and how can that itself be a latency bug?

**Candidate:** Through **safepoints.** A safepoint is a point in execution where a thread's
state is fully known to the JVM — all object references on the stack are in known
locations, so the GC can scan and move them safely. The JVM can't stop a thread at an
*arbitrary* instruction (it might be mid-way through computing a pointer, with a reference
live only in a register the GC doesn't know about). So the compiler inserts **safepoint
polls** — cheap checks — at method returns and on loop back-edges. When the JVM wants to
stop the world, it sets a global flag (on HotSpot, by making a special page unreadable);
the next time each thread hits a poll it traps, sees "safepoint requested," and parks
itself. Once *all* threads have reached a safepoint, the world is stopped.

The latency bug is **"time to safepoint" (TTSP).** The pause you actually experience is
*safepoint-bring-up + the GC work*, and the bring-up is bounded by the **slowest thread to
reach a poll.** If one thread is in a **giant counted loop with no safepoint poll** — JIT
compilers historically omitted polls from tight `int`-counted loops as an optimization —
then every *other* thread reaches the safepoint instantly and then **all of them sit
idle**, blocked, waiting for that one thread to finish its loop and finally poll. Your "GC
pause" metric might say the collection took 2 ms, but the application froze for 200 ms
because TTSP was 198 ms. It's a brutal class of bug because the GC logs look innocent — the
collector did almost no work; the time vanished into *getting* to the safepoint. You
diagnose it with `-XX:+PrintSafepointStatistics` (or safepoint logging) showing a large
"spin/block" time, and you fix it by breaking up the loop or letting the JIT insert polls
(modern JITs are better about loop safepoints, and `long`-counted loops always get them).
The lesson: a "GC problem" is sometimes not the collector at all — it's the cost of
everyone agreeing to stop.

──────────
> **[BANK]** G1 evacuates (copies live objects) in a STW pause → pause grows with live
> set. ZGC/Shenandoah relocate *concurrently* via colored pointers + load barriers (or a
> Brooks pointer + write barrier) that heal references on access → flat sub-ms pauses,
> paid for with a per-load barrier (throughput tax) and extra memory. Real pause =
> GC work + time-to-safepoint; a poll-less counted loop can freeze everyone.
> **[TRAP]** Claiming ZGC is "strictly better" than G1 (it costs throughput; batch jobs
> prefer G1/Parallel), or thinking a clean GC log rules out a GC-shaped freeze (TTSP).
> **[GO DEEPER]** [R2.Q7] the GC age bits in the mark word · [R4] sizing a GC pause budget
> against an SLA.

---

### [R2.Q9] "Show me a singleton that's broken without `volatile`"  ·  `JVM` · ★★★★★

**Interviewer:** Double-checked locking for a lazy singleton. People write it without
`volatile` and it "works" in testing. Why is it broken, and what does `volatile`
actually do here?

**Candidate:** Here's the broken version:

```java
class Holder {
    private static Holder instance;          // NOT volatile — the bug
    static Holder get() {
        if (instance == null) {              // 1st check (no lock)
            synchronized (Holder.class) {
                if (instance == null) {      // 2nd check (locked)
                    instance = new Holder(); // the dangerous line
                }
            }
        }
        return instance;
    }
}
```

The bug lives in `instance = new Holder()`, which is **not atomic**. The JVM compiles it
to roughly three steps:

```
 1. allocate memory for a Holder
 2. run the constructor, initializing fields
 3. publish: write the reference into `instance`
```

The JMM permits the compiler/CPU to **reorder steps 2 and 3** — there's no
*happens-before* edge forcing the constructor to complete before the reference is
published. So a thread can write a **non-null `instance` that points at a
half-constructed object**: memory allocated, reference published, but the constructor's
field writes not yet visible. Now thread B calls `get()`, hits the **first check without
the lock**, sees `instance != null`, skips the `synchronized` block entirely, and returns
a reference to an object whose fields are still default/zero. It reads garbage. The reason
it "passes testing" is that the reordering and the precise interleaving are rare and
hardware/JIT-dependent — it's a Heisenbug that shows up under load on a different CPU
months later.

**Interviewer:** So what does `volatile` on `instance` *do* that fixes it — at the memory
level, not "it makes it visible"?

**Candidate:** Marking `instance` **`volatile`** does two things under the Java Memory
Model:

1. **It establishes a happens-before edge.** A write to a volatile field *happens-before*
   every subsequent read of that field. So everything the writing thread did *before*
   publishing `instance` — including all the constructor's field writes — is guaranteed
   visible to any thread that later reads a non-null `instance`. The half-constructed
   object can no longer be observed, because the constructor writes are now ordered before
   the publish.

2. **It inserts the necessary memory barriers / forbids the reordering.** Concretely, on
   the write side the JVM emits a **release barrier** so step 2 (constructor) cannot be
   reordered after step 3 (publish); on the read side an **acquire barrier** so a thread
   that reads `instance` cannot see stale values of the fields it points to. On x86,
   loads/stores are already strongly ordered so the *read*-side barrier is nearly free and
   the *write* side is a single locked instruction — which is exactly why the bug "didn't
   reproduce" on the x86 dev laptop but would on a weaker memory model like ARM or
   PowerPC, where loads can be reordered far more aggressively. **`volatile` makes the JMM
   guarantee hold on *every* platform**, instead of relying on x86's accidental strictness.

The key reframe for a panel: `volatile` isn't really about "always read from main memory"
— that's a folk model. It's about **ordering and the happens-before relation.** A volatile
write is a *release*; a volatile read is an *acquire*; together they create the synchronizes-with edge that makes the constructor's writes visible. Without that edge, the
JMM doesn't *owe* you visibility, and a sufficiently aggressive CPU or JIT will collect.

**Interviewer:** Given how subtle this is, what would you actually ship instead?

**Candidate:** I'd avoid hand-rolled DCL entirely, because there are idioms that get the
JMM to do the work for you with zero barriers in *your* code:

- **The initialization-on-demand holder idiom** — lazy, thread-safe, lock-free, and the
  cleanest:

  ```java
  class Holder {
      private static class Lazy { static final Holder INSTANCE = new Holder(); }
      static Holder get() { return Lazy.INSTANCE; }
  }
  ```

  This leans on the **JLS class-initialization guarantee**: the JVM initializes the nested
  `Lazy` class — and runs its static initializer — *exactly once*, the first time `get()`
  touches it, under the JVM's own initialization lock with all the correct happens-before
  edges. It's lazy (the nested class isn't loaded until first use), thread-safe by
  construction, and has no synchronization on the hot path after init. This is the idiom I
  reach for.

- **An `enum` singleton** if I want serialization- and reflection-safety for free —
  `enum Singleton { INSTANCE; }` — the JVM guarantees a single instance even against
  reflection and deserialization attacks, which the field-based singleton doesn't.

- And if I genuinely need DCL (e.g. a per-key lazy cache, not a singleton), then `volatile`
  on the field is mandatory, and I'd document *why* with a comment, because the next person
  to "clean up that unnecessary volatile" will reintroduce the bug.

The meta-point: the existence of a correct DCL proves you understand the JMM, but
*choosing the holder idiom* proves you know that the best concurrency code is the code that
delegates ordering to a primitive the platform already gets right.

──────────
> **[BANK]** DCL without `volatile` is broken: `instance = new Holder()` can publish the
> reference before the constructor's writes are visible (reorder of allocate/construct/
> publish), so another thread sees a half-built object via the lock-free first check.
> `volatile` adds the release/acquire happens-before edge that orders construction before
> publication. Prefer the holder-class idiom or an enum.
> **[TRAP]** "It works on my machine" — x86's strong memory model hides the bug; ARM
> exposes it. Also the folk model "volatile = read from main memory" misses the real
> point: ordering / happens-before.
> **[GO DEEPER]** [R2.Q10] the hardware side: cache coherence & false sharing · [R3]
> happens-before across machines (logical clocks).

---

### [R2.Q10] "Two threads, two different counters, no shared state — and it's slow. Why?"  ·  `JVM` · ★★★★★

**Interviewer:** I have two threads each incrementing its *own* `long` counter — no shared
variable, no lock, no contention in the code. On two cores it runs barely faster than on
one, sometimes slower. Explain.

**Candidate:** That's **false sharing** — the threads share no *variable*, but their two
counters live on the **same CPU cache line**, and the cache-coherence protocol treats the
*line*, not the variable, as the unit of ownership.

Caches move memory in fixed **cache lines** — 64 bytes on x86/ARM. If those two `long`s
(8 bytes each) happen to be adjacent in memory — say two fields of the same object, or two
elements of an array — they fall in the same 64-byte line. Now the **MESI cache-coherence
protocol** kicks in: for core A to *write* its counter, it needs the line in the
**Modified** (exclusive) state, which means **invalidating** that line in core B's cache.
Core B then writes *its* counter, which requires invalidating the line in core A's cache.
They ping-pong exclusive ownership of the line back and forth on every increment —
**cache-line bouncing** — even though they never touch each other's actual bytes.

```
 cache line (64 B): [ counterA | counterB | ...padding... ]
   core A writes counterA → invalidates line in core B
   core B writes counterB → invalidates line in core A
   → every write triggers a coherence round-trip over the interconnect
```

Each invalidation forces the other core to re-fetch the line (an L1 miss, served from
L2/L3 or the other core's cache over the interconnect — tens of cycles). So two
"independent" threads are serialized by the hardware on a line they accidentally share.
That's why scaling to two cores buys you almost nothing: the coherence traffic eats the
parallelism. The classic real-world version is a thread-pool of per-worker counters packed
into an array, or two hot fields declared next to each other in a shared object.

**Interviewer:** Fix it. And tell me the cost of your fix.

**Candidate:** The fix is **padding** so each hot variable owns its own cache line — no two
contended fields share a line. Three ways, increasingly principled:

1. **Manual padding:** stuff dummy fields between the hot ones so they're ≥64 bytes apart.
   Crude and fragile — the JIT can reorder or eliminate "unused" fields.
2. **`@sun.misc.Contended` / `@jdk.internal.vm.annotation.Contended`** (JDK's own
   annotation, needs `-XX:-RestrictContended` for application use): tells the JVM to pad
   the field onto its own cache line for you. This is what the JDK uses internally — e.g.
   in `LongAdder`'s `Cell` and in the `ForkJoinPool` work-queue counters — precisely to
   avoid false sharing on hot per-thread state.
3. **Use a structure designed around it:** `LongAdder` instead of `AtomicLong` under high
   contention — it spreads the count across multiple padded `Cell`s (one per contending
   thread, striped), so threads hit *different* lines and only `sum()` reconciles them.
   It's the productionized version of "give each thread its own line."

The **cost of padding** is **memory**: you're inflating a `long` from 8 bytes to a full 64+
byte cache line — an 8× blowup for that field. So you only pad the **genuinely hot,
contended** variables — counters in the inner loop, ring-buffer cursors. Pad everything and
you destroy cache density and *create* misses elsewhere (now fewer useful objects fit in
each line, so cold-data access gets slower). It's a targeted optimization: profile to find
the bounced line (via `perf c2c` on Linux, which literally reports cache-line contention),
confirm it's false sharing and not real sharing, then pad *that* field. Padding a line you
*should* be sharing just wastes cache; the skill is telling the two apart.

**Interviewer:** Last one — connect this back to the disruptor or any high-perf queue.
Why do those obsess over cache lines?

**Candidate:** Because at millions of ops/sec, **the cache-coherence protocol is the
bottleneck, not the algorithm.** The LMAX Disruptor is the canonical example: it's a
single ring buffer shared between producer and consumer, and the naive design would put
the producer's write cursor and the consumer's read cursor adjacent in memory — instant
false sharing, the two cursors bouncing a line on every single message. The Disruptor pads
every cursor (`Sequence`) onto its own cache line so the producer's cursor and consumer's
cursor never invalidate each other. It also lays the ring buffer out as a **pre-allocated
contiguous array** so traversal is sequential and the hardware **prefetcher** can stream
the next entries in — turning random pointer-chasing into predictable linear access. And it
avoids the queue's usual head/tail contention by giving each participant its own padded
cursor and using the natural ordering of the ring.

The unifying idea across this whole round: **once you're fast enough, you stop programming
the instruction set and start programming the memory hierarchy.** False sharing, prefetch-
friendly layout, and cache-line ownership are the same level of concern as the wire
framing in Q1 or the page layout in Q4 — it's all about respecting the unit the hardware
actually moves (a TCP segment, a 16 KB page, a 64-byte cache line) instead of pretending
memory is a flat, uniform, free-to-touch array. The candidates who win the latency game are
the ones who think in those units.

──────────
> **[BANK]** False sharing: independent variables on the same 64-byte cache line force
> MESI to bounce exclusive ownership between cores on every write — parallelism collapses
> with zero logical contention. Fix by padding the hot field to its own line
> (`@Contended`, `LongAdder`); cost is 8×-ish memory, so pad only profiled-hot fields.
> Diagnose with `perf c2c`.
> **[TRAP]** Assuming "no shared variable = no contention." The hardware shares *lines*,
> not variables. Opposite trap: padding everything and trashing cache density.
> **[GO DEEPER]** [R2.Q9] the software-ordering side (JMM) · [R3] lock-free queues across
> NUMA nodes · LMAX Disruptor.

---

## Round 2 — closing note from the panel

Notice the through-line: every answer eventually bottomed out at **the unit the hardware
or protocol actually operates on** — a TCP segment and its framing, a TLS flight, a 16 KB
page, an SSTable, an undo-version chain, a 16-byte object header, a GC region, a
happens-before edge, a 64-byte cache line. The candidate who only knows the API names
stops one question early. The one who gets the offer is the one who, three follow-ups
deep, is still drawing boxes of bytes and explaining *why the box is that size.*

Proceed to [Round 3 — Distributed & messaging](./03-round-3-distributed-messaging.md),
where the question becomes: what happens when these machines have to agree, and the
network is allowed to lie.
