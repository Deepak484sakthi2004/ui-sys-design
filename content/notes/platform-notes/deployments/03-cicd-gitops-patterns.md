# CI/CD, GitOps, and Deployment Patterns
## Senior Engineer Interview Reference — 40 LPA Level

---

## 1. CI/CD Pipeline Architecture

```
Source Control (Git)
      │
      │ push / PR / tag
      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CI Pipeline                              │
│                                                                 │
│  [Source] → [Build] → [Unit Test] → [Security Scan] →         │
│  [Integration Test] → [Build Docker Image] → [Push Artifact]  │
└─────────────────────────────────────┬───────────────────────────┘
                                      │ artifact (image tag)
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        CD Pipeline / GitOps                     │
│                                                                 │
│  [Update Git (Helm values / kustomize)] → [ArgoCD / Flux]      │
│  → [Deploy to Dev] → [Smoke Test] → [Deploy to Staging]        │
│  → [Integration/E2E Test] → [Manual Gate] → [Deploy to Prod]   │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 Stage Design

**Source Stage:**
- Trigger: push to branch, PR creation/update, tag creation
- Checkout code, set up build environment
- Determine what changed (path filters for monorepos)

**Build Stage:**
- Java: `mvn clean package -DskipTests` or `gradle build -x test`
- Parallel with test stages where possible
- Artifact: JAR/WAR file → stored as pipeline artifact

**Test Stages:**
- Unit tests: fast, no external dependencies (mock everything)
- Integration tests: start database/message broker via Docker Compose or Testcontainers
- Contract tests: Pact for API compatibility between services
- Performance smoke: basic latency/throughput check

**Security Scan:**
- SAST (Static Analysis): Checkmarx, Semgrep, SpotBugs
- Dependency scan: OWASP Dependency-Check, Snyk, Trivy (for libraries)
- Secret scanning: git-secrets, truffleHog, GitHub Secret Scanning (prevents committing passwords)
- Container image scan: Trivy, Grype, Snyk Container (checks OS packages + app dependencies)
- DAST (Dynamic): OWASP ZAP against staging environment

**Artifact Stage:**
- Build Docker image (Dockerfile or Buildah/Kaniko in CI)
- Tag: `<service>:<git-sha>` (never `latest` in production!)
- Push to registry: ECR, GCR, Docker Hub, Harbor
- Sign image with Cosign (supply chain security)

**Deploy Stage:**
- GitOps model: update image tag in Git → ArgoCD/Flux deploys
- Direct K8s: `kubectl set image` or `helm upgrade`

### 1.2 Artifact Management

**Maven → Artifactory/Nexus → Docker Registry → K8s:**
```
mvn deploy → Artifactory (JARs, WARs, BOM)
                 │
                 │ (CI picks up artifact)
                 ▼
docker build + push → Amazon ECR / Harbor
                 │
                 │ (GitOps: update helm values with new image tag)
                 ▼
