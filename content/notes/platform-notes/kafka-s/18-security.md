# Chapter 18 — Security
### TLS, SASL, ACLs, and the Threat Model You Probably Don't Have

---

Most production Kafka deployments I have seen treat security as an
afterthought. The cluster is built, the topics are created, the
producers and consumers are wired up, and then someone says "we
should probably enable TLS." The next six months are spent
retrofitting authentication, authorisation, encryption, and audit
into a system that was already in production. This is the most painful
way to do it, and the resulting setup is usually subtly broken.

The right time to think about Kafka security is when you draw the
architecture diagram. The right way to think about it is *threat-model
first, mechanism second*. What are you protecting against? Who can
read what? Who can write what? What happens if a producer's
credentials leak? What happens if a broker is compromised? Without
those answers, "enable TLS" is theatre.

This chapter:

- The threat model: what Kafka security can and cannot protect against.
- TLS: encryption in transit, mutual authentication, certificate
  management.
- SASL mechanisms: PLAIN, SCRAM, GSSAPI (Kerberos), OAUTHBEARER.
- ACLs: the authorisation model, common patterns, audit.
- Encryption at rest and the conversation about it.
- Multi-tenant Kafka: tenant isolation, quotas, namespacing.
- Operational realities: certificate rotation, secret management,
  audit logs.

---

## 18.1 What you're actually protecting

A naive threat model: "we don't want bad people reading our data".
A useful threat model is finer-grained:

| Threat | Who | What |
|--------|-----|------|
| Network eavesdropping | A passive attacker on the network path | Sees plaintext records on the wire |
| Network impersonation | An active attacker on the path | Pretends to be a broker, captures data |
| Producer impersonation | Someone with stolen producer credentials | Writes fake records |
| Consumer impersonation | Someone with stolen consumer credentials | Reads sensitive records |
| Insider threat | A legitimate user exceeding their authority | Reads or writes topics they shouldn't |
| Broker compromise | Attacker with shell on a broker | Reads everything; can corrupt data |
| Disk theft | Disk physically stolen from a broker | Reads everything stored locally |

Different mechanisms address different threats:

- **TLS** addresses eavesdropping and impersonation in transit.
- **SASL authentication** addresses identity (who is connecting).
- **ACLs** address authorisation (what can they do).
- **Encryption at rest** addresses disk theft.
- **Audit logs** address detection after the fact.
- **Network isolation** (VPCs, firewalls) addresses outsider threats
  generally.
- **Secret management** addresses credential theft from misconfigured
  configs.

A "secure" Kafka deployment uses several of these together. Picking
one and feeling done is the common failure mode.

---

## 18.2 TLS

### 18.2.1 What TLS gives you

TLS in Kafka:

- **Encryption in transit** — bytes on the wire are unintelligible to
  passive attackers.
- **Server authentication** — the client verifies the broker's
  identity via the broker's certificate (signed by a trusted CA).
- **Optional client authentication (mTLS)** — the broker verifies the
  client's identity via the client's certificate.

TLS does *not* give you:

- **Encryption at rest** — bytes on disk are still plaintext.
- **Authorization** — TLS only verifies identity, not permission.
- **Per-topic access control** — every TLS-authenticated client sees
  the same topic surface area unless ACLs say otherwise.

### 18.2.2 Configuration

Broker side:

```properties
listeners=SSL://:9093
security.inter.broker.protocol=SSL

ssl.keystore.location=/etc/kafka/keystore.jks
ssl.keystore.password=...
ssl.key.password=...
ssl.truststore.location=/etc/kafka/truststore.jks
ssl.truststore.password=...

# For mTLS:
ssl.client.auth=required          # or 'requested' (mTLS optional) or 'none'
```

Client side:

```properties
security.protocol=SSL
ssl.truststore.location=/etc/kafka/truststore.jks
ssl.truststore.password=...

# For mTLS:
ssl.keystore.location=/etc/kafka/client-keystore.jks
ssl.keystore.password=...
ssl.key.password=...
```

The keystores hold private keys + certificates; the truststores hold
the CA certificates that sign the server's certificate. Standard
Java TLS configuration.

### 18.2.3 Cipher suites and protocols

```properties
ssl.enabled.protocols=TLSv1.3,TLSv1.2
ssl.cipher.suites=TLS_AES_256_GCM_SHA384,TLS_AES_128_GCM_SHA256,...
```

In 2026, TLS 1.3 is widely supported. TLS 1.2 is the floor.
TLS 1.1 and 1.0 should be disabled. SSLv3 was buried years ago.

