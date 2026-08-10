# Design Patterns Deep Dive — All 23 GoF Patterns
## Senior Java LLD Reference | Interview-Ready | JVM-Level Insights

---

## Table of Contents
1. [Creational Patterns](#creational)
2. [Structural Patterns](#structural)
3. [Behavioral Patterns](#behavioral)

---

# CREATIONAL PATTERNS

## 1. Singleton

### Intent
Ensure a class has exactly one instance and provide a global access point to it.

### When to Use
- Configuration objects (read-once, read-many)
- Connection pool managers
- Logger instances
- Registry / service locators

### When NOT to Use
- When you need testability (hard to mock, static global state)
- When you may need multiple instances in different contexts (multi-tenant)
- When using dependency injection containers (let the container control lifecycle)

### Implementations

#### a) Enum Singleton (BEST — Joshua Bloch recommended)
```java
public enum AppConfig {
    INSTANCE;

    private final Properties props = new Properties();

    AppConfig() {
        // load config once
        try (InputStream is = getClass().getResourceAsStream("/app.properties")) {
            props.load(is);
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public String get(String key) {
        return props.getProperty(key);
    }
}
// Usage: AppConfig.INSTANCE.get("db.url")
```
**Why enum is best:**
- JVM guarantees single instantiation per classloader (enum constants are static final fields)
- Serialization-safe: enum deserialization always returns the same instance
- Reflection-safe: `Constructor.newInstance()` throws `IllegalArgumentException` for enums
- Thread-safe by JVM class loading guarantees

#### b) Double-Checked Locking (DCL) with volatile
```java
public final class DatabasePool {
    // volatile is MANDATORY — without it, DCL is broken
    private static volatile DatabasePool instance;

    private final HikariDataSource dataSource;

    private DatabasePool() {
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(System.getProperty("db.url"));
        this.dataSource = new HikariDataSource(config);
    }

    public static DatabasePool getInstance() {
        if (instance == null) {                    // first check (no lock)
            synchronized (DatabasePool.class) {
                if (instance == null) {            // second check (with lock)
                    instance = new DatabasePool(); // volatile write
                }
            }
        }
        return instance;                           // volatile read
    }

    public Connection getConnection() throws SQLException {
        return dataSource.getConnection();
    }
}
```

**JVM-level insight — why volatile is required:**
Object construction (`new DatabasePool()`) is NOT atomic. The JVM executes 3 steps:
1. Allocate memory for the object
2. Initialize the object (call constructor)
3. Assign the reference to `instance`

Without `volatile`, the JIT/CPU may reorder steps 2 and 3 (this is legal under the Java Memory Model without a happens-before edge). Thread B can see a non-null `instance` pointing to a **partially constructed object** and use it — classic data race.

`volatile` establishes a happens-before between the write (`instance = new DatabasePool()`) in thread A and the read (`if (instance == null)`) in thread B. This prevents the reordering.

#### c) Initialization-On-Demand Holder (Bill Pugh)
```java
public final class CacheManager {
    private CacheManager() {}

    // Inner class is not loaded until getInstance() is first called
    private static final class Holder {
        static final CacheManager INSTANCE = new CacheManager();
    }

    public static CacheManager getInstance() {
        return Holder.INSTANCE;
    }
}
```
**Why this works:** JVM class initialization is guaranteed to be serial (JLS §12.4). `Holder` class is loaded lazily (only when `getInstance()` is called). The static field initializer runs under the class initialization lock. No `synchronized` needed on `getInstance()`.

**Performance:** Faster than DCL in the common case (no volatile read after initialization), but semantically equivalent in correctness.

### Pitfalls

**Classloader issue:** Each classloader in the JVM gets its own class, so multiple classloaders = multiple singleton instances. In OSGi, Java EE, or complex plugin architectures, singletons are per-classloader, not per-JVM.

**Reflection breaking singleton (except enum):**
```java
Constructor<CacheManager> c = CacheManager.class.getDeclaredConstructor();
c.setAccessible(true);
CacheManager second = c.newInstance(); // breaks Holder-based singleton
```
Defense: throw `IllegalStateException` in the constructor if an instance already exists.

**Serialization breaking singleton:** If the class implements `Serializable`, deserialization creates a new instance. Fix: add `readResolve()`:
```java
protected Object readResolve() { return getInstance(); }
```

---

## 2. Factory Method

### Intent
Define an interface for creating an object, but let subclasses decide which class to instantiate.

### Structure
```java
// Product
public interface Notification {
    void send(String message);
}

// Concrete products
public class EmailNotification implements Notification {
    private final String to;
    public EmailNotification(String to) { this.to = to; }
    public void send(String message) { /* SMTP send */ }
}

public class SMSNotification implements Notification {
    private final String phone;
    public SMSNotification(String phone) { this.phone = phone; }
    public void send(String message) { /* Twilio send */ }
}

// Creator — abstract, contains the factory method
public abstract class NotificationService {
    public void notify(String recipient, String message) {
        Notification n = createNotification(recipient); // factory method
        n.send(message);
    }
    protected abstract Notification createNotification(String recipient);
}

// Concrete creators
public class EmailNotificationService extends NotificationService {
    protected Notification createNotification(String recipient) {
        return new EmailNotification(recipient);
    }
}

public class SMSNotificationService extends NotificationService {
    protected Notification createNotification(String recipient) {
        return new SMSNotification(recipient);
    }
}
```

### Real-World Java Example
`java.sql.DriverManager.getConnection()` — callers ask for a connection without knowing which driver implementation is returned. `DocumentBuilderFactory.newInstance()` — returns a platform-specific DocumentBuilder.

---

## 3. Abstract Factory

### Intent
Provide an interface for creating **families of related objects** without specifying concrete classes.

### Factory Method vs Abstract Factory — The Critical Difference
- **Factory Method**: one product, subclass decides the type. "One factory method per product."
- **Abstract Factory**: multiple related products, factory creates a consistent family. "Swap the entire factory to swap the entire product family."

```java
// Abstract factory
public interface UIFactory {
    Button createButton();
    Checkbox createCheckbox();
    Dialog createDialog();
}

// Concrete factory — Windows family
public class WindowsUIFactory implements UIFactory {
    public Button createButton() { return new WindowsButton(); }
    public Checkbox createCheckbox() { return new WindowsCheckbox(); }
    public Dialog createDialog() { return new WindowsDialog(); }
}

// Concrete factory — macOS family
public class MacUIFactory implements UIFactory {
    public Button createButton() { return new MacButton(); }
    public Checkbox createCheckbox() { return new MacCheckbox(); }
    public Dialog createDialog() { return new MacDialog(); }
}

// Client — works with any UIFactory
public class Application {
    private final UIFactory factory;
    private Button button;
    private Dialog dialog;

    public Application(UIFactory factory) {
        this.factory = factory;
    }

    public void init() {
        this.button = factory.createButton();
        this.dialog = factory.createDialog();
    }
}

// Bootstrap
UIFactory factory = System.getProperty("os.name").startsWith("Mac")
    ? new MacUIFactory()
    : new WindowsUIFactory();
Application app = new Application(factory);
```

**When to choose Abstract Factory over Factory Method:** When you have multiple product hierarchies and they must be used together consistently (button + dialog + checkbox must all be Windows or all be Mac — never mixed).

---

## 4. Builder

### Intent
Construct complex objects step-by-step. Separate construction from representation.

### Joshua Bloch's Builder (Effective Java Item 2)
Use when: constructor has 4+ parameters, especially optional ones. Telescoping constructors are an anti-pattern.

```java
public final class HttpRequest {
    // All fields final — immutable object
    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final String body;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;
    private final boolean followRedirects;

    // Private constructor — only Builder can instantiate
    private HttpRequest(Builder builder) {
        this.url = builder.url;
        this.method = builder.method;
        this.headers = Collections.unmodifiableMap(new HashMap<>(builder.headers));
        this.body = builder.body;
        this.connectTimeoutMs = builder.connectTimeoutMs;
        this.readTimeoutMs = builder.readTimeoutMs;
        this.followRedirects = builder.followRedirects;
    }

    public static final class Builder {
        // Mandatory fields
        private final String url;
        private final String method;

        // Optional fields with defaults
        private Map<String, String> headers = new HashMap<>();
        private String body;
        private int connectTimeoutMs = 5000;
        private int readTimeoutMs = 30000;
        private boolean followRedirects = true;

        // Mandatory params in Builder constructor — forces caller to provide them
        public Builder(String url, String method) {
            if (url == null || url.isBlank()) throw new IllegalArgumentException("url required");
            if (method == null || method.isBlank()) throw new IllegalArgumentException("method required");
            this.url = url;
            this.method = method;
        }

        public Builder header(String name, String value) {
            this.headers.put(name, value);
            return this;
        }

        public Builder body(String body) {
            this.body = body;
            return this;
        }

        public Builder connectTimeout(int ms) {
            if (ms <= 0) throw new IllegalArgumentException("timeout must be positive");
            this.connectTimeoutMs = ms;
            return this;
        }

        public Builder readTimeout(int ms) {
            this.readTimeoutMs = ms;
            return this;
        }

        public Builder noRedirects() {
            this.followRedirects = false;
            return this;
        }

        public HttpRequest build() {
            // Cross-field validation here
            if ("GET".equals(method) && body != null) {
                throw new IllegalStateException("GET requests cannot have a body");
            }
            return new HttpRequest(this);
        }
    }

    // Getters only — no setters
    public String getUrl() { return url; }
    public String getMethod() { return method; }
    // ... etc
}

// Usage — reads like a sentence
HttpRequest request = new HttpRequest.Builder("https://api.example.com/users", "POST")
    .header("Authorization", "Bearer " + token)
    .header("Content-Type", "application/json")
    .body("{\"name\": \"alice\"}")
    .connectTimeout(3000)
    .build();
```

**Real-World:** `StringBuilder`, `Stream.Builder`, Lombok's `@Builder`, `ProcessBuilder`, `AlertDialog.Builder` (Android).

**Pitfall:** Builder adds boilerplate. For 2-3 params, prefer static factory methods. Use Lombok `@Builder` in production but know how to write it manually for interviews.

---

## 5. Prototype

### Intent
Create new objects by copying an existing object (the prototype).

### Object.clone() Problems
```java
public class UserProfile implements Cloneable {
    private String name;
    private List<String> roles; // mutable reference!

    @Override
    public UserProfile clone() {
        try {
            UserProfile copy = (UserProfile) super.clone(); // shallow copy
            // PROBLEM: copy.roles == this.roles (same reference)
            // Mutation through copy affects original
            copy.roles = new ArrayList<>(this.roles); // deep copy needed
            return copy;
        } catch (CloneNotSupportedException e) {
            throw new AssertionError(); // can't happen if Cloneable implemented
        }
    }
}
```

**Clone problems:**
1. `Cloneable` is a marker interface — `clone()` is on `Object`, not `Cloneable`. Confusing API.
2. Shallow copy by default — mutable fields shared between original and copy.
3. Constructors not called — fields populated directly. Breaks invariants if constructor validation is required.
4. Final fields cannot be assigned in `clone()` — incompatible with immutable objects.

**Prefer copy constructors:**
```java
public class UserProfile {
    private final String name;
    private final List<String> roles;

    // Original constructor
    public UserProfile(String name, List<String> roles) {
        this.name = name;
        this.roles = List.copyOf(roles); // defensive copy, immutable
    }

    // Copy constructor — explicit, clear, handles deep copy
    public UserProfile(UserProfile source) {
        this(source.name, source.roles); // reuses validation in original constructor
    }
}
```

### When to Use Prototype
- Object creation is expensive (DB query, network call) and the new object differs only slightly
- When you want to avoid subclassing of the creator
- Object pool pre-creation scenarios

---

## 6. Object Pool

### Intent
Reuse expensive-to-create objects rather than creating/destroying on demand.

### When it Matters
- Database connections: TCP handshake + authentication = expensive
- Thread creation: OS-level resource, expensive
- ByteBuffer allocations: for I/O-heavy code, pooled ByteBuffers reduce GC pressure
- Parser/compiler instances: `SAXParser`, `XPathExpression`

### Thread-Safe Pool Implementation
```java
public class ObjectPool<T> {
    private final BlockingQueue<T> pool;
    private final Supplier<T> factory;
    private final Consumer<T> resetAction;
    private final int maxSize;
    private final AtomicInteger currentSize = new AtomicInteger(0);

    public ObjectPool(int maxSize, Supplier<T> factory, Consumer<T> resetAction) {
        this.maxSize = maxSize;
        this.pool = new ArrayBlockingQueue<>(maxSize);
        this.factory = factory;
        this.resetAction = resetAction;
    }

    public T borrow(long timeout, TimeUnit unit) throws InterruptedException {
        T obj = pool.poll(); // non-blocking try first
        if (obj == null) {
            if (currentSize.get() < maxSize) {
                int size = currentSize.incrementAndGet();
                if (size <= maxSize) {
                    return factory.get(); // create new without blocking
                }
                currentSize.decrementAndGet();
            }
            // Pool at capacity, wait
            obj = pool.poll(timeout, unit);
            if (obj == null) throw new RuntimeException("Pool exhausted — timeout waiting for object");
        }
        return obj;
    }

    public void release(T obj) {
        resetAction.accept(obj); // reset state before returning
        if (!pool.offer(obj)) {
            // Pool is full (shouldn't happen with correct usage, but handle gracefully)
            // Destroy obj if it has a close() method
        }
    }
}

// Usage for ByteBuffer pool (JVM insight: direct ByteBuffers are outside heap)
ObjectPool<ByteBuffer> bufferPool = new ObjectPool<>(
    100,
    () -> ByteBuffer.allocateDirect(64 * 1024), // 64KB direct buffers
    ByteBuffer::clear
);
```

**JVM insight:** `ByteBuffer.allocateDirect()` allocates off-heap memory. GC cannot move it (it's not on heap), but GC must run a finalizer/cleaner to free it. Pooling direct ByteBuffers avoids both the allocation cost and the GC pressure — critical for Netty-style high-throughput I/O.

---

# STRUCTURAL PATTERNS

## 7. Adapter

### Intent
Convert the interface of a class into another interface that clients expect. Makes incompatible interfaces work together.

### Object Adapter vs Class Adapter

**Object Adapter (preferred in Java — uses composition):**
```java
// Target interface (what the client expects)
public interface ModernPaymentGateway {
    PaymentResult processPayment(PaymentRequest request);
}

// Adaptee — legacy system with incompatible interface
public class LegacyPaymentProcessor {
    public boolean charge(String cardNumber, int amountInCents, String currency) { /* ... */ return true; }
    public String getLastTransactionId() { /* ... */ return "TXN123"; }
}

// Object Adapter — wraps the adaptee
public class LegacyPaymentAdapter implements ModernPaymentGateway {
    private final LegacyPaymentProcessor legacy; // composition

    public LegacyPaymentAdapter(LegacyPaymentProcessor legacy) {
        this.legacy = legacy;
    }

    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        int cents = (int)(request.getAmount().multiply(BigDecimal.valueOf(100)).longValue());
        boolean success = legacy.charge(request.getCardNumber(), cents, request.getCurrency());
        String txnId = legacy.getLastTransactionId();
        return new PaymentResult(success, txnId);
    }
}
```

**Class Adapter (Java — multiple inheritance via interface + extends):**
```java
// Only possible when adaptee is extensible (not final)
public class ClassAdapterExample extends LegacyPaymentProcessor implements ModernPaymentGateway {
    @Override
    public PaymentResult processPayment(PaymentRequest request) {
        boolean success = charge(request.getCardNumber(), toCents(request), request.getCurrency());
        return new PaymentResult(success, getLastTransactionId());
    }
}
```

**When to use Object Adapter:** When you don't control the adaptee source and cannot extend it (final class, or you want loose coupling).

**Bridge vs Adapter:** Adapter makes things work together after the fact. Bridge is designed upfront to separate abstraction from implementation.

---

## 8. Bridge

### Intent
Decouple an abstraction from its implementation so that the two can vary independently.

```java
// Implementation interface (the "bridge")
public interface MessageSender {
    void send(String to, String subject, String body);
}

// Concrete implementations
public class SmtpSender implements MessageSender { /* SMTP implementation */ }
public class AwsSesSender implements MessageSender { /* AWS SES implementation */ }
public class MockSender implements MessageSender { /* for tests */ }

// Abstraction hierarchy
public abstract class Notification {
    protected final MessageSender sender; // bridge to implementation

    protected Notification(MessageSender sender) {
        this.sender = sender;
    }

    public abstract void notify(String recipient, String message);
}

// Refined abstractions — vary independently from sender implementations
public class AlertNotification extends Notification {
    public AlertNotification(MessageSender sender) { super(sender); }

    @Override
    public void notify(String recipient, String message) {
        sender.send(recipient, "[ALERT] " + message, buildAlertBody(message));
    }
}

public class ReportNotification extends Notification {
    public ReportNotification(MessageSender sender) { super(sender); }

    @Override
    public void notify(String recipient, String message) {
        sender.send(recipient, "Daily Report", buildReportBody(message));
    }
}

// 2 abstractions × 3 implementations = 6 combinations, no explosion
Notification alert = new AlertNotification(new SmtpSender());
Notification report = new ReportNotification(new AwsSesSender());
```

**The key insight:** Without Bridge, you'd need `SmtpAlertNotification`, `AwsSesAlertNotification`, `SmtpReportNotification`, `AwsSesReportNotification` — class explosion proportional to M×N.

---

## 9. Composite

### Intent
Compose objects into tree structures to represent part-whole hierarchies. Clients treat individual objects and compositions uniformly.

```java
// Component — uniform interface
public interface FileSystemEntry {
    String getName();
    long getSize();
    void print(String indent);
}

// Leaf
public class File implements FileSystemEntry {
    private final String name;
    private final long size;

    public File(String name, long size) { this.name = name; this.size = size; }

    public String getName() { return name; }
    public long getSize() { return size; }
    public void print(String indent) {
        System.out.println(indent + name + " (" + size + " bytes)");
    }
}

// Composite
public class Directory implements FileSystemEntry {
    private final String name;
    private final List<FileSystemEntry> children = new ArrayList<>();

    public Directory(String name) { this.name = name; }

    public void add(FileSystemEntry entry) { children.add(entry); }
    public void remove(FileSystemEntry entry) { children.remove(entry); }

    public String getName() { return name; }

    public long getSize() {
        return children.stream().mapToLong(FileSystemEntry::getSize).sum(); // recursive
    }

    public void print(String indent) {
        System.out.println(indent + "[" + name + "]");
        children.forEach(c -> c.print(indent + "  ")); // recursive
    }
}
```

**Null Object as companion:** Instead of checking `if (child != null)` throughout, create a `NullFileSystemEntry` that returns 0 size and does nothing on print. Eliminates null checks from tree traversal code.

**Real-World:** `java.awt.Component` / `Container`, Menu/MenuItem in Swing, Spring's `CompositePropertySource`, Gradle's task graph.

---

## 10. Decorator

### Intent
Attach additional responsibilities to an object dynamically. An alternative to subclassing for extending functionality.

### Java I/O — The canonical example
```java
// Decorator chain: FileInputStream -> BufferedInputStream -> GZIPInputStream -> DataInputStream
DataInputStream in = new DataInputStream(
    new GZIPInputStream(
        new BufferedInputStream(
            new FileInputStream("/data/large.gz"),
            8192
        )
    )
);
```
Each class wraps the previous: `BufferedInputStream` adds buffering, `GZIPInputStream` adds decompression, `DataInputStream` adds typed reads. All implement `InputStream`.

### Custom Decorator — Caching around a repository
```java
public interface ProductRepository {
    Optional<Product> findById(long id);
    List<Product> findAll();
}

// Real implementation (hits DB)
public class JpaProductRepository implements ProductRepository { /* ... */ }

// Decorator — adds caching without modifying JpaProductRepository
public class CachingProductRepository implements ProductRepository {
    private final ProductRepository delegate; // wrapped
    private final Cache<Long, Product> cache;

    public CachingProductRepository(ProductRepository delegate, Cache<Long, Product> cache) {
        this.delegate = delegate;
        this.cache = cache;
    }

    @Override
    public Optional<Product> findById(long id) {
        Product cached = cache.getIfPresent(id);
        if (cached != null) return Optional.of(cached);
        Optional<Product> result = delegate.findById(id);
        result.ifPresent(p -> cache.put(id, p));
        return result;
    }

    @Override
    public List<Product> findAll() {
        return delegate.findAll(); // don't cache list queries
    }
}

// Decorator chain
ProductRepository repo = new CachingProductRepository(
    new LoggingProductRepository(    // another decorator — logs queries
        new JpaProductRepository(entityManager)
    ),
    Caffeine.newBuilder().expireAfterWrite(10, TimeUnit.MINUTES).build()
);
```

**Decorator vs Inheritance:**
- Inheritance: behavior fixed at compile time, all subclasses inherit the change
- Decorator: behavior added at runtime, composable, single responsibility per decorator

**Anti-pattern:** Decorating with too many wrappers in a deep chain makes debugging hard (stack traces become long). Favor when you have 2-4 cross-cutting concerns.

---

## 11. Facade

### Intent
Provide a simplified interface to a complex subsystem.

```java
// Complex subsystem
public class VideoConverter {
    public VideoFile convert(VideoFile source, String format) {
        CodecFactory codecFactory = new CodecFactory();
        Codec sourceCodec = codecFactory.extract(source);
        Codec destCodec = format.equals("mp4") ? new MPEG4Codec() : new OggCodec();
        BitrateReader reader = new BitrateReader();
        BitrateWriter writer = new BitrateWriter();
        // ... 20 more lines of subsystem orchestration
        return new VideoFile(source.getName() + "." + format);
    }
}

// Facade — single method hides all subsystem complexity
public class VideoConversionFacade {
    private final VideoConverter converter = new VideoConverter();

    public File convertVideoFile(String sourceFileName, String format) {
        VideoFile source = new VideoFile(sourceFileName);
        VideoFile result = converter.convert(source, format);
        return new File(result.getName());
    }
}
```

**Real-World:** `javax.faces.context.FacesContext`, `java.net.URL` (hides TCP/DNS/HTTP), SLF4J (facade over Log4j/Logback/JUL), JDBC API (facade over database-specific drivers).

---

## 12. Flyweight

### Intent
Use sharing to efficiently support large numbers of fine-grained objects. Split state into intrinsic (shared, immutable) and extrinsic (context-dependent, passed in).

### JVM Examples — Built-In Flyweight

**Integer cache (-128 to 127):**
```java
Integer a = 100; // autoboxed: Integer.valueOf(100) — returns CACHED instance
Integer b = 100;
System.out.println(a == b);   // true — same cached instance

Integer c = 200; // outside cache range
Integer d = 200;
System.out.println(c == d);   // false — different heap objects

// Internals of Integer.valueOf:
// private static final Integer[] cache; // initialized from -128 to high (default 127)
// if (i >= IntegerCache.low && i <= IntegerCache.high) return cache[i + 128];
// return new Integer(i);
```

**String pool:**
```java
String s1 = "hello";          // interned — from string pool
String s2 = "hello";          // same reference from pool
String s3 = new String("hello"); // forced heap object — NOT from pool
System.out.println(s1 == s2); // true
System.out.println(s1 == s3); // false
s3 = s3.intern();             // manually intern — now returns pool reference
System.out.println(s1 == s3); // true
```

**Custom Flyweight — rendering a forest of trees:**
```java
// Intrinsic state — shared, immutable
public final class TreeType {
    private final String species;      // intrinsic
    private final Color color;         // intrinsic
    private final BufferedImage mesh;  // intrinsic — expensive to create

    // Constructor — creation is expensive, so we pool these
    TreeType(String species, Color color) {
        this.species = species;
        this.color = color;
        this.mesh = loadMeshFromDisk(species); // expensive!
    }

    public void draw(Graphics2D g, int x, int y) { // x,y are extrinsic — passed in
        g.drawImage(mesh, x, y, null);
    }
}

// Flyweight factory
public class TreeTypeFactory {
    private static final Map<String, TreeType> cache = new ConcurrentHashMap<>();

    public static TreeType getTreeType(String species, Color color) {
        String key = species + "-" + color.getRGB();
        return cache.computeIfAbsent(key, k -> new TreeType(species, color));
    }
}

// Extrinsic state — one per tree instance (cheap)
public class Tree {
    private final int x, y;            // extrinsic — unique per tree
    private final TreeType type;       // intrinsic — shared flyweight

    public Tree(int x, int y, String species, Color color) {
        this.x = x;
        this.y = y;
        this.type = TreeTypeFactory.getTreeType(species, color); // shared
    }

    public void draw(Graphics2D g) {
        type.draw(g, x, y); // pass extrinsic state to flyweight
    }
}
// 1,000,000 trees, but only ~20 TreeType objects in memory
```

---

## 13. Proxy

### Intent
Provide a surrogate/placeholder for another object to control access to it.

### Types of Proxies

**Static Proxy (hand-written):**
```java
public interface OrderService {
    Order placeOrder(Cart cart);
    Order getOrder(long id);
}

public class OrderServiceProxy implements OrderService {
    private final OrderService delegate;
    private final AuditLogger auditLogger;

    public OrderServiceProxy(OrderService delegate, AuditLogger auditLogger) {
        this.delegate = delegate;
        this.auditLogger = auditLogger;
    }

    @Override
    public Order placeOrder(Cart cart) {
        auditLogger.log("placeOrder called with " + cart.getId());
        Order result = delegate.placeOrder(cart);
        auditLogger.log("placeOrder returned order " + result.getId());
        return result;
    }

    @Override
    public Order getOrder(long id) {
        return delegate.getOrder(id); // no audit needed here
    }
}
```

**JDK Dynamic Proxy (interface-based):**
```java
public class LoggingInvocationHandler implements InvocationHandler {
    private final Object target;

    public LoggingInvocationHandler(Object target) { this.target = target; }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        long start = System.nanoTime();
        try {
            Object result = method.invoke(target, args); // delegate to real object
            long elapsed = System.nanoTime() - start;
            System.out.printf("[%s] %s took %.2fms%n",
                target.getClass().getSimpleName(), method.getName(), elapsed / 1e6);
            return result;
        } catch (InvocationTargetException e) {
            throw e.getCause(); // unwrap — re-throw the real exception
        }
    }
}

// Create proxy
OrderService realService = new RealOrderService();
OrderService proxy = (OrderService) Proxy.newProxyInstance(
    OrderService.class.getClassLoader(),
    new Class[]{OrderService.class},
    new LoggingInvocationHandler(realService)
);
// proxy is a generated class implementing OrderService
// ALL method calls go through invoke()
```

**CGLIB Proxy (subclass-based — used when no interface):**
Spring uses CGLIB when:
1. The target class does not implement any interface (`proxyTargetClass = false` is default but Spring Boot sets `proxyTargetClass = true` since Spring Boot 2.x)
2. Explicitly requested: `@EnableAspectJAutoProxy(proxyTargetClass = true)`

```java
// CGLIB creates a subclass at runtime using ASM bytecode manipulation:
// class OrderServiceCGLIB$$EnhancerBySpringCGLIB$$abc123 extends RealOrderService {
//     @Override
//     public Order placeOrder(Cart cart) {
//         // invoke interceptor chain first
//         return super.placeOrder(cart);
//     }
// }
```

**Limitations of proxy-based AOP (relevant for @Transactional):**
- `final` classes/methods cannot be proxied by CGLIB (cannot override final methods)
- Self-invocation bypasses proxy: if `method A()` calls `method B()` in the same class, Spring's proxy is not involved in the B() call — @Transactional on B() has no effect when called from A()

**JVM insight:** JDK dynamic proxy generates bytecode at runtime using `sun.misc.ProxyGenerator`. The generated class is loaded into a system classloader. In Java 9+, it uses `MethodHandles.Lookup` for more controlled loading.

---

# BEHAVIORAL PATTERNS

## 14. Chain of Responsibility

### Intent
Pass a request along a chain of handlers. Each handler either processes the request or passes it to the next handler.

### Servlet Filter / Spring Security Filter Chain
```java
public interface RequestHandler {
    void handle(HttpRequest request, HttpResponse response, RequestHandler next);
}

public class AuthenticationHandler implements RequestHandler {
    @Override
    public void handle(HttpRequest req, HttpResponse res, RequestHandler next) {
        String token = req.getHeader("Authorization");
        if (token == null || !isValid(token)) {
            res.setStatus(401);
            return; // chain broken — do NOT call next
        }
        req.setAttribute("userId", extractUserId(token));
        next.handle(req, res, null); // pass to next handler
    }
}

public class RateLimitHandler implements RequestHandler {
    private final RateLimiter limiter;

    @Override
    public void handle(HttpRequest req, HttpResponse res, RequestHandler next) {
        if (!limiter.tryAcquire()) {
            res.setStatus(429);
            return;
        }
        next.handle(req, res, null);
    }
}

// Chain builder
public class FilterChain implements RequestHandler {
    private final List<RequestHandler> handlers;
    private int index = 0;

    public FilterChain(RequestHandler... handlers) {
        this.handlers = Arrays.asList(handlers);
    }

    @Override
    public void handle(HttpRequest req, HttpResponse res, RequestHandler ignored) {
        if (index < handlers.size()) {
            handlers.get(index++).handle(req, res, this); // pass `this` as next
        }
    }
}

FilterChain chain = new FilterChain(
    new RateLimitHandler(limiter),
    new AuthenticationHandler(),
    new LoggingHandler(),
    new BusinessLogicHandler()
);
```

**Real-World:** `javax.servlet.FilterChain`, Spring Security's `SecurityFilterChain` (15+ filters by default), OkHttp Interceptors, Netty's `ChannelPipeline`.

---

## 15. Command

### Intent
Encapsulate a request as an object, allowing you to parameterize clients, queue requests, log them, or support undo/redo.

### Runnable as Command
`java.lang.Runnable` is exactly the Command pattern — the command interface is `run()`, with no receiver exposed to the invoker (ExecutorService).

### Undo/Redo Implementation
```java
public interface Command {
    void execute();
    void undo();
}

public class TextEditor {
    private final StringBuilder text = new StringBuilder();
    private final Deque<Command> history = new ArrayDeque<>();

    public void executeCommand(Command cmd) {
        cmd.execute();
        history.push(cmd);
    }

    public void undo() {
        if (!history.isEmpty()) {
            history.pop().undo();
        }
    }

    // Inner command — captures state via closure/fields
    public Command insertText(int position, String textToInsert) {
        return new Command() {
            @Override
            public void execute() {
                text.insert(position, textToInsert);
            }
            @Override
            public void undo() {
                text.delete(position, position + textToInsert.length());
            }
        };
    }

    public Command deleteText(int start, int end) {
        final String deleted = text.substring(start, end); // capture for undo
        return new Command() {
            @Override
            public void execute() { text.delete(start, end); }
            @Override
            public void undo() { text.insert(start, deleted); }
        };
    }
}

// Usage
TextEditor editor = new TextEditor();
editor.executeCommand(editor.insertText(0, "Hello"));
editor.executeCommand(editor.insertText(5, " World"));
editor.undo(); // removes " World"
editor.undo(); // removes "Hello"
```

**`Callable<V>` as Command with return value.** Used in `ExecutorService.submit()` — command queuing + result retrieval via Future.

---

## 16. Iterator

### Intent
Provide a way to sequentially access elements of an aggregate without exposing its underlying representation.

### Java Iterator Contract
```java
// java.util.Iterator
public interface Iterator<E> {
    boolean hasNext();
    E next();         // throws NoSuchElementException if no next
    default void remove() { throw new UnsupportedOperationException(); }
    default void forEachRemaining(Consumer<? super E> action) { /* default */ }
}
```

**For-each desugaring:**
```java
// Written
for (String s : list) { System.out.println(s); }

// Compiled to (javap -c)
Iterator<String> it = list.iterator();
while (it.hasNext()) {
    String s = it.next();
    System.out.println(s);
}
```

**External vs Internal Iterator:**
- External (Java Iterator): caller controls iteration — `hasNext()`/`next()`
- Internal (forEach, Stream): collection controls iteration — caller passes a lambda

**Fail-fast iterators:** `ArrayList`/`HashMap` iterators maintain a `modCount`. If the collection is structurally modified outside the iterator, `ConcurrentModificationException` is thrown. This is a best-effort mechanism, not a guarantee.

**Custom iterator — range tree:**
```java
public class NumberRange implements Iterable<Integer> {
    private final int start, end, step;

    public NumberRange(int start, int end, int step) {
        this.start = start; this.end = end; this.step = step;
    }

    @Override
    public Iterator<Integer> iterator() {
        return new Iterator<>() {
            private int current = start;

            @Override public boolean hasNext() { return current < end; }
            @Override public Integer next() {
                if (!hasNext()) throw new NoSuchElementException();
                int val = current;
                current += step;
                return val;
            }
        };
    }
}
// for (int n : new NumberRange(0, 100, 5)) { ... }
```

---

## 17. Mediator

### Intent
Define an object that encapsulates how a set of objects interact. Promotes loose coupling.

### EventBus Pattern (Mediator variant)
```java
public class EventBus {
    private final Map<Class<?>, List<Consumer<Object>>> listeners = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @SuppressWarnings("unchecked")
    public <T> void subscribe(Class<T> eventType, Consumer<T> handler) {
        listeners.computeIfAbsent(eventType, k -> new CopyOnWriteArrayList<>())
                 .add((Consumer<Object>) handler);
    }

    public <T> void publishAsync(T event) {
        List<Consumer<Object>> handlers = listeners.get(event.getClass());
        if (handlers != null) {
            handlers.forEach(h -> executor.submit(() -> h.accept(event)));
        }
    }
}

// Components don't know about each other — only about EventBus
// OrderService publishes, NotificationService listens
eventBus.subscribe(OrderPlacedEvent.class, notificationService::sendConfirmation);
eventBus.subscribe(OrderPlacedEvent.class, inventoryService::reserveItems);
eventBus.subscribe(OrderPlacedEvent.class, analyticsService::trackConversion);
```

**Real-World:** Guava EventBus, Spring's `ApplicationEventPublisher`, Vert.x EventBus, MediatR in .NET.

---

## 18. Memento

### Intent
Capture and externalize an object's internal state without violating encapsulation, so the object can be restored later.

```java
public final class EditorState {
    // Memento — immutable snapshot
    public static final class Memento {
        private final String content;
        private final int cursorPosition;
        private final Instant savedAt;

        private Memento(String content, int cursorPosition) {
            this.content = content;
            this.cursorPosition = cursorPosition;
            this.savedAt = Instant.now();
        }

        // Only the Editor (originator) can read the state
        // Caretaker (history list) just stores Mementos
    }

    private String content;
    private int cursorPosition;

    public Memento save() {
        return new Memento(content, cursorPosition);
    }

    public void restore(Memento m) {
        this.content = m.content;
        this.cursorPosition = m.cursorPosition;
    }
}

// Caretaker
public class EditorHistory {
    private final Deque<EditorState.Memento> stack = new ArrayDeque<>();
    private static final int MAX_HISTORY = 50;

    public void push(EditorState.Memento m) {
        if (stack.size() >= MAX_HISTORY) stack.removeLast();
        stack.push(m);
    }

    public Optional<EditorState.Memento> pop() {
        return stack.isEmpty() ? Optional.empty() : Optional.of(stack.pop());
    }
}
```

---

## 19. Observer

### Intent
Define a one-to-many dependency between objects so that when one changes state, all dependents are notified automatically.

### Java EventListener vs Reactive Streams

**Classic Observer (java.util.Observer is deprecated since Java 9):**
```java
public interface StockObserver {
    void onPriceChange(String ticker, BigDecimal newPrice);
}

public class StockTicker {
    private final Map<String, List<StockObserver>> observers = new ConcurrentHashMap<>();

    public void subscribe(String ticker, StockObserver observer) {
        observers.computeIfAbsent(ticker, k -> new CopyOnWriteArrayList<>()).add(observer);
    }

    public void unsubscribe(String ticker, StockObserver observer) {
        observers.getOrDefault(ticker, Collections.emptyList()).remove(observer);
    }

    public void priceUpdate(String ticker, BigDecimal price) {
        observers.getOrDefault(ticker, Collections.emptyList())
                 .forEach(o -> {
                     try { o.onPriceChange(ticker, price); }
                     catch (Exception e) { /* isolate one observer's failure */ }
                 });
    }
}
```

**Reactive (Project Reactor / RxJava) — Push-based with backpressure:**
Observer pattern without backpressure breaks when publisher is faster than subscriber. Reactive Streams (`Publisher<T>` / `Subscriber<T>`) add flow control via `request(n)`.

**Memory leak pitfall:** If observers register but never unregister, the subject holds strong references to them, preventing GC. Use `WeakReference<StockObserver>` in the observer list, or use `EventBus` patterns where unsubscription is explicit.

---

## 20. State

### Intent
Allow an object to alter its behavior when its internal state changes. The object will appear to change its class.

### FSM Implementation
```java
// State interface
public interface OrderState {
    void pay(OrderContext order);
    void ship(OrderContext order);
    void deliver(OrderContext order);
    void cancel(OrderContext order);
    String stateName();
}

// Context
public class OrderContext {
    private OrderState state = new PendingState();

    public void setState(OrderState state) { this.state = state; }
    public void pay() { state.pay(this); }
    public void ship() { state.ship(this); }
    public void deliver() { state.deliver(this); }
    public void cancel() { state.cancel(this); }
}

// Concrete states
public class PendingState implements OrderState {
    public void pay(OrderContext order) {
        System.out.println("Payment processed");
        order.setState(new PaidState()); // transition
    }
    public void ship(OrderContext order) { throw new IllegalStateException("Must pay first"); }
    public void deliver(OrderContext order) { throw new IllegalStateException("Not shipped"); }
    public void cancel(OrderContext order) {
        System.out.println("Order cancelled");
        order.setState(new CancelledState());
    }
    public String stateName() { return "PENDING"; }
}

public class PaidState implements OrderState {
    public void pay(OrderContext order) { throw new IllegalStateException("Already paid"); }
    public void ship(OrderContext order) {
        System.out.println("Order shipped");
        order.setState(new ShippedState());
    }
    public void cancel(OrderContext order) {
        System.out.println("Refund initiated");
        order.setState(new RefundedState());
    }
    // ...
}
```

**State vs Strategy:** Both delegate behavior via an interface. Difference: State transitions itself (states know about each other and trigger transitions). Strategy is stateless and doesn't transition.

---

## 21. Strategy

### Intent
Define a family of algorithms, encapsulate each one, and make them interchangeable.

### Lambda as Strategy (Java 8+)
```java
// Strategy interface
@FunctionalInterface
public interface SortStrategy<T> {
    List<T> sort(List<T> items);
}

// Strategies as lambdas — no boilerplate class needed
SortStrategy<Integer> quickSort = items -> { /* ... */ return items; };
SortStrategy<Integer> mergeSort = items -> { /* ... */ return items; };
SortStrategy<Integer> insertionSort = items -> { /* ... */ return items; };

// Comparator is Strategy in JDK
List<Employee> employees = new ArrayList<>(...);
employees.sort(Comparator.comparing(Employee::getDepartment)
               .thenComparing(Comparator.comparing(Employee::getSalary).reversed()));

// Strategy injection via constructor
public class ReportGenerator {
    private final SortStrategy<ReportLine> sortStrategy;
    private final FormattingStrategy<ReportLine> formatStrategy;

    public ReportGenerator(SortStrategy<ReportLine> sort, FormattingStrategy<ReportLine> format) {
        this.sortStrategy = sort;
        this.formatStrategy = format;
    }

    public String generate(List<ReportLine> data) {
        List<ReportLine> sorted = sortStrategy.sort(data);
        return formatStrategy.format(sorted);
    }
}
// Runtime composition: no subclassing needed
ReportGenerator gen = new ReportGenerator(
    data -> data.stream().sorted(Comparator.comparing(ReportLine::getDate)).collect(Collectors.toList()),
    data -> data.stream().map(ReportLine::toCsv).collect(Collectors.joining("\n"))
);
```

**Real-World:** `java.util.Comparator`, `ExecutorService` (thread pool strategy), `javax.xml.validation.SchemaFactory`, Spring's `PlatformTransactionManager`, `HandlerMapping` in Spring MVC.

---

## 22. Template Method

### Intent
Define the skeleton of an algorithm in a base class, deferring some steps to subclasses (hooks).

### Hollywood Principle: "Don't call us, we'll call you"
```java
public abstract class DataMigration {
    // Template method — defines algorithm skeleton
    public final void migrate() {
        connect();
        readData();     // abstract — subclass implements
        transformData(); // hook — optional override
        validateData(); // abstract
        writeData();    // abstract
        disconnect();
        reportMetrics();
    }

    private void connect() { /* common connection logic */ }
    private void disconnect() { /* common disconnect */ }
    private void reportMetrics() { /* common metrics */ }

    // Hook — default implementation, subclass may override
    protected void transformData() { /* default: no-op */ }

    // Abstract steps — subclass must implement
    protected abstract List<Record> readData();
    protected abstract List<Record> validateData();
    protected abstract void writeData();
}

public class MySQLToPostgresMigration extends DataMigration {
    @Override
    protected List<Record> readData() { /* MySQL-specific read */ return null; }
    @Override
    protected List<Record> validateData() { /* PG-specific validation */ return null; }
    @Override
    protected void writeData() { /* PG-specific write */ }
    @Override
    protected void transformData() { /* type coercion between MySQL and PG types */ }
}
```

**Real-World:** `AbstractList` (`get(int)` and `size()` abstract; `contains()`, `iterator()` etc. implemented in terms of them), `HttpServlet.service()` (calls `doGet()`/`doPost()` etc.), `AbstractQueuedSynchronizer` (AQS — `tryAcquire()`/`tryRelease()` abstract, queue management in template), Spring's `JdbcTemplate` (resource management is the template, SQL is the hook).

**Template Method vs Strategy:** Template Method uses inheritance (compile-time); Strategy uses composition (runtime). Prefer Strategy (favor composition over inheritance).

---

## 23. Visitor

### Intent
Represent an operation to be performed on elements of an object structure. Lets you define new operations without changing element classes.

### Double Dispatch
Java does NOT support method overloading based on runtime type (only compile-time type). Visitor solves this via double dispatch:

```java
// Element hierarchy — each accepts a visitor
public interface Shape {
    <R> R accept(ShapeVisitor<R> visitor);
}

public class Circle implements Shape {
    public final double radius;
    public Circle(double radius) { this.radius = radius; }
    @Override public <R> R accept(ShapeVisitor<R> v) { return v.visitCircle(this); }
}

public class Rectangle implements Shape {
    public final double width, height;
    public Rectangle(double w, double h) { this.width = w; this.height = h; }
    @Override public <R> R accept(ShapeVisitor<R> v) { return v.visitRectangle(this); }
}

public class Triangle implements Shape {
    public final double base, height;
    public Triangle(double b, double h) { this.base = b; this.height = h; }
    @Override public <R> R accept(ShapeVisitor<R> v) { return v.visitTriangle(this); }
}

// Visitor interface
public interface ShapeVisitor<R> {
    R visitCircle(Circle c);
    R visitRectangle(Rectangle r);
    R visitTriangle(Triangle t);
}

// Concrete visitors — new operations without touching Shape classes
public class AreaCalculator implements ShapeVisitor<Double> {
    public Double visitCircle(Circle c) { return Math.PI * c.radius * c.radius; }
    public Double visitRectangle(Rectangle r) { return r.width * r.height; }
    public Double visitTriangle(Triangle t) { return 0.5 * t.base * t.height; }
}

public class SVGRenderer implements ShapeVisitor<String> {
    public String visitCircle(Circle c) { return "<circle r=\"" + c.radius + "\"/>"; }
    public String visitRectangle(Rectangle r) {
        return "<rect width=\"" + r.width + "\" height=\"" + r.height + "\"/>";
    }
    public String visitTriangle(Triangle t) { return "<polygon .../>"; }
}

// Double dispatch in action
List<Shape> shapes = List.of(new Circle(5), new Rectangle(3, 4), new Triangle(6, 8));
AreaCalculator calc = new AreaCalculator();
double totalArea = shapes.stream()
    .mapToDouble(s -> s.accept(calc)) // dispatch #1: accept() on concrete type
    .sum();                            // dispatch #2: visitXxx() on concrete visitor
```

**Why needed:** Without Visitor, adding a new operation (e.g., `perimeter()`) requires modifying every Shape class. Visitor lets you add operations in one place.

**Limitation:** Adding a new element (e.g., `Hexagon`) requires modifying ALL visitor implementations. Use when element hierarchy is stable but operations change frequently.

**Real-World:** Java compiler (AST visitors), ANTLR4 visitor pattern, `javax.lang.model.element` visitors.

---

## 24. Interpreter (Brief)

### Intent
Given a language, define a representation for its grammar, along with an interpreter.

**When it appears in interviews:** Rarely asked as a design problem. More context: regex, SQL parsing, expression trees.

```java
// Expression tree for: "(5 + 3) * 2"
public interface Expression {
    int interpret();
}

public record NumberExpression(int value) implements Expression {
    public int interpret() { return value; }
}

public record AddExpression(Expression left, Expression right) implements Expression {
    public int interpret() { return left.interpret() + right.interpret(); }
}

public record MultiplyExpression(Expression left, Expression right) implements Expression {
    public int interpret() { return left.interpret() * right.interpret(); }
}

// Build the AST
Expression expr = new MultiplyExpression(
    new AddExpression(new NumberExpression(5), new NumberExpression(3)),
    new NumberExpression(2)
);
System.out.println(expr.interpret()); // 16
```

**Real-World:** `java.util.regex.Pattern`, Spring SpEL (`ExpressionParser`), OGNL, `javax.el.ExpressionLanguage`.

---

## Anti-Pattern Summary

| Pattern Misuse | Problem |
|---|---|
| Singleton everywhere | Tight coupling, untestable, hidden dependencies |
| Abstract Factory for one product | Overkill — use Factory Method or static factory |
| Builder for 2-3 params | Boilerplate without benefit — use constructor |
| Deep Decorator chains | Stack trace hell, hard to debug |
| Visitor when hierarchy changes | Requires modifying all visitors on new element |
| Template Method instead of Strategy | Inheritance instead of composition — fragile |
| Proxy on final classes | CGLIB cannot subclass final — NullPointerException or bean creation failure |
| Observer without unsubscription | Memory leaks in long-running services |
