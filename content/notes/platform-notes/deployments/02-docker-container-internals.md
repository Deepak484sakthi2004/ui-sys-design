# Docker and Container Internals Deep Dive
## Senior Engineer Interview Reference — 40 LPA Level

---

## 1. Linux Primitives That Make Containers

Containers are NOT virtual machines. They are **Linux processes** with isolation and resource control via kernel features. No hypervisor. No hardware virtualization.

```
┌─────────────────────────────────────────────────────┐
│                   Container                         │
│  ┌─────────────────────────────────────────────┐   │
│  │  Process (PID 1 in container)               │   │
│  │  ├── Namespace isolation (what it sees)     │   │
│  │  │     PID, NET, MNT, UTS, IPC, USER        │   │
│  │  └── cgroup limits (what it can use)        │   │
│  │        CPU, Memory, blkio, net_cls          │   │
│  └─────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────┐   │
│  │  OverlayFS (what filesystem it sees)         │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
          Actual: still on host Linux kernel
```

---

## 2. Linux Namespaces — The Isolation Layer

A **namespace** wraps a global kernel resource so that processes inside the namespace have their own isolated instance. Creating a new namespace is a `clone()` or `unshare()` syscall.

### 2.1 PID Namespace

- Process sees its own PID tree starting from PID 1
- Container's PID 1 is the process started with `CMD`/`ENTRYPOINT`
- From the host: `ps aux` shows the same processes with DIFFERENT PIDs (host PIDs)
- When container PID 1 dies → all other processes in the container are killed (SIGKILL)
- **Java implication**: JVM must be PID 1 OR a proper init process must be PID 1
  - Problem: bash script as PID 1 — it won't forward SIGTERM to the JVM
  - Solution: use `exec java ...` in entrypoint scripts (replaces shell with JVM)
  - Or: `tini` as init process (handles zombie reaping + signal forwarding)

```bash
# Bad: shell is PID 1, JVM is PID 5 — SIGTERM goes to shell, not JVM
ENTRYPOINT ["./start.sh"]   # start.sh runs java ...

# Good: JVM is PID 1
ENTRYPOINT ["java", "-jar", "app.jar"]

# Also good: exec replaces shell with JVM
ENTRYPOINT ["/bin/sh", "-c", "exec java -jar app.jar"]
```

### 2.2 NET Namespace

- Each namespace has its own: network interfaces, routing tables, iptables rules, sockets, ports
- Container gets a virtual ethernet interface (`eth0` inside, `vethXXXX` on host)
- `veth` pair: two connected ends like a pipe; packet in one end → out the other
- Docker bridge (`docker0`): all containers on same bridge can reach each other via L2
- Port binding: `docker run -p 8080:80` — host iptables NAT rule: host:8080 → container:80

```
Host                           Container
─────                          ─────────
docker0 bridge (172.17.0.1)    eth0 (172.17.0.2)
    │                              │
    └────── veth pair ─────────────┘
            (veth0abc on host ↔ eth0 in container)
```

### 2.3 MNT Namespace (Mount Namespace)

- Each process sees its own filesystem tree
- Container sees OverlayFS as its root `/`
- `pivot_root()` or `chroot()` to switch to container filesystem
- Bind mounts: host directory available inside container (volume mounts)
- `/proc` and `/sys` can be remounted inside the namespace

### 2.4 UTS Namespace (UNIX Timesharing System)

- Isolates hostname and NIS domain name
- Container can have its own hostname (set by `docker run --hostname`)
- Without UTS namespace: changing hostname in container changes host's hostname

### 2.5 IPC Namespace

- Isolates: SysV shared memory, semaphores, message queues, POSIX message queues
- Processes in different IPC namespaces cannot use SysV IPC to communicate
- Two containers sharing IPC namespace: `docker run --ipc=container:<id>`
- K8s: pods share IPC namespace by default within the pod (all containers in a pod)

### 2.6 USER Namespace

- Maps container UIDs to different host UIDs
- Container root (UID 0) → host UID 100000 (unprivileged on host)
- Provides security: container thinks it's root, host kernel sees it as unprivileged user
- `--userns-remap` in Docker daemon enables this
- Required for rootless containers (Podman, rootless Docker)
- **Limitation**: some capabilities (like mounting filesystems) still need real root unless user namespaces + new kernel features used

