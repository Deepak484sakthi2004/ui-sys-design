# Chapter 4 — The Network Layer: IP

> *The link layer (Chapter 3) can get a frame to any device on your local wire. But the machine you actually want to reach — a server running this website — is not on your wire. It's in a data center on another continent, behind a dozen networks owned by a dozen companies that have never coordinated with each other. How does a packet cross all of that? The answer begins here, with the protocol that is the literal definition of "the internet": **IP**.*

In Chapter 2 we called IP the "thin waist" — the one protocol everything converges on, the layer where any application meets any physical medium. In Chapter 3 we saw that the link layer's reach ends at the local segment: flat MAC addresses can't be routed globally. Now we build the layer that *can* reach globally, and it rests on two ideas that this chapter develops in depth:

1. **A global, hierarchical addressing scheme** — IP addresses — structured so that routers can make forwarding decisions without knowing where every individual machine is.
2. **Best-effort, connectionless delivery** — IP promises *nothing*. It will *try* to deliver your packet to the destination IP, but it may drop it, duplicate it, reorder it, or corrupt it, and it will never tell you. Every reliability guarantee you enjoy is built *on top* of this deliberately unreliable foundation (TCP, Chapter 7).

This chapter is where you learn to read an IP header the way you read a sentence, do subnet arithmetic in your head (a guaranteed interview question and a daily skill), and understand the two footguns — fragmentation and MTU mismatches — that cause a disproportionate share of real-world "it works for small requests but hangs for large ones" mysteries. We extend our sniffer from Chapter 3 up one layer to decode IP headers off the wire.

---

## 4.1 Why IP's Design Is the Way It Is

Before the bytes, the philosophy — because IP's two defining choices (hierarchical addressing, best-effort delivery) are deliberate, and understanding *why* makes everything else obvious.

**Best-effort, connectionless ("the dumb network").** IP keeps *no connection state* in the routers. Each packet — called a **datagram** — is forwarded independently, on its own merits, with no memory of packets before it and no promise about packets after. A router looks at a packet's destination, picks a next hop, forwards it, and forgets it. This was a radical choice (the competing telephone-network model kept elaborate per-call state in the switches). The payoff is the **end-to-end principle**, one of the most important ideas in systems design: *keep the network simple and dumb; put the intelligence (reliability, ordering, congestion control) at the endpoints.* The benefits are enormous:
- **Routers stay simple and fast** — no per-connection state to store or look up, so they scale to forwarding billions of packets/sec.
- **The network is robust** — if a router fails, packets just route around it; there's no connection state to lose. (This was a literal Cold War design goal: a network that survives nodes being destroyed.)
- **Innovation lives at the edges** — you can invent a new transport protocol (QUIC) by changing only the endpoints, because the network in the middle doesn't know or care what's inside the packets. The dumb network is a *permissionless* platform.

The cost: IP itself guarantees nothing, so *someone* must build reliability on top. That someone is TCP, and "reliable byte stream over an unreliable datagram service" is the whole story of Chapter 7.

**Hierarchical addressing (so routing can scale).** Recall from Chapter 3 that MAC addresses are flat and therefore unroutable globally — a router can't aggregate them. IP addresses are *hierarchical*: structured so that a single routing-table entry can cover millions of addresses ("everything starting with `52.94.x.x` goes that way"). This aggregation is what lets the global routing table stay at ~1 million entries instead of ~20 billion (one per device). Hierarchy is the entire reason IP scales, and CIDR (§4.4) is how the hierarchy is expressed. Hold this: *flat = local, hierarchical = global,* and routing is only possible because of the hierarchy.

---

## 4.2 The IPv4 Header, Field by Field

The IPv4 header (RFC 791, from 1981 — and still running the internet) is 20 bytes minimum. Every field earns its place; let's read all of them.

```
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |Version|  IHL  |    DSCP   |ECN|         Total Length          |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |         Identification        |Flags|     Fragment Offset     |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |  Time to Live |    Protocol   |        Header Checksum        |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                       Source IP Address                       |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                    Destination IP Address                     |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                    Options (if IHL > 5)         |   Padding   |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                          Payload (L4)...                       |
```

**Version (4 bits).** `4` for IPv4, `6` for IPv6. The very first nibble tells the receiver which header format follows.

