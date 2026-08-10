# Observability and SRE Patterns
## Senior Engineer Interview Reference — 40 LPA Level

---

## 1. The Three Pillars of Observability

```
                    Observability
                         │
          ┌──────────────┼──────────────┐
          │              │              │
       Metrics         Logs          Traces
          │              │              │
   "Is the system    "What happened  "Why is this
    healthy?"         exactly?"       request slow?"
          │              │              │
   Prometheus         Loki /         Jaeger /
   + Grafana         ELK Stack       Tempo
          │              │              │
   Aggregated,       High-cardinality, Request-scoped,
   numeric,          text,            causal chain,
   time-series       unstructured     cross-service
```

**Why all three are needed:**
- Metrics: tell you SOMETHING is wrong (error rate spike)
- Logs: tell you WHAT happened (exception stack trace)
- Traces: tell you WHERE and WHY it happened (slow downstream call)

**Correlation is key:**
- Trace ID appears in logs → jump from log to trace
- Exemplars in metrics → from a histogram bucket, link to an actual trace
- `traceId` / `spanId` / `requestId` in all three

---

## 2. Metrics: Prometheus

### 2.1 Data Model

Prometheus stores **time-series**: a stream of timestamped values identified by a metric name + label set.

```
metric_name{label1="value1", label2="value2"} value timestamp

Examples:
http_requests_total{method="GET", handler="/api/users", status="200"} 1234 1620000000000
jvm_memory_used_bytes{area="heap"} 536870912 1620000000000
container_cpu_usage_seconds_total{pod="my-app-abc123", container="app"} 42.5 1620000000000
```

**Cardinality warning:**
- Each unique label combination = separate time series
- `user_id` label → millions of time series → Prometheus OOM
- Rule: labels should have low cardinality (< 1000 unique values)
- High-cardinality data → use logs or traces instead of metrics

### 2.2 Metric Types

**Counter:**
- Monotonically increasing value (never decreases, resets to 0 on restart)
- Use: request counts, error counts, bytes sent
- Always use `_total` suffix by convention
- Query with `rate()` or `increase()`, not raw value

```
http_requests_total{...}
```

**Gauge:**
- Value that can go up or down
- Use: current temperature, current memory usage, active connections, queue depth
- Query raw value

```
jvm_memory_used_bytes{area="heap"}
active_connections{service="my-api"}
```

**Histogram:**
- Samples observations and counts them in configurable buckets
- Provides: `_bucket{le="..."}`, `_count`, `_sum`
- Use: request latency, response size
- Allows calculating quantiles server-side with `histogram_quantile()`

```
http_request_duration_seconds_bucket{le="0.005"} 24054
http_request_duration_seconds_bucket{le="0.01"}  33444
http_request_duration_seconds_bucket{le="0.025"} 100392
http_request_duration_seconds_bucket{le="0.05"}  129389
http_request_duration_seconds_bucket{le="+Inf"}  133988
http_request_duration_seconds_count              133988
http_request_duration_seconds_sum                53423
```

**Summary:**
- Similar to Histogram but quantiles calculated client-side (streaming)
- Provides: `{quantile="0.5"}`, `{quantile="0.9"}`, `{quantile="0.99"}`, `_count`, `_sum`
- **Problem**: cannot aggregate across instances (each calculates its own quantiles)
- **Prefer Histogram** for distributed systems; use Summary only if you need exact quantiles per instance

### 2.3 PromQL

**rate() — per-second rate of a counter over a time window:**
```promql
# HTTP requests per second (5-min window):
rate(http_requests_total[5m])

# Error rate percentage:
rate(http_requests_total{status=~"5.."}[5m])
/
rate(http_requests_total[5m])
* 100

# Rules:
# - [5m] window should be 4x scrape interval (typically 15s scrape → 1m min window)
# - rate() handles counter resets automatically
# - rate() returns per-second rate regardless of window size
```

**increase() — total increase over a time window:**
```promql
# Requests in the last hour:
increase(http_requests_total[1h])
# Note: this is rate(X[1h]) * 3600 — same math, different presentation
```

**histogram_quantile() — calculate percentile from histogram:**
```promql
# P99 request latency:
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# P99 latency by service:
histogram_quantile(0.99,
  sum by (service, le) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)
```

