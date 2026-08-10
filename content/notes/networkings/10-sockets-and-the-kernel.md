# Chapter 10 — Sockets and the Kernel

> *For nine chapters we've watched bytes travel — across wires, through routers, inside TCP's reliable stream. But how does your **program** actually touch any of it? You don't manipulate IP headers or sequence numbers; you call `read()` and `write()` on something. That something is a **socket**, and the journey from "your code calls `accept()`" to "the kernel hands you a connection" is where every networked application — every web server, database, proxy, and message broker you've ever run — actually lives. This chapter is about that boundary: the socket API, what the kernel does behind it, and the decades-long quest to make one machine handle a million connections at once.*

This is a pivotal chapter. Below it lies everything we've built — the wire, IP, TCP. Above it lies everything to come — HTTP, TLS, gRPC. The socket is the *seam* between them, the interface where the operating system hands the network to your software. And it's where the most consequential performance decisions in server engineering get made. The difference between a server that handles 100 connections and one that handles 1,000,000 is not the network or the CPU — it's *how the program waits for I/O*. Nginx, Redis, Node.js, Envoy, and HAProxy are all, at their core, answers to one question: **how do you efficiently wait for thousands of things to happen at once?** This chapter builds up to that answer — the event loop — and we'll write a real one: an `epoll`-based server that handles thousands of concurrent connections in a single thread, the exact architecture under those systems.

We'll go from the socket lifecycle (`socket`/`bind`/`listen`/`accept`/`connect`) through the C10K problem and the evolution of I/O multiplexing (`select` → `poll` → `epoll`/`kqueue` → `io_uring`), to zero-copy techniques — ending with working code you can run and load-test.

---

## 10.1 The Socket: A File Descriptor for the Network

The genius of the Unix socket API — invented at Berkeley in 1983, and essentially unchanged since — is that it makes the network look like a *file*. You read and write a socket with the same `read()`/`write()` calls you use on a file, because a socket *is* a file descriptor: a small integer that indexes into the kernel's per-process table of open "things." This is the famous Unix "everything is a file" philosophy, and it's why network programming in C feels like file I/O.

```
   A socket is a file descriptor (an int) that the kernel maps to a network endpoint:

   Your process                          Kernel
   ┌──────────────────┐                  ┌─────────────────────────────────────────┐
   │ fd table:        │                  │  socket object (struct sock):            │
   │   0 → stdin      │                  │   • the four-tuple (Ch.6)                 │
   │   1 → stdout     │                  │   • a SEND buffer (data waiting to go out)│
   │   2 → stderr     │                  │   • a RECEIVE buffer (data that arrived)  │
   │   3 → socket  ───┼─────────────────►│   • TCP state machine (Ch.7)             │
   │   4 → socket  ───┼─────────────────►│   • protocol handlers                     │
   └──────────────────┘                  └─────────────────────────────────────────┘
        read(3, ...) ── copies from the kernel's RECEIVE buffer into your memory
        write(3,...) ── copies from your memory into the kernel's SEND buffer
```

