# Appendix A — Wire Protocol Reference
### A Compact Guide to the Kafka Protocol

---

This appendix is reference material — the byte-level structure of
key Kafka protocol messages, for engineers who need to look up exact
formats. Not all messages are listed; only the ones that come up
most often in debugging or implementing clients.

For the canonical reference, see the
`kafka.org/protocol` page and the
`org.apache.kafka.common.message.*` classes in the source.

---

## A.1 Common types

The Kafka protocol uses these primitive types:

| Type | Bytes | Notes |
|------|-------|-------|
| `BOOLEAN` | 1 | 0 = false, non-zero = true |
| `INT8` | 1 | Signed byte |
| `INT16` | 2 | Signed, big-endian |
| `INT32` | 4 | Signed, big-endian |
| `INT64` | 8 | Signed, big-endian |
| `UINT32` | 4 | Unsigned, big-endian (CRC, etc) |
| `VARINT` | 1-5 | ZigZag-encoded variable-length integer |
| `VARLONG` | 1-10 | Same, 64-bit |
| `STRING` | 2 + N | INT16 length followed by N UTF-8 bytes |
| `NULLABLE_STRING` | 2 + N or 0 | -1 length = null |
| `COMPACT_STRING` | varint + N | Same but length is varint+1 (KIP-482) |
| `BYTES` | 4 + N | INT32 length + bytes |
| `COMPACT_BYTES` | varint + N | KIP-482 |
| `RECORDS` | int32 + bytes | Embedded RecordBatch v2 |
| `ARRAY` | INT32 + items | Length, then N elements |
| `COMPACT_ARRAY` | varint + items | KIP-482 |
| `UUID` | 16 | KIP-516 |

KIP-482 introduced "compact" encoding (varint lengths) for newer
protocol versions. Older versions use the non-compact forms.

---

## A.2 Request / response framing

Every Kafka request:

```
Size                : INT32         (size of everything that follows)
RequestHeader       : (per version)
RequestBody         : (per API)
```

`RequestHeader` (v2):

```
api_key             : INT16     (which API — see table below)
api_version         : INT16     (which version of that API)
correlation_id      : INT32     (echoed back in response)
client_id           : NULLABLE_STRING
TaggedFields        : ...        (extensible, KIP-482)
```

Response:

```
Size                : INT32
ResponseHeader      : (per version)
ResponseBody        : (per API)
```

`ResponseHeader` (v1):

```
correlation_id      : INT32     (matches request)
TaggedFields        : ...
```

---

## A.3 API key table (selected)

| API key | Name | Notes |
|---------|------|-------|
| 0 | Produce | Producer → broker |
| 1 | Fetch | Consumer → broker, follower → leader |
| 2 | ListOffsets | Find offset by timestamp |
| 3 | Metadata | Topic / partition / broker info |
| 8 | OffsetCommit | Consumer commits offsets |
| 9 | OffsetFetch | Consumer reads its committed offsets |
| 10 | FindCoordinator | Find group / txn coordinator |
| 11 | JoinGroup | Group rebalance phase 1 |
| 12 | Heartbeat | Group membership |
| 13 | LeaveGroup | Voluntarily leave group |
| 14 | SyncGroup | Group rebalance phase 2 |
| 16 | ListGroups | Admin: list groups |
| 17 | SaslHandshake | SASL negotiation |
| 18 | ApiVersions | Negotiate supported API versions |
| 19 | CreateTopics | Admin |
| 22 | InitProducerId | Idempotence / transactions |
| 24 | AddPartitionsToTxn | Transaction |
| 25 | AddOffsetsToTxn | Consume-process-produce |
| 26 | EndTxn | Commit / abort transaction |
| 27 | WriteTxnMarkers | Internal: txn markers |
| 32 | DescribeConfigs | Admin |
| 36 | SaslAuthenticate | SASL |
| 50 | DescribeUserScramCredentials | Admin |
| 60 | DescribeCluster | Admin |
| 63 | AlterPartitionReassignments | Admin |
| 64 | DescribeProducers | Admin |
| 68 | ListTransactions | Admin |
| 80+ | (KIP-848 ConsumerGroupHeartbeat etc) | New consumer protocol |

The full table has ~70 entries. Most are admin / introspection.

---

## A.4 RecordBatch v2 (the main payload format)

