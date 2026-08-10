# Chapter 9 — DNS

> *Every story about "what happens when you type a URL and press enter" begins with the same secret first step, the one that happens before a single packet reaches the website: your computer has a name, `example.com`, and it needs a number, `93.184.216.34`. Names are for humans; the network routes only on numbers. The system that translates between them — quietly, billions of times a second, across a globally distributed database with no central master — is DNS. It is the phone book of the internet, and like the phone book, it's invisible until it's wrong, at which point it takes everything down with it.*

We've spent eight chapters moving bytes between *numbers* — IP addresses. But humans don't think in IP addresses, and IP addresses change (a service migrates, scales, fails over) while names stay stable. The **Domain Name System (DNS)** is the indirection layer that maps stable, human-friendly names to the current, machine-routable addresses. It's the first application-layer protocol in this book (we've finally climbed out of the transport layer), and it's a beautiful piece of distributed-systems design: a hierarchical, delegated, aggressively-cached, eventually-consistent database that scales to the entire internet with no single point of control.

DNS deserves real attention for three reasons. First, **it's on the critical path of essentially every connection** — get it wrong and *nothing* works, which is why "it's always DNS" is the most-quoted sysadmin proverb (the joke being that when something breaks mysteriously, DNS is the usual culprit). Second, **its caching/TTL model is the source of a whole genre of production incidents** ("I updated DNS but it's still resolving to the old server"). Third, **it's a gorgeous example of how to build a planet-scale distributed system** through hierarchy, delegation, and caching — patterns that recur everywhere. We'll trace the full resolution path, decode the message format, build a DNS client from scratch (no library — just UDP and bytes), and cover the modern privacy layer (DoH/DoT/DNSSEC).

---

## 9.1 The Problem and the Shape of the Solution

Imagine designing a name-to-address database for the whole internet. The naive design — one giant central server holding every name — fails on every axis: it can't handle the query volume (trillions/day), it's a single point of failure (it dies, the internet dies), no single organization could be trusted to run it, and updating it would require global coordination. DNS solves all of this with three ideas that are worth naming because they're the blueprint for scaling *any* global system:

**1. Hierarchy.** Names are structured as a tree, read *right to left*, with each level delegating authority for the level below:

```
   The DNS name hierarchy (a tree, read RIGHT to LEFT):

                              . (root)
                             /    |    \
                          com    org    net   ...        ← Top-Level Domains (TLDs)
                          /  \
                    example  google  ...                  ← second-level domains
                      /  \
                   www   mail  ...                        ← subdomains
                                                          
   The name  www.example.com.  is really:  www . example . com . (root)
                                            └┬┘   └──┬──┘  └┬┘  └─┬─┘
                                          host  org-owned  TLD  root
                                                          
   (The trailing dot — the root — is usually implicit. "example.com" = "example.com.")
```

**2. Delegation.** No one entity knows the whole tree. Each level only knows *who is responsible for the next level down* and delegates to them. The root servers don't know `example.com`'s address — they only know who runs `.com`. The `.com` servers don't know `www.example.com` — they only know who runs `example.com`. Authority is delegated down the tree, so no server holds more than its slice. This is how the system distributes both *load* and *trust* — `example.com`'s owner controls `example.com`'s records, and nobody else has to.

**3. Caching.** The same names are looked up constantly (everyone resolves `google.com` over and over). So DNS caches aggressively at every level — your OS, your resolver, intermediate resolvers — each answer carrying a **TTL (Time To Live)** that says how long it may be cached. Caching is what makes the query volume survivable: the vast majority of lookups never reach the authoritative servers at all; they're served from a nearby cache. (And the TTL is the source of the "I changed DNS but it's stale" problem — §9.4.)

These three ideas — hierarchy, delegation, caching — turn an impossible centralized problem into a tractable distributed one. Keep them in mind; they *are* DNS.

---

## 9.2 The Resolution Path: From Name to Address

Let's trace a full resolution of `www.example.com` from a cold cache, because the choreography reveals the whole system. The key players:

