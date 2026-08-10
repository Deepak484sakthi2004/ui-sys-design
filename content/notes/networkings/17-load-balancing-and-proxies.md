# Chapter 17 — Load Balancing and Proxies

> *A single server is two things you can't ship to production: a single point of failure and a hard throughput ceiling. The moment you need more than one server — for capacity, for redundancy, for zero-downtime deploys — you need something in front of them deciding which server each request goes to. That something is a **load balancer**, and more generally a **proxy**: the most important and least-understood box in modern infrastructure. Every request you've traced through this book — through DNS, TCP, TLS, HTTP — actually hits one or more proxies before it reaches the server that handles it. This chapter is about that layer: what it sees, what it can do, and why the entire shape of modern systems (CDNs, service meshes, API gateways, zero-downtime deploys) is built on it.*

We've built the whole stack bottom-up and reached HTTP, gRPC, WebSockets — the protocols services speak. But real systems don't expose a single server speaking those protocols directly to the world. They put **proxies** in front: load balancers spreading traffic across a fleet, reverse proxies terminating TLS and routing by path, CDNs caching content at the edge, API gateways enforcing auth and rate limits, sidecars forming a service mesh. Understanding proxies is understanding how systems are actually shaped at scale — and it ties together nearly everything in this book, because a proxy's power comes precisely from *which layer it operates at* (the OSI numbers of Chapter 2 made operational).

This is a flagship chapter because the proxy is where the rubber meets the road for scale and reliability. We'll cover the fundamental L4-vs-L7 distinction (and what each can and can't do), balancing algorithms (including consistent hashing — a genuinely important idea), connection pooling and TLS termination, the real systems (Nginx, HAProxy, Envoy), and reverse proxies / CDNs / edge — closing the loop on the "beat the speed of light by moving content closer" thread that started in Chapter 1.

---

## 17.1 Why Proxies Exist: The Indirection That Enables Everything

A proxy is an intermediary that sits between client and server, receiving requests and forwarding them (perhaps after inspecting, modifying, routing, or caching). That one layer of indirection buys an enormous amount, and it's worth enumerating because every item is a reason proxies are everywhere:

```
   client ──► [ PROXY / LOAD BALANCER ] ──► one of many backend servers
                       │
   What the indirection buys:
   • SCALE:        spread requests across N servers (no single throughput ceiling)
   • REDUNDANCY:   a dead server is removed from rotation; requests route to live ones
   • ZERO-DOWNTIME DEPLOY: drain a server, update it, return it — no client sees downtime
   • ABSTRACTION:  clients hit ONE stable address; the fleet behind it changes freely
   • TLS TERMINATION: decrypt once at the proxy; backends speak plain HTTP internally
   • CACHING:      serve repeated content without bothering the backend (Ch.11)
   • SECURITY:     a chokepoint for auth, rate limiting, WAF, DDoS absorption
   • OBSERVABILITY: one place to log, trace, and measure all traffic
```

