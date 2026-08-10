# Chapter 7 — The Network Stack
### From Socket to Request Handler, and the Purgatories

---

The Kafka broker's networking layer is one of the parts of the system most
worth understanding *exactly*. Almost every operational symptom you will see
— produce timeouts, slow fetches, ISR shrinks under load, "the cluster
feels sluggish" — eventually connects back to one of three numbers: how
many threads are doing network I/O, how many threads are doing request
handling, and how full the queue between them is. If you can recite the
network-stack architecture from memory, you can diagnose three quarters of
broker problems without opening a code file.

This chapter walks the broker's network stack. We cover:

- The Reactor pattern Kafka uses, and the `Acceptor → Processor → Handler`
  pipeline.
- What "purgatory" means and why it exists.
- The `request.queue` and what fills it up.
- Connection management, idle handling, and the per-listener model.
- Diagnostic JMX metrics that tell you which thread pool is unhappy.
- The interaction with TLS, SASL, and quota throttling.

By the end, you should be able to describe what happens between a TCP
`SYN` arriving on port 9092 and a `ProduceResponse` being written back to
the wire.

---

## 7.1 The Reactor pattern, briefly

Kafka uses a **Reactor pattern** for its network stack. The basic idea
predates Kafka by decades and shows up in nginx, Netty, and most other
high-throughput servers. There are three reasons it dominates:

1. **One thread per connection does not scale.** A broker with 50,000
   connections cannot afford 50,000 threads — context-switch overhead, stack
   memory, and synchronisation costs would dominate. Reactor uses a small
   pool of threads to multiplex many connections.
2. **`select()`/`epoll()` are cheap.** The kernel's I/O readiness
   notification is far cheaper than per-connection polling. A single thread
   can manage thousands of connections by waking only when one is ready.
3. **Separation of concerns.** Reactor lets you separate "is this
   connection ready" (cheap, kernel-driven) from "process the request"
   (expensive, application-driven). Each layer can scale independently.

The Java implementation uses `java.nio.channels.Selector` (which is a thin
wrapper around `epoll` on Linux, `kqueue` on BSD/macOS). The broker spins
up a small set of threads, each owning a `Selector`, each handling many
sockets.

---

## 7.2 The threads

Here is the broker's network architecture, end to end:

```
                            ┌─────────────┐
                            │  Acceptor   │  (1 per listener)
                            │  (1 thread) │
                            └──────┬──────┘
                                   │ accepts new TCP connections
                                   │ assigns to processor (round-robin)
                                   ▼
              ┌────────────────────────────────────────────┐
              │              Processors                     │  (num.network.threads)
              │  ┌────────┐  ┌────────┐  ┌────────┐         │
              │  │Proc N0 │  │Proc N1 │  │Proc N2 │  ...    │
              │  │Selector│  │Selector│  │Selector│         │
              │  └───┬────┘  └───┬────┘  └───┬────┘         │
              └──────┼───────────┼───────────┼──────────────┘
                     │           │           │
                     └─────┐ pushes complete requests
                           ▼
                ┌──────────────────────┐
                │   request.queue      │  (bounded, size ~500)
                │   ┌─┬─┬─┬─┬─┬─┬─┐    │
                │   └─┴─┴─┴─┴─┴─┴─┘    │
                └──────────┬───────────┘
                           │
                           │ pops and processes
                           ▼
              ┌────────────────────────────────────────────┐
              │           Request Handlers                  │  (num.io.threads)
              │  ┌────────┐  ┌────────┐  ┌────────┐         │
              │  │Hdlr H0 │  │Hdlr H1 │  │Hdlr H2 │  ...    │
              │  └───┬────┘  └───┬────┘  └───┬────┘         │
              └──────┼───────────┼───────────┼──────────────┘
                     │           │           │
                     │ produces responses
                     ▼
                 response queue per processor
                     │
                     └→ Processors send responses back over the wire
```

Three thread pools, two queues. Read this top-to-bottom and bottom-to-top
both directions until it sticks.

### 7.2.1 Acceptor

