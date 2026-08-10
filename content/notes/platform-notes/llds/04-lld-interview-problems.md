# LLD Interview Problems — Complete Java Implementations
## Senior Java LLD Reference | Compilable Code | Pattern-Annotated

---

## 1. Design a Parking Lot

### Requirements
- Multiple floors, multiple spot types (Compact, Large, Handicapped)
- Vehicle types: Motorcycle, Car, Truck
- Issue tickets on entry, calculate fee on exit
- Strategy for pricing (hourly, daily, flat rate)
- Singleton for the lot itself

### Design Patterns Used
- Singleton: `ParkingLot`
- Factory: `VehicleFactory`
- Strategy: `PricingStrategy`
- Observer: `SpotAvailabilityListener`

```java
// ==================== ENUMS ====================
public enum SpotType { COMPACT, LARGE, HANDICAPPED, MOTORCYCLE }
public enum VehicleType { MOTORCYCLE, CAR, TRUCK }

// ==================== VEHICLES ====================
public abstract class Vehicle {
    private final String licensePlate;
    private final VehicleType type;
    private final SpotType requiredSpotType;

    protected Vehicle(String licensePlate, VehicleType type, SpotType requiredSpotType) {
        this.licensePlate = Objects.requireNonNull(licensePlate);
        this.type = type;
        this.requiredSpotType = requiredSpotType;
    }
    public String getLicensePlate() { return licensePlate; }
    public VehicleType getType() { return type; }
    public SpotType getRequiredSpotType() { return requiredSpotType; }
}

public class Motorcycle extends Vehicle {
    public Motorcycle(String plate) { super(plate, VehicleType.MOTORCYCLE, SpotType.MOTORCYCLE); }
}
public class Car extends Vehicle {
    public Car(String plate) { super(plate, VehicleType.CAR, SpotType.COMPACT); }
}
public class Truck extends Vehicle {
    public Truck(String plate) { super(plate, VehicleType.TRUCK, SpotType.LARGE); }
}

// Factory — creational pattern
public class VehicleFactory {
    public static Vehicle create(VehicleType type, String licensePlate) {
        return switch (type) {
            case MOTORCYCLE -> new Motorcycle(licensePlate);
            case CAR        -> new Car(licensePlate);
            case TRUCK      -> new Truck(licensePlate);
        };
    }
}

// ==================== SPOTS ====================
public class ParkingSpot {
    private final String id;
    private final SpotType type;
    private Vehicle currentVehicle;

    public ParkingSpot(String id, SpotType type) {
        this.id = id;
        this.type = type;
    }

    public synchronized boolean isAvailable() { return currentVehicle == null; }

    public synchronized boolean park(Vehicle vehicle) {
        if (currentVehicle != null) return false;
        if (!canFit(vehicle)) return false;
        currentVehicle = vehicle;
        return true;
    }

    public synchronized Vehicle remove() {
        Vehicle v = currentVehicle;
        currentVehicle = null;
        return v;
    }

    private boolean canFit(Vehicle v) {
        // Compact spots: motorcycles and cars; Large spots: all; Handicapped: cars only
        return switch (type) {
            case MOTORCYCLE -> v.getType() == VehicleType.MOTORCYCLE;
            case COMPACT    -> v.getType() == VehicleType.MOTORCYCLE || v.getType() == VehicleType.CAR;
            case LARGE      -> true;
            case HANDICAPPED -> v.getType() == VehicleType.CAR;
        };
    }

    public String getId() { return id; }
    public SpotType getType() { return type; }
}

// ==================== FLOOR ====================
public class ParkingFloor {
    private final int floorNumber;
    private final List<ParkingSpot> spots;
    private final Map<SpotType, List<ParkingSpot>> spotsByType;

    public ParkingFloor(int floorNumber) {
        this.floorNumber = floorNumber;
        this.spots = new ArrayList<>();
        this.spotsByType = new EnumMap<>(SpotType.class);
        for (SpotType t : SpotType.values()) {
            spotsByType.put(t, new ArrayList<>());
        }
    }

    public void addSpot(ParkingSpot spot) {
        spots.add(spot);
        spotsByType.get(spot.getType()).add(spot);
    }

    public Optional<ParkingSpot> findAvailableSpot(SpotType type) {
        return spotsByType.getOrDefault(type, Collections.emptyList()).stream()
            .filter(ParkingSpot::isAvailable)
            .findFirst();
    }

    public int getAvailableCount(SpotType type) {
        return (int) spotsByType.getOrDefault(type, Collections.emptyList()).stream()
            .filter(ParkingSpot::isAvailable).count();
    }

    public int getFloorNumber() { return floorNumber; }
}

// ==================== TICKET ====================
public class Ticket {
    private final String ticketId;
    private final Vehicle vehicle;
    private final ParkingSpot spot;
    private final LocalDateTime entryTime;
    private LocalDateTime exitTime;
    private BigDecimal fee;

    public Ticket(Vehicle vehicle, ParkingSpot spot) {
        this.ticketId = UUID.randomUUID().toString();
        this.vehicle = vehicle;
        this.spot = spot;
        this.entryTime = LocalDateTime.now();
    }

    public void closeTicket(BigDecimal fee) {
        this.exitTime = LocalDateTime.now();
        this.fee = fee;
    }

    public Duration getParkingDuration() {
        LocalDateTime end = exitTime != null ? exitTime : LocalDateTime.now();
        return Duration.between(entryTime, end);
    }

    public String getTicketId() { return ticketId; }
    public Vehicle getVehicle() { return vehicle; }
    public ParkingSpot getSpot() { return spot; }
    public LocalDateTime getEntryTime() { return entryTime; }
    public BigDecimal getFee() { return fee; }
}

// ==================== PRICING STRATEGY ====================
@FunctionalInterface
public interface PricingStrategy {
    BigDecimal calculateFee(Ticket ticket);
}

public class HourlyPricingStrategy implements PricingStrategy {
    private final Map<VehicleType, BigDecimal> hourlyRates;

    public HourlyPricingStrategy() {
        hourlyRates = new EnumMap<>(VehicleType.class);
        hourlyRates.put(VehicleType.MOTORCYCLE, new BigDecimal("2.00"));
        hourlyRates.put(VehicleType.CAR, new BigDecimal("5.00"));
        hourlyRates.put(VehicleType.TRUCK, new BigDecimal("10.00"));
    }

    @Override
    public BigDecimal calculateFee(Ticket ticket) {
        long hours = ticket.getParkingDuration().toHours() + 1; // round up
        BigDecimal rate = hourlyRates.get(ticket.getVehicle().getType());
        return rate.multiply(BigDecimal.valueOf(hours));
    }
}

// ==================== OBSERVER ====================
public interface SpotAvailabilityListener {
    void onSpotFreed(ParkingSpot spot, int floorNumber);
    void onSpotOccupied(ParkingSpot spot, int floorNumber);
}

// ==================== PAYMENT ====================
public class PaymentSystem {
    public boolean processPayment(Ticket ticket) {
        // Integration with payment gateway
        System.out.printf("Processing payment of %s for ticket %s%n",
            ticket.getFee(), ticket.getTicketId());
        return true; // simplified
    }
}

// ==================== PARKING LOT (Singleton) ====================
public final class ParkingLot {
    // Initialization-on-demand holder pattern
    private static final class Holder {
        static final ParkingLot INSTANCE = new ParkingLot("Central Parking", 5);
    }

    public static ParkingLot getInstance() { return Holder.INSTANCE; }

    private final String name;
    private final List<ParkingFloor> floors;
    private final Map<String, Ticket> activeTickets; // licensePlate -> Ticket
    private final PricingStrategy pricingStrategy;
    private final PaymentSystem paymentSystem;
    private final List<SpotAvailabilityListener> listeners;

    private ParkingLot(String name, int floorCount) {
        this.name = name;
        this.floors = new ArrayList<>();
        this.activeTickets = new ConcurrentHashMap<>();
        this.pricingStrategy = new HourlyPricingStrategy();
        this.paymentSystem = new PaymentSystem();
        this.listeners = new CopyOnWriteArrayList<>();
        initializeFloors(floorCount);
    }

    private void initializeFloors(int count) {
        for (int f = 1; f <= count; f++) {
            ParkingFloor floor = new ParkingFloor(f);
            // Add spots to each floor
            for (int i = 1; i <= 50; i++) floor.addSpot(new ParkingSpot(f + "-C" + i, SpotType.COMPACT));
            for (int i = 1; i <= 20; i++) floor.addSpot(new ParkingSpot(f + "-L" + i, SpotType.LARGE));
            for (int i = 1; i <= 10; i++) floor.addSpot(new ParkingSpot(f + "-H" + i, SpotType.HANDICAPPED));
            for (int i = 1; i <= 10; i++) floor.addSpot(new ParkingSpot(f + "-M" + i, SpotType.MOTORCYCLE));
            floors.add(floor);
        }
    }

    public void addListener(SpotAvailabilityListener listener) { listeners.add(listener); }

    public Optional<Ticket> parkVehicle(Vehicle vehicle) {
        for (ParkingFloor floor : floors) {
            Optional<ParkingSpot> spot = floor.findAvailableSpot(vehicle.getRequiredSpotType());
            if (spot.isPresent() && spot.get().park(vehicle)) {
                Ticket ticket = new Ticket(vehicle, spot.get());
                activeTickets.put(vehicle.getLicensePlate(), ticket);
                listeners.forEach(l -> l.onSpotOccupied(spot.get(), floor.getFloorNumber()));
                return Optional.of(ticket);
            }
        }
        return Optional.empty();
    }

    public boolean exitVehicle(String licensePlate) {
        Ticket ticket = activeTickets.remove(licensePlate);
        if (ticket == null) return false;

        BigDecimal fee = pricingStrategy.calculateFee(ticket);
        ticket.closeTicket(fee);

        if (paymentSystem.processPayment(ticket)) {
            ParkingSpot spot = ticket.getSpot();
            spot.remove();
            // Notify observers
            floors.stream()
                .filter(f -> f.getAvailableCount(spot.getType()) >= 0)
                .findFirst()
                .ifPresent(f -> listeners.forEach(l -> l.onSpotFreed(spot, f.getFloorNumber())));
            return true;
        }
        // Payment failed — re-add ticket
        activeTickets.put(licensePlate, ticket);
        return false;
    }

    public int getAvailableSpots(SpotType type) {
        return floors.stream().mapToInt(f -> f.getAvailableCount(type)).sum();
    }
}
```

