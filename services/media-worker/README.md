# media-worker

Checks the clips organizers add to an event (SCRUM-1106): downloads one by link, measures it, takes six stills and makes two
H.264 faststart copies (≤ 1080 px with sound, ≤ 540 px silent and about 2 MB). An HDR clip (HLG or PQ, as iPhones record) is brought to SDR BT.709 in every still and copy (`TO_SDR` in `clip.ts`), so the poster and the playing copy are one picture. It is a service of its own because it opens links
people paste, and the web service holds the database and sign-in secrets.

- **Holds:** `MEDIA_WORKER_SECRET` and nothing else. No storage keys: the web service (`lib/media-clip.ts`) sends a presigned PUT
  URL for each file. `__tests__/media-worker.test.ts` fails on any other variable, any dependency, or a CMD that is not this.
- **Reached:** over the private network only (no public domain), `POST /clip` with the secret. `GET /health` is open.
- **Sleeps:** it sends nothing on its own, so Railway Serverless puts it to sleep; the first request wakes it and the caller retries.
- **Opens:** https links on public addresses only, checked at connect and on every redirect; 50 MB and 45 s at most. ffmpeg reads
  only the downloaded file, only as MP4/MOV. One job at a time, a line of three, 150 s for
  the whole job; a job whose caller has gone is stopped. The decoder refuses a frame over 4096 × 2304 (`-max_pixels`).

Run it: `MEDIA_WORKER_SECRET=<32+ characters> node main.mjs` (Node 24+, ffmpeg on the PATH), or build the Dockerfile.

## Railway

Root Directory `services/media-worker` (the Dockerfile there is found by itself; no build or start command, no pre-deploy command,
no config file). Serverless on, no public domain, memory limit 1 GB (Settings → Resource limits: decoding is the untrusted part). Variables: `MEDIA_WORKER_SECRET`, and `PORT=8080`.
On the web service: `MEDIA_WORKER_URL=http://${{media-worker.RAILWAY_PRIVATE_DOMAIN}}:8080` and the same `MEDIA_WORKER_SECRET`.
Until both are set the check is off and the editor shows none of it.