**Aggregation operators:**
```promql
# Sum across all pods, keep namespace label:
sum by (namespace) (container_memory_working_set_bytes)

# Count of running pods per namespace:
count by (namespace) (kube_pod_status_phase{phase="Running"})

# Top 5 pods by CPU:
topk(5, rate(container_cpu_usage_seconds_total[5m]))

# CPU usage percent by pod:
sum by (pod) (rate(container_cpu_usage_seconds_total{container!="POD"}[5m]))
/
sum by (pod) (kube_pod_container_resource_limits{resource="cpu"})
* 100
```

**Useful functions:**
```promql
# Predict value in 24h based on last 4h trend:
predict_linear(node_filesystem_free_bytes[4h], 24 * 3600)

# Absent: alert when metric disappears:
absent(up{job="my-service"})

# Changes in gauge (number of times it changed):
changes(kube_pod_container_status_restarts_total[1h])
```

### 2.4 Recording Rules

Pre-compute expensive queries to reduce query latency and storage:

```yaml
groups:
- name: http.rules
  interval: 30s
  rules:
  - record: job:http_requests_total:rate5m    # naming convention: labels:metric:aggregation
    expr: sum by (job) (rate(http_requests_total[5m]))

  - record: job:http_error_rate:ratio5m
    expr: |
      sum by (job) (rate(http_requests_total{status=~"5.."}[5m]))
      /
      sum by (job) (rate(http_requests_total[5m]))
```

### 2.5 AlertManager

**Alerting flow:**
```
Prometheus evaluates alerting rules every eval_interval (default 1m)
     │
     │ PENDING (for < for duration)
     │ FIRING (for >= for duration)
     ▼
AlertManager receives alert
     │
     ├── Route: match alert → receiver
     ├── Grouping: batch related alerts (e.g., all alerts from same cluster)
     ├── Inhibition: silence lower-severity alert when higher-severity fires
     └── Silencing: temporary silence during maintenance
     │
     ▼
Receiver: PagerDuty, Slack, Email, OpsGenie, webhook
```

**Alert example:**
```yaml
groups:
- name: my-service.alerts
  rules:
  - alert: HighErrorRate
    expr: |
      job:http_error_rate:ratio5m > 0.05
    for: 5m          # must be true for 5 continuous minutes (reduces flapping)
    labels:
      severity: critical
      team: platform
    annotations:
      summary: "High error rate for {{ $labels.job }}"
      description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"
      runbook_url: "https://wiki.example.com/runbooks/high-error-rate"
      dashboard_url: "https://grafana.example.com/d/abc123"
```

**AlertManager routing:**
```yaml
route:
  receiver: slack-general
  group_by: ['alertname', 'cluster', 'namespace']
  group_wait: 30s         # wait for more alerts before first notification
  group_interval: 5m      # wait before sending updated notification
  repeat_interval: 4h     # repeat if still firing
  routes:
  - match:
      severity: critical
    receiver: pagerduty
  - match:
      team: platform
    receiver: slack-platform
```

### 2.6 Scrape Model vs Push

**Prometheus (pull/scrape model):**
```
Prometheus server ──── HTTP GET /metrics ────► Service (on scrape interval)
```
- Service exposes `/metrics` endpoint in Prometheus text format
- Prometheus discovers services via: static config, file-based SD, K8s SD, Consul SD, etc.
- **Advantage**: Prometheus controls scrape interval; can detect service downtime (`up` metric)
- **Problem**: short-lived jobs (batch) may not be scraped before they finish

**Pushgateway (for short-lived jobs):**
```
Batch Job ──── HTTP POST /metrics ────► Pushgateway ──── scrape ────► Prometheus
```
- Job pushes metrics, Pushgateway holds them until scraped
- **Caveat**: Pushgateway doesn't track instance liveness; old metrics persist

**Push model (StatsD, Graphite, InfluxDB):**
- Application pushes metrics to a server
- Better for short-lived processes
- Network firewall may block Prometheus scrape but allow push

### 2.7 Service Discovery in Kubernetes

```yaml
# Prometheus ServiceMonitor (Prometheus Operator)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: my-service
  endpoints:
  - port: http
    path: /actuator/prometheus
    interval: 15s
    scheme: https
    tlsConfig:
      insecureSkipVerify: true
```

Prometheus Operator watches ServiceMonitor CRDs and auto-configures Prometheus scrape targets.

---

## 3. Grafana

### 3.1 Dashboard Design Principles

