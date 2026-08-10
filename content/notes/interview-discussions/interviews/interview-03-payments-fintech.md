# Interview 03 — Payments / Fintech

> **The company:** A payments platform — Stripe/Adyen class — that moves other people's money.
> **The role:** Backend SDE on the money path. **The panel:** An engineer who has been paged at
> 3am for a double-charge and a senior who thinks about regulators. Their unspoken rule: **a
> bug here isn't a stack trace, it's someone's rent.** 
>
> **What they're testing:** Do you treat money with the paranoia it demands — correctness over
> availability, idempotency everywhere, an audit trail you can defend in court — and do you know
> that "exactly once" against a card network is a discipline, not a feature? Domains: `PS` `DB`
> `DIST`. Pairs with loop [R3.Q3](../03-round-3-distributed-messaging.md) and
> [R5.Q5](../05-round-5-bar-raiser.md).

7 exchanges. ★★★★ — ★★★★★.

---

### [I03.Q1] "How do you store $19.99 in the database?"  ·  ★★★☆☆

**Interviewer:** Simple one to start. A customer pays $19.99. What's the column type?

**Candidate:** **Never a float/double** — an integer count of the **minor unit** (cents), or a
fixed-precision **`DECIMAL`/`NUMERIC`**. `$19.99` is stored as the integer `1999` cents.

The reason is that **binary floating point cannot exactly represent most decimal fractions** —
`0.1 + 0.2 != 0.3` in IEEE-754, because 0.1 has no exact binary representation. Accumulate a few
million float operations across a ledger and the rounding errors drift, so your books **don't
balance to the penny** — which for money is not a rounding nuisance, it's a *correctness and
compliance failure*. Auditors and regulators require exact arithmetic.

So:
- **Integer minor units** (`amount_cents BIGINT`) is my default — money becomes ordinary
  integer arithmetic, exact and fast, and you format to `$19.99` only at the presentation layer.
- **`DECIMAL(precision, scale)`** when I need fractional minor units (FX rates, per-unit pricing
  with sub-cent precision, interest) — exact decimal arithmetic in the DB.
- And **always store the currency alongside the amount** (`amount_cents`, `currency`), because
  `1999` is meaningless without knowing it's USD vs JPY (which has *no* minor unit — ¥1999 is
  1999 yen, not 19.99) vs a 3-decimal currency like BHD. The minor-unit *exponent* varies by
  currency (ISO 4217), so the code that converts integer↔display must be currency-aware.

**Interviewer:** You convert USD to EUR at some rate. Where does the rounding happen, and who
eats the fraction of a cent?

**Candidate:** This is where naive money math leaks value, and the answer must be **deliberate,
documented, and conservative** — because a fraction of a cent times millions of transactions is
real money, and *which way you round* has legal and accounting implications.

- **Round at a single, defined point** — never let rounding happen implicitly at multiple steps,
  or errors compound. You compute in higher precision (`DECIMAL`) and round to the target
  currency's minor unit exactly once, at a specified boundary.
- **The rounding mode is a business/legal decision**, not a default. `HALF_EVEN` ("banker's
  rounding") is common because it's unbiased over many transactions (round-half-to-even cancels
  out, unlike `HALF_UP` which biases upward and slowly leaks value to one side). But some
  jurisdictions or contracts *mandate* a specific mode, and tax/interest often has legally
  prescribed rounding.
- **Conservation must hold** — the sum of rounded parts must equal the rounded total. If you
  split $10.00 three ways, you can't emit three $3.33s (= $9.99) and lose a cent; you allocate
  the remainder explicitly (the "largest remainder" method — one party gets $3.34). The residual
  cent goes *somewhere* by an explicit rule, never into the void.
- **The fraction is captured, not dropped** — in many systems the rounding residue is posted to
  a dedicated **rounding account** in the ledger so the books still balance to zero and the
  residue is auditable.

The framing: **money is exact-arithmetic-only (integer minor units or DECIMAL, never float),
currency-aware (the minor-unit exponent varies), and rounding is a single, explicit, legally-
informed, value-conserving step — never an implicit float artifact.** The junior answer is "use
a decimal type"; the senior answer knows *why* (binary can't represent decimal fractions exactly)
and that rounding policy is a domain decision with a paper trail.

