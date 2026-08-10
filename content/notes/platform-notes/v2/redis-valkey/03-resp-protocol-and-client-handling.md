# Chapter 3: The RESP Protocol & Client Handling

> RESP is the wire format that connects every client library on Earth to Redis.
> It is so deliberately small that you can write a working RESP parser on a
> napkin in 50 lines of code, and so deliberately efficient that it has scaled
> from one connection to one million. This chapter shows you the bytes, the
> parser, the buffering, the gotchas, and why pipelining is the single most
> underrated optimization in distributed systems.

---

## 3.1 What RESP Is and Why It Looks Like That

RESP — REdis Serialization Protocol — is a text-with-length-prefix binary-safe
protocol. It optimises for three things:

1. **Cheap to parse on the server** — the parser never has to look ahead more
   than a few bytes; lengths are explicit.
2. **Human-debuggable** — you can `telnet redis-host 6379` and type commands
   by hand.
3. **Binary-safe** — values can contain any bytes including `\0`, `\r`, `\n`.

There are two versions:

| Version | Default in | Capabilities |
|---------|-----------|--------------|
| RESP2 | All Redis clients before 6 | 5 data types: simple string, error, integer, bulk string, array |
| RESP3 | Redis 6+ (opt-in via `HELLO 3`) | RESP2 + null, double, boolean, big number, map, set, attribute, push, verbatim string |

RESP3 was added to support modern data types (returning `HGETALL` as a true
map instead of an alternating-key-value array), pub/sub push messages on the
same connection as commands, and richer client tracking. We cover RESP2 first
because that's what 90% of clients still speak; RESP3 differences are at the
end.

---

## 3.2 RESP2 Bytes: The Five Types

Every RESP2 message starts with one of five marker bytes, then has type-specific
content, ending in `\r\n`.

### 3.2.1 Simple String — `+`

```
+OK\r\n
```

Used for short server-side success messages. Cannot contain `\r` or `\n` in the
content. Examples: `+OK`, `+PONG`.

### 3.2.2 Error — `-`

```
-ERR unknown command 'foobar'\r\n
-WRONGTYPE Operation against a key holding the wrong kind of value\r\n
-MOVED 12345 10.0.0.5:6379\r\n
```

Same constraints as simple string — no `\r`/`\n`. The first whitespace-separated
token is the **error type** (e.g., `ERR`, `WRONGTYPE`, `MOVED`, `ASK`, `NOAUTH`,
`NOSCRIPT`, `BUSY`). Clients are expected to switch on this token.

### 3.2.3 Integer — `:`

```
:1000\r\n
:-7\r\n
```

Always a 64-bit signed integer in decimal text. No leading `+`, optional `-`.

### 3.2.4 Bulk String — `$`

```
$5\r\nhello\r\n
$0\r\n\r\n         <- empty string
$-1\r\n            <- "null bulk string"  (RESP2 way to say "no value")
```

A length prefix, then exactly that many bytes, then `\r\n`. The bytes are
arbitrary — they may contain `\r`, `\n`, or `\0`. This is the workhorse for
returning string values, hash field values, list elements.

### 3.2.5 Array — `*`

```
*3\r\n$3\r\nGET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n
```

A length prefix, then exactly that many RESP elements (any type). Arrays nest:
an array can contain arrays.

```
*-1\r\n            <- "null array" (e.g., timeout from BLPOP)
*0\r\n             <- empty array
```

### 3.2.6 The Protocol in One Line

The grammar:

```
RESP2_value ::= simple_string | error | integer | bulk_string | array
simple_string ::= "+" <bytes without \r\n> "\r\n"
error         ::= "-" <bytes without \r\n> "\r\n"
integer       ::= ":" <decimal int64> "\r\n"
bulk_string   ::= "$" <decimal length>  "\r\n" <length bytes> "\r\n"
                 | "$-1\r\n"  (null)
array         ::= "*" <decimal count>   "\r\n" <count RESP2_values>
                 | "*-1\r\n"  (null)
```

That's the whole protocol. Implementations exist in every language, all under
500 lines.