**USE Method (for resources):**
- **U**tilization: how busy is the resource? (CPU %, memory %)
- **S**aturation: how much work is queued/deferred? (queue depth, runqueue)
- **E**rrors: error count (disk errors, network errors)

**RED Method (for services):**
- **R**ate: requests per second
- **E**rror rate: errors per second (or % errors)
- **D**uration: latency distribution (P50, P95, P99)

**Four Golden Signals (Google SRE Book):**
1. Latency (how long requests take — distinguish success vs error latency)
2. Traffic (how much demand: RPS, QPS)
3. Errors (rate of failing requests)
4. Saturation (how "full" is the service: CPU %, queue depth)

### 3.2 Key Grafana Features

**Variable templating:**
```
${namespace} = all namespaces from label values query
${pod} = pods filtered by namespace
Used in panels: container_memory_working_set_bytes{pod=~"${pod}"}
```

**Exemplars:**
- Histograms can include trace IDs as "exemplars"
- Grafana can link from a histogram panel directly to a specific trace in Tempo/Jaeger
- Enables: "this p99 spike at 14:32 was caused by trace abc123"

**Alerting in Grafana (Grafana 8+):**
- Unified alerting: routes via AlertManager or built-in notification policies
- Alert on any datasource (Prometheus, Loki, SQL)

---

## 4. Distributed Tracing

### 4.1 Core Concepts

```
Request flow:
User → API Gateway → Service A → Service B → Database

Trace: one end-to-end request
├── Span 1: API Gateway (root span)
│   traceId: abc123
│   spanId: span001
│   duration: 250ms
├── Span 2: Service A
│   traceId: abc123
│   spanId: span002
│   parentSpanId: span001
│   duration: 200ms
├── Span 3: Service B (child of A)
│   traceId: abc123
│   spanId: span003
│   parentSpanId: span002
│   duration: 150ms
└── Span 4: Database query (child of B)
    traceId: abc123
    spanId: span004
    parentSpanId: span003
    duration: 100ms
```

**Span attributes:**
- `http.method`, `http.url`, `http.status_code`
- `db.system`, `db.statement`
- `rpc.service`, `rpc.method`
- Custom: `user.id`, `order.id`

**Span events:**
- Point-in-time annotations within a span
- `span.addEvent("cache-miss", {"key": "user:123"})` → visible in trace timeline

**Span status:**
- `UNSET` (default), `OK`, `ERROR`

### 4.2 OpenTelemetry — The Standard

OpenTelemetry (OTel) is the CNCF standard for instrumentation. It replaces vendor-specific SDKs (OpenCensus, OpenTracing).

```
Application code
     │
     │ OTel API (vendor-neutral)
     ▼
OTel SDK (language-specific implementation)
     │
     │ Exporters
     ├──── OTLP (OpenTelemetry Protocol) ──► OTel Collector
     │                                           │
     │                                      ┌───┴──────┐
     │                                      ▼          ▼
     │                                   Jaeger     Tempo
     │
     ├──── Jaeger exporter (direct)
     └──── Zipkin exporter (direct)
```

**OTel Collector:**
```yaml
# collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc: {endpoint: "0.0.0.0:4317"}
      http: {endpoint: "0.0.0.0:4318"}
  prometheus:                # also scrape Prometheus metrics
    config:
      scrape_configs:
      - job_name: my-service
        static_configs:
        - targets: [localhost:8080]

processors:
  batch:
    timeout: 1s
    send_batch_size: 1000
  memory_limiter:
    limit_mib: 1500
  resource:
    attributes:
    - key: environment
      value: production
      action: upsert

exporters:
  otlp/jaeger:
    endpoint: jaeger-collector:4317
    tls: {insecure: true}
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, memory_limiter, resource]
      exporters: [otlp/jaeger]
    metrics:
      receivers: [otlp, prometheus]
      processors: [batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
```

### 4.3 W3C Trace Context — Context Propagation

When Service A calls Service B, it must pass the trace context so spans can be correlated.

**Headers:**
```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^  ^                                ^               ^
             version  traceId (128-bit hex)      spanId (64-bit) flags (sampled=01)

tracestate: rojo=00f067aa0ba902b7,congo=t61rcWkgMzE
            vendor1=value1,vendor2=value2  (vendor-specific data)
```

