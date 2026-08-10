# Chapter 15 — gRPC and Protocol Buffers

> *When one of your microservices calls another, what's actually on the wire? Not JSON over a hand-rolled HTTP endpoint, if the system is built for scale — increasingly it's **gRPC**: a compact binary message (Protocol Buffers) carried as a stream over HTTP/2, with a strict schema, generated client/server code, and first-class support for streaming, deadlines, and cancellation. gRPC is not magic; it's a precise, elegant stack of things this book has already built — protobuf for serialization, HTTP/2 (Chapter 13) for transport — with a thin RPC layer on top. This chapter takes it apart until you can hand-decode a protobuf message with no schema and explain exactly how a method call becomes bytes.*

We've spent the book building toward the application layer, and for service-to-service communication, gRPC is where modern systems land. It answers a question REST-over-JSON answers poorly at scale: *how do services call each other efficiently, with a typed contract, low latency, and streaming?* The answer combines two technologies worth understanding separately and together:

1. **Protocol Buffers (protobuf)** — a binary serialization format that's compact, fast, and schema-driven. This is the *data* — how a structured message becomes bytes. We'll decode its wire format byte-by-byte (varints, ZigZag, field tags) because it's genuinely simple and beautiful once you see it, and because hand-decoding a protobuf is a great "do you actually understand binary protocols" interview signal.
2. **gRPC** — an RPC framework that maps method calls onto HTTP/2 streams, using protobuf for the messages, adding deadlines, metadata, streaming, and the rest. This is the *transport and semantics* — how a function call becomes a network exchange.

We'll cover protobuf's wire format and why it beats JSON, the four gRPC call types, how a call maps onto HTTP/2, the cross-cutting machinery (deadlines, metadata, interceptors, status codes, load balancing), and build a working protobuf encoder/decoder from scratch.

---

## 15.1 Protocol Buffers: The Wire Format

Protobuf is a binary serialization format defined by a **schema** (a `.proto` file) that both sides share. You define your message structure once, and a compiler (`protoc`) generates code to serialize/deserialize it in any language. Here's a schema and a message:

```proto
   // person.proto — the shared schema (the contract)
   message Person {
     string name  = 1;    // field number 1
     int32  age   = 2;    // field number 2
     string email = 3;    // field number 3
   }
```

The numbers (`= 1`, `= 2`, `= 3`) are **field numbers** — and they, not the field *names*, are what's on the wire. This is the first key insight: **protobuf sends field *numbers*, not field names.** JSON sends `{"name":"Alice","age":30}` — the *string* `"name"` is transmitted every time. Protobuf sends field number `1`, a tiny integer. For a message sent millions of times, omitting the field names is a massive saving. (It also means renaming a field in your schema doesn't break the wire format — only changing its *number* does. The field number is the contract; the name is just for your code.)

### The wire format: tag + value

A protobuf message is a flat sequence of `(tag, value)` pairs, one per field present. The **tag** packs two things into a varint: the field number and a 3-bit **wire type** (which tells the parser how to read the value that follows):

```
   Each field on the wire:  [ TAG ][ VALUE ]

   TAG = (field_number << 3) | wire_type      (encoded as a varint, §15.2)
         ┌──────────────────┬──────────────┐
         │  field number    │  wire type    │  ← bottom 3 bits = wire type
         └──────────────────┴──────────────┘

   Wire types (the 3 bits — how to read the value):
     0  VARINT          int32/64, uint, bool, enum  — a variable-length integer
     1  I64 (64-bit)    fixed64, double             — exactly 8 bytes
     2  LEN             string, bytes, sub-messages  — a length prefix, then that many bytes
     5  I32 (32-bit)    fixed32, float              — exactly 4 bytes
     (3, 4 were "groups" — deprecated)
```

So to parse a protobuf message with *no schema*, you can still walk it: read a tag varint, extract the field number and wire type, and the wire type tells you how to read the value (varint, 8 bytes, length-prefixed, or 4 bytes). You won't know the field *names* or *meanings* without the schema, but you can fully parse the *structure* — which is exactly what tools like `protoc --decode_raw` do. This is the "hand-decode a protobuf" skill (§15.6).

