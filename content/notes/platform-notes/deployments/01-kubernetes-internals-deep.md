# Kubernetes Internals Deep Dive
## Senior Engineer Interview Reference — 40 LPA Level

---

## 1. Kubernetes Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE                                │
│                                                                     │
│  ┌──────────────┐   ┌─────────────────┐   ┌─────────────────────┐  │
│  │     etcd     │   │ kube-apiserver  │   │kube-controller-mgr  │  │
│  │  (3 or 5     │◄──│  (REST + Watch) │──►│ (reconcile loops)   │  │
│  │   nodes,     │   │                 │   │                     │  │
│  │   Raft)      │   │                 │   └─────────────────────┘  │
│  └──────────────┘   └────────┬────────┘   ┌─────────────────────┐  │
│                               │            │  kube-scheduler     │  │
│                               │            │  (filter + score)   │  │
│                               │            └─────────────────────┘  │
└───────────────────────────────┼─────────────────────────────────────┘
                                │ HTTPS
        ┌───────────────────────┼────────────────────────┐
        │  NODE                 │                        │  NODE
        │  ┌────────────┐       │         ┌────────────┐ │
        │  │  kubelet   │◄──────┘         │  kubelet   │ │
        │  └────┬───────┘                 └────┬───────┘ │
        │  ┌────▼───────┐             ┌────────▼───────┐  │
        │  │ containerd │             │   containerd   │  │
        │  │  (CRI)     │             │    (CRI)       │  │
        │  └────┬───────┘             └────┬───────────┘  │
        │  ┌────▼───────┐             ┌────▼───────────┐  │
        │  │  runc/OCI  │             │   runc/OCI     │  │
        │  └────────────┘             └────────────────┘  │
        └────────────────────────────────────────────────┘
```

---

### 1.1 etcd — The Brain's Memory

etcd is a distributed key-value store that is the **single source of truth** for all cluster state.

**Raft Consensus — Why 3 or 5 Nodes:**
- Raft requires **quorum = (n/2) + 1** to commit writes
- 3 nodes: quorum = 2 — tolerates 1 failure
- 5 nodes: quorum = 3 — tolerates 2 failures
- 4 nodes: quorum = 3 — same tolerance as 3 nodes but higher write cost (worse!)
- 7 nodes: rarely needed, write latency grows, rarely justified
- **Never run 2 or 4** — suboptimal failure tolerance
- Leader election: candidate with highest term and most up-to-date log wins
- Writes only go through the leader; followers replicate and acknowledge
- etcd uses **WAL (Write-Ahead Log)** — data written to WAL before applying to state machine

**etcd Performance Characteristics:**
- 99th percentile write latency target: < 10ms
- Recommended: SSD storage, dedicated disk, no co-location with heavy I/O workloads
- `etcd --quota-backend-bytes` default 2GB — monitor `etcd_mvcc_db_total_size_in_bytes`
- Compaction: `etcd` accumulates MVCC revisions; compact regularly via `etcdctl compact`
- Defragmentation: `etcdctl defrag` reclaims space after compaction

**Data Model:**
- All Kubernetes objects stored under `/registry/<resource>/<namespace>/<name>`
- Example: `/registry/pods/default/my-pod`
- Secrets: stored under `/registry/secrets/` — base64 encoded value in the Value field

---

### 1.2 kube-apiserver — The Gateway

The API server is the **only component that talks directly to etcd**. All other components interact through the API server.

**Watch Mechanism — How Kubernetes "reacts":**
```
Client                    kube-apiserver              etcd
  │                            │                        │
  │─── GET /api/v1/pods?watch=true ──►│                │
  │                            │──── watch /registry/pods ──►│
  │                            │                        │
  │         (Pod created)      │◄─── watch event ───────│
  │◄── HTTP chunked event ─────│                        │
  │    (ADDED, pod spec)       │                        │
```
- Uses HTTP chunked transfer encoding (long-lived HTTP/1.1 connection) or HTTP/2 streams
- Each resource object has a **resourceVersion** — monotonically increasing integer from etcd
- Watch resumes from a `resourceVersion`; if the revision is too old (compacted), client gets `410 Gone` and must re-list
- `informers` in client-go maintain a local cache (Store) + watch goroutine; controllers use informers, not raw API calls

**Resource Versions and Optimistic Concurrency:**
- Every object has `metadata.resourceVersion`
- Update requests include the current `resourceVersion`; API server rejects if stale (HTTP 409 Conflict)
- This is **optimistic locking** — no pessimistic locks in Kubernetes

**Admission Controllers:**
```
Request → Authentication → Authorization (RBAC) → Admission (Mutating → Validating) → etcd
```
- **MutatingAdmissionWebhook**: can modify objects (e.g., inject sidecar, set defaults)
- **ValidatingAdmissionWebhook**: can reject objects (e.g., enforce policy)
- Built-in: LimitRanger, ResourceQuota, PodSecurityAdmission, ServiceAccount
- Admission webhooks use `admissionregistration.k8s.io/v1` — configured via `MutatingWebhookConfiguration`

---

### 1.3 kube-controller-manager — The Reconciliation Engine

Runs ~30+ controllers in a single binary (can be split for performance):

**Reconciliation Pattern (key concept):**
```
Desired State (etcd/Git) ──► [Controller] ──► Actual State (cluster)
        │                         │
        └─────── Observe ─────────┘
                 Compare
                 Act
