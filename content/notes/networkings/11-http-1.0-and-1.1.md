# Chapter 11 — HTTP/1.0 and HTTP/1.1

> *HTTP is the most successful application protocol ever written. It started in 1991 as a one-line method for fetching hypertext documents at CERN and became the universal substrate for essentially all of computing — web pages, APIs, mobile apps, microservices, IoT devices, and the very book you're reading if you got it over the web. It did this not by being clever but by being **simple** — simple enough to parse by eye, implement in an afternoon, and extend forever. This chapter is about that simplicity, the performance walls it eventually hit, and building a working HTTP/1.1 server from scratch on the event loop we wrote in Chapter 10.*

We've finally arrived at the layer most engineers actually work in. Everything beneath — the wire, IP, routing, TCP's reliable stream, the socket — exists so that HTTP can do its job: **a client asks for a resource, a server responds.** That request/response model is so ingrained it's hard to see as a *choice*, but it is one, and understanding HTTP at the byte level (not just as an abstraction your framework hides) is what lets you reason about caching, keep-alive, why your API is slow, and why HTTP/2 and HTTP/3 had to be invented.

HTTP/1.1 is the right place to learn HTTP deeply because it's still text-based — you can read it, type it by hand into a socket, and watch it work — yet it's rich enough to run the modern web. We'll cover the request/response grammar, methods and status codes as designed vocabularies, the headers that do the real work, the performance arc from HTTP/1.0's connection-per-request to HTTP/1.1's keep-alive and chunked encoding, caching (the most underused performance lever in web engineering), and the head-of-line-blocking wall that motivates everything in the chapters after this. Then we build a server.

---

## 11.1 The Request/Response Model and Its Grammar

