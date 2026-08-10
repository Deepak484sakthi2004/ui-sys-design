# SOLID Principles & Clean Code in Java
## Senior Java LLD Reference | Interview-Ready | Effective Java Integration

---

## S — Single Responsibility Principle (SRP)

**Definition:** A class should have one, and only one, reason to change.

"Reason to change" = one stakeholder / one axis of variation. Not "one method." Not "one line of code."

### Violation Example
```java
// BAD — OrderService has 4 reasons to change:
// 1. Business rules for ordering change
// 2. Database schema changes
// 3. Email template changes
// 4. PDF format changes
public class OrderService {
    public Order createOrder(Cart cart, User user) {
        // business logic
        Order order = new Order(cart, user);
        order.setTotal(calculateTotal(cart));

        // persistence — reason to change #2
        Connection conn = DriverManager.getConnection("jdbc:...");
        PreparedStatement ps = conn.prepareStatement("INSERT INTO orders ...");
        ps.setLong(1, order.getId());
        ps.execute();

        // notification — reason to change #3
        Properties props = new Properties();
        Session mailSession = Session.getDefaultInstance(props);
        MimeMessage message = new MimeMessage(mailSession);
        message.setText("Your order #" + order.getId() + " is confirmed");
        Transport.send(message);

        // PDF receipt — reason to change #4
        Document pdf = new Document();
        PdfWriter.getInstance(pdf, new FileOutputStream("receipt.pdf"));
        // ...

        return order;
    }
}
```

### Correct Design
```java
// Each class has exactly one reason to change
public class OrderService {
    private final OrderRepository orderRepository;
    private final OrderNotificationService notificationService;
    private final ReceiptGenerator receiptGenerator;
    private final PricingEngine pricingEngine;

    public OrderService(
            OrderRepository orderRepository,
            OrderNotificationService notificationService,
            ReceiptGenerator receiptGenerator,
            PricingEngine pricingEngine) {
        this.orderRepository = orderRepository;
        this.notificationService = notificationService;
        this.receiptGenerator = receiptGenerator;
        this.pricingEngine = pricingEngine;
    }

    public Order createOrder(Cart cart, User user) {
        Order order = new Order(cart, user);
        order.setTotal(pricingEngine.calculateTotal(cart));  // delegates
        orderRepository.save(order);                          // delegates
        notificationService.sendConfirmation(order);          // delegates
        receiptGenerator.generate(order);                     // delegates
        return order;
    }
}

// OrderRepository: changes when DB schema changes
// OrderNotificationService: changes when email template changes
// ReceiptGenerator: changes when PDF format changes
// PricingEngine: changes when business rules change
```

**Interview test:** "Give me 4 reasons this class could need to change." If you can list 4, it violates SRP.

**Practical limit:** SRP taken to extremes creates too many tiny classes. The heuristic: if a class is tested by a single test suite and has cohesive methods that use the same fields, it's probably fine.

---

## O — Open/Closed Principle (OCP)

**Definition:** Software entities should be open for extension, closed for modification.

Adding new behavior should not require changing existing, tested code.

### Violation — Switch/if-else on type
```java
// BAD — adding a new payment type requires modifying this class
public class PaymentProcessor {
    public void process(Payment payment) {
        if (payment.getType() == PaymentType.CREDIT_CARD) {
            // credit card logic
            chargeCard(payment.getCardNumber(), payment.getAmount());
        } else if (payment.getType() == PaymentType.PAYPAL) {
            // paypal logic
            paypalClient.charge(payment.getEmail(), payment.getAmount());
        } else if (payment.getType() == PaymentType.CRYPTO) {
            // crypto — added later, modified existing class
            cryptoGateway.transfer(payment.getWalletAddress(), payment.getAmount());
        }
        // Every new payment type = modify this class = risk regression
    }
}
```