──────────
> **[BANK]** Store money as **integer minor units** (cents) or **`DECIMAL`**, never float
> (binary IEEE-754 can't represent decimal fractions exactly → books drift, fail audit). Always
> store **currency** alongside (minor-unit exponent varies: JPY=0, USD=2, BHD=3). Round at **one
> defined point**, with a **deliberate mode** (`HALF_EVEN`/banker's, or legally mandated),
> conserving value (allocate the residual cent explicitly, e.g. to a rounding account).
> **[TRAP]** `float`/`double` for money; rounding implicitly at multiple steps (compounds);
> assuming 2 decimal places universally (currency-dependent); letting a split lose a cent.
> **[GO DEEPER]** [I03.Q2] the ledger these amounts live in · [I03.Q6] reconciliation to the
> penny.

---

### [I03.Q2] "Design the data model for an account balance."  ·  ★★★★★

**Interviewer:** An account has a balance. Customers deposit, withdraw, transfer. Model it. And
I'll warn you: if your first instinct is a `balance` column you `UPDATE`, I'm going to make your
life hard.

**Candidate:** I'd model it as a **double-entry, append-only ledger** — the balance is a
**derived** value, not a stored mutable field — because that's how accounting has worked for 500
years and it's the only model that's auditable and corruption-resistant.

The naive `accounts.balance` column you `UPDATE` is wrong for money:
- It's **destructive** — an `UPDATE` overwrites history; you can't answer "what was the balance
  on March 3rd?" or "why is it this number?" There's no audit trail, which is *disqualifying*
  for regulated money.
- It's a **hotspot for races** — concurrent debits read-modify-write the same row ([I03.Q4]).
- A bug or a partial failure leaves a **wrong number with no way to reconstruct the truth**.

**Double-entry ledger** instead:
- **Money is never created or destroyed, only moved** between accounts. Every transaction is a
  set of **entries** that **sum to zero**: a $50 transfer is a *debit* of $50 from account A and
  a *credit* of $50 to account B — two entries, netting zero. This is the invariant that makes
  the whole system checkable: **the sum of all entries across all accounts is always exactly
  zero**, forever. If it isn't, you have a bug, and you can detect it.

```
 ledger_entries (append-only, immutable):
   id | txn_id | account_id | amount_cents (signed) | currency | created_at
   ── a transfer of $50 A→B is ONE txn_id, TWO entries:
   .. | t1     | A          | -5000                 | USD      | ...
   .. | t1     | B          | +5000                 | USD      | ...   (sums to 0)

 balance(account) = SUM(amount_cents) WHERE account_id = ?   ← derived
```

- **Append-only / immutable** — you never `UPDATE` or `DELETE` an entry. A mistake is corrected
  by appending a **reversing entry** (the accounting "contra"), so the *error itself* stays in
  the history. This gives a perfect, tamper-evident audit trail.
- **The balance is `SUM(entries)`** — derived, always reconstructable, always consistent with
  history by construction.

**Interviewer:** `SUM` over every entry for an account that's existed for ten years, on every
balance check? That's insane. Reconcile your purity with reality.

**Candidate:** Correct — recomputing `SUM` over millions of historical entries per read doesn't
scale, so the production model keeps the immutable ledger as the **source of truth** but adds a
**materialized balance as a cache/optimization**, with the ledger as the ground truth that can
*always rebuild it*:

1. **Running balance / snapshot.** Store a periodic **balance snapshot** (e.g. end-of-day, or a
   running balance on each entry) so a current balance = `last_snapshot + SUM(entries since
   snapshot)` — bounded work. The snapshot is derived from the ledger, never authoritative on
   its own.
2. **A maintained `balances` row updated in the same transaction as the entries.** When you
   append the two ledger entries, you also `UPDATE balances` for both accounts **in the same DB
   transaction** (loop [R2.Q6] / [R5.Q5] outbox spirit — atomic with the thing it summarizes).
   So the fast-path read hits the `balances` row, but it's **always reconcilable**: a background
   job periodically recomputes `SUM(ledger)` and asserts it equals the cached balance, catching
   any drift. The ledger is truth; the balance column is a **checkable cache**.
3. **The append-only ledger never goes away** — it's the legal record, the audit trail, and the
   recovery mechanism. If the cached balance is ever wrong (bug, partial write), you **rebuild it
   from the ledger**, which is immutable and complete.

So the reconciliation of purity and performance: **the immutable double-entry ledger is the
source of truth (auditable, reconstructable, sums to zero globally); the current balance is a
materialized cache updated atomically with the entries and periodically re-verified against the
ledger.** You get O(1) balance reads *and* a perfect audit trail, with the invariant that the
cache is always derivable from — and checked against — the truth. The thing you never do is make
a mutable `balance` column the *source of truth*, because then you've lost history, auditability,
and the ability to ever prove the number is right. The deep principle: **for money, store the
events (immutable, append-only), derive the state — never store only the state.** That's event
sourcing, and finance invented it centuries before software did.

──────────
> **[BANK]** Model money as a **double-entry, append-only ledger**: every transaction = signed
> entries that **sum to zero** (debit A, credit B); the global sum of all entries is always
> zero (the checkable invariant). Entries are **immutable** — correct mistakes with reversing
> entries, never `UPDATE`/`DELETE`. Balance is **derived** (`SUM`), with a **materialized
> balance cache** updated atomically with entries and periodically re-verified against the
> ledger. Store events, derive state.
> **[TRAP]** A mutable `accounts.balance` column as source of truth — destroys history/
> auditability, races on the hot row, can't be proven correct. The ledger isn't optional at a
> payments company.
> **[GO DEEPER]** loop [R2.Q6] transactional atomicity · [I03.Q4] concurrent debits · [I03.Q7]
> event sourcing/audit · [I03.Q6] reconciliation.

---

### [I03.Q3] "A customer clicks 'Pay' twice. Or the network retries. They get charged once. How?"  ·  ★★★★★

**Interviewer:** Double-click, network retry, mobile app resends on timeout — the same payment
request arrives at your API two, three times. The customer must be charged **once**. Design it.

**Candidate:** This is **idempotency**, and it's *the* foundational discipline of a payments API
(loop [R1.Q6] — at-least-once delivery is reality, so processing must be idempotent). The client
attaches an **idempotency key** — a unique token *they* generate per logical operation — and the
server guarantees that **all requests with the same key produce the same single effect**.

The flow:
```
 POST /charges
 Idempotency-Key: 8f3a-...(client-generated, unique per logical payment)

 server:
   1. look up the key in an idempotency store
   2a. NEW key   → process the charge, store (key → result) atomically, return result
   2b. SEEN key, completed → return the STORED result, do NOT charge again
   2c. SEEN key, in-flight  → the original is still processing → block/wait or return 409
```

The critical implementation details that separate correct from broken:
1. **The key + result are stored atomically with the charge.** Recording "I processed key X →
   result R" must be in the **same database transaction** as the charge's ledger entries (loop
   [R5.Q5] inbox pattern). Otherwise: charge succeeds, crash before recording the key, retry
   comes in, key not found, **double charge**. The dedup record and the effect are one atomic
   unit.
2. **Handle the concurrent in-flight case.** Two requests with the same key arrive
   *simultaneously* (the double-click race). A naive "check then insert" has a TOCTOU race —
   both check (not found), both charge. Fix with a **unique constraint on the idempotency key**:
   the first `INSERT` wins, the second gets a uniqueness violation and is rejected/made to wait
   for the first's result. The database's unique index is the serialization point.
3. **Store the *response*, not just a flag** — so a retry returns the **identical** result
   (same charge id, same status), making the operation truly indistinguishable from a single
   call to the client.
4. **Scope and expiry** — keys are scoped (per account/endpoint) and retained long enough to
   cover any realistic retry window (hours to 24h), then expired.
5. **Bind the key to the request content** — store a hash of the request body; if the same key
   arrives with a *different* body (client bug reusing a key), reject it rather than silently
   returning the old result for a new intent.

**Interviewer:** That protects *your* database. But the actual charge goes to a card network you
don't control, over a connection that can time out. You sent the charge, got no response. Did it
happen? Now what?

**Candidate:** This is the genuinely hard part, and it's the heart of payments: **the external
card network is a non-transactional, possibly-non-idempotent system you reach over an unreliable
network, so a timeout is fundamentally ambiguous** — the charge may have succeeded, failed, or be
in-flight, and you *don't know which* (loop [R1.Q6], Two Generals). You cannot just retry blindly
— that risks a double charge at the network.

The disciplines:
1. **Propagate idempotency to the network.** Modern card networks and processors support their
   **own idempotency keys / unique transaction references**. So you send your charge with a
   **deterministic idempotency token**, and if you time out and retry with the *same* token, the
   **network** deduplicates it — the retry either returns the original result or completes the
   one in-flight, never creates a second charge. You've pushed at-least-once + idempotency one
   layer out (loop [R3.Q3] — exactly the closed-world-boundary lesson).
2. **For a network that lacks idempotency, never blind-retry — *query* first.** Before retrying
   an ambiguous timeout, **look up the transaction's status** by your reference (a status/inquiry
   API). If it already succeeded, record that; if it truly never landed, *then* retry. Verify
   before re-acting.
