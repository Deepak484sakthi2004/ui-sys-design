# Java Concurrency Patterns — Deep Dive
## Senior Java LLD Reference | JVM-Level | Interview-Ready

---

## Java Memory Model (JMM)

### Happens-Before (HB) Relationship
The JMM defines visibility and ordering guarantees via happens-before. If action A happens-before action B, then A's effects (writes) are visible to B.

**Key HB edges:**
| Action | Happens-Before |
|---|---|
| `synchronized` block exit | Entry to the same monitor by another thread |
| `volatile` write | Any subsequent `volatile` read of the same variable |
| `Thread.start()` | Any action in the started thread |
| Any action in a thread | `Thread.join()` returning in another thread |
| Static initializer completion | Any thread accessing a class |
| `final` field write in constructor | Any read after constructor returns |

**Without HB, there is no visibility guarantee** — the JIT/CPU can reorder, cache writes, or defer visibility.

### volatile — Visibility + Ordering, Not Atomicity
```java
// volatile guarantees:
// 1. Visibility: writes immediately visible to all threads (no CPU cache)
// 2. Ordering: no reordering of reads/writes across a volatile access
//    (StoreLoad + LoadLoad + StoreStore + LoadStore barriers)

// volatile IS sufficient for:
volatile boolean shutdownRequested = false; // flag read/written by one thread, read by many

// volatile is NOT sufficient for:
volatile int counter = 0;
counter++; // read-modify-write is NOT atomic even with volatile
// Thread A reads 0, Thread B reads 0, Thread A writes 1, Thread B writes 1 — lost update

// Need AtomicInteger or synchronized for compound operations
AtomicInteger atomicCounter = new AtomicInteger(0);
atomicCounter.incrementAndGet(); // CAS-based, atomic
```

### synchronized — Mutual Exclusion + Visibility
```java
public class SafeCounter {
    private int count = 0;
    private final Object lock = new Object();

    public synchronized void increment() {
        count++; // only one thread at a time, and JMM guarantees visibility on monitor exit
    }

    public synchronized int getCount() {
        return count; // monitor acquisition ensures we see the latest value
    }
}
// synchronized provides:
// 1. Mutual exclusion: only one thread in the critical section
// 2. Memory barrier: on exit, all writes flushed; on entry, all reads from memory
// Cost: contention causes thread scheduling (context switch = ~1-10 microseconds)
```

### Memory Model Reordering — The DCL Example
```java
// Without volatile:
class Broken {
    private static Broken instance;
    public static Broken getInstance() {
        if (instance == null) {
            synchronized (Broken.class) {
                if (instance == null) {
                    instance = new Broken(); // CPU may reorder:
                    // 1. allocate memory
                    // 3. assign reference to instance  <-- reordered BEFORE step 2!
                    // 2. initialize fields
                    // Thread B sees non-null instance, reads uninitialized fields
                }
            }
        }
        return instance; // could return partially initialized object
    }
}
// volatile on instance prevents this reordering (StoreStore barrier after construction)
```

---

## Producer-Consumer Pattern

### BlockingQueue (Production Code)
```java
// ArrayBlockingQueue: bounded, backed by array, fair optional
// LinkedBlockingQueue: optionally bounded, separate head/tail locks (higher throughput)
// PriorityBlockingQueue: unbounded, priority-ordered
// DelayQueue: elements have delay, take() blocks until delay expires
// SynchronousQueue: zero capacity — producer blocks until consumer ready

public class MessagePipeline<T> {
    private final BlockingQueue<T> queue;
    private final int workers;
    private final Consumer<T> processor;
    private final ExecutorService executorService;
    private volatile boolean running = true;

    public MessagePipeline(int capacity, int workers, Consumer<T> processor) {
        this.queue = new ArrayBlockingQueue<>(capacity); // bounded — backpressure!
        this.workers = workers;
        this.processor = processor;
        this.executorService = Executors.newFixedThreadPool(workers);
    }

    public void start() {
        for (int i = 0; i < workers; i++) {
            executorService.submit(this::consumeLoop);
        }
    }

    private void consumeLoop() {
        while (running || !queue.isEmpty()) {
            try {
                T item = queue.poll(100, TimeUnit.MILLISECONDS); // timeout to check `running`
                if (item != null) processor.accept(item);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    public boolean produce(T item) throws InterruptedException {
        return queue.offer(item, 1, TimeUnit.SECONDS); // backpressure: block if full
    }

    public void shutdown() throws InterruptedException {
        running = false;
        executorService.shutdown();
        executorService.awaitTermination(10, TimeUnit.SECONDS);
    }
}
```