- **Stub resolver:** the tiny DNS client in your OS (what `getaddrinfo()` calls). It doesn't do the work itself; it just asks a recursive resolver and waits for the final answer.
- **Recursive resolver:** the workhorse (run by your ISP, or a public one like `8.8.8.8`/`1.1.1.1`). It does the actual legwork of walking the hierarchy, and it caches results. This is the server your OS is configured to use.
- **Authoritative servers:** the servers that hold the *real* records, at each level — root, TLD, and the domain's own authoritative servers.

```
   Resolving www.example.com (cold cache) — "recursive" from your view, "iterative"
   from the resolver's view:

   Your app ──getaddrinfo()──► Stub resolver (in OS)
                                     │
                                     │ "what's www.example.com?" (recursive query:
                                     ▼  "do all the work, give me the final answer")
                          Recursive Resolver (8.8.8.8)
                                     │
       ┌─────────────────────────────┼──────────────────────────────────┐
       │  (iterative queries — the resolver walks the hierarchy itself)   │
       ▼                             ▼                                    ▼
   1. ROOT server          2. .com TLD server            3. example.com authoritative
   "where's .com?"         "where's example.com?"         "what's www.example.com?"
   ◄ "ask the .com         ◄ "ask example.com's          ◄ "www.example.com is
      servers at X"           servers at Y"                  93.184.216.34, TTL 3600"
                                     │
                                     ▼
                          Recursive Resolver CACHES the answer (and the intermediate
                          referrals), then returns 93.184.216.34 to the stub resolver
                                     │
   Your app ◄───────────────────────┘  gets 93.184.216.34, opens a TCP connection
```

The two query *styles* are worth distinguishing precisely (a classic interview point):

- **Recursive query** (your stub → the resolver): "Do *all* the work and come back with the final answer or an error. Don't make me chase referrals." The resolver takes on the full responsibility.
- **Iterative query** (the resolver → the authoritative servers): each authoritative server doesn't resolve the whole name; it returns a *referral* — "I don't have the final answer, but here's who to ask next." The resolver iterates down the hierarchy, following referrals: root → TLD → authoritative, one step at a time.

So a single `getaddrinfo()` from your app triggers *one* recursive query (you → resolver) that the resolver fulfills via *several* iterative queries (resolver → root → TLD → authoritative). The division of labor is the point: the stub stays trivially simple (ask one server, get the answer), while the resolver — which is shared and caches — absorbs the complexity and the load.

**Caching collapses this.** The walk above is the *cold-cache* worst case (~4 round trips). In reality, the resolver almost always has `.com`'s servers cached (everyone looks up `.com` domains constantly), often has `example.com`'s authoritative servers cached, and frequently has the final answer cached from a recent lookup. A *warm* cache resolves in a single round trip (you → resolver → cached answer). This is why DNS feels instant despite the elaborate hierarchy behind it: caching means the full walk is rare. The root servers handle a tiny fraction of the queries they'd face without caching — caching is load-bearing in the most literal sense.

> **The root servers, and an anycast callback.** There are **13 root server "identities"** (named `a.root-servers.net` through `m.root-servers.net`) — a number fixed by the old 512-byte UDP DNS packet limit. But "13 servers" is a fiction: each identity is actually *hundreds* of physical servers distributed worldwide via **anycast** (Chapter 5, §5.6). When your resolver queries "the root," BGP routes it to the *nearest* root instance — which is why root lookups are fast from anywhere on Earth and why the roots survive massive DDoS attacks (the load spreads across the anycast footprint). This is anycast's killer application, exactly as predicted in Chapter 5: short, stateless DNS queries fanned out to the nearest of many identical instances. The 13 logical roots are run by 12 independent organizations — deliberate decentralization so no single entity controls the internet's naming foundation.

---

## 9.3 The DNS Message Format and Record Types

DNS runs (usually) over UDP port 53, and its message format is the same for queries and responses — a header plus four sections. Understanding it is what lets us build a client in §9.5.

