# Java & Spring Internals — Deep LLD Reference
## Senior Java LLD | Spring Boot Internals | Interview-Ready

---

## Spring IoC Container

### BeanFactory vs ApplicationContext

| Feature | BeanFactory | ApplicationContext |
|---|---|---|
| Bean definition | Yes | Yes (extends BeanFactory) |
| Dependency injection | Yes | Yes |
| Eager initialization of singletons | No (lazy by default) | Yes (at startup) |
| Event propagation | No | Yes (`ApplicationEventPublisher`) |
| Internationalization | No | Yes (`MessageSource`) |
| Environment abstraction | No | Yes (`Environment`) |
| AOP integration | Limited | Full |
| `BeanPostProcessor` auto-detection | Manual | Automatic |
| Use case | Low-overhead, restricted envs | Standard Spring apps |

```java
// BeanFactory — low level, manual registration
BeanFactory factory = new DefaultListableBeanFactory();
XmlBeanDefinitionReader reader = new XmlBeanDefinitionReader((DefaultListableBeanFactory) factory);
reader.loadBeanDefinitions("beans.xml");
// BeanPostProcessors NOT automatically applied — must register manually
// Singleton beans NOT eagerly instantiated

// ApplicationContext — full container
ApplicationContext context = new AnnotationConfigApplicationContext(AppConfig.class);
// At construction time:
// 1. All BeanDefinitions registered
// 2. All BeanPostProcessors and BeanFactoryPostProcessors auto-detected and applied
// 3. All singleton beans eagerly instantiated (unless @Lazy)
// 4. ApplicationContextAware/BeanNameAware callbacks fired
```

### Bean Lifecycle — Complete Sequence

```java
// Complete lifecycle (every step):
@Component
public class OrderService
        implements BeanNameAware, BeanFactoryAware, ApplicationContextAware,
                   InitializingBean, DisposableBean {

    // ---- Phase 1: Instantiation ----
    // Spring calls the constructor (dependency injection via constructor injection)
    @Autowired
    public OrderService(OrderRepository repository) { /* ... */ }

    // ---- Phase 2: Populate Properties ----
    // @Autowired fields/setters injected here (after constructor)
    @Autowired
    private PaymentGateway paymentGateway;

    // ---- Phase 3: *Aware callbacks ----
    // BeanNameAware first, then BeanFactoryAware, then ApplicationContextAware
    @Override
    public void setBeanName(String name) {
        System.out.println("My bean name: " + name); // e.g., "orderService"
    }

    @Override
    public void setBeanFactory(BeanFactory factory) {
        // Access to raw BeanFactory — rarely needed
    }

    @Override
    public void setApplicationContext(ApplicationContext ctx) {
        // Can hold ref, but prefer constructor injection for testability
    }

    // ---- Phase 4: BeanPostProcessor.postProcessBeforeInitialization ----
    // All BeanPostProcessors run here (Spring's own: @Autowired, @Value, etc.)
    // You can implement BeanPostProcessor to intercept ALL beans

    // ---- Phase 5: @PostConstruct ----
    @PostConstruct
    public void init() {
        // Runs AFTER all dependencies injected, BEFORE bean is used
        // Good for: validation, cache warming, connection verification
        Objects.requireNonNull(paymentGateway, "paymentGateway must be injected");
        System.out.println("OrderService initialized");
    }

    // ---- Phase 6: InitializingBean.afterPropertiesSet ----
    @Override
    public void afterPropertiesSet() {
        // Equivalent to @PostConstruct but couples to Spring API
        // @PostConstruct is preferred (JSR-250, not Spring-specific)
    }

    // ---- Phase 7: @Bean(initMethod) ----
    // If configured: @Bean(initMethod = "customInit")
    public void customInit() { /* ... */ }

    // ---- Phase 8: BeanPostProcessor.postProcessAfterInitialization ----
    // Spring AOP proxy creation happens here
    // This is where @Transactional, @Async, @Cacheable proxies are created

    // ---- Bean is now READY — in service ----

    // ---- Phase 9: @PreDestroy ----
    @PreDestroy
    public void cleanup() {
        // Runs on context close (shutdown hook, or context.close())
        // Good for: connection pool shutdown, cache flush, file close
        System.out.println("OrderService shutting down");
    }

    // ---- Phase 10: DisposableBean.destroy ----
    @Override
    public void destroy() {
        // Spring-specific equivalent of @PreDestroy
    }

    // ---- Phase 11: @Bean(destroyMethod) ----
    // If configured: @Bean(destroyMethod = "customDestroy")
}
```