```

Key controllers:
- **ReplicaSet controller**: watches RS + Pods; if actual < desired, creates pods; if actual > desired, deletes pods
- **Deployment controller**: manages ReplicaSet rollouts; creates new RS, scales up/down
- **Node controller**: monitors node heartbeats (NodeLease in `kube-node-lease` ns); marks nodes `NotReady` after 40s; evicts pods after 5m (configurable)
- **Job controller**: creates pods for Jobs; tracks completions
- **Endpoint controller** (deprecated → EndpointSlice controller): populates Endpoints/EndpointSlices for Services
- **Namespace controller**: finalizer cleanup on namespace deletion

**Controller-Manager Leader Election:**
- Multiple replicas of controller-manager run but only one is active leader
- Leader lease stored in a ConfigMap/Lease object in `kube-system`
- Uses `client-go/tools/leaderelection` with `LeaseDuration`, `RenewDeadline`, `RetryPeriod`

---

### 1.4 kube-scheduler — Placement Intelligence

**Scheduling Framework (since K8s 1.15, stable 1.19):**

Replaced the old Predicates/Priorities model. Now uses **extension points** (plugins):

```
Pod enters scheduling queue
         │
    ┌────▼─────┐
    │QueueSort │  priority ordering in queue
    └────┬─────┘
         │
    ┌────▼─────┐
    │  PreFilter│  pre-processing, set context
    └────┬─────┘
         │
    ┌────▼─────┐
    │  Filter   │  eliminate nodes (was: Predicates)
    └────┬─────┘  NodeUnschedulable, NodeResourcesFit, NodeAffinity,
         │        PodTopologySpread, TaintToleration, VolumeBinding...
    ┌────▼─────┐
    │PostFilter │  if no nodes pass: preemption logic
    └────┬─────┘
         │
    ┌────▼─────┐
    │ PreScore  │  share state before scoring
    └────┬─────┘
         │
    ┌────▼─────┐
    │  Score    │  rank remaining nodes (was: Priorities)
    └────┬─────┘  NodeResourcesBalancedAllocation, ImageLocality,
         │        InterPodAffinity, NodeAffinity, PodTopologySpread...
    ┌────▼─────┐
    │NormalizeScore│ normalize to [0, 100]
    └────┬─────┘
         │
    ┌────▼─────┐
    │  Reserve  │  tentatively bind resources
    └────┬─────┘
         │
    ┌────▼─────┐
    │  Permit   │  approve/wait/deny binding
    └────┬─────┘
         │
    ┌────▼─────┐
    │ PreBind   │  e.g., provision volume
    └────┬─────┘
         │
    ┌────▼─────┐
    │   Bind    │  write binding to API server
    └────┬─────┘
         │
    ┌────▼─────┐
    │ PostBind  │  notification after bind
    └──────────┘
```

**Filter Plugins (what was "Predicates"):**
- `NodeUnschedulable`: skip nodes with `spec.unschedulable: true`
- `NodeResourcesFit`: check CPU/memory requests fit (LeastAllocated, MostAllocated, RequestedToCapacityRatio strategies)
- `NodeAffinity`: enforce `requiredDuringSchedulingIgnoredDuringExecution`
- `TaintToleration`: if node has taint not in pod's tolerations → filtered out
- `VolumeBinding`: check if PVC can be bound on node (topology constraints)
- `InterPodAffinity`: check pod (anti-)affinity rules
- `PodTopologySpread`: enforce `topologySpreadConstraints`

**Score Plugins (what was "Priorities"):**
- `NodeResourcesBalancedAllocation`: prefer nodes where CPU/memory usage is balanced
- `LeastAllocated` (default): prefer nodes with most free resources
- `ImageLocality`: prefer nodes that already have the container image pulled
- `InterPodAffinity`: score based on soft affinity preferences
- `NodeAffinity`: score based on `preferredDuringSchedulingIgnoredDuringExecution`
- Each plugin returns score 0–100; scheduler multiplies by plugin weight, sums → select highest

**Scheduling Performance:**
- Scheduler uses **percentageOfNodesToScore** (default: 50% for large clusters, 100% for small)
- Feasible nodes found early exits filtering phase (optimization for large clusters)
- Scheduling cycle is single-threaded; binding cycle is async/parallel

---

### 1.5 kubelet — The Node Agent

- Runs on every node; talks to API server, watches for Pods assigned to its node
- Main responsibilities: pod lifecycle, container probes, volume management, node status reporting

**kubelet Static Pods:**
- Reads YAML files from `/etc/kubernetes/manifests/` — used for control plane components (apiserver, etcd, scheduler, controller-manager) in kubeadm installations
- kubelet manages these pods directly, no API server needed for their scheduling

**Node Heartbeat:**
- kubelet updates `NodeLease` object in `kube-node-lease` namespace every 10s (default)
- Also updates `Node` status every 5m (or on change)
- Node controller marks node `NotReady` if no heartbeat for `node-monitor-grace-period` (40s default)

---

## 2. Pod Lifecycle: YAML to Running

```
Developer
   │
   │ kubectl apply -f pod.yaml
   ▼
