# Chapter 5 — Routing the Internet

> *Your laptop in Bangalore has a packet for a server in Virginia. Between them lie a dozen networks owned by a dozen companies — your ISP, a couple of transit carriers, an ocean's worth of submarine cable operators, a cloud provider — none of which has ever coordinated with the others about your specific packet. There is no central map of the internet. No one is in charge. And yet the packet arrives, in tens of milliseconds, reliably, billions of times a second. How?*

This is the chapter where the local-delivery machinery of Chapters 3–4 becomes *global*. We've established that IP gives every host a hierarchical address (Ch. 4) and that the link layer can move a frame one hop (Ch. 3). Routing is the act of stitching those one-hop deliveries into a planet-spanning path — and doing so with *no global coordinator*, across networks with conflicting commercial interests, in a way that adapts within seconds when a submarine cable is cut.

It is, honestly, one of the most remarkable distributed systems ever built, and most engineers understand it only as a vague cloud labeled "the internet." By the end of this chapter you'll understand it concretely: the split between forwarding (per-packet) and routing (building the tables), how a router picks a next hop in nanoseconds (longest-prefix match), how routes get computed *within* a network (OSPF) and *between* networks (BGP — the protocol that literally glues the internet together, and the one whose failures take down continents), how NAT lets billions of devices share a few billion addresses, and how one IP address can live in fifty cities at once (anycast). And we'll build a working `traceroute` from scratch so you can watch your own packets hop across the planet.

---

## 5.1 Forwarding vs. Routing: The Two-Plane Split

The single most clarifying idea in this entire chapter is that a router does *two completely different jobs*, on two different timescales, and conflating them is the root of most confusion. Internalize this split and everything else falls into place:

```
   ┌─────────────────────────────────────────────────────────────────┐
   │  CONTROL PLANE  (routing)  —  "build the map"                     │
   │  • Runs routing protocols (OSPF, BGP) with other routers          │
   │  • Computes the best path to every destination                    │
   │  • Timescale: seconds to minutes; runs continuously in background │
   │  • Output: the routing table (RIB — Routing Information Base)      │
   └───────────────────────────────┬─────────────────────────────────┘
                                   │ distills the best routes into...
                                   ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │  DATA PLANE  (forwarding)  —  "move the packet"                   │
   │  • For each arriving packet: look up dest IP, send out a port     │
   │  • Timescale: NANOSECONDS; happens billions of times/sec          │
   │  • Uses the forwarding table (FIB — Forwarding Information Base)   │
   │  • Often in dedicated hardware (ASIC/TCAM) — no CPU per packet     │
   └─────────────────────────────────────────────────────────────────┘
```

**Forwarding (the data plane)** is the per-packet act: a packet arrives, the router examines its destination IP, consults a table, and sends it out the appropriate interface toward the next hop. This happens at line rate — for a core router, *billions of packets per second* — so it must be brutally fast, typically done in dedicated hardware (an ASIC with a special memory called TCAM, §5.2) without troubling a general-purpose CPU. Forwarding is *mechanical and stateless*: it just looks up and sends.

**Routing (the control plane)** is the background process of *figuring out what the forwarding table should contain*. Routers run routing protocols — OSPF inside a network, BGP between networks — exchanging reachability information with their neighbors, computing best paths, and reacting to topology changes (a link goes down, a new route appears). This runs continuously on the router's CPU, on a timescale of seconds. Its output is the **RIB (Routing Information Base)** — the full routing table with all candidate routes and metadata.

The **FIB (Forwarding Information Base)** is the *optimized distillation* of the RIB into exactly what the data plane needs: for each destination prefix, the single best next-hop and output port, in a format the forwarding hardware can search in nanoseconds. The control plane writes the FIB; the data plane reads it.

> **Why this split matters in practice:** it's why a router can keep forwarding packets at full speed *while* its routing protocols are reconverging after a failure (the FIB doesn't change until the new best path is computed), and it's why "the routing table" you see with `ip route` (the RIB) can differ from what the hardware actually forwards on (the FIB). It's also the architecture of every modern network device and the conceptual basis of **SDN (Software-Defined Networking)**, which takes the split to its logical extreme: rip the control plane out of each device entirely and run it on a centralized controller, leaving the switches as pure dumb data planes. When you hear "control plane vs. data plane" anywhere in infrastructure — Kubernetes, service meshes, databases — this is the origin of the distinction.

---

## 5.2 How a Router Picks a Next Hop: Longest-Prefix Match

Let's zoom into the data plane's one job: given a destination IP, find the next hop. The routing table is a set of **prefixes** (CIDR blocks, Ch. 4) each mapped to a next hop:

```
   Destination prefix      Next hop            Interface
   ──────────────────      ───────────         ─────────
   0.0.0.0/0               203.0.113.1         eth0      ← default route ("everything else")
   10.0.0.0/8             (directly connected)  eth1
   10.1.0.0/16            10.0.0.5             eth1
   10.1.2.0/24            10.0.0.9             eth2
   192.0.2.0/24          (directly connected)  eth3
```

Now a packet arrives for `10.1.2.55`. Which entry wins? Look carefully — *three* entries match it: `10.0.0.0/8`, `10.1.0.0/16`, and `10.1.2.0/24` all contain `10.1.2.55`. The rule that resolves this is **longest-prefix match (LPM)**: **the most specific matching prefix wins** — the one with the most network bits. Here, `/24` beats `/16` beats `/8`, so the packet goes to next hop `10.0.0.9` out `eth2`.