The deepest of these is **abstraction/indirection**: clients connect to one stable endpoint (a load balancer's IP, a DNS name), and behind it the actual servers can be added, removed, replaced, scaled, and deployed *without the client ever knowing*. This decoupling — clients see a stable front, operators change the back freely — is what makes elastic scaling, rolling deploys, and self-healing possible. The proxy is the seam that lets the front and back of a system evolve independently, exactly as layering let protocol layers evolve independently (Chapter 2). It's the same principle — a stable interface hiding a changing implementation — applied to infrastructure topology.

And critically: **what a proxy can *do* depends entirely on what layer it operates at**, which is the subject of the next section and the single most important distinction in this chapter.

---

## 17.2 L4 vs L7: The Defining Distinction

The most important thing to understand about any load balancer or proxy is **which layer it operates at**, because that determines what it can *see* and therefore what it can *do*. The two big categories are **L4 (transport-layer)** and **L7 (application-layer)** — the OSI numbers of Chapter 2, now operational.

```
   L4 (TRANSPORT) load balancer — operates on TCP/UDP (Ch.6-7):
   ┌──────────────────────────────────────────────────────────────┐
   │ Sees:  IP addresses + ports (the 4-tuple). NOT the content.    │
   │ Does:  forwards whole TCP connections to a backend, by 4-tuple.│
   │        Picks a backend at connection time; ALL of that          │
   │        connection's bytes go to that one backend.               │
   │ Can't: read URLs, headers, cookies — it's all opaque bytes      │
   │        (especially if TLS-encrypted — it can't decrypt).        │
   │ Pros:  BLAZING fast (just moves packets/connections), protocol- │
   │        agnostic (works for any TCP/UDP traffic, not just HTTP). │
   └──────────────────────────────────────────────────────────────┘

   L7 (APPLICATION) load balancer — operates on HTTP/gRPC (Ch.11-15):
   ┌──────────────────────────────────────────────────────────────┐
   │ Sees:  the full HTTP request — method, URL path, headers,      │
   │        cookies, body. (Terminates TLS to read it, §17.5.)       │
   │ Does:  routes by CONTENT — /api → backend A, /images → CDN,     │
   │        Host: x.com → fleet X; per-REQUEST balancing; retries,   │
   │        rewrites, auth, rate limiting, A/B splits.               │
   │ Can't: be as fast as L4 (it parses every request); is          │
   │        protocol-specific (it speaks HTTP).                       │
   │ Pros:  intelligent — it understands the application.           │
   └──────────────────────────────────────────────────────────────┘
```

The trade-off is stark and worth stating crisply: **L4 is fast and dumb; L7 is smart and slower.**

- An **L4 load balancer** sees only the TCP/UDP layer — IP addresses and ports. It picks a backend when the connection is established and forwards *all* of that connection's bytes there, never looking inside. It can't read the URL or headers (they're application-layer, and often TLS-encrypted, which L4 can't decrypt). But because it does almost nothing per packet (just forwarding by four-tuple), it's *extremely* fast and handles enormous throughput, and it works for *any* TCP/UDP protocol — databases, custom protocols, anything. Examples: AWS Network Load Balancer, IPVS, the L4 layer of cloud load balancers.

- An **L7 load balancer** terminates the connection (and TLS), reads the full HTTP request, and routes based on *content* — path, host header, cookies, method. This unlocks intelligent behavior: route `/api/*` to the API fleet and `/static/*` to a cache, do per-request load balancing (not just per-connection), retry failed requests, rewrite headers, enforce auth and rate limits, split traffic for A/B tests or canary deploys. The cost: it parses every request (slower than L4) and it's HTTP-specific. Examples: Nginx, HAProxy (in HTTP mode), Envoy, AWS Application Load Balancer.

**The gRPC connection to Chapter 15.** Recall the gRPC load-balancing gotcha (§15.5): gRPC uses long-lived, multiplexed HTTP/2 connections, so an **L4** load balancer — which balances *connections* — pins all of a client's requests to one backend (one connection = one backend), defeating load balancing. You need an **L7** load balancer that understands HTTP/2 to balance the individual *streams/requests* within the connection across backends. This is the concrete payoff of the L4/L7 distinction: the layer the balancer operates at determines whether multiplexed gRPC gets balanced per-request or pinned per-connection. The distinction isn't academic — it directly decides whether your gRPC fleet is evenly loaded.

> **The decision in one line:** use **L4** when you need raw speed, protocol-agnosticism (non-HTTP traffic), or you don't need to look inside (and especially when you want end-to-end TLS where the balancer *shouldn't* decrypt). Use **L7** when you need content-based routing, per-request balancing, retries, or any HTTP-aware policy. Real architectures often use *both*: an L4 balancer at the edge for raw throughput and DDoS absorption, fanning out to L7 balancers that do the intelligent routing. Layered proxies, each at the layer that fits its job — the OSI model, deployed.

---

## 17.3 Balancing Algorithms (Including Consistent Hashing)

Once a load balancer has a pool of backends, *how* does it choose one per request/connection? The algorithms, from simple to important:

**Round-robin.** Cycle through backends in order: 1, 2, 3, 1, 2, 3... Simple, fair when all backends and requests are equal. Weakness: it ignores that some requests are heavy and some backends are slower — it can send a heavy request to an already-busy server.