3. **Model the charge as a state machine with a PENDING state.** The charge isn't binary
   success/fail; it's `PENDING → SUCCEEDED / FAILED`, and an ambiguous timeout leaves it
   **PENDING**, not retried-into-oblivion. A reconciliation process (loop [I03.Q6]) resolves
   PENDING charges against the network's settlement/report — the network's daily file is the
   eventual source of truth that collapses the ambiguity.
4. **Make the whole thing recoverable, not real-time-perfect.** You accept that *at the instant
   of the timeout* you don't know the answer; you guarantee that **eventually**, via idempotent
   retries + status queries + reconciliation, the customer is charged exactly once and your
   records match the network's. Correctness is eventual and reconciled, not instantaneous.

So the layered answer: **idempotency keys protect your own API (atomic key+effect, unique
constraint for races, store the response); at the external network boundary you extend
idempotency to the processor's own keys, query-before-retry on ambiguous timeouts, model charges
as PENDING state machines, and reconcile against settlement as the eventual truth.** The thing
you never do is treat a timeout as "failed, just retry" — that's how double charges happen, and
at a payments company a double charge is a sev1.

──────────
> **[BANK]** Idempotency = client-supplied **idempotency key**; store **(key → full response)
> atomically with the effect** (same DB txn, or a crash double-charges); use a **unique
> constraint** on the key to serialize concurrent double-clicks (no TOCTOU); bind key→request
> hash. At the **external card-network boundary**, extend idempotency to the processor's keys,
> **query status before retrying** an ambiguous timeout, model charges as **PENDING** state
> machines, and **reconcile against settlement** as eventual truth — never blind-retry a timeout.
> **[TRAP]** Check-then-insert race (double charge); storing only a flag not the response;
> recording the key in a separate txn from the charge; blind-retrying an ambiguous network
> timeout.
> **[GO DEEPER]** loop [R1.Q6] at-least-once + idempotency · loop [R3.Q3]/[R5.Q5] EOS &
> outbox/inbox · [I03.Q6] reconciliation resolving PENDING.