---

## 2. Design an Elevator System

### Design
- Multiple elevators, multiple floors
- LOOK algorithm for efficient scheduling (minimize travel distance)
- Thread-safe request handling

```java
public enum Direction { UP, DOWN, IDLE }

public class Request {
    private final int floor;
    private final Direction direction; // external: which direction user wants
    private final boolean isInternal;  // from inside elevator (destination)

    public Request(int floor, Direction direction, boolean isInternal) {
        this.floor = floor;
        this.direction = direction;
        this.isInternal = isInternal;
    }
    public int getFloor() { return floor; }
    public Direction getDirection() { return direction; }
    public boolean isInternal() { return isInternal; }
}

public class Elevator implements Runnable {
    private final int id;
    private volatile int currentFloor = 1;
    private volatile Direction direction = Direction.IDLE;

    // LOOK algorithm: two sorted sets for pending stops
    private final TreeSet<Integer> upRequests = new TreeSet<>();  // floors above
    private final TreeSet<Integer> downRequests = new TreeSet<>(); // floors below (descending)
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition hasWork = lock.newCondition();
    private volatile boolean running = true;

    public Elevator(int id) { this.id = id; }

    public void addRequest(int floor) {
        lock.lock();
        try {
            if (floor > currentFloor) upRequests.add(floor);
            else if (floor < currentFloor) downRequests.add(floor);
            else openDoors(); // already at requested floor
            hasWork.signal();
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void run() {
        while (running) {
            lock.lock();
            try {
                while (upRequests.isEmpty() && downRequests.isEmpty()) {
                    direction = Direction.IDLE;
                    hasWork.await();
                }
                moveToNextFloor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                running = false;
            } finally {
                lock.unlock();
            }
        }
    }

    // LOOK algorithm: serve all requests in current direction, then reverse
    private void moveToNextFloor() throws InterruptedException {
        int target;
        if (direction == Direction.UP || direction == Direction.IDLE) {
            if (!upRequests.isEmpty()) {
                target = upRequests.first(); // nearest floor above
                direction = Direction.UP;
            } else {
                direction = Direction.DOWN;
                target = downRequests.first(); // highest pending down request
            }
        } else { // Direction.DOWN
            if (!downRequests.isEmpty()) {
                target = downRequests.last(); // nearest floor below (TreeSet desc)
                direction = Direction.DOWN;
            } else {
                direction = Direction.UP;
                target = upRequests.first();
            }
        }

        // Simulate movement
        travelTo(target);

        // Serve the floor
        upRequests.remove(target);
        downRequests.remove(target);
        openDoors();
    }

    private void travelTo(int targetFloor) throws InterruptedException {
        while (currentFloor != targetFloor) {
            if (currentFloor < targetFloor) currentFloor++;
            else currentFloor--;
            Thread.sleep(500); // simulate floor traversal time
            System.out.printf("Elevator %d at floor %d%n", id, currentFloor);
        }
    }

    private void openDoors() {
        System.out.printf("Elevator %d: doors opening at floor %d%n", id, currentFloor);
        // simulate door open/close delay
    }

    public int getCurrentFloor() { return currentFloor; }
    public Direction getDirection() { return direction; }
    public int getId() { return id; }
    public void shutdown() { running = false; }
}

public class ElevatorController {
    private final List<Elevator> elevators;
    private final ExecutorService pool;

    public ElevatorController(int numElevators) {
        this.elevators = new ArrayList<>();
        this.pool = Executors.newFixedThreadPool(numElevators);
        for (int i = 1; i <= numElevators; i++) {
            Elevator e = new Elevator(i);
            elevators.add(e);
            pool.submit(e);
        }
    }

    // Dispatch to nearest available elevator
    public void requestElevator(int floor, Direction direction) {
        Elevator best = elevators.stream()
            .min(Comparator.comparingInt(e -> costToServe(e, floor, direction)))
            .orElseThrow();
        best.addRequest(floor);
    }

    // Estimate cost: distance + direction penalty for going wrong way
    private int costToServe(Elevator e, int requestedFloor, Direction requestedDir) {
        int distance = Math.abs(e.getCurrentFloor() - requestedFloor);
        // Penalize if elevator is moving away from the request
        if (e.getDirection() == Direction.UP && requestedFloor < e.getCurrentFloor()) distance += 10;
        if (e.getDirection() == Direction.DOWN && requestedFloor > e.getCurrentFloor()) distance += 10;
        return distance;
    }

    public void shutdown() {
        elevators.forEach(Elevator::shutdown);
        pool.shutdown();
    }
}
```

