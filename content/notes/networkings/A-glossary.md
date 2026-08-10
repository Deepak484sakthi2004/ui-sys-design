# Appendix A — Glossary and RFC Index

A reference for every term, acronym, and standard used in this book. Terms link to the chapter that develops them; the RFC index lists the controlling standards and where each is used.

---

## Glossary

**AAAA record** — A DNS record mapping a name to an IPv6 address (the IPv6 counterpart of an A record). [Ch. 9]

**A record** — A DNS record mapping a name to an IPv4 address. [Ch. 9]

**ACK (acknowledgment)** — A TCP segment (or the ACK flag/field) confirming receipt of data up to a given sequence number. TCP uses *cumulative* ACKs: "ACK N" confirms all bytes through N−1. [Ch. 7]

**AEAD (Authenticated Encryption with Associated Data)** — A cipher mode (AES-GCM, ChaCha20-Poly1305) that encrypts *and* authenticates in one operation, providing confidentiality and integrity together. Standard in TLS 1.3. [Ch. 12]

**AIMD (Additive Increase, Multiplicative Decrease)** — TCP's congestion-control control law: grow the window linearly while probing, halve it on loss. Provably converges many flows to a fair, stable share. [Ch. 8]

**Anycast** — Announcing the same IP prefix from many locations so BGP routes each user to the nearest instance. Underpins DNS root servers, public resolvers, and CDNs. [Ch. 5, 9, 17]

**ARP (Address Resolution Protocol)** — Resolves an IPv4 address to a MAC address on the local segment by broadcasting "who has X?" and caching the reply. Unauthenticated (hence ARP spoofing). [Ch. 3]

**AS (Autonomous System)** — An independently-operated network with a globally unique AS Number (ASN). BGP routes between ~75,000 ASes. [Ch. 5]

**Backpressure** — The propagation of a slow consumer's slowness back to a fast producer, forcing it to slow down. Physically realized by socket send/receive buffers filling. Critical in realtime push systems. [Ch. 10, 16]

**Bandwidth** — The data rate a link can carry (bits/sec). Distinct from latency: a fat pipe can still be a long pipe. [Ch. 1]

**Bandwidth-Delay Product (BDP)** — bandwidth × RTT; the data "in flight" needed to keep a link full. The window must be ≥ BDP to fill a long fat link. [Ch. 1, 7, 8]

**BBR (Bottleneck Bandwidth and RTT)** — A model-based congestion-control algorithm that measures bandwidth and min-RTT and paces to the optimum (full pipe, empty queue), instead of probing until loss. Loss-tolerant and bufferbloat-resistant. [Ch. 8]

**BGP (Border Gateway Protocol)** — The path-vector routing protocol between ASes; "glues the internet together." Routes by *policy/economics* (LOCAL_PREF) first, path length second. Insecure by design (hijacks, leaks). [Ch. 5]

**Bufferbloat** — Excessive latency caused by oversized router buffers queuing seconds of data before a loss-based sender backs off. The "download stutters my video call" symptom. Mitigated by AQM (CoDel) and BBR. [Ch. 8]

**CDN (Content Delivery Network)** — A globally distributed fleet of reverse-proxy caches at "edge" locations, routing users to the nearest via anycast/GeoDNS. The answer to the speed-of-light latency floor. [Ch. 1, 17]

**Certificate (X.509)** — A document binding a public key to a domain name, signed by a CA. The basis of TLS authentication. [Ch. 12]

**Certificate Authority (CA)** — An entity that verifies identities and signs certificates; trusted via pre-installed root certificates in the OS/browser trust store. [Ch. 12]

**CIDR (Classless Inter-Domain Routing)** — Expressing IP networks as a prefix length (`/24`), enabling arbitrary-boundary subnetting and route aggregation. The basis of scalable routing. [Ch. 4, 5]

**cwnd (congestion window)** — The sender's estimate of how much data the *network* can absorb. The sender is limited by min(cwnd, rwnd). [Ch. 8]

