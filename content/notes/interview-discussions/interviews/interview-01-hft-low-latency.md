# Interview 01 — HFT / Low-Latency Trading Firm

> **The company:** A proprietary trading firm. They make money by being **faster than the
> other guy by nanoseconds**, so their entire engineering culture is *mechanical sympathy* —
> understanding the machine so precisely that you can predict its timing. **The role:**
> Systems SDE on the execution path. **The panel:** A latency engineer who measures things
> in nanoseconds and gets visibly uncomfortable when you say "should be fast enough."
>
> **What they're testing:** Do you think in the units the hardware actually uses — cache
> lines, TLB entries, cycles — and do you understand that at this tier, *the average doesn't
> matter, the worst case is the whole game*? Domains: `JVM` `NET` `OS`.

8 exchanges. ★★★★ — ★★★★★.

---

### [I01.Q1] "Order-in to order-out is 5 microseconds. I want 3. Where did the 5 go?"  ·  ★★★★★

**Interviewer:** Tick-to-trade — market data arrives, we decide, an order leaves the NIC — is
5 µs. I need 3. Before you optimize anything, account for where the 5 microseconds *go*.

**Candidate:** You can't shave what you can't attribute, so first I'd build the **latency
budget** — the path decomposed into stages, each measured, because at this scale the time
hides in places people don't instrument. A typical tick-to-trade path:

```
 wire → NIC → kernel/userspace → feed parse → strategy → order encode → NIC → wire
   ~                ~0.5–1µs        ~0.5µs     ~1µs        ~0.5µs       ~
```

The big buckets, roughly:
1. **Wire + NIC + PHY** — serialization and the NIC's own latency. ~hundreds of ns each way,
   and *not* improvable in software — it's the NIC and the cable. This is why firms buy
   specific NICs (Solarflare/Exablaze) and **co-locate** in the exchange's data center: a
   meter of fiber is ~5 ns, so physical distance is literally latency.
2. **Kernel network stack** — if packets traverse the kernel (sockets, interrupts, copies),
   that's **microseconds** of pure overhead. The single biggest software win is **kernel
   bypass** (Q3) — getting the packet from NIC to user space without the kernel.
3. **Feed handler / parse** — decoding the market-data protocol (ITCH/OUDA). Parsing cost,
   and any allocation or branchiness here.
4. **Strategy / decision** — your actual logic. Should be branch-predictable and
   cache-resident.
5. **Order encode + send** — building the outbound message and pushing it to the NIC.

So before touching code: *measure each stage with timestamps* (RDTSC, Q7), find the fattest
bucket, and attack that. My prior is that a 5µs path is spending most of its time in the
**network stack and any cache misses on the strategy's data**, not in the arithmetic.

**Interviewer:** Suppose the budget says 2 of the 5 µs is in the kernel network path. What's
the move, and what do you give up?

**Candidate:** **Kernel bypass** — and I'd cover the cost honestly. The kernel path costs you
interrupts, a copy from kernel to user buffer, the socket layer, and context switches —
microseconds of work whose *only* job is generality you don't need. The moves:

- **User-space networking** — DPDK, or a vendor API (Solarflare **Onload/ef_vi**) that maps
  the NIC's rings directly into your process. The packet lands in your memory and you read it
  with **zero syscalls, zero copies, zero interrupts**.
- **Busy-poll instead of interrupt.** Don't wait to be *told* a packet arrived — **spin** a
  core reading the NIC ring in a tight loop. You burn a whole CPU core at 100% doing nothing
  but checking "is there a packet yet," but you eliminate interrupt latency and the
  wake-from-sleep delay entirely.

What you give up: **a CPU core permanently** (the busy-poll thread owns it), **generality**
(you've bypassed the kernel's TCP, firewall, everything — you implement only what you need,
often a thin UDP/multicast receiver), and **power/heat** (a spinning core runs hot). In HFT
that's an obvious trade — a core costs pennies, a microsecond costs the trade. Outside HFT
it'd be insane. The senior framing: **the kernel is an abstraction tax you pay for generality
and fairness; HFT opts out of both because it has exactly one job and wants the metal.**

──────────
> **[BANK]** Tick-to-trade optimization starts with a *measured latency budget* per stage —
> you can't shave unattributed time. Biggest software win is **kernel bypass** (DPDK /
> Solarflare ef_vi): NIC rings mapped into user space → no syscalls/copies/interrupts, plus
> **busy-polling** (burn a core spinning) to kill interrupt+wakeup latency. Cost: a dedicated
> core, all kernel generality, heat. Physical distance is latency (~5ns/m) → co-location.
> **[TRAP]** Optimizing the arithmetic before measuring; saying "should be fast enough" (the
> firm prices the *worst case*, not the average); forgetting the kernel/network stack is the
> usual fat bucket, not the logic.
> **[GO DEEPER]** [I01.Q3] busy-poll/NUMA · [I01.Q7] measuring with RDTSC · loop [R1.Q8]
> context-switch cost.

