# minipush

storageless autopush-compatible Web Push server

uaids and push endpoints are self-contained (signed and encrypted with
`MINIPUSH_HMAC_SECRET` and `MINIPUSH_ENDPOINT_SECRET`), so there's no database.
messages which haven't been acked by the ua yet are kept in memory, and are lost
only if a member crashes.

## how it works

minipush runs as a mesh of members (processes), which can live on any number of
hosts. all members need the same secrets, and every member needs to know about
every other member (`MINIPUSH_PEERS`).

links between members are authenticated with `MINIPUSH_MESH_SECRET`, but not
encrypted, so they should go over a private network (or `wss://` urls in
`MINIPUSH_PEERS`, with something terminating tls in front of the mesh listener).

each uaid has two **home** members, picked by rendezvous hashing over the
members that are currently reachable. homes store messages for the ua until it
acks them, and know which member the ua is connected to.

```
app server --POST--> any member --route--> home --deliver--> ua's member --> ua
                                            ^                    |
                                            +-------- ack -------+
```

- a ua tells its homes where it's connected once it says hello, and members
  re-announce their uas whenever members come or go.
- a ua which doesn't ack what we send it within `MINIPUSH_ACK_TIMEOUT_MS` gets
  disconnected, and everything unacked is redelivered once it reconnects
  (anywhere).
- on SIGTERM, a member stops taking new connections, hands the messages it
  stores off to the next home of each ua, waits up to `MINIPUSH_ACK_GRACE_MS`
  for in-flight acks, and closes connections with 1012 spread over
  `MINIPUSH_DRAIN_SECONDS`. a second signal exits right away.

## setup

```sh
cp .env.example .env
# fill in the secrets from `deno task gen`

docker compose up -d --build
```

minipush then listens on `127.0.0.1:10001`. the reverse proxy in front of it has
to pass websocket upgrades, overwrite `X-Forwarded-For`, and keep idle
websockets open for longer than `MINIPUSH_IDLE_TIMEOUT_SECONDS`. any variable
from the table below can be set in `.env`.

## configuration

`deno task gen` generates all secrets.

| variable                              | default             | description                                               |
| ------------------------------------- | ------------------- | --------------------------------------------------------- |
| `MINIPUSH_HMAC_SECRET`                | required            | signs uaids                                               |
| `MINIPUSH_ENDPOINT_SECRET`            | required            | encrypts endpoints and message ids                        |
| `MINIPUSH_BASE_URL`                   | `http://host:port/` | public url that endpoints are built from, see below       |
| `MINIPUSH_BIND_HOSTNAME`              | `127.0.0.1`         | public listener                                           |
| `MINIPUSH_PORT`                       | `10001`             | public listener                                           |
| `MINIPUSH_UNIX_SOCKET`                |                     | listen on a unix socket instead of hostname and port      |
| `MINIPUSH_TRUST_PROXY`                | `false`             | take the client ip from `X-Forwarded-For`                 |
| `MINIPUSH_NODE_ID`                    | `local`             | unique id of this member                                  |
| `MINIPUSH_PEERS`                      |                     | `id=ws://host:port,...`, may include this member          |
| `MINIPUSH_MESH_SECRET`                | required with peers | authenticates members to each other                       |
| `MINIPUSH_MESH_HOSTNAME`              | `127.0.0.1`         | mesh listener, also serves `/metrics`                     |
| `MINIPUSH_MESH_PORT`                  | `10002`             | mesh listener                                             |
| `MINIPUSH_MAX_TTL_SECONDS`            | `30`                | upper bound for message ttls                              |
| `MINIPUSH_MAX_QUEUED_PER_CHANNEL`     | `64`                | unacked messages per channel                              |
| `MINIPUSH_MAX_MAILBOX_BYTES`          | `268435456`         | memory budget for stored messages, per member             |
| `MINIPUSH_MAX_CHANNELS_PER_UAID`      | `1024`              | channels per uaid, also bounds its queue                  |
| `MINIPUSH_IDLE_TIMEOUT_SECONDS`       | `60`                | websocket ping timeout                                    |
| `MINIPUSH_ACK_TIMEOUT_MS`             | `60000`             | disconnect uas which don't ack within this                |
| `MINIPUSH_ACK_GRACE_MS`               | `2000`              | how long to wait for in-flight acks when draining         |
| `MINIPUSH_DRAIN_SECONDS`              | `30`                | how long to spread closing connections over when draining |
| `MINIPUSH_RATE_LIMIT_WINDOW`          | `60000`             | rate limit window, in ms                                  |
| `MINIPUSH_RATE_LIMIT_PER_CHANNEL`     | `300`               | pushes per channel per window                             |
| `MINIPUSH_RATE_LIMIT_CONNECTS_PER_IP` | `600`               | websocket connections per client ip per window            |

all members need the same `MINIPUSH_BASE_URL`, pointing at the anycast address.
endpoints are built from it, so a per-member url would tell app servers roughly
where the ua was when it subscribed.

queue limits are per channel only. a limit per uaid would be shared by all app
servers pushing to that ua, which would let them notice (or interfere with) each
other's messages.

## development

- `deno task dev` runs a single member
- `deno task test` runs unit tests, and integration tests which spin up
  (clusters of) real members