**CLOSE_WAIT** — A TCP state: you received the peer's FIN but your application hasn't called `close()`. Piling up = a connection-leak bug in *your* code. [Ch. 7]

**Congestion control** — Limiting send rate to avoid overwhelming the *network* (vs. flow control's *receiver*); the limit is *inferred*, not advertised. [Ch. 8]

**Connection ID** — QUIC's connection identifier (in the packet, not the 4-tuple), enabling connection migration across network changes. [Ch. 14]

**Consistent hashing** — A hashing scheme (keys + servers on a ring) where adding/removing a server remaps only ~1/N of keys, not all of them. For distributed caches, sharding, CDN routing. [Ch. 17]

**CSMA/CD** — Carrier Sense Multiple Access with Collision Detection; the original shared-Ethernet access algorithm with exponential backoff (ancestor of TCP's backoff). Obsolete with switched full-duplex. [Ch. 1]

**CUBIC** — Linux's longtime default loss-based congestion control, using a cubic growth curve to fill high-BDP links that Reno couldn't. [Ch. 8]

**Decapsulation** — The receiver stripping each layer's header bottom-up, using demux keys to route the payload to the next layer. [Ch. 2]

**Delayed ACK** — A receiver optimization batching ACKs (waiting ~200ms). Interacts pathologically with Nagle's algorithm to cause the ~40ms stall. [Ch. 8]

**DHCP** — (mentioned) The protocol that auto-assigns IP addresses to hosts joining a network. [Ch. 4 context]

**Diffie-Hellman (DH/ECDHE)** — A key-exchange method letting two parties derive a shared secret over a public channel an eavesdropper can't compute. *Ephemeral* (ECDHE) gives forward secrecy. [Ch. 12]

**DNS (Domain Name System)** — The hierarchical, delegated, cached distributed database mapping names to IP addresses. [Ch. 9]

**DNSSEC** — DNS Security Extensions; cryptographically *signs* records (integrity, anti-poisoning) but does not encrypt (no privacy). [Ch. 9]

**DoH / DoT (DNS over HTTPS / TLS)** — Encrypt DNS queries for privacy. DoH (port 443) is indistinguishable from web traffic. [Ch. 9]

**ECN (Explicit Congestion Notification)** — Routers signal congestion by *marking* packets (IP header bits) instead of dropping them — feedback without loss. [Ch. 4, 8]

**Encapsulation** — Each layer wrapping the layer above's entire PDU (header included) as opaque payload in its own header/trailer. The mechanism that implements layering. [Ch. 2]

**Ephemeral port** — An OS-assigned high port (49152–65535) used as a client's source port. Limited supply → port exhaustion on busy clients. [Ch. 6]

**epoll / kqueue** — Linux/BSD I/O multiplexing: register fds once, the kernel returns only the *ready* ones — O(active), not O(total). Enables the single-thread event loop (Nginx, Redis, Node). [Ch. 10]

**ETag** — An HTTP validator (content fingerprint) enabling cheap revalidation via `If-None-Match` → `304 Not Modified`. [Ch. 11]

**EtherType** — The 2-byte Ethernet field identifying the payload protocol (0x0800 IPv4, 0x0806 ARP, 0x86DD IPv6) — the L2 demux key. [Ch. 3]

**Event loop** — A single thread that waits on many connections (via epoll/kqueue) and processes only the ready ones. The architecture of high-performance servers. [Ch. 10]

**FCS (Frame Check Sequence)** — The CRC-32 trailer of an Ethernet frame; the receiver drops frames that fail it (detect, not correct). [Ch. 1, 3]

**FIB (Forwarding Information Base)** — The optimized forwarding table (best next-hop per prefix) the data plane uses, distilled from the RIB. [Ch. 5]

**FIN** — The TCP flag meaning "I have no more data to send"; each direction closes independently (four-way teardown). [Ch. 7]

**Flow control** — Limiting send rate to avoid overwhelming the *receiver*, via the advertised sliding window (rwnd). [Ch. 7]

**Forward secrecy** — The property that stealing a server's long-term key later cannot decrypt past sessions (because each used a discarded ephemeral key). Mandatory in TLS 1.3. [Ch. 12]

**Four-tuple** — (src IP, src port, dst IP, dst port); uniquely identifies a connection/flow. How one listening port serves many clients. [Ch. 6]

**Fragmentation** — Splitting an oversized IP packet to fit the MTU. A footgun (loss amplification, breaks firewalls); avoided via PMTUD. [Ch. 4]

**gRPC** — An RPC framework: protobuf messages over HTTP/2 streams, with deadlines, metadata, interceptors, four call types, and its own status codes. [Ch. 15]

**Head-of-line (HOL) blocking** — One slow/lost item stalling everything queued behind it. At the HTTP layer (HTTP/1.1, fixed by HTTP/2 multiplexing); at the TCP layer (HTTP/2's residual flaw, fixed by QUIC). [Ch. 11, 13, 14]

**Health check** — A load balancer's probe to determine which backends are healthy; enables self-healing and zero-downtime deploys. Too-deep checks on shared dependencies can cause cascading failures. [Ch. 17]

**HPACK** — HTTP/2 header compression (static + dynamic tables + Huffman). Its statefulness forces HTTP/3's QPACK redesign. [Ch. 13]

**HTTP/1.1** — Text-based request/response with persistent connections, chunked encoding, caching. Limited by head-of-line blocking. [Ch. 11]

**HTTP/2** — Binary-framed, multiplexed (streams over one connection), HPACK-compressed. Same semantics as HTTP/1.1. Suffers TCP HOL blocking. [Ch. 13]

**HTTP/3** — HTTP over QUIC; per-stream independence eliminates TCP HOL blocking. Uses QPACK. [Ch. 14]

**Idempotent** — An operation repeatable with the same effect (GET, PUT, DELETE; *not* POST). The basis of safe retries and the 0-RTT replay constraint. [Ch. 11, 12]

**ICMP** — The IP control/error protocol (ping = Echo, traceroute = Time Exceeded, PMTUD = Fragmentation Needed). Blanket-blocking it breaks PMTUD. [Ch. 4, 5]

**IP (Internet Protocol)** — Best-effort, connectionless datagram delivery with hierarchical global addressing; the "thin waist." [Ch. 4]

**IPv4 / IPv6** — 32-bit (4.3B addresses) vs. 128-bit IP. IPv6's slow rollout reflects how hard the thin waist is to change. [Ch. 4]

**ISN (Initial Sequence Number)** — TCP's randomly-chosen starting sequence number (random to prevent prediction attacks). [Ch. 7]

**io_uring** — Linux's completion-based async I/O via shared submission/completion ring buffers, minimizing syscalls. [Ch. 10]

**Latency** — The time for one operation, floored by propagation delay (speed of light). Distinct from bandwidth. [Ch. 1]

**Layering** — Decomposing networking into layers, each serving the one above using the one below. Enables independent evolution, decomposition, interoperability. [Ch. 2]

**Line coding** — Encoding bits into physical signals so the receiver can recover the clock (Manchester, 4B/5B, 8b/10b, scrambling). [Ch. 1]

**Load balancer** — A proxy distributing requests across backends. L4 (transport, fast, opaque) vs. L7 (application, content-aware). [Ch. 17]

**Longest-prefix match (LPM)** — The forwarding rule: the most-specific matching route prefix wins. The basis of IP forwarding. [Ch. 5]

**MAC address** — A flat 48-bit hardware identifier (who, not where); used for one-hop delivery. Can't be routed globally (needs IP's hierarchy). [Ch. 3]

**Masking (WebSocket)** — Mandatory XOR of client→server frames; defends middleboxes from being tricked into seeing WS payloads as HTTP. Not for confidentiality. [Ch. 16]

**Metadata (gRPC)** — Key/value pairs (= HTTP/2 headers) carrying auth tokens, trace IDs, etc., alongside the typed message. [Ch. 15]

**MSS (Maximum Segment Size)** — The largest TCP payload per segment, derived from the MTU to avoid fragmentation (typically 1460). [Ch. 7]

**MTU (Maximum Transmission Unit)** — The largest link-layer payload (1500 for Ethernet). The most consequential magic number; drives MSS, fragmentation, PMTUD. [Ch. 3, 4]

**Multiplexing** — Carrying many concurrent logical streams over one connection (HTTP/2 streams; QUIC streams). [Ch. 13, 14]

**Nagle's algorithm** — A sender optimization coalescing small writes; interacts with delayed ACK to cause the ~40ms stall. Disabled via TCP_NODELAY. [Ch. 8]

**NAT (Network Address Translation)** — Rewriting source IP:port so many private hosts share one public IP (PAT). Bought IPv4 time but broke end-to-end addressing (P2P needs STUN/TURN/hole-punching). [Ch. 5]

**NAPI** — Linux's hybrid interrupt+polling NIC driver model, avoiding interrupt storms under load. [Ch. 1]

**OSI model** — The 7-layer reference vocabulary (Physical, Data Link, Network, Transport, Session, Presentation, Application). A teaching model; TCP/IP is what runs. [Ch. 2]

**OSPF** — A link-state intra-domain routing protocol: every router floods its links, builds the full map, runs Dijkstra. Works only within one trusted domain. [Ch. 5]

**Pacing** — Spreading packets evenly over the RTT rather than bursting; gentler on buffers, central to BBR. [Ch. 8]

**Pipelining (HTTP/1.1)** — Sending requests without waiting for responses; failed due to head-of-line blocking. [Ch. 11]

**PKI (Public Key Infrastructure)** — The certificate/CA/trust-store system for authenticating servers — "trust a stranger." Where most real TLS failures live. [Ch. 12]

**PMTUD (Path MTU Discovery)** — Discovering the smallest path MTU (via DF flag + ICMP) to avoid fragmentation. Broken by ICMP blocking → "small works, big hangs" blackhole. [Ch. 4]

**Port** — A 16-bit number identifying a process endpoint; the transport-layer demux key. [Ch. 6]

**Propagation delay** — The time for a signal to traverse a medium (~200,000 km/s in fiber); the latency floor set by the speed of light. [Ch. 1]

**Protocol Buffers (protobuf)** — A compact, schema-driven binary serialization (varints, ZigZag, field-number tags). Smaller/faster than JSON; great schema evolution. [Ch. 15]

**Proxy** — An intermediary between client and server (forward = represents clients; reverse = represents servers). The basis of load balancing, CDNs, meshes. [Ch. 17]

**QPACK** — HTTP/3's header compression; HPACK redesigned to tolerate QUIC's out-of-order streams. [Ch. 14]

**QUIC** — A reliable, multiplexed, encrypted transport over UDP, in user space; fixes TCP HOL blocking, handshake stacking, and ossification. The basis of HTTP/3. [Ch. 14]

**Reverse proxy** — A proxy in front of servers (vs. forward proxy in front of clients). [Ch. 17]

**RIB (Routing Information Base)** — The full routing table (all candidate routes) built by the control plane; distilled into the FIB. [Ch. 5]

**RST (reset)** — A TCP flag aborting a connection immediately (e.g. connecting to a closed port → ECONNREFUSED). [Ch. 7]

**RTO (Retransmission Timeout)** — The adaptive timeout (Jacobson/Karels: SRTT + 4×RTTVAR) after which TCP retransmits unacknowledged data. [Ch. 7]

**RTT (Round-Trip Time)** — The time for a packet to reach the peer and an ACK to return; the master cost metric of networked systems. [Ch. 1, 7]

**rwnd (receive window)** — The receiver-advertised free buffer space; the flow-control limit. [Ch. 7]

**SACK (Selective Acknowledgment)** — A TCP option letting the receiver report exactly which non-contiguous blocks it has, so the sender retransmits only the gaps. [Ch. 7]

**Safe (HTTP method)** — Read-only, no side effects (GET, HEAD, OPTIONS); cacheable and prefetchable. [Ch. 11]

**Sequence number** — TCP's per-byte numbering; the basis of reliability, ordering, and duplicate/gap detection. [Ch. 7]

**sendfile / zero-copy** — Moving data (e.g. a file to a socket) without copying through userspace; how Nginx/Kafka achieve high throughput. [Ch. 10]

**Server-Sent Events (SSE)** — A never-ending HTTP response streaming events server→client, with free auto-reconnect. Simpler than WebSockets for one-directional push (e.g. LLM token streaming). [Ch. 16]

**Service mesh** — Per-service sidecar proxies (Envoy) handling mTLS, load balancing, retries, and observability — moving networking policy into infrastructure. [Ch. 17]

**Sliding window** — TCP's flow-control mechanism: the sender may have up to `rwnd` unacknowledged bytes in flight; the window slides as ACKs arrive. [Ch. 7]

**Slow start** — TCP's exponential cwnd ramp at connection start, finding the capacity ballpark quickly. Why short/cold connections never reach full speed. [Ch. 8]

**SNI (Server Name Indication)** — A TLS extension naming the target host so the server picks the right certificate (enables HTTPS virtual hosting). Cleartext (leaks destination); ECH encrypts it. [Ch. 12]

**Socket** — A file descriptor backed by kernel send/receive buffers; the application's handle to the network. [Ch. 10]

**SSE** — See Server-Sent Events.

**Subnetting** — Dividing an IP network by prefix length (CIDR); know host count = 2^(32−prefix) − 2 and the block-size trick. [Ch. 4]

**SYN / SYN cookies** — The connection-initiating TCP flag; SYN cookies defend SYN floods by encoding state in the ISN instead of allocating it. [Ch. 7]

**TCP (Transmission Control Protocol)** — A reliable, ordered, connection-oriented byte stream built on unreliable IP, via sequence-number bookkeeping. [Ch. 7, 8]

**TCP_NODELAY** — The socket option disabling Nagle's algorithm; the fix for the 40ms stall, default in low-latency systems. [Ch. 8]

**TCP/IP model** — The 4-layer model that actually runs the internet (Link, Internet, Transport, Application). [Ch. 2]

**Tail latency (p99/p999)** — The slowest percentiles, which govern user experience at scale (the whole operation waits for its slowest part). Measure percentiles, not averages. [Ch. 18]

**TIME_WAIT** — The active closer's post-teardown wait (2×MSL) to re-ACK a retransmitted FIN and let old duplicates die. Normal but ties up the 4-tuple; fix pileups with pooling. [Ch. 7]

**TLS (Transport Layer Security)** — Provides confidentiality, integrity, and authentication. TLS 1.3 = 1-RTT handshake (0-RTT resumption), mandatory forward secrecy. [Ch. 12]

**TTL (Time To Live)** — The IP hop counter (prevents loops); decremented per router, triggers ICMP Time Exceeded at zero (the traceroute mechanism). Also DNS cache lifetime. [Ch. 4, 5, 9]

**UDP (User Datagram Protocol)** — Minimal transport: ports + checksum over IP. Connectionless, unreliable, message-oriented. The blank canvas (DNS, media, QUIC). [Ch. 6]

**Varint** — Protobuf's variable-length integer encoding (7 bits/byte + continuation bit); small numbers cost 1–2 bytes. [Ch. 15]

**VLAN (802.1Q)** — Partitioning one physical switch into multiple logical broadcast domains via a 4-byte tag. [Ch. 3]

**WebSocket** — A persistent full-duplex channel established by upgrading an HTTP connection (`101 Switching Protocols`). For bidirectional realtime. [Ch. 16]

**Window scaling** — A TCP option multiplying the 16-bit window so it can exceed 64KB; required to fill high-BDP links. [Ch. 7]

**ZigZag encoding** — Mapping signed integers to unsigned so small-magnitude negatives encode small (protobuf `sint32/64`). [Ch. 15]

**Zero-copy** — See sendfile.

---

## RFC Index

The controlling standards cited in this book, with what each defines and where it's used.

| RFC | Title / What it defines | Chapter |
|-----|-------------------------|---------|
| **RFC 791** | Internet Protocol (IPv4) — the IPv4 header and datagram model | 4 |
| **RFC 792** | ICMP — control/error messages (ping, Time Exceeded, Unreachable) | 4, 5 |
| **RFC 793 / 9293** | TCP — the reliable byte-stream transport (9293 is the modern consolidation) | 7, 8 |
| **RFC 768** | UDP — the minimal datagram transport | 6 |
| **RFC 826** | ARP — IPv4-to-MAC address resolution | 3 |
| **RFC 1071** | Computing the Internet checksum (one's-complement sum) | 5 |
| **RFC 1918** | Private IPv4 address ranges (10/8, 172.16/12, 192.168/16) | 4 |
| **RFC 4632** | CIDR — classless addressing and route aggregation | 4 |
| **RFC 8200** | IPv6 — the 128-bit successor to IPv4 | 4 |
| **RFC 4271** | BGP-4 — inter-domain path-vector routing | 5 |
| **RFC 2328** | OSPF v2 — link-state intra-domain routing | 5 |
| **RFC 6298** | Computing TCP's retransmission timer (Jacobson/Karels RTO) | 7 |
| **RFC 2018** | TCP Selective Acknowledgment (SACK) | 7 |
| **RFC 5681 / 6582** | TCP congestion control; NewReno fast recovery | 8 |
| **RFC 6928** | Increasing TCP's initial window to 10 segments | 8 |
| **RFC 3168** | ECN — Explicit Congestion Notification | 4, 8 |
| **RFC 6528** | Defending against sequence-number prediction (random ISNs) | 7 |
| **RFC 1035 / 1034** | DNS — concepts and message format | 9 |
| **RFC 8484** | DNS over HTTPS (DoH) | 9 |
| **RFC 7858** | DNS over TLS (DoT) | 9 |
| **RFC 4033** | DNSSEC — DNS Security Extensions | 9 |
| **RFC 9110 / 9112** | HTTP semantics; HTTP/1.1 message syntax | 11 |
| **RFC 8446** | TLS 1.3 — the modern handshake (1-RTT/0-RTT, forward secrecy) | 12 |
| **RFC 5246** | TLS 1.2 (predecessor; 2-RTT handshake) | 12 |
| **RFC 9113 / 7540** | HTTP/2 — binary framing and multiplexing | 13 |
| **RFC 7541** | HPACK — HTTP/2 header compression | 13 |
| **RFC 9000** | QUIC — the UDP-based reliable, multiplexed, encrypted transport | 14 |
| **RFC 9114** | HTTP/3 — HTTP over QUIC | 14 |
| **RFC 9204** | QPACK — HTTP/3 header compression | 14 |
| **RFC 6455** | The WebSocket Protocol | 16 |
| **RFC 8441** | Bootstrapping WebSockets over HTTP/2 | 16 |
| **IEEE 802.3** | Ethernet — framing and the physical layer | 1, 3 |
| **IEEE 802.1Q** | VLAN tagging | 3 |
| **IEEE 802.11** | Wi-Fi — wireless LAN | 1, 3 |

---

## Closing

You've reached the end. Eighteen chapters of mechanism, one capstone that wove them together, and this reference to look anything up. The network is no longer a black box — it's a stack of byte formats and state machines, each one knowable, each one re-implementable, each one optimizable, and now each one yours.

The next time something is slow, or broken, or just mysterious, you won't reach for a shrug. You'll reach for `tcpdump`, or `ss -tin`, or `curl -w` — and you'll know exactly what you're looking at, because you know how every layer beneath it actually works.

That was the whole point.

---

*Previous: [Chapter 19 — One Request, End to End](./19-one-request-end-to-end.md) | [Back to Index](./00-index.md)*
