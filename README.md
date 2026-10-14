# helium-services
Privacy-first cloud services for the
[Helium Browser](https://github.com/imputnet/helium).

This repo includes exactly what we use and host, down to Ansible playbooks.
All services are self-hostable.

## Services
- [nginx](svc/nginx) is a reverse proxy for all other services, and also serves
spellcheck dictionaries.
- [extension-proxy](svc/extension-proxy) proxies extension downloads from the
Chrome Web Store.
- [ubo](svc/ubo) mirrors uBlock Origin filter lists, along with
[Helium's own filters](filters).
- [bangs](svc/bangs) provides the list of !bangs used in Helium, generated
from [Kagi's bangs](https://github.com/kagisearch/bangs) with our own extras.
- [minidumpster](svc/minidumpster) handles and symbolicates crash reports.

## Utilities
- [sparkler](util/sparkler) generates the Sparkle appcast for macOS updates
from GitHub releases.
- [release-collector](util/release-collector) builds a manifest of the latest
Helium downloads for each platform, channel, and architecture.

## Self-hosting
The main stack (nginx, extension-proxy, ubo, and !bangs) can be set up with
[setup.sh](setup.sh) and the [example .env file](.env.example), which also
issue a TLS certificate with acme.sh. To deploy it the same way we do, see the
[Ansible playbooks](deploy), which also include our network setup (firewall
and BGP), rolling updates, and the [preseed file](deploy/preseed.cfg) for our
Debian VMs.

Everything else runs on its own:
- minidumpster has its own [compose.yml](svc/minidumpster/compose.yml) and
[example .env file](svc/minidumpster/.env.example), and runs alongside
Sentry's symbolicator.
- minipush runs from its Dockerfile. Generate its secrets with
`deno task gen`.
- sparkler writes its output to disk every hour, or once with `--oneshot`.
release-collector runs once, so it's meant to be run on a schedule.
sparkler needs a GitHub repo, an Ed25519 signing key, and output dirs, as
shown in its [example .env file](util/sparkler/.env.example). release-collector
only needs `OUTPUT_JSON_PATH`. Both accept an optional `GITHUB_ACCESS_TOKEN`.

## License
All code in this repo is licensed under AGPL-3.0. See [LICENSE](LICENSE).