kube-apiserver ──► Admission Controllers ──► etcd (stored with Pending status)
   │
   │ (kube-scheduler watches for Pods with nodeName="")
   ▼
kube-scheduler
   │ runs filter + score
   │ writes Pod.spec.nodeName = "node-3"
   ▼
kube-apiserver ──► etcd (nodeName updated)
   │
   │ (kubelet on node-3 watches for Pods with nodeName="node-3")
   ▼
kubelet (node-3)
   │
   ├──► CRI (containerd): PullImage, CreateContainer, StartContainer
   │         │
   │         └──► runc: creates namespaces (PID, NET, MNT, UTS, IPC)
   │                     applies cgroup limits
   │                     runs container process
   │
   ├──► CNI Plugin: sets up Pod network interface (veth pair)
   │         allocates Pod IP, sets up routing
   │
   ├──► CSI Plugin (if PVC): mounts volumes into Pod's filesystem
   │
   └──► Reports Pod status = Running to API server ──► etcd
```

**Pod Phases:** Pending → Running → Succeeded/Failed (terminal) | Unknown

**Container States:** Waiting → Running → Terminated

**Init Containers:** run sequentially before app containers; must succeed (exit 0) before next starts; share volumes but NOT network namespace with app containers

**Sidecar Containers (K8s 1.29+):** defined under `initContainers` with `restartPolicy: Always` — they start before app containers and survive their completion

---

## 3. Kubernetes Networking Model

**Fundamental Rules:**
1. Every Pod gets a unique cluster-wide IP address
2. Pods on the same node can communicate without NAT
3. Pods on different nodes can communicate without NAT
4. The IP a Pod sees for itself is the same IP others use to reach it

### 3.1 CNI Plugins

**Flannel (simple overlay):**
- Default backend: VXLAN (Virtual Extensible LAN)
- Each node gets a `/24` subnet from the cluster CIDR (e.g., `10.244.1.0/24`)
- Cross-node traffic: encapsulated in UDP (VXLAN port 4789), sent over node network
- flanneld reads routing table from etcd/K8s API, updates Linux routing + ARP tables
- Low performance overhead vs simplicity: good for dev, limited network policy support

**Calico (BGP-based, policy-rich):**
- Default mode: BGP (Border Gateway Protocol) — no overlay needed if nodes on same L2
- Each node runs `bird` (BGP daemon), advertises Pod CIDRs to neighbors
- IPIP tunnel mode for cross-L3: encapsulates Pod packets in IP-in-IP
- Full NetworkPolicy support + Calico-specific GlobalNetworkPolicy (cluster-wide)
- eBPF dataplane option: bypasses iptables entirely, ~40% lower latency

**Cilium (eBPF-native):**
- All dataplane implemented in eBPF programs loaded into kernel
- No kube-proxy needed: eBPF handles Service load balancing at socket level
- Hubble: built-in observability (flow logs, network topology) via eBPF maps
- L7 policy: can enforce HTTP/gRPC/Kafka-level policies (not just IP/port)
- WireGuard transparent encryption between nodes
- Identity-based (not IP-based) security — crucial in dynamic K8s environments

### 3.2 kube-proxy

Runs on every node. Implements the Service abstraction by programming the kernel.

**iptables mode (default until recently):**
```
Incoming packet to ClusterIP:Port
   │
   ├──► iptables PREROUTING/OUTPUT → KUBE-SERVICES chain
   ├──► match ClusterIP → KUBE-SVC-xxxx chain
   ├──► statistically select endpoint (using iptables --probability)
   └──► DNAT to PodIP:Port
