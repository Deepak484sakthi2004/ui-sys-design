# Chapter 14: Use Cases -- Application Domains

## Where Data Structures Meet Revenue, Latency, and Users

Every line of production code you have written over fifteen years serves some application domain. You have built shopping carts, processed financial transactions, rendered social feeds, computed leaderboards, aggregated logs. In every case, you chose data structures -- often unconsciously. A `HashMap` here, an `ArrayList` there, maybe a `PriorityQueue` if you were feeling algorithmic. But the choice was rarely deliberate. It was rarely informed by the full landscape of what each structure offers.

This chapter changes that. We are going to walk through six major application domains -- e-commerce, financial systems, social networks, gaming, logging and monitoring, and compilers -- and for each one, we will dissect the exact data structures that power the core operations. Not in the abstract. In Java. With JVM memory analysis, concurrency considerations, and the kind of detail you would need to actually build these systems in production.

I have built systems in most of these domains. I have seen what happens when you use an `ArrayList` where you need a `TreeMap`, when you use `synchronized` where you need `ConcurrentHashMap`, when you build a quadratic algorithm where a trie gives you linear time. The cost is not theoretical. It is P95 latency spikes during flash sales, it is dropped orders during market volatility, it is a social feed that takes four seconds to render. Data structure choice is not an interview exercise. It is a business decision.

After this chapter, you will have a mental map: "I am building feature X in domain Y, therefore the right structure is Z, and here is why." That map will serve you in every design discussion, every code review, and every system design interview for the rest of your career.

---

## 14.1 E-Commerce

E-commerce systems are deceptively complex. On the surface, it is a catalog, a cart, and a checkout. Underneath, it is autocomplete across millions of SKUs, real-time inventory management under high concurrency, recommendation engines that must respond in under 100ms, and flash sales where thousands of users race for limited stock. Every one of these problems has a data structure at its heart.

### 14.1.1 Product Catalog Search: Trie for Autocomplete

When a user types "lap" into the search bar, the system must instantly suggest "laptop", "laptop stand", "laptop bag", "lap desk". This is prefix search, and the trie is the canonical structure.

```java
public class AutocompleteTrie {
    private static final int ALPHABET_SIZE = 128; // ASCII
    
    static class TrieNode {
        TrieNode[] children = new TrieNode[ALPHABET_SIZE];
        boolean isEnd;
        String fullProduct;  // store complete product name at terminal nodes
        int popularity;      // ranking signal for suggestions
    }
    
    private final TrieNode root = new TrieNode();
    
    public void insert(String product, int popularity) {
        TrieNode node = root;
        String lower = product.toLowerCase();
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (node.children[c] == null) {
                node.children[c] = new TrieNode();
            }
            node = node.children[c];
        }
        node.isEnd = true;
        node.fullProduct = product;
        node.popularity = popularity;
    }
    
    public List<String> autocomplete(String prefix, int maxResults) {
        TrieNode node = root;
        String lower = prefix.toLowerCase();
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (node.children[c] == null) return Collections.emptyList();
            node = node.children[c];
        }
        
        // DFS from prefix node, collect all terminal descendants
        PriorityQueue<String[]> pq = new PriorityQueue<>(
            (a, b) -> Integer.compare(Integer.parseInt(a[1]), Integer.parseInt(b[1]))
        );
        collectSuggestions(node, pq, maxResults);
        
        List<String> results = new ArrayList<>();
        while (!pq.isEmpty()) results.add(pq.poll()[0]);
        Collections.reverse(results);
        return results;
    }
    
    private void collectSuggestions(TrieNode node, PriorityQueue<String[]> pq, int k) {
        if (node == null) return;
        if (node.isEnd) {
            pq.offer(new String[]{node.fullProduct, String.valueOf(node.popularity)});
            if (pq.size() > k) pq.poll(); // keep only top-k by popularity
        }
        for (TrieNode child : node.children) {
            collectSuggestions(child, pq, k);
        }
    }
}
```

**JVM memory analysis:** Each `TrieNode` contains a `TrieNode[128]` array. On a 64-bit JVM with compressed OOPs, that is 16 bytes (object header) + 128 x 4 bytes (compressed references) = 528 bytes per node. For a catalog of 1 million products with average name length 20, the trie might have ~5 million nodes (shared prefixes compress this), consuming ~2.5 GB. That is why production autocomplete systems use compressed tries (Patricia trie / radix tree) or external indexes like Elasticsearch's completion suggester, which uses an FST (finite state transducer) -- essentially a compressed trie with shared suffixes as well.

**Why not just `TreeMap`?** A `TreeMap<String, Product>` supports `subMap(prefix, prefix + Character.MAX_VALUE)` for prefix queries, but it returns results in lexicographic order, not relevance order. It also cannot share prefixes -- every key is stored independently. For autocomplete, the trie wins on both relevance-ranked retrieval and memory sharing.

### 14.1.2 Full-Text Product Search: Inverted Index

When the user searches "wireless bluetooth headphones noise cancelling", you need full-text search. The inverted index maps each term to the set of products containing that term.

```java
public class InvertedIndex {
    // term -> sorted list of (productId, termFrequency) pairs
    private final Map<String, List<int[]>> index = new HashMap<>();
    
    public void addProduct(int productId, String description) {
        Map<String, Integer> termFreqs = new HashMap<>();
        for (String token : tokenize(description)) {
            termFreqs.merge(token, 1, Integer::sum);
        }
        for (var entry : termFreqs.entrySet()) {
            index.computeIfAbsent(entry.getKey(), k -> new ArrayList<>())
                 .add(new int[]{productId, entry.getValue()});
        }
    }
    
    // AND query: intersection of posting lists
    public List<Integer> search(String query) {
        List<String> terms = tokenize(query);
        if (terms.isEmpty()) return Collections.emptyList();
        
        // Sort posting lists by length (shortest first for early termination)
        List<List<int[]>> postings = new ArrayList<>();
        for (String term : terms) {
            List<int[]> list = index.get(term);
            if (list == null) return Collections.emptyList(); // AND semantics
            postings.add(list);
        }
        postings.sort(Comparator.comparingInt(List::size));
        
        // Intersect posting lists
        Set<Integer> result = new HashSet<>();
        for (int[] entry : postings.get(0)) {
            result.add(entry[0]);
        }
        for (int i = 1; i < postings.size(); i++) {
            Set<Integer> next = new HashSet<>();
            for (int[] entry : postings.get(i)) {
                if (result.contains(entry[0])) next.add(entry[0]);
            }
            result = next;
        }
        return new ArrayList<>(result);
    }
    
    private List<String> tokenize(String text) {
        List<String> tokens = new ArrayList<>();
        for (String word : text.toLowerCase().split("\\W+")) {
            if (!word.isEmpty() && word.length() > 2) tokens.add(word);
        }
        return tokens;
    }
}
```

Production systems like **Lucene** (which powers Elasticsearch and Solr) store posting lists as compressed integer arrays using delta encoding and variable-byte encoding. A posting list for a term appearing in 100,000 documents might compress from 400 KB (raw int[]) to under 50 KB. The JVM impact: fewer cache misses when scanning posting lists, because the data fits in L2/L3 cache.

### 14.1.3 Shopping Cart: HashMap<ProductId, CartItem>

The shopping cart is one of the most natural HashMap use cases. You need O(1) add, O(1) remove, O(1) update quantity, O(1) lookup.

```java
public class ShoppingCart {
    
    static class CartItem {
        final String productId;
        final String name;
        final BigDecimal unitPrice;
        int quantity;
        
        CartItem(String productId, String name, BigDecimal unitPrice, int quantity) {
            this.productId = productId;
            this.name = name;
            this.unitPrice = unitPrice;
            this.quantity = quantity;
        }
        
        BigDecimal subtotal() {
            return unitPrice.multiply(BigDecimal.valueOf(quantity));
        }
    }
    
    private final Map<String, CartItem> items = new LinkedHashMap<>(); // preserve insertion order
    
    public void addItem(String productId, String name, BigDecimal price, int quantity) {
        items.merge(productId, 
            new CartItem(productId, name, price, quantity),
            (existing, incoming) -> {
                existing.quantity += incoming.quantity;
                return existing;
            });
    }
    
    public void removeItem(String productId) {
        items.remove(productId);
    }
    
    public void updateQuantity(String productId, int newQuantity) {
        CartItem item = items.get(productId);
        if (item != null) {
            if (newQuantity <= 0) items.remove(productId);
            else item.quantity = newQuantity;
        }
    }
    
    public BigDecimal total() {
        return items.values().stream()
            .map(CartItem::subtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }
    
    public List<CartItem> getItems() {
        return new ArrayList<>(items.values()); // defensive copy
    }
}
```

**Why `LinkedHashMap` over `HashMap`?** When you render the cart UI, users expect to see items in the order they added them. `LinkedHashMap` maintains insertion order with O(1) access. The memory overhead is two extra pointers per entry (before/after in the doubly-linked list) -- 8 bytes per entry with compressed OOPs. For a cart with 20 items, that is 160 bytes. Negligible.

**Why `BigDecimal` for prices?** `double` and `float` cannot represent 0.10 exactly. `0.1 + 0.2 == 0.30000000000000004` in IEEE 754. Financial calculations demand `BigDecimal`. The cost: `BigDecimal` allocations on the heap, no primitive unboxing. For a shopping cart this is irrelevant. For high-frequency trading tick processing, it is a showstopper -- which is why HFT systems use fixed-point long arithmetic (price in cents or hundredths of a cent).

### 14.1.4 Recommendation Engine: Graph-Based Collaborative Filtering

"Users who bought X also bought Y" is a graph problem. Model users and products as nodes, purchases as edges. Finding recommendations means finding products that are close in the graph to what the current user has purchased.

```java
public class RecommendationEngine {
    // Bipartite graph: user -> set of purchased products
    private final Map<String, Set<String>> userPurchases = new HashMap<>();
    // Reverse index: product -> set of users who purchased it
    private final Map<String, Set<String>> productBuyers = new HashMap<>();
    
    public void recordPurchase(String userId, String productId) {
        userPurchases.computeIfAbsent(userId, k -> new HashSet<>()).add(productId);
        productBuyers.computeIfAbsent(productId, k -> new HashSet<>()).add(userId);
    }
    
    /**
     * Item-based collaborative filtering:
     * For each product the user bought, find other users who bought it,
     * then find what else those users bought. Rank by co-occurrence count.
     */
    public List<String> recommend(String userId, int maxResults) {
        Set<String> purchased = userPurchases.getOrDefault(userId, Collections.emptySet());
        if (purchased.isEmpty()) return Collections.emptyList();
        
        // Count co-occurrences: product -> number of "similar users" who bought it
        Map<String, Integer> scores = new HashMap<>();
        
        for (String ownedProduct : purchased) {
            Set<String> similarUsers = productBuyers.getOrDefault(ownedProduct, Collections.emptySet());
            for (String similarUser : similarUsers) {
                if (similarUser.equals(userId)) continue;
                for (String theirProduct : userPurchases.getOrDefault(similarUser, Collections.emptySet())) {
                    if (!purchased.contains(theirProduct)) {
                        scores.merge(theirProduct, 1, Integer::sum);
                    }
                }
            }
        }
        
        // Top-K by score using a min-heap
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            Comparator.comparingInt(Map.Entry::getValue)
        );
        for (var entry : scores.entrySet()) {
            pq.offer(entry);
            if (pq.size() > maxResults) pq.poll();
        }
        
        List<String> result = new ArrayList<>();
        while (!pq.isEmpty()) result.add(pq.poll().getKey());
        Collections.reverse(result);
        return result;
    }
}
```

**Complexity:** For a user who purchased P products, each purchased by U users on average, each of whom purchased P' products: O(P x U x P'). This is quadratic in the fan-out. Production systems pre-compute the item-item co-occurrence matrix offline (batch processing in Spark/Flink) and serve the pre-computed recommendations via a key-value store. The online path is then O(P x K) where K is the number of recommendations per product.

### 14.1.5 Inventory Management: ConcurrentHashMap with Atomic Decrements

Hundreds of users adding the same product to their carts simultaneously. The inventory count must never go negative. This is a concurrency problem that maps directly to `ConcurrentHashMap` with compare-and-swap (CAS) semantics.

```java
public class InventoryManager {
    private final ConcurrentHashMap<String, AtomicInteger> inventory = new ConcurrentHashMap<>();
    
    public void setStock(String productId, int quantity) {
        inventory.put(productId, new AtomicInteger(quantity));
    }
    
    /**
     * Attempt to reserve stock. Returns true if successful.
     * Uses CAS loop to ensure atomicity without locking.
     */
    public boolean reserveStock(String productId, int quantity) {
        AtomicInteger stock = inventory.get(productId);
        if (stock == null) return false;
        
        while (true) {
            int current = stock.get();
            if (current < quantity) return false; // insufficient stock
            if (stock.compareAndSet(current, current - quantity)) {
                return true; // successfully reserved
            }
            // CAS failed: another thread modified stock. Retry.
        }
    }
    
    public void releaseStock(String productId, int quantity) {
        AtomicInteger stock = inventory.get(productId);
        if (stock != null) {
            stock.addAndGet(quantity);
        }
    }
    
    public int getStock(String productId) {
        AtomicInteger stock = inventory.get(productId);
        return stock != null ? stock.get() : 0;
    }
}
```

**JVM-level detail:** `AtomicInteger.compareAndSet` compiles to a single `lock cmpxchg` instruction on x86. No object monitor, no thread parking, no OS kernel involvement. Under low contention (which is the common case -- most products are not being bought simultaneously), the CAS succeeds on the first attempt. Under high contention (flash sale on a single product), threads spin-retry but never block. This is why `AtomicInteger` outperforms `synchronized` for hot counters.

**Why not `ConcurrentHashMap.compute()`?** You could do:

```java
inventory.compute(productId, (k, stock) -> {
    if (stock == null || stock.get() < quantity) return stock; // or throw
    stock.addAndGet(-quantity);
    return stock;
});
```