---

## 3.3 Client → Server: How a Command Is Sent

Every modern client sends commands as a RESP array of bulk strings, one bulk
string per argument. So `SET foo bar` becomes:

```
*3\r\n
$3\r\nSET\r\n
$3\r\nfoo\r\n
$3\r\nbar\r\n
```

— a 30-byte payload for a 3-character command. The overhead is real but small
relative to network MTU.

>>> **Interview insight**: The "wasteful" length-prefix design is *intentional*.
>>> It lets the parser allocate exactly the right buffer size for each bulk
>>> string up front, do exactly one `read()` (or several but with known target),
>>> and never have to scan for delimiters inside binary data. Compare to
>>> Memcached's text protocol which is ambiguous about binary content.

### 3.3.1 The Inline Protocol (Legacy)

Before RESP2, Redis accepted "inline commands":

```
SET foo bar\r\n
```

The server still accepts this for human telnet sessions. Detection: if the
first byte of a command is *not* `*`, it's parsed as inline. Real client
libraries should never send inline — it's not binary-safe.

---

## 3.4 The Server-Side Parser, Step by Step

The parser is in `networking.c`. It is invoked from `processInputBuffer()`
after `read()` lands bytes in `c->querybuf`.

```c
int processMultibulkBuffer(client *c) {
    char *newline = NULL;
    int ok;
    long long ll;

    if (c->multibulklen == 0) {
        // Step 1: parse "*N\r\n" header
        newline = strchr(c->querybuf + c->qb_pos, '\r');
        if (newline == NULL) return C_ERR;       // wait for more data
        if ((newline - c->querybuf) > (sdslen(c->querybuf) - 2)) return C_ERR;

        ok = string2ll(c->querybuf + c->qb_pos + 1, newline - (c->querybuf+c->qb_pos+1), &ll);
        if (!ok || ll > 1024*1024 || ll < 0) {
            addReplyError(c, "Protocol error: invalid multibulk length");
            return C_ERR;
        }
        c->qb_pos = (newline - c->querybuf) + 2;   // advance past \r\n
        c->multibulklen = ll;
        c->argv = zmalloc(sizeof(robj*) * ll);
    }

    while (c->multibulklen) {
        if (c->bulklen == -1) {
            // Step 2: parse "$L\r\n" header
            newline = strchr(c->querybuf + c->qb_pos, '\r');
            if (newline == NULL) return C_ERR;
            if (c->querybuf[c->qb_pos] != '$') {
                addReplyErrorFormat(c, "Protocol error: expected '$', got '%c'",
                                    c->querybuf[c->qb_pos]);
                return C_ERR;
            }
            ok = string2ll(c->querybuf + c->qb_pos + 1, newline - (c->querybuf + c->qb_pos + 1), &ll);
            if (!ok || ll < 0 || ll > server.proto_max_bulk_len) { ... }
            c->qb_pos = (newline - c->querybuf) + 2;
            c->bulklen = ll;
        }

        // Step 3: read the bulk's bytes
        if (sdslen(c->querybuf) - c->qb_pos < (size_t)(c->bulklen + 2)) {
            return C_ERR;   // wait for more data
        }
        c->argv[c->argc++] = createStringObject(c->querybuf + c->qb_pos, c->bulklen);
        c->qb_pos += c->bulklen + 2;     // advance past bytes + \r\n
        c->bulklen = -1;
        c->multibulklen--;
    }

    return C_OK;
}
```

What to internalise:

- **Parsing is incremental.** If we don't have enough bytes, we `return C_ERR`
  (which means "not done yet, come back later"). State (`qb_pos`,
  `multibulklen`, `bulklen`) is preserved across calls. The next `read()`
  triggers `processInputBuffer` again, which retries.
- **No copying of large bulk content.** `createStringObject` creates an SDS
  pointing into a freshly-allocated buffer; we don't move bytes inside the
  query buffer.
- **`qb_pos` advances forward**, not by trimming. Compaction of the query
  buffer happens later (or never if it stays small).