---

### [I03.Q4] "Two withdrawals hit the same account at the same instant. Balance is $100, each wants $80. What happens?"  ·  ★★★★★

**Interviewer:** Account has $100. Two concurrent withdrawals of $80 arrive at the same
millisecond. The account must not go to −$60. Walk me through preventing it, and the tradeoffs.

**Candidate:** This is the **lost-update / concurrent-debit** problem (loop [R2.Q6] — snapshot
isolation alone doesn't catch it), and for money the invariant "balance ≥ 0" must hold under
concurrency. Both transactions read $100, both see "enough for $80," both proceed → −$60. The
defenses, with their tradeoffs:

**1. Pessimistic locking — `SELECT ... FOR UPDATE`.**
```
 BEGIN
   SELECT balance FROM ... WHERE account_id = ? FOR UPDATE   -- locks the row
   -- now the second txn BLOCKS here until the first commits
   if balance >= 80: insert debit entries; commit
   else: reject (insufficient funds)
```
The first withdrawal **locks the account row**; the second **blocks** until the first commits,
then re-reads the *new* balance ($20), sees it's insufficient, and is correctly rejected. Correct
and simple. **Cost:** it **serializes all activity on that account** — under high contention on a
hot account (a popular merchant, a treasury account), this lock becomes a throughput bottleneck,
and you risk **deadlocks** if transactions lock multiple accounts in different orders (mitigate by
always locking accounts in a canonical order, e.g. by id).

**2. Optimistic concurrency — version/conditional update.**
```
 read balance + version
 UPDATE ... SET balance = balance - 80, version = version + 1
   WHERE account_id = ? AND version = ? AND balance >= 80
 if rows_affected == 0:  someone else changed it (or insufficient) → retry or reject
```
No held locks; the `WHERE balance >= 80` makes the check-and-debit **atomic in one statement**,
and the version (or the balance condition itself) detects a concurrent modification. **Cost:**
under high contention you get **lots of retries** (livelock-ish), so it's best when contention is
*low*; the `WHERE balance >= 0` guard is the key — it pushes the invariant into the database so
the debit *cannot* drive it negative regardless of races.

**3. The ledger-native version** (preferred at a payments company): since the balance is derived
from the append-only ledger (loop [I03.Q2]), you enforce the invariant at insert time — atomically
append the debit entry *only if* the current derived balance permits it, using either the locked
read or a conditional insert guarded by the running balance. The atomic conditional debit is the
cleanest: the operation is "append −$80 iff resulting balance ≥ 0," done in one transaction.

**Interviewer:** High-throughput hot account — say a marketplace's float account taking thousands
of debits a second. Pessimistic locking serializes it; optimistic thrashes. Now what?

**Candidate:** When a single account is genuinely a write hotspot, you stop trying to serialize on
one row and **redesign the contention away** — several techniques from the toolkit:

1. **Sharded / split balances ("balance striping").** Split the hot account's balance into **N
   sub-balances** (shards), and route each debit to one shard (by hash). The true balance is the
   `SUM` of shards, but **writes spread across N rows**, so contention drops ~N×. This is the
   account-level version of the hash-sharded-index trick (Interview [02.Q1]) and false-sharing
   padding (Interview [01.Q3]) — spread the hot thing across independent units. The tradeoff: a
   debit that exceeds one shard's balance needs to "borrow" across shards (more complex), and
   reading the exact balance means summing shards.
2. **Reservation / two-phase model.** Instead of debiting synchronously under contention,
   **reserve** funds (a pending hold) quickly, then settle asynchronously — common in payments
   (an authorization holds the amount; capture settles later). The hold is a lighter-weight
   operation and the heavy reconciliation happens off the hot path.
3. **Serialize through a queue / single-writer per account.** Route all operations for a given
   account through a **single consumer** (partition by account_id, loop [R3.Q5]) so there's **no
   concurrent contention at all** — one writer processes that account's debits sequentially from
   a queue. This is the actor model / the LMAX single-writer principle (Interview [01.Q5]):
   instead of locking to *handle* concurrency, you *eliminate* concurrency for that account by
   funneling it to one owner. Throughput per account is bounded by one consumer, but there are no
   locks, no deadlocks, no retries, and ordering is natural.

So the escalation: **`FOR UPDATE` (correct, simple, serializes the account) for normal accounts;
optimistic conditional update with a `balance >= 0` guard for low contention; and for genuinely
hot accounts, eliminate the contention — stripe the balance, use reservations, or funnel the
account through a single-writer queue.** The deep point the panel wants: the database invariant
(`balance >= 0`, enforced by a lock or a conditional) guarantees *correctness*, but **scaling a
hot account is about removing the contention, not locking harder** — and the cleanest way to
remove contention is to give each account a single writer, which is the same single-writer lesson
that shows up in lock-free queues and Kafka partitions. Never let "balance ≥ 0" be enforced only
in application code that read the balance a moment ago — it must be atomic at the storage layer.

──────────
> **[BANK]** Concurrent debits → prevent negative balance with a **storage-level atomic guard**:
> `SELECT ... FOR UPDATE` (serializes the account — simple, but a hotspot/deadlock risk) or an
> **optimistic conditional** `UPDATE ... WHERE balance >= amount` (no locks, retries under
> contention). The invariant must be **atomic in the DB**, never "check in app code then write."
> Hot accounts: **stripe the balance across N shards**, use **reservations/holds**, or **funnel
> the account through a single-writer queue** (eliminate contention, not lock harder).
> **[TRAP]** Read balance in app, decide, then write (TOCTOU → negative balance); locking harder
> on a hot account instead of removing the contention; inconsistent lock ordering → deadlock.
> **[GO DEEPER]** loop [R2.Q6] lost update / `FOR UPDATE` · Interview [01.Q5] single-writer ·
> [02.Q1] sharding the hotspot · loop [R3.Q5] partition-by-key.

---

### [I03.Q5] "Money leaves account A and must arrive in account B. They're in different services. Don't lose a cent."  ·  ★★★★★

**Interviewer:** A transfer: debit account A (in the wallet service), credit account B (in a
different service / bank). Two systems, no shared transaction. A crash mid-way must not vaporize
or duplicate money. Design it.

**Candidate:** This is the **distributed-transaction / dual-write problem for money** (loop
[R3.Q7] sagas, [R5.Q5] outbox), and the stakes make the discipline non-negotiable: a crash
between "debit A" and "credit B" must never leave money **debited but not credited** (vanished)
or **credited twice** (created). Since there's no 2PC across the two systems (and you wouldn't
want its blocking anyway), the answer is a **saga with compensations + idempotency + an outbox**,
built so every intermediate state is recoverable.