```
- O(n) rules — 10,000 Services = 10,000+ iptables rules → slow updates, conntrack table pressure
- Each packet must traverse ALL rules until match (linear scan)

**IPVS mode (recommended for large clusters):**
- Uses Linux Virtual Server (LVS) in-kernel load balancer
- Hash table lookup: O(1) regardless of number of Services
- Supports multiple LB algorithms: rr, lc, dh, sh, sed, nq
- Enable: `kube-proxy --proxy-mode=ipvs`
- Requires `ip_vs`, `ip_vs_rr`, `ip_vs_wrr`, `ip_vs_sh` kernel modules

### 3.3 Services

**ClusterIP:**
- Virtual IP, only reachable within cluster
- kube-proxy programs DNAT rules: ClusterIP:Port → one of the Endpoints
- DNS: `service-name.namespace.svc.cluster.local` → ClusterIP (CoreDNS)
- No actual network interface exists for the ClusterIP — it's a fiction maintained by iptables/IPVS

**NodePort:**
- Opens a port (default: 30000–32767) on EVERY node
- Traffic to `NodeIP:NodePort` → iptables → DNAT → PodIP:Port
- `externalTrafficPolicy: Local` preserves source IP but requires pod on receiving node
- `externalTrafficPolicy: Cluster` (default): may hop to another node, source IP NATted

**LoadBalancer:**
- Creates a NodePort Service first
- Then calls cloud provider API (via cloud-controller-manager) to provision an external LB (ALB, NLB, GCP LB)
- LB routes to NodeIP:NodePort → then to Pod
- `spec.loadBalancerClass` for multiple LB implementations

**ExternalName:**
- CNAME-based DNS alias to an external service
- No kube-proxy rules; CoreDNS returns CNAME

**Headless Service (`clusterIP: None`):**
- DNS returns PodIPs directly (A records for each pod)
- Used by StatefulSets for stable DNS names per pod
- `pod-0.service-name.namespace.svc.cluster.local`

---

## 4. Ingress

```
External Traffic
      │
      ▼
[Cloud LB / NodePort]
      │
      ▼
[Ingress Controller Pod] ←── watches Ingress resources via K8s API
      │
      │  matches rules (host, path)
      │
      ▼
[Service ClusterIP] → [Pod]
```

**NGINX Ingress Controller:**
- Runs as a Deployment with a Service of type LoadBalancer
- Watches `Ingress` resources; dynamically generates `nginx.conf`
- Reloads nginx on config change (graceful reload via `nginx -s reload`)
- Supports: SSL termination, path rewrites, rate limiting, auth (oauth2-proxy integration)
- Annotations control behavior: `nginx.ingress.kubernetes.io/rewrite-target: /`

**AWS ALB Ingress Controller (AWS Load Balancer Controller):**
- Creates AWS ALB per Ingress resource (or shared ALB with `group.name` annotation)
- Uses TargetGroup per Service — pods registered directly as targets (IP mode) or via node (instance mode)
- Supports weighted routing natively (for canary deployments)
- Annotations: `kubernetes.io/ingress.class: alb`

**IngressClass:**
- `IngressClass` resource + `ingressClassName` in Ingress spec — allows multiple Ingress controllers
- `spec.controller` identifies the controller implementation
- `metadata.annotations: ingressclass.kubernetes.io/is-default-class: "true"` sets default

**Gateway API (next-gen Ingress):**
- `GatewayClass`, `Gateway`, `HTTPRoute`, `GRPCRoute` — more expressive than Ingress
- Role-based: cluster admin manages Gateway, app dev manages HTTPRoute

---

## 5. Storage

### 5.1 PV/PVC Lifecycle

```
StorageClass (dynamic) OR manually created PV
         │
         ▼
[PersistentVolumeClaim] ──► binds to PV ──► Pod uses PVC as volume
         │
         │  Lifecycle:
         │  Available → Bound → Released → (Reclaim: Retain/Delete/Recycle)