One thread per **listener**. A listener is a `(host, port, protocol)`
triple — typical brokers have at least two listeners (one for client
traffic, one for inter-broker replication), and may have more for separate
TLS, SASL, or external/internal interfaces. The
`listeners=PLAINTEXT://0.0.0.0:9092,SSL://0.0.0.0:9093` config defines
them.

The acceptor's job is to call `accept()` on the listening socket, get a
new connection, and hand it to a processor. It uses round-robin assignment
across the processors of that listener. The acceptor does *no* request
processing — it is purely a dispatcher.

If your broker is rejecting new connections (refusing connections, or
clients seeing "connection refused"), the acceptor is overloaded. Almost
never the bottleneck in practice.

### 7.2.2 Processors

`num.network.threads` of these (default 3). Each owns a `Selector` with
many connection channels registered. The processor's loop:

```java
while (running) {
    selector.select(timeoutMs);
    
    for (key in selector.selectedKeys()) {
        if (key.isReadable()) {
            // read bytes from socket
            // accumulate into a request buffer
            // if a complete request is buffered:
            //   push it onto request.queue
            //   set this connection to "muted" — won't read again
            //   until response is sent (preserves request order per conn)
        }
        if (key.isWritable()) {
            // write pending response bytes to socket
            // if response fully sent:
            //   "unmute" the connection — read can resume
        }
    }
    
    // Check responseQueue for new responses, register them for write
    while (!responseQueue.isEmpty()) {
        response = responseQueue.poll();
        ...
    }
}
```

Two important things here:

**Per-connection muting.** When a complete request has been read from a
connection and pushed to the request queue, the processor stops reading
more bytes from that connection. This **enforces in-order processing per
connection** — the next request from the same client is not even read off
the wire until the current one has a response. This matters a lot for the
producer's `max.in.flight.requests.per.connection` setting: at the broker,
all requests on one connection are processed in order. Multiple in-flight
requires *multiple connections* (or multiple network requests pipelined,
read in order, processed in order, responses in order — which is exactly
what the broker does).

**Round-robin connection ownership.** A given connection lives on exactly
one processor for its lifetime. There's no rebalancing of connections
across processors. This means an unlucky distribution can leave one
processor with all the heavy clients and another nearly idle. In practice,
with `num.network.threads=3` to `8` and tens of thousands of connections,
the law of large numbers spreads the load evenly enough.

### 7.2.3 The request queue

A bounded `ArrayBlockingQueue` (default size 500). Processors push, request
handlers poll. **This is the critical handoff point.**

When the queue fills:

- Processors *block* on push.
- Which means processors stop reading new requests.
- Which means clients see growing produce/fetch latency.
- Which means request timeouts and retries cascade.

The queue size is `queued.max.requests` (default 500). On a busy broker,
500 is generally fine — request handlers keep up. On a sick broker (slow
disk, GC pauses, bad replication delay), the queue fills up and the
broker becomes a slow-failure point.

The relevant JMX metric is `RequestQueueSize` from `kafka.network:type=RequestChannel`.
It should normally hover near zero, with brief spikes on burst. If it's
sustained high, your request handlers can't keep up — either you need
more of them (`num.io.threads`), or each request is taking too long
(disk slow, GC, etc).

### 7.2.4 Request handlers

`num.io.threads` of these (default 8). Each handler thread:

```java
while (running) {
    request = requestChannel.receiveRequest();   // blocks on queue
    
    if (request.isProduceRequest()) {
        handleProduce(request);
    } else if (request.isFetchRequest()) {
        handleFetch(request);
    } else if (request.isMetadataRequest()) {
        handleMetadata(request);
    } else if ... // many more request types
    
    // sendResponse() pushes onto the responseQueue of the appropriate processor
}
```

Each handler thread can do a substantial amount of work per request — a
ProduceRequest involves disk I/O (the `Log.append()` from Chapter 6),
authorisation checks, idempotence-state lookups. A FetchRequest involves
log scans, possibly waiting in fetch-purgatory. A MetadataRequest involves
serialising a fairly large response. The "average request" might take 1
to 50 milliseconds; outliers can be much more.