This is the format of records on the wire (in `RECORDS` arrays in
ProduceRequest and FetchResponse) and on disk (in `.log` files).

```
RecordBatch:
  baseOffset           : INT64    (8)   set by broker on produce
  batchLength          : INT32    (4)   bytes from "magic" onward
  partitionLeaderEpoch : INT32    (4)   set by leader
  magic                : INT8     (1)   currently 2
  crc                  : UINT32   (4)   CRC32C of bytes after this field
  attributes           : INT16    (2)   compression / timestamp type / txn / control flags
  lastOffsetDelta      : INT32    (4)   = numRecords - 1
  baseTimestamp        : INT64    (8)
  maxTimestamp         : INT64    (8)
  producerId           : INT64    (8)   for idempotence
  producerEpoch        : INT16    (2)
  baseSequence         : INT32    (4)
  records              : ARRAY<Record>
```

Record (varint-heavy):

```
Record:
  length               : VARINT
  attributes           : INT8
  timestampDelta       : VARINT
  offsetDelta          : VARINT
  keyLength            : VARINT
  key                  : <keyLength> bytes
  valueLength          : VARINT
  value                : <valueLength> bytes
  headersCount         : VARINT
  headers              : ARRAY<Header>

Header:
  keyLength            : VARINT
  key                  : bytes
  valueLength          : VARINT
  value                : bytes
```

Attributes flags:

```
bit 0-2: compression codec (0=none, 1=gzip, 2=snappy, 3=lz4, 4=zstd)
bit 3:   timestamp type (0=create time, 1=log append time)
bit 4:   transactional (1 if this batch is part of a transaction)
bit 5:   control batch (1 if this is a transaction marker)
bit 6+:  reserved
```

The `records` array is **compressed as a unit** when compression is
enabled — not per-record.

---

## A.5 ProduceRequest (v9+)

```
ProduceRequest:
  transactionalId      : NULLABLE_STRING / COMPACT_NULLABLE_STRING
  acks                 : INT16          (0, 1, -1)
  timeoutMs            : INT32
  topicData            : COMPACT_ARRAY of {
    topic              : COMPACT_STRING
    partitionData      : COMPACT_ARRAY of {
      partition        : INT32
      records          : COMPACT_RECORDS   (RecordBatch v2)
      TaggedFields     : ...
    }
    TaggedFields       : ...
  }
  TaggedFields         : ...
```

Response:

```
ProduceResponse:
  responses            : COMPACT_ARRAY of {
    topic              : COMPACT_STRING
    partitionResponses : COMPACT_ARRAY of {
      partitionIndex   : INT32
      errorCode        : INT16
      baseOffset       : INT64           (offset of first record)
      logAppendTime    : INT64
      logStartOffset   : INT64
      recordErrors     : COMPACT_ARRAY of {batchIndex: INT32, message: COMPACT_STRING}
      errorMessage     : COMPACT_STRING
      TaggedFields     : ...
    }
    TaggedFields       : ...
  }
  throttleTimeMs       : INT32
  TaggedFields         : ...
```

---

## A.6 FetchRequest (v13+)

```
FetchRequest:
  cluster_id              : COMPACT_NULLABLE_STRING
  replica_id              : INT32         (-1 = consumer; broker_id = follower)
  max_wait_ms             : INT32
  min_bytes               : INT32
  max_bytes               : INT32
  isolation_level         : INT8          (0=read_uncommitted, 1=read_committed)
  session_id              : INT32         (KIP-227)
  session_epoch           : INT32
  topics                  : COMPACT_ARRAY of {
    topic_id              : UUID          (KIP-516)
    partitions            : COMPACT_ARRAY of {
      partition_id        : INT32
      current_leader_epoch: INT32
      fetch_offset        : INT64
      last_fetched_epoch  : INT32         (KIP-320)
      log_start_offset    : INT64
      partition_max_bytes : INT32
      TaggedFields        : ...
    }
    TaggedFields          : ...
  }
  forgotten_topics        : COMPACT_ARRAY of ...   (KIP-227)
  rack_id                 : COMPACT_STRING          (KIP-392)
  TaggedFields            : ...
```

---