### Correct Design — Strategy + Polymorphism
```java
// Extension point: implement this interface
public interface PaymentGateway {
    boolean supports(PaymentType type);
    PaymentResult process(Payment payment);
}

// Existing code — never changes
public class PaymentProcessor {
    private final List<PaymentGateway> gateways;

    public PaymentProcessor(List<PaymentGateway> gateways) {
        this.gateways = gateways;
    }

    public PaymentResult process(Payment payment) {
        return gateways.stream()
            .filter(g -> g.supports(payment.getType()))
            .findFirst()
            .orElseThrow(() -> new UnsupportedPaymentTypeException(payment.getType()))
            .process(payment);
    }
}

// Adding crypto: write a new class, no existing code modified
public class CryptoPaymentGateway implements PaymentGateway {
    public boolean supports(PaymentType type) { return type == PaymentType.CRYPTO; }
    public PaymentResult process(Payment payment) {
        return cryptoGateway.transfer(payment.getWalletAddress(), payment.getAmount());
    }
}

// Register in DI config — zero changes to processor
@Bean
public List<PaymentGateway> gateways(CreditCardGateway cc, PaypalGateway pp, CryptoPaymentGateway crypto) {
    return List.of(cc, pp, crypto);
}
```

**Why not inheritance for OCP?**
- Inheritance couples you to the parent's implementation details (fragile base class problem)
- You can only extend one class in Java
- Interface + Strategy gives you runtime flexibility, testability, and no coupling

**Java ecosystem examples of OCP:**
- `java.util.Comparator` — add new ordering without touching sort algorithms
- JDBC — new database vendors add `Driver` implementation without modifying `DriverManager`
- Spring's `HandlerMapping` — new mappings added without modifying `DispatcherServlet`

---

## L — Liskov Substitution Principle (LSP)

**Definition:** Objects of a subtype must be substitutable for objects of their supertype without altering correctness.

If `S extends P`, then anywhere you use `P`, using `S` should work correctly.

### The Rectangle/Square Problem
```java
// Rectangle: width and height are independently mutable
public class Rectangle {
    protected int width;
    protected int height;

    public void setWidth(int w) { this.width = w; }
    public void setHeight(int h) { this.height = h; }
    public int area() { return width * height; }
}

// Square: width == height always
public class Square extends Rectangle {
    @Override
    public void setWidth(int w) {
        this.width = w;
        this.height = w; // maintains square invariant
    }
    @Override
    public void setHeight(int h) {
        this.height = h;
        this.width = h; // maintains square invariant
    }
}

// LSP violation — this test fails with Square
public void testRectangle(Rectangle r) {
    r.setWidth(5);
    r.setHeight(4);
    assert r.area() == 20; // passes for Rectangle, FAILS for Square (area = 16)
}
// Square is-not-a Rectangle in behavioral terms, even though mathematically it is
```

**Fix:** Don't inherit. Use separate classes with a shared `Shape` interface:
```java
public interface Shape { int area(); }
public final class Rectangle implements Shape { /* independent width/height */ }
public final class Square implements Shape { /* single side */ }
```

### Contract-Based Design (Design by Contract)
LSP says: subclass must honor the contract of the superclass:
- **Preconditions** can only be weakened (accept more)
- **Postconditions** can only be strengthened (guarantee more)
- **Invariants** must be preserved

```java
// Parent contract
public abstract class Collection<T> {
    /**
     * Precondition: element != null
     * Postcondition: size() increases by exactly 1
     */
    public abstract boolean add(T element);
}

// LSP violation — UnmodifiableCollection throws on add()
// Callers relying on the postcondition (size increases) break
public class UnmodifiableCollection<T> extends Collection<T> {
    @Override
    public boolean add(T element) {
        throw new UnsupportedOperationException(); // VIOLATED postcondition
    }
}
```

### How to Spot LSP Violations
1. Subclass overrides method to throw `UnsupportedOperationException`
2. Subclass weakens postconditions (promises less than parent)
3. `instanceof` checks in client code ("if it's a Square, do X differently")
4. `@Override` that ignores parameters the parent version uses

```java
// Smell: instanceof check = LSP violation in disguise
public void processShape(Shape shape) {
    if (shape instanceof Square s) {
        // special handling for square — this means Square is not substitutable
        processSquare(s);
    } else {
        processGenericShape(shape);
    }
}
```

---

## I — Interface Segregation Principle (ISP)

**Definition:** Clients should not be forced to depend on methods they do not use.

### Fat Interface Problem
```java
// BAD — forces all implementors to implement everything
public interface Worker {
    void work();
    void eat();           // robots don't eat
    void sleep();         // robots don't sleep
    void takeSickLeave(); // robots don't get sick
    void attendMeeting(); // junior employees might not attend meetings
}

// Robot forced to implement meaningless methods
public class Robot implements Worker {
    public void work() { /* actual work */ }
    public void eat() { throw new UnsupportedOperationException(); }   // meaningless
    public void sleep() { throw new UnsupportedOperationException(); } // meaningless
    public void takeSickLeave() { throw new UnsupportedOperationException(); }
    public void attendMeeting() { /* maybe */ }
}
```

