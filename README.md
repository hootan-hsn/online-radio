# Raadio

24/7 internet radio station. Live at https://raadio.run.place.

This repo holds the web player (PWA). The streaming server and controller run on AWS.

## Streaming server (AWS EC2, Ubuntu)

- Elastic IP (permanent address); raadio.run.place points to it through DNSExit.
- Icecast on port 8000, serving two streams:
  - `/radio.mp3` at 96k for older iPhones
  - `/radio.opus` at 32k for everyone else (about 75% less data than the original 128k MP3)
- Nginx and Certbot handle HTTPS on 443 and forward `/radio.mp3`, `/radio.opus`, `/skip` and `/now-playing` (duplicate-CORS-header issue fixed).

## Controller (radio_controller.py, FastAPI with the Telegram client)

- Logs in as a Telegram user account (`radio_user.session`), since a bot can't read channel history, and plays tracks from a private channel.
- One FFmpeg encoder stays connected to Icecast. Songs are decoded into it, and silence fills download gaps, so listeners never disconnect between tracks. The next song downloads while the current one plays.
- Skip voting: 2 different IPs within 90 s skips a song, with a short fade-out.
- Tier system: skips raise a song's score and finished plays lower it. Tiers 2 to 4 play less often, and tier 5 is banned permanently.
- `/now-playing` returns the title, artist and track id.

## Web player (PWA)

- Cream, gold and amber design; a dislike button for skip (also triggered by swiping left, the N key, or the next button on headsets and lock screens); and a "Coming up" panel.
- Plays Opus by default and falls back to MP3. Keeps playing with the screen off and shows the song name on the lock screen.
- Lite mode for old Android phones, sized for a 3.6-inch screen, and installable to the home screen.
- A login that flips the card to a studio (upload, record, server status, calendar). This part is still mocked: nothing reaches the server yet.

## Roadmap

- Dockerize the app, Terraform the infra, add CI/CD.
- Wire the studio (upload, record, server status) to the server.
