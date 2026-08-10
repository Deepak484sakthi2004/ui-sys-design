# Chapter 3 — The Link Layer and the LAN

> *Two machines on the same switch want to talk. Neither has ever heard of the other. There is no router involved, no DNS, no TCP — just two NICs, a switch between them, and a question: "who are you, and how do I put bytes on the wire addressed to you specifically?"* This chapter answers that question, and by the end you'll have written a program that reads the answer straight off the wire.

We've gotten a bit across a wire (Chapter 1) and we have a map of the whole stack (Chapter 2). Now we climb to **Layer 2, the data link layer**, and meet the first layer with real, parseable structure — the first layer where we stop talking about voltages and start talking about *frames* with *addresses* and *fields you can print*. This is also the chapter where the book stops being theory: we will write a raw-socket sniffer in C that captures live frames off your machine's NIC and a parser that decodes them byte by byte. From here on, every protocol we study, we study by reading its actual bytes.

The link layer's job, stated precisely, is narrow: **move a frame from one device to another device on the same physical network segment — one hop.** Not across the internet (that's L3, next chapter). Not to a specific program (that's L4). Just: get this frame to *that NIC over there, on this same wire/switch*, and detect if it got corrupted on the way. Everything in this chapter — Ethernet framing, MAC addressing, ARP, switching, VLANs — is in service of that one-hop delivery. But "one hop" is the foundation the entire internet is built on, because every global journey is just a sequence of one-hop deliveries, each one a link-layer problem solved.

---

## 3.1 The Ethernet Frame, Byte by Byte

**Ethernet** (IEEE 802.3) is the dominant link-layer technology for wired networks — it won so completely that "Ethernet frame" and "L2 frame" are nearly synonymous in practice. Wi-Fi (802.11) is its wireless cousin with a more complex frame (more addresses, because of access points), but the concepts transfer. We'll use Ethernet II framing (the variant essentially all IP traffic uses) as our concrete object of study.

Here is the complete frame, field by field:

```
   Ethernet II frame (the bytes on the wire, in order):

   ┌──────────────┬───────────┬───────────────┬──────────────┬───────────┬─────────────────────┬────────┐
   │  Preamble +  │ Dest MAC  │  Source MAC   │  EtherType   │           │      Payload        │  FCS   │
   │     SFD      │           │               │  (or Length) │           │   (the L3 packet)   │ (CRC)  │
   ├──────────────┼───────────┼───────────────┼──────────────┼───────────┼─────────────────────┼────────┤
   │   8 bytes    │  6 bytes  │   6 bytes     │   2 bytes    │           │   46 – 1500 bytes   │ 4 bytes│
   └──────────────┴───────────┴───────────────┴──────────────┴───────────┴─────────────────────┴────────┘
    ▲ added by PHY,            ◄──────────── this is what your software sees ──────────────────►
      not in software             (the "MAC frame" — 14-byte header + payload + 4-byte trailer)
```

Let's walk every field, because each one teaches something:

**Preamble + SFD (8 bytes).** Seven bytes of alternating `10101010` followed by a Start-of-Frame Delimiter (`10101011`). This isn't data — it's a wake-up call for the receiver's clock-recovery circuit. Remember §1.3: the receiver must lock its clock to the sender's signal. The preamble is a known pattern of guaranteed transitions that gives the PHY time to synchronize *before* the real data starts. **Your software never sees this** — the NIC's PHY strips it on receive and adds it on transmit. We mention it only so you know the frame on the wire is slightly bigger than the frame your code handles.

**Destination MAC address (6 bytes).** *Who is this frame for, on this segment?* The MAC (Media Access Control) address is a 48-bit identifier, written as six hex bytes (`a4:83:e7:1c:9b:02`). This is the *first* field on the wire for a reason: a NIC reading an incoming frame wants to know *immediately* whether the frame is addressed to it, so it can ignore frames meant for others without processing the whole thing. Destination first = fast rejection.

**Source MAC address (6 bytes).** *Who sent it?* So the receiver knows where to reply, and — crucially — so switches can learn the network topology (§3.4).

**EtherType (2 bytes).** *What's inside the payload?* This is the **demultiplexing key** from Chapter 2, made concrete. `0x0800` = the payload is an IPv4 packet. `0x86DD` = IPv6. `0x0806` = ARP (which we meet in §3.3). When the receiver's link layer finishes with the frame, this field tells it which higher-layer handler to pass the payload up to. (Historical wrinkle: in the original 802.3, this field was a *length*, not a type — values ≤ 1500 are interpreted as length, values ≥ 1536/`0x0600` as an EtherType. Modern IP traffic always uses it as EtherType.)

**Payload (46–1500 bytes).** The encapsulated L3 packet — the IP packet of Chapter 4 — treated as opaque bytes by Ethernet. Two bounds to know:
   - **Maximum 1500 bytes** is the famous **MTU (Maximum Transmission Unit)** of standard Ethernet. This single number echoes through the entire stack: it's why IP has fragmentation (Ch. 4), why TCP negotiates a Maximum Segment Size (Ch. 7), why Path MTU Discovery exists. 1500 is arguably the most consequential magic number in networking. ("Jumbo frames" raise it to ~9000 inside data centers, but 1500 is the universal safe default across the internet.)
   - **Minimum 46 bytes**: if the payload is smaller, it's *padded* up to 46. This minimum exists because of the old CSMA/CD collision-detection physics (§1.4.2) — a frame had to be long enough to still be transmitting when the most distant collision could come back. A fossil, like CSMA/CD itself, but the padding requirement remains in the standard.

**FCS — Frame Check Sequence (4 bytes).** A **CRC-32** checksum computed over the header and payload (the Chapter 1 error-detection mechanism). The receiving NIC recomputes it and **silently discards** any frame that doesn't match. Note again the division of labor: the link layer *detects* corruption and drops the frame; it does *not* retransmit. Recovery is somebody else's job (TCP). Like the preamble, the FCS is usually handled entirely by the NIC hardware — your software typically sees a frame that has *already passed* its CRC check, with the FCS stripped.

### The MAC address itself: flat, global, and burned in

A MAC address is worth dwelling on because its design contrasts sharply with the IP address of the next chapter, and the contrast is illuminating:

```
   MAC address:  a4:83:e7:1c:9b:02
                 └────┬────┘ └───┬───┘
                  OUI (24 bits)  NIC-specific (24 bits)
                  "who made it"  "which unit"

   Two special bits in the first byte:
     bit 0 (I/G): 0 = unicast (one NIC),  1 = multicast/broadcast (a group)
     bit 1 (U/L): 0 = globally unique (burned in), 1 = locally administered

   Broadcast address: ff:ff:ff:ff:ff:ff  = "every NIC on this segment"
```

The defining property: **MAC addresses are flat.** There is no hierarchy, no geography, no structure that tells you *where* a MAC address is — `a4:83:e7:1c:9b:02` could be in a laptop in Tokyo or a server in Texas; nothing in the address tells you. The first 24 bits (the **OUI**, Organizationally Unique Identifier) identify the *manufacturer* (Apple, Intel, etc. — you can look up any OUI), and the last 24 are assigned by that manufacturer to a specific NIC, traditionally "burned in" at the factory (though modern OSes randomize them for privacy).

This flatness is the key contrast with IP. **A MAC address says *who* you are; an IP address says *where* you are.** Because a MAC is flat and locationless, you cannot *route* on it across the internet — a router can't look at a MAC and know which direction to send it. Routing needs *hierarchy* (a structured address where the prefix tells you the general region), which is exactly what IP provides (Ch. 4). This is the deep reason we have *two* address systems: MAC for "who, on this local wire" (where a flat address is fine because the segment is small) and IP for "where, in the global internet" (where you need hierarchy to route). Bridging the two — given an IP, find the MAC — is the job of ARP, coming up in §3.3. But first, let's actually capture some frames.

---

## 3.2 Code: A Raw-Socket Frame Sniffer

Theory is cheap. Let's write a program that captures real Ethernet frames off your NIC and prints their headers — your first program that reads bytes straight off the wire. This is, in miniature, what `tcpdump` and Wireshark do.

The key that unlocks this is the **raw socket** with `AF_PACKET` (Linux) — a socket type that delivers entire link-layer frames to userspace, bypassing the kernel's normal protocol processing. `ETH_P_ALL` asks for *every* frame the NIC sees. This requires `CAP_NET_RAW` (run as root / `sudo`), because reading all your machine's traffic is a privileged operation.

**`sniff.c`** **`[needs CAP_NET_RAW / sudo, Linux]`**

```c
/* sniff.c — capture raw Ethernet frames and print their L2 headers.
 *
 *   Build:  gcc -Wall -O2 -o sniff sniff.c
 *   Run:    sudo ./sniff            (Linux; AF_PACKET is Linux-specific)
 *
 * This is the smallest useful packet sniffer: it opens a raw socket that
 * receives every frame the NIC sees, then decodes the 14-byte Ethernet
 * header of each. It is the foundation we extend with IP (Ch.4) and ARP (below).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>          /* ntohs */
#include <sys/socket.h>
#include <linux/if_packet.h>    /* AF_PACKET */
#include <linux/if_ether.h>     /* ETH_P_ALL, struct ethhdr, ETH_FRAME_LEN */
#include <net/ethernet.h>

/* Pretty-print a 6-byte MAC address into a caller-provided buffer. */
static void fmt_mac(const unsigned char *m, char *out) {
    sprintf(out, "%02x:%02x:%02x:%02x:%02x:%02x",
            m[0], m[1], m[2], m[3], m[4], m[5]);
}

/* Map an EtherType value to a human-readable name. */
static const char *ethertype_name(unsigned short et) {
    switch (et) {
        case 0x0800: return "IPv4";
        case 0x86DD: return "IPv6";
        case 0x0806: return "ARP";
        case 0x8100: return "802.1Q VLAN";
        default:     return "unknown";
    }
}

int main(void) {
    /* AF_PACKET + SOCK_RAW + ETH_P_ALL = "give me every frame, headers and all".
     * htons() because the protocol field here is in network byte order. */
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) {
        perror("socket (are you root? AF_PACKET is Linux-only)");
        return 1;
    }

    unsigned char buf[ETH_FRAME_LEN];   /* up to 1514 bytes: 14 hdr + 1500 payload */
    char src[18], dst[18];

    printf("Listening for frames... (Ctrl-C to stop)\n\n");
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n < 0) { perror("recv"); break; }
        if (n < (ssize_t)sizeof(struct ethhdr)) continue;  /* runt, ignore */

        /* The first 14 bytes are the Ethernet II header. Overlay the struct. */
        struct ethhdr *eth = (struct ethhdr *)buf;
        unsigned short et = ntohs(eth->h_proto);   /* wire is big-endian */

        fmt_mac(eth->h_source, src);
        fmt_mac(eth->h_dest,   dst);

        printf("%s -> %s  | EtherType 0x%04x (%-6s) | %zd bytes\n",
               src, dst, et, ethertype_name(et), n);
    }

    close(fd);
    return 0;
}
```

Run it (`sudo ./sniff`) and you'll see live output like:

```
Listening for frames... (Ctrl-C to stop)

a4:83:e7:1c:9b:02 -> ff:ff:ff:ff:ff:ff  | EtherType 0x0806 (ARP   ) | 42 bytes
a4:83:e7:1c:9b:02 -> 88:66:5a:11:cc:7d  | EtherType 0x0800 (IPv4  ) | 74 bytes
88:66:5a:11:cc:7d -> a4:83:e7:1c:9b:02  | EtherType 0x0800 (IPv4  ) | 66 bytes
33:33:00:00:00:fb -> ...                | EtherType 0x86DD (IPv6  ) | 90 bytes
```

Look at what you can already read: you see MAC addresses talking to each other, you see the `ff:ff:ff:ff:ff:ff` broadcast (almost certainly an ARP request — "who has this IP?"), you see the EtherType demultiplexing key telling you what's inside each frame. **You are reading the data link layer with your own eyes.** Everything in this book from here is an elaboration of this: open a socket, read bytes, overlay a struct, interpret the fields.

> **In the wild:** `struct ethhdr` is defined by the kernel (`<linux/if_ether.h>`) — we're using the *same* struct the Linux network stack uses internally. The `(struct ethhdr *)buf` cast is the canonical packet-parsing move: a network header is just a fixed byte layout, and a C struct *is* a fixed byte layout, so you overlay one on the other and read fields directly. (Caveats: this works because Ethernet headers have no alignment padding issues and we handle byte order with `ntohs`; for variable-length or bit-packed headers like IP options or TCP flags, you need more care, as we'll see.) On macOS/BSD, `AF_PACKET` doesn't exist — you'd use the BPF device (`/dev/bpf*`) instead; the *concept* is identical, the API differs.