---

## 3. Library Management System

```java
// ==================== DOMAIN MODELS ====================
public class Book {
    private final String isbn;
    private final String title;
    private final String author;
    private final Set<String> subjects;

    public Book(String isbn, String title, String author, Set<String> subjects) {
        this.isbn = isbn; this.title = title; this.author = author;
        this.subjects = Set.copyOf(subjects);
    }
    public String getIsbn() { return isbn; }
    public String getTitle() { return title; }
}

public enum BookStatus { AVAILABLE, CHECKED_OUT, RESERVED, LOST }

public class BookItem {
    private final String barcode;
    private final Book book;
    private volatile BookStatus status;
    private LocalDate dueDate;
    private String checkedOutByMemberId;

    public BookItem(String barcode, Book book) {
        this.barcode = barcode;
        this.book = book;
        this.status = BookStatus.AVAILABLE;
    }

    public synchronized boolean checkout(String memberId, int loanDays) {
        if (status != BookStatus.AVAILABLE) return false;
        this.status = BookStatus.CHECKED_OUT;
        this.checkedOutByMemberId = memberId;
        this.dueDate = LocalDate.now().plusDays(loanDays);
        return true;
    }

    public synchronized void returnBook() {
        this.status = BookStatus.AVAILABLE;
        this.checkedOutByMemberId = null;
        this.dueDate = null;
    }

    public String getBarcode() { return barcode; }
    public Book getBook() { return book; }
    public BookStatus getStatus() { return status; }
    public LocalDate getDueDate() { return dueDate; }
    public String getCheckedOutByMemberId() { return checkedOutByMemberId; }
}

// ==================== MEMBER ====================
public class Member {
    private static final int MAX_BOOKS = 5;
    private final String memberId;
    private final String name;
    private final List<BookItem> checkedOutBooks = new ArrayList<>();
    private final List<Reservation> reservations = new ArrayList<>();

    public Member(String memberId, String name) {
        this.memberId = memberId;
        this.name = name;
    }

    public boolean canCheckout() { return checkedOutBooks.size() < MAX_BOOKS; }

    public void addCheckedOutBook(BookItem item) { checkedOutBooks.add(item); }
    public void removeCheckedOutBook(BookItem item) { checkedOutBooks.remove(item); }

    public String getMemberId() { return memberId; }
    public String getName() { return name; }
    public List<BookItem> getCheckedOutBooks() { return Collections.unmodifiableList(checkedOutBooks); }
}

// ==================== RESERVATION ====================
public class Reservation {
    private final String reservationId;
    private final Member member;
    private final Book book;
    private final LocalDateTime createdAt;
    private LocalDateTime fulfilledAt;

    public Reservation(Member member, Book book) {
        this.reservationId = UUID.randomUUID().toString();
        this.member = member;
        this.book = book;
        this.createdAt = LocalDateTime.now();
    }

    public void fulfill() { this.fulfilledAt = LocalDateTime.now(); }
    public boolean isFulfilled() { return fulfilledAt != null; }
    public Member getMember() { return member; }
    public Book getBook() { return book; }
}

// ==================== FINE CALCULATION ====================
public class FineCalculator {
    private static final BigDecimal DAILY_FINE = new BigDecimal("0.50");

    public BigDecimal calculate(BookItem item) {
        if (item.getDueDate() == null || !LocalDate.now().isAfter(item.getDueDate())) {
            return BigDecimal.ZERO;
        }
        long daysOverdue = ChronoUnit.DAYS.between(item.getDueDate(), LocalDate.now());
        return DAILY_FINE.multiply(BigDecimal.valueOf(daysOverdue));
    }
}

// ==================== CATALOG ====================
public class Catalog {
    private final Map<String, Book> booksByIsbn = new ConcurrentHashMap<>();
    private final Map<String, List<BookItem>> itemsByIsbn = new ConcurrentHashMap<>();

    public void addBook(Book book) {
        booksByIsbn.put(book.getIsbn(), book);
        itemsByIsbn.putIfAbsent(book.getIsbn(), new CopyOnWriteArrayList<>());
    }

    public void addBookItem(BookItem item) {
        itemsByIsbn.computeIfAbsent(item.getBook().getIsbn(), k -> new CopyOnWriteArrayList<>())
            .add(item);
    }

    public Optional<Book> findByIsbn(String isbn) { return Optional.ofNullable(booksByIsbn.get(isbn)); }

    public List<Book> searchByTitle(String title) {
        return booksByIsbn.values().stream()
            .filter(b -> b.getTitle().toLowerCase().contains(title.toLowerCase()))
            .collect(Collectors.toList());
    }

    public Optional<BookItem> findAvailableCopy(String isbn) {
        return itemsByIsbn.getOrDefault(isbn, Collections.emptyList()).stream()
            .filter(i -> i.getStatus() == BookStatus.AVAILABLE)
            .findFirst();
    }

    public List<BookItem> getAllCopies(String isbn) {
        return Collections.unmodifiableList(itemsByIsbn.getOrDefault(isbn, Collections.emptyList()));
    }
}

// ==================== OBSERVER FOR AVAILABILITY ====================
public interface BookAvailabilityListener {
    void onBookAvailable(Book book, BookItem item);
}

// ==================== LENDING SERVICE ====================
public class LendingService {
    private static final int DEFAULT_LOAN_DAYS = 14;
    private final Catalog catalog;
    private final FineCalculator fineCalculator;
    private final Map<String, Queue<Reservation>> reservationQueue; // isbn -> queue
    private final List<BookAvailabilityListener> availabilityListeners;

    public LendingService(Catalog catalog) {
        this.catalog = catalog;
        this.fineCalculator = new FineCalculator();
        this.reservationQueue = new ConcurrentHashMap<>();
        this.availabilityListeners = new CopyOnWriteArrayList<>();
    }

    public void addAvailabilityListener(BookAvailabilityListener l) { availabilityListeners.add(l); }

    public Optional<BookItem> checkoutBook(Member member, String isbn) {
        if (!member.canCheckout()) {
            System.out.println("Member has reached checkout limit");
            return Optional.empty();
        }

        Optional<BookItem> itemOpt = catalog.findAvailableCopy(isbn);
        if (itemOpt.isEmpty()) {
            System.out.println("No available copy for " + isbn);
            return Optional.empty();
        }

        BookItem item = itemOpt.get();
        if (item.checkout(member.getMemberId(), DEFAULT_LOAN_DAYS)) {
            member.addCheckedOutBook(item);
            return Optional.of(item);
        }
        return Optional.empty();
    }

    public BigDecimal returnBook(Member member, String barcode) {
        BookItem item = member.getCheckedOutBooks().stream()
            .filter(b -> b.getBarcode().equals(barcode))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Item not checked out by this member"));

        BigDecimal fine = fineCalculator.calculate(item);
        item.returnBook();
        member.removeCheckedOutBook(item);

        // Notify waiting reservations (Observer pattern)
        notifyAvailabilityListeners(item.getBook(), item);
        fulfillNextReservation(item.getBook().getIsbn(), item);

        return fine;
    }

    public Reservation reserveBook(Member member, String isbn) {
        Book book = catalog.findByIsbn(isbn)
            .orElseThrow(() -> new IllegalArgumentException("Book not found: " + isbn));
        Reservation reservation = new Reservation(member, book);
        reservationQueue.computeIfAbsent(isbn, k -> new LinkedList<>()).offer(reservation);
        return reservation;
    }

    private void fulfillNextReservation(String isbn, BookItem item) {
        Queue<Reservation> queue = reservationQueue.get(isbn);
        if (queue != null && !queue.isEmpty()) {
            Reservation next = queue.poll();
            next.fulfill();
            System.out.printf("Book '%s' reserved for member %s%n",
                item.getBook().getTitle(), next.getMember().getName());
        }
    }

    private void notifyAvailabilityListeners(Book book, BookItem item) {
        availabilityListeners.forEach(l -> l.onBookAvailable(book, item));
    }
}
```

