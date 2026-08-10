# Chapter 18: LLD Worked Problems

> **Relearning log.** Running the [Ch 17 process](17-ood-solid-and-patterns.md) on real problems is
> where it clicked that LLD is mostly about **(1) the right set of classes, (2) the one or two
> patterns that fit, and (3) the concurrency story** — and that I should resist gold-plating. Each
> problem below shows the class model, the pattern choice with its *why*, and the thread-safety
> concern, because that triad is exactly what's scored. I keep the code at "interview fidelity" —
> enough to be concrete, not a full app.

---

## 18.1 Parking lot (the canonical LLD warm-up)

**Clarify.** Multiple levels; spots of types (compact/large/handicapped/EV); vehicles of types;
park/unpark; fee by duration; find a spot fast; concurrent entries at gates.

**Entities & relationships.**

```
ParkingLot 1──* Level 1──* ParkingSpot ──assigned── Vehicle (abstract)
   │                                                    ▲
   ├── EntryGate / ExitGate                   Car · Bike · Truck · ElectricCar
   ├── Ticket (spot, vehicle, entryTime)
   └── FeeStrategy (Strategy)  · SpotFinder
```

**Patterns applied (and why):**
- **Strategy** for `FeeStrategy` — flat / hourly / weekend pricing swappable without touching the lot.
- **Factory** for creating the right `Vehicle` / spot-type matching.
- (Optionally **Observer** to notify a display board when occupancy changes — only if asked.)

```java
abstract class Vehicle { abstract SpotType requiredSpot(); }
class Car extends Vehicle { SpotType requiredSpot() { return SpotType.COMPACT; } }

class ParkingSpot {
    final int id; final SpotType type;
    private final AtomicReference<Vehicle> occupant = new AtomicReference<>();   // CAS, no lock
    boolean tryPark(Vehicle v) { return occupant.compareAndSet(null, v); }       // atomic claim
    void free() { occupant.set(null); }
    boolean isFree() { return occupant.get() == null; }
}

interface FeeStrategy { Money fee(Duration parked); }                            // Strategy

class ParkingLot {
    private final List<Level> levels;
    private final FeeStrategy feeStrategy;
    Ticket park(Vehicle v) {
        for (Level lvl : levels) {
            ParkingSpot spot = lvl.findAndClaim(v);   // returns a spot it CAS-claimed, or null
            if (spot != null) return new Ticket(spot, v, Instant.now());
        }
        throw new NoSpotAvailableException();
    }
    Money unpark(Ticket t) {
        t.spot().free();
        return feeStrategy.fee(Duration.between(t.entryTime(), Instant.now()));
    }
}
```

**Concurrency story.** Two cars at two gates must not get the same spot → **CAS on each spot**
(`compareAndSet(null, v)`) so only the first claimer wins; no global lock, low contention. *That's*
the L5 point.

**Follow-ups:** spot-finding efficiency (a free-spot queue/count per type per level, not a scan);
EV charging spots; reservations; multi-lot.

---

## 18.2 Elevator system

**Clarify.** N elevators, M floors; external hall calls (up/down) + internal car requests; a
**scheduling strategy** to pick which car serves a call; direction-aware service (SCAN/LOOK).

**Entities.** `ElevatorSystem` → `ElevatorCar*`; `Request` (floor, direction); `Scheduler`
(Strategy); each `ElevatorCar` has a `State` (moving-up / moving-down / idle / doors-open).

**Patterns:**
- **Strategy** for the scheduling algorithm (nearest-car, SCAN/LOOK, load-balanced) — swappable.
- **State** for the car's behavior per mode (what a button press does depends on current state).

```java
interface Scheduler { ElevatorCar chooseCar(List<ElevatorCar> cars, Request r); }
class NearestCarScheduler implements Scheduler {
    public ElevatorCar chooseCar(List<ElevatorCar> cars, Request r) {
        return cars.stream()
            .filter(c -> c.canServe(r))                  // moving toward r in the same direction, or idle
            .min(Comparator.comparingInt(c -> c.distanceTo(r.floor())))
            .orElse(null);
    }
}

class ElevatorCar {
    private volatile Direction direction = Direction.IDLE;
    private final TreeSet<Integer> upStops = new TreeSet<>();        // sorted stops while going up
    private final TreeSet<Integer> downStops = new TreeSet<>(Comparator.reverseOrder());
    synchronized void addStop(int floor) { /* route to up/downStops by current position+direction */ }
    // step(): pop next stop in current direction (LOOK), flip direction when none ahead.
}
```

**Concurrency.** Requests arrive from many threads (button presses) → guard each car's stop sets
(`synchronized`/concurrent set); the scheduler reads car state atomically.

**Follow-ups:** SCAN vs LOOK; starvation (a far floor never served — age requests); express elevators;
optimizing average wait vs throughput.

---

## 18.3 Rate limiter (object model)

(System-level design is in [Ch 16](16-system-design-worked-problems.md); here it's the *class*
design.)

```java
interface RateLimiter { boolean allow(String clientId); }            // Strategy: swap algorithms

class TokenBucketLimiter implements RateLimiter {
    private final long capacity; private final double refillPerSec;
    private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

    public boolean allow(String clientId) {
        Bucket b = buckets.computeIfAbsent(clientId, k -> new Bucket(capacity, refillPerSec));
        return b.tryConsume();                                        // per-bucket lock = low contention
    }
    static class Bucket {
        private double tokens; private final double cap, rate; private long lastRefillNanos;
        synchronized boolean tryConsume() {
            refill();                                                 // add tokens for elapsed time
            if (tokens >= 1) { tokens -= 1; return true; }
            return false;
        }
        private void refill() { /* tokens = min(cap, tokens + elapsed*rate); update lastRefillNanos */ }
    }
}
```