```

**Static Provisioning:** Admin creates PV manually, user creates PVC, K8s binds them (capacity + accessModes must match).

**Dynamic Provisioning:**
1. User creates PVC with `storageClassName: fast-ssd`
2. `kube-controller-manager`'s `PersistentVolumeController` sees unbound PVC
3. Calls the provisioner specified in StorageClass
4. Provisioner creates the backing storage (EBS volume, GCE PD, etc.)
5. Creates PV object, binds PVC to PV

**Access Modes:**
- `ReadWriteOnce` (RWO): single node read+write (most block storage)
- `ReadOnlyMany` (ROX): many nodes read-only
- `ReadWriteMany` (RWX): many nodes read+write (NFS, CephFS, EFS)
- `ReadWriteOncePod` (RWOP, K8s 1.22+): single pod only

**Reclaim Policies:**
- `Retain`: PV released but not deleted; data preserved; manual cleanup required
- `Delete`: PV and backing storage deleted automatically
- `Recycle` (deprecated): `rm -rf` on volume then make available again

### 5.2 CSI Driver Architecture

```
Kubernetes                          CSI Driver (vendor)
─────────────────────────────────   ──────────────────────────────
External Provisioner sidecar  ──►   CreateVolume / DeleteVolume
External Attacher sidecar     ──►   ControllerPublishVolume
External Resizer sidecar      ──►   ControllerExpandVolume
Node Driver Registrar         ──►   NodePublishVolume (mount on node)
```

- CSI driver runs as a DaemonSet (node plugin) + Deployment (controller plugin)
- Communication via gRPC over Unix domain sockets
- Three gRPC services: `Identity`, `Controller`, `Node`
- `NodePublishVolume` actually mounts the volume into the pod's filesystem on the node
- Volume topology: driver can express availability zones via topology keys

---

## 6. ConfigMaps and Secrets

**ConfigMap:**
- Stored in etcd as plaintext
- Mounted as files or injected as env vars
- Changes to mounted ConfigMaps propagate to pods (eventually, kubelet sync period: ~1 min)
- Changes to env var injections require pod restart

**Secret:**
- Stored in etcd as **base64-encoded** — NOT encrypted by default
- base64 is encoding, not encryption — `echo "cGFzc3dvcmQ=" | base64 -d` → `password`
- **Encryption at Rest (EncryptionConfiguration):**
  ```yaml
  apiVersion: apiserver.config.k8s.io/v1
  kind: EncryptionConfiguration
  resources:
  - resources: ["secrets"]
    providers:
    - kms:            # AWS KMS, GCP KMS, Azure Key Vault
        name: myKMSPlugin
        endpoint: unix:///var/run/kmsplugin/socket.sock
    - aescbc:         # AES-CBC with PKCS#7 padding (good but manage key rotation)
        keys:
        - name: key1
          secret: <base64-encoded-32-byte-key>
    - identity: {}    # fallback: no encryption
  ```
- KMS provider: data key encrypted by KMS; envelope encryption — K8s doesn't store master key
- `secretKeyRef` + RBAC is the minimum; prefer External Secrets Operator + Vault in production

**ImagePullSecret:**
- Stores docker registry credentials
- Referenced via `spec.imagePullSecrets` in Pod spec or attached to ServiceAccount

---

## 7. Scheduling Deep Dive

### 7.1 Taints and Tolerations

**Taints on nodes** repel pods. **Tolerations on pods** allow scheduling on tainted nodes.

```yaml
# Taint node:
kubectl taint nodes node1 key=value:NoSchedule
# NoSchedule: don't schedule new pods without toleration
# PreferNoSchedule: prefer not to schedule (soft)
# NoExecute: evict existing pods + don't schedule new ones

# Pod toleration:
tolerations:
- key: "key"
  operator: "Equal"  # or Exists
  value: "value"
  effect: "NoSchedule"
  tolerationSeconds: 300  # only for NoExecute: evict after 300s
```

**Built-in taints:**
- `node.kubernetes.io/not-ready`: node NotReady
- `node.kubernetes.io/unreachable`: node unreachable from controller
- `node.kubernetes.io/memory-pressure`, `disk-pressure`, `pid-pressure`
- `node.kubernetes.io/unschedulable`

### 7.2 Node Affinity

```yaml
affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:  # hard requirement
      nodeSelectorTerms:
      - matchExpressions:
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["us-east-1a", "us-east-1b"]
    preferredDuringSchedulingIgnoredDuringExecution:  # soft preference
    - weight: 100  # 1-100
      preference:
        matchExpressions:
        - key: instance-type
          operator: In
          values: ["m5.xlarge"]
```

`IgnoredDuringExecution` = once scheduled, node label changes don't evict the pod.
`RequiredDuringExecution` (future) = would evict if node no longer matches.

### 7.3 Pod Affinity / Anti-Affinity

```yaml
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app: my-service
      topologyKey: kubernetes.io/hostname  # each pod on different host
```

- `topologyKey: kubernetes.io/hostname` → spread across different nodes
- `topologyKey: topology.kubernetes.io/zone` → spread across availability zones
- **Interview gotcha**: Pod affinity rules are expensive — O(pods × nodes) computation

### 7.4 PodTopologySpreadConstraints (preferred over affinity for spreading)

```yaml
topologySpreadConstraints:
- maxSkew: 1              # max difference in pod count between topology domains
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: DoNotSchedule  # or ScheduleAnyway
  labelSelector:
    matchLabels:
      app: my-app
```

### 7.5 Priority Classes and Preemption

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000      # higher number = higher priority
globalDefault: false
preemptionPolicy: PreemptLowerPriority  # or Never
description: "Critical workloads"
```

**Preemption Flow:**
1. High-priority pod cannot be scheduled (no room)
2. Scheduler's PostFilter plugin attempts preemption
3. Finds nodes where evicting lower-priority pods would fit the high-priority pod
4. Selects the node that minimizes preemption impact
5. Marks victim pods for eviction; adds nominations annotation to pod
6. Victims respect `terminationGracePeriodSeconds` before being killed

**System reserved priorities:**
- `system-cluster-critical` (2000000000): kube-dns, metrics-server
- `system-node-critical` (2000001000): kube-proxy, kubelet static pods

---

## 8. Autoscaling

### 8.1 HPA — Horizontal Pod Autoscaler