The relevant JMX metric is `RequestHandlerAvgIdlePercent` from
`kafka.server:type=KafkaRequestHandlerPool`. It is the fraction of time
the handler threads are idle, averaged across the pool. **Healthy value:
> 70%.** Below 30% is alarming — the broker is CPU-bound on its own work.

### 7.2.5 Response queue

Each processor has its own response queue. After a request handler
finishes, it pushes the response into the response queue of *the same
processor that received the request*. This preserves "responses go back
on the same connection they came from" without needing cross-processor
coordination.

The processor picks up responses from its queue on the next iteration of
its loop and registers the connection for write. Once written, the
connection is unmuted and ready for the next request.

---

## 7.3 The purgatories

Some Kafka requests cannot be answered immediately. They have to *wait*
for some condition. The classic example: a `ProduceRequest` with
`acks=all` cannot be acknowledged until the HWM has advanced past the
record's offset, which happens after enough followers have replicated.

Naively, the request handler thread could block waiting for HWM
advancement. But that would tie up a request handler for tens of ms of
just waiting — when you only have 8 of them, that's a problem.

Kafka's solution is **Purgatory**. A purgatory is a data structure that
holds *delayed operations*: requests that are waiting for a condition. The
request handler completes its synchronous work, places the request in
purgatory, and returns. Later, when the condition is satisfied (HWM
advances, more bytes arrive, etc), purgatory completes the operation and
sends the response.

Three purgatories on the broker:

### 7.3.1 ProducePurgatory

Holds `ProduceRequest`s waiting for `acks=all` HWM advancement.

A request is added to purgatory with a timeout (`request.timeout.ms`).
When the timeout fires, the request is completed with a
`REQUEST_TIMEOUT_MS_EXCEEDED` (rare; usually some upstream issue caused
the wait).

When the leader's HWM advances, **partition state machine** notifies
purgatory. Purgatory checks all delayed produces against the new HWM and
completes the ones whose target offsets are now ≤ HWM.

### 7.3.2 FetchPurgatory

Holds `FetchRequest`s waiting for either `minBytes` of data or
`maxWaitMs` to elapse. This is the long-poll mechanism: when a consumer
fetches with `fetch.min.bytes=1MB, fetch.max.wait.ms=500ms`, and only
500KB is available, the request goes into FetchPurgatory and waits up to
500ms for more data to arrive.

When the partition's LEO advances (more data appended), FetchPurgatory is
notified and re-checks waiting fetches.

For follower fetches: same mechanism, but with `replicaId` set — the
broker knows it's a follower and the fetch participates in HWM
calculations.

### 7.3.3 DelayedDeleteRecords / DelayedJoin / DelayedHeartbeat

Smaller purgatories for less common operations: explicit
`DeleteRecordsRequest` (rare), the JoinGroup/SyncGroup protocol of the
group coordinator (Chapter 11), and consumer heartbeat tracking.

### 7.3.4 The data structure

Internally, a purgatory is a *timer wheel* combined with a watcher map.
The timer wheel handles "complete this request after X ms"; the watcher
map handles "complete this request when condition Y becomes true."

Kafka's `TimerWheel` is a hierarchical timing wheel — efficient O(1) insert
and tick-advance, with bounded buckets. The implementation is in
`org.apache.kafka.server.util.timer.SystemTimer`. Worth reading if you ever
want to understand efficient timeout management; it is one of the cleaner
pieces of the broker.

---

## 7.4 Connection management

Each connection has state on the broker:

- **Owning processor.** Set on accept; immutable for the connection's
  life.
- **Read buffer**. Used by the processor to accumulate partial requests.
- **Write buffer / pending responses.** Kept in the response queue and
  written when the socket becomes writable.
- **Authentication state.** Cached after SASL handshake or TLS-mutual-auth.
- **Quota state.** Cached client-id / user identity for quota enforcement.
- **Connection idle timer.** Tracks the last activity for idle eviction.

### Idle connection eviction

A connection idle longer than `connections.max.idle.ms` (default 600000 ms,
10 minutes) is forcibly closed by the broker. This bounds the broker's
connection-state memory.

