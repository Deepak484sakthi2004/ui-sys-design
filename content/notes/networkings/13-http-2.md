# Chapter 13 — HTTP/2

> *HTTP/1.1 conquered the world by being simple, human-readable text. HTTP/2 kept every bit of HTTP's **semantics** — the same methods, status codes, headers, and request/response model from Chapter 11 — and threw away its **wire format** entirely, replacing readable text with a binary, multiplexed, compressed protocol. The result solved HTTP/1.1's central performance wall (head-of-line blocking, Chapter 11) and made the web meaningfully faster. But in solving one head-of-line-blocking problem, it exposed a deeper one hiding in TCP itself — and that exposure is the entire reason HTTP/3 and QUIC exist (Chapter 14). This chapter is that story.*

By the end of Chapter 11 we had a clear villain: HTTP/1.1's **head-of-line blocking**. One connection could carry one request/response at a time (pipelining having failed), so a slow response blocked everything behind it, and browsers resorted to opening ~6 parallel connections per origin — wasteful, with 6× the handshakes, slow-starts, and connection state. HTTP/2 (RFC 9113, originally RFC 7540, derived from Google's SPDY) was designed to fix exactly this, and its core idea is **multiplexing**: many concurrent request/response exchanges interleaved over a *single* TCP connection, in any order, none blocking the others.

To do that, HTTP/2 had to stop being text. You cannot interleave text streams that have no internal structure — you need *frames* with stream identifiers so the receiver can sort interleaved pieces back into their respective requests. So HTTP/2 is **binary-framed**: every message is chopped into typed frames, each tagged with a stream ID, and the frames of many streams flow concurrently over one connection. This chapter covers the frame format, streams and multiplexing, HPACK header compression, flow control and priority, the rise and fall of server push, and — crucially — the *one* head-of-line problem HTTP/2 *couldn't* solve, because it lives below HTTP, in TCP. Understanding that residual problem is understanding why the next chapter had to rebuild the transport layer.

---

## 13.1 The Core Idea: Keep the Semantics, Replace the Wire

The single most important framing (pun intended) for HTTP/2 is this: **it is the same HTTP, with a different envelope.** Everything you learned in Chapter 11 — `GET`/`POST`, `200`/`404`, `Content-Type`, `Host`, cookies, caching, the request/response model — is *unchanged*. An HTTP/2 request is still semantically "GET /index.html with these headers"; a response is still "200 OK with this body." What changed is purely *how those bytes are represented and transmitted on the wire*:

```
   HTTP/1.1:  human-readable TEXT, one exchange per connection at a time
   ┌──────────────────────────────────┐
   │ GET /index.html HTTP/1.1\r\n      │   ← you can read it; you can type it by hand
   │ Host: example.com\r\n             │
   │ \r\n                              │
   └──────────────────────────────────┘

   HTTP/2:  BINARY frames, many exchanges interleaved on ONE connection
   ┌─────────┬─────────┬─────────┬─────────┬─────────┐
   │HEADERS  │ DATA    │HEADERS  │ DATA    │ DATA    │   ← binary frames, each tagged
   │stream 1 │stream 3 │stream 5 │stream 1 │stream 3 │     with a STREAM ID so the
   └─────────┴─────────┴─────────┴─────────┴─────────┘     receiver can demultiplex them
     request    request   request   response  response
     (req 1)    (req 3)   (req 5)   (to 1)    (to 3)
        ▲ three requests and two responses, all in flight at once, interleaved
```

