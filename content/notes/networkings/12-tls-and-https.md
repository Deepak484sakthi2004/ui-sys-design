# Chapter 12 — TLS and HTTPS

> *The `s` in `https` is a whole protocol, and it's the one most engineers wave their hands at. They know it means "encrypted" and "secure" and that a padlock appears, and they stop there. But that padlock is the visible tip of one of the most consequential pieces of engineering on the internet: a system that lets two parties who have never met, communicating over a wire controlled by adversaries (Chapter 3's ARP spoofers, Chapter 5's BGP hijackers, every café Wi-Fi), establish a private, authenticated, tamper-proof channel — in one round trip. This chapter removes the hand-waving.*

Everything we've built so far is, by default, *naked*. The HTTP request of Chapter 11 travels as plaintext that any router, any Wi-Fi eavesdropper, any compromised middlebox along the path (Chapter 5) can read and modify. Your password, your bank balance, your messages — all of it, readable by anyone on the wire, in a world where the wire is demonstrably untrustworthy (ARP spoofing on the LAN, BGP hijacks across the internet, malicious hotspots). **TLS (Transport Layer Security)** is the layer that fixes this, and HTTPS is just "HTTP over TLS." TLS provides three guarantees, and you must be able to name and distinguish them because they're separate problems:

1. **Confidentiality (encryption):** no one on the path can *read* your data.
2. **Integrity (tamper detection):** no one on the path can *modify* your data without being detected.
3. **Authentication:** you're actually talking to the server you think you are — *not* an impostor who hijacked the route or poisoned your DNS.

The third is the subtle and underappreciated one. Encryption alone is useless if you've encrypted a channel to an attacker — you'd have a perfectly private conversation with the wrong party. **Authentication is what makes encryption meaningful**, and it's the harder problem, solved by the certificate and PKI machinery that this chapter spends real time on (§12.4) because it's where the genuine difficulty and the best interview questions live.

We'll build the cryptographic primitives only as far as needed, walk the TLS 1.2 and (faster) TLS 1.3 handshakes byte by byte, dig deep into PKI (certificates, chains, the root store — how your browser decides to trust a stranger), cover SNI/0-RTT/resumption, and dissect a real handshake with `openssl`.

---

## 12.1 The Cryptographic Primitives (Just Enough)

TLS combines four cryptographic tools. You don't need to implement them, but you must know *what each does and why TLS needs all four* — because the handshake is a carefully choreographed dance of these primitives, and the choreography only makes sense if you know the pieces.

**1. Symmetric encryption (the workhorse).** A single shared secret key both encrypts and decrypts. Fast (hardware-accelerated — AES-NI instructions on every modern CPU), used for the *actual data* once the connection is established. Examples: **AES-GCM**, **ChaCha20-Poly1305**. The catch that drives the whole handshake: *both sides need the same secret key, but they've never met* — so how do they agree on a shared key over a wire an eavesdropper is watching? That's the key-exchange problem, and solving it is what the handshake is *for*.