---

## 3.3 ARP: The Bridge from IP to MAC

Here is a problem that has to be solved billions of times a second and that most engineers have never thought about. Your machine wants to send an IP packet to `192.168.1.20`, another machine on your local network. To put that packet on the wire, Ethernet needs a **destination MAC address** — but your application only knows the *IP* address. How do you find the MAC that corresponds to an IP, on your local segment?

The answer is **ARP — the Address Resolution Protocol** (RFC 826), the little protocol that glues L3 to L2. It answers exactly one question: *"Who has IP address X? Tell me your MAC."* And it answers it with beautiful simplicity — by *shouting to everyone* and letting the right machine respond:

```
   ARP resolution for 192.168.1.20:

   1. REQUEST (broadcast — to ff:ff:ff:ff:ff:ff, EVERYONE on the segment hears it):
      ┌─────────────────────────────────────────────────────────────┐
      │  "Who has 192.168.1.20? Tell a4:83:e7:1c:9b:02 (192.168.1.5)" │
      └─────────────────────────────────────────────────────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        192.168.1.10        192.168.1.20        192.168.1.30
        "not me, ignore"    "that's ME!"        "not me, ignore"
                                  │
   2. REPLY (unicast — sent directly back to the asker):
      ┌──────────────────────────────────────────────────────┐
      │  "192.168.1.20 is at 88:66:5a:11:cc:7d"               │
      └──────────────────────────────────────────────────────┘

   3. The asker CACHES the mapping (192.168.1.20 → 88:66:5a:11:cc:7d)
      in its ARP table, so it doesn't have to ask again for a while.
```