```
[metrics-server / Prometheus Adapter / custom.metrics.k8s.io]
              │
              ▼
    [HPA Controller] (runs in kube-controller-manager)
              │  every 15s (--horizontal-pod-autoscaler-sync-period)
              │  desiredReplicas = ceil(currentReplicas × currentMetric/targetMetric)
              ▼
    [Deployment / ReplicaSet]
```

**HPA v2 (current) metrics sources:**
- `Resource`: CPU/memory from metrics-server (`metrics.k8s.io`)
- `Pods`: pod-level custom metrics (`custom.metrics.k8s.io`) — e.g., HTTP requests/pod
- `Object`: metrics from a K8s object (`custom.metrics.k8s.io`) — e.g., Ingress RPS
- `External`: external system metrics (`external.metrics.k8s.io`) — e.g., SQS queue depth

**Prometheus Adapter:**
- Implements `custom.metrics.k8s.io` API by querying Prometheus
- Configure `seriesQuery` + `metricsQuery` in ConfigMap to map PromQL → K8s metric API
- Allows HPA to scale on any Prometheus metric (RPS, latency p99, queue depth)

**Scale-down stabilization:**
```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 300  # wait 5min before scale-down
    policies:
    - type: Percent
      value: 10
      periodSeconds: 60  # reduce by max 10% per minute
  scaleUp:
    policies:
    - type: Pods
      value: 4
      periodSeconds: 60  # add max 4 pods per minute
```

### 8.2 VPA — Vertical Pod Autoscaler

- Adjusts CPU/memory requests/limits based on historical usage
- Modes: `Off` (recommend only), `Initial` (set at pod creation), `Auto` (evict + recreate)
- **Do not use VPA + HPA on same resource metric** (CPU) — they conflict
- VPA + HPA can coexist if HPA uses custom metric (e.g., RPS) and VPA adjusts memory

### 8.3 KEDA — Kubernetes Event-Driven Autoscaling

- Extends HPA with event-source scalers: Kafka lag, RabbitMQ queue depth, Redis list length, AWS SQS, Azure Service Bus, Prometheus, cron schedule
- Scales to zero (HPA cannot go below 1 replica unless using KEDA)
- Architecture: KEDA operator watches `ScaledObject` CRDs, creates/manages HPA objects

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-kafka-scaler
spec:
  scaleTargetRef:
    name: my-consumer
  minReplicaCount: 0    # can scale to zero!
  maxReplicaCount: 50
  triggers:
  - type: kafka
    metadata:
      topic: my-topic
      bootstrapServers: kafka:9092
      consumerGroup: my-group
      lagThreshold: "100"   # scale up when lag > 100 per partition
```

---

## 9. Resource Requests vs Limits

```
spec:
  containers:
  - resources:
      requests:          # used for scheduling decisions
        cpu: "500m"      # 0.5 CPU cores
        memory: "512Mi"
      limits:            # enforced at runtime
        cpu: "2000m"
        memory: "1Gi"
```

### CPU Throttling (CFS — Completely Fair Scheduler)

- CPU limit implemented via CFS quota: `cpu.cfs_quota_us` / `cpu.cfs_period_us`
- Default period: 100ms. If limit is 1 CPU → quota = 100ms per 100ms period
- If container uses its full quota in 50ms → **throttled for remaining 50ms**
- **This is silent performance degradation** — no OOM kill, no visible error, just slow response
- CPU throttle rate: `container_cpu_throttled_seconds_total` (Prometheus metric)
- **Java impact**: JVM GC threads, JIT compilation threads compete for CPU quota
- **Recommendation**: set CPU requests (for scheduling), avoid CPU limits OR set generous limits

### Memory OOM Killer

- Memory limit enforced by kernel cgroup: `memory.limit_in_bytes`
- When container exceeds limit → kernel OOM killer kills processes in the cgroup
- Pod shows `OOMKilled` in `kubectl describe pod`
- Java heap: JVM will not shrink heap below `-Xms`; always set proper `MaxRAMPercentage`
- **GC does not help**: if heap is allocated but GC cannot free enough → OOM

### JVM in Kubernetes — The Critical Details

**The historical problem (pre-JDK 8u191):**
```
# JVM reads:
cat /proc/cpuinfo  → sees ALL host CPUs (e.g., 64)
cat /proc/meminfo  → sees ALL host memory (e.g., 256GB)

# JVM configures itself for 64-CPU, 256GB machine
# Container limit: 2 CPU, 4GB
# Result: too many GC threads, massive heap, OOM
```

**Fix: `-XX:+UseContainerSupport` (default ON since JDK 10, backported to 8u191):**
```
# JVM reads cgroup limits:
/sys/fs/cgroup/cpu/cpu.cfs_quota_us
/sys/fs/cgroup/cpu/cpu.cfs_period_us
/sys/fs/cgroup/memory/memory.limit_in_bytes