For ciphers, use modern AEAD suites (GCM or ChaCha20-Poly1305). Avoid
CBC modes, RC4, anything with "EXPORT" in the name.

### 18.2.4 Performance cost

As discussed in earlier chapters, TLS without kTLS costs 30-50% of
broker throughput because `sendfile` zero-copy is broken. The fix:

- Enable kTLS at the kernel level (Linux 4.13+).
- Use a JDK + provider combination that activates kTLS (typically
  modern JDK + OpenSSL provider).

Verify with `ss --tcp -i` showing kTLS use, or by measuring
throughput with vs without TLS.

If kTLS isn't available, budget 30-50% extra broker hardware to
absorb the cost.

### 18.2.5 Certificate management

Certificates expire. Some teams have learned this the hard way at
2 a.m. on a holiday weekend.

The discipline:

- **Track expiry.** Monitor every cert with at least 30 days warning.
- **Automate renewal.** Manual renewal is tomorrow's outage. Use
  cert-manager (Kubernetes) or Let's Encrypt or your CA's automation
  hook.
- **Use a meaningful CA hierarchy.** Issuing certificates from a
  single internal CA is reasonable; treating Let's Encrypt as your
  internal CA is convenient but couples you to public PKI uptime.
- **Plan for compromise.** If a private key leaks, you need to revoke
  the cert and re-key everything that trusted it. CRLs and OCSP help;
  short-lived certs help more.

The state of the art is **short-lived certificates** (24-hour validity)
with frequent automated rotation. SPIFFE/SPIRE-style infrastructure is
gaining ground.

---

## 18.3 SASL

SASL — Simple Authentication and Security Layer — is the pluggable
authentication framework Kafka uses. It's not transport security
(TLS does that); it's identity exchange.

### 18.3.1 SASL/PLAIN

Username and password sent as plaintext over the connection. **Only
safe over TLS** (otherwise the password is on the wire).

```properties
security.protocol=SASL_SSL
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required \
   username="alice" password="secret";
```

Use SASL/PLAIN for simplicity, only when password-equivalent
credentials are acceptable in your security model.

### 18.3.2 SASL/SCRAM

Salted Challenge-Response Authentication Mechanism. The password
never crosses the wire — instead, a challenge-response protocol
proves possession.

Two variants: SCRAM-SHA-256 and SCRAM-SHA-512.

```properties
security.protocol=SASL_SSL
sasl.mechanism=SCRAM-SHA-512
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \
   username="alice" password="secret";
```

SCRAM credentials are stored in ZooKeeper (legacy) or KRaft
metadata. Created with:

```bash
kafka-configs.sh --bootstrap-server broker:9092 \
    --alter --add-config 'SCRAM-SHA-512=[password=secret]' \
    --entity-type users --entity-name alice
```

SCRAM is strictly better than PLAIN. Use SCRAM if your environment
allows it.

### 18.3.3 SASL/GSSAPI (Kerberos)

Kerberos integration. Common in enterprise environments where Active
Directory is the identity source.

```properties
security.protocol=SASL_SSL
sasl.mechanism=GSSAPI
sasl.kerberos.service.name=kafka
sasl.jaas.config=com.sun.security.auth.module.Krb5LoginModule required \
   useKeyTab=true keyTab="/etc/krb5.keytab" principal="kafka/host@REALM";
```

Kerberos is operationally heavy: KDC infrastructure, ticket
expiration, principal management. If you already have Kerberos,
this is natural. If not, it's a heavy lift just for Kafka.

### 18.3.4 SASL/OAUTHBEARER

JWT-based authentication, integrated with OAuth2/OIDC providers.
Common when you have an existing identity provider (Okta, Auth0,
Cognito, etc.).

```properties
security.protocol=SASL_SSL
sasl.mechanism=OAUTHBEARER
sasl.jaas.config=org.apache.kafka.common.security.oauthbearer.OAuthBearerLoginModule required;
sasl.login.callback.handler.class=...   // your token-fetching handler
```

A custom callback fetches tokens from your IdP. The broker is
configured to validate tokens (signature, issuer, audience).

For modern cloud-native deployments, OAUTHBEARER is increasingly
preferred — it integrates with the identity layer you already have.

---

## 18.4 ACLs

Authentication tells you *who*. Authorisation tells you *what they
can do*. Kafka ACLs are the authorisation mechanism.

### 18.4.1 The ACL model

An ACL is a tuple:

```
(Principal, Operation, Resource, PermissionType, Host)
```

For example:

```
User:alice  CAN-DO  Read  ON Topic:orders  FROM '*'
User:bob    DENIED  Write ON Topic:orders  FROM '*'
```