**Context propagation flow:**
```
Service A (creates root span)
   │ Sets traceparent header on outgoing HTTP request
   │ traceparent: 00-<traceId>-<parentSpanId>-01
   ▼
Service B (receives request)
   │ Reads traceparent header
   │ Creates child span with parentSpanId from header
   │ Sets new traceparent on outbound calls
   ▼
Service C (etc.)
```

**Java implementation with OTel SDK:**
```java
// Spring Boot auto-instrumentation (no code changes needed!):
// Add -javaagent:opentelemetry-javaagent.jar
// Set OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME

// Manual instrumentation:
Tracer tracer = GlobalOpenTelemetry.getTracer("my-service");

Span span = tracer.spanBuilder("process-order")
    .setSpanKind(SpanKind.INTERNAL)
    .startSpan();

try (Scope scope = span.makeCurrent()) {
    span.setAttribute("order.id", orderId);
    span.addEvent("validating-payment");
    // ... do work ...
    span.addEvent("payment-validated");
} catch (Exception e) {
    span.setStatus(StatusCode.ERROR, e.getMessage());
    span.recordException(e);
    throw e;
} finally {
    span.end();
}
```

**Context propagation in async code (critical for Java):**
```java
// Problem: OTel uses ThreadLocal for context → lost in async handoff

// Solution 1: OTel context wrapper
Context context = Context.current();
CompletableFuture.runAsync(() -> {
    try (Scope scope = context.makeCurrent()) {  // restore context in new thread
        doWork();
    }
}, executor);

// Solution 2: OTel-aware executor wrapper
ExecutorService instrumentedExecutor = 
    Context.taskWrapping(Executors.newFixedThreadPool(10));
// All tasks submitted to this executor automatically carry OTel context

// Solution 3: Reactor + Project Loom contexts
// Use reactor-context + OTel bridge for reactive code
```

### 4.4 Sampling Strategies

```
Head-based sampling (decide at trace start):
- AlwaysOn: 100% sampled (dev/test)
- AlwaysOff: 0% sampled
- TraceIdRatioBased: sample X% based on trace ID hash
- ParentBased: respect upstream sampling decision

Tail-based sampling (decide after trace complete — in OTel Collector):
- Can sample based on error status, duration, specific attributes
- More intelligent but requires buffering spans in collector
- Config: tailsampling processor in OTel Collector

# Tail sampling example:
processors:
  tail_sampling:
    decision_wait: 10s
    policies:
    - name: error-policy
      type: status_code
      status_code: {status_codes: [ERROR]}
    - name: slow-traces
      type: latency
      latency: {threshold_ms: 1000}
    - name: baseline-rate
      type: probabilistic
      probabilistic: {sampling_percentage: 10}
```

### 4.5 Jaeger vs Zipkin vs Tempo

| | Jaeger | Zipkin | Grafana Tempo |
|-|--------|--------|---------------|
| Origin | Uber | Twitter | Grafana Labs |
| Protocol | OTLP, Jaeger, Zipkin | Zipkin, OTLP | OTLP |
| Storage | Elasticsearch, Cassandra, Badger | Elasticsearch, Cassandra, MySQL | Object storage (S3, GCS, Azure) |
| Query | Jaeger UI | Zipkin UI | Grafana (no standalone UI) |
| Cost at scale | High (ES/Cassandra) | High | Low (object storage) |
| Grafana integration | Plugin available | Plugin available | Native |
| Use case | Feature-rich UI | Established, simple | Cost-efficient at scale |

**Tempo advantages:**
- Uses object storage (S3/GCS) → much cheaper than Elasticsearch for high volume
- No indexing — trace lookup by trace ID only (fast) or via Grafana exemplars
- TraceQL: query language for filtering traces

---

## 5. Structured Logging

### 5.1 Why JSON Logs

```
# Bad (unstructured):
2024-01-15 14:23:45.123 ERROR [my-service] [http-nio-8080-exec-1] Error processing order 12345: Connection refused
# Hard to query: grep, parse, index

# Good (structured JSON):
{
  "timestamp": "2024-01-15T14:23:45.123Z",
  "level": "ERROR",
  "service": "my-service",
  "thread": "http-nio-8080-exec-1",
  "message": "Error processing order",
  "orderId": "12345",
  "errorType": "ConnectionRefused",
  "traceId": "4bf92f3577b34da6a3",
  "spanId": "00f067aa0ba902",
  "userId": "user-789",
  "duration_ms": 150
}
# Queryable by any field; machine-parseable; correlation via traceId
```