### Hand-Rolled with wait/notify (Interview Version)
```java
public class BoundedBuffer<T> {
    private final Queue<T> buffer = new LinkedList<>();
    private final int capacity;
    private final Object lock = new Object();

    public BoundedBuffer(int capacity) { this.capacity = capacity; }

    public void put(T item) throws InterruptedException {
        synchronized (lock) {
            while (buffer.size() == capacity) { // while — not if (spurious wakeups!)
                lock.wait(); // releases lock and waits
            }
            buffer.add(item);
            lock.notifyAll(); // wake all waiters (consumers and producers)
        }
    }

    public T take() throws InterruptedException {
        synchronized (lock) {
            while (buffer.isEmpty()) {
                lock.wait();
            }
            T item = buffer.poll();
            lock.notifyAll();
            return item;
        }
    }
}
// CRITICAL: always use while loop for wait(), not if loop
// Spurious wakeups: JVM/OS can wake a thread without notify being called
// After wakeup, condition must be re-checked
```

**`notifyAll()` vs `notify()`:** `notify()` wakes one random waiter — if wrong thread (e.g., woke another producer when buffer is full), no progress. `notifyAll()` wakes all, all re-check condition, correct one proceeds. Use `notify()` only when exactly one thread can benefit AND all waiting threads can make progress.

---

## Read-Write Lock

```java
public class ReadWriteCache<K, V> {
    private final Map<K, V> map = new HashMap<>();
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final ReentrantReadWriteLock.ReadLock readLock = rwLock.readLock();
    private final ReentrantReadWriteLock.WriteLock writeLock = rwLock.writeLock();

    public V get(K key) {
        readLock.lock();
        try {
            return map.get(key); // many readers concurrently
        } finally {
            readLock.unlock(); // always in finally
        }
    }

    public void put(K key, V value) {
        writeLock.lock();
        try {
            map.put(key, value); // exclusive write
        } finally {
            writeLock.unlock();
        }
    }

    public V computeIfAbsent(K key, Function<K, V> loader) {
        // Read first (optimistic)
        readLock.lock();
        V value;
        try {
            value = map.get(key);
        } finally {
            readLock.unlock();
        }
        if (value != null) return value;

        // Upgrade to write lock (cannot upgrade directly — must release read lock first)
        writeLock.lock();
        try {
            // Double-check after acquiring write lock (another thread may have put it)
            value = map.get(key);
            if (value == null) {
                value = loader.apply(key);
                map.put(key, value);
            }
            return value;
        } finally {
            writeLock.unlock();
        }
    }
}
```

**Writer starvation:** If readers arrive continuously, the writer may wait indefinitely. `ReentrantReadWriteLock(true)` (fair mode) uses a queue — prevents starvation but reduces throughput. `StampedLock` (Java 8+) supports optimistic reads which are even faster.

**StampedLock optimistic read:**
```java
StampedLock sl = new StampedLock();
long stamp = sl.tryOptimisticRead();
// read data
if (!sl.validate(stamp)) { // check if a write happened since tryOptimisticRead
    stamp = sl.readLock(); // fall back to read lock
    try { /* re-read */ } finally { sl.unlockRead(stamp); }
}
```

---

## Semaphore — Rate Limiting & Connection Pool

