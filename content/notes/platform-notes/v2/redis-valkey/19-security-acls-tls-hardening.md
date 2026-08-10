# Chapter 19: Security — ACLs, TLS & Hardening

> "Unauthenticated Redis on the internet" was a top-five reason for
> data breaches in the 2010s. Tens of thousands of misconfigured
> instances have been compromised by ransomware, cryptojackers, and
> data thieves. Modern Redis has serious security primitives — ACLs,
> TLS, protected mode, command renaming — but they only help if you
> use them. This chapter is the hardening checklist.

---

## 19.1 Threat Model

What can go wrong with Redis:

1. **Network exposure**: a Redis bound to 0.0.0.0 with no password is
   a Free-For-All-Cluster.
2. **Weak authentication**: shared `requirepass` distributed across
   apps; one leak compromises everything.
3. **Command-level abuse**: even authenticated users may run commands
   they shouldn't (`FLUSHALL`, `DEBUG`, `CONFIG`).
4. **Data exfiltration via replication**: an attacker registers as a
   replica and slurps the entire dataset.
5. **Lua sandbox escape**: rare but historically real. Old Lua versions
   had documented escapes.
6. **Module-loaded RCE**: if an attacker can run `MODULE LOAD`, they
   can load arbitrary `.so`. Game over.
7. **TLS man-in-the-middle**: if traffic isn't encrypted, anyone on the
   path can read or modify.

We address each below.

---

## 19.2 Network Layer: Bind, Protected Mode, Firewall

### 19.2.1 `bind`

```
bind 127.0.0.1 -::1            # default for redis-server (loopback only)
bind 10.0.0.5 ::1               # bind to specific NIC
bind 0.0.0.0                    # bind to all interfaces (dangerous on public IPs)
```

Always bind to specific internal IPs. Never bind to `0.0.0.0` on a host
with a public network interface unless you're 100% sure of your firewall
rules.

### 19.2.2 Protected Mode

```
protected-mode yes            # default
```

When protected mode is on, Redis refuses connections from non-loopback
IPs **if** no password is set. This is the safety net for "I just
installed Redis and forgot to set requirepass."

```
> redis-cli -h 10.0.0.5
DENIED Redis is running in protected mode because protected mode is
enabled, no bind address was specified, no authentication password is
requested to clients...
```

Setting `protected-mode no` or setting any password disables this
guard. **Always set a password before disabling protected mode.**

### 19.2.3 Firewall

OS-level firewall rules are the next layer. iptables/nftables/ufw rules
that allow port 6379 only from your application subnet:

```bash
sudo ufw allow from 10.0.0.0/24 to any port 6379
sudo ufw deny 6379
```

In cloud:
- AWS: Security Group inbound rule (port 6379, source = app SG ID).
- GCP: VPC firewall rule (port 6379, source ranges = app subnet).
- K8s: NetworkPolicy.

**Never expose 6379 (or 16379 cluster bus) on a public load balancer.**

---

## 19.3 Authentication: `requirepass` (Legacy)

Pre-ACL Redis had one password for everyone:

```
requirepass topsecret
```

```
> AUTH topsecret
+OK
> GET k
"v"
```

Single password for all users. Cannot revoke individual app credentials
without rotating the global password (and reconfiguring everyone).

This is the legacy model — still works, but use **ACLs** instead in
modern Redis.

---

## 19.4 ACLs: Per-User Access Control

Redis 6+ ships with full ACLs. Multiple users, each with:
- A password (or no password, or external auth via module)
- A set of allowed commands and command categories
- A set of accessible keys (by pattern)
- A set of accessible Pub/Sub channels (by pattern)
- A set of allowed client IPs

### 19.4.1 The Default User

Out of the box:

```
> ACL LIST
1) "user default on nopass ~* &* +@all"
```

`default`: the user used when a client connects.
`on`: the user is enabled.
`nopass`: any password (including no `AUTH`) works.
`~*`: any key.
`&*`: any pub/sub channel.
`+@all`: all command categories.

Once you start configuring ACLs, the first thing you do is lock down
this default user.

### 19.4.2 Defining Users

```
> ACL SETUSER alice on >alice-password ~user:* +@read +@write -flushall -flushdb -keys
+OK
```

Breakdown:
- `alice on` — enable user alice
- `>alice-password` — set password (one of multiple if multi-password)
- `~user:*` — allowed keys: any key matching `user:*`
- `+@read` — add read commands
- `+@write` — add write commands
- `-flushall -flushdb -keys` — minus specific commands

Now alice can:
- `GET`, `SET`, `INCR`, etc. on keys matching `user:*`
- Cannot run `KEYS`, `FLUSHDB`, `FLUSHALL`

### 19.4.3 Command Categories

```
> ACL CAT
1) "keyspace"
2) "read"
3) "write"
4) "set"
5) "sortedset"
...
12) "admin"           <-- DEBUG, CONFIG, SHUTDOWN, etc.
13) "dangerous"       <-- FLUSHALL, FLUSHDB, KEYS, MIGRATE, ...
14) "scripting"       <-- EVAL, EVALSHA, SCRIPT
...
```