### 2.7 Network Namespace (detailed)

```bash
# What happens when docker creates a container:
ip netns add container1                     # create net namespace
ip link add veth0 type veth peer name eth0  # create veth pair
ip link set eth0 netns container1           # move eth0 into namespace
ip netns exec container1 ip addr add 172.17.0.2/16 dev eth0
ip link set veth0 master docker0            # attach host end to bridge
ip link set veth0 up
ip netns exec container1 ip link set eth0 up
ip netns exec container1 ip route add default via 172.17.0.1
```

---

## 3. cgroups — The Resource Control Layer

Control Groups (cgroups) limit, prioritize, and account for resource usage.

### 3.1 cgroups v1 vs v2

**cgroups v1 (legacy):**
- Each subsystem (cpu, memory, blkio) has its own hierarchy
- `/sys/fs/cgroup/cpu/docker/<container-id>/` — cpu limits
- `/sys/fs/cgroup/memory/docker/<container-id>/` — memory limits
- Inconsistencies: a process can be in different groups for different resources
- Rootless containers difficult (unprivileged processes can't write to v1 hierarchies)

**cgroups v2 (unified, current):**
- Single unified hierarchy under `/sys/fs/cgroup/`
- All controllers in one tree: `cpu`, `memory`, `io`, `pids`, `cpuset`
- Better delegation to unprivileged users (rootless containers)
- Thread-level granularity
- Kernel 4.5+ (2016); default in most distros by 2021-2022
- Docker uses v2 when available

### 3.2 CPU Controls

**CPU Shares (v1) / cpu.weight (v2):**
- Relative weight in CFS scheduler
- Default: 1024 (v1), 100 (v2)
- Only matters when CPU is **contended**; if idle, container can use more

**CPU Quota/Period (hard limit):**
- `cpu.cfs_quota_us` / `cpu.cfs_period_us` in v1
- `cpu.max` in v2: `<quota> <period>` e.g. `200000 100000` = 2 CPUs
- Period: typically 100ms (100,000 microseconds)
- Quota: max CPU time per period
- Docker: `--cpus=2` → sets quota=200000, period=100000
- **Throttling**: when quota exhausted in period, process blocked until next period
- `container_cpu_cfs_throttled_periods_total` / `container_cpu_cfs_periods_total` → throttle %

**CPU Sets:**
- `cpuset.cpus`: pin container to specific CPU cores (NUMA optimization)
- `--cpuset-cpus="0,1,4-7"` in docker run

### 3.3 Memory Controls

- `memory.limit_in_bytes` (v1) / `memory.max` (v2): hard limit → OOM kill on breach
- `memory.soft_limit_in_bytes` (v1) / `memory.high` (v2): soft limit → kernel reclaims memory before OOM
- `memory.memsw.limit_in_bytes`: memory + swap limit (swap disabled in K8s by default)
- `memory.oom_control`: `oom_kill_disable 1` disables OOM killer (container pauses instead of dying)
- `memory.usage_in_bytes`: current memory usage (RSS + cache)

**OOM Kill sequence:**
1. Process in container allocates memory
2. Kernel cannot allocate from cgroup (at limit)
3. Kernel invokes OOM killer in cgroup
4. OOM killer selects victim (usually largest `oom_score_adj` + memory usage)
5. SIGKILL sent to victim
6. Container usually exits (if PID 1 is killed)

### 3.4 PID Limits

- `pids.max` (v2) / `pids.limit` in Docker: prevents fork bombs
- Docker default: 1000 PIDs per container (`--pids-limit`)

---

## 4. OverlayFS — The Filesystem Layer

### 4.1 How OverlayFS Works

```
mount -t overlay overlay \
  -o lowerdir=/image-layer3:/image-layer2:/image-layer1,\
     upperdir=/container-writable,\
     workdir=/container-work \
  /container-merged
```

```
 Merged view (what container sees)
 ─────────────────────────────────
          /container-merged
               ↑ union mount
 ┌─────────────────────────────┐
 │  upperdir (read-write)      │  ← container writes go here
 │  /container-writable        │
 │  modified files appear here │
 └─────────────────────────────┘
 ┌─────────────────────────────┐
 │  lowerdir (read-only)       │  ← image layers (stacked)
 │  layer3 (CMD, EXPOSE)       │  ← topmost image layer
 │  layer2 (COPY app.jar)      │
 │  layer1 (apt-get packages)  │
 │  layer0 (base OS)           │  ← bottom image layer
 └─────────────────────────────┘
 ┌─────────────────────────────┐
 │  workdir (internal)         │  ← OverlayFS internal use only
 │  /container-work            │     used during copy_up operations
 └─────────────────────────────┘
```

**File lookup resolution (top-down):**
1. Check `upperdir` (container writes)
2. Check `lowerdir` layers top to bottom
3. Return first match found

**Write operations (Copy-on-Write):**
1. Container writes to file `/app/config.yaml` (exists only in lowerdir)
2. OverlayFS performs `copy_up`: copies file from lowerdir → upperdir
3. Container modifies the copy in upperdir
4. Subsequent reads return upperdir version

**File deletion:**
- OverlayFS cannot remove a file from read-only lowerdir
- Creates a **whiteout file** in upperdir: `char device with major=minor=0` named same as deleted file
- Merged view hides any file that has a corresponding whiteout in upperdir

**Directory operations:**
- Creating new dir → new dir in upperdir
- Modifying existing dir → `opaque directory` marker in upperdir (fully replaces lower version)

### 4.2 Docker Image Layers

```
docker build sequence → each RUN/COPY/ADD creates a new layer

Layer 0: FROM ubuntu:22.04          sha256:abc123...  (pulled from registry)
Layer 1: RUN apt-get update          sha256:def456...  (new layer: /var/cache/apt/...)
         RUN apt-get install -y java
Layer 2: COPY target/app.jar /app/  sha256:ghi789...  (new layer: /app/app.jar)
Layer 3: ENTRYPOINT ["java","-jar"] sha256:jkl012...  (metadata only, no fs change)
```

**Content-addressable storage:**
- Each layer identified by SHA256 hash of its content (tar archive)
- `/var/lib/docker/overlay2/` — layer directories
- Layers are **shared** across images: if two images use same base, one copy on disk
- `docker images -a` shows intermediate layers

**Layer caching in docker build:**
- Build checks if layer's cache key matches existing layer
- Cache key = instruction + parent layer hash + context files (for COPY/ADD)
- If cache hit: reuse existing layer (fast)
- If cache miss: rebuild this layer AND all subsequent layers
- **This is why ordering matters in Dockerfile**

### 4.3 Dockerfile Layer Optimization

**Bad order (cache invalidated too early):**
```dockerfile
FROM openjdk:17
COPY . /app/                     # copies everything including source
RUN cd /app && mvn package -DskipTests
# Every source code change → invalidates all subsequent layers
```

**Good order (dependencies cached separately):**
```dockerfile
FROM maven:3.9-openjdk-17 AS builder
WORKDIR /app
COPY pom.xml .                   # copy only pom.xml first
RUN mvn dependency:go-offline    # download deps — cached unless pom changes!
COPY src/ src/                   # copy source code after
RUN mvn package -DskipTests

FROM openjdk:17-jre-slim         # multi-stage: smaller runtime image
WORKDIR /app
COPY --from=builder /app/target/app.jar app.jar
# Non-root user:
RUN addgroup --system appgroup && adduser --system appuser --ingroup appgroup
USER appuser
ENTRYPOINT ["java", "-jar", "app.jar"]
```

**Why multi-stage builds reduce image size:**
- Builder stage: contains JDK, Maven, source code, build artifacts, test dependencies
- Runtime stage: only JRE + final JAR
- Typical sizes: builder ~800MB → runtime ~180MB
- `--from=builder` copies only specified artifacts across stages
- Build cache still maintained per stage

**.dockerignore (critical for security and performance):**
```
.git
target/
*.md
.env
*.log
node_modules
.idea
Dockerfile*
docker-compose*
```
- Reduces build context sent to Docker daemon (tar of entire context)
- Prevents secrets (`.env`) from being accidentally copied into layers
- Without `.dockerignore`, `COPY . /app/` copies `.git/`, `target/`, everything

---

## 5. Container Runtime Landscape

```
Kubernetes
    │  uses CRI (Container Runtime Interface) — gRPC API
    ▼
containerd (CRI runtime)
    │  uses OCI Runtime Spec
    ▼
runc (OCI runtime — reference implementation)
    │  calls Linux kernel
    ▼
namespaces + cgroups + OverlayFS
```

**containerd:**
- Graduated CNCF project; used by Docker, Kubernetes
- Manages: image pull, image storage, container lifecycle, snapshot management
- Implements CRI: `RuntimeService` (pods/containers) + `ImageService` (images)
- Config: `/etc/containerd/config.toml`
- Snapshotter: overlayfs (default), btrfs, zfs, devmapper

**runc:**
- Reference OCI runtime; Go binary
- Takes an OCI bundle (config.json + rootfs) → calls `clone()`, mounts OverlayFS, `execve()` process
- Other OCI runtimes: `crun` (C, faster), `gVisor/runsc` (kernel sandboxing), `kata-containers` (lightweight VM)

**CRI-O:**
- Alternative CRI implementation for Kubernetes (no Docker daemon)
- Lighter than containerd; purpose-built for K8s
- Uses OCI runtimes (runc by default) via OCI interface

**Docker Engine architecture:**
```
docker CLI
    │ REST API
    ▼
dockerd (Docker daemon)
    │ gRPC
    ▼
containerd
    │ OCI
    ▼
runc
```
- Docker in production K8s: dockershim was removed in K8s 1.24
- K8s now speaks directly to containerd/CRI-O via CRI

---

## 6. Docker Networking In Depth

### 6.1 Bridge Network (default)

```
Host
├── eth0 (10.0.0.5 — real NIC)
├── docker0 (172.17.0.1 — bridge, virtual)
│    ├── veth0abc  ←→ eth0 (172.17.0.2) [Container 1]
│    └── veth0def  ←→ eth0 (172.17.0.3) [Container 2]
```

**Container-to-container (same bridge):**
- ARP within bridge; direct L2 forwarding; no NAT

**Container-to-external:**
- Packet exits via docker0 → host routing table → eth0
- NAT via iptables MASQUERADE: container IP 172.17.0.2 → host IP 10.0.0.5

**External-to-container (published port):**
- `docker run -p 8080:80`
- iptables PREROUTING DNAT: host:8080 → 172.17.0.2:80

**Custom bridge vs default bridge:**
- Custom: automatic DNS between containers by name (`container1` resolves to IP)
- Default bridge: only by IP or `--link` (deprecated)
- Create: `docker network create --driver bridge my-network`

### 6.2 Host Network

```
docker run --network=host nginx
```
- Container shares host's network namespace — no isolation
- Container's port 80 IS host's port 80
- No NAT, no port mapping
- Use case: performance-critical (avoids NAT overhead), or when app needs host IP

### 6.3 None Network

```
docker run --network=none
```
- No network interfaces except loopback (`lo`)
- Complete network isolation
- Use case: batch jobs, security-sensitive processing

### 6.4 Overlay Network (Docker Swarm)

- Multi-host networking via VXLAN encapsulation
- Containers on different hosts communicate transparently
- Similar to Kubernetes Flannel VXLAN

---

## 7. Volume Types

### 7.1 Bind Mount

```bash
docker run -v /host/path:/container/path:ro nginx
# OR modern syntax:
docker run --mount type=bind,source=/host/path,target=/container/path,readonly nginx
```

- Direct access to host filesystem path
- No Docker daemon involvement — kernel bind mount
- Performance: same as host filesystem (no layers)
- Risk: container writes directly to host; use `:ro` for configs/secrets

### 7.2 Docker Volume (Named Volume)

```bash
docker volume create my-data
docker run -v my-data:/app/data nginx
```

- Managed by Docker daemon
- Stored in `/var/lib/docker/volumes/my-data/_data/`
- Survives container removal (explicit `docker volume rm` required)
- Can use volume drivers: `local`, `nfs`, `aws-efs`, etc.
- Preferred for persistent data over bind mounts

### 7.3 tmpfs Mount

```bash
docker run --mount type=tmpfs,destination=/app/cache,tmpfs-size=100m nginx
```

- Stored in host memory (not on disk)
- Ephemeral: disappears when container stops
- Use case: sensitive data (session tokens, temp encryption keys), high-speed temp storage
- No I/O to disk — very fast

---

## 8. Container Security

### 8.1 Running as Non-Root

```dockerfile
# Create user in Dockerfile
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser
USER appuser
```

```yaml
# Kubernetes: enforce non-root
securityContext:
  runAsNonRoot: true
  runAsUser: 1001
  runAsGroup: 1001
```

**Why non-root matters:**
- If container process breaks out via kernel exploit → limited to unprivileged user on host
- Root in container (without user namespaces) = root on host

### 8.2 Linux Capabilities

Traditional Linux: root can do everything. Capabilities split root powers into ~40 distinct units.

**Container default capabilities (Docker):**
```
CHOWN, DAC_OVERRIDE, FSETID, FOWNER, MKNOD, NET_RAW, SETGID, SETUID,
SETFCAP, SETPCAP, NET_BIND_SERVICE, SYS_CHROOT, KILL, AUDIT_WRITE
```

**Drop all, add only what you need:**
```yaml
# Kubernetes:
securityContext:
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]   # if app needs port < 1024
```

```bash
# Docker:
docker run --cap-drop ALL --cap-add NET_BIND_SERVICE nginx
```

### 8.3 Read-Only Filesystem

```yaml
securityContext:
  readOnlyRootFilesystem: true
# Then mount writable volumes only where needed:
volumeMounts:
- name: tmp
  mountPath: /tmp
volumes:
- name: tmp
  emptyDir: {}
```

### 8.4 Seccomp Profiles

- Syscall filter: whitelist which syscalls the container can make
- Default Docker profile blocks ~60 dangerous syscalls (`ptrace`, `kexec_load`, `mount`, etc.)
- RuntimeDefault in K8s: applies the container runtime's default seccomp profile

```yaml
securityContext:
  seccompProfile:
    type: RuntimeDefault    # OR: Localhost (custom profile)
```

**Custom profile example:**
```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {"names": ["read","write","open","close","stat","exit"], "action": "SCMP_ACT_ALLOW"}
  ]
}
```

### 8.5 AppArmor

- Mandatory Access Control: per-program security profiles
- Profiles specify allowed file accesses, network access, capabilities
- Applied via annotation: `container.apparmor.security.beta.kubernetes.io/<container>: runtime/default`

### 8.6 Security Contexts Summary

```yaml
spec:
  securityContext:                    # Pod-level
    runAsNonRoot: true
    runAsUser: 1001
    fsGroup: 2000                     # volume ownership
    seccompProfile:
      type: RuntimeDefault
  containers:
  - securityContext:                  # Container-level (overrides pod)
      allowPrivilegeEscalation: false  # prevents setuid/setgid escalation
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
```

---

## 9. Docker Image Architecture

### 9.1 Image Manifest

```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
  "config": {
    "mediaType": "application/vnd.docker.container.image.v1+json",
    "size": 7023,
    "digest": "sha256:b5b2b2c507a0944348e0303114d8d93aaaa081732b86451d9bce1f432a537bc7"
  },
  "layers": [
    {
      "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
      "size": 32654,
      "digest": "sha256:e692418e4cbaf90ca69d05a66403747baa33ee08806650b51fab574d857d2f66"
    },
    {
      "mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip",
      "size": 16724,
      "digest": "sha256:3c3a4604a545cdc127456d94e421cd355bca5b528f4a9c1905b15da2eb4a4c6b"
    }
  ]
}
```

### 9.2 How `docker pull` Works

```
docker pull openjdk:17-jre-slim
  │
  ├── 1. Resolve tag → manifest digest from registry (HTTPS GET)
  ├── 2. Fetch manifest (JSON) — get list of layer digests
  ├── 3. For each layer:
  │      - Check if layer already in local cache by digest
  │      - If not: download gzipped tar, verify SHA256
  │      - Extract to /var/lib/docker/overlay2/<id>/diff/
  ├── 4. Fetch config blob (container config JSON)
  └── 5. Create image record in containerd/docker metadata DB
```

**Multi-platform images (manifest list / image index):**
```json
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.docker.distribution.manifest.list.v2+json",
  "manifests": [
    { "platform": {"os": "linux", "architecture": "amd64"},
      "digest": "sha256:amd64-manifest-digest" },
    { "platform": {"os": "linux", "architecture": "arm64"},
      "digest": "sha256:arm64-manifest-digest" }
  ]
}
```
- `docker buildx build --platform linux/amd64,linux/arm64 --push`
- Registry returns correct manifest for client's platform
- QEMU emulation or cross-compilation for building multi-arch

### 9.3 Image Signing (Cosign/Notary)

- `cosign sign <image>` — attaches OCI signature artifact to registry
- `cosign verify <image>` — verifies signature
- Policy enforcement: `Kyverno` or `OPA/Gatekeeper` can block unsigned images in K8s

---

## 10. JVM in Docker — Complete Picture

### 10.1 The Historical Problem (Pre-JDK 8u191)

```
Host: 64 CPU cores, 256GB RAM
Container limits: 2 CPUs, 4GB RAM
JVM (old): reads /proc/cpuinfo, /proc/meminfo → configures for HOST resources

Result:
- Heap size: -XX:MaxHeapSize = 256GB * 0.25 = 64GB (!)
- GC threads: 64 * 3/8 = 24 threads
- JIT compiler threads: based on 64 CPUs
- Container gets OOM killed immediately
- Or: JVM spawns 24 GC threads, all throttled by cgroup CPU quota → terrible GC pauses
```

### 10.2 The Fix: Container Awareness

**JDK 8u191+ / JDK 10+: `-XX:+UseContainerSupport` (default ON from JDK 10)**

```
JVM now reads:
  /sys/fs/cgroup/cpu/cpu.cfs_quota_us    → CPU count
  /sys/fs/cgroup/cpu/cpu.cfs_period_us
  /sys/fs/cgroup/memory/memory.limit_in_bytes → memory limit
  (v2: /sys/fs/cgroup/cpu.max, /sys/fs/cgroup/memory.max)

Correctly calculates:
  CPU count = quota / period (e.g., 200000 / 100000 = 2 CPUs)
  MaxHeap = memory.limit_in_bytes * MaxRAMPercentage / 100
```

### 10.3 cgroups v2 and JVM

- JDK 15+ fully supports cgroups v2
- JDK 8u/11 on cgroups v2: may not read limits correctly
- Fix for older JDK on cgroup v2: set explicit `-Xmx` or use `--cgroupns=host` (not recommended)

### 10.4 Complete JVM Flag Reference for Containers

```bash
# Minimal required flags
-XX:+UseContainerSupport               # read cgroup (ON by default JDK10+)
-XX:MaxRAMPercentage=75.0              # 75% of container memory for heap
-XX:InitialRAMPercentage=50.0          # initial heap = 50%
-XX:MinRAMPercentage=25.0              # min heap for small containers

# GC configuration
-XX:+UseG1GC                           # G1GC default since JDK 9
# For low-latency (Java 15+):
-XX:+UseZGC -XX:+ZGenerational         # ZGC: sub-ms GC pauses, container-aware

# Debugging / observability
-XX:+ExitOnOutOfMemoryError            # die cleanly, trigger pod restart
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/dumps/heapdump.hprof

# CPU override (if cgroup detection unreliable)
-XX:ActiveProcessorCount=2             # explicit CPU count

# GC thread tuning (if too many threads cause throttling)
-XX:ParallelGCThreads=2
-XX:ConcGCThreads=1

# Startup optimization
-XX:TieredStopAtLevel=1               # quick startup (no JIT opt), use for CLI tools
# OR: use CDS (Class Data Sharing)
-XX:SharedArchiveFile=app.jsa
```

### 10.5 Memory Sizing in Practice

```
Container memory limit: 2GB

JVM heap (MaxRAMPercentage=75):   1.5 GB
Non-heap memory (estimated):      ~500 MB
  ├── Metaspace:                   ~200 MB (loaded classes)
  ├── CodeCache:                   ~100 MB (JIT compiled code)
  ├── Thread stacks:               ~50 MB  (500 threads * 512KB default)
  ├── DirectByteBuffers:           ~50 MB  (NIO, Netty, SSL)
  └── GC overhead:                 ~100 MB

Total:                             ~2 GB (fits in limit)
```

**Monitor with:**
- `jcmd <pid> VM.native_memory` — full memory breakdown
- Prometheus: `jvm_memory_bytes_used{area="nonheap"}` (Micrometer)
- `container_memory_working_set_bytes` vs container limit

### 10.6 Graceful JVM Shutdown in Docker/K8s

**Problem without proper signal handling:**
```
K8s sends SIGTERM to PID 1
PID 1 = shell script → doesn't forward SIGTERM to JVM
JVM never receives SIGTERM → doesn't shut down gracefully
terminationGracePeriodSeconds expires → SIGKILL → data corruption possible
```

**Solution chain:**
```
1. Dockerfile: ENTRYPOINT ["java", ...] (exec form, no shell)
   OR: ENTRYPOINT ["/bin/sh", "-c", "exec java ..."] (exec replaces shell)

2. Spring Boot: server.shutdown=graceful
   spring.lifecycle.timeout-per-shutdown-phase=30s
   → existing requests complete, new requests rejected (503)

3. K8s preStop hook:
   lifecycle:
     preStop:
       exec:
         command: ["sh", "-c", "sleep 10"]
   # This sleep allows kube-proxy/LB to remove pod from endpoints
   # before SIGTERM is sent — drains in-flight traffic

4. terminationGracePeriodSeconds: 60
   # Must be > preStop time + graceful shutdown time
   # 10s drain + 30s graceful shutdown + buffer = 50s → 60s

5. JVM receives SIGTERM:
   - Spring Boot closes HTTP server (rejects new connections)
   - Completes existing requests up to timeout
   - Closes datasource pools, message consumers
   - Triggers @PreDestroy / DisposableBean.destroy()
   - JVM exits with code 143 (128 + 15 for SIGTERM)
```

### 10.7 JVM Startup Time in Containers

K8s liveness/readiness probes require fast startup:
- `initialDelaySeconds`: time before first probe
- `failureThreshold × periodSeconds`: max time to start

**Startup optimization:**
```
Option 1: -XX:TieredStopAtLevel=1 (interpreter + C1 JIT only)
  - Faster startup, lower peak throughput

Option 2: AppCDS (Application Class Data Sharing)
  - Pre-populate class metadata cache
  - ~30% faster startup, smaller memory footprint

Option 3: GraalVM Native Image
  - Ahead-of-time compilation: 10ms startup, 5x lower memory
  - Limitations: reflection/dynamic proxies need explicit config

Option 4: Project Leyden (future OpenJDK)
  - AOT class loading + code optimization snapshots
```

---

## Quick Reference: Key Interview Points

| Topic | Key Insight |
|-------|-------------|
| Container = process | Uses namespaces (isolation) + cgroups (limits); NOT a VM |
| PID namespace | PID 1 must handle SIGTERM; use `exec java` or tini |
| OverlayFS copy_up | First write triggers full file copy from lower to upper layer |
| Layer caching | Instructions after a cache miss rebuild all following layers |
| Multi-stage builds | Builder stage discarded; only artifacts copied to runtime stage |
| cgroup CPU throttle | Silent performance degradation; check throttled_periods metric |
| cgroups v1 vs v2 | v2 unified hierarchy; JDK 15+ required for full v2 support |
| JVM pre-8u191 | Reads host /proc/cpuinfo, /proc/meminfo — completely wrong limits |
| UseContainerSupport | Reads cgroup limits; ON by default JDK10+; backported to 8u191 |
| MaxRAMPercentage=75 | Leave 25% for Metaspace, CodeCache, threads, DirectBuffers |
| Non-root container | Container root without user namespace = host root |
| Seccomp profile | Blocks dangerous syscalls; RuntimeDefault is the safe baseline |

---

Sources:
- [Docker OverlayFS Storage Driver Documentation](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)
- [OverlayFS Internals - Julia Evans](https://jvns.ca/blog/2019/11/18/how-containers-work--overlayfs/)
- [Docker OverlayFS Deep Dive](https://www.petermcconnell.com/posts/docker-overlayfs/)
- [OverlayFS — The Magic Behind Docker](https://dev.to/hrrydgls/overlayfs-the-magic-behind-docker-52c6)