**BeanPostProcessor — the most powerful extension point:**
```java
@Component
public class TimingBeanPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessBeforeInitialization(Object bean, String beanName) {
        return bean; // can return a different object (a proxy!)
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        // Spring AOP does its proxy wrapping here
        // If this returns a CGLIB proxy, the original bean is replaced in the context
        // This is exactly how @Transactional and @Async work
        return bean;
    }
}
```

---

## Spring AOP

### Proxy Mechanisms — JDK Dynamic Proxy vs CGLIB

**JDK Dynamic Proxy:**
- Requires the target to implement at least one interface
- Proxy is a new class implementing the same interfaces
- Method interception via `InvocationHandler`
- `proxy instanceof TargetInterface` returns true
- `proxy instanceof TargetClass` returns false (proxy is NOT the target)

**CGLIB Proxy:**
- Works on any class (interface or not)
- Creates a bytecode-generated **subclass** of the target at runtime using ASM
- Method interception via `MethodInterceptor` (overriding each method)
- Constructor called twice (once for the real object, once for the proxy subclass)
- Cannot proxy: `final` classes, `final` methods, `private` methods
- `proxy instanceof TargetClass` returns true

**Spring Boot default (2.x+):** `proxyTargetClass = true` — CGLIB for ALL beans, even those with interfaces. Reason: avoids confusion where `@Autowired MyServiceImpl impl` fails because only the interface type is proxied.

```java
// How Spring creates a JDK proxy for a @Transactional service
// (simplified — actual Spring code is more complex)
OrderService target = new OrderServiceImpl(repository);

OrderService proxy = (OrderService) Proxy.newProxyInstance(
    target.getClass().getClassLoader(),
    new Class[]{OrderService.class},
    new InvocationHandler() {
        private final TransactionInterceptor txInterceptor = new TransactionInterceptor(txManager);

        @Override
        public Object invoke(Object proxyObj, Method method, Object[] args) throws Throwable {
            // Check if @Transactional on this method
            Transactional txAnnotation = method.getAnnotation(Transactional.class);
            if (txAnnotation != null) {
                return txInterceptor.invoke(
                    new MethodInvocation(target, method, args) // wraps actual invocation
                );
            }
            return method.invoke(target, args); // no transaction, direct call
        }
    }
);
```

### Self-Invocation — Why @Transactional Breaks
```java
@Service
public class OrderService {
    // Spring injects a PROXY of OrderService into the context
    // When you call proxy.placeOrder(...), the proxy intercepts and starts a transaction

    public void placeOrder(Cart cart) {
        // This calls this.processPayment() — NOT proxy.processPayment()
        // The JVM invokes the method directly on 'this' (the real object, not the proxy)
        // The @Transactional on processPayment() is IGNORED — no proxy involved
        processPayment(cart.getTotal());
    }

    @Transactional
    public void processPayment(BigDecimal amount) {
        // Runs WITHOUT a transaction because called via this, not proxy
        paymentRepository.save(new Payment(amount));
    }
}
```

**Fixes for self-invocation:**

Option 1: Inject self (not clean but works)
```java
@Service
public class OrderService {
    @Autowired
    private OrderService self; // Spring injects the proxy!

    public void placeOrder(Cart cart) {
        self.processPayment(cart.getTotal()); // proxy intercepts — transaction starts
    }
}
```

Option 2: Extract to a separate bean (cleanest)
```java
@Service
public class PaymentService {
    @Transactional
    public void processPayment(BigDecimal amount) { /* ... */ }
}

@Service
public class OrderService {
    @Autowired
    private PaymentService paymentService; // separate bean = different proxy

    public void placeOrder(Cart cart) {
        paymentService.processPayment(cart.getTotal()); // proxy intercepts correctly
    }
}
```

Option 3: AspectJ compile-time / load-time weaving (bypasses proxy entirely)

### AspectJ vs Spring AOP