---

## 4. LRU Cache — O(1) get and put

### Core: HashMap + Doubly Linked List
```java
public class LRUCache<K, V> {
    // Doubly linked list node
    private static class Node<K, V> {
        K key;
        V value;
        Node<K, V> prev, next;

        Node(K key, V value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<K, Node<K, V>> map;

    // Sentinel nodes — eliminate null checks at head and tail
    private final Node<K, V> head; // MRU end
    private final Node<K, V> tail; // LRU end

    public LRUCache(int capacity) {
        if (capacity <= 0) throw new IllegalArgumentException("Capacity must be positive");
        this.capacity = capacity;
        this.map = new HashMap<>(capacity * 2); // pre-size to avoid rehash

        // Initialize sentinels
        head = new Node<>(null, null);
        tail = new Node<>(null, null);
        head.next = tail;
        tail.prev = head;
    }

    // O(1) get
    public Optional<V> get(K key) {
        Node<K, V> node = map.get(key);
        if (node == null) return Optional.empty();
        moveToFront(node); // mark as recently used
        return Optional.of(node.value);
    }

    // O(1) put
    public void put(K key, V value) {
        Node<K, V> existing = map.get(key);
        if (existing != null) {
            existing.value = value;
            moveToFront(existing);
            return;
        }

        Node<K, V> newNode = new Node<>(key, value);
        map.put(key, newNode);
        addToFront(newNode);

        if (map.size() > capacity) {
            Node<K, V> lru = removeLast();
            map.remove(lru.key); // evict LRU
        }
    }

    public void remove(K key) {
        Node<K, V> node = map.remove(key);
        if (node != null) removeNode(node);
    }

    public int size() { return map.size(); }

    // ---- Doubly linked list operations ----
    private void addToFront(Node<K, V> node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }

    private void removeNode(Node<K, V> node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private void moveToFront(Node<K, V> node) {
        removeNode(node);
        addToFront(node);
    }

    private Node<K, V> removeLast() {
        Node<K, V> lru = tail.prev;
        removeNode(lru);
        return lru;
    }
}

// ==================== Thread-Safe Version ====================
public class ConcurrentLRUCache<K, V> {
    private final LRUCache<K, V> cache;
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final ReentrantReadWriteLock.ReadLock readLock = rwLock.readLock();
    private final ReentrantReadWriteLock.WriteLock writeLock = rwLock.writeLock();

    public ConcurrentLRUCache(int capacity) {
        this.cache = new LRUCache<>(capacity);
    }

    public Optional<V> get(K key) {
        // Note: get() also moves to front (mutation) — needs write lock
        writeLock.lock();
        try {
            return cache.get(key);
        } finally {
            writeLock.unlock();
        }
    }

    public void put(K key, V value) {
        writeLock.lock();
        try {
            cache.put(key, value);
        } finally {
            writeLock.unlock();
        }
    }

    public int size() {
        readLock.lock();
        try { return cache.size(); }
        finally { readLock.unlock(); }
    }
}

// ==================== Test ====================
// LRUCache<Integer, String> cache = new LRUCache<>(3);
// cache.put(1, "one");    // [1]
// cache.put(2, "two");    // [2,1]
// cache.put(3, "three");  // [3,2,1]
// cache.get(1);           // [1,3,2]  — 1 moved to front
// cache.put(4, "four");   // [4,1,3]  — 2 evicted (LRU)
// cache.get(2)            // empty — evicted
```

