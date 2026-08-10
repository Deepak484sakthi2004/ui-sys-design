# Chapter 8 — TCP, Part II: Congestion Control

> *In October 1986, the internet — then a small research network — suffered a "congestion collapse." The throughput between two sites at Berkeley, a few hundred yards apart, dropped from 32 kbit/s to 40 **bit**/s — a factor of a thousand. The links weren't broken. They were drowning in their own retransmissions: senders, seeing packets lost to congestion, retransmitted harder, which caused more congestion, which caused more loss, in a death spiral. Van Jacobson's fix — congestion control — saved the internet, and the algorithms he sketched in 1988 still run, evolved, in every TCP stack today. This chapter is that fix, and everything that came after.*

Chapter 7 covered how TCP makes delivery *reliable* (sequence numbers, ACKs, retransmission) and how it protects the *receiver* (flow control's sliding window). This chapter covers the harder, subtler problem TCP also has to solve: protecting the **network**. Flow control asks the receiver "how much can *you* take?" — and the receiver tells you, explicitly, in the window field. Congestion control asks "how much can the *network between us* take?" — and **nobody tells you**. There is no field for it. The routers in the middle don't send you their queue depths. You have to *infer* the network's capacity from indirect signals — packet loss, delay, ECN marks — and constantly probe for more while backing off when you've taken too much. It's a distributed control problem with no central coordinator, played by billions of TCP connections simultaneously, all sharing the same links, all guessing. That it works at all is remarkable; that it works *well* is the subject of forty years of research.

This is a flagship chapter because congestion control is where TCP performance actually lives. Every "why is my throughput low," every bufferbloat complaint, every CDN tuning decision, every "we switched to BBR and YouTube got faster" — it's all here. We'll build up the classic loss-based lineage (Tahoe → Reno → NewReno → CUBIC), the paradigm-shifting model-based approach (BBR), the cross-layer pathologies that bite in production (Nagle vs. delayed ACK, bufferbloat), and the knobs that actually matter.

---

## 8.1 The Problem: Inferring an Invisible Limit

Let's be precise about why this is hard. The sender wants to transmit as fast as possible *without* overloading the path. The path's capacity is the bottleneck link's bandwidth, and how much can be "in flight" is the bandwidth-delay product (BDP, Chapter 1). But:

- **The capacity is unknown.** You don't know the bottleneck bandwidth — it could be a 100 Gbps backbone or a congested coffee-shop Wi-Fi, and it's somewhere along a path you can't see.
- **The capacity is shared and changing.** Other flows come and go, constantly. The capacity *you* can use drops when a neighbor starts a download and rises when they stop. There's no notification.
- **The only feedback is indirect and delayed.** The network tells you it's congested by *dropping your packets* (a router's queue overflowed) or, if ECN is enabled, by *marking* them. Either way, you find out *one RTT later* — the signal is stale by the time it arrives.

So congestion control is a feedback loop with a hidden, moving setpoint and a laggy sensor. The classic strategy, and the one Jacobson chose, is **probe-and-back-off**: gently increase your sending rate to probe for available capacity, and when you detect congestion (loss), sharply reduce. This gives the characteristic "sawtooth" of classic TCP — climb, crash, climb, crash — perpetually searching for the edge of the cliff by occasionally falling off it.

The state variable at the center of all this is the **congestion window (cwnd)** — the sender's *estimate* of how much data it can safely have in flight. It's a second window alongside the flow-control window (rwnd) from Chapter 7, and the sender is limited by the *minimum* of the two:

```
   Bytes the sender may have in flight = min(cwnd, rwnd)
                                              │      │
                              network limit ──┘      └── receiver limit
                              (congestion control,    (flow control,
                               this chapter — INFERRED) Chapter 7 — ADVERTISED)
```

Flow control's rwnd is *advertised* (the receiver tells you). Congestion control's cwnd is *inferred* (you guess). The whole chapter is about how to guess cwnd well.

---

## 8.2 The Classic Algorithm: Slow Start and Congestion Avoidance

Jacobson's 1988 algorithm has two phases, and essentially every loss-based TCP since is a refinement of these two ideas. The sender maintains cwnd and a threshold **ssthresh** (slow-start threshold) that marks the boundary between the phases.

### Slow start: find the ballpark fast (exponential growth)

When a connection begins, the sender has *no idea* what the path's capacity is. Starting by blasting at full speed would risk instant congestion collapse; starting at a crawl wastes time. The answer is **slow start** — which, despite its name, ramps up *exponentially* (it's "slow" only relative to the old "dump everything at once" behavior it replaced):

