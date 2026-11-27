# helium components

the update server for helium's own browser components, at
https://components.helium.computer/. each component is signed with its own
key, derived from `COMPONENT_KEY` by the component's name, and each release
is built the first time a browser needs it.

- **crlset**: [opencrlset](https://github.com/imputnet/opencrlset)'s
  newest build, its `crl-set` and `manifest.json` packed as they are,
  as the component `crlset`.
- **translation models**: one component per direction, packed from
  mozilla's [firefox translations](https://github.com/mozilla/translations)
  models, as the components `translation-<from>-<to>`.
- **ublock**: the crx from [imputnet/uBlock](https://github.com/imputnet/uBlock)'s
  newest published release, served as it is once it checks out: signed by
  uBlock's own key (so not derived from `COMPONENT_KEY`), and with the
  release's version in its manifest.
- **pki metadata** and **ssl error assistant**: proxied from google

browsers that have a release from the last week cached get a [puffin][]
patch to the newest one, made the first time it's needed. responses are
signed with cup.

`components keys` prints every component's app id, name and the sha-256 of
its public key, which the browser pins.

### configuration

| variable | |
| --- | --- |
| `BASE_URL` | where this server is reachable, e.g. `https://components.helium.computer/` |
| `COMPONENT_KEY` | pkcs#8 pem key that every component's signing key is derived from |
| `CUP_KEYS` | `<version>=<key.pem>`, comma separated; ml-dsa-44 or ecdsa p-256 |
| `PUFFIN` | chromium's `puffin`; without it, no patches. the image has one; elsewhere, `OUT=<dir> ./build-puffin.sh` builds one (about 20 gib of disk while building) |
| `DATA_DIR` | where builds are kept, `/data` by default |
| `CRLSET_URL`, `CRLSET_TIER` | `https://crls.helium.computer/`, `standard`; empty url leaves the crlset out |
| `BERGAMOT_CHANGESET`, `BERGAMOT_ATTACHMENTS` | mozilla's model list and where its files are; an empty changeset leaves translations out |
| `LISTEN`, `MAX_CONNECTIONS`, `METRICS_LISTEN` | `0.0.0.0:8000`, `1024`, off |

### privacy policy

this service does not log, track or store any personal information.

[puffin]: https://chromium.googlesource.com/chromium/src/+/main/third_party/puffin/