**Least-connections.** Send the next request to the backend with the *fewest active connections* — a proxy for "least busy." Better than round-robin when request durations vary (a backend stuck on slow requests accumulates connections and gets fewer new ones). A solid default for L7.

**Weighted** variants — assign weights so beefier servers get proportionally more traffic (useful with heterogeneous hardware, or to gradually shift traffic during a canary deploy).

**Random (and "power of two choices").** Pure random is surprisingly decent. The elegant refinement is **"power of two choices"**: pick *two* backends at random and send to the less-loaded of the two. This simple tweak gets *most* of the benefit of full least-connections tracking with almost none of the coordination cost — a beautiful result from probability theory (it exponentially reduces the maximum load versus pure random). It's widely used in practice (e.g. in Nginx, and it's a known trick in distributed systems generally).

**Consistent hashing — the important one.** Sometimes you need the *same* request (or client, or key) to *consistently* go to the *same* backend — for cache affinity (so a cache on that backend stays warm), for sticky sessions, or for sharding (key X always lives on shard Y). The naive approach — `backend = hash(key) % N` — has a catastrophic flaw: when N changes (a server is added or removed), *almost every key remaps* to a different backend, blowing away every cache and reshuffling every session. **Consistent hashing** solves this:

```
   Naive  hash(key) % N :  add/remove ONE server → N changes → nearly ALL keys remap.
                           (cache cold everywhere, sessions scrambled — a disaster at scale)

   Consistent hashing: place servers AND keys on a circular hash ring (0 ... 2^32).
   Each key belongs to the next server CLOCKWISE on the ring.

                    [Server A]
                   ╱           ╲
            key3 •               • key1 → Server B (next clockwise)
                 │   the ring     │
         [Server C]               [Server B]
                 │                 │
            key2 •───────• key4───╯
                   ╲           ╱
                    (key2 → C, key4 → B...)

   Add Server D between B and C: ONLY the keys that fall in the B→D arc move to D.
   Everything else stays put. Adding/removing a server remaps only ~1/N of the keys,
   not all of them. (Virtual nodes — each server placed at many ring points — smooth
   out the distribution so load is even.)
```

Consistent hashing places both servers and keys on a hash *ring*; each key is served by the next server clockwise. When a server is added or removed, only the keys in its immediate arc move — roughly *1/N* of the keys, not all of them. This is *the* algorithm for distributed caches (Memcached, Redis Cluster), CDN request routing, sharded databases, and any system where you want stable key→server mapping that survives membership changes. "Virtual nodes" (placing each physical server at many points on the ring) smooth the distribution so load is even and removing one server spreads its keys across many others rather than dumping them all on one neighbor. Consistent hashing is a genuinely important distributed-systems idea — it shows up far beyond load balancing — and being able to explain *why naive modulo fails and consistent hashing fixes it* is a strong interview signal.

---

## 17.4 Health Checks and the Self-Healing Fleet

A load balancer's reliability superpower is that it can *stop sending traffic to broken backends* — but only if it knows which are broken. **Health checks** are how it knows:

```
   Health checking — the load balancer continuously probes each backend:

   • ACTIVE health check: the LB periodically sends a probe (e.g. GET /health) to each
     backend. Healthy → keep in rotation. Fails N times → REMOVE from rotation (stop
     sending traffic). Recovers → add back. The fleet self-heals.

   • PASSIVE health check (outlier detection): watch real traffic — if a backend starts
     returning errors / timing out, eject it without a separate probe. (Envoy's
     "outlier detection.") Catches failures the active probe might miss.

   Health check depth matters:
     shallow ("is the port open?")  → misses a process that's up but broken
     deep    ("GET /health that checks DB connectivity, etc.") → catches real readiness
     ...but too-deep checks can cause CASCADING failure: if /health checks a shared DB
     and the DB hiccups, ALL backends fail health checks simultaneously and the LB
     removes the ENTIRE fleet → total outage from a transient blip. Tune carefully.
```