Clients (good clients) handle this by reconnecting transparently. The
producer's `connections.max.idle.ms` (default 540000 ms, 9 minutes — slightly
less than the broker's, intentionally) lets the client close first to
avoid the disconnect noise. Older clients sometimes do not, leading to
mysterious "Connection reset by peer" log lines on idle clients —
basically harmless but noisy.

### Connection limits

`max.connections.per.ip` (default unbounded) caps connections from a
single IP. `max.connections` (default unbounded) is the cluster-wide
cap. Both should typically be set in production: a misbehaving client (or
a fork bomb on a client host) can otherwise exhaust the broker's file
descriptors.

### Listener separation

A common production setup:

```properties
listeners=INTERNAL://0.0.0.0:9091,EXTERNAL://0.0.0.0:9092,REPLICATION://0.0.0.0:9093
inter.broker.listener.name=REPLICATION
advertised.listeners=INTERNAL://broker-1.internal:9091,EXTERNAL://broker-1.example.com:9092,REPLICATION://broker-1.internal:9093
```

This gives:

- Inter-broker traffic on a dedicated listener (replication, controller
  RPCs) — usually with its own bandwidth allocation.
- Internal client traffic on a listener restricted to internal networks.
- External client traffic on a listener available externally (with TLS,
  ACLs, etc).

Each listener has its own acceptor and its own set of processors. The
counts are configured per-listener: `listener.name.external.num.network.threads=8`
overrides the default for the external listener.

This separation lets you keep replication traffic insulated from a sudden
external traffic spike — a common stability pattern. Without it, a single
processor pool serves all listeners, and a noisy external client can
starve replication.

---

## 7.5 TLS, SASL, and quota throttling

### 7.5.1 TLS

When a connection arrives on a TLS-enabled listener, the processor handles
the TLS handshake at the `SslChannel` layer (a wrapper around
`SSLEngine`). The handshake is non-blocking, driven by the same selector
loop, but is more expensive than plaintext — multiple round trips, CPU for
key exchange, ciphersuite negotiation.

After handshake, the channel is in "secure mode": all reads decrypt before
buffering, all writes encrypt before sending. As discussed in Chapter 6,
this **breaks `sendfile`-based zero-copy** unless kTLS is in use.

A common surprise is that **TLS at high connection churn rates is
expensive on the CPU**, even if not many bytes flow. Each new connection
pays the handshake cost. If your client churns connections (bad client
design — should hold connections open), TLS makes it 3-5x more expensive
on the broker.

### 7.5.2 SASL

SASL negotiates user identity over an established (typically TLS)
connection. Mechanisms:

- **SASL/PLAIN** — username and password sent as plaintext. Only safe over
  TLS.
- **SASL/SCRAM** — challenge-response, password never on the wire. Two
  variants, SHA-256 and SHA-512.
- **SASL/GSSAPI** — Kerberos.
- **SASL/OAUTHBEARER** — JWT-based, usually with an OIDC provider.

The handshake adds a few round trips before the connection is usable.
Caching is critical — clients should hold connections open after auth, not
re-handshake per request. The `sasl.kerberos.ticket.renew.window.factor`,
the OAuth token expiry, and friends govern when re-auth is needed.

### 7.5.3 Quota throttling

Kafka has client quotas (KIP-13 and successors): a user or client-id can
be limited to N MB/s of produce/fetch, or M requests/s. When a client
exceeds its quota, the broker delays the response.

The delay is implemented in the network stack: the response, instead of
going to the response queue immediately, is held in **DelayQueue** for
the configured throttle time. The client sees an artificially-long
response time and (correctly) slows down.

On modern Kafka versions, quota throttling is sophisticated:

- Per-user, per-client-id, per-topic quotas can be configured.
- A consumer's quota tracks its actual fetch rate and throttles based on
  rolling windows.
- The broker's `throttle-time-ms` field in responses tells the client
  exactly how long it was throttled.

Quotas are how multi-tenant Kafka clusters keep one tenant from starving
others. Configure them; review them periodically.

---

## 7.6 Diagnostic metrics

Network-stack health, in JMX:

| Metric | Healthy value | What it means |
|--------|---------------|---------------|
| `kafka.network:type=RequestMetrics,name=TotalTimeMs,request=Produce/Fetch/...` | `p99 < 50 ms` | Request latency, percentile distributions |
| `kafka.network:type=RequestChannel,name=RequestQueueSize` | `< 50` | Pending in queue between processors and handlers |
| `kafka.network:type=RequestChannel,name=ResponseQueueSize` | `< 50` | Pending in queue from handlers to processors |
| `kafka.network:type=Processor,name=IdlePercent,networkProcessor=N` | `> 70%` | Per-processor idle time |
| `kafka.server:type=KafkaRequestHandlerPool,name=RequestHandlerAvgIdlePercent` | `> 70%` | Request-handler idle time (averaged) |
| `kafka.network:type=Acceptor,name=AcceptorBlockedPercent,...` | `≈ 0` | Acceptor blocked (rare) |
| `kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec/BytesOutPerSec` | varies | Throughput |
| `kafka.network:type=NetworkProcessorAvgIdlePercent` | `> 70%` | Aggregate network idle |

If you check **only one metric**, check `RequestHandlerAvgIdlePercent`. If
it's high, the broker is fine; if low, the broker is overloaded and the
diagnostic question is *why*.

A typical drilldown:

1. `RequestHandlerAvgIdlePercent` low → handlers are busy.
2. `TotalTimeMs` per request type → which request type is slow?
   - Produce slow → check disk write latency, HWM advancement (replication).
   - Fetch slow → check disk read latency, page cache hit rate.
   - Metadata slow → check controller responsiveness.
3. `RequestQueueSize` high → queue between processors and handlers is
   backing up; handlers are saturated.
4. `NetworkProcessorAvgIdlePercent` low → processors saturated; usually
   means too many connections per processor or excessive bytes/sec.

This four-step drilldown handles most "broker is slow" tickets.

---

## 7.7 Tuning the network stack

```properties
# Listener / connection
listeners=PLAINTEXT://...:9092
num.network.threads=8                    # default 3; raise for high connection counts
queued.max.requests=500                  # request queue size; rarely tuned
connections.max.idle.ms=600000           # 10 min; rarely tuned
max.connections.per.ip=1000              # protect against client misbehaviour
max.connections.per.ip.overrides=admin-host:0    # whitelist
socket.send.buffer.bytes=102400          # SO_SNDBUF; rarely tuned
socket.receive.buffer.bytes=102400       # SO_RCVBUF; rarely tuned
socket.request.max.bytes=104857600       # max single request; ~100 MB

# Request handlers (the big one)
num.io.threads=16                        # default 8; raise to ~ 2× #CPUs

# Listener-specific overrides
listener.name.external.num.network.threads=8
```

**Sizing rule of thumb:**

- `num.network.threads` ≈ 1 thread per 5,000 connections, minimum 3, ceiling
  ~16.
- `num.io.threads` ≈ 2 × CPU cores, minimum 8.

The defaults work fine for clusters with up to a few thousand connections
and modest throughput. Tune up when you see saturation in JMX, not before.

---

## 7.8 The lifecycle of a Produce request, end to end

To anchor everything: trace a single ProduceRequest from arrival to
response.

1. Producer's TCP segment arrives on broker port 9092.
2. The kernel's network stack reads it; the `epoll` for the relevant
   processor's selector fires.
3. Processor 0's loop wakes from `select()`, sees the channel readable,
   reads bytes into the per-connection request buffer.
4. Once a complete request is buffered (size prefix indicates how much to
   read), the processor parses the request header, builds a `RequestChannel.Request`
   object, and pushes it onto the `request.queue`.
5. The connection is **muted**: processor stops reading further bytes
   from this connection until the response is sent.
6. Request Handler 3 is idle; it polls the `request.queue` and gets the
   request.
7. Handler decodes the request body, finds it's a `ProduceRequest`,
   dispatches to `KafkaApis.handleProduceRequest()`.
8. For each partition in the request:
   a. Authorise the produce (ACLs).
   b. Validate the records (CRC, sequence numbers, etc).
   c. Call `Log.append()` — appends to the active segment, updates
      sparse index, returns the assigned base offset.
   d. The follower fetcher threads on other brokers will eventually fetch
      these new records as part of their normal loops.