**2. Asymmetric (public-key) cryptography (the introducer).** A *key pair*: a public key (shareable with everyone) and a private key (kept secret). Data encrypted with one can only be decrypted with the other. Slow (orders of magnitude slower than symmetric), so it's *not* used for bulk data — it's used during the handshake to bootstrap. Two uses: encryption (encrypt to someone's public key; only their private key decrypts) and, crucially, **signatures** (sign with your private key; anyone can verify with your public key — proving the data came from the private-key holder). Examples: **RSA**, **ECDSA** (elliptic curve). The asymmetric keys are how TLS solves "we've never met": the server's public key, vouched for by a certificate, lets the client safely establish a shared secret.

**3. Key exchange — specifically Diffie-Hellman (the magic trick).** This is the beautiful part. **Diffie-Hellman (DH)**, and its modern elliptic-curve form **ECDHE**, lets two parties who have *never met* derive a *shared secret* over a *public channel* that an eavesdropper watching every byte *cannot* compute. They exchange public values, each combines their own private value with the other's public value, and — by the math — both arrive at the same secret, while the eavesdropper, lacking either private value, cannot. It's genuinely astonishing the first time you see it: a shared secret born in public.

```
   Diffie-Hellman, the intuition (the "mixing paint" analogy):

   Alice and Bob agree publicly on a common base color (yellow). Eavesdropper sees it.
   Alice picks a SECRET color (red), mixes → orange. Sends orange publicly.
   Bob picks a SECRET color (blue), mixes → green. Sends green publicly.
   Eavesdropper now sees: yellow, orange, green.

   Alice takes Bob's green + her secret red → brown.
   Bob takes Alice's orange + his secret blue → brown.   ← SAME brown! the shared secret
   Eavesdropper has yellow/orange/green but CANNOT make brown — separating mixed paint
   (or, mathematically, the discrete-log problem) is infeasible.
```

The **E** in ECDH**E** stands for **Ephemeral** — a *fresh* DH key pair is generated for *every* connection and thrown away after. This gives **forward secrecy**: even if the server's long-term private key is stolen *later*, past recorded sessions stay safe, because each used a unique ephemeral secret that no longer exists. Forward secrecy is why ECDHE is mandatory in TLS 1.3 — it makes "record everything now, decrypt later when you steal the key" attacks impossible.

**4. Cryptographic hashing & MACs (the integrity check).** A hash (SHA-256) produces a fixed fingerprint of data; any change to the data changes the fingerprint. A **MAC** (Message Authentication Code) combines a hash with the shared key so the receiver can verify both *integrity* (unmodified) and *authenticity* (from someone holding the key). Modern TLS uses **AEAD** ciphers (AES-GCM, ChaCha20-Poly1305) that encrypt *and* authenticate in one operation — "Authenticated Encryption with Associated Data" — so confidentiality and integrity come together, closing whole classes of attacks that arose when they were bolted together wrong (the old MAC-then-encrypt vs. encrypt-then-MAC bugs).

> **The grand strategy, before the details:** TLS uses *slow asymmetric crypto briefly, during the handshake, to authenticate the server and establish a shared secret* (via ECDHE), then switches to *fast symmetric crypto (AEAD) for all the actual data*. Asymmetric solves "we've never met and the wire is hostile"; symmetric solves "now encrypt gigabytes fast." The handshake is the bridge between them: a few expensive operations to bootstrap a cheap, secure channel. Every TLS handshake is this same arc — authenticate, agree on a secret, then talk fast and cheap.

---

## 12.2 The TLS 1.2 Handshake (and Why It Costs 2 RTT)

Let's walk the classic **TLS 1.2** handshake. It's worth doing even though 1.3 superseded it, because (a) 1.2 is still widely deployed, and (b) seeing 1.2's *costs* makes 1.3's improvements legible. The handshake happens *after* the TCP three-way handshake (Chapter 7) — TLS rides on top of TCP — so there's already 1 RTT spent before TLS even starts.

```
   TLS 1.2 handshake (over an already-established TCP connection):

   CLIENT                                                        SERVER
   ──────                                                        ──────
   ── ClientHello ──────────────────────────────────────────►
      "Here are the TLS versions and cipher suites I support,
       and a random number (ClientRandom)."
                                          ◄──── ServerHello ──────────────
                                               "I pick this version + cipher suite,
                                                here's my random (ServerRandom)."
                                          ◄──── Certificate ───────────────
                                               "Here's my certificate (my public key,
                                                signed by a CA — proof of who I am)."
                                          ◄──── ServerKeyExchange ─────────
                                               "Here's my ephemeral DH public value,
                                                SIGNED with my cert's private key."
                                          ◄──── ServerHelloDone ───────────
            ┌── (client verifies the certificate against its root store — §12.4) ──┐
   ── ClientKeyExchange ──────────────────────────────────────►
      "Here's MY ephemeral DH public value."
      → both sides now compute the SAME shared secret (DH) → derive symmetric keys
   ── ChangeCipherSpec ───────────────────────────────────────►
      "Everything after this is encrypted with our new symmetric keys."
   ── Finished (encrypted) ───────────────────────────────────►
                                          ◄──── ChangeCipherSpec ──────────
                                          ◄──── Finished (encrypted) ──────
   ══════════════════ now: encrypted application data (HTTP) ══════════════════

   COST: 2 round trips for the TLS handshake — ON TOP of the 1 RTT TCP handshake.
   So HTTPS over TLS 1.2 = 3 RTTs before the first byte of your HTTP request.
```

The choreography, mapped to the primitives:
1. **ClientHello / ServerHello** negotiate the version and **cipher suite** (which combination of key-exchange + signature + symmetric cipher + hash to use, e.g. `ECDHE-RSA-AES128-GCM-SHA256`), and exchange random nonces (mixed into the key derivation so each session is unique).
2. **Certificate** delivers the server's public key *vouched for by a Certificate Authority* — this is the authentication step (§12.4).
3. **Key exchange** (ServerKeyExchange + ClientKeyExchange) performs ECDHE — both sides exchange ephemeral DH public values and independently compute the shared secret. The server *signs* its DH value with the certificate's private key, proving it's the legitimate cert holder (tying the key exchange to the authenticated identity — without this, an attacker could substitute their own DH value).
4. **ChangeCipherSpec / Finished** switch to the derived symmetric keys and verify the whole handshake wasn't tampered with (the Finished message is a MAC over the entire handshake transcript — if a man-in-the-middle altered any earlier message, the Finished check fails).

The expensive truth: **TLS 1.2 costs 2 RTTs**, and that's *on top of* TCP's 1 RTT, so a fresh HTTPS connection spends **3 round trips** before the first HTTP byte flows. On a 100ms-RTT transcontinental link, that's 300ms of pure handshake latency — visible, painful, and the direct motivation for TLS 1.3.

---

## 12.3 TLS 1.3: One Round Trip (and Zero)

**TLS 1.3** (2018, RFC 8446) is a major redesign whose headline achievement is cutting the handshake to **1 RTT** — and, for resumed connections, **0 RTT**. It did this by being aggressive about both *latency* and *security*, and the two goals reinforced each other.

The key insight: in TLS 1.2, the client had to wait for the server to choose the cipher and send its DH parameters before the client could send its own. TLS 1.3 collapses this by having the client **guess** — it sends its ECDHE public value *in the very first ClientHello*, optimistically assuming a supported key-exchange group. The server, in its first response, can complete the key exchange immediately:

```
   TLS 1.3 handshake — 1 RTT:

   CLIENT                                                        SERVER
   ──────                                                        ──────
   ── ClientHello ──────────────────────────────────────────►
      "Versions, cipher suites, AND my ECDHE public value
       (I'm guessing you support this group)."
                                          ◄── ServerHello ─────────────────
                                              "Picked cipher + here's MY ECDHE value"
                                          ◄── {Certificate, CertVerify, Finished} ──
                                              ↑ ALL of this already ENCRYPTED, because
                                                both sides can derive keys after the
                                                first exchange of ECDHE values.
   ── {Finished} ─────────────────────────────────────────────►
   ══════ encrypted application data ══════  (client can send data WITH its Finished!)

   COST: 1 RTT for TLS (plus TCP's 1 RTT = 2 RTT total for a fresh HTTPS connection).
   Cut a full round trip versus 1.2. And the server's certificate is now ENCRYPTED.
```

What 1.3 changed and why each matters:
- **1-RTT handshake** (client sends ECDHE value upfront → server completes key exchange in its first reply). One round trip saved on *every* fresh HTTPS connection — a large latency win at scale.
- **Encrypted handshake** — the certificate and the rest of the handshake are encrypted (1.2 sent the certificate in cleartext), improving privacy (an eavesdropper can't even see which cert/site you're connecting to, modulo SNI — §12.5).
- **Forward secrecy mandatory** — only ECDHE is allowed; the old RSA key-exchange (where the client encrypted the secret to the server's static public key — *no* forward secrecy) is *gone*. Every 1.3 session has forward secrecy, full stop.
- **Pruned the cruft** — 1.3 removed dozens of weak/obsolete ciphers and options (RSA key exchange, RC4, SHA-1, compression, renegotiation — each a source of past vulnerabilities like BEAST, CRIME, POODLE). The cipher-suite list shrank to a handful of vetted AEAD options. Less attack surface, fewer footguns.

**0-RTT resumption — and its sharp edge.** TLS 1.3 also offers **0-RTT**: if you've connected to a server *before*, it gave you a pre-shared key (a session ticket), and on the *next* connection you can send application data *in the very first packet*, alongside the ClientHello — **zero round trips of handshake before your data**. For repeat visits this is a massive latency win (combined with TCP Fast Open or over QUIC, you approach *instant* connections). But 0-RTT has a genuine, must-know **caveat: replay attacks.** Because the 0-RTT data is sent before the handshake completes, an attacker who captures it can *replay* it to the server, and the server might process it twice. So **0-RTT data must be restricted to idempotent operations** (recall Chapter 11 — safe/idempotent methods like GET) — *never* a non-idempotent action like "transfer $100" (which a replay would execute twice). This is the same idempotency principle from Chapter 11, now load-bearing for security: 0-RTT is safe only for requests where replaying them is harmless. The latency win comes with a correctness constraint, and conflating them is a real vulnerability.

> **The latency arc across this book:** TCP handshake = 1 RTT (Ch. 7). TLS 1.2 = +2 RTT. TLS 1.3 = +1 RTT, or +0 on resumption. QUIC (Ch. 14) folds the TCP *and* TLS handshakes into *one*, hitting 1-RTT-or-0-RTT for the *combined* transport+crypto setup. Every step in this progression is a battle against the round-trip latency floor set by the speed of light (Chapter 1) — because round trips are the dominant cost of connection setup, and shaving them is the highest-leverage latency optimization in networked systems. TLS 1.3's 1-RTT and QUIC's 0-RTT are two of the most impactful performance changes the internet has made in a decade, and they're both fundamentally about *not waiting for round trips*.

---

## 12.4 PKI: How You Trust a Stranger

Now the hard problem, the one encryption alone doesn't solve and the one that generates the best interview questions. ECDHE lets you establish a shared secret with *someone* — but how do you know that someone is *actually `bank.com`* and not an attacker who hijacked your route (Chapter 5) or poisoned your DNS (Chapter 9) and is happily doing ECDHE with you while pretending to be your bank? Encryption without authentication is a private conversation with an impostor. **PKI (Public Key Infrastructure)** is the answer: the system by which your browser decides to trust a server it has never seen before.

The chain of trust works like this:

```
   The certificate chain — trust delegated downward from a root you already trust:

   ┌─────────────────────────────────────────────────────────────────────┐
   │ ROOT CA (e.g. "ISRG Root X1" for Let's Encrypt)                       │
   │   • Its public key is PRE-INSTALLED in your OS/browser "root store"   │
   │   • You trust it AXIOMATICALLY — it's shipped with your device.        │
   │   • Self-signed. The anchor of trust.                                 │
   └───────────────────────────────┬─────────────────────────────────────┘
                                    │ signs (vouches for)
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ INTERMEDIATE CA (e.g. "Let's Encrypt R3")                            │
   │   • Signed by the root. Roots stay offline/safe; intermediates do    │
   │     the day-to-day issuing (so a compromise is recoverable).          │
   └───────────────────────────────┬─────────────────────────────────────┘
                                    │ signs
                                    ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ LEAF CERTIFICATE (for "example.com")                                 │
   │   • Contains example.com's PUBLIC KEY and domain name.               │
   │   • Signed by the intermediate.                                       │
   └─────────────────────────────────────────────────────────────────────┘

   Verification (client side): example.com's cert is signed by R3, R3 is signed by
   ISRG Root X1, and ISRG Root X1 is IN MY ROOT STORE. Chain verified → I trust this
   public key really belongs to example.com.
```

A **certificate** is a document binding a *public key* to an *identity* (a domain name), signed by a **Certificate Authority (CA)** whose job is to verify that identity before signing. The trust is *delegated*: your browser ships with a **root store** — a few hundred CA public keys it trusts axiomatically (curated by OS/browser vendors). Any certificate that chains up to a root in that store is trusted; anything that doesn't (self-signed, expired, wrong domain, untrusted CA) triggers the scary browser warning.

The verification the client performs on every TLS connection:
1. The server presents its leaf certificate (and usually the intermediate).
2. The client checks the **signature chain**: leaf signed by intermediate, intermediate signed by a root, root in the trust store. Each signature verified with the signer's public key (asymmetric crypto, §12.1).
3. The client checks the **domain matches**: the certificate's Subject Alternative Name (SAN) must include the hostname the client connected to (`example.com`). A valid cert for `evil.com` doesn't authenticate `bank.com`.
4. The client checks **validity** (not expired, not yet valid) and **revocation** (not revoked — §below).
5. The server proves it holds the *private key* matching the cert's public key (it signs the handshake with it — the CertificateVerify message). A stolen certificate is useless without the matching private key.

Only if *all* of these pass does the connection proceed. This is what the padlock means: a certificate chain verified to a trusted root, the domain matched, and the server proved possession of the private key.

**How PKI goes wrong** (the failure modes worth knowing):
- **Expired certificates** — the #1 cause of outages-by-self-inflicted-wound. Certs have validity periods (now typically 90 days, trending shorter); forget to renew and *your own site* throws security errors for everyone. Automated renewal (ACME / Let's Encrypt / cert-manager) exists precisely because humans forget.
- **CA compromise / mis-issuance** — if a CA is tricked or hacked into issuing a cert for a domain to the wrong party (DigiNotar in 2011, which led to its destruction; numerous mis-issuance incidents since), an attacker gets a *valid* cert for your domain and can impersonate you. The whole system's security rests on every trusted CA behaving correctly — a sprawling trust surface. Mitigations: **Certificate Transparency** (all issued certs are logged publicly, so you can *detect* a rogue cert for your domain — now mandatory), **CAA records** (Chapter 9 — DNS records specifying *which* CAs may issue for your domain, limiting the blast radius), and certificate pinning (apps hardcode the expected cert/key, though it's fragile).
- **Revocation is hard** — if a private key is stolen, you want to *revoke* the cert before its expiry. But revocation checking (CRLs, OCSP) is slow, often soft-fails (browsers proceed if the check times out, to avoid breaking everything — which defeats the purpose), and leaks browsing data (OCSP tells the CA which sites you visit). The industry's pragmatic answer has been *short-lived certs* (90 days, soon shorter) — if certs expire fast, revocation matters less. Revocation remains one of PKI's genuinely unsolved-elegantly problems.

> **The deep point:** authentication, not encryption, is the hard part of TLS, and PKI is a vast, imperfect, human-and-organization-laden system for solving "trust a stranger." The cryptography (ECDHE, AES) is mathematically sound and rarely the weak link. The *trust* — which CAs to trust, whether they behave, whether revocation works, whether you remembered to renew — is messy, social, and where real-world TLS failures cluster. When TLS breaks in production, it's almost never the crypto; it's an expired cert, a missing intermediate in the chain, a hostname mismatch, or a clock skew. Knowing PKI's structure is knowing where TLS actually fails.

---

## 12.5 SNI, ECH, and Resumption

A few important pieces that complete the picture:

**SNI (Server Name Indication).** Recall virtual hosting from Chapter 11 — one server/IP hosting many sites. With HTTP, the `Host` header says which site you want. But TLS happens *before* HTTP, so the server needs to know *which site's certificate to present* during the handshake, before any HTTP. **SNI** is a TLS extension in the ClientHello that says "I'm connecting to `example.com`" — letting the server pick the right certificate. It's what makes HTTPS virtual hosting (and shared hosting, and CDNs serving thousands of sites per IP) possible. The catch: **SNI is sent in cleartext** (even in TLS 1.3, where the rest of the handshake is encrypted) — so an eavesdropper, while unable to read your traffic, *can* see *which site* you're connecting to. Your DNS lookup (Chapter 9) and SNI together leak your browsing destinations even over HTTPS.

**ECH (Encrypted Client Hello).** The fix for SNI's leak, and a frontier topic. **ECH** encrypts the SNI (and the whole ClientHello) using a public key the client gets via DNS (an HTTPS/SVCB DNS record), so the destination hostname is no longer visible on the wire. Combined with encrypted DNS (DoH, Chapter 9), ECH closes the last major metadata leak — an observer sees an encrypted connection to a *shared frontend* (e.g. a CDN's IP) but not which of the thousands of sites behind it you wanted. It's deploying now (Cloudflare, Chrome) and is contentious for the same reason DoH is: it defeats network-level filtering and visibility.