This is how a fleet *self-heals*: a server crashes or hangs, fails its health checks, and the load balancer routes around it automatically — no human paged at 3am (yet). It's also the mechanism behind **zero-downtime deploys**: to update a server, you *drain* it (mark it unhealthy / stop sending new requests, let in-flight ones finish), update it, let it pass health checks, and return it to rotation — repeating across the fleet (a rolling deploy). The client never sees downtime because there's always a healthy server in rotation.

The subtlety worth knowing — and a real production trap — is **health-check depth**. A *shallow* check ("is the TCP port open?") is cheap but misses a process that's accepting connections while being internally broken. A *deep* check ("GET /health that verifies database connectivity, downstream dependencies, etc.") catches real un-readiness — but if every backend's deep health check probes a *shared* dependency (the same database), and that dependency has a transient hiccup, *every* backend fails its health check *simultaneously*, the load balancer removes the *entire* fleet, and a brief database blip becomes a total outage. This cascading-failure-via-health-check is a classic, painful incident pattern. The lesson: health checks must distinguish "this instance is broken" (eject it) from "a shared dependency is degraded" (don't eject everyone) — and "readiness" (can take traffic now) is often usefully separated from "liveness" (is the process alive at all), which is exactly the readiness/liveness distinction Kubernetes formalizes.

---

## 17.5 TLS Termination and Connection Pooling

Two more proxy capabilities that are everywhere in real systems:

**TLS termination.** Recall TLS's cost (Chapter 12): the handshake is expensive (asymmetric crypto, round trips), and managing certificates is operational work. Rather than have every backend server do TLS, the proxy **terminates TLS** — it holds the certificates, decrypts incoming HTTPS at the edge, and forwards *plain HTTP* to the backends over the trusted internal network:

```
   TLS termination at the proxy:

   client ──HTTPS (encrypted)──► [ PROXY terminates TLS ] ──plain HTTP──► backends
              (Ch.12 handshake)        holds the certs              (trusted internal net)

   Benefits: certs managed in ONE place (not on every backend); backends are simpler
   (no TLS); the proxy can READ the request (needed for L7 routing — §17.2); TLS
   compute is centralized (often hardware-accelerated).

   Variants:
   • TLS PASSTHROUGH: L4 proxy forwards encrypted bytes without decrypting (when the
     backend must do TLS itself, e.g. end-to-end encryption requirements).
   • RE-ENCRYPTION (mTLS): proxy decrypts, then RE-encrypts to the backend — for zero-
     trust internal networks (service mesh, below) where even internal hops are encrypted.
```

TLS termination is *why* L7 load balancing is even possible (you must decrypt to read the HTTP), and it centralizes the certificate-management and crypto-compute burden. The variants matter: **passthrough** (L4, never decrypt — for true end-to-end encryption), and **re-encryption** (decrypt then re-encrypt to the backend — for zero-trust mesh where internal traffic must also be encrypted, via mutual TLS / mTLS).

**Connection pooling.** Recall the cost of opening connections (TCP handshake + TLS handshake + slow-start, Chapters 7-8-12). A proxy handling many client requests to a backend shouldn't open a fresh backend connection per request — it maintains a **pool** of warm, reused connections to each backend (keep-alive, Chapter 11), multiplexing many client requests over them. This amortizes the connection-setup cost across thousands of requests and keeps the backend connections past slow start (warm, fast). It's the server-side counterpart to the client connection pooling from Chapter 11, and it's a major reason a proxy in front of your backends can *improve* performance rather than just add a hop — it absorbs the connection-setup cost and presents the backend with a stable set of warm connections. (Connection pooling is also why the proxy can do connection-level optimizations the individual clients can't — coalescing, HTTP/2 to HTTP/1 translation, etc.)

---

## 17.6 The Real Systems: Nginx, HAProxy, Envoy

It's worth knowing the three proxies you'll actually encounter and what distinguishes them, because their architectures encode the lessons of this book:

**Nginx.** The ubiquitous web server and reverse proxy. Its architecture is the **event loop from Chapter 10** — a master process plus worker processes (one per CPU core), each running an `epoll` event loop handling thousands of connections (using `SO_REUSEPORT` to share the listening port across workers, exactly as Chapter 10 described). It excels as a reverse proxy, static-file server (using `sendfile` zero-copy, Chapter 10), TLS terminator, and L7 router, configured via its declarative config files. Nginx *is* the Chapter 10 architecture in production — when you understand the epoll event loop, you understand how Nginx serves hundreds of thousands of connections per worker.