### Role Interfaces (ISP-compliant)
```java
// Split into role interfaces
public interface Workable { void work(); }
public interface Feedable { void eat(); }
public interface Restable { void sleep(); }
public interface Meetable { void attendMeeting(); }
public interface HRManaged { void takeSickLeave(); }

// Human employee implements relevant roles
public class HumanEmployee implements Workable, Feedable, Restable, HRManaged, Meetable {
    public void work() { /* work */ }
    public void eat() { /* eat */ }
    public void sleep() { /* sleep */ }
    public void takeSickLeave() { /* HR process */ }
    public void attendMeeting() { /* meeting */ }
}

// Robot only implements what applies
public class Robot implements Workable, Meetable {
    public void work() { /* work */ }
    public void attendMeeting() { /* status update */ }
}

// Client depends only on what it needs
public class WorkScheduler {
    private final List<Workable> workers; // only depends on Workable — not the whole fat interface
    public void scheduleWork(LocalDateTime time) {
        workers.forEach(Workable::work);
    }
}
```

### Java Functional Interfaces as ISP Embodiment
Java 8's functional interfaces are the ultimate ISP expression:
```java
// Each is a single-method role interface
@FunctionalInterface public interface Runnable { void run(); }
@FunctionalInterface public interface Callable<V> { V call() throws Exception; }
@FunctionalInterface public interface Supplier<T> { T get(); }
@FunctionalInterface public interface Consumer<T> { void accept(T t); }
@FunctionalInterface public interface Function<T,R> { R apply(T t); }
@FunctionalInterface public interface Predicate<T> { boolean test(T t); }
@FunctionalInterface public interface Comparator<T> { int compare(T o1, T o2); }
```

A method that needs to sort doesn't take `Object` — it takes `Comparator<T>`. It depends only on the sorting contract, not on the entire object.

**Interface explosion risk:** Dozens of 1-method interfaces can be hard to discover. Balance: group logically related operations (e.g., `Closeable` and `Flushable` are separate, but `Autocloseable` covers most use cases).

---

## D — Dependency Inversion Principle (DIP)

**Definition:**
1. High-level modules should not depend on low-level modules. Both should depend on abstractions.
2. Abstractions should not depend on details. Details should depend on abstractions.

### Violation
```java
// BAD — OrderService (high-level) directly depends on MySQLOrderRepository (low-level)
public class OrderService {
    private final MySQLOrderRepository repository = new MySQLOrderRepository(); // concrete dep
    // ...
}
// To test OrderService, you NEED a MySQL database running
// To switch to PostgreSQL, you must modify OrderService
```

### Correct — Depend on Abstraction
```java
// Abstraction — the interface lives with the consumer, not the implementation
public interface OrderRepository {
    Order save(Order order);
    Optional<Order> findById(long id);
    List<Order> findByUserId(long userId);
}

// High-level module — depends on abstraction
public class OrderService {
    private final OrderRepository repository; // interface, not concrete class

    public OrderService(OrderRepository repository) { // injected, not created
        this.repository = Objects.requireNonNull(repository);
    }
}

// Low-level modules — depend on abstraction (implement it)
public class MySQLOrderRepository implements OrderRepository { /* MySQL */ }
public class PostgresOrderRepository implements OrderRepository { /* Postgres */ }
public class InMemoryOrderRepository implements OrderRepository { /* for tests */ }
```

### IoC Containers (Spring)
Spring implements DIP at framework level:
```java
@Service
public class OrderService {
    private final OrderRepository repository;
    private final PaymentGateway paymentGateway;

    // Constructor injection — PREFERRED (field injection is an anti-pattern for production)
    @Autowired
    public OrderService(OrderRepository repository, PaymentGateway paymentGateway) {
        this.repository = repository;
        this.paymentGateway = paymentGateway;
    }
}
```

### Why Constructor Injection Over Field Injection

**Field injection (`@Autowired` on field):**
```java
@Service
public class OrderService {
    @Autowired
    private OrderRepository repository; // AVOID IN PRODUCTION
}
```

