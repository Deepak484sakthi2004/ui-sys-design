# Chapter 17: OOD, SOLID & the Patterns That Show Up

> **Relearning log.** I write OO code daily, so I assumed LLD would be free. The rust was different
> here: the LLD round is a **45-minute design conversation that produces clean class diagrams and
> compiling-ish Java**, and the failure mode is *over-engineering* — reaching for five design
> patterns to model a parking lot. The recovery: a **clarify → identify entities → define
> relationships → apply the *one* pattern that fits → handle concurrency** process, and a hard rule
> to *only introduce a pattern when the requirement demands it*. The other rust: I could use these
> patterns but couldn't crisply *name the problem each one solves* on demand. So this chapter is the
> OOD process, SOLID as a checklist, and the six patterns that actually appear — each tied to "the
> problem it solves."

[Ch 18](18-lld-worked-problems.md) applies this to full problems.

---

## 17.1 The LLD process (5 steps)

```
1. CLARIFY      requirements, the core use cases, what's in/out of scope
2. ENTITIES     identify the nouns → classes; the verbs → methods/behaviors
3. RELATIONSHIPS associations, composition (has-a), inheritance (is-a), multiplicity
4. PATTERN      apply the ONE pattern the requirement calls for (not five)
5. CONCURRENCY  where is shared mutable state? how do we make it thread-safe?
```

> The senior move in LLD is **restraint**. Junior candidates bolt on patterns to look clever; the
> signal is a clean, minimal model with the *one* abstraction the problem actually needs, and the
> judgment to say "I'd add a Strategy here *if* pricing rules grow, but for now a method is fine."

I also state **assumptions and extensibility**: "I'm modeling X; if requirement Y comes later, this
interface lets me add it without touching existing code" (that's the Open/Closed payoff, below).

---

## 17.2 SOLID — as a design checklist

| Principle | One-line meaning | Smell it catches |
|-----------|------------------|------------------|
| **S — Single Responsibility** | one class, one reason to change | a class that parses *and* validates *and* persists |
| **O — Open/Closed** | open to extension, closed to modification | adding a new type forces edits to a giant `switch` |
| **L — Liskov Substitution** | subtypes must be usable as their base | `Square extends Rectangle` breaking `setWidth` |
| **I — Interface Segregation** | many small interfaces > one fat one | clients forced to implement methods they don't use |
| **D — Dependency Inversion** | depend on abstractions, not concretions | high-level code `new`-ing a concrete DB class |

> The two that earn the most signal in an LLD round are **Open/Closed** (model so new variants
> plug in via an interface, no `switch` edits) and **Dependency Inversion** (program to interfaces
> so things are testable and swappable). I explicitly call them out as I design.

```java
// Dependency Inversion + Open/Closed: payment processing open to new methods, closed to edits.
interface PaymentMethod { boolean pay(Money amount); }      // abstraction
class CreditCard implements PaymentMethod { public boolean pay(Money a) { /*...*/ return true; } }
class UpiPayment implements PaymentMethod { public boolean pay(Money a) { /*...*/ return true; } }

class Checkout {
    private final PaymentMethod method;                     // depends on abstraction
    Checkout(PaymentMethod method) { this.method = method; } // injected, not new-ed
    boolean process(Money amount) { return method.pay(amount); }
}
// Adding ApplePay later = new class, zero edits to Checkout. That's O + D.
```

---

## 17.3 The six patterns that actually appear (problem → pattern)

I memorize each as **"when you see this problem, reach for this."**

### Strategy — "interchangeable algorithms / behaviors at runtime"
Pricing rules, sorting orders, payment methods, ride-fare calculation, parking-fee policies.
Encapsulate each behavior behind an interface; inject the one you want.

```java
interface FeeStrategy { Money fee(Duration parked); }
class FlatFee implements FeeStrategy { public Money fee(Duration d){ /*...*/ return null; } }
class HourlyFee implements FeeStrategy { public Money fee(Duration d){ /*...*/ return null; } }
```

### Observer — "when X changes, notify many interested parties"
Notifications, event subscriptions, pub/sub, "alert all displays when a spot frees up," stock
tickers.

```java
interface Observer { void update(Event e); }
class Subject {
    private final List<Observer> observers = new CopyOnWriteArrayList<>();  // thread-safe iteration
    void subscribe(Observer o) { observers.add(o); }
    void notifyAll(Event e) { for (Observer o : observers) o.update(e); }
}
```

### Factory / Factory Method — "create objects without hard-coding the concrete class"
Creating the right `Vehicle`/`Notification`/`Shape` subtype based on input. Centralizes construction;
pairs with Open/Closed.

```java
class VehicleFactory {
    static Vehicle create(VehicleType t) {
        return switch (t) { case CAR -> new Car(); case BIKE -> new Bike(); case TRUCK -> new Truck(); };
    }
}
```