---

### [I01.Q2] "Your strategy allocates one object per market tick. We have 200,000 ticks a second. Problem?"  ·  ★★★★★

**Interviewer:** Code review: your hot path does `new Order(...)` and a couple of small
allocations per tick. 200k ticks/sec. What's wrong, and don't just say "GC."

**Candidate:** The problem is **GC pauses destroy the tail**, and at HFT a single pause is a
catastrophe — but you're right that "use less GC" is the junior answer. The real answer is
**zero-allocation on the steady-state hot path**, and here's the precise reasoning:

At 200k allocations/sec of small objects, you're churning the young generation constantly, so
**minor GCs fire frequently**. Even a "fast" minor GC is a **stop-the-world pause** —
hundreds of microseconds to milliseconds — and during it, *every* in-flight decision freezes
(loop [R4.Q7]). In HFT, a 2 ms GC pause means you're **blind and dead** for 2 ms while the
market moves and faster firms pick you off. Worse, it's **non-deterministic** — it hits at
the wrong moment by definition (under load, which is exactly when ticks spike). The average
latency might look fine; the **p99.99 has a GC-shaped cliff** that costs real money.

The fix is the **LMAX/HFT discipline: allocate everything at startup, reuse forever, allocate
nothing in steady state.**
- **Pre-allocated object pools** — a ring of `Order` objects created at warmup and recycled;
  the hot path *mutates* a pooled object, never `new`s one.
- **Primitive/flyweight design** (loop [R1.Q4]) — no autoboxing, no `Integer`, no
  `ArrayList<Long>`; use `long[]`, primitive collections, and **flyweights** over off-heap
  buffers so a "message" is a cursor into a pre-allocated `ByteBuffer`, not an object graph.
- **Off-heap** for big buffers (loop [R4.Q7]) — the GC can't pause for memory it doesn't
  manage.

Get the steady-state allocation rate to ~0 and the GC **simply never runs during the trading
day** — you've converted a runtime problem into a design constraint and solved it upstream.

**Interviewer:** You said "during the trading day." So GC still runs sometimes. How do you
make sure it runs when you want, not when the market does?

**Candidate:** Right — zero-allocation means the GC has *nothing to do*, but you still
manage it defensively, because "nearly zero" isn't "exactly zero" and you want determinism:

1. **GC at known-safe times.** Markets have a known schedule — pre-open, lunch lulls, after
   close. You can **trigger `System.gc()` deliberately during a quiet window** (and/or before
   the open), so any accumulated garbage is collected when *you* choose, not at 09:31 when
   volume spikes. You're moving the pause to a moment when being blind costs nothing.
2. **A pause-less or pause-tiny collector as backstop** — modern HFT-adjacent shops run
   **ZGC/Shenandoah** (loop [R2.Q8]) so that *if* a collection happens, the pause is
   sub-millisecond rather than a multi-ms G1 stall. Belt and suspenders: minimize allocation
   *and* run a collector whose worst case you can tolerate.
3. **Watch time-to-safepoint** (loop [R2.Q8]) — a poll-less counted loop can freeze you for
   longer than the GC itself, and the GC log won't show it. HFT code is profiled for TTSP
   jitter specifically.
4. Some shops go further and run on the JVM but with **Epsilon GC** (the no-op collector) for
   short sessions — it *never* collects, so if you've truly pre-allocated everything, you get
   zero GC by construction, and you just restart between sessions. It's the ultimate
   commitment to the zero-allocation design: prove there's no garbage by removing the
   collector entirely.

The framing: **GC isn't something you tune at HFT, it's something you *design out* of the hot
path, then schedule the residue to fire when the market isn't looking.** "Use less garbage"
is a 10% answer; "the steady-state path allocates nothing, and I collect deliberately during
the lunch lull" is the answer that says you understand the GC is reacting to *your* choices.

──────────
> **[BANK]** HFT hot path = **zero allocation in steady state**: pre-allocated object pools +
> primitive/flyweight design over off-heap buffers, so the GC has nothing to collect and never
> fires during trading. GC pauses are a non-deterministic tail cliff (p99.99) that's lethal at
> µs scale. Manage the residue: trigger `System.gc()` in known-quiet windows, run ZGC/Epsilon
> as backstop, watch time-to-safepoint.
> **[TRAP]** "Just tune the GC / use a bigger heap" — at HFT you *design out* allocation; a
> bigger heap means *longer* pauses, not fewer. Forgetting TTSP can freeze you with a clean GC
> log.
> **[GO DEEPER]** loop [R4.Q7] GC budget math · loop [R1.Q4] autoboxing · [I01.Q5] the
> Disruptor (allocation-free queue).

---

### [I01.Q3] "Two cores, a shared queue, and your throughput got *worse*. Mechanical sympathy — explain."  ·  ★★★★★