Resources can be: Cluster, Topic, Group, TransactionalId, DelegationToken.
Operations vary by resource type:

- Topic: Read, Write, Create, Delete, Alter, Describe, AlterConfigs,
  DescribeConfigs, IdempotentWrite.
- Group: Read, Describe, Delete.
- Cluster: ClusterAction, Create, Alter, Describe,
  AlterConfigs, DescribeConfigs, IdempotentWrite.

### 18.4.2 Configuration

```properties
authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found=false       # secure default; deny if no ACL
super.users=User:admin
```

Set `allow.everyone.if.no.acl.found=false` in production. The default
`true` means "no ACL = allow", which is dangerous in a multi-tenant
environment.

### 18.4.3 Managing ACLs

```bash
# Grant alice read access to topic 'orders' and the group 'orders-consumers'
kafka-acls.sh --bootstrap-server broker:9092 \
    --add --allow-principal User:alice \
    --operation Read --topic orders --group orders-consumers

# Grant bob write access to 'orders'
kafka-acls.sh --bootstrap-server broker:9092 \
    --add --allow-principal User:bob \
    --operation Write --topic orders

# View all ACLs
kafka-acls.sh --bootstrap-server broker:9092 --list
```

For idempotent producers, additionally grant `IdempotentWrite` on the
cluster. For transactional producers, grant `Write` on the
`TransactionalId` resource.

### 18.4.4 ACL patterns at scale

For dozens of users and dozens of topics, manually managing ACLs is
tedious. Common patterns:

**Prefix-based ACLs.** A team owning topics matching `team-foo-*`
gets a single prefixed ACL covering all of them. New topics with the
prefix automatically inherit access.

**Role-based abstraction.** Map your identity provider's groups
("data-engineering", "platform-team") to ACL bundles. Access is
granted by group membership, not user-by-user.

**GitOps for ACLs.** Store ACL configurations in a Git repository,
apply via CI/CD. Audit log = git history.

