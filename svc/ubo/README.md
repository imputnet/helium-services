# uBlock Origin mirror

- provides a uBlock Origin [update manifest](https://services.helium.computer/ubo/update.xml)
and [CRX](https://services.helium.computer/ubo/ublock.crx) for installation.

- proxies all uBO lists via `https://services.helium.computer/ubo/lists/*` (see [gen/nginx-ubo-lists.conf](gen/nginx-ubo-lists.conf)), provides an assets.json [here](https://services.helium.computer/ubo/assets.json)

### url
https://services.helium.computer/ubo/*

### privacy policy
this service does not log, track or store any personal information of any kind.

### maintenance
- `bump-version.sh` updates generation script to latest version
- `generate.mjs` generates all the junk in [gen](gen/)
