import type { Problem } from "@/lib/types";

export const distributedTraining70b: Problem = {
  slug: "distributed-training-70b",
  num: "7.9",
  title: "Design Distributed Training for a 70B Model",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design the distributed training system for a dense 70-billion-parameter transformer trained from scratch on roughly 2 trillion tokens across a ~2,048-GPU cluster, sustaining more than 40% model FLOPs utilization (MFU) and finishing on the order of a month, while surviving hardware failures that arrive routinely at that scale without losing more than minutes of progress.",
  ],
  hardParts:
    "The hard parts: fitting over 1TB of model and optimizer state across GPUs with only 80GB of memory each without communication overhead eating the FLOPs, mapping the parallelism strategy onto a network topology with an ~18x bandwidth gap between intra-node and inter-node links, and surviving hardware failures that arrive roughly daily at 2,000+ GPU scale without losing more than minutes of a multi-week run.",
  keyTopics: [
    "3D Parallelism (Tensor + Pipeline + Data)",
    "ZeRO / FSDP Optimizer Sharding",
    "Mixed-Precision (bf16) Training",
    "Elastic, Fault-Tolerant Checkpointing",
    "Ring All-Reduce over NVLink / InfiniBand",
  ],
  foundationsReferenced: [
    { label: "Ring All-Reduce", tone: "purple" },
    { label: "Sharding", tone: "green" },
    { label: "NVLink / NVSwitch", tone: "blue" },
    { label: "Write-Ahead Logging", tone: "orange" },
    { label: "Leader Election", tone: "green" },
    { label: "Consensus (Raft/Paxos)", tone: "orange" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "data-loader", label: "Sharded Data Loader", sub: "tokenized shards, per-DP-rank", col: 1, row: 1, tone: "slate" },
      { id: "scheduler", label: "Job Scheduler", sub: "Slurm / Kubernetes", col: 1, row: 2, tone: "slate" },
      {
        id: "node-a",
        label: "Node Group A",
        sub: "TP=8 · 8×H100 · NVLink 900GB/s",
        mono: "pipeline stage 0",
        col: 2,
        row: 1,
        tone: "green",
      },
      {
        id: "node-b",
        label: "Node Group B",
        sub: "TP=8 · 8×H100 · NVLink 900GB/s",
        mono: "pipeline stage 3",
        col: 3,
        row: 1,
        tone: "green",
      },
      {
        id: "node-c",
        label: "Node Group C",
        sub: "TP=8 · 8×H100 · NVLink 900GB/s",
        mono: "pipeline stage 7",
        col: 4,
        row: 1,
        tone: "green",
      },
      { id: "dp-allreduce", label: "DP Ring All-Reduce", sub: "InfiniBand NDR · 32-way", col: 3, row: 2, tone: "purple" },
      { id: "zero1", label: "ZeRO-1 Optimizer Shards", sub: "1/32 optimizer state per rank", col: 4, row: 2, tone: "purple" },
      { id: "ckpt-store", label: "Sharded Checkpoint Store", sub: "parallel FS / object store", col: 2, row: 3, tone: "orange" },
      { id: "elastic", label: "Elastic Launcher", sub: "rendezvous + watchdog", col: 3, row: 3, tone: "orange" },
      { id: "metrics", label: "Loss & MFU Dashboard", sub: "W&B / Prometheus", col: 5, row: 3, tone: "orange" },
    ],
    edges: [
      { from: "data-loader", to: "node-a", label: "micro-batch", kind: "read" },
      { from: "node-a", to: "node-b", label: "activations →", kind: "read" },
      { from: "node-b", to: "node-c", label: "activations →", kind: "read" },
      { from: "node-c", to: "node-b", label: "← grads (backward)", kind: "read" },
      { from: "node-b", to: "node-a", label: "← grads (backward)", kind: "read" },
      { from: "node-a", to: "dp-allreduce", label: "grads, ring all-reduce", kind: "write" },
      { from: "node-b", to: "dp-allreduce", label: "grads, ring all-reduce", kind: "write" },
      { from: "node-c", to: "dp-allreduce", label: "grads, ring all-reduce", kind: "write" },
      { from: "dp-allreduce", to: "zero1", label: "reduce-scatter", kind: "write" },
      { from: "zero1", to: "node-a", label: "all-gather updated shard", kind: "write" },
      { from: "scheduler", to: "elastic", label: "spawn 2,048 ranks", kind: "analytics" },
      { from: "elastic", to: "node-a", label: "rank assignment / rendezvous", kind: "analytics" },
      { from: "node-a", to: "ckpt-store", label: "async sharded ckpt · 30min", kind: "analytics" },
      { from: "node-c", to: "ckpt-store", label: "async sharded ckpt · 30min", kind: "analytics" },
      { from: "elastic", to: "ckpt-store", label: "resume from latest on failure", kind: "analytics" },
      { from: "node-b", to: "metrics", label: "loss, grad-norm, MFU", kind: "analytics" },
    ],
    legend: [
      { kind: "read", text: "compute/pipeline flow · forward + backward activations" },
      { kind: "write", text: "gradient sync · ring all-reduce + ZeRO reduce-scatter/all-gather" },
      { kind: "analytics", text: "control plane · scheduling, checkpointing, monitoring — async, off the hot path" },
    ],
  },

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Train a dense 70B-parameter transformer from scratch on ~2T tokens to convergence", tag: "P0" },
      { id: "FR-02", text: "Shard model weights, gradients, and optimizer state across the cluster so no single GPU must hold the full ~1.1TB of model+optimizer state", tag: "P0" },
      { id: "FR-03", text: "Combine tensor, pipeline, and data parallelism (3D parallelism) and map each dimension onto the network tier that can afford its communication volume", tag: "P0" },
      { id: "FR-04", text: "Checkpoint training state periodically to durable storage and resume automatically after a hardware or process failure with bounded lost work", tag: "P0" },
      { id: "FR-05", text: "Run in mixed precision (bf16 compute, fp32 master weights) for numerical stability without doubling memory", tag: "P0" },
      { id: "FR-06", text: "Detect a failed or hung GPU/node and recover the job without restarting all 2,048 GPUs from scratch", tag: "P0" },
      { id: "FR-07", text: "Emit loss, gradient norm, throughput, and per-rank health metrics continuously for live monitoring", tag: "P1" },
      { id: "FR-08", text: "Support activation checkpointing (recomputation) to trade compute for the memory needed by longer sequences", tag: "P1" },
      { id: "FR-09", text: "Support elastic resize of the GPU count between checkpoints as capacity becomes available or is reclaimed", tag: "P1" },
      { id: "FR-10", text: "Reproduce a training run closely enough (fixed seed, deterministic data order) to debug a loss spike", tag: "P1" },
      { id: "FR-11", text: "Resume a checkpoint under a different parallelism configuration (different TP/PP/DP split) than it was saved under", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Model FLOPs utilization (MFU) sustained across the run", tag: "> 40%" },
      { id: "NFR-02", text: "Wall-clock time to train ~2T tokens on a 2,048-GPU cluster", tag: "~3-4 weeks" },
      { id: "NFR-03", text: "Checkpoint write overhead added to a training step", tag: "< 5%" },
      { id: "NFR-04", text: "Time from a hardware failure to training resuming", tag: "< 5 min" },
      { id: "NFR-05", text: "Training progress lost on any single failure", tag: "< 1 ckpt interval" },
      { id: "NFR-06", text: "Cross-node (InfiniBand) bandwidth utilization during DP gradient sync", tag: "> 80% line rate" },
      { id: "NFR-07", text: "Unrecovered loss divergences (NaN/inf not auto-rolled-back) over the full run", tag: "zero" },
      { id: "NFR-08", text: "Cluster scale the design must hold at", tag: "2K-4K GPUs" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "Sizing: why 70B parameters don't fit on one GPU",
      body: [
        "Before choosing a partition scheme, prove that partitioning is even necessary. Mixed-precision Adam training keeps five tensors per parameter: a bf16 weight, a bf16 gradient, an fp32 master weight, and fp32 Adam momentum and variance. That is 4 bytes plus 12 bytes, 16 bytes per parameter. Multiply by 70 billion parameters and you get roughly 1.12TB of model and optimizer state, before a single activation is stored.",
        "An H100 has 80GB of HBM. Unsharded, this model needs about 14 of them just to hold state, with zero room left for activations. That single number, ~1.12TB versus 80GB, is the entire reason this problem is 'find a partition scheme', not 'buy more GPUs'.",
      ],
      bullets: [
        { lead: "bf16 weight + bf16 grad", text: "4 bytes/param for the two low-precision copies actually used in the forward and backward matmuls." },
        { lead: "fp32 master weight", text: "Adam updates are tiny relative to a bf16 weight's precision; without an fp32 accumulator, small updates round away to zero and training stalls." },
        { lead: "fp32 momentum + variance", text: "Adam's two running-average tensors, 8 bytes/param combined, dwarf the weights themselves." },
        { lead: "16 bytes/param total", text: "70B params × 16B ≈ 1.12TB of model+optimizer state, roughly 14× the memory of a single 80GB H100." },
      ],
      pictureTitle: "Where does 1.1TB come from?",
      pictureRows: [
        { label: "bf16 weight + grad", value: "4 bytes/param → 280GB", tone: "neutral" },
        { label: "fp32 master weight", value: "4 bytes/param → 280GB", tone: "neutral" },
        { label: "fp32 Adam momentum + variance", value: "8 bytes/param → 560GB", tone: "bad" },
        { label: "Total", value: "16 bytes/param → ~1.12TB, ~14 H100s worth", tone: "bad" },
      ],
      remember: {
        problem: "Does a 70B model fit on one 80GB GPU?",
        solution: "No — mixed-precision Adam needs ~16 bytes/param, ≈1.12TB, ~14× an H100's HBM.",
        why: "bf16 weight+grad (4B) plus fp32 master weight+momentum+variance (12B) all have to live somewhere for the optimizer step to be numerically stable.",
        tradeoff: "A lighter optimizer (e.g. no momentum) saves memory but trades away training stability and convergence speed.",
        failure: "Sizing for weights alone (140GB) and forgetting the optimizer state undercounts the actual footprint by 8×.",
        mitigation: "Partition it — that is the entire justification for 3D parallelism plus ZeRO, covered next.",
      },
    },
    {
      n: 2,
      title: "3D parallelism: kill three, defend one",
      body: [
        "The partition problem has three dimensions to split across — layers, the hidden dimension within a layer, and independent replicas of the whole model — and each one trades memory savings for a different kind of communication. Put the pure strategies on the board, show why each one alone breaks at 2,048 GPUs, then combine them.",
      ],
      bullets: [
        { lead: "Pure data parallelism", text: "replicate the full ~1.1TB model+optimizer on every GPU. Doesn't even fit on one 80GB GPU, so this is dead on arrival at this model size without further sharding." },
        { lead: "Pure tensor parallelism (whole cluster)", text: "split every matmul's hidden dimension across all 2,048 GPUs. Every layer now needs an all-reduce across the full cluster, most of it crossing InfiniBand instead of NVLink — communication dominates and step time collapses." },
        { lead: "Pure pipeline parallelism (whole cluster)", text: "split layers into 2,048 stages. Fixes memory but the pipeline bubble (idle GPU time while the schedule fills and drains) grows with stage count, and inter-stage traffic still crosses far more network hops than needed." },
        { lead: "3D combination", text: "tensor-parallel only within a node (8-way, stays on NVLink), pipeline-parallel across small node groups (8-way, bounded cross-node hops), data-parallel across the remaining replicas (32-way, lowest-frequency sync, tolerates InfiniBand). Winner." },
      ],
      pictureTitle: "3D parallelism: kill three, keep the combination",
      pictureRows: [
        { label: "Pure data parallel", value: "1.1TB/GPU — doesn't fit, reject", tone: "bad" },
        { label: "Pure tensor parallel (2,048-way)", value: "all-reduce every layer over InfiniBand — reject", tone: "bad" },
        { label: "Pure pipeline parallel (2,048-way)", value: "bubble dominates step time — reject", tone: "bad" },
        { label: "TP=8 × PP=8 × DP=32", value: "each dimension matched to its network tier — WINNER", tone: "good" },
      ],
      remember: {
        problem: "Partition a 1.1TB model across 2,048 GPUs without communication eating the FLOPs.",
        solution: "3D parallelism: TP=8 inside a node, PP=8 across node groups, DP=32 across replicas.",
        why: "Each parallel dimension has a different communication volume and frequency; matching it to the fastest link that can carry it keeps GPUs computing instead of waiting.",
        tradeoff: "More moving parts than 'just add data-parallel replicas' — three interacting schedules to reason about and debug.",
        failure: "Any pure strategy either doesn't fit in memory or spends most of the step waiting on network.",
        mitigation: "Confine the highest-volume, highest-frequency communication (TP) to the fastest, closest link (NVLink); let the lowest-frequency one (DP, once per step) use the slower one.",
      },
    },
    {
      n: 3,
      title: "ZeRO: shard only what you still need to",
      body: [
        "Once TP=8 and PP=8 have already cut the per-GPU parameter count to 70B/64 ≈ 1.09B, the remaining question is whether to shard just the optimizer state (ZeRO-1) or also the gradients and parameters themselves (ZeRO-2/3) across the 32 data-parallel replicas. The right answer depends on what 3D parallelism already did for you.",
      ],
      bullets: [
        { lead: "Per-GPU footprint before any DP sharding", text: "1.09B params × 4 bytes (bf16 weight+grad) ≈ 4.4GB, plus 1.09B × 12 bytes (fp32 master+momentum+variance) ≈ 13GB of optimizer state — the optimizer state is the part worth sharding." },
        { lead: "ZeRO-1 (shard optimizer state only)", text: "32-way shard cuts that 13GB to ~0.4GB per GPU. Cheapest option: only the reduce-scatter/all-gather at the optimizer step touches the network, not every layer's forward/backward." },
        { lead: "ZeRO-3 / FSDP (shard params and grads too)", text: "would shave the 4.4GB further, but adds an all-gather before every layer's forward and backward — extra InfiniBand traffic competing with the TP all-reduce that's already saturating NVLink. Not worth it once TP/PP already got you to single-digit GB." },
        { lead: "Net result", text: "~4.4GB (bf16, unsharded) + ~0.4GB (ZeRO-1 shard) ≈ 5GB of model state on an 80GB GPU — about 75GB free for activations, which is the real memory pressure at long sequence lengths." },
      ],
      pictureTitle: "How much ZeRO sharding do you actually need?",
      pictureRows: [
        { label: "Per-GPU optimizer state, unsharded", value: "~13GB", tone: "bad" },
        { label: "ZeRO-1: 32-way shard", value: "~0.4GB, one comm hop per step", tone: "good" },
        { label: "ZeRO-3 on top of TP+PP", value: "extra all-gather per layer — not worth it here", tone: "neutral" },
        { label: "Total model state / 80GB budget", value: "~5GB used, ~75GB free for activations", tone: "good" },
      ],
      remember: {
        problem: "Shrink the ~13GB/GPU optimizer state further without adding communication you don't need.",
        solution: "ZeRO-1: shard only the optimizer state across the 32 DP replicas; skip ZeRO-3 since TP/PP already shrank params and grads enough.",
        why: "3D parallelism already cut per-GPU params to ~1B; the optimizer state (12 bytes/param) is the only piece still large enough to matter, and it's touched only once per step.",
        tradeoff: "ZeRO-3 would save a few more GB of param/grad memory but adds a per-layer all-gather that competes with the TP all-reduce for the same NVLink/InfiniBand bandwidth.",
        failure: "Reflexively reaching for ZeRO-3 everywhere (the default for pure-DP setups) adds communication overhead a 3D-parallel job doesn't need.",
        mitigation: "Pick the ZeRO stage based on what your parallelism strategy already solved, not by habit.",
      },
    },
    {
      n: 4,
      title: "Communication topology: match each collective to its link",
      body: [
        "Every collective communication primitive has to run on a physical link, and the two links here differ by about 18x: NVLink 4/NVSwitch gives ~900GB/s between any two GPUs in the same 8-GPU node, while InfiniBand NDR between nodes delivers roughly 50GB/s per GPU. The entire 3D-parallelism placement decision is downstream of that one number.",
      ],
      bullets: [
        { lead: "Ring all-reduce cost", text: "for N participants exchanging D bytes, the bandwidth-optimal ring costs ≈ 2D/bandwidth regardless of N (each GPU sends/receives ~2D/N over N-1 steps) — so what matters isn't participant count, it's which link the ring runs over." },
        { lead: "TP all-reduce: every layer, every microbatch", text: "the highest-frequency, highest-volume collective in the whole job. Confined to the 8-GPU NVLink domain, it never touches the 18×-slower network." },
        { lead: "PP send/recv: activations between adjacent stages", text: "one hop, once per microbatch, crosses InfiniBand between small node groups — much lower volume than TP's per-layer traffic." },
        { lead: "DP all-reduce: gradients, once per step", text: "the lowest-frequency collective (once per full step, not per layer), so it's the one that can afford to run across all 32 replicas over InfiniBand." },
      ],
      pictureTitle: "Match each collective to its link",
      pictureRows: [
        { label: "NVLink (intra-node)", value: "~900GB/s — carries the TP all-reduce", tone: "good" },
        { label: "InfiniBand NDR (inter-node)", value: "~50GB/s/GPU — carries PP send/recv + DP all-reduce", tone: "neutral" },
        { label: "Gap", value: "~18× — the reason TP never leaves a node", tone: "bad" },
      ],
      remember: {
        problem: "Decide which collective runs on which network link.",
        solution: "TP all-reduce stays inside the 8-GPU NVLink domain; PP activation hops and the once-per-step DP all-reduce use InfiniBand.",
        why: "Ring all-reduce cost scales with data volume, not participant count, so the deciding factor is frequency × volume vs. link bandwidth.",
        tradeoff: "This caps TP width at whatever fits in one NVLink domain (8 GPUs here); going wider forces TP traffic onto the slow link.",
        failure: "Running the TP all-reduce over InfiniBand instead of NVLink turns an 18× bandwidth gap into an 18× slowdown on the highest-frequency collective in the job.",
        mitigation: "Always place the most frequent, highest-volume collective on the fastest link, and size the parallel dimension to match that link's domain (8-way TP for an 8-GPU NVLink node).",
      },
    },
    {
      n: 5,
      title: "Fault tolerance: failure is routine at 2,048 GPUs",
      body: [
        "At 2,048 GPUs, individual component failure rates that look negligible per-GPU stop being negligible in aggregate. Published logs from comparable runs report hardware-triggered restarts roughly every one to two days at this scale — not a tail event, a routine one — so the design has to treat interruption as the expected case, not an outage.",
      ],
      bullets: [
        { lead: "MTBF math", text: "if a single GPU/NIC/node has a mean time between failures of, say, several years, 2,048 of them collectively fail far more often — the math that made a personal workstation reliable stops applying at fleet scale." },
        { lead: "Checkpoint interval sizes the blast radius", text: "checkpointing every ~30 minutes bounds the worst case to 30 minutes of recompute, negligible against a 3-4 week run, even if failures hit daily." },
        { lead: "Sharded, asynchronous writes", text: "each rank writes only its own shard, and offloads to host memory then flushes to the object store/parallel FS in the background — so the write doesn't block the next training step for the ~1.1TB aggregate checkpoint to land." },
        { lead: "Elastic relaunch, not a cold restart", text: "the launcher detects the dead rank (NCCL timeout / heartbeat miss), evicts just that node, and re-does rendezvous with a replacement — the other 2,040 GPUs don't restart from zero." },
      ],
      pictureTitle: "Failure is routine, not exceptional, at 2,048 GPUs",
      pictureRows: [
        { label: "Expected interruption cadence", value: "~daily, from published large-run logs", tone: "bad" },
        { label: "Checkpoint interval", value: "~30 min → bounds lost work to 30 min", tone: "good" },
        { label: "Checkpoint write", value: "sharded per-rank, async, off the hot path", tone: "good" },
        { label: "Recovery", value: "elastic relaunch of the dead node only, not the whole job", tone: "good" },
      ],
      remember: {
        problem: "Survive routine hardware failures over a multi-week run without losing days of progress.",
        solution: "Checkpoint every ~30 min, write sharded and async, and elastically relaunch just the failed node via rendezvous.",
        why: "At 2,048-GPU scale, a failure every day or two is the expected case, so the recovery cost — not the failure itself — is what you control.",
        tradeoff: "More frequent checkpoints cost a bit of step-time overhead; the design targets < 5% to keep that cost negligible.",
        failure: "A single blocking rank-0 checkpoint of the full 1.1TB state stalls every GPU in the job for the write, and a full job restart on any node loss throws away hours of progress.",
        mitigation: "Shard the checkpoint write across ranks, make it async, and make the launcher elastic so only the failed node's work is redone.",
      },
    },
    {
      n: 6,
      title: "Mixed precision and numerical stability",
      body: [
        "bf16 (Brain Float16) and fp16 use the same 16 bits but split them differently: bf16 keeps fp32's 8 exponent bits (same dynamic range) and gives up mantissa precision, while fp16 keeps more mantissa bits but only 5 exponent bits. At transformer scale, activations and gradients routinely swing across a huge dynamic range, so fp16 overflows without careful loss scaling; bf16 doesn't, which is why it's the default for large-model training.",
      ],
      bullets: [
        { lead: "bf16 over fp16", text: "same exponent range as fp32 means no loss-scaling dance to avoid overflow — one less moving part in a run that already has enough of them." },
        { lead: "fp32 master weights", text: "an Adam update can be many orders of magnitude smaller than the weight it's updating; accumulating directly in bf16 rounds tiny updates away to zero and training silently stalls." },
        { lead: "Gradient clipping + LR warmup", text: "guard against the loss spikes that large-batch, large-model training is prone to early and at LR changes — clip the global gradient norm, warm up the learning rate over the first few hundred steps." },
        { lead: "Divergence watchdog", text: "monitor loss and gradient norm for NaN/inf or a sustained spike; auto-rollback to the last good checkpoint and resume with a lower learning rate rather than letting a bad step propagate for hours before a human notices." },
      ],
      pictureTitle: "bf16 vs fp16 for a 70B run",
      pictureRows: [
        { label: "fp16 (5 exp / 10 mantissa bits)", value: "needs loss scaling to avoid overflow", tone: "bad" },
        { label: "bf16 (8 exp / 7 mantissa bits)", value: "fp32's dynamic range, no loss scaling needed", tone: "good" },
        { label: "fp32 master weights", value: "prevents tiny Adam updates rounding to zero", tone: "good" },
        { label: "Watchdog on loss/grad-norm", value: "auto-rollback beats hours of silently bad training", tone: "neutral" },
      ],
      remember: {
        problem: "Train in low precision without silent numerical failure over hundreds of thousands of steps.",
        solution: "bf16 compute (no loss scaling needed), fp32 master weights, gradient clipping, and an automated divergence watchdog.",
        why: "bf16's fp32-matching exponent range avoids overflow; fp32 master weights avoid update underflow; clipping and a watchdog catch the spikes that do happen.",
        tradeoff: "fp32 master weights cost extra memory (already counted in the 16 bytes/param), and the watchdog adds a small amount of monitoring overhead.",
        failure: "fp16 without careful loss scaling overflows; bf16-only optimizer state loses small updates and training plateaus without an obvious cause.",
        mitigation: "bf16 + fp32 master weights + clipping + an automated rollback-on-divergence watchdog, not a human staring at a loss curve at 3am.",
      },
    },
    {
      n: 7,
      title: "Pipeline bubbles and activation checkpointing",
      body: [
        "Splitting the model into 8 pipeline stages introduces a structural inefficiency: the first stage has already moved on to the next microbatch while the last stage is still waiting for its first one to arrive, so some fraction of every GPU's time is idle — the 'pipeline bubble'. The knob you control is the number of microbatches per step; more microbatches shrink the bubble but raise activation memory, which activation checkpointing then buys back.",
      ],
      bullets: [
        { lead: "Naive (GPipe) bubble fraction", text: "≈ (P-1)/M, where P = pipeline stages (8) and M = microbatches per step. With only a few microbatches, a meaningful fraction of every step is idle GPU time." },
        { lead: "1F1B schedule", text: "interleaves one-forward-one-backward per stage instead of draining fully before starting backward, which caps peak activation memory without eliminating the bubble — it's a memory fix, not a throughput fix." },
        { lead: "More microbatches shrinks the bubble", text: "but each in-flight microbatch holds its activations until its backward pass runs, so more microbatches directly means more activation memory held at once." },
        { lead: "Activation checkpointing buys the memory back", text: "discard activations after the forward pass and recompute them during backward — roughly 33% more compute for a large cut in activation memory, which is what makes a high microbatch count (small bubble) affordable." },
      ],
      pictureTitle: "The pipeline-bubble / activation-memory trade",
      pictureRows: [
        { label: "Few microbatches", value: "small activation memory, bigger idle bubble", tone: "neutral" },
        { label: "Many microbatches", value: "smaller bubble, more activations held at once", tone: "neutral" },
        { label: "Activation checkpointing", value: "~33% more compute buys back the memory", tone: "good" },
        { label: "1F1B schedule", value: "caps peak memory without changing the bubble math", tone: "neutral" },
      ],
      remember: {
        problem: "Pipeline parallelism leaves GPUs idle while the schedule fills and drains.",
        solution: "Increase microbatches per step to shrink the bubble, use activation checkpointing to afford the resulting memory pressure, and 1F1B to cap peak memory.",
        why: "Bubble fraction ≈ (P-1)/M falls as M grows, but more in-flight microbatches means more held activations — checkpointing trades compute for the memory to allow that.",
        tradeoff: "Activation checkpointing costs ~33% more FLOPs per step in exchange for fitting a smaller bubble (and/or longer sequences).",
        failure: "Too few microbatches wastes a large fraction of every step to bubble idle time; ignoring activation memory while chasing a small bubble runs out of HBM.",
        mitigation: "Tune microbatch count against the bubble/memory trade explicitly, and lean on activation checkpointing rather than treating it as optional.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "It's a memory-partitioning problem before it's a compute problem: 70B params need ~1.1TB of mixed-precision model+optimizer state, about 14x an H100's HBM, so the whole job is about slicing that state across GPUs without drowning in communication.",
      "3D parallelism matches each slice to a network tier: tensor-parallel stays inside an 8-GPU NVLink node, pipeline-parallel crosses a few nodes, data-parallel (with ZeRO-1) syncs once per step over InfiniBand.",
      "bf16 compute with fp32 master weights, gradient clipping, and a divergence watchdog are what keep a run numerically sane for hundreds of thousands of steps.",
      "At 2,048 GPUs, hardware failure is a daily routine, not an outage — sharded async checkpoints every ~30 minutes plus an elastic launcher turn 'lose a day' into 'lose 30 minutes'.",
      "The real efficiency metric is MFU (model FLOPs utilization), not GPU count — pipeline bubbles and communication stalls are what eat it.",
    ],
    flows: [
      {
        kind: "read",
        title: "DATA LOADING · SHARDED INPUT PIPELINE",
        summary:
          "The corpus is pre-tokenized and pre-sharded so each data-parallel replica only ever reads its own 1/32 slice, deterministically, so a restart replays the same data order.",
        steps: [
          { label: "Tokenized corpus", note: "object store, pre-sharded" },
          { label: "Shuffle + shard by DP rank", note: "deterministic seed for reproducibility" },
          { label: "Per-rank shard", note: "1/32 of the corpus per DP replica" },
          { label: "Microbatch queue", note: "prefetched, overlapped with compute" },
          { label: "GPU HBM", note: "ready for the forward pass" },
        ],
      },
      {
        kind: "write",
        title: "TRAINING STEP · 3D-PARALLEL FORWARD → BACKWARD → OPTIMIZER",
        summary:
          "Every step runs a forward and backward pass through the 8-way tensor-parallel, 8-way pipeline-parallel model, then syncs gradients once across the 32 data-parallel replicas and applies the ZeRO-1 sharded optimizer step.",
        steps: [
          { label: "Forward pass", note: "TP all-reduce per layer, NVLink" },
          { label: "Pipeline hop", note: "activations to next stage, InfiniBand" },
          { label: "Backward pass", note: "TP all-reduce per layer, NVLink" },
          { label: "DP gradient sync", note: "ring all-reduce, InfiniBand, once/step" },
          { label: "ZeRO-1 optimizer step", note: "reduce-scatter, update local shard, all-gather" },
          { label: "Weights updated", note: "bf16 weights refreshed for next step" },
        ],
      },
      {
        kind: "analytics",
        title: "FAILURE RECOVERY · WATCHDOG → ELASTIC RESUME",
        summary:
          "A dead rank is detected by NCCL timeout or missed heartbeat, evicted, and replaced through rendezvous while the rest of the cluster reloads the latest sharded checkpoint — never a full job restart.",
        steps: [
          { label: "NCCL timeout / heartbeat miss", note: "watchdog detects the dead rank" },
          { label: "Evict failed node", note: "scheduler removes it from the job" },
          { label: "Re-run rendezvous", note: "elastic launcher reassigns ranks" },
          { label: "Load latest sharded checkpoint", note: "from parallel FS / object store" },
          { label: "Resume training", note: "< 5 min target, < 30 min of work lost" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "70B params × 16 bytes/param (bf16 wt+grad + fp32 master+momentum+variance) ≈ 1.12TB model+optimizer state",
          "Cluster: 2,048 H100 80GB GPUs, 256 nodes × 8, TP=8 × PP=8 × DP=32",
          "Per-GPU footprint: ~1.09B params (70B/64), ~4.4GB bf16 wt+grad, ~0.4GB ZeRO-1 shard ≈ ~5GB of 80GB used",
          "NVLink ≈ 900GB/s intra-node vs InfiniBand NDR ≈ 50GB/s/GPU inter-node — ~18× gap",
          "~2T training tokens, ~4M tokens/step global batch → ~500K steps",
          "Compute ≈ 6ND ≈ 8.4×10²³ FLOPs; at ~40% MFU, compute-bound floor ≈ 12 days, real wall clock ≈ 3-4 weeks with restarts",
          "Checkpoint every ~30 min, sharded per-rank, async flush",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "TP=8 confined to a single NVLink node; never crosses the slower inter-node network",
          "PP=8 splits layers across small node groups, bounding cross-node activation traffic",
          "DP=32 + ZeRO-1 (not ZeRO-3) — 3D parallelism already shrank params/grads enough; only optimizer state needs sharding",
          "bf16 compute + fp32 master weights, not fp16 + loss scaling",
          "Sharded, asynchronous checkpoint writes, not a blocking rank-0 dump",
          "Elastic launcher (torchrun/Slurm) re-does rendezvous on node loss instead of restarting the whole job",
          "Activation checkpointing (~33% extra compute) to afford more microbatches and a smaller pipeline bubble",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "Match each collective to its network tier: highest-frequency (TP) on the fastest link, lowest-frequency (DP, once/step) on the slowest",
          "Hardware failure at 2,048-GPU scale is routine (roughly daily), not exceptional — design for it, don't bolt it on",
          "MFU, not GPU count, is the real efficiency metric — say what eats it: pipeline bubbles, comm stalls, checkpoint overhead",
          "Checkpoint interval is the lever that turns 'lose a day' into 'lose 30 minutes'",
          "3D-parallel + ZeRO-1 beats blanket ZeRO-3 here — say why, not just 'use ZeRO'",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  rehearse: [
    {
      n: 1,
      title: "Clarify Requirements and Scale",
      minutes: 5,
      goal: "Get model size, token budget, cluster size/hardware, an MFU target, and explicit scope on the board before drawing anything.",
      why: "Every downstream decision — parallelism split, checkpoint cadence, memory budget — falls out of these numbers. Locking them first shows you drive the design from data, not from a memorized architecture.",
      steps: [
        { kind: "ASK", text: '**What model size and token budget?** Land on "70B dense params, ~2T tokens". Write **"70B / 2T tokens"** in the top-left corner.' },
        { kind: "ASK", text: '**What hardware and how many GPUs?** Land on "H100 80GB, ~2,048 GPUs, 256 nodes × 8". Write it under the model size.' },
        { kind: "SAY", text: 'Propose targets yourself: **"MFU > 40%"**, **"wall clock on the order of a month"**. Wait for a nod before writing them down.' },
        { kind: "SAY", text: 'State scope. In: "pretraining", "3D parallelism", "fault tolerance", "checkpointing". Out: "data curation/dedup", "RLHF/fine-tuning", "serving/inference". "Let me know if you\'d like me to come back to any of those."' },
        { kind: "WRITE", text: 'Do the memory math out loud: **"16 bytes/param × 70B ≈ 1.12TB model+optimizer state"**, **"~14× an H100\'s 80GB"**. Write the totals on the board.' },
      ],
      grading: "Senior judgment. Are you writing numbers on the board, parking out-of-scope items deliberately, and locking the memory/compute budget before drawing any boxes?",
    },
    {
      n: 2,
      title: "Memory Math and Parallelism Strategy",
      minutes: 5,
      goal: "Derive the TP/PP/DP split from the memory math and the hardware topology, not from habit.",
      why: "The interviewer wants to see the parallelism strategy fall out of two numbers — the 1.12TB model state and the 18× NVLink/InfiniBand gap — rather than being recited from memory.",
      steps: [
        { kind: "WRITE", text: '**"1.12TB total, must fit in 80GB/GPU → must partition, not just replicate."**' },
        { kind: "SAY", text: '"NVLink is ~900GB/s intra-node, InfiniBand is ~50GB/s per GPU inter-node — about an 18× gap. That gap decides where each parallel dimension goes."' },
        { kind: "DRAW", text: 'Sketch the split: **"TP=8 inside a node, PP=8 across node groups, DP=32 across replicas = 2,048 GPUs."**' },
        { kind: "RULE OUT", text: '"Pure DP doesn\'t fit — 1.1TB/GPU. Pure TP at 2,048-way puts every layer\'s all-reduce on the slow network. Pure PP at 2,048-way makes the bubble dominate." Cross all three off.' },
      ],
      grading: "The TP/PP/DP split traced directly back to the memory number and the bandwidth gap, plus a one-line rejection for each pure strategy.",
    },
    {
      n: 3,
      title: "High-Level Design (draw the three lanes)",
      minutes: 10,
      goal: "One diagram with three labeled lanes: compute/pipeline, gradient-sync, and control-plane (checkpoint/monitoring).",
      why: "Drawing these as separate lanes proves you understand they have different frequencies and different failure tolerances — the compute lane can never be blocked, the sync lane runs once per step, and the control plane is fully asynchronous.",
      steps: [
        { kind: "DRAW", text: 'Lay down the **compute lane**: Data loader → Node Group A (TP=8, stage 0) → B → C, forward then backward. Label arrows **"NVLink, per layer"** and **"InfiniBand, per microbatch"**.' },
        { kind: "DRAW", text: 'Add the **gradient-sync lane**: Node groups → DP ring all-reduce → ZeRO-1 shards → all-gather back, labeled **"InfiniBand, once/step"**.' },
        { kind: "DRAW", text: 'Add the **control-plane lane**: Scheduler → Elastic Launcher → rendezvous; Node groups → sharded checkpoint store (async, every ~30 min); metrics dashboard, dashed, labeled **"never blocks a training step"**.' },
        { kind: "SAY", text: '"Compute is tier-1 and can never wait. Gradient sync happens once per step. Checkpointing and monitoring are fully async, off the hot path."' },
      ],
      grading: "Three clearly separated lanes, arrows labeled with the link and frequency, and an explicit statement that the control plane never blocks a training step.",
    },
    {
      n: 4,
      title: "Deep Dive: ZeRO Sharding and Communication",
      minutes: 8,
      goal: "Show the per-GPU memory math and defend ZeRO-1 over ZeRO-3, plus the ring all-reduce placement.",
      why: "This is the signature sub-problem: can you reason about which ZeRO stage is actually needed given what TP/PP already solved, instead of reaching for ZeRO-3 by default?",
      steps: [
        { kind: "WRITE", text: 'Per-GPU numbers: **"70B/64 ≈ 1.09B params/GPU"**, **"4.4GB bf16 wt+grad"**, **"13GB unsharded optimizer state"**.' },
        { kind: "SAY", text: '"ZeRO-1 shards just the optimizer state 32-way → ~0.4GB/GPU. ZeRO-3 would shard params/grads too, but adds a per-layer all-gather that competes with the TP all-reduce we already put on NVLink — not worth it once 3D parallelism already shrank the params."' },
        { kind: "SAY", text: 'Explain ring all-reduce cost ≈ 2D/bandwidth, independent of participant count, and why that means matching frequency × volume to link speed rather than counting GPUs.' },
        { kind: "RULE OUT", text: '"ZeRO-3 everywhere" as the reflexive default for pure-DP setups; explain why 3D parallelism changes the calculus here.' },
      ],
      grading: "The bit/byte-level per-GPU math on the board, and a ZeRO-1-vs-ZeRO-3 decision defended by what TP/PP already accomplished, not recited from a framework's default.",
    },
    {
      n: 5,
      title: "Deep Dive: Fault Tolerance and Checkpointing",
      minutes: 7,
      goal: "MTBF reasoning, checkpoint cadence, and elastic recovery, volunteered rather than pulled out by a follow-up question.",
      why: "The interviewer is checking whether you treat failure at 2,048-GPU scale as routine and design the recovery cost down, rather than bolting on 'we checkpoint sometimes' when asked.",
      steps: [
        { kind: "SAY", text: '"At 2,048 GPUs, published large-run logs show hardware-triggered interruptions roughly every 1-2 days — that\'s the expected case, not a tail risk."' },
        { kind: "WRITE", text: '**"Checkpoint every ~30 min → worst case lose 30 min of a 3-4 week run."**' },
        { kind: "SAY", text: '"Checkpoints are sharded per-rank and written async — offloaded to host memory, then flushed to the object store in the background — so they don\'t stall the training step."' },
        { kind: "SAY", text: '"The launcher is elastic: a watchdog detects the dead rank via NCCL timeout, evicts it, re-does rendezvous with a replacement. The other 2,040 GPUs keep their state."' },
      ],
      grading: "Failure framed as routine and quantified, checkpoint interval justified against lost-work math, and recovery described as elastic rather than a full restart.",
    },
    {
      n: 6,
      title: "Wrap: Numerical Stability, Bottlenecks, and Close",
      minutes: 5,
      goal: "Name numerical stability as a first-class concern, restate the real efficiency metric, push back on a requirement, and close cleanly.",
      why: "Staff-level signal is treating stability and efficiency as designed-in properties, not afterthoughts, and closing the interview like a collaborator rather than running out the clock.",
      steps: [
        { kind: "SAY", text: '"bf16 over fp16 avoids loss scaling; fp32 master weights avoid update underflow; a divergence watchdog auto-rolls-back a NaN or spike instead of letting it run for hours."' },
        { kind: "SAY", text: '"MFU, not GPU count, is the real efficiency number — say what eats it: pipeline bubble, comm stalls, checkpoint overhead."' },
        { kind: "SAY", text: 'Push back where useful: "Do we actually need 2,048 GPUs on day one, or can we start smaller and scale the cluster elastically as capacity frees up?"' },
        { kind: "SAY", text: 'Close in one sentence and list the rest: "It\'s a memory-partitioning problem solved with 3D parallelism matched to network topology, ZeRO-1 for the remaining optimizer state, and fault tolerance treated as routine. With more time I\'d cover data curation/dedup and the RLHF fine-tuning stage after pretraining."' },
      ],
      grading: "Numerical stability treated as designed-in, MFU named as the real metric, at least one push-back on requirements, and a crisp closing summary with a parked-items list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Reaches a design that names the right ingredients, but the memory math, network topology, and failure handling stay hand-wavy.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Lists the right components: a GPU cluster, some kind of parallelism, a data loader, checkpoints.",
          "Knows the model doesn't fit on one GPU and reaches for 'more GPUs' and 'data parallelism'.",
          "Can name bf16/fp16 mixed precision as a memory saver when prompted.",
          "Mentions checkpointing for fault tolerance if asked 'what if it crashes'.",
          "Recognizes ZeRO/DeepSpeed or FSDP by name, at least as a buzzword.",
        ],
        gaps: [
          "Doesn't do the 16 bytes/param memory math; treats memory sizing as 'a lot'.",
          "Proposes pure data parallelism without noticing 1.1TB doesn't fit on one GPU.",
          "No mention of network topology (NVLink vs InfiniBand) driving the parallelism split.",
          "Treats hardware failure as an edge case rather than a routine, near-daily event at this scale.",
          "No MFU concept — measures progress in GPU count, not sustained FLOPs.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design from the memory and bandwidth numbers, picks a defensible 3D-parallel split, and can defend each piece when pushed.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Does the memory math (16 bytes/param, ~1.1TB) unprompted and uses it to justify partitioning.",
          "Proposes 3D parallelism (TP/PP/DP) and can explain what each dimension trades away.",
          "Knows the NVLink vs InfiniBand bandwidth gap and places TP inside a node because of it.",
          "Chooses ZeRO-1/2/3 deliberately based on what TP/PP already solved, not by default.",
          "Has a checkpoint-and-resume story with a concrete interval and async writes.",
          "Uses bf16 + fp32 master weights and can explain why, not just name-drop it.",
          "Names MFU as the efficiency metric when asked 'how do you know it's working well'.",
        ],
        gaps: [
          "Volunteers the fault-tolerance/MTBF reasoning only when asked 'what happens if a GPU dies', not proactively.",
          "Quantifies communication savings in general terms ('NVLink is faster') rather than the ~18× number and what it implies.",
          "Doesn't distinguish the ZeRO-1 vs ZeRO-3 tradeoff clearly, defaults to 'use ZeRO-3, it's the safest'.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Owns the room, quantifies every tradeoff, and shows how the techniques interact rather than listing them side by side.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers that hardware failure is routine at 2,048-GPU scale (roughly daily) and quantifies checkpoint interval as the lever that bounds lost work, unprompted.",
          "Explains why ZeRO-1, not ZeRO-3, is the right choice given 3D parallelism already shrank per-GPU state — showing the interaction between techniques, not just listing them.",
          "Quantifies the ring all-reduce cost model (≈2D/bandwidth, independent of participant count) to justify link placement, not just 'NVLink is faster'.",
          "Distinguishes the compute-bound floor (~12 days at 40% MFU) from realistic wall-clock time (~3-4 weeks with restarts), and explains the gap.",
          "Pushes back on requirements ('do we need 2,048 GPUs on day one, or elastic scale-up?').",
          "Treats numerical stability (bf16, fp32 master weights, divergence watchdog) as a first-class design concern, not an afterthought.",
          "Closes with a crisp one-sentence summary and names what's out of scope (data curation, RLHF) with intent to return if time allows.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing pure data parallelism for a 70B model without checking whether 1.1TB of model+optimizer state fits on one 80GB GPU (it doesn't, by about 14×).",
      "Running the tensor-parallel all-reduce across InfiniBand instead of confining it to the NVLink domain — the highest-frequency collective on the slowest link.",
      "No fault-tolerance story for a multi-week, 2,000+ GPU job — treating hardware failure as an edge case instead of a near-daily routine.",
      "A single blocking rank-0 checkpoint of the full model state, stalling every GPU in the job for the write.",
      "Using fp16 with no mention of loss scaling, or skipping the numerical-stability discussion (fp32 master weights, gradient clipping) entirely.",
      "Measuring progress in GPU count instead of MFU — no acknowledgment that pipeline bubbles and communication stalls eat realized FLOPs.",
      "No answer for 'what happens if a node dies at step 400,000' — a question interviewers ask specifically to probe this.",
    ],
    followUps: [
      {
        q: "Why bf16 instead of fp16?",
        a: "bf16 shares fp32's 8-bit exponent, so it has the same dynamic range and doesn't need loss scaling; fp16's extra mantissa precision isn't worth the overflow risk at this scale. The fp32 master weight already restores the precision bf16 gives up on individual parameter updates, so bf16 compute plus fp32 master weights gets both wide dynamic range and precise accumulation without doubling every tensor to fp32.",
      },
      {
        q: "Why not just add more data-parallel replicas and skip tensor/pipeline parallelism?",
        a: "Because the full ~1.1TB of model+optimizer state has to live somewhere before ZeRO shards anything, and it doesn't fit on one 80GB GPU. TP and PP exist to shrink the per-GPU footprint first; DP alone with ZeRO-3 is a legitimate strategy for smaller models where the params fit, but at 70B you need TP/PP to get per-GPU state down to a size ZeRO can finish sharding on without adding excessive communication.",
      },
      {
        q: "How do you decide checkpoint frequency?",
        a: "Balance two costs: checkpointing too often adds overhead to every step (targeting under ~5%), checkpointing too rarely raises the expected lost work on failure. With interruptions roughly every 1-2 days at this scale and a ~30 minute checkpoint interval, the expected lost work stays a small fraction of the run, and sharded async writes keep the per-checkpoint overhead low enough that checkpointing aggressively doesn't hurt throughput.",
      },
      {
        q: "What's a pipeline bubble and how do you shrink it?",
        a: "It's the idle time each GPU spends while the pipeline schedule fills (early stages start before later ones have work) and drains (later stages finish after earlier ones go idle). Bubble fraction is roughly (P-1)/M for P stages and M microbatches, so increasing microbatches per step shrinks it — at the cost of holding more activations in flight, which activation checkpointing buys back by recomputing them during backward instead of storing them.",
      },
      {
        q: "How does ZeRO-3 differ from ZeRO-1, and when would you actually want it?",
        a: "ZeRO-1 shards only the optimizer state; ZeRO-2 adds gradients; ZeRO-3/FSDP shards parameters too, requiring an all-gather before every layer's forward and backward. It's the right default when you're relying purely on data parallelism (no TP/PP) because nothing else is shrinking the per-GPU parameter count. Once 3D parallelism has already cut per-GPU params to ~1B, ZeRO-1 is usually enough and avoids stacking extra all-gathers on top of the TP all-reduce that's already saturating NVLink.",
      },
      {
        q: "How would you debug a loss spike mid-training?",
        a: "First check whether it's a NaN/inf (numerical) or just a high but finite loss (data or learning-rate issue). For numerical spikes, check the gradient norm right before the spike — an unclipped norm points at a bad batch or an LR that's too high after a schedule change. Roll back to the last checkpoint before the spike, optionally skip or re-shuffle the offending data range, and consider a temporary LR reduction; compare per-layer gradient norms to localize whether one layer (often the embedding or final layer) is the source before resuming at full LR.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  deepDive: {
    intro:
      "A full written walkthrough of this design, end to end — the same reasoning as the tabs above, laid out as prose you can read once and re-derive from memory.",
    sections: [
      {
        heading: "The one-line mental model",
        body: [
          "This is a memory-partitioning problem before it's a compute problem. A 70B-parameter model with mixed-precision Adam needs ~1.12TB of model and optimizer state, roughly 14× an H100's 80GB of HBM, so nothing about this design works until that state is sliced across GPUs in a way that doesn't drown in communication.",
          "Anchor everything on a handful of numbers: 70B params, ~1.12TB of state, 2,048 H100s (256 nodes × 8), ~2T training tokens, and an ~18× bandwidth gap between NVLink and InfiniBand. Every structural choice below is a consequence of these numbers, not a preference.",
        ],
      },
      {
        heading: "Sizing the problem: the memory wall",
        body: [
          "Mixed-precision Adam keeps five tensors per parameter: bf16 weight and gradient (4 bytes), plus fp32 master weight, momentum, and variance (12 bytes) — 16 bytes/param total. 70B × 16B ≈ 1.12TB, before a single activation is stored. Unsharded, that needs about 14 H100s just to hold state.",
          "This is why the design starts with a partition scheme, not a component list. Every subsequent decision — how many GPUs per tensor-parallel group, how many pipeline stages, how the optimizer state is sharded — is a direct answer to 'where does each of those 16 bytes/param live.'",
        ],
      },
      {
        heading: "3D parallelism and network topology",
        body: [
          "Three pure strategies all fail at this scale: pure data parallelism doesn't fit in one GPU's memory, pure tensor parallelism forces a cluster-wide all-reduce on every layer, and pure pipeline parallelism drowns in an idle 'bubble' at thousands of stages. The fix is to run all three at once, sized to the network: tensor-parallel (8-way) stays inside a single NVLink node (~900GB/s), pipeline-parallel (8-way) crosses small node groups over InfiniBand, and data-parallel (32-way) replicates the result, syncing gradients only once per step.",
          "The deciding number is the ~18× bandwidth gap between NVLink and InfiniBand NDR (~50GB/s per GPU). Ring all-reduce cost scales with data volume, not participant count, so the rule is simple: put the highest-frequency, highest-volume collective (the TP all-reduce, run every layer) on the fastest link, and let the lowest-frequency one (DP gradient sync, once per step) use the slower one.",
        ],
      },
      {
        heading: "ZeRO: shard only what you still need to",
        body: [
          "After TP=8 and PP=8, each GPU holds only ~1.09B params (70B/64) — about 4.4GB of bf16 weights and gradients, and ~13GB of unsharded fp32 optimizer state. ZeRO-1 shards just that optimizer state across the 32 data-parallel replicas, cutting it to ~0.4GB per GPU, and only touches the network once per step at the optimizer boundary.",
          "ZeRO-3/FSDP would shard the params and gradients too, but adds an all-gather before every layer's forward and backward — extra traffic competing with the TP all-reduce already saturating NVLink. That tradeoff is worth it when data parallelism is the only sharding mechanism you have; once 3D parallelism has already done the heavy lifting, ZeRO-1 is enough, and stacking ZeRO-3 on top just adds unnecessary communication.",
        ],
      },
      {
        heading: "Fault tolerance at 2,048-GPU scale",
        body: [
          "At this scale, hardware failure is the expected case: published logs from comparable large runs report hardware-triggered interruptions roughly every one to two days, not as a tail risk but as routine operation. The design responds by making the cost of recovery small rather than trying to prevent failure.",
          "Checkpointing every ~30 minutes bounds worst-case lost work to 30 minutes against a 3-4 week run. Each rank writes only its own shard and offloads to host memory before flushing to the object store in the background, so the write never blocks the next training step. An elastic launcher detects a dead rank via NCCL timeout, evicts just that node, and re-does rendezvous with a replacement — the other 2,040 GPUs keep their state and resume without a full job restart.",
        ],
      },
      {
        heading: "Numerical stability and the pipeline-bubble trade",
        body: [
          "bf16 shares fp32's exponent range, so it avoids the overflow that fp16 needs loss scaling to prevent; fp32 master weights preserve tiny Adam updates that would otherwise round away to zero in bf16. Gradient clipping and LR warmup guard against loss spikes, and an automated divergence watchdog rolls back to the last checkpoint on a NaN or sustained spike rather than letting a bad step run for hours unnoticed.",
          "Separately, splitting the model into pipeline stages creates an idle 'bubble' with fraction roughly (P-1)/M for P stages and M microbatches; more microbatches shrink the bubble but hold more activations in flight. Activation checkpointing trades ~33% more compute — recomputing activations during backward instead of storing them — for the memory headroom that makes a small bubble affordable. At ~40% MFU, the compute-bound floor for this run is about 12 days; real wall-clock time lands closer to 3-4 weeks once checkpoint overhead and failure-recovery bubbles are counted in.",
        ],
      },
    ],
  },
};