ArgoCD → kubectl apply → K8s cluster
```

**Versioning strategy:**
- Semantic versioning (releases): `1.2.3`
- CI builds: `1.2.3-SNAPSHOT`, `1.2.3-git-sha8`
- Docker images: `app:1.2.3-abc12345` (release tag + git SHA)
- `latest` tag: NEVER use in K8s deployments (you lose traceability)

---

## 2. GitHub Actions Deep Dive

### 2.1 Architecture

```
GitHub Actions
    │
    ├── Workflow (.github/workflows/*.yml)
    │     ├── Triggered by: push, pull_request, schedule, workflow_dispatch, etc.
    │     └── Contains: jobs
    │
    ├── Job (runs on a runner, has steps)
    │     ├── Runs on: ubuntu-latest, self-hosted, windows-latest, macos-latest
    │     ├── Needs: job dependencies
    │     └── Contains: steps
    │
    ├── Step (individual task)
    │     ├── uses: <action>@v3  (call a reusable action)
    │     └── run: <shell command>
    │
    └── Runner
          ├── GitHub-hosted: GitHub manages, ephemeral VM per job
          └── Self-hosted: your infrastructure (EKS, EC2, bare metal)
```

### 2.2 Workflow Anatomy

```yaml
name: CI/CD Pipeline

on:
  push:
    branches: [main, 'release/**']
  pull_request:
    branches: [main]
  workflow_dispatch:        # manual trigger with optional inputs
    inputs:
      environment:
        type: choice
        options: [staging, production]

env:
  REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  IMAGE_NAME: my-service

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}   # pass to other jobs
    steps:
    - uses: actions/checkout@v4

    - name: Set up JDK 21
      uses: actions/setup-java@v4
      with:
        java-version: '21'
        distribution: 'temurin'
        cache: 'maven'         # caches ~/.m2/repository

    - name: Run tests
      run: mvn test

    - name: Build image
      id: meta
      uses: docker/metadata-action@v5
      with:
        images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
        tags: |
          type=sha,prefix=,suffix=,format=short
          type=semver,pattern={{version}}
```

### 2.3 Matrix Builds

```yaml
jobs:
  test:
    strategy:
      matrix:
        java-version: [17, 21]
        os: [ubuntu-latest, windows-latest]
        exclude:
        - java-version: 17
          os: windows-latest      # skip this combination
      fail-fast: false            # don't cancel others if one fails
    runs-on: ${{ matrix.os }}
    steps:
    - uses: actions/setup-java@v4
      with:
        java-version: ${{ matrix.java-version }}
```

### 2.4 Reusable Workflows

```yaml
# .github/workflows/reusable-build.yml
on:
  workflow_call:
    inputs:
      java-version:
        required: true
        type: string
    secrets:
      registry-password:
        required: true
    outputs:
      image-digest:
        description: "Built image digest"
        value: ${{ jobs.build.outputs.digest }}

# .github/workflows/service-a-ci.yml
jobs:
  build:
    uses: ./.github/workflows/reusable-build.yml
    with:
      java-version: '21'
    secrets:
      registry-password: ${{ secrets.ECR_PASSWORD }}
```

### 2.5 Caching

```yaml
- name: Cache Maven dependencies
  uses: actions/cache@v4
  with:
    path: ~/.m2/repository
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    restore-keys: |
      ${{ runner.os }}-maven-
      # Falls back to this prefix if exact key not found
```

**Cache key strategy:**
- `hashFiles('**/pom.xml')`: changes when any pom.xml changes → new cache
- `restore-keys`: partial match — loads old cache, still faster than fresh download
- Cache is per-branch; cache from default branch is available to other branches

### 2.6 OIDC Authentication (No Long-Lived Credentials)

**Traditional (bad):** Store `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as GitHub Secrets — long-lived, risky if leaked.

**OIDC (good):** GitHub mints a short-lived JWT for each workflow run; AWS verifies JWT directly.

```yaml
permissions:
  id-token: write    # required to request the OIDC token
  contents: read

steps:
- name: Configure AWS credentials via OIDC
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789:role/GitHubActionsRole
    aws-region: us-east-1
    # No access keys needed!

# The OIDC flow:
# 1. GitHub creates JWT: iss=token.actions.githubusercontent.com,
#    sub=repo:org/repo:ref:refs/heads/main
# 2. Action calls AWS STS AssumeRoleWithWebIdentity
# 3. STS validates JWT signature + checks trust policy conditions
# 4. Returns temp credentials (valid 1 hour)
```

**AWS IAM Trust Policy:**
```json
{
  "Principal": {"Federated": "arn:aws:iam::123456789:oidc-provider/token.actions.githubusercontent.com"},
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:myorg/myrepo:*"
    },
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    }
  }
}
```

---

## 3. GitLab CI

### 3.1 .gitlab-ci.yml Structure

```yaml
stages:
- build
- test
- security
- package
- deploy

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=$CI_PROJECT_DIR/.m2/repository"

# Template jobs (reusable)
.java-base: &java-base
  image: maven:3.9-openjdk-21
  cache:
    key: "$CI_COMMIT_REF_SLUG"
    paths:
    - .m2/repository/