| Feature | Spring AOP | AspectJ |
|---|---|---|
| Mechanism | Runtime proxy (JDK/CGLIB) | Bytecode weaving (compile/load/runtime) |
| Scope | Spring-managed beans only | Any Java object (new ClassName(), too) |
| Self-invocation | Broken | Works (no proxy) |
| `final` methods | Cannot advise | Can advise (bytecode level) |
| Performance | Proxy overhead per call | Near-zero (woven into bytecode) |
| Complexity | Simple (Spring-native) | Requires ajc compiler or agent |

---

## Spring Transaction Management

### @Transactional Under the Hood
1. Spring's `BeanPostProcessor` detects `@Transactional` methods/classes
2. Creates a proxy (JDK or CGLIB) for the bean
3. On method call via proxy: `TransactionInterceptor` is invoked
4. `TransactionInterceptor` calls `PlatformTransactionManager.getTransaction(txDef)`
5. `PlatformTransactionManager` checks `TransactionSynchronizationManager` (thread-local) for existing transaction
6. Based on propagation, either joins existing or creates new transaction
7. Executes the method in the `try` block
8. On success: `PlatformTransactionManager.commit(txStatus)`
9. On `RuntimeException` or `Error`: `PlatformTransactionManager.rollback(txStatus)`
10. `TransactionSynchronizationManager` clears thread-local state

### TransactionSynchronizationManager — Thread-Local State
```java
// Simplified view of what Spring uses internally
public class TransactionSynchronizationManager {
    // Each thread has its own "current transaction" state
    private static final ThreadLocal<Map<Object, Object>> resources = new NamedThreadLocal<>();
    private static final ThreadLocal<Set<TransactionSynchronization>> synchronizations = new NamedThreadLocal<>();
    private static final ThreadLocal<String> currentTransactionName = new NamedThreadLocal<>();
    private static final ThreadLocal<Boolean> currentTransactionReadOnly = new NamedThreadLocal<>();
    private static final ThreadLocal<Integer> currentTransactionIsolationLevel = new NamedThreadLocal<>();
    private static final ThreadLocal<Boolean> actualTransactionActive = new NamedThreadLocal<>();

    // How @Transactional service access to connection works:
    // DataSourceTransactionManager binds Connection to current thread via resources
    // JdbcTemplate calls DataSourceUtils.getConnection(dataSource) which reads from thread-local
    // So JdbcTemplate, JPA, etc. all participate in the SAME transaction transparently
}
```

### Transaction Propagation Levels — Exact Behavior

```java
// ---- REQUIRED (default) ----
// If active transaction: join it
// If no transaction: create new
@Transactional(propagation = Propagation.REQUIRED)
public void createOrder(Order order) {
    // Called without transaction? New transaction started here.
    // Called FROM a transaction (e.g., outer service)? Joins that transaction.
    // IMPORTANT: if inner method marks rollback-only, the ENTIRE outer transaction rolls back
    // even if outer method catches the exception!
    orderRepository.save(order);
}

// ---- REQUIRES_NEW ----
// ALWAYS creates new independent physical transaction
// Suspends outer transaction for its duration
// Commits/rolls back independently of outer
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void auditLog(AuditEntry entry) {
    // Even if outer transaction rolls back, the audit log is committed
    // Outer transaction is SUSPENDED until this method returns
    // Use case: audit logging, sequence generation — must persist regardless
    auditRepository.save(entry);
}

// ---- NESTED ----
// Uses SAVEPOINT within the outer physical transaction
// Rollback rolls back to savepoint, not the entire transaction
// Outer transaction can still commit after inner rolls back
// NOTE: JPA/Hibernate does NOT support nested (no savepoint API in JPA)
// Only JDBC DataSourceTransactionManager supports it
@Transactional(propagation = Propagation.NESTED)
public void saveAddress(Address address) {
    // If this fails: rolls back to savepoint before saveAddress
    // Outer transaction continues and can still commit
    addressRepository.save(address);
}

// REQUIRED vs REQUIRES_NEW vs NESTED:
// REQUIRED: same connection, same transaction — all-or-nothing together
// REQUIRES_NEW: new connection, new transaction — independent commit/rollback
// NESTED: same connection, savepoint — partial rollback possible

// ---- SUPPORTS ----
// If active transaction: join it
// If no transaction: run non-transactionally (no transaction started)
@Transactional(propagation = Propagation.SUPPORTS)
public Optional<Order> findOrder(long id) {
    // Works with or without transaction
    // Within @Transactional method: participates (reads see uncommitted data of outer tx)
    // Outside: plain non-transactional read
    return orderRepository.findById(id);
}

// ---- MANDATORY ----
// MUST have active transaction — throws if none
@Transactional(propagation = Propagation.MANDATORY)
public void updateInventory(long productId, int qty) {
    // Use when this operation MUST be called within a transaction
    // Self-documents the contract: caller must provide a transaction
    // Throws TransactionRequiredException if called without one
    inventoryRepository.updateQuantity(productId, qty);
}

// ---- NOT_SUPPORTED ----
// Suspends active transaction, runs non-transactionally
// Use when operation must NOT be in a transaction (e.g., expensive read that should release locks)
@Transactional(propagation = Propagation.NOT_SUPPORTED)
public List<Product> bulkExport() {
    // Huge SELECT — don't want to hold DB connection for duration of entire outer tx
    return productRepository.findAll();
}

// ---- NEVER ----
// Must NOT have active transaction — throws if one exists
@Transactional(propagation = Propagation.NEVER)
public void nonTransactionalOperation() {
    // IllegalTransactionStateException if called within a transaction
}
```