---

## 5. Rate Limiter — Token Bucket

### Token Bucket Algorithm
Tokens accumulate at a fixed rate up to a max capacity. Each request consumes one token. If no tokens available, request is rejected (or waits).

```java
public class TokenBucketRateLimiter {
    private final long capacity;            // max tokens (burst capacity)
    private final double refillRatePerMs;   // tokens added per millisecond
    private double currentTokens;
    private long lastRefillTimeMs;
    private final ReentrantLock lock = new ReentrantLock();

    public TokenBucketRateLimiter(long capacity, long refillRatePerSecond) {
        this.capacity = capacity;
        this.refillRatePerMs = refillRatePerSecond / 1000.0;
        this.currentTokens = capacity; // start full
        this.lastRefillTimeMs = System.currentTimeMillis();
    }

    public boolean tryAcquire() {
        return tryAcquire(1);
    }

    public boolean tryAcquire(int tokens) {
        lock.lock();
        try {
            refill();
            if (currentTokens >= tokens) {
                currentTokens -= tokens;
                return true;
            }
            return false;
        } finally {
            lock.unlock();
        }
    }

    public boolean tryAcquire(int tokens, long timeout, TimeUnit unit) throws InterruptedException {
        long deadlineMs = System.currentTimeMillis() + unit.toMillis(timeout);
        while (System.currentTimeMillis() < deadlineMs) {
            if (tryAcquire(tokens)) return true;
            long waitMs = calculateWaitTimeMs(tokens);
            Thread.sleep(Math.min(waitMs, deadlineMs - System.currentTimeMillis()));
        }
        return false;
    }

    private void refill() {
        long now = System.currentTimeMillis();
        long elapsed = now - lastRefillTimeMs;
        double tokensToAdd = elapsed * refillRatePerMs;
        currentTokens = Math.min(capacity, currentTokens + tokensToAdd);
        lastRefillTimeMs = now;
    }

    private long calculateWaitTimeMs(int tokensNeeded) {
        double deficit = tokensNeeded - currentTokens;
        return (long) Math.ceil(deficit / refillRatePerMs);
    }

    // Snapshot for monitoring
    public long getAvailableTokens() {
        lock.lock();
        try {
            refill();
            return (long) currentTokens;
        } finally {
            lock.unlock();
        }
    }
}

// ==================== Lock-Free Version using AtomicLong ====================
public class AtomicTokenBucket {
    private final long capacity;
    private final long refillRatePerSecond;
    private final AtomicLong tokens;
    private final AtomicLong lastRefillNanos;

    public AtomicTokenBucket(long capacity, long refillRatePerSecond) {
        this.capacity = capacity;
        this.refillRatePerSecond = refillRatePerSecond;
        this.tokens = new AtomicLong(capacity);
        this.lastRefillNanos = new AtomicLong(System.nanoTime());
    }

    public boolean tryAcquire() {
        while (true) {
            refillIfNeeded();
            long current = tokens.get();
            if (current <= 0) return false;
            if (tokens.compareAndSet(current, current - 1)) return true;
            // CAS failed (another thread modified tokens) — retry
        }
    }

    private void refillIfNeeded() {
        long now = System.nanoTime();
        long last = lastRefillNanos.get();
        long elapsedNanos = now - last;
        if (elapsedNanos < 1_000_000_000L / refillRatePerSecond) return; // not time yet

        long tokensToAdd = elapsedNanos * refillRatePerSecond / 1_000_000_000L;
        if (tokensToAdd > 0 && lastRefillNanos.compareAndSet(last, now)) {
            long current;
            long updated;
            do {
                current = tokens.get();
                updated = Math.min(capacity, current + tokensToAdd);
            } while (!tokens.compareAndSet(current, updated));
        }
    }
}

// ==================== Distributed Extension with Redis ====================
// For distributed rate limiting, use Redis + Lua script (atomic eval):
//
// KEYS[1] = rate_limit:<userId>
// ARGV[1] = capacity, ARGV[2] = refill_rate, ARGV[3] = requested_tokens, ARGV[4] = now_ms
//
// Lua script (atomic in Redis):
// local key = KEYS[1]
// local capacity = tonumber(ARGV[1])
// local rate = tonumber(ARGV[2])
// local requested = tonumber(ARGV[3])
// local now = tonumber(ARGV[4])
//
// local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
// local tokens = tonumber(bucket[1]) or capacity
// local last_refill = tonumber(bucket[2]) or now
//
// -- refill
// local elapsed = now - last_refill
// tokens = math.min(capacity, tokens + elapsed * rate / 1000)
//
// if tokens >= requested then
//     tokens = tokens - requested
//     redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
//     redis.call('EXPIRE', key, 60)
//     return 1  -- allowed
// else
//     return 0  -- rejected
// end
```

