# Chapter 19 — One Request, End to End

> *"What happens when you type a URL into your browser and press enter?"* It is the most famous interview question in computing, asked at every level from intern to principal, and it is famous because it is *fractal* — you can answer it in thirty seconds or thirty minutes, and how deep you go reveals exactly how much you actually understand. This book has spent eighteen chapters building every layer of the answer. This chapter assembles them into one continuous narration — every packet, every round trip, every microsecond, from keystroke to rendered pixel — so that the next time you're asked, you can go as deep as you like, and *know* you're right.

This is the capstone. It contains almost no new material; instead, it weaves together everything from Chapters 1-18 into a single, complete story. Read on its own, it's a satisfying tour of how the internet actually works. Rehearsed out loud, it's the most thorough answer to the URL question your interviewer has ever heard — and the act of rehearsing it is the single highest-leverage thing you can do to consolidate this book's knowledge, because it forces you to connect every layer to its neighbors.

We'll trace the request `https://example.com/index.html` from a fresh browser (cold caches everywhere — the worst case, which exercises every mechanism) on a laptop connected by Wi-Fi to a home router, reaching a server behind a CDN and a load balancer across the country. We'll go down the stack on the way out, and back up on the way in, naming the chapter that owns each step.

---

## 19.1 The Setup

The scene, so the trace is concrete:

```
   YOU: a laptop, IP 192.168.1.20, on Wi-Fi, behind a home router (192.168.1.1) that
        NATs to a public IP via your ISP.
   GOAL: load https://example.com/index.html
   SERVER: example.com, served via a CDN (anycast edge near you) fronting an L7 load
        balancer fronting a fleet of web servers, somewhere across the country.
   STATE: cold — nothing cached anywhere (DNS, TCP, TLS all from scratch). Worst case.
```

Press enter. Here's everything that happens.

---

## 19.2 Phase 1 — From URL to "I Need to Talk to an IP"

**The browser parses the URL** (Chapter 11). `https://example.com/index.html` decomposes into: scheme `https` (→ use TLS, default port 443, Chapter 12), host `example.com` (the name to resolve), path `/index.html` (what to request). The browser now knows it needs to make an HTTPS request to whatever IP `example.com` resolves to, on port 443.

**But first: is it even allowed to connect?** The browser checks its **HSTS** list (HTTP Strict Transport Security) — if `example.com` is on it, the browser *forces* HTTPS even if you typed `http://`, refusing to ever send plaintext. A small but important security step (it prevents downgrade attacks). Cold cache, so assume it proceeds to resolve the name.

**DNS resolution: name → IP** (Chapter 9). The browser needs `example.com`'s IP. With everything cold:

```
   1. Browser cache: miss. OS cache: miss. So the OS stub resolver asks the configured
      recursive resolver (say 8.8.8.8) — a RECURSIVE query: "give me the final answer."

   2. To reach 8.8.8.8, the laptop itself needs to send a UDP packet (Ch.6) to it on
      port 53 — which requires its own lower-layer journey (ARP for the gateway, etc.,
      see Phase 2). DNS is itself a network request! (We'll fold that in.)

   3. The recursive resolver walks the hierarchy with ITERATIVE queries (Ch.9):
      root server → "ask the .com servers" → .com TLD server → "ask example.com's
      servers" → example.com's authoritative server → "example.com is at 93.184.x.x,
      TTL 300." (Here, the authoritative answer is a CDN edge IP, via anycast — Ch.5.)

   4. The resolver caches the answer and returns the IP to the laptop's stub resolver.
```

Crucially, because `example.com` is behind a CDN, the IP returned is an **anycast** address (Chapter 5) or a GeoDNS-selected one — routing you toward the *nearest* CDN edge, not a distant origin. The DNS answer is itself the first act of "move the content closer" (Chapters 1, 17). Total DNS cost (cold): a few round trips, but on a warm resolver cache (the common case), one quick round trip to 8.8.8.8.

Now the browser has an IP: `93.184.216.34` (say). It needs to open a TCP connection to it on port 443.

---

## 19.3 Phase 2 — Getting the First Packet onto the Wire