The transfer as a saga of local transactions:
```
 1. debit A      (local txn in wallet svc: append −$X to A's ledger, status=PENDING transfer)
 2. credit B     (local txn in svc B: append +$X to B, idempotent on transfer_id)
 3. mark complete
 failure handling:
   - if credit B fails permanently → COMPENSATE: refund/credit back A (reverse the debit)
```

The properties that make it lose-proof:
1. **Each step is a local ACID transaction** — debit A commits atomically in A's DB; credit B
   commits atomically in B's DB. No cross-system atomicity needed.
2. **Reliable handoff via the outbox** (loop [R5.Q5]). When you debit A, you write a "transfer
   initiated" **event into A's outbox in the same transaction** as the debit — so the intent to
   credit B is *durably recorded atomically with* the debit. It's impossible to debit A without
   the credit-B instruction existing. A relay then reliably delivers it to B (at-least-once).
3. **Credit B is idempotent** (loop [I03.Q3]) — keyed by `transfer_id`, so the at-least-once
   delivery (the relay may retry) credits B **exactly once**. Redelivery is a no-op.
4. **PENDING/escrow state** — the money debited from A sits in a **pending/in-transit** state
   (often modeled as a transfer through an intermediate "in-flight" ledger account) until B
   confirms. So at every instant, **the money is accounted for somewhere** — in A, in transit,
   or in B — never lost, and the double-entry invariant (global sum = 0) still holds (loop
   [I03.Q2]). This in-transit account is the ledger making the saga's intermediate state
   *visible and balanced*.