**Patterns:** Strategy (`RateLimiter` interface → token-bucket / sliding-window / fixed-window
implementations). **Concurrency:** per-client `Bucket` with its own lock via `ConcurrentHashMap` →
no global bottleneck.

**Follow-ups:** distributed version (state in Redis, atomic Lua — see
[Ch 16](16-system-design-worked-problems.md)); tiers per client; cleanup of idle buckets.

---

## 18.4 In-memory key-value store with TTL & LRU

**Clarify.** `get/put/delete`; per-key TTL with expiry; bounded size with LRU eviction; thread-safe.

```java
class KVStore<K, V> {
    private final int capacity;
    private final LinkedHashMap<K, Entry<V>> map;            // accessOrder=true → LRU recency

    KVStore(int capacity) {
        this.capacity = capacity;
        this.map = new LinkedHashMap<>(16, 0.75f, true) {     // access-order
            protected boolean removeEldestEntry(Map.Entry<K, Entry<V>> e) { return size() > KVStore.this.capacity; }
        };
    }
    synchronized V get(K key) {
        Entry<V> e = map.get(key);
        if (e == null) return null;
        if (e.isExpired()) { map.remove(key); return null; }  // lazy expiry on read
        return e.value;
    }
    synchronized void put(K key, V value, long ttlMillis) {
        map.put(key, new Entry<>(value, System.currentTimeMillis() + ttlMillis));
    }
    static class Entry<V> { final V value; final long expiryAt;
        Entry(V v, long e){ value=v; expiryAt=e; } boolean isExpired(){ return System.currentTimeMillis() > expiryAt; } }
}
```

**Design points worth narrating:** `LinkedHashMap` with `accessOrder=true` gives **O(1) LRU** for
free (or build it explicitly with a `HashMap` + doubly-linked list — interviewers often want that
version). **Lazy expiry** on read + an optional **background sweeper** for proactive cleanup.
**Concurrency:** `synchronized` here for simplicity; mention striped locks / `ConcurrentHashMap` +
a concurrent LRU for higher throughput.

**Follow-ups:** the explicit O(1) LRU (HashMap + DLL) — a classic standalone problem; sharded locks;
eviction policy as a Strategy (LRU/LFU/FIFO).

---

## 18.5 Splitwise (expense sharing)

**Clarify.** Users, groups; add an expense split equally / by exact amounts / by percentage; track
who-owes-whom; simplify debts; show balances.

**Entities.** `User`, `Group`, `Expense` (payer, amount, **SplitStrategy**, participants),
`BalanceSheet` (a `Map<UserPair, Money>` net balances).

**Patterns:** **Strategy** for the split type (equal / exact / percentage) — the textbook fit.

```java
interface SplitStrategy { Map<User, Money> split(Money total, List<User> participants, Map<User,?> meta); }
class EqualSplit implements SplitStrategy { /* total / n each */ public Map<User,Money> split(...){ return null; } }
class PercentSplit implements SplitStrategy { /* validate sums to 100% */ public Map<User,Money> split(...){ return null; } }

class ExpenseService {
    private final Map<User, Map<User, Money>> balances = new ConcurrentHashMap<>();  // owed[a][b]
    void addExpense(User payer, Money amount, List<User> participants, SplitStrategy strategy, Map<User,?> meta) {
        Map<User, Money> shares = strategy.split(amount, participants, meta);
        shares.forEach((u, owed) -> { if (!u.equals(payer)) recordDebt(u, payer, owed); });
    }
    // recordDebt updates balances atomically; netting cancels mutual debts.
}
```

**Design points:** balance representation (net pairwise vs a graph); **debt simplification** (a
min-cash-flow problem — reduce the number of transactions; a nice "do you know graphs?" follow-up).
**Concurrency:** concurrent expense additions → atomic balance updates.

**Follow-ups:** debt simplification algorithm; multi-currency; group vs non-group; settle-up flow.

---

## 18.6 The recurring shape

> Across all of these the scored triad is identical: **a minimal clean class model + the one or two
> patterns the requirement actually needs (almost always Strategy, sometimes State/Observer/Factory)
> + an explicit concurrency story with the narrowest correct synchronization.** Plus restraint — I
> name patterns I'd add *if* a requirement appears, rather than adding them now.

## Interview Drills

- **D18.1 [E]** Design a parking lot; defend CAS-per-spot over a global lock.
- **D18.2 [M]** Design an LRU cache with O(1) get/put using a HashMap + doubly-linked list (the
  explicit version).
- **D18.3 [M]** Design Splitwise; which pattern handles equal/exact/percent splits, and why?
- **D18.4 [M]** Design a vending machine or order-lifecycle — show the State pattern transitions.
- **D18.5 [H]** Design an elevator scheduler; compare nearest-car vs SCAN/LOOK and handle starvation.
- **D18.6 [H]** Make the in-memory KV store thread-safe at high throughput (beyond one big lock).

## Key Takeaways

1. **Every LLD reduces to: clean class model + the *one* fitting pattern + an explicit concurrency
   story.** Show all three.
2. **Strategy is the most common LLD pattern** (pricing, splits, scheduling, rate-limit algorithms);
   State for lifecycles; Factory for construction; Observer for notifications.
3. **Concurrency is where seniority shows** — name the shared mutable state and use the narrowest fix
   (CAS / per-resource lock / concurrent collection) over a global lock.
4. **`LinkedHashMap(accessOrder=true)` is free LRU;** know the explicit HashMap+DLL version too.
5. **Restraint wins** — minimal model, patterns only when the requirement demands, and say what
   you'd add *if* a requirement appears.