### Why protobuf beats JSON (the tradeoffs)

```
   The same Person {name:"Alice", age:30} :

   JSON:      {"name":"Alice","age":30}          → 25 bytes, and the parser must scan
                                                    text, handle quotes/escapes/whitespace
   Protobuf:  0a 05 41 6c 69 63 65 10 1e          → 9 bytes, fixed binary parse
              │  │  └Alice┘  │  └30              (field1=LEN, len5, "Alice"; field2=varint, 30)
              tag len        tag
```

Protobuf's advantages: **smaller** (field numbers not names, binary not text, varints for small integers), **faster to parse** (no text scanning, no string-to-number conversion, fixed binary layout), and **strongly typed via the schema** (you can't accidentally send a string where a number is expected; the contract is enforced). The costs, honestly stated: **not human-readable** (you can't `curl` a gRPC endpoint and read the response, hence `protoc --decode`, grpcurl, and Wireshark dissectors), **requires the schema** (both sides need the `.proto`, and schema management/versioning becomes real work), and **less universal** than JSON (which any browser/tool speaks natively). The tradeoff mirrors HTTP/2 vs HTTP/1.1 (Chapter 13): binary efficiency at the cost of human-readability. For high-volume internal service-to-service traffic, the efficiency wins decisively; for public-facing APIs consumed by browsers and third parties, JSON's universality often still wins. That's the right way to choose: protobuf/gRPC internally, JSON/REST at the edge, frequently.

> **Schema evolution — protobuf's underrated superpower.** Because the wire format keys on field *numbers*, not names or positions, protobuf has excellent forward/backward compatibility *if you follow the rules*: you can *add* new fields (old code ignores unknown field numbers — it skips them using the wire type), and old fields stay readable. The rules: never reuse or change a field number, never change a field's type incompatibly, and use `reserved` to retire numbers you'll never reuse. This lets you evolve a schema across a fleet of services deployed at different versions — a new service can add a field and old services keep working, deploying independently. This independent-deployability is a major reason protobuf dominates in microservices: the schema is a *contract that can evolve* without lockstep deploys. (Contrast positional formats where adding a field breaks everything.)

---

## 15.2 Varints and ZigZag: The Clever Integer Encoding

The detail that makes protobuf compact, and a favorite interview deep-dive. A **varint (variable-length integer)** encodes an integer in as few bytes as possible: small numbers take one byte, large numbers take more. The scheme uses the top bit of each byte as a "continuation" flag:

```
   Varint encoding: each byte holds 7 bits of the number; the top (8th) bit is the
   "continuation" flag — 1 means "more bytes follow," 0 means "this is the last byte."
   Bytes are LITTLE-ENDIAN (least-significant group first).

   Encode 1:    0000 0001                    → 1 byte  (top bit 0 = done)
   Encode 300:  1010 1100  0000 0010          → 2 bytes
                ^cont=1     ^cont=0
                low 7 bits  high bits
                300 = 100101100 in binary → split into 7-bit groups: 0000010 0101100
                → little-endian: 0101100(+cont) 0000010 → 0xAC 0x02
```

The payoff: integers, which dominate real data (IDs, counts, timestamps, enums), are usually small and cost just 1–2 bytes, versus a fixed 4 or 8. A field like `age = 30` is *one byte* on the wire. For messages full of small integers, varints are a big win over fixed-width encoding.

But varints have a problem with *negative* numbers. A negative `int32` like `-1` is, in two's-complement, `0xFFFFFFFF` — all bits set — which a naive varint would encode as the *maximum* length (10 bytes!), because the high bits are all 1s. Negative numbers would be catastrophically large. **ZigZag encoding** fixes this for signed types (`sint32`/`sint64`): it maps signed integers to unsigned ones so that small-magnitude negatives become small unsigned values:

```
   ZigZag: interleave positive and negative numbers so small magnitudes → small values:
        0 → 0      -1 → 1      1 → 2      -2 → 3      2 → 4      -3 → 5  ...
   Formula: zigzag(n) = (n << 1) ^ (n >> 31)   [for 32-bit]
   So -1 encodes as 1 (one byte), not 0xFFFFFFFF (ten bytes). Small negatives stay small.
```

ZigZag "zig-zags" between positive and negative so that numbers near zero (positive *or* negative) all encode small. This is why protobuf has both `int32` (varint, efficient for non-negative) and `sint32` (ZigZag+varint, efficient for values that can be negative) — choosing the right one matters for size, and choosing `int32` for a frequently-negative field is a real (if minor) performance bug. The varint+ZigZag combination is a small, elegant piece of encoding craft that explains a lot of protobuf's compactness, and explaining it cleanly is a strong interview signal.

---

## 15.3 gRPC: RPC over HTTP/2

Now the framework. **gRPC** (Google RPC) makes a remote call look like a local function call: you call `client.GetUser(request)` and it returns a `User`, with the network exchange hidden. Underneath, gRPC maps this onto **HTTP/2** (Chapter 13) using protobuf messages. The mapping is precise and worth knowing:

```
   A gRPC unary call (GetUser) mapped onto HTTP/2:

   The method becomes an HTTP/2 stream with a POST to a path derived from the service:
     :method = POST
     :path   = /user.UserService/GetUser     ← /<package.Service>/<Method>
     content-type = application/grpc+proto
     (custom headers = gRPC METADATA, §15.5)

   Request:  a HEADERS frame (the above) + DATA frame(s) carrying the length-prefixed
             protobuf request message:
             [1-byte compressed-flag][4-byte length][ protobuf-encoded request ]
                    ↑ this 5-byte prefix is gRPC's framing on top of HTTP/2's DATA frames

   Response: HEADERS frame + DATA frame(s) with the length-prefixed protobuf response,
             then a TRAILERS frame (HTTP/2 trailers) carrying the gRPC status:
             grpc-status: 0   (0 = OK; nonzero = error code, §15.5)
             grpc-message: "..."
```

The key mappings:
- **Each gRPC call = one HTTP/2 stream.** Because HTTP/2 multiplexes streams (Chapter 13), many concurrent gRPC calls share one connection without head-of-line blocking (at the HTTP layer) — gRPC inherits HTTP/2's multiplexing for free, which is a big reason it's efficient for chatty service meshes.
- **The method is a POST to a path** of the form `/package.Service/Method`. gRPC always uses POST (the request carries a body — the protobuf message).
- **Messages are length-prefixed** within the HTTP/2 DATA frames (a 1-byte compression flag + 4-byte length + the protobuf bytes) — gRPC's own framing layered on HTTP/2's framing (the framing theme of Chapter 7, one more level up). This length-prefix is what lets gRPC put *multiple* messages on one stream (for streaming, §15.4).
- **Status comes back in HTTP/2 trailers** (`grpc-status`), *after* the response body — clever, because it lets the server stream a response and report final success/failure *at the end*, which is exactly what streaming needs.

So gRPC is, precisely: protobuf messages, length-framed, carried as HTTP/2 DATA frames on a stream per call, with the method in the path and the status in the trailers. Everything you learned about HTTP/2 (Chapter 13) directly applies — and gRPC over HTTP/3/QUIC (Chapter 14) is emerging, inheriting QUIC's per-stream loss recovery for even better behavior on lossy networks.

---

## 15.4 The Four Call Types: Streaming as First-Class

gRPC's HTTP/2 foundation gives it something REST struggles with: **streaming** in both directions, as a first-class feature. Because an HTTP/2 stream is bidirectional and can carry many length-prefixed messages, gRPC supports four call patterns:

```
   1. UNARY:  one request → one response (the classic RPC)
      client ──[req]──► server
      client ◄─[resp]── server
      e.g. GetUser(id) → User

   2. SERVER STREAMING:  one request → a STREAM of responses
      client ──[req]──► server
      client ◄─[resp]◄─[resp]◄─[resp]◄── server   (server sends many, then closes)
      e.g. ListUsers(filter) → stream of User; or a live feed, search results

   3. CLIENT STREAMING:  a STREAM of requests → one response
      client ──[req]─►[req]─►[req]─► server
      client ◄────────[resp]──────── server        (client sends many, server replies once)
      e.g. UploadMetrics(stream of samples) → Summary

   4. BIDIRECTIONAL STREAMING:  streams BOTH ways, independently
      client ──[req]─►[req]──► server
      client ◄─[resp]◄────[resp]── server           (both stream freely, full-duplex)
      e.g. Chat(stream Message) → stream Message; live collaboration
```

This is a genuine capability gap over plain REST/HTTP-1.1 (which is fundamentally one-request-one-response). The streaming maps naturally onto the HTTP/2 stream: each length-prefixed message in the DATA frames is one logical request or response message, so a stream can carry as many as needed in either direction, with `END_STREAM` (Chapter 13) marking completion. Bidirectional streaming over a single multiplexed connection is powerful for real-time systems — chat, live dashboards, collaborative editing — and it's a major reason gRPC is chosen for systems that need more than request/response. (It's a different tool from WebSockets, Chapter 16, with a schema and the gRPC ecosystem attached.)