**Session resumption.** Full handshakes are expensive (asymmetric crypto + round trips). **Resumption** lets a client reconnect to a server it's talked to before *without* the full handshake. In TLS 1.3 the server hands the client a **session ticket** (an opaque, server-encrypted blob containing the session state, or a pre-shared key reference); on reconnect, the client presents the ticket and both resume with the previously-established secret — a cheaper 1-RTT (or 0-RTT) handshake instead of the full one. This is what makes browsing a site you've visited feel instant on the TLS layer, and it's the basis of the 0-RTT mode (§12.3). The session ticket is, again, the "encode state in something you hand the client to give back" pattern (TCP SYN cookies in Ch. 7, JWTs in Ch. 11) — the server stays stateless by stuffing the session into an encrypted ticket only it can read.

---

## 12.6 Code: Dissecting a Real Handshake with OpenSSL

Implementing TLS from scratch is thousands of lines of subtle cryptographic code (and writing your own is famously dangerous — "don't roll your own crypto"). The instructive thing is to *observe* a real handshake, which `openssl s_client` lets us do — it connects and dumps every detail of the negotiation. This is the practical skill: reading a TLS connection's actual parameters, which you'll do constantly when debugging certificate and protocol issues.

```bash
# Connect to a real server and watch the full TLS handshake + certificate chain:
openssl s_client -connect example.com:443 -servername example.com
```