```
   DNS message structure:
   ┌──────────────────────────────────────────┐
   │  Header (12 bytes)                         │  ID, flags, section counts
   ├──────────────────────────────────────────┤
   │  Question section                          │  the name + type being asked about
   ├──────────────────────────────────────────┤
   │  Answer section                            │  the resource records (RRs) that answer
   ├──────────────────────────────────────────┤
   │  Authority section                         │  authoritative servers (referrals)
   ├──────────────────────────────────────────┤
   │  Additional section                        │  helpful extras (e.g. the referred
   └──────────────────────────────────────────┘   servers' IPs — "glue records")

   Header (12 bytes):
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                      ID (matches query to reply)              |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |QR|  Opcode   |AA|TC|RD|RA|  Z   |    RCODE  (error code)      |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |       QDCOUNT (# questions)   |     ANCOUNT (# answers)       |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |       NSCOUNT (# authority)   |     ARCOUNT (# additional)    |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Key header fields: **ID** (a random number matching a reply to its query — crucial for security, §9.6), **QR** (0=query, 1=response), **RD** (Recursion Desired — set by the stub asking the resolver to recurse), **RA** (Recursion Available), **AA** (Authoritative Answer — this came from an authoritative server, not a cache), **TC** (Truncated — the response didn't fit in a UDP packet; retry over TCP), and **RCODE** (the result: 0=NOERROR, 3=NXDOMAIN "name doesn't exist", 2=SERVFAIL, etc.).

**Name encoding** has a quirk you must handle in code: names aren't stored as `www.example.com` but as **length-prefixed labels**: `3www7example3com0` — each label preceded by its length, terminated by a zero byte. And DNS has **compression pointers** (a label can be a pointer to a name appearing earlier in the message, to save space) — the source of much parsing pain (§9.5).

### Record types (RRs) — the ones that matter

Each answer is a **Resource Record (RR)** with a name, a type, a TTL, and data. The types you must know:

```
   Type   Maps name to...                     Example use
   ────   ───────────────────────────────     ───────────────────────────────────
   A      an IPv4 address                      example.com → 93.184.216.34
   AAAA   an IPv6 address                      example.com → 2606:2800:220:1:...
   CNAME  another name (an alias)              www.example.com → example.com
   NS     a name server for a zone             example.com → ns1.example.com (delegation)
   MX     a mail server (+ priority)           example.com → 10 mail.example.com
   TXT    arbitrary text                       SPF/DKIM (email auth), domain verification
   SOA    zone metadata (the "start of         serial #, refresh/retry/expire, default TTL
           authority" — one per zone)
   SRV    a service's host+port                _sip._tcp.example.com → server:5060
   PTR    an IP back to a name (reverse DNS)   93.184.216.34 → example.com
   CAA    which CAs may issue certs            example.com → "letsencrypt.org" (TLS, Ch.12)
```

A few that bite in practice:
- **CNAME** chains a name to another name (an alias). Useful (`www` → apex, or pointing at a CDN's hostname), but with a famous gotcha: **a CNAME cannot coexist with other records at the same name**, which is why you *can't* put a CNAME at the apex/root of a domain (`example.com` itself needs NS and SOA records there). This is why providers invented `ALIAS`/`ANAME`/flattened CNAME hacks for apex domains pointing at CDNs.
- **NS records are the delegation mechanism** — they're literally how the hierarchy's "ask them next" referrals are expressed (§9.2). The `.com` servers return NS records for `example.com`; that *is* the delegation.
- **MX** routes email; **TXT** holds the SPF/DKIM/DMARC records that authenticate email senders (and the random strings services ask you to add to "verify domain ownership"). **CAA** (Ch. 12) restricts which Certificate Authorities can issue TLS certs for your domain — a defense against mis-issuance.

---

## 9.4 Caching, TTLs, and the Stale-Record Problem

Caching is what makes DNS scale, and TTLs are how it's governed — but they're also a notorious operational footgun, so this section earns its keep.

Every RR carries a **TTL** (in seconds) set by the domain's authoritative server. When a resolver (or your OS, or your app) caches an answer, it may serve that cached answer until the TTL expires, then must re-query. This is *the* knob that trades freshness against load:

- **High TTL (e.g. 86400 = 1 day):** answers are cached a long time → very few queries reach the authoritative servers (low load, fast resolution) → but changes propagate *slowly* (up to a day for everyone to see a new IP).
- **Low TTL (e.g. 60 = 1 minute):** changes propagate fast → but caches expire constantly, so far more queries hit the authoritative servers (higher load, slightly slower average resolution).

The classic incident: **"I updated my DNS record but traffic is still going to the old server."** This is almost always TTL caching — somewhere along the chain (the resolver, the OS, the application, the browser, a CDN) the *old* answer is still cached and won't expire until its TTL runs out. Worse, some resolvers and many applications *ignore TTLs* and cache longer than they should (Java's JVM historically cached DNS *forever* by default — `networkaddress.cache.ttl` — a legendary source of "why is my app still hitting the dead database" incidents; a JVM-depth gotcha worth remembering). And the TTL countdown only *starts* when an answer enters a cache, so different caches expire at different times — propagation is staggered, not synchronized.

**The migration playbook** that this knowledge gives you: *before* a planned IP change (migrating a service, failing over), **lower the TTL well in advance** (e.g. drop it to 60s a day before the change — long enough before that the *old* high TTL has expired everywhere and the low TTL is now cached). Make the change; now everyone re-queries within 60s and picks up the new IP quickly. After the dust settles, raise the TTL back up to reduce load. Skipping the "lower TTL in advance" step is how migrations turn into hours of split traffic. This single operational pattern is worth the whole section.

> **DNS as a load-balancing and failover tool — and its limits.** Because a name can map to *multiple* A records, DNS does crude load balancing: the resolver returns several IPs (often rotated, "round-robin DNS") and the client picks one. It's used for geographic routing too (GeoDNS returns different IPs based on the querier's location — a poor man's anycast). But DNS is a *bad* failover mechanism precisely because of caching: if a server dies, you can update DNS to remove its IP, but cached answers keep sending traffic to the dead server until TTLs expire — and low TTLs to mitigate this hammer your authoritative servers. This is *why* serious load balancing and failover happen at L4/L7 (Chapter 17, with health checks and instant removal) rather than via DNS, and why anycast (Chapter 5) — where failover is BGP reconvergence, not cache expiry — is preferred for the cases DNS can't serve. DNS distributes load; it doesn't react to failure fast. Know the difference.

---

## 9.5 Code: A DNS Client from Scratch

Let's build a DNS resolver with no library — just a UDP socket and raw bytes. This makes the message format concrete and demystifies what `getaddrinfo()` does under the hood. It's portable POSIX (compiles and runs on Linux *and* macOS), and it sends a real query to a real resolver.

**`dns_query.c`**

```c
/* dns_query.c — resolve a hostname's A record by speaking DNS directly over UDP.
 *   Build:  gcc -Wall -O2 -o dns_query dns_query.c
 *   Run:    ./dns_query example.com 8.8.8.8
 * No resolver library — we build the query bytes, send to a recursive resolver,
 * and parse the response by hand. This IS what getaddrinfo() does internally.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

/* Encode "www.example.com" as DNS labels: 3www7example3com0  */
static int encode_qname(const char *host, unsigned char *out) {
    int o = 0, label_start = 0, i = 0;
    for (;; i++) {
        if (host[i] == '.' || host[i] == '\0') {
            int len = i - label_start;
            out[o++] = (unsigned char)len;            /* length byte */
            memcpy(out + o, host + label_start, len);  /* the label */
            o += len;
            label_start = i + 1;
            if (host[i] == '\0') break;
        }
    }
    out[o++] = 0;   /* root label (zero-length) terminates the name */
    return o;
}

/* Skip a (possibly compressed) name in the response, returning bytes consumed
 * from THIS position. Compression pointers (top 2 bits = 11) jump elsewhere. */
static int skip_name(const unsigned char *msg, int pos) {
    int start = pos;
    while (msg[pos] != 0) {
        if ((msg[pos] & 0xC0) == 0xC0) { pos += 2; return pos - start; } /* pointer: 2 bytes */
        pos += msg[pos] + 1;                                            /* label: len+data */
    }
    return pos + 1 - start;   /* +1 for the terminating zero byte */
}

int main(int argc, char **argv) {
    const char *host     = (argc > 1) ? argv[1] : "example.com";
    const char *resolver = (argc > 2) ? argv[2] : "8.8.8.8";

    /* ---- Build the query ---- */
    unsigned char q[512];
    int n = 0;
    /* Header: ID=0x1234, flags=0x0100 (RD=1, recursion desired), 1 question. */
    q[n++] = 0x12; q[n++] = 0x34;       /* ID */
    q[n++] = 0x01; q[n++] = 0x00;       /* flags: RD set */
    q[n++] = 0x00; q[n++] = 0x01;       /* QDCOUNT = 1 */
    q[n++] = 0x00; q[n++] = 0x00;       /* ANCOUNT = 0 */
    q[n++] = 0x00; q[n++] = 0x00;       /* NSCOUNT = 0 */
    q[n++] = 0x00; q[n++] = 0x00;       /* ARCOUNT = 0 */
    n += encode_qname(host, q + n);     /* QNAME */
    q[n++] = 0x00; q[n++] = 0x01;       /* QTYPE = A (1) */
    q[n++] = 0x00; q[n++] = 0x01;       /* QCLASS = IN (1) */

    /* ---- Send it over UDP to the resolver on port 53 ---- */
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in srv = {0};
    srv.sin_family = AF_INET;
    srv.sin_port = htons(53);
    inet_pton(AF_INET, resolver, &srv.sin_addr);
    sendto(fd, q, n, 0, (struct sockaddr *)&srv, sizeof srv);

    /* ---- Receive and parse the response ---- */
    unsigned char r[512];
    ssize_t rn = recvfrom(fd, r, sizeof r, 0, NULL, NULL);
    if (rn < 12) { fprintf(stderr, "short/no response\n"); return 1; }

    int ancount = (r[6] << 8) | r[7];          /* answer count from the header */
    printf("Response: %d answer record(s)\n", ancount);

    /* Skip header (12) + the question (name + QTYPE + QCLASS). */
    int pos = 12;
    pos += skip_name(r, pos);   /* question name */
    pos += 4;                   /* QTYPE + QCLASS */

    /* Walk each answer RR. */
    for (int i = 0; i < ancount; i++) {
        pos += skip_name(r, pos);                 /* RR name (usually a compression ptr) */
        int type  = (r[pos] << 8) | r[pos + 1];
        int ttl   = (r[pos+4]<<24)|(r[pos+5]<<16)|(r[pos+6]<<8)|r[pos+7];
        int rdlen = (r[pos+8] << 8) | r[pos + 9];
        pos += 10;                                 /* type(2)+class(2)+ttl(4)+rdlen(2) */

        if (type == 1 && rdlen == 4) {             /* an A record: 4 bytes of IPv4 */
            printf("  A    %u.%u.%u.%u   (TTL %d)\n",
                   r[pos], r[pos+1], r[pos+2], r[pos+3], ttl);
        } else {
            printf("  type=%d  rdlen=%d  (TTL %d)\n", type, rdlen, ttl);
        }
        pos += rdlen;
    }
    close(fd);
    return 0;
}
```

Run it:

```
$ ./dns_query example.com 8.8.8.8
Response: 1 answer record(s)
  A    93.184.216.34   (TTL 21576)

$ ./dns_query google.com 1.1.1.1
Response: 1 answer record(s)
  A    142.250.193.206   (TTL 211)
```

Everything in this chapter is in that ~80 lines: the **label encoding** (`3www7example3com0`), the **12-byte header** with the RD flag set to request recursion, the **UDP transport** on port 53, the **compression-pointer handling** in `skip_name` (the `0xC0` check — without which the parser would walk off into garbage, because the answer's name is almost always a pointer back to the question), and the **A record with its TTL**. You've reimplemented the core of `getaddrinfo()`. Notice you sent *one recursive query* to `8.8.8.8` and it did all the hierarchy-walking (§9.2) for you — that's the recursive resolver earning its keep.

> **The compression-pointer detail is the one that gets you.** DNS names in answers are usually not spelled out — they're a 2-byte *pointer* (top two bits `11`) referencing the name already present in the question section, to save space. Our `skip_name` handles this (a pointer is 2 bytes total and we stop). A from-scratch DNS parser that ignores compression pointers will misparse essentially every real response — it's the classic "works on my hand-crafted test packet, explodes on real traffic" bug, and it's a great example of how real binary protocols hide complexity (variable-length, self-referential encoding) behind clean-looking diagrams.

---

## 9.6 Security and the Modern Privacy Layer

DNS was designed in 1983 with *zero* security — no authentication, no encryption — and that legacy causes real problems that the modern additions try to fix.

**DNS cache poisoning / spoofing.** Classic DNS over UDP has weak defenses against forgery. An attacker who can guess the query's **ID** (16 bits) and source port, and reply faster than the real server, can inject a *false* answer that the resolver caches — sending all users of that resolver to the attacker's IP. The **Kaminsky attack** (2008) made this devastatingly practical. The mitigations (source-port randomization + the query ID + the "0x20" case-randomization hack) add entropy to make guessing infeasible, but they're patches on an unauthenticated protocol. This is *why* the ID in our client is important and *why* it should be random in real code (we hardcoded `0x1234` for clarity — a real resolver randomizes it).

**DNSSEC (DNS Security Extensions)** adds *authentication* via cryptographic signatures: each record is signed, and the signatures chain up the hierarchy (the root signs the TLD's key, the TLD signs the domain's key), so a resolver can *verify* that an answer genuinely came from the authoritative source and wasn't forged. DNSSEC stops cache poisoning. But it does *not* add *privacy* — DNSSEC-signed queries and answers are still sent in cleartext, so anyone watching the wire sees what you're resolving. And its deployment is partial and operationally fiddly (key rollovers, larger responses). It authenticates; it doesn't conceal.

**The privacy problem: DNS leaks what you visit.** Even with HTTPS encrypting your actual traffic (Ch. 12), your *DNS queries* are traditionally in cleartext on port 53 — so your ISP, or anyone on the path, can see *every domain you look up*, even if they can't see the content. Your DNS history is a near-complete record of your browsing. Two protocols encrypt the query itself:

- **DoT (DNS over TLS):** DNS wrapped in a TLS connection (Ch. 12) on a dedicated port (853). The query is encrypted; an observer sees an encrypted connection to a DNS resolver but not the names. Easy to identify and block (dedicated port).
- **DoH (DNS over HTTPS):** DNS queries sent as HTTPS requests (Ch. 11–13) on port 443 — *indistinguishable from normal web traffic*. This makes DoH much harder to block or even detect (it looks like any other HTTPS), which is exactly why it's both *loved* (privacy from ISPs and censors) and *controversial* (it bypasses network-level DNS filtering that enterprises and parental controls rely on, and centralizes DNS visibility in whoever runs the DoH resolver — often a big browser vendor). Browsers ship DoH increasingly by default.

> **The synthesis:** DNS's original sins — no authentication, no encryption — produced two distinct modern fixes for two distinct problems. DNSSEC answers *"is this answer authentic?"* (integrity, via signatures). DoH/DoT answer *"can anyone see what I'm asking?"* (privacy, via encryption). They're orthogonal and complementary: DNSSEC stops the attacker who forges answers; DoH/DoT stops the observer who reads your queries. Both are retrofits onto a protocol that assumed a friendlier internet — the same "foundational protocol meets a hostile modern world" theme we saw with ARP (Ch. 3) and BGP (Ch. 5). The lesson recurs: the internet's bedrock protocols were built on trust, and securing them after the fact is hard, partial, and ongoing.

---

## Key Takeaways

1. **DNS maps stable human names to changeable machine addresses** via three scaling ideas worth stealing for any global system: **hierarchy** (a delegated tree read right-to-left), **delegation** (each level only knows who's responsible for the next — distributing load and trust), and **caching** (aggressive, TTL-governed — what makes the query volume survivable so the full hierarchy walk is rare).

2. **Resolution splits labor:** your stub resolver sends *one recursive query* ("do all the work") to a recursive resolver, which fulfills it via *iterative queries* down the hierarchy (root → TLD → authoritative), following referrals (NS records). Caching collapses the cold-cache ~4-RTT walk to a single RTT in the common case. The 13 logical root servers are hundreds of physical servers via **anycast** (Ch. 5's killer app).

3. **Know the record types:** A (IPv4), AAAA (IPv6), CNAME (alias — can't coexist with other records, so not at the apex), NS (delegation), MX (mail), TXT (SPF/DKIM/verification), SOA (zone metadata), SRV (service host+port), PTR (reverse), CAA (which CAs may issue certs). NS records *are* the delegation mechanism.

4. **TTLs trade freshness for load and cause the classic "I updated DNS but it's still stale" incident.** Caches (resolver, OS, app, browser) serve old answers until TTLs expire — and some clients ignore TTLs entirely (the JVM historically cached forever). The migration playbook: **lower the TTL well in advance** of a planned change, make the change, then raise it back.

5. **DNS distributes load (multiple A records, GeoDNS) but is a poor *failover* mechanism** because caching keeps sending traffic to dead servers until TTLs expire — which is why real failover lives at L4/L7 (Ch. 17, health checks) and anycast (Ch. 5, BGP reconvergence), not DNS.

6. **You can build a resolver from a UDP socket and raw bytes:** length-prefixed labels (`3www7example3com0`), a 12-byte header with the RD flag, and — the detail that bites — **compression pointers** (`0xC0`) in answers that reference earlier names. Ignoring compression is the classic "works on my test packet, explodes on real traffic" bug.

7. **DNS had no security by design, fixed by two orthogonal retrofits:** **DNSSEC** authenticates answers via signatures chained up the hierarchy (stops cache poisoning — integrity, not privacy), while **DoT/DoH** encrypt the query itself (privacy — DoH on port 443 is indistinguishable from web traffic, hence both loved and controversial). Same "trusting protocol meets hostile world" theme as ARP and BGP.

---

## Interview Drills

**Q1. Walk me through what happens when your computer resolves `www.example.com` with a cold cache.**
*Model answer:* The app calls getaddrinfo(), which hands the name to the OS's stub resolver. The stub sends a single *recursive* query — "give me the final answer" — to its configured recursive resolver (e.g. 8.8.8.8). The resolver, with nothing cached, walks the hierarchy via *iterative* queries: it asks a root server "where's .com?", which returns a referral (NS records) to the .com TLD servers; it asks a .com server "where's example.com?", which refers it to example.com's authoritative servers; it asks those "what's www.example.com?", which returns the A record (e.g. 93.184.216.34) with a TTL. The resolver caches the answer (and the intermediate referrals) and returns the IP to the stub, which hands it to the app, which opens a TCP connection to that IP. The distinction to highlight: one recursive query from the client triggers several iterative queries from the resolver — the stub stays simple, the shared resolver absorbs the complexity and the caching. With a warm cache (the usual case) this collapses to a single round trip, which is why DNS feels instant.

**Q2. What's the difference between a recursive and an iterative DNS query?**
*Model answer:* It's about who does the work. In a recursive query, the client asks the server to do *everything* and return the final answer (or an error) — "don't make me chase referrals." That's what your stub resolver sends to your recursive resolver. In an iterative query, the queried server doesn't resolve the whole name; it returns the best it has — usually a *referral* pointing to the next server to ask. That's what the recursive resolver sends to the authoritative servers: each one (root, then TLD, then the domain's authoritative server) hands back "I don't have the final answer, ask these servers next," and the resolver iterates down the hierarchy following the referrals. So a single recursive request from the client is fulfilled by a chain of iterative requests from the resolver. The design keeps the client trivially simple while concentrating the work and the cache in the shared resolver.

**Q3. You changed your domain's IP address an hour ago, but some users still hit the old server. Why, and how should you have done it?**
*Model answer:* TTL caching. Your old DNS record had a TTL, and resolvers, operating systems, applications, and browsers along the path cached the old IP for up to that TTL — they won't re-query until it expires, so they keep sending traffic to the old server. Some clients are worse: certain resolvers and apps ignore the TTL and cache longer (the JVM historically cached DNS forever by default). And because each cache's TTL countdown starts when *it* cached the answer, expiry is staggered, so propagation is gradual, not instant. The right approach is to plan the cutover: well before the change (say a day ahead, longer than the *current* TTL), lower the record's TTL to something small like 60 seconds and wait for the old long TTL to expire everywhere; then make the IP change — now every cache re-queries within ~60s and picks up the new IP quickly; afterward, raise the TTL back up to reduce load on your authoritative servers. Skipping the "pre-lower the TTL" step is exactly what causes hours of split traffic.

**Q4. Why is DNS not a good failover mechanism?**
*Model answer:* Because of caching latency. When a server fails, you can update DNS to remove its IP, but cached answers throughout the system keep directing traffic to the dead server until their TTLs expire — so failover is as slow as your TTL, and clients keep hitting the failed server in the meantime. You can lower TTLs to react faster, but very low TTLs hammer your authoritative servers with constant re-queries and still leave a window of broken traffic, and some clients ignore TTLs anyway. DNS is fundamentally a *distribution* mechanism (hand out multiple IPs, do geographic routing), not a *reactive* one — it has no health checking and no way to instantly stop sending traffic to a dead endpoint. That's why real failover and load balancing happen at L4/L7 with load balancers that health-check backends and remove them instantly (Chapter 17), and why anycast is preferred for the global cases — with anycast, a dead instance withdrawing its BGP route reconverges in seconds without waiting for any cache to expire. Use DNS to distribute, not to fail over.

**Q5. DNS originally had no security. What are the modern fixes and what does each address?**
*Model answer:* Two orthogonal problems, two fixes. The first problem is *authenticity*: classic DNS over UDP can be forged — an attacker guessing the 16-bit query ID and source port can inject a false answer the resolver caches (cache poisoning, made practical by the Kaminsky attack), redirecting users. DNSSEC fixes this by cryptographically *signing* records, with the signatures chained up the hierarchy (root signs the TLD's key, TLD signs the domain's key), so a resolver can verify an answer genuinely came from the authoritative source. DNSSEC provides integrity, not privacy. The second problem is *privacy*: even when your web traffic is HTTPS-encrypted, traditional DNS queries are cleartext on port 53, so your ISP or any on-path observer sees every domain you look up — a near-complete browsing record. DoT (DNS over TLS, port 853) and DoH (DNS over HTTPS, port 443) encrypt the query itself. DoH is notable because it's indistinguishable from regular web traffic, making it hard to block — which is why it's both praised for privacy and criticized for bypassing enterprise/parental DNS filtering and centralizing DNS visibility in browser vendors. DNSSEC answers "is this answer real?"; DoH/DoT answer "can anyone see what I asked?" — complementary retrofits onto a protocol built for a more trusting internet.

**Q6. Why are there "only 13 root servers" and how do they handle global load?**
*Model answer:* The "13" is a historical artifact of the original 512-byte UDP DNS message limit — only 13 root server addresses fit in a referral response alongside the necessary glue. But it's a logical fiction: each of the 13 named identities (a through m root-servers.net) is actually *hundreds* of physical servers spread across the world using anycast. The same IP prefix is announced into BGP from many locations, so when a resolver queries "the root," BGP routes it to the topologically nearest instance — giving low latency from anywhere and massive resilience, since a DDoS attack on the root is diluted across the entire anycast footprint rather than concentrated on one machine. The 13 identities are operated by 12 independent organizations, a deliberate decentralization so no single entity controls the internet's naming foundation. So "13 root servers" really means "13 anycast clouds of hundreds of servers each, run by a dozen independent operators" — and it's the textbook example of anycast's strength for short, stateless queries.

---

*Previous: [Chapter 8 — TCP, Part II: Congestion Control](./08-tcp-part2-congestion.md) | Next: [Chapter 10 — Sockets and the Kernel](./10-sockets-and-the-kernel.md)*