build:
  <<: *java-base
  stage: build
  script:
  - mvn clean compile
  artifacts:
    paths:
    - target/
    expire_in: 1 day

unit-test:
  <<: *java-base
  stage: test
  script:
  - mvn test
  artifacts:
    reports:
      junit: target/surefire-reports/TEST-*.xml  # GitLab parses JUnit XML
    when: always

# Build image — Kaniko (no Docker daemon needed)
build-image:
  stage: package
  image:
    name: gcr.io/kaniko-project/executor:v1.23.0-debug
    entrypoint: [""]
  script:
  - /kaniko/executor
    --context $CI_PROJECT_DIR
    --dockerfile $CI_PROJECT_DIR/Dockerfile
    --destination $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
    --destination $CI_REGISTRY_IMAGE:latest
  rules:
  - if: $CI_COMMIT_BRANCH == "main"
```

### 3.2 GitLab Runner

- Executor types: `docker`, `kubernetes`, `shell`, `docker-machine`
- `docker` executor: each job runs in a fresh Docker container
- `kubernetes` executor: each job spins up a K8s pod (autoscaling CI)
- Runners registered with `gitlab-runner register` → `config.toml`

### 3.3 DinD vs Kaniko

**Docker in Docker (DinD):**
```yaml
build-image-dind:
  image: docker:24
  services:
  - name: docker:24-dind       # separate DinD container
    alias: docker
  variables:
    DOCKER_HOST: tcp://docker:2376
    DOCKER_TLS_CERTDIR: "/certs"
  script:
  - docker build -t myapp:$CI_COMMIT_SHORT_SHA .
  - docker push myapp:$CI_COMMIT_SHORT_SHA
```
**Problems with DinD:**
- Requires `--privileged` flag (security risk — container has root-like host access)
- Docker daemon inside container → doesn't share layers with host → slow pulls

**Kaniko (recommended):**
- Builds Docker images without Docker daemon or `--privileged`
- Reads Dockerfile, builds layers in userspace
- Pushes directly to registry
- Runs as a regular (non-privileged) container
- Works natively in K8s pods

**Other alternatives:**
- `Buildah` (Red Hat): OCI-compliant, rootless image builds
- `img` (Jessie Frazelle): rootless Docker builds
- `BuildKit` (Docker): `docker buildx` — more efficient layer caching, parallel stages

---

## 4. GitOps

### 4.1 GitOps Principles

```
Traditional CD:                    GitOps:
──────────────                     ────────
CI pipeline pushes directly        CI pipeline updates Git
to cluster (kubectl, helm)         GitOps controller pulls from Git
│                                  and applies to cluster
└─ "push-based" deployment         └─ "pull-based" deployment

Problems with push-based:          GitOps benefits:
- CI needs cluster credentials     - Cluster credentials NOT in CI
- No drift detection               - Drift detected + auto-corrected
- Hard to see desired state        - Git IS the desired state (audit trail)
- Manual rollback                  - Rollback = git revert
```

**Four Principles of GitOps:**
1. **Declarative**: entire system described declaratively
2. **Versioned and immutable**: desired state stored in Git (version history, revert)
3. **Pulled automatically**: software agents pull desired state from Git
4. **Continuously reconciled**: software agents continuously observe and correct

### 4.2 ArgoCD vs Flux

| Feature | ArgoCD | Flux v2 |
|---------|--------|---------|
| UI | Rich web UI | No UI (third-party: Weave GitOps) |
| Architecture | Server-side | Agent-only (no server) |
| Multi-cluster | Yes (app-of-apps) | Yes (fleet management) |
| Config | Application CRDs | Kustomization + HelmRelease CRDs |
| Multi-tenancy | Built-in RBAC | Via namespace isolation |
| Image automation | External (Argo Image Updater) | Built-in (ImageUpdateAutomation) |
| Helm support | Native | Native (HelmController) |
| Community | Larger | Growing (CNCF) |

---

## 5. ArgoCD Deep Dive

### 5.1 Architecture

```
Git Repository
      │
      │ (webhook or poll every 3min)
      ▼