What it reveals, annotated against this chapter:

```
   CONNECTED(00000003)
   ---
   Certificate chain                          ← the chain from §12.4, bottom-up:
    0 s:CN=example.com                          ← LEAF (the site's cert)
      i:C=US, O=DigiCert Inc, CN=DigiCert ...   ← issued by an intermediate
    1 s:C=US, O=DigiCert Inc, CN=DigiCert ...   ← INTERMEDIATE
      i:C=US, O=DigiCert Inc, CN=DigiCert ...   ← issued by the root
   ---
   SSL handshake has read 4096 bytes and written 394 bytes
   ---
   New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384   ← negotiated: TLS 1.3, AEAD cipher (§12.1)
   Server public key is 2048 bit
   Secure Renegotiation IS NOT supported            ← (1.3 removed renegotiation, §12.3)
   ---
   SSL-Session:
       Protocol  : TLSv1.3                          ← version negotiated
       Cipher    : TLS_AES_256_GCM_SHA384
       Session-ID: ...                              ← for resumption (§12.5)
       ...
```

A few more practical incantations that turn this chapter into a working toolkit:

```bash
# Check a certificate's expiry and the domains it covers (the #1 TLS outage cause, §12.4):
echo | openssl s_client -connect example.com:443 2>/dev/null | \
  openssl x509 -noout -dates -subject -ext subjectAltName

# Force a TLS version to test what a server supports:
openssl s_client -connect example.com:443 -tls1_2     # force TLS 1.2
openssl s_client -connect example.com:443 -tls1_3     # force TLS 1.3

# See the full certificate, decoded:
openssl s_client -connect example.com:443 2>/dev/null | openssl x509 -noout -text
```