**Interviewer:** A producer core and a consumer core hand off via a queue. You add the second
core expecting parallelism; latency gets *worse* and jittery. Walk the hardware.

**Candidate:** This is a **mechanical sympathy** failure, and there are two hardware effects
stacking: **false sharing** on the queue's cursors and **cache-coherence traffic** on the
handoff (loop [R2.Q10]).

A naive concurrent queue keeps a **head** and **tail** index, and the producer writes tail
while the consumer writes head. If those two indices sit on the **same 64-byte cache line**,
every producer write **invalidates** the consumer's copy of the line and vice versa — the
line **ping-pongs** between the two cores' caches over the interconnect on *every single
operation*. You added a core and bought yourself a coherence round-trip (tens of cycles) per
message. That's why it got *slower*: the hardware serialized your "parallel" cores on a line
they accidentally share.

Plus, the data itself bounces: the producer writes a slot, the consumer reads it, so that
cache line transfers core→core — unavoidable for a handoff, but you don't want to *add*
false sharing on top.

The fix is the **LMAX Disruptor** design (loop [R2.Q10]):
- **Pad every cursor onto its own cache line** (`@Contended`) so producer and consumer
  sequences never invalidate each other.
- **A pre-allocated ring buffer** (a contiguous array sized to a power of two, masked instead
  of modulo'd) so traversal is **sequential** and the hardware **prefetcher** streams the
  next slots in — turning pointer-chasing into predictable linear access.
- **Single-writer principle** — one producer owns the write cursor, so there's no CAS
  contention on the common case; the consumer just reads a published sequence.

```
 cache-line-padded cursors:
   [ producerSeq | pad...64B ]   [ consumerSeq | pad...64B ]
   ring: contiguous pre-allocated array, masked index → prefetcher-friendly
```

**Interviewer:** You pinned the threads too. Why does *which* core matters, and what's NUMA
got to do with it?

**Candidate:** Because **not all cores are equidistant from memory or from each other**, and
the scheduler will happily ruin your latency by moving a thread to a "bad" core mid-trade.

- **Core pinning (affinity) + `isolcpus`.** I pin the busy-poll and strategy threads to
  **specific, isolated cores** (`isolcpus` / `taskset` / cgroups) so (a) the OS scheduler
  never migrates them — a migration means the thread arrives on a **cold cache** and eats
  misses until it warms (loop [R1.Q8]) — and (b) **no other process** is scheduled on those
  cores to evict my hot data or cause jitter. The strategy core does *one* thing forever, with
  its working set resident in L1/L2.
- **NUMA (Non-Uniform Memory Access).** On a multi-socket box, each socket has its **own
  local memory**; accessing the *other* socket's memory crosses the inter-socket link and is
  **significantly slower** (and the other socket's L3). So I (a) **pin the thread and its
  memory to the same NUMA node** (`numactl --membind`), allocating the ring buffer and hot
  structures on the local node, and (b) **keep the NIC, the busy-poll core, and the strategy
  on the same socket** the NIC is physically attached to — because a packet DMA'd into socket
  0's memory should be processed by socket 0's core, not fetched across the QPI/UPI link by
  socket 1.
- I'd also **disable hyperthreading** on these cores (a sibling hyperthread shares L1/L2 and
  execution units, injecting jitter) and pin down **C-states** (a core that went to sleep
  takes microseconds to wake — fatal for busy-poll).

The unifying principle: **at this tier you're not programming a CPU, you're programming a
specific physical layout of cores, caches, memory controllers, and a NIC — and your job is to
keep the hot data and the thread that touches it as physically close and as undisturbed as
possible.** False sharing, prefetch-friendly layout, core pinning, NUMA locality, HT-off,
C-state lockdown are all the same idea: respect the machine's geometry.

──────────
> **[BANK]** Adding a core can *slow* a handoff via **false sharing** (head/tail on one cache
> line → coherence ping-pong) — fix with cache-line-padded cursors + a pre-allocated, masked
> ring buffer (Disruptor) + single-writer. Then pin threads to **isolated cores** (`isolcpus`,
> no migration/cold-cache), keep thread+memory+NIC on the **same NUMA node** (local memory is
> far cheaper than cross-socket), disable hyperthreading, lock C-states.
> **[TRAP]** Assuming more cores = more speed (coherence/false-sharing can reverse it); letting
> the scheduler migrate hot threads (cold cache + jitter); ignoring NUMA on a 2-socket box.
> **[GO DEEPER]** loop [R2.Q10] false sharing/MESI · loop [R1.Q8] migration cost · [I01.Q5]
> Disruptor in full.

---

### [I01.Q4] "How do you even *measure* a 200-nanosecond improvement without lying to yourself?"  ·  ★★★★☆

**Interviewer:** You claim a change saved 200 ns. The skeptic in me says your measurement is
noisier than that. How do you measure sub-microsecond latency *correctly*?

**Candidate:** Measuring at this scale is harder than optimizing, and there are specific traps
that make naive measurement *lie*. The toolkit:

1. **Timestamp with `RDTSC` (read time-stamp counter), not `System.nanoTime()` in the inner
   loop.** `RDTSC` reads the CPU's cycle counter directly — single-digit-nanosecond
   resolution, ~20–30 cycle cost. But you must (a) use `RDTSCP` or fence around it because the
   CPU **reorders instructions** and could move the timestamp read across the code you're
   timing, and (b) account for the counter being **invariant TSC** (constant rate regardless
   of frequency scaling) on modern chips — pin the frequency so cycles↔time is stable.
2. **Measure percentiles, never the average.** The mean hides the tail, and at HFT **the tail
   is the product**. I report p50/p99/p99.9/p99.99 and the max. A change that improves the
   mean but fattens p99.9 is a *loss*.
3. **Use a latency histogram, and beware coordinated omission.** This is the subtle killer →

**Interviewer:** Go there — coordinated omission. Most people have never heard of it.

**Candidate:** **Coordinated omission** is a measurement bug that makes your latency numbers
**fraudulently good**, and it's everywhere. It happens when your measurement loop **stops the
clock during the very stalls you're trying to measure.**

Picture a benchmark that sends a request, waits for the response, records the latency, then
sends the next — a synchronous loop. Now suppose the system **stalls for 10 ms** (a GC pause,
a scheduler hiccup). During that stall, a real production system would have had, say, 10,000
requests *arrive and queue up*, each experiencing progressively less of the 10 ms wait. But
your benchmark **wasn't sending during the stall** — it was politely blocked waiting for the
one in-flight request. So it records **one** 10 ms sample instead of the **thousands** of
delayed samples a real load would see. The stall is *coordinated* with your measurement: you
omitted exactly the bad samples. Your p99.9 looks great; production's is a cliff.

The fixes:
- **Measure against an intended schedule, not the response.** If you intend to send a request
  every 1 µs, then a request that *should* have gone at T but couldn't until T+10ms has a
  latency of (actual_finish − **intended_send_time**), not (finish − actual_send). Tools like
  **HdrHistogram** with `recordValueWithExpectedInterval` correct for this by back-filling the
  omitted samples.
- **Open-loop load generation** — a separate thread sends at the fixed rate regardless of
  whether responses are coming back, so queueing during stalls is actually captured.
- **HdrHistogram** specifically because it records across a huge dynamic range (ns to seconds)
  with constant precision and **zero allocation** (loop [I01.Q2]) — so the *measurement itself*
  doesn't perturb the thing being measured (the observer effect: a `println` or an allocating
  logger in the hot path changes the latency you're measuring).

So my honest answer to "did it save 200 ns": I'd run it many times, open-loop, record into an
HdrHistogram corrected for coordinated omission, compare **percentile-by-percentile** with the
baseline (ideally interleaved to cancel drift), and only claim the win if **p99.9 moved
outside the run-to-run noise band**. At 200 ns, the measurement rig has to be more precise
than the effect — otherwise I'm reporting noise, and the latency engineer across the table
knows it.

──────────
> **[BANK]** Sub-µs measurement: timestamp with **RDTSC(P)** (fence it — CPU reorders), pin
> frequency (invariant TSC). Report **percentiles + max**, never the mean (the tail is the
> product). Beware **coordinated omission** — synchronous benchmarks stop the clock during the
> stalls they should measure, hiding the tail; fix with intended-schedule latency / open-loop
> load / **HdrHistogram** (zero-alloc, dynamic range). The measurement must be more precise
> than the effect.
> **[TRAP]** Reporting averages; closed-loop benchmarking (coordinated omission → fraudulently
> good tail); an allocating/logging measurement that perturbs what it measures.
> **[GO DEEPER]** [I01.Q1] the budget you're measuring · [I01.Q8] the jitter sources the tail
> exposes · loop [R4.Q7] tail latency.

---

### [I01.Q5] "Build me a single-producer-single-consumer queue with no locks and no garbage."  ·  ★★★★★

**Interviewer:** One thread produces, one consumes. I want a wait-free handoff — no locks, no
allocation. Design it.

**Candidate:** This is a **bounded SPSC ring buffer**, and the SPSC constraint is what makes
it **wait-free without any CAS** — single-producer-single-consumer is the easy, fastest case,
and the design is the heart of the Disruptor.

```
 fixed array of size N (power of two), pre-allocated at startup:
   slots: T[N]            ← reused forever, never allocated in steady state
   writeSeq: long         ← only the producer writes it (own cache line)
   readSeq:  long         ← only the consumer writes it (own cache line)

 produce(x):
   next = writeSeq + 1
   if (next - readSeq > N) return FULL          // would overwrite unread → backpressure
   slots[next & (N-1)] = x                       // mask, not modulo (power of two)
   STORE-RELEASE writeSeq = next                 // publish: release barrier

 consume():
   if (readSeq == writeSeq) return EMPTY          // nothing new
   x = slots[(readSeq+1) & (N-1)]                 // read BEFORE advancing
   STORE-RELEASE readSeq = readSeq+1              // free the slot
   return x
```

The crucial pieces:
- **No lock, no CAS:** because there's exactly one writer of `writeSeq` and one writer of
  `readSeq`, neither index is contended for *writes* — each thread only *reads* the other's
  index. The only synchronization needed is **memory ordering**, not mutual exclusion.
- **The release/acquire barrier is the correctness linchpin** (loop [R2.Q9]). The producer
  writes the slot data, *then* publishes `writeSeq` with a **store-release**; the consumer
  reads `writeSeq` with a **load-acquire**, *then* reads the slot. This happens-before edge
  guarantees the consumer never sees an advanced `writeSeq` before the slot's data is visible
  — the exact same half-constructed-object hazard as the broken double-checked lock, here on a
  queue slot. In Java these are `volatile`/`VarHandle` ops; without them, the consumer could
  read a published index but stale slot contents.
- **Power-of-two size + mask** (`& (N-1)`) instead of `% N` — modulo is a division (~20+
  cycles); a mask is one cycle. Free win, and it's why ring buffers are always powers of two.
- **Pre-allocated slots** (loop [I01.Q2]) — zero allocation in steady state; the queue
  recycles the same array forever.
- **Padded cursors** (loop [I01.Q3]) — `writeSeq` and `readSeq` on separate cache lines to
  kill false sharing.

**Interviewer:** When it's full, you return FULL. Is that right? What would you do instead,
and why not just grow it?

**Candidate:** Returning FULL — i.e. **bounded with backpressure** — is deliberately correct,
and "just grow it" is the wrong instinct, for reasons that matter especially in HFT:

- **A bounded queue is the design** (loop [R4.Q6]). If the consumer can't keep up, an
  **unbounded** queue doesn't fix anything — it hides the overload, grows without limit (now
  you're *allocating* again, killing the zero-GC property, and eventually OOM), and worse, it
  builds a **backlog of stale work**. In trading, a queued market-data event that's 5 ms old
  is *worthless* — acting on it is acting on the past. So unbounded queuing is actively harmful:
  it trades a clean "I'm overloaded" signal for a slow-motion disaster of stale, memory-eating
  backlog.
- **What I do at FULL depends on the data semantics:**
  - For **market data**, often the right move is to **drop or overwrite** — keep only the
    latest, because stale ticks are useless (a "conflation" queue that coalesces updates per
    instrument). A full queue means "you're behind; the freshest truth is what matters."
  - For **orders** (can't drop — each is a real action), FULL is a genuine **backpressure**
    signal that propagates upstream: slow the producer, or it's a sign the system is past its
    design capacity and you alert/halt rather than silently lag.
- **Growing it** also means a **resize** — allocation + copy — which is a latency spike at
  exactly the worst time (under load), and reallocating breaks the pre-allocated,
  cache-resident, zero-GC guarantees the whole design rests on. The size is chosen at startup
  from the worst-case burst you're willing to buffer, and hitting the bound is *information*,
  not a failure to paper over.

So: bounded, power-of-two, pre-allocated, padded, release/acquire-published, and **full means
something** — either conflate to the latest (market data) or apply backpressure (orders). The
bound isn't a limitation of the queue; **the bound, and what you do at it, *is* the queue's
policy.**

──────────
> **[BANK]** SPSC ring buffer = wait-free handoff with **no CAS** (single writer per index, so
> only memory *ordering* is needed, not mutual exclusion). Pre-allocated power-of-two array
> (mask, not modulo), **store-release the publish / load-acquire the read** (the happens-before
> edge that prevents reading a published index with stale slot data), padded cursors. **Bounded
> on purpose**: at FULL, conflate-to-latest (market data — stale is worthless) or backpressure
> (orders), never grow (alloc spike + stale backlog + OOM).
> **[TRAP]** Reaching for locks/CAS on an SPSC queue (unnecessary), forgetting the release/
> acquire barrier (data race on slot contents), or making it unbounded (hides overload, breaks
> zero-GC, buffers stale work).
> **[GO DEEPER]** loop [R2.Q9] release/acquire & happens-before · [I01.Q3] padded cursors ·
> loop [R4.Q6] bounded queues & backpressure.

---

### [I01.Q6] "The mean latency is 800ns and beautiful. The max is 4 milliseconds. Hunt the jitter."  ·  ★★★★★

**Interviewer:** p50 is 800 ns, p99 is 1.2 µs — gorgeous. But every few seconds there's a
**4 ms** spike. That's 5000× the median. Where do multi-millisecond stalls come from on a
machine doing sub-microsecond work?

**Candidate:** A 4 ms spike on an 800 ns path is **the operating system and hardware
interrupting your thread** — it's never the application logic (that's deterministic and fast).
At HFT, hunting these **jitter sources** is the actual job, and they come from a known rogues'
gallery, roughly in order of how nasty they are:

1. **GC pause** (loop [I01.Q2]) — the prime suspect for a *multi-millisecond* spike. Even with
   a zero-alloc design, a stray allocation (a logging call, an exception, a boxed long) can
   trigger a minor GC. 4 ms is very GC-shaped. First thing I'd rule in/out with GC logs and
   `-Xlog:safepoint`.
2. **Safepoint / time-to-safepoint** (loop [R2.Q8]) — a poll-less loop somewhere makes *all*
   threads wait at a safepoint for the slow one; the pause shows up as latency the GC log won't
   explain. Also JIT **deoptimization** and **biased-lock revocation** ride on safepoints.
3. **Page faults.** If a memory page isn't resident (first touch, or it got swapped/reclaimed),
   accessing it traps into the kernel to map it — microseconds to milliseconds. Fix:
   **pre-fault and pin memory** — touch every page at startup and `mlockall()` so nothing is
   ever paged out, and **disable swap entirely** on the box.
4. **TLB miss / huge pages.** A TLB miss triggers a page-table walk. For a large working set,
   use **huge pages** (2 MB instead of 4 KB) so the TLB covers far more memory with fewer
   entries — fewer walks, less jitter.
5. **Interrupts (IRQs).** A network or timer interrupt can land on *your* isolated core and
   steal it. Fix: **IRQ affinity** — route all interrupts *away* from the strategy cores onto a
   housekeeping core, and combine with `isolcpus` + `nohz_full` (tickless kernel) so the
   scheduler tick itself doesn't fire on your core.
6. **CPU frequency / C-states / P-states** — a core that dropped to a low-power C-state takes
   microseconds to wake; frequency scaling (P-states) changes your cycles↔time. Fix: **disable
   C-states, pin max frequency**, disable Turbo's variability — predictability over peak speed.
7. **Scheduler migration** (loop [I01.Q3]) — thread moved to a cold core. Fixed by pinning.
8. **NUMA cross-socket access** (loop [I01.Q3]) — an occasional remote-memory access. Fixed by
   membind.
9. Further down: **THP (transparent huge page) compaction**, **memory reclaim**, **kernel
   timers**, even **SMIs (System Management Interrupts)** — firmware-level interrupts the OS
   can't even see, which on a bad BIOS can cost hundreds of µs and are diagnosed only by
   elimination.

**Interviewer:** Of those, which would you suspect *first* for a clean-looking 4 ms, and how
do you confirm it without guessing?

**Candidate:** For a **4 ms** spike specifically, I suspect **GC or a safepoint stall** first
— 4 ms is far too long for a page fault or interrupt (those are µs–low-ms) and too long for
NUMA or TLB (sub-µs). Multi-millisecond on a JVM almost always means "the world stopped."

I confirm by **correlation, not hypothesis**, because guessing wastes days:
- Turn on **safepoint logging** (`-Xlog:safepoint`) and **GC logging** with timestamps, and
  **align them against the latency-spike timestamps** from my HdrHistogram (loop [I01.Q4]). If
  every 4 ms spike lines up with a safepoint/GC event → confirmed, and now I know whether it's
  collection work or time-to-safepoint (the log distinguishes "reaching safepoint" from "at
  safepoint").
- If the spikes *don't* align with any JVM event, it's **below the JVM** — and I escalate to
  OS-level tools: `perf` to catch what the CPU was doing, `/proc/interrupts` deltas around the
  spike, `ftrace`/`bpftrace` to catch scheduler migrations and page faults, and cross-checking
  C-state residency. The discipline is **timestamp everything and correlate** — the spike has a
  cause that left a fingerprint somewhere, and you find it by lining up clocks, not by theory.

The meta-point the panel wants: **at this tier, performance engineering is jitter elimination,
and jitter lives in the OS and firmware, not your code.** You spend your time turning the
machine into a *deterministic* device — pinned cores, locked memory, routed interrupts,
disabled power management, huge pages, no swap — so that the only thing running on your
strategy core is your strategy, and the histogram's max collapses toward its median. A
beautiful mean with an ugly max means **the machine is still allowed to interrupt you**, and
the job isn't done until you've taken that permission away.

──────────
> **[BANK]** Sub-µs path with multi-ms max = the **OS/hardware interrupting the thread**, not
> your logic. Jitter rogues' gallery: GC/safepoint stalls (the multi-ms ones), page faults
> (→ `mlockall` + no swap), TLB misses (→ huge pages), IRQs (→ IRQ affinity away from your
> core, `nohz_full`), C-states/freq scaling (→ disable C-states, pin frequency), migration
> (→ pin), NUMA, even SMIs. Confirm by **correlating spike timestamps with safepoint/GC/perf
> logs**, not guessing.
> **[TRAP]** Optimizing the mean while ignoring the max (the max is what HFT prices); guessing
> at causes instead of correlating timestamps; leaving power management / swap / IRQs on.
> **[GO DEEPER]** loop [R2.Q8] safepoints/TTSP · [I01.Q2] GC · [I01.Q4] measuring the tail you're
> hunting.

---

### [I01.Q7] "Wall-clock time is useless to you. So how do you order events across machines to the nanosecond?"  ·  ★★★★☆

**Interviewer:** You need to know, to the nanosecond, whether your order reached the exchange
before a competitor's market-data update — across different machines. NTP is milliseconds off.
How?

**Candidate:** NTP (millisecond accuracy) is **useless** at this scale — you can't order
nanosecond events with a millisecond-skewed clock (loop [R3.Q8], wall clocks lie). HFT solves
it with **hardware time synchronization** plus careful local timestamping:

1. **PTP (Precision Time Protocol, IEEE 1588)** instead of NTP. PTP synchronizes clocks across
   the network to **sub-microsecond, often nanosecond** accuracy, by (a) **hardware-
   timestamping** packets *at the NIC* (so the timestamp is taken on the wire, not in software
   where jitter lives) and (b) measuring path delay precisely with a master clock. The key is
   the **NIC does the timestamping in hardware** — software timestamps include all the OS
   jitter you're trying to escape.
2. **A grandmaster clock disciplined by GPS/atomic** — the network's PTP master is locked to
   GPS (which is locked to atomic time), so every machine's clock traces back to a true,
   physical time source. This is the same idea as Spanner's TrueTime (loop [R3.Q8]) — buy
   *real* synchronized physical time with special hardware — just applied to a trading network
   instead of a global database.
3. **Local timestamping with the invariant TSC** (loop [I01.Q4]) for the sub-event timing
   within a machine, disciplined to the PTP clock.

So the answer is: **you don't trust software clocks at all — you push timestamping into
hardware (NIC PTP) disciplined by GPS, getting nanosecond cross-machine accuracy.**

**Interviewer:** Even with perfect clocks, two events can be genuinely simultaneous or
ordering-ambiguous. Does the exchange care about your timestamp at all?

**Candidate:** Sharp point — and the honest answer is **the exchange uses *its own* clock and
its own arrival order, not mine.** This is where the distributed-systems humility comes in
(loop [R3.Q8]): my beautifully synchronized timestamp tells *me* when my packet left, but **the
only ordering that determines who gets filled is the exchange's matching engine's view** — the
sequence in which *it* received and processed the messages at its own gateway. So:

- **The exchange is the single source of truth for ordering.** It assigns sequence numbers as
  messages hit its matching engine; that total order is authoritative (a centralized sequencer,
  which is how you *avoid* the distributed-ordering problem entirely — one machine decides).
  My job isn't to *prove* I was first with my clock; it's to *actually arrive* first at the
  exchange's gateway.
- **My nanosecond clocks are for *my* analysis** — measuring my own tick-to-trade, debugging
  which leg of my path was slow, reconstructing event order across *my* machines for
  post-trade analysis, and proving to myself that a strategy decision used data that genuinely
  preceded it. They don't win me the trade; **being physically faster does.**
- And there's a real causality subtlety: with synchronized clocks I can detect when two of *my*
  events are so close they're effectively concurrent (loop [R3.Q8] — even perfect physical time
  has an uncertainty interval ε), and I shouldn't pretend an ordering that's within my clock's
  error bars is real.

The framing: **synchronize clocks to nanoseconds with PTP+GPS so you can measure and reason
about your own system precisely — but understand that cross-machine *event ordering that
matters* is decided by a central authority (the exchange's sequencer), not by comparing
distributed timestamps.** It's the same lesson as the loop's logical clocks, inverted: HFT can
afford near-perfect *physical* clocks, but it still defers the *authoritative* order to a
single sequencer, because that's the only thing that's actually true.

──────────
> **[BANK]** NTP (ms) is useless at ns scale → **PTP/IEEE-1588** with **NIC hardware
> timestamping** disciplined by a **GPS/atomic grandmaster** gives ns cross-machine accuracy
> (the HFT version of Spanner TrueTime). But the **exchange's central sequencer** decides the
> *authoritative* order, not your timestamps — your job is to physically arrive first; your
> clocks are for measuring/analyzing your own path.
> **[TRAP]** Trusting software/NTP clocks for ns ordering; believing your synchronized
> timestamp wins the trade (the exchange's arrival order does); ignoring the clock-uncertainty
> interval and over-claiming an ordering within your error bars.
> **[GO DEEPER]** loop [R3.Q8] logical clocks/TrueTime · [I01.Q4] invariant TSC · [I01.Q1]
> co-location (arriving first physically).

---

### [I01.Q8] "Sell me on staying on the JVM. Your competitor rewrote in C++ and FPGA. Why aren't you wrong?"  ·  ★★★★★

**Interviewer:** Everything you've described — zero-alloc, pinning, busy-poll — is fighting the
JVM. Your competitor put their strategy in C++ and their fast path in an FPGA. Defend the JVM,
or concede.

**Candidate:** I'd defend it for a *specific tier* of the latency game and concede the
*extreme* tier honestly — because pretending the JVM beats an FPGA on raw latency would be a
lie the panel would catch instantly.

**Where the JVM genuinely competes (and why firms really do run Java in trading):**
- **The JIT produces excellent code** once warmed — for steady, hot, monomorphic paths, C2/
  Graal generate native code competitive with C++. The arithmetic and branchy strategy logic
  aren't where Java loses; the **allocation and pauses** are, and I've designed those out
  (zero-alloc, off-heap, ZGC/Epsilon).
- **Developer velocity and safety.** Strategy logic changes *constantly* — that's the business.
  Java's faster iteration, memory safety (no segfaults taking down the trading day), and richer
  tooling/observability mean you ship and adjust strategies faster, with fewer catastrophic
  bugs, than in C++. At the **microsecond** tier (not nanosecond), that velocity is worth more
  than the last few hundred ns, and the firm makes money on *good strategies shipped fast*, not
  only on raw speed.
- **You can get within a small multiple** of C++ with the disciplines I described, and for many
  strategies that's well inside the winning envelope.

**Interviewer:** Don't hedge — tell me precisely where the JVM *loses* and you'd reach for
something else.

**Candidate:** Happily, because pretending it wins everywhere is the tell of someone who hasn't
shipped at this tier. Where I concede, and naming it precisely is the point:
- **The nanosecond tier belongs to hardware.** For the absolute fastest path — simple, fixed
  logic like "if price crosses X, fire this pre-baked order" — an **FPGA** (or ASIC) wins
  decisively: the logic runs **in the NIC silicon, tick-to-trade in tens of nanoseconds**,
  with no CPU, no OS, no JVM, no jitter at all. No software language competes; the comparison
  isn't C++ vs Java, it's *software vs no software*. Conceding this isn't weakness — it's
  knowing the tool boundary.
- **C++ wins the deterministic, no-runtime tier** where you want zero GC by *language*
  (RAII/stack allocation), no warmup, and full control — for the hottest software path that's
  still too complex for an FPGA, C++ is the right call, and I wouldn't fight it.

So my actual position — and it's a *judgment*, not a loyalty: **architect by tier.** Put the
**simplest, hottest, fixed logic in the FPGA** (tens of ns); put the **complex hot path that
must be deterministic** in C++; and run the **rich, fast-evolving strategy logic and the
broader platform** on a carefully-tuned JVM, where developer velocity and safety pay for
themselves and the JVM is fast *enough* (µs) because I've removed its weaknesses. The firms that
win don't religiously pick one runtime — they **match each piece of the path to the tier its
latency requirement demands**, and the JVM has a real, defensible place in that hierarchy as
long as you're honest that it's not the floor. Defending Java *everywhere* would be as wrong as
the C++ purist who hand-rolls a hash map the JIT would've optimized better — the senior move is
knowing exactly which tier you're in.

──────────
> **[BANK]** Architect the latency path **by tier**: fixed simplest logic → **FPGA/ASIC** (tens
> of ns, no software/OS/jitter — software can't compete); complex deterministic hot path →
> **C++** (no-runtime, RAII, no warmup); rich fast-evolving strategy + platform → **tuned JVM**
> (JIT is competitive once hot; zero-alloc/off-heap/ZGC remove its weaknesses; developer
> velocity + memory safety pay off at the µs tier). Match the piece to the tier; don't pick one
> runtime religiously.
> **[TRAP]** Defending the JVM at the nanosecond tier (FPGA wins, it's not even a language
> comparison) *or* dismissing the JVM entirely (ignores velocity/safety and that the JIT is
> fast once warm). Both are tier-confusion.
> **[GO DEEPER]** [I01.Q1] co-location/NIC · [I01.Q2] zero-alloc making the JVM viable · loop
> [R5.Q4] tune-vs-rewrite judgment.

---

## Closing note — the HFT floor

Every question here collapsed to one obsession: **determinism**. Not "fast on average" —
*predictable to the nanosecond*, which means understanding and then *removing* every source of
variance the machine can inject: the kernel (bypass it), the GC (design it out), the cache
(respect the lines), the scheduler and interrupts (pin and route them away), the clock
(synchronize it in hardware), and even the language runtime (tier it). The candidate who wins
here doesn't know more APIs — they've internalized that at this scale **the computer is a
physical device with geometry and timing**, and the job is to make that device do exactly one
thing, the same way, every time. The mean is vanity; the max is the truth.

→ Back to the [interview floor](./00-interviews-index.md) · related: loop
[R2](../02-round-2-internals.md) (the internals this round weaponizes).