5. **Compensation for unrecoverable failure** — if crediting B is *permanently* impossible (B
   rejects, account closed), the saga **compensates**: reverse the debit, crediting A back (an
   explicit reversing ledger entry, loop [I03.Q2] — you don't delete the debit, you offset it).

**Interviewer:** Sagas have visible intermediate states — for a moment the money is "gone" from A
but not yet in B. A customer checking both accounts sees money missing. Is that acceptable, and
how do you bound it?

**Candidate:** It's acceptable **because the money isn't actually missing — it's in a defined
in-transit state** — but you must *model and surface* that honestly, and bound how long it lasts:

- **The money is never unaccounted for.** With the in-transit/escrow ledger account, A's
  available balance drops, B's hasn't risen yet, but the **double-entry books still sum to zero**
  — the funds are sitting in the "transfers in flight" account. So it's not lost; it's
  *visibly pending*. The UI shows it as "pending/processing," which is exactly how real banks
  show transfers — the intermediate state is **disclosed, not hidden**, and that's the honest
  design (loop [R3.Q7] — sagas trade isolation for availability, and you manage the lost
  isolation by *exposing* the pending state rather than pretending atomicity).
- **Bound the window with timeouts + reconciliation.** A transfer stuck PENDING beyond a
  threshold is escalated: retried (idempotently), or after a hard limit, **compensated** (refund
  A) and flagged. A reconciliation job (loop [I03.Q6]) continuously sweeps PENDING transfers and
  drives each to a terminal state (completed or reversed), so nothing lingers in-flight
  indefinitely.
- **Choose the failure direction deliberately.** For money you generally prefer to **fail toward
  "money returns to sender"** (compensate the debit) rather than "credit without confirmed
  debit" — never create money you're unsure was debited. And **irreversible steps go last** (loop
  [R3.Q7]): you don't, say, send a physical payout until the internal transfer is confirmed,
  because you can't un-send it.

So the complete answer: **a transfer is a saga — debit A (with an outbox event, atomically) →
idempotently credit B → compensate by reversing if B is unrecoverable — with the money always
parked in a balanced in-transit ledger account so it's never unaccounted for, the pending state
honestly surfaced to the user, and a reconciliation sweep bounding how long anything stays
in-flight.** It's eventually consistent, not atomic, and that's *correct* for cross-system money
movement; the engineering is in making every intermediate state recoverable and balanced, and in
choosing failure directions that never create or destroy money. "Just use a distributed
transaction" (2PC) would be the wrong answer — blocking, coupling two services' availability, and
still not spanning the external bank.

──────────
> **[BANK]** Cross-service transfer = **saga + outbox + idempotency**, never 2PC. Debit A and
> write a "transfer initiated" **outbox event in the same txn**; relay delivers (at-least-once)
> to **idempotently credit B** (keyed by transfer_id); **compensate** (reverse the debit) if B is
> permanently unrecoverable. Park the funds in a **balanced in-transit ledger account** so money
> is always accounted for (books sum to zero), surface PENDING honestly, bound it with timeouts +
> reconciliation, irreversible steps last, fail toward "return to sender."
> **[TRAP]** Dual-write debit-then-credit with no outbox (crash vanishes money); 2PC across
> services (blocking, couples availability, doesn't reach the external bank); hiding the pending
> state instead of modeling it as in-transit.
> **[GO DEEPER]** loop [R3.Q7] sagas/compensation · loop [R5.Q5] outbox/inbox · [I03.Q3]
> idempotent credit · [I03.Q2] in-transit account & reversing entries.

---

### [I03.Q6] "Your ledger says the customer has $5,000. The bank says $4,980. Who's right, and what do you do?"  ·  ★★★★☆

**Interviewer:** Your internal ledger and the external bank/processor's records disagree by $20.
Walk me through reconciliation — and which number you trust.

**Candidate:** **Reconciliation** is the process of continuously proving that your internal
records match the external source of truth, and the disagreement is *expected* — it's not a bug to
panic over, it's the normal state that reconciliation exists to **detect, explain, and resolve**.
The key principle: **for money that has left your system, the external party (the bank/network/
processor) is the ultimate source of truth for *settled* funds**, while your ledger is the source
of truth for your *internal* accounting and intent. They diverge transiently and must be
reconciled.

Why they legitimately differ:
- **Timing.** A charge you recorded as SUCCEEDED may not have **settled** yet at the bank (auth vs
  capture vs settlement happen over hours/days). Your ledger is "ahead." The $20 may be an
  in-flight transaction.
- **Fees.** The processor deducts fees you haven't booked yet, or booked differently.
- **PENDING ambiguity** (loop [I03.Q3]) — a charge you're unsure about (timeout) sits PENDING; the
  bank's record resolves it.
- **Genuine error** — a bug, a missed webhook, a duplicated entry.

**Interviewer:** Concretely — how does the matching actually run, and what do you do with the
items that *don't* match?

**Candidate:** It's a three-way match with an exceptions workflow, and the discipline is that
*every* item reaches a terminal state. The reconciliation process:
1. **Ingest the external truth** — the processor/bank sends a **settlement file / report**
   (daily, or via webhooks) listing every transaction *they* know about with *their* status and
   amount. This is the authoritative record for settled money.
2. **Match** each external record against your ledger entries by a shared reference (transaction
   id). Three-way outcomes:
   - **Matched** (amount + status agree) → reconciled, done.
   - **In your ledger, not in theirs** → you think it happened, they don't. Maybe in-flight
     (wait), maybe a phantom you created (investigate/reverse).
   - **In theirs, not in yours** → they processed something you didn't record (a missed webhook,
     a chargeback) → you must **book it** (append the ledger entries to catch up).