Every concept from this chapter is visible here: the **certificate chain** (leaf → intermediate → root, §12.4), the negotiated **TLS version and cipher suite** (the AEAD cipher of §12.1, the version of §12.2–12.3), the **public key**, the **SNI** (`-servername`, §12.5), and the **session ID** for resumption (§12.5). When you debug a real TLS problem — "why is the handshake failing," "is this cert expired," "why is it falling back to TLS 1.2," "is the intermediate cert missing from the chain" — `openssl s_client` is the tool, and now you can read every line it prints. The `x509 -dates` check in particular is the one-liner that catches the expired-cert outage before your users do.

> **Why we don't implement TLS from scratch (a real lesson):** unlike the parsers and servers in earlier chapters, *you should not write your own TLS.* Cryptographic code is uniquely unforgiving — a subtle bug (a timing side channel, a misused nonce, a missing validation) doesn't cause a visible crash; it silently destroys the security while everything *appears* to work. The history of TLS is littered with catastrophic implementation bugs (Heartbleed — a buffer over-read in OpenSSL that leaked private keys; Apple's "goto fail" — a single misplaced line that skipped certificate verification entirely). The right move is *always* to use a vetted, audited library (OpenSSL, BoringSSL, rustls) and understand it deeply enough to use it correctly and debug it — which is exactly what reading the handshake with `s_client` builds. Understanding TLS thoroughly and *implementing* it are different skills; this chapter is the former, deliberately.

---

## Key Takeaways

1. **TLS provides three distinct guarantees: confidentiality (encryption — no one reads your data), integrity (no one modifies it undetected), and authentication (you're talking to the real server, not an impostor).** Authentication is the hard, underappreciated one — encryption to an impostor is a private chat with the wrong party. Authentication is what makes encryption meaningful, and it's solved by PKI.

2. **TLS combines four primitives in a deliberate arc:** slow *asymmetric* crypto + *ECDHE key exchange* during the handshake to authenticate the server and derive a shared secret over a hostile wire (Diffie-Hellman creates a shared secret in public that an eavesdropper can't compute), then fast *symmetric AEAD* (AES-GCM/ChaCha20) for all the actual data. **Ephemeral** ECDHE gives *forward secrecy* — stealing the server's key later can't decrypt past sessions.

3. **TLS 1.2 costs 2 RTTs on top of TCP's 1 RTT = 3 round trips before the first HTTP byte.** The handshake negotiates a cipher suite, delivers the CA-signed certificate (authentication), performs ECDHE (signed by the cert to bind key exchange to identity), and verifies the transcript (Finished).

4. **TLS 1.3 cuts the handshake to 1 RTT** (the client sends its ECDHE value in the first ClientHello, so the server completes key exchange immediately), encrypts the handshake (including the certificate), makes forward secrecy mandatory, and prunes decades of weak cruft. **0-RTT resumption** sends data in the first packet for repeat connections — but its data must be *idempotent* (Chapter 11!) because it's replayable. This latency arc (TCP → TLS 1.2 → TLS 1.3 → QUIC's 0-RTT) is a sustained war on the speed-of-light round-trip floor.

5. **PKI is how you trust a stranger:** a certificate binds a public key to a domain, signed by a CA; trust delegates down a chain (leaf → intermediate → root) to a root in your device's pre-installed trust store. The client verifies the signature chain, the domain match (SAN), validity, revocation, and that the server holds the private key. That's what the padlock means.

6. **TLS fails in production almost never at the crypto, almost always at the trust:** expired certificates (the #1 self-inflicted outage — hence automated ACME renewal), CA mis-issuance/compromise (mitigated by Certificate Transparency logs and CAA records), missing intermediate certs in the chain, hostname mismatches, and clock skew. Revocation (CRL/OCSP) is genuinely hard, which is why the industry moved to short-lived certs.

7. **SNI tells the server which site's cert to present (enabling HTTPS virtual hosting/CDNs) but is sent in cleartext — leaking your destination even over HTTPS.** ECH encrypts it (closing the last metadata leak, with DoH). Session resumption (tickets) avoids full handshakes — the same "stateless server hands the client an encrypted blob to give back" pattern as SYN cookies and JWTs.

8. **Never implement your own TLS** — crypto bugs silently destroy security while everything appears to work (Heartbleed, Apple's "goto fail"). Use a vetted library; understand it deeply enough to use and debug it correctly. `openssl s_client` lets you read any real handshake — the chain, version, cipher, and the `x509 -dates` expiry check that catches outages before users do.

---

## Interview Drills

**Q1. TLS gives you encryption. Why isn't encryption alone enough — what else does TLS need and why?**
*Model answer:* Encryption alone protects confidentiality, but it's useless if you've established an encrypted channel to the *wrong party*. If an attacker hijacks your route (BGP) or poisons your DNS and you do a key exchange with *them*, you'll have a perfectly private, perfectly encrypted conversation — with the impostor, who relays it to the real server (or just steals your data). So TLS also needs *authentication*: cryptographic proof that the server you're talking to is genuinely the domain you intended. That's the hard part, and it's solved by PKI — the server presents a certificate binding its public key to its domain name, signed by a Certificate Authority whose root is pre-trusted in your device's trust store; the client verifies the signature chain up to a trusted root, checks the domain matches, and confirms the server holds the matching private key. TLS also provides integrity (tamper detection, via AEAD/MACs), so the channel is private, authenticated, *and* unmodifiable. The order of importance is counterintuitive: the crypto for confidentiality is the easy, solved part; authentication — knowing *who* you're encrypting to — is where the real difficulty and most real-world failures live.

**Q2. How do two parties who have never met agree on a shared secret key over a wire an eavesdropper is watching?**
*Model answer:* Diffie-Hellman key exchange (in TLS, the elliptic-curve ephemeral form, ECDHE). The two parties publicly agree on common parameters, then each generates a *private* secret value and derives a *public* value from it, which they exchange over the open wire. Each then combines their own private value with the other's public value, and by the mathematics both arrive at the *same* shared secret — while an eavesdropper, who sees only the two public values and the common parameters, cannot compute it, because deriving the secret from the public values requires solving the discrete-logarithm problem, which is computationally infeasible. The paint-mixing analogy: both mix a shared base color with their own secret color and exchange the mixtures; each adds their secret to the other's mixture to reach the same final color, but the eavesdropper can't "unmix" to find the secrets. The "ephemeral" part — a fresh key pair per connection, discarded after — gives forward secrecy: even if the server's long-term private key is stolen later, past sessions can't be decrypted because their ephemeral secrets no longer exist. This is why ECDHE is mandatory in TLS 1.3.

**Q3. Why is TLS 1.3 faster than 1.2, and how does it achieve 0-RTT — with what caveat?**
*Model answer:* TLS 1.2 takes 2 round trips because the client must wait for the server to choose the cipher and send its key-exchange parameters before the client sends its own. TLS 1.3 cuts this to 1 RTT by having the client *guess*: it sends its ECDHE public value right in the first ClientHello, optimistically assuming a supported group, so the server can complete the key exchange and send its certificate (now encrypted) in its very first response, and the client can send application data with its Finished. That saves a full round trip on every fresh HTTPS connection. 1.3 also achieves 0-RTT on *resumed* connections: a returning client that holds a session ticket/pre-shared key from a prior visit can send application data in the *first* packet alongside the ClientHello — zero handshake round trips before data. The caveat is replay: because 0-RTT data is sent before the handshake completes and confirms freshness, an attacker who captures it can replay it, and the server may process it twice. So 0-RTT data must be restricted to idempotent operations (like GET) where replay is harmless — never something like a payment or order creation. It's the Chapter 11 idempotency principle becoming a security requirement: the latency win is real but comes with a correctness constraint.

**Q4. Walk me through how your browser decides to trust `https://bank.com`.**
*Model answer:* Through the PKI certificate chain. During the TLS handshake, bank.com presents its certificate — which binds bank.com's public key to its domain name and is signed by a Certificate Authority — usually along with one or more intermediate certificates. The browser verifies a chain of trust: bank.com's leaf cert is signed by an intermediate CA, the intermediate is signed by a root CA, and that root CA's public key is in the browser/OS's pre-installed *root store*, which it trusts axiomatically. It validates each signature in the chain using the signer's public key. Then it performs additional checks: the certificate's Subject Alternative Name must include the exact hostname the browser connected to (a valid cert for another domain doesn't count), the cert must be currently valid (not expired, not future-dated), it shouldn't be revoked, and — critically — the server must prove it possesses the *private key* matching the cert's public key (it signs part of the handshake with it), so a stolen certificate alone is useless. Only if every check passes does the browser show the padlock and proceed. If anything fails — untrusted CA, expired, wrong domain, broken chain (e.g. missing intermediate) — it shows a security warning. The trust is delegated and transitive: you trust the root, the root vouches for the intermediate, the intermediate vouches for bank.com.

**Q5. When TLS breaks in production, where do you look first, and why not at the cryptography?**
*Model answer:* I look at the *trust and certificate* layer, not the crypto, because the cryptography (ECDHE, AES-GCM) is mathematically sound and essentially never the weak link in a properly configured server using a vetted library. Real-world TLS failures cluster in PKI and configuration: an expired certificate (the single most common self-inflicted outage — someone forgot to renew, so your own site throws errors), a missing or wrong intermediate certificate so the chain doesn't reach a trusted root (works in some clients that cache the intermediate, fails in others — a classic "works on my machine"), a hostname mismatch (the cert's SAN doesn't cover the name being requested), clock skew (a wrong system clock makes a valid cert look expired or not-yet-valid), a protocol/cipher mismatch (server only offers TLS 1.0 that a modern client refuses), or revocation/OCSP issues. My toolkit is `openssl s_client -connect host:443` to dump the negotiated version, cipher, and full chain, and `openssl x509 -noout -dates -subject -ext subjectAltName` to check expiry and covered domains. The lesson is that TLS security rests on a sprawling human-and-organizational trust system — which CAs are trusted, whether certs are renewed, whether chains are complete — and that's where it breaks, not in the math.

**Q6. What is SNI, why does it exist, and what does it leak?**
*Model answer:* SNI (Server Name Indication) is a TLS extension in the ClientHello that tells the server which hostname the client is connecting to — for example "example.com." It exists because of virtual hosting: one server at one IP can host many HTTPS sites, but TLS happens *before* HTTP, so the server can't use the HTTP Host header to decide which site's certificate to present during the handshake. SNI solves that by carrying the intended hostname in the handshake itself, letting the server select the correct certificate. It's what makes HTTPS virtual hosting, shared hosting, and CDNs serving thousands of sites per IP possible. What it leaks: SNI is sent in *cleartext*, even in TLS 1.3 where the rest of the handshake (including the certificate) is encrypted. So an on-path eavesdropper, while unable to read your actual traffic, *can* see which site you're connecting to — combined with the (traditionally cleartext) DNS lookup, your browsing destinations are exposed even over HTTPS. The fix is ECH (Encrypted Client Hello), which encrypts the SNI using a public key fetched via DNS, so an observer sees only an encrypted connection to a shared frontend (like a CDN IP) and not which site behind it you wanted — closing the last major metadata leak when paired with encrypted DNS (DoH).

**Q7. What is forward secrecy and why does TLS 1.3 mandate it?**
*Model answer:* Forward secrecy means that compromising a server's long-term private key in the *future* does not allow decryption of *past* recorded sessions. It's achieved by using ephemeral key exchange — ECDHE — where each connection generates a fresh, throwaway Diffie-Hellman key pair, derives the session's shared secret from it, and then discards the ephemeral private values. So even if an attacker records all your encrypted traffic today and later steals the server's private key, they still can't decrypt those recordings, because the ephemeral secrets that actually protected each session no longer exist and were never derivable from the long-term key. This defeats the "harvest now, decrypt later" attack, where adversaries archive encrypted traffic hoping to break it later. TLS 1.2 *allowed* a non-forward-secret mode (RSA key exchange, where the client encrypted the pre-master secret directly to the server's static public key — so stealing that key later decrypts everything). TLS 1.3 removed that entirely and mandates ECDHE, so *every* 1.3 session has forward secrecy by construction. It's part of 1.3's theme of eliminating footguns: rather than leaving forward secrecy as an option people might misconfigure, it's made the only choice.

---

*Previous: [Chapter 11 — HTTP/1.0 and HTTP/1.1](./11-http-1.0-and-1.1.md) | Next: [Chapter 13 — HTTP/2](./13-http-2.md)*