- **Multiple commands per call.** After `processMultibulkBuffer` succeeds,
  `processInputBuffer` calls `processCommand` and then loops back to parse the
  next command in the same buffer. This is the foundation of pipelining.

---

## 3.5 Pipelining: The Free Lunch

A round trip is the killer. Even on a LAN, a 100 µs network RTT means 10K
commands/second per client if you wait for each reply. That's terrible.
Pipelining fixes it.

```
Without pipelining (1 RTT per command):
   client: GET a    --> 100 µs RTT --> reply
   client: GET b    --> 100 µs RTT --> reply
   client: GET c    --> 100 µs RTT --> reply
   3 commands, 300 µs

With pipelining (1 RTT total):
   client: GET a; GET b; GET c   --100 µs RTT--> reply a; reply b; reply c
   3 commands, 100 µs
```

The wire image of a pipelined request is just multiple RESP arrays back to back:

```
*2\r\n$3\r\nGET\r\n$1\r\na\r\n
*2\r\n$3\r\nGET\r\n$1\r\nb\r\n
*2\r\n$3\r\nGET\r\n$1\r\nc\r\n
```

The server parses them sequentially, executes each in turn, and the replies
come back in the same order:

```
$5\r\nval_a\r\n
$5\r\nval_b\r\n
$5\r\nval_c\r\n
```

### 3.5.1 Pipelining vs Transactions

These are unrelated and frequently confused:

| | Pipelining | Transaction (MULTI/EXEC) |
|-|-----------|--------------------------|
| Purpose | Reduce network round trips | Atomic group of commands |
| Atomic? | No. Other clients' commands can interleave between commands in the pipeline | Yes. The whole MULTI/EXEC block runs uninterrupted |
| Server treats it as | A back-to-back stream of independent commands | A single batch held until EXEC |
| Reply timing | Each reply queued as it's produced | All replies returned together at EXEC |

Use pipelining for performance. Use transactions for atomicity. Use both
together if you need both.

### 3.5.2 Pipeline Sizing

How big should a pipeline be?

- **Too small** (1-10 commands): you don't amortise enough RTTs.
- **Too big** (10K+ commands): you fill the OS socket buffer, the server's
  query buffer, and the server's reply buffer — eventually one of them backpressures
  and your pipeline blocks.

Empirically, 100-1000 commands per pipeline is the sweet spot. Most client
libraries (Jedis, lettuce, ioredis) auto-flush at this size or after a timeout.

(!) **Production hazard**: If you pipeline 1 million commands at once, you can
  blow the server's `client-output-buffer-limit normal` and the server will
  disconnect you mid-stream. Cap your pipelines.

---

## 3.6 The Reply Path: Per-Client Buffers

Replies don't go straight to the socket. They go to the `client` struct in two
buffers:

```c
typedef struct client {
    int fd;                   // the socket
    sds querybuf;             // input bytes from socket

    // Reply buffers:
    char buf[PROTO_REPLY_CHUNK_BYTES];  // 16 KB static, fast path
    int bufpos;
    list *reply;              // overflow: linked list of clientReplyBlock
    unsigned long long reply_bytes;
    size_t sentlen;           // how much of head reply already written
    ...
} client;
```

Two-tier strategy:

- **Static buffer `c->buf` (16 KB)**: used by `addReplyToBuffer()`. As long as
  the cumulative reply for this iteration fits, we copy bytes here. Zero
  allocation.
- **Linked list `c->reply`**: when the static buffer overflows (or when an
  individual reply piece is too big), we allocate `clientReplyBlock` chunks
  (each ~16 KB) and append to the list.

This is the same pattern as Java's `StringBuilder` with a small inline buffer
followed by a chunk list.

### 3.6.1 Output buffer limits

Per-client memory is capped via `client-output-buffer-limit`:

```
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit replica 256mb 64mb 60
client-output-buffer-limit pubsub  32mb  8mb  60
```

Format: `<class> <hard-limit> <soft-limit> <soft-seconds>`.