### Rollback Rules
```java
// Default: rolls back on RuntimeException and Error
// Does NOT roll back on checked exceptions (Exception, IOException, etc.)

@Transactional(rollbackFor = {IOException.class, PaymentException.class})
public void processPayment(Payment p) throws IOException {
    // IOException triggers rollback (overriding default behavior)
}

@Transactional(noRollbackFor = IllegalArgumentException.class)
public void updateOrder(Order o) {
    // IllegalArgumentException does NOT trigger rollback
    // (overriding the default that RuntimeException triggers rollback)
}
```

---

## Spring MVC — DispatcherServlet Flow

```
HTTP Request
    ↓
DispatcherServlet.doDispatch()
    ↓
1. HandlerMapping.getHandler(request)
   → Returns HandlerExecutionChain (handler + interceptors)
   → Implementations: RequestMappingHandlerMapping (@RequestMapping), RouterFunctionMapping, etc.
    ↓
2. HandlerAdapter.handle(request, response, handler)
   → Adapts the handler to the actual invocation
   → RequestMappingHandlerAdapter: resolves @RequestMapping methods
    ↓
3. Interceptors.preHandle(request, response, handler)
   → HandlerInterceptor.preHandle() runs (auth, logging, etc.)
   → Returns false = request aborted here
    ↓
4. Argument Resolution
   → HandlerMethodArgumentResolver resolves @RequestParam, @PathVariable,
      @RequestBody (via HttpMessageConverter), @RequestHeader, etc.
    ↓
5. Handler Method Invocation
   → Calls your @Controller method
   → @ExceptionHandler if exception thrown
    ↓
6. Return Value Handling
   → HandlerMethodReturnValueHandler: @ResponseBody → HttpMessageConverter (Jackson)
   → String view name → ViewResolver → View.render()
    ↓
7. Interceptors.postHandle(request, response, handler, modelAndView)
    ↓
8. View rendering (if not @ResponseBody)
    ↓
9. Interceptors.afterCompletion(request, response, handler, ex)
    ↓
HTTP Response
```

### @RequestMapping Resolution
```java
// RequestMappingHandlerMapping builds a map at startup:
// Map<RequestMappingInfo, HandlerMethod>

// RequestMappingInfo = (URL pattern, HTTP method, params, headers, consumes, produces)

// Matching algorithm:
// 1. Find all handlers matching URL pattern
// 2. Filter by HTTP method
// 3. Filter by consumes (Content-Type)
// 4. Filter by produces (Accept)
// 5. Sort by specificity (exact > pattern > most-specific-pattern)
// 6. First result = selected handler

@RestController
@RequestMapping("/orders")
public class OrderController {
    // HandlerMethod registered for: GET /orders/{id}
    @GetMapping("/{id}")
    public OrderDTO getOrder(@PathVariable long id, // PathVariable resolver
                              @RequestParam(required = false) String format, // RequestParam resolver
                              @RequestHeader("Authorization") String auth) { // RequestHeader resolver
        return orderService.findById(id);
    }

    // @RequestBody → Jackson's MappingJackson2HttpMessageConverter
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderDTO createOrder(@RequestBody @Valid CreateOrderRequest request,
                                 BindingResult bindingResult) {
        if (bindingResult.hasErrors()) throw new ValidationException(bindingResult);
        return orderService.create(request);
    }
}
```