```java
// Semaphore: N permits — at most N threads concurrent
public class ConnectionPool {
    private final ArrayBlockingQueue<Connection> connections;
    private final Semaphore semaphore;

    public ConnectionPool(String url, int size) throws SQLException {
        this.semaphore = new Semaphore(size, true); // fair
        this.connections = new ArrayBlockingQueue<>(size);
        for (int i = 0; i < size; i++) {
            connections.offer(DriverManager.getConnection(url));
        }
    }

    public Connection acquire(long timeout, TimeUnit unit) throws InterruptedException, SQLException {
        if (!semaphore.tryAcquire(timeout, unit)) {
            throw new SQLException("Connection pool exhausted after " + timeout + " " + unit);
        }
        return connections.poll(); // semaphore ensures always non-null here
    }

    public void release(Connection conn) {
        connections.offer(conn);
        semaphore.release();
    }
}

// Rate limiter using Semaphore + scheduled refill
public class RateLimiterSemaphore {
    private final Semaphore semaphore;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    public RateLimiterSemaphore(int permitsPerSecond) {
        this.semaphore = new Semaphore(permitsPerSecond);
        scheduler.scheduleAtFixedRate(
            () -> {
                int deficit = permitsPerSecond - semaphore.availablePermits();
                if (deficit > 0) semaphore.release(deficit);
            },
            1, 1, TimeUnit.SECONDS
        );
    }

    public boolean tryAcquire() { return semaphore.tryAcquire(); }
}
```

---

## CountDownLatch, CyclicBarrier, Phaser

```java
// CountDownLatch — one-time gate: wait for N events, then proceed
// Use case: wait for N services to initialize before starting
CountDownLatch startLatch = new CountDownLatch(3);

for (int i = 0; i < 3; i++) {
    final int serviceNum = i;
    executor.submit(() -> {
        initService(serviceNum);
        startLatch.countDown(); // decrement
    });
}
startLatch.await(); // blocks until count reaches 0
System.out.println("All services ready, starting application");

// CyclicBarrier — reusable barrier: all threads wait until all arrive, then proceed together
// Use case: game rounds, batch processing phases
CyclicBarrier barrier = new CyclicBarrier(4, () -> {
    // Runs when all 4 threads hit the barrier
    System.out.println("All threads at checkpoint, advancing to next phase");
});

for (int i = 0; i < 4; i++) {
    executor.submit(() -> {
        doPhase1Work();
        barrier.await(); // wait for all 4 threads
        doPhase2Work();
        barrier.await(); // reuse for next phase — CyclicBarrier resets!
    });
}

// Phaser — most powerful: variable party count, multiple phases
Phaser phaser = new Phaser(1); // register "main" thread
for (int i = 0; i < 5; i++) {
    phaser.register(); // dynamic registration
    executor.submit(() -> {
        doWork();
        phaser.arriveAndAwaitAdvance(); // signal done, wait for all
        doMoreWork();
        phaser.arriveAndDeregister(); // done, deregister
    });
}
phaser.arriveAndDeregister(); // main thread deregisters

// Key differences:
// CountDownLatch: one-shot, count only goes down
// CyclicBarrier: resets after each barrier; optional barrier action; BrokenBarrierException if thread dies
// Phaser: dynamic party count, multiple phases, tree of phasers for large parallel workloads
```

---

## ThreadLocal — Use Cases and Pitfalls

```java
// Use case: per-request context without passing through every method
public class RequestContext {
    private static final ThreadLocal<RequestContext> CONTEXT = ThreadLocal.withInitial(RequestContext::new);

    private String requestId;
    private String userId;
    private Instant startTime;

    public static RequestContext current() { return CONTEXT.get(); }

    public static void set(String requestId, String userId) {
        RequestContext ctx = CONTEXT.get();
        ctx.requestId = requestId;
        ctx.userId = userId;
        ctx.startTime = Instant.now();
    }

    public static void clear() {
        CONTEXT.remove(); // CRITICAL — must call in finally block
    }

    // Spring's RequestContextHolder uses exactly this pattern
}

// Usage in servlet filter
public class RequestContextFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        try {
            RequestContext.set(
                ((HttpServletRequest) req).getHeader("X-Request-ID"),
                ((HttpServletRequest) req).getRemoteUser()
            );
            chain.doFilter(req, res);
        } finally {
            RequestContext.clear(); // MANDATORY — thread pool reuses threads!
        }
    }
}
```

**Memory leak pitfall — Thread Pools:**
Thread pool threads are long-lived. If `ThreadLocal.remove()` is not called, the `ThreadLocal` value persists on the thread indefinitely. In a web server handling thousands of requests, this leaks:
1. The value objects themselves
2. In ClassLoader-based leaks: `Thread.threadLocals` holds strong refs to ClassLoader's classes, preventing ClassLoader GC. This is a classic cause of `PermGen`/`Metaspace` leaks in deploy-redeploy scenarios.