**HAProxy.** A specialized, extremely high-performance load balancer (the "HA" is High Availability). Also event-driven (single-threaded event loop per core), laser-focused on load balancing and proxying (L4 and L7), with sophisticated health checking, balancing algorithms, and observability. Where Nginx is a general web server that also proxies, HAProxy is a proxy/load balancer specialist — often chosen when load balancing is the *primary* job and you want its depth of LB features.

**Envoy.** The modern, cloud-native proxy that powers the **service mesh** era. Envoy's architecture (listeners → filter chains → clusters) is explicitly designed for dynamic, programmable, observable proxying: it can be reconfigured *at runtime* via APIs (the "xDS" control plane) without restarts, has deep L7 support (HTTP/2, gRPC — solving the gRPC LB problem of §17.2/15.5), rich observability (metrics, tracing, logging built in), and advanced traffic management (retries, circuit breaking, outlier detection, canary routing). It's the data plane of service meshes like Istio: a copy of Envoy runs as a **sidecar** next to *every* service instance, and *all* service-to-service traffic flows through these sidecars, which handle mTLS (§17.5), load balancing, retries, observability, and policy — moving all that cross-cutting networking logic *out* of application code and into the mesh. The service mesh is "what if every service talked to every other service through a smart L7 proxy" — and Envoy is that proxy.

```
   The service mesh (Envoy sidecars):

   ┌─ Service A ──────┐         ┌─ Service B ──────┐
   │ app  ──► [Envoy] │──mTLS──►│ [Envoy] ──► app  │
   └──────────────────┘         └──────────────────┘
        every service has a sidecar proxy; ALL traffic goes proxy→proxy.
        The sidecars handle: mTLS, load balancing, retries, timeouts, circuit breaking,
        tracing, metrics — so the application code doesn't have to. Networking policy
        becomes infrastructure, configured centrally (the control plane).
```

The trajectory across these three traces the evolution of the proxy: Nginx (web server that proxies) → HAProxy (dedicated load balancer) → Envoy (programmable, observable, mesh-native proxy). Each reflects the era's needs, and all three are built on the same foundations this book developed — event loops (Ch. 10), HTTP/1-2-3 (Ch. 11-14), TLS (Ch. 12), the L4/L7 distinction (Ch. 2). The proxy is where the whole stack converges into infrastructure.

---

## 17.7 Reverse Proxies, CDNs, and the Edge

Finally, the thread that started in Chapter 1: **beating the speed of light by moving content closer.** A **reverse proxy** sits in front of *your* servers (representing the server to clients — versus a *forward* proxy that represents clients to servers, like a corporate egress proxy). Everything we've discussed — load balancing, TLS termination, caching, routing — is reverse-proxy behavior. The **CDN (Content Delivery Network)** is the reverse proxy taken to its geographic extreme:

```
   A CDN — reverse-proxy caches distributed worldwide (the "edge"):

   User in Tokyo ──► CDN edge in Tokyo (cache HIT → served in ~5ms, never touches origin)
   User in Paris ──► CDN edge in Paris (cache HIT → served locally)
   User in Sydney ─► CDN edge in Sydney
                          │ (cache MISS → fetch from origin, cache it, serve)
                          ▼
                     ORIGIN server (one location, e.g. Virginia)

   The CDN puts cached copies of your content at hundreds of "edge" locations near
   users. Most requests are served from a NEARBY edge — never crossing the planet
   to your origin. Routing users to the nearest edge uses ANYCAST (Ch.5) and/or GeoDNS.
```