┌─────────────────────────────────────────────────────────────────┐
│                        ArgoCD                                   │
│                                                                 │
│  argocd-repo-server                                            │
│  ├── Clones Git repo                                           │
│  ├── Renders manifests (Helm, Kustomize, plain YAML)           │
│  └── Returns rendered YAML                                     │
│                                                                 │
│  argocd-application-controller                                 │
│  ├── Watches Application CRDs                                  │
│  ├── Compares desired (Git) vs actual (cluster)                │
│  ├── Detects OutOfSync state                                   │
│  └── Triggers sync operations                                  │
│                                                                 │
│  argocd-server (API + UI)                                       │
│  ├── REST/gRPC API for CLI/UI                                  │
│  ├── Webhook receiver                                          │
│  └── Authentication (OIDC, LDAP, GitHub OAuth)                │
│                                                                 │
│  argocd-dex-server (OIDC/OAuth2 provider)                      │
│  redis (cache for repo server results)                         │
└─────────────────────────────────────────────────────────────────┘
      │
      │ kubectl apply (impersonates ServiceAccount)
      ▼
Kubernetes Cluster
```

### 5.2 Reconciliation Loop

```
1. Git commit pushed (or timer fires every 3min + jitter)
2. Webhook hits argocd-server → enqueues app for refresh
3. argocd-repo-server clones/fetches Git repo
4. Renders manifests (runs helm template / kustomize build)
5. argocd-application-controller fetches live cluster state (kubectl get)
6. Compares: desired (rendered YAML) vs actual (live state)
   - Difference found → status: OutOfSync
7. If autoSync enabled: triggers sync
8. Sync applies resources to cluster (kubectl apply)
9. Tracks rollout completion (watches Deployment rollout)
10. Status: Synced + Healthy (or Degraded if pods fail)
```

**Diff engine:**
- ArgoCD uses a three-way merge: last-applied ↔ desired ↔ live
- Ignores fields set by K8s (status, resourceVersion, managedFields)
- `ignoreDifferences` in Application spec to ignore specific fields:
```yaml
ignoreDifferences:
- group: apps
  kind: Deployment
  jsonPointers:
  - /spec/replicas    # ignore replica count (if HPA manages it)
```

### 5.3 Application CRD

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-service
  namespace: argocd
  finalizers:
  - resources-finalizer.argocd.argoproj.io  # cascade delete resources on app delete
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/gitops-config
    targetRevision: HEAD
    path: apps/my-service/overlays/production
    # For Helm:
    # chart: my-service
    # helm:
    #   valueFiles: ["values-production.yaml"]
  destination:
    server: https://kubernetes.default.svc  # in-cluster
    namespace: production
  syncPolicy:
    automated:
      prune: true          # delete resources removed from Git
      selfHeal: true       # revert manual changes to cluster
    syncOptions:
    - CreateNamespace=true
    - PrunePropagationPolicy=foreground
    - ApplyOutOfSyncOnly=true  # only apply changed resources (faster sync)
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### 5.4 Sync Phases and Hooks

```
PreSync hooks (e.g., database migrations)
      │ wait for PreSync to complete
      ▼
Sync phase (apply all resources)
      │ wait for resources to be healthy
      ▼
PostSync hooks (e.g., integration tests, notifications)
      │
      ▼
SyncFail hooks (e.g., rollback on failure)
```

```yaml
# Database migration job (PreSync hook)
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded  # clean up on success
spec:
  template:
    spec:
      containers:
      - name: migrate
        image: myapp:1.2.3
        command: ["java", "-jar", "app.jar", "--migrate-only"]
      restartPolicy: Never