### HttpMessageConverter Chain
```java
// When @RequestBody processed:
// 1. Read Content-Type header
// 2. Iterate message converters: canRead(targetType, contentType)?
// 3. First matching converter calls read()

// Default converters (in order):
// ByteArrayHttpMessageConverter    — application/octet-stream
// StringHttpMessageConverter       — text/plain, text/*
// ResourceHttpMessageConverter     — */*
// ResourceRegionHttpMessageConverter
// SourceHttpMessageConverter
// AllEncompassingFormHttpMessageConverter  — application/x-www-form-urlencoded
// MappingJackson2HttpMessageConverter      — application/json (if Jackson on classpath)
// MappingJackson2XmlHttpMessageConverter  — application/xml (if Jackson XML on classpath)
```

---

## Spring Boot Autoconfiguration

### How It Works
```java
// @SpringBootApplication = @Configuration + @EnableAutoConfiguration + @ComponentScan

// @EnableAutoConfiguration triggers:
// 1. Spring Boot reads META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
//    (Spring Boot 2.7+, previously META-INF/spring.factories)
// 2. For each AutoConfiguration class listed, Spring evaluates @Conditional* annotations
// 3. If conditions pass, the @Configuration class is applied

// Example: DataSourceAutoConfiguration
@AutoConfiguration
@ConditionalOnClass({ DataSource.class, EmbeddedDatabaseType.class })  // <- needs these on classpath
@ConditionalOnMissingBean(type = "io.r2dbc.spi.ConnectionFactory")     // <- not reactive
@EnableConfigurationProperties(DataSourceProperties.class)
@Import({ DataSourcePoolMetadataProvidersConfiguration.class, ... })
public class DataSourceAutoConfiguration {

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnMissingBean(DataSource.class)    // <- only if no custom DataSource defined
    @ConditionalOnSingleCandidate(DataSource.class)
    static class PooledDataSourceConfiguration {

        @Bean
        @ConditionalOnMissingBean
        @ConditionalOnSingleCandidate
        HikariDataSource dataSource(DataSourceProperties properties) {
            // Creates HikariCP pool from spring.datasource.* properties
            return properties.initializeDataSourceBuilder()
                .type(HikariDataSource.class)
                .build();
        }
    }
}
```

### Key Conditional Annotations
```java
@ConditionalOnClass(Foo.class)         // passes if Foo is on the classpath
@ConditionalOnMissingClass("com.Foo")  // passes if Foo is NOT on classpath
@ConditionalOnBean(DataSource.class)   // passes if DataSource bean exists
@ConditionalOnMissingBean(DataSource.class) // passes if NO DataSource bean exists
@ConditionalOnProperty("spring.datasource.url") // passes if property set
@ConditionalOnWebApplication           // passes if running as web app
@ConditionalOnExpression("${feature.flags.enabled:false}") // SpEL condition
```

### Writing a Custom Starter

**Step 1: Autoconfigure module (`my-feature-spring-boot-autoconfigure`)**
```java
// AutoConfiguration class
@AutoConfiguration
@ConditionalOnClass(MyFeatureClient.class)
@ConditionalOnProperty(prefix = "my.feature", name = "enabled", havingValue = "true", matchIfMissing = false)
@EnableConfigurationProperties(MyFeatureProperties.class)
public class MyFeatureAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public MyFeatureClient myFeatureClient(MyFeatureProperties props) {
        return new MyFeatureClient(props.getUrl(), props.getApiKey());
    }
}

// Properties class
@ConfigurationProperties(prefix = "my.feature")
public class MyFeatureProperties {
    private boolean enabled = false;
    private String url = "https://api.example.com";
    private String apiKey;
    // getters/setters
}
```

**Step 2: Register autoconfiguration**
```
# src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.MyFeatureAutoConfiguration
```