3. **Resolve the discrepancies** — most auto-resolve (timing: re-check next cycle once settled).
   Persistent unmatched items go to an **exceptions queue** for investigation, and **PENDING
   charges are driven to terminal state** by the bank's report (the report collapses the
   timeout-ambiguity from [I03.Q3]).
4. **Never silently overwrite.** You don't just set your ledger to the bank's number — you append
   **correcting entries** (loop [I03.Q2], immutable ledger) that explain *why* it changed, so the
   audit trail records the reconciliation itself. The $20 gets a documented entry (a fee, a
   settlement adjustment, a correction), not a silent overwrite.

So "who's right": **the bank is authoritative for settled funds, your ledger for internal intent
— and the $20 is almost always a timing or fee difference that reconciliation explains, not a
loss.** You trust the external settlement record as truth for money that's left your system,
investigate genuine mismatches via the exceptions queue, and resolve everything with **explicit,
auditable correcting entries** rather than overwrites. The framing the panel wants: **a payments
system is never instantaneously consistent with the outside world — correctness is *eventual and
reconciled*, and reconciliation (matching against the external source of truth, with an
exceptions process) is a first-class, continuously-running part of the system, not an afterthought.**
A company that doesn't reconcile doesn't actually know if its money is right.

──────────
> **[BANK]** **Reconciliation** = continuously matching your ledger against the external **source
> of truth** (bank/processor **settlement file**/webhooks) by transaction id. Mismatches are
> *expected* (timing: auth vs settle, fees, PENDING) — auto-resolve most, route persistent ones to
> an **exceptions queue**, and resolve with **explicit correcting ledger entries** (never silent
> overwrite — preserve audit trail). The external party is authoritative for **settled** funds.
> Correctness is **eventual and reconciled**, not instantaneous.
> **[TRAP]** Treating any internal-vs-external mismatch as a bug/panic (most are timing/fees);
> silently overwriting your ledger to match the bank (destroys audit trail); not reconciling at
> all (you don't actually know your money is right).
> **[GO DEEPER]** [I03.Q3] PENDING charges resolved here · [I03.Q2] correcting entries · loop
> [R3.Q8] eventual consistency.

---

### [I03.Q7] "A regulator asks: prove this customer's balance was correct on a specific day two years ago. Can you?"  ·  ★★★★☆

**Interviewer:** Compliance/audit scenario. A regulator (or a dispute, or a lawsuit) demands you
demonstrate exactly what a customer's balance was on a given date two years ago, and justify every
movement. Can your system answer that, and what makes it possible?

**Candidate:** Yes — and the ability to answer this is *precisely why* the system is built as an
immutable, append-only, double-entry ledger (loop [I03.Q2]) rather than a mutable balance. This
question is the **payoff of event sourcing**: because we **store every event (entry) immutably and
derive state**, we can reconstruct the **exact state at any past point in time** by replaying the
ledger up to that timestamp.

What makes it possible:
1. **Immutable, append-only history.** No entry is ever updated or deleted (loop [I03.Q2]).
   Corrections are *additional* reversing entries, timestamped. So the complete, ordered history
   of every movement exists permanently. The balance on `2023-03-15` = `SUM(entries WHERE
   created_at <= '2023-03-15')` — a deterministic replay. This is **temporal / point-in-time query
   ability** as a first-class property.
2. **Every entry is explained and traceable.** Each ledger entry carries its `txn_id`, the
   counterparty, the reason/type, and links back to the originating event (the charge, the
   transfer, the fee). So I can not only show the *balance* but **justify every delta** — "on this
   date it was $5,000; it became $4,920 because of charge X (here's the idempotency key, the
   processor reference, the reconciliation status)." A full, navigable causal chain.
3. **Audit metadata.** Entries are timestamped with both **when the event occurred** and **when it
   was recorded** (bitemporal — important when a backdated correction is booked: you can show both
   "as of the transaction date" and "as we knew it at the time"), plus who/what initiated it. This
   bitemporality answers "what did you *believe* the balance was on that day" vs "what do you *now
   know* it should have been" — distinct questions a regulator may ask.
4. **Tamper evidence.** Because the ledger is append-only and the global invariant (sum = 0) holds,
   and because many systems add **cryptographic hashing/chaining** (each entry hashes the previous,
   a hash chain / Merkle structure — Interview [17] blockchain territory) or write to **WORM
   (write-once-read-many) storage**, you can *prove the history wasn't altered after the fact* —
   which is what "audit-grade" really means.

**Interviewer:** Storage and privacy collide with "keep everything forever." How do you reconcile
immutability with regulations that say you must *delete* a customer's data (GDPR right to erasure)?

**Candidate:** This is a genuine tension — **immutable financial records vs the right to be
forgotten** — and the resolution is to **separate the financial facts (which law requires you to
keep) from the personal data (which law may require you to delete)**:

- **Financial records have a *retention obligation* that usually overrides erasure.** Anti-money-
  laundering (AML), tax, and financial regulations typically *mandate* keeping transaction records
  for years (often 5–7+), and GDPR explicitly carves out data you're **legally required to retain**
  — the right to erasure isn't absolute when another law compels retention. So the *ledger entries*
  (amounts, dates, the financial facts) generally stay, because you're legally bound to keep them.
- **Pseudonymization / tokenization.** You keep the immutable *financial* facts but **separate the
  personal identifiers**. The ledger references a customer by an internal id/token; the **PII
  (name, address, card number) lives in a separate store** that *can* be redacted/deleted or
  crypto-shredded without touching the financial history. So you erase the *person's identifiable
  data* while the *anonymized transaction record* survives for compliance — the entry still says
  "$80 moved on this date," it just no longer points to retrievable personal details.
- **Crypto-shredding** — encrypt PII with a per-customer key and, to "delete," **destroy the key**.
  The encrypted data is now unrecoverable (effectively erased) while the immutable record's
  *structure* is intact. This squares "append-only, never delete" with "make this data
  unrecoverable."
- **Card data specifically** is governed by **PCI-DSS** — you typically don't even store raw card
  numbers; you **tokenize** them (a vault returns a token; the real PAN never touches your ledger),
  so there's less sensitive data to reconcile against erasure in the first place.

So the reconciliation: **the immutable ledger keeps the financial *facts* (legally mandated
retention, audit-grade, tamper-evident), while personal/identifying data is separated and made
erasable via tokenization and crypto-shredding** — you don't delete the transaction, you delete the
*ability to tie it to an identifiable person*, satisfying both the retention obligation and the
erasure right. The senior framing the panel wants: **auditability and event-sourced immutability
are what let you prove correctness years later (replay the ledger to any timestamp, justify every
delta, prove non-tampering), and the privacy tension is resolved by separating durable financial
facts from erasable personal data — not by compromising the ledger's immutability.** The whole
architecture — append-only, double-entry, idempotent, reconciled — exists so that the answer to
"prove it" is always *yes*.

──────────
> **[BANK]** Event-sourced immutable ledger → **point-in-time provable correctness**: balance at any
> past date = replay entries up to that timestamp; every delta is traceable to its originating event
> (bitemporal: event-time vs record-time); append-only + sum-zero + hash-chaining/WORM = tamper
> evidence. Reconcile immutability vs **GDPR erasure** by **separating durable financial facts (legal
> retention obligation, AML/tax) from erasable PII** via **tokenization + crypto-shredding** (destroy
> the key) — delete the link to a person, not the transaction.
> **[TRAP]** A mutable balance can't answer "prove it two years ago"; thinking GDPR forces deleting
> financial records (retention law overrides; you erase PII, not the ledger fact); storing raw card
> numbers instead of tokenizing (PCI-DSS).
> **[GO DEEPER]** [I03.Q2] the immutable ledger this relies on · Interview [17] hash-chaining/Merkle ·
> [I03.Q6] reconciliation as part of the audit story.

---

## Closing note — the payments floor

Every answer bent toward the same north star: **money demands correctness over convenience, and an
audit trail over a fast path.** Floats are banned because books must balance to the penny; balances
are *derived from* an immutable double-entry ledger because you must be able to prove every number;
idempotency is everywhere because at-least-once is reality and a double charge is rent; cross-system
transfers are sagas with in-transit accounts because money must always be *accounted for somewhere*;
and reconciliation runs forever because you're never instantaneously consistent with the outside
world. The candidate who wins here has internalized that a payments system is, at heart, an
**accounting system with a recovery process** — eventual, reconciled, immutable, paranoid — and that
"it usually works" is the wrong sentence to ever say about someone's money.

→ Back to the [interview floor](./00-interviews-index.md) · related: loop
[R3.Q3](../03-round-3-distributed-messaging.md) (EOS), [R3.Q7](../03-round-3-distributed-messaging.md)
(sagas), [R5.Q5](../05-round-5-bar-raiser.md) (outbox), Interview [06](./interview-06-streaming-platform.md).
