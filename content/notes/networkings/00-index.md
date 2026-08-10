# How Networks Actually Work

### Building the Internet Stack from Scratch — From Copper to gRPC

---

## About This Book

Almost every engineer "knows" networking the way most people know how an engine works: turn the key, it goes. You call `fetch()`, bytes appear. You bind a socket, clients connect. You add a load balancer, throughput goes up. The abstractions are so good that you can ship production systems for a decade without ever knowing what a `TIME_WAIT` socket costs you, why your p99 latency has a suspicious 40ms cliff (hello, delayed ACK meeting Nagle's algorithm), or why HTTP/2 made some things faster and one specific thing — packet loss — dramatically worse.

This book is written for the engineer who is tired of that. It is an internal, build-it-from-scratch reference whose thesis is simple: **you do not understand a protocol until you can parse its bytes off the wire and re-implement it.** So that is what we do. We start with a voltage on a copper pair and we do not stop until we have hand-decoded a protobuf message inside an HTTP/2 frame inside a TLS record inside a TCP segment inside an IP packet inside an Ethernet frame — the same nesting doll your `grpc` call becomes the instant you press enter.

Three commitments shape every chapter:

1. **Mechanism over vocabulary.** Anyone can tell you TCP is "reliable." This book shows you the sequence-number arithmetic, the retransmission timer, the SACK bitmap, and the exact kernel state machine that *makes* it reliable — and the specific failure modes (silly window syndrome, TIME_WAIT exhaustion, bufferbloat) that leak out when the mechanism is stressed.

2. **Cost is always on the table.** Every mechanism we introduce is annotated with what it costs: round trips, bytes on the wire, syscalls, copies, cache lines, microseconds. An abstraction you cannot cost is an abstraction you cannot optimize.

3. **Real systems, real code.** Concepts are grounded in the systems you already run — the Linux kernel's `tcp_input.c`, Nginx's event loop, Envoy's L7 filters, Wireshark's dissectors — and every protocol gets working C or Java that you can compile, run, and point at a real server. Raw-socket parsers, an `epoll` event loop, a from-scratch HTTP/1.1 server, a TLS 1.3 handshake walkthrough, a protobuf codec.

If you read this book and do the drills, you will never again treat the network as a black box. You will treat it as what it is: a stack of byte formats and state machines, each one knowable, each one re-implementable, each one optimizable.

> A note on the title. "From scratch" is meant literally. We assume you can program and that you have used the network as a consumer. We do **not** assume you know what a MAC address is, how a route is chosen, or what happens between `connect()` returning and your first byte arriving. We build all of it.

---

## Who This Is For

- **Backend / systems / platform engineers** who want to move from *using* the network to *reasoning about and optimizing* it.
- **Engineers preparing for senior/staff/principal interviews** where "explain what happens when you type a URL and press enter" is the warm-up, not the whole question. Every chapter ends with **Interview Drills** pitched at that bar.
- **Anyone building networked infrastructure** — proxies, load balancers, RPC frameworks, databases, message brokers — who needs the layer beneath their layer to stop being magic.

**Prerequisites:** comfort reading C and Java; basic command line; the ability to run `sudo` on a Linux box (several programs use raw sockets, which require `CAP_NET_RAW`). No prior networking theory is assumed.

---

## How to Read This Book

The chapters are ordered bottom-up — physical layer first, application protocols last — because that is the order in which the abstractions actually stack, and each layer's design only makes sense once you've felt the pain of the layer below it. Reading straight through is the recommended path. But three other paths serve specific goals:

### Reading Paths

**The From-Zero Path** *(you want the whole mental model, in order)*
`01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19`
Every chapter, in order. This is the book as designed.

**The Systems-Engineer Path** *(you know the OSI words; you want the deep machinery)*
`02 (skim) → 04 → 05 → 07 → 08 → 10 → 12 → 13 → 14 → 17 → 18 → 19`
Skips the gentlest foundations, lingers on the flagship chapters where the real engineering lives: routing, TCP internals, the kernel socket path, TLS, HTTP/2-3, and proxies.

**The Interview-Cram Path** *(you have two weeks and a Tuesday onsite)*
`02 → 04 → 07 → 08 → 09 → 12 → 13 → 14 → 19` plus every chapter's **Interview Drills** section.
The capstone (19) ties it together: it is the long-form answer to "what happens when you type `https://...` and press enter," and rehearsing it out loud is the single highest-leverage prep you can do.

**The Application-Protocol Path** *(you live above the socket; you want HTTP/gRPC depth)*
`06 (skim) → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17`
For engineers who build APIs and services and want to master everything from the socket up.

---

## Conventions

**Chapter structure.** Each chapter opens with the problem it solves (why this layer exists at all), develops the mechanism with byte-level diagrams and runnable code, then closes with two fixed sections:
- **Key Takeaways** — the load-bearing ideas, numbered, the things you must not forget.
- **Interview Drills** — questions pitched at a senior/staff bar, each with a model answer that demonstrates depth.

**Wire-format diagrams.** Byte and bit layouts use box-drawing characters, big-endian (network byte order) unless noted. Bit offsets run left-to-right, MSB first, matching RFC convention:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|          Source Port          |       Destination Port        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

**Code.** C is the lingua franca for anything touching the kernel or the wire; Java appears where it illuminates the application layer or where the reader's day job lives. Every program is self-contained with build and run instructions. Programs using raw sockets are marked **`[needs CAP_NET_RAW / sudo]`**. Kernel and library source is cited by file and function (e.g. `net/ipv4/tcp_input.c:tcp_ack()`) so you can read the real thing.

**Cost annotations.** Watch for the **Cost:** callout. It quantifies what a mechanism spends — RTTs, bytes, syscalls, copies — because every chapter's deeper purpose is to let you optimize, and you optimize what you can measure.

**Production correlations.** Watch for **In the wild:** — these tie an abstract mechanism to a system you actually run (Linux, Nginx, Envoy, Kafka, Redis, the JVM).

**RFCs.** When a protocol is defined by a standard, the controlling RFC is named on first use and collected in the glossary's RFC index. We quote RFCs where their wording is precise and load-bearing; we paraphrase where they are merely thorough.

---

## Table of Contents

| # | Chapter | Tier | What you'll be able to do |
|--:|---------|------|---------------------------|
| 00 | **Index** *(you are here)* | — | Navigate the book |
| 01 | [The Physical Reality](./01-the-physical-reality.md) | Foundation | Explain how a bit becomes a voltage/photon and back |
| 02 | [The Models: OSI and TCP/IP](./02-models-osi-and-tcpip.md) | Foundation | Reason about layering and encapsulation precisely |
| 03 | [The Link Layer and the LAN](./03-link-layer-lan-ethernet.md) | Mid | Parse an Ethernet frame and resolve a MAC via ARP |
| 04 | [The Network Layer: IP](./04-network-layer-ip.md) | Mid | Decode an IP header; subnet with CIDR in your head |
| 05 | [Routing the Internet](./05-routing-the-internet.md) | Flagship | Trace how a packet crosses the planet; explain BGP |
| 06 | [The Transport Layer: UDP and Ports](./06-transport-udp-and-ports.md) | Mid | Explain demultiplexing; know when UDP wins |
| 07 | [TCP, Part I: Reliability](./07-tcp-part1-reliability.md) | Flagship | Draw the TCP state machine; explain every transition |
| 08 | [TCP, Part II: Congestion Control](./08-tcp-part2-congestion.md) | Flagship | Compare CUBIC vs BBR; diagnose bufferbloat |
| 09 | [DNS](./09-dns.md) | Mid | Hand-build a DNS query; explain the full resolver path |
| 10 | [Sockets and the Kernel](./10-sockets-and-the-kernel.md) | Flagship | Write an `epoll` server; explain C10K and zero-copy |
| 11 | [HTTP/1.0 and HTTP/1.1](./11-http-1.0-and-1.1.md) | Flagship | Build an HTTP/1.1 server; explain keep-alive & chunking |
| 12 | [TLS and HTTPS](./12-tls-and-https.md) | Flagship | Walk the TLS 1.3 handshake byte by byte |
| 13 | [HTTP/2](./13-http-2.md) | Flagship | Parse HTTP/2 frames; explain HPACK and multiplexing |
| 14 | [HTTP/3 and QUIC](./14-http-3-and-quic.md) | Flagship | Explain why QUIC exists; decode a QUIC header |
| 15 | [gRPC and Protocol Buffers](./15-grpc-and-protobuf.md) | Flagship | Hand-decode a protobuf; map gRPC onto HTTP/2 |
| 16 | [WebSockets and Realtime](./16-websockets-and-realtime.md) | Mid | Choose between WS, SSE, and polling with reasons |
| 17 | [Load Balancing and Proxies](./17-load-balancing-and-proxies.md) | Flagship | Contrast L4/L7; explain Nginx/Envoy internals |
| 18 | [Performance and Observability](./18-performance-and-observability.md) | Mid | Debug a slow connection with `tcpdump`/`ss`/eBPF |
| 19 | [One Request, End to End](./19-one-request-end-to-end.md) | Capstone | Narrate every packet of one HTTPS request |
| A | [Glossary and RFC Index](./A-glossary.md) | — | Look up any term or standard |

**Tiers** denote depth, not importance: *Foundation* chapters (~1,000–1,500 lines) build vocabulary and intuition; *Mid* chapters (~2,000–2,500 lines) develop a full mechanism with code; *Flagship* chapters (~3,500–4,000 lines) are exhaustive deep dives with multiple runnable programs, RFC-level wire formats, and kernel-source grounding.

---

## Chapter Synopses

### 01 — The Physical Reality *(Foundation)*
Before there are packets, there are signals. This chapter answers the question every higher layer takes for granted: how does a `1` get from one machine to another? We cover the encoding of bits onto physical media — voltage on copper (NRZ, Manchester, 4B/5B line codes), light on fiber, modulation on radio — and why clock recovery, not raw bandwidth, is the hard part. We open up a NIC: the PHY and MAC sublayers, the DMA ring buffers the kernel and card share, interrupts vs. polling (NAPI), and what "the wire is busy" actually means. By the end you'll understand the physical constraints — propagation delay, the speed of light as a latency floor, bit-error rates — that every protocol above spends its life working around.

### 02 — The Models: OSI and TCP/IP *(Foundation)*
The seven-layer OSI model is the vocabulary everyone uses and almost no real system implements; the four-layer TCP/IP model is what actually runs the internet. This chapter makes the relationship precise. We develop **encapsulation** as the central idea — each layer wraps the one above in its own header (and sometimes trailer) — and trace one payload down the sending stack and back up the receiving stack, watching headers get pushed and popped. We're honest about where the models lie: where layers leak (TLS sits awkwardly between 4 and 7; QUIC bulldozes the boundary entirely), where the abstraction is load-bearing, and where it's just a teaching fiction. This chapter is the map for the rest of the book.

### 03 — The Link Layer and the LAN *(Mid)*
The link layer moves frames between two machines on the same physical network. We dissect the **Ethernet II frame** byte by byte (destination MAC, source MAC, EtherType, payload, FCS), explain **MAC addressing** and why it's flat while IP is hierarchical, and build the bridge between the two: **ARP**, the protocol that answers "who has this IP?" with a MAC. We cover how a **switch** learns the network (the CAM/MAC-address table), the difference between a collision domain and a broadcast domain, and how **VLANs** (802.1Q tagging) carve one physical LAN into many logical ones. **Code:** a raw-socket (`AF_PACKET`) sniffer that captures live frames and a parser that prints Ethernet + ARP fields — your first program that reads bytes straight off the wire.

### 04 — The Network Layer: IP *(Mid)*
IP is the internet's thin waist: every protocol above and every medium below meets here. We decode the **IPv4 header** field by field (version, IHL, DSCP/ECN, total length, the fragmentation triplet, TTL, protocol, checksum, addresses, options) and the leaner, fixed-size **IPv6 header**, explaining what the redesign fixed and what it cost. We make **subnetting and CIDR** something you can do in your head — prefix lengths, masks, network/broadcast addresses, address planning — because it's both a daily skill and a guaranteed interview question. We cover **fragmentation**, why it's a performance and security footgun, and how **Path MTU Discovery** tries to avoid it. **Code:** an IP header decoder that turns raw packet bytes into a readable dump, extending the Chapter 3 sniffer up a layer.

### 05 — Routing the Internet *(Flagship)*
How does a packet get from your laptop in Bangalore to a server in Virginia, across a dozen independently-operated networks that have never met? This is the chapter that answers it. We build up from **forwarding** (the per-packet act: longest-prefix match against the FIB) versus **routing** (the control plane that builds the table). We cover intra-domain routing (**OSPF**, link-state, Dijkstra over the network) and the protocol that actually glues the internet together: **BGP** — path-vector routing, autonomous systems, peering vs. transit, route advertisement, and the spectacular ways BGP fails (route leaks, hijacks, the day a single misconfiguration took down a continent). We explain **NAT** thoroughly (why your laptop's `192.168.x.x` can talk to the world, and what state the router keeps) and **anycast** (how one IP address can live in fifty cities). **Code:** a from-scratch **traceroute** using raw ICMP and the TTL trick, so you can watch your own packets hop across the planet.

### 06 — The Transport Layer: UDP and Ports *(Mid)*
The network layer gets a packet to a *host*; the transport layer gets it to a *program*. This chapter introduces the abstraction that makes that possible — **ports** — and the simplest transport that uses them: **UDP**. We decode UDP's gloriously minimal 8-byte header, explain demultiplexing (how the kernel routes an incoming datagram to the right socket via the 4-tuple), and cover the checksum and its pseudo-header quirk. Crucially, we frame UDP not as "TCP without the good parts" but as **"raw packets with multiplexing"** — the right primitive when you want to build your own reliability (QUIC), can't afford head-of-line blocking (video, games), or need fan-out (DNS, multicast). This chapter sets up both the DNS chapter and the QUIC chapter.

### 07 — TCP, Part I: Reliability *(Flagship)*
TCP turns IP's unreliable, unordered, best-effort packets into a reliable, ordered byte stream — and the machinery that performs this trick is some of the most carefully engineered code in the world. Part I covers everything except congestion control. We draw and *explain* the full **TCP state machine** — every state, every transition, why `TIME_WAIT` exists and why it lasts 2×MSL, why `CLOSE_WAIT` piling up means *your* code has a bug. We cover the **three-way handshake** and **four-way teardown** byte by byte, **sequence and acknowledgment numbers** as the arithmetic of reliability, the **sliding window** for flow control, **retransmission** (timeouts via the Jacobson/Karels RTT estimator, plus fast retransmit), and **SACK** (selective acknowledgment) — what modern TCP actually uses to avoid re-sending data that already arrived. **Code:** a TCP segment decoder and a passive handshake observer that prints the state transitions of real connections.

### 08 — TCP, Part II: Congestion Control *(Flagship)*
Flow control stops a fast sender from overwhelming a slow *receiver*; **congestion control** stops it from overwhelming the *network* — a far harder problem, because no one tells you the network is full; you have to infer it. This chapter is the history and mechanism of that inference. We trace the lineage — **Tahoe → Reno → NewReno → CUBIC** (Linux's longtime default, loss-based, optimized for high-bandwidth-delay-product links) — explaining slow start, congestion avoidance, AIMD, and fast recovery with diagrams of `cwnd` over time. Then we cover the paradigm shift: **BBR** (and BBRv2/v3), which models the bottleneck's bandwidth and RTT directly instead of treating loss as the only signal, and why Google deployed it across YouTube. We explain the interactions that bite in production — **Nagle's algorithm** meeting **delayed ACK** (the infamous 40ms stall), **bufferbloat**, **ECN**, and the **bandwidth-delay product** as the number that governs how much you can have in flight — and how to tune all of it.

### 09 — DNS *(Mid)*
DNS is the internet's phone book, a globally distributed, eventually-consistent, hierarchical database that answers billions of queries a second — and it's almost always the first thing that happens when you make a request. We trace the **full resolver path**: stub resolver → recursive resolver → root → TLD → authoritative, explaining the difference between **recursive and iterative** resolution and who does the work. We decode the **DNS message format** (header, question, answer/authority/additional sections) and cover the **record types** that matter (A, AAAA, CNAME, MX, NS, SOA, TXT, SRV). We dig into **caching and TTLs** (the source of every "I updated DNS but it's still resolving to the old IP" story), **anycast** (how root servers are everywhere at once), and the modern privacy layer: **DoH, DoT, and DNSSEC**. **Code:** a from-scratch DNS client that builds a query, sends it over UDP, and parses the response — no library.

### 10 — Sockets and the Kernel *(Flagship)*
This is where theory meets the syscall table. Everything above the transport layer reaches the network through the **socket API**, and this chapter builds your understanding of it from `socket()` to `io_uring`. We walk the lifecycle — `socket`, `bind`, `listen`, `accept`, `connect`, `send`/`recv`, `close` — and what the kernel does for each (the socket as a file descriptor backed by send/receive buffers). Then the central drama of network programming: **the C10K problem** and the evolution of I/O multiplexing — blocking threads → `select` → `poll` → **`epoll`/`kqueue`** (readiness notification, level vs. edge triggered) → **`io_uring`** (completion-based, the current frontier). We cover **zero-copy** (`sendfile`, `splice`, `MSG_ZEROCOPY`) and why copies dominate the cost of high-throughput servers. **Code:** a complete, runnable **`epoll`-based echo server** that handles thousands of concurrent connections in a single thread — the architecture under Nginx, Redis, and Node.js.

### 11 — HTTP/1.0 and HTTP/1.1 *(Flagship)*
HTTP is the protocol the web is built on, and at version 1.1 it's simple enough to parse by eye and rich enough to run the planet for thirty years. We cover the **request/response grammar** (request line, headers, blank line, body), **methods** and their semantics (safe, idempotent, cacheable), **status codes** as a designed vocabulary, and the headers that do the real work. We explain the performance arc: HTTP/1.0's connection-per-request, HTTP/1.1's **persistent connections (keep-alive)** and **pipelining** (and why pipelining failed), **chunked transfer encoding** (sending a body of unknown length), **caching** (`Cache-Control`, `ETag`, conditional requests — the most underused performance lever in web engineering), and **cookies**. We name the wall HTTP/1.1 hits — **head-of-line blocking** — that motivates HTTP/2. **Code:** a from-scratch **HTTP/1.1 server** built on the Chapter 10 `epoll` loop, parsing requests and serving responses with keep-alive and chunked encoding.

### 12 — TLS and HTTPS *(Flagship)*
The `s` in `https` is a whole protocol, and it's the one most engineers wave their hands at. This chapter removes the hand-waving. We build up the cryptographic primitives only as far as needed (symmetric vs. asymmetric, AEAD, key exchange, digital signatures) and then walk the **handshake byte by byte** — both the **TLS 1.2** handshake (and why it costs 2 RTTs) and the streamlined **TLS 1.3** handshake (1 RTT, and **0-RTT** resumption, with its replay caveat). We cover the part everyone gets asked about and few can explain: **PKI** — certificates, certificate chains, the root store, how your browser decides to trust a stranger's server, and how it all goes wrong (expired certs, revocation, CA compromise). Plus **SNI** (and ECH), **cipher suites**, **ECDHE** forward secrecy, and **session resumption**. **Code:** an annotated TLS 1.3 handshake walkthrough that captures and dissects every handshake message of a real connection.

### 13 — HTTP/2 *(Flagship)*
HTTP/2 keeps HTTP's semantics and replaces its wire format wholesale: text becomes **binary framing**, one-request-per-connection becomes **multiplexed streams** over a single TCP connection. We decode the **frame format** (the nine frame types: HEADERS, DATA, SETTINGS, WINDOW_UPDATE, etc.), explain **streams** and how multiplexing kills HTTP/1.1's head-of-line blocking *at the HTTP layer*, and cover **HPACK** — the header-compression scheme (static + dynamic tables, Huffman coding) that makes per-request headers cheap. We cover **flow control** (per-stream and connection-level), **stream priority/dependencies**, and **server push** — including an honest account of why push was a good idea that didn't work and got deprecated. Then the crucial limitation: HTTP/2 solved HOL blocking at the HTTP layer but **TCP's own head-of-line blocking** remains, and under packet loss HTTP/2 can be *worse* than HTTP/1.1 with parallel connections — the exact problem QUIC was built to solve. **Code:** an HTTP/2 frame parser.

### 14 — HTTP/3 and QUIC *(Flagship)*
QUIC is the most significant transport-layer change in thirty years: it rebuilds TCP's guarantees on top of **UDP**, in **user space**, integrated with **TLS 1.3**. This chapter explains why and how. We start with the motivation — TCP head-of-line blocking, the ossification of the network (middleboxes that won't let anything but TCP and UDP through), and the cost of TCP+TLS's combined handshakes — and then build QUIC's answers: **streams** as first-class transport objects with **independent loss recovery** (a lost packet stalls only its own stream), a **0/1-RTT handshake** that folds in encryption, **connection migration** (your connection survives a Wi-Fi-to-cellular switch because the connection ID, not the 4-tuple, identifies it), and **congestion control moved to user space** where it can iterate without kernel deployments. We map **HTTP/3** onto QUIC and explain **QPACK** (HPACK adapted for out-of-order streams). **Code:** a QUIC long/short-header packet decoder.

### 15 — gRPC and Protocol Buffers *(Flagship)*
gRPC is how modern services talk to each other, and it's a precise stack of things this book has already built: **Protocol Buffers** for serialization, **HTTP/2** for transport, a thin RPC layer on top. We decode the **protobuf wire format** byte by byte — **varints**, **ZigZag** encoding for signed integers, field tags (field number + wire type), length-delimited fields — until you can hand-decode a message with no `.proto` file, and we explain *why* it's so compact and so fast compared to JSON. Then we map **gRPC onto HTTP/2**: how a method call becomes a stream, how request/response messages become length-prefixed frames, the four call types (**unary, server-streaming, client-streaming, bidirectional**), and the cross-cutting machinery — **deadlines/timeouts** (and why they must propagate), **metadata** (headers), **interceptors** (middleware), **status codes**, and **client-side load balancing**. **Code:** a from-scratch protobuf encoder/decoder and a minimal gRPC frame builder.

### 16 — WebSockets and Realtime *(Mid)*
Sometimes request/response isn't enough and you need the server to push. This chapter covers the realtime toolkit. **WebSockets**: the HTTP **Upgrade** handshake that turns an HTTP connection into a raw bidirectional channel, the **frame format** (opcodes, the mandatory client-to-server masking and the security reason it exists, fragmentation), and ping/pong keepalives. **Server-Sent Events (SSE)**: the simpler, HTTP-native, server-to-client-only alternative that's underrated for its simplicity. And a clear-eyed **decision framework**: WebSockets vs. SSE vs. long-polling vs. HTTP/2 streams vs. just polling — with the latency, infrastructure, and backpressure tradeoffs that should drive the choice. We cover **backpressure**, the thing realtime systems get wrong most often.

### 17 — Load Balancing and Proxies *(Flagship)*
A single server is a single point of failure and a throughput ceiling; everything at scale sits behind a proxy. This chapter explains the layer that fans your traffic out. We draw the fundamental distinction — **L4 (transport) vs. L7 (application) load balancing** — and what each can and can't see and do (an L4 LB moves bytes and is blazing fast; an L7 LB understands HTTP and can route, retry, and rewrite). We cover **balancing algorithms** (round-robin, least-connections, **consistent hashing** and why it matters for cache affinity), **Direct Server Return**, **health checks**, **connection pooling** and keep-alive reuse, and **TLS termination**. We open up the real systems: **Nginx**'s worker-and-event-loop model, **HAProxy**, and **Envoy**'s listener/filter/cluster architecture that powers the service mesh. Plus **reverse proxies, CDNs, and edge** — why a byte served from 20km away beats one served from 2,000km, every time.

### 18 — Performance and Observability *(Mid)*
You can't optimize what you can't see, and the network is invisible by default. This chapter makes it visible. We start with the fundamental quantities and how they trade off — **latency vs. bandwidth vs. the bandwidth-delay product** — and why **tail latency** (p99, p999), not the average, is what your users feel. Then the toolkit, hands-on: **`tcpdump`** and **Wireshark** for packet-level truth, **`ss`** for socket state, **`tcpretrans`/`tcptrace`** and the **eBPF**-based tools (`bpftrace`, the BCC suite) that let you trace the kernel's network path without a debugger. We cover **sysctl tuning** that actually matters (buffer sizes, `tcp_notsent_lowat`, `SO_REUSEPORT`) and, most importantly, a **debugging methodology** — how to localize a network problem to a layer instead of guessing — that turns "the network is slow" into a falsifiable hypothesis.

### 19 — One Request, End to End *(Capstone)*
This is the chapter the whole book was building toward, and the answer to the interview question that opens a thousand onsites: **"What happens when you type `https://example.com` and press enter?"** We narrate it completely, end to end, touching every layer we built — the DNS resolution (Ch. 9), the ARP for the gateway (Ch. 3), the IP routing across autonomous systems (Ch. 4–5), the TCP three-way handshake (Ch. 7), the TLS 1.3 handshake (Ch. 12), the HTTP/2 request and response (Ch. 13), and the bytes coming back up the stack to become pixels — annotating **every packet, every syscall, every round trip, and every microsecond**. Read on its own, it's a satisfying tour. Rehearsed out loud, it's the most complete answer to that question your interviewer has ever heard.

### Appendix A — Glossary and RFC Index
Every acronym, term, and protocol defined in the book, plus a complete index of the RFCs cited — what each one standardizes and where in the book it's used.

---

## A Final Word Before We Start

The network is not magic, and it is not someone else's problem. It is a stack of byte formats and state machines, every one of which was designed by an engineer solving a concrete problem under concrete constraints. By the end of this book those engineers' decisions will feel like your own — obvious in hindsight, the way good engineering always does. And the next time something is slow, or broken, or just mysterious, you won't reach for a shrug. You'll reach for `tcpdump`, and you'll know exactly what you're looking at.

Let's start with a voltage on a wire.

---

*Next: [Chapter 1 — The Physical Reality](./01-the-physical-reality.md)*