Problems:
1. **Testability:** Cannot instantiate `OrderService` with `new OrderService(mockRepo)` in unit tests — you must use a Spring context or reflection
2. **Immutability:** Field is not final — can be mutated after construction
3. **Mandatory dependencies are invisible:** Nothing in the class signature tells you what's required
4. **Circular dependency detection:** Spring detects circular deps with constructor injection at startup; with field injection, it defers and may create circular proxies

**Constructor injection (preferred):**
```java
@Service
public class OrderService {
    private final OrderRepository repository;   // final
    private final PaymentGateway paymentGateway; // final

    // If you have 5+ constructor args, this is a smell — class has too many deps (SRP violation)
    public OrderService(OrderRepository repository, PaymentGateway paymentGateway) {
        this.repository = Objects.requireNonNull(repository);
        this.paymentGateway = Objects.requireNonNull(paymentGateway);
    }
}
// Unit test: new OrderService(new InMemoryOrderRepository(), new FakePaymentGateway())
```

**Circular dependency detection with constructor injection:**
```java
@Service class A {
    A(B b) {}   // A needs B
}
@Service class B {
    B(A a) {}   // B needs A
}
// Spring throws: UnsatisfiedDependencyException (circular dependency)
// This is GOOD — it surfaces a design problem at startup
// With field injection, Spring creates proxies and may hide this problem
```

---

## Clean Code Principles in Java

### Naming
```java
// BAD
int d; // elapsed time in days
List<int[]> list1;
String s;
boolean flag;

// GOOD
int elapsedTimeInDays;
List<Cell> gameBoard;
String customerFullName;
boolean isUserAuthenticated;

// Method names: verb + noun
// BAD: data(), process(), manage()
// GOOD: findOrderByCustomerId(), calculateShippingCost(), validateCreditCard()

// Boolean methods: is/has/can/should
boolean isEligibleForDiscount();
boolean hasOutstandingInvoices();
boolean canProcessRefund();
```

### Method Size — Single Level of Abstraction
```java
// BAD — mixes abstraction levels (SQL + business logic + formatting)
public String generateMonthlyReport(YearMonth month) {
    Connection conn = dataSource.getConnection();
    PreparedStatement ps = conn.prepareStatement("SELECT * FROM orders WHERE ...");
    ResultSet rs = ps.executeQuery();
    List<Order> orders = new ArrayList<>();
    while (rs.next()) {
        orders.add(new Order(rs.getLong("id"), rs.getBigDecimal("total")));
    }
    BigDecimal total = BigDecimal.ZERO;
    for (Order o : orders) total = total.add(o.getTotal());
    StringBuilder sb = new StringBuilder();
    sb.append("Monthly Report - ").append(month).append("\n");
    sb.append("Total: ").append(total).append("\n");
    return sb.toString();
}

// GOOD — each method at one abstraction level
public String generateMonthlyReport(YearMonth month) {
    List<Order> orders = orderRepository.findByMonth(month);  // same level
    MonthlyStats stats = calculateStats(orders);               // same level
    return formatReport(month, stats);                         // same level
}

private MonthlyStats calculateStats(List<Order> orders) {
    return new MonthlyStats(
        orders.size(),
        orders.stream().map(Order::getTotal).reduce(BigDecimal.ZERO, BigDecimal::add),
        orders.stream().mapToDouble(o -> o.getTotal().doubleValue()).average().orElse(0)
    );
}
```

### Comment Necessity
```java
// BAD — comment restates what code says (noise)
// increment i by 1
i++;

// BAD — comment instead of good naming
// Check if the user has been active in the last 30 days
if (user.getLastLoginDate().isAfter(LocalDate.now().minusDays(30))) { ... }

// GOOD — rename to eliminate comment
if (user.hasBeenActiveRecently()) { ... }

// GOOD — comment explains WHY, not WHAT
// Using Integer.parseInt() instead of Long because the downstream API
// chokes on numbers > Integer.MAX_VALUE due to a known bug (JIRA-4521)
int id = Integer.parseInt(rawId);

// GOOD — javadoc for public API contracts
/**
 * Calculates shipping cost for the given cart.
 *
 * @param cart the shopping cart (must not be null, items must have positive quantities)
 * @return shipping cost in USD, 0.0 if cart qualifies for free shipping
 * @throws IllegalArgumentException if cart is null or contains invalid items
 */
public BigDecimal calculateShipping(Cart cart) { ... }
```