**Java (Logback + Logstash encoder):**
```xml
<!-- logback-spring.xml -->
<appender name="JSON" class="ch.qos.logback.core.ConsoleAppender">
    <encoder class="net.logstash.logback.encoder.LogstashEncoder">
        <customFields>{"service":"my-service","version":"1.2.3"}</customFields>
        <fieldNames>
            <timestamp>timestamp</timestamp>
            <message>message</message>
        </fieldNames>
    </encoder>
</appender>

<springProfile name="production">
    <root level="INFO">
        <appender-ref ref="JSON"/>
    </root>
</springProfile>
```

**MDC (Mapped Diagnostic Context) for correlation IDs:**
```java
// In filter/interceptor:
MDC.put("traceId", span.getSpanContext().getTraceId());
MDC.put("spanId", span.getSpanContext().getSpanId());
MDC.put("requestId", UUID.randomUUID().toString());
MDC.put("userId", SecurityContext.getCurrentUser().getId());

// Logback JSON encoder includes all MDC fields automatically
// In log output:
// {"traceId": "4bf92f...", "spanId": "00f067...", "requestId": "...", "userId": "..."}
```

### 5.2 ELK Stack

```
Application pods
      │ stdout/stderr
      ▼
Fluentd/Fluent Bit (DaemonSet on every node)
      │ parses JSON, adds k8s metadata (pod, namespace, node)
      ▼
Logstash (optional: filtering, transformation)
      │
      ▼
Elasticsearch (indexing, storage)
      │
      ▼
Kibana (visualization, search, alerting)
```

**Elasticsearch data model:**
- Document-based: each log line is a JSON document in an index
- Inverted index: every field indexed → fast full-text search
- **Cost**: Elasticsearch is expensive at high log volume
  - Heavy indexing CPU + memory
  - Storage: ES stores data in compressed segments but still costly
  - Hot/warm/cold architecture: recent data on fast SSDs, older on HDDs

**Fluent Bit vs Fluentd:**
- Fluent Bit: lighter, lower memory, recommended for K8s DaemonSet
- Fluentd: richer plugin ecosystem, more transformation logic
- Both can output to Elasticsearch, Loki, Kafka, etc.

### 5.3 Loki + Grafana (Log-as-Metrics)

```
Application pods
      │ stdout/stderr
      ▼
Promtail (DaemonSet) — or Fluent Bit Loki output
      │ scrapes logs from /var/log/pods/, adds labels
      ▼
Loki (log aggregation, indexed by labels only)
      │
      ▼
Grafana (query with LogQL, correlate with Prometheus)
```

**Key difference from ELK:**
- Loki does **NOT** index log content — only indexes labels (`{app="my-service", namespace="production"}`)
- Log content queried via grep-like scan per label set
- Hugely cheaper for storage: compressed chunks in object storage (S3)
- Trade-off: slower ad-hoc text search vs Elasticsearch

**LogQL:**
```logql
# All error logs from production:
{namespace="production", app="my-service"} |= "ERROR"

# Parse JSON and filter:
{namespace="production"} | json | level="ERROR" | orderId != ""

# Rate of error logs:
rate({namespace="production", app="my-service"} |= "ERROR" [5m])

# Extract metric from logs (log-derived metrics):
sum by (status) (
  rate({app="nginx"} | json | __error__=""
    | unwrap status [1m]
  )
)
```

**When to use ELK vs Loki:**
- Loki: cost-sensitive, K8s-native, Grafana-centric, labels-based querying
- ELK: full-text search critical, complex transformations, enterprise features needed

---

## 6. SRE Principles

### 6.1 SLI, SLO, SLA

**SLI (Service Level Indicator):** A metric that measures a specific aspect of service quality.
```
SLI examples:
- Availability: % of successful requests (non-5xx / total)
- Latency: % of requests completing under 200ms
- Throughput: requests per second
- Error rate: % of requests resulting in error
- Freshness: % of data updates processed within 10 seconds
```

**SLO (Service Level Objective):** A target value for an SLI. Internal goal.
```
SLO examples:
- 99.9% of requests return non-5xx (availability)
- 95% of requests complete in < 200ms (latency)
- 99% of writes replicated within 1 second

SLO = measured over a rolling window (e.g., 28 days)
```