```
   Destination: 10.1.2.55

   10.0.0.0/8     matches (first 8 bits agree)   ← least specific
   10.1.0.0/16    matches (first 16 bits agree)
   10.1.2.0/24    matches (first 24 bits agree)  ← MOST specific → WINS
   0.0.0.0/0      matches (zero bits required)   ← the fallback, matches everything

   Longest-prefix match: pick the route with the most network bits. Always.
```

Longest-prefix match is the elegant heart of IP routing, and it's *why* CIDR's hierarchy (Ch. 4) works. It lets you have a broad route (`10.0.0.0/8` → "the whole 10-network goes that way") *and* override it with specific exceptions (`10.1.2.0/24` → "but this particular subnet goes a different way"), and the most-specific rule automatically does the right thing. The **default route** `0.0.0.0/0` is just LPM's natural fallback: it matches everything with zero required bits, so it wins only when *nothing* more specific matches — exactly the semantics you want for "send anything I don't have a specific route for toward the internet."

**The hard part — doing LPM in nanoseconds.** A core internet router holds ~1,000,000 prefixes in its table, and must find the longest match for *every* packet at line rate. A linear scan is hopelessly slow. The solutions are a beautiful corner of systems engineering:
- **TCAM (Ternary Content-Addressable Memory)** — special hardware memory that compares a search key against *all* stored entries *simultaneously* in one clock cycle, with "don't care" bits for the host portion. It returns the longest match in O(1). TCAM is power-hungry and expensive (it's why router line cards cost what they do), but it's how hardware forwarding hits billions of packets/sec.
- **Software tries** (e.g. the **LPC-trie / LC-trie** the Linux kernel uses, `net/ipv4/fib_trie.c`) — a tree structure keyed on address bits that finds the longest match in O(address length) without special hardware, for software routers and hosts.

> **In the wild:** Your own laptop does LPM on every outbound packet. Run `ip route` (Linux) or `netstat -rn` (macOS) and you'll see exactly this table: a default route (`0.0.0.0/0` via your gateway), a route for your local subnet (directly connected), and maybe a few others. When you send a packet, your kernel does longest-prefix match against this table to decide: is the destination on my local subnet (→ ARP for it directly, Ch. 3) or not (→ send to the default gateway)? That decision from the end of Chapter 3 *is* longest-prefix match. The same algorithm runs identically on your laptop's tiny table and a core router's million-entry one.

---

## 5.3 Intra-Domain Routing: OSPF and Link-State

Now: *who fills in the routing table?* The control plane. But routing splits into two fundamentally different problems with two different protocol families, and the division is both technical and *political*:

- **Intra-domain (interior) routing:** finding best paths *within* a single administrative network — your company, one ISP, one data center. Here, all routers are cooperative (same owner), you trust each other completely, and the goal is the *technically* optimal path (fewest hops, lowest latency, highest bandwidth). Protocol: **OSPF** (or IS-IS, its close cousin used by large carriers).
- **Inter-domain (exterior) routing:** finding paths *between* these independent networks, across the whole internet. Here, the networks are owned by *different companies with competing interests*, who don't trust each other and route based on *business relationships and policy*, not just technical optimality. Protocol: **BGP** (§5.4).

These are genuinely different problems — cooperative-and-optimal vs. adversarial-and-political — which is why they use different protocols. Let's do OSPF first; it's the cleaner one.

**OSPF (Open Shortest Path First)** is a **link-state** protocol, and the link-state idea is elegant: *every router learns the complete map of the network, then independently computes the best path to everywhere.* The mechanism:

```
   1. DISCOVER NEIGHBORS: each router finds its directly-connected neighbors
      (via "Hello" packets) and measures the "cost" of each link (configured,
      often inversely proportional to bandwidth — faster link = lower cost).

   2. FLOOD LINK-STATE: each router builds a "Link-State Advertisement" (LSA)
      describing its own links and their costs, and FLOODS it to every other
      router in the area. Everyone forwards every LSA until all routers have all
      LSAs.

   3. BUILD THE MAP: now every router has an identical database — the complete
      graph of the network: all routers, all links, all costs. (The "link-state
      database," synchronized across the whole area.)

   4. COMPUTE SHORTEST PATHS: each router independently runs DIJKSTRA'S ALGORITHM
      on this graph, with itself as the root, computing the shortest (lowest-cost)
      path to every destination. The first hop of each shortest path becomes the
      routing-table entry.
```

The defining property: **every router has the full topology and computes paths itself.** This is what "link-state" means — the *state of every link* is known to everyone. Dijkstra's algorithm — yes, the same shortest-path algorithm you learned for coding interviews — runs *inside every router on the internet's interior*, on a graph where nodes are routers and edge weights are link costs. (This is one of the cleanest "DSA shows up in real infrastructure" examples you'll find; if you've studied Dijkstra abstractly, OSPF is where it earns its living.)

When a link fails, the routers adjacent to it flood updated LSAs, everyone updates their map, everyone reruns Dijkstra, and the network *converges* on new paths — typically within a few seconds. Fast convergence is link-state's big advantage over the older **distance-vector** approach (used by RIP), where routers only know "distances" reported by neighbors, not the full map, and converge slowly with "count-to-infinity" pathologies. Link-state trades more memory and CPU (everyone stores the whole map and runs Dijkstra) for fast, loop-free convergence — a good trade inside a network you control.

OSPF scales to large networks by dividing them into **areas** (hierarchy again!): routers flood LSAs only within their area, and "area border routers" summarize between areas, so no single router needs the entire global map. But OSPF's whole model — *everyone shares full state and trusts it* — only works *within one administrative domain*. You cannot run OSPF across the whole internet: you'd be asking every router on Earth to hold the complete global topology (impossible) and to *trust* link-state advertisements from networks owned by strangers and competitors (insane). The internet between networks needs a fundamentally different protocol — one built for scale, policy, and distrust. That's BGP.

---

## 5.4 Inter-Domain Routing: BGP, the Protocol That Glues the Internet

This is the centerpiece. **BGP (Border Gateway Protocol)** is the routing protocol *between* the independent networks that make up the internet, and it is, with little exaggeration, *the* protocol that makes the internet a single connected thing. It's also the source of some of the most spectacular outages in internet history. Understanding BGP is understanding how the internet actually coheres.

### Autonomous Systems: the internet as a graph of networks

The internet is not a graph of routers; it's a graph of **networks**. Each independently-operated network — an ISP, a university, Google, Cloudflare, Amazon — is an **Autonomous System (AS)**, identified by a globally unique **AS Number (ASN)** (e.g. AS15169 is Google, AS13335 is Cloudflare, AS16509 is Amazon). There are ~75,000 active ASes. BGP's job is to route *between* ASes: to figure out, for any destination IP prefix, the sequence of ASes a packet should traverse to reach it.

```
   The internet at the AS level (not routers — whole networks):

        AS64500 (your ISP) ──── AS3356 (a Tier-1 transit carrier) ──── AS15169 (Google)
              │                        │                                    │
              └──── AS13335 ───────────┘                                    │
                   (Cloudflare)         (peering & transit links between)   │
        Your laptop is inside AS64500. Google's server is inside AS15169.
        BGP finds the AS-path: AS64500 → AS3356 → AS15169.
```

### Path-vector routing: advertising reachability

BGP is a **path-vector** protocol. Each AS *advertises* to its neighbors which IP prefixes it can reach and *the AS-path to reach them*. The mechanism:

```
   • Google (AS15169) owns the prefix 142.250.0.0/15. It ANNOUNCES to its BGP
     neighbors: "I can reach 142.250.0.0/15, AS-path = [15169]."

   • A transit carrier AS3356 hears this, and re-announces to ITS neighbors:
     "I can reach 142.250.0.0/15, AS-path = [3356, 15169]" — prepending its own ASN.

   • Your ISP AS64500 hears that, and now knows: "to reach 142.250.0.0/15, send
     toward AS3356; the full path is [64500, 3356, 15169]."

   The AS-PATH (the list of ASes a route traverses) is the core of BGP. It serves two
   purposes: (1) LOOP DETECTION — if an AS sees its own ASN already in a path, it
   rejects the route (it would be a loop); (2) POLICY — ASes choose routes based on
   the path's properties.
```

Critically, **BGP does not pick routes by "shortest path" in any technical sense.** It picks routes by **policy** — and policy is driven by *money and business relationships*. This is the thing that makes BGP utterly unlike OSPF and surprises every engineer the first time they learn it: **the internet's routing is shaped by commercial contracts, not network distance.**

### The economics: transit, peering, and the policy that drives routing

AS-to-AS relationships come in two main flavors, and they determine routing:

- **Transit (customer ↔ provider):** a smaller AS *pays* a larger one to carry its traffic to the rest of the internet. You (a customer) pay your provider; in return they give you reachability to *everywhere*. Money flows customer → provider.
- **Peering (settlement-free, peer ↔ peer):** two ASes of comparable size agree to exchange traffic *between their respective customers* directly, for free, because it's mutually beneficial (saves both of them transit fees). Peering typically happens at **Internet Exchange Points (IXPs)** — physical locations where many networks meet to peer.

These relationships drive routing via the **Gao-Rexford rules** (the economic logic of BGP), which boil down to: *prefer the route that makes you money or saves you money.* An AS will:
1. **Prefer routes through customers** (they pay you — you *want* to carry their traffic) over...
2. **Routes through peers** (free) over...
3. **Routes through providers** (you pay — use only as a last resort).

This is captured in BGP's **LOCAL_PREF** attribute, the *first and highest-priority* tiebreaker in BGP's decision process. Only *after* policy (LOCAL_PREF) does BGP consider path length (shortest AS-path), and even that is a crude proxy for distance. The full BGP best-path selection is a multi-step tiebreaker:

```
   BGP best-path selection (simplified, in priority order):
   1. Highest LOCAL_PREF        ← POLICY/MONEY decides first (prefer customer routes)
   2. Shortest AS-PATH          ← then fewest ASes (crude distance proxy)
   3. Lowest MED                ← then the neighbor's preference hint
   4. eBGP over iBGP            ← prefer externally-learned routes
   5. Lowest IGP cost to next-hop, then tie-breakers (router ID, etc.)
```

> **The mind-bending consequence:** the path your packet takes across the internet is often *not* the geographically or technically shortest one. It's the one that's cheapest for the ASes involved. Your traffic might detour through a distant city because that's where two networks peer for free, rather than taking a shorter path that would cost someone transit fees. This is why traceroute (§5.7) sometimes shows baffling detours, and why internet performance between two points can depend on the *business relationship* between their ISPs as much as on physics. **The internet's topology is an economic artifact, not just an engineering one.** This is the single most important and least-known fact about how the internet actually routes.

### When BGP goes wrong: leaks and hijacks

BGP's defining weakness is the flip side of its strength: it's built entirely on **trust**, with essentially no authentication of who's *allowed* to announce a prefix. An AS can announce *any* prefix it wants, and its neighbors will, by default, believe it. This causes two catastrophic failure modes that have repeatedly broken large swaths of the internet:

- **Route hijacking:** an AS announces a prefix it doesn't own — accidentally or maliciously — and attracts traffic destined for the real owner. Because BGP prefers more-specific prefixes (longest-prefix match again, §5.2) and trusts announcements, a hijack of a *more specific* prefix can pull global traffic. The classic example: in 2008, **Pakistan Telecom tried to block YouTube domestically by announcing a more-specific YouTube prefix into BGP — and accidentally leaked it to the global internet, taking YouTube down worldwide for hours** as traffic flooded toward Pakistan. In 2018, attackers hijacked Amazon's Route 53 DNS prefixes to steal cryptocurrency. Hijacks happen regularly.
- **Route leaks:** an AS that learns routes from a provider/peer improperly re-announces them to *another* provider/peer, violating the Gao-Rexford rules, and inadvertently becomes a transit path for traffic it can't handle. The traffic floods in and is dropped or massively delayed. A single fat-fingered config has repeatedly taken down major services (e.g. a 2019 leak by a small ISP, propagated through a large carrier, broke Cloudflare and others; Facebook's 2021 global outage was a BGP withdrawal cutting their own DNS off from the internet).

