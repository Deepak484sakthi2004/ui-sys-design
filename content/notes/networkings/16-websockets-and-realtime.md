# Chapter 16 — WebSockets and Realtime

> *HTTP, in every version we've studied, is fundamentally **client-initiated**: the client asks, the server answers. That model built the web, but it has a glaring gap — the server can never speak first. It can't push you a chat message, a stock tick, a "your ride is here," or a collaborator's keystroke without you asking. For thirty years the web faked server-push with ugly hacks (constant polling, hanging requests), until WebSockets gave us a real bidirectional channel. This chapter is about the realtime toolkit — WebSockets, Server-Sent Events, and the decision framework for choosing among them — and the thing that quietly breaks realtime systems more than anything else: backpressure.*

Everything up to now assumed request/response. But a huge class of applications needs the *server* to initiate: live chat, notifications, multiplayer games, collaborative editors (Google Docs), live dashboards, trading platforms, "someone is typing..." indicators. The request/response model can't naturally express "the server has news for you." This chapter covers how the web grew real server-push: first the hacks (so you understand what they cost), then **WebSockets** (a true bidirectional channel via an HTTP upgrade), then **Server-Sent Events** (a simpler, HTTP-native, server-to-client stream), and finally a clear-eyed *decision framework* — because the most common realtime mistake isn't a protocol bug, it's choosing the wrong tool, or forgetting backpressure. It's a shorter, mid-tier chapter, but the decision framework and backpressure section are the high-value parts you'll actually use.

---

## 16.1 The Problem: HTTP Can't Push

In classic HTTP, a connection is opened by the client, carries one request and one response, and that's the interaction (Chapter 11). The server is purely reactive — it cannot send data to the client unless the client asked. So how did the early web do things like chat and notifications? With workarounds, each a different way of *faking* server-push, and each worth knowing because they illuminate what WebSockets fixed:

```
   Faking server-push before WebSockets:

   1. SHORT POLLING: the client asks "anything new?" every N seconds, forever.
      client: GET /messages → [] → (wait 3s) → GET /messages → [] → (wait 3s) → ...
      • Simple, works everywhere. But: huge waste (most polls return nothing),
        latency up to N seconds (news waits for the next poll), and load scales with
        clients × poll-frequency — thousands of clients hammering "anything new?".

   2. LONG POLLING: the client asks, and the server HOLDS the request open until it
      has news (or a timeout), then responds; the client immediately re-asks.
      client: GET /messages → ...(server holds)... → [new msg!] → GET /messages → ...
      • Near-realtime (news delivered as soon as it exists), less wasteful than short
        polling. But: a held-open request per client (connection/thread cost), and each
        message still pays a full HTTP request/response cycle. A clever hack, not a channel.
```

These work and are still used (long polling is a robust fallback), but they're *workarounds* — they bend request/response to *simulate* a push channel, paying in latency, wasted requests, or held connections. What you actually want is a *real* bidirectional, persistent channel where either side can send a message at any time, cheaply. That's WebSockets.

---

## 16.2 WebSockets: A Real Bidirectional Channel

**WebSocket** (RFC 6455) gives you exactly that: a persistent, full-duplex (both directions, simultaneously) connection between client and server over a single TCP connection, where either side can send messages at any time with minimal overhead. The clever part is how it *starts* — it doesn't invent a new port or protocol; it **upgrades** an existing HTTP connection:

```
   The WebSocket upgrade handshake (starts as HTTP, becomes WebSocket):

   CLIENT                                          SERVER
   ── HTTP GET with Upgrade headers ──────────►
      GET /chat HTTP/1.1
      Host: example.com
      Upgrade: websocket                            ← "let's switch protocols"
      Connection: Upgrade
      Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==   ← a random nonce
      Sec-WebSocket-Version: 13
                                  ◄── 101 Switching Protocols ──────────
                                      HTTP/1.1 101 Switching Protocols
                                      Upgrade: websocket
                                      Connection: Upgrade
                                      Sec-WebSocket-Accept: s3pPLMBi...  ← hash of the key
   ══════════ now it's a WebSocket: bidirectional frames, either side sends anytime ══════════
   client ──[frame]──► server        server ──[frame]──► client        (full-duplex!)
```