The browser tells the OS "connect to `93.184.216.34:443`." The OS must now actually *send a packet*, and that's a journey through the bottom of the stack (Chapters 1-5).

**Routing decision: local or remote?** (Chapters 4-5). The OS consults its routing table and does **longest-prefix match** (Chapter 5) on the destination `93.184.216.34`. Is it on the local subnet (`192.168.1.0/24`)? No. So it matches the **default route** (`0.0.0.0/0`) → send to the gateway, `192.168.1.1`. The packet's *final* destination IP is the server, but the *next hop* is the router.

**ARP: find the gateway's MAC** (Chapter 3). To put a frame on the Wi-Fi destined for the gateway, the OS needs the gateway's MAC address. ARP cache cold → it **broadcasts** an ARP request ("who has `192.168.1.1`?"), the router replies with its MAC, the laptop caches it. (Over Wi-Fi this rides 802.11 frames, but the ARP logic is identical to Chapter 3.)

**Encapsulation: build the packet** (Chapter 2). Now the stack builds the nested envelopes (Chapter 2's encapsulation, the literal mechanism):

```
   The first TCP SYN packet, encapsulated (Ch.2):
   ┌──────────┬─────────┬──────────┬─────────────────────┐
   │ Wi-Fi/   │ IP hdr  │ TCP hdr  │  (SYN — no payload)  │
   │ Eth hdr  │         │          │                      │
   └──────────┴─────────┴──────────┴─────────────────────┘
     dst MAC =          dst IP =    SYN flag,    The SYN has no data; it's
     gateway's MAC      93.184.x.x  seq=random   the start of the handshake (Ch.7)
     (ARP, Ch.3)        (the SERVER, Ch.4)       (Ch.7)  with the random ISN (Ch.7).
```

Note the Chapter 2 insight made real: the **destination MAC is the gateway** (one hop away, Chapter 3) but the **destination IP is the server** (end-to-end, Chapter 4). The frame is a local taxi to the router; the IP packet is the through-traveler.

**The physical layer** (Chapter 1). The NIC's PHY line-codes the frame's bits onto the Wi-Fi radio signal (or copper, if wired) — voltages/RF modulation, the clock-recovery-friendly encoding of Chapter 1 — and the bits propagate to the router at ~two-thirds the speed of light. The first byte is on its way.

---

## 19.4 Phase 3 — Across the Internet

**The router: NAT and forwarding** (Chapters 4-5). The home router receives the frame, strips the Wi-Fi header (Chapter 2 decapsulation), sees an IP packet destined for the public internet. It does two things:
- **NAT** (Chapter 5): rewrites the source IP from `192.168.1.20` (private) to its own public IP, and the source port to a tracked value, recording the mapping so the reply can be reversed. Your private address is now hidden behind one public IP.
- **Forwarding** (Chapter 5): longest-prefix match on the destination → forward toward the ISP. It wraps the IP packet in a *new* link-layer frame for the next hop (Chapter 2: the IP packet survives, the frame is rebuilt) and sends it on.

**Hop by hop across autonomous systems** (Chapters 4-5). The packet now traverses the internet — your ISP's network, possibly a transit carrier, into the CDN's network — a sequence of routers, each:
- decrementing the **TTL** (Chapter 4 — and if it hit zero, you'd get the ICMP that `traceroute` exploits, Chapter 5),
- doing **longest-prefix-match forwarding** (Chapter 5) toward the destination,
- the path chosen by **BGP** (Chapter 5) — and remember, that path follows *business relationships*, not just geography (Chapter 5's economic routing). Each AS forwards based on its BGP-learned routes.

Because the destination is an **anycast** CDN address (Chapter 5), BGP naturally routes the packet to the *nearest* CDN edge — a server perhaps a few milliseconds away, not the distant origin. This is the speed-of-light mitigation of Chapter 1 realized through routing: you're not crossing the country; you're reaching a nearby edge.

---

## 19.5 Phase 4 — The Three Handshakes

The packet reaches the CDN edge server (which terminates the connection on behalf of `example.com`). Now the connection setup — and the latency cost of these handshakes is *the* dominant factor in how fast the page starts loading (Chapter 1's "round trips are the master metric").

**Handshake 1 — TCP** (Chapter 7):

```
   SYN ──────────────────────────────────►  (you → edge: "let's connect", random ISN)
        ◄────────────────────────────── SYN+ACK  (edge → you: "ok, my ISN, ack yours")
   ACK ──────────────────────────────────►  (you → edge: "ack yours") → ESTABLISHED
   Cost: 1 RTT. The edge's kernel completed this; the connection is now in its accept
   queue (Ch.10), and accept() hands it to the server's event loop (Ch.10).
```

**Handshake 2 — TLS 1.3** (Chapter 12):

```
   ClientHello (+ my ECDHE key, SNI="example.com") ──►  (SNI tells the edge WHICH cert
                                                          to present, Ch.12 — it hosts many sites)
        ◄── ServerHello (+ ECDHE key), {Certificate, Finished}  (edge proves identity via
                                                          its CA-signed cert, Ch.12)
   {Finished} + application data ──►                     (you verify the cert chain to a
                                                          root in your trust store, Ch.12)
   Cost: 1 RTT (TLS 1.3, Ch.12). Both sides now share symmetric keys; everything from
   here is encrypted (Ch.12). Forward secrecy via ephemeral ECDHE (Ch.12).
```

The browser **verifies the certificate** (Chapter 12): the edge presented a cert for `example.com`, signed by an intermediate, chaining to a root CA in the browser's trust store; the browser checks the chain, that the domain matches, that it's not expired, and that the server holds the private key. Only then does the padlock appear and the connection proceed. (This is the "trust a stranger" machinery of Chapter 12 — the hard part.)

So far: **2 RTTs** spent (1 TCP + 1 TLS). On a 30ms-RTT path to the edge, that's ~60ms before the first HTTP byte. (Had this been a *repeat* visit, TLS 1.3 session resumption or 0-RTT — Chapter 12 — would've cut it; over HTTP/3/QUIC — Chapter 14 — the TCP+TLS handshakes would've fused into 1 RTT, or 0 on resumption. The whole latency arc of the book, right here.)

**Handshake 3 — HTTP (well, the request)** (Chapters 11, 13). Modern browsers negotiate **HTTP/2** during the TLS handshake (via ALPN — Application-Layer Protocol Negotiation, an extension in the TLS ClientHello). So the connection speaks HTTP/2 (Chapter 13). The browser sends the request as an HTTP/2 `HEADERS` frame on stream 1:

```
   HTTP/2 HEADERS frame, stream 1 (Ch.13), HPACK-compressed (Ch.13):
     :method: GET    :path: /index.html    :authority: example.com    :scheme: https
     (plus accept, user-agent, cookie — all HPACK-compressed)
   Carried inside the now-ENCRYPTED TLS records (Ch.12), inside TCP segments (Ch.7),
   inside IP packets (Ch.4), inside frames (Ch.3) — the full nesting doll (Ch.2).
```

---

## 19.6 Phase 5 — The Server Side

The request arrives at the CDN edge. What happens depends on caching (Chapter 11):

**Cache hit (the common case for static content):** the edge has `/index.html` cached (Chapter 11's HTTP caching, applied at the CDN edge, Chapter 17). It serves it *immediately* from the nearby edge — no trip to the origin. This is the entire point of the CDN: most requests never cross the country (Chapters 1, 17). Response sent in ~one RTT to the nearby edge.

**Cache miss (or dynamic content):** the edge must fetch from the origin. Behind `example.com` is typically (Chapter 17):

```
   CDN edge ──► [ L7 LOAD BALANCER ] ──► one of N web servers
       (cache miss)    │
                       ├─ terminates TLS again / re-encrypts (mTLS, Ch.17)
                       ├─ reads the HTTP request (L7 — routes by path/host, Ch.17)
                       ├─ picks a healthy backend (health checks, Ch.17; least-conn, Ch.17)
                       ├─ over a POOLED warm connection (Ch.17 — no fresh handshake)
                       ▼
                   web server: runs the app, maybe queries a database (its own network
                   request — another TCP connection, maybe gRPC/protobuf to a service,
                   Ch.15), renders /index.html, returns it.
```

The load balancer (Chapter 17) picks a healthy backend (it knows which are healthy via health checks, and balances by least-connections or consistent hashing), forwards the request over a warm pooled connection (Chapter 17 — amortizing the handshake), and the web server generates the response — possibly making its *own* downstream network calls (to a database, or to other microservices via gRPC/protobuf, Chapter 15, each a request like this one recursively). The response travels back up: web server → load balancer → CDN edge (which caches it per the `Cache-Control` headers, Chapter 11, for next time) → toward you.

---

## 19.7 Phase 6 — The Response Comes Back Up the Stack

The response — `200 OK` with the HTML — now travels back, and it's the entire outbound journey in reverse (the symmetry of Chapter 2's encapsulation/decapsulation):

```
   The HTML response, journeying back:

   edge server: HTTP/2 HEADERS frame (200 OK) + DATA frames (the HTML), stream 1 (Ch.13)
        │  HPACK-compressed headers (Ch.13)
        ▼  encrypted into TLS records (Ch.12)
        ▼  split into TCP segments, sequence-numbered (Ch.7) — and if a segment is lost,
        ▼  retransmitted (Ch.7); congestion control paces the sending (Ch.8)
        ▼  each segment in an IP packet (Ch.4), routed back via BGP (Ch.5), through NAT
        ▼  at your router (which reverses the mapping → back to 192.168.1.20, Ch.5)
        ▼  in link-layer frames, hop by hop (Ch.3), over the physical medium (Ch.1)
        │
   YOUR LAPTOP receives the packets and decapsulates UP the stack (Ch.2):
        ▲  NIC checks frame CRC (Ch.1,3), strips Wi-Fi header → IP
        ▲  IP checks destination, strips header → TCP
        ▲  TCP reassembles segments IN ORDER by sequence number (Ch.7), ACKs them (Ch.7),
        ▲     places the bytes in the socket receive buffer (Ch.10)
        ▲  TLS decrypts the records → plaintext HTTP/2 frames (Ch.12)
        ▲  HTTP/2 demultiplexes the frames by stream ID, HPACK-decompresses (Ch.13)
        ▲  the browser gets: 200 OK + the HTML bytes
```

Every mechanism in the book fires on the way back: TCP's reliability reassembles the segments in order despite any reordering (Chapter 7), retransmits any losses (Chapter 7), and ACKs what it receives (Chapter 7); congestion control governs the rate (Chapter 8); TLS decrypts (Chapter 12); HTTP/2 demultiplexes and decompresses (Chapter 13); and the socket buffers (Chapter 10) hold the bytes until the browser reads them. The `read()` returns the HTML.

---

## 19.8 Phase 7 — From Bytes to Pixels (and More Requests)

The browser now has the HTML, and the story continues (briefly, since rendering is beyond our scope but the *networking* isn't done):

**Parsing reveals more resources.** The browser parses `/index.html` and finds references — `<link>` to CSS, `<script>` to JS, `<img>` to images, fonts. *Each is another request*, and here HTTP/2's multiplexing (Chapter 13) shines: the browser sends all those requests as **concurrent streams over the same already-warm connection** — no new TCP handshake, no new TLS handshake, no new slow-start (Chapters 7, 8, 12), and no head-of-line blocking at the HTTP layer (Chapter 13). One warm connection, many multiplexed requests — exactly what HTTP/2 was built for, and a world away from HTTP/1.0's connection-per-request (Chapter 11).

**Caching shortcuts the repeats.** Many of those resources are cached from prior visits (Chapter 11) — served from the browser cache with *zero* network round trips (the fastest request is the one you never make, Chapter 11). Others get `304 Not Modified` revalidations (Chapter 11). The CDN edge serves the rest from nearby (Chapter 17).

**The page renders.** The browser assembles the HTML, CSS, JS, and images into the rendered page. From your perspective, you pressed enter and the page appeared. Underneath, the journey was: a URL parsed, a name resolved through a global distributed database, a route chosen across autonomous networks by economic policy, three handshakes establishing a reliable encrypted multiplexed channel, a request demultiplexed through a CDN and load balancer to a server, a response carried back through every layer with reliability and congestion control and decryption and decompression, and dozens of follow-up resources multiplexed over the warm connection — all in a few hundred milliseconds, governed at the floor by the speed of light.

---

## 19.9 The Whole Journey, at a Glance

Here is the entire trace as one map — the book on a page:

```
   KEYSTROKE
      │
      ├─ Parse URL, HSTS check ............................ Ch.11, 12
      ├─ DNS: name → IP (stub→recursive→root→TLD→auth) .... Ch.9 (anycast edge, Ch.5)
      │
   GET THE PACKET OUT:
      ├─ Routing: longest-prefix → default route → gateway  Ch.4, 5
      ├─ ARP: find gateway's MAC ......................... Ch.3
      ├─ Encapsulate: Eth(dst=gateway) / IP(dst=server) /   Ch.2
      │   TCP(SYN) ....................................... Ch.7
      ├─ PHY: line-code onto the wire, ~2/3 c ............ Ch.1
      │
   ACROSS THE INTERNET:
      ├─ Router: NAT + longest-prefix forwarding ......... Ch.5
      ├─ Hop by hop: TTL--, BGP-chosen path .............. Ch.4, 5
      ├─ Anycast → nearest CDN edge ..................... Ch.5, 17
      │
   THREE HANDSHAKES (the latency that matters):
      ├─ TCP handshake (SYN/SYN-ACK/ACK) .. 1 RTT ........ Ch.7
      ├─ TLS 1.3 handshake (+ cert verify, SNI, ALPN) 1 RTT Ch.12
      ├─ HTTP/2 request (HEADERS frame, HPACK) .......... Ch.13
      │    (or: QUIC fuses TCP+TLS → 1/0 RTT ............. Ch.14)
      │
   SERVER SIDE:
      ├─ CDN cache hit → served from edge ............... Ch.11, 17
      ├─ ...or miss → L7 LB → healthy backend → app → DB . Ch.17, 15
      │
   RESPONSE BACK UP THE STACK:
      ├─ HTTP/2 frames → TLS encrypt → TCP segments ..... Ch.13, 12, 7
      ├─ reliability (reorder/retransmit/ACK) + cong ctrl  Ch.7, 8
      ├─ IP routing back, NAT reverse .................... Ch.4, 5
      ├─ decapsulate up: frame→IP→TCP→TLS→HTTP/2→bytes ... Ch.2-13
      │
   BYTES TO PIXELS:
      ├─ parse HTML → more resources, multiplexed (warm) . Ch.13
      ├─ cached resources: 0 RTT; others: 304 / edge ..... Ch.11, 17
      └─ RENDER. You pressed enter; the page appeared.
```

Every line is a chapter. Every chapter was a mechanism. Every mechanism was an engineer solving a concrete problem under concrete constraints — and now they're all yours. That's the book.

---

## Key Takeaways

1. **"What happens when you type a URL and press enter" is the whole book in one question, and it's fractal** — answerable in 30 seconds or 30 minutes, with depth revealing understanding. The complete answer traverses every layer: URL parsing (Ch. 11), DNS (Ch. 9), routing and ARP (Ch. 3-5), three handshakes (TCP Ch. 7, TLS Ch. 12, HTTP Ch. 11/13), the server side (CDN/LB Ch. 17), and the response back up the stack.

2. **The destination MAC is the gateway (one hop) while the destination IP is the server (end-to-end)** — Chapter 2's encapsulation made concrete: the link-layer frame is a local taxi rebuilt at every hop, the IP packet is the through-traveler. This single fact, understood, demonstrates real grasp of the L2/L3 distinction.

3. **The three handshakes (TCP 1 RTT, TLS 1.3 1 RTT, then the HTTP request) are the dominant startup latency**, which is why the entire book's latency arc — keep-alive (Ch. 11), TLS 1.3's 1-RTT (Ch. 12), HTTP/2's one warm multiplexed connection (Ch. 13), QUIC's fused 0/1-RTT (Ch. 14), and the CDN moving the endpoint closer (Ch. 1, 17) — all exist to attack those round trips against the speed-of-light floor (Ch. 1).

4. **The CDN + anycast + DNS combination means most requests never cross the country** — DNS resolves you to a nearby anycast edge (Ch. 5, 9), which serves cached content (Ch. 11) a few milliseconds away (Ch. 1, 17). The page-load is fast because the distance was eliminated, not crossed faster.

5. **The response journey is the request journey in reverse** — the symmetry of encapsulation/decapsulation (Ch. 2): down the stack on the way out (HTTP→TLS→TCP→IP→frame→wire), up the stack on the way in (wire→frame→IP→TCP→TLS→HTTP), with TCP reliability/ordering/congestion control (Ch. 7-8), TLS decryption (Ch. 12), and HTTP/2 demultiplexing (Ch. 13) all firing on the return.

6. **The follow-up resources reveal HTTP/2's payoff:** dozens of CSS/JS/image requests multiplexed as concurrent streams over the *one warm connection* — no new handshakes, no new slow-start, no HTTP-layer head-of-line blocking — with cached resources served at zero round trips. This is the difference between modern web performance and HTTP/1.0's connection-per-request.

7. **Rehearsing this trace out loud is the single best way to consolidate the book**, because it forces you to connect every layer to its neighbors — and it's the most complete answer to the most famous question in the field.

---

## The Interview Drill (there is only one)

**Q. What happens when you type `https://example.com` into your browser and press enter? Go as deep as you can.**

*Model answer (the senior/staff version — calibrate depth to the interviewer's cues):* The browser parses the URL — scheme https means TLS on port 443 — and checks HSTS to force HTTPS. It needs example.com's IP, so it does DNS resolution: browser and OS caches miss, so the stub resolver asks a recursive resolver, which walks the hierarchy iteratively — root, then .com TLD, then example.com's authoritative server — returning an IP that, because example.com is behind a CDN, is an anycast address routing me toward the nearest edge. Now the OS opens a TCP connection to that IP on 443: it does a longest-prefix-match routing lookup, finds the destination isn't local so it uses the default route to the gateway, ARPs for the gateway's MAC, and builds the packet — note the destination MAC is the gateway (one hop) but the destination IP is the server (end-to-end), the frame being a local taxi and the IP packet the through-traveler. The NIC line-codes it onto the wire. The home router NATs the source address and forwards it; the packet crosses the internet hop by hop, each router decrementing TTL and forwarding by longest-prefix match along a BGP-chosen path that follows business relationships, anycast steering me to the nearest CDN edge. Then three handshakes: TCP (SYN/SYN-ACK/ACK, 1 RTT), TLS 1.3 (ClientHello with my ECDHE key, SNI naming the site and ALPN negotiating HTTP/2; the server returns its key and CA-signed certificate, which I verify up the chain to a trusted root, checking domain and expiry and that it holds the private key — 1 RTT, with forward secrecy from ephemeral ECDHE), and then the HTTP/2 request as a HEADERS frame on stream 1, HPACK-compressed, inside encrypted TLS records inside TCP segments inside IP packets inside frames. At the edge: a cache hit serves index.html immediately from nearby; a miss goes through an L7 load balancer that picks a healthy backend over a warm pooled connection to a web server, which may make its own downstream calls (a database, or gRPC to other services). The response travels back — HTTP/2 frames, TLS-encrypted, TCP-segmented with reliability and congestion control, IP-routed back through the reversed NAT — and I decapsulate up the stack: frame to IP to TCP (reassembled in order, ACKed) to TLS (decrypted) to HTTP/2 (demultiplexed, decompressed), yielding the HTML. Parsing it reveals more resources — CSS, JS, images — which I fetch as concurrent multiplexed streams over the same warm connection, no new handshakes, with cached ones served at zero round trips, and the page renders. The whole thing is governed at the floor by the speed of light, which is why everything in the path — keep-alive, TLS 1.3's single round trip, HTTP/2 multiplexing, QUIC's fused handshake, and the CDN itself — exists to minimize round trips. *(And then go deeper on whichever layer they probe — that's where the book pays off.)*

---

*Previous: [Chapter 18 — Performance and Observability](./18-performance-and-observability.md) | Next: [Appendix A — Glossary and RFC Index](./A-glossary.md)*