The mechanism, precisely:
1. The sender broadcasts an **ARP request** (EtherType `0x0806`) to the broadcast MAC `ff:ff:ff:ff:ff:ff`, so *every* device on the segment receives it. The request carries the sender's IP and MAC, and the *target IP* it's asking about (with the target MAC left blank — that's what it wants to learn).
2. Every machine on the segment inspects it, but only the one that *owns* the target IP responds. It sends an **ARP reply** — this time a *unicast*, addressed directly back to the requester's MAC — saying "that IP is me, here's my MAC."
3. The requester stores the result in its **ARP cache** (view it with `arp -a` or `ip neigh` on Linux), so subsequent packets to that IP skip the whole dance. Entries expire after a few minutes (so the table stays correct if a machine moves or its NIC changes).

You can now see why your `sniff.c` showed that `ff:ff:ff:ff:ff:ff` broadcast frame — it was almost certainly an ARP request. **Every single TCP connection to a machine on your local network begins with an ARP exchange** (or an ARP cache hit), before a single TCP byte flows. It's invisible, automatic, and absolutely fundamental — and it's the literal answer to "I have an IP, how do I get a frame to it on my wire."

### The ARP packet, and a security note

The ARP message sits in the Ethernet payload and has its own little format:

```
   ARP packet (28 bytes, inside an Ethernet frame with EtherType 0x0806):
   ┌────────────────┬────────────────┬──────┬──────┬─────────┐
   │ HW type (Eth=1)│ Proto (IPv4)   │ HLEN │ PLEN │ Opcode  │  opcode 1=request 2=reply
   ├────────────────┴────────────────┴──────┴──────┴─────────┤
   │ Sender MAC (6) │ Sender IP (4)                           │
   │ Target MAC (6) │ Target IP (4)                           │
   └─────────────────────────────────────────────────────────┘
```

> **Security aside — ARP spoofing.** Notice ARP has *no authentication whatsoever*. Any machine can reply to any ARP request, or send unsolicited "gratuitous" replies, claiming "I'm the gateway, here's my MAC." Victims cache the lie and send their traffic to the attacker — a **man-in-the-middle** attack called **ARP spoofing/poisoning**, trivial to execute on any LAN you can plug into. This is why local networks are a trust boundary, why public Wi-Fi is dangerous, and ultimately part of *why TLS exists* (Ch. 12): you cannot trust the network to deliver your bytes to the right machine unmolested, so you encrypt and authenticate end-to-end and stop trusting the network at all. ARP's naïve trust is a 1982 design meeting a 2020s threat model — another case of a foundational protocol predating the adversaries it now faces.

---

## 3.4 Switching: How the LAN Actually Forwards

We've been saying "the segment" and "everyone on the wire" as if all local machines share one cable. In 1980 they literally did (the coaxial party line of §1.4.2). Today they don't — they connect to a **switch**, and understanding how a switch works completes the local-delivery picture.

A switch is an L2 device with many ports, and its entire job is: *given a frame arriving on one port, send it out only the port(s) that need it.* The naive thing — send every frame out every port (a "hub," the dumb predecessor) — wastes bandwidth and is a security disaster (everyone sees everyone's traffic). A switch is smarter: it **learns** which MAC address lives on which port, and forwards selectively. The learning algorithm is elegant and worth knowing:

```
   The switch's MAC address table (a.k.a. CAM table), learned by observation:

   ┌──────────────────────┬──────┐
   │ MAC address          │ Port │
   ├──────────────────────┼──────┤
   │ a4:83:e7:1c:9b:02    │  3   │   learned: a frame FROM this MAC arrived on port 3,
   │ 88:66:5a:11:cc:7d    │  7   │   so this MAC must be reachable via port 3.
   │ ...                  │ ...  │
   └──────────────────────┴──────┘

   Forwarding a frame destined for MAC X:
     • X in table?  → send out ONLY that port (unicast forwarding). Efficient.
     • X not in table, or X is broadcast/multicast?
                    → FLOOD: send out every port except the one it came in on.
   Learning (on every frame): record (source MAC → arrival port) in the table.
```

The genius is that learning is *automatic and free*: every frame a switch forwards also teaches it something. The frame's *source* MAC plus its *arrival port* is a fact ("this MAC is reachable that way"), and the switch records it. Over the first few frames the table fills in, and flooding becomes rare. A switch needs no configuration to learn its topology — it deduces it from the traffic it carries. (When a destination is genuinely unknown, it floods, which is correct-but-inefficient; the reply teaches it the missing entry, so the next frame is forwarded precisely.)

This is why two machines on the same switch get a *private* conversation: once the switch has learned both their ports, frames between them go out only the two relevant ports — the other machines never see them. It's also why **broadcasts (like ARP) and the broadcast/unknown-unicast flooding define the "broadcast domain"**: a switch forwards broadcasts everywhere, so all ports on a switch (by default) are one broadcast domain. Limiting broadcast domains is exactly what VLANs (§3.5) are for.

> **In the wild:** The MAC table is finite (tens of thousands of entries in a typical switch). An attacker can overflow it by flooding frames with millions of fake source MACs — **MAC flooding** — until the table is full and the switch *fails open*, reverting to flooding everything out every port (becoming a hub). Now the attacker sees all traffic. This is a classic LAN attack, mitigated by "port security" features that cap MACs per port. Again: the local network is a trust boundary, and its protocols were designed for a friendlier era.

### Two collision/broadcast-domain facts to have crisp

These come up constantly and are easy to keep straight if you anchor on "what does this device do with a frame":

- A **collision domain** is a set of devices that could collide if they transmit simultaneously. Each switch *port* is its own collision domain (full-duplex point-to-point link, §1.4.2 — collisions are gone). Hubs put everyone in *one* collision domain (why hubs are extinct).
- A **broadcast domain** is the set of devices a broadcast frame reaches. A switch forwards broadcasts out all ports, so by default an entire switch (or set of interconnected switches) is **one broadcast domain.** To *break* a broadcast domain, you need either a **router** (L3 — broadcasts don't cross routers, which is half the point of routers) or a **VLAN** (which partitions one physical switch into multiple logical broadcast domains).

---

## 3.5 VLANs: Slicing One Wire Into Many

The last piece of the LAN puzzle. Physically, you might have one switch with 48 ports. Logically, you might want it to be *several separate networks* — engineering on one, finance on another, guest Wi-Fi on a third — that *cannot* see each other's broadcast traffic and are isolated for security, even though they share the same physical switch. **VLANs (Virtual LANs, IEEE 802.1Q)** do exactly this.

A VLAN partitions a physical switch into multiple logical broadcast domains by tagging frames with a **VLAN ID**. The mechanism is a tiny insertion into the Ethernet frame — a 4-byte **802.1Q tag** slipped in right after the source MAC:

```
   Untagged frame:
   ┌───────────┬───────────┬──────────────┬─────────────────┐
   │ Dest MAC  │ Source MAC │  EtherType   │     Payload     │
   └───────────┴───────────┴──────────────┴─────────────────┘

   802.1Q-tagged frame (4 bytes inserted):
   ┌───────────┬───────────┬─────────────────────┬──────────────┬─────────────────┐
   │ Dest MAC  │ Source MAC │  802.1Q tag (4 B)   │  EtherType   │     Payload     │
   └───────────┴───────────┴─────────────────────┴──────────────┴─────────────────┘
                            │  TPID=0x8100        │
                            │  PCP(3b) DEI(1b)    │  ← priority bits (QoS)
                            │  VLAN ID (12 bits)  │  ← 0–4095: which VLAN
                            └─────────────────────┘
```

The 12-bit VLAN ID allows 4,096 VLANs. The switch enforces the rule: **a frame tagged VLAN 10 is only ever forwarded to ports in VLAN 10.** Broadcasts stay within their VLAN. Two machines on the same physical switch but different VLANs *cannot* reach each other at L2 — they're as isolated as if they were on separate switches, and to talk they'd have to go up to a router (L3) that connects the two VLANs, where firewall rules can govern the crossing. Two port roles matter:
- **Access ports** carry one VLAN's untagged traffic (what a normal end device — a laptop — plugs into; it's blissfully unaware of VLANs).
- **Trunk ports** carry *many* VLANs' tagged traffic between switches (so VLAN 10 can span multiple switches across a building); the tag is how the receiving switch knows which VLAN each frame belongs to.

> **In the wild:** VLANs are everywhere in real infrastructure — they're how a cloud provider gives each tenant an isolated network on shared hardware (well, the modern version: VXLAN, which tunnels L2 over L3 to scale past 4096 and across data centers — same idea, bigger tag, encapsulated in UDP). They're how your office separates corporate from guest traffic on one set of switches. And the 802.1Q tag's priority bits (PCP) are one of the few places QoS (quality-of-service) prioritization actually happens at L2. When someone says "put the storage traffic on its own VLAN," this is the mechanism.

---

## 3.6 Code: Extending the Sniffer to Parse ARP

Let's close the loop with code, decoding the ARP packets we now understand. We extend `sniff.c`: when the EtherType is `0x0806`, parse the ARP payload and print the question or answer in plain English. This shows the *next* decapsulation step — Ethernet header off, now interpret the payload according to the EtherType.

**`arp_parse.c`** **`[needs CAP_NET_RAW / sudo, Linux]`**

```c
/* arp_parse.c — sniff frames; when one is ARP, decode and explain it.
 *   Build:  gcc -Wall -O2 -o arp_parse arp_parse.c
 *   Run:    sudo ./arp_parse
 * Try generating ARP traffic from another terminal:  ping <some-LAN-IP>
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/ethernet.h>

/* The ARP packet layout (RFC 826), exactly as it sits in the Ethernet payload.
 * __attribute__((packed)) forbids the compiler from inserting alignment padding,
 * so the struct matches the wire byte-for-byte — essential for packet parsing. */
struct arp_hdr {
    unsigned short htype;      /* hardware type: 1 = Ethernet               */
    unsigned short ptype;      /* protocol type: 0x0800 = IPv4              */
    unsigned char  hlen;       /* hardware addr length: 6                   */
    unsigned char  plen;       /* protocol addr length: 4                   */
    unsigned short opcode;     /* 1 = request, 2 = reply                    */
    unsigned char  sender_mac[6];
    unsigned char  sender_ip[4];
    unsigned char  target_mac[6];
    unsigned char  target_ip[4];
} __attribute__((packed));

static void fmt_mac(const unsigned char *m, char *o) {
    sprintf(o, "%02x:%02x:%02x:%02x:%02x:%02x", m[0],m[1],m[2],m[3],m[4],m[5]);
}
static void fmt_ip(const unsigned char *p, char *o) {
    sprintf(o, "%u.%u.%u.%u", p[0], p[1], p[2], p[3]);
}

int main(void) {
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) { perror("socket (need sudo)"); return 1; }

    unsigned char buf[ETH_FRAME_LEN];
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n < (ssize_t)sizeof(struct ethhdr)) continue;

        struct ethhdr *eth = (struct ethhdr *)buf;
        if (ntohs(eth->h_proto) != ETH_P_ARP) continue;   /* only care about ARP */

        /* Decapsulate: the ARP packet starts right after the 14-byte Eth header. */
        struct arp_hdr *arp = (struct arp_hdr *)(buf + sizeof(struct ethhdr));
        char smac[18], sip[16], tip[16];
        fmt_mac(arp->sender_mac, smac);
        fmt_ip(arp->sender_ip, sip);
        fmt_ip(arp->target_ip, tip);

        if (ntohs(arp->opcode) == 1)        /* request */
            printf("ARP REQUEST: who has %s? tell %s (%s)\n", tip, sip, smac);
        else if (ntohs(arp->opcode) == 2)   /* reply */
            printf("ARP REPLY:   %s is at %s\n", sip, smac);
    }
    close(fd);
    return 0;
}
```

Output, while pinging a neighbor on your LAN:

```
ARP REQUEST: who has 192.168.1.20? tell 192.168.1.5 (a4:83:e7:1c:9b:02)
ARP REPLY:   192.168.1.20 is at 88:66:5a:11:cc:7d
```

There it is — the IP-to-MAC resolution that precedes *every* local connection, decoded by hand. Notice the two parsing techniques you'll reuse for every protocol in this book: the **`packed` struct** overlaid on the wire bytes (so the struct layout *is* the wire layout, no surprise padding), and **`ntohs`** to convert multi-byte fields from network byte order (big-endian) to your host's order. Master these two moves and you can parse any binary protocol. We'll use the exact same approach to peel back IP (next chapter), TCP (Ch. 7), and beyond.

> **Byte order, once and for all:** the network is **big-endian** ("network byte order") — most-significant byte first. Your x86/ARM machine is almost certainly **little-endian**. So every multi-byte numeric field read off the wire must be converted: `ntohs` (network-to-host short, 16-bit), `ntohl` (32-bit), and `htons`/`htonl` for the reverse. Forgetting this is the single most common packet-parsing bug. A MAC address or IP address read as raw bytes is fine (it's a byte array, not a number), but the EtherType, the ARP opcode, ports, sequence numbers — anything you treat as an integer — needs the conversion.

---

## 3.7 Putting It Together: A Local Delivery, Start to Finish

Let's trace one complete local delivery, tying every concept together. Your machine (`192.168.1.5`, MAC `a4:83:...`) wants to send an IP packet to `192.168.1.20` on the same LAN:

```
   1. Your IP layer has a packet for 192.168.1.20. It checks: is that IP on my
      local subnet? (Subnet math — Chapter 4.) Yes → deliver directly on this LAN.

   2. IP layer asks the link layer: "I need the MAC for 192.168.1.20."
      Link layer checks the ARP cache. Miss.

   3. ARP REQUEST broadcast (dst MAC ff:ff:ff:ff:ff:ff). The switch FLOODS it out
      every port (it's a broadcast). Every machine on the broadcast domain receives it.

   4. 192.168.1.20 recognizes its own IP, sends an ARP REPLY (unicast). The switch,
      having now learned both MACs, forwards it out only your port.

   5. Your machine caches 192.168.1.20 → 88:66:5a:11:cc:7d.

   6. Now the link layer builds the Ethernet frame: dst MAC 88:66:..., src MAC a4:83:...,
      EtherType 0x0800, payload = the IP packet, plus FCS. Hands it to the NIC.

   7. NIC's PHY adds preamble, line-codes it, drives it onto the wire (Chapter 1).

   8. The switch reads the dst MAC, looks it up (port 7), forwards the frame out
      ONLY port 7. 192.168.1.20's NIC receives it, checks the FCS, sees the dst MAC
      is its own, strips the Ethernet header, sees EtherType 0x0800, hands the
      payload UP to its IP layer (Chapter 4 territory).
```

Every step here is a concept from this chapter: subnet check (preview of Ch. 4), ARP resolution, switch flooding and learning, frame construction, MAC-based forwarding, decapsulation by EtherType. This is *local delivery* — one hop — fully understood. And here's the punchline that connects to everything ahead: **when the destination is *not* on your local subnet (it's a server across the internet), step 1 changes — your machine ARPs for the MAC of its *default gateway* (the router) instead, and sends the frame there.** The router then does its L3 job and forwards the IP packet toward its destination, and the whole local-delivery dance repeats on the *next* hop's segment. Every global journey is a chain of these local deliveries, each one exactly the link-layer problem we just solved. That handoff — local subnet vs. "send it to the gateway" — is the subject of the next chapter, where IP and routing take the stage.

---

## Key Takeaways

1. **The link layer's job is one-hop delivery on a single segment** — get a frame to *that NIC on this wire* and detect corruption — nothing more. Every global journey is a chain of these one-hop deliveries.

2. **The Ethernet II frame is 14 bytes of header (dst MAC, src MAC, EtherType) + payload + 4-byte CRC trailer.** The EtherType is the demux key (`0x0800` IPv4, `0x86DD` IPv6, `0x0806` ARP). The 1500-byte payload max — the **MTU** — is networking's most consequential magic number, echoing up into IP fragmentation, TCP MSS, and PMTUD.

3. **MAC addresses are flat (who you are), IP addresses are hierarchical (where you are).** Flatness is why you can't route on MACs across the internet — routing needs hierarchy. This is the fundamental reason for *two* address systems, bridged by ARP.

4. **ARP resolves an IP to a MAC by broadcasting "who has X?" and caching the unicast reply.** It precedes essentially every local connection, is completely unauthenticated (hence ARP spoofing / MITM), and is part of the deep reason TLS must authenticate end-to-end rather than trust the network.

5. **A switch forwards frames by destination MAC, learning (source MAC → arrival port) from every frame it carries** — automatic, configuration-free topology discovery. Known destinations are forwarded precisely to one port; unknown/broadcast destinations are flooded. The MAC table is finite (MAC-flooding attack) and a switch (set) is one broadcast domain by default.

6. **Collision domains vs. broadcast domains:** each switch port is its own collision domain (full-duplex killed collisions); a switch is one broadcast domain, broken only by a *router* (L3) or a *VLAN*.

7. **VLANs (802.1Q) partition one physical switch into many logical broadcast domains** via a 4-byte tag carrying a 12-bit VLAN ID; tagged frames are confined to their VLAN. Access ports carry one untagged VLAN to end devices; trunk ports carry many tagged VLANs between switches. This is how shared hardware gives isolated networks (and VXLAN scales the idea across data centers).

8. **Packet parsing in code is two moves:** overlay a `packed` struct on the raw bytes (struct layout = wire layout) and convert multi-byte integer fields with `ntohs`/`ntohl` (the network is big-endian). Master these and you can decode any binary protocol — which is exactly what we'll do for every layer above.

---

## Interview Drills

**Q1. You want to send an IP packet to another machine on your local network. You know its IP but not its MAC. Walk me through what happens.**
*Model answer:* ARP resolution. Your IP layer determines (via subnet math) that the destination is on the local segment, so it needs the destination's MAC to build an Ethernet frame. It checks the ARP cache; on a miss, it broadcasts an ARP request to `ff:ff:ff:ff:ff:ff` — every device on the broadcast domain receives it, carrying "who has 192.168.1.20? tell <my IP/MAC>." Only the machine owning that IP replies, with a *unicast* ARP reply containing its MAC. Your machine caches the IP→MAC mapping (so it won't ask again for a few minutes) and then builds the Ethernet frame with that destination MAC, EtherType 0x0800, and the IP packet as payload. If the destination were *not* on the local subnet, the same process would resolve the MAC of the default gateway (router) instead, and the frame would be sent there for L3 forwarding. This ARP step precedes essentially every local connection and is normally invisible.

**Q2. Why do we have both MAC addresses and IP addresses? Isn't one enough?**
*Model answer:* Because they answer different questions and have different structures suited to different jobs. A MAC address is *flat* — 48 bits with no geographic or topological structure — and identifies *who* a device is (burned in by the manufacturer). An IP address is *hierarchical* — its prefix identifies a network/region — and identifies *where* a device is in the global topology. You can't route on MACs across the internet because flatness gives a router no information about direction; a routing table keyed on individual flat MACs would need a billion entries. Hierarchy lets routers aggregate — "everything matching this prefix goes that way" — which is what makes global routing scale (Chapter 5). So MAC handles local, one-hop delivery where a flat address is fine (the segment is small), and IP handles global, end-to-end delivery where hierarchy is essential. ARP bridges the two: given the *where* (IP), find the *who* (MAC) for the next hop.

**Q3. How does a switch know which port to send a frame out of, and how did it learn that?**
*Model answer:* It consults its MAC address table (CAM table), which maps MAC addresses to ports. It learns the table by observation: for every frame it forwards, it records the *source* MAC and the *port it arrived on* — that's proof the source is reachable via that port. To forward a frame, it looks up the *destination* MAC: if found, it sends the frame out only that one port (unicast forwarding); if not found, or if the destination is broadcast/multicast, it floods the frame out every port except the ingress one. Flooding is self-correcting — the reply teaches the switch the missing entry, so the next frame is forwarded precisely. This learning is automatic and needs no configuration; the switch deduces its topology from the traffic it carries. (Aside: overflowing the finite table with fake source MACs — MAC flooding — can force it to fail open and behave like a hub, a classic attack.)

**Q4. What's the difference between a collision domain and a broadcast domain, and what device boundaries define each?**
*Model answer:* A collision domain is the set of devices whose transmissions could collide on a shared medium. With modern full-duplex switched Ethernet, each switch port is its own collision domain — there's a dedicated point-to-point link with separate TX/RX, so collisions essentially can't happen (the old CSMA/CD shared-medium problem is gone). A broadcast domain is the set of devices a broadcast frame reaches. A switch forwards broadcasts out all ports, so an entire switch — or a set of interconnected switches — is, by default, a single broadcast domain. To *break* a broadcast domain you need either a router (broadcasts don't cross L3 boundaries — that's a core reason routers exist) or a VLAN, which logically partitions one physical switch into multiple broadcast domains. Summary: switches separate collision domains but not broadcast domains; routers and VLANs separate broadcast domains.

**Q5. What is the MTU, why is 1500 significant, and what does it cause higher up the stack?**
*Model answer:* The MTU (Maximum Transmission Unit) is the largest payload a link-layer frame can carry; for standard Ethernet it's 1500 bytes. It matters because it's a hard ceiling on how much a single frame can carry, and since it's effectively universal across the internet, everything above must respect it. Consequences: IP must *fragment* packets larger than the path's MTU (Chapter 4), which is a performance and reliability footgun; TCP negotiates a Maximum Segment Size (MSS = MTU − IP header − TCP header, typically 1460) so it never produces segments that would need fragmenting (Chapter 7); and Path MTU Discovery exists to find the smallest MTU along a route and avoid fragmentation altogether. Data centers sometimes use "jumbo frames" (~9000-byte MTU) to cut per-packet overhead, but 1500 is the safe internet-wide default. It's arguably the most consequential magic number in networking.

**Q6. ARP has no authentication. What's the attack, and what's the broader lesson?**
*Model answer:* The attack is ARP spoofing (poisoning). Since any machine can send an ARP reply — including unsolicited "gratuitous" ones — an attacker on the LAN can claim "the gateway's IP is at *my* MAC." Victims cache the false mapping and send their traffic to the attacker, who relays it (man-in-the-middle), reading or modifying it in transit. It's trivial on any network you can physically join, which is why open Wi-Fi is dangerous. The broader lesson is that the local network is a trust boundary you can't actually trust: link-layer protocols like ARP were designed in a friendlier era and assume cooperative participants. This is a foundational reason for end-to-end encryption and authentication — TLS (Chapter 12) doesn't trust the network to deliver bytes to the right machine unmolested; it authenticates the *peer* cryptographically and encrypts the payload, so even a successful MITM sees only ciphertext and can't impersonate the server. You secure the endpoints because you cannot secure the path.

---

*Previous: [Chapter 2 — The Models](./02-models-osi-and-tcpip.md) | Next: [Chapter 4 — The Network Layer: IP](./04-network-layer-ip.md)*