---

## 6. Task Scheduler

### ScheduledExecutorService vs TimerTask
```java
// TimerTask problems:
// - Single thread for all tasks — one long-running task blocks others
// - Unchecked exception in task kills the timer thread — all future tasks never run
// - Uses absolute time — affected by system clock changes (daylight saving, NTP)

// ScheduledExecutorService advantages:
// - Pool of threads — tasks run concurrently
// - Exception in one task does NOT affect other tasks (exception is captured in Future)
// - Relative delays — immune to system clock changes

// ==================== Priority-Based Scheduler ====================
public class PriorityTaskScheduler {
    private final PriorityBlockingQueue<ScheduledTask<?>> queue;
    private final ExecutorService workerPool;
    private final ScheduledExecutorService poller;
    private volatile boolean running = true;

    public PriorityTaskScheduler(int workerThreads) {
        this.queue = new PriorityBlockingQueue<>();
        this.workerPool = Executors.newFixedThreadPool(workerThreads);
        this.poller = Executors.newSingleThreadScheduledExecutor();

        // Poll every 10ms for due tasks
        poller.scheduleAtFixedRate(this::drainDueTasks, 0, 10, TimeUnit.MILLISECONDS);
    }

    public <T> Future<T> schedule(Callable<T> task, long delay, TimeUnit unit, int priority) {
        CompletableFuture<T> future = new CompletableFuture<>();
        long executeAtNanos = System.nanoTime() + unit.toNanos(delay);
        queue.offer(new ScheduledTask<>(task, executeAtNanos, priority, future));
        return future;
    }

    public Future<?> scheduleAtFixedRate(Runnable task, long initialDelay,
                                          long period, TimeUnit unit, int priority) {
        // Recurring task — re-schedules itself after each execution
        Callable<Void> selfRescheduling = new Callable<>() {
            @Override
            public Void call() throws Exception {
                task.run();
                long nextAt = System.nanoTime() + unit.toNanos(period);
                queue.offer(new ScheduledTask<>(this, nextAt, priority, new CompletableFuture<>()));
                return null;
            }
        };
        return schedule(selfRescheduling, initialDelay, unit, priority);
    }

    private void drainDueTasks() {
        long now = System.nanoTime();
        ScheduledTask<?> task;
        while ((task = queue.peek()) != null && task.getExecuteAtNanos() <= now) {
            ScheduledTask<?> t = queue.poll();
            if (t != null) workerPool.submit(t::execute);
        }
    }

    public void shutdown() throws InterruptedException {
        running = false;
        poller.shutdown();
        workerPool.shutdown();
        workerPool.awaitTermination(30, TimeUnit.SECONDS);
    }

    private static class ScheduledTask<T> implements Comparable<ScheduledTask<?>> {
        private final Callable<T> task;
        private final long executeAtNanos;
        private final int priority;
        private final CompletableFuture<T> future;

        ScheduledTask(Callable<T> task, long executeAtNanos, int priority, CompletableFuture<T> future) {
            this.task = task;
            this.executeAtNanos = executeAtNanos;
            this.priority = priority;
            this.future = future;
        }

        void execute() {
            try {
                T result = task.call();
                future.complete(result);
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        }

        long getExecuteAtNanos() { return executeAtNanos; }

        @Override
        public int compareTo(ScheduledTask<?> other) {
            // First compare by time, then by priority (lower number = higher priority)
            int timeComp = Long.compare(this.executeAtNanos, other.executeAtNanos);
            if (timeComp != 0) return timeComp;
            return Integer.compare(this.priority, other.priority);
        }
    }
}

// ==================== DelayQueue internals ====================
// Java's ScheduledThreadPoolExecutor uses a DelayQueue internally
// DelayQueue: unbounded PriorityQueue + each element must implement Delayed
// take() blocks until the element at head has expired

public class DelayedTask implements Delayed {
    private final String name;
    private final long executeAtMs;

    public DelayedTask(String name, long delayMs) {
        this.name = name;
        this.executeAtMs = System.currentTimeMillis() + delayMs;
    }

    @Override
    public long getDelay(TimeUnit unit) {
        return unit.convert(executeAtMs - System.currentTimeMillis(), TimeUnit.MILLISECONDS);
    }

    @Override
    public int compareTo(Delayed other) {
        return Long.compare(this.getDelay(TimeUnit.MILLISECONDS), other.getDelay(TimeUnit.MILLISECONDS));
    }
}

// DelayQueue<DelayedTask> queue = new DelayQueue<>();
// new Thread(() -> {
//     while (true) {
//         DelayedTask task = queue.take(); // blocks until delay expires
//         execute(task);
//     }
// }).start();
```

