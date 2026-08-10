# Chapter 6 — The Transport Layer: UDP and Ports

> *IP got your packet to the right machine — across the planet, through a dozen networks, via longest-prefix match and BGP. But a machine runs hundreds of programs. Your browser, your SSH session, three Docker containers, a database, a DNS resolver — all on the same host, all sharing one IP address. The packet arrived at the host. Now: which **program** gets it?*

This is the transport layer's founding question, and it's a different question from everything below. Layers 1–3 were about *getting bytes between machines*. The transport layer (L4) is about *getting bytes between **processes*** — and, optionally, adding the guarantees applications actually want (reliability, ordering, flow control). It's the first layer that the operating system, not the network hardware, fully owns, and the first layer your application code directly touches (through sockets, Chapter 10).

The transport layer forks into two protocols with opposite philosophies: **UDP** (this chapter) and **TCP** (Chapters 7–8). It's tempting to learn UDP as "TCP minus the good parts" and move on — but that framing is wrong and will cost you. UDP is not deficient TCP; it's a *different, deliberately minimal primitive*: **raw packets, plus the one thing IP lacks — the ability to address a specific program.** Understanding UDP properly — what it adds to IP (almost nothing) and what it deliberately *doesn't* (everything else) — is the foundation for understanding why TCP is shaped the way it is, why DNS and video and games chose UDP, and why QUIC (Chapter 14) rebuilt the entire transport layer on top of it. UDP is the blank canvas; this chapter is about what the blank canvas gives you and why a blank canvas is sometimes exactly what you want.

---

## 6.1 Ports: Addressing a Process, Not a Machine

The transport layer's core invention — the thing both UDP and TCP add to IP — is the **port number**: a 16-bit integer (0–65535) that identifies a specific *communication endpoint* (a process's socket) within a host. IP addresses the host; the port addresses the program on it.

```
   One host, one IP (192.168.1.5), many programs — ports tell them apart:

                    ┌──────────────────────────────────────────┐
                    │  Host  192.168.1.5                        │
                    │                                            │
   packet to :443 ─────►  port 443  → nginx (web server)        │
   packet to :22  ─────►  port 22   → sshd                      │
   packet to :5432 ────►  port 5432 → postgres                  │
   packet to :53  ─────►  port 53   → dnsmasq                   │
                    │                                            │
                    └──────────────────────────────────────────┘

   The transport header carries SOURCE port and DESTINATION port. The destination
   port selects which program receives the packet. This is DEMULTIPLEXING.
```

The destination port is the final demux key in the chain we've been following since Chapter 2: EtherType (→ IP) → IP Protocol (→ TCP/UDP) → **destination port (→ the specific application)**. When a UDP datagram for port 53 arrives, the kernel's UDP layer looks up which socket is bound to port 53 and delivers the payload there. This is the literal answer to the chapter's opening question.

### Well-known, registered, and ephemeral ports

Port numbers are divided into ranges by convention (IANA-assigned), and knowing the structure is practical:

```
   0    – 1023    Well-known (system) ports — standard services, bind needs privilege
                    20/21 FTP   22 SSH   25 SMTP   53 DNS   80 HTTP   443 HTTPS
                    123 NTP     143 IMAP   3306 MySQL(reg.)   ...
   1024 – 49151   Registered ports — assigned to specific apps (5432 Postgres,
                    6379 Redis, 8080 alt-HTTP, 9092 Kafka, ...)
   49152 – 65535  Ephemeral (dynamic) ports — the OS hands these out to CLIENTS
```

The **well-known ports** (< 1024) are why you can type `https://example.com` without specifying a port — the client *assumes* 443 because that's the standard. On Unix, binding to a port < 1024 requires root/`CAP_NET_BIND_SERVICE`, a historical security measure (so a random user can't impersonate a system service like SSH). The **ephemeral ports** are the other half of the story, and the one people forget: when *your* program connects out (a browser to a web server), the server side uses the well-known port (443), but *your* side uses a random ephemeral port the OS picks (e.g. 54321). This is essential for the four-tuple.