```
> ACL CAT dangerous
1) "flushdb"
2) "flushall"
3) "keys"
4) "debug"
5) "monitor"
...
```

Common patterns:

```
# An app that should never do admin / dangerous
+@all -@admin -@dangerous

# A pure read replica reader
+@read

# A backup script that needs DUMP and BGSAVE but nothing else
+dump +bgsave +info

# A monitoring agent
+info +client +latency +slowlog +memory|stats +ping
```

### 19.4.4 Key Patterns

`~pattern` permits keys matching the glob. Multiple patterns:

```
~user:* ~session:*           # both
~* allkeys                   # everything
%R~user:*                    # read-only access to user:*
%W~user:*                    # write-only access to user:*
%RW~user:*                   # equivalent to ~user:*
```

The `%R`/`%W` prefixes (Redis 7.4+) let you grant read-only on a
namespace and write-only on another.

### 19.4.5 Channel Patterns

```
&channel:*                   # subscribe/publish on channel:*
&__keyspace@*__:*            # access keyspace notifications
```

Same glob style.

### 19.4.6 Persisting ACLs

ACLs live in:

```
aclfile /etc/redis/users.acl    # external file (recommended for clusters)
# OR
# inline in redis.conf via "user ..." lines (not recommended for ops)
```

`ACL SAVE` writes the runtime state to the file. `ACL LOAD` reloads.
Cluster: ensure the same file is on every node and reload after
changes.

### 19.4.7 Inspecting

```
> ACL WHOAMI
"alice"
> ACL GETUSER alice
1) "flags"
2) 1) "on"
   2) "allkeys"        <-- this would be set if ~* was used
3) "passwords"
4) 1) "<sha-256 of password>"
5) "commands"
6) "+@read +@write -flushall -flushdb -keys"
7) "keys"
8) 1) "user:*"
9) "channels"
10) ""
```

### 19.4.8 Logging Denials

```
> ACL LOG
1) 1) "count" -> "5"
   2) "reason" -> "command"
   3) "context" -> "toplevel"
   4) "object" -> "FLUSHALL"
   5) "username" -> "alice"
   6) "age-seconds" -> "23.456"
   ...
```

Watch this in production. Repeated denials suggest an app misconfigured
or an attacker probing.

---

## 19.5 TLS

Redis 6+ has native TLS. To enable:

```
port 0                              # disable plaintext port
tls-port 6380
tls-cert-file /etc/redis/tls/redis.crt
tls-key-file /etc/redis/tls/redis.key
tls-ca-cert-file /etc/redis/tls/ca.crt
tls-auth-clients yes                # require client cert (mTLS)
tls-cluster yes                     # encrypt cluster bus too
tls-replication yes                 # encrypt replication
```

Connect:

```bash
redis-cli --tls --cert client.crt --key client.key --cacert ca.crt -h ...
```

Costs:
- ~1-3 ms TLS handshake per connection (use connection pooling).
- ~10-30% CPU per byte for encryption.
- I/O threads (Chapter 2) help mitigate.

**Always use TLS in production**, even within a private network. Defense
in depth.

### 19.5.1 mTLS (Mutual TLS)

`tls-auth-clients yes` requires every client to present a valid
certificate signed by your CA. Combined with ACLs, you can:

1. Issue client certs per app (or per app instance).
2. Map cert subject to ACL user via cluster-controlled provisioning.
3. Revoke a cert (CRL) to disable an app instantly without rotating
   passwords.

This is the gold standard for service-to-service Redis auth.

---

## 19.6 Securing Specific Commands

Some commands are dangerous by design:

| Command | Why dangerous |
|---------|---------------|
| `FLUSHALL`, `FLUSHDB` | Wipe data |
| `DEBUG` | Internal/diagnostic; can crash server |
| `CONFIG` | Change server behavior live |
| `SHUTDOWN` | Stop the server |
| `KEYS` | DoS — O(N) over keyspace |
| `MIGRATE` | Move keys to other servers |
| `SLAVEOF`/`REPLICAOF` | Reconfigure replication |
| `MONITOR` | Tap all commands |
| `SCRIPT FLUSH` | Drop cached scripts |
| `EVAL` (without sandbox limits) | Arbitrary Lua execution |
| `MODULE LOAD` | Load arbitrary native code |
| `ACL` | Change auth |

Two ways to lock these down:

### 19.6.1 Renaming (legacy)

```
rename-command FLUSHALL "FLUSHALL_b69a2d_secret"
rename-command CONFIG ""              # disable entirely
rename-command DEBUG ""
```

The rename obscures the command. A blank-string rename disables it.

This is now mostly a relic — ACLs are cleaner. But still useful when
you want to allow `CONFIG GET` (read-only) to a monitoring agent
without giving it any other admin commands.

### 19.6.2 ACL Subcommand Restrictions

```
> ACL SETUSER monitor +config|get -config
```

The `command|subcommand` form lets you allow `CONFIG GET` while denying
the broader `CONFIG` (and thus `CONFIG SET`).

### 19.6.3 Cluster-Level Hardening