```

**Sync waves (ordering within a phase):**
```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "0"   # lower number → applied first
# Wave -5: namespaces, CRDs
# Wave 0: configmaps, secrets (default)
# Wave 5: deployments, services
# Wave 10: ingresses
```

### 5.5 ApplicationSets — Multi-Cluster/Environment Deployment

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: my-service-all-envs
spec:
  generators:
  - list:
      elements:
      - cluster: dev
        url: https://dev-cluster.example.com
        namespace: dev
        imageTag: latest
      - cluster: staging
        url: https://staging-cluster.example.com
        namespace: staging
        imageTag: v1.2.3
      - cluster: production
        url: https://prod-cluster.example.com
        namespace: production
        imageTag: v1.2.3
  template:
    metadata:
      name: 'my-service-{{cluster}}'
    spec:
      source:
        path: 'apps/my-service/overlays/{{cluster}}'
```

**Generator types:**
- `list`: explicit list of values
- `git`: discover directories/files in Git repo
- `cluster`: all registered ArgoCD clusters
- `matrix`: cartesian product of two generators
- `merge`: combine generators with override

### 5.6 App of Apps Pattern

```
ArgoCD manages one "root" Application
   └── root-app (points to apps/ directory in Git)
         ├── Creates Application for service-a
         ├── Creates Application for service-b
         ├── Creates Application for infrastructure (cert-manager)
         └── Creates Application for monitoring (prometheus-stack)
```

Allows bootstrapping an entire cluster from a single ArgoCD Application.

---

## 6. Helm

### 6.1 Chart Structure

```
my-service/
├── Chart.yaml          # metadata: name, version, appVersion, dependencies
├── values.yaml         # default values
├── values-production.yaml  # override file (not in chart, referenced externally)
├── charts/             # dependencies (subcharts)
├── templates/
│   ├── _helpers.tpl    # named templates (define blocks, reusable)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   ├── hpa.yaml
│   └── NOTES.txt       # printed after helm install
└── .helmignore
```

### 6.2 Go Templating

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "my-service.fullname" . }}   # use named template
  labels:
    {{- include "my-service.labels" . | nindent 4 }}  # nindent adds newline + indent