**IHL — Internet Header Length (4 bits).** The header length in 32-bit *words*. Normally `5` (5 × 4 = 20 bytes, no options). It exists because the header is variable-length (options can extend it), and the receiver needs to know where the header ends and the payload begins. Max value 15 → max 60-byte header.

**DSCP + ECN (8 bits).** **DSCP** (Differentiated Services Code Point, 6 bits) is for **QoS** — marking packets by priority class so routers can prioritize, say, voice over bulk download. **ECN** (Explicit Congestion Notification, 2 bits) is a clever congestion signal: instead of *dropping* a packet to signal congestion, a router can *mark* it (set the ECN bits), and the endpoints react by slowing down — congestion feedback without packet loss. ECN is a key character in Chapter 8; remember it lives here, in the IP header.

**Total Length (16 bits).** The entire packet size — header + payload — in bytes. 16 bits caps it at 65,535 bytes, though in practice the link MTU (1500) caps it far lower. This is how the receiver knows the packet's true length (the link layer might pad, so you can't trust the frame size).

**Identification, Flags, Fragment Offset (the fragmentation triplet).** These three fields exist solely for **fragmentation** (§4.5) — splitting a too-big packet into pieces and reassembling them. **Identification** tags all fragments of one original packet so they can be matched up. **Flags** include DF (Don't Fragment) and MF (More Fragments). **Fragment Offset** says where this fragment sits in the original. We'll dwell on these in §4.5 because they're a rich source of bugs and a (now largely discouraged) mechanism.

**TTL — Time To Live (8 bits).** A hop counter, and one of the most important fields. Each router that forwards the packet *decrements TTL by 1*; if it hits 0, the router **drops the packet and sends an ICMP "Time Exceeded" message back to the source.** Purpose: prevent packets from circling forever in a routing loop (a misconfiguration that would otherwise melt the network). The starting value is typically 64 or 128. **TTL is the mechanism `traceroute` exploits** — by sending packets with TTL 1, 2, 3, ... and collecting the "Time Exceeded" replies, you discover each router on the path (we build exactly this in Chapter 5).

**Protocol (8 bits).** The **demux key** for L4: `6` = TCP, `17` = UDP, `1` = ICMP, `41` = IPv6 encapsulation, etc. When IP finishes with a packet, this field tells it which transport handler to pass the payload up to. (This is the IP-layer equivalent of Ethernet's EtherType.)

**Header Checksum (16 bits).** A checksum over the *header only* (not the payload — the payload's integrity is the transport layer's job). Because TTL changes at every hop, this checksum must be *recomputed at every router* — a per-hop cost. (IPv6 dropped this field entirely, reasoning that L2 CRC and L4 checksums already cover the data, and recomputing per hop was wasteful — see §4.3.)

**Source and Destination IP Addresses (32 bits each).** The headline fields: *where the packet is going* (destination — what routers actually forward on) and *where it came from* (source — where replies go). These are the end-to-end addresses that, unlike the MAC addresses around them, **stay constant across the entire journey** (barring NAT, Chapter 5). Recall the Chapter 2 image: the IP packet is the through-traveler; the Ethernet frame is the local taxi rebuilt each hop.

**Options + Padding (variable).** Rarely used (record-route, timestamp, source-routing). Most options are security-filtered or ignored today. Their existence is why IHL exists.

> **The fields that matter most in practice,** if you're prioritizing: **destination IP** (what gets forwarded on), **TTL** (loop prevention + traceroute), **Protocol** (L4 demux), and the **fragmentation triplet** (source of subtle bugs). The rest you should recognize but rarely touch.

---

## 4.3 IPv6: What the Redesign Fixed

IPv4 has 32-bit addresses — about 4.3 billion of them. In 1981 that was effectively infinite. By the 2010s, with billions of phones, laptops, servers, and IoT devices, it ran out. **IPv6** (RFC 8200) is the long, painful, still-incomplete migration to a larger, cleaner address space. Its header is a deliberate simplification of IPv4's:

```
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |Version| Traffic Class |           Flow Label                  |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |         Payload Length        |  Next Header  |   Hop Limit   |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                                                               |
   +                     Source Address (128 bits)                 +
   |                                                               |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                                                               |
   +                  Destination Address (128 bits)               +
   |                                                               |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

What changed, and why:

- **128-bit addresses** (vs. 32). That's 3.4×10³⁸ addresses — enough to give every grain of sand on Earth billions. Written as eight groups of hex: `2001:0db8:85a3:0000:0000:8a2e:0370:7334`, abbreviated by dropping leading zeros and collapsing one run of zero-groups to `::` → `2001:db8:85a3::8a2e:370:7334`. The address-exhaustion problem is solved permanently.
- **Fixed 40-byte header, no IHL, no checksum, no options-in-the-base-header.** IPv6's base header is a *fixed* size with a clean layout, which makes hardware forwarding faster. Options moved to optional **extension headers** chained via the **Next Header** field (which doubles as the Protocol demux key). The header *checksum is gone entirely* — IPv6 trusts L2's CRC and L4's checksum, saving the per-hop recomputation cost.
- **No router fragmentation.** In IPv6, routers *never* fragment; only the sender may, guided by Path MTU Discovery. This removes a whole class of fragmentation attacks and per-hop work (§4.5).
- **Flow Label** — a field for labeling packet flows so routers can handle related packets consistently (useful for QoS and load balancing) without deep-inspecting each packet.

> **Why has IPv6 taken 25+ years and still isn't universal?** Because IP is the thin waist (Chapter 2), and changing the waist means changing *everything* — every host, router, firewall, and application assumption. IPv4 and IPv6 aren't directly interoperable (an IPv4-only host can't talk to an IPv6-only host without translation), so the migration requires running *both* (dual-stack) for a long transition. And **NAT** (Chapter 5) relieved the address-exhaustion pressure enough that IPv4 limped on far longer than predicted — NAT let thousands of devices share one public IPv4 address, removing the urgency. As of the mid-2020s, IPv6 carries a large and growing share of traffic (mobile networks especially), but dual-stack remains the norm. It's the canonical case study in how hard it is to change a foundational layer that everything depends on.

---

## 4.4 Addressing, Subnetting, and CIDR

This section is the one to *practice* until it's reflexive, because subnetting is asked in nearly every infrastructure interview and used every time you configure a network, a VPC, or a firewall rule. The goal: do this arithmetic in your head.

### The address and the mask

An IPv4 address is 32 bits, written as four 8-bit "octets" in decimal: `192.168.1.20` = `11000000.10101000.00000001.00010100`. An address by itself doesn't tell you which part identifies the *network* and which identifies the *host* within it. That split is defined by a **subnet mask** or, equivalently, a **CIDR prefix length**:

```
   192.168.1.20 / 24       ("slash 24" — the first 24 bits are the network part)

   Address:  11000000.10101000.00000001.00010100   = 192.168.1.20
   Mask /24: 11111111.11111111.11111111.00000000   = 255.255.255.0
             └────────── network (24) ─────┘└host(8)┘

   Network address (host bits = 0):    192.168.1.0    ← names the subnet itself
   Broadcast address (host bits = 1):  192.168.1.255  ← "everyone on this subnet"
   Usable host range:                  192.168.1.1  –  192.168.1.254  (254 hosts)
```

The **prefix length** (the `/24`) is how many leading bits are the network. The rest are host bits. This is **CIDR — Classless Inter-Domain Routing** (RFC 4632), and the word "classless" matters: before CIDR, addresses came in rigid "classes" (Class A = /8, B = /16, C = /24) that wasted enormous space. CIDR replaced classes with arbitrary prefix lengths, so you can carve address space at *any* bit boundary, exactly sizing each subnet to need.

### The arithmetic you must be able to do

Given a CIDR block, you should be able to instantly state: how many addresses, the network address, the broadcast address, and the usable host range. The key facts:

```
   Host bits = 32 − prefix.    Total addresses = 2^(host bits).
   Usable hosts = 2^(host bits) − 2   (subtract network addr and broadcast addr).

   /24  → 8 host bits  → 256 addresses, 254 usable    (a typical small LAN)
   /25  → 7 host bits  → 128 addresses, 126 usable
   /26  → 6 host bits  →  64 addresses,  62 usable
   /27  → 5 host bits  →  32 addresses,  30 usable
   /28  → 4 host bits  →  16 addresses,  14 usable
   /30  → 2 host bits  →   4 addresses,   2 usable     (a point-to-point link)
   /16  → 16 host bits → 65,536 addresses              (a big network, e.g. 10.0.0.0/16)
   /32  → 0 host bits  →   1 address                   (a single host — a "host route")
```

**Worked example — the kind you'll be asked to do live.** *"What subnet does `10.20.30.200/26` belong to, and what's its usable range?"*

A /26 means the first 26 bits are network, leaving 6 host bits. 6 host bits = blocks of 64 addresses. So /26 subnets of `10.20.30.x` start at `.0, .64, .128, .192`. `200` falls in the `.192` block (`192 ≤ 200 < 256`). Therefore:
- Network address: `10.20.30.192`
- Broadcast address: `10.20.30.255` (192 + 64 − 1)
- Usable range: `10.20.30.193` – `10.20.30.254` (62 hosts)

The trick that makes this fast: **the prefix determines a "block size" = 256 − (the mask's last nonzero octet), and subnets fall on multiples of that block size.** For /26, mask octet = 192, block size = 64; subnets at 0/64/128/192. For /28, mask octet = 240, block size = 16; subnets at 0/16/32/.../240. Internalize the block-size trick and you can subnet in your head.

### Private addresses, special ranges

A few ranges you'll recognize constantly (RFC 1918 private space and friends):

```
   10.0.0.0/8         private (16M addresses — big orgs, cloud VPCs)
   172.16.0.0/12      private (1M addresses)
   192.168.0.0/16     private (65K — home/office routers default here)
   127.0.0.0/8        loopback (127.0.0.1 = localhost — never leaves the machine)
   169.254.0.0/16     link-local (auto-assigned when DHCP fails; also cloud metadata
                                  endpoint 169.254.169.254 — worth knowing!)
   0.0.0.0/0          "the default route" / "any address" (the whole internet)
```

**Private ranges** (`10.x`, `172.16-31.x`, `192.168.x`) are not routable on the public internet — they're reused inside millions of separate private networks, made to reach the internet via **NAT** (Chapter 5). This is why your laptop is `192.168.1.x` and so is everyone else's: it's private, behind your router's NAT. **`0.0.0.0/0`** is the *default route* — "if no more-specific route matches, send it here" (toward the internet); it's the route your laptop uses for everything outside its own subnet, pointing at the gateway.

### Why CIDR is what makes routing scale

CIDR isn't just for sizing subnets — it's the mechanism behind **route aggregation**, the thing that keeps the global routing table manageable. An ISP that owns `52.0.0.0/8` can advertise to the rest of the internet a *single* route — "all 16 million addresses under `52.x.x.x` are reachable through me" — instead of millions of individual routes. Routers forward using **longest-prefix match**: when multiple routes could match a destination, the one with the *most specific* (longest) prefix wins. This combination — hierarchical CIDR blocks + longest-prefix match — is the entire basis of internet-scale routing, and it's the first thing we build on in Chapter 5. For now, hold the connection: *the subnet math you just learned is the same math that makes the global internet routable.*

---

## 4.5 Fragmentation and the MTU Problem

Recall the 1500-byte Ethernet MTU from Chapter 3. Now suppose IP needs to send a 4000-byte packet across a link that only accepts 1500-byte frames. It has two options, and the history of IP is partly the story of moving from the first to the second.

**Option 1 — Fragmentation (the old way).** IP splits the oversized packet into fragments that each fit the MTU, using the fragmentation triplet from §4.2:

```
   Original 4000-byte IP packet (20B header + 3980B data), MTU = 1500:

   Fragment 1: [IP hdr | bytes 0–1479]      MF=1, offset=0
   Fragment 2: [IP hdr | bytes 1480–2959]   MF=1, offset=185  (1480/8)
   Fragment 3: [IP hdr | bytes 2960–3979]   MF=0, offset=370  (2960/8)

   All three share the same Identification field, so the receiver can group them.
   MF (More Fragments) = 1 on all but the last. Offset is in 8-byte units.
   The RECEIVER reassembles; routers along the way just forward fragments.
```

Fragmentation *works*, but it's a footgun for several reasons, which is why it's discouraged:
- **Loss amplification:** if *any one* fragment is dropped, the *entire* original packet is lost (the receiver can't reassemble) and must be resent in full. One lost fragment wastes all the others.
- **Reassembly cost and DoS:** the receiver must buffer fragments and hold reassembly state — a target for attacks (send many incomplete fragment sets to exhaust memory; the "teardrop" and related attacks abused overlapping fragments).
- **Firewalls and load balancers hate it:** only the first fragment has the L4 header (the TCP/UDP ports), so a stateless firewall or an ECMP load balancer (Chapter 5) can't classify the *later* fragments — they don't know the ports. This breaks filtering and can split a flow across paths.

**Option 2 — Path MTU Discovery (the modern way).** Instead of fragmenting, the sender *avoids producing oversized packets in the first place* by discovering the smallest MTU along the entire path and sizing packets to fit. The mechanism is clever, and it leans on ICMP and the DF flag:

```
   PMTUD:
   1. Sender sets the DF (Don't Fragment) flag on its packets and sends them at
      its local MTU (1500).
   2. If a router along the path has a smaller MTU (say 1400, common with VPN/PPPoE
      tunnels that add overhead) and DF is set, it CANNOT fragment — so it DROPS the
      packet and sends back an ICMP "Fragmentation Needed" message stating the MTU it
      can handle (1400).
   3. The sender receives the ICMP, lowers its packet size to 1400, and retransmits.
   4. Repeat until packets traverse the whole path without being dropped.
```

This is how TCP avoids fragmentation entirely: it discovers the path MTU and sets its MSS (Maximum Segment Size, Chapter 7) so its segments always fit. IPv6 *mandates* this approach — routers never fragment, so the sender *must* do PMTUD.

> **The classic real-world bug — and why this section earns its place.** PMTUD depends on those ICMP "Fragmentation Needed" messages getting back to the sender. But many networks, out of misguided "security," **block all ICMP**. Now PMTUD is broken silently: the oversized packets are dropped by the small-MTU router, but the ICMP that would tell the sender *why* never arrives. The result is a maddening, specific symptom: **small requests work fine, but large transfers hang.** The TCP handshake (tiny packets) succeeds, small responses succeed, but the moment a full-size data packet needs to cross the small-MTU link, it's silently dropped, and the connection stalls forever (this is called a **PMTUD black hole**). Engineers burn *days* on this because the symptom — "works for small, hangs for big" — doesn't obviously point at MTU. The lesson: **don't blanket-block ICMP**, and when a connection works for small payloads but hangs for large ones, *suspect MTU/PMTUD first*. This single piece of knowledge will one day save you a very bad day.

---

## 4.6 ICMP: The Network's Control and Error Channel

We've already leaned on **ICMP (Internet Control Message Protocol)** twice — for TTL-expiry (`traceroute`) and PMTUD ("Fragmentation Needed"). It deserves a proper introduction, because it's the network's *out-of-band signaling* layer: not for carrying user data, but for IP to report errors and exchange control/diagnostic information about packet delivery.

ICMP rides directly inside IP (Protocol = 1) and its messages are small (type + code + checksum + payload, usually including the header of the packet that triggered it, so the sender knows *which* packet failed). The ones that matter:

```
   ICMP message      Type  When / Why                            Tool that uses it
   ──────────────    ────  ───────────────────────────────────   ─────────────────
   Echo Request/Reply 8/0  "are you alive?" / "yes"               ping
   Time Exceeded       11  TTL hit 0 at a router                  traceroute
   Destination         3   host/port/network unreachable;          (error reporting)
     Unreachable             code 4 = "Fragmentation Needed"      PMTUD
   Redirect            5   "use a better gateway for this dest"   (route optimization)
```

**`ping`** is just ICMP Echo Request/Reply: send "are you there?", measure how long the reply takes (round-trip time), repeat. **`traceroute`** (Chapter 5) sends packets with increasing TTL and collects the Time Exceeded replies. **PMTUD** depends on Destination Unreachable / Fragmentation Needed. So three of the most fundamental diagnostic tools are ICMP in a trench coat.

> **The security tension that makes ICMP a perennial headache:** ICMP is genuinely useful (ping, traceroute, PMTUD all need it), but it's also abused — ping floods (DoS), ICMP tunneling (exfiltrating data inside ICMP payloads to bypass firewalls), and network mapping (attackers ping-sweep to find live hosts). So security teams are tempted to block it. But blocking it *too* aggressively breaks PMTUD (§4.5) and makes the network undiagnosable. The right answer is *rate-limiting and selective filtering*, not blanket blocking — but plenty of networks get it wrong, which is why "is ICMP being filtered?" is an early question in many a debugging session. ICMP is the network's nervous system; numbing it entirely has consequences.

---

## 4.7 Code: An IP Header Decoder

Let's extend the sniffer once more, climbing from L2 into L3. When a frame's EtherType is `0x0800` (IPv4), we parse the IP header and print its key fields — version, header length, TTL, protocol, addresses, and flags. This is decapsulation in code: Ethernet header off, then interpret the payload as IP.

**`ip_decode.c`** **`[needs CAP_NET_RAW / sudo, Linux]`**

```c
/* ip_decode.c — sniff frames; for IPv4 frames, decode the IP header.
 *   Build:  gcc -Wall -O2 -o ip_decode ip_decode.c
 *   Run:    sudo ./ip_decode
 * Extends Chapter 3's sniffer up one layer (L2 -> L3).
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/ethernet.h>

/* IPv4 header, wire layout. Bit-fields handle the two nibbles (version/IHL) and
 * the flags/offset. NOTE: bit-field ordering is compiler/endian-dependent; this
 * layout is correct for little-endian GCC/Clang, which covers x86 and ARM Linux. */
struct ipv4_hdr {
    unsigned char  ihl:4;        /* header length in 32-bit words */
    unsigned char  version:4;    /* 4 */
    unsigned char  tos;          /* DSCP + ECN */
    unsigned short tot_len;      /* total packet length */
    unsigned short id;           /* identification (fragmentation) */
    unsigned short frag_off;     /* flags (top 3 bits) + fragment offset (13 bits) */
    unsigned char  ttl;          /* time to live (hop count) */
    unsigned char  protocol;     /* 6=TCP 17=UDP 1=ICMP */
    unsigned short checksum;     /* header checksum */
    unsigned int   saddr;        /* source IP */
    unsigned int   daddr;        /* destination IP */
} __attribute__((packed));

static const char *proto_name(unsigned char p) {
    switch (p) { case 1: return "ICMP"; case 6: return "TCP";
                 case 17: return "UDP"; default: return "other"; }
}

int main(void) {
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) { perror("socket (need sudo)"); return 1; }

    unsigned char buf[ETH_FRAME_LEN];
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n < (ssize_t)sizeof(struct ethhdr)) continue;

        struct ethhdr *eth = (struct ethhdr *)buf;
        if (ntohs(eth->h_proto) != ETH_P_IP) continue;   /* IPv4 only */

        struct ipv4_hdr *ip = (struct ipv4_hdr *)(buf + sizeof(struct ethhdr));

        struct in_addr s = { .s_addr = ip->saddr };
        struct in_addr d = { .s_addr = ip->daddr };
        char src[INET_ADDRSTRLEN], dst[INET_ADDRSTRLEN];
        /* inet_ntop expects network-byte-order address bytes — saddr already is. */
        inet_ntop(AF_INET, &s, src, sizeof src);
        inet_ntop(AF_INET, &d, dst, sizeof dst);

        unsigned short frag = ntohs(ip->frag_off);
        int df = (frag & 0x4000) != 0;            /* Don't Fragment bit */
        int mf = (frag & 0x2000) != 0;            /* More Fragments bit */
        int offset = (frag & 0x1FFF) * 8;         /* fragment offset, in bytes */

        printf("IPv%d  %s -> %s  | proto=%s  ttl=%d  len=%d  hdr=%dB%s%s%s\n",
               ip->version, src, dst, proto_name(ip->protocol),
               ip->ttl, ntohs(ip->tot_len), ip->ihl * 4,
               df ? "  DF" : "",
               mf ? "  MF" : "",
               offset ? "  [fragment]" : "");
    }
    close(fd);
    return 0;
}
```

Sample output:

```
IPv4  192.168.1.5 -> 142.250.80.46    | proto=TCP   ttl=64  len=60  hdr=20B  DF
IPv4  142.250.80.46 -> 192.168.1.5    | proto=TCP   ttl=117 len=52  hdr=20B  DF
IPv4  192.168.1.5 -> 192.168.1.1      | proto=UDP   ttl=64  len=68  hdr=20B
IPv4  192.168.1.5 -> 8.8.8.8          | proto=ICMP  ttl=64  len=84  hdr=20B
```

Read what you've decoded: outbound packets leaving with `ttl=64` (your machine's default starting TTL), replies coming back with `ttl=117` (started at 128, so they crossed ~11 routers — `128 − 117`), the `DF` flag set on TCP (PMTUD in action), a UDP packet to your gateway (`.1` — probably DNS, Chapter 9), an ICMP packet to `8.8.8.8` (a ping). **You are now reading the network layer of live internet traffic.** The TTL difference alone (64 → 117 means ~11 hops away) is a real diagnostic you can use: it tells you roughly how far away a host is, no traceroute needed.

> **The bit-field caveat, made explicit:** the `version:4`/`ihl:4` and `frag_off` parsing above uses C bit-fields and manual masking, and bit-field *ordering within a byte* is implementation-defined — the struct above is correct for little-endian GCC/Clang (x86, ARM), which is where you'll run it, but it is the kind of thing that bites you on a big-endian platform or a different compiler. For the multi-bit flags (DF/MF/offset) we deliberately did the masking *manually* on the `ntohs`-converted value rather than trusting bit-fields, which is the more portable approach. This is the messy reality of parsing real binary protocols that the clean diagrams hide: bit-packed fields and byte order are where the bugs live.

---

## Key Takeaways

1. **IP is best-effort, connectionless datagram delivery** — it promises nothing (may drop, dupe, reorder, corrupt) and keeps no per-connection state in routers. This "dumb network" choice embodies the *end-to-end principle*: simple, fast, robust, innovation-friendly core; intelligence (reliability) pushed to the endpoints. The cost — building reliability on top — is paid by TCP (Chapter 7).

2. **IP addresses are hierarchical so routing can scale.** The hierarchy (expressed via CIDR prefixes) lets routers aggregate millions of addresses into one routing-table entry — the only reason the global table is ~1M entries instead of ~20B. Flat = local (MAC), hierarchical = global (IP).

3. **Read the IPv4 header fluently:** version, IHL (header length), DSCP/ECN (QoS/congestion), Total Length, the **fragmentation triplet** (ID/Flags/Offset), **TTL** (hop count → loop prevention + traceroute), **Protocol** (L4 demux: 6=TCP, 17=UDP, 1=ICMP), header checksum (recomputed per hop), and the constant-across-the-journey source/dest addresses.

4. **IPv6 fixed exhaustion (128-bit addresses) and cleaned up the header** (fixed 40 bytes, no IHL, no checksum, no router fragmentation, extension headers). Its 25-year, still-incomplete rollout is the canonical lesson in how hard it is to change the thin waist — eased (and delayed) by NAT relieving the address pressure.

5. **Subnetting/CIDR is reflexive arithmetic you must own:** host bits = 32 − prefix; usable hosts = 2^(host bits) − 2; subnets fall on multiples of the block size (256 − last mask octet). Know the private ranges (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16, incl. cloud metadata 169.254.169.254), and the default route 0.0.0.0/0. This is the same hierarchy that powers longest-prefix-match routing (Chapter 5).

6. **Fragmentation is a footgun** (loss amplification, reassembly DoS, breaks firewalls/LBs because only the first fragment has L4 ports). The modern answer is **Path MTU Discovery** — discover the smallest path MTU (via DF flag + ICMP "Fragmentation Needed") and never produce oversized packets. IPv6 mandates this.

7. **The PMTUD black hole is a classic, costly bug:** networks that blanket-block ICMP break PMTUD silently, producing the signature symptom "small requests work, large transfers hang." When you see that symptom, suspect MTU/PMTUD first — it will save you days.

8. **ICMP is the network's control/error channel** (ping = Echo, traceroute = Time Exceeded, PMTUD = Fragmentation Needed). It's useful and abusable; rate-limit and selectively filter it — never blanket-block it, or you break diagnostics and PMTUD.

---

## Interview Drills

**Q1. IP is "unreliable" and "best-effort." What exactly does that mean, and why was it designed that way?**
*Model answer:* It means IP makes no delivery guarantees: a packet may be dropped, duplicated, delayed, reordered, or corrupted, and IP won't detect or report it or retransmit. It's connectionless — routers keep no per-flow state and forward each datagram independently. This was deliberate, embodying the end-to-end principle: keep the network core simple and stateless so it's fast (no per-connection lookups), robust (a failed router is just routed around — no connection state to lose, a Cold-War survivability goal), and innovation-friendly (new transports like QUIC need only endpoint changes since the core doesn't inspect payloads). The trade-off is that reliability must be built atop IP by the endpoints — which is precisely TCP's job: a reliable, ordered byte stream constructed over an unreliable datagram service.

**Q2. Why can't we route on MAC addresses? Why do we need IP's hierarchy?**
*Model answer:* MAC addresses are flat — 48 bits with no structure indicating location — so a router seeing a destination MAC has no way to know which direction leads toward it, and a global table would need one entry per device (~tens of billions), which is infeasible. IP addresses are hierarchical: the prefix encodes a network, so an entire block of addresses can be summarized by one routing entry ("everything under 52.0.0.0/8 goes this way"). This *aggregation*, expressed through CIDR and resolved by longest-prefix match, keeps the global routing table around a million entries. Hierarchy is the entire reason internet-scale routing is possible; flatness works only for local one-hop delivery on a small segment, which is exactly where MAC addresses are used.

**Q3. A host's app works fine for small requests but hangs whenever it transfers a large file. The TCP connection establishes successfully. What's your first hypothesis?**
*Model answer:* A Path MTU Discovery black hole, almost certainly caused by something blocking ICMP. The handshake and small requests use tiny packets that fit any MTU, so they succeed. But when a full-size data packet needs to cross a link with a smaller MTU than the sender assumes (common with VPN/PPPoE tunnels that add header overhead), that router — seeing the DF flag set — drops the packet and sends back an ICMP "Fragmentation Needed" message stating its MTU. If a firewall blocks that ICMP, the sender never learns to shrink its packets; it keeps sending oversized packets that are silently dropped, and the transfer stalls forever. The signature is exactly "small works, large hangs." Fix: stop blocking ICMP type 3 code 4 (or clamp MSS at the tunnel endpoint). This is why you never blanket-block ICMP.

**Q4. Subnet `10.20.30.200/26` for me — network, broadcast, usable range, and how many hosts.**
*Model answer:* /26 means 26 network bits, 6 host bits, so 2⁶ = 64 addresses per subnet and blocks of size 64. The /26 subnets of 10.20.30.x start at .0, .64, .128, .192. 200 falls in the .192 block (192 ≤ 200 < 256). So: network address 10.20.30.192, broadcast 10.20.30.255 (192 + 64 − 1), usable host range 10.20.30.193 through 10.20.30.254, which is 62 usable hosts (64 − 2, subtracting network and broadcast). The fast trick is the block-size method: mask's last octet for /26 is 192, block size = 256 − 192 = 64, subnets at multiples of 64.

**Q5. What does TTL do, and how does traceroute exploit it?**
*Model answer:* TTL (Time To Live) is an 8-bit hop counter in the IP header. Every router that forwards a packet decrements it by 1; if it reaches 0, the router discards the packet and sends an ICMP "Time Exceeded" message back to the source. Its purpose is to prevent packets from looping forever when there's a routing misconfiguration — without it, a loop would accumulate packets until the network melted. Traceroute exploits this deliberately: it sends packets with TTL=1, which the *first* router drops, returning a Time Exceeded that reveals the first hop's address; then TTL=2 to reveal the second hop; and so on, incrementing until the packets reach the destination. By collecting the source addresses of the Time Exceeded messages, traceroute reconstructs the entire path hop by hop. (Bonus: you can also estimate a host's distance from the TTL of its *replies* — a reply arriving with TTL 117 likely started at 128, so it crossed ~11 routers.)

**Q6. Why did IPv6 take decades to deploy, and what slowed it down?**
*Model answer:* Because IP is the internet's thin waist — *everything* depends on it — so changing it means touching every host, router, firewall, and application. IPv4 and IPv6 aren't directly interoperable (an IPv6-only host can't natively talk to an IPv4-only host), so the transition requires running both stacks (dual-stack) during a long overlap, with no flag-day cutover possible. The biggest delaying factor was NAT: by letting many private devices share one public IPv4 address, NAT relieved the address-exhaustion pressure that was supposed to force migration, so IPv4 limped on far past its predicted death. IPv6 also offered little immediate benefit to early adopters (a classic network-effect chicken-and-egg). It's now a large and growing share of traffic — mobile carriers especially are heavily IPv6 — but dual-stack remains common. It's the textbook case of how a foundational layer's ubiquity is exactly what makes it nearly impossible to change.

---

*Previous: [Chapter 3 — The Link Layer](./03-link-layer-lan-ethernet.md) | Next: [Chapter 5 — Routing the Internet](./05-routing-the-internet.md)*