## A.7 Common error codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | NONE | Success |
| 1 | OFFSET_OUT_OF_RANGE | Offset not in valid range |
| 2 | CORRUPT_MESSAGE | Record corrupted (CRC failure) |
| 3 | UNKNOWN_TOPIC_OR_PARTITION | Topic/partition not found |
| 5 | LEADER_NOT_AVAILABLE | Leader is being elected |
| 6 | NOT_LEADER_OR_FOLLOWER | Stale metadata, retry |
| 7 | REQUEST_TIMED_OUT | Server-side timeout |
| 9 | REPLICA_NOT_AVAILABLE | Replica is being created |
| 10 | MESSAGE_TOO_LARGE | Record exceeds limit |
| 11 | STALE_CONTROLLER_EPOCH | Controller fenced |
| 13 | NETWORK_EXCEPTION | Network problem |
| 14 | COORDINATOR_LOAD_IN_PROGRESS | Group coordinator loading |
| 15 | COORDINATOR_NOT_AVAILABLE | Try again later |
| 16 | NOT_COORDINATOR | Wrong broker for this group |
| 17 | INVALID_TOPIC_EXCEPTION | Topic name invalid |
| 18 | RECORD_LIST_TOO_LARGE | Batch too big |
| 19 | NOT_ENOUGH_REPLICAS | Below min.insync.replicas |
| 20 | NOT_ENOUGH_REPLICAS_AFTER_APPEND | After-append check failed |
| 22 | INVALID_REQUIRED_ACKS | Bad acks value |
| 25 | UNKNOWN_MEMBER_ID | Group member ID expired |
| 27 | REBALANCE_IN_PROGRESS | Group rebalancing |
| 28 | INVALID_COMMIT_OFFSET_SIZE | Offset commit too large |
| 29 | TOPIC_AUTHORIZATION_FAILED | ACL denied |
| 30 | GROUP_AUTHORIZATION_FAILED | ACL denied |
| 31 | CLUSTER_AUTHORIZATION_FAILED | ACL denied |
| 35 | UNSUPPORTED_VERSION | API version not supported |
| 36 | TOPIC_ALREADY_EXISTS | Create topic conflict |
| 38 | INCONSISTENT_GROUP_PROTOCOL | Mismatched assignor |
| 42 | INCONSISTENT_VOTER_SET | Raft membership |
| 45 | DUPLICATE_SEQUENCE_NUMBER | Idempotence-detected dup |
| 46 | INVALID_PRODUCER_EPOCH | Fenced |
| 47 | INVALID_TXN_STATE | Bad transaction state |
| 50 | OUT_OF_ORDER_SEQUENCE_NUMBER | Idempotence: gap |
| 60 | UNSUPPORTED_FOR_MESSAGE_FORMAT | Old format |
| 89 | OFFSET_NOT_AVAILABLE | LSO has not advanced |
| ... | (~150 codes total) | |

The full list is in `org.apache.kafka.common.protocol.Errors`.

---

## A.8 ApiVersionsRequest: how clients learn the protocol

When a client connects, the first request is typically
`ApiVersionsRequest`. The broker returns the list of supported APIs
and the version range it supports for each:

```
ApiVersionsResponse:
  errorCode            : INT16
  apiKeys              : ARRAY of {
    apiKey             : INT16
    minVersion         : INT16
    maxVersion         : INT16
  }
  throttleTimeMs       : INT32
  ...
```

The client picks a version it can speak that's within the broker's
range. This is how Kafka clients and brokers stay forward-compatible:
each side advertises capabilities, and they negotiate.

---

## A.9 Reading the source for protocol details

The canonical specification is in JSON files at:

```
clients/src/main/resources/common/message/*.json
```

For example, `ProduceRequest.json` defines the `ProduceRequest`
across versions. The build process generates Java classes from
these.

For wire-format debugging, **`kafka-console-producer.sh`** and
**`kafka-console-consumer.sh`** support `--property print.key=true`
and similar flags to inspect record contents at the application
level. For protocol-level debugging, **Wireshark** has a Kafka
dissector that decodes most messages.

---

## Summary

This appendix is what to consult when:

- You're implementing a Kafka client.
- You're debugging a binary-level issue (CRC mismatch, framing bug).
- You're reading a Wireshark capture.
- You want to know exactly what an error code means.

For everything else, the chapter narratives above are the right
level. Wire format is precise; the chapters explain what the bytes
*mean*.