---

## 15.5 The Cross-Cutting Machinery: Deadlines, Metadata, Interceptors, Status

The features that make gRPC production-grade, each worth knowing:

**Deadlines/timeouts (and why they must propagate).** Every gRPC call carries a **deadline** — "fail this call if it isn't done by time T." This is sent as a header (`grpc-timeout`) and is *crucial* in microservices: without deadlines, a slow downstream service causes calls to pile up upstream, exhausting threads/connections and cascading into a system-wide outage. The vital part is **deadline propagation**: when service A calls B with a 1-second deadline, and B calls C, B should pass the *remaining* deadline to C (not a fresh one) — so the whole call tree respects A's original budget and nothing keeps working on a request whose caller has already given up. Proper deadline propagation is one of the most important practices for microservice reliability, and gRPC builds it in. (A request whose deadline has passed should be *cancelled* all the way down — cancellation propagation — freeing resources across the call tree. Without it, "zombie" work continues on requests no one is waiting for.)

**Metadata (headers).** gRPC calls carry **metadata** — key/value pairs, exactly like HTTP headers (because they *are* HTTP/2 headers, §15.3). This is how you pass auth tokens, trace IDs (distributed tracing — propagating a trace context across the call tree, like deadline propagation but for observability), request IDs, and other cross-cutting context alongside the typed message. Metadata is separate from the protobuf message body — the message is the *typed business data*, metadata is the *cross-cutting context*.