For very large fleets, dedicated tooling (Confluent's Stream Governance,
Aiven's Karapace, custom scripts) becomes necessary.

---

## 18.5 Encryption at rest

Kafka does not encrypt data on disk by default. The `.log` files are
plaintext records on the broker's filesystem.

To get encryption at rest, your options are:

1. **Filesystem-level encryption** (LUKS on Linux, similar on others).
   The kernel encrypts blocks transparently. Kafka is unaware. Costs:
   slight CPU overhead, key management for the disk.
2. **Cloud provider encryption** (EBS encryption on AWS, similar
   elsewhere). Functionally similar to LUKS — the cloud handles
   key management.
3. **Application-level encryption.** Producer encrypts the value
   before sending; consumer decrypts. Kafka stores ciphertext.

Application-level is the strongest (the broker never sees plaintext)
but is operationally heavy: key management, key rotation, search
becomes impossible without key, etc.

For most deployments, **filesystem/cloud-provider encryption is
sufficient**. It addresses disk-theft / disposed-disk threats. For
regulated environments (HIPAA, PCI), application-level may be
required.

---

## 18.6 Multi-tenant Kafka

When multiple tenants share a cluster, isolation matters more.
Kafka has several mechanisms:

### 18.6.1 ACLs (basic isolation)

Each tenant has their own user identity; ACLs limit them to their
own topics. This is necessary but not sufficient — a noisy
neighbour can still consume bandwidth or storage that affects others.

### 18.6.2 Quotas

Per-user / per-client-id throughput quotas (KIP-13 et al):

```bash
# Limit alice to 50 MB/s in and out
kafka-configs.sh --alter \
    --add-config 'producer_byte_rate=52428800,consumer_byte_rate=52428800' \
    --entity-type users --entity-name alice
```

Quotas prevent any single tenant from saturating the cluster. Tune
based on tenant SLAs.

### 18.6.3 Resource quotas

KIP-257: per-user / per-client-id quotas on number of partitions,
connections, etc. Helps prevent a tenant from exhausting cluster-wide
resources.

### 18.6.4 Network isolation

The toughest isolation: separate listeners for separate tenants,
firewalled at the network level. Costs: complexity. Benefits:
tenants can't even attempt connections that would be rejected by
ACLs — the rejection is at L4.

### 18.6.5 The "just give them their own cluster" answer

For really noisy or really sensitive tenants, separate clusters are
cleaner than carefully tuned multi-tenancy. The operational overhead
of multiple clusters has dropped (KRaft, automation), making this
more viable than it used to be.

---

## 18.7 Audit

Who did what, when. Kafka itself has limited audit capabilities;
operators add them.

### 18.7.1 What's logged

The broker's `kafka-authorizer.log` records ACL decisions:

```
AUTHORIZER - ALLOWED Request from User:alice for Operation Read on Resource Topic:orders
AUTHORIZER - DENIED Request from User:eve for Operation Write on Resource Topic:secrets
```

Log every DENIED. Sample ALLOWED to control volume.

### 18.7.2 What's missing

Default logging doesn't capture *what records were read or written*
— only the connection-level operations. For finer-grained audit
(record-level), you need Custom AuditLogger plugins or a downstream
process tailing key topics.

### 18.7.3 Sending audit logs out

Forward broker logs to a centralised log system (Splunk, Elasticsearch,
S3). Don't rely on the local broker's logs surviving incidents — a
compromised broker's logs are not trustworthy.

---

## 18.8 Operational realities

### 18.8.1 Secrets management

Don't put secrets in plaintext config files. Options:

- **Environment variables**: better than config files, but still
  visible to anyone with shell on the host.
- **Config providers (KIP-297)**: configurable secret stores. Reference
  secrets via `${file:/path:key}` or `${vault:secret/path:key}`.
- **External vault (HashiCorp Vault, AWS Secrets Manager)**: gold
  standard. Brokers pull secrets at startup and renewal.

### 18.8.2 Rotation

Plan for credential rotation:

- TLS certs: 30-day to 24-hour validity, automated renewal.
- SCRAM passwords: rotate quarterly or annually; use rolling
  re-credentialing.
- OAuth tokens: short-lived by nature; the IdP handles refresh.

### 18.8.3 The "fix it later" trap

Common pattern: cluster ships without TLS or ACLs ("we'll add it
later"); a few months pass; production is now critical, retrofitting
security means downtime; security is silently deprioritised.

The fix: ship secure from day one, even if it's slightly more
work. Adding TLS to a green-field cluster is a few hours of
configuration. Adding TLS to a five-year-old cluster with hundreds of
producers and consumers can be a quarter-long project.

---

## 18.9 Configurations recap

Production secure configuration, broker side:

```properties
listeners=SASL_SSL://0.0.0.0:9092,REPLICATION-SASL_SSL://0.0.0.0:9093
security.inter.broker.protocol=SASL_SSL
sasl.enabled.mechanisms=SCRAM-SHA-512
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512

ssl.keystore.location=/etc/kafka/server-keystore.jks
ssl.truststore.location=/etc/kafka/server-truststore.jks
ssl.keystore.password=${file:/etc/kafka/secrets:keystore_password}
ssl.client.auth=required

ssl.enabled.protocols=TLSv1.3,TLSv1.2

authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer
allow.everyone.if.no.acl.found=false
super.users=User:admin
```

---

## Summary box

- Threat-model first. "Enable TLS" without a model is theatre.
- **TLS** for transit encryption + server identity + (optional)
  client identity. Use kTLS to avoid the throughput hit.
- **SASL** for authentication: SCRAM-SHA-512 is the modern default;
  OAUTHBEARER is the cloud-native modern; PLAIN only with TLS;
  Kerberos if you already have it.
- **ACLs** for authorisation. `allow.everyone.if.no.acl.found=false`.
  Use prefix-based and role-based patterns at scale.
- **Encryption at rest** is filesystem-level (LUKS / cloud-provider)
  for most; application-level for regulated.
- **Quotas** for multi-tenant fairness.
- **Audit logs** to the central log system, not local files.
- **Secrets via vault**, not config files. Plan for rotation.

## Further reading

- KIP-12: Kafka Sasl/Kerberos and SSL implementation.
- KIP-43: SASL handshake.
- KIP-297: Externalize Secrets for Connect Configurations (also
  applies to brokers/clients).
- KIP-684: Support mutual authentication for SASL.
- *Real-World Cryptography* by David Wong. For threat modelling.

## War story: the cluster everyone could read

A team had a cluster running for two years, "internally accessible
only" — meaning behind a corporate VPN, no public exposure. They had
no TLS, no auth, no ACLs.

A new internal product launched, used the cluster, and pulled all
the topics into its UI for "convenient browsing." Suddenly every
employee with VPN access could see every topic — including HR
events, payment processing logs, and customer PII — through the
new product's UI.

Nobody was malicious; the data was just visible. The breach
notification cost more than the cluster's three-year operational
spend.

The team rebuilt with TLS, SASL/SCRAM, and ACLs over the next quarter.
They also discovered, in the process, three other internal "browsers"
their topic data had been silently exposed to.

Lesson: **"behind the VPN" is not security.** Threat models that
include "trusted insiders" are different from those that don't. Most
production data deserves the latter. Build security in from day
one.