---

## Effective Java Key Items as LLD Principles

### Item 17: Minimize Mutability

**Why immutable objects are thread-safe:** An immutable object is fully constructed before any reference to it is published to other threads. No synchronization needed — ever.

```java
// Immutable class — all fields final, no setters, defensive copies
public final class Money {
    private final BigDecimal amount;
    private final Currency currency;

    public Money(BigDecimal amount, Currency currency) {
        // Defensive copy of mutable input
        this.amount = Objects.requireNonNull(amount, "amount").setScale(2, RoundingMode.HALF_UP);
        this.currency = Objects.requireNonNull(currency, "currency");
        if (amount.compareTo(BigDecimal.ZERO) < 0) throw new IllegalArgumentException("Amount cannot be negative");
    }

    // All "mutating" operations return new instances
    public Money add(Money other) {
        if (!this.currency.equals(other.currency)) throw new IllegalArgumentException("Currency mismatch");
        return new Money(this.amount.add(other.amount), this.currency);
    }

    public Money multiply(BigDecimal factor) {
        return new Money(this.amount.multiply(factor), this.currency);
    }

    // Defensive copy in getter — if amount were mutable (it isn't for BigDecimal)
    public BigDecimal getAmount() { return amount; } // BigDecimal is already immutable
    public Currency getCurrency() { return currency; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Money)) return false;
        Money m = (Money) o;
        return amount.equals(m.amount) && currency.equals(m.currency);
    }
    @Override public int hashCode() { return Objects.hash(amount, currency); }
    @Override public String toString() { return amount + " " + currency; }
}

// Thread safety:
Money price = new Money(new BigDecimal("19.99"), Currency.getInstance("USD"));
// price can be shared across threads with no synchronization
// because it can never change after construction
```

**Defensive copies:**
```java
// BAD — caller can mutate the internal list through the returned reference
public class OrderSummary {
    private final List<LineItem> items;
    public List<LineItem> getItems() { return items; } // leaks mutable reference
}

// GOOD — defensive copy
public class OrderSummary {
    private final List<LineItem> items;
    public OrderSummary(List<LineItem> items) {
        this.items = List.copyOf(items); // unmodifiable copy
    }
    public List<LineItem> getItems() { return items; } // already unmodifiable
    // OR: return List.copyOf(items); — if items themselves are mutable
}
```

### Item 18: Favor Composition Over Inheritance

**Fragile base class problem:**
```java
// Base class — assume from a library you don't control
public class InstrumentedHashSet<E> extends HashSet<E> {
    private int addCount = 0;

    @Override
    public boolean add(E e) {
        addCount++;
        return super.add(e);
    }

    @Override
    public boolean addAll(Collection<? extends E> c) {
        addCount += c.size();
        return super.addAll(c); // internally calls this.add() for each element!
    }
    // addAll of 3 elements: addCount becomes 3 (from addAll) + 3 (from add) = 6 — WRONG!
}
```

HashSet's `addAll` internally calls `add()` — but that's an implementation detail. If HashSet changes it, your class breaks. This is the "fragile base class" problem.

**Composition fix:**
```java
public class InstrumentedSet<E> implements Set<E> {
    private final Set<E> delegate; // composition
    private int addCount = 0;

    public InstrumentedSet(Set<E> delegate) { this.delegate = delegate; }

    @Override
    public boolean add(E e) {
        addCount++;
        return delegate.add(e);
    }

    @Override
    public boolean addAll(Collection<? extends E> c) {
        addCount += c.size();
        return delegate.addAll(c); // calls delegate.addAll, not our add()
    }

    public int getAddCount() { return addCount; }

    // Forwarding methods for all Set methods
    @Override public int size() { return delegate.size(); }
    @Override public boolean isEmpty() { return delegate.isEmpty(); }
    @Override public boolean contains(Object o) { return delegate.contains(o); }
    // ... etc (or extend AbstractSet and implement required methods)
}
// Works correctly regardless of HashSet's internal implementation changes
```

