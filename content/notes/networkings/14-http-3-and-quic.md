# Chapter 14 — HTTP/3 and QUIC

> *HTTP/2 took multiplexing as far as it could go over TCP — and ran straight into TCP itself. A single lost packet stalls every multiplexed stream, because TCP delivers one ordered byte pipe and can't tell the streams apart (Chapter 13). The obvious fix is "make the transport stream-aware," but TCP can't be changed: it's frozen into billions of OS kernels and a global thicket of middleboxes that mangle anything unfamiliar. So Google did something audacious — they rebuilt the entire transport layer from scratch, in user space, on top of UDP, with encryption baked in and streams as first-class citizens. That transport is **QUIC**, and HTTP-over-QUIC is **HTTP/3**. It's the most significant change to the internet's transport layer in thirty years, and this chapter is why it had to happen and how it works.*

We end the previous chapter with a precise problem statement: HTTP/2's independent streams share one TCP connection, TCP's strict in-order delivery means one lost packet blocks all streams (TCP head-of-line blocking), and HTTP/2 can't fix it because it's *built on* TCP. The fix requires a transport where streams are independent all the way down — where stream 3's bytes can be delivered while stream 1's lost bytes are still being recovered. **QUIC (RFC 9000)** is that transport. It's not a tweak to TCP; it's a from-scratch reliable, multiplexed, encrypted transport that happens to run over UDP.

This chapter covers *why* QUIC exists (TCP HOL blocking, ossification, handshake costs), how it rebuilds TCP's guarantees over UDP's blank canvas (Chapter 6), its signature features (per-stream loss recovery, 0/1-RTT handshakes, connection migration, user-space congestion control), how HTTP/3 maps onto it (and why HPACK had to become QPACK), and we'll decode a QUIC packet header. It's the convergence of nearly everything in this book: UDP (Ch. 6), TCP's mechanisms (Ch. 7–8), TLS (Ch. 12), and HTTP/2's streams (Ch. 13), recombined into something new.

---

## 14.1 Why QUIC: Three Problems with TCP That Couldn't Be Fixed in Place

QUIC exists because TCP has three deep problems, and *none* of them could be fixed by changing TCP. Understanding why "just fix TCP" was impossible is half the insight.

**Problem 1 — TCP head-of-line blocking (the one from Chapter 13).** TCP's single ordered byte stream means a lost packet blocks all data behind it, including data from logically independent HTTP/2 streams. This is the headline motivation, fully developed in §13.7.

**Problem 2 — Handshake latency stacking.** A fresh HTTPS connection pays the TCP handshake (1 RTT, Ch. 7) *and then* the TLS handshake (1 RTT in TLS 1.3, 2 in 1.2, Ch. 12) — *sequentially*, because TLS runs on top of TCP and can't start until TCP is established. So even with TLS 1.3 you pay 2 RTTs before the first byte of HTTP. On a transcontinental link that's hundreds of milliseconds of setup latency on every new connection. The layering that kept TCP and TLS clean (Chapter 2) *cost* round trips by forcing them to happen in sequence.

**Problem 3 — Ossification: TCP can't evolve.** This is the deepest and least obvious. TCP is implemented in the *kernel* of every operating system, so changing it means an OS update on billions of devices — a decade-long process. Worse, the internet is full of **middleboxes** (NATs, firewalls, "TCP accelerators," deep-packet-inspection boxes — Chapter 2's layering violators) that *understand* TCP and actively interfere with anything that doesn't match the TCP behavior they expect. Try to add a new TCP option or a new TCP feature and middleboxes drop or mangle the packets. TCP has become **ossified** — frozen by its own ubiquity, unable to change because too many things depend on its exact current behavior. (Recall Chapter 2's thin waist: IP's strength was that everyone depends on it, and that same strength made it nearly impossible to change. TCP inherited the same curse.) This is why TCP Fast Open (Ch. 7) and ECN (Ch. 8) deployed so slowly — middleboxes fought them.