---

## 7. In-Memory Pub-Sub System

### Design: Topic-based, Async Delivery, At-Least-Once with Ack

```java
// ==================== MESSAGE ====================
public final class Message {
    private final String id;
    private final String topic;
    private final Object payload;
    private final Instant publishedAt;
    private int deliveryAttempts;

    public Message(String topic, Object payload) {
        this.id = UUID.randomUUID().toString();
        this.topic = topic;
        this.payload = payload;
        this.publishedAt = Instant.now();
    }

    public String getId() { return id; }
    public String getTopic() { return topic; }
    public Object getPayload() { return payload; }
    public void incrementDeliveryAttempts() { deliveryAttempts++; }
    public int getDeliveryAttempts() { return deliveryAttempts; }
}

// ==================== SUBSCRIBER ====================
@FunctionalInterface
public interface MessageHandler {
    /**
     * Process the message. Return true to acknowledge (remove from delivery queue).
     * Return false to request redelivery.
     */
    boolean handle(Message message);
}

public class Subscriber {
    private final String subscriberId;
    private final String topic;
    private final MessageHandler handler;
    private final BlockingQueue<Message> inbox;
    private final int maxRetries;

    public Subscriber(String subscriberId, String topic, MessageHandler handler, int maxRetries) {
        this.subscriberId = subscriberId;
        this.topic = topic;
        this.handler = handler;
        this.maxRetries = maxRetries;
        this.inbox = new LinkedBlockingQueue<>(10_000);
    }

    public void deliver(Message message) {
        if (!inbox.offer(message)) {
            System.err.println("Subscriber " + subscriberId + " inbox full, dropping message " + message.getId());
        }
    }

    // Called by delivery executor thread
    public void processNextBatch(int batchSize) {
        List<Message> batch = new ArrayList<>(batchSize);
        inbox.drainTo(batch, batchSize);

        for (Message msg : batch) {
            msg.incrementDeliveryAttempts();
            try {
                boolean acked = handler.handle(msg);
                if (!acked && msg.getDeliveryAttempts() < maxRetries) {
                    inbox.offer(msg); // redeliver — at-least-once
                } else if (!acked) {
                    // Dead letter — exceeded retry limit
                    System.err.printf("Message %s exceeded max retries for subscriber %s%n",
                        msg.getId(), subscriberId);
                }
            } catch (Exception e) {
                if (msg.getDeliveryAttempts() < maxRetries) {
                    inbox.offer(msg); // exception = nack — redeliver
                }
            }
        }
    }

    public String getSubscriberId() { return subscriberId; }
    public boolean hasMessages() { return !inbox.isEmpty(); }
}

// ==================== TOPIC ====================
public class Topic {
    private final String name;
    private final List<Subscriber> subscribers = new CopyOnWriteArrayList<>();

    public Topic(String name) { this.name = name; }

    public void addSubscriber(Subscriber subscriber) { subscribers.add(subscriber); }

    public void removeSubscriber(String subscriberId) {
        subscribers.removeIf(s -> s.getSubscriberId().equals(subscriberId));
    }

    public void publish(Message message) {
        subscribers.forEach(s -> s.deliver(message));
    }

    public List<Subscriber> getSubscribers() { return Collections.unmodifiableList(subscribers); }
    public String getName() { return name; }
}

// ==================== MESSAGE BROKER ====================
public class MessageBroker {
    private final Map<String, Topic> topics = new ConcurrentHashMap<>();
    private final ScheduledExecutorService deliveryScheduler;
    private static final int DELIVERY_THREADS = 4;
    private static final int BATCH_SIZE = 100;

    public MessageBroker() {
        this.deliveryScheduler = Executors.newScheduledThreadPool(DELIVERY_THREADS);
        // Periodically drain subscriber inboxes
        deliveryScheduler.scheduleAtFixedRate(
            this::drainAllInboxes, 0, 50, TimeUnit.MILLISECONDS
        );
    }

    public void createTopic(String topicName) {
        topics.putIfAbsent(topicName, new Topic(topicName));
    }

    public Subscriber subscribe(String topicName, String subscriberId,
                                MessageHandler handler, int maxRetries) {
        Topic topic = topics.computeIfAbsent(topicName, Topic::new);
        Subscriber subscriber = new Subscriber(subscriberId, topicName, handler, maxRetries);
        topic.addSubscriber(subscriber);
        return subscriber;
    }

    public void unsubscribe(String topicName, String subscriberId) {
        Topic topic = topics.get(topicName);
        if (topic != null) topic.removeSubscriber(subscriberId);
    }

    public void publish(String topicName, Object payload) {
        Topic topic = topics.get(topicName);
        if (topic == null) throw new IllegalArgumentException("Topic not found: " + topicName);
        Message message = new Message(topicName, payload);
        topic.publish(message); // delivers to subscriber inboxes synchronously
    }

    private void drainAllInboxes() {
        topics.values().stream()
            .flatMap(t -> t.getSubscribers().stream())
            .filter(Subscriber::hasMessages)
            .forEach(s -> deliveryScheduler.submit(() -> s.processNextBatch(BATCH_SIZE)));
    }

    public void shutdown() throws InterruptedException {
        deliveryScheduler.shutdown();
        deliveryScheduler.awaitTermination(10, TimeUnit.SECONDS);
    }
}

// ==================== USAGE EXAMPLE ====================
/*
MessageBroker broker = new MessageBroker();
broker.createTopic("orders");

// Subscribe
broker.subscribe("orders", "notification-service",
    msg -> {
        Order order = (Order) msg.getPayload();
        System.out.println("Notification: new order " + order.getId());
        return true; // ack
    }, 3);

broker.subscribe("orders", "analytics-service",
    msg -> {
        // Simulate transient failure
        if (Math.random() < 0.3) return false; // nack — will redeliver
        recordMetric(msg.getPayload());
        return true;
    }, 5); // 5 retries

// Publish
broker.publish("orders", new Order("order-123", ...));
*/
```