The defenses are partial and slowly deploying: **RPKI (Resource Public Key Infrastructure)** cryptographically certifies which AS is *authorized* to announce which prefix, letting routers reject unauthorized announcements (Route Origin Validation). **BGPsec** would authenticate the whole path, but is barely deployed. The honest state of affairs: **the protocol that holds the internet together runs largely on trust and good behavior, and a single misconfiguration in one network can — and regularly does — disrupt connectivity for millions.** It's simultaneously a triumph (it scales to the whole internet and converges) and a fragility (it's insecure by design and politically/economically tangled). Knowing this is knowing how the internet *really* works, fragility included.

---

## 5.5 NAT: How Billions of Devices Share a Few Billion Addresses

We said in Chapter 4 that IPv4 ran out of addresses, and that **NAT (Network Address Translation)** is a big reason it limped on anyway. NAT is the mechanism that lets an entire private network (all those `192.168.x.x` devices) share a *single* public IP address — and understanding it explains a huge amount of real-world networking behavior (why your home devices can reach out but can't be reached, why P2P is hard, why you need port-forwarding for a game server).

The core idea: a NAT router rewrites the source IP (and port) of outbound packets to its own public IP, remembers the mapping, and reverses the rewrite on the replies. The variant everyone uses is **PAT (Port Address Translation)**, a.k.a. "NAT overload," which multiplexes many private hosts onto one public IP *using port numbers* to tell the conversations apart:

```
   Inside (private)                NAT router                 Outside (internet)
   ────────────────                ──────────                 ──────────────────
   192.168.1.5:51000  ──packet──►  rewrites src to            ──►  server 142.250.80.46:443
     (to 142.250.80.46:443)        203.0.113.7:60001
                                   and records the mapping:
                                   ┌──────────────────────────────────────────────┐
                                   │ NAT table (connection-tracking state)         │
                                   │ 192.168.1.5:51000  ⇄  203.0.113.7:60001       │
                                   │ 192.168.1.8:51000  ⇄  203.0.113.7:60002       │  ← same
                                   │ 192.168.1.5:51001  ⇄  203.0.113.7:60003       │   inside
                                   └──────────────────────────────────────────────┘   port, OK!
                                                                          different
   192.168.1.5:51000  ◄─reply──    rewrites dst back to       ◄──  reply (to 203.0.113.7:60001)
     (from server)                 192.168.1.5:51000 using
                                   the table
```

The mechanism:
1. An inside host sends a packet. The NAT router rewrites the **source IP** to its public IP and the **source port** to a unique value it picks, and records the four-tuple mapping (inside IP:port ⇄ public IP:port) in its **NAT table** (connection-tracking state).
2. The reply comes back addressed to the public IP:port. The NAT router looks up the table, rewrites the **destination** back to the original inside IP:port, and forwards it in.
3. The port numbers are what make this scale: thousands of inside hosts can share one public IP because each conversation gets a distinct public port. (Even two inside hosts using the *same* inside port get distinct public ports.)

NAT's profound consequences, all of which you've felt:

- **It bought IPv4 ~20 extra years** by collapsing the address requirement from "one public IP per device" to "one public IP per *network*." This is *the* reason IPv4 didn't collapse in 2011 — and, ironically, a big reason IPv6 adoption was so slow (the pressure was relieved).
- **It breaks the end-to-end principle (Ch. 4).** Inside hosts are no longer directly addressable from the internet — there's no public IP that names them. They can *initiate* connections out (the NAT creates a mapping on the way out) but cannot *receive* unsolicited connections in (no mapping exists until they reach out). This is why your laptop can browse the web but a friend can't directly connect *to* it. It's a crude, accidental "firewall" (unsolicited inbound is dropped because there's no NAT mapping) — security as a side effect.
- **It makes peer-to-peer hard.** Two devices both behind NATs can't directly connect (neither can receive an unsolicited inbound). The workarounds — **STUN** (discover your public IP:port), **TURN** (relay through a public server), **ICE** (try everything), and **NAT hole-punching** (both sides initiate simultaneously to trick the NATs into creating mappings) — are an entire subfield, central to WebRTC, video calls, and gaming. Whenever a video call "connects directly" or "falls back to a relay," this machinery is why.
- **Carrier-Grade NAT (CGNAT)** does it again at the ISP level — even your "public" IP is often shared with other customers behind the ISP's NAT — which is why "what's my IP" can show an address you don't control and why running servers from home gets ever harder.