**Rule:** Always call `ThreadLocal.remove()` in a `finally` block when using ThreadLocal with thread pools.

---

## CompletableFuture — Deep Dive

### Core Operations
```java
// Supply async work
CompletableFuture<User> userFuture = CompletableFuture.supplyAsync(
    () -> userRepository.findById(userId), // runs in ForkJoinPool.commonPool() by default
    customExecutor // RECOMMENDED: provide custom executor to avoid common pool saturation
);

// Transform result (thenApply — synchronous transformation, runs in completing thread)
CompletableFuture<UserDTO> dtoFuture = userFuture.thenApply(UserMapper::toDTO);

// Chain async operation (thenCompose — like flatMap, avoids nested CompletableFuture<CF<T>>)
CompletableFuture<Order> orderFuture = userFuture
    .thenCompose(user -> CompletableFuture.supplyAsync(
        () -> orderRepository.findLatestByUser(user.getId()),
        customExecutor
    ));

// Combine two independent futures
CompletableFuture<String> userFuture2 = CompletableFuture.supplyAsync(() -> fetchUser(), exec);
CompletableFuture<String> orderFuture2 = CompletableFuture.supplyAsync(() -> fetchOrder(), exec);
CompletableFuture<String> combined = userFuture2.thenCombine(
    orderFuture2,
    (user, order) -> user + " -> " + order // called when BOTH complete
);

// Wait for all (allOf doesn't preserve types — use stream + join)
List<CompletableFuture<Product>> futures = productIds.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> fetchProduct(id), exec))
    .collect(Collectors.toList());

CompletableFuture<List<Product>> allProducts = CompletableFuture
    .allOf(futures.toArray(new CompletableFuture[0]))
    .thenApply(v -> futures.stream()
        .map(CompletableFuture::join) // safe here — all completed
        .collect(Collectors.toList()));
```

### Exception Handling
```java
CompletableFuture<User> result = CompletableFuture
    .supplyAsync(() -> {
        if (Math.random() < 0.5) throw new RuntimeException("Service down");
        return new User("Alice");
    }, exec)
    // exceptionally: recover from exception, return fallback
    .exceptionally(ex -> {
        log.warn("User fetch failed: " + ex.getMessage());
        return User.ANONYMOUS; // fallback value
    })
    // handle: always runs (exception or success) — can inspect both
    .handle((user, ex) -> {
        if (ex != null) return User.ANONYMOUS; // handle error
        return user;                            // pass through on success
    })
    // whenComplete: side effect only, doesn't transform
    .whenComplete((user, ex) -> {
        if (ex != null) metrics.incrementErrorCount();
        else metrics.recordSuccess();
    });
```

### Critical Pitfalls

**1. Blocking in async code (ForkJoinPool starvation):**
```java
// WRONG — blocks a ForkJoinPool thread, starving other tasks
CompletableFuture.supplyAsync(() -> {
    Connection conn = dataSource.getConnection(); // BLOCKING I/O in async thread!
    PreparedStatement ps = conn.prepareStatement(SQL);
    return ps.executeQuery(); // blocks entire FJ thread
});

// RIGHT — use dedicated I/O executor
ExecutorService ioExecutor = Executors.newFixedThreadPool(50); // sized for I/O concurrency
CompletableFuture.supplyAsync(() -> {
    // blocking I/O here is fine — dedicated thread pool sized for it
    return jdbcTemplate.queryForObject(SQL, rowMapper, id);
}, ioExecutor);
```

**2. thenApply vs thenApplyAsync:**
```java
// thenApply: transformation runs in the thread that completed the previous stage
// If supplyAsync completed in ioExecutor thread, thenApply also runs in that thread

// thenApplyAsync (no executor arg): runs in ForkJoinPool.commonPool()
// thenApplyAsync(executor): explicitly schedules on provided executor

// Implication: if your thenApply has a heavy CPU computation, use thenApplyAsync with cpuExecutor
future.thenApplyAsync(data -> heavyComputation(data), cpuExecutor);
```