This is the literal realization of Chapter 1's lesson: *you cannot make Sydney-to-Virginia faster than ~80ms one-way (the speed of light), so you don't — you put a copy of the content in Sydney.* A CDN is a globally distributed fleet of reverse-proxy caches ("edge" locations, often hundreds worldwide), each caching your content (Chapter 11's HTTP caching, applied geographically). A user's request is routed (via **anycast**, Chapter 5, and/or GeoDNS, Chapter 9) to the *nearest* edge, which serves cached content locally — a few milliseconds away instead of hundreds. Only cache misses travel to your origin. The CDN is where Chapter 1 (latency floor), Chapter 5 (anycast), Chapter 9 (GeoDNS), and Chapter 11 (HTTP caching) all converge into one of the most impactful performance technologies on the internet.

Modern CDNs go further into **edge computing** — running *code* (not just serving cached files) at the edge locations (Cloudflare Workers, Lambda@Edge, Vercel Edge Functions), so dynamic logic also executes close to users. The edge has become a compute platform, extending "move content closer" to "move *computation* closer." But the foundation is the same reverse-proxy-cache idea, distributed globally, beating the speed of light the only way you can — by not having to cross the distance.

> **Closing the arc:** Chapter 1 told you propagation delay is a hard floor set by physics, and that you'd see CDNs as the answer. Here it is. Every layer of this book contributes to that answer: the latency floor (Ch. 1), the routing and anycast that send you to the nearest edge (Ch. 5), the DNS that resolves you there (Ch. 9), the TCP/TLS the edge terminates (Ch. 7, 12), the HTTP caching that makes the edge effective (Ch. 11), and the proxy architecture that makes the edge a programmable platform (this chapter). The CDN is the whole book, deployed at planetary scale, to answer one question physics posed in Chapter 1: *how do you serve a user 16,000 km away quickly?* You move the bytes — and now the code — to within a few milliseconds of them. That's the proxy's ultimate expression.

---

## Key Takeaways

1. **Proxies/load balancers exist for the indirection they provide:** scale (spread load), redundancy (route around failures), zero-downtime deploys (drain/update/return), abstraction (stable front, changeable back), TLS termination, caching, security chokepoint, and observability. The deepest is abstraction — clients see one stable endpoint while the fleet behind changes freely (the Chapter 2 stable-interface principle, applied to topology).

2. **L4 vs L7 is the defining distinction, and it's about what the proxy can *see*.** L4 (transport) sees only IPs/ports, forwards whole connections by four-tuple, is blazing fast and protocol-agnostic, but can't read content (or decrypt TLS). L7 (application) terminates TLS, reads the full HTTP request, and routes by content (path/host/cookies) with per-request balancing, retries, and policy — but is slower and HTTP-specific. The gRPC gotcha (Ch. 15) is the payoff: multiplexed HTTP/2 needs L7 to balance per-request, or L4 pins everything to one backend.

3. **Balancing algorithms:** round-robin (simple, equal), least-connections (good default when request durations vary), weighted (heterogeneous/canary), power-of-two-choices (most of least-connections' benefit, almost no cost). **Consistent hashing** is the important one — it gives stable key→server mapping that survives membership changes (only ~1/N of keys remap when a server is added/removed, vs. naive `hash%N` which remaps nearly *all* keys). It's foundational for distributed caches, sharding, and CDN routing.

4. **Health checks make the fleet self-heal** — failing backends are removed from rotation automatically, and the same mechanism enables zero-downtime rolling deploys (drain → update → return). The trap: too-*deep* health checks that probe a *shared* dependency can eject the *entire* fleet on a transient blip (cascading failure). Distinguish "this instance is broken" from "a shared dependency is degraded," and separate readiness from liveness.

5. **TLS termination** centralizes certs and crypto at the proxy (and is what makes L7 routing possible — you must decrypt to read HTTP); variants are passthrough (L4, never decrypt) and re-encryption/mTLS (for zero-trust meshes). **Connection pooling** keeps warm, reused connections to backends, amortizing handshake + slow-start costs — why a proxy can *improve* performance, not just add a hop.

6. **The real proxies encode this book:** Nginx *is* the Chapter 10 epoll event loop (master + per-core workers, `sendfile`, `SO_REUSEPORT`); HAProxy is the dedicated high-performance load balancer; Envoy is the programmable, observable, mesh-native proxy (listeners → filters → clusters, runtime-reconfigurable) that powers service meshes as a per-service sidecar handling mTLS/LB/retries/observability — moving networking policy out of app code into infrastructure.

7. **The CDN is the reverse proxy at planetary scale and the answer to Chapter 1's speed-of-light floor:** globally distributed reverse-proxy caches at hundreds of edge locations, with users routed to the nearest via anycast (Ch. 5) and GeoDNS (Ch. 9), serving cached content (Ch. 11) a few ms away instead of crossing the planet. Edge computing extends "move content closer" to "move computation closer." The CDN is the whole book deployed to answer "how do you serve a user 16,000 km away quickly?" — you don't cross the distance; you eliminate it.

---

## Interview Drills

**Q1. What's the difference between an L4 and an L7 load balancer, and when do you use each?**
*Model answer:* The difference is which layer they operate at, which determines what they can see and do. An L4 (transport-layer) load balancer sees only the TCP/UDP layer — IP addresses and ports — and forwards whole connections to a backend chosen at connection time by the four-tuple; all of that connection's bytes go to the same backend. It can't read URLs, headers, or cookies (they're application-layer, and often TLS-encrypted, which it can't decrypt), but because it does almost nothing per packet it's extremely fast and works for *any* TCP/UDP protocol, not just HTTP. An L7 (application-layer) load balancer terminates the connection and TLS, parses the full HTTP request, and routes by content — path, host header, cookies — enabling per-request balancing, retries, header rewriting, auth, rate limiting, and canary/A-B splits; the cost is that it parses every request (slower) and is HTTP-specific. Use L4 when you need raw throughput, protocol-agnosticism (databases, custom protocols), or true end-to-end encryption where the balancer shouldn't decrypt. Use L7 when you need content-based routing or any HTTP-aware policy. A concrete consequence: gRPC uses long-lived multiplexed HTTP/2 connections, so an L4 balancer pins all of a client's requests to one backend (one connection = one backend), defeating balancing — you need an L7 balancer that understands HTTP/2 to spread the individual streams. Real architectures often layer both: L4 at the edge for throughput, fanning to L7 for intelligent routing.

**Q2. Why is consistent hashing better than `hash(key) % N` for distributing keys across servers?**
*Model answer:* Because of what happens when the number of servers changes. With `hash(key) % N`, the server for a key depends on N, so when you add or remove a server — changing N — *almost every key* maps to a different server. In a distributed cache that means nearly every cache entry is suddenly on the wrong node (cold caches everywhere, a thundering herd to the origin); in a sharded system it means a massive data reshuffle; in sticky sessions it scrambles everyone's session. That's catastrophic at scale for a routine event like scaling up or a server failing. Consistent hashing fixes this by placing both servers and keys on a circular hash ring, where each key is served by the next server clockwise. When a server is added or removed, only the keys in its immediate arc move to a neighbor — roughly 1/N of the keys — and everything else stays put. So membership changes cause minimal remapping instead of total reshuffling. Virtual nodes (placing each physical server at many points on the ring) smooth the load distribution and ensure a removed server's keys spread across many neighbors rather than dumping on one. It's the foundational algorithm for distributed caches (Memcached, Redis Cluster), sharded databases, and CDN request routing — anywhere you want a stable key-to-server mapping that survives membership changes.

**Q3. How does a load balancer enable zero-downtime deployments, and what's a way health checks can cause an outage?**
*Model answer:* The load balancer continuously health-checks its backends and only sends traffic to healthy ones, which lets you deploy without downtime via a rolling update: to update a server you *drain* it (mark it unhealthy or stop sending new requests while letting in-flight ones finish), update it, wait for it to pass health checks again, and return it to rotation — then repeat across the fleet. Because there's always a healthy server in rotation, clients never see downtime. The same mechanism self-heals: a crashed or hung server fails its checks and is automatically removed. The outage trap is health-check depth. A shallow check ("is the port open?") can miss a process that's up but internally broken. So people write deep checks ("GET /health that verifies database connectivity and downstream dependencies"). But if *every* backend's deep health check probes the *same shared dependency* — say the primary database — and that database has a brief hiccup, then *all* backends fail their health checks simultaneously, the load balancer removes the *entire fleet* from rotation, and a transient blip becomes a total outage with zero healthy servers. The fix is to design health checks to distinguish "this instance is broken" (eject just it) from "a shared dependency is degraded" (don't eject everyone), and to separate readiness (can take traffic now) from liveness (is the process alive) — which is exactly why Kubernetes splits readiness and liveness probes.

**Q4. What is TLS termination and what are the trade-offs of doing it at the proxy?**
*Model answer:* TLS termination means the proxy holds the TLS certificates, decrypts incoming HTTPS connections at the edge, and forwards plain HTTP to the backend servers over the internal network. The benefits: certificates are managed in one place instead of on every backend; backends are simpler (no TLS to implement or configure); the crypto compute is centralized and often hardware-accelerated; and — crucially — the proxy can now *read* the request, which is required for L7 content-based routing (you can't route by URL path if you can't decrypt the request). The trade-off is that traffic between the proxy and backends is unencrypted, which is acceptable on a trusted internal network but not in a zero-trust environment. So there are variants: TLS passthrough, where an L4 proxy forwards the encrypted bytes without decrypting (used when you need true end-to-end encryption and the backend must terminate TLS itself); and re-encryption, where the proxy decrypts to inspect/route and then re-encrypts to the backend (often with mutual TLS / mTLS), used in zero-trust architectures and service meshes where even internal hops must be encrypted and authenticated. The choice depends on whether you need L7 features (must decrypt) and how much you trust the internal network (passthrough or re-encrypt if you don't).

**Q5. Explain how a CDN works and why it makes a globally-distributed service fast.**
*Model answer:* A CDN is a globally distributed fleet of reverse-proxy caches — hundreds of "edge" locations spread around the world, each caching copies of your content. When a user requests something, they're routed (via anycast and/or GeoDNS) to the *nearest* edge location, which serves the content from its local cache in a few milliseconds. Only on a cache miss does the request travel to your origin server (in one central location), which then populates the edge cache for next time. It makes things fast because of the physics from the start of networking: propagation delay is a hard floor set by the speed of light — you cannot make a request from Sydney to a Virginia origin faster than roughly 80ms one way, no matter how much bandwidth you buy. So the CDN doesn't try to cross the distance faster; it eliminates the distance by putting a copy of the content near the user. Most requests are served from a nearby edge and never cross the planet. It's the convergence of several things: the speed-of-light latency floor (why it's needed), anycast and GeoDNS (routing users to the nearest edge), and HTTP caching (what makes the edge effective — Cache-Control, ETags). Modern CDNs extend this to edge computing — running code at the edge locations — so even dynamic logic executes close to users, taking "move content closer" to "move computation closer." It's one of the highest-impact performance technologies on the internet, and it's fundamentally a reverse-proxy cache deployed at planetary scale.

**Q6. What is a service mesh, and what problem does it solve?**
*Model answer:* A service mesh moves all the cross-cutting networking concerns of service-to-service communication out of application code and into a dedicated infrastructure layer of proxies. Concretely, a copy of a programmable L7 proxy (typically Envoy) runs as a *sidecar* next to every service instance, and all traffic between services flows proxy-to-proxy. Those sidecars handle mutual TLS (encrypting and authenticating every internal hop for zero-trust), load balancing (including per-request balancing of multiplexed gRPC/HTTP/2, which naive L4 can't do), retries, timeouts, circuit breaking, outlier detection, and observability (metrics, distributed tracing, logging) — all configured centrally through a control plane without changing or redeploying the applications. The problem it solves is that, in a microservices architecture, every service otherwise has to reimplement this networking logic (TLS, retries, load balancing, tracing) in its own code, in every language, inconsistently — a huge duplication and a source of subtle bugs and security gaps. The mesh makes networking policy a property of the *infrastructure* rather than the application: you configure retry and mTLS and traffic-splitting rules once, centrally, and they apply uniformly. The cost is operational complexity and the latency/resource overhead of an extra proxy hop on every call. It's essentially "what if every service talked to every other through a smart, observable, policy-enforcing L7 proxy" — and Envoy is the proxy that made it practical.

---

*Previous: [Chapter 16 — WebSockets and Realtime](./16-websockets-and-realtime.md) | Next: [Chapter 18 — Performance and Observability](./18-performance-and-observability.md)*