**SLA (Service Level Agreement):** A contract with users/customers. Usually less strict than SLO.
```
SLA: 99.5% availability (weaker than internal SLO of 99.9%)
Violation → financial penalty / service credits
```

**SLO calculation:**
```promql
# Availability SLO: 99.9% over 28 days
# Good events = non-5xx requests
# Total events = all requests

# Current SLO compliance:
(
  sum(increase(http_requests_total{status!~"5.."}[28d]))
  /
  sum(increase(http_requests_total[28d]))
) * 100

# Target: >= 99.9
```

### 6.2 Error Budgets

```
SLO: 99.9% availability over 30 days
   ↓
Allowed downtime = 0.1% of 30 days
  = 0.001 × 30 × 24 × 60 = 43.2 minutes of downtime per month

Error Budget = 43.2 minutes

Error Budget consumption:
  ├── Deploy goes wrong, 5-min outage → uses 5/43.2 = 11.6% of budget
  ├── DNS misconfiguration, 10-min → uses 23.1% of budget
  └── Budget nearly exhausted → freeze releases, focus on reliability

Error Budget policy:
  ├── Budget > 50%: ship features, take risks
  ├── Budget 10-50%: cautious deploys, fix reliability issues
  └── Budget < 10%: no new features, all hands on reliability
```

**Burn rate alerting:**
```promql
# Alert if error budget is burning too fast
# 1-hour burn rate > 14.4 means budget exhausted in < 3 days
(
  rate(http_requests_total{status=~"5.."}[1h])
  /
  rate(http_requests_total[1h])
) / 0.001 > 14.4   # 0.001 = error budget rate (1 - 0.999)
```

**Multiwindow burn rate (Google SRE Workbook recommended):**
```promql
# Alert: high burn rate on 1h AND 5min windows (reduces false positives)
(
  (burn_rate_1h > 14.4) AND (burn_rate_5m > 14.4)   # fast burn (2% budget in 1h)
) OR
(
  (burn_rate_6h > 6) AND (burn_rate_30m > 6)          # medium burn
)
```

### 6.3 Toil Reduction

**Toil definition (Google SRE):** Manual, repetitive, automatable, tactical work that scales with service growth.
```
Toil examples:
- Manually restarting pods when app hangs
- Manually rotating certificates
- Manually approving deploys in staging
- Manually responding to noisy non-actionable alerts
- Manually scaling clusters for known traffic patterns

Toil elimination:
- Auto-restart: K8s liveness probes
- Auto-rotation: cert-manager
- Auto-deploy: ArgoCD
- Fix alerts: fix root cause OR raise alert threshold
- Scheduled scaling: KEDA cron scaler
```

---

## 7. Kubernetes-Specific Observability

### 7.1 kube-state-metrics

Exposes K8s object state as Prometheus metrics (from K8s API, not from kubelets).

```promql
# Pods not running:
kube_pod_status_phase{phase!="Running", phase!="Succeeded"} == 1

# Deployments where desired != available:
kube_deployment_status_replicas_available
  != kube_deployment_spec_replicas

# Container restarts in last hour:
increase(kube_pod_container_status_restarts_total[1h]) > 5

# PVC not bound:
kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1

# Node memory pressure:
kube_node_status_condition{condition="MemoryPressure", status="true"} == 1
```

### 7.2 metrics-server

- In-cluster metrics pipeline for HPA and `kubectl top`
- Collects resource usage from kubelets (kubelet Summary API)
- NOT for long-term storage (in-memory, ~1 min retention)
- Not for Prometheus (use cAdvisor exporter or node-exporter for that)

```bash
kubectl top pods -n production --sort-by=memory
kubectl top nodes
```

### 7.3 node-exporter

DaemonSet that exposes host-level metrics:
```promql
# CPU utilization:
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))

# Memory available:
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes

# Disk I/O utilization:
rate(node_disk_io_time_seconds_total[5m])

# Network bandwidth:
rate(node_network_receive_bytes_total{device="eth0"}[5m])
```

### 7.4 Kubernetes Events

K8s Events are short-lived objects (1 hour TTL) recording what happened to resources.

```bash
kubectl get events -n production --sort-by=.lastTimestamp
# REASON: FailedScheduling, BackOff, OOMKilled, Pulled, Created, Started

# Useful events to alert on:
# - BackOff (CrashLoopBackOff) → pod stuck in restart loop
# - OOMKilled → container hitting memory limit
# - FailedMount → volume mount failure
# - FailedScheduling → pod can't be scheduled (insufficient resources)
```