```
cluster-replica-no-failover yes      # disable replica auto-promotion
```

Sometimes used in DR setups where you never want automated failover.

---

## 19.7 Module Security

Module loading is a remote code execution surface. Mitigations:

1. **Allowlist modules at config time**:
   ```
   loadmodule /etc/redis/modules/redisjson.so
   loadmodule /etc/redis/modules/redisearch.so
   ```
   Don't allow `MODULE LOAD` at runtime via ACL:
   ```
   > ACL SETUSER admin -module|load -module|loadex -module|unload
   ```
2. **Restrict file system access** to the modules directory (read-only,
   owned by root).
3. **Don't accept user-supplied module paths**, ever.

In multi-tenant deployments (e.g., managed Redis services), modules
are usually pinned at provisioning time and runtime loading is denied.

---

## 19.8 Replication Security

A rogue replica drains data:

```
attacker: REPLICAOF target-host 6379
attacker's redis: receives full RDB → reads all data
```

Defenses:

1. **`requirepass` on the primary, masterauth on the replica**:
   ```
   # primary:
   requirepass primarysecret
   
   # replica:
   masterauth primarysecret
   ```
2. **TLS replication** (`tls-replication yes`).
3. **Network isolation**: cluster bus and replication on private subnets.

---

## 19.9 The `--no-rdb`, `--no-aof`, `--no-modules` Bunker Mode

Sometimes you want a Redis to be ephemeral, in-memory only, no
persistence, no modules. Useful for short-lived testing or for
"trusted but ephemeral" workloads.

```
appendonly no
save ""
loadmodule (none)
```

Combined with TLS + ACLs, this is the most secure operational config.

---

## 19.10 Common Misconfigurations to Audit

A pre-deploy checklist:

- [ ] `bind` is to specific internal IPs, not `0.0.0.0`.
- [ ] `protected-mode yes` (or password is set).
- [ ] Default user is locked down (`nopass` removed, password set,
  capabilities scoped).
- [ ] ACLs defined per app role.
- [ ] TLS enabled (`port 0`, `tls-port 6380`).
- [ ] Cluster bus uses TLS (`tls-cluster yes`).
- [ ] Replication is authenticated (`masterauth` + `requirepass`).
- [ ] `MODULE LOAD` is restricted at the ACL level.
- [ ] `CONFIG`, `DEBUG`, `FLUSHALL`, `KEYS`, `MIGRATE` not allowed for
  app users.
- [ ] No `FLUSHDB` cron-runable scripts in production.
- [ ] Firewall rules narrow down 6379 access to app subnets.
- [ ] Logging captures `ACL LOG` events to your SIEM.
- [ ] Redis runs as non-root user.
- [ ] AOF and RDB files have restrictive perms (`chmod 0640`, owner =
  redis).

---

## 19.11 The "Compromised Redis" Recovery

If you suspect compromise:

1. **Isolate**: firewall off the instance from the internet.
2. **Forensic snapshot**: `BGSAVE` or `redis-cli --rdb` to capture
   state.
3. **Audit ACL log**: `ACL LOG`, recent commands, modules loaded.
4. **Inspect for backdoors**:
   ```
   > MODULE LIST       # any unexpected modules?
   > CONFIG GET dir    # is "dir" pointing at a webroot?
   > CONFIG GET dbfilename   # rdb pointed at /etc/cron.d/something?
   ```
5. **Look for rogue cron / authorized_keys**: classic Redis exploits
   write to `~/.ssh/authorized_keys` via `CONFIG SET dir + dbfilename`.
6. **Rebuild**: don't try to clean. Spin up a new Redis from scratch
   with hardened config; restore data from a known-good backup.

---

## 19.12 Source Files for This Chapter

| File | What lives here |
|------|----------------|
| `acl.c` | ACL implementation; users, commands, keys, patterns |
| `tls.c` | TLS support |
| `networking.c` | Connection setup, protected mode check |
| `server.c` | `requirepass`, command flags |

---

## Practice Questions

1. A new junior engineer types `redis-cli -h <prod-redis>` and gets
   `DENIED Redis is running in protected mode...`. Walk through the
   right way to give them access.
2. Your monitoring agent needs to call `INFO`, `LATENCY GET`,
   `SLOWLOG GET`, and `CLIENT LIST`. Sketch the ACL line.
3. A bug bounty researcher says they ran `CONFIG SET dir
   /var/spool/cron/crontabs ; CONFIG SET dbfilename root ; BGSAVE`
   on your Redis. What just happened? How was it possible?
4. You enable TLS with mTLS. Each app has its own client cert. One
   app's cert is compromised. Describe revocation.
5. ACL key patterns use globs. What happens for `~user:*` if a key
   like `user:42:profile` exists? What about `usermail:42`?
6. `MODULE LOAD` should never be runtime-callable in production. Why
   is even one loaded module a real security upgrade in your threat
   model?
7. You inherited a Redis with `requirepass` set and 12 apps using it.
   The shared password leaked. Walk through migration to ACLs without
   downtime.

(Answers at end of Chapter 22.)