HTTP is a **request/response** protocol: the client sends a request, the server sends exactly one response, and (in the classic model) that's the entire interaction. It's **stateless** by design — each request is independent, carrying everything the server needs to handle it; the server keeps no memory of prior requests between them. (Statelessness is a deliberate, load-bearing choice — §11.6 — it's what lets any server handle any request, enabling the load balancing of Chapter 17.)

The thing that made HTTP win is that its messages are **human-readable text** with a dead-simple structure. Here is a complete HTTP/1.1 request and response, byte for byte:

```
   REQUEST:                                    RESPONSE:
   ┌─────────────────────────────────────┐    ┌─────────────────────────────────────┐
   │ GET /index.html HTTP/1.1\r\n         │    │ HTTP/1.1 200 OK\r\n                  │ ← status line
   │ Host: example.com\r\n                │    │ Content-Type: text/html\r\n         │ ← headers
   │ User-Agent: curl/8.0\r\n             │    │ Content-Length: 1256\r\n            │
   │ Accept: text/html\r\n               │    │ Cache-Control: max-age=3600\r\n     │
   │ \r\n                                 │    │ \r\n                                │ ← blank line
   └─────────────────────────────────────┘    │ <!DOCTYPE html>...                   │ ← body
        ▲                                      └─────────────────────────────────────┘
   request line + headers + blank line + (optional body)
```

The structure is identical for both directions and trivially parseable:

1. **A start line.** For requests, the **request line**: `METHOD PATH VERSION` (`GET /index.html HTTP/1.1`). For responses, the **status line**: `VERSION STATUS_CODE REASON` (`HTTP/1.1 200 OK`).
2. **Headers**, one per line, `Name: Value`, each terminated by `\r\n` (carriage-return + line-feed).
3. **A blank line** (`\r\n` alone) — the critical delimiter that marks *the end of the headers*.
4. **An optional body** — the request payload (POST data) or response content (the HTML, JSON, image, etc.).

That `\r\n\r\n` (blank line) is the single most important byte sequence in HTTP/1.1: it's how the parser knows the headers are done and the body (if any) begins. This is HTTP's **framing** solution to the problem we flagged in Chapter 7 — *TCP gives no message boundaries, so every protocol on top must define its own.* HTTP/1.1 frames with delimiters (`\r\n` between lines, `\r\n\r\n` ending headers) for the head, and then uses `Content-Length` or chunked encoding (§11.4) to frame the body. The whole protocol is just "lines of text until a blank line, then a body of a known length." That you can *read* it is why HTTP could be debugged with `telnet` and learned by a generation of engineers typing requests by hand — a simplicity that was decisive in its adoption.

> **Try it yourself — HTTP is just text on a socket.** You can speak HTTP/1.1 by hand:
> ```
> $ printf 'GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n' | nc example.com 80
> ```
> and you'll get back the raw response — status line, headers, blank line, HTML. There is no magic; HTTP is *exactly* those bytes. Every web framework, every browser, every `curl` is ultimately producing and parsing this text. Internalizing "HTTP is human-readable text framed by `\r\n`" demystifies the entire web.

---

## 11.2 Methods: A Vocabulary of Intent

The **method** (or "verb") states what the client wants to *do* with the resource. The methods aren't arbitrary — they form a designed vocabulary with formal *properties* that the entire web's caching, retrying, and REST architecture depend on:

```
   Method   Intent                  Safe?  Idempotent?  Cacheable?  Has body?
   ──────   ──────────────────      ─────  ───────────  ──────────  ────────
   GET      retrieve a resource     yes    yes          yes         no
   HEAD     GET but headers only    yes    yes          yes         no
   POST     create / submit data    no     NO           rarely      yes
   PUT      replace a resource      no     yes          no          yes
   PATCH    partially modify        no     NO           no          yes
   DELETE   remove a resource       no     yes          no          no
   OPTIONS  ask what's allowed      yes    yes          no          no
```

Two properties matter enormously, and confusing them is a classic interview trap:

- **Safe** = "read-only; doesn't change server state." `GET`, `HEAD`, `OPTIONS` are safe. This is *why* a browser can prefetch links, a crawler can follow them, and a proxy can cache them freely — a safe method has no side effects to worry about. (It's also why your `GET` endpoint must *never* mutate state — a crawler hitting `GET /delete?id=5` and wiping your database is a real, classic disaster.)

- **Idempotent** = "doing it N times has the same effect as doing it once." `GET`, `PUT`, `DELETE` are idempotent (deleting something twice leaves it deleted; setting a value twice leaves that value). **`POST` is NOT idempotent** — two `POST /orders` create *two* orders. This property is the foundation of *safe retries*: a client or proxy can safely retry an idempotent request after a timeout (maybe it succeeded, maybe not — retrying is harmless), but retrying a `POST` risks duplicating the side effect (two charges, two orders). This is precisely why the "double-submit" problem exists (user double-clicks "Pay," two POSTs, two charges) and why patterns like **idempotency keys** were invented — to make `POST`s safe to retry by giving each logical operation a unique key the server deduplicates on. Every payment API, every message queue, every retry policy lives or dies by this distinction.

`PUT` vs `POST` is the other perennial: `PUT` *replaces* a resource at a known URI idempotently ("make the resource at `/users/5` be exactly this"); `POST` *creates* a subordinate resource or triggers processing non-idempotently ("create a new user under `/users`"). Use `PUT` when the client decides the URI and the operation is "set to this value"; `POST` when the server assigns the URI or the operation isn't safely repeatable.

> **Why this is more than trivia:** the method properties are the *contract* that makes the web's infrastructure work. Caches cache safe methods; CDNs and proxies retry idempotent ones; REST API design *is* the discipline of mapping operations onto methods whose properties match the operation's real semantics. When someone designs an API where `GET` mutates state, or expects a load balancer to retry `POST`s safely, they've violated the contract, and something will eventually break — a prefetch corrupts data, a retry double-charges a customer. Knowing safe/idempotent cold is knowing why the web's plumbing is allowed to be as aggressive (and fast) as it is.

---

## 11.3 Status Codes and Headers: The Rest of the Vocabulary

**Status codes** are the server's three-digit verdict, grouped by leading digit into five designed classes — and knowing the *classes* matters more than memorizing every code:

```
   1xx  Informational   request received, continuing      (100 Continue, 101 Switching Protocols)
   2xx  Success         it worked                          (200 OK, 201 Created, 204 No Content)
   3xx  Redirection     go look elsewhere                  (301 Moved Permanently, 304 Not Modified,
                                                            302/307/308 redirects)
   4xx  Client error    YOU messed up                      (400 Bad Request, 401 Unauthorized,
                                                            403 Forbidden, 404 Not Found, 429 Too Many)
   5xx  Server error    I messed up                        (500 Internal Error, 502 Bad Gateway,
                                                            503 Unavailable, 504 Gateway Timeout)
```

The 4xx/5xx split is *the* operational distinction: **4xx means the client sent something wrong (don't retry the same request — it'll fail again); 5xx means the server failed (retrying might succeed).** This drives retry logic everywhere — clients retry 5xx (with backoff), not 4xx. A few worth knowing specifically: **304 Not Modified** is the heart of caching (§11.5 — "your cached copy is still good, I sent no body"); **301 vs 302** is permanent vs temporary redirect (301 is cached forever and SEO-transferring, 302 isn't); **429 Too Many Requests** is rate limiting; **502/503/504** are the proxy/load-balancer errors you'll stare at in production (502 = upstream gave a bad response, 503 = no healthy upstream, 504 = upstream timed out — Chapter 17 territory, and being able to distinguish them is half of debugging a gateway).

**Headers** are where HTTP's real richness lives — the start line and status code are simple; the headers carry the metadata that makes HTTP extensible. The categories worth knowing:

- **Host** (request, *mandatory* in HTTP/1.1) — which website you want, *by name*. This header is why **virtual hosting** works: one server at one IP can host thousands of sites (`example.com`, `other.com`) and uses the `Host` header to know which one you're asking for. It was *the* addition that made HTTP/1.1 necessary (HTTP/1.0 lacked it, so one IP = one site — untenable as the web grew). It's also the header an L7 load balancer routes on (Ch. 17) and, in encrypted form, the SNI problem of TLS (Ch. 12).
- **Content-Type** — what the body *is* (`text/html`, `application/json`, `image/png`), via MIME types. How the receiver knows whether to render HTML or parse JSON.
- **Content-Length** — the body's size in bytes; the body-framing mechanism (§11.4).
- **Connection** — `keep-alive` or `close`; controls connection reuse (§11.4).
- **Cache-Control, ETag, Last-Modified, Expires** — the caching machinery (§11.5).
- **Cookie / Set-Cookie** — the state mechanism bolted onto stateless HTTP (§11.6).
- **Authorization** — credentials (Bearer tokens, Basic auth).
- **Accept / Accept-Encoding / Accept-Language** — content negotiation ("I can take JSON or XML; I can decompress gzip; I prefer English") — the client tells the server its preferences and the server picks.
- **Transfer-Encoding: chunked** — streaming a body of unknown length (§11.4).

Headers are HTTP's extensibility mechanism: the core protocol is fixed, but you can add headers forever (custom `X-` headers, new standard ones) without changing the grammar. This is why HTTP could absorb cookies, caching, compression, CORS, auth schemes, and tracing — all as headers, no protocol revision needed. The header is to HTTP what the option is to TCP: the designed-in room to grow.

---

## 11.4 The Performance Arc: Keep-Alive, Pipelining, and Chunked Encoding

Here's where HTTP/1.0 → 1.1 becomes a *performance* story, and where the seeds of HTTP/2 get planted.

**HTTP/1.0's fatal flaw: a connection per request.** In HTTP/1.0, each request/response used a *fresh TCP connection*, closed immediately after. Recall what a TCP connection costs (Chapters 7–8): a three-way handshake (1 RTT before any data) *plus* starting from slow start (a small congestion window that takes several RTTs to ramp). For a single small page that was tolerable, but a modern web page pulls *dozens to hundreds* of resources (HTML, CSS, JS, images, fonts). At connection-per-request, each one paid a fresh handshake and a fresh slow-start ramp:

```
   HTTP/1.0 fetching a page with 1 HTML + 10 images = 11 connections:

   [handshake][slow-start][GET html][close]
              [handshake][slow-start][GET img1][close]
                         [handshake][slow-start][GET img2][close]
                                    ... 11 times ...

   Each connection: 1 RTT handshake wasted + slow-start ramp from scratch +
   TIME_WAIT pileup (Ch.7). For a 100ms-RTT link, the handshakes ALONE add a second+.
```

This was catastrophic for performance and the reason HTTP/1.0 felt slow.

**HTTP/1.1's fix #1: persistent connections (keep-alive).** HTTP/1.1 made connections **persistent by default** — after a response, the connection *stays open* and is *reused* for the next request. One handshake, one slow-start ramp, then many requests over the warm connection. The `Connection: close` header opts out; `Connection: keep-alive` (the default) keeps it open. This was a massive win — it amortizes the handshake and lets the connection stay past slow start (recall Chapter 8: a warm connection with a grown congestion window is far faster than a cold one). **Connection reuse is one of the most important performance levers in HTTP**, and it's why connection *pooling* (keeping a set of warm connections to a backend) is standard in every HTTP client library, database driver, and service mesh. The cost it removes — repeated handshakes and slow-starts — is exactly the round-trip-and-ramp tax from Chapters 7–8.

**HTTP/1.1's fix #2 (that failed): pipelining.** HTTP/1.1 also allowed **pipelining** — sending multiple requests back-to-back on one connection without waiting for each response, letting them be processed in a batch. In theory, great. In practice, it *failed* and was abandoned, for one reason that is the entire motivation for HTTP/2: **head-of-line (HOL) blocking.** HTTP/1.1 requires responses to come back *in the same order* as the requests (the protocol has no way to match an out-of-order response to its request). So if you pipeline requests A, B, C, and A is slow to generate (a complex query), B and C must *wait* behind it even if they're ready — the slow A blocks the head of the line. One slow response stalls everything queued behind it. Combined with buggy proxy support, pipelining was a failure; browsers disabled it. **This HOL-blocking limitation — responses must be ordered, so one slow response blocks the rest — is the wall HTTP/1.1 cannot climb, and the precise problem HTTP/2's multiplexing was built to solve (Chapter 13).** Hold this; it's the bridge to the next two chapters.

Because pipelining failed, browsers worked around HTTP/1.1's one-request-at-a-time limit by opening **multiple parallel connections** (typically 6 per origin) to fetch resources concurrently. This helped but is wasteful (6× the handshakes, 6× the connection state, 6 independent slow-starts, and contention between them) — a hack that HTTP/2 would replace with proper multiplexing over a single connection.

**Chunked transfer encoding: framing a body of unknown length.** One more mechanism, important for both streaming and the server we'll build. `Content-Length` frames a body when you *know* its size upfront. But what if you don't — you're streaming a response generated on the fly (a large report, a live feed, server-sent events)? You can't set `Content-Length` for data that doesn't exist yet. **`Transfer-Encoding: chunked`** solves this: send the body as a series of *chunks*, each prefixed with its size in hex, terminated by a zero-size chunk:

```
   HTTP/1.1 200 OK\r\n
   Transfer-Encoding: chunked\r\n
   \r\n
   1a\r\n                          ← next chunk is 0x1a = 26 bytes
   <26 bytes of data>\r\n
   10\r\n                          ← next chunk is 0x10 = 16 bytes
   <16 bytes of data>\r\n
   0\r\n                           ← zero-length chunk = "end of body"
   \r\n
```

Each chunk says how big it is, so the receiver knows where it ends, and the zero chunk signals completion — framing without knowing the total size in advance. This is how HTTP streams responses, and it's the HTTP/1.1 ancestor of the streaming that HTTP/2 frames and gRPC streams do natively. (Note: it's framing on a byte stream again — the recurring Chapter 7 theme. Chunked encoding *is* an application-level framing layer over TCP.)

---

## 11.5 Caching: The Most Underused Performance Lever

If there's one section of this chapter that will make your systems faster, it's this one. **HTTP caching** lets responses be reused without re-fetching — and the fastest request is the one you never make. HTTP has a rich, often-ignored caching model built entirely from headers, working at every level (browser cache, CDN, reverse proxy, Chapter 17).

There are two complementary caching strategies, and using both is the art:

**1. Freshness (avoid the request entirely).** The server tells the client how long a response may be reused *without asking again*, via **`Cache-Control: max-age=N`** (reusable for N seconds). While fresh, the client serves from cache with *zero network round trips* — the ideal. `Cache-Control` has a vocabulary worth knowing: `max-age` (lifetime), `no-cache` (cache it but *revalidate* before each use — confusingly *not* "don't cache"), `no-store` (genuinely don't cache — for sensitive data), `private` (only the browser may cache, not shared CDNs/proxies — for user-specific data), `public` (any cache may store it), `immutable` (never revalidate — for content-hashed assets like `app.7f3a9.js` that never change). Setting these well is the difference between a CDN serving 99% of your traffic and your origin getting hammered.

**2. Validation (cheap revalidation when freshness expires).** When a cached response goes stale, instead of re-downloading the whole thing, the client asks "is my copy still good?" using **validators**:

```
   Conditional request flow (validation):

   First response carries a validator:
       HTTP/1.1 200 OK
       ETag: "a1b2c3"                 ← a fingerprint of this version (a hash/version id)
       Last-Modified: Mon, ...         ← or a timestamp
       <the full 1 MB body>

   Later, cache is stale; client revalidates with a CONDITIONAL request:
       GET /resource HTTP/1.1
       If-None-Match: "a1b2c3"         ← "only send it if it's CHANGED from this ETag"

   If unchanged, server replies with NO body:
       HTTP/1.1 304 Not Modified       ← "your copy is still good" — TINY response,
       (no body!)                         saves re-transferring the whole 1 MB
```

The **304 Not Modified** response (recall §11.3) is the payoff: the server confirms the cached copy is still valid *without resending the body* — turning a 1 MB transfer into a few bytes. **ETag** (an opaque version fingerprint, usually a content hash) and **Last-Modified** (a timestamp) are the two validator types; `If-None-Match` (with the ETag) and `If-Modified-Since` (with the timestamp) are the conditional headers that carry them. Validation doesn't avoid the round trip, but it avoids re-transferring unchanged data.

The combined strategy in practice: set a `max-age` so most reuse is *free* (no request at all), and provide an `ETag` so that when freshness expires, revalidation is *cheap* (a 304, not a full transfer). Content-hashed immutable assets (`app.7f3a9.js`) get `max-age=31536000, immutable` — cached forever, never revalidated, because the hash in the filename changes when the content does. This pattern — long cache + content-hashed filenames — is how modern web build pipelines make repeat visits nearly instant.

> **Why "underused":** most engineers set caching headers haphazardly or not at all, leaving enormous performance on the table — every uncached response is a full round trip and a full transfer that a few header bytes could have eliminated. A well-tuned cache policy can offload 90%+ of traffic from your origin to CDNs and browser caches, slash latency (a cache hit is faster than *any* origin response — it's local or edge-local, beating even the speed of light per Chapter 1), and cut bandwidth costs. The headers are simple; the leverage is enormous; the neglect is widespread. This is the cheapest big win in web performance.

---

## 11.6 State on a Stateless Protocol: Cookies and Sessions

HTTP is **stateless** — each request is independent, the server remembers nothing between them. This is a *feature*: statelessness is what lets *any* server handle *any* request (no server holds session state the others lack), which is exactly what makes horizontal scaling and load balancing (Chapter 17) possible — you can add servers and spray requests across them freely because no request depends on having hit a particular server before. Statelessness is the property that lets the web scale.

But applications *need* state — a logged-in user, a shopping cart, a session. The mechanism bolted on to provide it without breaking statelessness is the **cookie**: the server sends `Set-Cookie: session=abc123` in a response, the browser stores it, and *replays* it as `Cookie: session=abc123` on every subsequent request to that domain. Now the server can recognize the user — not because it remembers them (it's still stateless), but because the client *carries the identifier back every time*. The state lives at the client (or in a shared store the cookie keys into), not in the server's per-connection memory. This preserves statelessness at the HTTP layer (any server can read the cookie) while enabling stateful *applications*.

This bolt-on has consequences worth knowing: cookies are sent on *every* request to the domain (overhead — part of why HTTP/2's header compression matters, Ch. 13); they're a security surface (`HttpOnly` to block JS access, `Secure` to require HTTPS, `SameSite` to mitigate CSRF); and the choice between *session cookies* (an opaque ID keying into server-side session storage) vs. *self-contained tokens* (a JWT carrying the state, signed — so any server can validate it without shared storage, the same "encode state in the token you get back" idea as TCP SYN cookies in Chapter 7) is a core architecture decision. The through-line: **HTTP stays stateless so it can scale; cookies move the necessary state to the client so applications can still be stateful.** Have that tension crisp — it explains a huge amount of web architecture.

---

## 11.7 Code: An HTTP/1.1 Server from Scratch

Let's build a real HTTP/1.1 server by grafting an HTTP parser onto the epoll event loop from Chapter 10. This is the moment everything converges: the socket machinery (Ch. 10), TCP's byte stream and framing problem (Ch. 7), and HTTP's grammar (this chapter). To keep the focus on HTTP (not re-printing all the epoll plumbing), here's a self-contained *threaded* version that's portable and runnable on Linux *and* macOS — the HTTP logic is identical to what you'd put in the event loop; only the concurrency strategy differs.

**`http_server.c`**

```c
/* http_server.c — a minimal but real HTTP/1.1 server: parses requests, serves
 * responses with keep-alive and chunked encoding. Portable POSIX (Linux + macOS).
 *
 *   Build:  gcc -Wall -O2 -o http_server http_server.c -lpthread
 *   Run:    ./http_server 8080
 *   Test:   curl -v http://localhost:8080/         (200, HTML)
 *           curl -v http://localhost:8080/stream   (chunked streaming)
 *           curl -v http://localhost:8080/nope      (404)
 *
 * Thread-per-connection here for clarity; the HTTP parsing/response logic is exactly
 * what you'd drop into the Chapter 10 epoll loop for a production single-thread server.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <arpa/inet.h>
#include <sys/socket.h>

/* Read a full HTTP request head: loop until we see the \r\n\r\n that ends the headers.
 * THIS is the framing from Chapter 7 — TCP gives no boundaries, so we read in a loop
 * and look for HTTP's delimiter ourselves. A single read() is NOT guaranteed to give
 * us the whole request. */
static int read_request(int fd, char *buf, int cap) {
    int total = 0;
    while (total < cap - 1) {
        ssize_t n = read(fd, buf + total, cap - 1 - total);
        if (n <= 0) return -1;                 /* closed or error */
        total += n;
        buf[total] = '\0';
        if (strstr(buf, "\r\n\r\n")) return total;   /* end of headers found */
    }
    return -1;   /* headers too large */
}

/* Send a complete response with explicit Content-Length (the simple body framing). */
static void send_response(int fd, const char *status, const char *ctype,
                          const char *body, int keep_alive) {
    char hdr[512];
    int blen = (int)strlen(body);
    int hlen = snprintf(hdr, sizeof hdr,
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Connection: %s\r\n"
        "\r\n",
        status, ctype, blen, keep_alive ? "keep-alive" : "close");
    write(fd, hdr, hlen);
    write(fd, body, blen);
}

/* Send a chunked response — for a body whose length we don't know upfront (§11.4). */
static void send_chunked(int fd, int keep_alive) {
    char hdr[256];
    int hlen = snprintf(hdr, sizeof hdr,
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/plain\r\n"
        "Transfer-Encoding: chunked\r\n"
        "Connection: %s\r\n\r\n", keep_alive ? "keep-alive" : "close");
    write(fd, hdr, hlen);

    /* Stream three chunks, each prefixed with its size in hex, then the 0 terminator. */
    const char *parts[] = { "Hello, ", "chunked ", "world!\n" };
    for (int i = 0; i < 3; i++) {
        char chunk[64];
        int len = snprintf(chunk, sizeof chunk, "%zx\r\n%s\r\n",
                           strlen(parts[i]), parts[i]);   /* "<hexsize>\r\n<data>\r\n" */
        write(fd, chunk, len);
    }
    write(fd, "0\r\n\r\n", 5);   /* zero-size chunk = end of body */
}

static void *handle_conn(void *arg) {
    int fd = (int)(long)arg;
    char buf[8192];

    /* Keep-alive loop: serve multiple requests on the same connection (§11.4). */
    for (;;) {
        if (read_request(fd, buf, sizeof buf) < 0) break;   /* client closed */

        /* Parse the request line: "METHOD PATH VERSION". */
        char method[16], path[256], version[16];
        if (sscanf(buf, "%15s %255s %15s", method, path, version) != 3) {
            send_response(fd, "400 Bad Request", "text/plain", "Bad Request\n", 0);
            break;
        }

        /* Honor Connection: close if the client requested it. */
        int keep_alive = (strcasestr(buf, "Connection: close") == NULL);

        /* Route on the path. */
        if (strcmp(path, "/") == 0) {
            send_response(fd, "200 OK", "text/html",
                          "<!DOCTYPE html><h1>Hello from scratch</h1>\n", keep_alive);
        } else if (strcmp(path, "/stream") == 0) {
            send_chunked(fd, keep_alive);
        } else {
            send_response(fd, "404 Not Found", "text/plain", "Not Found\n", keep_alive);
        }

        if (!keep_alive) break;   /* client asked to close, or we chose to */
    }
    close(fd);
    return NULL;
}

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 8080;
    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int yes = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) < 0) { perror("bind"); return 1; }
    listen(listen_fd, 128);
    printf("HTTP/1.1 server on http://localhost:%d/\n", port);

    for (;;) {
        int conn = accept(listen_fd, NULL, NULL);
        if (conn < 0) continue;
        pthread_t t;
        pthread_create(&t, NULL, handle_conn, (void *)(long)conn);   /* one thread/conn */
        pthread_detach(t);
    }
    return 0;
}
```

Run it and hit it with `curl`:

```
$ curl -v http://localhost:8080/
> GET / HTTP/1.1
< HTTP/1.1 200 OK
< Content-Type: text/html
< Content-Length: 42
< Connection: keep-alive
<
<!DOCTYPE html><h1>Hello from scratch</h1>

$ curl http://localhost:8080/stream
Hello, chunked world!          ← assembled from 3 chunks, curl reassembles transparently

$ curl -v http://localhost:8080/nope
< HTTP/1.1 404 Not Found
```

Everything from this chapter is in that code:
- **The framing loop** (`read_request`) reads until `\r\n\r\n` — the Chapter 7 lesson made concrete: *one `read()` is not one request*, so we loop and look for HTTP's delimiter ourselves. This is the single most important correctness detail, and the one naive servers get wrong.
- **Request-line parsing** (`METHOD PATH VERSION`) — HTTP's human-readable grammar (§11.1).
- **`Content-Length` framing** for known-size bodies and **chunked encoding** for the streaming endpoint (§11.4).
- **The keep-alive loop** — the connection serves multiple requests until the client says `close` (§11.4) — persistent connections in action.
- **Status codes** (200 / 404 / 400) routing the response (§11.3).

This is, in miniature, what Nginx and every web framework do: read bytes, find the request boundary, parse the request line and headers, route, and write a well-framed response. Graft this parsing logic onto the Chapter 10 epoll loop (instead of thread-per-connection) and you have the architecture of a real, high-concurrency web server. The threading here is for clarity; the *HTTP* is real.

> **What a production server adds (and why each matters):** full header parsing into a map (we only peeked at `Connection`), request body handling (reading `Content-Length` bytes for POSTs — more framing), URL decoding and path sanitization (security: stop `../../etc/passwd` traversal), proper HTTP date headers, robust error handling for malformed input (HTTP parsing is a notorious security surface — request smuggling attacks exploit `Content-Length`/`Transfer-Encoding` ambiguities between servers), timeouts (a slow client holding a connection open is the "Slowloris" DoS), and the epoll event loop for concurrency. But the skeleton is honest: HTTP/1.1 really is this simple to parse, which is exactly why it conquered the world — and exactly why its successors had to work so hard to improve on it without losing that simplicity.

---

## Key Takeaways

1. **HTTP is a stateless request/response protocol whose messages are human-readable text:** a start line (request line or status line), `Name: Value` headers each ending in `\r\n`, a blank line (`\r\n\r\n`) that frames the end of the headers, and an optional body. That readability — you can type HTTP into `nc` by hand — was decisive in its adoption. The `\r\n\r\n` delimiter is HTTP's framing solution to TCP's no-boundaries problem (Ch. 7).

2. **Methods form a vocabulary with formal properties that the web's infrastructure depends on:** *safe* (read-only — GET/HEAD, so prefetchers and caches can hit them freely) and *idempotent* (repeatable harmlessly — GET/PUT/DELETE, so they're safe to retry). **POST is neither**, which is why retrying it risks duplicate side effects and why idempotency keys exist. Confusing safe and idempotent is a classic trap.

3. **Status codes group by leading digit; the 4xx/5xx split drives retry logic** (4xx = client's fault, don't retry the same request; 5xx = server's fault, retry with backoff). Know 304 (caching), 301 vs 302 (permanent vs temporary redirect), 429 (rate limit), and 502/503/504 (the proxy/LB errors of Ch. 17).

4. **Headers are HTTP's extensibility mechanism** — the grammar is fixed but you can add headers forever. `Host` (mandatory in 1.1) enables virtual hosting (many sites per IP) and L7 routing; Content-Type/Length frame the body; Cache-Control/ETag drive caching; Cookie carries state. Headers are to HTTP what options are to TCP: designed-in room to grow.

5. **The 1.0→1.1 performance arc:** HTTP/1.0's connection-per-request paid a fresh handshake + slow-start ramp for every resource (catastrophic for multi-resource pages). HTTP/1.1's **persistent connections (keep-alive)** reuse one warm connection — one of the biggest HTTP performance levers (hence connection pooling everywhere). **Pipelining failed** due to **head-of-line blocking** (responses must be ordered, so one slow response stalls the rest) — the exact wall HTTP/2 multiplexing was built to break. **Chunked transfer encoding** frames a body of unknown length (size-prefixed chunks, zero chunk ends it) for streaming.

6. **HTTP caching is the cheapest big win in web performance, and it's widely neglected.** *Freshness* (`Cache-Control: max-age`) avoids the request entirely (free reuse, faster than any origin response); *validation* (ETag/Last-Modified + conditional requests → **304 Not Modified**) makes revalidation cheap (confirm without re-transferring the body). The pattern: long `max-age` + content-hashed `immutable` assets makes repeat visits nearly instant and offloads 90%+ of traffic to caches/CDNs.

7. **HTTP stays stateless so it can scale (any server handles any request → load balancing), and cookies move the necessary state to the client** so applications can still be stateful. Session cookies (opaque ID → server-side store) vs. self-contained signed tokens (JWT — any server validates without shared storage) is a core architecture choice.

8. **A real HTTP/1.1 server is simple to build:** loop-read until `\r\n\r\n` (the framing detail naive servers get wrong), parse the request line, route, write a well-framed response (Content-Length or chunked), and loop for keep-alive. That simplicity is why HTTP won — and why improving on it (HTTP/2, /3) without losing it was hard.

---

## Interview Drills

**Q1. What's the difference between a safe method and an idempotent method, and why does it matter?**
*Model answer:* Safe means the method has no side effects — it's read-only and doesn't change server state (GET, HEAD, OPTIONS). Idempotent means performing it N times has the same effect as performing it once (GET, PUT, DELETE — deleting twice leaves it deleted; setting a value twice leaves that value). They're related but distinct: all safe methods are idempotent, but not all idempotent methods are safe (PUT and DELETE change state but are repeatable). POST is *neither* — two POSTs to /orders create two orders. This matters because the properties are the contract the web's infrastructure relies on: caches and prefetchers freely hit safe methods (no side effects to fear), and clients/proxies safely retry idempotent requests after a timeout (retrying is harmless whether or not the original succeeded). But you must *not* auto-retry a POST, because it might duplicate the side effect — two charges, two orders. That's exactly why the double-submit problem exists and why idempotency keys were invented: to give each logical POST a unique key the server deduplicates on, making it safe to retry. Designing an API where GET mutates state, or expecting a load balancer to retry POSTs, violates the contract and eventually breaks something.

**Q2. Why was HTTP/1.0 slow for real web pages, and how did HTTP/1.1 fix it?**
*Model answer:* HTTP/1.0 used a fresh TCP connection per request, closed after each response. A modern page pulls dozens of resources, so each one paid the full TCP cost: a three-way handshake (one RTT of latency before any data) plus starting from slow start (a small congestion window that needs several RTTs to ramp up to full speed), plus TIME_WAIT accumulation. On a 100ms-RTT link, the handshakes alone for a page with dozens of resources add a second or more of pure waiting. HTTP/1.1 fixed the worst of it with persistent connections (keep-alive): the connection stays open after a response and is reused for subsequent requests, so you pay one handshake and one slow-start ramp, then run many requests over the now-warm connection (which has a grown congestion window and is much faster). This is why connection pooling is standard in every HTTP client and database driver. HTTP/1.1 also tried pipelining (multiple requests in flight without waiting), but it failed due to head-of-line blocking and buggy proxies, so browsers instead opened ~6 parallel connections per origin as a workaround — wasteful, and ultimately what HTTP/2's single-connection multiplexing replaced.

**Q3. What is head-of-line blocking in HTTP/1.1, and why does it motivate HTTP/2?**
*Model answer:* HTTP/1.1 allows at most one outstanding request-response exchange per connection at a time (pipelining, which would allow more, failed). Even with pipelining, HTTP/1.1 requires responses to return in the *same order* as the requests, because the protocol has no way to match an out-of-order response to its request. So if you send requests A, B, C and A's response is slow to generate (an expensive query), B and C must wait behind A even if they're ready — the slow response at the head of the line blocks everything queued behind it. That's head-of-line blocking at the HTTP layer. The practical effect is that one slow or large resource stalls all the others on that connection, which is why browsers resorted to opening multiple parallel connections (each with its own handshake and slow-start). HTTP/2 solves this with multiplexing: it splits each request/response into independently-framed streams that can interleave over a single connection in any order, so a slow response no longer blocks others — they make progress concurrently. (HTTP/2 still suffers TCP-level head-of-line blocking under packet loss, which is what HTTP/3/QUIC then addresses — Chapters 13–14.)

**Q4. Explain HTTP caching — how do you both avoid requests and make unavoidable ones cheap?**
*Model answer:* Two complementary strategies via headers. Freshness avoids the request entirely: the server sends `Cache-Control: max-age=N`, and while the response is younger than N seconds the client serves it straight from cache with zero network round trips — the fastest possible outcome, faster than any origin response. Validation makes revalidation cheap once freshness expires: the original response carries a validator — an ETag (an opaque content fingerprint, usually a hash) and/or Last-Modified (a timestamp). When the cached copy goes stale, the client sends a conditional request (`If-None-Match: "<etag>"` or `If-Modified-Since`), and if the resource hasn't changed, the server replies `304 Not Modified` with *no body* — confirming the cached copy is still valid without re-transferring it, turning a 1 MB download into a few bytes. The art is combining both: a sensible `max-age` so most reuse is free, plus an ETag so expiry costs only a 304. Content-hashed assets (app.<hash>.js) go further with `max-age=31536000, immutable` — cached forever and never revalidated, because the filename changes when the content does. Well-tuned caching offloads the large majority of traffic from the origin to CDNs and browser caches; it's the cheapest big win in web performance and widely neglected.

**Q5. HTTP is stateless, yet websites remember you're logged in. How?**
*Model answer:* Statelessness means each HTTP request is independent and the server keeps no memory between requests — which is deliberately a feature, because it lets *any* server handle *any* request, enabling horizontal scaling and load balancing (you can spray requests across a fleet because none depends on having hit a specific server before). Applications still need state, so cookies bridge the gap without breaking statelessness: on login the server sends `Set-Cookie: session=abc123`, the browser stores it and automatically replays it as `Cookie: session=abc123` on every subsequent request to that domain. The server recognizes the user not because it remembers them, but because the *client carries the identifier back every time* — the state lives at the client (or in a shared store the cookie keys into), not in the server's per-connection memory, so any server in the fleet can read the cookie and serve the request. There are two designs: a session cookie holding an opaque ID that keys into server-side session storage, or a self-contained signed token (JWT) that carries the state itself so any server can validate it cryptographically without shared storage — the same "encode the state in the token you get back" idea as TCP SYN cookies. The through-line: HTTP stays stateless to scale; cookies relocate the necessary state to the client so apps can be stateful.

**Q6. You're building an HTTP server. Why can't you just call `read()` once and parse the result as a request?**
*Model answer:* Because TCP is a byte stream with no message boundaries (Chapter 7), so a single `read()` is not guaranteed to return exactly one HTTP request — it might return part of a request (the headers split across two reads), or a request and a half (one request plus the start of the next on a keep-alive connection), depending on how TCP segmented and delivered the bytes. If you parse one `read()` as a complete request, it works in testing with small requests on localhost and then fails intermittently in production when requests get split or coalesced. The correct approach is to read in a loop, accumulating bytes into a buffer, until you find HTTP's framing delimiter — `\r\n\r\n`, which marks the end of the headers — and then, if there's a body, continue reading until you have `Content-Length` bytes (or parse chunked encoding to its terminating zero chunk). You also have to handle leftover bytes belonging to the *next* request on a keep-alive connection. This loop-until-you-have-a-complete-message pattern is exactly the application-level framing that every protocol over TCP must implement, and getting it wrong (assuming one read = one message) is one of the most common and most intermittent networking bugs. HTTP's `\r\n\r\n` and Content-Length/chunked encoding are precisely its framing scheme layered onto TCP's boundary-less stream.

---

*Previous: [Chapter 10 — Sockets and the Kernel](./10-sockets-and-the-kernel.md) | Next: [Chapter 12 — TLS and HTTPS](./12-tls-and-https.md)*