**Prefer inheritance ONLY when:**
1. The IS-A relationship is truly valid (not just "has the same methods")
2. You control the base class (or it's designed for extension, with docs)
3. The subclass doesn't need to suppress or throw from inherited methods

### Item 64: Refer to Objects by Interface

```java
// BAD — tightly coupled to concrete type
ArrayList<Order> orders = new ArrayList<>();
HashMap<String, User> userMap = new HashMap<>();

// GOOD — program to interface
List<Order> orders = new ArrayList<>();
Map<String, User> userMap = new HashMap<>();

// Now switching to LinkedList or TreeMap requires changing only the right side
List<Order> orders = new LinkedList<>();
Map<String, User> userMap = new TreeMap<>();

// Method signatures — always use interface types
// BAD
public HashMap<String, User> getUsersByName() { ... }
// GOOD
public Map<String, User> getUsersByName() { ... }

// Exception: use concrete type when behavior is specific to it
LinkedHashMap<String, Order> orderedMap = new LinkedHashMap<>(); // insertion-order matters
// OR
ArrayDeque<Task> taskQueue = new ArrayDeque<>(); // specifically using deque semantics
```

**Why it matters for LLD interviews:** Shows you understand polymorphism and loose coupling. A method accepting `List<T>` works with ArrayList, LinkedList, CopyOnWriteArrayList — without modification.

### Items 69-72: Exception Handling

**Item 69 — Use exceptions for exceptional conditions only:**
```java
// WRONG — using exceptions for control flow (terrible performance)
try {
    int i = 0;
    while (true) { array[i++] = value; } // relies on ArrayIndexOutOfBoundsException
} catch (ArrayIndexOutOfBoundsException e) { /* done */ }

// CORRECT
for (int i = 0; i < array.length; i++) { array[i] = value; }
// OR
Arrays.fill(array, value);
```

**Performance note:** Exception creation calls `fillInStackTrace()` which traverses the entire call stack — O(depth). In a tight loop, this is catastrophic.

**Item 70 — Checked vs Unchecked exceptions:**
```java
// Checked exception — ONLY when caller can reasonably recover
// "I/O failed but you can retry with a different file path"
public Document parseDocument(Path path) throws IOException { ... }

// Unchecked (RuntimeException) — programming errors, precondition violations
// Caller cannot recover; the code has a bug
public Order findOrder(long id) {
    if (id <= 0) throw new IllegalArgumentException("id must be positive: " + id);
    return orderRepository.findById(id)
        .orElseThrow(() -> new OrderNotFoundException("Order not found: " + id));
}

// Anti-pattern: catching Exception/Throwable without re-throwing or logging
try {
    processOrder(order);
} catch (Exception e) {
    // swallowed silently — NEVER DO THIS
}

// Anti-pattern: using checked exceptions for things callers can't recover from
// Nobody can "recover" from NullPointerException — don't check it
```

**Item 71 — Avoid unnecessary checked exceptions:**
```java
// BAD — forces all callers to handle this even if they can't do anything
public void processPayment(Payment p) throws PaymentProcessingException { ... }

// BETTER — unless callers genuinely need to handle this differently,
// make it unchecked
public void processPayment(Payment p) {
    try { /* process */ }
    catch (PaymentGatewayException e) {
        throw new PaymentProcessingException("Payment failed for " + p.getId(), e);
        // Unchecked — wrap in RuntimeException
    }
}
```

**Item 72 — Prefer standard exceptions:**

| Use case | Exception |
|---|---|
| Invalid argument | `IllegalArgumentException` |
| Wrong state | `IllegalStateException` |
| Null argument not allowed | `NullPointerException` (or `Objects.requireNonNull`) |
| Index out of range | `IndexOutOfBoundsException` |
| Operation not supported | `UnsupportedOperationException` |
| Concurrent modification | `ConcurrentModificationException` |

```java
// Custom domain exception hierarchy
public class DomainException extends RuntimeException {
    private final ErrorCode code;
    public DomainException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }
    public DomainException(ErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }
    public ErrorCode getCode() { return code; }
}

public class OrderNotFoundException extends DomainException {
    public OrderNotFoundException(long orderId) {
        super(ErrorCode.ORDER_NOT_FOUND, "Order not found: " + orderId);
    }
}

// Exception chaining — never lose the original cause
try {
    return jdbcTemplate.queryForObject(SQL, orderMapper, id);
} catch (EmptyResultDataAccessException e) {
    throw new OrderNotFoundException(id); // fine — e is informational
} catch (DataAccessException e) {
    throw new DataPersistenceException("Failed to fetch order " + id, e); // preserve cause
}
```