But `compute()` acquires the bin lock (synchronized on the hash bucket's head node), which serializes all operations on products in the same bucket. With the `AtomicInteger` approach, the ConcurrentHashMap lookup is lock-free (volatile read), and the decrement is CAS -- only threads competing for the *same product* contend, not threads competing for the same hash bucket.

### 14.1.6 Flash Sale / Limited Stock: AtomicInteger Countdown

A flash sale: 100 units available, 10,000 users click "Buy" simultaneously. The system must guarantee exactly 100 successful purchases and zero oversells.

```java
public class FlashSaleManager {
    private final AtomicInteger remainingStock;
    private final int maxPerUser;
    private final ConcurrentHashMap<String, AtomicInteger> userPurchaseCounts = new ConcurrentHashMap<>();
    
    public FlashSaleManager(int totalStock, int maxPerUser) {
        this.remainingStock = new AtomicInteger(totalStock);
        this.maxPerUser = maxPerUser;
    }
    
    public enum PurchaseResult { SUCCESS, OUT_OF_STOCK, LIMIT_EXCEEDED }
    
    public PurchaseResult attemptPurchase(String userId) {
        // Check per-user limit first (cheap check, avoids unnecessary CAS on global counter)
        AtomicInteger userCount = userPurchaseCounts.computeIfAbsent(userId, k -> new AtomicInteger(0));
        if (userCount.get() >= maxPerUser) return PurchaseResult.LIMIT_EXCEEDED;
        
        // CAS loop on global stock
        while (true) {
            int current = remainingStock.get();
            if (current <= 0) return PurchaseResult.OUT_OF_STOCK;
            if (remainingStock.compareAndSet(current, current - 1)) {
                // Stock reserved. Now increment user count.
                int newCount = userCount.incrementAndGet();
                if (newCount > maxPerUser) {
                    // Race condition: another thread incremented between check and here.
                    // Roll back both.
                    userCount.decrementAndGet();
                    remainingStock.incrementAndGet();
                    return PurchaseResult.LIMIT_EXCEEDED;
                }
                return PurchaseResult.SUCCESS;
            }
            // CAS failed, retry
        }
    }
}
```

**Distributed reality check:** This works for a single JVM. In a distributed system with multiple application servers, you need a distributed atomic counter. **Redis** `DECR` with Lua scripting (atomic server-side check-and-decrement) is the standard approach. The data structure is the same (atomic counter), the implementation just moves from `AtomicInteger` in JVM memory to a Redis key with `INCRBY` / `DECRBY` commands that are single-threaded and thus serialized.

### 14.1.7 Price Comparison: TreeMap for Sorted Price Ranges

"Show me all laptops between $500 and $1000, sorted by price." This is a range query on a sorted structure. `TreeMap<BigDecimal, List<Product>>` provides exactly this.

```java
public class PriceSortedCatalog {
    // Price -> list of products at that price point
    private final TreeMap<BigDecimal, List<Product>> priceIndex = new TreeMap<>();
    
    public void addProduct(Product product) {
        priceIndex.computeIfAbsent(product.getPrice(), k -> new ArrayList<>())
                  .add(product);
    }
    
    /**
     * Range query: all products with price in [minPrice, maxPrice]
     * TreeMap.subMap returns a view in O(log n), iteration is O(k) for k results.
     */
    public List<Product> getProductsInPriceRange(BigDecimal minPrice, BigDecimal maxPrice) {
        NavigableMap<BigDecimal, List<Product>> range = 
            priceIndex.subMap(minPrice, true, maxPrice, true);
        
        List<Product> result = new ArrayList<>();
        for (List<Product> products : range.values()) {
            result.addAll(products);
        }
        return result;
    }
    
    public BigDecimal getLowestPrice() {
        return priceIndex.isEmpty() ? null : priceIndex.firstKey();
    }
    
    public BigDecimal getHighestPrice() {
        return priceIndex.isEmpty() ? null : priceIndex.lastKey();
    }
    
    // "Show next 10 products above $500"
    public List<Product> getProductsAbove(BigDecimal minPrice, int limit) {
        List<Product> result = new ArrayList<>();
        for (var entry : priceIndex.tailMap(minPrice, false).entrySet()) {
            for (Product p : entry.getValue()) {
                result.add(p);
                if (result.size() >= limit) return result;
            }
        }
        return result;
    }
}
```

**Why TreeMap beats sorting a list:** If you maintain a sorted `ArrayList` and do `Collections.binarySearch` for range queries, insertion is O(n) (shift elements). With `TreeMap` (Red-Black tree), insertion is O(log n), and `subMap` returns a view backed by the tree -- no copying. For a catalog with 100,000 products and frequent inserts (new products, price updates), the TreeMap is clearly superior.

**Database correlation:** This is exactly what a B+ Tree index on a `price` column does in **PostgreSQL** or **MySQL InnoDB**. `SELECT * FROM products WHERE price BETWEEN 500 AND 1000 ORDER BY price` uses the B+ Tree index to find the starting leaf, then scans forward through linked leaves -- the same pattern as TreeMap's `subMap` iteration.

---

## 14.2 Financial Systems

Financial systems have the tightest correctness and latency requirements of any application domain. An order book must process millions of events per second with microsecond latency. A risk engine must aggregate portfolio values across thousands of instruments in real time. A transaction ledger must be append-only and tamper-evident. The data structures here are not just performance-critical -- they are correctness-critical.

### 14.2.1 Order Book (Stock Exchange): TreeMap<Price, Queue<Order>>

The order book is the central data structure of every stock exchange. It maintains two sides: bids (buy orders) sorted by descending price, and asks (sell orders) sorted by ascending price. At each price level, orders are queued in FIFO order (price-time priority).

```java
public class OrderBook {
    
    static class Order {
        final String orderId;
        final boolean isBuy;
        final BigDecimal price;
        int remainingQuantity;
        final long timestamp;
        
        Order(String orderId, boolean isBuy, BigDecimal price, int quantity) {
            this.orderId = orderId;
            this.isBuy = isBuy;
            this.price = price;
            this.remainingQuantity = quantity;
            this.timestamp = System.nanoTime();
        }
    }
    
    static class Trade {
        final String buyOrderId, sellOrderId;
        final BigDecimal price;
        final int quantity;
        
        Trade(String buyOrderId, String sellOrderId, BigDecimal price, int quantity) {
            this.buyOrderId = buyOrderId;
            this.sellOrderId = sellOrderId;
            this.price = price;
            this.quantity = quantity;
        }
    }
    
    // Bids: highest price first (descending order)
    private final TreeMap<BigDecimal, Deque<Order>> bids = new TreeMap<>(Comparator.reverseOrder());
    // Asks: lowest price first (ascending order, natural order)
    private final TreeMap<BigDecimal, Deque<Order>> asks = new TreeMap<>();
    // Order lookup by ID for cancellation
    private final Map<String, Order> orderIndex = new HashMap<>();
    
    public List<Trade> submitOrder(Order order) {
        List<Trade> trades = new ArrayList<>();
        
        if (order.isBuy) {
            matchAgainst(order, asks, trades, true);
        } else {
            matchAgainst(order, bids, trades, false);
        }
        
        // If order has remaining quantity, add to book
        if (order.remainingQuantity > 0) {
            TreeMap<BigDecimal, Deque<Order>> side = order.isBuy ? bids : asks;
            side.computeIfAbsent(order.price, k -> new ArrayDeque<>()).addLast(order);
            orderIndex.put(order.orderId, order);
        }
        
        return trades;
    }
    
    private void matchAgainst(Order incoming, TreeMap<BigDecimal, Deque<Order>> oppositeSide,
                              List<Trade> trades, boolean incomingIsBuy) {
        while (incoming.remainingQuantity > 0 && !oppositeSide.isEmpty()) {
            Map.Entry<BigDecimal, Deque<Order>> bestLevel = oppositeSide.firstEntry();
            BigDecimal bestPrice = bestLevel.getKey();
            
            // Check if prices cross
            if (incomingIsBuy && incoming.price.compareTo(bestPrice) < 0) break;
            if (!incomingIsBuy && incoming.price.compareTo(bestPrice) > 0) break;
            
            Deque<Order> queue = bestLevel.getValue();
            while (incoming.remainingQuantity > 0 && !queue.isEmpty()) {
                Order resting = queue.peekFirst();
                int fillQty = Math.min(incoming.remainingQuantity, resting.remainingQuantity);
                
                trades.add(new Trade(
                    incomingIsBuy ? incoming.orderId : resting.orderId,
                    incomingIsBuy ? resting.orderId : incoming.orderId,
                    bestPrice, // execute at resting order's price
                    fillQty
                ));
                
                incoming.remainingQuantity -= fillQty;
                resting.remainingQuantity -= fillQty;
                
                if (resting.remainingQuantity == 0) {
                    queue.pollFirst();
                    orderIndex.remove(resting.orderId);
                }
            }
            
            if (queue.isEmpty()) {
                oppositeSide.pollFirstEntry();
            }
        }
    }
    
    public boolean cancelOrder(String orderId) {
        Order order = orderIndex.remove(orderId);
        if (order == null) return false;
        
        TreeMap<BigDecimal, Deque<Order>> side = order.isBuy ? bids : asks;
        Deque<Order> queue = side.get(order.price);
        if (queue != null) {
            queue.remove(order); // O(n) within price level -- acceptable, levels are small
            if (queue.isEmpty()) side.remove(order.price);
        }
        return true;
    }
    
    public BigDecimal getBestBid() {
        return bids.isEmpty() ? null : bids.firstKey();
    }
    
    public BigDecimal getBestAsk() {
        return asks.isEmpty() ? null : asks.firstKey();
    }
    
    public BigDecimal getSpread() {
        BigDecimal bid = getBestBid(), ask = getBestAsk();
        return (bid != null && ask != null) ? ask.subtract(bid) : null;
    }
}
```

**Why TreeMap?** The order book needs: (1) O(log P) insert at a price level, (2) O(1) access to the best bid/ask (`firstEntry`), (3) O(log P) removal of depleted price levels. TreeMap provides all three. P is the number of distinct price levels, typically 100-1000 for liquid instruments.

**Production reality:** Real exchanges (LMAX, NASDAQ's matching engine) do NOT use `TreeMap`. They use array-indexed price levels -- since prices are discrete (tick size of $0.01), you can map price to an array index: `index = (int)((price - minPrice) / tickSize)`. This gives O(1) access to any price level. The trade-off: you pre-allocate array space for the entire price range, but that is a few MB at most. They also avoid all object allocation on the hot path (no `BigDecimal`, no `ArrayDeque` nodes) -- everything is stored in pre-allocated ring buffers with flyweight patterns. The **LMAX Disruptor** pattern eliminates all GC pauses from the matching engine.

### 14.2.2 Time-Series Data: Circular Buffer for Tick Data

Market data arrives as a stream of ticks (price, volume, timestamp). You need to maintain the last N ticks for analysis. A circular buffer (ring buffer) provides O(1) append with fixed memory.

```java
public class TickBuffer {
    
    static class Tick {
        final long timestamp;
        final double price;
        final int volume;
        
        Tick(long timestamp, double price, int volume) {
            this.timestamp = timestamp;
            this.price = price;
            this.volume = volume;
        }
    }
    
    private final Tick[] buffer;
    private final int capacity;
    private int head = 0; // next write position
    private int size = 0;
    
    public TickBuffer(int capacity) {
        this.capacity = capacity;
        this.buffer = new Tick[capacity];
    }
    
    public void addTick(Tick tick) {
        buffer[head] = tick;
        head = (head + 1) % capacity;
        if (size < capacity) size++;
    }
    
    public Tick getLatest() {
        if (size == 0) throw new NoSuchElementException();
        return buffer[(head - 1 + capacity) % capacity];
    }
    
    public Tick getOldest() {
        if (size == 0) throw new NoSuchElementException();
        int tail = (head - size + capacity) % capacity;
        return buffer[tail];
    }
    
    // Iterate from oldest to newest
    public void forEach(Consumer<Tick> consumer) {
        int start = (head - size + capacity) % capacity;
        for (int i = 0; i < size; i++) {
            consumer.accept(buffer[(start + i) % capacity]);
        }
    }
    
    public int size() { return size; }
}
```

**JVM advantage:** The `Tick[]` array is a contiguous block of references in memory. Sequential iteration has excellent cache locality. Compare to a `LinkedList<Tick>` where each node is a separate heap object, scattered across memory -- every `.next` dereference is a potential cache miss. For a buffer of 100,000 ticks, the `LinkedList` approach would create 100,000 `Node` objects (24 bytes each for item + next + prev references plus 16 bytes header = 40 bytes), totaling 4 MB of node overhead alone. The array approach uses zero extra memory beyond the `Tick` references.

**Kafka correlation:** Apache **Kafka**'s log segment is essentially a ring buffer at the filesystem level. Old segments are deleted (or compacted) when they exceed retention. The concept is identical: fixed-capacity, append-only, oldest entries automatically evicted.

### 14.2.3 Risk Calculation: Segment Tree for Range Aggregation

A portfolio of 10,000 instruments. Each instrument's value changes with market data. The risk engine needs to compute the total value of any sub-portfolio (instruments i through j) in O(log n), and update individual instrument values in O(log n).

```java
public class PortfolioSegmentTree {
    private final double[] tree;
    private final int n;
    
    public PortfolioSegmentTree(double[] values) {
        this.n = values.length;
        this.tree = new double[4 * n];
        build(values, 1, 0, n - 1);
    }
    
    private void build(double[] values, int node, int start, int end) {
        if (start == end) {
            tree[node] = values[start];
        } else {
            int mid = (start + end) / 2;
            build(values, 2 * node, start, mid);
            build(values, 2 * node + 1, mid + 1, end);
            tree[node] = tree[2 * node] + tree[2 * node + 1];
        }
    }
    
    // Update instrument at index 'idx' to new value
    public void update(int idx, double newValue) {
        update(1, 0, n - 1, idx, newValue);
    }
    
    private void update(int node, int start, int end, int idx, double val) {
        if (start == end) {
            tree[node] = val;
        } else {
            int mid = (start + end) / 2;
            if (idx <= mid) update(2 * node, start, mid, idx, val);
            else update(2 * node + 1, mid + 1, end, idx, val);
            tree[node] = tree[2 * node] + tree[2 * node + 1];
        }
    }
    
    // Sum of values for instruments in range [l, r]
    public double rangeSum(int l, int r) {
        return query(1, 0, n - 1, l, r);
    }
    
    private double query(int node, int start, int end, int l, int r) {
        if (r < start || end < l) return 0;
        if (l <= start && end <= r) return tree[node];
        int mid = (start + end) / 2;
        return query(2 * node, start, mid, l, r) 
             + query(2 * node + 1, mid + 1, end, l, r);
    }
}
```

**Why not just sum the array?** With 10,000 instruments and market data arriving at 100,000 ticks/second, each tick potentially updating 1-10 instruments, you might have 1,000,000 updates per second. If each update requires re-summing the entire array to get portfolio value, that is 10^10 operations/second. The segment tree reduces this to 10^6 x log(10^4) = ~14 million operations/second. Entirely feasible on a single core.

### 14.2.4 Transaction Ledger: Append-Only Log with Hash Chain

Every financial transaction must be recorded in an immutable, verifiable log. New entries are appended; old entries are never modified. Each entry contains a hash of the previous entry, forming a hash chain -- the fundamental concept behind blockchain.

```java
public class TransactionLedger {
    
    static class LedgerEntry {
        final int index;
        final long timestamp;
        final String transactionId;
        final String data;           // serialized transaction
        final String previousHash;
        final String hash;
        
        LedgerEntry(int index, long timestamp, String transactionId, 
                    String data, String previousHash) {
            this.index = index;
            this.timestamp = timestamp;
            this.transactionId = transactionId;
            this.data = data;
            this.previousHash = previousHash;
            this.hash = computeHash();
        }
        
        private String computeHash() {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                String content = index + timestamp + transactionId + data + previousHash;
                byte[] digest = md.digest(content.getBytes(StandardCharsets.UTF_8));
                return bytesToHex(digest);
            } catch (NoSuchAlgorithmException e) {
                throw new RuntimeException(e);
            }
        }
        
        private static String bytesToHex(byte[] bytes) {
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) sb.append(String.format("%02x", b));
            return sb.toString();
        }
    }
    
    private final List<LedgerEntry> chain = new ArrayList<>(); // append-only
    
    public synchronized LedgerEntry append(String transactionId, String data) {
        String prevHash = chain.isEmpty() ? "0" : chain.get(chain.size() - 1).hash;
        LedgerEntry entry = new LedgerEntry(
            chain.size(), System.currentTimeMillis(), transactionId, data, prevHash
        );
        chain.add(entry);
        return entry;
    }
    
    public boolean verifyIntegrity() {
        for (int i = 1; i < chain.size(); i++) {
            LedgerEntry current = chain.get(i);
            LedgerEntry previous = chain.get(i - 1);
            
            // Verify hash chain linkage
            if (!current.previousHash.equals(previous.hash)) return false;
            // Verify entry has not been tampered with
            if (!current.hash.equals(current.computeHash())) return false;
        }
        return true;
    }
    
    public LedgerEntry getEntry(int index) {
        return chain.get(index);
    }
    
    public int size() { return chain.size(); }
}
```

**The data structure insight:** This is a singly-linked list where the "next pointer" is replaced by a cryptographic hash of the previous node. Modify any entry, and its hash changes, which breaks the link from the next entry -- and every subsequent entry. Verification is O(n) by walking the chain and recomputing hashes. This is exactly how **Bitcoin** and every blockchain works at the data structure level. The distributed consensus layer (proof of work, proof of stake) is a separate concern -- the data structure itself is just a hash-linked list.

### 14.2.5 Moving Average: Sliding Window with ArrayDeque

A stock ticker showing the 20-period simple moving average (SMA). Each new price arrives, the oldest price leaves, and the average updates. A sliding window with a running sum gives O(1) per update.

```java
public class MovingAverage {
    private final int windowSize;
    private final Deque<Double> window = new ArrayDeque<>();
    private double runningSum = 0.0;
    
    public MovingAverage(int windowSize) {
        this.windowSize = windowSize;
    }
    
    public double next(double price) {
        window.addLast(price);
        runningSum += price;
        
        if (window.size() > windowSize) {
            runningSum -= window.pollFirst();
        }
        
        return runningSum / window.size();
    }
    
    public boolean isReady() {
        return window.size() == windowSize;
    }
}
```

**Numerical stability:** For very long running windows (millions of prices), the accumulated floating-point error in `runningSum` can become significant. Production systems periodically recompute the sum from scratch, or use Kahan summation (compensated summation) to maintain precision. For a 20-period SMA, this is not a concern.

**Why `ArrayDeque` over `LinkedList`?** `ArrayDeque` is backed by a circular array. `addLast` and `pollFirst` are O(1) amortized with no allocation (until the array resizes). `LinkedList` creates a new `Node` object on every `addLast` -- that is 40 bytes of heap allocation per price tick. At 10,000 ticks/second, that is 400 KB/second of garbage for the GC to collect. `ArrayDeque` produces zero garbage once the array is sized.

---

## 14.3 Social Networks

Social networks are graph problems in disguise. The friend relationship is an undirected edge. The follow relationship is a directed edge. The news feed is a merge of sorted streams. Mutual friend discovery is set intersection. "People you may know" is short-path graph exploration. The data structures here are graph-centric, with clever use of sets and priority queues.

### 14.3.1 Friend Graph: Adjacency List with HashMap

The social graph: each user has a set of friends (undirected) or followers (directed).

```java
public class SocialGraph {
    // Undirected friend graph
    private final Map<Long, Set<Long>> friends = new HashMap<>();
    
    public void addFriendship(long user1, long user2) {
        friends.computeIfAbsent(user1, k -> new HashSet<>()).add(user2);
        friends.computeIfAbsent(user2, k -> new HashSet<>()).add(user1);
    }
    
    public void removeFriendship(long user1, long user2) {
        Set<Long> set1 = friends.get(user1);
        Set<Long> set2 = friends.get(user2);
        if (set1 != null) set1.remove(user2);
        if (set2 != null) set2.remove(user1);
    }
    
    public Set<Long> getFriends(long userId) {
        return friends.getOrDefault(userId, Collections.emptySet());
    }
    
    public boolean areFriends(long user1, long user2) {
        Set<Long> set = friends.get(user1);
        return set != null && set.contains(user2);
    }
    
    public int friendCount(long userId) {
        return getFriends(userId).size();
    }
}
```

**Memory analysis:** For a social network with 100 million users, average 150 friends each. Each `HashSet<Long>` entry stores a boxed `Long` (24 bytes: 16 header + 8 value) plus a `HashMap.Node` (32 bytes: 16 header + hash + key + value + next). Per friend entry: ~56 bytes. Total: 100M x 150 x 56 = ~840 GB. That does not fit in one machine's memory.

This is why **Facebook** (now Meta) uses a distributed graph store (TAO -- "The Associations and Objects" cache). The data structure is conceptually the same adjacency list, but sharded across thousands of machines. The shard key is typically `userId % numShards`. Look up friends: hash to shard, fetch the adjacency list. The algorithmic thinking is identical; the deployment is distributed.

### 14.3.2 News Feed: Merge K Sorted Lists

Each user follows N people. Each person has a stream of posts sorted by timestamp (newest first). The news feed merges these streams to show the most recent posts across all followed users.

```java
public class NewsFeedService {
    
    static class Post implements Comparable<Post> {
        final long authorId;
        final long postId;
        final long timestamp;
        final String content;
        
        Post(long authorId, long postId, long timestamp, String content) {
            this.authorId = authorId;
            this.postId = postId;
            this.timestamp = timestamp;
            this.content = content;
        }
        
        @Override
        public int compareTo(Post other) {
            return Long.compare(other.timestamp, this.timestamp); // newest first
        }
    }
    
    // Each user's posts, sorted by timestamp descending
    private final Map<Long, List<Post>> userPosts = new HashMap<>();
    // Follow graph: user -> set of followed user IDs
    private final Map<Long, Set<Long>> following = new HashMap<>();
    
    public void createPost(long userId, String content) {
        List<Post> posts = userPosts.computeIfAbsent(userId, k -> new ArrayList<>());
        posts.add(0, new Post(userId, System.nanoTime(), System.currentTimeMillis(), content));
    }
    
    public void follow(long userId, long targetId) {
        following.computeIfAbsent(userId, k -> new HashSet<>()).add(targetId);
    }
    
    /**
     * Merge K sorted lists using a min-heap (by most recent timestamp).
     * K = number of followed users. Returns top 'limit' posts.
     */
    public List<Post> getFeed(long userId, int limit) {
        Set<Long> followedUsers = following.getOrDefault(userId, Collections.emptySet());
        
        // PriorityQueue entry: [postIndex, userId] -- tracks position in each user's list
        PriorityQueue<long[]> pq = new PriorityQueue<>((a, b) -> {
            Post postA = userPosts.get(a[1]).get((int) a[0]);
            Post postB = userPosts.get(b[1]).get((int) b[0]);
            return Long.compare(postB.timestamp, postA.timestamp); // newest first
        });
        
        // Seed PQ with the first (most recent) post from each followed user
        for (long followedId : followedUsers) {
            List<Post> posts = userPosts.get(followedId);
            if (posts != null && !posts.isEmpty()) {
                pq.offer(new long[]{0, followedId});
            }
        }
        
        List<Post> feed = new ArrayList<>();
        while (!pq.isEmpty() && feed.size() < limit) {
            long[] entry = pq.poll();
            int idx = (int) entry[0];
            long authorId = entry[1];
            
            List<Post> posts = userPosts.get(authorId);
            feed.add(posts.get(idx));
            
            if (idx + 1 < posts.size()) {
                pq.offer(new long[]{idx + 1, authorId});
            }
        }
        
        return feed;
    }
}
```

**Complexity:** Building the feed is O(K log K) for the initial heap construction (K followed users), plus O(limit x log K) for extracting the top 'limit' posts. For a user following 500 people and requesting 20 posts: O(500 log 500 + 20 log 500) = ~4,500 + ~180 = ~4,680 operations. Trivial.

**Fan-out-on-write alternative:** Instead of computing the feed on read (pull model), pre-compute it on write (push model). When a user creates a post, push it to every follower's pre-computed feed list. Read is O(1) -- just fetch the list. Write is O(F) where F is the number of followers. **Twitter** uses a hybrid: fan-out-on-write for normal users, pull-on-read for celebrity users (who have millions of followers). The data structure for the pre-computed feed is a simple bounded list (ring buffer or sorted list with eviction).

### 14.3.3 Mutual Friends: Set Intersection

"You and Alice have 23 mutual friends." This is set intersection.

```java
public class MutualFriendsService {
    private final SocialGraph graph;
    
    public MutualFriendsService(SocialGraph graph) {
        this.graph = graph;
    }
    
    // Approach 1: HashSet.retainAll -- O(min(|A|, |B|)) amortized
    public Set<Long> mutualFriends(long user1, long user2) {
        Set<Long> friends1 = new HashSet<>(graph.getFriends(user1));
        Set<Long> friends2 = graph.getFriends(user2);
        friends1.retainAll(friends2);
        return friends1;
    }
    
    // Approach 2: Sorted arrays + merge -- O(|A| + |B|) worst case, cache-friendly
    public List<Long> mutualFriendsSorted(long user1, long user2) {
        long[] sorted1 = graph.getFriends(user1).stream().mapToLong(Long::longValue).sorted().toArray();
        long[] sorted2 = graph.getFriends(user2).stream().mapToLong(Long::longValue).sorted().toArray();
        
        List<Long> mutual = new ArrayList<>();
        int i = 0, j = 0;
        while (i < sorted1.length && j < sorted2.length) {
            if (sorted1[i] == sorted2[j]) {
                mutual.add(sorted1[i]);
                i++; j++;
            } else if (sorted1[i] < sorted2[j]) {
                i++;
            } else {
                j++;
            }
        }
        return mutual;
    }
}
```

**Which approach is faster?** `HashSet.retainAll` iterates over the smaller set and calls `contains` on the larger set -- each `contains` is O(1) amortized but involves a hash computation and a pointer chase to the bucket. The sorted-merge approach scans two `long[]` arrays sequentially -- pure sequential memory access, L1 cache-friendly. For friend lists of 150 each, the sorted-merge approach is typically faster despite the O(n log n) sort overhead, because the sort itself is cache-friendly (merge sort on primitives in `Arrays.sort(long[])`).

### 14.3.4 Degrees of Separation: BFS

"How many hops between you and Elon Musk?" This is shortest-path in an unweighted graph -- classic BFS.

```java
public class DegreesOfSeparation {
    
    public int findDegrees(SocialGraph graph, long source, long target) {
        if (source == target) return 0;
        
        Set<Long> visited = new HashSet<>();
        Deque<Long> queue = new ArrayDeque<>();
        queue.offer(source);
        visited.add(source);
        int degrees = 0;
        
        while (!queue.isEmpty()) {
            degrees++;
            int levelSize = queue.size();
            for (int i = 0; i < levelSize; i++) {
                long current = queue.poll();
                for (long friend : graph.getFriends(current)) {
                    if (friend == target) return degrees;
                    if (visited.add(friend)) {
                        queue.offer(friend);
                    }
                }
            }
        }
        
        return -1; // not connected
    }
    
    // Bidirectional BFS: meets in the middle, reducing exploration from O(b^d) to O(b^(d/2))
    public int findDegreesBidirectional(SocialGraph graph, long source, long target) {
        if (source == target) return 0;
        
        Map<Long, Integer> visitedFromSource = new HashMap<>();
        Map<Long, Integer> visitedFromTarget = new HashMap<>();
        Deque<Long> queueSource = new ArrayDeque<>();
        Deque<Long> queueTarget = new ArrayDeque<>();
        
        queueSource.offer(source);
        visitedFromSource.put(source, 0);
        queueTarget.offer(target);
        visitedFromTarget.put(target, 0);
        
        while (!queueSource.isEmpty() && !queueTarget.isEmpty()) {
            // Expand the smaller frontier
            int result;
            if (queueSource.size() <= queueTarget.size()) {
                result = expandLevel(graph, queueSource, visitedFromSource, visitedFromTarget);
            } else {
                result = expandLevel(graph, queueTarget, visitedFromTarget, visitedFromSource);
            }
            if (result >= 0) return result;
        }
        
        return -1;
    }
    
    private int expandLevel(SocialGraph graph, Deque<Long> queue, 
                           Map<Long, Integer> thisVisited, Map<Long, Integer> otherVisited) {
        int levelSize = queue.size();
        for (int i = 0; i < levelSize; i++) {
            long current = queue.poll();
            int currentDist = thisVisited.get(current);
            for (long friend : graph.getFriends(current)) {
                if (otherVisited.containsKey(friend)) {
                    return currentDist + 1 + otherVisited.get(friend);
                }
                if (!thisVisited.containsKey(friend)) {
                    thisVisited.put(friend, currentDist + 1);
                    queue.offer(friend);
                }
            }
        }
        return -1;
    }
}
```

**Why bidirectional BFS?** With an average branching factor of 150 (friends per person) and six degrees of separation, standard BFS explores up to 150^6 = ~1.1 x 10^13 nodes. Bidirectional BFS explores 2 x 150^3 = ~6.75 million nodes. That is a factor of 1.6 million improvement. LinkedIn uses this approach for its "degrees of connection" feature.

### 14.3.5 Trending Topics: Count-Min Sketch + PriorityQueue

Millions of hashtags per hour. You need the top 10 trending hashtags. Exact counting with a `HashMap<String, Long>` works but consumes unbounded memory. The Count-Min Sketch provides approximate counts in bounded space.

```java
public class TrendingTopics {
    
    // Count-Min Sketch for approximate frequency estimation
    static class CountMinSketch {
        private final int[][] table;
        private final int width;
        private final int depth;
        private final int[] hashSeeds;
        
        CountMinSketch(int width, int depth) {
            this.width = width;
            this.depth = depth;
            this.table = new int[depth][width];
            this.hashSeeds = new int[depth];
            Random rng = new Random(42);
            for (int i = 0; i < depth; i++) hashSeeds[i] = rng.nextInt();
        }
        
        void add(String item) {
            for (int i = 0; i < depth; i++) {
                int hash = (item.hashCode() ^ hashSeeds[i]) & 0x7fffffff;
                table[i][hash % width]++;
            }
        }
        
        int estimate(String item) {
            int min = Integer.MAX_VALUE;
            for (int i = 0; i < depth; i++) {
                int hash = (item.hashCode() ^ hashSeeds[i]) & 0x7fffffff;
                min = Math.min(min, table[i][hash % width]);
            }
            return min;
        }
    }
    
    private final CountMinSketch sketch;
    private final PriorityQueue<Map.Entry<String, Integer>> topK;
    private final Map<String, Integer> topKMap; // track items currently in top-K
    private final int k;
    
    public TrendingTopics(int k, int sketchWidth, int sketchDepth) {
        this.k = k;
        this.sketch = new CountMinSketch(sketchWidth, sketchDepth);
        this.topK = new PriorityQueue<>(Comparator.comparingInt(Map.Entry::getValue));
        this.topKMap = new HashMap<>();
    }
    
    public void recordHashtag(String hashtag) {
        sketch.add(hashtag);
        int estimatedCount = sketch.estimate(hashtag);
        
        if (topKMap.containsKey(hashtag)) {
            // Update existing entry: remove and re-insert with new count
            topKMap.put(hashtag, estimatedCount);
            rebuildHeap();
        } else if (topK.size() < k) {
            topK.offer(Map.entry(hashtag, estimatedCount));
            topKMap.put(hashtag, estimatedCount);
        } else if (estimatedCount > topK.peek().getValue()) {
            Map.Entry<String, Integer> evicted = topK.poll();
            topKMap.remove(evicted.getKey());
            topK.offer(Map.entry(hashtag, estimatedCount));
            topKMap.put(hashtag, estimatedCount);
        }
    }
    
    private void rebuildHeap() {
        topK.clear();
        for (var entry : topKMap.entrySet()) {
            topK.offer(Map.entry(entry.getKey(), entry.getValue()));
        }
    }
    
    public List<String> getTopK() {
        List<String> result = new ArrayList<>();
        PriorityQueue<Map.Entry<String, Integer>> copy = new PriorityQueue<>(topK);
        while (!copy.isEmpty()) result.add(copy.poll().getKey());
        Collections.reverse(result);
        return result;
    }
}
```

**Space analysis:** A Count-Min Sketch with width=10000, depth=7 uses 10000 x 7 x 4 bytes = 280 KB. It can track frequency estimates for unlimited items in that fixed space. The error probability is controlled by depth (number of hash functions), and error magnitude by width. With these parameters, the probability of overestimating any item's count by more than N/10000 (where N is total count) is less than 2^(-7) < 1%.

**Production deployment:** **Twitter** uses a similar approach for trending topics. The Count-Min Sketch is reset on a time window (hourly), and the top-K heap is merged across time windows to detect trends (increasing frequency over time, not just high absolute frequency).

---

## 14.4 Gaming

Game development pushes data structures to their limits. Spatial queries must run in microseconds for smooth frame rates. Pathfinding must navigate complex terrain in milliseconds. Leaderboards must update in real time across millions of players. Game state must support undo/redo for both gameplay and editor tooling.

### 14.4.1 Spatial Indexing: Quadtree for Collision Detection

A 2D game with thousands of entities (players, projectiles, NPCs). Every frame, you need to detect which entities are close enough to collide. Naive pairwise checking is O(n^2). A quadtree reduces this to O(n log n) average case.

```java
public class Quadtree {
    
    static class AABB { // Axis-Aligned Bounding Box
        final double x, y, width, height;
        
        AABB(double x, double y, double width, double height) {
            this.x = x; this.y = y;
            this.width = width; this.height = height;
        }
        
        boolean contains(double px, double py) {
            return px >= x && px <= x + width && py >= y && py <= y + height;
        }
        
        boolean intersects(AABB other) {
            return !(other.x > x + width || other.x + other.width < x 
                  || other.y > y + height || other.y + other.height < y);
        }
    }
    
    static class Entity {
        final int id;
        double x, y;
        double radius; // collision radius
        
        Entity(int id, double x, double y, double radius) {
            this.id = id; this.x = x; this.y = y; this.radius = radius;
        }
    }
    
    private static final int MAX_ENTITIES = 8;
    private static final int MAX_DEPTH = 8;
    
    private final AABB boundary;
    private final int depth;
    private final List<Entity> entities = new ArrayList<>();
    private Quadtree[] children = null; // NW, NE, SW, SE
    
    public Quadtree(AABB boundary, int depth) {
        this.boundary = boundary;
        this.depth = depth;
    }
    
    public boolean insert(Entity entity) {
        if (!boundary.contains(entity.x, entity.y)) return false;
        
        if (entities.size() < MAX_ENTITIES || depth >= MAX_DEPTH) {
            entities.add(entity);
            return true;
        }
        
        if (children == null) subdivide();
        
        for (Quadtree child : children) {
            if (child.insert(entity)) return true;
        }
        
        // Should not reach here if boundary check is correct
        entities.add(entity);
        return true;
    }
    
    private void subdivide() {
        double halfW = boundary.width / 2, halfH = boundary.height / 2;
        double x = boundary.x, y = boundary.y;
        
        children = new Quadtree[4];
        children[0] = new Quadtree(new AABB(x, y, halfW, halfH), depth + 1);              // NW
        children[1] = new Quadtree(new AABB(x + halfW, y, halfW, halfH), depth + 1);      // NE
        children[2] = new Quadtree(new AABB(x, y + halfH, halfW, halfH), depth + 1);      // SW
        children[3] = new Quadtree(new AABB(x + halfW, y + halfH, halfW, halfH), depth + 1); // SE
        
        // Re-insert existing entities into children
        List<Entity> temp = new ArrayList<>(entities);
        entities.clear();
        for (Entity e : temp) {
            boolean inserted = false;
            for (Quadtree child : children) {
                if (child.insert(e)) { inserted = true; break; }
            }
            if (!inserted) entities.add(e); // keep in parent if on boundary
        }
    }
    
    // Find all entities within a given range
    public List<Entity> queryRange(AABB range) {
        List<Entity> found = new ArrayList<>();
        queryRange(range, found);
        return found;
    }
    
    private void queryRange(AABB range, List<Entity> found) {
        if (!boundary.intersects(range)) return;
        
        for (Entity e : entities) {
            if (range.contains(e.x, e.y)) found.add(e);
        }
        
        if (children != null) {
            for (Quadtree child : children) {
                child.queryRange(range, found);
            }
        }
    }
    
    // Collision detection: for each entity, query nearby entities
    public List<int[]> detectCollisions() {
        List<int[]> collisions = new ArrayList<>();
        List<Entity> allEntities = new ArrayList<>();
        getAllEntities(allEntities);
        
        for (Entity e : allEntities) {
            AABB searchArea = new AABB(
                e.x - e.radius * 2, e.y - e.radius * 2, 
                e.radius * 4, e.radius * 4
            );
            List<Entity> nearby = queryRange(searchArea);
            for (Entity other : nearby) {
                if (other.id > e.id) { // avoid duplicate pairs
                    double dist = Math.hypot(e.x - other.x, e.y - other.y);
                    if (dist < e.radius + other.radius) {
                        collisions.add(new int[]{e.id, other.id});
                    }
                }
            }
        }
        return collisions;
    }
    
    private void getAllEntities(List<Entity> result) {
        result.addAll(entities);
        if (children != null) {
            for (Quadtree child : children) child.getAllEntities(result);
        }
    }
}
```

**Grid-based alternative:** For many games, a simpler spatial hash performs better. Divide the world into cells of size `cellSize` (typically 2x the largest entity radius). Map each cell to a list of entities:

```java
Map<Long, List<Entity>> grid = new HashMap<>();

long cellKey(double x, double y, double cellSize) {
    int cx = (int) Math.floor(x / cellSize);
    int cy = (int) Math.floor(y / cellSize);
    return ((long) cx << 32) | (cy & 0xFFFFFFFFL);
}
```

For each entity, check only the 9 neighboring cells (3x3 grid around the entity's cell). This is O(1) per entity if entities are uniformly distributed. The quadtree is better when entity density varies wildly across the map (dense clusters in some areas, sparse in others).

### 14.4.2 Pathfinding: A* with PriorityQueue

A character needs to navigate from point A to point B on a grid with obstacles. A* is the standard algorithm: it uses a heuristic to guide search toward the goal, expanding fewer nodes than Dijkstra.

```java
public class AStarPathfinder {
    
    static class Node implements Comparable<Node> {
        final int row, col;
        double gCost; // actual cost from start
        double fCost; // gCost + heuristic estimate to goal
        Node parent;
        
        Node(int row, int col, double gCost, double fCost, Node parent) {
            this.row = row; this.col = col;
            this.gCost = gCost; this.fCost = fCost;
            this.parent = parent;
        }
        
        @Override
        public int compareTo(Node other) {
            return Double.compare(this.fCost, other.fCost);
        }
    }
    
    private static final int[][] DIRS = {{-1,0},{1,0},{0,-1},{0,1},{-1,-1},{-1,1},{1,-1},{1,1}};
    private static final double SQRT2 = Math.sqrt(2);
    
    /**
     * A* pathfinding on a grid. 0 = walkable, 1 = obstacle.
     * Returns the path as a list of [row, col] from start to goal.
     */
    public List<int[]> findPath(int[][] grid, int[] start, int[] goal) {
        int rows = grid.length, cols = grid[0].length;
        
        PriorityQueue<Node> openSet = new PriorityQueue<>();
        double[][] gCosts = new double[rows][cols];
        for (double[] row : gCosts) Arrays.fill(row, Double.MAX_VALUE);
        
        gCosts[start[0]][start[1]] = 0;
        double h = heuristic(start[0], start[1], goal[0], goal[1]);
        openSet.offer(new Node(start[0], start[1], 0, h, null));
        
        boolean[][] closed = new boolean[rows][cols];
        
        while (!openSet.isEmpty()) {
            Node current = openSet.poll();
            
            if (current.row == goal[0] && current.col == goal[1]) {
                return reconstructPath(current);
            }
            
            if (closed[current.row][current.col]) continue; // lazy deletion
            closed[current.row][current.col] = true;
            
            for (int[] dir : DIRS) {
                int nr = current.row + dir[0], nc = current.col + dir[1];
                if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                if (grid[nr][nc] == 1 || closed[nr][nc]) continue;
                
                // Diagonal movement costs sqrt(2), cardinal costs 1
                double moveCost = (dir[0] != 0 && dir[1] != 0) ? SQRT2 : 1.0;
                double newG = current.gCost + moveCost;
                
                if (newG < gCosts[nr][nc]) {
                    gCosts[nr][nc] = newG;
                    double newF = newG + heuristic(nr, nc, goal[0], goal[1]);
                    openSet.offer(new Node(nr, nc, newG, newF, current));
                }
            }
        }
        
        return Collections.emptyList(); // no path found
    }
    
    // Octile distance: consistent heuristic for 8-directional grid
    private double heuristic(int r1, int c1, int r2, int c2) {
        int dr = Math.abs(r1 - r2), dc = Math.abs(c1 - c2);
        return Math.max(dr, dc) + (SQRT2 - 1) * Math.min(dr, dc);
    }
    
    private List<int[]> reconstructPath(Node node) {
        List<int[]> path = new ArrayList<>();
        while (node != null) {
            path.add(new int[]{node.row, node.col});
            node = node.parent;
        }
        Collections.reverse(path);
        return path;
    }
}
```

**Why A* over Dijkstra?** Both find optimal paths when the heuristic is admissible (never overestimates). But A* expands far fewer nodes because the heuristic biases exploration toward the goal. On a 1000x1000 grid with 10% obstacles, Dijkstra might explore 500,000 nodes to find a path; A* with octile distance heuristic might explore 5,000. That is a 100x reduction in nodes expanded, which translates directly to faster pathfinding.

**JVM optimization:** The `PriorityQueue` in the A* open set is a binary heap. Each `offer` and `poll` is O(log n). The bottleneck is often the `Node` object allocation -- each explored cell creates a new `Node` on the heap. For pathfinding-heavy games, pre-allocate a pool of `Node` objects and recycle them to avoid GC pressure. Alternatively, use a flat array representation where `gCosts[r][c]` and `parent[r][c]` are separate 2D arrays, eliminating `Node` objects entirely.

### 14.4.3 Entity Component System: HashMap Per Entity

Modern game engines use the Entity Component System (ECS) pattern. An entity is just an ID. Components are data bags (Position, Velocity, Health, Sprite). Systems process entities that have specific component combinations.

```java
public class ECS {
    
    interface Component {}
    
    static class Position implements Component {
        double x, y;
        Position(double x, double y) { this.x = x; this.y = y; }
    }
    
    static class Velocity implements Component {
        double dx, dy;
        Velocity(double dx, double dy) { this.dx = dx; this.dy = dy; }
    }
    
    static class Health implements Component {
        int current, max;
        Health(int max) { this.current = max; this.max = max; }
    }
    
    // Entity storage: entityId -> (componentClass -> component)
    private final Map<Integer, Map<Class<? extends Component>, Component>> entities = new HashMap<>();
    private int nextId = 0;
    
    public int createEntity() {
        int id = nextId++;
        entities.put(id, new HashMap<>());
        return id;
    }
    
    public <T extends Component> void addComponent(int entityId, T component) {
        entities.get(entityId).put(component.getClass(), component);
    }
    
    @SuppressWarnings("unchecked")
    public <T extends Component> T getComponent(int entityId, Class<T> type) {
        return (T) entities.get(entityId).get(type);
    }
    
    public boolean hasComponent(int entityId, Class<? extends Component> type) {
        Map<Class<? extends Component>, Component> components = entities.get(entityId);
        return components != null && components.containsKey(type);
    }
    
    // System: update positions based on velocity
    public void movementSystem(double deltaTime) {
        for (var entry : entities.entrySet()) {
            int entityId = entry.getKey();
            if (hasComponent(entityId, Position.class) && hasComponent(entityId, Velocity.class)) {
                Position pos = getComponent(entityId, Position.class);
                Velocity vel = getComponent(entityId, Velocity.class);
                pos.x += vel.dx * deltaTime;
                pos.y += vel.dy * deltaTime;
            }
        }
    }
    
    // System: damage entities in a radius
    public void areaDamage(double cx, double cy, double radius, int damage) {
        for (var entry : entities.entrySet()) {
            int entityId = entry.getKey();
            if (hasComponent(entityId, Position.class) && hasComponent(entityId, Health.class)) {
                Position pos = getComponent(entityId, Position.class);
                double dist = Math.hypot(pos.x - cx, pos.y - cy);
                if (dist <= radius) {
                    Health health = getComponent(entityId, Health.class);
                    health.current = Math.max(0, health.current - damage);
                }
            }
        }
    }
}
```

**Cache performance problem:** This HashMap-of-HashMaps approach stores components scattered across the heap. When the movement system iterates over all entities with Position and Velocity, it chases pointers through two levels of HashMap for every entity. For 10,000 entities at 60 FPS, that is 1.2 million pointer-chasing operations per second.

Production ECS frameworks (like Artemis, Ashley, or libGDX's ECS) use an archetype-based approach: entities with the same component set are stored together in contiguous arrays. All Position components for entities with {Position, Velocity} archetype live in one `Position[]` array. The movement system iterates this array sequentially -- no HashMap lookups, pure cache-line-friendly sequential access. The `HashMap<Class, Component>` per entity is a good conceptual model; the archetype array is the production implementation.

### 14.4.4 Leaderboard: TreeMap by Score

A game leaderboard: millions of players, each with a score. Support: (1) update score, (2) get top-K, (3) get a player's rank.

```java
public class Leaderboard {
    
    static class PlayerScore implements Comparable<PlayerScore> {
        final String playerId;
        final long score;
        
        PlayerScore(String playerId, long score) {
            this.playerId = playerId;
            this.score = score;
        }
        
        @Override
        public int compareTo(PlayerScore other) {
            // Higher score = better rank. Break ties by playerId for uniqueness.
            int cmp = Long.compare(other.score, this.score);
            return cmp != 0 ? cmp : this.playerId.compareTo(other.playerId);
        }
        
        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof PlayerScore)) return false;
            PlayerScore that = (PlayerScore) o;
            return score == that.score && playerId.equals(that.playerId);
        }
        
        @Override
        public int hashCode() {
            return Objects.hash(playerId, score);
        }
    }
    
    private final TreeMap<PlayerScore, Boolean> board = new TreeMap<>();
    private final Map<String, Long> playerScores = new HashMap<>(); // track current score
    
    public void updateScore(String playerId, long newScore) {
        Long oldScore = playerScores.get(playerId);
        if (oldScore != null) {
            board.remove(new PlayerScore(playerId, oldScore));
        }
        board.put(new PlayerScore(playerId, newScore), Boolean.TRUE);
        playerScores.put(playerId, newScore);
    }
    
    public List<String> topK(int k) {
        List<String> result = new ArrayList<>();
        for (PlayerScore ps : board.navigableKeySet()) {
            result.add(ps.playerId);
            if (result.size() >= k) break;
        }
        return result;
    }
    
    // Rank is 1-based: rank 1 = highest score
    public int getRank(String playerId) {
        Long score = playerScores.get(playerId);
        if (score == null) return -1;
        PlayerScore key = new PlayerScore(playerId, score);
        // headMap gives all entries before this one (i.e., higher ranked)
        return board.headMap(key).size() + 1; // O(n) -- not ideal
    }
}
```

**The rank problem:** `getRank` is O(n) because `TreeMap.headMap().size()` iterates the sub-tree. For a leaderboard with millions of players, this is unacceptable. Solutions:

1. **Order-statistic tree** (augmented BST where each node stores subtree size): O(log n) rank queries. Java does not have one in the JDK, but you can build one or use a library.
2. **Fenwick tree on bucketed scores**: If scores are integers in [0, MAX_SCORE], maintain a Fenwick tree where index i stores the count of players with score i. Rank = total players - prefix_sum(score). Both update and rank are O(log MAX_SCORE).
3. **Redis ZSET**: In production, **Redis** sorted sets use a skip list with a hash table. `ZRANK` is O(log n). This is the standard production solution for game leaderboards.

### 14.4.5 Game State: Stack for Undo/Redo (Command Pattern)

Every game editor (and many games) needs undo/redo. The command pattern with two stacks implements this cleanly.

```java
public class UndoRedoSystem {
    
    interface Command {
        void execute();
        void undo();
        String description();
    }
    
    // Example: move an entity
    static class MoveEntityCommand implements Command {
        private final ECS.Position position;
        private final double newX, newY;
        private double oldX, oldY;
        
        MoveEntityCommand(ECS.Position position, double newX, double newY) {
            this.position = position;
            this.newX = newX;
            this.newY = newY;
        }
        
        @Override
        public void execute() {
            oldX = position.x; oldY = position.y;
            position.x = newX; position.y = newY;
        }
        
        @Override
        public void undo() {
            position.x = oldX; position.y = oldY;
        }
        
        @Override
        public String description() {
            return String.format("Move entity to (%.1f, %.1f)", newX, newY);
        }
    }
    
    private final Deque<Command> undoStack = new ArrayDeque<>();
    private final Deque<Command> redoStack = new ArrayDeque<>();
    private final int maxHistory;
    
    public UndoRedoSystem(int maxHistory) {
        this.maxHistory = maxHistory;
    }
    
    public void executeCommand(Command command) {
        command.execute();
        undoStack.push(command);
        redoStack.clear(); // new action invalidates redo history
        
        // Limit history size to prevent memory leak
        if (undoStack.size() > maxHistory) {
            // Remove oldest command (bottom of stack)
            // ArrayDeque: removeLast() removes from the "bottom" (tail)
            ((ArrayDeque<Command>) undoStack).removeLast();
        }
    }
    
    public boolean undo() {
        if (undoStack.isEmpty()) return false;
        Command command = undoStack.pop();
        command.undo();
        redoStack.push(command);
        return true;
    }
    
    public boolean redo() {
        if (redoStack.isEmpty()) return false;
        Command command = redoStack.pop();
        command.execute();
        undoStack.push(command);
        return true;
    }
    
    public List<String> getUndoHistory() {
        List<String> history = new ArrayList<>();
        for (Command cmd : undoStack) {
            history.add(cmd.description());
        }
        return history;
    }
}
```

**Why two stacks?** The undo stack holds executed commands in reverse chronological order. Pop the top, undo it, push it onto the redo stack. If a new command is executed, clear the redo stack (you cannot redo after a new action diverges the timeline). This is O(1) for all operations. Using a single list with an index pointer is also viable, but the two-stack approach is cleaner and naturally prevents the "redo after divergence" bug.

---

## 14.5 Logging and Monitoring

Observability systems process enormous volumes of events -- millions of log lines per second, thousands of metric data points per second. The data structures must handle high throughput with bounded memory, provide real-time aggregation, and support approximate queries where exact answers are too expensive.

### 14.5.1 Ring Buffer for Fixed-Size Log Retention

Keep the last N log entries in memory for quick access. The ring buffer provides O(1) append with guaranteed bounded memory.

```java
public class InMemoryLogBuffer {
    
    static class LogEntry {
        final long timestamp;
        final String level; // INFO, WARN, ERROR
        final String message;
        final String source;
        
        LogEntry(long timestamp, String level, String message, String source) {
            this.timestamp = timestamp;
            this.level = level;
            this.message = message;
            this.source = source;
        }
    }
    
    private final LogEntry[] buffer;
    private final int capacity;
    private int head = 0;
    private int count = 0;
    
    public InMemoryLogBuffer(int capacity) {
        this.capacity = capacity;
        this.buffer = new LogEntry[capacity];
    }
    
    public void append(LogEntry entry) {
        buffer[head] = entry;
        head = (head + 1) % capacity;
        if (count < capacity) count++;
    }
    
    // Get most recent N entries, newest first
    public List<LogEntry> getRecent(int n) {
        int toReturn = Math.min(n, count);
        List<LogEntry> result = new ArrayList<>(toReturn);
        for (int i = 0; i < toReturn; i++) {
            int idx = (head - 1 - i + capacity) % capacity;
            result.add(buffer[idx]);
        }
        return result;
    }
    
    // Search logs by level
    public List<LogEntry> searchByLevel(String level, int maxResults) {
        List<LogEntry> result = new ArrayList<>();
        for (int i = 0; i < count && result.size() < maxResults; i++) {
            int idx = (head - 1 - i + capacity) % capacity;
            if (buffer[idx].level.equals(level)) result.add(buffer[idx]);
        }
        return result;
    }
}
```

**LMAX Disruptor pattern:** The LMAX Disruptor is a high-performance ring buffer designed for inter-thread communication. It avoids locks by using a single-writer principle: one producer thread writes to the buffer, and consumer threads read from it using memory barriers (volatile reads) instead of locks. The ring buffer is pre-allocated (no GC), and the sequence number is a `long` that wraps around modulo capacity. This design achieves over 100 million messages per second on a single thread. The key insight: the ring buffer's fixed size means zero allocation on the hot path, and the single-writer principle eliminates all contention.

### 14.5.2 Top-K Frequent Errors: HashMap + PriorityQueue

From millions of log lines, find the top 10 most frequent error messages. Classic top-K heavy hitters problem.

```java
public class TopKErrors {
    
    private final Map<String, Integer> errorCounts = new HashMap<>();
    
    public void recordError(String errorMessage) {
        // Normalize: strip variable parts (timestamps, IDs) to group similar errors
        String normalized = normalizeError(errorMessage);
        errorCounts.merge(normalized, 1, Integer::sum);
    }
    
    public List<Map.Entry<String, Integer>> getTopK(int k) {
        // Min-heap: keeps the K entries with highest counts
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            Comparator.comparingInt(Map.Entry::getValue)
        );
        
        for (var entry : errorCounts.entrySet()) {
            pq.offer(entry);
            if (pq.size() > k) pq.poll();
        }
        
        List<Map.Entry<String, Integer>> result = new ArrayList<>(pq);
        result.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));
        return result;
    }
    
    private String normalizeError(String message) {
        // Replace UUIDs, timestamps, numeric IDs with placeholders
        return message
            .replaceAll("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<UUID>")
            .replaceAll("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}", "<TIMESTAMP>")
            .replaceAll("\\b\\d{5,}\\b", "<ID>");
    }
}
```

**Complexity:** Recording is O(1) amortized (HashMap insert). Retrieving top-K is O(n log k) where n is the number of distinct error types. For monitoring dashboards that refresh every 10 seconds, this is trivially fast even for millions of distinct error types.

### 14.5.3 Percentile Calculation: Sorted Array or T-Digest

"What is the P99 latency?" requires maintaining a distribution of values and querying arbitrary percentiles.

```java
public class PercentileTracker {
    
    // Simple approach: sorted insertion for small datasets
    private final List<Double> values = new ArrayList<>();
    private boolean sorted = false;
    
    public void addValue(double value) {
        values.add(value);
        sorted = false;
    }
    
    public double getPercentile(double percentile) {
        if (values.isEmpty()) throw new NoSuchElementException();
        if (!sorted) {
            Collections.sort(values);
            sorted = true;
        }
        
        int index = (int) Math.ceil(percentile / 100.0 * values.size()) - 1;
        index = Math.max(0, Math.min(index, values.size() - 1));
        return values.get(index);
    }
    
    public double getP50() { return getPercentile(50); }
    public double getP95() { return getPercentile(95); }
    public double getP99() { return getPercentile(99); }
}

/**
 * T-Digest: approximate percentile computation for streaming data.
 * Maintains a set of centroids (mean, count) that compress the distribution.
 * Accuracy is highest at the tails (P1, P99) where it matters most.
 */
class SimpleTDigest {
    
    static class Centroid implements Comparable<Centroid> {
        double mean;
        int count;
        
        Centroid(double mean, int count) {
            this.mean = mean;
            this.count = count;
        }
        
        @Override
        public int compareTo(Centroid other) {
            return Double.compare(this.mean, other.mean);
        }
        
        void merge(Centroid other) {
            int totalCount = this.count + other.count;
            this.mean = (this.mean * this.count + other.mean * other.count) / totalCount;
            this.count = totalCount;
        }
    }
    
    private final TreeMap<Double, Centroid> centroids = new TreeMap<>();
    private final int compression; // controls accuracy vs memory trade-off
    private int totalCount = 0;
    
    public SimpleTDigest(int compression) {
        this.compression = compression;
    }
    
    public void add(double value) {
        totalCount++;
        
        Map.Entry<Double, Centroid> closest = centroids.floorEntry(value);
        if (closest == null) closest = centroids.ceilingEntry(value);
        
        if (closest != null) {
            Centroid c = closest.getValue();
            double q = cumulativeCount(c.mean) / (double) totalCount;
            double maxSize = 4.0 * totalCount * q * (1 - q) / compression;
            
            if (c.count + 1 <= maxSize) {
                centroids.remove(c.mean);
                c.merge(new Centroid(value, 1));
                centroids.put(c.mean, c);
                return;
            }
        }
        
        // Create new centroid
        centroids.put(value, new Centroid(value, 1));
        
        if (centroids.size() > compression * 3) compress();
    }
    
    public double quantile(double q) {
        if (centroids.isEmpty()) throw new NoSuchElementException();
        
        double target = q * totalCount;
        double cumulative = 0;
        
        Centroid prev = null;
        for (Centroid c : centroids.values()) {
            if (cumulative + c.count >= target) {
                if (prev == null) return c.mean;
                double fraction = (target - cumulative) / c.count;
                return prev.mean + fraction * (c.mean - prev.mean);
            }
            cumulative += c.count;
            prev = c;
        }
        
        return centroids.lastEntry().getValue().mean;
    }
    
    private double cumulativeCount(double mean) {
        double count = 0;
        for (Centroid c : centroids.values()) {
            if (c.mean > mean) break;
            count += c.count;
        }
        return count;
    }
    
    private void compress() {
        List<Centroid> sorted = new ArrayList<>(centroids.values());
        centroids.clear();
        Collections.shuffle(sorted); // randomize merge order for better distribution
        for (Centroid c : sorted) {
            for (int i = 0; i < c.count; i++) add(c.mean);
        }
    }
}
```

**Production systems:** **Prometheus** uses histograms with fixed buckets. **HDRHistogram** (used in many Java performance tools) pre-allocates count arrays for the full range of expected values with configurable significant digits. The t-digest (used in **Elasticsearch**) provides the best accuracy at distribution tails (P99, P99.9) which is exactly where monitoring systems need it most.

### 14.5.4 Time-Windowed Metrics: Sliding Window of Bucketed Counters

"Show me the request count for the last 60 seconds, updated every second." Maintain a sliding window of per-second counters.

```java
public class SlidingWindowCounter {
    
    private final int windowSizeSeconds;
    private final AtomicLong[] buckets;
    private final AtomicLong globalCount = new AtomicLong(0);
    private volatile long currentSecond;
    
    public SlidingWindowCounter(int windowSizeSeconds) {
        this.windowSizeSeconds = windowSizeSeconds;
        this.buckets = new AtomicLong[windowSizeSeconds];
        for (int i = 0; i < windowSizeSeconds; i++) {
            buckets[i] = new AtomicLong(0);
        }
        this.currentSecond = System.currentTimeMillis() / 1000;
    }
    
    public void increment() {
        long now = System.currentTimeMillis() / 1000;
        advanceTo(now);
        int idx = (int) (now % windowSizeSeconds);
        buckets[idx].incrementAndGet();
        globalCount.incrementAndGet();
    }
    
    public long getWindowCount() {
        long now = System.currentTimeMillis() / 1000;
        advanceTo(now);
        long sum = 0;
        for (AtomicLong bucket : buckets) {
            sum += bucket.get();
        }
        return sum;
    }
    
    private void advanceTo(long targetSecond) {
        long current = currentSecond;
        if (targetSecond <= current) return;
        
        // Zero out buckets that have expired
        long secondsToAdvance = Math.min(targetSecond - current, windowSizeSeconds);
        for (long s = current + 1; s <= current + secondsToAdvance; s++) {
            int idx = (int) (s % windowSizeSeconds);
            buckets[idx].set(0);
        }
        currentSecond = targetSecond;
    }
    
    public double getRate() {
        return (double) getWindowCount() / windowSizeSeconds;
    }
}
```

**This is exactly how rate limiters work.** A sliding window rate limiter is this structure with a threshold check: if `getWindowCount() >= limit`, reject the request. The bucket array is a circular buffer of counters. It uses O(W) space where W is the window size in buckets, and O(1) for both increment and query (the full-window sum is O(W) but W is small -- 60 for a 60-second window).

### 14.5.5 Alert Deduplication: HashSet with TTL or Bloom Filter

When the same alert fires thousands of times per minute, you want to deduplicate: fire the alert once, suppress duplicates for a cooldown period. A `HashSet` with expiration achieves this.

```java
public class AlertDeduplicator {
    
    private final Map<String, Long> seenAlerts = new ConcurrentHashMap<>();
    private final long cooldownMillis;
    
    public AlertDeduplicator(long cooldownMillis) {
        this.cooldownMillis = cooldownMillis;
    }
    
    /**
     * Returns true if this alert should be fired (not a duplicate within cooldown).
     */
    public boolean shouldFire(String alertKey) {
        long now = System.currentTimeMillis();
        Long lastFired = seenAlerts.get(alertKey);
        
        if (lastFired != null && now - lastFired < cooldownMillis) {
            return false; // still in cooldown
        }
        
        // CAS to avoid race condition between check and put
        Long prev = seenAlerts.put(alertKey, now);
        if (prev != null && now - prev < cooldownMillis) {
            // Another thread beat us -- restore and suppress
            seenAlerts.put(alertKey, prev);
            return false;
        }
        
        return true;
    }
    
    // Periodic cleanup of expired entries to prevent memory leak
    public void cleanup() {
        long now = System.currentTimeMillis();
        seenAlerts.entrySet().removeIf(e -> now - e.getValue() >= cooldownMillis * 2);
    }
}
```

**Bloom filter alternative:** If memory is critical and false positives (suppressing a genuinely new alert) are acceptable at a low rate, use a time-bucketed Bloom filter. Maintain two Bloom filters: "current" and "previous" window. Check both before firing. Rotate periodically. This caps memory at the Bloom filter size regardless of the number of distinct alerts.

---

## 14.6 Compiler / Interpreter

Compilers are the most data-structure-dense programs that exist. Every phase -- lexing, parsing, semantic analysis, optimization, code generation -- relies on a different structure. Understanding compiler data structures is not just academic; it illuminates how the JVM itself works.

### 14.6.1 AST (Abstract Syntax Tree): Tree with Typed Nodes

The parser produces an AST: a tree where each node represents a language construct (expression, statement, declaration). This is the central data structure of every compiler.

```java
public abstract class ASTNode {
    // Base class for all AST nodes
    abstract <T> T accept(ASTVisitor<T> visitor);
}

// Expression nodes
class NumberLiteral extends ASTNode {
    final double value;
    NumberLiteral(double value) { this.value = value; }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitNumber(this); }
}

class BinaryExpr extends ASTNode {
    final ASTNode left, right;
    final String operator; // "+", "-", "*", "/"
    BinaryExpr(ASTNode left, String operator, ASTNode right) {
        this.left = left; this.operator = operator; this.right = right;
    }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitBinary(this); }
}

class UnaryExpr extends ASTNode {
    final String operator; // "-", "!"
    final ASTNode operand;
    UnaryExpr(String operator, ASTNode operand) {
        this.operator = operator; this.operand = operand;
    }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitUnary(this); }
}

class VariableRef extends ASTNode {
    final String name;
    VariableRef(String name) { this.name = name; }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitVariable(this); }
}

class Assignment extends ASTNode {
    final String name;
    final ASTNode value;
    Assignment(String name, ASTNode value) { this.name = name; this.value = value; }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitAssignment(this); }
}

class FunctionCall extends ASTNode {
    final String name;
    final List<ASTNode> arguments;
    FunctionCall(String name, List<ASTNode> arguments) {
        this.name = name; this.arguments = arguments;
    }
    <T> T accept(ASTVisitor<T> visitor) { return visitor.visitFunctionCall(this); }
}

// Visitor pattern: separate tree traversal from tree structure
interface ASTVisitor<T> {
    T visitNumber(NumberLiteral node);
    T visitBinary(BinaryExpr node);
    T visitUnary(UnaryExpr node);
    T visitVariable(VariableRef node);
    T visitAssignment(Assignment node);
    T visitFunctionCall(FunctionCall node);
}
```

**Why the Visitor pattern?** The AST node hierarchy is stable (you rarely add new node types after the language is designed). But you frequently add new operations: type checking, constant folding, code generation, pretty printing. The Visitor pattern lets you add operations without modifying node classes. This is the Open/Closed Principle applied to tree structures.

**JVM connection:** The JVM's own bytecode verifier walks a tree-like structure (the operand stack types form a lattice). The `javac` compiler builds an AST from Java source, then lowers it through multiple passes -- desugaring, type erasure, boxing/unboxing insertion -- each pass implemented as a tree visitor.

### 14.6.2 Symbol Table: HashMap with Scope Chain

During compilation, the symbol table maps identifiers to their declarations (type, scope, memory location). Scopes nest: an inner scope can shadow an outer scope's variable.

```java
public class SymbolTable {
    
    static class Symbol {
        final String name;
        final String type;
        final int scopeDepth;
        final boolean isMutable;
        
        Symbol(String name, String type, int scopeDepth, boolean isMutable) {
            this.name = name;
            this.type = type;
            this.scopeDepth = scopeDepth;
            this.isMutable = isMutable;
        }
    }
    
    // Stack of scopes: each scope is a HashMap<name, Symbol>
    private final Deque<Map<String, Symbol>> scopeStack = new ArrayDeque<>();
    private int currentDepth = 0;
    
    public SymbolTable() {
        enterScope(); // global scope
    }
    
    public void enterScope() {
        scopeStack.push(new HashMap<>());
        currentDepth++;
    }
    
    public void exitScope() {
        if (scopeStack.size() <= 1) throw new IllegalStateException("Cannot exit global scope");
        scopeStack.pop();
        currentDepth--;
    }
    
    public void define(String name, String type, boolean isMutable) {
        Map<String, Symbol> currentScope = scopeStack.peek();
        if (currentScope.containsKey(name)) {
            throw new IllegalStateException("Variable '" + name + "' already defined in current scope");
        }
        currentScope.put(name, new Symbol(name, type, currentDepth, isMutable));
    }
    
    // Resolve: search from innermost scope outward
    public Symbol resolve(String name) {
        for (Map<String, Symbol> scope : scopeStack) {
            Symbol symbol = scope.get(name);
            if (symbol != null) return symbol;
        }
        return null; // undefined
    }
    
    public boolean isDefinedInCurrentScope(String name) {
        return scopeStack.peek().containsKey(name);
    }
}
```

**Complexity:** `define` is O(1) -- single HashMap insert. `resolve` is O(D) where D is the scope depth -- walk outward through at most D HashMaps. In practice, D rarely exceeds 10-15 (global, class, method, a few nested blocks). This is why the stack-of-HashMaps approach beats a single flat HashMap with scope-prefixed keys.

**JVM connection:** The JVM does not use a symbol table at runtime -- names are resolved to constant pool indices at compile time. But the `javac` compiler's `com.sun.tools.javac.code.Scope` class is exactly this structure: a chain of scopes, each mapping names to symbols.

### 14.6.3 Expression Evaluation: Two Stacks (Operand + Operator)

Evaluate arithmetic expressions like `3 + 4 * 2 / (1 - 5)` respecting operator precedence and parentheses. The classic Dijkstra shunting-yard algorithm uses two stacks.

```java
public class ExpressionEvaluator {
    
    private static final Map<Character, Integer> PRECEDENCE = Map.of(
        '+', 1, '-', 1, '*', 2, '/', 2
    );
    
    public double evaluate(String expression) {
        Deque<Double> operands = new ArrayDeque<>();
        Deque<Character> operators = new ArrayDeque<>();
        
        int i = 0;
        while (i < expression.length()) {
            char c = expression.charAt(i);
            
            if (c == ' ') {
                i++;
                continue;
            }
            
            if (Character.isDigit(c) || c == '.') {
                // Parse number
                StringBuilder num = new StringBuilder();
                while (i < expression.length() && 
                       (Character.isDigit(expression.charAt(i)) || expression.charAt(i) == '.')) {
                    num.append(expression.charAt(i));
                    i++;
                }
                operands.push(Double.parseDouble(num.toString()));
                continue;
            }
            
            if (c == '(') {
                operators.push(c);
            } else if (c == ')') {
                // Process until matching '('
                while (operators.peek() != '(') {
                    applyOperator(operands, operators.pop());
                }
                operators.pop(); // remove '('
            } else if (PRECEDENCE.containsKey(c)) {
                // Process operators with >= precedence
                while (!operators.isEmpty() && operators.peek() != '(' 
                       && PRECEDENCE.getOrDefault(operators.peek(), 0) >= PRECEDENCE.get(c)) {
                    applyOperator(operands, operators.pop());
                }
                operators.push(c);
            }
            
            i++;
        }
        
        // Process remaining operators
        while (!operators.isEmpty()) {
            applyOperator(operands, operators.pop());
        }
        
        return operands.pop();
    }
    
    private void applyOperator(Deque<Double> operands, char op) {
        double b = operands.pop(), a = operands.pop();
        switch (op) {
            case '+' -> operands.push(a + b);
            case '-' -> operands.push(a - b);
            case '*' -> operands.push(a * b);
            case '/' -> {
                if (b == 0) throw new ArithmeticException("Division by zero");
                operands.push(a / b);
            }
        }
    }
}
```

**Why two stacks?** The operand stack holds values waiting to be combined. The operator stack holds operators waiting for their right operand. The precedence comparison ensures `3 + 4 * 2` evaluates `4 * 2` before adding 3 -- when we see `+` after `*`, the `*` has higher precedence so it gets applied immediately.

**JVM connection:** The JVM bytecode interpreter IS a stack machine. It uses an operand stack to evaluate expressions. `3 + 4 * 2` compiles to: `iconst_3, iconst_4, iconst_2, imul, iadd`. The JVM pushes operands, pops them for operations, and pushes results. The shunting-yard algorithm is essentially the compile step that converts infix to this postfix (stack-based) form.

### 14.6.4 Type Checking: Union-Find for Type Unification

In languages with type inference (like Java's `var`, or ML/Haskell), the compiler infers types by generating constraints and unifying them. Union-Find is the key data structure for type unification.

```java
public class TypeUnifier {
    
    static class TypeVar {
        final int id;
        TypeVar(int id) { this.id = id; }
    }
    
    static class ConcreteType {
        final String name; // "int", "String", "List<T>"
        final List<Object> typeArgs; // for parameterized types
        
        ConcreteType(String name, List<Object> typeArgs) {
            this.name = name;
            this.typeArgs = typeArgs;
        }
        
        ConcreteType(String name) {
            this(name, Collections.emptyList());
        }
    }
    
    private final Map<Integer, Object> parent = new HashMap<>(); // typeVarId -> parent (TypeVar or ConcreteType)
    private final Map<Integer, Integer> rank = new HashMap<>();
    
    public TypeVar freshTypeVar() {
        TypeVar tv = new TypeVar(parent.size());
        parent.put(tv.id, tv);
        rank.put(tv.id, 0);
        return tv;
    }
    
    public Object find(Object type) {
        if (type instanceof TypeVar tv) {
            Object p = parent.get(tv.id);
            if (p == tv) return tv; // root
            Object root = find(p);
            parent.put(tv.id, root); // path compression
            return root;
        }
        return type; // ConcreteType is always a root
    }
    
    public void unify(Object type1, Object type2) {
        Object root1 = find(type1);
        Object root2 = find(type2);
        
        if (root1.equals(root2)) return;
        
        if (root1 instanceof TypeVar tv1 && root2 instanceof TypeVar tv2) {
            // Union by rank
            int r1 = rank.get(tv1.id), r2 = rank.get(tv2.id);
            if (r1 < r2) parent.put(tv1.id, tv2);
            else if (r1 > r2) parent.put(tv2.id, tv1);
            else { parent.put(tv2.id, tv1); rank.merge(tv1.id, 1, Integer::sum); }
        } else if (root1 instanceof TypeVar tv1) {
            parent.put(tv1.id, root2); // bind type variable to concrete type
        } else if (root2 instanceof TypeVar tv2) {
            parent.put(tv2.id, root1);
        } else {
            // Both concrete: must be the same type constructor
            ConcreteType c1 = (ConcreteType) root1, c2 = (ConcreteType) root2;
            if (!c1.name.equals(c2.name) || c1.typeArgs.size() != c2.typeArgs.size()) {
                throw new RuntimeException("Type mismatch: " + c1.name + " vs " + c2.name);
            }
            for (int i = 0; i < c1.typeArgs.size(); i++) {
                unify(c1.typeArgs.get(i), c2.typeArgs.get(i));
            }
        }
    }
    
    public String resolve(Object type) {
        Object root = find(type);
        if (root instanceof ConcreteType ct) return ct.name;
        return "?" + ((TypeVar) root).id; // unresolved type variable
    }
}
```

**Why Union-Find?** Type inference generates constraints like "the type of `x` equals the type of `y + 1`", "the return type of `f(x)` equals `int`". These are equality constraints. Union-Find merges type variables into equivalence classes. When a class is unified with a concrete type, all variables in that class are resolved. The amortized O(alpha(n)) per operation makes this efficient even for programs with thousands of type constraints.

### 14.6.5 Register Allocation: Graph Coloring

The compiler must assign variables to CPU registers. Two variables that are "live" at the same time cannot share a register -- they "interfere." Build an interference graph (nodes = variables, edges = interference), then color the graph with K colors (K = number of registers). If a node cannot be colored, it must be "spilled" to memory.

```java
public class RegisterAllocator {
    
    static class InterferenceGraph {
        final int numVars;
        final Set<Integer>[] neighbors;
        
        @SuppressWarnings("unchecked")
        InterferenceGraph(int numVars) {
            this.numVars = numVars;
            this.neighbors = new HashSet[numVars];
            for (int i = 0; i < numVars; i++) neighbors[i] = new HashSet<>();
        }
        
        void addEdge(int u, int v) {
            if (u != v) {
                neighbors[u].add(v);
                neighbors[v].add(u);
            }
        }
        
        int degree(int v) { return neighbors[v].size(); }
    }
    
    /**
     * Chaitin's algorithm for graph coloring register allocation.
     * K = number of available registers.
     * Returns: variable -> register (0 to K-1), or -1 if spilled.
     */
    public int[] allocate(InterferenceGraph graph, int K) {
        int n = graph.numVars;
        int[] color = new int[n];
        Arrays.fill(color, -1);
        boolean[] removed = new boolean[n];
        
        // Simplification: iteratively remove nodes with degree < K
        Deque<Integer> stack = new ArrayDeque<>();
        int[] currentDegree = new int[n];
        for (int i = 0; i < n; i++) currentDegree[i] = graph.degree(i);
        
        for (int round = 0; round < n; round++) {
            int toRemove = -1;
            
            // Find a node with degree < K (guaranteed colorable)
            for (int i = 0; i < n; i++) {
                if (!removed[i] && currentDegree[i] < K) {
                    toRemove = i;
                    break;
                }
            }
            
            if (toRemove == -1) {
                // No node with degree < K: must spill one
                // Heuristic: spill the node with highest degree
                int maxDeg = -1;
                for (int i = 0; i < n; i++) {
                    if (!removed[i] && currentDegree[i] > maxDeg) {
                        maxDeg = currentDegree[i];
                        toRemove = i;
                    }
                }
            }
            
            if (toRemove == -1) break;
            
            stack.push(toRemove);
            removed[toRemove] = true;
            for (int neighbor : graph.neighbors[toRemove]) {
                if (!removed[neighbor]) currentDegree[neighbor]--;
            }
        }
        
        // Selection: pop nodes and assign colors
        while (!stack.isEmpty()) {
            int v = stack.pop();
            Set<Integer> usedColors = new HashSet<>();
            for (int neighbor : graph.neighbors[v]) {
                if (color[neighbor] >= 0) usedColors.add(color[neighbor]);
            }
            
            for (int c = 0; c < K; c++) {
                if (!usedColors.contains(c)) {
                    color[v] = c;
                    break;
                }
            }
            // If color[v] is still -1, this variable is spilled to memory
        }
        
        return color;
    }
}
```

**JVM connection:** HotSpot's C2 (server) JIT compiler uses a linear scan register allocator (not graph coloring) for speed. Graph coloring produces better allocation but is NP-hard in general. Linear scan runs in O(n) and produces near-optimal results for most programs. The C1 (client) compiler uses an even simpler allocator. GraalVM uses a more sophisticated variant of linear scan with backtracking.

---

## 14.7 Cross-Domain Patterns

Several data structure patterns appear across multiple domains. Recognizing these cross-cutting patterns accelerates your design intuition.

### 14.7.1 The Top-K Pattern

**Appears in:** trending topics (social), top errors (logging), best products (e-commerce), leaderboard (gaming), highest risk positions (finance).

**Structure:** Min-heap of size K. For each element, if the heap is not full or the element exceeds the heap minimum, insert and potentially evict the minimum.

```
Time:  O(n log k) for n elements
Space: O(k)
```

### 14.7.2 The Sliding Window Pattern

**Appears in:** moving average (finance), rate limiting (logging), time-windowed metrics (monitoring), recent activity feed (social).

**Structure:** `ArrayDeque` or circular array of fixed size. New elements enter one end, old elements exit the other.

```
Time:  O(1) per element
Space: O(w) where w = window size
```

### 14.7.3 The Producer-Consumer Pattern

**Appears in:** order processing (e-commerce), market data ingestion (finance), log ingestion (logging), event processing (gaming).

**Structure:** `BlockingQueue` (bounded: `ArrayBlockingQueue`, unbounded: `LinkedBlockingQueue`) or lock-free ring buffer (LMAX Disruptor).

### 14.7.4 The Write-Ahead Log Pattern

**Appears in:** transaction ledger (finance), event sourcing (e-commerce), database WAL (storage), game save/replay.

**Structure:** Append-only list with sequential IDs. Optionally hash-chained for tamper detection. Recovery: replay the log from the last checkpoint.

---

## 14.8 Problems

### E-Commerce Domain

**P14.01** [E] -- Design a Shopping Cart (HashMap Operations)

Implement a `ShoppingCart` supporting `addItem(productId, quantity)`, `removeItem(productId)`, `getTotal()`, and `getItemCount()`. Handle edge cases: adding an existing item increases quantity, removing a non-existent item is a no-op.

```java
public class ShoppingCartSimple {
    
    static class Item {
        String productId;
        String name;
        double price;
        int quantity;
        
        Item(String productId, String name, double price, int quantity) {
            this.productId = productId;
            this.name = name;
            this.price = price;
            this.quantity = quantity;
        }
    }
    
    private final Map<String, Item> cart = new LinkedHashMap<>();
    
    public void addItem(String productId, String name, double price, int quantity) {
        cart.merge(productId, new Item(productId, name, price, quantity),
            (old, incoming) -> { old.quantity += incoming.quantity; return old; });
    }
    
    public boolean removeItem(String productId) {
        return cart.remove(productId) != null;
    }
    
    public double getTotal() {
        return cart.values().stream().mapToDouble(i -> i.price * i.quantity).sum();
    }
    
    public int getItemCount() {
        return cart.values().stream().mapToInt(i -> i.quantity).sum();
    }
}
```

```
Time:  O(1) for add/remove, O(n) for getTotal/getItemCount where n = distinct items
Space: O(n) for n distinct items
JVM note: LinkedHashMap preserves insertion order for consistent rendering.
Real-world: Amazon's cart service uses a key-value store with userId as partition key.
```

---

**P14.02** [E] -- Search Autocomplete System (LeetCode 642 variant)

Given a list of products and a search prefix, return the top 3 products lexicographically that match the prefix. For each character typed, return the current matches.

```java
public List<List<String>> suggestedProducts(String[] products, String searchWord) {
    Arrays.sort(products); // sort once for lexicographic order
    List<List<String>> result = new ArrayList<>();
    String prefix = "";
    
    int left = 0, right = products.length - 1;
    for (char c : searchWord.toCharArray()) {
        prefix += c;
        // Binary search for leftmost product >= prefix
        while (left <= right && (products[left].length() < prefix.length() 
               || !products[left].substring(0, prefix.length()).equals(prefix))) {
            left++;
        }
        // Binary search for rightmost product starting with prefix
        while (left <= right && (products[right].length() < prefix.length() 
               || !products[right].substring(0, prefix.length()).equals(prefix))) {
            right--;
        }
        
        List<String> suggestions = new ArrayList<>();
        for (int i = left; i <= Math.min(left + 2, right); i++) {
            suggestions.add(products[i]);
        }
        result.add(suggestions);
    }
    return result;
}
```

```
Time:  O(n log n) for initial sort, O(m * n) worst case for search where m = searchWord length
Space: O(1) extra (excluding result)
JVM note: String.substring() in JDK 7+ creates a new String (no shared backing array).
Real-world: Elasticsearch's completion suggester uses FST for O(prefix_length) lookup.
```

---

**P14.03** [M] -- Design Search Typeahead with Trie

Implement a typeahead system that stores sentences with their frequencies. `input(char c)` adds a character to the current search and returns the top 3 sentences by frequency. '#' marks end of sentence.

```java
public class SearchTypeahead {
    
    static class TrieNode {
        Map<Character, TrieNode> children = new HashMap<>();
        Map<String, Integer> sentenceCounts = new HashMap<>(); // all sentences passing through this prefix
    }
    
    private final TrieNode root = new TrieNode();
    private TrieNode currentNode;
    private StringBuilder currentInput = new StringBuilder();
    
    public SearchTypeahead(String[] sentences, int[] times) {
        for (int i = 0; i < sentences.length; i++) {
            insertSentence(sentences[i], times[i]);
        }
        currentNode = root;
    }
    
    private void insertSentence(String sentence, int count) {
        TrieNode node = root;
        for (char c : sentence.toCharArray()) {
            node.children.putIfAbsent(c, new TrieNode());
            node = node.children.get(c);
            node.sentenceCounts.merge(sentence, count, Integer::sum);
        }
    }
    
    public List<String> input(char c) {
        if (c == '#') {
            String sentence = currentInput.toString();
            insertSentence(sentence, 1);
            currentInput = new StringBuilder();
            currentNode = root;
            return Collections.emptyList();
        }
        
        currentInput.append(c);
        if (currentNode != null) {
            currentNode = currentNode.children.get(c);
        }
        
        if (currentNode == null) return Collections.emptyList();
        
        // Get top 3 by frequency, then lexicographic order
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            (a, b) -> a.getValue().equals(b.getValue()) 
                ? b.getKey().compareTo(a.getKey())
                : Integer.compare(a.getValue(), b.getValue())
        );
        
        for (var entry : currentNode.sentenceCounts.entrySet()) {
            pq.offer(entry);
            if (pq.size() > 3) pq.poll();
        }
        
        List<String> result = new ArrayList<>();
        while (!pq.isEmpty()) result.add(pq.poll().getKey());
        Collections.reverse(result);
        return result;
    }
}
```

```
Time:  input: O(s * k log k) where s = avg sentence length, k = matching sentences
Space: O(n * L) where n = number of sentences, L = average length
JVM note: Storing full sentence counts at each trie node trades space for time.
  For 100K sentences of avg length 20, that is 2M HashMap entries across all nodes.
Real-world: Google's autocomplete pre-computes suggestions per prefix offline.
```

---

**P14.04** [M] -- Shopping Cart with Concurrent Access

Design a thread-safe shopping cart supporting concurrent add/remove/getTotal from multiple threads (e.g., user has multiple browser tabs).

```java
public class ConcurrentShoppingCart {
    
    static class CartItem {
        final String productId;
        final double price;
        volatile int quantity;
        
        CartItem(String productId, double price, int quantity) {
            this.productId = productId;
            this.price = price;
            this.quantity = quantity;
        }
    }
    
    private final ConcurrentHashMap<String, CartItem> cart = new ConcurrentHashMap<>();
    
    public void addItem(String productId, double price, int quantity) {
        cart.compute(productId, (k, existing) -> {
            if (existing == null) return new CartItem(productId, price, quantity);
            existing.quantity += quantity;
            return existing;
        });
    }
    
    public boolean removeItem(String productId) {
        return cart.remove(productId) != null;
    }
    
    public void updateQuantity(String productId, int newQuantity) {
        if (newQuantity <= 0) {
            cart.remove(productId);
        } else {
            cart.computeIfPresent(productId, (k, item) -> {
                item.quantity = newQuantity;
                return item;
            });
        }
    }
    
    public double getTotal() {
        return cart.values().stream()
            .mapToDouble(item -> item.price * item.quantity)
            .sum();
    }
    
    public Map<String, Integer> getSnapshot() {
        Map<String, Integer> snapshot = new LinkedHashMap<>();
        cart.forEach((id, item) -> snapshot.put(id, item.quantity));
        return snapshot;
    }
}
```

```
Time:  O(1) for add/remove/update, O(n) for getTotal
Space: O(n)
JVM note: ConcurrentHashMap.compute() locks only the bin containing the key.
  getTotal() iterates without global lock -- it may see a partially updated cart
  (one item added, another not yet). For strict consistency, wrap in ReadWriteLock.
Real-world: Session-based carts typically use single-writer (one session = one user),
  making ConcurrentHashMap overkill. It matters for shared carts or server-side aggregation.
```

---

**P14.05** [M] -- Implement Collaborative Filtering Recommendations

Given purchase history as `(userId, productId)` pairs, implement `recommend(userId, k)` that returns the top K products the user has not purchased but similar users have.

```java
public List<String> recommend(Map<String, Set<String>> userPurchases, 
                               String targetUser, int k) {
    Set<String> targetProducts = userPurchases.getOrDefault(targetUser, Collections.emptySet());
    if (targetProducts.isEmpty()) return Collections.emptyList();
    
    // Find similar users (Jaccard similarity)
    Map<String, Double> userSimilarity = new HashMap<>();
    for (var entry : userPurchases.entrySet()) {
        if (entry.getKey().equals(targetUser)) continue;
        Set<String> otherProducts = entry.getValue();
        
        // Jaccard = |intersection| / |union|
        Set<String> intersection = new HashSet<>(targetProducts);
        intersection.retainAll(otherProducts);
        if (intersection.isEmpty()) continue;
        
        Set<String> union = new HashSet<>(targetProducts);
        union.addAll(otherProducts);
        
        double similarity = (double) intersection.size() / union.size();
        userSimilarity.put(entry.getKey(), similarity);
    }
    
    // Weight product recommendations by user similarity
    Map<String, Double> productScores = new HashMap<>();
    for (var entry : userSimilarity.entrySet()) {
        double sim = entry.getValue();
        for (String product : userPurchases.get(entry.getKey())) {
            if (!targetProducts.contains(product)) {
                productScores.merge(product, sim, Double::sum);
            }
        }
    }
    
    // Top-K by weighted score
    return productScores.entrySet().stream()
        .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
        .limit(k)
        .map(Map.Entry::getKey)
        .collect(Collectors.toList());
}
```

```
Time:  O(U * P) where U = users, P = avg products per user
Space: O(U + P) for similarity and score maps
JVM note: Stream-based top-K creates intermediate objects. For hot paths, use a PriorityQueue.
Real-world: Netflix Prize-winning algorithm (SVD++) pre-computes a user-item matrix factorization.
```

---

**P14.06** [H] -- Design Flash Sale System with Distributed Counter

Implement a flash sale that handles: (1) global stock limit, (2) per-user purchase limit, (3) concurrent access from multiple threads, (4) rollback on payment failure.

```java
public class FlashSaleSystem {
    
    enum Result { SUCCESS, OUT_OF_STOCK, USER_LIMIT, PAYMENT_FAILED }
    
    private final AtomicInteger globalStock;
    private final int perUserLimit;
    private final ConcurrentHashMap<String, AtomicInteger> userCounts = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, List<String>> userOrders = new ConcurrentHashMap<>();
    
    public FlashSaleSystem(int totalStock, int perUserLimit) {
        this.globalStock = new AtomicInteger(totalStock);
        this.perUserLimit = perUserLimit;
    }
    
    public Result purchase(String userId, PaymentService paymentService) {
        // Phase 1: Check and reserve stock (optimistic)
        AtomicInteger userCount = userCounts.computeIfAbsent(userId, k -> new AtomicInteger(0));
        
        // Increment user count first (lightweight check)
        int newUserCount = userCount.incrementAndGet();
        if (newUserCount > perUserLimit) {
            userCount.decrementAndGet();
            return Result.USER_LIMIT;
        }
        
        // Decrement global stock
        while (true) {
            int current = globalStock.get();
            if (current <= 0) {
                userCount.decrementAndGet(); // rollback user count
                return Result.OUT_OF_STOCK;
            }
            if (globalStock.compareAndSet(current, current - 1)) break;
        }
        
        // Phase 2: Process payment
        String orderId = UUID.randomUUID().toString();
        try {
            boolean paymentOk = paymentService.charge(userId, orderId);
            if (!paymentOk) {
                // Rollback both counters
                globalStock.incrementAndGet();
                userCount.decrementAndGet();
                return Result.PAYMENT_FAILED;
            }
        } catch (Exception e) {
            globalStock.incrementAndGet();
            userCount.decrementAndGet();
            return Result.PAYMENT_FAILED;
        }
        
        // Phase 3: Record order
        userOrders.computeIfAbsent(userId, k -> new CopyOnWriteArrayList<>()).add(orderId);
        return Result.SUCCESS;
    }
    
    interface PaymentService {
        boolean charge(String userId, String orderId);
    }
}
```

```
Time:  O(1) for stock check and decrement (CAS may retry under contention)
Space: O(U) where U = number of participating users
JVM note: CAS contention on globalStock under 10K concurrent threads will cause
  spinning. In practice, most requests fail the stock check quickly (stock depletes fast).
  For extreme throughput, shard the stock across multiple AtomicIntegers.
Real-world: Alibaba's flash sale system pre-shards inventory across multiple Redis keys,
  each handling a fraction of the total stock. This eliminates the single-counter bottleneck.
```

---

**P14.07** [E] -- Price Range Filter

Given a list of products with prices, implement `getProductsInRange(min, max)` that returns products sorted by price. Optimize for repeated queries on different ranges.

```java
public class PriceRangeFilter {
    
    private final TreeMap<Double, List<String>> priceMap = new TreeMap<>();
    
    public void addProduct(String productName, double price) {
        priceMap.computeIfAbsent(price, k -> new ArrayList<>()).add(productName);
    }
    
    public List<String> getProductsInRange(double minPrice, double maxPrice) {
        List<String> result = new ArrayList<>();
        for (var entry : priceMap.subMap(minPrice, true, maxPrice, true).entrySet()) {
            result.addAll(entry.getValue());
        }
        return result;
    }
}
```

```
Time:  O(log n + k) where k = number of products in range
Space: O(n) for all products
JVM note: TreeMap.subMap returns a view, not a copy -- iteration is lazy.
Real-world: This is the in-memory equivalent of a B+ Tree range scan.
```

---

### Financial Systems Domain

**P14.08** [H] -- Design an Order Book

Implement a limit order book supporting `submitOrder(side, price, quantity)`, `cancelOrder(orderId)`, `getBestBid()`, `getBestAsk()`, `getSpread()`. Match incoming orders against the opposite side using price-time priority.

```java
// Full implementation provided in Section 14.2.1 above (OrderBook class).
// Key insight: TreeMap<Price, Queue<Order>> for each side,
// with HashMap<orderId, Order> for O(1) cancel lookup.
```

```
Time:  Submit: O(log P + M) where P = price levels, M = matched orders
       Cancel: O(1) lookup + O(Q) removal from queue at price level
Space: O(N) for N live orders
JVM note: For HFT, replace TreeMap with array-indexed price levels (O(1) access)
  and eliminate all object allocation on the hot path.
Real-world: NASDAQ's INET matching engine processes 1M+ orders/second.
```

---

**P14.09** [M] -- Stock Price Ticker with Moving Average (LeetCode 346 variant)

Design a data stream class that supports `next(price)` returning the moving average of the last `size` prices.

```java
public class MovingAverageStream {
    private final int size;
    private final double[] window;
    private int head = 0, count = 0;
    private double sum = 0;
    
    public MovingAverageStream(int size) {
        this.size = size;
        this.window = new double[size];
    }
    
    public double next(double val) {
        if (count == size) {
            sum -= window[head]; // subtract outgoing
        } else {
            count++;
        }
        window[head] = val;
        sum += val;
        head = (head + 1) % size;
        return sum / count;
    }
}
```

```
Time:  O(1) per call
Space: O(w) where w = window size
JVM note: Using double[] instead of ArrayDeque<Double> avoids autoboxing.
  Each Double object = 24 bytes; each double primitive = 8 bytes. For size=200, saves 3.2 KB.
Real-world: Bloomberg Terminal's moving average uses this exact pattern.
```

---

**P14.10** [M] -- Design Hit Counter (LeetCode 362)

Design a hit counter that records hits and returns the number of hits in the past 5 minutes (300 seconds). Multiple hits can arrive at the same timestamp.

```java
public class HitCounter {
    private final int[] times;
    private final int[] hits;
    
    public HitCounter() {
        times = new int[300];
        hits = new int[300];
    }
    
    public void hit(int timestamp) {
        int idx = timestamp % 300;
        if (times[idx] != timestamp) {
            times[idx] = timestamp;
            hits[idx] = 1;
        } else {
            hits[idx]++;
        }
    }
    
    public int getHits(int timestamp) {
        int total = 0;
        for (int i = 0; i < 300; i++) {
            if (timestamp - times[i] < 300) {
                total += hits[i];
            }
        }
        return total;
    }
}
```

```
Time:  hit: O(1), getHits: O(300) = O(1)
Space: O(300) = O(1)
JVM note: Two int[300] arrays = 2400 bytes. Fixed, predictable, GC-friendly.
Real-world: This circular bucketing pattern is how Prometheus histograms work internally.
```

---

**P14.11** [M] -- Design Event Sourcing System

Implement an event-sourced aggregate (e.g., bank account) where state is derived by replaying events. Support `deposit`, `withdraw`, `getBalance`, and `getEventHistory`.

```java
public class EventSourcedAccount {
    
    interface Event {
        long timestamp();
        String type();
    }
    
    record DepositEvent(long timestamp, double amount) implements Event {
        public String type() { return "DEPOSIT"; }
    }
    
    record WithdrawEvent(long timestamp, double amount) implements Event {
        public String type() { return "WITHDRAW"; }
    }
    
    private final List<Event> eventLog = new ArrayList<>(); // append-only
    private double cachedBalance = 0; // materialized view
    
    public void deposit(double amount) {
        DepositEvent event = new DepositEvent(System.currentTimeMillis(), amount);
        eventLog.add(event);
        cachedBalance += amount;
    }
    
    public boolean withdraw(double amount) {
        if (cachedBalance < amount) return false;
        WithdrawEvent event = new WithdrawEvent(System.currentTimeMillis(), amount);
        eventLog.add(event);
        cachedBalance -= amount;
        return true;
    }
    
    public double getBalance() { return cachedBalance; }
    
    // Rebuild state from scratch (for verification or after loading from storage)
    public double replayBalance() {
        double balance = 0;
        for (Event event : eventLog) {
            if (event instanceof DepositEvent d) balance += d.amount();
            else if (event instanceof WithdrawEvent w) balance -= w.amount();
        }
        return balance;
    }
    
    public List<Event> getEventHistory() {
        return Collections.unmodifiableList(eventLog);
    }
}
```

```
Time:  deposit/withdraw: O(1), replayBalance: O(n) for n events
Space: O(n) for event log (grows unbounded; snapshot/compact in production)
JVM note: Using Java records for events gives compact, immutable value objects.
Real-world: Apache Kafka + event sourcing is the backbone of modern CQRS systems.
  The event log IS the source of truth; all views are derived projections.
```

---

**P14.12** [H] -- Time-Series Range Aggregation with Segment Tree

Given a time series of stock prices, support `update(index, newPrice)` and `rangeMax(l, r)` / `rangeSum(l, r)` in O(log n).

```java
public class TimeSeriesAggregator {
    private final int n;
    private final double[] sumTree, maxTree;
    
    public TimeSeriesAggregator(double[] prices) {
        this.n = prices.length;
        this.sumTree = new double[4 * n];
        this.maxTree = new double[4 * n];
        build(prices, 1, 0, n - 1);
    }
    
    private void build(double[] arr, int node, int start, int end) {
        if (start == end) {
            sumTree[node] = arr[start];
            maxTree[node] = arr[start];
        } else {
            int mid = (start + end) / 2;
            build(arr, 2 * node, start, mid);
            build(arr, 2 * node + 1, mid + 1, end);
            sumTree[node] = sumTree[2 * node] + sumTree[2 * node + 1];
            maxTree[node] = Math.max(maxTree[2 * node], maxTree[2 * node + 1]);
        }
    }
    
    public void update(int idx, double val) {
        update(1, 0, n - 1, idx, val);
    }
    
    private void update(int node, int start, int end, int idx, double val) {
        if (start == end) {
            sumTree[node] = val;
            maxTree[node] = val;
        } else {
            int mid = (start + end) / 2;
            if (idx <= mid) update(2 * node, start, mid, idx, val);
            else update(2 * node + 1, mid + 1, end, idx, val);
            sumTree[node] = sumTree[2 * node] + sumTree[2 * node + 1];
            maxTree[node] = Math.max(maxTree[2 * node], maxTree[2 * node + 1]);
        }
    }
    
    public double rangeSum(int l, int r) { return querySum(1, 0, n - 1, l, r); }
    public double rangeMax(int l, int r) { return queryMax(1, 0, n - 1, l, r); }
    
    private double querySum(int node, int start, int end, int l, int r) {
        if (r < start || end < l) return 0;
        if (l <= start && end <= r) return sumTree[node];
        int mid = (start + end) / 2;
        return querySum(2 * node, start, mid, l, r) + querySum(2 * node + 1, mid + 1, end, l, r);
    }
    
    private double queryMax(int node, int start, int end, int l, int r) {
        if (r < start || end < l) return Double.NEGATIVE_INFINITY;
        if (l <= start && end <= r) return maxTree[node];
        int mid = (start + end) / 2;
        return Math.max(queryMax(2 * node, start, mid, l, r), 
                       queryMax(2 * node + 1, mid + 1, end, l, r));
    }
}
```

```
Time:  build: O(n), update: O(log n), query: O(log n)
Space: O(n) for segment tree arrays
JVM note: Flat arrays (sumTree[], maxTree[]) have perfect cache locality.
  Compared to node-based trees, this avoids pointer chasing entirely.
Real-world: Time-series databases like InfluxDB use similar tree structures for aggregation.
```

---

### Social Networks Domain

**P14.13** [M] -- Design News Feed System

Implement a news feed with `postTweet(userId, tweetId)`, `follow(followerId, followeeId)`, `unfollow`, and `getNewsFeed(userId)` returning the 10 most recent tweets from followed users.

```java
public class TwitterNewsFeed {
    
    private static int timestamp = 0;
    
    private final Map<Integer, List<int[]>> userTweets = new HashMap<>(); // userId -> [(timestamp, tweetId)]
    private final Map<Integer, Set<Integer>> following = new HashMap<>();
    
    public void postTweet(int userId, int tweetId) {
        userTweets.computeIfAbsent(userId, k -> new ArrayList<>())
                  .add(new int[]{timestamp++, tweetId});
    }
    
    public List<Integer> getNewsFeed(int userId) {
        PriorityQueue<int[]> pq = new PriorityQueue<>(
            (a, b) -> Integer.compare(b[0], a[0]) // newest first
        );
        
        // Include own tweets
        Set<Integer> sources = new HashSet<>(following.getOrDefault(userId, Collections.emptySet()));
        sources.add(userId);
        
        // Add most recent tweet from each source
        for (int source : sources) {
            List<int[]> tweets = userTweets.get(source);
            if (tweets != null && !tweets.isEmpty()) {
                int lastIdx = tweets.size() - 1;
                int[] tweet = tweets.get(lastIdx);
                pq.offer(new int[]{tweet[0], tweet[1], source, lastIdx});
            }
        }
        
        List<Integer> feed = new ArrayList<>();
        while (!pq.isEmpty() && feed.size() < 10) {
            int[] entry = pq.poll();
            feed.add(entry[1]); // tweetId
            
            int sourceId = entry[2], idx = entry[3];
            if (idx > 0) {
                List<int[]> tweets = userTweets.get(sourceId);
                int[] prev = tweets.get(idx - 1);
                pq.offer(new int[]{prev[0], prev[1], sourceId, idx - 1});
            }
        }
        return feed;
    }
    
    public void follow(int followerId, int followeeId) {
        if (followerId != followeeId) {
            following.computeIfAbsent(followerId, k -> new HashSet<>()).add(followeeId);
        }
    }
    
    public void unfollow(int followerId, int followeeId) {
        Set<Integer> set = following.get(followerId);
        if (set != null) set.remove(followeeId);
    }
}
```

```
Time:  postTweet: O(1), getNewsFeed: O(K log K) where K = followed users, follow/unfollow: O(1)
Space: O(T + F) where T = total tweets, F = total follow relationships
JVM note: Merge K sorted lists via PriorityQueue is the canonical approach.
Real-world: Twitter uses fan-out-on-write for most users, pull-on-read for celebrities.
```

---

**P14.14** [M] -- Social Network Friend Recommendations

Given a social graph, recommend friends for a user based on mutual friend count (people you may know).

```java
public List<int[]> recommendFriends(Map<Integer, Set<Integer>> graph, int userId) {
    Set<Integer> myFriends = graph.getOrDefault(userId, Collections.emptySet());
    Map<Integer, Integer> mutualCount = new HashMap<>();
    
    for (int friend : myFriends) {
        for (int friendOfFriend : graph.getOrDefault(friend, Collections.emptySet())) {
            if (friendOfFriend != userId && !myFriends.contains(friendOfFriend)) {
                mutualCount.merge(friendOfFriend, 1, Integer::sum);
            }
        }
    }
    
    // Sort by mutual count descending
    return mutualCount.entrySet().stream()
        .sorted(Map.Entry.<Integer, Integer>comparingByValue().reversed())
        .limit(10)
        .map(e -> new int[]{e.getKey(), e.getValue()})
        .collect(Collectors.toList());
}
```

```
Time:  O(F * F') where F = user's friends, F' = avg friends per friend
Space: O(N) for mutual count map
JVM note: The two-hop BFS is bounded by the social graph's branching factor.
Real-world: LinkedIn's "People You May Know" uses this plus profile similarity signals.
```

---

**P14.15** [E] -- Mutual Friends Count

Given two users, return the count and list of their mutual friends.

```java
public int[] mutualFriends(Map<Integer, Set<Integer>> graph, int user1, int user2) {
    Set<Integer> friends1 = graph.getOrDefault(user1, Collections.emptySet());
    Set<Integer> friends2 = graph.getOrDefault(user2, Collections.emptySet());
    
    // Iterate smaller set, check membership in larger set
    Set<Integer> smaller = friends1.size() <= friends2.size() ? friends1 : friends2;
    Set<Integer> larger = friends1.size() > friends2.size() ? friends1 : friends2;
    
    int count = 0;
    for (int friend : smaller) {
        if (larger.contains(friend)) count++;
    }
    return new int[]{count};
}
```

```
Time:  O(min(|F1|, |F2|)) with HashSet contains
Space: O(1) extra
JVM note: HashSet.contains is O(1) amortized -- single hash computation + bucket lookup.
Real-world: Facebook computes mutual friends lazily and caches the result.
```

---

**P14.16** [M] -- Degrees of Separation (Bidirectional BFS)

Find the shortest path length between two users in a social graph. Use bidirectional BFS for efficiency.

```java
// Full implementation provided in Section 14.3.4 above (DegreesOfSeparation class).
```

```
Time:  O(b^(d/2)) where b = branching factor, d = degrees of separation
Space: O(b^(d/2)) for visited sets
JVM note: HashMap<Long, Integer> for visited stores boxed Longs. For massive graphs,
  use a primitive long-to-int map (Eclipse Collections LongIntHashMap) to save 50% memory.
Real-world: LinkedIn computes this for its "1st/2nd/3rd connection" badges.
```

---

**P14.17** [H] -- Design Trending Hashtags with Count-Min Sketch

Implement a trending system that processes a stream of hashtags and returns the top K trending hashtags at any time. Memory must be bounded regardless of the number of distinct hashtags.

```java
// Full implementation provided in Section 14.3.5 above (TrendingTopics class).
// Key: Count-Min Sketch for bounded-memory frequency estimation,
// PriorityQueue for top-K maintenance.
```

```
Time:  recordHashtag: O(d) where d = sketch depth (hash functions), getTopK: O(k log k)
Space: O(w * d + k) where w = sketch width, d = depth, k = top-K size
JVM note: The sketch's int[][] array has excellent cache locality for column access.
Real-world: Twitter's trending topics pipeline uses a similar sketch-based approach.
```

---

### Gaming Domain

**P14.18** [H] -- Implement A* Pathfinding

Find the shortest path on a weighted grid from start to goal, avoiding obstacles. Implement A* with octile distance heuristic.

```java
// Full implementation provided in Section 14.4.2 above (AStarPathfinder class).
```

```
Time:  O(E log V) where E = edges explored, V = vertices in open set. With good heuristic, E << total edges.
Space: O(V) for open/closed sets and gCost array
JVM note: PriorityQueue is a binary heap. For A* on large grids,
  a bucket queue (array indexed by integer f-cost) gives O(1) insert/extract-min.
Real-world: Most commercial game engines (Unity, Unreal) implement A* variants (JPS, HPA*).
```

---

**P14.19** [H] -- Implement Quadtree for Spatial Queries

Build a quadtree supporting insert, range query, and nearest-neighbor search for 2D points.

```java
// Core quadtree provided in Section 14.4.1 above (Quadtree class).
// Extension: nearest neighbor search
public class QuadtreeNN extends Quadtree {
    
    public QuadtreeNN(AABB boundary, int depth) {
        super(boundary, depth);
    }
    
    public Entity nearestNeighbor(double qx, double qy) {
        double[] bestDist = {Double.MAX_VALUE};
        Entity[] bestEntity = {null};
        nearestHelper(qx, qy, bestDist, bestEntity);
        return bestEntity[0];
    }
    
    private void nearestHelper(double qx, double qy, double[] bestDist, Entity[] best) {
        for (Entity e : entities) {
            double dist = Math.hypot(e.x - qx, e.y - qy);
            if (dist < bestDist[0]) {
                bestDist[0] = dist;
                best[0] = e;
            }
        }
        
        if (children != null) {
            // Sort children by distance to query point (prune far quadrants)
            Integer[] order = {0, 1, 2, 3};
            Arrays.sort(order, (a, b) -> {
                double dA = distToQuadrant(children[a].boundary, qx, qy);
                double dB = distToQuadrant(children[b].boundary, qx, qy);
                return Double.compare(dA, dB);
            });
            for (int idx : order) {
                if (distToQuadrant(children[idx].boundary, qx, qy) < bestDist[0]) {
                    ((QuadtreeNN) children[idx]).nearestHelper(qx, qy, bestDist, best);
                }
            }
        }
    }
    
    private double distToQuadrant(AABB box, double qx, double qy) {
        double dx = Math.max(box.x - qx, Math.max(0, qx - (box.x + box.width)));
        double dy = Math.max(box.y - qy, Math.max(0, qy - (box.y + box.height)));
        return Math.hypot(dx, dy);
    }
}
```

```
Time:  Insert: O(log n) avg, Query: O(sqrt(n) + k) for k results (theoretical bound)
Space: O(n) for n entities across all nodes
JVM note: Each Quadtree node allocates a Quadtree[4] children array on subdivision.
  For n=100K entities, expect ~25K nodes, each 100+ bytes = ~2.5 MB total.
Real-world: Spatial databases (PostGIS) use R-trees; game engines often prefer grids for uniform distributions.
```

---

**P14.20** [M] -- Design a Leaderboard (LeetCode 1244)

Design a leaderboard supporting `addScore(playerId, score)`, `top(K)` (sum of top K scores), and `reset(playerId)`.

```java
public class LeaderboardSystem {
    private final Map<Integer, Integer> scores = new HashMap<>();
    private final TreeMap<Integer, Integer> sortedScores = new TreeMap<>(Collections.reverseOrder());
    
    public void addScore(int playerId, int score) {
        int oldScore = scores.getOrDefault(playerId, 0);
        int newScore = oldScore + score;
        
        if (oldScore > 0) {
            int count = sortedScores.get(oldScore);
            if (count == 1) sortedScores.remove(oldScore);
            else sortedScores.put(oldScore, count - 1);
        }
        
        scores.put(playerId, newScore);
        sortedScores.merge(newScore, 1, Integer::sum);
    }
    
    public int top(int K) {
        int sum = 0, count = 0;
        for (var entry : sortedScores.entrySet()) {
            int score = entry.getKey();
            int freq = entry.getValue();
            int take = Math.min(freq, K - count);
            sum += score * take;
            count += take;
            if (count >= K) break;
        }
        return sum;
    }
    
    public void reset(int playerId) {
        int oldScore = scores.getOrDefault(playerId, 0);
        if (oldScore > 0) {
            int count = sortedScores.get(oldScore);
            if (count == 1) sortedScores.remove(oldScore);
            else sortedScores.put(oldScore, count - 1);
        }
        scores.remove(playerId);
    }
}
```

```
Time:  addScore: O(log n), top: O(K), reset: O(log n) where n = distinct scores
Space: O(n) for both maps
JVM note: TreeMap<Integer, Integer> uses autoboxed Integer keys.
  For scores in [0, 10^6], a Fenwick tree gives O(log M) top-K with no boxing.
Real-world: Redis ZSET powers most production game leaderboards.
```

---

**P14.21** [M] -- Implement Undo/Redo System

Implement an undo/redo system using the command pattern with two stacks.

```java
// Full implementation provided in Section 14.4.5 above (UndoRedoSystem class).
```

```
Time:  O(1) for execute, undo, redo
Space: O(h) where h = history size (bounded by maxHistory)
JVM note: ArrayDeque as stack is more cache-friendly than LinkedList.
  Bounding history prevents unbounded memory growth in long editor sessions.
Real-world: Every text editor, Photoshop, and game editor uses this exact pattern.
```

---

### Logging / Monitoring Domain

**P14.22** [M] -- Design a Rate Limiter Per User (LeetCode-style)

Implement a rate limiter that allows at most K requests per user per time window of W seconds.

```java
public class RateLimiter {
    private final int maxRequests;
    private final int windowSeconds;
    private final ConcurrentHashMap<String, ArrayDeque<Long>> userWindows = new ConcurrentHashMap<>();
    
    public RateLimiter(int maxRequests, int windowSeconds) {
        this.maxRequests = maxRequests;
        this.windowSeconds = windowSeconds;
    }
    
    public synchronized boolean allowRequest(String userId) {
        long now = System.currentTimeMillis();
        long windowStart = now - windowSeconds * 1000L;
        
        ArrayDeque<Long> timestamps = userWindows.computeIfAbsent(userId, k -> new ArrayDeque<>());
        
        // Remove expired timestamps
        while (!timestamps.isEmpty() && timestamps.peekFirst() <= windowStart) {
            timestamps.pollFirst();
        }
        
        if (timestamps.size() < maxRequests) {
            timestamps.addLast(now);
            return true;
        }
        return false;
    }
}

// Token bucket variant: smoother rate limiting
class TokenBucketRateLimiter {
    private final int maxTokens;
    private final double refillRate; // tokens per millisecond
    private final ConcurrentHashMap<String, double[]> buckets = new ConcurrentHashMap<>();
    
    public TokenBucketRateLimiter(int maxTokens, double tokensPerSecond) {
        this.maxTokens = maxTokens;
        this.refillRate = tokensPerSecond / 1000.0;
    }
    
    public boolean allowRequest(String userId) {
        long now = System.currentTimeMillis();
        double[] bucket = buckets.computeIfAbsent(userId, k -> new double[]{maxTokens, now});
        
        synchronized (bucket) {
            double elapsed = now - bucket[1];
            bucket[0] = Math.min(maxTokens, bucket[0] + elapsed * refillRate);
            bucket[1] = now;
            
            if (bucket[0] >= 1.0) {
                bucket[0] -= 1.0;
                return true;
            }
            return false;
        }
    }
}
```

```
Time:  Sliding window: O(expired entries removed), Token bucket: O(1)
Space: O(U * W) for sliding window, O(U) for token bucket, where U = users
JVM note: The sliding window variant creates Long objects per request.
  Token bucket uses a double[2] per user -- 16 bytes, no garbage.
Real-world: Nginx uses leaky bucket. Stripe uses token bucket. AWS API Gateway uses sliding window.
```

---

**P14.23** [M] -- Design Log Aggregation System

Aggregate log entries by source and level. Support `log(source, level, message)`, `getCountByLevel(level)`, `getTopSources(k)`.

```java
public class LogAggregator {
    private final Map<String, Map<String, AtomicInteger>> sourceLevelCounts = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger> globalLevelCounts = new ConcurrentHashMap<>();
    private final AtomicLong totalLogs = new AtomicLong(0);
    
    public void log(String source, String level, String message) {
        totalLogs.incrementAndGet();
        globalLevelCounts.computeIfAbsent(level, k -> new AtomicInteger(0)).incrementAndGet();
        sourceLevelCounts
            .computeIfAbsent(source, k -> new ConcurrentHashMap<>())
            .computeIfAbsent(level, k -> new AtomicInteger(0))
            .incrementAndGet();
    }
    
    public int getCountByLevel(String level) {
        AtomicInteger count = globalLevelCounts.get(level);
        return count != null ? count.get() : 0;
    }
    
    public List<Map.Entry<String, Integer>> getTopSources(int k) {
        Map<String, Integer> totalPerSource = new HashMap<>();
        for (var entry : sourceLevelCounts.entrySet()) {
            int total = entry.getValue().values().stream()
                .mapToInt(AtomicInteger::get).sum();
            totalPerSource.put(entry.getKey(), total);
        }
        
        PriorityQueue<Map.Entry<String, Integer>> pq = new PriorityQueue<>(
            Comparator.comparingInt(Map.Entry::getValue)
        );
        for (var entry : totalPerSource.entrySet()) {
            pq.offer(entry);
            if (pq.size() > k) pq.poll();
        }
        
        List<Map.Entry<String, Integer>> result = new ArrayList<>(pq);
        result.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));
        return result;
    }
}
```

```
Time:  log: O(1), getCountByLevel: O(1), getTopSources: O(S log k) for S sources
Space: O(S * L) where S = sources, L = levels
JVM note: ConcurrentHashMap + AtomicInteger = lock-free logging.
  No contention between different sources. Same source contends only on AtomicInteger CAS.
Real-world: ELK stack (Elasticsearch, Logstash, Kibana) aggregates logs similarly.
```

---

**P14.24** [E] -- Design a Fixed-Size Log Buffer

Implement a circular buffer that stores the last N log messages. Support `add(message)` and `getLast(k)`.

```java
public class FixedLogBuffer {
    private final String[] buffer;
    private int head = 0, count = 0;
    
    public FixedLogBuffer(int capacity) {
        this.buffer = new String[capacity];
    }
    
    public void add(String message) {
        buffer[head] = message;
        head = (head + 1) % buffer.length;
        if (count < buffer.length) count++;
    }
    
    public List<String> getLast(int k) {
        int toReturn = Math.min(k, count);
        List<String> result = new ArrayList<>(toReturn);
        for (int i = 0; i < toReturn; i++) {
            int idx = (head - 1 - i + buffer.length) % buffer.length;
            result.add(buffer[idx]);
        }
        return result;
    }
}
```

```
Time:  add: O(1), getLast: O(k)
Space: O(N) fixed
JVM note: String references in the array keep messages alive -- old messages are only
  GC'd when overwritten. To enable earlier GC, null out the slot before overwriting.
Real-world: Kernel dmesg uses a ring buffer. LMAX Disruptor is a sophisticated ring buffer.
```

---

**P14.25** [M] -- Distributed Counter for Likes

Design a counter that supports high-concurrency increments from multiple threads, with eventual read consistency.

```java
public class ShardedCounter {
    private final AtomicLong[] shards;
    private final int numShards;
    
    public ShardedCounter(int numShards) {
        this.numShards = numShards;
        this.shards = new AtomicLong[numShards];
        for (int i = 0; i < numShards; i++) {
            shards[i] = new AtomicLong(0);
        }
    }
    
    public void increment() {
        // Shard by thread ID to reduce contention
        int shard = (int) (Thread.currentThread().threadId() % numShards);
        shards[shard].incrementAndGet();
    }
    
    public long get() {
        long total = 0;
        for (AtomicLong shard : shards) {
            total += shard.get();
        }
        return total;
    }
    
    // LongAdder is the JDK's built-in sharded counter
    // It uses Cell[] internally with the same sharding-by-thread approach
    private final LongAdder builtInCounter = new LongAdder();
    
    public void incrementBuiltIn() { builtInCounter.increment(); }
    public long getBuiltIn() { return builtInCounter.sum(); }
}
```

```
Time:  increment: O(1) with minimal CAS contention, get: O(shards)
Space: O(shards) -- typically 16 or numCPUs
JVM note: LongAdder (JDK 8+) is the standard solution. It shards internally using
  Striped64.Cell[], each on its own cache line (@Contended annotation prevents false sharing).
  Under contention, LongAdder is 10-100x faster than AtomicLong.
Real-world: Facebook's like counter shards across multiple database rows, aggregated on read.
```

---

### Compiler / Interpreter Domain

**P14.26** [M] -- Implement Expression Evaluator (Calculator)

Evaluate arithmetic expressions with `+`, `-`, `*`, `/`, parentheses, and unary minus. Handle operator precedence correctly.

```java
// Full implementation provided in Section 14.6.3 above (ExpressionEvaluator class).
// Handles: "3 + 4 * 2 / (1 - 5)" -> 1.0
```

```
Time:  O(n) where n = expression length
Space: O(n) for the two stacks
JVM note: ArrayDeque<Character> boxes each char into a Character object.
  For performance-critical evaluators, use an int array as a stack.
Real-world: Every calculator app, spreadsheet formula engine, and SQL expression evaluator.
```

---

**P14.27** [M] -- Design In-Memory File System (LeetCode 588)

Implement a file system with `mkdir(path)`, `addContentToFile(path, content)`, `readContentFromFile(path)`, `ls(path)`.

```java
public class InMemoryFileSystem {
    
    static class FSNode {
        Map<String, FSNode> children = new TreeMap<>(); // sorted for ls()
        StringBuilder content = null; // null = directory, non-null = file
        
        boolean isFile() { return content != null; }
    }
    
    private final FSNode root = new FSNode();
    
    public List<String> ls(String path) {
        FSNode node = navigate(path);
        if (node.isFile()) {
            // Return just the file name
            String[] parts = path.split("/");
            return List.of(parts[parts.length - 1]);
        }
        return new ArrayList<>(node.children.keySet());
    }
    
    public void mkdir(String path) {
        navigateAndCreate(path);
    }
    
    public void addContentToFile(String filePath, String content) {
        FSNode node = navigateAndCreate(filePath);
        if (node.content == null) node.content = new StringBuilder();
        node.content.append(content);
    }
    
    public String readContentFromFile(String filePath) {
        FSNode node = navigate(filePath);
        return node.content != null ? node.content.toString() : "";
    }
    
    private FSNode navigate(String path) {
        FSNode node = root;
        if (path.equals("/")) return node;
        for (String part : path.substring(1).split("/")) {
            node = node.children.get(part);
            if (node == null) throw new IllegalArgumentException("Path not found: " + path);
        }
        return node;
    }
    
    private FSNode navigateAndCreate(String path) {
        FSNode node = root;
        if (path.equals("/")) return node;
        for (String part : path.substring(1).split("/")) {
            node = node.children.computeIfAbsent(part, k -> new FSNode());
        }
        return node;
    }
}
```

```
Time:  All operations: O(L) where L = path depth (number of components)
Space: O(N) where N = total nodes (files + directories)
JVM note: TreeMap for children ensures ls() returns sorted results without extra sorting.
  For a flat directory with 10,000 files, TreeMap ls() is O(n) iteration vs HashMap O(n log n) sort.
Real-world: Linux VFS (Virtual File System) uses a dentry cache (HashMap) for path resolution.
```

---

**P14.28** [E] -- Implement a Basic Symbol Table with Scoping

Implement `define(name, value)`, `lookup(name)`, `enterScope()`, `exitScope()`. Inner scopes shadow outer scopes.

```java
public class BasicSymbolTable {
    private final Deque<Map<String, Object>> scopes = new ArrayDeque<>();
    
    public BasicSymbolTable() { enterScope(); }
    
    public void enterScope() { scopes.push(new HashMap<>()); }
    
    public Map<String, Object> exitScope() { return scopes.pop(); }
    
    public void define(String name, Object value) {
        scopes.peek().put(name, value);
    }
    
    public Object lookup(String name) {
        for (Map<String, Object> scope : scopes) {
            Object val = scope.get(name);
            if (val != null) return val;
        }
        return null; // undefined
    }
    
    public boolean isDefinedLocally(String name) {
        return scopes.peek().containsKey(name);
    }
}
```

```
Time:  define: O(1), lookup: O(D) where D = scope depth, enterScope/exitScope: O(1)
Space: O(S) where S = total symbols across all scopes
JVM note: Stack of HashMaps. Each HashMap defaults to capacity 16, load factor 0.75.
  For small scopes (3-4 variables), the HashMap overhead is significant.
  A linear probe array would be more space-efficient for small scopes.
Real-world: javac's com.sun.tools.javac.code.Scope implements exactly this pattern.
```

---

**P14.29** [H] -- Build an AST Evaluator (Tree Interpreter)

Given an AST representing arithmetic expressions, evaluate it. Support numbers, binary operators, unary minus, and variables.

```java
public class ASTEvaluator implements ASTVisitor<Double> {
    
    private final Map<String, Double> environment;
    
    public ASTEvaluator(Map<String, Double> environment) {
        this.environment = environment;
    }
    
    @Override
    public Double visitNumber(NumberLiteral node) {
        return node.value;
    }
    
    @Override
    public Double visitBinary(BinaryExpr node) {
        double left = node.left.accept(this);
        double right = node.right.accept(this);
        return switch (node.operator) {
            case "+" -> left + right;
            case "-" -> left - right;
            case "*" -> left * right;
            case "/" -> {
                if (right == 0) throw new ArithmeticException("Division by zero");
                yield left / right;
            }
            default -> throw new UnsupportedOperationException("Unknown operator: " + node.operator);
        };
    }
    
    @Override
    public Double visitUnary(UnaryExpr node) {
        double operand = node.operand.accept(this);
        return switch (node.operator) {
            case "-" -> -operand;
            default -> throw new UnsupportedOperationException("Unknown unary: " + node.operator);
        };
    }
    
    @Override
    public Double visitVariable(VariableRef node) {
        Double val = environment.get(node.name);
        if (val == null) throw new RuntimeException("Undefined variable: " + node.name);
        return val;
    }
    
    @Override
    public Double visitAssignment(Assignment node) {
        double val = node.value.accept(this);
        environment.put(node.name, val);
        return val;
    }
    
    @Override
    public Double visitFunctionCall(FunctionCall node) {
        // Built-in functions
        List<Double> args = node.arguments.stream()
            .map(a -> a.accept(this)).collect(Collectors.toList());
        return switch (node.name) {
            case "sqrt" -> Math.sqrt(args.get(0));
            case "abs" -> Math.abs(args.get(0));
            case "max" -> Math.max(args.get(0), args.get(1));
            case "min" -> Math.min(args.get(0), args.get(1));
            default -> throw new RuntimeException("Unknown function: " + node.name);
        };
    }
}
```

```
Time:  O(n) where n = number of AST nodes
Space: O(d) call stack where d = tree depth
JVM note: The Visitor pattern uses virtual dispatch (invokevirtual).
  For tight evaluation loops, the JVM's inline cache handles this efficiently.
  Deep expressions risk StackOverflowError -- convert to iterative with explicit stack for depth > 1000.
Real-world: CPython's ceval.c is a giant switch-based AST evaluator (now bytecode evaluator).
```

---

### Additional Problems (Cross-Domain)

**P14.30** [E] -- Implement a Stack with getMin() (LeetCode 155)

Design a stack supporting `push`, `pop`, `top`, and `getMin` all in O(1).

```java
public class MinStack {
    private final Deque<long[]> stack = new ArrayDeque<>(); // [value, currentMin]
    
    public void push(int val) {
        long min = stack.isEmpty() ? val : Math.min(val, stack.peek()[1]);
        stack.push(new long[]{val, min});
    }
    
    public void pop() { stack.pop(); }
    
    public int top() { return (int) stack.peek()[0]; }
    
    public int getMin() { return (int) stack.peek()[1]; }
}
```

```
Time:  O(1) for all operations
Space: O(n) -- each entry stores value + min
JVM note: long[] avoids Integer boxing. Each long[2] = 32 bytes (16 header + 16 data).
Real-world: Monitoring dashboards that show "current min/max" over a sliding window.
```

---

**P14.31** [E] -- Implement LRU Cache (LeetCode 146)

Design a data structure for Least Recently Used (LRU) cache with O(1) get and put.

```java
public class LRUCache {
    private final int capacity;
    private final LinkedHashMap<Integer, Integer> map;
    
    public LRUCache(int capacity) {
        this.capacity = capacity;
        this.map = new LinkedHashMap<>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Integer, Integer> eldest) {
                return size() > capacity;
            }
        };
    }
    
    public int get(int key) {
        return map.getOrDefault(key, -1);
    }
    
    public void put(int key, int value) {
        map.put(key, value);
    }
}
```

```
Time:  O(1) for get and put
Space: O(capacity)
JVM note: LinkedHashMap with accessOrder=true moves accessed entries to the tail.
  removeEldestEntry is called after every put, evicting the head (least recently used).
Real-world: CDN edge caches, database buffer pools, browser caches all use LRU variants.
```

---

**P14.32** [M] -- Design a Time-Based Key-Value Store (LeetCode 981)

Implement `set(key, value, timestamp)` and `get(key, timestamp)` where get returns the value with the largest timestamp <= the given timestamp.

```java
public class TimeMap {
    private final Map<String, TreeMap<Integer, String>> store = new HashMap<>();
    
    public void set(String key, String value, int timestamp) {
        store.computeIfAbsent(key, k -> new TreeMap<>()).put(timestamp, value);
    }
    
    public String get(String key, int timestamp) {
        TreeMap<Integer, String> timeline = store.get(key);
        if (timeline == null) return "";
        Map.Entry<Integer, String> entry = timeline.floorEntry(timestamp);
        return entry != null ? entry.getValue() : "";
    }
}
```

```
Time:  set: O(log n), get: O(log n) where n = timestamps per key
Space: O(n) total entries
JVM note: TreeMap.floorEntry uses Red-Black tree traversal -- O(log n), no scanning.
  If timestamps are always increasing, ArrayList + binary search is more space-efficient.
Real-world: Git's reflog, database MVCC (multi-version concurrency control).
```

---

**P14.33** [M] -- Design a Logger Rate Limiter (LeetCode 359)

Implement a logger where `shouldPrintMessage(timestamp, message)` returns true if the same message has not been printed in the last 10 seconds.

```java
public class LoggerRateLimiter {
    private final Map<String, Integer> lastPrinted = new HashMap<>();
    
    public boolean shouldPrintMessage(int timestamp, String message) {
        Integer lastTime = lastPrinted.get(message);
        if (lastTime != null && timestamp - lastTime < 10) {
            return false;
        }
        lastPrinted.put(message, timestamp);
        return true;
    }
}
```

```
Time:  O(1) per call
Space: O(m) where m = distinct messages (unbounded -- add cleanup in production)
JVM note: HashMap grows unboundedly. In production, use a TTL-evicting cache
  (Caffeine, Guava Cache) or periodically purge entries older than 10 seconds.
Real-world: Alert deduplication in PagerDuty, Datadog, and CloudWatch.
```

---

**P14.34** [M] -- Implement a Trie (LeetCode 208)

Implement insert, search, and startsWith operations on a trie.

```java
public class Trie {
    private final int[][] children;
    private final boolean[] isEnd;
    private int nextNode = 1; // 0 = root
    
    public Trie() {
        // Pre-allocate for up to ~100K characters total
        children = new int[100001][26];
        isEnd = new boolean[100001];
        for (int[] row : children) Arrays.fill(row, -1);
    }
    
    public void insert(String word) {
        int node = 0;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (children[node][idx] == -1) {
                children[node][idx] = nextNode++;
            }
            node = children[node][idx];
        }
        isEnd[node] = true;
    }
    
    public boolean search(String word) {
        int node = findNode(word);
        return node != -1 && isEnd[node];
    }
    
    public boolean startsWith(String prefix) {
        return findNode(prefix) != -1;
    }
    
    private int findNode(String s) {
        int node = 0;
        for (char c : s.toCharArray()) {
            int idx = c - 'a';
            if (children[node][idx] == -1) return -1;
            node = children[node][idx];
        }
        return node;
    }
}
```

```
Time:  insert/search/startsWith: O(L) where L = word length
Space: O(N * 26) for N nodes in array form -- less pointer overhead than object-based trie
JVM note: Flat int[][] avoids per-node object headers (saves 16 bytes per node).
  For 100K nodes: array form = 100K * 26 * 4 = 10.4 MB; object form = 100K * (16 + 26*4) = 12 MB + pointers.
Real-world: Autocomplete, spell checkers, IP routing tables (Patricia trie).
```

---

**P14.35** [E] -- Two Sum (LeetCode 1)

Given an array of integers and a target, return indices of two numbers that add up to the target.

```java
public int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        int complement = target - nums[i];
        if (seen.containsKey(complement)) {
            return new int[]{seen.get(complement), i};
        }
        seen.put(nums[i], i);
    }
    return new int[]{};
}
```

```
Time:  O(n) single pass
Space: O(n) for HashMap
JVM note: Integer keys in [-128, 127] use cached Integer objects (IntegerCache).
  Outside this range, each put creates a new Integer on the heap.
Real-world: Index lookups in databases -- "find the row whose key + this value = target."
```

---

**P14.36** [E] -- Valid Parentheses (LeetCode 20)

Determine if a string of brackets is valid.

```java
public boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        if (c == '(' || c == '[' || c == '{') {
            stack.push(c);
        } else {
            if (stack.isEmpty()) return false;
            char open = stack.pop();
            if ((c == ')' && open != '(') || (c == ']' && open != '[') || (c == '}' && open != '{'))
                return false;
        }
    }
    return stack.isEmpty();
}
```

```
Time:  O(n)
Space: O(n) worst case
JVM note: ArrayDeque<Character> autoboxes. For pure ASCII, use a byte[] stack.
Real-world: Compiler parsers validate matching delimiters. JSON/XML parsers use the same pattern.
```

---

**P14.37** [M] -- Merge Intervals (LeetCode 56)

Given a collection of intervals, merge all overlapping intervals.

```java
public int[][] merge(int[][] intervals) {
    Arrays.sort(intervals, Comparator.comparingInt(a -> a[0]));
    List<int[]> merged = new ArrayList<>();
    
    for (int[] interval : intervals) {
        if (merged.isEmpty() || merged.get(merged.size() - 1)[1] < interval[0]) {
            merged.add(interval);
        } else {
            merged.get(merged.size() - 1)[1] = Math.max(merged.get(merged.size() - 1)[1], interval[1]);
        }
    }
    return merged.toArray(new int[0][]);
}
```

```
Time:  O(n log n) for sorting
Space: O(n) for result
JVM note: Arrays.sort on int[][] uses TimSort (merge sort variant), stable and O(n log n).
Real-world: Calendar apps merge overlapping events. Network IP range consolidation.
  Database query planners merge overlapping index scan ranges.
```

---

**P14.38** [M] -- Top K Frequent Elements (LeetCode 347)

Given an integer array, return the K most frequent elements.

```java
public int[] topKFrequent(int[] nums, int k) {
    Map<Integer, Integer> freq = new HashMap<>();
    for (int n : nums) freq.merge(n, 1, Integer::sum);
    
    // Bucket sort: index = frequency, value = list of elements with that frequency
    @SuppressWarnings("unchecked")
    List<Integer>[] buckets = new List[nums.length + 1];
    for (var entry : freq.entrySet()) {
        int f = entry.getValue();
        if (buckets[f] == null) buckets[f] = new ArrayList<>();
        buckets[f].add(entry.getKey());
    }
    
    int[] result = new int[k];
    int idx = 0;
    for (int i = buckets.length - 1; i >= 0 && idx < k; i--) {
        if (buckets[i] != null) {
            for (int val : buckets[i]) {
                result[idx++] = val;
                if (idx == k) break;
            }
        }
    }
    return result;
}
```

```
Time:  O(n) -- bucket sort avoids O(n log k) heap overhead
Space: O(n) for frequency map and buckets
JVM note: The List[] array has sparse allocation -- most buckets are null.
Real-world: Top search queries, top error messages, top API endpoints by call volume.
```

---

**P14.39** [M] -- Design a HashMap from Scratch (LeetCode 706)

Implement a HashMap with `put`, `get`, `remove` without using any built-in hash table libraries.

```java
public class MyHashMap {
    private static final int SIZE = 1024;
    private final int[][] buckets;
    
    public MyHashMap() {
        buckets = new int[SIZE][];
    }
    
    private int hash(int key) { return key % SIZE; }
    
    public void put(int key, int value) {
        int h = hash(key);
        if (buckets[h] == null) {
            buckets[h] = new int[]{key, value};
            return;
        }
        // Linear probe in a simple chain (array-based for demo)
        // In practice, use separate chaining with linked list
        int[] bucket = buckets[h];
        for (int i = 0; i < bucket.length; i += 2) {
            if (bucket[i] == key) { bucket[i + 1] = value; return; }
        }
        int[] newBucket = new int[bucket.length + 2];
        System.arraycopy(bucket, 0, newBucket, 0, bucket.length);
        newBucket[bucket.length] = key;
        newBucket[bucket.length + 1] = value;
        buckets[h] = newBucket;
    }
    
    public int get(int key) {
        int h = hash(key);
        if (buckets[h] == null) return -1;
        for (int i = 0; i < buckets[h].length; i += 2) {
            if (buckets[h][i] == key) return buckets[h][i + 1];
        }
        return -1;
    }
    
    public void remove(int key) {
        int h = hash(key);
        if (buckets[h] == null) return;
        for (int i = 0; i < buckets[h].length; i += 2) {
            if (buckets[h][i] == key) {
                // Shift remaining elements
                int[] newBucket = new int[buckets[h].length - 2];
                System.arraycopy(buckets[h], 0, newBucket, 0, i);
                System.arraycopy(buckets[h], i + 2, newBucket, i, buckets[h].length - i - 2);
                buckets[h] = newBucket.length > 0 ? newBucket : null;
                return;
            }
        }
    }
}
```

```
Time:  O(n/B) average for all operations where B = bucket count
Space: O(n + B)
JVM note: This array-based chaining avoids Node object overhead.
  OpenJDK HashMap uses Node objects with separate chaining, plus treeification at chain length 8.
Real-world: Every key-value store -- Redis, Memcached, DynamoDB -- is a HashMap at its core.
```

---

**P14.40** [E] -- Implement a Queue Using Stacks (LeetCode 232)

Implement a FIFO queue using two LIFO stacks.

```java
public class MyQueue {
    private final Deque<Integer> pushStack = new ArrayDeque<>();
    private final Deque<Integer> popStack = new ArrayDeque<>();
    
    public void push(int x) { pushStack.push(x); }
    
    public int pop() {
        if (popStack.isEmpty()) transfer();
        return popStack.pop();
    }
    
    public int peek() {
        if (popStack.isEmpty()) transfer();
        return popStack.peek();
    }
    
    public boolean empty() { return pushStack.isEmpty() && popStack.isEmpty(); }
    
    private void transfer() {
        while (!pushStack.isEmpty()) popStack.push(pushStack.pop());
    }
}
```

```
Time:  Amortized O(1) for all operations. Each element is moved at most once.
Space: O(n)
JVM note: Two ArrayDeques backed by circular arrays -- no node objects, no GC pressure.
Real-world: Message queue systems batch messages similarly -- produce to one buffer, consume from another.
```

---

**P14.41** [E] -- First Unique Character in a String (LeetCode 387)

Find the first non-repeating character in a string and return its index.

```java
public int firstUniqChar(String s) {
    int[] count = new int[26];
    for (char c : s.toCharArray()) count[c - 'a']++;
    for (int i = 0; i < s.length(); i++) {
        if (count[s.charAt(i) - 'a'] == 1) return i;
    }
    return -1;
}
```

```
Time:  O(n) two passes
Space: O(1) -- fixed 26-element array
JVM note: int[26] = 120 bytes (16 header + 4 padding + 26*4). Fits in a single cache line.
Real-world: Deduplication in log processing -- find the first unique event in a stream.
```

---

**P14.42** [M] -- Kth Largest Element in a Stream (LeetCode 703)

Design a class to find the kth largest element in a stream.

```java
public class KthLargest {
    private final PriorityQueue<Integer> minHeap;
    private final int k;
    
    public KthLargest(int k, int[] nums) {
        this.k = k;
        this.minHeap = new PriorityQueue<>();
        for (int n : nums) add(n);
    }
    
    public int add(int val) {
        minHeap.offer(val);
        if (minHeap.size() > k) minHeap.poll();
        return minHeap.peek();
    }
}
```

```
Time:  add: O(log k)
Space: O(k)
JVM note: PriorityQueue of size k -- heap operations touch at most log(k) elements.
  Integer autoboxing creates objects; for millions of calls, consider an IntPriorityQueue.
Real-world: Real-time leaderboard "you are rank K" computation.
```

---

**P14.43** [M] -- LFU Cache (LeetCode 460)

Design a Least Frequently Used cache with O(1) get and put.

```java
public class LFUCache {
    private final int capacity;
    private int minFreq = 0;
    private final Map<Integer, int[]> keyToValFreq = new HashMap<>(); // key -> [value, freq]
    private final Map<Integer, LinkedHashSet<Integer>> freqToKeys = new HashMap<>();
    
    public LFUCache(int capacity) { this.capacity = capacity; }
    
    public int get(int key) {
        if (!keyToValFreq.containsKey(key)) return -1;
        int[] vf = keyToValFreq.get(key);
        incrementFreq(key, vf);
        return vf[0];
    }
    
    public void put(int key, int value) {
        if (capacity <= 0) return;
        if (keyToValFreq.containsKey(key)) {
            int[] vf = keyToValFreq.get(key);
            vf[0] = value;
            incrementFreq(key, vf);
            return;
        }
        
        if (keyToValFreq.size() >= capacity) evict();
        
        keyToValFreq.put(key, new int[]{value, 1});
        freqToKeys.computeIfAbsent(1, k -> new LinkedHashSet<>()).add(key);
        minFreq = 1;
    }
    
    private void incrementFreq(int key, int[] vf) {
        int oldFreq = vf[1];
        freqToKeys.get(oldFreq).remove(key);
        if (freqToKeys.get(oldFreq).isEmpty()) {
            freqToKeys.remove(oldFreq);
            if (minFreq == oldFreq) minFreq++;
        }
        vf[1] = oldFreq + 1;
        freqToKeys.computeIfAbsent(vf[1], k -> new LinkedHashSet<>()).add(key);
    }
    
    private void evict() {
        LinkedHashSet<Integer> keys = freqToKeys.get(minFreq);
        int evictKey = keys.iterator().next(); // oldest in this frequency
        keys.remove(evictKey);
        if (keys.isEmpty()) freqToKeys.remove(minFreq);
        keyToValFreq.remove(evictKey);
    }
}
```

```
Time:  O(1) for get and put
Space: O(capacity)
JVM note: LinkedHashSet maintains insertion order -- the first element via iterator() is the
  oldest at that frequency. This gives O(1) eviction of the least-frequent, oldest entry.
Real-world: CPU caches approximate LFU. CDN caches (Cloudflare) use LFU variants.
```

---

**P14.44** [E] -- Reverse a Linked List (LeetCode 206)

Reverse a singly-linked list iteratively.

```java
public ListNode reverseList(ListNode head) {
    ListNode prev = null, curr = head;
    while (curr != null) {
        ListNode next = curr.next;
        curr.next = prev;
        prev = curr;
        curr = next;
    }
    return prev;
}
```

```
Time:  O(n)
Space: O(1)
JVM note: Each node is a separate heap object. Reversing only changes the next pointers --
  no allocation, no copying. The GC sees the same object graph, just wired differently.
Real-world: Reversing a log for chronological display. Reversing a linked buffer for replay.
```

---

**P14.45** [E] -- Contains Duplicate (LeetCode 217)

Return true if any value appears at least twice in the array.

```java
public boolean containsDuplicate(int[] nums) {
    Set<Integer> seen = new HashSet<>();
    for (int n : nums) {
        if (!seen.add(n)) return true;
    }
    return false;
}
```

```
Time:  O(n)
Space: O(n)
JVM note: HashSet.add returns false if the element already exists -- single operation, no separate contains().
  For int[] of size 10^5, the HashSet creates ~10^5 Integer wrapper objects = ~2.4 MB heap.
Real-world: Duplicate detection in data pipelines, deduplication of event streams.
```

---

**P14.46** [E] -- Maximum Depth of Binary Tree (LeetCode 104)

Find the maximum depth of a binary tree.

```java
public int maxDepth(TreeNode root) {
    if (root == null) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
```

```
Time:  O(n) -- visit every node
Space: O(h) call stack where h = tree height
JVM note: For balanced tree of 10^6 nodes, h ~ 20, call stack = ~20 frames.
  For a degenerate (linked-list) tree, h = 10^6, risking StackOverflowError.
  Default thread stack = 512KB-1MB. Convert to iterative BFS for safety.
Real-world: File system depth analysis, DOM tree depth for rendering optimization.
```

---

**P14.47** [M] -- Serialize and Deserialize Binary Tree (LeetCode 297)

Design an algorithm to serialize a binary tree to a string and deserialize it back.

```java
public class TreeSerializer {
    
    public String serialize(TreeNode root) {
        StringBuilder sb = new StringBuilder();
        serializeHelper(root, sb);
        return sb.toString();
    }
    
    private void serializeHelper(TreeNode node, StringBuilder sb) {
        if (node == null) { sb.append("#,"); return; }
        sb.append(node.val).append(",");
        serializeHelper(node.left, sb);
        serializeHelper(node.right, sb);
    }
    
    public TreeNode deserialize(String data) {
        Deque<String> tokens = new ArrayDeque<>(Arrays.asList(data.split(",")));
        return deserializeHelper(tokens);
    }
    
    private TreeNode deserializeHelper(Deque<String> tokens) {
        String val = tokens.poll();
        if ("#".equals(val)) return null;
        TreeNode node = new TreeNode(Integer.parseInt(val));
        node.left = deserializeHelper(tokens);
        node.right = deserializeHelper(tokens);
        return node;
    }
}
```

```
Time:  O(n) for both serialize and deserialize
Space: O(n) for the string / token queue
JVM note: Pre-order traversal with null markers uniquely defines the tree.
  split(",") creates a String[] of n tokens -- consider a streaming tokenizer for large trees.
Real-world: Protocol Buffers, JSON serialization of tree structures, Kafka message encoding.
```

---

**P14.48** [H] -- Word Search II (LeetCode 212)

Given a board and a list of words, find all words that can be formed by sequentially adjacent cells.

```java
public List<String> findWords(char[][] board, String[] words) {
    // Build trie from words
    int[][] trie = new int[250001][26];
    boolean[] isWord = new boolean[250001];
    String[] wordAt = new String[250001];
    int trieSize = 1;
    
    for (String word : words) {
        int node = 0;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (trie[node][idx] == 0) trie[node][idx] = trieSize++;
            node = trie[node][idx];
        }
        isWord[node] = true;
        wordAt[node] = word;
    }
    
    List<String> result = new ArrayList<>();
    int m = board.length, n = board[0].length;
    
    for (int i = 0; i < m; i++) {
        for (int j = 0; j < n; j++) {
            dfs(board, i, j, m, n, 0, trie, isWord, wordAt, result);
        }
    }
    return result;
}

private void dfs(char[][] board, int r, int c, int m, int n, int node,
                 int[][] trie, boolean[] isWord, String[] wordAt, List<String> result) {
    if (r < 0 || r >= m || c < 0 || c >= n || board[r][c] == '#') return;
    
    char ch = board[r][c];
    int next = trie[node][ch - 'a'];
    if (next == 0) return; // no words with this prefix
    
    if (isWord[next]) {
        result.add(wordAt[next]);
        isWord[next] = false; // avoid duplicates
    }
    
    board[r][c] = '#'; // mark visited
    dfs(board, r + 1, c, m, n, next, trie, isWord, wordAt, result);
    dfs(board, r - 1, c, m, n, next, trie, isWord, wordAt, result);
    dfs(board, r, c + 1, m, n, next, trie, isWord, wordAt, result);
    dfs(board, r, c - 1, m, n, next, trie, isWord, wordAt, result);
    board[r][c] = ch; // restore
}
```

```
Time:  O(M * N * 4^L) worst case where L = max word length, but trie pruning makes it much faster
Space: O(W * L) for trie where W = number of words
JVM note: Flat int[][] trie avoids per-node object creation.
  For 10K words of avg length 10, trie has ~50K nodes = 50K * 26 * 4 = 5.2 MB.
Real-world: Spell-check in word processors, crossword puzzle solvers, Scrabble AI.
```

---

**P14.49** [H] -- Median from Data Stream (LeetCode 295)

Design a data structure that supports adding numbers and finding the median.

```java
public class MedianFinder {
    private final PriorityQueue<Integer> maxHeap = new PriorityQueue<>(Collections.reverseOrder()); // lower half
    private final PriorityQueue<Integer> minHeap = new PriorityQueue<>(); // upper half
    
    public void addNum(int num) {
        maxHeap.offer(num);
        minHeap.offer(maxHeap.poll());
        if (minHeap.size() > maxHeap.size()) {
            maxHeap.offer(minHeap.poll());
        }
    }
    
    public double findMedian() {
        if (maxHeap.size() > minHeap.size()) return maxHeap.peek();
        return (maxHeap.peek() + minHeap.peek()) / 2.0;
    }
}
```

```
Time:  addNum: O(log n), findMedian: O(1)
Space: O(n)
JVM note: Two PriorityQueues, each holding ~n/2 Integer objects.
  For n = 10^6, that is ~24 MB of boxed Integers.
Real-world: Real-time median latency monitoring, percentile computation for SLOs.
```

---

**P14.50** [H] -- Implement Trie with Wildcard Search (LeetCode 211)

Design a data structure supporting `addWord(word)` and `search(word)` where search may contain '.' as wildcard for any letter.

```java
public class WildcardTrie {
    private final WildcardTrie[] children = new WildcardTrie[26];
    private boolean isEnd = false;
    
    public void addWord(String word) {
        WildcardTrie node = this;
        for (char c : word.toCharArray()) {
            int idx = c - 'a';
            if (node.children[idx] == null) node.children[idx] = new WildcardTrie();
            node = node.children[idx];
        }
        node.isEnd = true;
    }
    
    public boolean search(String word) {
        return searchFrom(this, word, 0);
    }
    
    private boolean searchFrom(WildcardTrie node, String word, int index) {
        if (node == null) return false;
        if (index == word.length()) return node.isEnd;
        
        char c = word.charAt(index);
        if (c == '.') {
            for (WildcardTrie child : node.children) {
                if (searchFrom(child, word, index + 1)) return true;
            }
            return false;
        }
        return searchFrom(node.children[c - 'a'], word, index + 1);
    }
}
```

```
Time:  addWord: O(L), search: O(26^L) worst case with all dots, O(L) without dots
Space: O(N * 26) for N nodes
JVM note: Each WildcardTrie node = 16 (header) + 26*4 (children) + 1 (isEnd) + 3 (padding) = 128 bytes.
Real-world: DNS wildcard matching (*.example.com), regex engines, search pattern matching.
```

---

**P14.51** [E] -- Ransom Note (LeetCode 383)

Can you construct the ransom note from the magazine characters?

```java
public boolean canConstruct(String ransomNote, String magazine) {
    int[] count = new int[26];
    for (char c : magazine.toCharArray()) count[c - 'a']++;
    for (char c : ransomNote.toCharArray()) {
        if (--count[c - 'a'] < 0) return false;
    }
    return true;
}
```

```
Time:  O(m + n) where m = magazine length, n = note length
Space: O(1) -- fixed 26-element array
JVM note: int[26] fits in a single 64-byte cache line on modern CPUs.
Real-world: Character inventory checking in games, anagram validation, resource availability checks.
```

---

**P14.52** [E] -- Binary Search (LeetCode 704)

Implement binary search on a sorted array.

```java
public int search(int[] nums, int target) {
    int lo = 0, hi = nums.length - 1;
    while (lo <= hi) {
        int mid = lo + (hi - lo) / 2; // avoid overflow
        if (nums[mid] == target) return mid;
        else if (nums[mid] < target) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}
```

```
Time:  O(log n)
Space: O(1)
JVM note: (lo + hi) / 2 overflows for large arrays. lo + (hi - lo) / 2 is safe.
  Arrays.binarySearch uses the same pattern internally.
Real-world: Every database index lookup, sorted file bisection, Git bisect.
```

---

**P14.53** [M] -- Maximum Subarray (LeetCode 53, Kadane's Algorithm)

Find the contiguous subarray with the largest sum.

```java
public int maxSubArray(int[] nums) {
    int maxSum = nums[0], currentSum = nums[0];
    for (int i = 1; i < nums.length; i++) {
        currentSum = Math.max(nums[i], currentSum + nums[i]);
        maxSum = Math.max(maxSum, currentSum);
    }
    return maxSum;
}
```

```
Time:  O(n)
Space: O(1)
JVM note: Pure arithmetic on primitives. JIT compiles this to tight machine code with no allocations.
  Branch prediction succeeds on most iterations (currentSum + nums[i] is usually the max).
Real-world: Maximum profit period in financial data. Peak load period in monitoring.
  Maximum contiguous resource utilization in capacity planning.
```

---

**P14.54** [H] -- Design a Concurrent LRU Cache

Implement a thread-safe LRU cache that supports concurrent reads and writes.

```java
public class ConcurrentLRUCache<K, V> {
    
    private final int capacity;
    private final Map<K, V> cache;
    private final ReadWriteLock lock = new ReentrantReadWriteLock();
    
    public ConcurrentLRUCache(int capacity) {
        this.capacity = capacity;
        this.cache = new LinkedHashMap<>(capacity, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                return size() > capacity;
            }
        };
    }
    
    public V get(K key) {
        lock.readLock().lock();
        try {
            return cache.get(key); // note: this modifies access order, needs write lock in strict impl
        } finally {
            lock.readLock().unlock();
        }
    }
    
    public void put(K key, V value) {
        lock.writeLock().lock();
        try {
            cache.put(key, value);
        } finally {
            lock.writeLock().unlock();
        }
    }
    
    // Stricter version: get needs write lock because accessOrder=true modifies internal state
    public V getStrict(K key) {
        lock.writeLock().lock();
        try {
            return cache.get(key);
        } finally {
            lock.writeLock().unlock();
        }
    }
    
    public int size() {
        lock.readLock().lock();
        try {
            return cache.size();
        } finally {
            lock.readLock().unlock();
        }
    }
}
```

```
Time:  O(1) for get/put (amortized), but serialized under write lock
Space: O(capacity)
JVM note: ReadWriteLock allows concurrent reads but exclusive writes.
  With accessOrder=true, get() actually modifies the linked list, so it needs the write lock.
  Caffeine cache (used by Spring) uses a striped, lock-free design with much better throughput.
Real-world: Database connection pool metadata cache, session store, CDN edge cache.
```

---

**P14.55** [H] -- Design a Task Scheduler with Priority and Dependencies

Implement a task scheduler that respects both task priorities and dependency ordering (topological sort + priority queue).

```java
public class TaskScheduler {
    
    static class Task {
        final String id;
        final int priority; // higher = more important
        final List<String> dependencies;
        
        Task(String id, int priority, List<String> dependencies) {
            this.id = id;
            this.priority = priority;
            this.dependencies = dependencies;
        }
    }
    
    public List<String> schedule(List<Task> tasks) {
        Map<String, Task> taskMap = new HashMap<>();
        Map<String, Integer> inDegree = new HashMap<>();
        Map<String, Set<String>> dependents = new HashMap<>(); // task -> tasks that depend on it
        
        for (Task task : tasks) {
            taskMap.put(task.id, task);
            inDegree.put(task.id, task.dependencies.size());
            for (String dep : task.dependencies) {
                dependents.computeIfAbsent(dep, k -> new HashSet<>()).add(task.id);
            }
        }
        
        // Priority queue: among tasks with no pending dependencies, pick highest priority
        PriorityQueue<Task> ready = new PriorityQueue<>(
            (a, b) -> Integer.compare(b.priority, a.priority)
        );
        
        for (Task task : tasks) {
            if (inDegree.get(task.id) == 0) ready.offer(task);
        }
        
        List<String> order = new ArrayList<>();
        while (!ready.isEmpty()) {
            Task current = ready.poll();
            order.add(current.id);
            
            Set<String> deps = dependents.getOrDefault(current.id, Collections.emptySet());
            for (String depId : deps) {
                int newDegree = inDegree.merge(depId, -1, Integer::sum);
                if (newDegree == 0) {
                    ready.offer(taskMap.get(depId));
                }
            }
        }
        
        if (order.size() != tasks.size()) {
            throw new IllegalStateException("Cycle detected in task dependencies");
        }
        return order;
    }
}
```

```
Time:  O(T log T + D) where T = tasks, D = total dependency edges
Space: O(T + D)
JVM note: PriorityQueue ensures highest-priority ready tasks execute first.
  This is a priority-aware topological sort (Kahn's algorithm with a heap instead of a queue).
Real-world: Build systems (Gradle, Bazel) schedule tasks exactly this way.
  CI/CD pipelines, Kubernetes pod scheduling with init container dependencies.
```

---

## Key Takeaways

1. **Every application domain has a canonical data structure mapping.** E-commerce autocomplete maps to tries. Order books map to TreeMap<Price, Queue>. Social feeds map to merge-K-sorted-lists. Leaderboards map to sorted sets. Knowing these mappings lets you design systems in minutes instead of hours because you start from the right foundation.

2. **HashMap is the universal workhorse, but it is rarely sufficient alone.** Shopping carts, symbol tables, entity component systems, inventory tracking -- they all start with HashMap. But production systems layer additional structures on top: LinkedHashMap for ordering, TreeMap for range queries, ConcurrentHashMap for thread safety, or custom hash tables for performance-critical paths.

3. **Concurrency changes everything about data structure choice.** A HashMap that works perfectly in a single-threaded test fails catastrophically under concurrent access (infinite loops during resize in pre-Java 8, silent data corruption in all versions). The jump from HashMap to ConcurrentHashMap is not just a class swap -- it changes the semantics of every operation. Understand the concurrency guarantees before choosing.

4. **Approximate data structures unlock bounded-memory solutions.** Count-Min Sketch for frequency estimation, Bloom filters for membership testing, t-digest for percentile computation, HyperLogLog for cardinality estimation. When you have unbounded input streams (log messages, hashtags, user events), exact counting requires unbounded memory. Approximate structures give you 99%+ accuracy in fixed space.

5. **The ring buffer is the most underappreciated data structure in systems engineering.** Fixed-size log retention, market data tick buffers, sliding window counters, the LMAX Disruptor's inter-thread communication, Kafka's log segments -- all ring buffers. O(1) append, bounded memory, zero allocation on the hot path, cache-friendly sequential access. When you need fixed-capacity FIFO, reach for a circular array before anything else.

6. **Trees are not just for interviews -- they power real-time aggregation.** Segment trees for portfolio risk calculation, TreeMaps for order books and price range queries, tries for autocomplete, ASTs for compilers. The common thread: trees decompose a problem into O(log n) subproblems. When you need to both update individual elements and query aggregate properties, a tree structure is almost always the answer.

7. **Graph algorithms model real relationships, not abstract problems.** Friend networks are adjacency lists. Degrees of separation is BFS. Mutual friends is set intersection. Recommendations are two-hop BFS. Dependency scheduling is topological sort. Game pathfinding is A*. The graph vocabulary you learn for interviews is the same vocabulary you use to design systems.

8. **JVM object overhead drives production data structure choices away from the textbook.** A node-based trie with TrieNode objects costs 128+ bytes per node. A flat-array trie costs 104 bytes per node. An object-based linked list costs 40 bytes per node for the Node alone. Production systems flatten trees into arrays, use primitive collections to avoid boxing, and pre-allocate buffers to avoid GC pressure. The algorithmic complexity is the same; the constant factor is what determines whether you hit your latency SLO.

9. **The command pattern with two stacks is the universal undo/redo solution.** Games, editors, IDEs, drawing applications -- every application that supports undo/redo uses this exact pattern. Execute pushes to the undo stack. Undo pops from the undo stack and pushes to the redo stack. New actions clear the redo stack. Bound the undo stack to prevent memory leaks.

10. **System design interviews are data structure selection interviews in disguise.** "Design a news feed" is really "choose merge-K-sorted-lists vs fan-out-on-write." "Design a rate limiter" is really "choose sliding window vs token bucket." "Design a leaderboard" is really "choose TreeMap vs Fenwick tree vs Redis ZSET." When you know the data structure mapping for each domain, the system design writes itself -- the structure dictates the API, the complexity, and the scaling strategy.

---

[Previous: Chapter 13 -- OS & Distributed Systems](13-use-cases-os-distributed-systems.md) | [Next: Chapter 15 -- Patterns: Arrays & Strings](15-pattern-arrays-strings.md)