```
   Slow start: cwnd starts small (the "initial window," ~10 segments today, RFC 6928)
   and DOUBLES every RTT — increase cwnd by 1 MSS for each ACK received.

   RTT 1:  cwnd = 10   ──send 10 segments──►  10 ACKs come back  ──►  cwnd = 20
   RTT 2:  cwnd = 20   ──send 20──►           20 ACKs            ──►  cwnd = 40
   RTT 3:  cwnd = 40   ──send 40──►           40 ACKs            ──►  cwnd = 80
   ...exponential: 10, 20, 40, 80, 160, ...  (doubling each round trip)
```

Exponential growth finds the right order of magnitude quickly — in ~log(BDP) round trips you've gone from nothing to filling the pipe. Slow start continues until one of: cwnd reaches ssthresh (switch to congestion avoidance), or a loss occurs (congestion detected — back off).

> **Why slow start matters for short connections (and HTTP).** Here's a consequence that shapes web performance: a connection *starts slow* and takes several RTTs to ramp up. For a short transfer (a small web page, an API response), the connection may *finish while still in slow start* — it never reaches full speed. This means short connections are dominated by the *number of round trips* (latency), not bandwidth, and the slow-start ramp is a big part of why. It's a major reason HTTP/2 multiplexes everything onto *one* long-lived connection (Ch. 13) — to keep that connection "warm" (past slow start, with a large cwnd) and amortize the ramp, rather than paying the slow-start tax on a fresh connection per request. The bigger initial window (raised to 10 segments by Google's research, RFC 6928) was specifically to help short flows finish faster. The slow-start ramp is invisible until you realize it's why your first request to a service feels slower than the tenth.

### Congestion avoidance: probe gently (linear growth)

Once cwnd passes ssthresh, the sender is in the right ballpark and switches to **congestion avoidance** — cautious, *linear* growth, probing for a little more capacity each RTT:

```
   Congestion avoidance: increase cwnd by 1 MSS per RTT (not per ACK).
   Linear, additive growth — gently feeling for the ceiling.

   cwnd:  80 → 81 → 82 → 83 → ...   (one more segment each round trip)
```

This is the **Additive Increase** half of **AIMD (Additive Increase, Multiplicative Decrease)** — the control law at the heart of classic TCP.

### Reacting to loss: the multiplicative decrease

When loss is detected, the sender concludes the network is congested and backs off. *How* it backs off depends on *how* the loss was detected — and this distinction is the difference between TCP Tahoe and Reno:

- **Loss detected by timeout (RTO):** the severe case — no ACKs at all, the connection may have stalled badly. Response: drastic. Set ssthresh = cwnd/2, then **reset cwnd to 1 (or the initial window)** and re-enter slow start. Start over, gently.
- **Loss detected by 3 duplicate ACKs (fast retransmit, Ch. 7):** the mild case — later packets are still getting through, so the path isn't dead, just lightly congested. Response: moderate. This is **fast recovery** (Reno's innovation): halve cwnd (`cwnd = ssthresh = cwnd/2`) and continue in congestion avoidance *without* dropping all the way back to slow start. You lost a packet but the pipe's still flowing, so don't panic.

```
   The AIMD sawtooth (TCP Reno's cwnd over time):

   cwnd
     │        /|        /|        /|
     │       / |       / |       / |        ← additive increase (probe up, +1/RTT)
     │      /  |      /  |      /  |
     │     /   ↓     /   ↓     /   ↓         ← multiplicative decrease on loss (÷2)
     │    /    │    /    │    /    │
     │   /     └───/     └───/     └──
     └────────────────────────────────► time
       perpetually probing for the bottleneck, halving when it overshoots
```

**Why multiplicative decrease specifically?** Because it's what makes TCP *stable and fair*. Additive increase + multiplicative decrease (AIMD) is mathematically proven (Chiu & Jain, 1989) to converge to a fair, stable allocation when many flows share a link: the gentle linear increase lets flows probe for spare capacity without overshooting wildly, and the sharp halving on congestion quickly relieves overload and nudges competing flows toward equal shares. A different rule (e.g. additive decrease) wouldn't converge to fairness. AIMD is one of those rare cases where a simple control law has a deep theoretical justification — it's not arbitrary, it's the rule that makes a billion selfish senders share links fairly without coordinating. This is the AIMD/fairness result worth knowing by name.

---

## 8.3 The Loss-Based Lineage: Tahoe → Reno → NewReno → CUBIC

The classic algorithms are all variations on "probe up, back off on loss." The lineage is worth knowing because the names come up and each step fixed a real flaw:

**TCP Tahoe (1988).** The original: slow start, congestion avoidance, and fast retransmit. On *any* loss (timeout or dup-ACKs), it drops cwnd to 1 and re-enters slow start. Correct but conservative — even a mild, single loss caused a full restart.

**TCP Reno (1990).** Added **fast recovery**: on loss detected by 3 dup-ACKs (the mild case), halve cwnd and stay in congestion avoidance instead of restarting from 1. This is the AIMD sawtooth above. Reno was the workhorse for over a decade. Its weakness: it recovers poorly from *multiple* losses in one window (each loss triggers another halving).

**TCP NewReno (1999, RFC 6582).** Refined fast recovery to handle multiple losses in a single window without repeatedly halving — it stays in fast recovery until *all* the data outstanding when recovery began is ACKed. Better, but still fundamentally loss-based with the same sawtooth shape.

**TCP CUBIC (2008) — Linux's longtime default.** Here's the important modern one. The problem with Reno on *high-BDP* links (fast, long-distance — a "long fat network"): after a loss halves cwnd, Reno's *linear* +1/RTT recovery is agonizingly slow to climb back. On a 10 Gbps transcontinental link, refilling the window after a single loss could take *minutes* — so Reno simply can't fill fast, long pipes. CUBIC replaces the linear increase with a **cubic function** of time since the last congestion event:

```
   CUBIC's window growth (cubic curve, vs. Reno's straight line):

   cwnd
     │            ___________          ← plateau: near the previous max (Wmax), grow
     │          /                        SLOWLY and cautiously (probe gently)
     │         /
     │  ______/  ← inflection at the last-known-good window (Wmax)
     │ /
     │/   ← after a loss, climb FAST back toward Wmax (steep cubic rise)
     └──────────────────────────────► time since last congestion event

   Fast climb back to where it last congested, cautious near that ceiling, then
   accelerating probe beyond it if no loss. RTT-independent: same shape regardless
   of latency, so it's fair across connections with different RTTs.
```

CUBIC climbs back toward the last-known-good window *fast* (steep cubic rise), then *flattens* as it approaches that ceiling (probing cautiously where congestion last happened), then *accelerates* again to probe beyond if all stays well. Crucially, its growth depends on *time*, not RTT — making it **RTT-fair** (connections with different latencies get fairer shares than Reno, which favored short-RTT flows). CUBIC's aggressive-then-cautious shape lets it fill high-BDP links that Reno couldn't, which is why it became the Linux default and carried most of the internet's traffic for over a decade.

But CUBIC — and all of Tahoe/Reno/NewReno — shares one deep flaw: **they treat packet loss as the *signal* of congestion.** That assumption made sense in 1988 when loss meant a router queue overflowed. But it has two problems that became severe over time, motivating a completely different approach.

---

## 8.4 The Loss-as-Signal Problem, and Bufferbloat

The loss-based assumption — "loss means congestion" — breaks in two important ways:

**Problem 1: Loss isn't always congestion.** On wireless links (Wi-Fi, cellular), packets are sometimes lost to *radio interference*, not congestion. A loss-based algorithm sees that loss and *halves its rate* — even though the network wasn't congested at all. So classic TCP underperforms badly on lossy-but-not-congested links, misreading random loss as a signal to slow down. (This is one reason mobile network performance was historically poor.)

**Problem 2: Bufferbloat — congestion *without* loss, until it's too late.** This is the big one, and it's worth understanding deeply because it's everywhere. Modern routers and devices have *huge* buffers (memory got cheap, and vendors over-provisioned buffers thinking "more buffer = fewer drops = good"). But for a loss-based algorithm, big buffers are a disaster:

```
   Bufferbloat:  a loss-based sender keeps increasing cwnd until it sees loss. But
   with a huge buffer, the bottleneck router QUEUES the excess instead of dropping it.

   Sender pushes harder ──► router buffer fills up ──► fills MORE ──► fills MORE...
                            (no loss yet, so the sender keeps pushing!)
                                      │
   ...until the buffer is FULL (maybe seconds of queued data), THEN it drops.

   Meanwhile: every packet now waits in that bloated queue. LATENCY SKYROCKETS —
   a buffer holding 2 seconds of data adds 2 SECONDS of delay to every packet,
   even though throughput looks fine and there's no loss.
```

The result is the maddening real-world symptom: **you start a big download, and suddenly your video call stutters, your SSH session lags, web pages crawl — even though the download itself is fast.** The download's loss-based TCP filled the router's giant buffer to the brim (because no loss occurred to make it stop), and now *every* packet — including your latency-sensitive ones — sits behind seconds of queued bulk data. Throughput is maximized; latency is destroyed. This is **bufferbloat**, and it plagued home internet for years (and still does on under-managed networks). The loss-based algorithm did exactly what it was designed to do — push until loss — and the oversized buffer turned that into a latency catastrophe.