### State — "an object behaves differently depending on its mode, with legal transitions"
Order lifecycle (placed→paid→shipped→delivered), vending machine, traffic light, document workflow.
Each state is a class controlling allowed transitions — kills giant `if/switch` on a status field.

### Decorator — "add responsibilities to an object dynamically, stackably"
Coffee with add-ons, I/O streams (`BufferedReader` wrapping `FileReader`), pricing modifiers.
Wrap objects in same-interface wrappers.

### Singleton — "exactly one instance, globally accessed" (use sparingly, do it right)
Config, connection pool, logger, in-memory store. **Do it right** (the bug everyone makes):

```java
// Thread-safe lazy singleton via holder idiom (no synchronization on the hot path).
class Config {
    private Config() {}
    private static class Holder { static final Config INSTANCE = new Config(); }
    static Config getInstance() { return Holder.INSTANCE; }   // JVM guarantees lazy + thread-safe
}
// Enum singletons are even simpler and serialization-safe: `enum Config { INSTANCE; ... }`
```

> Honorable mentions I'll name if relevant: **Builder** (many optional constructor params — a fluent
> immutable builder), **Adapter** (make an incompatible interface fit), **Command** (encapsulate a
> request as an object — undo/redo, job queues), **Composite** (tree of part-whole, e.g., file
> system). But I don't force them in.

---

## 17.4 Concurrency in LLD (the part that separates senior)

LLD problems almost always have shared mutable state (a parking lot's spots, a rate limiter's
counters, a booking system's seats). Naming the race and fixing it is a strong signal.

- **Identify shared mutable state** explicitly: "multiple threads can grab the last parking spot."
- **Tools, smallest-hammer first:**
  - **Atomics** (`AtomicInteger`, `AtomicReference` + CAS) for single counters/flags.
  - **Concurrent collections** (`ConcurrentHashMap`, `CopyOnWriteArrayList`,
    `ConcurrentLinkedQueue`) over manual locking.
  - **`synchronized` / `ReentrantLock`** for critical sections; `ReadWriteLock` for read-heavy.
  - **Immutability** — the best concurrency strategy is shared state that can't change.
- **Avoid** holding locks across I/O; watch for deadlock (lock ordering); prefer fine-grained locks
  (lock per spot/account, not one global lock).

```java
// Reserving a seat safely with compare-and-set on a concurrent map.
ConcurrentHashMap<Integer, String> seats = new ConcurrentHashMap<>();
boolean reserve(int seatId, String userId) {
    return seats.putIfAbsent(seatId, userId) == null;   // atomic: only the first wins
}
```

> The interviewer is listening for: *"where is the race, and what's the **narrowest** synchronization
> that fixes it?"* Wrapping everything in one global lock is correct but signals junior; a lock-per-
> resource or a CAS shows you think about contention.

---

## 17.5 Common pitfalls

- **Over-engineering** — patterns the problem didn't ask for. Restraint is the signal.
- **God class** — one class doing everything (SRP violation).
- **Inheritance where composition fits** — prefer "has-a" over deep "is-a" hierarchies (LSP traps).
- **Mutable shared state with no concurrency story** — interviewers will ask "what if two threads…".
- **Anemic model** — data classes with no behavior; put behavior with the data it operates on.
- **Broken singleton** — non-thread-safe lazy init; use the holder idiom or an enum.

## Interview Drills

- **D17.1 [E]** Name the problem each of the six patterns solves, in one sentence each.
- **D17.2 [E]** Give a real code smell that each SOLID letter catches.
- **D17.3 [M]** You're modeling order status with a 6-state lifecycle and growing `if/else`. Which
  pattern, and why? *(State.)*
- **D17.4 [M]** Pricing needs to support flat, hourly, and surge fees, swappable at runtime. Which
  pattern? *(Strategy.)*
- **D17.5 [H]** Two threads try to book the last seat. Show the race and the narrowest fix.
- **D17.6 [H]** Write a thread-safe singleton and explain why the holder idiom is lazy *and*
  thread-safe without synchronization. *(JVM class-init guarantees.)*

## Key Takeaways

1. **LLD process: clarify → entities → relationships → the *one* pattern that fits → concurrency.**
   Restraint (no over-engineering) is the senior signal.
2. **SOLID as a checklist;** Open/Closed and Dependency Inversion earn the most signal — model so new
   variants plug in via interfaces.
3. **Six patterns by the problem they solve:** Strategy (swappable behavior), Observer (notify many),
   Factory (hide construction), State (mode + transitions), Decorator (stackable add-ons), Singleton
   (one instance, done right).
4. **Always have a concurrency story:** name the shared mutable state and apply the *narrowest*
   synchronization (atomics/concurrent collections/immutability before a global lock).
5. **Prefer composition over inheritance; behavior lives with its data.**
