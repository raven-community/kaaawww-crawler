#Kaaawww-Crawler

Ravencoin Network Crawler

## Prerequisites

- Node 6.x.x or higher

- NPM 3.5.x or higher

### 1. Install

npm install -g kaaawww-crawler

Download [maxmind ASN database](https://geolite.maxmind.com/download/geoip/database/GeoLite2-ASN.tar.gz) and place GeoLite2-ASN.mmdb in the directory where you are planning to run the crawler.

### 2. Run:

kaaawww-crawler -network=rvn -port=3003

currently for ravencoin.

### 3. Commands / Server Query:

see if it's running: http://localhost:3003/node_count, http://localhost:3003/node_list, http://localhost:3003/debug

#### 4.3. Rate limiter: 
(some host or VPS providers will balk at you for virus-like activity, which crawler is.)

kaaawww-crawler -network=rvn -port=3003 -max_failed_connections_per_minute=200 -max_concurrent_connections=300

defaults: -max_failed_connections_per_minute=300 -max_concurrent_connections=800