**Event exporter (Prometheus):**
- `kubernetes-event-exporter` tool: streams K8s events to various backends
- Export events to Elasticsearch/Loki for longer retention and search

---

## 8. Java-Specific Observability

### 8.1 Micrometer — Spring Boot Actuator

Micrometer is the "SLF4J for metrics" — vendor-neutral metrics facade.

```xml
<!-- pom.xml -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
```

```yaml
# application.yml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus,metrics,env
  endpoint:
    health:
      show-details: always
      probes:
        enabled: true      # /actuator/health/liveness, /actuator/health/readiness
  metrics:
    tags:
      application: ${spring.application.name}
      environment: ${spring.profiles.active}
    distribution:
      percentiles-histogram:
        http.server.requests: true    # enable histogram for P99 queries
      slo:
        http.server.requests: 50ms,200ms,500ms,1s  # SLO buckets
```

**Custom metrics:**
```java
@Component
public class OrderMetrics {
    private final Counter ordersCreated;
    private final Timer orderProcessingTime;
    private final Gauge pendingOrders;
    private final AtomicInteger pendingCount = new AtomicInteger(0);

    public OrderMetrics(MeterRegistry registry) {
        this.ordersCreated = Counter.builder("orders.created.total")
            .description("Total orders created")
            .tag("region", "us-east")
            .register(registry);

        this.orderProcessingTime = Timer.builder("orders.processing.time")
            .description("Time to process an order")
            .publishPercentileHistogram()  // for histogram_quantile
            .register(registry);

        this.pendingOrders = Gauge.builder("orders.pending", pendingCount, AtomicInteger::get)
            .description("Current pending orders")
            .register(registry);
    }

    public void recordOrderCreated() {
        ordersCreated.increment();
        pendingCount.incrementAndGet();
    }

    public <T> T timeOrderProcessing(Supplier<T> work) {
        return orderProcessingTime.record(work);
    }
}
```

### 8.2 JVM Metrics (Auto-exposed by Micrometer)

```promql
# Heap usage:
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} * 100

# Non-heap (Metaspace + CodeCache):
jvm_memory_used_bytes{area="nonheap"}

# GC pause time (P99):
histogram_quantile(0.99, rate(jvm_gc_pause_seconds_bucket[5m]))

# GC pause frequency:
rate(jvm_gc_pause_seconds_count[5m])

# GC overhead (% of time in GC):
rate(jvm_gc_pause_seconds_sum[5m]) * 100

# Thread states:
jvm_threads_states_threads{state="blocked"}
jvm_threads_states_threads{state="waiting"}
jvm_threads_states_threads{state="runnable"}

# Class loading:
jvm_classes_loaded_classes
rate(jvm_classes_loaded_classes[5m])  # should be ~0 after startup

# Buffer pools (DirectByteBuffers):
jvm_buffer_memory_used_bytes{id="direct"}
```

**GC alerts:**
```promql
# GC overhead > 20%:
rate(jvm_gc_pause_seconds_sum[5m]) > 0.20

# Heap usage > 85%:
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} > 0.85

# Full GC occurring:
rate(jvm_gc_pause_seconds_count{action="end of major GC"}[5m]) > 0
```

### 8.3 Async Context Propagation with OpenTelemetry

**The problem in reactive/async Java:**
```java
// Thread 1: HTTP request arrives, span started
Span span = tracer.spanBuilder("handle-request").startSpan();
try (Scope scope = span.makeCurrent()) {

    // Thread 2: async operation (context is NOT automatically propagated!)
    CompletableFuture.supplyAsync(() -> {
        // !! OTel context is LOST here (ThreadLocal was on Thread 1) !!
        Span child = tracer.spanBuilder("async-work").startSpan();
        // This span has no parent → broken trace!
        ...
    });
}
```

**Solutions:**

**Solution 1: Explicit context propagation:**
```java
Context currentContext = Context.current();
CompletableFuture.supplyAsync(() -> {
    try (Scope scope = currentContext.makeCurrent()) {
        return doWork();
    }
}, executor);
```

**Solution 2: Context-wrapping executor:**
```java
// Wrap your ExecutorService:
ExecutorService otelExecutor = Context.taskWrapping(executor);
// All submitted tasks inherit current context automatically
```