Why force this change? Because **multiplexing requires structure**. To interleave many requests on one connection, the receiver must be able to take an arbitrary sequence of arriving bytes and sort them back into "these bytes belong to request 1, those to request 3." Plain text has no such structure — `GET /a` and `GET /b` interleaved would be unparseable mush. Binary framing adds the structure: every chunk is a self-describing *frame* with a length, a type, and a **stream identifier** that says which logical exchange it belongs to. The binary format also happens to be more efficient to parse (fixed-offset fields, no text scanning) and less error-prone (no ambiguity about line endings or whitespace — eliminating the request-smuggling attacks that plague HTTP/1.1's text parsing). The cost is human-readability — you can no longer `telnet` to an HTTP/2 server and type a request — which is why tools like `nghttp`, `curl --http2 -v`, and Wireshark's HTTP/2 dissector matter (§13.6).

> **The design philosophy worth absorbing:** HTTP/2 is a masterclass in *separating an interface from its implementation*. The HTTP semantics (the interface applications and developers see) stayed completely stable, so the entire web ecosystem — every framework, every app — kept working with zero changes. Only the wire encoding (the implementation) was swapped out underneath. This is why HTTP/2 deployment was largely *invisible* to developers: you enabled it on your server or CDN and your existing app got faster without code changes. Preserving the semantic interface while replacing the wire is *also* exactly what HTTP/3 does again (Chapter 14) — same HTTP semantics, yet another new wire format (over QUIC). The lesson: a stable semantic interface lets you revolutionize the implementation beneath it without breaking the world. It's the layering principle of Chapter 2, applied to evolve HTTP itself.

---

## 13.2 The Frame Format

Everything in HTTP/2 is a **frame** — a small, typed, length-prefixed binary message. The frame is the atom of the protocol, and its 9-byte header is worth knowing:

```
   HTTP/2 frame:
   ┌─────────────────────────────────────────────────────────────┐
   │  Length (24 bits)          │ Type (8) │ Flags (8)            │  ← 9-byte header
   ├────┬────────────────────────────────────────────────────────┤
   │ R  │            Stream Identifier (31 bits)                  │  ← which stream!
   ├────┴────────────────────────────────────────────────────────┤
   │                     Frame Payload (Length bytes)              │
   └─────────────────────────────────────────────────────────────┘

   • Length: payload size (so the receiver knows where this frame ends — framing!)
   • Type:   what kind of frame (see below)
   • Flags:  type-specific bits (e.g. END_STREAM, END_HEADERS)
   • Stream ID: which logical request/response this frame belongs to (0 = connection-wide)
```

Notice the **Length** field — it's the explicit framing (Chapter 7's recurring theme) that lets the receiver chop the byte stream back into discrete frames, and the **Stream Identifier** is the demultiplexing key that lets it route each frame to the right logical exchange. Those two fields *are* multiplexing.

The frame **types** (there are ten; the important ones):

```
   Type            Purpose
   ────────────    ───────────────────────────────────────────────────────────
   HEADERS         carries the (HPACK-compressed) request/response headers — starts a stream
   DATA            carries the message body (request payload or response content)
   SETTINGS        connection-level configuration (window sizes, max streams, etc.)
   WINDOW_UPDATE   flow control — "I can receive N more bytes" (§13.4)
   RST_STREAM      cancel a single stream (without killing the whole connection)
   PRIORITY        hint about a stream's relative importance (§13.4)
   PUSH_PROMISE    server push — "I'm going to send you this resource unasked" (§13.5)
   PING            liveness / RTT measurement
   GOAWAY          graceful connection shutdown ("finish current streams, no new ones")
   CONTINUATION    header block continuation when headers exceed one frame
```

A request, in HTTP/2 terms, is a `HEADERS` frame (the method, path, and headers) optionally followed by `DATA` frames (the body), all sharing one stream ID, with the last frame carrying an `END_STREAM` flag. A response is the same shape coming back. So "an HTTP request" decomposes into "a HEADERS frame plus DATA frames on a stream" — and *that's* what gets interleaved with other streams' frames on the wire.

---

## 13.3 Streams and Multiplexing: Killing HTTP-Layer HOL Blocking

Now the payoff. A **stream** is an independent, bidirectional sequence of frames within the connection, identified by a stream ID — and it corresponds to exactly one request/response exchange. The single TCP connection carries *many* concurrent streams, their frames interleaved, and the stream ID on each frame lets the receiver reassemble each stream's frames independently:

```
   HTTP/1.1: one connection, requests serialized — HOL blocking at the HTTP layer
   ──────────────────────────────────────────────────────────────────
   conn:  [── req A (SLOW) ──────────────][── req B ──][── req C ──]
                      ▲ B and C wait for slow A to finish. Blocked.

   HTTP/2: one connection, streams multiplexed — no HTTP-layer HOL blocking
   ──────────────────────────────────────────────────────────────────
   conn:  [A][B][C][A][C][B][A][C][B][A]...   ← frames of A, B, C interleaved
              ▲ B and C make progress WHILE A is still going. A slow A doesn't
                block B and C — each stream advances independently. SOLVED.
```