- **Normal clients (default 0 0 0)**: no cap. If a client is slow and you keep
  shoving replies at it, RAM grows unbounded. (Unless you also set
  `maxmemory-clients`.)
- **Replica clients (256mb / 64mb / 60s)**: kill the replica connection if its
  output buffer exceeds 256 MB at any moment, OR exceeds 64 MB for 60
  consecutive seconds.
- **Pub/Sub subscribers (32mb / 8mb / 60s)**: same idea.

(!) **Production hazard**: The replica limit is the single most common cause
  of "replica keeps disconnecting under load." Replica falls behind, output
  buffer fills, primary kills the link, replica reconnects, full resync happens
  (because the replication backlog is also overrun), the cycle repeats. The fix
  is to raise the limits or fix the underlying network/disk bottleneck. Chapter
  11 has the playbook.

### 3.6.2 maxmemory-clients (Redis 7+)

Newer Redis versions track total client memory (input + output buffers across
all clients) and enforce a global cap:

```
maxmemory-clients 1gb
maxmemory-clients 10%   # 10% of maxmemory
```

When exceeded, Redis evicts the biggest-buffered clients. This is the safety
net for the "many slow clients with `client-output-buffer-limit normal 0 0 0`"
problem.

---

## 3.7 Pub/Sub Wire Image

Pub/Sub uses RESP arrays with a special structure:

```
SUBSCRIBE chan1 chan2
-> *3\r\n$9\r\nsubscribe\r\n$5\r\nchan1\r\n:1\r\n
   *3\r\n$9\r\nsubscribe\r\n$5\r\nchan2\r\n:2\r\n
```

After subscribing, when a publisher sends `PUBLISH chan1 hello`, the
subscriber receives:

```
*3\r\n$7\r\nmessage\r\n$5\r\nchan1\r\n$5\r\nhello\r\n
```

These messages arrive **interleaved with command replies on the same TCP
connection** in RESP2. RESP3 fixes this with a dedicated push type (`>`).

### 3.7.1 The Subscribed-Connection Lockout

Once a client `SUBSCRIBE`s in RESP2, the connection is restricted: only
`SUBSCRIBE`, `UNSUBSCRIBE`, `PSUBSCRIBE`, `PUNSUBSCRIBE`, `QUIT`, and `PING`
are allowed. Trying anything else returns:

```
-ERR Can't execute 'get': only (P)SUBSCRIBE / (P)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context
```

This is why every Pub/Sub client library opens a *separate* TCP connection
for the subscription, leaving the primary connection free for normal commands.

### 3.7.2 Sharded Pub/Sub `[Redis 7+]`

In a cluster, regular `PUBLISH` broadcasts to *every* node — which doesn't
scale. Sharded Pub/Sub (`SPUBLISH`, `SSUBSCRIBE`) routes by key (`channel`
hashed to a slot) so the message only goes to the slot's node.

---

## 3.8 RESP3 Highlights

If your client speaks RESP2, skip this section. If you want to use RESP3
features (typed replies, push messages, client tracking), here is what's
new.

Switch protocols with `HELLO`:

```
HELLO 3 [AUTH user password] [SETNAME connname]
```

The server replies with a map of server info. After this point, the connection
speaks RESP3.

New types added:

| Marker | Type | Example |
|--------|------|---------|
| `_\r\n` | Null | Replaces `$-1`, `*-1`, `:-1` everywhere |
| `,` | Double | `,3.14159\r\n` |
| `#` | Boolean | `#t\r\n` or `#f\r\n` |
| `(` | Big number | `(3492890328409238509324850943850943825024385\r\n` |
| `=` | Verbatim string | `=15\r\ntxt:Some string\r\n` |
| `%` | Map | `%2\r\n+key1\r\n+val1\r\n+key2\r\n+val2\r\n` |
| `~` | Set | `~3\r\n+a\r\n+b\r\n+c\r\n` |
| `\|` | Attribute | Adds metadata to the next reply (e.g., key timestamps) |
| `>` | Push | Out-of-band server-pushed message (Pub/Sub, invalidation) |

The biggest wins:

- **`HGETALL` returns a `Map`** in RESP3 instead of `[k1, v1, k2, v2, ...]` in
  RESP2 — clients no longer need adapter logic.
- **Push (`>`) for client-side caching invalidations** (`CLIENT TRACKING`).
  Redis sends invalidations on the same connection without RESP2's awkward
  Pub/Sub workaround.

---

## 3.9 Client-Side Caching (Tracking)

Redis 6 added a server-driven cache invalidation mechanism. The basic idea: a
client tells Redis "I'm caching keys locally; please notify me when they
change." Redis tracks which clients have read which keys and sends invalidation
messages on writes.

```
CLIENT TRACKING ON
GET user:42        -> "alice"   (also: client now tracks key "user:42")
... another client does: SET user:42 "bob" ...
=> server pushes: > 2 invalidate ["user:42"]
```

Two modes:

- **Default (per-key tracking)**: Server keeps a key→client mapping in the
  Tracking Table (memory cost on the server). Best for small working sets.
- **Broadcast mode (`BCAST`)**: Server doesn't track per key; instead, clients
  subscribe to *prefixes* and get every write within those prefixes. Memory-cheap
  on the server, more network noise.

This is one of the most under-used Redis features. We revisit it in Chapter 17
(caching patterns).

---

## 3.10 Connection Lifecycle: A Field Manual

What happens to a TCP connection over its lifetime:

```
connect (TCP handshake)
    +
    v
HELLO 3 (optional, switch to RESP3)
    +
    v
AUTH (if requirepass set)
    +
    v
SELECT db (if non-cluster, multi-db)
    +
    v
[main loop of commands and pipelines]
    +
    v
QUIT or socket close
```

Things to know:

- **Idle connections survive forever** unless `tcp-keepalive` (default 300s)
  detects a dead peer. The server sends a TCP keepalive every 300 seconds; if
  the kernel reports the peer dead, the server closes its side.
- **Per-client `timeout` config** closes idle clients after N seconds (default
  `timeout 0` = never). Set this in environments where clients leak connections.
- **`CLIENT NO-EVICT ON`** marks a client as exempt from `maxmemory-clients`
  eviction. Use for replication and important server-internal connections.
- **`CLIENT PAUSE ms`** stops processing commands for ms milliseconds.
  Used during failover to drain in-flight writes.
- **`CLIENT KILL ADDR ip:port`** disconnects a client.
- **`CLIENT LIST`** dumps all connected clients with their stats — incredibly
  useful for debugging.

```
$ redis-cli CLIENT LIST
id=12 addr=127.0.0.1:55432 fd=8 name=app1 age=1234 idle=0 ... cmd=get ...
id=13 addr=127.0.0.1:55433 fd=9 name=app2 age=234 idle=10 ... cmd=ping ...
```

---

## 3.11 Inline Compression and TLS

There is no compression at the RESP layer. If you want compressed values, your
client compresses them. Some libraries (Stackexchange.Redis with `IBufferWriter`,
ioredis with codecs) support transparent codecs.

TLS: Redis 6+ supports TLS natively (`redis-server --tls-port 6380 ...`).
The TLS handshake adds ~1-3 ms per connection (use connection pooling), and TLS
encryption adds ~10-30% CPU per byte. The wire format inside TLS is the same
RESP. I/O threads (Chapter 2) help mitigate the CPU cost.

---

## 3.12 Field Notes from Production

A few things that bite people in real systems:

### 3.12.1 Connection storms after a deploy

When 500 application pods restart simultaneously and each opens 32 connections,
Redis sees 16,000 simultaneous connection attempts. With TLS this means 16K
TLS handshakes — at 5 ms each, the main thread is busy for 80 seconds.

**Fix**: cap `tcp-backlog` at a sane value, use staggered rolling deploys,
pool connections on the client side.

### 3.12.2 Output buffer explosion from a single bad client

A subscriber to a high-throughput channel falls behind. The server keeps
buffering, hitting `client-output-buffer-limit pubsub`. The client is killed.
The application reconnects. Cycle repeats.