**3. allOf() exception handling:**
```java
// If ANY future in allOf fails, the combined future fails
// BUT: remaining futures continue to run (no cancellation)
// AND: you don't know WHICH future failed unless you inspect each

CompletableFuture<Void> all = CompletableFuture.allOf(f1, f2, f3);
all.exceptionally(ex -> {
    // ex is the exception from the FIRST failed future — not all failures
    // To get all failures:
    Stream.of(f1, f2, f3)
        .filter(CompletableFuture::isCompletedExceptionally)
        .forEach(f -> f.exceptionally(e -> { log.error("Failed: " + e); return null; }));
    return null;
});
```

**4. join() in stream pipeline:**
```java
// WRONG — sequential: each join() waits for one future before starting next
List<Product> products = productIds.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> fetch(id), exec))
    .map(CompletableFuture::join) // BLOCKS HERE — sequential execution!
    .collect(Collectors.toList());

// RIGHT — collect futures first, then join all
List<CompletableFuture<Product>> futures = productIds.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> fetch(id), exec))
    .collect(Collectors.toList()); // all started before any joined

List<Product> products = futures.stream()
    .map(CompletableFuture::join) // now truly parallel
    .collect(Collectors.toList());
```

---

## Project Reactor — Mono/Flux

### subscribeOn vs publishOn — The Critical Distinction
```java
// subscribeOn: determines which thread the subscription chain starts on
// (affects upstream: source operator and operators before subscribeOn)
Mono.fromCallable(() -> blockingDbCall()) // runs in scheduler thread
    .subscribeOn(Schedulers.boundedElastic()) // <- moves the SOURCE to elastic pool
    .map(data -> transform(data))            // also runs in elastic pool thread
    .subscribe();

// publishOn: switches the execution context for DOWNSTREAM operators
Flux.range(1, 100)
    .publishOn(Schedulers.parallel())    // <- operators AFTER this run in parallel pool
    .map(n -> heavyCpuWork(n))           // runs in parallel thread
    .subscribe(result -> log(result));   // also in parallel thread

// Common pattern: I/O on boundedElastic, CPU on parallel
Flux.fromIterable(ids)
    .flatMap(id ->
        Mono.fromCallable(() -> fetchFromDb(id))
            .subscribeOn(Schedulers.boundedElastic()) // I/O thread per element
    )
    .publishOn(Schedulers.parallel()) // switch to CPU thread for processing
    .map(data -> processData(data))
    .subscribe();
```

**Schedulers:**
- `Schedulers.parallel()`: fixed thread pool (= CPU cores), for CPU-bound work
- `Schedulers.boundedElastic()`: elastic pool (max 10× CPUs, 100K queued tasks), for blocking I/O
- `Schedulers.single()`: single thread, for serialized ops
- `Schedulers.immediate()`: caller's thread (no switch)

### Backpressure
```java
// Without backpressure — fast publisher overwhelms slow subscriber
Flux.range(1, 1_000_000)
    .subscribe(n -> {
        Thread.sleep(1); // slow consumer
    }); // OOM — all 1M items buffered in memory

// With backpressure — subscriber requests at its own pace
Flux.range(1, 1_000_000)
    .onBackpressureBuffer(1000) // buffer up to 1000, then drop or error
    .subscribe(new BaseSubscriber<Integer>() {
        @Override
        protected void hookOnSubscribe(Subscription sub) {
            request(50); // pull-based: request 50 at a time
        }
        @Override
        protected void hookOnNext(Integer value) {
            process(value);
            request(1); // request one more after processing each
        }
    });
```

---

## Lock-Free Programming — CAS

### Compare-And-Swap
```java
// AtomicInteger — wraps volatile int with CAS operations
AtomicInteger counter = new AtomicInteger(0);

// Atomic increment — no lock needed
int newValue = counter.incrementAndGet(); // CAS in a loop under the hood

// Custom CAS loop (equivalent to what AtomicInteger does internally)
AtomicInteger value = new AtomicInteger(0);
public int addAndGet(int delta) {
    int current, next;
    do {
        current = value.get();    // read current volatile value
        next = current + delta;
    } while (!value.compareAndSet(current, next)); // CAS: set next ONLY IF current matches
    // If another thread changed value between get() and CAS, CAS fails — retry
    return next;
}
```