# Correctly configures threads and heap
```

**Recommended JVM flags for containers:**
```bash
JAVA_OPTS="\
  -XX:+UseContainerSupport \          # read cgroup limits (ON by default JDK10+)
  -XX:MaxRAMPercentage=75.0 \         # use 75% of container memory for heap
  -XX:InitialRAMPercentage=50.0 \     # start with 50% to allow fast startup
  -XX:+ExitOnOutOfMemoryError \       # crash instead of limping along
  -XX:+HeapDumpOnOutOfMemoryError \   # capture heap dump
  -XX:HeapDumpPath=/tmp/heapdump.hprof \
  -XX:ActiveProcessorCount=2 \        # override CPU count if needed
  -Djava.util.concurrent.ForkJoinPool.common.parallelism=2"
```

**Why MaxRAMPercentage=75 not 100:**
- Non-heap memory: Metaspace, CodeCache, thread stacks, DirectByteBuffers, NIO
- Rule of thumb: leave ~25% for non-heap overhead
- Monitor with: `container_memory_working_set_bytes` vs limit

**Graceful Shutdown in Kubernetes:**
```yaml
spec:
  containers:
  - lifecycle:
      preStop:
        exec:
          command: ["/bin/sh", "-c", "sleep 10"]  # wait for LB to drain
  terminationGracePeriodSeconds: 60
```
**Shutdown sequence:**
1. Pod marked `Terminating`; removed from Service Endpoints (kube-proxy/ipvs update)
2. `preStop` hook executed (sleep 10 allows in-flight requests to complete)
3. SIGTERM sent to PID 1
4. JVM Spring Boot: `server.shutdown=graceful` + `spring.lifecycle.timeout-per-shutdown-phase=30s`
5. After `terminationGracePeriodSeconds`: SIGKILL (no more waiting)

**SIGTERM handling in Java:**
```java
Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    // Spring context close triggers graceful shutdown
    context.close();
}));
```

---

## 10. Pod Disruption Budgets

Prevents too many pods going down simultaneously during voluntary disruptions (node drain, rolling update).

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-app-pdb
spec:
  minAvailable: 2        # OR maxUnavailable: 1
  selector:
    matchLabels:
      app: my-app
```

- Voluntary disruptions: `kubectl drain`, rolling updates, node auto-provisioner scale-down
- Involuntary disruptions (node crash): PDB does NOT apply
- `kubectl drain` respects PDB — waits if draining would violate it
- **Cluster Autoscaler** checks PDB before removing a node

---

## 11. Deployment Strategies

### Rolling Update (default)
```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1           # max pods above desired count (absolute or %)
    maxUnavailable: 0     # max pods unavailable during update (0 = zero-downtime)
```
- `maxSurge: 25%, maxUnavailable: 25%` (defaults)
- Zero-downtime: set `maxUnavailable: 0`, `maxSurge: 1` (or more)
- Requires: proper readiness probes (pods not added to Service until ready)

### Blue/Green
```
┌─────────────┐     ┌─────────────┐
│  Blue (v1)  │     │ Green (v2)  │
│  replicas=5 │     │  replicas=5 │
└──────┬──────┘     └──────┬──────┘
       │                   │
       │   Service selector│
       └──── app=v1 ───────┘
             (switch to app=v2 for cutover)
```
- Two full deployments; instantaneous traffic switch via Service label selector change
- Database migrations: forward-compatible schema required (v1 and v2 must work with same schema)
- Rollback: switch selector back to v1 (v1 pods still running)
- Cost: 2x resources required during the switch period

### Canary
- Send small % of traffic to new version, monitor, gradually increase
- **Option 1: Multiple Deployments + single Service** — crude (only controls ratio by replica count)
- **Option 2: Argo Rollouts** — `Rollout` CRD with canary steps
- **Option 3: Istio VirtualService** — fine-grained % routing at sidecar proxy level
- **Option 4: AWS ALB weighted routing** — `kubernetes.io/ingress.class: alb` with target group weights

---

## 12. RBAC

```
Subject (User/Group/ServiceAccount)
    │
    ├── RoleBinding (namespace-scoped) → Role (namespace-scoped rules)
    └── ClusterRoleBinding (cluster-wide) → ClusterRole (cluster-wide rules)
```

**ServiceAccount:**
- Identity for Pods; token auto-mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`
- Token is a JWT signed by API server; validated by API server
- Since K8s 1.22: **Bound Service Account Token** — time-limited, audience-scoped (no permanent secrets)
- `automountServiceAccountToken: false` to disable if pod doesn't need API access

**Role Example:**
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: production
  name: pod-reader
rules:
- apiGroups: [""]              # "" = core API group
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
```

**Minimal privilege for operators:**
- Operators often need `ClusterRole` with watch/list/create/update/delete on specific resources
- Scope with `namespaceSelector` in `RoleBinding` where possible

---

## 13. Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  podSelector: {}          # applies to all pods in namespace
  policyTypes: ["Ingress", "Egress"]
  # No ingress/egress rules = deny all
