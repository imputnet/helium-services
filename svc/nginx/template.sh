#!/bin/sh
set -ex
ls -la /
for f in /*.j2; do
    BASE=$(basename "$f" .j2)
    jinja2 --strict \
    -D "services_hostname=$SERVICES_HOSTNAME" \
    "$f" -o "/$BASE"
done