**Solution 3: Spring + OTel auto-instrumentation (recommended):**
```
-javaagent:opentelemetry-javaagent.jar
```
- Agent instruments `CompletableFuture`, Spring `@Async`, Spring WebFlux, Project Reactor
- Context propagated automatically through instrumented code paths
- Zero code changes required for standard Spring Boot apps

**Reactor (WebFlux) context propagation:**
```java
// Reactor uses its own Context (not ThreadLocal)
// OTel Reactor instrumentation bridges the two:
Mono<String> result = Mono.defer(() -> {
    // OTel context available here via reactor-bridge
    return callDownstream();
})
.contextWrite(ReactorBaggage.inject(currentBaggage))  // pass OTel context via Reactor
```

**Virtual Threads (JDK 21) + OTel:**
```java
// Virtual threads (Project Loom) don't have ThreadLocal propagation issues
// within a single continuation, but handoffs between virtual threads still need care
// OTel Java agent 1.27+ supports virtual thread context propagation
```

### 8.4 Distributed Trace Correlation with Logs

```java
// With OTel Java agent: trace IDs automatically added to MDC
// Configure Logback to include them:
// %X{trace_id} %X{span_id}  OR  traceId/spanId fields in JSON encoder

// Result in Grafana: click on log line → "View trace" → opens Jaeger/Tempo
// Requires: traceId field in Loki labels OR indexed field in Elasticsearch

// Logstash encoder custom field mapping:
<provider class="net.logstash.logback.composite.loggingevent.ArgumentsJsonProvider"/>
<addKeyValuePairs>true</addKeyValuePairs>
// Ensures all MDC fields (traceId, spanId) are in JSON output
```

---

## 9. Production Observability Checklist

### Infrastructure Metrics
```
[ ] Node CPU, memory, disk, network utilization
[ ] Pod CPU/memory usage vs requests/limits
[ ] Container restarts (> 0 in 1h = alert)
[ ] PVC usage (alert at 80%)
[ ] etcd size, latency, leader changes
[ ] Certificate expiry (alert 30d before)
```

### Application Metrics (The Four Golden Signals)
```
[ ] Request rate (RPS by endpoint)
[ ] Error rate (5xx %, alert at 1-5%)
[ ] Latency P50/P95/P99 (alert on SLO breach)
[ ] Saturation (queue depth, thread pool usage)
```

### JVM Metrics
```
[ ] Heap usage % (alert at 85%)
[ ] GC overhead % (alert at 20%)
[ ] Full GC frequency (alert if > 0/min)
[ ] Thread count (alert on unexpected growth)
[ ] Metaspace usage
```

### Business Metrics
```
[ ] Orders created/min
[ ] Payment success rate
[ ] User login rate
[ ] API error rate by customer
```

---

## Quick Reference: Key Interview Points

| Topic | Key Insight |
|-------|-------------|
| Counter vs Gauge | Counter: always increases (use rate()); Gauge: current value |
| Histogram vs Summary | Histogram: aggregate across instances; Summary: per-instance only |
| High cardinality | user_id as label = millions of series = OOM; use traces instead |
| rate() vs increase() | rate()=per-second; increase()=total over window; same data different view |
| histogram_quantile | Requires histogram type (not summary); P99 = 0.99 |
| Error budget | 99.9% SLO = 43.2 min downtime/month; burn rate alerts prevent exhaustion |
| Loki vs ELK | Loki: label-indexed, cheap object storage; ELK: full-text search, expensive |
| OTel traceparent | 00-<128bitTraceId>-<64bitSpanId>-<flags>; W3C standard header |
| Tail sampling | Decision after trace complete; filter by error/latency; in OTel Collector |
| Async OTel context | ThreadLocal lost on thread switch; wrap executor or use agent |
| MDC + traceId | Bridge logs and traces; OTel agent auto-populates MDC trace_id/span_id |
| Exemplars | Link from metric histogram bucket to specific trace in Grafana |
| kube-state-metrics | K8s object state (desired vs actual replicas, pod phase) in Prometheus |

---

Sources:
- [OpenTelemetry Context Propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [W3C Trace Context Specification](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [OTel Context Propagation Guide](https://uptrace.dev/opentelemetry/context-propagation)
- [BetterStack OTel Context Propagation](https://betterstack.com/community/guides/observability/otel-context-propagation/)