9. Now the handler has appended locally for all partitions. For
   `acks=all`, it constructs a `DelayedProduce` and adds it to
   `ProducePurgatory`. For `acks=1` or `acks=0`, it can build the
   response immediately.
10. Handler returns to its loop and grabs the next request from the
    queue.
11. Time passes. Followers fetch. Each follower notifies the leader of
    its new LEO. The leader's `Partition.maybeIncrementHighWatermark()`
    runs, sees that all ISR LEOs ≥ the produce's offset, advances HWM,
    and notifies `ProducePurgatory`.
12. `ProducePurgatory` finds the matching delayed operation, completes
    it, and pushes the response onto Processor 0's response queue.
13. Processor 0's loop wakes (timeout or notify), sees the response,
    registers the connection for write.
14. On the next select cycle, the connection is writable; processor
    writes the response bytes; once fully written, the connection is
    *unmuted* and ready for the next request.
15. The producer's `Sender` thread receives the response, completes the
    `Future`, fires the user-supplied callback.

A round trip. The fast path is steps 1-9 (synchronous in the handler).
Steps 11-14 are asynchronous on the leader side; the producer just sees
the eventual response.

For `acks=1`, steps 9-12 collapse: the handler can respond immediately
after local append (no purgatory). For `acks=0`, the handler can respond
without even appending locally (fire and forget; the broker may even
discard rejected records silently).

---

## Summary box

- The broker uses a Reactor pattern: one **Acceptor** thread per listener,
  N **Processor** threads, M **Request Handler** threads.
- Two queues: **request.queue** (Processors → Handlers, bounded ~500),
  **response queue** (Handlers → Processors, per-processor).
- **Per-connection muting** ensures requests are read and processed in
  order on each connection.
- **Purgatories** hold delayed operations: `ProducePurgatory`,
  `FetchPurgatory`, `DelayedJoin`, etc. Implemented with a hierarchical
  timer wheel.
- TLS breaks `sendfile`'s zero-copy. Plan for the CPU cost. Use kTLS if
  available.
- Quota throttling delays responses inside the network stack — clients
  see longer round trips, slow naturally.
- The single most important diagnostic: `RequestHandlerAvgIdlePercent`.
  High = healthy, low = overloaded. Drill from there.

## Further reading

- Doug Lea, *Scalable IO in Java*. The Reactor pattern, by the implementer
  of `java.util.concurrent`. Required reading.
- KIP-103: Separation of Internal and External traffic.
- KIP-72: Allow Sizing Incoming Request Queue in Bytes (rejected, but
  the discussion is illuminating).
- The Kafka source: `core/src/main/scala/kafka/network/SocketServer.scala`.
  About 1500 lines; legibly written; this is the network stack.

## War story: the queue that wasn't queueing

A team had a broker that intermittently dropped to 30% throughput. JMX
showed `RequestHandlerAvgIdlePercent = 25%` (low), `RequestQueueSize = 5`
(very low), and `BytesInPerSec` healthy. Handlers were busy; queue was
empty. Strange combination.

What was happening: the handlers were *each individually* slow. A specific
topic was experiencing slow `Log.append()` calls because its log
directory's filesystem (`xfs`) was running into a bug under high
fragmentation. Each handler thread spent 100ms+ per produce. The queue
stayed nearly empty — the processors were trickling requests in faster
than the handlers could consume them, but only barely; whenever a small
burst happened, it cleared immediately because there were so few backlogs.
Yet the *throughput* was stuck because the system was "always at line",
never catching up.

This is the failure mode of a saturated handler pool when handlers are
*each* slow rather than *collectively* slow. The queue length doesn't
spike; the handlers do. `TotalTimeMs` for the produce request type was
the giveaway — p99 had jumped from 8ms to 120ms.

Lesson: **`RequestQueueSize` low does not mean handlers are healthy**.
You need both `RequestHandlerAvgIdlePercent` *and* per-request-type
latency. Together they tell the story; alone, neither does.

The fix was a filesystem switch (xfs → ext4) on that broker's affected
disk and a defragmentation. Kafka itself was blameless. As is so often
the case, "broker is slow" turned out to be Layer 1.