**ABA Problem:**
```java
// Thread A reads value = "A"
// Thread B changes A -> B
// Thread B changes B -> A  (back to original!)
// Thread A: CAS(A, C) SUCCEEDS — doesn't notice the intermediate change

// Solution: AtomicStampedReference — tag each value with a version number
AtomicStampedReference<String> ref = new AtomicStampedReference<>("A", 0);

int[] stampHolder = new int[1];
String current = ref.get(stampHolder); // get value AND stamp
int stamp = stampHolder[0];

// Later:
ref.compareAndSet(current, "newValue", stamp, stamp + 1);
// CAS fails if either value OR stamp has changed
```

### ConcurrentHashMap Internals
```java
// Java 7: segment locking
// 16 segments by default (Hashtable of Hashtables)
// Each segment is a ReentrantLock
// Concurrency level = number of segments = max concurrent writers
// Problem: segment distribution uneven, waste if few keys hot

// Java 8+: CAS + synchronized on bucket head
// Each bucket (array slot) is independently lockable
// Empty bucket: CAS to insert without lock
// Non-empty bucket: synchronized on the head node of the bucket's linked list / tree
// Concurrency = up to array length (default 16, resized to 32/64 etc.)
// At low contention: CAS (lock-free)
// At high contention: synchronize only on the specific bucket

// Tree conversion: when a bucket's linked list exceeds 8 entries,
// it becomes a TreeMap (red-black tree): O(log n) per lookup vs O(n)

// Why beats Collections.synchronizedMap:
// synchronizedMap uses a single monitor for ALL operations — true global lock
// ConcurrentHashMap locks at bucket granularity — full concurrency for different buckets
```

---

## ExecutorService Internals

### ThreadPoolExecutor Parameters
```java
ThreadPoolExecutor executor = new ThreadPoolExecutor(
    4,                                    // corePoolSize: always-alive threads
    16,                                   // maximumPoolSize: max threads (core + extra)
    60L, TimeUnit.SECONDS,                // keepAliveTime: idle extra thread survival
    new ArrayBlockingQueue<>(1000),       // workQueue: bounded (CRITICAL choice)
    new ThreadFactory() { /* naming */ }, // custom: name threads for debugging
    new ThreadPoolExecutor.CallerRunsPolicy() // rejection policy
);
```

**Queue choice — the most critical parameter:**

| Queue | Behavior | Risk |
|---|---|---|
| `ArrayBlockingQueue(n)` | Bounded. When full, new tasks rejected/block | Right choice — backpressure |
| `LinkedBlockingQueue()` | **Unbounded!** Default in `Executors.newFixedThreadPool` | OOM risk — tasks pile up |
| `SynchronousQueue` | No capacity — task must be immediately handed to thread | Risk: always spawns new thread up to max, then rejects |

```java
// DANGEROUS — default Executors.newFixedThreadPool uses unbounded queue!
ExecutorService dangerous = Executors.newFixedThreadPool(10);
// 1000s of tasks submitted? All queued in LinkedBlockingQueue — OOM

// SAFE — explicit bounded queue with rejection policy
ExecutorService safe = new ThreadPoolExecutor(
    10, 10, 0, TimeUnit.MILLISECONDS,
    new ArrayBlockingQueue<>(1000),
    new ThreadPoolExecutor.CallerRunsPolicy() // throttle the producer naturally
);
```

**Rejection policies:**
- `AbortPolicy` (default): throws `RejectedExecutionException`
- `CallerRunsPolicy`: runs task in the calling thread (natural backpressure)
- `DiscardPolicy`: silently drops task (dangerous — use only for truly best-effort work)
- `DiscardOldestPolicy`: drops oldest queued task, retries submission

