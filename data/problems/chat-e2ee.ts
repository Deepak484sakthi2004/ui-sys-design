import type { Problem } from "@/lib/types";

export const chatE2ee: Problem = {
  slug: "chat-e2ee",
  num: "7.1",
  title: "Design a Chat System with E2EE",
  level: "Hard",
  deepDiveAvailable: true,
  intro: [
    "Design a chat system for 200M daily active users sending 20B end-to-end encrypted messages a day (~1M msgs/sec at peak), across 1:1 chats, groups up to 1,000 members, and multiple devices per account, where the server relays and stores only ciphertext it can never read.",
  ],
  hardParts:
    "The hard parts: establishing a session and exchanging keys with someone who might be offline (X3DH), keeping forward secrecy and self-healing after a key compromise (Double Ratchet) without the server ever brokering plaintext, and fanning a message out to every device in a 1,000-member group without paying an O(members × devices) encryption cost on every send.",
  keyTopics: [
    "X3DH Key Agreement",
    "Double Ratchet (Signal Protocol)",
    "Sender Keys for Groups",
    "Multi-Device Fanout",
    "Sealed Sender / Metadata Minimization",
  ],
  foundationsReferenced: [
    { label: "Diffie-Hellman Key Exchange", tone: "purple" },
    { label: "Symmetric vs Asymmetric Crypto", tone: "purple" },
    { label: "WebSockets", tone: "blue" },
    { label: "Consistent Hashing", tone: "green" },
    { label: "Cassandra / Wide-Column Stores", tone: "blue" },
    { label: "CDN & Object Storage", tone: "blue" },
  ],

  // -------------------------------------------------------------------------
  diagram: {
    caption: "THE WHOLE SYSTEM IN ONE PICTURE",
    nodes: [
      { id: "sender", label: "Sender Client", sub: "encrypts locally", col: 1, row: 1, tone: "slate" },
      { id: "gateway", label: "WS Gateway", sub: "persistent conn · sharded", col: 2, row: 1, tone: "green" },
      {
        id: "router",
        label: "Message Router",
        sub: "per-device fanout",
        mono: "recipient → device list",
        col: 3,
        row: 1,
        tone: "purple",
      },
      {
        id: "mailbox",
        label: "Mailbox Store",
        sub: "Cassandra/DynamoDB",
        mono: "ciphertext only · TTL 30d",
        col: 4,
        row: 1,
        tone: "blue",
      },
      { id: "recipientOnline", label: "Recipient Client (online)", sub: "decrypts locally", col: 5, row: 1, tone: "slate" },
      {
        id: "keyserver",
        label: "Key Server",
        sub: "identity + signed + one-time prekeys",
        mono: "X3DH bundle",
        col: 1,
        row: 2,
        tone: "purple",
      },
      { id: "presence", label: "Presence Registry", sub: "user/device → gateway shard", col: 3, row: 2, tone: "green" },
      { id: "push", label: "Push Notification", sub: "APNs / FCM", mono: "silent wake, no plaintext", col: 4, row: 2, tone: "orange" },
      { id: "recipientOffline", label: "Recipient Client (offline)", col: 5, row: 2, tone: "slate" },
      { id: "groupFanout", label: "Group Fanout", sub: "sender-key distribution", col: 3, row: 3, tone: "orange" },
      { id: "media", label: "Media Blob Store", sub: "S3 / CDN", mono: "opaque AES-encrypted bytes", col: 4, row: 3, tone: "blue" },
    ],
    edges: [
      { from: "sender", to: "keyserver", label: "fetch prekey bundle · new session only", kind: "read" },
      { from: "sender", to: "gateway", label: "Double-Ratchet ciphertext", kind: "write" },
      { from: "gateway", to: "router", kind: "write" },
      { from: "router", to: "presence", label: "lookup recipient's shard", kind: "read" },
      { from: "router", to: "mailbox", label: "persist ciphertext (durability)", kind: "write" },
      { from: "router", to: "recipientOnline", label: "deliver live over WS", kind: "write" },
      { from: "mailbox", to: "push", label: "recipient offline → trigger wake", kind: "analytics" },
      { from: "push", to: "recipientOffline", label: "silent push, no plaintext", kind: "analytics" },
      { from: "recipientOffline", to: "mailbox", label: "reconnect → pull queued ciphertext", kind: "read" },
      { from: "sender", to: "media", label: "upload AES-encrypted attachment", kind: "write" },
      { from: "media", to: "recipientOnline", label: "fetch ciphertext blob via CDN", kind: "read" },
      { from: "router", to: "groupFanout", label: "member join/rotate only → distribute new chain key", kind: "write" },
      { from: "groupFanout", to: "mailbox", label: "one pairwise-encrypted write per member device", kind: "write" },
    ],
    legend: [
      { kind: "read", text: "read / fetch path · prekeys, presence, reconnect delivery" },
      { kind: "write", text: "write / send path · encrypt, route, persist, deliver" },
      { kind: "analytics", text: "async · offline wake-up, never blocks a send" },
    ],
  },

  diagramSteps: [
    {
      reveal: ["sender", "gateway", "router", "recipientOnline"],
      say: "Start with the shape everyone expects: a sender's client talks to a WebSocket gateway, a router forwards the message, and if the recipient is connected right now it's delivered live. The one thing that makes this different from a normal chat app: everything the router ever touches is already ciphertext.",
    },
    {
      reveal: ["keyserver"],
      say: "But the sender can't encrypt to someone new without their public key material, and that someone might be offline. The Key Server holds pre-published X3DH bundles — identity key, signed prekey, one-time prekeys — so a session can start asynchronously, with zero live round trip to the recipient.",
    },
    {
      reveal: ["presence", "mailbox", "push", "recipientOffline"],
      say: "Not everyone is online when a message lands. Presence tells the router whether a live connection exists; if not, the Mailbox Store durably queues the ciphertext for up to 30 days and a content-free silent push wakes the recipient's device to come pull it.",
    },
    {
      reveal: ["media"],
      say: "Attachments don't fit inside a Double-Ratchet message. The client encrypts the file locally with a random AES key, uploads the opaque blob straight to object storage, and embeds only the decryption key inside the small encrypted text message.",
    },
    {
      reveal: ["groupFanout"],
      say: "Groups can't pay a pairwise-encryption cost on every one of a million messages a second. Group Fanout does the expensive pairwise work exactly once — distributing each member's sender key on join or rotation — after which every steady-state send is a single O(1) symmetric encryption the router just broadcasts like any other fan-out.",
    },
  ],

  // -------------------------------------------------------------------------
  requirements: {
    functional: [
      { id: "FR-01", text: "Send/receive 1:1 messages such that only the sender's and recipient's devices can read the plaintext", tag: "P0" },
      { id: "FR-02", text: "Group messaging, up to 1,000 members, with the same end-to-end guarantee", tag: "P0" },
      { id: "FR-03", text: "Multi-device support: a single account can have several devices, each independently keyed", tag: "P0" },
      { id: "FR-04", text: "Offline delivery: messages queue durably and deliver when the recipient device reconnects", tag: "P0" },
      { id: "FR-05", text: "Forward secrecy and post-compromise security via per-message key ratcheting", tag: "P0" },
      { id: "FR-06", text: "Encrypted media/file attachments (photo, video, doc) up to 100MB", tag: "P0" },
      { id: "FR-07", text: "Delivery and read receipts without leaking message content to the server", tag: "P1" },
      { id: "FR-08", text: "New-device linking with out-of-band key verification (safety numbers / QR)", tag: "P1" },
      { id: "FR-09", text: "Typing indicators and presence (online/last-seen)", tag: "P1" },
      { id: "FR-10", text: "Disappearing messages with a per-chat TTL", tag: "P2" },
      { id: "FR-11", text: "Message search, performed client-side only since the server holds no plaintext", tag: "P2" },
    ],
    nonFunctional: [
      { id: "NFR-01", text: "Message delivery latency, both parties online", tag: "p99 < 150ms" },
      { id: "NFR-02", text: "Sustained message throughput at peak", tag: "1M/sec" },
      { id: "NFR-03", text: "Availability (messaging must survive regional failure)", tag: "99.99%" },
      { id: "NFR-04", text: "Durability: no message dropped once accepted, until ≥1 device ACKs", tag: "zero loss" },
      { id: "NFR-05", text: "Plaintext ever held or logged server-side", tag: "0 bytes" },
      { id: "NFR-06", text: "Offline mailbox retention before a message expires undelivered", tag: "30 days" },
      { id: "NFR-07", text: "Prekey bundle fetch latency (new session setup)", tag: "p99 < 50ms" },
      { id: "NFR-08", text: "Group size before pairwise fanout cost dominates without Sender Keys", tag: "1,000 members" },
    ],
  },

  // -------------------------------------------------------------------------
  learn: [
    {
      n: 1,
      title: "The core constraint: the server is a blind relay",
      body: [
        "Every other decision in this system follows from one rule: the server must never possess a key that can decrypt message content. That's the definition of end-to-end encryption, not a nice-to-have. It means the server cannot do full-text search, cannot generate rich link-preview thumbnails from the message itself, cannot scan for spam by reading content, and cannot recover a lost conversation if every device is lost. Say this constraint out loud before drawing a single box, because it explains why so many 'obvious' server-side features (search, moderation, notification previews) have to move to the client or disappear.",
        "What the server is allowed to know and optimize is metadata: who is talking to whom, when, how often, and how big the payload is. Minimizing even that (sealed sender) is a second, harder-won layer on top of content encryption.",
      ],
      bullets: [
        { lead: "Content", text: "encrypted client-side before it ever leaves the sender's device; the server stores and forwards bytes it cannot open." },
        { lead: "Metadata", text: "sender, recipient, timestamp, size — this is what sealed sender tries to hide from the server, separately from content." },
        { lead: "Consequence", text: "search, spam scanning, rich previews, and lost-device recovery all have to be redesigned around never touching plaintext server-side." },
      ],
      pictureTitle: "What the server can and can't see",
      pictureRows: [
        { label: "Message ciphertext", value: "server relays/stores it, cannot decrypt", tone: "good" },
        { label: "Sender/recipient/time", value: "server sees this unless sealed sender is used", tone: "neutral" },
        { label: "Server-side search or spam scan on content", value: "impossible by design — reject the request", tone: "bad" },
      ],
      remember: {
        problem: "What can the server ever be trusted to see?",
        solution: "Ciphertext only for content; metadata (who/when/size) is visible unless separately hidden via sealed sender.",
        why: "E2EE is a hard guarantee: if the server can decrypt, it isn't E2EE — this constrains every feature that touches content.",
        tradeoff: "You give up server-side search, spam scanning on content, and previews generated from the message body.",
        failure: "A 'temporary' server-side decrypt for a convenience feature (e.g. push preview text) silently breaks the guarantee.",
        mitigation: "Do those features client-side (local search index, client-generated previews) and treat any server decrypt request as a red flag in design review.",
      },
    },
    {
      n: 2,
      title: "X3DH: starting a session with someone who's offline",
      body: [
        "Two people can't do a live Diffie-Hellman handshake if the recipient's phone is off. X3DH (Extended Triple Diffie-Hellman) solves this by having every device pre-publish a bundle of public keys to the Key Server: a long-term identity key, a medium-term signed prekey (rotated periodically, signed by the identity key so it can't be forged), and a batch of one-time prekeys (each used for exactly one incoming session, then deleted).",
        "The sender fetches the recipient's bundle, does several DH computations combining their own keys with the recipient's, and derives a shared secret — all without the recipient being online. The one-time prekey is what gives forward secrecy to that very first message: even if the identity and signed prekeys are later compromised, that initial handshake can't be recomputed once the one-time prekey is gone.",
      ],
      bullets: [
        { lead: "Identity key", text: "long-term, one per device, the anchor of that device's identity — this is what a safety-number check verifies." },
        { lead: "Signed prekey", text: "rotated every so often (e.g. weekly), signed by the identity key so the server can't hand out a forged one." },
        { lead: "One-time prekeys", text: "single-use; a device uploads a batch (e.g. 100) and the server hands one out per incoming session, then discards it." },
        { lead: "Depletion", text: "if one-time prekeys run out before the device replenishes, the handshake falls back to just the signed prekey — still secure, but loses that extra forward-secrecy margin on message one." },
      ],
      pictureTitle: "The prekey bundle",
      pictureRows: [
        { label: "Identity key", value: "long-term, verified via safety number", tone: "neutral" },
        { label: "Signed prekey", value: "rotates weekly, signed by identity key", tone: "neutral" },
        { label: "One-time prekey", value: "used once, deleted — gives msg-1 forward secrecy", tone: "good" },
        { label: "Prekey pool empty", value: "falls back to signed-prekey-only, weaker margin", tone: "bad" },
      ],
      remember: {
        problem: "Start an encrypted session with a device that's offline right now.",
        solution: "X3DH: sender combines their keys with the recipient's pre-published identity + signed + one-time prekeys via multiple DH computations.",
        why: "The recipient doesn't need to be online — their keys were already published; the sender does all the work asynchronously.",
        tradeoff: "One-time prekeys are a finite, replenishable resource; running dry weakens (doesn't break) the very first message's forward secrecy.",
        failure: "If the key server can be tricked into serving a forged signed prekey, an attacker can MITM the handshake.",
        mitigation: "Signed prekeys are signed by the long-term identity key, and safety-number verification catches a substituted identity key out of band.",
      },
    },
    {
      n: 3,
      title: "Double Ratchet: forward secrecy and healing after compromise",
      body: [
        "X3DH gets you one shared secret to start a conversation. The Double Ratchet is what keeps that conversation secure message after message, for months. It runs two ratchets: a symmetric-key ratchet that derives a fresh message key from a chain key for every message (so each message key is used once and discarded — that's forward secrecy, a stolen key today can't decrypt yesterday's messages), and a Diffie-Hellman ratchet that mixes in a brand-new DH exchange whenever the conversation direction flips (that's post-compromise security — even if an attacker steals today's chain, the next DH step heals the session going forward).",
        "Because messages can arrive out of order (network retries, multiple devices), the ratchet keeps a bounded cache of 'skipped' message keys it derived but hasn't used yet, so an out-of-order message can still be decrypted later — with a cap (e.g. a few thousand) to stop an attacker from forcing unbounded memory growth by claiming huge gaps in the counter.",
      ],
      bullets: [
        { lead: "Symmetric-key ratchet", text: "every message derives a new key from a one-way chain; old keys are deleted immediately, so forward secrecy holds message-by-message." },
        { lead: "DH ratchet", text: "on each turn of the conversation, a fresh DH exchange is mixed in — compromise today doesn't compromise tomorrow (self-healing)." },
        { lead: "Out-of-order delivery", text: "a bounded skipped-message-key cache (not a strict in-order requirement) lets messages 1, 3, 2 arrive and still decrypt." },
        { lead: "Bounded cache", text: "capped size prevents a malicious peer from claiming a huge counter jump and exhausting memory." },
      ],
      pictureTitle: "Two ratchets, two guarantees",
      pictureRows: [
        { label: "Symmetric-key ratchet", value: "forward secrecy: old key theft doesn't expose history", tone: "good" },
        { label: "DH ratchet", value: "post-compromise security: session heals going forward", tone: "good" },
        { label: "Skipped-key cache", value: "handles out-of-order delivery, capped size", tone: "neutral" },
        { label: "Uncapped skipped-key cache", value: "DoS vector via forged large counter gaps", tone: "bad" },
      ],
      remember: {
        problem: "Keep a long-running conversation secure even if a key or device is compromised at some point.",
        solution: "Double Ratchet: symmetric chain ratchet per message (forward secrecy) + DH ratchet per direction flip (post-compromise healing).",
        why: "A single static session key would mean one leak exposes the entire conversation, past and future; ratcheting bounds the blast radius to one message or one epoch.",
        tradeoff: "More per-message compute and per-session state (chain keys, skipped-key cache) than a static shared key.",
        failure: "An unbounded skipped-key cache lets an attacker force unbounded memory growth by forging large sequence gaps.",
        mitigation: "Cap the skipped-key cache size and evict oldest entries; treat cache-exhaustion as a signal to drop the session, not extend it.",
      },
    },
    {
      n: 4,
      title: "Groups at scale: Sender Keys instead of O(members × devices)",
      body: [
        "The naive extension of 1:1 encryption to groups is: encrypt the message separately, pairwise, to every device of every member. For a 1,000-member group averaging 2 devices each, that's 2,000 independent Double Ratchet encryptions per message — completely unworkable at 1M msgs/sec.",
        "Sender Keys fix this: each member generates a symmetric chain key for the group and distributes it once to every other member's devices over their existing pairwise Double Ratchet sessions (still O(members × devices), but only on join or key rotation, not on every message). After that, sending a message is one symmetric encryption, broadcast to everyone who already holds the chain key — O(1) per send. The cost moves from 'every message' to 'every membership change,' which is exactly where you want it, since membership changes far less often than messages are sent.",
      ],
      bullets: [
        { lead: "Naive pairwise", text: "O(members × devices) asymmetric encryptions per message — the failure mode to name and reject." },
        { lead: "Sender Keys", text: "each sender's chain key is distributed once (pairwise, cost amortized), then reused for O(1) bulk symmetric encryption per message." },
        { lead: "Rotation cost", text: "when someone leaves the group, every remaining member must rotate to a fresh sender key, or the departed member could still decrypt future messages." },
        { lead: "Say the tradeoff", text: "large, high-churn groups pay rotation cost often; the interviewer wants to hear you name this, not just 'use Sender Keys' as a magic phrase." },
      ],
      pictureTitle: "Per-message cost as the group scales",
      pictureRows: [
        { label: "Pairwise, 1,000 members × 2 devices", value: "2,000 encryptions per message — reject", tone: "bad" },
        { label: "Sender Keys, steady state", value: "1 symmetric encryption per message", tone: "good" },
        { label: "Sender Keys, on member leave", value: "full re-distribution to all remaining members", tone: "neutral" },
      ],
      remember: {
        problem: "Encrypt a group message without paying an O(members × devices) cost on every single send.",
        solution: "Sender Keys: distribute a per-sender symmetric chain key once (pairwise), then bulk-encrypt each message with it (O(1)).",
        why: "Amortizes the expensive pairwise step over many messages instead of paying it per message; group churn is far less frequent than message volume.",
        tradeoff: "Every membership change (especially a leave) forces a full key rotation and re-distribution to the remaining members.",
        failure: "Skip rotation on leave and a removed member can still decrypt every future group message with their old sender key.",
        mitigation: "Force sender-key rotation synchronously on any leave/remove event before the next message is allowed to send.",
      },
    },
    {
      n: 5,
      title: "Multi-device: every device is its own identity",
      body: [
        "A user with a phone, laptop, and tablet isn't one recipient — they're three separate device identities, each with its own identity key, its own prekey bundle, and its own Double Ratchet session with every peer. Sending 'to a person' really means encrypting the message once per device across every conversation participant, including the sender's own other devices (so your laptop shows a message you sent from your phone).",
        "This creates the hardest UX problem in the whole system: linking a new device. The server never had plaintext, so it cannot backfill history to a freshly linked laptop. The practical answer is a primary-device relay — the new device generates its own keys, the primary device authenticates it (usually via QR-code-scanned linking secret) and then re-encrypts and forwards a bounded window of recent history directly to the new device over an encrypted channel; the server is not a participant in that transfer.",
      ],
      bullets: [
        { lead: "Fanout multiplies", text: "a message to N group members with D devices each is N×D encryptions under Sender Keys' distribution step, or N×D full Double Ratchet sessions without it." },
        { lead: "Self-sync", text: "your own other devices need the message too, so 'recipients' includes the sender's device set minus the sending device." },
        { lead: "New-device linking", text: "the server can't backfill history it never had; the primary device must relay it directly, out of band from server storage." },
        { lead: "Safety numbers per device", text: "verification is now per-device-pair, not per-person — a changed device shows as a changed safety number and should re-prompt verification." },
      ],
      pictureTitle: "Who actually needs a copy of this message",
      pictureRows: [
        { label: "Recipient's 2 devices", value: "2 independent encryptions", tone: "neutral" },
        { label: "Sender's own other devices", value: "also need the message — often forgotten", tone: "bad" },
        { label: "New device, no history from server", value: "primary device relays it directly, server never sees it", tone: "good" },
      ],
      remember: {
        problem: "One 'user' is really several independently keyed devices; how does content and history reach all of them?",
        solution: "Encrypt separately per device (including the sender's own other devices); sync new-device history via a primary-device relay, not the server.",
        why: "Each device has its own identity key and ratchet state — there is no shared 'account key' the server could use to fan out for you.",
        tradeoff: "Fanout cost multiplies by device count on every send; new-device linking is slower and requires the primary device to be online.",
        failure: "Forgetting to encrypt to the sender's own other devices means messages you send don't show up on your other devices.",
        mitigation: "Treat the sender's device set as recipients too, and cap history relay to a bounded recent window to keep linking fast.",
      },
    },
    {
      n: 6,
      title: "Delivery: mailboxes, presence, and silent push",
      body: [
        "The server's job on the write path is boring by design: accept ciphertext, figure out which gateway shard (if any) holds a live connection to each target device via a presence registry, deliver live if online, and durably persist to a per-device mailbox otherwise. That's it — there's no business logic to run on the content because the server can't read it.",
        "For offline devices, a push notification (APNs/FCM) is not the message — it's a wake-up signal, typically opaque or containing only minimal metadata, that tells the OS to open the app or briefly resume the network connection so the client can pull the real ciphertext from its mailbox. This split (silent push to wake, mailbox pull for content) is what lets the server participate in delivery without ever holding a decryptable payload in the push provider's hands, which is itself a third party outside your trust boundary.",
      ],
      bullets: [
        { lead: "Presence registry", text: "a fast, consistent-hashed lookup (user/device → gateway shard) so the router knows whether to deliver live or fall back to storage." },
        { lead: "Mailbox store", text: "per-device durable queue (Cassandra/DynamoDB), TTL'd (e.g. 30 days) so undelivered messages don't accumulate forever." },
        { lead: "Push is a doorbell, not a letter", text: "APNs/FCM only ever carries a wake-up signal; the ciphertext is fetched over an authenticated connection to your own mailbox, never embedded in the push payload." },
        { lead: "Sealed sender", text: "an optional further step where the server-relayed envelope hides even who sent the message from the server, using a server-issued certificate the sender includes without revealing their identity to the delivery layer." },
      ],
      pictureTitle: "Online vs. offline delivery",
      pictureRows: [
        { label: "Recipient online", value: "router delivers live over the existing WS connection", tone: "good" },
        { label: "Recipient offline", value: "persist to mailbox + silent push to wake the client", tone: "neutral" },
        { label: "Push payload contains plaintext", value: "leaks content to Apple/Google — never do this", tone: "bad" },
      ],
      remember: {
        problem: "Deliver a message whether the recipient is connected right now or not, without the server understanding content.",
        solution: "Presence registry routes to a live WS connection when possible; otherwise persist to a per-device mailbox and send a content-free silent push to wake the client.",
        why: "The server's only job is store-and-forward of opaque bytes plus connection routing — no content-dependent logic is possible or needed.",
        tradeoff: "Offline delivery adds a round trip (wake, reconnect, pull) versus the single hop of a live delivery.",
        failure: "Putting message content or a preview in the push payload leaks plaintext to the push provider (Apple/Google), breaking E2EE.",
        mitigation: "Push carries only an opaque wake signal; the client always fetches the real ciphertext over its own authenticated channel.",
      },
    },
    {
      n: 7,
      title: "Encrypted media: the key travels inside the message, not to the server",
      body: [
        "Attachments are too large to embed directly in a Double-Ratchet-encrypted message, so media gets a split design: the client generates a random AES-256 key and nonce, encrypts the file locally, and uploads the opaque ciphertext blob to ordinary object storage (S3-class + CDN) that never sees the key. The AES key and nonce are then embedded inside the small E2EE text message sent through the normal Double Ratchet channel, so only devices that can decrypt the message can decrypt the attachment.",
        "This means the blob store is exactly as blind as the mailbox — it serves bytes on request but the decrypt capability lives entirely in the message payload, not in anything the server holds. It also means content-addressed deduplication across users is effectively impossible (the same file encrypted by two different senders produces two unrelated ciphertexts), which is a deliberate privacy tradeoff, not an oversight.",
      ],
      bullets: [
        { lead: "Per-file random key", text: "generated client-side, never sent to the server in the clear, embedded only inside the already-encrypted message payload." },
        { lead: "Blob store stays dumb", text: "S3/CDN serves opaque bytes by content handle; it cannot decrypt and therefore cannot thumbnail, scan, or transcode server-side." },
        { lead: "No cross-user dedup", text: "the same file uploaded by two senders yields two unrelated ciphertexts — this is the privacy cost of not letting the server compute a plaintext hash." },
        { lead: "Expiry", text: "media blobs get their own TTL/garbage-collection policy, independent of the message mailbox TTL, since a message can reference the same blob from multiple recipients." },
      ],
      pictureTitle: "Where does the decrypt key live?",
      pictureRows: [
        { label: "AES key for the file", value: "generated client-side, travels inside the encrypted message", tone: "good" },
        { label: "Ciphertext blob", value: "sits in ordinary object storage, server cannot open it", tone: "neutral" },
        { label: "Server-side thumbnailing/transcoding", value: "impossible without the key — must happen client-side", tone: "bad" },
      ],
      remember: {
        problem: "Deliver large attachments end-to-end encrypted without embedding megabytes in the message protocol.",
        solution: "Client encrypts the file with a random per-file AES key, uploads ciphertext to plain object storage, and ships the key inside the small E2EE message.",
        why: "Splits bulk-data transport (cheap, server can host it) from the decrypt capability (which must never leave the E2EE channel).",
        tradeoff: "No server-side thumbnailing, transcoding, or cross-user content dedup, since the server never holds a usable key or plaintext hash.",
        failure: "Sending the AES key alongside the blob upload (instead of inside the E2EE message) would let the storage layer decrypt it.",
        mitigation: "Treat the blob store as untrusted by construction — key material only ever travels through the Double-Ratchet-encrypted channel.",
      },
    },
  ],

  // -------------------------------------------------------------------------
  cheatSheet: {
    oneBreath: [
      "The server is a blind relay: it stores and forwards ciphertext it can never decrypt, so every feature that needs content (search, previews, spam scanning) has to move client-side.",
      "X3DH lets a sender start a session with an offline device using pre-published keys; the Double Ratchet then keeps every message forward-secret and heals the session after a compromise.",
      "Groups use Sender Keys so a message is one O(1) symmetric encryption per send, paying the expensive pairwise distribution only when membership changes, not on every message.",
      "Every device — not every person — is a separate identity; a message fans out per device, including the sender's own other devices, and new-device history syncs via a primary-device relay, not the server.",
      "Delivery is presence-routed when the recipient is online, else it lands in a durable per-device mailbox and a content-free silent push wakes the client to pull it.",
    ],
    flows: [
      {
        kind: "write",
        title: "SEND · 1M/S PEAK · P99 < 150MS ONLINE",
        summary:
          "The sender's device does all the cryptography. The server never touches plaintext — it just routes and, if needed, stores ciphertext until the recipient's device can pull it.",
        steps: [
          { label: "Sender Client", note: "Double Ratchet: derive next message key, encrypt locally" },
          { label: "Key Server", note: "only on first message to a new device — fetch X3DH prekey bundle" },
          { label: "WS Gateway", note: "accepts ciphertext over the sender's persistent connection" },
          { label: "Message Router", note: "per-device fanout list" },
          { label: "Presence Registry", note: "is each target device online right now?" },
          { label: "Mailbox Store", note: "persist ciphertext for durability regardless of online status" },
          { label: "Recipient Client (online)", note: "delivered live over its own WS connection" },
        ],
      },
      {
        kind: "read",
        title: "OFFLINE RECONNECT · P99 < 50MS PREKEY FETCH",
        summary:
          "A device that was offline never lost anything — the server was holding its ciphertext the whole time. A silent push just tells it to come back and ask for what's waiting.",
        steps: [
          { label: "Mailbox Store", note: "held ciphertext for this device, TTL 30 days" },
          { label: "Push Notification", note: "silent APNs/FCM wake, carries no content" },
          { label: "Recipient Client (offline → online)", note: "reconnects to its WS Gateway shard" },
          { label: "Mailbox Store", note: "pulls the full queued backlog for this device" },
          { label: "Recipient Client", note: "runs the Double Ratchet forward per message, decrypts locally" },
        ],
      },
      {
        kind: "analytics",
        title: "GROUP SEND · SENDER KEYS · O(1) STEADY STATE",
        summary:
          "The expensive pairwise work happens once, when the group's membership changes — not on every message. Steady-state sends are a single symmetric encryption broadcast to everyone who already has the key.",
        steps: [
          { label: "Group Fanout", note: "on join/rotate: distribute sender's chain key pairwise to each member's devices" },
          { label: "Sender Client", note: "steady state: one symmetric encryption with the existing chain key" },
          { label: "Message Router", note: "broadcasts the single ciphertext to all member mailboxes/connections" },
          { label: "Mailbox Store", note: "fan-out write per member/device" },
          { label: "On member leave", note: "force chain-key rotation before the next send is allowed" },
        ],
      },
    ],
    columns: [
      {
        heading: "NUMBERS",
        icon: "🔢",
        items: [
          "200M DAU, 20B msgs/day ≈ 1M msgs/sec at peak",
          "Groups up to 1,000 members; ~2 devices/user average",
          "Delivery latency: p99 < 150ms both parties online",
          "Prekey bundle fetch: p99 < 50ms",
          "Offline mailbox retention: 30 days TTL",
          "Naive pairwise group fanout: 1,000 × 2 = 2,000 encryptions/msg (rejected)",
          "Sender Keys steady state: 1 symmetric encryption/msg",
        ],
      },
      {
        heading: "DECISIONS",
        icon: "🧭",
        items: [
          "X3DH for asynchronous session setup with offline devices",
          "Double Ratchet: symmetric chain ratchet (forward secrecy) + DH ratchet (post-compromise healing)",
          "Sender Keys for groups, not pairwise fanout — O(1) per send, O(members) only on membership change",
          "Every device is its own identity; sender's own other devices are recipients too",
          "New-device history relayed by the primary device, never backfilled by the server",
          "Media: random per-file AES key travels inside the E2EE message, ciphertext blob in plain object storage",
        ],
      },
      {
        heading: "MUST MENTION",
        icon: "📣",
        items: [
          "The server can never hold a key that decrypts content — this constrains search, previews, and spam scanning",
          "Push notifications are a content-free wake-up signal, never the message itself",
          "Rotate the group sender key synchronously on every member removal, or the removed member keeps reading",
          "Skipped-message-key cache must be size-bounded or it's a DoS vector",
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  rehearse: [
    {
      n: 1,
      title: "Clarify Requirements and Threat Model",
      minutes: 5,
      goal: "Lock the scale numbers and, more importantly, lock exactly what the server is and isn't trusted to see. That threat-model line drives every later decision.",
      why: "This is not a generic chat app question — the E in E2EE is the whole point. If you don't nail down the trust boundary first, you'll spend the rest of the interview accidentally proposing server-side features that break the guarantee.",
      steps: [
        { kind: "ASK", text: 'Ask **"What scale — how many DAU, messages per day, and are we 1:1 only or also groups?"** Land on "200M DAU, 20B msgs/day, ~1M msgs/sec peak, groups up to 1,000 members." Write it on the board.' },
        { kind: "SAY", text: 'State the threat model yourself: **"The server must never be able to decrypt message content — only ciphertext touches the server."** Get the interviewer to confirm this is the actual bar, since it rules out server-side search and spam scanning on content.' },
        { kind: "ASK", text: 'Ask **"Multi-device — phone, laptop, tablet all logged in at once?"** Land on yes, and note out loud that each device is its own key identity, not a shared account key.' },
        { kind: "SAY", text: 'Propose scope. In: "1:1 and group E2EE messaging, multi-device, offline delivery, encrypted media." Out for now: "voice/video calls, server-assisted content moderation, account recovery via server-held keys." Park them explicitly.' },
        { kind: "SAY", text: 'Propose the latency target: **"p99 under 150ms when both parties are online"**. Wait for a nod before moving on.' },
      ],
      grading: "Did the threat model get stated explicitly and confirmed before any design work, and were the scale numbers written down rather than left implicit?",
    },
    {
      n: 2,
      title: "API and Data Model",
      minutes: 5,
      goal: "A tiny surface: send-ciphertext, fetch-prekey-bundle, pull-mailbox. Show the mailbox row is opaque bytes, not a chat schema.",
      why: "The interviewer wants to see that you understand the server's schema has almost no chat-domain fields in it — no 'text', no 'sender name' it can act on. If your data model looks like a normal chat app's, you've missed the point.",
      steps: [
        { kind: "WRITE", text: 'Write three endpoints: **"POST /messages { deviceId, recipientDeviceIds[], ciphertext, header }"**, **"GET /prekeys/{userId}"** returns a bundle, **"GET /mailbox/{deviceId}"** returns queued ciphertext.' },
        { kind: "DRAW", text: 'Sketch the mailbox row: **"device_id (PK)"**, **"message_id"**, **"ciphertext (opaque blob)"**, **"ratchet_header (opaque)"**, **"received_at"**, **"ttl"**. Say out loud: "There is no plaintext field, no sender-display-name the server resolves from content — those live client-side."' },
        { kind: "SAY", text: 'Name the prekey bundle fields: **"identity key, signed prekey + signature, one optional one-time prekey"**. Explain the one-time prekey is deleted after being served once.' },
        { kind: "RULE OUT", text: 'Get ahead of it: "A schema with a plaintext or even a hashed-plaintext content column would leak information server-side — reject that immediately, even for search convenience."' },
      ],
      grading: "The schema is visibly opaque (blobs, not fields the server can interpret), and the candidate explicitly rejects any convenience field that would leak plaintext or its hash.",
    },
    {
      n: 3,
      title: "High-Level Design: draw the send and delivery paths",
      minutes: 8,
      goal: "One diagram, three lanes: encrypt-and-send, online delivery via presence, and offline delivery via mailbox + silent push.",
      why: "The interviewer is checking whether you understand that online and offline delivery are structurally different paths, and that push notifications are architecturally forbidden from carrying content.",
      steps: [
        { kind: "DRAW", text: 'Draw the send path: Sender Client → WS Gateway → Message Router → Presence Registry (is target online?). Label the arrow into the router **"ciphertext, already Double-Ratchet-encrypted"**.' },
        { kind: "DRAW", text: 'Split at the router: online branch → deliver live to Recipient Client over its own WS Gateway; offline branch → Mailbox Store (durable, TTL 30d) → Push Notification (silent, content-free) → recipient wakes and pulls from mailbox.' },
        { kind: "DRAW", text: 'Add the media path off to the side: Sender Client → Media Blob Store (opaque ciphertext) with the AES key traveling inside the normal encrypted message, not with the upload.' },
        { kind: "SAY", text: 'Narrate: "The router never inspects content, only routes by device id. The only content-shaped thing the server ever sees is ciphertext length and timing — that\'s the metadata surface, separate from the content guarantee."' },
      ],
      grading: "Online and offline delivery are drawn as genuinely different paths, and the candidate states unprompted that push notifications never carry message content.",
    },
    {
      n: 4,
      title: "Deep Dive: X3DH and the Double Ratchet",
      minutes: 8,
      goal: "Explain how a session starts with an offline device and how it stays secure for months, in your own words, with the two ratchets named separately.",
      why: "This is the signature crypto sub-problem. The interviewer wants to see you distinguish forward secrecy (symmetric ratchet) from post-compromise security (DH ratchet) — conflating them is the single most common gap at this stage.",
      steps: [
        { kind: "SAY", text: 'Explain X3DH: "The recipient pre-publishes an identity key, a signed prekey, and one-time prekeys to the Key Server. The sender combines their own keys with that bundle via several DH computations to derive a shared secret — no live round trip needed."' },
        { kind: "SAY", text: 'Explain forward secrecy: "Every message derives a fresh key from a one-way chain and the old key is deleted immediately — stealing today\'s key doesn\'t expose yesterday\'s messages."' },
        { kind: "SAY", text: 'Explain post-compromise security: "On top of that, a DH ratchet step runs whenever the conversation direction flips, mixing in a new exchange — so even a compromised session heals going forward."' },
        { kind: "RULE OUT", text: 'Handle out-of-order delivery: "Messages can arrive 1, 3, 2 — I keep a bounded skipped-message-key cache so message 3 can still be decrypted once it arrives, but I cap its size so a forged large counter gap can\'t exhaust memory."' },
      ],
      grading: "Forward secrecy and post-compromise security are named and explained as two separate mechanisms, and the skipped-key cache's DoS risk is raised unprompted.",
    },
    {
      n: 5,
      title: "Deep Dive: Groups and Multi-Device Fanout",
      minutes: 8,
      goal: "Kill naive pairwise group encryption with real numbers, defend Sender Keys, and name the rotation-on-leave requirement.",
      why: "This is where candidates either show they've thought about scale under E2EE constraints or reveal they only know the 1:1 case. The interviewer is listening for the O(1)-per-send claim and its cost (rotation on membership change).",
      steps: [
        { kind: "SAY", text: 'Quantify the naive approach: "Encrypting pairwise to every device in a 1,000-member group at ~2 devices each is 2,000 asymmetric encryptions per message — completely unworkable at 1M msgs/sec."' },
        { kind: "SAY", text: 'Introduce Sender Keys: "Each member distributes a symmetric chain key once, pairwise, over existing Double Ratchet sessions. After that, sending is one symmetric encryption broadcast to the group — O(1) per message."' },
        { kind: "RULE OUT", text: 'Name the cost: "The tradeoff is rotation — when someone leaves, everyone remaining must rotate to a new sender key immediately, or the removed member can keep decrypting future messages with the old one."' },
        { kind: "SAY", text: 'Bring up multi-device fanout: "Fanout is really members times devices, and it also includes the sender\'s own other devices, which is an easy thing to forget."' },
      ],
      grading: "The naive-vs-Sender-Keys tradeoff is quantified with real numbers, and the rotation-on-leave requirement is stated without being prompted.",
    },
    {
      n: 6,
      title: "Wrap: Metadata, Failure Modes, and Close",
      minutes: 6,
      goal: "Name what's still visible to the server (metadata), how the system degrades gracefully, and close with a crisp one-sentence summary plus a parked-items list.",
      why: "Staff-level signal here is knowing E2EE has layers — content is protected, but metadata is a second, harder problem — and being able to reason about failure modes (prekey exhaustion, gateway loss) without prompting.",
      steps: [
        { kind: "SAY", text: 'Name the metadata gap: "Even with content fully encrypted, the server still sees who talks to whom and when, unless we add sealed sender — that\'s a separate, harder guarantee on top of content encryption."' },
        { kind: "SAY", text: 'Cover a failure mode unprompted: "If one-time prekeys run dry before a device replenishes, the handshake falls back to signed-prekey-only — still secure, just a slightly weaker forward-secrecy margin on the very first message."' },
        { kind: "SAY", text: 'Push back where useful: "Do we need search at all, or is client-side local search enough? Server-side search on content isn\'t possible under this threat model."' },
        { kind: "SAY", text: 'Close in one sentence and park the rest: "It\'s an X3DH-plus-Double-Ratchet system where the server only ever routes and stores ciphertext; with more time I\'d cover sealed sender, key-compromise recovery, and abuse reporting via client-side flagging."' },
      ],
      grading: "The metadata-vs-content distinction is drawn explicitly, at least one failure mode is raised unprompted, and the close is a crisp one-liner with a named parking list.",
    },
  ],

  // -------------------------------------------------------------------------
  scoring: {
    levels: [
      {
        tag: "L4 / SDE-II",
        title: "Mid-Level Engineer",
        emoji: "🥉",
        summary: "Builds a working messaging system with encryption in transit and at rest, but treats E2EE as a checkbox rather than a hard architectural constraint.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "Draws the standard chat pieces: WebSocket gateway, message queue, database, push notifications.",
          "Knows TLS is not the same as E2EE and mentions client-side encryption exists.",
          "Handles offline delivery with a queue and a push notification.",
          "Can name Signal Protocol / Double Ratchet if prompted, but can't explain what problem each ratchet solves.",
          "Adds a database schema with a ciphertext column.",
        ],
        gaps: [
          "Proposes server-side search or content moderation without noticing it contradicts E2EE.",
          "Treats groups as 'just send to everyone' without quantifying the pairwise fanout cost.",
          "Multi-device is an afterthought — assumes one key per account, not per device.",
          "Doesn't distinguish forward secrecy from post-compromise security, or conflates them.",
          "No plan for what goes in a push notification payload; may put message text in it.",
        ],
      },
      {
        tag: "L5 / SDE-III",
        title: "Senior Engineer",
        emoji: "🥈",
        summary: "Drives the design from the E2EE constraint itself, correctly separates X3DH from the Double Ratchet, and quantifies why naive group fanout fails.",
        gapsLabel: "COMMON GAPS THAT CAP YOU HERE",
        signals: [
          "States the server-never-sees-plaintext constraint before drawing any boxes.",
          "Explains X3DH for asynchronous session setup and the Double Ratchet for ongoing forward secrecy separately.",
          "Quantifies naive pairwise group encryption (members × devices) and proposes Sender Keys as the fix.",
          "Treats every device as its own identity, including the sender's own other devices as recipients.",
          "Designs push notifications as content-free wake signals with mailbox pull for the real payload.",
          "Explains the media split: random per-file AES key traveling inside the E2EE message, blob in plain storage.",
        ],
        gaps: [
          "Mentions sealed sender / metadata protection only when asked, not as a natural extension of the threat model.",
          "Doesn't volunteer the rotation-on-leave requirement for Sender Keys unless pushed.",
          "New-device linking is hand-waved as 'sync from server' rather than recognizing the server has no history to give.",
        ],
      },
      {
        tag: "L6+",
        title: "Staff+ Engineer",
        emoji: "🥇",
        summary: "Treats content encryption and metadata protection as two separate, layered guarantees, and reasons fluently about every degraded/compromise state.",
        gapsLabel: "WHAT SETS THIS LEVEL APART",
        signals: [
          "Volunteers the metadata gap unprompted: content is E2EE, but who-talks-to-whom is still visible to the server unless sealed sender is layered on.",
          "Names the primary-device-relay solution for new-device history sync without being asked, and explains why the server structurally cannot help.",
          "Walks through prekey exhaustion, skipped-key-cache DoS risk, and Sender Key rotation-on-leave as a connected set of failure modes, not isolated trivia.",
          "Explains why cross-user media deduplication is impossible under this design and frames it as a deliberate privacy tradeoff, not a limitation to fix.",
          "Pushes back on requirements that quietly break the threat model (e.g. 'can we add server-side spam scanning?') and proposes the client-side alternative.",
          "Closes with a one-sentence summary and an explicit list of what more time would cover (sealed sender, key-compromise recovery, abuse reporting).",
          "Paces the 40 minutes deliberately, parking tangents and returning to them only if time remains.",
        ],
        gaps: [],
      },
    ],
    redFlags: [
      "Proposing server-side message search, content-based spam scanning, or rich push previews without noticing they all require server-side plaintext.",
      "Treating groups as 'send to every member' without quantifying the members × devices pairwise cost, or naming Sender Keys with no rotation-on-leave story.",
      "Modeling multi-device as one shared account key instead of one identity key per device.",
      "Putting message content, or even a plaintext-derived hash, in a push notification payload — that leaks content to Apple/Google.",
      "No distinction between forward secrecy and post-compromise security — treating the Double Ratchet as one undifferentiated 'magic encryption' step.",
      "Assuming the server can backfill message history to a newly linked device, when the server never held plaintext to backfill.",
      "An unbounded skipped-message-key cache, which is a memory-exhaustion DoS vector via forged sequence gaps.",
    ],
    followUps: [
      {
        q: "Why can't the server just do full-text search on an encrypted index?",
        a: "Because any index the server can query without your key either leaks information about content (frequency analysis, searchable-encryption schemes are still an active, leaky research area at this scale) or requires the server to hold a key, which breaks the E2EE guarantee outright. The practical answer used in production systems is client-side search: each device maintains its own local plaintext index built as messages are decrypted, and search never leaves the device.",
      },
      {
        q: "What happens if a user loses every device at once?",
        a: "Message history is gone — there is no server-side plaintext to recover, by design. What can survive is whatever the backup strategy explicitly opts into: an encrypted local backup (e.g. to iCloud/Google Drive) protected by a user-held passphrase the server never sees, or nothing at all if the product chooses maximum security over recoverability. This is a genuine product tradeoff to surface, not a bug to silently work around.",
      },
      {
        q: "How does sealed sender actually hide the sender from the server?",
        a: "The sender includes a certificate, issued periodically by the server itself, that proves 'this is a valid registered user' without embedding who. The message envelope delivered to the server is encrypted such that the server can route it to the right recipient mailbox without decrypting who sent it — only the recipient's device, using its session state, can determine the sender's identity after decrypting. The server still learns the recipient and rough timing/size, so it's a metadata reduction, not full anonymity.",
      },
      {
        q: "Why not just re-run X3DH for every message instead of ratcheting?",
        a: "X3DH is deliberately expensive relative to a ratchet step — it involves multiple DH computations and a round trip to fetch prekeys. Running it per message at 1M msgs/sec would be both a massive compute cost and would exhaust one-time prekeys almost immediately. The Double Ratchet reuses the X3DH-derived secret as a starting point and then evolves it cheaply (a hash-chain step per message, a DH step per direction flip), giving the same forward-secrecy property at a fraction of the cost.",
      },
      {
        q: "How do you handle a group with 10,000 members, beyond the stated 1,000 cap?",
        a: "At that size even Sender Keys' O(members) rotation cost on every leave becomes expensive, since large public/broadcast-style groups churn membership constantly. Products at this scale typically split the model: cap true E2EE groups at a size where rotation stays cheap (hundreds to low thousands), and offer large-scale 'channels' or 'broadcast' as a structurally different, lower-guarantee product (e.g. content signed but not encrypted per-member, or a server-mediated large-fanout mode) rather than stretching Sender Keys past where it's efficient.",
      },
      {
        q: "What's the actual risk if a device's one-time prekeys run out?",
        a: "The very next new-session handshake to that device falls back to using just the signed prekey (no one-time prekey), which is still cryptographically sound but loses one specific property: an attacker who later compromises the signed prekey and recorded that first exchange could, in a narrow replay scenario, learn something about that initial message that a one-time prekey would have prevented. It's a real but bounded degradation — the fix is simply making sure devices replenish their one-time prekey pool proactively (e.g. refill when the pool drops below a threshold) rather than reactively.",
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
          "This is a store-and-forward routing system wrapped around a hard constraint: the server can never hold a key that decrypts message content. Every structural choice — the schema, the push design, the group protocol, the media split — exists to keep that constraint true at 1M messages/sec while still delivering messages reliably to offline devices and 1,000-member groups.",
          "Anchor on the numbers: 200M DAU, 20B msgs/day (~1M/sec peak), groups up to 1,000 members, ~2 devices per user, p99 < 150ms delivery when both parties are online. The cryptography (X3DH, Double Ratchet, Sender Keys) is what makes 'the server never sees plaintext' compatible with that scale and reliability bar.",
        ],
      },
      {
        heading: "Starting a session: X3DH",
        body: [
          "You can't do a live handshake with an offline device, so every device pre-publishes a prekey bundle to the Key Server: a long-term identity key, a signed prekey rotated periodically and signed by the identity key, and a batch of one-time prekeys, each consumed exactly once. A sender fetches this bundle and performs several Diffie-Hellman computations combining their own keys with the recipient's to derive a shared secret asynchronously — no round trip to an online recipient required.",
          "The one-time prekey is what gives the very first message extra forward-secrecy margin; if the pool runs dry, the handshake degrades gracefully to signed-prekey-only rather than failing, so devices should replenish proactively rather than reactively.",
        ],
      },
      {
        heading: "Staying secure for months: the Double Ratchet",
        body: [
          "X3DH produces one shared secret; the Double Ratchet is what evolves it, message after message, for the life of the conversation. A symmetric-key ratchet derives a fresh, single-use message key from a one-way chain for every message — forward secrecy, since old keys are deleted immediately and a leak today can't expose yesterday. A DH ratchet layered on top mixes in a fresh Diffie-Hellman exchange whenever the conversation direction flips — post-compromise security, since even a compromised session heals on the next turn.",
          "Because messages can arrive out of order, the ratchet keeps a bounded cache of derived-but-unused 'skipped' message keys so a late-arriving message can still decrypt; the cap on that cache size matters, since an unbounded cache is a memory-exhaustion vector against a peer who forges large sequence-number gaps.",
        ],
      },
      {
        heading: "Groups without the O(members × devices) tax",
        body: [
          "Naively extending 1:1 encryption to groups means encrypting pairwise to every device of every member — at 1,000 members and ~2 devices each, 2,000 asymmetric encryptions per message, unworkable at scale. Sender Keys fix this: each member distributes a symmetric chain key once, pairwise, over their existing Double Ratchet sessions, and after that a message is a single O(1) symmetric encryption broadcast to everyone who already holds the key.",
          "The cost moves from every message to every membership change, which is the right place for it — but it's not free: when a member leaves, everyone else must rotate to a fresh sender key immediately, or the removed member can keep decrypting messages sent with the old one. Naming this rotation requirement unprompted is a strong senior/staff signal.",
        ],
      },
      {
        heading: "Multi-device and the new-device-linking problem",
        body: [
          "Every device — not every person — is a distinct identity with its own keys and its own ratchet state per peer. A message to 'a person' actually fans out per device, including the sender's own other devices, which is easy to forget and produces the visible bug of 'messages I sent don't show up on my laptop' when missed.",
          "This makes linking a new device the hardest UX problem in the system: the server never held plaintext, so it structurally cannot backfill history. The working pattern is a primary-device relay — the new device authenticates via an out-of-band linking secret (typically a scanned QR code), and the primary device re-encrypts and forwards a bounded window of recent history directly to it, with the server never a participant in that transfer.",
        ],
      },
      {
        heading: "Delivery, push, and media — keeping the server blind end to end",
        body: [
          "On the write path the server does only routing and storage: a presence registry maps device to gateway shard for live delivery, and a durable, TTL'd per-device mailbox holds ciphertext for offline devices. Push notifications are strictly a content-free wake-up signal — never the message itself — because the push provider (APNs/FCM) is a third party outside the trust boundary; the real ciphertext is always pulled over the client's own authenticated connection after waking.",
          "Media follows the same blindness principle at a different layer: the client generates a random per-file AES key, encrypts the attachment locally, uploads the opaque ciphertext to ordinary object storage, and ships only the key inside the small E2EE text message. The storage layer serves bytes it can't open, which also means no server-side thumbnailing, transcoding, or cross-user deduplication — a deliberate privacy cost, not an oversight, of never letting the server compute anything on plaintext.",
        ],
      },
    ],
  },
};
