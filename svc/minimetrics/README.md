# minimetrics

Collector for Chromium's UMA usage metrics (histograms) from Helium users who
opt in. Speaks Google's UMA upload protocol, keeps only daily aggregates.

### privacy policy

this service receives usage statistics from Helium installs that opted in:
histograms (technical counts such as page load timings), plus version,
channel, OS, CPU architecture, a random install identifier and other system
details.

each report is reduced to version, channel, OS, architecture and histogram
counts, then added to per-day totals. the report itself is not stored, nor are
session identifiers, field trials, hardware details or locale.

daily active installs are counted with a salted hash of the install
identifier. the salt changes daily, and both hashes and salt are deleted when
the day ends, so installs can't be followed across days or identified. a
fingerprint of each report, used to drop duplicates, is deleted at the same
time.

aggregates are kept for 90 days. data is only shown for groups of at least 5
daily users. access is limited to active members of the imputnet GitHub org.
IP addresses are used for rate limiting only and never stored.

## setup

```sh
cp .env.example .env  # fill in required fields
mkdir -p data
docker compose up -d --build
```

the reverse proxy must overwrite `X-Forwarded-For`, which is used for rate
limiting.

## usage

point Chromium's UMA server URL (`IDS_METRICS_SERVER_URL` in
`components/metrics/server_urls.grd`) at `https://$hostname/uma/v2`. keep the
UKM and DWA URLs empty.

logs only carry name hashes. upload names from a Chromium checkout, again
after each update:

```sh
python3 tools/metrics/histograms/print_histogram_names.py \
  | gzip | curl -sS -X POST \
    -H "Authorization: Bearer $NAMES_UPLOAD_TOKEN" \
    -H 'Content-Encoding: gzip' \
    --data-binary @- \
    "https://$hostname/api/histogram-names"
```

`HISTOGRAM_ALLOWLIST` (a file of names, one per line) drops all other
histograms on receipt. `MIN_USERS` sets the small-group threshold.

the changes page lists histograms whose median, p95 or (for enums)
distribution moved between two versions beyond noise, per OS as well. it's
triage: check what it flags on the histogram's page.

## development

needs Node 26+.

```sh
npm install
npm run dev       # http://localhost:8080, no login, MIN_USERS=1
npm run dev:seed  # a month of fake data
npm test
npm run check     # types
npm run lint
npm run fmt
```

```sh
Helium.app/Contents/MacOS/Helium \
  --force-enable-metrics-reporting \
  --uma-server-url=http://localhost:8080/uma/v2 \
  --metrics-upload-interval=30
```