The partial fixes attacked it from the router side: **Active Queue Management (AQM)** algorithms like **CoDel** ("Controlled Delay") and **FQ-CoDel** *deliberately drop or mark packets early* — before the buffer is full — to signal congestion to the sender *while latency is still low*, and to fair-queue flows so a bulk download can't starve a video call. AQM is now standard in good router firmware and is the reason modern home routers handle mixed traffic far better. But AQM treats the symptom at the router; the deeper question is whether the *sender's* congestion signal should have been loss at all. That question is what BBR answers.

> **In the wild:** You can *measure* your own bufferbloat: run a speed test that reports latency *under load* (e.g. the "bufferbloat" grade on speed-test sites). If your idle ping is 20ms but your ping *during a download* jumps to 500ms+, you have bufferbloat — your router is queuing seconds of data. Enabling FQ-CoDel/SQM on your router (or switching to a congestion control like BBR) fixes it. This is one of the most directly observable pieces of this entire book.

---

## 8.5 BBR: Modeling the Bottleneck Instead of Waiting for Loss

In 2016, Google introduced **BBR (Bottleneck Bandwidth and Round-trip propagation time)** — a fundamentally different philosophy that abandons loss as the primary signal. Instead of probing until something breaks, BBR *builds a model* of the network path and paces itself to match it. This is the most significant change in congestion control since Jacobson, and it now carries a large fraction of the internet (all of YouTube and Google's services, and widely adopted elsewhere).

The core insight: the *optimal* operating point is the one Leonard Kleinrock identified in 1979 — send at exactly the **bottleneck bandwidth (BtlBw)**, with exactly one BDP of data in flight, so the pipe is *full* but the *queue is empty*. At that point you get maximum throughput *and* minimum latency simultaneously — no bufferbloat, no underutilization. Loss-based algorithms can't find this point (they only stop at loss, which is *past* it, in the bloated-queue region). BBR aims directly for it by continuously estimating two quantities:

```
   BBR measures the path's two defining properties, separately:

   • BtlBw (Bottleneck Bandwidth): the max delivery rate it has observed
     = how fast can data actually drain through the bottleneck?

   • RTprop (Round-trip propagation time): the min RTT it has observed
     = the path's latency with NO queuing (the "empty pipe" delay)

   Optimal in-flight data = BtlBw × RTprop = the BDP.   Send at BtlBw, pace it out
   smoothly, keep exactly one BDP in flight. Pipe full, queue empty. The Kleinrock point.
```

BBR works in phases: it periodically *probes bandwidth* (briefly sends faster — pacing gain 1.25× — to see if more bandwidth is available, then drains the queue it just created), and periodically *probes RTT* (briefly sends much slower to drain any queue and re-measure the true minimum RTT). From these it computes the BDP and **paces** packets out at exactly BtlBw — spacing them evenly rather than sending in bursts. The differences from loss-based TCP are profound:

- **Loss-tolerant:** BBR doesn't halve its rate on random loss — it only cares about its *measured* delivery rate and RTT. So on lossy wireless/cellular links, BBR vastly outperforms CUBIC (which would cut its rate on every interference-induced loss). This is a primary reason Google deployed it for mobile YouTube.
- **Bufferbloat-resistant:** because BBR targets one BDP in flight (empty queue), it *doesn't* fill buffers the way loss-based algorithms do. It keeps latency near the path's true minimum even at full throughput — solving bufferbloat from the *sender* side.
- **Paced, not bursty:** BBR sends packets smoothly spaced at the bottleneck rate, rather than the bursty send-a-window-then-wait of classic TCP, which is gentler on buffers.

BBR isn't a free lunch — it's had genuine controversy. **BBRv1 could be unfair to CUBIC flows** (it would grab more than its share when competing with loss-based traffic, because it ignores the loss signals CUBIC respects) and could itself cause some queuing. **BBRv2 and BBRv3** (the current generation, ~2023) addressed this — incorporating loss and ECN signals as *secondary* inputs to coexist more fairly with loss-based flows, improving fairness and reducing the aggressiveness, while keeping the model-based core. The trajectory is clear: model-based congestion control (measure the path, pace to it) is the future, with loss as one input among several rather than *the* signal. BBR's deployment in QUIC (Ch. 14), where congestion control lives in userspace and can be updated without kernel changes, accelerates this evolution enormously.

> **The paradigm shift, stated plainly:** loss-based TCP (Reno/CUBIC) asks "have I caused a problem yet?" and backs off when the answer becomes yes — so it *operates in the problem region* (full buffers) by design, finding the limit by exceeding it. BBR asks "what is this path's actual bandwidth and latency?" and paces to match — operating at the *optimal* point (full pipe, empty queue) without needing to overshoot. It's the difference between finding the edge of a cliff by falling off it repeatedly versus measuring where the edge is and standing right at it. That reframe — *model the network, don't just react to its breakage* — is the single most important idea in modern congestion control.

---

## 8.6 The Small-Packet Pathologies: Nagle vs. Delayed ACK

Congestion control governs *how fast* to send. A separate set of mechanisms governs *when* to send small amounts of data — and their interaction produces one of the most infamous latency bugs in networking, one you *will* hit and must be able to diagnose instantly.

### Nagle's algorithm: don't send tiny segments

Recall from Chapter 7 (§7.5, silly window syndrome) that sending many tiny segments is wasteful — a 1-byte payload still carries 40 bytes of IP+TCP header, a 4000% overhead. **Nagle's algorithm** (1984) addresses this on the *sender* side: *don't send a small segment if there's already unacknowledged data outstanding — instead, buffer the small writes and coalesce them, sending when either an ACK arrives or enough data accumulates to fill a full segment.*

```
   Nagle's rule: if there is unacknowledged data in flight, hold small writes and
   batch them; only send a small segment when all prior data is ACKed (or you've
   accumulated a full MSS). Goal: avoid flooding the network with tiny packets.
```

This is great for bulk throughput (it prevents tinygram floods, e.g. from a telnet session sending one keystroke per packet). But it *adds latency* to small writes — they wait for an ACK before going out.

### Delayed ACK: don't send tiny ACKs

Independently, the *receiver* has its own efficiency optimization: **delayed ACK**. Instead of immediately ACKing every segment (each ACK is a 40-byte packet carrying no data), the receiver *waits* up to ~200ms (or until it has data to send back, so the ACK can piggyback) before sending a standalone ACK, hoping to either piggyback it on a response or ACK two segments at once. This halves the number of pure-ACK packets — also a sensible efficiency win.

### The collision: a 40ms (or 200ms) stall

Now watch what happens when a Nagle sender talks to a delayed-ACK receiver in a *request/response* pattern with small messages (which is to say: a huge fraction of real applications — RPCs, database queries, interactive protocols):

```
   The deadlock-ish stall (request/response, small messages):

   Sender (Nagle on)                          Receiver (delayed ACK on)
   ────────────────                           ─────────────────────────
   sends request part 1  ──────────────────►  receives it
                                              (delays ACK, hoping to piggyback
                                               or batch — waits up to 200ms)
   wants to send part 2, but Nagle says:
   "there's unacked data (part 1) in flight,
    so HOLD part 2 until part 1 is ACKed"
                          │                            │
                          │   ...both sides WAIT...    │
                          │   sender waits for ACK to send part 2;
                          │   receiver waits (delayed) before ACKing
                          ▼                            ▼
                   ──── ~40–200ms of dead silence ────
                                              finally the delayed-ACK timer fires
   receives ACK  ◄──────────────────────────  sends the (delayed) ACK
   NOW Nagle releases part 2 ──────────────►  receives part 2

   A fixed ~40ms (often) latency penalty, on EVERY small request/response exchange,
   for no reason — two independently-reasonable optimizations deadlocking each other.
```

Each optimization is individually sensible; *together*, in a request/response pattern, they create a standoff where Nagle won't send until it gets an ACK, and delayed-ACK won't send the ACK promptly — so the exchange stalls for the delayed-ACK timer (~40ms on many systems, up to 200ms). This is the legendary **"40ms latency" bug**, and it has bitten *everyone* — it's been found in databases, RPC frameworks, game servers, and HTTP clients. The symptom: your small request/response operations are mysteriously, consistently ~40ms slower than they should be, with the network and servers all looking idle.

**The fix** is almost always to disable Nagle's algorithm by setting the **`TCP_NODELAY`** socket option on the sender. For latency-sensitive request/response traffic (which is most modern application traffic — RPCs, interactive APIs), you want your small writes to go out *immediately*, not wait for coalescing. This is why **`TCP_NODELAY` is set by default in Redis, in most RPC frameworks, in gRPC, in Nginx for proxied connections, and in essentially every low-latency networked application.** Nagle's algorithm was designed for 1984's telnet-over-slow-links world; in today's world of small RPCs over fast links, it's usually a liability, and `TCP_NODELAY` is the standard remedy.

> **The interview-and-production-grade takeaway:** if you ever see a consistent, suspicious ~40ms (or ~200ms) latency on small request/response operations, with everything else looking healthy, **suspect Nagle's algorithm interacting with delayed ACK first**, and try `TCP_NODELAY`. This is one of the highest-value diagnostic patterns in all of network programming — it has saved careers' worth of debugging time, and most engineers who hit it the first time have *no idea* the network stack is silently adding 40ms. Now you do.

---

## 8.7 ECN, Pacing, and the Knobs That Matter

A few remaining mechanisms and practical levers, briefly but with intent:

**ECN (Explicit Congestion Notification, Ch. 4 §4.2).** Instead of *dropping* a packet to signal congestion (which costs a retransmission and the loss-based machinery), a router can *mark* a packet (set the ECN bits in the IP header) to say "I'm getting congested" *without* dropping it. The receiver echoes the mark back to the sender (via the ECE/CWR flags in the TCP header, Ch. 7), and the sender reduces its rate as if it had seen a loss — but *no packet was actually lost*, so no retransmission and no stall. ECN is congestion feedback *without* the cost of loss. It requires support at the endpoints and routers, and it's increasingly deployed (modern Linux, and especially in data centers with **DCTCP** — Data Center TCP — which uses ECN aggressively for ultra-low-latency intra-DC traffic). ECN is a strictly better congestion signal than loss when available; its slow universal rollout is, again, the ossification story (Ch. 2).

**Pacing.** Classic TCP sends a whole window's worth of packets in a burst, then waits — bursty traffic that stresses buffers. **Pacing** (spreading packets evenly over the RTT, at the estimated bottleneck rate) is gentler on queues and is central to BBR. Modern Linux supports pacing (via the `fq` queueing discipline), and it improves performance even for CUBIC. The trend across all of modern congestion control is *toward* paced, model-informed sending and *away* from bursty, loss-reactive sending.

**TSO/GRO (offloads).** Not congestion control per se, but performance-critical: **TSO (TCP Segmentation Offload)** lets the kernel hand the NIC a huge (64KB) buffer and have the *NIC hardware* slice it into MSS-sized segments — saving the CPU from per-segment work. **GRO (Generic Receive Offload)** does the reverse on receive — the NIC coalesces many incoming segments into one big buffer for the kernel to process once. These offloads are why a modern server can saturate a 100 Gbps link without melting its CPU (recall Chapter 1's "the CPU has ~200ns per packet"). They're the hardware's answer to per-packet overhead, complementing congestion control's job of deciding *how much* to send.

**The knobs worth knowing** (Linux), tied to what they do:
- `net.ipv4.tcp_congestion_control` — selects the algorithm (`cubic` default, `bbr` increasingly common). One line to switch your whole machine to BBR.
- `net.core.rmem_max` / `wmem_max` and `tcp_rmem` / `tcp_wmem` — the socket buffer sizes that cap the window; must be large enough to hold a full BDP on high-BDP links (Ch. 1, §7.5) or you can't fill the pipe regardless of congestion control.
- `tcp_notsent_lowat` — limits how much un-sent data the kernel buffers, reducing local queuing latency for latency-sensitive apps.
- `fq` qdisc — enables pacing.
- And on the application side, the single most impactful one: **`TCP_NODELAY`** (§8.6).

We'll return to the *observability* of all this — how to actually *see* congestion, retransmissions, and queuing on a live connection with `ss`, `tcpdump`, and eBPF tools — in Chapter 18. For now, the mechanisms; later, the measurement.

---

## Key Takeaways

1. **Congestion control protects the *network* (vs. flow control's *receiver*), and the network's capacity is *invisible* — there's no field that advertises it.** The sender must *infer* congestion from indirect, delayed signals (loss, delay, ECN marks) and maintain a *congestion window (cwnd)*; it's limited by `min(cwnd, rwnd)`. It exists because the 1986 congestion collapse proved that without it, loss → retransmit → more loss spirals to total collapse.

2. **Classic TCP = slow start (exponential ramp to find the ballpark) + congestion avoidance (linear AIMD probing) + multiplicative decrease on loss.** AIMD's halving-on-loss is *provably* what converges billions of selfish flows to a fair, stable share — it's not arbitrary. The slow-start ramp means short connections never reach full speed (dominated by RTTs), which is why HTTP/2 keeps one warm connection.

3. **The loss-based lineage (Tahoe → Reno → NewReno → CUBIC) all treat packet loss as *the* congestion signal.** CUBIC (Linux's longtime default) uses a cubic growth curve to refill high-BDP "long fat networks" that Reno's linear recovery couldn't, and is RTT-fair.

4. **Treating loss as congestion has two deep flaws:** random loss (wireless interference) isn't congestion but makes loss-based TCP needlessly halve its rate; and **bufferbloat** — oversized router buffers let a loss-based sender queue *seconds* of data before any loss occurs, destroying latency for everyone sharing the link (the "download makes my video call stutter" symptom). AQM (CoDel/FQ-CoDel) fixes it router-side by dropping/marking early and fair-queuing.

5. **BBR is the paradigm shift: model the path (bottleneck bandwidth + min RTT = BDP) and pace to it, targeting full pipe + empty queue (the Kleinrock optimum), instead of probing until loss.** It's loss-tolerant (wins big on lossy wireless), bufferbloat-resistant (keeps queues empty), and paced. BBRv2/v3 add loss/ECN signals for fairness with CUBIC. It carries YouTube/Google traffic and is QUIC's natural home.

6. **Nagle's algorithm (coalesce small sends) and delayed ACK (batch ACKs) are each individually reasonable but deadlock in request/response patterns, causing the infamous ~40ms stall.** When you see a consistent ~40ms latency on small request/response ops with everything else idle, suspect this first and set **`TCP_NODELAY`** — the standard fix, default in Redis, gRPC, and most low-latency systems.

7. **ECN signals congestion by *marking* packets instead of dropping them** — feedback without the cost of loss/retransmission (and the basis of data-center DCTCP). **Pacing** (smooth sending) and **TSO/GRO** (hardware segmentation offloads) are the modern complements that make high-throughput, low-latency TCP possible. Key knobs: `tcp_congestion_control` (cubic→bbr), socket buffer sizes (must hold the BDP), and `TCP_NODELAY`.

---

## Interview Drills

**Q1. What problem does congestion control solve that flow control doesn't, and why is it harder?**
*Model answer:* Flow control prevents a fast sender from overflowing the *receiver's* buffer, and it's easy because the receiver explicitly advertises its available space in the window field — the limit is *told* to you. Congestion control prevents senders from overwhelming the *network* — the routers and links in between — and it's much harder because *nobody advertises the network's capacity*. There's no field where a router tells you its queue depth or available bandwidth; that capacity is unknown, shared with other flows, and constantly changing. The sender has to *infer* congestion from indirect, delayed signals — packet loss, increased delay, or ECN marks — which arrive a full round trip after the fact. So congestion control is a distributed feedback-control problem with a hidden, moving target and a laggy sensor, played simultaneously by billions of uncoordinated flows. It exists because without it, the 1986 congestion collapse showed the internet death-spirals: loss triggers retransmission, which causes more congestion, which causes more loss.

**Q2. Walk me through slow start and congestion avoidance.**
*Model answer:* They're the two phases of classic TCP congestion control, governed by the congestion window (cwnd) and a threshold (ssthresh). Slow start handles the beginning, when the path's capacity is unknown: cwnd starts small (~10 segments today) and grows *exponentially* — doubling every RTT, by increasing cwnd one MSS per ACK — to quickly find the right order of magnitude without risking instant collapse. It continues until cwnd reaches ssthresh or a loss occurs. Then congestion avoidance takes over with cautious *linear* growth — increasing cwnd by one MSS per RTT — gently probing for a little more capacity. That's the "additive increase" of AIMD. On loss, multiplicative decrease kicks in: if detected by triple-duplicate-ACK (mild, path still flowing), halve cwnd and continue (fast recovery); if detected by timeout (severe), drop cwnd to 1 and restart slow start. The result is the AIMD sawtooth — climb, halve, climb — perpetually probing for the bottleneck by occasionally overshooting it. A practical consequence: short connections may finish while still in slow start, never reaching full speed, which is why keeping connections warm (HTTP/2) matters.

**Q3. Your big file download makes your video call stutter, even though the download stays fast. What's happening?**
*Model answer:* Bufferbloat. The download uses loss-based TCP (like CUBIC), which keeps increasing its sending rate until it detects loss. But modern routers have huge buffers, so instead of dropping packets when overloaded, the bottleneck router *queues* the excess — and keeps queuing, because no loss occurs to tell the sender to stop. The buffer fills with potentially seconds of the download's data. Now *every* packet crossing that link — including your latency-sensitive video and voice packets — has to wait behind that massive queue, so latency skyrockets from ~20ms to hundreds of milliseconds or more, and the call stutters, even though the download's throughput looks great. The loss-based algorithm did exactly what it was designed to do (push until loss), and the oversized buffer turned that into a latency disaster. Fixes: on the router, enable Active Queue Management (FQ-CoDel/SQM), which drops/marks early to signal congestion before the buffer bloats and fair-queues flows so the bulk download can't starve the call; on the sender side, a model-based congestion control like BBR keeps the queue empty by design.

**Q4. How is BBR fundamentally different from CUBIC?**
*Model answer:* CUBIC (and all loss-based algorithms) treats packet loss as the congestion signal: it pushes harder until something drops, then backs off — so by design it operates in the "problem region" of full buffers, finding the limit by exceeding it. BBR abandons loss as the primary signal and instead *builds a model* of the path: it continuously measures the bottleneck bandwidth (max observed delivery rate) and the round-trip propagation time (min observed RTT), whose product is the bandwidth-delay product. It then paces packets to send at exactly the bottleneck rate with about one BDP in flight — targeting the Kleinrock optimum where the pipe is full but the queue is empty, giving max throughput *and* min latency simultaneously. The consequences: BBR doesn't slow down on random (non-congestion) loss, so it crushes CUBIC on lossy wireless/cellular links; it doesn't bloat buffers, so it keeps latency low even at full throughput; and it sends smoothly paced rather than in bursts. The reframe is "model the network and stand at the edge" versus "react to the network's breakage by falling off the edge repeatedly." BBRv1 could be unfair to CUBIC; v2/v3 fold in loss and ECN signals to coexist better.

**Q5. An engineer reports that their RPC calls are consistently ~40ms slower than expected, but the network and servers look idle. What do you suspect?**
*Model answer:* The classic interaction between Nagle's algorithm (on the sender) and delayed ACK (on the receiver). Nagle holds small writes when there's unacknowledged data in flight, coalescing them until an ACK arrives or a full segment accumulates — to avoid flooding the network with tiny packets. Delayed ACK makes the receiver wait up to ~200ms before sending a standalone ACK, hoping to piggyback it on a response or batch two segments. In a request/response pattern with small messages, these deadlock: the sender won't send the next small chunk until its previous data is ACKed (Nagle), but the receiver won't send the ACK promptly (delayed ACK) — so the exchange stalls until the delayed-ACK timer fires, adding a fixed ~40ms (sometimes 200ms) to every small round trip, with everything looking idle because both sides are just *waiting*. The fix is almost always to set TCP_NODELAY on the sender to disable Nagle, so small latency-sensitive writes go out immediately. It's why TCP_NODELAY is default in Redis, gRPC, and most low-latency frameworks. This is one of the highest-value diagnostic patterns in network programming.

**Q6. What is ECN and why is it better than loss as a congestion signal?**
*Model answer:* ECN (Explicit Congestion Notification) lets a router signal congestion by *marking* a packet — setting two bits in the IP header — instead of *dropping* it. The receiver echoes the mark back to the sender via TCP header flags (ECE/CWR), and the sender reduces its congestion window as if it had detected a loss. The advantage is that no packet was actually lost: there's no retransmission, no recovery stall, and the congestion feedback arrives without the cost and latency penalty that dropping a packet incurs. It's strictly better feedback than loss when supported, because loss is a destructive way to communicate "slow down" — you lose data to send the message. ECN requires support at both endpoints and the routers, and its universal deployment has been slow (the ossification problem — middleboxes that mangle the bits). It's used aggressively inside data centers via DCTCP, which leverages fine-grained ECN marking to achieve very low latency. The broader trend — toward marking, pacing, and model-based control and away from loss-reactive bursting — is the direction of all modern congestion control.

**Q7. Why does a fresh connection to a service often feel slower than subsequent requests on a warm connection?**
*Model answer:* Largely because of slow start. A new TCP connection begins with a small congestion window (~10 segments) and grows it exponentially over several round trips before reaching the path's full capacity. A short transfer on a fresh connection may complete while *still in slow start*, never reaching full speed — so it's bottlenecked by round-trip count (latency × number of RTTs to ramp), not bandwidth. A "warm" connection that's already transferred data has grown its congestion window large, so it can send a full BDP immediately and the transfer runs at full speed. This is compounded by the TCP handshake (1 RTT) and, for HTTPS, the TLS handshake (another 1–2 RTTs) that a fresh connection must pay and a reused one skips. It's a primary reason HTTP/2 multiplexes all requests over a single long-lived connection (keeping it warm and past slow start) instead of opening a new connection per request, and why connection pooling and keep-alive are such important performance levers. The bigger initial window (RFC 6928's 10 segments) was specifically introduced to help short flows finish before slow start throttles them.

---

*Previous: [Chapter 7 — TCP, Part I: Reliability](./07-tcp-part1-reliability.md) | Next: [Chapter 9 — DNS](./09-dns.md)*