```
   Why "just improve TCP" was impossible:

   TCP lives in the KERNEL → changing it = OS updates on billions of devices (a decade)
   Middleboxes INSPECT TCP → they drop/mangle anything that isn't "normal" TCP
                              (NATs, firewalls, DPI — the ossification trap)

   QUIC's escape: build the new transport in USER SPACE (ship it in the app/browser —
   updates in weeks, not a decade) on top of UDP (which middleboxes pass through as
   "just UDP" and ENCRYPT EVERYTHING so middleboxes can't even SEE the transport logic
   to interfere with it. The transport becomes invisible and un-ossifiable.
```

QUIC's design is a direct response to all three:
- It runs in **user space** (shipped inside the browser/application/library, not the kernel) — so it can be *updated* as fast as you ship an app, escaping the decade-long kernel-update cycle. Google could (and did) iterate QUIC across YouTube and Chrome continuously.
- It runs over **UDP** (Chapter 6's "blank canvas") — which middleboxes pass through as ordinary UDP datagrams, since UDP is one of the two protocols (with TCP) that everything permits. QUIC builds reliability *on top of* UDP itself.
- It **encrypts almost everything**, including most of the transport-layer headers — so middleboxes literally *cannot see* QUIC's internals to interfere with or ossify them. The transport is opaque to the network, which keeps it *evolvable* forever (middleboxes can't depend on what they can't see). This "encrypt the transport to prevent ossification" is one of QUIC's most strategically important ideas.

> **The meta-insight:** QUIC is what you build when you accept that *the layered architecture you depend on has become a prison.* TCP and TLS as separate layers cost round trips; TCP-in-the-kernel can't be updated; middleboxes-that-understand-TCP prevent change. QUIC *deliberately collapses the layers* — transport, encryption, and stream multiplexing fused together (the Chapter 2 "lie" where QUIC bulldozes the layer boundaries) — and *hides the result inside encrypted UDP* so the network can't ossify it. It's the most consequential layering violation in the book, and it's *correct* — the clean layering had become the bottleneck, exactly as Chapter 2 warned it sometimes does.

---

## 14.2 QUIC = Reliability + Streams + Encryption, Rebuilt on UDP

QUIC takes UDP — which gives only ports and a checksum (Chapter 6) — and builds back everything TCP and TLS provide, plus more, but *better-factored*. Conceptually:

```
   The classic stack:              The QUIC stack:
   ┌─────────────┐                 ┌──────────────────────────────┐
   │   HTTP/2    │                 │           HTTP/3              │
   ├─────────────┤                 ├──────────────────────────────┤
   │    TLS      │                 │   QUIC (reliability + streams │   ← all fused,
   ├─────────────┤                 │   + TLS 1.3 encryption +      │     in USER SPACE
   │    TCP      │                 │   congestion control)         │
   ├─────────────┤                 ├──────────────────────────────┤
   │     IP      │                 │            UDP                │   ← the only kernel/
   └─────────────┘                 ├──────────────────────────────┤     network-visible part
                                   │            IP                 │
                                   └──────────────────────────────┘
```

QUIC re-implements, in user space over UDP:
- **Reliability** — sequence numbers (per-packet packet numbers), acknowledgments, retransmission (the Chapter 7 machinery, redesigned — and notably, QUIC's ACKs are more informative than TCP's, with SACK-like ranges built in).
- **Streams** — but as *first-class, independent* objects (the key difference, §14.3).
- **Flow control** — both per-stream and connection-level (like HTTP/2's, but now in the transport).
- **Congestion control** — the same algorithms (CUBIC, BBR, Chapter 8) but in user space, so they can be *changed and tuned per-application without kernel updates* — a huge deal for iterating on congestion control.
- **Encryption** — TLS 1.3 (Chapter 12) is not layered *on top* but *integrated into* QUIC's handshake, so transport and crypto setup happen together (§14.4).

The genius is the recombination: by building the transport and crypto *together* over UDP, QUIC fixes the problems that arose from having them as *separate layers* (handshake stacking) and *in the kernel* (ossification) — while keeping the *guarantees* applications relied on. To HTTP/3, QUIC looks like "TCP+TLS but with independent streams and faster setup." Underneath, it's a complete reimagining.

---

## 14.3 Streams as First-Class Objects: Killing TCP Head-of-Line Blocking

Here's the feature that justifies QUIC's existence — the fix for the problem Chapter 13 left us with. In QUIC, **streams are part of the transport, and each stream has its own independent delivery and loss recovery.** A lost packet affecting one stream does *not* block the others, because QUIC *knows* which bytes belong to which stream and can deliver the unaffected streams' data while recovering only the affected stream's loss:

```
   HTTP/2 over TCP — one lost packet stalls EVERYTHING (§13.7):
   ┌──────────────────────────────────────────────────────────┐
   │ TCP: one ordered byte stream                              │
   │ [s1][s3][s5][s1✗][s3][s5]   ← s1 packet lost              │
   │ TCP holds back s3, s5 too (can't tell they're independent) │
   │ → ALL streams stalled until s1 retransmitted              │
   └──────────────────────────────────────────────────────────┘

   HTTP/3 over QUIC — one lost packet stalls only ITS stream:
   ┌──────────────────────────────────────────────────────────┐
   │ QUIC: independent streams, transport KNOWS the boundaries │
   │ [s1][s3][s5][s1✗][s3][s5]   ← s1 packet lost              │
   │ s3 and s5 DELIVERED immediately (their bytes are complete) │
   │ → only s1 waits for retransmission; s3, s5 unaffected     │
   └──────────────────────────────────────────────────────────┘
```

This is the whole point. Because QUIC's transport is *stream-aware* — packet number N's payload is tagged with which stream(s) its data belongs to — a loss only blocks the stream(s) whose data was in the lost packet. Other streams, whose data arrived intact, are delivered to the application immediately. **QUIC eliminates head-of-line blocking at the transport layer, which TCP could never do.** This is the genuine, fundamental advantage of HTTP/3 over HTTP/2, and it matters most exactly where HTTP/2 hurt most: lossy networks (mobile, congested Wi-Fi), where HTTP/2's single TCP connection could underperform even HTTP/1.1. On a lossy link, HTTP/3 keeps every unaffected stream flowing while HTTP/2 would stall them all.

A subtle but important consequence: QUIC distinguishes **per-stream ordering** (bytes within one stream are still delivered in order — each stream is its own reliable ordered substream) from **cross-stream independence** (streams don't wait for each other). You get TCP's nice in-order guarantee *within* a stream, without TCP's penalty of one stream's loss blocking another. It's the best of both: ordered where you need it (within a request), independent where you want it (across requests).

---

## 14.4 The Integrated 0/1-RTT Handshake

QUIC folds the transport handshake and the TLS 1.3 cryptographic handshake into *one*, eliminating the sequential stacking of Problem 2 (§14.1). Where TCP+TLS 1.3 cost 2 RTTs (1 for TCP, then 1 for TLS), QUIC does the *combined* transport+crypto setup in **1 RTT** for a fresh connection — and **0 RTT** for a resumed one:

```
   TCP + TLS 1.3 (sequential — the layering tax):
   [── TCP handshake: 1 RTT ──][── TLS 1.3 handshake: 1 RTT ──][ HTTP data ]
                  2 RTTs before the first HTTP byte

   QUIC (fused — transport AND crypto together):
   [── QUIC handshake (transport + TLS 1.3 combined): 1 RTT ──][ HTTP data ]
                  1 RTT before the first HTTP byte (fresh connection)

   QUIC 0-RTT (resumed connection — client has a cached session):
   [ HTTP data sent IMMEDIATELY, in the very first packet ]
                  0 RTTs — data flies with the first packet
```

Because QUIC integrates TLS 1.3 directly (it *is* the security layer, not a layer on top), the cryptographic keys are established as part of the same exchange that establishes the transport. The result is the fastest connection setup the internet has — 1-RTT fresh, 0-RTT resumed. And 0-RTT carries the *same* caveat as TLS 1.3's 0-RTT (Chapter 12): the early data is replayable, so it must be restricted to idempotent operations (Chapter 11). QUIC inherits TLS 1.3's replay constraint exactly.

This is the culmination of the latency arc traced through the whole book: TCP handshake (1 RTT, Ch. 7) → TLS 1.2 (+2 RTT) → TLS 1.3 (+1 RTT, Ch. 12) → **QUIC (1 RTT for transport *and* crypto combined, or 0 on resumption)**. Every step has been a war on the round-trip latency floor set by the speed of light (Chapter 1), and QUIC is the current front line: it gets connection setup as close to "free" as physics and security allow.

---

## 14.5 Connection Migration: Surviving the Network Switch

A feature TCP *fundamentally cannot* have, because of how TCP identifies connections. Recall a TCP connection is identified by its **four-tuple** (source IP, source port, dest IP, dest port — Chapter 6). If *any* of those changes, it's a different connection. So when your phone switches from Wi-Fi to cellular, your IP address changes, the four-tuple changes, and **every TCP connection breaks** — your downloads restart, your video call drops and reconnects, your SSH session dies. You've felt this every time you walked out of Wi-Fi range mid-download.

QUIC fixes this with **connection migration**. A QUIC connection is identified not by the four-tuple but by a **Connection ID** — an identifier carried in the QUIC packets, independent of IP and port. So when your IP changes (Wi-Fi → cellular), the Connection ID stays the same, and the connection *survives the switch*:

```
   TCP connection identity:    (src IP, src port, dst IP, dst port)  — the 4-tuple
        Wi-Fi → cellular: src IP changes → 4-tuple changes → CONNECTION BREAKS
        (download restarts, call drops, SSH dies)

   QUIC connection identity:   Connection ID (in the packet, NOT tied to IP/port)
        Wi-Fi → cellular: src IP changes → Connection ID UNCHANGED → CONNECTION SURVIVES
        (download continues, call keeps going, no interruption)
```

The server sees packets arrive from a new IP/port but with a familiar Connection ID, recognizes the connection, and seamlessly continues — your download doesn't restart, your call doesn't drop. (There are anti-spoofing path-validation steps so an attacker can't hijack a connection by spoofing the Connection ID from a new address, but the user experience is seamless continuity.) This is impossible for TCP because TCP's very *identity* is the four-tuple; QUIC decoupled connection identity from network address, and got mobility for free. For a mobile-first internet — phones constantly roaming between networks — this is a genuinely important capability, and one of QUIC's most user-visible wins.

---

## 14.6 HTTP/3 and QPACK: Mapping HTTP onto QUIC

**HTTP/3** is HTTP's semantics (the same methods, status codes, headers — Chapter 11, *still* unchanged) mapped onto QUIC instead of TCP. Conceptually it's "HTTP/2's ideas, but each HTTP stream maps directly to a QUIC stream," so the independence is real all the way down. Most of HTTP/2's concepts carry over — but one piece couldn't, and it's instructive.

Recall **HPACK** (Chapter 13), HTTP/2's header compression: it maintains a per-connection dynamic table where both sides reference previously-seen headers by index, and it relies on headers being processed in a strict, ordered sequence (because the table state must stay synchronized). But QUIC streams are *independent and can arrive out of order* — that's the whole point of §14.3. If HEADERS on stream 5 reference a dynamic-table entry that was established on stream 3, but stream 3's data is delayed, stream 5 can't decode its headers — it would have to wait for stream 3, *reintroducing the very head-of-line blocking QUIC eliminated*. HPACK's strict ordering is fundamentally incompatible with QUIC's out-of-order streams.

So HTTP/3 uses **QPACK** — HPACK redesigned for out-of-order delivery. QPACK keeps the static/dynamic-table idea but adds machinery to handle the ordering problem: it separates the table-update instructions onto a dedicated stream and lets the encoder choose to *avoid* references that would create blocking dependencies (trading a little compression for non-blocking decode), with explicit acknowledgments to keep the tables synchronized despite out-of-order streams. The details are intricate, but the *lesson* is clean and worth carrying: **a mechanism designed for an ordered transport (HPACK over TCP) had to be redesigned when the transport became unordered (QPACK over QUIC).** It's a concrete example of how a lower-layer change (TCP → QUIC's independent streams) forces upper-layer redesigns — the layers aren't as independent as the clean model pretends (Chapter 2 again).

> **In the wild:** HTTP/3 is now broadly deployed — major browsers support it, and a large and growing share of web traffic uses it (Google, Cloudflare, Meta, and most large CDNs serve HTTP/3). Adoption is driven by the mobile and lossy-network wins (per-stream loss recovery, connection migration) and the faster handshake. The typical deployment pattern: a server advertises HTTP/3 availability via the `Alt-Svc` header (or DNS HTTPS records) on its HTTP/2 response, and capable clients upgrade to HTTP/3 on the next connection — a graceful, opportunistic migration, with HTTP/2 over TCP as the fallback when UDP is blocked (some restrictive networks block UDP, the one scenario where QUIC can't run and falls back to TCP).

---

## 14.7 Code: Decoding a QUIC Packet Header

QUIC encrypts almost everything (§14.1), so unlike TCP, you can't decode the interesting internals from a capture without the keys — which is *by design* (it's what prevents ossification). But the outermost **packet header** has some visible fields, and decoding them shows QUIC's structure — particularly the Connection ID that enables migration (§14.5). QUIC has two header forms: a **long header** (used during the handshake, more fields visible) and a **short header** (used after, minimal). This parser decodes the long header's public fields. Portable POSIX.

**`quic_header.c`**

```c
/* quic_header.c — decode the public fields of a QUIC long-header packet.
 *   Build:  gcc -Wall -O2 -o quic_header quic_header.c
 *   Run:    ./quic_header   (uses a built-in sample Initial packet header)
 *
 * QUIC encrypts almost everything (to prevent middlebox ossification), so only the
 * outer header fields are visible without keys. This shows the structure — especially
 * the Connection IDs that enable connection migration across network changes.
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* QUIC long header (RFC 9000), public fields:
 *   byte 0: 1|1|TT|RR|PP   (bit7=1 header form=long, bit6=1 fixed, bits5-4 packet type)
 *   bytes 1-4: Version (32-bit; 0x00000001 = QUIC v1)
 *   byte: DCID length, then Destination Connection ID
 *   byte: SCID length, then Source Connection ID
 *   ...(then type-specific, mostly encrypted)
 */
static const char *long_packet_type(uint8_t b0) {
    switch ((b0 >> 4) & 0x03) {
        case 0: return "Initial";
        case 1: return "0-RTT";
        case 2: return "Handshake";
        case 3: return "Retry";
        default: return "?";
    }
}

static void print_cid(const char *label, const unsigned char *p, int len) {
    printf("  %s (%d bytes): ", label, len);
    for (int i = 0; i < len; i++) printf("%02x", p[i]);
    printf("\n");
}

int main(void) {
    /* A sample QUIC v1 Initial packet header (long header). */
    unsigned char pkt[] = {
        0xc3,                               /* byte0: long header, Initial type */
        0x00, 0x00, 0x00, 0x01,             /* version = 0x00000001 (QUIC v1) */
        0x08,                               /* DCID length = 8 */
        0x83, 0x94, 0xc8, 0xf0, 0x3e, 0x51, 0x57, 0x08,   /* Destination Connection ID */
        0x05,                               /* SCID length = 5 */
        0xa1, 0xb2, 0xc3, 0xd4, 0xe5        /* Source Connection ID */
    };

    int pos = 0;
    uint8_t b0 = pkt[pos++];

    /* Header form: top bit. 1 = long header, 0 = short header. */
    int is_long = (b0 & 0x80) != 0;
    printf("QUIC packet:\n");
    printf("  header form: %s\n", is_long ? "LONG (handshake)" : "SHORT (established)");

    if (is_long) {
        printf("  packet type: %s\n", long_packet_type(b0));
        uint32_t version = (pkt[pos]<<24)|(pkt[pos+1]<<16)|(pkt[pos+2]<<8)|pkt[pos+3];
        pos += 4;
        printf("  version: 0x%08x %s\n", version,
               version == 0x00000001 ? "(QUIC v1)" : "");

        int dcid_len = pkt[pos++];
        print_cid("Destination Connection ID", pkt + pos, dcid_len);   /* the migration key! */
        pos += dcid_len;

        int scid_len = pkt[pos++];
        print_cid("Source Connection ID", pkt + pos, scid_len);
        pos += scid_len;

        printf("  [remaining fields are ENCRYPTED — invisible without keys, by design]\n");
    }
    return 0;
}
```

Output:

```
QUIC packet:
  header form: LONG (handshake)
  packet type: Initial
  version: 0x00000001 (QUIC v1)
  Destination Connection ID (8 bytes): 8394c8f03e515708
  Source Connection ID (5 bytes): a1b2c3d4e5
  [remaining fields are ENCRYPTED — invisible without keys, by design]
```

What this shows about QUIC's design:
- **The Connection IDs are right there in the header** — and they're what make connection migration (§14.5) possible. The connection is identified by these IDs, *not* by the IP/port four-tuple, so when your IP changes the Connection ID stays put and the connection survives. This visible field is the literal mechanism of QUIC's mobility.
- **The version field** lets QUIC evolve (negotiate new versions) — un-ossifiable because it's part of the design from day one.
- **"remaining fields are ENCRYPTED"** is the headline: unlike the TCP decoder of Chapter 7 (where we read seq/ack/flags/window in the clear), QUIC's packet numbers, frames, ACKs, and stream data are all encrypted. You *cannot* build a QUIC equivalent of our `tcp_decode.c` from a passive capture — and that opacity is *intentional*, the anti-ossification armor of §14.1. To actually inspect QUIC internals you need the session keys (e.g. via `SSLKEYLOGFILE` and Wireshark, the same mechanism for decrypting TLS), which is how developers debug their *own* QUIC traffic. The contrast with Chapter 7's fully-readable TCP header is the whole point: TCP exposed its mechanics to the network (and got ossified for it); QUIC hides them (and stays evolvable).

---

## Key Takeaways

1. **QUIC exists because TCP has three problems that couldn't be fixed in place:** TCP head-of-line blocking (one loss stalls all HTTP/2 streams, Ch. 13), handshake latency stacking (TCP then TLS, sequentially — 2 RTTs even with TLS 1.3), and ossification (TCP is frozen in kernels and policed by middleboxes that mangle anything unfamiliar). You can't fix TCP; you can only replace it.

2. **QUIC's escape route: build the transport in user space (ship it in the app/browser — update in weeks, not a kernel-update decade) over UDP (Chapter 6's blank canvas, which middleboxes pass) and encrypt almost everything (so middleboxes can't see or ossify the transport logic).** It deliberately collapses the transport/crypto/multiplexing layers — the Chapter 2 "QUIC bulldozes the boundaries" — because the clean layering had become the bottleneck.

3. **QUIC rebuilds TCP+TLS over UDP, better-factored:** reliability (packet numbers, ACKs with SACK-like ranges, retransmission), first-class independent streams, per-stream and connection flow control, congestion control (CUBIC/BBR, now updatable in user space), and integrated TLS 1.3 encryption.

4. **The signature win — streams are first-class in the transport, so a lost packet blocks only its own stream, not the others.** QUIC eliminates head-of-line blocking *at the transport layer*, which TCP fundamentally cannot. This matters most on lossy networks (mobile, Wi-Fi) — exactly where HTTP/2's single TCP connection could underperform even HTTP/1.1. You get in-order delivery *within* a stream and independence *across* streams.

5. **QUIC fuses the transport and TLS 1.3 handshakes into one: 1 RTT for a fresh connection (vs. TCP+TLS's 2), 0 RTT for a resumed one** (with the same idempotency-only replay caveat as TLS 1.3 0-RTT). This is the culmination of the book's latency arc (TCP → TLS 1.2 → TLS 1.3 → QUIC) — a sustained war on the speed-of-light round-trip floor.

6. **Connection migration: QUIC identifies a connection by a Connection ID in the packet, not the IP/port four-tuple — so a connection survives a network change** (Wi-Fi → cellular) that would break every TCP connection (whose identity *is* the four-tuple). A genuinely important mobility win TCP can't replicate.

7. **HTTP/3 is HTTP's same semantics over QUIC, with each HTTP stream mapping to a QUIC stream.** HPACK (Ch. 13) had to be redesigned as **QPACK** because HPACK's strict-ordering requirement is incompatible with QUIC's out-of-order streams — a concrete case of a lower-layer change forcing an upper-layer redesign. HTTP/3 is broadly deployed (advertised via `Alt-Svc`), with HTTP/2-over-TCP as the fallback when UDP is blocked.

8. **QUIC encrypts its internals by design, so you can't passively decode it like TCP** — that opacity is the anti-ossification armor. The contrast with Chapter 7's fully-readable TCP header is the lesson: TCP exposed its mechanics and got frozen; QUIC hides them and stays evolvable.

---

## Interview Drills

**Q1. Why was QUIC created instead of just improving TCP?**
*Model answer:* Because TCP has three deep problems that genuinely couldn't be fixed in place. First, TCP head-of-line blocking: HTTP/2's multiplexed streams share one ordered TCP byte stream, so one lost packet stalls all of them. Second, handshake latency stacking: TLS runs on top of TCP, so a fresh HTTPS connection pays the TCP handshake and *then* the TLS handshake sequentially — 2 RTTs even with TLS 1.3. Third, and deepest, ossification: TCP lives in OS kernels, so changing it means updating billions of devices over a decade, and the internet is full of middleboxes (NATs, firewalls, DPI) that inspect TCP and mangle anything that doesn't match the behavior they expect — so even good improvements like TCP Fast Open and ECN deployed glacially. You can't fix these by changing TCP; the kernel-and-middlebox reality prevents it. QUIC's escape is to build a new transport in user space (shipped in the app/browser, so it updates in weeks) on top of UDP (which middleboxes pass through) and to encrypt almost the entire transport so middleboxes can't see or interfere with it — making the transport both fast to evolve and impossible to ossify. It deliberately fuses transport, encryption, and multiplexing — collapsing the layers that, kept separate, caused the latency and rigidity.

**Q2. How does QUIC solve the TCP head-of-line blocking that HTTP/2 couldn't?**
*Model answer:* By making streams first-class in the transport itself, with independent per-stream delivery and loss recovery. The root of TCP HOL blocking is that TCP delivers one strictly-ordered byte stream and has no idea the bytes belong to independent HTTP streams — so a lost packet forces it to hold back everything after the gap, including unrelated streams' data, until the loss is retransmitted. QUIC's transport *knows* which bytes belong to which stream, so when a packet carrying stream 1's data is lost, streams 3 and 5 — whose data arrived intact — are delivered to the application immediately, and only stream 1 waits for retransmission. Head-of-line blocking is eliminated at the transport layer, which TCP structurally cannot do because it's built around a single ordered byte stream. You still get in-order delivery *within* each stream (each is its own reliable ordered substream), but streams don't wait on each other. The benefit is largest exactly where HTTP/2 hurt most — lossy networks like mobile and congested Wi-Fi, where HTTP/2's single TCP connection could stall all streams on every loss and underperform even HTTP/1.1's parallel connections. HTTP/2 couldn't fix this because it's built on TCP and can't change TCP's delivery model; QUIC fixes it by replacing the transport.

**Q3. What is QUIC connection migration and why can't TCP do it?**
*Model answer:* Connection migration lets a QUIC connection survive a change in the client's network — for example, a phone switching from Wi-Fi to cellular — without dropping. TCP can't do this because a TCP connection is *identified* by its four-tuple: source IP, source port, destination IP, destination port. When you switch networks your IP address changes, so the four-tuple changes, so it's a different connection by definition — every TCP connection breaks, and your download restarts, your video call drops, your SSH session dies. QUIC decouples connection identity from the network address: it identifies a connection by a Connection ID carried inside the QUIC packets, independent of IP and port. So when your IP changes, the Connection ID stays the same; the server sees packets arriving from a new address but with a familiar Connection ID, recognizes the connection, and continues seamlessly — the download keeps going, the call doesn't drop. There are path-validation steps to prevent an attacker from hijacking a connection by spoofing the Connection ID from a new address, but the user experience is uninterrupted continuity. For a mobile-first internet where devices constantly roam between networks, this is one of QUIC's most valuable and user-visible advantages, and it's fundamentally impossible for TCP because TCP's very identity is the four-tuple.

**Q4. QUIC runs over UDP, which is unreliable. How does it provide reliability?**
*Model answer:* QUIC reimplements, in user space on top of UDP, all the reliability machinery that TCP provides — UDP is used purely as a "blank canvas" that gives ports and gets datagrams past middleboxes (since UDP is universally permitted), and QUIC builds everything else itself. Specifically: it numbers packets and the data within streams, the receiver acknowledges what it got (with SACK-like ranges built into the ACK format, more informative than TCP's), and QUIC retransmits anything unacknowledged — the same fundamental reliability loop as TCP (Chapter 7), redesigned. It adds per-stream and connection-level flow control, and congestion control using the same algorithms as TCP (CUBIC, BBR) but running in user space so they can be tuned and updated without kernel changes. So although the underlying UDP makes no delivery guarantees, QUIC layers reliability, ordering (within each stream), flow control, and congestion control on top — giving applications the same guarantees as TCP+TLS, but with independent streams, integrated encryption, and faster setup. It's a complete reimplementation of the transport, deliberately built over UDP rather than as a new protocol next to TCP, because a genuinely new transport protocol number would be dropped by middleboxes that only understand TCP and UDP.

**Q5. Why did HTTP/3 need QPACK instead of reusing HTTP/2's HPACK?**
*Model answer:* Because HPACK's design assumes an ordered transport, which QUIC deliberately isn't. HPACK compresses headers using a per-connection dynamic table where both sides reference previously-seen headers by index, and it depends on headers being processed in a strict sequence so the table state stays synchronized between encoder and decoder. That works fine over TCP's single ordered byte stream. But QUIC's streams are independent and can arrive out of order — which is the entire point of QUIC. If a HEADERS block on stream 5 referenced a dynamic-table entry that was established on stream 3, and stream 3's data is delayed, stream 5 couldn't decode its headers until stream 3 arrived — which would reintroduce exactly the head-of-line blocking QUIC was built to eliminate. So HPACK's strict-ordering requirement is fundamentally incompatible with QUIC. QPACK is HPACK redesigned for out-of-order delivery: it keeps the static/dynamic-table compression idea but moves table-update instructions to a dedicated stream, lets the encoder avoid references that would create blocking dependencies (trading a little compression ratio for non-blocking decode), and uses explicit acknowledgments to keep the tables synchronized despite out-of-order streams. The broader lesson is that a change in a lower layer (TCP's ordered delivery becoming QUIC's independent streams) forced a redesign in an upper layer (HPACK → QPACK) — the layers aren't as cleanly independent as the model pretends.

**Q6. Trace the connection-setup latency from TCP through to QUIC. Why does it keep improving?**
*Model answer:* Each step attacks the round-trip cost of setup, because round trips are the dominant latency term and are bounded by the speed of light. Plain TCP: the three-way handshake costs 1 RTT before any data. Add TLS 1.2 for HTTPS: the TLS handshake costs another 2 RTTs, and because TLS runs on top of TCP it happens *after* the TCP handshake — so 3 RTTs total before the first HTTP byte. TLS 1.3 cut its handshake to 1 RTT (the client sends its key-exchange value in the first message), bringing HTTPS down to 2 RTTs (TCP + TLS), with 0-RTT possible on resumption. QUIC goes further by *fusing* the transport and TLS 1.3 handshakes into a single exchange — instead of doing TCP setup and then TLS setup sequentially, it establishes transport and cryptographic state together — so a fresh connection is 1 RTT for *both*, and a resumed connection is 0 RTT (data in the very first packet). The reason it keeps improving is that the sequential layering of TCP-then-TLS was itself the cost: each clean layer boundary forced another round trip. QUIC collapses the layers to remove that tax, getting connection setup as close to free as security allows. The 0-RTT modes carry a replay caveat — the early data must be idempotent (Chapter 11), since an attacker can replay it. It's the same battle, fought across four protocol generations, against the latency floor physics imposes.

---

*Previous: [Chapter 13 — HTTP/2](./13-http-2.md) | Next: [Chapter 15 — gRPC and Protocol Buffers](./15-grpc-and-protobuf.md)*