**Interceptors (middleware).** gRPC has **interceptors** — middleware that wraps calls on both client and server, for cross-cutting concerns: authentication, logging, metrics, retries, tracing, rate limiting. An interceptor sees every call and can act before/after it. This is the same middleware pattern as HTTP server frameworks (and the proxies of Chapter 17), letting you implement policy once and apply it to all RPCs rather than scattering it through business logic.

**Status codes.** gRPC has its own set of ~17 **status codes** (distinct from HTTP's), returned in the `grpc-status` trailer: `OK` (0), `NOT_FOUND` (5), `INVALID_ARGUMENT` (3), `DEADLINE_EXCEEDED` (4), `UNAVAILABLE` (14, retryable), `PERMISSION_DENIED` (7), `RESOURCE_EXHAUSTED` (8, rate-limited), etc. Like HTTP's 4xx/5xx split (Chapter 11), these distinguish client errors from server/infrastructure errors and drive retry logic — `UNAVAILABLE` and `DEADLINE_EXCEEDED` are typically retryable (with backoff), `INVALID_ARGUMENT` and `NOT_FOUND` are not. Knowing the retryable-vs-not distinction is essential for resilient clients.

**Client-side load balancing.** A notable architectural choice: because gRPC connections are long-lived and multiplexed (HTTP/2), traditional connection-level load balancers (Chapter 17) don't spread *requests* well — all of one client's requests ride one connection to one backend. So gRPC often does **client-side load balancing**: the client knows all the backend addresses (via service discovery) and spreads *individual RPCs* across them, or uses an L7 proxy (Envoy, Chapter 17) that understands gRPC and load-balances per-request inside the connection. This is a real gotcha when deploying gRPC behind a naive L4 load balancer — it pins each client to one backend, defeating load balancing. (We'll connect this to proxy design in Chapter 17.)

---

## 15.6 Code: A Protobuf Encoder/Decoder from Scratch

Let's encode and decode a protobuf message with no library — proving the wire format is genuinely simple. We'll handle varints, the tag format, and length-delimited strings — enough to round-trip our `Person {name, age, email}`. Portable POSIX; compiles and runs anywhere.

**`protobuf.c`**

```c
/* protobuf.c — encode and decode a protobuf message by hand (no library).
 *   Build:  gcc -Wall -O2 -o protobuf protobuf.c
 *   Run:    ./protobuf
 * Demonstrates: varint encoding, tag = (field<<3)|wiretype, length-delimited fields.
 * Round-trips Person{ name(1)=string, age(2)=varint, email(3)=string }.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* ---- Varint: encode an unsigned integer, 7 bits per byte, high bit = continuation ---- */
static int write_varint(unsigned char *buf, uint64_t v) {
    int n = 0;
    do {
        unsigned char byte = v & 0x7f;     /* low 7 bits */
        v >>= 7;
        if (v) byte |= 0x80;               /* set continuation bit if more remains */
        buf[n++] = byte;
    } while (v);
    return n;                              /* bytes written */
}

static int read_varint(const unsigned char *buf, uint64_t *out) {
    uint64_t v = 0; int shift = 0, n = 0;
    for (;;) {
        unsigned char byte = buf[n++];
        v |= (uint64_t)(byte & 0x7f) << shift;   /* accumulate 7 bits */
        if (!(byte & 0x80)) break;               /* no continuation → done */
        shift += 7;
    }
    *out = v;
    return n;                              /* bytes consumed */
}

/* ---- Write a tag: (field_number << 3) | wire_type ---- */
static int write_tag(unsigned char *buf, int field, int wiretype) {
    return write_varint(buf, ((uint64_t)field << 3) | wiretype);
}

/* ---- Encode a length-delimited (wire type 2) string field ---- */
static int write_string_field(unsigned char *buf, int field, const char *s) {
    int n = write_tag(buf, field, 2);              /* tag */
    int len = (int)strlen(s);
    n += write_varint(buf + n, len);               /* length prefix */
    memcpy(buf + n, s, len); n += len;             /* the bytes */
    return n;
}

/* ---- Encode a varint (wire type 0) field ---- */
static int write_varint_field(unsigned char *buf, int field, uint64_t v) {
    int n = write_tag(buf, field, 0);
    n += write_varint(buf + n, v);
    return n;
}

int main(void) {
    /* ---- ENCODE Person{ name="Alice", age=30, email="alice@example.com" } ---- */
    unsigned char buf[256];
    int n = 0;
    n += write_string_field(buf + n, 1, "Alice");
    n += write_varint_field(buf + n, 2, 30);
    n += write_string_field(buf + n, 3, "alice@example.com");

    printf("Encoded %d bytes: ", n);
    for (int i = 0; i < n; i++) printf("%02x ", buf[i]);
    printf("\n\n");

    /* ---- DECODE it back, knowing only the wire format (not the field names) ---- */
    printf("Decoding:\n");
    int pos = 0;
    while (pos < n) {
        uint64_t tag;
        pos += read_varint(buf + pos, &tag);
        int field    = tag >> 3;        /* top bits = field number */
        int wiretype = tag & 0x07;      /* bottom 3 bits = wire type */

        if (wiretype == 0) {            /* VARINT */
            uint64_t v;
            pos += read_varint(buf + pos, &v);
            printf("  field %d (varint): %llu\n", field, (unsigned long long)v);
        } else if (wiretype == 2) {     /* LEN-delimited (string/bytes/submessage) */
            uint64_t len;
            pos += read_varint(buf + pos, &len);
            printf("  field %d (string, %llu bytes): \"%.*s\"\n",
                   field, (unsigned long long)len, (int)len, buf + pos);
            pos += len;
        } else {
            printf("  field %d (wire type %d): [skipped]\n", field, wiretype);
            break;
        }
    }
    return 0;
}
```

Run it:

```
Encoded 28 bytes: 0a 05 41 6c 69 63 65 10 1e 1a 11 61 6c 69 63 65 40 65 78 61 6d 70 6c 65 2e 63 6f 6d

Decoding:
  field 1 (varint): ... → actually field 1 (string, 5 bytes): "Alice"
  field 2 (varint): 30
  field 3 (string, 17 bytes): "alice@example.com"
```

Read the bytes against the format: `0a` is the tag for field 1, wire type 2 (`(1<<3)|2 = 0x0a`); `05` is the length; `41 6c 69 63 65` is "Alice". Then `10` is field 2, wire type 0 (`(2<<3)|0 = 0x10`); `1e` is varint 30. Then `1a` is field 3, wire type 2; `11` is length 17; then "alice@example.com". **You just decoded a protobuf message knowing only the wire format, not the schema** — exactly what `protoc --decode_raw` does, and exactly the skill that proves you understand the format. Notice the decoder didn't know the field *names* (`name`, `age`, `email`) — only the numbers and types — because those names live in the `.proto` schema, not on the wire. That's the whole point: the schema is shared out-of-band; the wire carries only numbers and values.

> **From here to real gRPC:** this codec is the *heart* of protobuf — varints, tags, length-delimited fields. Real protobuf adds the other wire types (fixed32/64 for floats/doubles, ZigZag for sint), nested messages (a LEN field whose bytes are themselves a protobuf message — recursion), repeated fields (packed varints), and the `protoc`-generated typed accessors. And real gRPC wraps each message in the 5-byte length prefix (§15.3) and carries it in HTTP/2 DATA frames (Chapter 13) with the method in the `:path` and status in trailers. But the foundation — *fields are (number, wiretype, value) triples, integers are varints, strings are length-prefixed* — is exactly what's above. You could extend this codec to handle nested messages (recurse into the LEN payload) and you'd have a meaningful chunk of a real protobuf parser.

---

## Key Takeaways

1. **gRPC is a precise stack of things this book already built: Protocol Buffers (serialization) + HTTP/2 (transport, Ch. 13) + a thin RPC layer.** It makes a remote call look like a local function call, with a typed schema, generated code, streaming, and production machinery (deadlines, metadata, interceptors).

2. **Protobuf sends field *numbers*, not names** — `{"name":"Alice"}` (JSON, name repeated every time) becomes field `1` + value. Combined with binary encoding and varints, it's much smaller and faster to parse than JSON, and strongly typed via the shared `.proto` schema. Costs: not human-readable (need `protoc --decode`/grpcurl), requires schema sharing, less universal than JSON. Use gRPC/protobuf internally, JSON/REST at the edge, often.

3. **The protobuf wire format is a flat sequence of (tag, value) pairs**, where `tag = (field_number << 3) | wire_type`. The 3-bit wire type (VARINT, I64, LEN, I32) tells the parser how to read the value — so you can parse the *structure* of any protobuf with no schema (just not the field names/meanings). This is the "hand-decode a protobuf" skill.

4. **Varints encode integers in 7 bits/byte with a continuation bit, so small numbers (the common case — IDs, counts, enums) cost 1–2 bytes** instead of fixed 4/8. **ZigZag** maps signed ints so small-magnitude negatives stay small (`-1` → 1 byte, not 10) — which is why `sint32` exists alongside `int32`.

5. **Protobuf's schema evolution is a superpower** because it keys on field *numbers*: you can add fields (old code skips unknown numbers via the wire type) and deploy services at different versions independently — a major reason it dominates microservices. The rules: never reuse/change a field number, use `reserved` to retire numbers.

6. **gRPC maps each call to one HTTP/2 stream:** method in the `:path` (`/package.Service/Method`), a POST, length-prefixed protobuf messages in DATA frames (gRPC's framing over HTTP/2's framing), and the `grpc-status` in HTTP/2 *trailers* (after the body — enabling streaming). It inherits HTTP/2 multiplexing (many concurrent calls, one connection) for free.

7. **Four call types — unary, server-streaming, client-streaming, bidirectional** — give gRPC first-class streaming that plain REST lacks, mapping naturally onto bidirectional HTTP/2 streams. Powerful for real-time/feed/upload patterns.

8. **The production machinery matters as much as the wire format:** deadlines (with *propagation* down the call tree — critical for preventing cascading failures), metadata (auth/trace context, = HTTP/2 headers), interceptors (middleware for cross-cutting concerns), gRPC status codes (with a retryable-vs-not distinction like HTTP's 4xx/5xx), and **client-side load balancing** (because long-lived multiplexed connections defeat naive L4 load balancers — a real deployment gotcha, Chapter 17).

---

## Interview Drills

**Q1. What is gRPC, concretely, in terms of protocols you already know?**
*Model answer:* gRPC is an RPC framework that makes a remote call look like a local function call, built on a precise combination of protocols. The data is serialized with Protocol Buffers — a compact binary format defined by a shared `.proto` schema. The transport is HTTP/2 (Chapter 13): each gRPC call becomes one HTTP/2 stream, with the method encoded in the `:path` as `/package.Service/Method`, the request and response sent as length-prefixed protobuf messages inside HTTP/2 DATA frames, and the final status (`grpc-status`) returned in HTTP/2 trailers after the body. On top of this it adds an RPC layer: generated client/server code from the schema, four call types (unary and three streaming forms), deadlines, metadata (which are just HTTP/2 headers), interceptors (middleware), and its own status codes. So nothing about gRPC is magic — it's protobuf for the messages, HTTP/2 for multiplexed transport, and a thin convenience-and-policy layer on top. It inherits HTTP/2's multiplexing (many concurrent calls over one connection without HTTP-layer head-of-line blocking) for free, which is a big reason it's efficient for chatty microservice communication.

**Q2. Decode this protobuf or explain how you'd decode one with no schema.**
*Model answer:* A protobuf message is a flat sequence of (tag, value) pairs. To decode without a schema, I walk it: read a varint *tag*, then split it — the bottom 3 bits are the *wire type* and the rest is the *field number* (`field = tag >> 3`, `wiretype = tag & 7`). The wire type tells me how to read the value: type 0 (VARINT) means read a variable-length integer (7 bits per byte, top bit is a continuation flag); type 2 (LEN) means read a varint length then that many bytes (a string, bytes, or nested message); type 1 (I64) is exactly 8 bytes; type 5 (I32) is exactly 4 bytes. So I can fully parse the *structure* — which fields are present, their numbers, and their raw values — without the schema. What I *can't* recover without the `.proto` is the field *names* and *meanings* (is field 2 an age or a count?) and whether a LEN field is a string or a nested message, because those live in the schema, not on the wire. That's exactly what `protoc --decode_raw` does. For example, bytes `0a 05 41 6c 69 63 65` decode as: tag `0x0a` → field 1, wire type 2 (length-delimited); length `0x05` = 5; then 5 bytes `41 6c 69 63 65` = "Alice". The key realization is that protobuf transmits field numbers, not names — which is why it's compact and why decoding gives you numbers without names.

**Q3. Why is protobuf more compact than JSON, and what does it give up?**
*Model answer:* Three reasons it's smaller and faster. First, it sends field *numbers* instead of names — JSON transmits the string "name" on every message, protobuf sends the integer 1, so for messages sent millions of times the field-name overhead vanishes. Second, it's binary, not text, so there's no quotes, braces, whitespace, or string-to-number conversion — the parser reads fixed binary layouts at known offsets instead of scanning and tokenizing text. Third, integers use varint encoding, so small numbers (the common case — IDs, counts, enums, timestamps) take 1–2 bytes instead of a fixed 4 or 8, or instead of a multi-character decimal string in JSON. It's also strongly typed via the shared schema, so the contract is enforced and you can't accidentally send the wrong type. What it gives up: human-readability (you can't curl a gRPC endpoint and eyeball the response — you need tools like `protoc --decode` or grpcurl), the requirement that both sides share the `.proto` schema (so schema management and versioning become real work), and universality (JSON is natively understood by every browser and tool; protobuf needs generated code). The tradeoff mirrors HTTP/2 vs HTTP/1.1 — binary efficiency versus human-readability — so the common pattern is protobuf/gRPC for high-volume internal service-to-service traffic and JSON/REST for public-facing APIs consumed by browsers and third parties.

**Q4. Explain varint and ZigZag encoding.**
*Model answer:* A varint encodes an unsigned integer in a variable number of bytes, using 7 bits of each byte for the value and the top bit as a continuation flag: if the high bit is set, more bytes follow; if clear, it's the last byte. Bytes are little-endian (least-significant group first). So the number 1 is one byte (0x01), and 300 is two bytes. The benefit is that small integers — which dominate real data like IDs, counts, and enums — cost just 1–2 bytes instead of a fixed 4 or 8. The problem is negative numbers: a negative int32 like -1 is, in two's-complement, all 1-bits (0xFFFFFFFF), which a naive varint would encode in the maximum length (10 bytes) because the high bits are set — so negatives would be huge. ZigZag encoding fixes this for signed types: it maps signed integers to unsigned ones by interleaving positive and negative values around zero — 0→0, -1→1, 1→2, -2→3, 2→4 — using the formula `(n << 1) ^ (n >> 31)` for 32-bit. This way small-magnitude numbers, positive or negative, all encode to small unsigned values, so -1 becomes 1 (one byte) instead of ten. That's why protobuf offers both `int32` (plain varint, efficient when values are usually non-negative) and `sint32` (ZigZag then varint, efficient when values are often negative) — and choosing `int32` for a frequently-negative field is a real if minor size bug.

**Q5. What are gRPC deadlines and why is deadline propagation important?**
*Model answer:* A deadline is a per-call limit — "fail this call if it isn't complete by time T" — sent as a `grpc-timeout` header. Deadlines are essential in microservices because without them, a slow or hung downstream service causes calls to pile up upstream, exhausting threads, connections, and memory, and cascading into a system-wide outage; the deadline bounds how long anyone waits and frees resources when the budget is blown. Deadline *propagation* is the critical practice: when service A calls B with a 1-second deadline and B then calls C, B should pass the *remaining* time budget to C — not start a fresh 1-second deadline — so the entire call tree respects A's original budget. Without propagation, downstream services keep working on a request long after the original caller has already timed out and given up, wasting resources on results no one will use ("zombie" work). gRPC builds deadline propagation in, and ideally pairs it with cancellation propagation: when a deadline passes or a caller cancels, the cancellation flows down the call tree so every service stops working on that request and releases its resources. Proper deadline and cancellation propagation is one of the most important practices for preventing cascading failures and resource exhaustion in a microservice architecture.

**Q6. You deployed gRPC behind a load balancer and one backend is getting all the traffic. Why?**
*Model answer:* Because gRPC uses long-lived, multiplexed HTTP/2 connections, and a naive L4 (connection-level) load balancer distributes *connections*, not *requests*. When a gRPC client opens one HTTP/2 connection to the load balancer, the L4 balancer pins that whole connection to a single backend, and then *all* of that client's multiplexed requests ride that one connection to that one backend — so the load balancing happens once, at connect time, and every subsequent RPC goes to the same place. With few long-lived clients, traffic concentrates on whichever backends those connections landed on, defeating the load balancer. There are two standard fixes. One is client-side load balancing: the gRPC client learns all backend addresses via service discovery and spreads individual RPCs across them itself (opening connections to multiple backends), so balancing happens per-request. The other is to use an L7 proxy that understands HTTP/2 and gRPC — like Envoy (Chapter 17) — which can load-balance *individual streams/requests* within a connection across backends, rather than pinning the whole connection. So the rule is: don't put gRPC behind a plain L4/connection-level load balancer expecting per-request distribution; use client-side LB or an L7/gRPC-aware proxy. This is a common and surprising production gotcha precisely because it works fine in testing (few connections) and skews badly at scale.

---

*Previous: [Chapter 14 — HTTP/3 and QUIC](./14-http-3-and-quic.md) | Next: [Chapter 16 — WebSockets and Realtime](./16-websockets-and-realtime.md)*