This is the headline achievement. In HTTP/1.1, a slow request (A) blocked the requests behind it (B, C) because the connection handled one exchange at a time. In HTTP/2, A, B, and C are separate streams whose frames interleave; a slow A merely means A's frames are sparse, while B's and C's frames flow freely — **the slow response no longer blocks the others.** Stream IDs make this work: each arriving frame is routed to its stream by ID, so the receiver reassembles A, B, and C concurrently from the interleaved flow.

The consequences ripple out:
- **One connection replaces six.** Because a single HTTP/2 connection multiplexes unlimited concurrent requests, browsers no longer open ~6 parallel connections per origin. One connection per origin, kept warm (past slow start, Chapter 8), serving everything. This eliminates the redundant handshakes, redundant slow-starts, and redundant TLS sessions of the HTTP/1.1 workaround — and reduces server connection load dramatically.
- **The single warm connection compounds with everything from earlier chapters:** one TCP handshake (Ch. 7), one TLS handshake (Ch. 12), one congestion window that grows large and *stays* warm (Ch. 8 — no repeated slow-starts), all amortized across hundreds of requests. The performance gains of HTTP/2 are substantially "stop paying connection-setup costs over and over."
- **Request prioritization becomes possible** (§13.4) — since everything shares one connection, the protocol can express "send the CSS before the images" via stream priorities.

> **The crucial caveat, stated now and dissected in §13.7:** HTTP/2 eliminates head-of-line blocking *at the HTTP layer* — no stream blocks another stream *in HTTP's view*. But all those streams still ride on a *single TCP connection*, and TCP delivers a strictly-ordered byte stream (Chapter 7). So if a TCP segment is *lost*, TCP holds back *all* subsequent bytes — of *every* stream — until the lost segment is retransmitted, because TCP doesn't know or care that those bytes belong to independent HTTP streams. HTTP/2 solved HOL blocking at its own layer but inherited a *worse* HOL blocking from the layer below. We'll return to this; it's the hinge to Chapter 14.

---

## 13.4 HPACK, Flow Control, and Priority

Three supporting mechanisms make multiplexing practical:

**HPACK header compression.** HTTP headers are verbose and *repetitive* — every request to a site resends nearly identical headers (the same `User-Agent`, `Accept`, `Cookie`, `Host` on request after request). In HTTP/1.1 these were sent in full, uncompressed, every time — and cookies alone can be kilobytes (Chapter 11). With HTTP/2 multiplexing hundreds of requests over one connection, that repetition becomes a major cost. **HPACK** (RFC 7541) compresses headers using:

```
   HPACK compression — three techniques combined:
   1. STATIC TABLE: a predefined table of ~61 common header name/value pairs
      (":method: GET", ":status: 200", "accept-encoding: gzip,deflate", ...).
      Instead of the full text, send a 1-byte INDEX into this table.
   2. DYNAMIC TABLE: headers seen earlier on THIS connection are added to a per-
      connection table; later requests referencing them send just an index. So the
      second request's repeated headers cost a few bytes instead of hundreds.
   3. HUFFMAN CODING: literal header strings that must be sent are Huffman-encoded.

   Result: the headers of the 2nd+ request on a connection often compress from
   hundreds of bytes to a handful — because they're mostly "same as before, see index N."
```

HPACK is stateful per connection: both sides maintain synchronized static and dynamic tables, so a header sent once can be referenced by index forever after. This makes per-request headers nearly free, which matters enormously when you're sending hundreds of requests (each with the same fat cookie and user-agent) over one connection. (HPACK's statefulness becomes a *problem* for HTTP/3, because QUIC's out-of-order streams can't have a strictly-ordered shared table — which is why HTTP/3 needs QPACK, a redesigned variant. Chapter 14.)