**Step 3: Starter module (`my-feature-spring-boot-starter`)**
```xml
<!-- Only POM — depends on autoconfigure module and the feature library -->
<dependencies>
    <dependency>
        <groupId>com.example</groupId>
        <artifactId>my-feature-spring-boot-autoconfigure</artifactId>
    </dependency>
    <dependency>
        <groupId>com.example</groupId>
        <artifactId>my-feature-core</artifactId>
    </dependency>
</dependencies>
```

**Usage: Add `my-feature-spring-boot-starter` to any Spring Boot app's pom.xml. Autoconfiguration activates automatically.**

---

## Jackson Internals

### ObjectMapper Thread Safety
```java
// ObjectMapper IS thread-safe AFTER configuration.
// NEVER modify ObjectMapper from multiple threads concurrently.
// Best practice: configure once at startup, share the singleton.

@Configuration
public class JacksonConfig {
    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        mapper.configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
        mapper.setSerializationInclusion(JsonInclude.Include.NON_NULL);
        return mapper; // singleton — thread-safe for all read/write operations
    }
}

// ObjectReader and ObjectWriter (created via mapper.reader()/.writer()) are immutable
// → completely thread-safe, create once and share
ObjectReader reader = mapper.readerFor(Order.class); // immutable, share freely
ObjectWriter writer = mapper.writerWithDefaultPrettyPrinter(); // immutable
```

### Serialization / Deserialization Internals
```java
// Serialization: Object → JSON
// 1. mapper.writeValue() called
// 2. SerializerProvider locates BeanSerializer for the class (cached in TypeFactory)
// 3. BeanSerializer iterates over properties (via BeanPropertyWriter, built from reflection)
// 4. Each property: find its JsonSerializer<T>, call serialize()
// 5. JsonSerializer writes to JsonGenerator (which writes to OutputStream/Writer)

// Key: BeanSerializer is cached per type. First call = expensive (reflection).
// Subsequent calls = cached, very fast.

// Custom serializer
public class MoneySerializer extends JsonSerializer<Money> {
    @Override
    public void serialize(Money value, JsonGenerator gen, SerializerProvider provider)
            throws IOException {
        gen.writeStartObject();
        gen.writeNumberField("amount", value.getAmount());
        gen.writeStringField("currency", value.getCurrency().getCurrencyCode());
        gen.writeEndObject();
    }
}

// Custom deserializer
public class MoneyDeserializer extends JsonDeserializer<Money> {
    @Override
    public Money deserialize(JsonParser p, DeserializationContext ctx) throws IOException {
        ObjectCodec codec = p.getCodec();
        JsonNode node = codec.readTree(p);
        BigDecimal amount = node.get("amount").decimalValue();
        String currencyCode = node.get("currency").asText();
        return new Money(amount, Currency.getInstance(currencyCode));
    }
}

// Register
SimpleModule module = new SimpleModule();
module.addSerializer(Money.class, new MoneySerializer());
module.addDeserializer(Money.class, new MoneyDeserializer());
mapper.registerModule(module);

// OR via annotation
@JsonSerialize(using = MoneySerializer.class)
@JsonDeserialize(using = MoneyDeserializer.class)
public class Money { /* ... */ }
```

### Polymorphic Deserialization
```java
// Problem: deserializing a List<Shape> where each element could be Circle or Rectangle
// JSON: [{"type":"circle","radius":5}, {"type":"rectangle","width":3,"height":4}]

@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,        // use "type" field to determine class
    include = JsonTypeInfo.As.PROPERTY, // "type" is a property in the JSON
    property = "type"                  // name of the discriminator field
)
@JsonSubTypes({
    @JsonSubTypes.Type(value = Circle.class, name = "circle"),
    @JsonSubTypes.Type(value = Rectangle.class, name = "rectangle"),
    @JsonSubTypes.Type(value = Triangle.class, name = "triangle")
})
@JsonIgnoreProperties(ignoreUnknown = true)
public abstract class Shape {
    public abstract double area();
}

public class Circle extends Shape {
    private double radius;
    public Circle() {}
    public Circle(double radius) { this.radius = radius; }
    public double getRadius() { return radius; }
    public double area() { return Math.PI * radius * radius; }
}

// Now:
List<Shape> shapes = mapper.readValue(json, new TypeReference<List<Shape>>() {});
// Jackson reads "type": "circle" → instantiates Circle, populates radius
```