**Fix**: monitor `info clients output_buffer_length`, set sensible limits,
ensure consumers can keep up, consider sharded Pub/Sub or Streams + consumer
groups for slow consumers.

### 3.12.3 Pipelining a dataset import without flow control

```
for i in range(1_000_000):
    pipe.set(f"k{i}", f"v{i}")
pipe.execute()    # OOM
```

This buffers 1 M commands client-side and 1 M replies server-side before
flushing. Both can blow up.

**Fix**: flush in chunks of 1000-10000.

### 3.12.4 Mixing pub/sub and commands on one connection

Setting up Pub/Sub on the same connection your app uses for `GET`/`SET`
will cause every other command to fail with "Can't execute 'get': only
(P)SUBSCRIBE / (P)UNSUBSCRIBE..." once you subscribe.

**Fix**: dedicated connection per Pub/Sub subscriber.

---

## 3.13 Hand-Building a RESP Parser (≤80 lines)

To prove RESP is as simple as advertised, here is a complete RESP2 decoder in
Python. Use it to debug servers, write test fixtures, or just internalise the
protocol:

```python
def decode(buf, i=0):
    """Returns (value, next_index) or (None, i) if more data needed."""
    if i >= len(buf): return None, i
    t = chr(buf[i]); i += 1

    if t == '+' or t == '-':
        end = buf.find(b'\r\n', i)
        if end == -1: return None, i
        s = buf[i:end].decode()
        return (s if t == '+' else Exception(s)), end + 2

    if t == ':':
        end = buf.find(b'\r\n', i)
        if end == -1: return None, i
        return int(buf[i:end]), end + 2

    if t == '$':
        end = buf.find(b'\r\n', i)
        if end == -1: return None, i
        n = int(buf[i:end])
        if n == -1: return None, end + 2
        if len(buf) < end + 2 + n + 2: return None, i
        return bytes(buf[end+2 : end+2+n]), end + 2 + n + 2

    if t == '*':
        end = buf.find(b'\r\n', i)
        if end == -1: return None, i
        n = int(buf[i:end])
        if n == -1: return None, end + 2
        i = end + 2
        out = []
        for _ in range(n):
            v, i = decode(buf, i)
            if v is None: return None, i
            out.append(v)
        return out, i

    raise ValueError(f"unknown type {t!r}")


def encode(value):
    if isinstance(value, str):
        b = value.encode()
        return b'$' + str(len(b)).encode() + b'\r\n' + b + b'\r\n'
    if isinstance(value, int):
        return b':' + str(value).encode() + b'\r\n'
    if isinstance(value, list):
        return b'*' + str(len(value)).encode() + b'\r\n' + b''.join(encode(x) for x in value)
    raise TypeError(type(value))
```

```python
>>> encode(['SET', 'foo', 'bar'])
b'*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n'

>>> decode(b'$5\r\nhello\r\n')
(b'hello', 11)

>>> decode(b'*2\r\n:1\r\n:2\r\n')
([1, 2], 12)
```

That's the protocol. If you can read and write these bytes, you can talk
directly to any Redis or Valkey server in the world.

---

## Practice Questions

1. A client sends two commands without waiting for the first reply. Both touch
   the same key (`SET k v1; GET k`). What's the guaranteed reply order? Why?
2. Why does RESP use `\r\n` as a delimiter and length prefixes for bulk
   strings? Wouldn't just `\n` save a byte?
3. You see your application throwing "ERR Protocol error: invalid bulk
   length" intermittently. What kinds of bugs in client code produce this
   error?
4. Your `client-output-buffer-limit normal` is 0 0 0 (unlimited). A buggy
   monitoring script subscribes via `MONITOR` and then stops reading. What
   happens to RAM, and what config saves you?
5. Estimate the wire size of `MGET k1 k2 ... k1000` where each key is
   8 bytes. Then estimate the reply size if each value is 100 bytes. What
   does this tell you about pipeline sizing?
6. Why does `HELLO 3` exist as a server-side command and not a TCP option?

(Answers at end of Chapter 22.)