> **The deep tension:** NAT is a beautiful hack and an architectural sin, simultaneously. It solved a real crisis (address exhaustion) elegantly, but it did so by *breaking the internet's founding assumption that every host is globally addressable*, and we've been paying for that in P2P complexity, protocol contortions, and middlebox fragility ever since. IPv6's whole pitch is "enough addresses that NAT becomes unnecessary, restoring true end-to-end addressing." Whether that's worth the migration pain is a 25-year-old debate (Ch. 4).

---

## 5.6 Anycast: One Address, Many Locations

The last routing concept, and a genuinely clever exploitation of BGP. Normally an IP prefix is announced from *one* place. **Anycast** announces the *same* prefix from *many* locations simultaneously, and lets BGP's longest-prefix/shortest-path machinery naturally route each user to the *nearest* announcing location.

```
   8.8.8.8 (Google DNS) is anycast: the prefix 8.8.8.0/24 is announced into BGP
   from HUNDREDS of Google locations worldwide, all at once.

   A user in Tokyo:    BGP routes 8.8.8.8 → Google's Tokyo POP    (a few ms away)
   A user in London:   BGP routes 8.8.8.8 → Google's London POP   (a few ms away)
   A user in São Paulo: BGP routes 8.8.8.8 → Google's Brazil POP  (a few ms away)

   Same IP address. Different physical servers. Each user reaches the closest one,
   automatically, because BGP independently picks the shortest AS-path from each
   user's location — and the shortest path leads to the nearest announcement.
```

