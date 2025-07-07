## sparkler

A script that transforms github releases into a
[Sparkle appcast](https://sparkle-project.org/documentation/).

Helium uses this script in production to generate the appcast for macOS updates, and the output of
the script can be seen at [https://updates.helium.computer/](https://updates.helium.computer/).

### usage

```
docker build -t sparkler .
```

run as a daemon:

```
docker run \
  -d \
  -v /path/to/appcast/output:/appcast \
  -v /path/to/assets/dir:/assets \
  --env-file=.env \
  sparkler
```

run as oneshot:

```
docker run \
  --rm -it \
  -v /path/to/appcast/output:/appcast \
  -v /path/to/assets/dir:/assets \
  --env-file=.env \
  sparkler \
  --oneshot
```

### privacy policy

The script does not handle any requests, and therefore it cannot collect any personal data.

Our mirror at [updates.helium.computer] is behind CloudFlare, and therefore requests to it are
subject to the [CloudFlare privacy policy](https://www.cloudflare.com/privacypolicy/).

We do not directly log, or store any requests, and most requests to this service are typically
proxied through a helium-services [nginx instance](../../svc/nginx).
