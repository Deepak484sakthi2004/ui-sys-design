# Chapter 7 — TCP, Part I: Reliability

> *IP delivers packets the way a careless postal service delivers letters: most arrive, some are lost, some are duplicated, some show up out of order, and a few are quietly damaged — and you are never told which. TCP takes this and presents your application with a perfect, reliable, ordered stream of bytes, as if the network were a flawless pipe. That transformation — from chaos to a clean byte stream — is one of the great engineering achievements in computing, and it is built entirely from a handful of mechanisms running on top of the unreliable datagram service of Chapter 4. This chapter is how the trick is done.*

In Chapter 6 we met UDP, the blank canvas: ports and a checksum over raw IP, nothing more. **TCP (Transmission Control Protocol, RFC 793, updated by RFC 9293)** is the opposite philosophy — it builds, on top of the same unreliable IP, a service with strong guarantees:

- **Reliable:** every byte you send arrives, or the connection fails trying. Lost data is detected and retransmitted.
- **Ordered:** bytes arrive in exactly the order you sent them, even though IP may reorder packets.
- **Connection-oriented:** a setup handshake and teardown bracket a stateful conversation between exactly two endpoints.
- **Byte-stream:** the application sees a continuous stream of bytes, not packets (no message boundaries — the source of much grief, §7.7).
- **Flow-controlled:** a fast sender won't overwhelm a slow receiver.
- **Congestion-controlled:** senders back off when the *network* is overloaded (Chapter 8 — so important it gets its own chapter).

TCP is the workhorse of the internet — HTTP/1 and HTTP/2, SSH, database connections, email, and most of everything else ride on it. This chapter, Part I, covers everything *except* congestion control: the connection state machine, the handshake and teardown, sequence numbers, the sliding window, retransmission, and selective acknowledgment. Part II (Chapter 8) covers the congestion machinery. We'll close by extending our sniffer to decode TCP segments and watch real handshakes happen.

The mental model to hold throughout: **TCP is a state machine at each endpoint, exchanging numbered segments, where every byte is accounted for by sequence and acknowledgment numbers, and anything unacknowledged is eventually resent.** Reliability is *bookkeeping* — careful, relentless accounting of which bytes have been confirmed received. Master the bookkeeping and you've mastered TCP.

---

## 7.1 The TCP Segment, Field by Field

Everything TCP does is encoded in its 20-byte (minimum) header. Unlike UDP's bare 8 bytes, every field here exists to support a guarantee, so reading the header *is* learning the mechanisms:

```
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |          Source Port          |       Destination Port        |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                        Sequence Number                        |  ← byte numbering
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                    Acknowledgment Number                      |  ← "next byte I expect"
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |  Data |       |C|E|U|A|P|R|S|F|                               |
   | Offset| rsvd  |W|C|R|C|S|S|Y|I|          Window Size          |  ← flow control
   |       |       |R|E|G|K|H|T|N|N|                               |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |           Checksum            |         Urgent Pointer        |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                    Options (if Data Offset > 5)               |  ← MSS, SACK, etc.
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                          Payload ...                          |
```

**Source / Destination Port (16 bits each).** As in UDP (Ch. 6) — the process-addressing demux key, part of the four-tuple that identifies the connection.

**Sequence Number (32 bits).** *The heart of reliability.* TCP numbers every *byte* of the stream. This field is the sequence number of the *first byte* of this segment's payload. Because every byte has a number, the receiver can detect gaps (missing data), duplicates, and reordering, and reassemble bytes into the exact order sent. (§7.4)

**Acknowledgment Number (32 bits).** *The heart of confirmation.* When the ACK flag is set, this is the sequence number of the **next byte the receiver expects** — which implicitly confirms it has received everything *up to* that byte. This is **cumulative acknowledgment**: "ACK 5000" means "I have bytes 0–4999, send me 5000 next." (§7.4)