### The four-tuple: how connections are actually identified

Here's the subtlety that trips people up: a destination port alone is *not* enough to identify a conversation. A busy web server has thousands of clients all connected to port 443 simultaneously. How does it keep them apart? With the **four-tuple** (a.k.a. the connection 4-tuple or socket pair):

```
   A connection/flow is uniquely identified by FOUR values:

   ┌──────────────┬─────────────┬───────────────────┬──────────────┐
   │  Source IP   │ Source Port │   Dest IP         │  Dest Port   │
   ├──────────────┼─────────────┼───────────────────┼──────────────┤
   │ 203.0.113.9  │   54321     │   142.250.80.46   │     443      │   client A
   │ 198.51.100.2 │   61000     │   142.250.80.46   │     443      │   client B
   │ 203.0.113.9  │   54322     │   142.250.80.46   │     443      │   client A, 2nd conn
   └──────────────┴─────────────┴───────────────────┴──────────────┘
            ▲ these differ, so the server distinguishes all three flows ▲

   Same dest IP+port (the server's 443), but the (source IP, source port) pairs
   differ — so the four-tuple is unique per connection. THIS is how one server
   socket on port 443 serves thousands of clients at once.
```

The kernel demultiplexes incoming packets by the *full four-tuple*, not just the destination port. Two packets both destined for `142.250.80.46:443` go to different connections because their *source* (IP, port) differs. This is why a single listening port can serve unlimited concurrent connections — each is a distinct four-tuple. (For UDP, which is connectionless, the kernel demuxes to the socket bound to the destination port, and the application sees the source address per-datagram; for TCP, the four-tuple maps to a specific established connection. We'll see the TCP side in Chapter 7.)

> **Practical consequence — ephemeral port exhaustion.** A single *client* making many connections *to the same server* (same dest IP:port) can only vary its *source port* — and there are only ~16,000–28,000 ephemeral ports by default. So one machine can make at most ~28k simultaneous connections *to one destination* before it runs out of source ports (`EADDRNOTAVAIL`). This bites load-test rigs, API gateways, and proxies hammering one backend. Fixes: connection pooling/reuse, widening the ephemeral range (`net.ipv4.ip_local_port_range`), or spreading across multiple destination IPs. Knowing the four-tuple is *why* this limit exists makes it diagnosable instead of mysterious. (We revisit this and `TIME_WAIT`'s role in Chapter 7.)

---

## 6.2 UDP: The Minimal Transport

**UDP (User Datagram Protocol, RFC 768)** is one of the shortest, simplest protocols you'll ever meet — the entire specification is a few pages — and its simplicity is the *point*. UDP adds exactly two things to raw IP: **ports** (so you can address a process) and an **optional checksum** (so you can detect corruption). That's it. Everything else that IP doesn't provide — reliability, ordering, flow control, congestion control, connection setup — UDP also doesn't provide. UDP is, almost literally, "IP with port numbers."

The header is gloriously minimal — 8 bytes:

```
    0                   1                   2                   3
    0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |          Source Port          |       Destination Port        |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |            Length             |           Checksum            |
   +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
   |                          Payload  ...                          |
```

All four fields:
- **Source Port (16 bits)** — where replies go (optional; can be 0 if no reply expected).
- **Destination Port (16 bits)** — the demux key, which program gets it.
- **Length (16 bits)** — header + payload length in bytes.
- **Checksum (16 bits)** — covers the header, payload, *and a "pseudo-header"* (§6.3). Optional in IPv4 (can be 0 = "not computed"), mandatory in IPv6.

Compare that to TCP's 20-byte header full of sequence numbers, acknowledgments, flags, and windows (Chapter 7). UDP has *none* of that machinery because it makes *none* of those promises. The defining characteristics:

**Connectionless.** There is no handshake, no connection setup, no teardown. You just send a datagram. The first UDP packet *is* the conversation — no round trip is wasted establishing anything. (Contrast TCP's mandatory three-way handshake, a full RTT of latency before any data, Chapter 7.) This is UDP's killer latency advantage.

**Unreliable.** UDP does not acknowledge receipt, does not retransmit lost packets, does not detect loss at all. If a datagram is dropped by a congested router (Chapter 4's "best-effort"), it's simply gone — neither sender nor receiver is told. The application either doesn't care (a dropped video frame is forgotten in 16ms) or builds its own reliability (DNS retries the query; QUIC implements full retransmission).

**Unordered.** UDP datagrams may arrive in a different order than sent (IP can reorder them). UDP delivers them in the order they *arrive*, not the order they were *sent*. The application must handle reordering if it matters.

**Message-oriented (preserves boundaries).** This is a crucial and underappreciated difference from TCP. UDP preserves *message boundaries*: one `sendto()` of 100 bytes arrives as exactly one `recvfrom()` of 100 bytes. The receiver gets discrete datagrams, each a complete message. TCP, by contrast, is a *byte stream* — it has no message boundaries at all; ten `write()`s might arrive as one `read()` or be split across several, and the application must frame its own messages (a constant source of bugs, Chapter 7/11). UDP's datagram model is *easier* for message-shaped data — you don't have to invent your own framing.

**No flow or congestion control.** UDP sends as fast as the application calls `send()`. It does *not* slow down for a slow receiver (no flow control) or for a congested network (no congestion control). This is powerful (no throttling) and dangerous (a UDP firehose can congest a network and starve well-behaved TCP flows — which is why high-rate UDP applications are *expected* to implement their own congestion control, and why QUIC does).

> **The reframe to carry forward:** UDP is not "broken TCP." It's a *minimal datagram service with process addressing* — the thinnest possible shim over IP. Think of it as **"IP that programs can use"** or **"a blank canvas."** Everything TCP does, UDP leaves to you. Sometimes that's a burden (you must build reliability yourself). Sometimes it's *exactly what you want* — because TCP's guarantees come with costs (latency, head-of-line blocking, connection state) that some applications can't afford and don't need. The next section is about when the blank canvas wins.

---

## 6.3 The Pseudo-Header: A Layering Wrinkle Worth Knowing

The UDP (and TCP) checksum has a quirk that's a favorite interview "gotcha" and a genuine insight into a layering compromise. The checksum is computed not just over the UDP header and payload, but also over a **pseudo-header** — a few fields *borrowed from the IP layer*:

```
   UDP/TCP pseudo-header (IPv4) — NOT transmitted, only used in checksum calc:
   ┌───────────────────────────────────────┐
   │           Source IP Address           │   ← from the IP header (L3!)
   ├───────────────────────────────────────┤
   │         Destination IP Address        │   ← from the IP header (L3!)
   ├──────────┬──────────────┬─────────────┤
   │  zeros   │  Protocol    │  UDP Length │
   └──────────┴──────────────┴─────────────┘
   The checksum covers:  pseudo-header  +  UDP header  +  UDP payload
```

Why borrow IP-layer fields into an L4 checksum? It's a **deliberate, pragmatic layering violation** that catches a specific error: a packet **misdelivered to the wrong host**. If the source/destination IP got corrupted *after* the IP checksum was verified (or in a way the IP checksum missed), the pseudo-header makes the UDP checksum fail too — so a packet that ends up at the wrong machine (or claims the wrong source) is caught and dropped at L4, not accepted. The transport layer "double-checks" the addressing the network layer was responsible for.

This is a small, honest example of the theme from Chapter 2: **the clean layered model is occasionally, deliberately violated for a real benefit.** The transport layer is "supposed" to know nothing about IP addresses — they're L3's business — but reaching down to include them in the checksum provides defense-in-depth against misdelivery that pure layering wouldn't. It's also a headache in practice: it's *why NAT (Chapter 5) must recompute transport checksums* — when NAT rewrites the IP addresses and ports, the pseudo-header changes, so the UDP/TCP checksum must be recalculated. The layering violation propagates: because L4's checksum depends on L3's addresses, anything that rewrites L3 addresses (NAT) must also touch L4. A clean separation would have avoided this coupling; the designers judged the misdelivery protection worth it. Know this one — it comes up.

---

## 6.4 When UDP Wins: The Right Tool

UDP is the right choice precisely when TCP's guarantees would *hurt* more than help. Here are the canonical cases, each illustrating a different reason the blank canvas beats the full-service protocol:

**DNS (Chapter 9) — small, single-shot, latency-critical.** A DNS query is one small request, one small response. Setting up a TCP connection (handshake = 1 RTT wasted) for a single tiny exchange is absurd overhead — the handshake would cost more than the query. UDP sends the query immediately (no setup), gets the answer, done — one round trip total. If the response is lost, DNS just *re-asks* (application-level retry); the simplicity is worth more than TCP's automatic reliability for a request this small and idempotent. *Lesson: for tiny, single-shot, idempotent exchanges, TCP's setup cost dominates and UDP's immediacy wins.* (DNS does fall back to TCP for large responses that don't fit a datagram — zone transfers, DNSSEC — but the common case is UDP.)

**Real-time media — video calls, live streaming, VoIP — where stale data is worthless.** This is the most important UDP insight. In a video call, if a packet carrying frame N is lost, you do *not* want TCP's behavior — TCP would *stop everything and retransmit* frame N, holding up frames N+1, N+2, ... while it recovers the old one (head-of-line blocking, Chapter 7/13). But by the time the retransmitted frame N arrives, it's *too late to display* — that moment of video is in the past. You'd rather *skip* the lost frame and keep playing the fresh ones. **For real-time media, a late packet is as useless as a lost one, so TCP's "deliver everything, in order, even if late" is exactly the wrong guarantee.** UDP lets the application say "drop it and move on," which is what real-time demands. *Lesson: when freshness beats completeness, you must not let the transport stall the present to recover the past — so you can't use TCP.*

**Online games — low latency over completeness.** Same logic: a fast-twitch game wants the *latest* player positions, not a faithful replay of every stale position. Losing one position update is fine — the next one (16ms later) supersedes it. UDP's "send now, don't retransmit, don't stall" is ideal. Games build minimal custom reliability only for the things that *must* arrive (e.g. "player fired weapon"), getting the best of both: TCP-like reliability where needed, UDP immediacy everywhere else.

**Multicast/broadcast — one-to-many.** TCP is strictly point-to-point (a connection has exactly two endpoints). UDP can send one datagram to *many* receivers (multicast) — essential for service discovery (mDNS/Bonjour, the `33:33:...`/`224.x` traffic you saw in Chapter 3's sniffer), IPTV, and financial market-data feeds where one source fans out to thousands of subscribers.

**Custom transports — QUIC, and the future.** The deepest reason UDP matters: it's the **substrate for building your own transport**. QUIC (Chapter 14) wanted TCP's reliability *plus* multiplexed streams *plus* integrated encryption *plus* connection migration — but couldn't get them by modifying TCP (kernel TCP is ossified, and middleboxes mangle anything that isn't the TCP they expect, Chapter 2). So QUIC built all of it *in userspace on top of UDP*, using UDP purely as "IP with ports that middleboxes will pass." UDP's minimalism — the very thing that makes it "incomplete" — is what makes it the perfect foundation to build *anything* on. *Lesson: when you need a transport that doesn't exist yet, UDP is the blank canvas you build it on.*

```
   The decision, distilled:

   Use TCP when:                          Use UDP when:
   • You need every byte, in order         • Stale data is worthless (real-time media,
   • The data is a stream (file, HTTP)       games) — freshness > completeness
   • You want reliability for free         • Tiny single-shot exchange (DNS) — setup
   • Setup cost (1 RTT) is amortized         cost would dominate
     over a long connection                • One-to-many (multicast)
   • Most request/response apps            • You're building a custom transport (QUIC)
                                           • You'll implement your own reliability
```

> **The interview-grade synthesis:** the choice between TCP and UDP is a choice about *who handles reliability and at what cost.* TCP handles it for you, completely, at the cost of latency (handshake), head-of-line blocking (one loss stalls everything behind it), and connection state. UDP hands you a blank, immediate, stateless datagram service and says "build exactly the reliability you need, and no more." For a file transfer, you want all of TCP's guarantees — take them. For a video frame, TCP's "stop and recover the past" guarantee is actively harmful — refuse it, use UDP, and drop what you can't use in time. The protocols aren't better/worse; they encode opposite answers to "what should happen when a packet is lost?", and the right answer depends entirely on whether your data is still useful late.

---

## 6.5 Code: A UDP Echo Client and Server

UDP's simplicity shows in code — a working client/server is tiny, and there's no handshake, no connection object, just `sendto`/`recvfrom` on datagrams. This is portable POSIX (compiles and runs on Linux *and* macOS), and it's the cleanest possible illustration of the connectionless, message-oriented model.

**`udp_server.c`**

```c
/* udp_server.c — a UDP echo server: receive a datagram, send it back.
 *   Build:  gcc -Wall -O2 -o udp_server udp_server.c
 *   Run:    ./udp_server 9000
 * Note: NO listen(), NO accept(), NO connection. Just bind and recvfrom/sendto.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 9000;

    /* SOCK_DGRAM = UDP. (SOCK_STREAM would be TCP.) */
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket"); return 1; }

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);   /* listen on all interfaces */
    addr.sin_port = htons(port);

    if (bind(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        perror("bind"); return 1;
    }
    printf("UDP echo server listening on port %d\n", port);

    char buf[2048];
    for (;;) {
        struct sockaddr_in client; socklen_t clen = sizeof client;
        /* recvfrom gives us BOTH the data AND who sent it (no connection to remember). */
        ssize_t n = recvfrom(fd, buf, sizeof buf, 0,
                             (struct sockaddr *)&client, &clen);
        if (n < 0) { perror("recvfrom"); continue; }

        char ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client.sin_addr, ip, sizeof ip);
        printf("got %zd bytes from %s:%d\n", n, ip, ntohs(client.sin_port));

        /* Echo it straight back to whoever sent it. One message in, one out:
         * UDP preserves message boundaries — this n-byte datagram stays n bytes. */
        sendto(fd, buf, n, 0, (struct sockaddr *)&client, clen);
    }
    close(fd);
    return 0;
}
```

**`udp_client.c`**

```c
/* udp_client.c — send a line to the UDP echo server and print the reply.
 *   Build:  gcc -Wall -O2 -o udp_client udp_client.c
 *   Run:    ./udp_client 127.0.0.1 9000 "hello udp"
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: %s <ip> <port> <message>\n", argv[0]);
        return 1;
    }
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket"); return 1; }

    struct sockaddr_in srv = {0};
    srv.sin_family = AF_INET;
    srv.sin_port = htons(atoi(argv[2]));
    inet_pton(AF_INET, argv[1], &srv.sin_addr);

    /* No connect() needed — just send the datagram to the server's address.
     * (The OS picks an ephemeral source port for us automatically.) */
    sendto(fd, argv[3], strlen(argv[3]), 0, (struct sockaddr *)&srv, sizeof srv);

    char buf[2048];
    struct sockaddr_in from; socklen_t fl = sizeof from;
    ssize_t n = recvfrom(fd, buf, sizeof buf - 1, 0,
                         (struct sockaddr *)&from, &fl);
    if (n < 0) { perror("recvfrom"); return 1; }
    buf[n] = '\0';
    printf("server replied: %s\n", buf);

    close(fd);
    return 0;
}
```

Run them:

```
$ ./udp_server 9000 &
UDP echo server listening on port 9000
$ ./udp_client 127.0.0.1 9000 "hello udp"
server replied: hello udp
# server side prints: got 9 bytes from 127.0.0.1:54321   ← note the ephemeral source port!
```

Notice everything that *isn't* here, compared to the TCP version we'll write in Chapter 10: no `listen()`, no `accept()`, no connection object, no handshake, no streams. The server `bind()`s and immediately `recvfrom()`s; the client `sendto()`s and immediately `recvfrom()`s. Each datagram carries its own return address (that's why `recvfrom` gives you the sender's address — there's no connection to remember it for you). And the message boundary is preserved: the client sent one 9-byte message, the server received exactly one 9-byte message. **This is the entire UDP programming model in 30 lines** — and it's the model QUIC, DNS, and every game netcode starts from before building their own everything-else on top.

> **Try this to *feel* the unreliability:** point the client at a host that's down, or drop the server mid-conversation. The client's `recvfrom()` just blocks forever (or until you add a timeout) — UDP gives *no* error, no "connection refused", no notification of loss. That silence *is* UDP: it did its job (handed the datagram to IP) and makes no promises about what happened next. Contrast TCP's `connect()` failing loudly with `ECONNREFUSED`. The silence is the lesson.

---

## Key Takeaways

1. **The transport layer's founding job is process-to-process delivery via ports** — a 16-bit number identifying a program's endpoint on a host. The destination port is the final demux key (EtherType → IP Protocol → port → the application). IP addresses the machine; the port addresses the program.

2. **Connections are identified by the four-tuple (src IP, src port, dst IP, dst port), not just the destination port** — which is how one listening port serves thousands of concurrent clients (each is a distinct four-tuple). This also explains *ephemeral port exhaustion*: one client to one destination can only vary its source port (~28k available), capping simultaneous connections to a single backend.

3. **UDP adds exactly two things to raw IP — ports and an optional checksum — and nothing else.** It is not "broken TCP"; it's a deliberately minimal datagram service: connectionless (no handshake, no setup RTT), unreliable (no ACKs, no retransmission, no loss detection), unordered, message-oriented (preserves boundaries — unlike TCP's byte stream), and with no flow/congestion control. Think "IP that programs can use" — a blank canvas.

4. **UDP is message-oriented; TCP is a byte stream.** One UDP `send` = one `recv` of the same size; message boundaries are preserved. TCP has no boundaries — the application must frame its own messages. This makes UDP simpler for discrete-message data.

5. **The pseudo-header is a deliberate layering violation:** the UDP/TCP checksum reaches down to include the IP source/destination addresses, providing defense-in-depth against misdelivery to the wrong host. The cost of this coupling is that NAT, which rewrites IP addresses, must recompute the transport checksum.

6. **UDP wins when TCP's guarantees would hurt:** tiny single-shot exchanges where setup cost dominates (DNS), real-time media and games where *a late packet is as useless as a lost one* so you must not stall the present to recover the past (the deepest reason), one-to-many multicast, and as the substrate for custom transports (QUIC). The TCP-vs-UDP choice encodes opposite answers to "what happens when a packet is lost?" — and the right answer depends on whether late data is still useful.

7. **The UDP programming model is `socket(SOCK_DGRAM)` + `bind` + `recvfrom`/`sendto`** — no listen, no accept, no connection. Each datagram carries its own return address. UDP reports nothing on loss — the silence *is* the protocol.

---

## Interview Drills

**Q1. A web server has one IP and one listening port (443), yet serves thousands of clients simultaneously. How does it keep the connections apart?**
*Model answer:* By the four-tuple: (source IP, source port, destination IP, destination port). All those clients share the same destination (the server's IP and port 443), but each client connects from a distinct (source IP, source port) — the OS assigns each client an ephemeral source port. So every connection has a unique four-tuple, and the kernel demultiplexes incoming packets to the right connection by matching all four values, not just the destination port. This is why a single listening socket on port 443 can back unlimited concurrent connections — `accept()` spawns a new socket per connection, each bound to a unique four-tuple. The corollary worth mentioning: a single *client* hitting a single *server* can only vary its source port, so it's capped at ~28k simultaneous connections to that one destination before exhausting ephemeral ports — relevant for load testers and proxies.

**Q2. Is UDP just "TCP without reliability"? Frame it correctly.**
*Model answer:* No — that framing implies UDP is a deficient TCP, when it's actually a different, deliberately minimal primitive. UDP adds just two things to raw IP: port numbers (to address a process) and an optional checksum (to detect corruption). It's "IP that programs can use." Everything else — reliability, ordering, flow control, congestion control, connection setup — UDP omits *by design*, not by deficiency. The better mental model is that UDP is a blank canvas: a connectionless, message-preserving, immediate datagram service that hands the application full control to build exactly the guarantees it needs and no more. Sometimes you want TCP's full service (file transfer); sometimes the blank canvas is exactly right (real-time media, or building QUIC). They encode opposite philosophies, not better/worse versions of the same thing.

**Q3. Why do real-time applications like video calls use UDP instead of TCP?**
*Model answer:* Because for real-time media, a late packet is as useless as a lost one, and TCP's core guarantee actively works against that. If a packet is lost, TCP stops and retransmits it, holding back all subsequent packets until the lost one is recovered — head-of-line blocking. But in a live video call, by the time a retransmitted frame arrives, the moment it represents is already in the past and can't be displayed; meanwhile the in-order guarantee has stalled the *fresh* frames behind it. So TCP's "deliver everything, in order, even if late" is precisely the wrong behavior. UDP lets the application do the right thing: skip the lost frame and keep playing the current ones, because freshness matters more than completeness. Applications layer minimal custom reliability only on the parts that must arrive. The principle: when stale data is worthless, you cannot let the transport stall the present to recover the past — which rules out TCP.

**Q4. Why does DNS use UDP for normal queries?**
*Model answer:* Because a DNS query is a tiny, single-shot, idempotent exchange — one small request, one small response — and for that shape, TCP's overhead dominates. TCP requires a three-way handshake (a full round trip) before any data flows, plus connection teardown; that setup costs more time than the actual query. UDP sends the query immediately with no setup and gets the answer in a single round trip. If the response is lost, DNS just re-sends the query at the application level — cheap, because the query is idempotent and tiny. So UDP's immediacy and simplicity beat TCP's automatic-but-expensive reliability here. DNS does switch to TCP when a response is too large for a datagram (zone transfers, large DNSSEC responses), but the overwhelmingly common single-lookup case is UDP. The general lesson: for tiny one-shot exchanges, TCP's per-connection setup cost is the dominant term, so a connectionless protocol wins.

**Q5. What's the difference between UDP being "message-oriented" and TCP being a "byte stream," and why does it matter?**
*Model answer:* UDP preserves message boundaries: each `sendto()` produces exactly one datagram, and the receiver's `recvfrom()` returns exactly that one message at its original size. TCP has no concept of messages — it's a continuous stream of bytes, so the boundaries between your `write()` calls are lost: ten writes might be coalesced into one `read()`, or one write split across several reads (Nagle's algorithm and the network decide). This matters because with TCP the application *must implement its own framing* — length prefixes, delimiters, or a self-describing format — to know where one logical message ends and the next begins; forgetting to do this is one of the most common networking bugs (you read "half a message" or "a message and a half"). With UDP, framing comes free because the datagram *is* the message. So UDP is naturally simpler for discrete-message data, while TCP's stream model fits continuous data (files) but pushes message-framing responsibility onto the application.

**Q6. What is the pseudo-header in the UDP/TCP checksum, and why does it complicate NAT?**
*Model answer:* The UDP/TCP checksum is computed not only over the transport header and payload but also over a "pseudo-header" containing fields borrowed from the IP layer — the source and destination IP addresses, the protocol number, and the length. This is a deliberate layering violation: by folding the IP addresses into the L4 checksum, it catches packets that were misdelivered to the wrong host (if the destination IP were corrupted in a way IP's own checksum missed, the transport checksum would also fail, and the packet is dropped at L4). It's defense-in-depth against misdelivery. The complication for NAT: NAT rewrites the IP addresses (and often ports) of packets. Because the transport checksum depends on those addresses through the pseudo-header, NAT must *recompute* the UDP/TCP checksum after rewriting, not just the IP checksum. So a layering shortcut taken for a good reason (misdelivery protection) creates a coupling that every NAT device has to account for — a concrete example of how breaking clean layering has downstream costs.

---

*Previous: [Chapter 5 — Routing the Internet](./05-routing-the-internet.md) | Next: [Chapter 7 — TCP, Part I: Reliability](./07-tcp-part1-reliability.md)*
