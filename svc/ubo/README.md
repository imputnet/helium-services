# uBlock Origin list mirror
proxies all uBO lists via `https://services.helium.imput.net/ubo/lists/*` (see [gen/nginx-ubo-lists.conf](gen/nginx-ubo-lists.conf)), provides an assets.json [here](https://services.helium.imput.net/ubo/assets.json)

### url
https://services.helium.imput.net/ubo/*

### privacy policy
this service does not log, track or store any personal information of any kind.

### maintenance
- `bump-version.sh` updates generation script to latest version
- `generate.mjs` generates all the junk in [gen](gen/)