### @JsonIgnore, @JsonProperty, @JsonAlias
```java
public class UserDTO {
    @JsonProperty("user_id")           // serializes/deserializes as "user_id" not "userId"
    private long userId;

    @JsonAlias({"full_name", "name"})  // accepts any of these aliases on deserialization
    @JsonProperty("displayName")       // serializes as "displayName"
    private String displayName;

    @JsonIgnore                        // excluded from both serialization and deserialization
    private String passwordHash;

    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY) // deserialization only, not serialized
    private String newPassword;

    @JsonProperty(access = JsonProperty.Access.READ_ONLY)  // serialized only, not deserialized
    private LocalDateTime createdAt;

    @JsonInclude(JsonInclude.Include.NON_NULL) // field-level: only include if non-null
    private String optionalField;
}
```

### Jackson Performance Pitfalls
```java
// 1. Creating new ObjectMapper per request — VERY SLOW
// ObjectMapper construction calls reflection to discover all standard modules
// Fix: singleton ObjectMapper

// 2. mapper.readValue(jsonString, Map.class) — deserializes numbers as Integer then Long then BigDecimal
// Fix: mapper.readValue(jsonString, new TypeReference<Map<String, Object>>(){}) with explicit type

// 3. Deserializing huge arrays without streaming
// Fix: use JsonParser + ObjectReader for streaming
try (JsonParser parser = mapper.createParser(inputStream)) {
    ObjectReader reader = mapper.readerFor(Order.class);
    MappingIterator<Order> it = reader.readValues(parser);
    while (it.hasNext()) {
        Order order = it.next(); // process one at a time — no full array in memory
        process(order);
    }
}

// 4. Polymorphic types with external type ID — security risk (CVE-2017-7525)
// Never use JsonTypeInfo.Id.CLASS with untrusted input (allows gadget chain deserialization)
// Safe: use JsonTypeInfo.Id.NAME with explicit @JsonSubTypes allowlist
```

---

## Spring Internals — Common Interview Questions

### Q: What happens when you call @Transactional method from non-Spring code?
The method executes without a transaction because no proxy is involved. `@Transactional` only works when called through the Spring proxy (i.e., the bean injected by Spring).

### Q: What is the difference between @Component, @Service, @Repository, @Controller?
Technically identical to `@Component` for component scanning. Semantic differences:
- `@Repository`: enables Spring's persistence exception translation (wraps JPA/JDBC exceptions into Spring's `DataAccessException`)
- `@Service`: marks the service layer — no special Spring behavior, but documents intent
- `@Controller` / `@RestController`: registers with `DispatcherServlet` for request handling

### Q: Spring singleton vs GoF singleton
- GoF singleton: one instance per JVM / ClassLoader
- Spring singleton: one instance per **ApplicationContext**
- Two `ApplicationContext` instances = two Spring "singletons" of the same class
- Spring prototype scope: new instance per injection/getBean() call

### Q: How does @Async work?
```java
@EnableAsync // on @Configuration class
@Service
public class EmailService {
    @Async // Spring creates a proxy, method runs in TaskExecutor thread pool
    public CompletableFuture<Void> sendEmail(String to, String body) {
        // Runs asynchronously in SimpleAsyncTaskExecutor (default) or custom Executor
        emailClient.send(to, body);
        return CompletableFuture.completedFuture(null);
    }
    // Same self-invocation problem as @Transactional applies here too
}
```

### Q: What does @ConditionalOnMissingBean enable?
It allows users to override auto-configured beans. If you define your own `DataSource` bean, `@ConditionalOnMissingBean(DataSource.class)` on the autoconfigured one means it won't be created. This is the fundamental extensibility mechanism of Spring Boot autoconfiguration.

### Q: How does Spring resolve circular dependencies?
For singleton beans with setter/field injection:
1. Spring creates instance A (constructor called, no properties set yet)
2. Stores A in "early singleton cache" (partially constructed)
3. Injects A's dependencies — needs B
4. Creates B (constructor called)
5. B needs A — Spring finds A in early singleton cache, injects it
6. B finishes initialization
7. Spring finishes A initialization with B injected

This does NOT work for constructor injection (hence Spring Boot 2.6+ throws by default — set `spring.main.allow-circular-references=true` to re-enable, but better to fix the design).