The magic is that **the routing system does the load-distribution and proximity-routing for free.** No one configures "Tokyo users go here" — BGP's per-location best-path selection naturally sends each user to the topologically-nearest instance, because that instance's announcement *is* the shortest path from that user. Anycast gives you:
- **Latency reduction** — everyone reaches a nearby instance (the CDN/edge principle of Ch. 1's "beat the speed of light by moving content closer," now realized through routing).
- **Load distribution** — traffic naturally spreads across instances by geography.
- **DDoS resilience** — an attack from one region is absorbed by the nearest instance rather than concentrating on a single server; the attack is "diluted" across the anycast footprint. This is a primary reason DNS root servers and DDoS-protection providers (Cloudflare) are anycast.
- **Implicit failover** — if one instance withdraws its BGP announcement (it died), traffic automatically re-routes to the next-nearest. No health-check reconfiguration; BGP just reconverges.

Anycast's catch: it works best for *stateless, short* interactions (DNS queries, single HTTP requests) because successive packets *could* be routed to different instances if BGP paths shift mid-conversation. For long-lived stateful connections (a TCP session), you need the routing to stay stable for the connection's duration, or you front the anycast address with load balancers that hand off to a stable backend. This is why anycast is the backbone of **DNS** (Ch. 9, where 8.8.8.8 and the root servers live) and **CDNs** (Ch. 17), both of which are dominated by short, stateless requests.

> **In the wild:** `8.8.8.8`, `1.1.1.1` (Cloudflare DNS), the 13 DNS root server addresses (each actually hundreds of anycast instances), and essentially every modern CDN edge all run on anycast. When you `ping 8.8.8.8` from two different continents and get single-digit-millisecond replies from both, you are not reaching the same machine — you're reaching two different machines that share an address, and BGP routed you to the near one. It's one of the most elegant tricks in networking.

---

## 5.7 Code: Building traceroute from Scratch

Time to make this concrete. **`traceroute`** reveals the actual sequence of routers your packets traverse — the realization of everything in this chapter. And it works by exploiting the **TTL** field (Ch. 4, §4.2) in a beautifully simple way:

```
   The TTL trick:
   • Send a packet with TTL=1. The FIRST router decrements it to 0, drops it, and
     sends back an ICMP "Time Exceeded" — revealing the first hop's IP.
   • Send a packet with TTL=2. It passes the first router (TTL→1), the SECOND router
     drops it (TTL→0) and replies — revealing the second hop.
   • Continue incrementing TTL until the packet finally reaches the destination,
     which replies differently (e.g. ICMP Echo Reply or a Port Unreachable),
     signaling "we've arrived."
   • Each hop reveals one router; the round-trip time of each reply measures latency
     to that hop.
```

Here's a working implementation using raw sockets, sending ICMP Echo Requests with increasing TTL (the classic approach; the real `traceroute` defaults to UDP but the principle is identical).

**`traceroute.c`** **`[needs CAP_NET_RAW / sudo]`**

```c
/* traceroute.c — discover the routers between here and a destination, using the
 * IP TTL field and ICMP Time Exceeded replies.
 *
 *   Build:  gcc -Wall -O2 -o mytrace traceroute.c
 *   Run:    sudo ./mytrace 8.8.8.8
 *
 * Sends ICMP Echo Requests with TTL = 1, 2, 3, ...  Each intermediate router that
 * decrements TTL to 0 returns an ICMP Time Exceeded, revealing its address. When a
 * reply comes from the destination itself (Echo Reply), we're done.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/ip_icmp.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/time.h>

#define MAX_HOPS 30
#define PROBES_PER_HOP 3
#define TIMEOUT_SEC 2

/* Standard Internet checksum (RFC 1071): one's-complement sum of 16-bit words. */
static unsigned short checksum(void *data, int len) {
    unsigned int sum = 0;
    unsigned short *p = data;
    while (len > 1) { sum += *p++; len -= 2; }
    if (len) sum += *(unsigned char *)p;          /* odd trailing byte */
    sum = (sum >> 16) + (sum & 0xffff);           /* fold carries */
    sum += (sum >> 16);
    return (unsigned short)(~sum);
}

static double now_ms(void) {
    struct timeval tv; gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: %s <dest-ip>\n", argv[0]); return 1; }

    struct sockaddr_in dst = {0};
    dst.sin_family = AF_INET;
    if (inet_pton(AF_INET, argv[1], &dst.sin_addr) != 1) {
        fprintf(stderr, "bad IP: %s\n", argv[1]); return 1;
    }

    /* Raw ICMP socket: we craft ICMP, kernel adds the IP header (but lets us set TTL). */
    int sock = socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
    if (sock < 0) { perror("socket (need sudo)"); return 1; }

    struct timeval tv = { TIMEOUT_SEC, 0 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);

    printf("traceroute to %s, %d hops max\n", argv[1], MAX_HOPS);

    int pid = getpid() & 0xffff;
    for (int ttl = 1; ttl <= MAX_HOPS; ttl++) {
        /* Set the IP TTL for outgoing packets — this is the whole trick. */
        setsockopt(sock, IPPROTO_IP, IP_TTL, &ttl, sizeof ttl);
        printf("%2d  ", ttl);

        int reached = 0;
        char last_addr[INET_ADDRSTRLEN] = "";

        for (int probe = 0; probe < PROBES_PER_HOP; probe++) {
            /* Build an ICMP Echo Request. */
            struct icmphdr icmp = {0};
            icmp.type = ICMP_ECHO;
            icmp.un.echo.id = pid;
            icmp.un.echo.sequence = ttl * 10 + probe;
            icmp.checksum = 0;
            icmp.checksum = checksum(&icmp, sizeof icmp);

            double t0 = now_ms();
            if (sendto(sock, &icmp, sizeof icmp, 0,
                       (struct sockaddr *)&dst, sizeof dst) < 0) {
                perror("sendto"); continue;
            }

            /* Wait for a reply (Time Exceeded from a router, or Echo Reply from dest). */
            char buf[512];
            struct sockaddr_in from; socklen_t fl = sizeof from;
            ssize_t n = recvfrom(sock, buf, sizeof buf, 0,
                                 (struct sockaddr *)&from, &fl);
            if (n < 0) { printf(" *  "); continue; }   /* timeout */

            double rtt = now_ms() - t0;
            char addr[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &from.sin_addr, addr, sizeof addr);

            /* The reply is an IP packet; the ICMP header starts after the IP header. */
            struct iphdr *rip = (struct iphdr *)buf;
            struct icmphdr *ricmp = (struct icmphdr *)(buf + rip->ihl * 4);

            if (strcmp(addr, last_addr) != 0) {        /* print addr once per hop */
                printf("%s  ", addr);
                strcpy(last_addr, addr);
            }
            printf("%.1fms  ", rtt);

            if (ricmp->type == ICMP_ECHOREPLY)          /* reached the destination */
                reached = 1;
            /* ICMP_TIME_EXCEEDED (11) means an intermediate router — keep going. */
        }
        printf("\n");
        if (reached) { printf("Reached %s.\n", argv[1]); break; }
    }
    close(sock);
    return 0;
}
```

Run `sudo ./mytrace 8.8.8.8` and watch your packets cross the planet, one revealed router at a time:

```
traceroute to 8.8.8.8, 30 hops max
 1  192.168.1.1  1.2ms  0.9ms  0.9ms        ← your home router (the gateway)
 2  100.64.0.1  9.1ms  8.8ms  9.0ms          ← ISP's CGNAT gateway (note the 100.64 CGNAT range!)
 3  10.21.4.1  9.5ms  9.2ms  9.4ms           ← inside the ISP's network
 4  72.14.215.85  11.0ms  10.8ms             ← entering Google's network (peering point)
 5  142.250.226.1  11.3ms  11.1ms
 6  8.8.8.8  11.5ms  11.2ms  11.4ms          ← arrived!
Reached 8.8.8.8.
```

Look at what this one command reveals from this chapter: hop 1 is your default gateway (the LPM default route in action, §5.2); the `100.64.x.x` at hop 2 is the CGNAT range (§5.5); the jump at hop 4 into Google's address space is you crossing an *AS boundary* via BGP peering (§5.4); the per-hop RTTs show latency accumulating with distance (the propagation-delay floor of Ch. 1). And the `*` you'll sometimes see for a hop is a router configured not to send Time Exceeded (or rate-limiting ICMP, §4.6) — the path is still traversed, that router just declines to identify itself. **You built a tool that x-rays the internet's structure, using nothing but the TTL field and ICMP.** Every concept in this chapter is visible in its output.

> **Why the real traceroute uses UDP/random high ports by default:** sending to a closed UDP port at the destination makes the *destination* reliably reply with "Port Unreachable" (a clean "you've arrived" signal), and using varying ports lets it correlate probes. But ICMP-based traceroute (what we built, and what Windows `tracert` uses) is conceptually identical — the TTL trick is the heart of all of them. Some firewalls block one method but not another, which is why having both in your toolkit matters when debugging.

---

## Key Takeaways

1. **Routing splits into two planes: the control plane (routing — building the table via OSPF/BGP, timescale of seconds, on the CPU) and the data plane (forwarding — moving each packet via the FIB, timescale of nanoseconds, in hardware).** The control plane writes the FIB; the data plane reads it. This split is the architecture of every router and the origin of "control plane vs. data plane" everywhere in infra (and the basis of SDN).

2. **Forwarding is longest-prefix match:** the most specific matching CIDR prefix wins, with `0.0.0.0/0` (the default route) as the natural catch-all. LPM is why CIDR's hierarchy works (broad routes + specific overrides), and it runs identically on your laptop's tiny table and a core router's million-entry one (accelerated by TCAM in hardware, LC-tries in software).

3. **Intra-domain routing (OSPF) and inter-domain routing (BGP) are different problems.** OSPF is link-state: every router floods its links, builds the full map, and runs *Dijkstra* to compute shortest paths — cooperative, optimal, fast-converging, but only works *within* one trusted administrative domain.

4. **BGP glues the internet together by routing between ~75,000 Autonomous Systems via path-vector advertisements (the AS-path).** Crucially, BGP picks routes by **policy and economics (LOCAL_PREF) first, path length second** — the internet's topology is shaped by *commercial relationships* (transit vs. peering, the Gao-Rexford "prefer customer > peer > provider" logic), not technical optimality. Your packets often take the *cheapest* path, not the shortest.

5. **BGP runs on trust and is insecure by design.** Route hijacks (announcing prefixes you don't own — e.g. Pakistan Telecom taking down YouTube globally in 2008) and route leaks (improperly re-announcing routes — e.g. Facebook's 2021 outage) regularly disrupt millions. RPKI is slowly adding origin authentication, but the protocol holding the internet together is fundamentally fragile.

6. **NAT/PAT lets a whole private network share one public IP by rewriting source IP:port and tracking the mappings.** It bought IPv4 ~20 extra years but broke the end-to-end principle: inside hosts can initiate out but can't receive unsolicited inbound — which is why P2P needs STUN/TURN/ICE/hole-punching and why home-hosted servers need port forwarding. CGNAT extends this to the ISP level.

7. **Anycast announces the same IP prefix from many locations and lets BGP route each user to the nearest one — for free.** It gives latency reduction, geographic load distribution, DDoS dilution, and implicit failover, which is why DNS (8.8.8.8, root servers) and CDNs are built on it. Works best for short, stateless requests.

8. **traceroute exploits the TTL field:** send packets with TTL 1, 2, 3, ..., collect the ICMP "Time Exceeded" replies each expiring router sends, and reconstruct the path hop by hop. One command reveals your gateway, CGNAT, AS boundaries (BGP peering points), and per-hop latency — the whole chapter made visible.

---

## Interview Drills

**Q1. What's the difference between the control plane and the data plane in a router?**
*Model answer:* The data plane (forwarding) is the per-packet fast path: a packet arrives, the router looks up its destination IP in the forwarding table (FIB) and sends it out an interface toward the next hop. This happens at line rate — billions of packets/sec on a core router — typically in dedicated hardware (ASIC/TCAM) with no CPU involvement per packet. The control plane (routing) is the background process that *builds* that table: it runs routing protocols (OSPF, BGP) to exchange reachability with neighbors, computes best paths, reacts to topology changes, and maintains the routing table (RIB), from which the FIB is distilled. Timescales differ by orders of magnitude — nanoseconds for forwarding, seconds for routing. The separation is why a router keeps forwarding at full speed while its protocols reconverge after a failure, and it's the conceptual basis for SDN, which centralizes the control plane and leaves switches as pure data planes.

**Q2. A packet's destination matches several routes in the table. How does the router choose?**
*Model answer:* Longest-prefix match: among all matching prefixes, the most specific one — the one with the most network bits — wins. So if 10.0.0.0/8, 10.1.0.0/16, and 10.1.2.0/24 all match 10.1.2.55, the /24 wins. This is what makes CIDR's hierarchy useful: you can have a broad route and override it with more-specific exceptions, and LPM automatically applies the exception where it exists and the broad route everywhere else. The default route 0.0.0.0/0 is just the limiting case — it matches everything with zero required bits, so it's chosen only when nothing more specific matches, giving exactly the "send anything I don't have a specific route for to the gateway" behavior. Doing LPM fast at scale (a million prefixes at line rate) needs special hardware (TCAM, which matches all entries in parallel) or efficient trie structures in software.

**Q3. Why does the internet use two different routing protocols (OSPF and BGP) instead of one?**
*Model answer:* Because intra-domain and inter-domain routing are fundamentally different problems. Within one administrative domain (a company, one ISP), all routers are owned by the same entity, fully trust each other, and want the technically optimal path — so OSPF works: every router floods its link states, builds the complete network map, and runs Dijkstra for shortest paths. That model is impossible across the whole internet: you can't ask every router on Earth to hold the global topology, and you certainly can't have networks trust link-state advertisements from competitors. Between domains you have ~75,000 independently-operated Autonomous Systems with conflicting commercial interests who route based on *business policy*, not technical distance. BGP is built for that: it's a path-vector protocol that advertises reachability with AS-paths, scales to the whole internet, and selects routes primarily by policy (LOCAL_PREF — prefer routes that make/save money) rather than shortest path. Different trust models and goals demand different protocols.

**Q4. Someone says "the internet always routes packets along the shortest path." Correct them.**
*Model answer:* That's true only *inside* a single network (OSPF computes genuinely shortest paths via Dijkstra). *Between* networks, BGP does not optimize for distance — it optimizes for *policy and economics*. BGP's first and highest-priority selection criterion is LOCAL_PREF, which networks set according to business relationships: by the Gao-Rexford rules, an AS prefers routes through paying customers, then settlement-free peers, then (last resort) paid providers — because that's what's cheapest. Only after policy does BGP consider AS-path length, and even that's a crude hop-count proxy, not real distance. The consequence is that your traffic often takes a longer-than-necessary path because that's the one that's financially preferable to the ASes involved — e.g. detouring to a city where two networks peer for free. The internet's topology is an economic artifact as much as an engineering one, which is exactly why traceroute sometimes shows surprising detours.

**Q5. Explain how NAT works and one significant problem it causes.**
*Model answer:* NAT (specifically PAT/"NAT overload") lets many devices on a private network share one public IP. When an inside host (192.168.1.5:51000) sends a packet out, the NAT router rewrites the source to its own public IP and a unique source port (203.0.113.7:60001), records the mapping in a connection-tracking table, and forwards it. Replies come back to the public IP:port; the router consults the table and rewrites the destination back to the original inside host. Port numbers let thousands of inside hosts multiplex onto one public IP. The significant problem: it breaks the end-to-end principle. Inside hosts have no globally-reachable address — they can *initiate* outbound connections (which create the mapping) but can't *receive* unsolicited inbound connections (no mapping exists until they reach out). This makes peer-to-peer connectivity hard: two hosts both behind NAT can't directly connect, requiring workarounds like STUN (discover your public mapping), TURN (relay through a public server), and hole-punching (both initiate simultaneously). It's why WebRTC/video-calling has all that connection machinery and why hosting a server from home needs port forwarding.

**Q6. How can one IP address, like 8.8.8.8, serve users on every continent with single-digit-millisecond latency?**
*Model answer:* Anycast. The same IP prefix (8.8.8.0/24) is announced into BGP from hundreds of physically separate locations simultaneously. Because BGP independently computes the best path from every point on the internet, each user's traffic is naturally routed to the topologically nearest announcing instance — a Tokyo user reaches the Tokyo server, a London user the London server — all using the identical destination IP but landing on different physical machines. The routing system does the proximity-routing and load-distribution for free; no one configures "these users go here." Benefits: low latency (everyone hits a nearby instance — the CDN principle realized through routing), geographic load spreading, DDoS dilution (an attack hits the nearest instance, not one global target), and automatic failover (a dead instance withdraws its announcement and BGP reroutes to the next-nearest). The catch is it suits short, stateless requests (DNS, single HTTP requests) because long-lived stateful connections could break if BGP reroutes mid-session — which is exactly why DNS and CDN edges, dominated by short requests, are anycast's killer applications.

**Q7. How does traceroute work?**
*Model answer:* It exploits the IP TTL (hop-limit) field. Traceroute sends a probe with TTL=1; the first router decrements it to 0, drops the packet, and — per IP's rules — sends back an ICMP "Time Exceeded" message, whose source address reveals that first router. Then it sends TTL=2, which expires at the second router, revealing it; then TTL=3, and so on, incrementing until the probe finally reaches the destination, which replies with a different message (Echo Reply for ICMP probes, or Port Unreachable for UDP probes) signaling arrival. Each reply's round-trip time measures latency to that hop. So by walking the TTL up and collecting who replies, traceroute reconstructs the router-by-router path. A `*` for a hop means that router didn't return a Time Exceeded (disabled or rate-limited ICMP) — the path still works, that hop just declined to identify itself. The same TTL trick underlies ICMP traceroute, UDP traceroute, and Windows tracert; they differ only in probe type and the "arrived" signal.

---

*Previous: [Chapter 4 — The Network Layer: IP](./04-network-layer-ip.md) | Next: [Chapter 6 — The Transport Layer: UDP and Ports](./06-transport-udp-and-ports.md)*