spec:
  replicas: {{ .Values.replicaCount }}
  {{- if .Values.hpa.enabled }}  # conditional block
  # HPA manages replicas when enabled
  {{- else }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  template:
    spec:
      containers:
      - name: {{ .Chart.Name }}
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
        {{- with .Values.resources }}    # with: sets . to this value if non-empty
        resources:
          {{- toYaml . | nindent 10 }}
        {{- end }}
        env:
        {{- range .Values.extraEnv }}    # range: iterate over list
        - name: {{ .name }}
          value: {{ .value | quote }}    # quote: wraps in ""
        {{- end }}
```

**_helpers.tpl:**
```yaml
{{- define "my-service.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
```

### 6.3 Helm Hooks

```yaml
annotations:
  "helm.sh/hook": pre-upgrade        # or: post-install, pre-rollback, etc.
  "helm.sh/hook-weight": "5"         # execution order (-100 to 100)
  "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
```

Hook types: `pre-install`, `post-install`, `pre-upgrade`, `post-upgrade`, `pre-delete`, `post-delete`, `pre-rollback`, `post-rollback`, `test`

### 6.4 Helm vs Kustomize vs Raw YAML

| | Helm | Kustomize | Raw YAML |
|-|------|-----------|----------|
| Templating | Go templates | No templates | No |
| Reuse | Charts (versioned) | Bases + overlays | Copy-paste |
| Package management | Yes (Helm repos) | No | No |
| Per-environment config | values.yaml per env | Overlays | Separate files |
| Learning curve | High (Go templating) | Low | None |
| ArgoCD support | Native | Native | Native |
| Complexity | Can get complex | Clear structure | Simple but verbose |

**Kustomize + Helm (best of both):** Helm generates base, Kustomize patches for env-specific changes.

---

## 7. Kustomize

### 7.1 Structure

```
k8s/
├── base/                    # common resources
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── configmap.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── replica-patch.yaml
    ├── staging/
    │   ├── kustomization.yaml
    │   └── staging-values.yaml
    └── production/
        ├── kustomization.yaml
        ├── hpa.yaml
        └── resource-limits-patch.yaml
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
commonLabels:
  app: my-service

# overlays/production/kustomization.yaml
bases:
- ../../base
namePrefix: prod-                     # prefix all resource names
namespace: production
images:
- name: myapp
  newTag: v1.2.3                       # override image tag
patchesStrategicMerge:
- resource-limits-patch.yaml           # merge patch
patchesJSON6902:
- target:
    group: apps
    version: v1
    kind: Deployment
    name: my-service
  patch: |-
    - op: replace
      path: /spec/replicas
      value: 5
```

---

## 8. Deployment Strategies Deep Dive

### 8.1 Rolling Update

```
Initial: [v1, v1, v1, v1, v1]  (desired=5)
maxSurge=1, maxUnavailable=0

Step 1: [v1, v1, v1, v1, v1, v2]  (create surge pod)
Step 2: [v1, v1, v1, v1, __, v2]  (terminate v1 when v2 ready)
Step 3: [v1, v1, v1, v1, v2, v2]  (create another v2)
...continues...
Final:  [v2, v2, v2, v2, v2]
```

**Zero-downtime requirements:**
1. `maxUnavailable: 0` — no pod removed until new one is Ready
2. Readiness probe correctly configured — pod only "Ready" when serving traffic
3. PodDisruptionBudget — external processes can't disrupt during rollout
4. `preStop` hook — existing connections complete before pod removed from LB

**Rollback:**
```bash
kubectl rollout undo deployment/my-service
kubectl rollout undo deployment/my-service --to-revision=3
kubectl rollout history deployment/my-service
```

### 8.2 Blue/Green Deployment

```
Blue (v1) - Live          Green (v2) - Staging
────────────────          ──────────────────────
Deployment: app-blue      Deployment: app-green
Labels: version=blue      Labels: version=green
Replicas: 5               Replicas: 5

Service:
  selector:
    version: blue   →  (switch to: version: green)
```

**Traffic cutover:**
```bash
kubectl patch service my-service -p '{"spec":{"selector":{"version":"green"}}}'
```

**Database considerations:**
- Blue/Green requires **backward-compatible** schema changes
- Pattern: Expand → Migrate → Contract
  - Expand: add new column (nullable, no constraint) — v1 still works
  - Deploy green (v2): writes to both old + new column
  - Migrate: backfill data in new column
  - Contract: remove old column (only after old version removed)

**Rollback:** Switch selector back to `blue` (blue pods still running).

### 8.3 Canary Deployment

**Option 1: Argo Rollouts**
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-service
spec:
  strategy:
    canary:
      steps:
      - setWeight: 10        # 10% traffic to canary
      - pause: {duration: 5m}  # wait 5 minutes
      - analysis:            # check metrics
          templates:
          - templateName: error-rate-check
      - setWeight: 50        # 50% traffic
      - pause: {duration: 10m}
      - setWeight: 100       # full rollout
      canaryService: my-service-canary
      stableService: my-service-stable
      trafficRouting:
        istio:
          virtualService:
            name: my-service-vsvc
```

**Option 2: Istio VirtualService**
```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-service
spec:
  hosts: [my-service]
  http:
  - route:
    - destination:
        host: my-service
        subset: v1
      weight: 90
    - destination:
        host: my-service
        subset: v2
      weight: 10
```

**Option 3: AWS ALB weighted routing:**
```yaml
# Two Services → Two Target Groups
annotations:
  alb.ingress.kubernetes.io/actions.forward-multiple-tg: |
    {"type":"forward","forwardConfig":{"targetGroups":[
      {"serviceName":"my-service-stable","servicePort":"80","weight":90},
      {"serviceName":"my-service-canary","servicePort":"80","weight":10}
    ]}}
```

**Automated canary analysis (Argo Rollouts AnalysisTemplate):**
```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-check
spec:
  metrics:
  - name: error-rate
    interval: 1m
    successCondition: result[0] < 0.05   # < 5% error rate
    failureLimit: 3
    provider:
      prometheus:
        address: http://prometheus:9090
        query: |
          rate(http_requests_total{status=~"5.."}[5m])
          /
          rate(http_requests_total[5m])
```

### 8.4 Feature Flags

Decouple **deploy** (code is in production) from **release** (users see the feature):

```java
// LaunchDarkly example
LDUser user = new LDUser.Builder(userId)
    .email(userEmail)
    .custom("tier", "premium")
    .build();

boolean showNewUI = ldClient.boolVariation("new-ui-feature", user, false);
if (showNewUI) {
    return newUIController.handle(request);
} else {
    return legacyUIController.handle(request);
}
```

**Benefits:**
- Dark launches: code deployed but feature off — test infrastructure at scale
- A/B testing: 50% users get v1, 50% get v2 — measure business metrics
- Kill switch: turn off broken feature without deployment
- Gradual rollout: 1% → 10% → 50% → 100% by user segment

**Self-hosted alternatives:** Flagsmith (open source), Unleash, Flipt, OpenFeature (standard API)

---

## 9. Service Mesh

### 9.1 What Problems Service Mesh Solves

Without service mesh:
- Every service must implement: retries, timeouts, circuit breaker, mTLS, distributed tracing headers
- Config in code: hard to change, hard to audit
- No visibility into inter-service traffic

With service mesh (e.g., Istio):
- All of the above handled by sidecar proxy (Envoy) — without code changes
- Central control plane for policy
- Automatic mTLS between services
- Traffic metrics, distributed traces — automatic

### 9.2 Istio Architecture

```
Control Plane (istiod):
├── Pilot: converts Istio config (VirtualService, DestinationRule) → Envoy xDS config
├── Citadel: certificate authority; issues mTLS certificates to workloads
└── Galley: validates Istio config

Data Plane (per pod):
├── Envoy sidecar: intercepts all inbound/outbound traffic via iptables rules
└── iptables rules: redirect port 15001 (outbound) + 15006 (inbound) → Envoy
```

**Sidecar injection:**
```yaml
# Namespace-level auto-injection:
kubectl label namespace production istio-injection=enabled

# Per-pod opt-out:
metadata:
  annotations:
    sidecar.istio.io/inject: "false"
```

Injection webhook: `MutatingAdmissionWebhook` named `istio-sidecar-injector` adds Envoy container + init container to every pod in labeled namespace.

### 9.3 mTLS (Mutual TLS)

```
Service A                                    Service B
Envoy sidecar ←──── mTLS ────────────────→ Envoy sidecar
   │                                              │
   │ app sees plain HTTP                          │ app sees plain HTTP
```

- Envoy-to-Envoy: TLS with client + server certificates
- Certs issued by Istiod CA, rotated every 24h
- App containers unaware — they speak plain HTTP to local Envoy
- `PeerAuthentication` policy enforces mTLS:
```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT   # reject non-mTLS connections
```

### 9.4 Traffic Management

```yaml
# VirtualService: routing rules
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: my-service
spec:
  hosts: [my-service]
  http:
  - match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: my-service
        subset: v2
  - route:
    - destination:
        host: my-service
        subset: v1

# DestinationRule: traffic policy + subsets
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: my-service
spec:
  host: my-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    outlierDetection:           # circuit breaker
      consecutiveGatewayErrors: 5
      interval: 30s
      baseEjectionTime: 30s
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

### 9.5 Linkerd vs Istio

| | Istio | Linkerd |
|-|-------|---------|
| Proxy | Envoy (C++, large) | Linkerd2-proxy (Rust, tiny) |
| Complexity | High | Low |
| Latency overhead | ~1ms | ~0.5ms |
| Resource usage | High (Envoy is heavy) | Low |
| Features | More (WASM plugins, L7 policy) | Core features, simpler |
| mTLS | Yes | Yes (default on) |
| Traffic management | Rich | Basic |
| Use case | Full control, complex routing | Simple, low overhead |

---

## 10. Secrets Management

### 10.1 The Problem with Kubernetes Secrets

```
# Default K8s Secret — base64 in etcd, NOT encrypted:
kubectl get secret my-secret -o yaml
apiVersion: v1
data:
  password: cGFzc3dvcmQxMjM=   ← echo "cGFzc3dvcmQxMjM=" | base64 -d = "password123"
kind: Secret

# Problems:
# 1. Stored in Git → committed by mistake → permanent exposure
# 2. etcd not encrypted by default → etcd backup = all secrets exposed
# 3. Passed as env vars → visible in pod description, process table
```

### 10.2 External Secrets Operator (ESO)

Fetches secrets from external stores and creates K8s Secret objects.

```yaml
# ExternalSecret — fetches from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: my-service-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-secretsmanager
  target:
    name: my-service-secret      # creates this K8s Secret
    creationPolicy: Owner
  data:
  - secretKey: database-password  # K8s Secret key
    remoteRef:
      key: /production/my-service/db  # AWS Secrets Manager path
      property: password              # JSON field in the secret

# ClusterSecretStore — connection config
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

**Flow:** ESO controller watches ExternalSecret → calls AWS API with IRSA credentials → creates/updates K8s Secret → Pod mounts Secret as volume or env var.

### 10.3 HashiCorp Vault Integration

**Method 1: Vault Agent Sidecar (init container + sidecar):**
```yaml
# Annotation-based auto-injection (Vault Agent Injector)
metadata:
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/role: "my-service"
    vault.hashicorp.com/agent-inject-secret-database: "secret/data/my-service/db"
    vault.hashicorp.com/agent-inject-template-database: |
      {{- with secret "secret/data/my-service/db" -}}
      SPRING_DATASOURCE_PASSWORD={{ .Data.data.password }}
      {{- end }}
```

**Method 2: Vault CSI Provider:**
- Vault Secrets CSI driver mounts secrets as files directly into pods
- No sidecar needed; uses CSI SecretProviderClass

**Method 3: External Secrets Operator (with Vault provider):**
- Same ESO pattern, but `provider.vault` instead of `provider.aws`

### 10.4 Best Practices

1. Never store secrets in Git (use SOPS/sealed-secrets for GitOps if necessary)
2. Use IRSA (IAM Roles for Service Accounts) — no static credentials in pods
3. Rotate secrets regularly — short-lived credentials preferred
4. Audit access — all secret accesses logged in Vault/AWS CloudTrail
5. Prefer secret as files over env vars — env vars appear in crash dumps, `/proc/<pid>/environ`
6. Encrypt etcd at rest — `EncryptionConfiguration` with KMS provider
7. `readOnly: true` on volume mounts for secret files

---

## Quick Reference: Key Interview Points

| Topic | Key Insight |
|-------|-------------|
| GitOps pull model | Cluster credentials NOT in CI; Git is source of truth |
| ArgoCD reconciliation | Polls every 3min OR webhook; desired=Git rendered YAML |
| ArgoCD selfHeal | Reverts manual kubectl changes — GitOps principle |
| Helm vs Kustomize | Helm: packages+templating; Kustomize: overlays+patches |
| PreSync hooks | DB migrations run before deployment, Argo waits for completion |
| OIDC in GitHub Actions | No long-lived credentials; JWT verified by AWS STS |
| DinD security | Requires --privileged; Kaniko is the secure alternative |
| Blue/Green DB migration | Expand-Migrate-Contract pattern for zero-downtime schema changes |
| Canary analysis | Argo Rollouts + PromQL query auto-promotes or rolls back |
| Feature flags | Decouple deploy from release; kill switch without redeployment |
| Service mesh mTLS | Envoy-to-Envoy TLS; app talks plain HTTP to local proxy |
| External Secrets | Never store secrets in Git; ESO fetches from Vault/AWS SM |

---

Sources:
- [ArgoCD Reconciliation Documentation](https://argo-cd.readthedocs.io/en/stable/operator-manual/reconcile/)
- [ArgoCD Automated Sync Policy](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)
- [ArgoCD Sync Phases and Waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
- [Understanding ArgoCD Reconciliation](https://rafay.co/ai-and-cloud-native-blog/understanding-argocd-reconciliation-how-it-works-why-it-matters-and-best-practices)
