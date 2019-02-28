# Kaaawww-Crawler

Ravencoin Network Crawler

## Prerequisites

- Node 6.x.x or higher

- NPM 3.5.x or higher

### 1. Install

npm install -g kaaawww-crawler

### 2. Run:

kaaawww-crawler -port=3003

currently for ravencoin.

### 3. Commands / Server Query:

http://localhost:3003/

http://localhost:3003/node_count

Charts:
- http://localhost:3003/map
- http://localhost:3003/node_list
- http://localhost:3003/charts/pie
- http://localhost:3003/charts/bar-v
- http://localhost:3003/charts/bar-h
- http://localhost:3003/charts/table

CSV:
- http://localhost:3003/connections/HOST-IP.csv

APIs:
- http://localhost:3003/api
- http://localhost:3003/debug

#### 4.3. Rate limiter:
(some hosts or VPS providers will balk at you for virus-like activity, which the crawler is.)

kaaawww-crawler -port=3003 -max_failed_connections_per_minute=200 -max_concurrent_connections=300

defaults: -max_failed_connections_per_minute=300 -max_concurrent_connections=800