```

**Default deny pattern:**
1. Apply `deny-all` NetworkPolicy (no ingress/egress rules)
2. Add specific allow policies per workload

**CNI requirement:** NetworkPolicy is only enforced if the CNI plugin supports it. Flannel does NOT (requires Calico, Cilium, WeaveNet, etc.)

**Example allow-specific:**
```yaml
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes: ["Ingress"]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: frontend
    ports:
    - protocol: TCP
      port: 8080
```

---

## 14. StatefulSets

For stateful applications needing stable identity, ordered deployment, and persistent storage.

```
StatefulSet: app=postgres, replicas=3

Pods created in order:
  postgres-0  (must be Running+Ready before postgres-1 starts)
  postgres-1
  postgres-2

DNS names:
  postgres-0.postgres-headless.default.svc.cluster.local
  postgres-1.postgres-headless.default.svc.cluster.local
  postgres-2.postgres-headless.default.svc.cluster.local

PVCs created from volumeClaimTemplates:
  data-postgres-0  (stays bound even if pod is deleted/recreated)
  data-postgres-1
  data-postgres-2
```

**Key properties:**
- Pod identity is stable: same name, DNS, PVC across restarts
- Scale down: deletes in reverse order (postgres-2 first)
- Rolling update: updates in reverse order (postgres-2, postgres-1, postgres-0)
- `updateStrategy.type: OnDelete` — manual control (delete pod to trigger update)
- `partition` in rolling update: only update pods with ordinal >= partition (staged rollouts)

**Headless Service required** (`clusterIP: None`) for DNS to work per-pod.

---

## 15. Operators and CRDs

**Operator Pattern:**
- Custom Resource Definition (CRD) defines new API types
- Operator (controller) watches those custom resources + acts to converge state
- Encodes operational knowledge: how to install, upgrade, backup, failover

```
CRD: PostgresCluster (custom type)
Operator watches PostgresCluster objects
   │
   ├── Creates StatefulSet for primary
   ├── Creates StatefulSet for replicas
   ├── Configures replication
   ├── Handles failover on primary crash
   └── Manages backup schedules
```

**CRD anatomy:**
```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: postgresclusters.postgres-operator.crunchydata.com
spec:
  group: postgres-operator.crunchydata.com
  versions:
  - name: v1beta1
    served: true
    storage: true
    schema:
      openAPIV3Schema: ...   # validation schema
  scope: Namespaced
  names:
    plural: postgresclusters
    singular: postgrescluster
    kind: PostgresCluster
```

**Popular operators:** cert-manager, Prometheus Operator, Strimzi (Kafka), Zalando Postgres Operator, Crossplane

---

## 16. etcd Backup and Disaster Recovery

**Backup:**
```bash
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-snapshot.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Verify:
etcdctl snapshot status /backup/etcd-snapshot.db
```

**Restore (must stop API server first):**
```bash
ETCDCTL_API=3 etcdctl snapshot restore /backup/etcd-snapshot.db \
  --name=etcd-1 \
  --initial-cluster="etcd-1=https://10.0.0.1:2380" \
  --initial-cluster-token=etcd-cluster-1 \
  --initial-advertise-peer-urls=https://10.0.0.1:2380 \
  --data-dir=/var/lib/etcd-restored
```

- Backup frequency: every 30 minutes minimum for production
- Velero: K8s backup solution — backs up K8s resources + PV snapshots
- Multi-region: run etcd members across AZs; Raft latency-sensitive (same region preferred)

---

## Quick Reference: Key Interview Points

| Topic | Key Insight |
|-------|-------------|
| etcd quorum | n=3: tolerate 1 failure; n=5: tolerate 2; never use even numbers |
| Watch mechanism | HTTP chunked streaming from etcd; resourceVersion for resume |
| Scheduler framework | Filter (elimination) → Score (ranking) → Bind |
| CNI choice | Flannel: simple; Calico: BGP+policy; Cilium: eBPF+L7 |
| kube-proxy IPVS | O(1) hash lookup vs O(n) iptables scan |
| CPU limits | CFS throttling is silent; avoid or set generously for Java |
| JVM containers | UseContainerSupport reads cgroup; MaxRAMPercentage=75 |
| Secret encryption | base64 ≠ encrypted; use KMS provider for encryption at rest |
| HPA scale-down | 5 min stabilization window prevents flapping |
| PDB | Protects voluntary disruptions; cluster autoscaler respects it |
| StatefulSet PVC | PVC survives pod deletion — must delete PVC manually |
| SIGTERM + preStop | preStop sleep gives LB time to drain before SIGTERM |

---

Sources:
- [Kubernetes Scheduler Framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- [Kubernetes Scheduling Policies](https://kubernetes.io/docs/reference/scheduling/policies/)
- [Kubernetes Scheduler Documentation](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Beyond Scheduling: QoS, Priority, and Scoring](https://dev.to/gteegela/beyond-scheduling-how-kubernetes-uses-qos-priority-and-scoring-to-keep-your-cluster-balanced-4o8i)