The handshake is genuinely elegant: it begins as a normal HTTP/1.1 GET with `Upgrade: websocket` headers. The server, if it supports WebSocket, responds `101 Switching Protocols`, and from that point the *same TCP connection* stops speaking HTTP and starts speaking the WebSocket framing protocol. The `Sec-WebSocket-Key`/`Accept` exchange (the server hashes the client's key with a fixed magic string and returns it) proves the server actually understood the WebSocket handshake (not just any server echoing headers) — a simple anti-confusion check, not security. Why upgrade from HTTP instead of using a fresh protocol/port? Because it reuses port 80/443, passes through firewalls and proxies that allow HTTP, and works with existing HTTP infrastructure (including TLS — `wss://` is WebSocket over TLS, just like `https`). It's a pragmatic piece of design: ride HTTP's ubiquity to bootstrap, then become something else.

### The WebSocket frame and mandatory masking

After the upgrade, data flows as **frames** (not HTTP messages). The frame format is compact, with one quirk worth understanding:

```
   WebSocket frame (simplified):
   ┌─┬─┬─┬─┬───────┬─┬─────────────┬───────────────┬──────────────┐
   │F│R│R│R│ opcode│M│ Payload len │  Masking-key   │   Payload     │
   │I│S│S│S│ (4b)  │A│  (7/16/64b) │  (0 or 4 bytes)│   (masked)    │
   │N│V│V│V│       │SK│             │                │               │
   └─┴─┴─┴─┴───────┴─┴─────────────┴───────────────┴──────────────┘
   • FIN: is this the final frame of a message? (messages can span multiple frames)
   • opcode: 0x1=text, 0x2=binary, 0x8=close, 0x9=ping, 0xA=pong
   • MASK: is the payload masked? (MANDATORY for client→server, see below)
   • Payload len: small numbers in 7 bits; larger extend to 16 or 64 bits
```

The notable feature: **client-to-server frames MUST be masked** — the client XORs the payload with a random 4-byte key (sent in the frame). This is *not* for confidentiality (the key is right there in the frame; use TLS for confidentiality). It exists to defend *proxies and middleboxes*: without masking, an attacker could craft WebSocket payloads that, to a confused intermediary proxy, *look like* a valid HTTP request, tricking the proxy into cache-poisoning or request-smuggling attacks. Masking randomizes the bytes so attacker-controlled content can't be made to resemble a meaningful HTTP request to a middlebox. It's a defense born from the reality of Chapter 2's middleboxes — the same ossification/interference world that shaped QUIC. (Server-to-client frames are *not* masked, because the server isn't the untrusted party in this threat model.)

WebSocket also has built-in **ping/pong** frames (opcodes 0x9/0xA) for keepalive and liveness detection — either side can ping, the other must pong, letting you detect a dead connection (and keep NATs/proxies from timing out an idle connection, the NAT-mapping-expiry issue from Chapter 5). This matters because a persistent connection that's secretly dead (the peer crashed, the network dropped) looks identical to an idle one until you try to use it — ping/pong surfaces the death.

> **WebSockets and HTTP/2: an awkward fit worth knowing.** WebSocket was designed for HTTP/1.1's connection model (take over the whole connection). Over HTTP/2 (Chapter 13), where one connection is multiplexed into many streams, "take over the connection" doesn't fit — so there's a separate mechanism (RFC 8441's extended CONNECT) to run WebSocket over a single HTTP/2 stream. It works but is less commonly deployed. This mismatch — a protocol designed to commandeer a connection meeting a protocol designed to multiplex one — is a small example of how layering assumptions ripple: WebSocket assumed "one connection = one thing," which HTTP/2 broke.

---

## 16.3 Server-Sent Events: The Simpler Half

WebSockets are full-duplex (both directions). But a *lot* of realtime needs are **one-directional**: the server pushes updates to the client, and the client doesn't need to push back over the same channel (it can use normal HTTP requests for its actions). Live scores, news feeds, notifications, progress updates, a stock ticker, server logs streaming to a dashboard — these are server→client only. For these, WebSockets are *overkill*, and **Server-Sent Events (SSE)** is the simpler, better fit.

SSE is beautifully minimal: it's just a normal HTTP response that *never ends*. The client makes an ordinary GET request, and the server responds with `Content-Type: text/event-stream` and then *keeps the response open*, sending events as plain text whenever it has news:

```
   SSE — an HTTP response that streams forever:

   client: GET /events HTTP/1.1
           Accept: text/event-stream
   server: HTTP/1.1 200 OK
           Content-Type: text/event-stream
           (connection stays open; server writes events as they happen)

           data: {"price": 100}\n\n          ← event 1 (each event ends with blank line)
           data: {"price": 101}\n\n          ← event 2 (sent later, same connection)
           id: 42\n                          ← optional event ID (for resumption)
           event: alert\n                    ← optional named event type
           data: {"msg": "halt"}\n\n
```

SSE's advantages over WebSockets, when you only need server→client:
- **It's just HTTP.** No upgrade, no new framing protocol, no special server support — it's a long-lived HTTP response with a specific content type (the chunked-streaming idea from Chapter 11, formalized as an event format). It works through all HTTP infrastructure, proxies, and HTTP/2 trivially (unlike WebSocket's HTTP/2 awkwardness).
- **Automatic reconnection, built in.** If the connection drops, the browser's `EventSource` API *automatically reconnects* and — using the `Last-Event-ID` header (from the `id:` fields) — can tell the server where it left off, so the server resumes the stream. You get reconnection-with-resumption *for free*; with WebSockets you build it yourself.
- **Dead simple.** A few lines of server code (write events to an open response) and one line of client code (`new EventSource('/events')`).

Its limits: **one-directional** (server→client only — the client uses separate HTTP requests for its actions), **text-only** (UTF-8 events; no binary frames — though you can base64), and historically a per-domain connection limit over HTTP/1.1 (mitigated by HTTP/2 multiplexing). For the very common case of "server pushes updates, client occasionally acts via normal requests," SSE is simpler and more robust than WebSockets — and it's underused precisely because WebSockets get all the attention.

---

## 16.4 The Decision Framework

The most valuable thing in this chapter: *which realtime tool do you actually choose?* The mistake engineers make is reaching for WebSockets reflexively (it's the famous one) when a simpler option fits better. Here's the decision logic:

```
   Choosing a realtime transport — match the tool to the communication shape:

   Do you need the SERVER to push to the client at all?
   ├─ NO → just use normal HTTP request/response (or polling for infrequent checks).
   │       Don't add realtime complexity you don't need.
   │
   └─ YES → does the CLIENT need to push to the server over the SAME channel,
            frequently / with low latency / bidirectionally?
            │
            ├─ NO (server→client is the main flow; client acts via normal requests)
            │   → SERVER-SENT EVENTS (SSE). Simpler, HTTP-native, free reconnection.
            │     e.g. notifications, live feeds, dashboards, progress, AI token streaming
            │
            └─ YES (true bidirectional, low-latency both ways)
                → WEBSOCKETS.
                  e.g. chat, multiplayer games, collaborative editing, live trading
                │
                └─ Is it a typed RPC/service-to-service streaming need (not browser)?
                    → consider gRPC bidirectional streaming (Ch.15) instead — schema,
                      deadlines, and the gRPC ecosystem, over HTTP/2.

   Also consider: is the data REAL-TIME-CRITICAL where late = useless (games, voice)?
   → those often want UDP/WebRTC (Ch.6) under the hood, not TCP-based WS/SSE, to avoid
     head-of-line blocking on loss. WebRTC for peer-to-peer media; WS for everything else.
```

The framework in words:
- **Don't need server push?** Use plain HTTP. The cheapest realtime is no realtime.
- **Server→client only** (the common case — feeds, notifications, dashboards, *streaming LLM tokens* which is a huge modern SSE use case)? **SSE** — simpler, HTTP-native, free reconnection. Default here unless you need bidirectional.
- **True bidirectional, low-latency both ways** (chat, games, collaboration)? **WebSockets.**
- **Service-to-service typed streaming** (not browser)? **gRPC streaming** (Chapter 15) — you get the schema and ecosystem.
- **Latency-critical media where late data is useless** (live voice/video, fast games)? **WebRTC/UDP** (Chapter 6) — because TCP-based WS/SSE suffer head-of-line blocking on loss, and for media you'd rather drop than wait (the exact Chapter 6 lesson — freshness over completeness).

The meta-point: these aren't competitors so much as different shapes. Match the tool to the *communication pattern* — directionality, latency-sensitivity, browser-vs-service, and whether late data is useful. Reaching for WebSockets when SSE fits is over-engineering (you take on connection management and reconnection logic you didn't need); reaching for SSE when you need bidirectional is under-engineering. Knowing the framework is knowing when each is right.

> **In the wild — the LLM streaming example.** When ChatGPT or any LLM app streams tokens to your browser one word at a time, that's almost always **SSE**, not WebSockets — because it's purely server→client (the server streams the generated tokens; your prompt was a normal POST), so SSE's simplicity and free reconnection are exactly right. It's the canonical modern SSE use case, and a great illustration of "server→client streaming → SSE, not WebSockets." If you've wondered how the typing-out effect works, it's an `text/event-stream` response with one `data:` event per token chunk.

---

## 16.5 Backpressure: The Thing That Breaks Realtime Systems

The most important *operational* concept for realtime systems, and the one most often gotten wrong. Recall **backpressure** from Chapter 10 (§10.1): the socket send buffer fills when you write faster than the network drains, and eventually `write()` blocks or fails — the network's slowness propagating back to force the producer to slow down. In request/response systems this is mostly handled for you. In *persistent push* systems, it becomes your problem, and ignoring it crashes servers.

The scenario: a server pushing data over a WebSocket or SSE connection to a client that *can't keep up* — a slow mobile connection, a client whose tab is throttled in the background, a client that's just slow. The server generates events faster than the client consumes them. What happens to the un-sent data?

```
   The backpressure failure mode:

   Server generates events at 1000/sec ──► WebSocket/SSE connection ──► SLOW client (10/sec)
                                                    │
                                          un-sent events pile up...
                                                    │
   If the server naively "just sends" each event without checking whether the previous
   ones drained:
     • the kernel send buffer fills (Ch.10) → write() would block or buffer
     • a naive server BUFFERS the backlog in application memory, unbounded
     • memory grows... and grows... with every slow client...
     → OUT OF MEMORY. One slow client (or thousands) crashes the server.
```

A server pushing to many persistent connections *must* handle the case where a client can't keep up, or a slow client becomes a memory leak that takes down the server. The strategies, each a real design choice:
- **Apply backpressure to the source:** slow down or pause generating events for that connection when its send buffer is full (check writability — the `EPOLLOUT`/drained signal from Chapter 10). For a data stream you control (e.g. streaming a query result), pause reading from the source until the client catches up. This propagates the slowness back to where the data originates — the *correct* default when every event matters.
- **Drop / shed:** for data where stale is worthless (live positions, latest price — the Chapter 6 freshness principle), *drop* old events for a slow client and send only the latest. Better to skip than to buffer unboundedly. (e.g. a live dashboard sends the *current* value, not a backlog of every value the slow client missed.)
- **Bound the buffer and disconnect:** cap per-connection buffering; if a client exceeds it, disconnect them (they're too slow to serve). Protects the server at the cost of dropping the slow client.
- **Coalesce/conflate:** merge pending updates (if three "price changed" events are queued for a slow client, collapse to one with the latest price).

The unifying principle, which is *the* realtime systems lesson: **a persistent push connection is a place where a fast producer meets a potentially slow consumer, and you must decide — explicitly — what happens to the backlog.** Buffer it (bounded!), drop it, conflate it, or backpressure the source — but never "just keep sending and let memory grow," which is the naive default that works in testing (fast localhost clients) and falls over in production (real slow clients at scale). This is the same backpressure that governs Kafka consumers, reactive streams, and the socket buffers of Chapter 10 — and in realtime systems it's not a nice-to-have, it's the difference between a server that survives slow clients and one that OOMs. Whenever you build a push system, the first question after "which transport" should be "what's my backpressure strategy."

---

## Key Takeaways

1. **HTTP is fundamentally client-initiated — the server can't push** — so realtime web was long faked with short polling (waste + latency) and long polling (held-open requests). These work but are workarounds that bend request/response to simulate a channel.

2. **WebSockets give a real persistent, full-duplex channel** by *upgrading* an HTTP/1.1 connection (`Upgrade: websocket` → `101 Switching Protocols`), then speaking a compact frame protocol where either side sends anytime. Upgrading from HTTP rides its ubiquity (ports 80/443, firewall/proxy/TLS compatibility). Client→server frames are *mandatorily masked* — not for secrecy but to stop middleboxes from being tricked into seeing WebSocket payloads as HTTP requests (a Chapter 2 middlebox defense). Built-in ping/pong detects dead connections and keeps NAT mappings alive.

3. **Server-Sent Events (SSE) is the simpler half — server→client only — and it's just a never-ending HTTP response** (`text/event-stream`). Advantages over WebSockets when you don't need bidirectional: pure HTTP (works everywhere, including HTTP/2 cleanly), *automatic reconnection with resumption* (`Last-Event-ID`) for free, and trivial implementation. It's underused; streaming LLM tokens is its canonical modern use case.

4. **Choose the realtime tool by communication shape:** no server push → plain HTTP; server→client only → **SSE** (default for feeds/notifications/dashboards/token streaming); true bidirectional low-latency → **WebSockets** (chat/games/collaboration); typed service-to-service streaming → **gRPC streaming** (Ch. 15); latency-critical media where late=useless → **WebRTC/UDP** (Ch. 6). Reflexively reaching for WebSockets when SSE fits is over-engineering.

5. **Backpressure is what breaks realtime systems.** A persistent push connection is where a fast producer meets a possibly-slow consumer; you *must* decide explicitly what happens to the backlog — backpressure the source (pause generating, the correct default when every event matters), drop/shed stale events (Ch. 6 freshness principle), bound-and-disconnect, or coalesce. Never "just keep sending and let memory grow" — that works in testing and OOMs in production when real slow clients pile up. It's the same backpressure as Chapter 10's socket buffers and Kafka consumers.

---

## Interview Drills

**Q1. HTTP can't push from server to client. How did the web do realtime before WebSockets, and what were the costs?**
*Model answer:* With two polling-based workarounds. Short polling has the client repeatedly ask "anything new?" on a fixed interval — simple and universal, but wasteful (most polls return nothing), latency-bound (news waits up to one interval to be delivered), and load scales with clients times poll frequency, so thousands of clients constantly hammer the server with empty checks. Long polling improves this: the client asks, but the server *holds the request open* until it actually has news (or a timeout), then responds, and the client immediately re-asks. That's near-realtime (news is delivered as soon as it exists) and far less wasteful, but it still costs a held-open request (connection/thread) per client and pays a full HTTP request/response cycle per message. Both are workarounds that bend the request/response model to *simulate* server push — they don't give you a real channel. What you actually want is a persistent, low-overhead channel where either side can send anytime, which is what WebSockets provide (and SSE provides for the server→client direction). Long polling survives as a robust fallback when WebSockets/SSE aren't available.

**Q2. How does a WebSocket connection get established, and why does it start as HTTP?**
*Model answer:* It starts as a normal HTTP/1.1 GET request carrying upgrade headers: `Upgrade: websocket`, `Connection: Upgrade`, a random `Sec-WebSocket-Key`, and a version. If the server supports WebSocket, it responds `101 Switching Protocols` with a `Sec-WebSocket-Accept` header containing a hash of the client's key with a fixed magic string — which proves the server genuinely understood the WebSocket handshake rather than just echoing headers. After that response, the *same TCP connection* stops speaking HTTP and starts speaking the WebSocket frame protocol, full-duplex, with either side sending frames anytime. It starts as HTTP for pragmatic reasons: it reuses ports 80/443 so it traverses firewalls and proxies that permit HTTP, it works with existing HTTP infrastructure and TLS (`wss://` is WebSocket over TLS just like HTTPS), and it avoids needing a brand-new port or protocol that middleboxes might block. So the design rides HTTP's ubiquity to bootstrap the connection, then sheds HTTP to become a lightweight bidirectional channel. One wrinkle: this "take over the connection" model fits HTTP/1.1 but not HTTP/2's multiplexing, so running WebSocket over HTTP/2 needs a separate mechanism (extended CONNECT) and is less common.

**Q3. WebSocket requires client-to-server frames to be masked. Why, given it's not for confidentiality?**
*Model answer:* It's a defense against middlebox attacks, not a confidentiality measure — the masking key is sent right there in the frame, so it provides no secrecy (use TLS/`wss://` for that). The threat is that WebSocket traffic passes through proxies and other intermediaries that were built to understand HTTP. Without masking, an attacker controlling the content of WebSocket payloads could craft bytes that, to a confused intermediary, *look like* a legitimate HTTP request — enabling cache poisoning or request smuggling against that proxy. Masking XORs the client's payload with a random per-frame key, so attacker-controlled content is randomized on the wire and can't be reliably shaped to resemble a meaningful HTTP request to a middlebox. Only client→server frames are masked because the client is the untrusted party that an attacker might control (e.g. via malicious JavaScript); server→client frames aren't masked since the server isn't the threat in this model. It's a defense born directly from the reality of HTTP-aware middleboxes — the same middlebox-interference world that drove QUIC to encrypt its transport.

**Q4. When would you choose Server-Sent Events over WebSockets?**
*Model answer:* When the communication is server→client only — the server pushes updates and the client doesn't need to push back over the same channel (it can use normal HTTP requests for its own actions). That covers a large set of realtime needs: notifications, live feeds and scores, dashboards, progress updates, and streaming LLM tokens (the canonical modern example — ChatGPT-style token-by-token output is SSE). For these, SSE is simpler and more robust than WebSockets: it's just a long-lived HTTP response with `Content-Type: text/event-stream`, so it works through all HTTP infrastructure including HTTP/2 cleanly (no upgrade, no new framing, no special handling), and the browser's EventSource API gives you *automatic reconnection with resumption* for free — on a dropped connection it reconnects and uses the Last-Event-ID header to tell the server where to resume, which with WebSockets you'd have to build yourself. WebSockets are the right call only when you genuinely need *bidirectional* low-latency communication over the same channel — chat, multiplayer games, collaborative editing, live trading. Reaching for WebSockets when SSE fits is over-engineering: you take on connection management, reconnection logic, and framing complexity you didn't need. The rule is match the tool to the communication shape: one-directional server push → SSE; true bidirectional → WebSockets.

**Q5. You build a WebSocket server pushing live data. Under load it crashes with out-of-memory. What likely went wrong?**
*Model answer:* Almost certainly a backpressure failure with slow clients. A persistent push connection is a place where a fast producer (your server generating events) meets a potentially slow consumer (a client on a bad mobile connection, a backgrounded/throttled tab, or just a slow client). If the server naively sends every event without checking whether prior events have actually drained to the client, the un-sent events back up: the kernel send buffer fills, and a naive server then buffers the growing backlog in application memory — unbounded. With one slow client that's a leak; with thousands at scale, memory grows until the server OOMs and crashes. The fix is an explicit backpressure strategy. Options: backpressure the source — pause or slow event generation for a connection when its send buffer is full (check writability via the EPOLLOUT/drained signal), propagating the slowness back to the data source (the right default when every event matters); drop/shed — for data where stale is worthless (live positions, latest price), send only the latest and discard the backlog (the freshness-over-completeness principle); bound and disconnect — cap per-connection buffering and drop clients that exceed it; or coalesce — merge queued updates into one latest value. The cardinal sin is "just keep sending and let memory grow," which works in testing with fast localhost clients and fails in production. The first design question for any push system, after choosing the transport, must be the backpressure strategy.

**Q6. A client needs the server to push updates AND needs to send frequent low-latency messages back. Which transport, and what if it's latency-critical media?**
*Model answer:* For frequent low-latency communication in *both* directions over the same channel, WebSockets — that's exactly the bidirectional, full-duplex case they're built for (chat, multiplayer games, collaborative editing). SSE wouldn't fit because it's server→client only; long polling wouldn't fit because each client message would pay a full request cycle. If it's a service-to-service (non-browser) need with a typed contract, I'd consider gRPC bidirectional streaming instead (Chapter 15) to get the schema, deadlines, and ecosystem. But there's an important exception: if it's *latency-critical real-time media* — live voice/video, or a fast-twitch game where a late update is useless — then TCP-based transports (WebSockets and SSE both ride TCP) are the wrong choice, because TCP's in-order delivery causes head-of-line blocking on packet loss: a lost packet stalls everything behind it while it's retransmitted, and by the time the retransmission arrives the moment has passed. For media you'd rather drop a lost packet than wait for it (freshness over completeness, Chapter 6), so you want UDP-based transport — typically WebRTC, which runs media over UDP with its own loss handling and is designed for peer-to-peer real-time audio/video. So: bidirectional app messaging → WebSockets; typed service streaming → gRPC; real-time media where late equals useless → WebRTC/UDP. Match the transport to whether late data is still useful.

---

*Previous: [Chapter 15 — gRPC and Protocol Buffers](./15-grpc-and-protobuf.md) | Next: [Chapter 17 — Load Balancing and Proxies](./17-load-balancing-and-proxies.md)*