**Data Offset (4 bits).** Header length in 32-bit words (like IP's IHL) — needed because options make the header variable-length. Normally 5 (20 bytes); larger when options are present.

**Flags (the control bits).** These drive the state machine:
- **SYN** — "synchronize": initiates a connection, carries the initial sequence number. (Handshake, §7.3)
- **ACK** — "this segment's acknowledgment number is valid." Set on essentially every segment after the first.
- **FIN** — "finish": I have no more data to send (graceful close, §7.6).
- **RST** — "reset": abort the connection immediately, something is wrong (§7.6).
- **PSH** — "push": deliver this data to the application promptly (don't wait to buffer more).
- **URG** + Urgent Pointer — marks "urgent" data; essentially obsolete, a security footgun, rarely used.
- **CWR / ECE** — congestion signaling (ECN, Chapter 8).

**Window Size (16 bits).** *The heart of flow control.* "I have this many bytes of free buffer space — don't send me more than this without waiting for me to acknowledge." The receiver advertises this on every segment; the sender must never have more unacknowledged data outstanding than the window allows. (§7.5)

**Checksum (16 bits).** Covers the header, payload, and the pseudo-header (the IP-address-borrowing trick from Chapter 6, §6.3) — detecting corruption and misdelivery.

**Urgent Pointer (16 bits).** Offset to "urgent" data when URG is set. Obsolete; ignore in practice.

**Options (variable).** Where modern TCP lives. The important ones, negotiated at connection setup:
- **MSS (Maximum Segment Size)** — the largest payload each side will accept in one segment, derived from the path MTU (Ch. 4) to avoid fragmentation. Typically 1460 (1500 MTU − 20 IP − 20 TCP).
- **Window Scale** — multiplies the 16-bit window field so it can exceed 64KB, essential for high-bandwidth-delay-product links (Ch. 1's BDP — without it you can't fill a fast, long link).
- **SACK Permitted / SACK** — selective acknowledgment (§7.8), how modern TCP avoids re-sending data that already arrived.
- **Timestamps** — for round-trip-time measurement and protection against wrapped sequence numbers.

> **The unifying observation:** UDP's header is 8 bytes because it makes no promises. TCP's header is 20+ bytes because *every guarantee needs bookkeeping fields*. Sequence + Acknowledgment numbers = reliability and ordering. Window = flow control. Flags = the connection state machine. Checksum = integrity. Read the TCP header as a *ledger*, and the whole protocol becomes legible.

---

## 7.2 The State Machine: TCP's Soul

A TCP connection is not a thing that exists "out there" — it's a pair of **state machines**, one at each endpoint, that must be kept consistent through the exchange of segments. Understanding the state machine is understanding TCP, because every operational mystery — why `TIME_WAIT` sockets pile up, why `CLOSE_WAIT` means *your* bug, why a connection won't close — is a state-machine question. Here is the full diagram (the one worth being able to draw from memory):

```
                              ┌──────────┐
                              │  CLOSED  │  ◄───────────────────────┐
                              └────┬─────┘                          │
              passive open (server)│ active open (client)           │
                  listen()         │  connect(): send SYN           │
                              ┌─────┴─────┐                          │
              ┌──────────────►│  LISTEN   │                          │
              │               └─────┬─────┘                          │
              │   recv SYN,         │                                │
              │   send SYN+ACK      │                                │
              │            ┌────────┴────────┐      send SYN         │
              │            │    SYN_RCVD     │      ┌────────────┐    │
              │            └────────┬────────┘      │  SYN_SENT  │    │
              │   recv ACK          │               └─────┬──────┘    │
              │                     │       recv SYN+ACK, │           │
              │                     ▼       send ACK      ▼           │
              │               ┌──────────────────────────────┐       │
              │               │         ESTABLISHED          │       │
              │               │   (data flows both ways)     │       │
              │               └──────┬────────────────┬──────┘       │
              │    close(): send FIN │                │ recv FIN,    │
              │                      ▼                │ send ACK     │
        ── ACTIVE CLOSE ──     ┌──────────┐          ▼              │
        (the side that          │FIN_WAIT_1│   ┌────────────┐  ── PASSIVE
         calls close first)     └────┬─────┘   │ CLOSE_WAIT │     CLOSE ──
              │      recv ACK        │         └─────┬──────┘  (the OTHER side)
              │                      ▼               │ close():
              │               ┌──────────┐           │ send FIN
              │               │FIN_WAIT_2│           ▼
              │               └────┬─────┘     ┌────────────┐
              │   recv FIN,        │           │  LAST_ACK  │
              │   send ACK         ▼           └─────┬──────┘
              │            ┌──────────────┐          │ recv ACK
              │            │  TIME_WAIT   │          ▼
              │            │ (wait 2·MSL) │      ┌────────┐
              │            └──────┬───────┘      │ CLOSED │
              │   timeout         │              └────────┘
              └───────────────────┘
```

Don't memorize it as a static picture — understand it as *a protocol for two parties to agree on starting and stopping*. The states cluster into three phases: **setup** (LISTEN/SYN_SENT/SYN_RCVD → ESTABLISHED), **data transfer** (ESTABLISHED), and **teardown** (the FIN_WAIT/CLOSE_WAIT/TIME_WAIT/LAST_ACK dance). We'll walk setup (§7.3) and teardown (§7.6) in detail; the data-transfer mechanisms (§7.4–7.8) all happen in ESTABLISHED. For now, two states to flag as *operationally critical* — they're the ones you'll actually debug:

- **`TIME_WAIT`** — the active closer (whoever called `close()` first) lingers here for 2×MSL (Maximum Segment Lifetime, typically 2×30s = 60s, or 2×2min on some systems) after the connection closes. *This is normal and correct*, but it ties up the four-tuple, and a busy server that closes many connections can accumulate tens of thousands of TIME_WAIT sockets. (§7.6 explains why it must exist.)
- **`CLOSE_WAIT`** — you received the peer's FIN and ACK'd it, but *your* application hasn't called `close()` yet. **Piling-up CLOSE_WAIT sockets is almost always a bug in your own code** — a leaked connection your application forgot to close. This is one of the most useful diagnostic facts in all of network programming (§7.6).

---

## 7.3 The Three-Way Handshake

A TCP connection opens with the famous **three-way handshake** — three segments that synchronize both sides' sequence numbers and confirm the path works in both directions. Here it is, with the state transitions:

```
   CLIENT                                                    SERVER
   (active open)                                       (passive open, LISTEN)

   CLOSED                                                    LISTEN
     │                                                         │
     │ ──── SYN, seq=x ────────────────────────────────────►  │   "let's talk; my ISN is x"
     │                                                         │
   SYN_SENT                                                 SYN_RCVD
     │                                                         │
     │ ◄──── SYN, seq=y, ACK, ack=x+1 ─────────────────────── │   "ok; my ISN is y, and I
     │                                                         │    confirm your x (expect x+1)"
   ESTABLISHED                                                 │
     │                                                         │
     │ ──── ACK, ack=y+1 ──────────────────────────────────►  │   "I confirm your y (expect y+1)"
     │                                                         │
     │                                                     ESTABLISHED
     │ ◄════════════════ data flows both ways ═══════════════►│
```

Walk through what each message accomplishes:

1. **SYN (client → server):** "I want to open a connection. My **Initial Sequence Number (ISN)** is `x`." The SYN flag is set; `seq=x`. The ISN is *randomly chosen* (critically — see the security note below), not zero.

2. **SYN+ACK (server → client):** "Acknowledged — I'll expect your byte `x+1` next (`ack=x+1`). And here's *my* ISN: `y`." Both SYN and ACK flags set. The server confirms the client's sequence number *and* announces its own in one segment.

3. **ACK (client → server):** "Acknowledged — I'll expect your byte `y+1` next (`ack=y+1`)." Now both sides have exchanged and confirmed initial sequence numbers, and both know the path works in both directions.

**Why three messages, not two?** Because the connection is *full-duplex* — data flows both ways independently — so *each direction* needs its sequence number established and acknowledged. The client's SYN establishes the client→server direction; the server's SYN establishes the server→client direction; and each SYN must be ACK'd. That's four logical events (2 SYNs + 2 ACKs), but the server's SYN and ACK are *combined into one segment* (message 2), collapsing four into three. Two messages wouldn't suffice: with only two, one side never learns whether its own sequence number was received. Three is the minimum to synchronize both directions.

Notice the cost: **the handshake takes one full round trip (1 RTT) before any application data can flow.** On a transcontinental link (Ch. 1, ~160ms RTT), that's 160ms of pure waiting before your first byte. This is exactly the round-trip cost that motivates connection reuse (HTTP keep-alive, Ch. 11), the combined TCP+TLS handshake optimizations (Ch. 12), and ultimately QUIC's 0-RTT (Ch. 14). *The handshake is the tax you pay to set up reliable state, and round trips are expensive (Ch. 1).* — TCP Fast Open (TFO) is an optimization that lets data ride on the SYN to reclaim that RTT for repeat connections, but it's only partially deployed (middlebox interference, the Chapter 2 ossification problem again).

> **Security: why the ISN is random, and the SYN flood attack.** Two security facts live in the handshake. First, the **ISN must be unpredictable**: if an attacker can guess your sequence numbers, they can *forge* segments that your TCP will accept as part of the connection (sequence-number prediction attacks, infamously demonstrated by Kevin Mitnick). Modern stacks generate ISNs with a cryptographic function of the four-tuple plus a secret and a timer (RFC 6528). Second, the **SYN flood**: the handshake requires the server to allocate state when it receives a SYN (entering SYN_RCVD) and *wait* for the final ACK. An attacker sends thousands of SYNs from spoofed source IPs and never completes the handshakes, exhausting the server's half-open-connection table (a denial-of-service). The defense is **SYN cookies**: instead of allocating state on the SYN, the server encodes the connection state into the ISN it returns (`y`), so it can reconstruct the state from the client's final ACK *without* having stored anything — making the attack stateless to absorb. SYN cookies are a beautiful "encode state in the data you'll get back" trick (the same idea as JWT, or the SYN cookie's cousin in QUIC's retry tokens).

---

## 7.4 Sequence and Acknowledgment Numbers: The Arithmetic of Reliability

Now the core mechanism — how TCP actually *guarantees* delivery. The principle is simple and the consequences are deep: **TCP numbers every byte, and the receiver acknowledges the highest contiguous byte it has received. Anything not acknowledged is eventually retransmitted.** Reliability is this accounting loop, run relentlessly.

```
   Sender's stream:  [ byte 1000 ][ byte 1001 ]...[ byte 1999 ]  (1000 bytes, seq starts 1000)

   Sender sends segment:  seq=1000, length=1000  (carries bytes 1000–1999)

   Receiver gets it intact, and replies:
       ACK, ack=2000   ← "I have everything through byte 1999; send me 2000 next"

   This is CUMULATIVE ACK: ack=2000 confirms ALL bytes up to 1999 at once. The ACK
   number is "the next byte I expect," which equals "one past the last byte I have."
```

Three properties make this robust:

**Cumulative acknowledgment.** An ACK confirms *everything* up to that point, not just one segment. So a single ACK can confirm many segments, and if an ACK is lost, the *next* ACK covers the same ground (ACKs are cumulative, so a lost ACK is self-healing — the next one re-confirms everything). This is elegant and efficient.

**Gap detection via the expected sequence number.** Suppose segments arrive out of order — byte-3000 segment arrives before the byte-2000 segment (IP reordered them). The receiver has bytes 1000–1999 and now 3000–3999, but *not* 2000–2999. It cannot acknowledge 4000 (that would falsely claim it has 2000–2999). So it keeps ACKing **2000** — "I still need byte 2000" — even as more out-of-order data piles up. These repeated ACKs for the same number are **duplicate ACKs**, and they're a signal: the sender, seeing several dup-ACKs for 2000, infers that 2000 was lost (while later data got through) and retransmits it — *fast retransmit* (§7.8), without waiting for a timeout.

**Retransmission on timeout.** If the sender sends a segment and *no* ACK comes back within a timeout (the **RTO, Retransmission Timeout**), it assumes the segment was lost and resends it. The RTO is computed adaptively from measured round-trip times (§7.8) — too short and you retransmit needlessly; too long and you stall after a loss.

The beauty is that these few rules — number every byte, cumulatively ACK the highest contiguous byte, retransmit the unacknowledged — combine to handle *every* failure mode IP throws at TCP:
- **Loss?** The lost bytes are never acknowledged → retransmitted (by timeout or fast retransmit).
- **Reordering?** The receiver buffers out-of-order data and reassembles by sequence number, delivering to the application *in order*.
- **Duplication?** Duplicate bytes have sequence numbers the receiver already has → discarded.
- **Corruption?** The checksum fails → the segment is dropped → treated as loss → retransmitted.

All of TCP's reliability is *these numbers*. Everything else (windows, congestion control) is about doing this *efficiently* and *without overwhelming anyone*.

---

## 7.5 Flow Control: The Sliding Window

Reliability says "every byte arrives." But there's a second problem: what if the sender is fast and the receiver is slow? The receiver has a finite buffer; if the sender blasts data faster than the receiver's application can consume it, the buffer overflows and data is lost. **Flow control** prevents this — it's *receiver protection*, distinct from congestion control (network protection, Ch. 8). Don't conflate them: flow control is "don't overwhelm the *receiver*"; congestion control is "don't overwhelm the *network*." Same idea (limit data in flight), different limiter.

The mechanism is the **sliding window**, driven by the Window Size field (§7.1). The receiver advertises, on every ACK, how much free buffer space it has — the **receive window (rwnd)**. The sender may have *at most* `rwnd` bytes of unacknowledged data outstanding at any time.

```
   The sender's view of the byte stream, divided into four regions:

   ...sent & ACKed │ sent, not yet ACKed │ not sent, but ALLOWED │ not allowed yet...
   ────────────────┼─────────────────────┼───────────────────────┼──────────────────►
                   ▲                     ▲                        ▲
              window left edge      next byte to send         window right edge
                   └────────────── the window (= rwnd) ────────┘
                          "can have this many bytes in flight"

   As ACKs arrive, the LEFT edge advances (acknowledged data leaves the window).
   As the receiver frees buffer space, the RIGHT edge advances (window "opens").
   The window SLIDES rightward along the stream — hence "sliding window."
```

The window "slides" as the conversation proceeds: ACKs move the left edge right (confirmed data exits the window), and the receiver advertising more free space moves the right edge right (more data permitted). The sender can keep `rwnd` bytes in flight without waiting — this is what lets TCP achieve high throughput instead of stop-and-wait (send one segment, wait for ACK, send next — which would be catastrophically slow, one segment per RTT).

> **The window and the BDP (callback to Chapter 1).** For the sender to keep a link *full*, the window must be at least the **bandwidth-delay product** (BDP = bandwidth × RTT). If the window is smaller than the BDP, the sender exhausts its window and *stalls* waiting for ACKs while the link sits idle — throughput collapses to `window / RTT`, far below capacity. On a fast, long link (high BDP), the original 16-bit window (max 64KB) is far too small — which is exactly why the **Window Scale option** (§7.1) exists, multiplying the window up to ~1GB. This is the moment Chapter 1's BDP becomes concrete: *the window is the knob that must be ≥ BDP to fill the pipe.* Congestion control (Ch. 8) adds a *second* window (the congestion window, cwnd), and the sender is limited by `min(rwnd, cwnd)` — receiver limit and network limit, whichever is tighter.

**The zero-window and silly-window problems.** Two edge cases worth knowing. If the receiver's buffer fills completely, it advertises `window=0` — "stop sending." The sender pauses and periodically sends a tiny **window probe** to ask "any room yet?" (it can't just wait forever, because the ACK that would re-open the window might have been lost). When the receiver frees space, it advertises a non-zero window and data resumes. The related **silly window syndrome** is a pathology where the receiver advertises tiny window openings (a few bytes) and the sender sends tiny segments, drowning the connection in overhead (40 bytes of header for 1 byte of data). The fixes — the receiver waits to advertise a worthwhile window (Clark's solution), and the sender waits to send a worthwhile segment (Nagle's algorithm, Ch. 8) — keep segments efficiently large. (Nagle's algorithm, as we'll see in Chapter 8, also causes the infamous 40ms latency stall when it collides with delayed ACK — a preview of how these efficiency mechanisms have sharp edges.)

---

## 7.6 Connection Teardown and TIME_WAIT

Closing a TCP connection is more subtle than opening it, because the connection is full-duplex — *each direction* must be closed independently. This is the **four-way teardown** (four segments, vs. the handshake's three):

```
   CLIENT (calls close() first = ACTIVE CLOSE)              SERVER (PASSIVE CLOSE)
   ESTABLISHED                                              ESTABLISHED
     │                                                         │
     │ ──── FIN, seq=u ────────────────────────────────────►  │  "I'm done sending"
   FIN_WAIT_1                                                  │
     │ ◄──── ACK, ack=u+1 ──────────────────────────────────  │  "ok, noted"
   FIN_WAIT_2                                              CLOSE_WAIT
     │                                                         │  (server may still send
     │              (server finishes sending its data)         │   data here! half-open)
     │ ◄──── FIN, seq=v ──────────────────────────────────── │  "now I'm done too"
     │                                                     LAST_ACK
     │ ──── ACK, ack=v+1 ──────────────────────────────────►  │  "ok, goodbye"
   TIME_WAIT                                                 CLOSED
     │  (wait 2·MSL, then →)                                   │
   CLOSED
```

The key insight: a **FIN means "I have no more data to send"** — but the *other* direction can keep sending. So when the client sends FIN and the server ACKs it, the connection is **half-closed**: client→server is done, but server→client is still open, and the server can keep sending data (and the client must keep receiving it) until the server *also* sends its FIN. Two FINs, two ACKs, four segments, and each side independently signals "I'm finished." (Often the two middle segments coalesce — the server's ACK and FIN combine if it has no more data — making it look like three, but logically it's four events.)

**Now, the famous `TIME_WAIT`.** After the active closer sends its final ACK, it does *not* immediately go to CLOSED. It enters **TIME_WAIT** and waits **2×MSL** (twice the Maximum Segment Lifetime, where MSL is the longest a segment can live in the network — historically 2 minutes, often configured to 30s, so TIME_WAIT is ~60s–4min). Why this seemingly wasteful wait? Two solid reasons:

1. **To ensure the final ACK arrives.** If the active closer's final ACK is lost, the passive closer (in LAST_ACK) will *retransmit its FIN* after a timeout. If the active closer had already gone to CLOSED, it would respond to the retransmitted FIN with a RST (it has no connection anymore), and the passive closer would see an error instead of a clean close. By lingering in TIME_WAIT, the active closer is still around to re-ACK the retransmitted FIN, ensuring the *other* side closes cleanly.

2. **To prevent "old duplicate" segments from a closed connection contaminating a new one.** Suppose a segment from this connection got delayed in the network (stuck in a queue somewhere). If you immediately reused the same four-tuple for a brand-new connection, that delayed old segment could arrive and be mistaken for data on the new connection — corrupting it. Waiting 2×MSL guarantees all old segments from the previous connection have died off (exceeded their maximum lifetime) before the four-tuple can be reused.

TIME_WAIT is *correct and necessary*, but it has a real operational cost: **the active closer holds the four-tuple for 2×MSL, unable to reuse it.** A server that initiates many short connections (e.g. a proxy opening and closing connections to a backend) can accumulate *tens of thousands* of TIME_WAIT sockets, potentially exhausting ephemeral ports (Ch. 6) toward that backend. This is a classic production issue. The *right* fixes: have the **client** be the active closer where possible (so TIME_WAIT lands on the client, which has spare capacity), use **connection pooling / keep-alive** (don't open and close so many connections — Ch. 11), and enable `tcp_tw_reuse` (safely reuse TIME_WAIT sockets for new outbound connections, using timestamps to reject old duplicates). The *wrong* fix that people reach for is `tcp_tw_recycle`, which was so broken with NAT that it was removed from Linux entirely — a cautionary tale about "optimizing away" a mechanism whose purpose you don't fully understand.

> **The diagnostic gold, restated because it's that useful:** **Many `TIME_WAIT` sockets on a host = that host is doing a lot of active closes** (often normal for a busy client/proxy; tune with pooling). **Many `CLOSE_WAIT` sockets = a bug in the local application** — it received the peer's FIN but never called `close()`, leaking the connection. CLOSE_WAIT doesn't time out on its own; it sits there until the app closes the socket or dies. So a growing CLOSE_WAIT count is a smoking gun pointing at *your* code's failure to close connections. Internalize the difference (TIME_WAIT = me closing, normal; CLOSE_WAIT = me forgetting to close, bug) and you'll diagnose a whole class of production problems in seconds with `ss -tan state close-wait` / `state time-wait`.

**RST — the abrupt close.** Distinct from the graceful FIN teardown is the **RST (reset)**, which aborts a connection immediately, no handshake. You get a RST when: connecting to a port with nothing listening (`ECONNREFUSED` is a RST), sending data on a connection the peer has already torn down, or an application closes a socket with unread data (or sets SO_LINGER to 0). A RST is "this connection is dead, stop talking" — it discards any in-flight data and skips TIME_WAIT. Useful but blunt; seeing unexpected RSTs in a capture is a sign of crashes, aggressive timeouts, or middleboxes killing idle connections.

---

## 7.7 The Byte-Stream Abstraction (and the Framing Trap)

A point that causes more application bugs than almost anything else in this book: **TCP is a byte stream with no message boundaries.** Recall from Chapter 6 that UDP preserves message boundaries (one send = one recv). TCP does *not*. TCP gives you a continuous, ordered stream of bytes — it has *no idea* where your "messages" begin and end, and it freely splits and coalesces your writes:

```
   Application does:           write("HELLO")  write("WORLD")

   TCP may deliver as:         read() → "HELLOWORLD"        (coalesced)
                          or:  read() → "HEL"  read() → "LOWORLD"  (split)
                          or:  read() → "HELLO" read() → "WORLD"   (lucky, but NOT guaranteed)

   TCP guarantees only: the BYTES arrive in order. NOT that they arrive grouped the
   way you sent them. There are NO message boundaries in a TCP stream.
```

Why does TCP coalesce and split? Because it's optimizing the byte stream for the network: Nagle's algorithm (Ch. 8) batches small writes into fuller segments; the MSS caps segment size, splitting large writes; and the receiver delivers whatever bytes have arrived. None of this respects your application's notion of a "message" — TCP doesn't *have* that notion.

**The consequence — you must frame your own messages.** Every protocol built on TCP must define where one logical message ends and the next begins, because TCP won't. The standard techniques:
- **Length prefix:** send the message length first (e.g. a 4-byte big-endian length), then read exactly that many bytes. This is what gRPC, most RPC protocols, and Kafka use.
- **Delimiter:** mark the end with a special byte sequence (HTTP/1 uses `\r\n\r\n` to end headers; Redis uses `\r\n` between elements). Requires escaping or guaranteeing the delimiter can't appear in the payload.
- **Self-describing format:** the message structure itself indicates its end (parse until structurally complete).

**The bug this prevents:** the naive mistake is to assume "one `write()` = one `read()`" and parse each `read()` as a complete message. This *appears* to work in testing (small messages on localhost usually arrive intact) and then fails in production under load, across the real network, where TCP splits and coalesces — you suddenly read half a message, or two messages stuck together, and your parser corrupts. This is one of the most common and most *intermittent* networking bugs, precisely because it works until it doesn't. **The fix is always: implement framing, read in a loop until you have a complete message, buffer the leftover bytes for the next message.** We'll do exactly this when we build an HTTP server in Chapter 11 — HTTP's framing (Content-Length, chunked encoding) exists *because* TCP gives no boundaries. Internalize "TCP is a byte stream, frame your own messages" and you'll never write this bug.

---

## 7.8 Retransmission and SACK: Recovering from Loss Efficiently

We've established *that* TCP retransmits unacknowledged data (§7.4). Now *how*, efficiently — because naive retransmission wastes bandwidth and time, and the refinements here are what make TCP fast in the real, lossy world.

### Timeout-based retransmission and the RTO

The baseline: if a segment isn't ACKed within the **Retransmission Timeout (RTO)**, resend it. The hard part is *choosing* the RTO. Too short → spurious retransmissions (you resend data that was merely delayed, wasting bandwidth and, worse, falsely signaling congestion to Ch. 8's machinery). Too long → after a real loss, the connection stalls for the whole timeout before recovering, killing latency. The RTO must *adapt* to the connection's actual round-trip time, which varies wildly (1ms on a LAN, 300ms transcontinental, and jittery).

TCP measures the RTT of segments (time from send to ACK) and computes the RTO with the **Jacobson/Karels algorithm** (RFC 6298), one of the most important and elegant pieces of TCP, born from the 1986 internet congestion collapse:

```
   SRTT   = smoothed RTT     = (1−α)·SRTT + α·measured_RTT     (α = 1/8)
   RTTVAR = RTT variation    = (1−β)·RTTVAR + β·|SRTT − measured_RTT|   (β = 1/4)
   RTO    = SRTT + 4·RTTVAR   (clamped to a minimum, often ~200ms–1s)

   Key insight: the RTO is the smoothed RTT PLUS a generous margin proportional to
   the RTT's VARIANCE. On a stable link (low variance), RTO hugs the RTT tightly. On
   a jittery link (high variance), RTO backs way off to avoid spurious timeouts.
   Including the variance was Jacobson's crucial 1988 insight — earlier formulas used
   only the mean and broke badly under load.
```

When a retransmission *itself* times out, TCP doubles the RTO (**exponential backoff** — the same idea as Ethernet's CSMA/CD backoff from Ch. 1 and your retry-with-jitter loops). This prevents a struggling connection from hammering an already-troubled network.

### Fast retransmit: don't wait for the timeout

Timeouts are slow (hundreds of ms minimum). If only *one* segment in a stream is lost while later segments arrive fine, waiting for the RTO is wasteful — there's faster evidence of the loss. Recall from §7.4 that out-of-order arrivals trigger **duplicate ACKs** (the receiver keeps ACKing the byte it's still missing). TCP uses this: **on receiving 3 duplicate ACKs** for the same sequence number, the sender concludes that segment was lost (the dup-ACKs prove later data is getting through, so it's not a general outage) and **retransmits immediately, without waiting for the RTO**. This is **fast retransmit**, and it's the common-case loss recovery on a healthy connection — far faster than a timeout.

```
   Sender sends segments for bytes:  1000, 2000, 3000, 4000, 5000
   Byte-2000 segment is LOST; the rest arrive.

   Receiver gets 1000 → ACK 2000  ("got 1000, want 2000")
   Receiver gets 3000 → ACK 2000  ("still want 2000!")   ← dup ACK #1
   Receiver gets 4000 → ACK 2000  ("still want 2000!")   ← dup ACK #2
   Receiver gets 5000 → ACK 2000  ("still want 2000!")   ← dup ACK #3
                                          │
                  3 dup ACKs → sender FAST RETRANSMITS byte-2000 segment immediately
                  (doesn't wait for the RTO — recovery in ~1 RTT instead of ~1 RTO)
```

### SACK: don't re-send what already arrived

Here's the inefficiency that remained. With *cumulative* ACKs alone, when byte-2000 is lost, the receiver can only say "I want 2000" — it *cannot* tell the sender "but I already have 3000, 4000, and 5000." So a naive sender, on retransmitting, might resend 2000 *and everything after it* (because cumulative ACKs gave it no way to know what got through) — wastefully re-transmitting data the receiver already has. On a link with multiple losses, this is badly inefficient.

**SACK (Selective Acknowledgment, RFC 2018)** fixes this. It's a TCP option (negotiated at handshake, §7.1) that lets the receiver explicitly tell the sender *which non-contiguous blocks* it has received, beyond the cumulative ACK:

```
   With SACK, the receiver's ACK carries BOTH:
     • the cumulative ACK:   ack=2000   ("I have everything up to 1999")
     • SACK blocks:          SACK 3000–5999   ("AND I separately have bytes 3000–5999")

   Now the sender knows EXACTLY what's missing: only bytes 2000–2999. It retransmits
   ONLY that gap, not 3000–5999 (which the receiver already holds). No wasted bandwidth.
```

SACK transforms loss recovery from "retransmit the gap and hope" into "retransmit *precisely* the missing bytes." On connections with multiple losses in one window — common on lossy wireless or congested links — SACK is a large efficiency win, and essentially all modern TCP stacks enable it. (Its modern refinement, **RACK — Recent ACKnowledgment** — uses time rather than dup-ACK counts to detect loss, handling reordering more gracefully; it's the default in recent Linux.) The through-line: TCP's loss recovery evolved from "timeout and resend everything" → "fast retransmit on 3 dup-ACKs" → "SACK to resend only the gaps" → "RACK time-based detection," each step squeezing more efficiency out of the same fundamental sequence-number bookkeeping.

---

## 7.9 Code: A TCP Segment Decoder and Handshake Observer

Let's make all of this visible. We extend our sniffer one final time to decode TCP segments — printing the ports, sequence/ack numbers, flags, and window — and to recognize handshakes and teardowns by their flag patterns. This is the tool that lets you *watch* the state machine in action on real traffic.

**`tcp_decode.c`** **`[needs CAP_NET_RAW / sudo, Linux]`**

```c
/* tcp_decode.c — sniff frames; for IPv4/TCP, decode the TCP header and annotate
 * handshake/teardown segments by their flags.
 *   Build:  gcc -Wall -O2 -o tcp_decode tcp_decode.c
 *   Run:    sudo ./tcp_decode
 * Then in another terminal: curl http://example.com  (and watch the handshake)
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <linux/if_packet.h>
#include <linux/if_ether.h>
#include <net/ethernet.h>

struct ipv4_hdr {              /* (same as Chapter 4) */
    unsigned char  ihl:4, version:4;
    unsigned char  tos;
    unsigned short tot_len, id, frag_off;
    unsigned char  ttl, protocol;
    unsigned short checksum;
    unsigned int   saddr, daddr;
} __attribute__((packed));

struct tcp_hdr {
    unsigned short sport, dport;     /* source / destination ports        */
    unsigned int   seq;              /* sequence number                   */
    unsigned int   ack;              /* acknowledgment number             */
    unsigned char  reserved:4, doff:4;   /* data offset (header words)    */
    unsigned char  flags;            /* FIN URG... but see bit masks below */
    unsigned short window;           /* receive window (flow control)     */
    unsigned short checksum, urg;
} __attribute__((packed));

/* TCP flag bit masks (in the flags byte). */
#define F_FIN 0x01
#define F_SYN 0x02
#define F_RST 0x04
#define F_PSH 0x08
#define F_ACK 0x10

int main(void) {
    int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
    if (fd < 0) { perror("socket (need sudo)"); return 1; }

    unsigned char buf[ETH_FRAME_LEN];
    for (;;) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n < (ssize_t)sizeof(struct ethhdr)) continue;
        struct ethhdr *eth = (struct ethhdr *)buf;
        if (ntohs(eth->h_proto) != ETH_P_IP) continue;

        struct ipv4_hdr *ip = (struct ipv4_hdr *)(buf + sizeof(struct ethhdr));
        if (ip->protocol != 6) continue;                  /* TCP only */

        /* TCP header starts after the (variable-length) IP header. */
        struct tcp_hdr *tcp =
            (struct tcp_hdr *)((unsigned char *)ip + ip->ihl * 4);

        char src[INET_ADDRSTRLEN], dst[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &ip->saddr, src, sizeof src);
        inet_ntop(AF_INET, &ip->daddr, dst, sizeof dst);

        unsigned char fl = tcp->flags;
        char flags[8] = "";   /* build a flag string like "SYN ACK" */
        if (fl & F_SYN) strcat(flags, "S");
        if (fl & F_ACK) strcat(flags, "A");
        if (fl & F_FIN) strcat(flags, "F");
        if (fl & F_RST) strcat(flags, "R");
        if (fl & F_PSH) strcat(flags, "P");

        /* Annotate the segment's role in the state machine by its flags. */
        const char *role = "";
        if      ((fl & (F_SYN|F_ACK)) == F_SYN)        role = "  <- SYN (handshake 1)";
        else if ((fl & (F_SYN|F_ACK)) == (F_SYN|F_ACK))role = "  <- SYN+ACK (handshake 2)";
        else if (fl & F_FIN)                            role = "  <- FIN (teardown)";
        else if (fl & F_RST)                            role = "  <- RST (abort!)";

        printf("%s:%d -> %s:%d  [%s]  seq=%u ack=%u win=%u%s\n",
               src, ntohs(tcp->sport), dst, ntohs(tcp->dport),
               flags, ntohl(tcp->seq), ntohl(tcp->ack),
               ntohs(tcp->window), role);
    }
    close(fd);
    return 0;
}
```

Run `sudo ./tcp_decode` and in another terminal `curl http://example.com`. You'll watch a connection's whole life:

```
192.168.1.5:54880 -> 93.184.216.34:80  [S]    seq=1656013648 ack=0 win=64240   <- SYN (handshake 1)
93.184.216.34:80 -> 192.168.1.5:54880  [SA]   seq=708392301 ack=1656013649 win=65535  <- SYN+ACK (handshake 2)
192.168.1.5:54880 -> 93.184.216.34:80  [A]    seq=1656013649 ack=708392302 win=64240
192.168.1.5:54880 -> 93.184.216.34:80  [PA]   seq=1656013649 ack=708392302 win=64240   ← the HTTP GET
93.184.216.34:80 -> 192.168.1.5:54880  [A]    seq=708392302 ack=1656013723 win=65535
93.184.216.34:80 -> 192.168.1.5:54880  [PA]   seq=708392302 ack=1656013723 win=65535   ← the HTTP response
192.168.1.5:54880 -> 93.184.216.34:80  [FA]   seq=1656013723 ack=708393688 win=64240   <- FIN (teardown)
93.184.216.34:80 -> 192.168.1.5:54880  [FA]   seq=708393688 ack=1656013724 win=65535   <- FIN (teardown)
192.168.1.5:54880 -> 93.184.216.34:80  [A]    seq=1656013724 ack=708393689 win=64240
```

Read the whole state machine in that output: the SYN / SYN+ACK / ACK handshake (note `ack` = peer's `seq` + 1, confirming §7.3's arithmetic), the data exchange with PSH+ACK carrying the HTTP request and response (and watch the `ack` numbers climb as bytes are confirmed — §7.4's cumulative ACK in action), then the FIN / FIN+ACK teardown (§7.6). **You are watching TCP's reliability bookkeeping happen, byte by byte, on a real connection.** Everything abstract in this chapter is right there in the sequence and acknowledgment numbers. This is also, incidentally, exactly what `tcpdump -tn 'tcp'` shows you — you've just built a miniature version and now understand every field it prints.

---

## Key Takeaways

1. **TCP builds a reliable, ordered, connection-oriented byte stream on top of unreliable IP, and the whole thing is *bookkeeping*:** every byte is numbered (sequence number), the receiver cumulatively acknowledges the highest contiguous byte it has (acknowledgment number = next byte expected), and anything unacknowledged is eventually retransmitted. Read the 20-byte header as a ledger — seq/ack = reliability+ordering, window = flow control, flags = state machine, checksum = integrity.

2. **A TCP connection is a pair of state machines.** Know the operationally critical states cold: **TIME_WAIT** (the active closer waits 2×MSL — normal, but ties up the four-tuple) and **CLOSE_WAIT** (you got the peer's FIN but haven't called `close()` — *almost always a bug in your code*). This single distinction diagnoses a huge class of production issues.

3. **The three-way handshake (SYN / SYN+ACK / ACK) synchronizes both directions' sequence numbers in the minimum 3 messages** (the server's SYN and ACK combine), costing 1 RTT before any data — the round-trip tax that motivates keep-alive, TLS handshake folding, and QUIC 0-RTT. The ISN must be random (sequence-prediction attacks) and SYN floods are defended with stateless SYN cookies.

4. **Reliability = number every byte + cumulatively ACK the highest contiguous byte + retransmit the unacknowledged.** These few rules handle every failure IP produces: loss (never ACKed → resent), reordering (buffered and reassembled by seq), duplication (already-seen seq → dropped), corruption (checksum fail → treated as loss).

5. **Flow control is the sliding window** — the receiver advertises free buffer (rwnd) and the sender keeps at most rwnd bytes in flight. This is *receiver* protection (distinct from Ch. 8's *network* protection). To fill a link, the window must be ≥ the bandwidth-delay product — which is why the Window Scale option exists for high-BDP links.

6. **Teardown is four-way because the connection is full-duplex** — each direction closes independently (a FIN means "I'm done sending," but the peer can keep sending: the half-closed state). **TIME_WAIT exists for two reasons**: to re-ACK a retransmitted FIN (clean close for the peer) and to let old duplicate segments die before the four-tuple is reused. Fix TIME_WAIT pileups with connection pooling and client-side closing, not by disabling the mechanism.

7. **TCP is a byte stream with NO message boundaries** — it freely splits and coalesces your writes. *You must frame your own messages* (length prefix, delimiter, or self-describing format). Assuming "one write = one read" is a classic intermittent bug that works in testing and fails under production load. HTTP's Content-Length and chunked encoding exist precisely because TCP gives no boundaries.

8. **Loss recovery evolved for efficiency:** adaptive RTO via the Jacobson/Karels algorithm (smoothed RTT + 4×variance, with exponential backoff) → **fast retransmit** (3 duplicate ACKs trigger immediate resend, no timeout wait) → **SACK** (receiver reports exactly which non-contiguous blocks it has, so the sender retransmits only the gaps) → RACK (time-based detection). All of it rests on the same sequence-number bookkeeping.

---

## Interview Drills

**Q1. How does TCP turn IP's unreliable packet delivery into a reliable, ordered byte stream?**
*Model answer:* Through sequence-number bookkeeping plus retransmission. TCP numbers every byte of the stream; each segment's header carries the sequence number of its first payload byte. The receiver sends cumulative acknowledgments — the ACK number is "the next byte I expect," which confirms receipt of everything up to that point. The sender retransmits any data that isn't acknowledged within an adaptive timeout (or sooner, via fast retransmit on duplicate ACKs). These rules cover every failure IP produces: lost segments are never ACKed so they're resent; reordered segments are buffered and reassembled by sequence number before delivery to the app; duplicate segments carry already-seen sequence numbers and are discarded; corrupted segments fail the checksum and are dropped, then treated as loss. So the application sees a perfect ordered stream, manufactured entirely from careful accounting on top of best-effort datagrams.

**Q2. Why is the TCP handshake three messages and not two or four?**
*Model answer:* Because a TCP connection is full-duplex, so each direction needs its sequence number established and acknowledged — that's four logical events: the client's SYN, the server's ACK of it, the server's SYN, and the client's ACK of it. But the server can combine its ACK (of the client's SYN) and its own SYN into a single SYN+ACK segment, collapsing four events into three messages. Two messages wouldn't work: with only two, one side never confirms that its sequence number was received, so it can't know the reverse path works. Three is the minimum that synchronizes both directions and proves bidirectional connectivity. The cost is one full round-trip of latency before any application data flows, which is why connection reuse and 0-RTT optimizations matter so much.

**Q3. You see thousands of sockets in CLOSE_WAIT on your server. What does that tell you?**
*Model answer:* It tells me there's a bug in my own application — it's leaking connections. CLOSE_WAIT means the peer sent a FIN (it's done sending), my TCP stack ACKed it automatically, and now it's waiting for *my application* to call `close()` on the socket — which it hasn't. CLOSE_WAIT doesn't time out on its own; the socket sits there consuming a file descriptor until the app closes it or the process dies. So a growing CLOSE_WAIT count is a smoking gun for a code path that finishes with a connection but forgets to close it (a missing `close()`/`defer conn.Close()`, an exception that skips cleanup, a connection-pool leak). Contrast TIME_WAIT, which is on the *active closer* and is normal-but-tunable. The mnemonic: TIME_WAIT = me closing properly (normal); CLOSE_WAIT = me forgetting to close (my bug). I'd grep for where that connection type is handled and ensure every path closes the socket.

**Q4. What is TIME_WAIT, why does it exist, and why can it be a problem?**
*Model answer:* TIME_WAIT is the state the active closer (whoever called close() first) enters after sending the final ACK of the teardown; it lingers there for 2×MSL (twice the maximum segment lifetime, roughly 60 seconds to a few minutes) before fully closing. It exists for two reasons: (1) if its final ACK is lost, the peer will retransmit its FIN, and the lingering socket is still around to re-ACK it, ensuring the peer closes cleanly instead of getting a RST; (2) it prevents old, delayed duplicate segments from the just-closed connection from arriving on a *new* connection that reuses the same four-tuple — waiting 2×MSL guarantees those stragglers have expired. It's correct and necessary. The problem is operational: the active closer holds that four-tuple unusable for the whole 2×MSL, so a host that initiates and closes many short connections (a proxy hitting a backend) can accumulate tens of thousands of TIME_WAIT sockets and exhaust ephemeral ports toward that destination. The right fixes are connection pooling/keep-alive (fewer closes), arranging for the client rather than the server to be the active closer, and `tcp_tw_reuse` — not disabling the mechanism, which reintroduces the bugs it prevents.

**Q5. A colleague's TCP-based protocol "works in testing but occasionally reads corrupted/partial messages in production." What's likely wrong?**
*Model answer:* They're treating TCP as message-oriented when it's a byte stream with no message boundaries. TCP guarantees ordered bytes, but it freely splits and coalesces writes — one `write()` may arrive across several `read()`s, or several writes may arrive in one `read()`. Their code probably assumes "one write = one read" and parses each read as a complete message. On localhost with small messages that usually holds, so tests pass; but under production load across the real network, segments get split (MSS) and coalesced (Nagle), so they suddenly read half a message or two messages concatenated, and the parser corrupts. The fix is application-level framing: prefix each message with its length and read exactly that many bytes (looping until complete, buffering leftover bytes for the next message), or use a delimiter, or a self-describing format. This is exactly why HTTP has Content-Length and chunked transfer encoding — they're framing on top of TCP's boundary-less stream. The rule: TCP gives you bytes in order, nothing more; you frame your own messages.

**Q6. Explain fast retransmit and how SACK improves on plain cumulative ACKs.**
*Model answer:* Fast retransmit avoids waiting for the (slow) retransmission timeout when a single segment is lost amid others that arrive. When segments arrive out of order, the receiver keeps sending duplicate ACKs for the byte it's still missing (it can't cumulatively ACK past the gap). When the sender sees three duplicate ACKs, it infers that specific segment was lost — the dup-ACKs prove later data is getting through, so it's an isolated loss, not an outage — and retransmits immediately, recovering in about one RTT instead of one RTO. SACK (Selective Acknowledgment) then fixes a remaining inefficiency: with only cumulative ACKs, the receiver can say "I want byte 2000" but *can't* say "I already have 3000–5999," so the sender may wastefully retransmit everything from the gap onward. SACK is a TCP option letting the receiver report the exact non-contiguous blocks it holds alongside the cumulative ACK, so the sender retransmits *only* the missing bytes (2000–2999) and not data the receiver already has. On links with multiple losses per window (lossy wireless, congestion), SACK is a major efficiency win, and it's standard in modern stacks — with RACK, the time-based successor, now the default in recent Linux.

**Q7. What's the difference between flow control and congestion control?**
*Model answer:* They both limit how much data a sender puts in flight, but they protect different things. Flow control protects the *receiver*: it stops a fast sender from overflowing the receiver's finite buffer, using the sliding window — the receiver advertises its available buffer space (the receive window, rwnd) on every ACK, and the sender keeps at most rwnd unacknowledged bytes outstanding. Congestion control (Chapter 8) protects the *network*: it stops senders from overwhelming the routers and links between the endpoints, which no one explicitly advertises — the sender has to *infer* congestion from signals like packet loss or ECN marks and maintains a separate congestion window (cwnd). The sender is bound by the minimum of the two windows, min(rwnd, cwnd): whichever limit is tighter governs. Conflating them is a common error — flow control is about the endpoint's buffer, congestion control is about the path's capacity. To fill a link you also need the window to be at least the bandwidth-delay product, which is a third, related consideration.

---

*Previous: [Chapter 6 — The Transport Layer: UDP and Ports](./06-transport-udp-and-ports.md) | Next: [Chapter 8 — TCP, Part II: Congestion Control](./08-tcp-part2-congestion.md)*