### ForkJoinPool — Work Stealing
```java
// ForkJoinPool: each thread has its own deque of tasks
// When a thread runs out of work, it "steals" from another thread's deque tail
// Optimized for recursive divide-and-conquer tasks
ForkJoinPool forkJoinPool = new ForkJoinPool(Runtime.getRuntime().availableProcessors());

// RecursiveTask example — parallel merge sort
public class MergeSortTask extends RecursiveTask<int[]> {
    private final int[] array;
    private static final int THRESHOLD = 1000;

    @Override
    protected int[] compute() {
        if (array.length <= THRESHOLD) {
            return sequentialSort(array); // base case
        }
        int mid = array.length / 2;
        MergeSortTask left = new MergeSortTask(Arrays.copyOfRange(array, 0, mid));
        MergeSortTask right = new MergeSortTask(Arrays.copyOfRange(array, mid, array.length));

        left.fork(); // submit left to queue asynchronously
        int[] rightResult = right.compute(); // compute right in current thread
        int[] leftResult = left.join(); // wait for left

        return merge(leftResult, rightResult);
    }
}

// parallelStream() uses ForkJoinPool.commonPool()
// CompletableFuture.supplyAsync() WITHOUT executor also uses commonPool()
// Custom ForkJoinPool for stream:
ForkJoinPool pool = new ForkJoinPool(8);
pool.submit(() ->
    largeList.parallelStream().filter(...).collect(...)
).get();
```

**Common pool saturation:** If all common pool threads are blocked (e.g., waiting on I/O), `parallelStream()` and `CompletableFuture.supplyAsync()` tasks starve. **Always provide a custom executor for I/O operations in CompletableFuture.**

---

## Deadlock

### Four Necessary Conditions (Coffman)
1. **Mutual Exclusion:** resources held exclusively
2. **Hold-and-Wait:** thread holds one resource while waiting for another
3. **No Preemption:** resources cannot be forcibly taken
4. **Circular Wait:** thread A waits for B, B waits for A

```java
// Classic deadlock
Object lockA = new Object();
Object lockB = new Object();

Thread t1 = new Thread(() -> {
    synchronized (lockA) {
        Thread.sleep(100); // increase probability of interleaving
        synchronized (lockB) { /* work */ } // waits for B
    }
});

Thread t2 = new Thread(() -> {
    synchronized (lockB) {
        synchronized (lockA) { /* work */ } // waits for A
    }
});
// t1 holds A, waits for B; t2 holds B, waits for A — deadlock
```

**Prevention strategies:**

1. **Lock ordering:** always acquire locks in same order
```java
// Always acquire lockA before lockB — everywhere in the codebase
void transferMoney(Account from, Account to, BigDecimal amount) {
    Object first = from.getId() < to.getId() ? from : to;
    Object second = from.getId() < to.getId() ? to : from;
    synchronized (first) {
        synchronized (second) {
            from.debit(amount);
            to.credit(amount);
        }
    }
}
```

2. **Try-lock with timeout:**
```java
if (lockA.tryLock(1, TimeUnit.SECONDS)) {
    try {
        if (lockB.tryLock(1, TimeUnit.SECONDS)) {
            try { /* work */ }
            finally { lockB.unlock(); }
        }
        // lockB not acquired — back off, retry
    } finally { lockA.unlock(); }
}
```

3. **Use `java.util.concurrent` high-level abstractions** — avoid explicit locks when possible.

**Deadlock detection:** JVM thread dumps (`jstack`, `jcmd <pid> Thread.print`) show lock ownership and wait chains. Look for "BLOCKED (on object monitor)" with circular chains.

---

## Amdahl's Law Applied to Java

```
Speedup = 1 / (S + (1-S)/N)

Where:
S = serial fraction of work (cannot be parallelized)
N = number of processors/threads
```

```java
// If 20% of work is serial (S=0.2) and you have 16 cores:
// Max speedup = 1 / (0.2 + 0.8/16) = 1 / (0.2 + 0.05) = 4x
// NOT 16x — serial fraction limits parallelism

// Practical Java implication:
// Every synchronized block is serial work
// Every lock acquisition under contention adds to S
// I/O waits add to S from the perspective of useful work

// Example: web app with 10% time in DB connection pool wait
// Adding more threads beyond the pool size gives 0 speedup
// (they all block waiting for pool slot — 100% serial at that point)

// Diminishing returns — measure before adding threads:
// 1. Profile: what % of time is truly parallelizable?
// 2. Check lock contention: high contention = serial work
// 3. Check GC: more threads = more allocation = more GC = more serial STW pauses
```