The crucial mental model: **a socket has two kernel-side buffers — a send buffer and a receive buffer — and your `read`/`write` calls just move data between your memory and these buffers, not directly to/from the wire.** When you `write()`, you copy data into the kernel's send buffer and return *immediately* — the kernel's TCP machinery (Chapters 7–8) drains that buffer onto the network on its own schedule (governed by the congestion window, the receiver's window, etc.). When data arrives from the network, the kernel's TCP stack places it in the receive buffer, and your `read()` copies it out. This decoupling is fundamental:

- **`write()` returning doesn't mean "sent."** It means "copied into the kernel's send buffer." The bytes may still be in flight, retransmitting, or not yet transmitted. (This is why you can `write()` and then have the connection fail — the data was buffered, not delivered.)
- **`read()` returns whatever is in the receive buffer** — which, per Chapter 7's byte-stream nature, may be a partial message, multiple messages, or one message. (This is *why* you must frame your own messages — §7.7.)
- **The buffers are finite,** and their sizes (the `SO_SNDBUF`/`SO_RCVBUF` and the autotuned `tcp_wmem`/`tcp_rmem` from Chapter 8) cap throughput on high-BDP links — if the send buffer can't hold a full bandwidth-delay product, you can't keep the pipe full (Chapter 1, §7.5). The buffers are where flow control physically happens: a full receive buffer is what makes TCP advertise a zero window.

> **The buffers explain "backpressure," a concept you'll meet everywhere.** When you `write()` faster than the network can drain the send buffer, the buffer fills, and eventually `write()` *blocks* (or returns `EAGAIN` in non-blocking mode, §10.3) — the kernel refuses to accept more until space frees up. That refusal *is* backpressure: the network's slowness propagating back up into your application, forcing it to slow down. Symmetrically, if you `read()` too slowly, your receive buffer fills, TCP advertises a smaller window, and the *sender* is forced to slow down (flow control, Ch. 7). The socket buffers are the physical mechanism by which a slow consumer anywhere in a pipeline eventually throttles a fast producer — the same backpressure idea that governs Kafka consumers, reactive streams, and every well-designed data pipeline. Understanding it *here*, at the socket, is understanding it everywhere.

---

## 10.2 The Socket Lifecycle: server and client

The socket API has a fixed choreography, different for the server (passive — waits for connections) and the client (active — initiates them). These map directly onto the TCP state machine of Chapter 7.

```
   SERVER (passive open)                      CLIENT (active open)
   ─────────────────────                      ────────────────────
   fd = socket(AF_INET, SOCK_STREAM, 0)       fd = socket(AF_INET, SOCK_STREAM, 0)
        │  create an endpoint                      │  create an endpoint
        ▼                                          ▼
   bind(fd, &addr)                            connect(fd, &server_addr)
        │  claim a port (e.g. 8080)                │  ── triggers the 3-way handshake!
        ▼                                          │     (SYN → SYN+ACK → ACK, Ch.7)
   listen(fd, backlog)                             │  blocks until ESTABLISHED
        │  mark it passive; kernel now              ▼
        │  accepts handshakes into a queue      [ connected — read()/write() ]
        ▼
   for (;;) {
     conn = accept(fd, ...)   ◄────────── handshake completes; accept() returns a
        │   pull one completed connection         NEW fd for this specific connection
        │   off the queue (a NEW fd!)
        ▼
     read(conn, ...) / write(conn, ...)
     close(conn)
   }
```

The key subtleties, each a common interview point:

**`socket()`** creates an endpoint — `SOCK_STREAM` for TCP, `SOCK_DGRAM` for UDP (Ch. 6). It's just an unconnected file descriptor at this point.

**`bind()`** assigns a local address and port. Servers bind to a well-known port (8080); clients usually skip `bind()` and let the kernel pick an ephemeral source port automatically (Ch. 6, §6.1). Binding to a port < 1024 needs privilege (Ch. 6).

**`listen(fd, backlog)`** is the pivotal one: it marks the socket *passive* and tells the kernel to start *accepting incoming handshakes on this port into a queue.* The `backlog` parameter sizes that queue. Crucially, **the kernel completes the three-way handshake (Ch. 7) on your behalf, without your program's involvement** — completed connections pile up in the **accept queue** waiting for you to claim them. (There are actually *two* queues: the SYN queue for half-open handshakes in progress, and the accept queue for completed ones ready to hand off. A too-small backlog means completed connections get dropped under load — the SYN/accept queue overflow is a real production tuning issue, `net.core.somaxconn`.)

**`accept()`** pulls one *completed* connection off the accept queue and returns a **brand-new file descriptor** dedicated to that one connection. This is the part people miss: the *listening* socket (port 8080) is not the same as the *connection* socket — `accept()` mints a new fd per connection, each with its own four-tuple and buffers. The listening socket's only job is to be a factory that produces connection sockets. This is how one listening port serves thousands of clients (the four-tuple story from Chapter 6, §6.1, realized in the API): one listener, many accepted connection fds.

**`connect()`** (client side) is where the three-way handshake is *triggered* — calling it sends the SYN and, by default, *blocks until the connection is ESTABLISHED* (or fails with `ECONNREFUSED` on a RST, Ch. 7). So `connect()` returning successfully means the handshake completed.

This API is elegant and has barely changed in 40 years. But it hides a question that turns out to be the central drama of server engineering: when you call `accept()` or `read()` and there's nothing there yet — **what does your program do while it waits?**

---

## 10.3 Blocking, Non-Blocking, and the C10K Problem

By default, sockets are **blocking**: `accept()` with no pending connection *sleeps the calling thread* until one arrives; `read()` with an empty receive buffer *sleeps* until data comes. This is simple and intuitive — your code reads top to bottom, blocking where it must wait. And for a handful of connections, it's perfect.

The problem is *scale*. A blocking socket can only wait for *one* thing at a time per thread. So how do you serve many clients simultaneously? The historical answers, and why they fail at scale:

**Thread-per-connection.** Spawn a thread (or process) per client; each blocks on its own socket. Simple and correct, and it works fine into the low thousands. But it collapses beyond that — this is the famous **C10K problem** (Dan Kegel, ~1999): how do you handle *ten thousand concurrent connections* on one machine? Thread-per-connection can't, because:

```
   Thread-per-connection at 10,000 connections:
   • 10,000 threads × ~1–8 MB stack each = 10–80 GB of RAM just for stacks. Dead.
   • The scheduler thrashes context-switching among 10,000 threads — each switch
     flushes caches, reloads registers; the CPU spends its time switching, not working.
   • Most threads are ASLEEP (blocked on idle connections) at any instant — you've
     paid for 10,000 threads to have maybe 100 doing anything. Massive waste.
```

The core inefficiency: **most connections are idle most of the time.** A web server with 10,000 open connections might have only 50 with data actually ready to process *right now*; the other 9,950 are just... open, waiting. Thread-per-connection allocates a full, expensive thread to *each* idle connection. That's the waste C10K is about. (Modern lightweight threads — Go goroutines, Java virtual threads — *mitigate* this by making threads cheap and multiplexing them onto few OS threads over an event loop underneath; we'll note this, but the *underlying* mechanism is still the event loop we're building toward.)

**Non-blocking sockets + polling.** Set sockets to **non-blocking** (`O_NONBLOCK`): now `read()` returns *immediately* with `EAGAIN`/`EWOULDBLOCK` if there's no data, instead of sleeping. You could loop over all 10,000 sockets, trying each — but that's a *busy-loop* burning 100% CPU spinning over mostly-idle sockets. Non-blocking alone isn't the answer; you need a way to *wait efficiently for any of many sockets to become ready* without spinning and without a thread each. That mechanism is **I/O multiplexing**, and its evolution is the rest of this chapter.

> **The reframe that unlocks everything:** the goal is to have *one* thread efficiently manage *many* connections by waiting on *all of them at once* and being told *which* are ready. Instead of "one thread per connection, each blocking," it's "one thread watching all connections, processing only the ready ones." This inversion — from a thread blocking *per connection* to a single thread reacting to *events* across all connections — is the **event loop**, and it's the architectural heart of every high-performance server. The whole C10K problem is solved by changing *how you wait*.

---

## 10.4 The Evolution of I/O Multiplexing

I/O multiplexing is a kernel facility that lets one thread say "here are 10,000 file descriptors; put me to sleep until *any* of them is ready, then wake me and tell me which." Its history is a march toward doing this efficiently at scale.

### select() and poll(): the O(n) ancestors

The original (1983) is **`select()`**: you pass three bitmaps of fds (interested in read / write / error), the kernel blocks until any becomes ready, then returns with the bitmaps modified to show which fired. **`poll()`** (1986) is similar with a nicer API (an array of `pollfd` structs instead of fixed-size bitmaps). Both work, both are portable, and both have the *same fatal scaling flaw*:

```
   select()/poll() are O(n) in the number of fds, EVERY call:

   1. You pass the ENTIRE list of all N fds to the kernel on every single call.
      (Copy 10,000 fds into the kernel — every time you want to wait.)
   2. The kernel SCANS all N fds to check which are ready.        O(n)
   3. It returns, and YOU scan all N to find which fired.          O(n)

   At 10,000 fds, every wait costs you a 10,000-element copy + two 10,000-element
   scans — even if only ONE fd is actually ready. The cost scales with the number of
   connections you're WATCHING, not the number that are ACTIVE. That's backwards.
```

The killer is that the cost is proportional to the number of connections you're *monitoring*, not the number that are *active*. With 10,000 mostly-idle connections, you pay the full 10,000-element price on every loop iteration to process maybe one ready socket. `select()` also has a hard limit (`FD_SETSIZE`, usually 1024 fds). These O(n)-per-call mechanics are *why* C10K was hard for so long — the multiplexing primitive itself didn't scale.

### epoll (Linux) and kqueue (BSD/macOS): the O(1) breakthrough

The fix, arriving ~2002, was **`epoll`** (Linux) and **`kqueue`** (BSD/macOS) — same idea, different APIs. The breakthrough insight: **stop re-telling the kernel your fd list every call. Register the fds once, and let the kernel maintain the readiness state and hand you only the ready ones.**

```
   epoll: register once, then wait O(number of READY fds), not O(total fds):

   1. epoll_create() — make an epoll instance (itself an fd).
   2. epoll_ctl(ADD/MOD/DEL) — register interest in an fd, ONCE. The kernel keeps
      this in an internal structure (a red-black tree) — you don't re-pass it.
   3. epoll_wait() — block until any registered fd is ready. The kernel returns ONLY
      the fds that are actually ready, in a "ready list" it maintains via callbacks
      from the network stack. You get back exactly the active ones.

   Cost per wait = O(number of fds that are READY), NOT O(total registered).
   10,000 idle connections + 50 active → epoll_wait returns ~50, costing ~50, not
   10,000. THIS is what makes a million connections on one thread possible.
```

The difference is structural: with `select`/`poll`, the kernel discovers readiness by *scanning everything on demand* (O(n) each call). With `epoll`, the kernel is *notified* of readiness as it happens (the network stack calls back into epoll when a socket's buffer gets data) and maintains a ready-list, so `epoll_wait` just hands you the pre-computed ready set in O(ready). You register interest *once* (amortized), and each wait costs only what's actually active. This O(active) instead of O(total) scaling is *the* thing that killed C10K and made the single-threaded event loop viable for hundreds of thousands of connections.

**Level-triggered vs. edge-triggered** — an epoll subtlety you must know:
- **Level-triggered (default):** `epoll_wait` reports an fd as ready *as long as* there's data to read (the "level" is high). If you don't read everything, the next `epoll_wait` reports it again. Forgiving and simpler.
- **Edge-triggered (`EPOLLET`):** reports readiness only on the *transition* (when data *arrives*) — once. If you don't drain *all* available data in response, you won't be told again until *more* arrives, and the unread data sits there silently. Higher performance (fewer wakeups) but you *must* read in a loop until `EAGAIN` to drain the socket fully. Edge-triggered with non-blocking sockets and drain-loops is the high-performance configuration (Nginx uses it); get the drain wrong and you get mysterious stalls (a connection with unread data that never wakes up again). This is a classic high-performance-server bug.

### io_uring: the completion-based frontier

The newest evolution (Linux, ~2019) is **`io_uring`**, and it changes the *model*, not just the efficiency. `epoll` is **readiness-based**: it tells you "the socket is ready, now *you* call `read()`." That still requires a syscall (`read`) per operation, and syscalls have grown expensive (Spectre/Meltdown mitigations added overhead to every kernel crossing). `io_uring` is **completion-based**: you submit operations ("read 4KB from this fd into this buffer") into a shared ring buffer, the kernel performs them asynchronously, and posts *completions* ("that read is done, here's the data") into another shared ring — and you can submit and reap *many* operations with *zero or one* syscall, because the rings are shared memory between you and the kernel.

```
   epoll (readiness):  "tell me when I can read" → you get notified → YOU call read()
                       (1+ syscall per I/O operation)

   io_uring (completion): "do this read for me" → kernel does it → "it's done, here's data"
                       Submission Queue (SQ) and Completion Queue (CQ) are SHARED MEMORY
                       rings → batch hundreds of ops with ONE syscall, or even zero
                       (kernel polls the SQ). The fewest possible kernel crossings.
```

If the descriptor-ring pattern feels familiar, it should — it's exactly the **DMA descriptor ring from Chapter 1** (§1.4.3), now between your process and the kernel instead of between the kernel and the NIC. The same "two parties hand work back and forth via a shared circular buffer with producer/consumer pointers, no locks, no copies" idea, applied one layer up. `io_uring` is how the very highest-performance modern servers (and databases) are heading, because it minimizes the one remaining cost epoll couldn't: the syscall itself.

The arc — `select` (O(n), re-pass everything) → `epoll` (O(active), register once, readiness) → `io_uring` (completion, batched, shared-memory rings) — is one continuous story of *removing overhead from the wait*: first the scanning, then the re-copying, finally the syscalls themselves. Each step let one machine handle an order of magnitude more connections.

---

## 10.5 Zero-Copy: The Other Half of the Battle

Multiplexing solves "how do I wait for many connections." But high-throughput servers face a second cost that's just as important: **copying**. Recall from §10.1 that `read()` copies from the kernel buffer to your memory, and `write()` copies from your memory to the kernel buffer. For a server whose job is to move bytes (a file server, a proxy, a CDN), those copies dominate the CPU cost — and they're often *pointless*.

Consider serving a static file over a socket — the canonical case:

```
   The naive way (read into userspace, then write out) — FOUR copies + context switches:

   disk ──► kernel page cache ──copy──► your buffer ──copy──► kernel socket buffer ──► NIC
            (DMA)              read()                 write()              (DMA)
                              ▲ copy 2               ▲ copy 3
   Plus 2 DMA copies (1 & 4) and 2 user↔kernel context switches. For data your program
   never even looks at — it's just shoveling a file to a socket. The copies are waste.
```

Your program reads the file into its own memory only to immediately write it back out unchanged — two copies through userspace for data you never inspect. **Zero-copy** techniques eliminate the pointless trips through user space:

- **`sendfile(out_fd, in_fd, ...)`** — tells the kernel "copy directly from this file to this socket." The data never enters your process's memory; the kernel moves it from the page cache straight toward the NIC (often with the NIC's DMA reading directly from the page cache via "scatter-gather," so it's truly *zero* CPU copies for the payload). One syscall, no userspace round trip. **This is how Nginx, Kafka, and every static-file/CDN server serve content fast** — Kafka's famous throughput comes substantially from using `sendfile` to send log segments directly from the page cache to consumer sockets without ever copying messages into the JVM heap.
- **`splice()` / `vmsplice()`** — generalize this to move data between *any* two fds (e.g. pipe ↔ socket) via the kernel without userspace copies — the building block for zero-copy proxying (moving bytes from an upstream socket to a downstream socket without touching them).
- **`MSG_ZEROCOPY`** — lets `send()` transmit directly from your userspace buffer without the kernel copying it into the socket buffer first (the kernel pins your pages and DMAs from them), for large sends where the copy is the bottleneck.

> **The deeper principle (callback to Chapter 1):** recall that a 100 Gbps NIC gives the CPU only ~hundreds of nanoseconds per packet (§1.4). At those rates, *copies are the enemy* — memory bandwidth and cache pressure, not the network, become the bottleneck. The entire thrust of high-performance networking is **"touch the data as few times as possible":** zero-copy avoids the copies, TSO/GRO (Ch. 8) avoids per-segment processing, DMA (Ch. 1) avoids CPU involvement in the wire transfer, and `io_uring` avoids the syscalls. They're all the same war on overhead, fought at different layers. When you understand *why* Kafka and Nginx are fast, it's always some combination of these: don't copy, don't switch contexts, don't make syscalls you can batch, and let the hardware move the bytes.

---

## 10.6 Code: An epoll-Based Event-Loop Server

Now we build the thing this whole chapter pointed at: a single-threaded server that handles thousands of concurrent connections using `epoll` — the architecture under Nginx, Redis, and Node.js. It's an echo server (echoes back whatever you send) so the I/O machinery is the focus. **`[Linux — uses epoll]`**

```c
/* epoll_server.c — a single-threaded server handling MANY concurrent connections
 * via an epoll event loop. The architecture under Nginx / Redis / Node.js.
 *
 *   Build:  gcc -Wall -O2 -o epoll_server epoll_server.c
 *   Run:    ./epoll_server 8080
 *   Test:   nc localhost 8080   (type; it echoes). Open MANY ncs — all on one thread.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/epoll.h>

#define MAX_EVENTS 1024

/* Put a socket in non-blocking mode — REQUIRED for an epoll event loop, so that
 * accept()/read() never sleep the single thread that's serving everyone. */
static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 8080;

    /* ---- Set up the listening socket (socket → bind → listen, §10.2) ---- */
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
        perror("bind"); return 1;
    }
    set_nonblocking(listen_fd);
    listen(listen_fd, SOMAXCONN);          /* backlog = system max accept queue */

    /* ---- Create the epoll instance and register the listening socket ---- */
    int epfd = epoll_create1(0);
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listen_fd };
    epoll_ctl(epfd, EPOLL_CTL_ADD, listen_fd, &ev);   /* register ONCE (§10.4) */

    printf("epoll echo server on port %d (single thread, many connections)\n", port);

    struct epoll_event events[MAX_EVENTS];
    for (;;) {
        /* THE EVENT LOOP: block until ANY registered fd is ready; the kernel returns
         * ONLY the ready ones — O(ready), not O(total registered). This is the core. */
        int n = epoll_wait(epfd, events, MAX_EVENTS, -1);

        for (int i = 0; i < n; i++) {
            int fd = events[i].data.fd;

            if (fd == listen_fd) {
                /* The listening socket is readable → one or more new connections are
                 * waiting. accept() them all (loop until EAGAIN, since we're nonblocking). */
                for (;;) {
                    int conn = accept(listen_fd, NULL, NULL);
                    if (conn < 0) {
                        if (errno == EAGAIN || errno == EWOULDBLOCK) break; /* drained */
                        perror("accept"); break;
                    }
                    set_nonblocking(conn);
                    /* Register the NEW connection fd for read-readiness (§10.2: accept
                     * mints a new fd per connection). Now the loop watches it too. */
                    struct epoll_event cev = { .events = EPOLLIN, .data.fd = conn };
                    epoll_ctl(epfd, EPOLL_CTL_ADD, conn, &cev);
                }
            } else {
                /* An established connection has data ready. Read and echo it. */
                char buf[4096];
                ssize_t r = read(fd, buf, sizeof buf);
                if (r > 0) {
                    write(fd, buf, r);             /* echo it back (simplified; see note) */
                } else if (r == 0 || (r < 0 && errno != EAGAIN)) {
                    /* r==0: peer closed (got FIN, Ch.7). r<0 (not EAGAIN): error.
                     * Either way, remove from epoll and close. */
                    epoll_ctl(epfd, EPOLL_CTL_DEL, fd, NULL);
                    close(fd);
                }
            }
        }
    }
    close(listen_fd);
    return 0;
}
```

Run `./epoll_server 8080`, then open *many* terminals with `nc localhost 8080` and type in each — **one thread, one event loop, serves them all simultaneously.** You could open ten thousand connections and this single thread would handle them, spending CPU only on the ones with data, sleeping in `epoll_wait` otherwise. That's the C10K solution, in ~70 lines.

Trace the architecture against the chapter:
- The **listening socket** is registered in epoll; when it's "readable," that means *new connections are waiting* (§10.2) — we `accept()` them all in a loop (non-blocking, drain until `EAGAIN`).
- Each accepted connection gets its **own fd, registered in the same epoll instance** — now the one loop watches the listener *and* every connection together.
- `epoll_wait` returns **only the ready fds** (§10.4) — the loop never wastes time on idle connections, which is the whole point.
- Everything is **non-blocking** so no single operation can stall the one thread that serves everyone.

> **What this skeleton omits, and why it matters:** a production event-loop server adds (1) **per-connection state and write buffering** — `write()` can return `EAGAIN` (the send buffer is full — backpressure, §10.1!), so you must buffer unsent data and register for `EPOLLOUT` (write-readiness) to finish sending later, rather than the naive `write()` here; (2) **message framing** (Ch. 7 — read in a loop, accumulate until you have a complete message, since `read()` gives arbitrary byte chunks); (3) often **multiple event loops across cores** (one epoll per CPU, with `SO_REUSEPORT` letting several threads each accept on the same port — how Nginx uses all cores). But the *core architecture* — register fds, wait for events, react only to the ready ones, never block — is exactly what's above, and exactly what Nginx, Redis, HAProxy, and Node.js do. You've written the heart of a modern server. In Chapter 11 we'll graft an HTTP parser onto this exact loop and turn it into a real web server.

**A note on `kqueue` and portability:** `epoll` is Linux-only. macOS and the BSDs use **`kqueue`**, which is conceptually identical (register events once, wait, get back only the ready ones) with a different API (`kevent`). Cross-platform event-loop libraries — **libuv** (which powers Node.js), **libevent**, **libev** — exist precisely to paper over `epoll` vs `kqueue` vs `io_uring` vs Windows IOCP, presenting one event-loop API across all of them. When you use Node.js or any async runtime, libuv is running an epoll/kqueue loop exactly like ours underneath.

---

## Key Takeaways

1. **A socket is a file descriptor backed by two kernel buffers (send and receive).** Your `read`/`write` move data between your memory and these buffers — *not* the wire. `write()` returning means "copied into the kernel's send buffer," not "delivered." The buffers are where flow control and **backpressure** physically happen: a full send buffer blocking `write()` is the network's slowness propagating back into your app.

2. **The socket lifecycle maps to TCP's state machine:** `socket → bind → listen → accept` (server) and `socket → connect` (client, which triggers the handshake). The pivotal facts: `listen()` makes the kernel complete handshakes *for you* into an accept queue (sized by `backlog`/`somaxconn`), and `accept()` mints a *new fd per connection* — one listening socket is a factory producing many connection sockets (the four-tuple realized).

3. **Blocking sockets wait for one thing per thread, so thread-per-connection collapses at scale — the C10K problem.** 10,000 threads = tens of GB of stacks plus scheduler thrash, mostly to babysit *idle* connections. The insight: most connections are idle most of the time, so allocating a thread per connection is enormous waste.

4. **The solution is I/O multiplexing — one thread waiting on all connections, reacting only to ready ones (the event loop).** Its evolution removed overhead from "the wait": `select`/`poll` (O(n) — re-pass and re-scan every fd every call, the reason C10K was hard) → **`epoll`/`kqueue`** (register once, kernel maintains a ready-list via callbacks, cost is O(*active*) not O(total) — the breakthrough that made a million connections per thread viable) → **`io_uring`** (completion-based, shared-memory submission/completion rings — the Chapter 1 DMA-ring pattern again — batching away the syscalls themselves).

5. **Edge-triggered epoll (`EPOLLET`) reports readiness once per transition — you must drain to `EAGAIN` or you'll silently stall** a connection with unread data. Level-triggered (default) re-reports while data remains. Edge-triggered + non-blocking + drain-loop is the high-performance config (Nginx); getting the drain wrong is a classic bug.

6. **Zero-copy eliminates pointless trips through userspace:** `sendfile` moves a file straight from the page cache to a socket without entering your process's memory (how Nginx serves files and Kafka serves log segments fast), `splice` does it between any fds (zero-copy proxying), `MSG_ZEROCOPY` sends from userspace without a kernel copy. It's part of the broader war on overhead — "touch the data as few times as possible" — alongside DMA, TSO/GRO, and io_uring's syscall batching.

7. **You can build the heart of a modern server in ~70 lines:** an epoll loop that registers the listener, accepts connections into the same loop, watches all fds together, and reacts only to ready ones — never blocking. This *is* the architecture of Nginx, Redis, HAProxy, and (via libuv) Node.js. Production versions add write-buffering for `EPOLLOUT` backpressure, message framing, and multiple loops across cores via `SO_REUSEPORT`.

---

## Interview Drills

**Q1. What actually happens, kernel-side, when you call `write()` on a socket? Does it mean the data was sent?**
*Model answer:* No — `write()` copies your data into the kernel's *send buffer* for that socket and returns; it does not mean the bytes reached the network or the peer. The kernel's TCP machinery drains that send buffer onto the wire on its own schedule, governed by the congestion window and the receiver's advertised window (Chapters 7–8) — the data may still be queued, in flight, or retransmitting after `write()` returns. This is why a `write()` can succeed and the connection still fail afterward: you buffered data that was never delivered. Two important consequences: the send buffer is finite, so if you write faster than the network drains it, `write()` eventually blocks (or returns `EAGAIN` if non-blocking) — that's backpressure, the network's slowness propagating back into your app. And the receive side mirrors this: a slow `read()` lets the receive buffer fill, causing TCP to advertise a smaller window and throttle the sender (flow control). The socket buffers are the physical mechanism of backpressure throughout any pipeline.

**Q2. What is the C10K problem and why does thread-per-connection fail at it?**
*Model answer:* C10K is the challenge of handling ten thousand (and beyond) concurrent connections on a single machine. Thread-per-connection — spawn a thread that blocks on each client's socket — is simple and works into the low thousands, but collapses at 10K for three reasons: memory (10,000 threads × ~1–8 MB of stack each is tens of GB, just for stacks), scheduler overhead (context-switching among 10,000 threads thrashes the CPU caches and registers, so the machine spends its time switching rather than working), and fundamental waste (most connections are *idle* at any instant — you might have 10,000 open but only 50 with data ready, yet you've allocated a full expensive thread to each of the 9,950 idle ones). The root insight is that connection count and activity are decoupled: thread-per-connection pays per *connection*, but the work is per *active* connection. The fix is I/O multiplexing — one thread that waits on all connections at once and processes only the ready ones (an event loop), so cost scales with activity, not connection count. (Modern cheap threads like goroutines mitigate the memory/switching costs but still run an event loop underneath.)

**Q3. Why is `epoll` more scalable than `select`/`poll`?**
*Model answer:* Because epoll's cost scales with the number of *active* fds, while select/poll scale with the number of *monitored* fds. With select/poll, on every single wait you copy your entire list of N fds into the kernel, the kernel scans all N to check readiness, and then you scan all N to find which fired — all O(n), even if only one fd is ready. So with 10,000 mostly-idle connections you pay the full 10,000-element cost on every loop iteration. epoll inverts this: you register each fd *once* via `epoll_ctl` (the kernel keeps them in an internal structure), and the network stack *notifies* epoll as fds become ready, maintaining a ready-list. So `epoll_wait` just hands you the pre-computed set of *ready* fds — O(number ready), not O(total registered). With 10,000 idle and 50 active connections, `epoll_wait` returns ~50 and costs ~50. That O(active) scaling, plus not re-copying the fd list each call, is what made the single-threaded event loop viable for hundreds of thousands of connections and effectively solved C10K. kqueue on BSD/macOS is the same idea with a different API.

**Q4. What's the difference between level-triggered and edge-triggered epoll, and what's the danger of edge-triggered?**
*Model answer:* Level-triggered (the default) reports an fd as ready *whenever* the condition holds — as long as there's unread data in the receive buffer, each `epoll_wait` will keep reporting it ready, even if you only read part of it. Edge-triggered (`EPOLLET`) reports readiness only on the *transition* — the moment new data arrives — and only once; it won't report that fd again until *more* new data arrives. Edge-triggered is higher performance (fewer redundant wakeups) but carries a sharp danger: if you don't drain *all* available data when notified — reading in a loop until you get `EAGAIN` — the leftover data sits in the buffer silently, and since no new "edge" occurs, `epoll_wait` never tells you about it again. The connection appears hung with unread data stuck in it. So edge-triggered *requires* non-blocking sockets plus a drain-to-`EAGAIN` loop on every readiness event. It's the high-performance configuration (Nginx uses it), but the "forgot to fully drain" stall is a classic, hard-to-spot bug. Level-triggered is more forgiving and fine for most code.

**Q5. How does `sendfile` make a static-file or proxy server faster, and what's the general principle?**
*Model answer:* Serving a file the naive way copies it twice through userspace: the kernel reads the file from the page cache into your process's buffer (`read`), then you write that buffer back into the kernel's socket buffer (`write`) — two copies and two user↔kernel context switches, for data your program never even inspects (it's just shoveling bytes from file to socket). `sendfile` tells the kernel to move the data *directly* from the page cache toward the socket/NIC without it ever entering your process's memory — ideally zero CPU copies of the payload (the NIC can DMA straight from the page cache via scatter-gather). One syscall, no userspace round trip. This is how Nginx serves static files and how Kafka achieves its throughput — Kafka uses `sendfile` to send log segments straight from the page cache to consumer sockets without copying messages into the JVM heap. The general principle is "touch the data as few times as possible": at modern line rates (a 100 Gbps NIC gives the CPU only hundreds of nanoseconds per packet), memory copies and cache pressure become the bottleneck, not the network. Zero-copy (sendfile/splice/MSG_ZEROCOPY), DMA, TSO/GRO offloads, and io_uring's syscall batching are all the same war on per-byte and per-operation overhead, fought at different layers.

**Q6. Describe the architecture of a high-performance server like Nginx or Redis at the socket level.**
*Model answer:* A single-threaded (per core) event loop built on epoll/kqueue. It creates a listening socket (`socket`/`bind`/`listen`), sets everything non-blocking, and registers the listener with epoll. Then it loops on `epoll_wait`, which blocks until any registered fd is ready and returns only the ready ones. When the *listening* socket is ready, that means new connections are waiting, so it `accept`s them (in a loop until `EAGAIN`) and registers each new connection fd into the same epoll instance. When a *connection* fd is ready for read, it reads and processes the data (parsing HTTP for Nginx, commands for Redis); when ready for write and there's buffered output, it writes. Nothing ever blocks, so one thread juggles thousands of connections, spending CPU only on the active ones. Production refinements: it buffers unsent data and watches `EPOLLOUT` to handle `write()` returning `EAGAIN` (send-buffer-full backpressure); it frames messages itself since TCP is a byte stream; and it runs one event loop per CPU core, using `SO_REUSEPORT` so multiple threads can each accept on the same port, scaling across all cores. Redis is famously mostly single-threaded for command execution on exactly this loop; Nginx runs one such worker per core; Node.js runs this loop via libuv. The unifying idea is "don't block, react to events, and only touch active connections."

**Q7. What does the `backlog` argument to `listen()` control, and why does it matter under load?**
*Model answer:* It sizes the queue of *completed* connections waiting to be `accept()`ed. The subtlety is that the kernel completes the TCP three-way handshake on your behalf, without your application's involvement — there are actually two queues: a SYN queue for handshakes in progress (half-open) and an accept queue for fully-established connections ready to hand to `accept()`. The `backlog` (capped by `net.core.somaxconn`) bounds the accept queue. It matters under load: if connections arrive faster than your application calls `accept()` — e.g. the app is briefly busy, or there's a burst — the accept queue fills, and further completed connections get dropped or the handshake refused, manifesting as connection timeouts or resets for clients even though your server is "up." This is a real production tuning issue; a too-small backlog under bursty load causes mysterious connection failures. The fix is raising the backlog and `somaxconn`, and ensuring the app accepts promptly (which an event loop does naturally). It's also why SYN-flood defenses (SYN cookies, Ch. 7) matter — they protect the SYN queue from malicious half-open floods.

---

*Previous: [Chapter 9 — DNS](./09-dns.md) | Next: [Chapter 11 — HTTP/1.0 and HTTP/1.1](./11-http-1.0-and-1.1.md)*
