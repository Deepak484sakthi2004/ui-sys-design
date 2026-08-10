# Chapter 16 — Schema Registry and Schema Evolution
### How to Change Your Mind Without Breaking Everything

---

A Kafka topic stores bytes. Bytes mean nothing without an interpretation
— a schema that says "the first four bytes are an integer order ID, then
a UTF-8 string customer name, then..." For a single producer and a
single consumer who both ship together, the schema can be implicit:
both sides know what the bytes mean because the same team writes both.

For anything larger, that breaks. A topic that has fifteen producers and
forty consumers cannot rely on tribal knowledge. When the producer team
adds a new field, what happens to the forty consumers? When a consumer
team needs the field as `Long` but the producer is sending `Int`, who
mediates? When two teams ship at different times and disagree about the
schema, what's the ground truth?

**Schema Registry** is the mediation layer. It is a separate service —
not part of Kafka itself, but ubiquitous in production deployments —
that stores schemas, assigns versions, enforces compatibility rules,
and is consulted by serializers and deserializers to encode and decode
records. When you write to Kafka, the bytes have a small prefix
identifying the schema version; consumers fetch the schema from the
registry to decode.

This chapter:

- Why schemas need a registry, and what goes wrong without one.
- The Schema Registry architecture (Confluent's, the most widely used).
- Avro, Protobuf, and JSON Schema as schema languages — strengths and
  weaknesses.
- Compatibility levels: backward, forward, full, transitive — what
  each enforces and what they enable.
- The wire format of schema-registered records.
- Schema evolution patterns and the migration trap.
- Alternatives: the topic-level schema, decentralised registries.

By the end you should be able to design a schema strategy for a
production Kafka deployment and predict what will and won't break when
a schema changes.

---

## 16.1 Why a registry?

Without a registry, schemas live in code. Producer team A defines an
Avro schema in their repository, ships it as part of their service.
Consumer team B has the same schema in their repository (a copy, hopefully
in sync). When A updates the schema, B has to update theirs too.

This is the integration hairball, in schema form. It does not scale.

Production failures from this approach are diverse:

- **Drift.** Producer adds a field; consumer's copy of the schema
  doesn't include it; consumer crashes on the new field or silently
  drops it.
- **Implicit assumption.** Producer changes a field's type; consumer
  reads the bytes assuming the old type; crashes or worse, silent
  corruption.
- **Lost meaning.** A new team starts consuming the topic; they have
  to reverse-engineer the format from sample bytes; they get it
  wrong; they ship.
- **No deletion.** A field is no longer used; everyone forgets it
  exists; it stays in the schema (and the records) forever.
- **No audit.** When did this schema change? Who changed it? What did
  it look like before? You cannot answer.

A schema registry solves all of these.

---

## 16.2 Schema Registry architecture

The reference implementation is **Confluent Schema Registry**, an open-source
component (Confluent Community License). Other implementations exist
(Apicurio Registry, AWS Glue Schema Registry); the wire protocol is
similar enough that they can mostly interoperate.

```
                ┌──────────────────────────────────────┐
                │       SCHEMA REGISTRY (REST)         │
                │                                       │
                │   POST /subjects/<topic>-value/versions│
                │   GET  /schemas/ids/<id>              │
                │   GET  /subjects/<subject>/versions   │
                │   PUT  /config/<subject>              │
                └──────────────┬────────────────────────┘
                               │
                               │ stores schemas in
                               ▼
                       ┌────────────────┐
                       │  KAFKA topic:  │
                       │  _schemas      │  ← compacted, replicated
                       └────────────────┘

   Producer:                              Consumer:
   ─────────                              ─────────
   record → Avro Encoder → REGISTRY       BYTES → REGISTRY
                          GET schema by ID  → GET schema by ID
            BYTES with                       Avro Decoder → record
            schema-ID prefix
            ↓
            KAFKA topic
```

The Registry is itself a Kafka client: schema metadata lives in the
internal `_schemas` topic, compacted, replicated. The Registry process
acts as a coordinator and HTTP front end — multiple Registry instances
can run for HA, with one elected as leader to handle writes.

### 16.2.1 Subjects

A "subject" is a logical schema namespace, typically named after the
topic it serves. The conventions:

- `<topic>-value` — the value schema for `<topic>`.
- `<topic>-key` — the key schema for `<topic>` (if keys are also
  schema-encoded).

Each subject has a sequence of schema **versions**. Versions are
numbered starting at 1; new schemas get the next version number when
registered.

Each schema also has a global **schema ID** (a 32-bit integer,
unique across all schemas in the registry), assigned at registration
time. The wire format references schema by ID, not by version — IDs
are unique cluster-wide and stable.

### 16.2.2 The wire format

A record produced via a schema-aware serializer (like
`KafkaAvroSerializer`) has this on-the-wire layout:

```
Byte 0:        Magic byte (0x00)
Bytes 1-4:     Schema ID (big-endian int32)
Bytes 5+:      The actual encoded payload (Avro/Protobuf/JSON Schema)
```

5 bytes of overhead per record. Tiny.

Consumer side: read magic byte (validate 0x00), read schema ID, fetch
schema from registry (cached locally), decode payload. The first record
with a new schema ID triggers a registry call; all subsequent records
with the same ID hit the local cache.

---

## 16.3 Avro, Protobuf, JSON Schema

Schema Registry supports three serialization formats. Each has its
own trade-offs.

### 16.3.1 Avro

The original — Schema Registry was designed around Avro.

Strengths:
- **Compact binary encoding.** No field names or tags in the payload;
  schema describes the layout.
- **Sophisticated evolution rules.** Backward / forward compatibility
  is well-specified.
- **Schema-as-data.** Avro schemas are themselves JSON, easy to
  generate / inspect.

Weaknesses:
- **Schema is required to decode.** You cannot decode an Avro record
  without the schema. (This is also a strength — no encoding ambiguity.)
- **Less language coverage than Protobuf.** Avro has good Java, Python,
  C# support; weaker for some niche languages.
- **Generic record vs specific record** is a footgun: developers
  often start with generic records (works without code generation)
  then realise typed records are easier; refactor cost is real.

Use Avro when: you're in a Java-heavy ecosystem, you have control over
producer/consumer code, and you want the most compact wire format.

### 16.3.2 Protobuf

Google's wire format.

Strengths:
- **Universal language coverage.** Protobuf has excellent support
  in everything.
- **Field tags are baked in.** Each field has a numeric tag in the
  wire format, so adding/removing fields by tag is straightforward.
- **Strong type system.** Enums, oneofs, maps, well-known types.

Weaknesses:
- **Schemas are .proto files**, separate from code, with their own
  compiler. More tooling, more gotchas.
- **Default-value semantics differ from Avro.** Protobuf's "missing"
  field is not the same as "field set to default" — surprises lurk.
- **gRPC's tight integration with Protobuf colours people's
  expectations.** Schema Registry's Protobuf support is independent of
  gRPC.

Use Protobuf when: you have a polyglot ecosystem, you already use
Protobuf for gRPC, or you need maximum cross-language compatibility.

### 16.3.3 JSON Schema

Schemas in JSON Schema; payloads in JSON.

Strengths:
- **Human-readable on the wire.** Easy to debug.
- **Universal tooling.** Every language can produce/consume JSON.
- **Draft-07 / Draft-2020-12** schemas are mature and expressive.

Weaknesses:
- **Big payloads.** Field names repeated per record, plus quoting
  overhead.
- **Limited evolution semantics.** JSON Schema's compatibility rules
  are looser than Avro's.
- **Numbers are tricky.** JSON's "number" doesn't distinguish int
  from float; schemas help but loose typing leaks through.

Use JSON Schema when: you need human readability, your traffic
volume is modest, or you have non-JVM consumers that prefer JSON.

---

## 16.4 Compatibility levels

Schema Registry enforces **compatibility** between schema versions.
When a producer attempts to register a new schema version, the
registry checks: is this new schema compatible with previous
versions, according to the configured rule?

If not, registration fails. This is the Registry's most important
operational role — it prevents incompatible schema changes from
silently breaking consumers.

The levels:

| Level | "Can old consumers read new producer's records?" | "Can new consumer read old records?" |
|-------|--------------------------------------------------|--------------------------------------|
| **None** | (no checks) | (no checks) |
| **Backward** | Yes | (not checked) |
| **Backward Transitive** | Yes, against ALL older versions | (not checked) |
| **Forward** | (not checked) | Yes |
| **Forward Transitive** | (not checked) | Yes, against ALL older versions |
| **Full** | Yes | Yes |
| **Full Transitive** | Yes, all versions | Yes, all versions |

In practice:

- **Backward compatibility** lets producers upgrade *first*, consumers later. The new
  schema can be deserialised by code expecting the old schema. You can
  add optional fields, remove fields with defaults, change field
  types in carefully prescribed ways.
- **Forward compatibility** lets consumers upgrade *first*, producers later. Old
  producers' records can be deserialised by new consumer code.
- **Full compatibility** is both — order of upgrades doesn't matter.
- **Transitive** variants enforce against *all* prior versions, not
  just the immediately previous one. Use transitive in production —
  non-transitive can let you make changes that break against
  long-lived consumer versions.

Default is `BACKWARD`. For mature production, `FULL_TRANSITIVE` is the
gold standard but slows you down. Most teams settle on
`BACKWARD_TRANSITIVE` as a reasonable compromise.

### 16.4.1 What each format allows under "backward"

**Avro backward-compatible changes:**
- Add a field with a default value. (Old readers ignore it; new
  readers see the default for old records.)
- Remove a field that had a default. (New readers fall back to default
  for old records that still had the field.)
- Change a field type to a wider type (int → long, float → double, in
  some cases).

**Avro backward-incompatible changes:**
- Add a required field (no default).
- Remove a required field.
- Rename a field (this is removing one and adding another, not a rename).
- Change a field's type to a narrower or incompatible type.

**Protobuf backward-compatible changes:**
- Add new fields with new tag numbers.
- Mark fields as `optional` instead of `required`.
- Remove `optional` fields (the tag remains "reserved" so it can't be
  reused).

The exact rules are format-specific; consult the format's spec when
in doubt.

---

## 16.5 Schema evolution patterns

### 16.5.1 The additive pattern (most common)

Add new fields with defaults. Don't remove fields. Don't rename. Don't
change types. The schema grows over time, never shrinks.

This is the simplest pattern and works for almost every business need.
The cost is a slowly-bloating schema (fields nobody uses any more).

### 16.5.2 The deprecation cycle

When you really need to remove a field:

1. Mark the field as deprecated (a comment or annotation).
2. Update all consumer code to stop using it.
3. Wait until you're confident no consumer reads it.
4. Remove the field from the schema (either with a default to satisfy
   compatibility, or by accepting a breaking change at a new "major
   version" subject).

This typically takes weeks to months. Plan for it.

### 16.5.3 The version-bump pattern (rare)

For a true breaking change, create a new topic (`my-topic-v2`) with the
new schema. Run both topics in parallel for a migration period.
Producers dual-write; consumers gradually migrate from v1 to v2. Eventually
v1 is decommissioned.

This is operationally heavy but sometimes necessary. The pattern is
well-known and widely used.

### 16.5.4 The "I'll just turn off compatibility checks" trap

The Registry lets you disable compatibility checks per subject:

```
PUT /config/my-topic-value
{
  "compatibility": "NONE"
}
```

This is a foot gun. Once you have legacy code with old schemas, you cannot
predict what a new schema will break. Don't disable compatibility unless
you have a written migration plan.

---

## 16.6 Operational realities

### 16.6.1 Cache behaviour

Producers and consumers cache schemas locally. The default cache size
is 1000 schemas (configurable). For applications with many schemas
(or wide schema fan-out), raise the cache size.

A subtle issue: if the registry is unreachable, cached schemas still
work, but new schemas (or first-time fetches of an old schema) fail.
A producer trying to publish a record whose schema isn't cached will
fail; the task is dead until the registry is reachable.

For high availability, deploy multiple registry nodes behind a load
balancer.

### 16.6.2 The `_schemas` topic

This is where the registry persists schemas. Lose this topic, lose your
schemas. Treat it like the consumer-offsets topic: high replication,
high min-ISR, monitored.

A common production setting:

```properties
kafkastore.topic=_schemas
kafkastore.topic.replication.factor=3
```

### 16.6.3 Auth and permissions

Registry is HTTP-based. Authentication via:
- HTTP Basic Auth.
- mTLS.
- OAuth tokens.

Authorisation: role-based (read/write per subject), RBAC plugins for
Confluent Platform. The default is "anyone with network access can
do anything" — usually unsuitable.

Production-deploy registry behind a reverse proxy with proper auth.
Limit who can register schemas; broad write access leads to schema
sprawl.

### 16.6.4 Federation across clusters

Multi-cluster Kafka deployments often want a single source of truth
for schemas. Patterns:

- **One central registry** for all clusters. The schemas are global;
  cluster boundaries don't matter for serialisation.
- **Per-cluster registries** synced via MirrorMaker or a custom sync
  tool. More complex but allows cluster-local schema autonomy.

Pick based on whether your data is logically one universe (use
central registry) or genuinely independent per cluster (per-cluster
registries).

---

## 16.7 The "do I really need this?" question

Schema Registry is overkill for some deployments:

- A single team owning both producer and consumer.
- A topic with 1-2 stable schemas that almost never change.
- A research / experimental cluster where speed > correctness.

For these, Schema Registry adds operational weight without buying
much. JSON without a registry, with a documented schema in code, is
fine.

Schema Registry earns its complexity when:

- Multiple independent teams produce / consume.
- Schemas evolve continuously (a healthy product domain).
- Consumers need to handle records from arbitrary historical periods
  (replay, backfill).
- You have strict data-governance requirements (every schema change
  must be auditable).

Most production Kafka deployments above a certain size end up using
it.

---

## 16.8 Configurations that matter

### Registry server

```properties
listeners=http://0.0.0.0:8081
kafkastore.bootstrap.servers=PLAINTEXT://broker1:9092,broker2:9092
kafkastore.topic=_schemas
kafkastore.topic.replication.factor=3
schema.compatibility.level=BACKWARD            # or FORWARD, FULL, etc.
master.eligibility=true                        # for HA setup
```

### Producer (Avro example)

```properties
key.serializer=org.apache.kafka.common.serialization.StringSerializer
value.serializer=io.confluent.kafka.serializers.KafkaAvroSerializer
schema.registry.url=http://schema-registry:8081
auto.register.schemas=true                      # producer registers if schema not present
use.latest.version=false                        # use the schema embedded in the record
```

### Consumer

```properties
key.deserializer=org.apache.kafka.common.serialization.StringDeserializer
value.deserializer=io.confluent.kafka.serializers.KafkaAvroDeserializer
schema.registry.url=http://schema-registry:8081
specific.avro.reader=true                        # use generated SpecificRecord, not GenericRecord
```

`auto.register.schemas=true` is convenient but production-dangerous —
any producer can introduce new schemas. In production, set this to
false and have a CI pipeline that registers schemas via tested,
reviewed PRs.

---

## Summary box

- Schema Registry stores schemas, assigns versions and IDs, enforces
  compatibility.
- Records on the wire have a 5-byte prefix: magic byte + 32-bit
  schema ID. Consumers fetch schemas by ID and cache them.
- **Avro, Protobuf, JSON Schema** are the three supported formats.
  Each has different evolution rules and trade-offs.
- **Compatibility levels** (backward / forward / full, with transitive
  variants) determine what schema changes are allowed.
- The **additive pattern** (add fields, never remove) is the simplest;
  more complex evolutions require deprecation cycles or version-bumps.
- The `_schemas` topic is critical infrastructure; replicate, monitor,
  protect.
- `auto.register.schemas=true` is convenient in dev, dangerous in
  production. Use a CI pipeline.

## Further reading

- *Avro 1.11 Specification* — particularly the section on schema
  resolution rules.
- Confluent's Schema Registry documentation — long but thorough.
- KIP-69: Kafka Schema Registry (the original).
- Apicurio Registry's documentation — alternative implementation,
  same wire protocol.

## War story: the schema that wasn't backward-compatible

A team deployed an Avro schema change. They added a new required field
(`tax_id`, no default). The Schema Registry was configured with
compatibility level `BACKWARD`. The registration succeeded.

Why? Because Avro's `BACKWARD` checks "can the new schema be used to
deserialise records produced with the OLD schema?" — and *adding a
field with no default is backward-compatible* in that direction
(records with the old schema lack the field; the new schema, when
reading, sees no field, but `BACKWARD` only checks that consumers
using the *new* schema can read records produced with the *old*; it
doesn't check the reverse).

But a *consumer* using the *old* schema reading records produced with
the *new* schema would crash on the new field — that's `FORWARD`
compatibility, which wasn't being checked.

The team's consumers ranged across many services on different deploy
schedules. As the new producer rolled out, consumer services on older
versions started seeing the new field, getting confused, in some
cases crashing.

The fix was twofold:

1. Roll back the producer (a `tax_id` field was added with a default
   value, making the schema change additive).
2. Change the compatibility level on the subject from `BACKWARD` to
   `FULL_TRANSITIVE`, ensuring future changes work in both directions.

Lesson: **`BACKWARD` is not the same as "safe"**. It allows changes
that break old consumers. For deployments where producers and
consumers ship independently, `FULL` (or transitive variants) is
worth the constraint.

I now treat schema compatibility level as a load-bearing config —
documented, reviewed, alarmed when changed. Setting it to `BACKWARD`
is a perfectly reasonable choice, but only if you have iron-clad
control over consumer rollout. Most teams don't.