**Flow control (per-stream and connection-level).** With many streams sharing one connection, you need to prevent one fast stream from starving others or overflowing buffers. HTTP/2 has its *own* flow control (separate from TCP's, Chapter 7) using `WINDOW_UPDATE` frames — each stream has a flow-control window *and* there's a connection-level window. A receiver advertises how much it's willing to buffer per stream and overall, and senders respect both. This is application-layer flow control layered on top of TCP's transport-layer flow control — necessary because TCP's single window can't distinguish the multiplexed streams. (It's the sliding-window idea of Chapter 7, replicated at the HTTP layer for per-stream fairness.)

**Stream priority and dependencies.** Since everything shares one connection, HTTP/2 lets the client express *relative importance*: "the CSS and JS are critical (render-blocking) — send them before the below-the-fold images." This was done via a `PRIORITY` mechanism (a dependency tree with weights). In practice, the original priority scheme was **complex and poorly implemented** by both browsers and servers, often ignored or done wrong, and RFC 9113 deprecated it in favor of a simpler scheme (`Extensible Prioritization`, a priority *header*). The *idea* — prioritize critical resources over non-critical ones on the shared connection — is sound and important for page-load performance; the original *mechanism* was over-engineered. A theme of HTTP/2's evolution: great core ideas, a couple of over-ambitious features that didn't survive contact with reality (priority, and even more so, push — §13.5).

---

## 13.5 Server Push: A Good Idea That Didn't Work

**Server push** is the HTTP/2 feature most worth understanding *as a cautionary tale*, because it teaches something about protocol design. The idea: when a browser requests `index.html`, the server *knows* the browser will next need `style.css` and `app.js` (they're referenced in the HTML). So why wait for the browser to parse the HTML, discover the references, and send separate requests (a round trip each)? The server could *proactively push* those resources *before being asked*, using `PUSH_PROMISE` frames — saving round trips:

```
   Server push (the idea):
   Browser: GET /index.html
   Server:  here's index.html  +  PUSH_PROMISE: I'm also sending you style.css and app.js
            (browser gets all three without separately requesting css/js — saves 2 RTTs)
```

It sounds great. It failed, and was **deprecated and removed** from major browsers (Chrome dropped it in 2022). The reasons are instructive:
- **The server often pushes what the browser already has cached.** The server can't easily know the browser's cache state, so it wastes bandwidth pushing resources the browser would've served from cache — *negative* benefit, actively slower.
- **It's hard to push the *right* things at the *right* time.** Push too much and you delay the critical HTML by clogging the connection with resources; push too little and you didn't help. Getting it right requires knowledge the server doesn't have.
- **It competes with the HTML for bandwidth/flow-control window**, sometimes *slowing* the very page it's trying to speed up.
- **It was complex to implement correctly** and rarely delivered net wins in practice.

The replacement is **`103 Early Hints`** + **preload hints** (`<link rel=preload>` / the `Link` header): instead of *pushing* the resource (guessing the cache state), the server *tells the browser early* "you'll want style.css and app.js — go request them now if you don't have them." The browser, which *knows* its own cache, decides whether to fetch. This keeps the round-trip-saving benefit (the browser learns about the resources early) while letting the party with the cache knowledge (the browser) make the decision. **It's a better factoring of the same goal:** hint, don't push; let the cache-owner decide.

> **The protocol-design lesson:** server push violated a subtle principle — *don't make decisions on behalf of a party that has information you lack.* The server tried to decide what to send without knowing the browser's cache, and got it wrong often enough to be net-negative. Early Hints fixes the factoring: the server shares what it knows (the dependencies) and the browser decides using what *it* knows (its cache). This is a recurring lesson in distributed systems — push the decision to where the relevant state lives. Server push is a great example of a feature that was *intuitively* appealing, *technically* impressive, and *practically* wrong, and it's worth knowing precisely because the intuition is so seductive.

---

## 13.6 Code: An HTTP/2 Frame Parser

Let's make the binary protocol concrete by parsing HTTP/2 frames. HTTP/2 (over TLS) begins with a fixed connection preface, then everything is frames. This parser reads the 9-byte frame headers and identifies the frame types — enough to *see* the multiplexing (multiple stream IDs interleaved). It's portable POSIX. To get real HTTP/2 frames to parse, we read them from a file captured via `curl --http2`; we focus on the frame-decoding logic that is the heart of any HTTP/2 implementation.

**`h2_frames.c`**

```c
/* h2_frames.c — parse a stream of HTTP/2 frames and print their headers.
 *   Build:  gcc -Wall -O2 -o h2_frames h2_frames.c
 *   Capture frames to parse (the cleartext h2c case, or decrypt via SSLKEYLOGFILE):
 *     # This reads raw HTTP/2 frame bytes from stdin (after the 24-byte preface).
 *   Demo:  ./h2_frames  < captured_h2_frames.bin
 *
 * The point is the frame-decoding logic: a 9-byte header (length, type, flags,
 * stream id) followed by a payload — repeated. Stream IDs reveal multiplexing.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static const char *frame_type_name(uint8_t t) {
    switch (t) {
        case 0x0: return "DATA";
        case 0x1: return "HEADERS";
        case 0x2: return "PRIORITY";
        case 0x3: return "RST_STREAM";
        case 0x4: return "SETTINGS";
        case 0x5: return "PUSH_PROMISE";
        case 0x6: return "PING";
        case 0x7: return "GOAWAY";
        case 0x8: return "WINDOW_UPDATE";
        case 0x9: return "CONTINUATION";
        default:  return "UNKNOWN";
    }
}

/* The HTTP/2 connection preface that every client sends first (RFC 9113). */
static const char PREFACE[] = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

int main(void) {
    unsigned char buf[65536];

    /* Read everything from stdin into buf (the captured frame stream). */
    size_t total = 0;
    ssize_t r;
    while ((r = read(0, buf + total, sizeof buf - total)) > 0) total += r;

    size_t pos = 0;
    /* Skip the 24-byte connection preface if present. */
    if (total >= 24 && memcmp(buf, PREFACE, 24) == 0) {
        printf("[connection preface]\n");
        pos = 24;
    }

    /* Walk the frames: each is a 9-byte header + Length-byte payload. */
    while (pos + 9 <= total) {
        /* Length is a 24-bit big-endian integer. */
        uint32_t len = (buf[pos] << 16) | (buf[pos+1] << 8) | buf[pos+2];
        uint8_t  type  = buf[pos+3];
        uint8_t  flags = buf[pos+4];
        /* Stream ID is 31 bits (top bit reserved). */
        uint32_t sid = ((buf[pos+5] & 0x7f) << 24) | (buf[pos+6] << 16)
                     | (buf[pos+7] << 8) | buf[pos+8];

        printf("frame: type=%-13s stream=%-3u len=%-5u flags=0x%02x%s%s\n",
               frame_type_name(type), sid, len, flags,
               (flags & 0x1) ? " END_STREAM" : "",     /* DATA/HEADERS END_STREAM bit */
               (type==0x1 && (flags & 0x4)) ? " END_HEADERS" : "");

        pos += 9 + len;   /* advance past this frame's header + payload */
    }
    return 0;
}
```

Conceptual output (parsing a captured HTTP/2 session fetching a page with several resources):

```
[connection preface]
frame: type=SETTINGS      stream=0   len=18    flags=0x00              ← connection setup (stream 0)
frame: type=HEADERS       stream=1   len=32    flags=0x05 END_STREAM END_HEADERS  ← request for /
frame: type=HEADERS       stream=3   len=28    flags=0x05 END_STREAM END_HEADERS  ← request for /style.css
frame: type=HEADERS       stream=5   len=30    flags=0x05 END_STREAM END_HEADERS  ← request for /app.js
frame: type=HEADERS       stream=1   len=40    flags=0x04 END_HEADERS  ← RESPONSE headers for /
frame: type=DATA          stream=1   len=1024  flags=0x00              ← response body for / (chunk)
frame: type=DATA          stream=3   len=512   flags=0x00              ← response body for /style.css
frame: type=DATA          stream=1   len=1024  flags=0x01 END_STREAM   ← more of /'s body, done
frame: type=DATA          stream=5   len=800   flags=0x01 END_STREAM   ← /app.js body, done
frame: type=DATA          stream=3   len=256   flags=0x01 END_STREAM   ← rest of /style.css, done
```

Read the multiplexing right off the output: three requests (streams 1, 3, 5) sent back-to-back without waiting, and their responses' DATA frames **interleaved** — stream 1's body, then stream 3's, then more of stream 1, then stream 5's — all flowing concurrently over one connection. *That interleaving is the thing HTTP/1.1 could not do.* Stream 0 carries connection-level frames (SETTINGS). The `END_STREAM` flag marks each stream's completion. You're seeing, in the stream IDs, the exact mechanism that killed HTTP-layer head-of-line blocking. (Note we parse frame *headers*; decoding the HPACK-compressed HEADERS payloads requires implementing HPACK's table state — a substantial addition, which is why real tooling like `nghttp -v` exists.)

---

## 13.7 The Residual Problem: TCP Head-of-Line Blocking

Now the most important conceptual point in the chapter, the one that motivates everything in Chapter 14. HTTP/2 multiplexing is brilliant, but it has a flaw it *cannot fix from where it sits*, and the flaw is in the layer below.

Recall: all those independent HTTP/2 streams ride on a **single TCP connection**, and TCP provides a strictly-ordered byte stream (Chapter 7). TCP delivers bytes to the application *in order* — if byte N is lost, TCP holds back bytes N+1, N+2, ... until N is retransmitted and arrives, even if those later bytes are sitting in the receive buffer ready to go. TCP does this because *it has no idea the bytes belong to independent streams* — to TCP, it's all one undifferentiated byte stream. So:

```
   HTTP/2 over TCP, when a packet carrying stream 1's data is LOST:

   Wire (one TCP connection):  [s1][s3][s5][s1][s3][s5][s1]...
                                          ▲ this segment (stream 1) is LOST

   TCP receive buffer has: ...s3, s5 data that arrived AFTER the lost segment...
   But TCP MUST deliver bytes in order, so it HOLDS BACK everything after the gap —
   INCLUDING stream 3's and stream 5's data — until the lost stream-1 segment is
   retransmitted (one whole RTT later).

   Result: a packet loss affecting ONE stream stalls ALL streams. The independent
   streams aren't independent at the TCP layer — they share one ordered byte pipe.
```

This is **TCP head-of-line blocking**, and it's the cruel irony of HTTP/2: it eliminated HOL blocking *at the HTTP layer* (no stream blocks another stream in HTTP's logic) but the streams still share *one TCP byte stream*, so a single lost packet stalls *every* multiplexed stream while TCP recovers it. And it can be **worse than HTTP/1.1** under packet loss: HTTP/1.1's 6 parallel connections were 6 *independent* TCP streams, so a loss on one connection only stalled that connection's requests, leaving the other 5 flowing. HTTP/2's single connection means a loss stalls *everything*. On a clean network HTTP/2 wins big; on a lossy network (mobile, congested Wi-Fi), HTTP/2's single connection can underperform HTTP/1.1's parallel connections — the exact opposite of the intent.

HTTP/2 *cannot* fix this, because the problem is TCP's in-order delivery, and HTTP/2 is *built on* TCP — it can't change how TCP delivers bytes. The streams are independent in HTTP's model but TCP flattens them into one ordered pipe beneath HTTP's feet. **The only way to fix it is to make the *transport* aware of streams — to have a transport that can deliver stream 3's bytes while stream 1's lost bytes are still being recovered.** That requires a new transport, where streams are first-class and loss recovery is per-stream. That transport is **QUIC**, and HTTP-over-QUIC is HTTP/3 — the entire subject of the next chapter. HTTP/2 pushed multiplexing as far as it could go *over TCP*; QUIC is what you build when you realize TCP itself is the remaining bottleneck.

> **The clean statement to carry to Chapter 14:** HTTP/2 moved head-of-line blocking *down* the stack — from the HTTP layer (where it solved it) to the TCP layer (where it couldn't). The streams are logically independent but physically share TCP's single ordered byte stream, so any packet loss blocks all of them. Fixing this requires a transport with independent per-stream delivery — and since TCP can't be changed (it's ossified in kernels and middleboxes, Chapter 2) and a brand-new transport protocol would be filtered by those middleboxes, the answer is to build the new transport *on top of UDP* (Chapter 6's blank canvas) where streams are first-class. That's QUIC. HTTP/2's residual flaw is QUIC's reason for existing.

---

## Key Takeaways

1. **HTTP/2 keeps all of HTTP's semantics (methods, status codes, headers, request/response) and replaces only the wire format** — text becomes binary frames. This stable-interface/new-implementation split (the Chapter 2 layering principle applied to HTTP) made deployment invisible to developers: enable it, get faster, change no code.

2. **Everything is a binary frame** — a 9-byte header (length, type, flags, **stream ID**) plus payload. The Length field is the framing (Ch. 7 again) and the Stream ID is the demux key; together they *are* multiplexing. Key frame types: HEADERS (starts a request/response), DATA (body), SETTINGS, WINDOW_UPDATE (flow control), PUSH_PROMISE, GOAWAY.

3. **Multiplexing — many concurrent streams interleaved on one connection, each frame tagged by stream ID — kills HTTP/1.1's head-of-line blocking at the HTTP layer.** A slow response no longer blocks others; its frames are just sparse while others flow. One warm connection replaces the ~6 parallel connections HTTP/1.1 needed, amortizing one TCP handshake, one TLS handshake, and one ever-growing congestion window across hundreds of requests.

4. **HPACK compresses the repetitive headers** that multiplexing would otherwise resend constantly: a static table of common headers, a per-connection dynamic table of headers seen before (referenced by index), and Huffman coding. The 2nd+ request's headers shrink from hundreds of bytes to a handful ("same as before, index N"). Its statefulness later forces HTTP/3's QPACK redesign.

5. **HTTP/2 adds its own per-stream and connection-level flow control** (WINDOW_UPDATE frames) on top of TCP's, because TCP's single window can't distinguish multiplexed streams. **Stream priority** (prioritize critical CSS/JS over images) was a sound idea with an over-engineered original mechanism that RFC 9113 deprecated for a simpler header-based scheme.

6. **Server push failed and was removed** — a cautionary tale. The server pushed resources without knowing the browser's cache, often wasting bandwidth on already-cached resources and competing with the critical HTML. The replacement, **103 Early Hints / preload**, fixes the factoring: the server *hints* what's needed and the browser (which knows its cache) decides. Lesson: don't make decisions for a party whose state you lack — push the decision to where the relevant state lives.

7. **HTTP/2's unfixable flaw: TCP head-of-line blocking.** The independent HTTP streams still share one TCP connection, and TCP's strict in-order delivery means a single lost packet stalls *all* streams (TCP can't tell they're independent). This can make HTTP/2 *worse* than HTTP/1.1's parallel connections under packet loss. HTTP/2 can't fix it (it's built on TCP); fixing it requires a stream-aware transport — **QUIC** — which is why HTTP/3 exists (Chapter 14).

---

## Interview Drills

**Q1. What problem does HTTP/2 solve, and what's the core mechanism?**
*Model answer:* It solves HTTP/1.1's head-of-line blocking. In HTTP/1.1, a connection handles one request/response at a time (pipelining failed because responses had to be ordered), so a slow response blocks everything behind it, and browsers worked around this by opening ~6 parallel connections per origin — wasteful in handshakes, slow-starts, and connection state. HTTP/2's core mechanism is multiplexing: it splits each request and response into binary *frames*, each tagged with a *stream ID*, and interleaves the frames of many streams over a single TCP connection. The receiver uses the stream IDs to reassemble each exchange independently, so a slow response just produces sparse frames while other streams' frames keep flowing — no stream blocks another. To enable this, HTTP/2 had to abandon HTTP/1.1's plain text (which has no structure to interleave) for a binary framed format. Critically, it kept all of HTTP's *semantics* (methods, status codes, headers) identical — only the wire encoding changed — so existing applications got faster with no code changes. The win is one warm connection replacing six, amortizing one TCP handshake, one TLS handshake, and one large congestion window across hundreds of requests.

**Q2. HTTP/2 eliminated head-of-line blocking. Is that completely true?**
*Model answer:* Only at the HTTP layer — and that incompleteness is the whole reason HTTP/3 exists. HTTP/2 eliminates HOL blocking *in HTTP's model*: no stream blocks another stream logically, because their frames interleave and the receiver demultiplexes by stream ID. But all those streams ride on a *single TCP connection*, and TCP delivers a strictly ordered byte stream — if one packet is lost, TCP holds back all bytes after the gap until the lost packet is retransmitted, because TCP has no idea those bytes belong to independent HTTP streams; to TCP it's one undifferentiated byte pipe. So a single packet loss stalls *every* multiplexed stream while TCP recovers — TCP-level head-of-line blocking. This can make HTTP/2 *worse* than HTTP/1.1 on lossy networks: HTTP/1.1's six parallel connections were independent TCP streams, so a loss on one stalled only that connection, leaving five flowing, whereas HTTP/2's single connection means one loss stalls all streams. HTTP/2 can't fix this because it's built on TCP and can't change TCP's in-order delivery. The fix requires a stream-aware transport with per-stream loss recovery — QUIC — which is exactly what HTTP/3 runs on. So HTTP/2 moved HOL blocking from the HTTP layer (solved) down to the TCP layer (unsolvable from where HTTP/2 sits).

**Q3. Why does HTTP/2 need HPACK header compression?**
*Model answer:* Because HTTP headers are verbose and extremely repetitive, and HTTP/2's multiplexing makes that repetition expensive. Every request to a site resends nearly identical headers — the same User-Agent, Accept, Host, and especially cookies, which can be kilobytes. In HTTP/1.1 these went uncompressed in full on every request. With HTTP/2 sending hundreds of requests over one connection, resending those fat repeated headers each time would be a major and pointless cost. HPACK compresses them three ways: a static table of ~61 common header name/value pairs that can be referenced by a one-byte index instead of full text; a per-connection dynamic table that adds headers seen earlier so later requests reference them by index ("same Cookie as request 1, index N"); and Huffman coding for any literal strings that must be sent. The result is that the second and subsequent requests' headers compress from hundreds of bytes to a handful, mostly "same as before, see index." HPACK is stateful — both sides maintain synchronized tables — which is elegant over TCP's ordered stream but becomes a problem over QUIC's out-of-order streams, forcing HTTP/3 to design QPACK, a variant that tolerates out-of-order delivery.

**Q4. Tell me about HTTP/2 server push and why it's no longer used.**
*Model answer:* Server push let a server proactively send resources the client hadn't asked for yet — e.g. when you request index.html, the server pushes style.css and app.js too (via PUSH_PROMISE frames), reasoning that the browser will need them and this saves the round trips of the browser parsing the HTML, discovering the references, and requesting them separately. It sounds great but failed in practice and was deprecated and removed (Chrome dropped it in 2022) for several reasons: the server can't easily know the browser's cache state, so it often pushed resources the browser already had cached — wasting bandwidth and actively slowing things down; pushing the right things at the right time is hard, and pushing too much delayed the critical HTML by competing for the connection's bandwidth and flow-control window; and it was complex to implement correctly while rarely delivering a net win. The replacement is 103 Early Hints plus preload hints: instead of pushing the resource blindly, the server *tells* the browser early "you'll want these resources," and the browser — which knows its own cache — decides whether to fetch them. That's a better factoring: the server shares what it knows (dependencies), and the decision is made where the relevant state (the cache) lives. The lesson is a general one — don't make decisions on behalf of a party whose information you lack.

**Q5. Why did HTTP/2 switch from text to binary, and what was the cost?**
*Model answer:* Because multiplexing requires structure that plain text doesn't have. To interleave many concurrent requests over one connection, the receiver must be able to take an arbitrary sequence of arriving bytes and sort them back into "these belong to request 1, those to request 3" — which is impossible with HTTP/1.1's unstructured text (two text requests interleaved are unparseable mush). Binary framing adds that structure: every chunk is a self-describing frame with a length, a type, and a stream ID, so frames from different streams can interleave and be demultiplexed by ID. The binary format is also faster to parse (fixed-offset fields instead of text scanning) and less ambiguous — it eliminates the whitespace/line-ending ambiguities that enable HTTP/1.1 request-smuggling attacks. The cost is human-readability: you can no longer telnet to a server and type an HTTP/2 request by hand, or read a capture with the naked eye, so you need tools like nghttp, `curl --http2 -v`, or Wireshark's dissector to inspect traffic. It's a deliberate trade — give up the debuggability-by-eye that made HTTP/1.1 beloved, in exchange for the structure that multiplexing and efficiency require. Notably, HTTP/2 kept the *semantics* textual-friendly (same methods, headers) so only the wire representation became binary.

**Q6. If HTTP/2 uses a single connection, how does it avoid one request starving the others, and how does it know to send important resources first?**
*Model answer:* Two mechanisms: flow control and prioritization. For starvation, HTTP/2 has its own flow control, separate from TCP's, using WINDOW_UPDATE frames — each stream has a flow-control window and there's also a connection-level window, so a receiver can bound how much any single stream (and the connection overall) buffers, preventing one fast stream from overwhelming buffers or crowding out others. This is necessary because TCP's single flow-control window can't distinguish the multiplexed streams — it sees one byte pipe — so HTTP/2 replicates the sliding-window idea at the application layer for per-stream fairness. For importance, HTTP/2 lets the client express priority — telling the server that render-blocking resources like CSS and JS should be sent before below-the-fold images, since they all share one connection. The original priority mechanism was a dependency tree with weights that proved over-complex and was inconsistently implemented, so RFC 9113 deprecated it in favor of a simpler priority-header scheme. The underlying goal — prioritize critical resources on the shared connection to speed up page rendering — is sound and important; only the original mechanism was over-engineered. It's a recurring HTTP/2 theme: excellent core ideas (multiplexing, HPACK) alongside a couple of over-ambitious features (priority, server push) that didn't survive real-world use.

---

*Previous: [Chapter 12 — TLS and HTTPS](./12-tls-and-https.md) | Next: [Chapter 14 — HTTP/3 and QUIC](./14-http-3-and-quic.md)*
