# Alert routing — YIL-12

Pre-launch we are one on-call engineer (the founder). The goal is fewer, higher
signal alerts — not comprehensive coverage. When in doubt, **don't page** and
let the runbook catch the next incident.

## Who pages whom

| Severity | Channel                          | Who responds      | Response time |
|----------|----------------------------------|-------------------|---------------|
| SEV1     | SMS + phone call (PagerDuty / Better Stack) | Founder (on-call) | <15 min       |
| SEV2     | Email + Sentry assign            | Founder (next business day) | <8 business hours |
| SEV3     | GitHub issue, no auto-page       | Whoever picks it up | Best-effort   |

## Triggers (and what they should NOT trigger)

| Trigger                                          | Severity | Why                                          |
|--------------------------------------------------|----------|----------------------------------------------|
| `/api/health` 503 from 2 regions, ≥2 min         | SEV1     | Service is down. Page immediately.           |
| `/api/health` 503 from 1 region, ≥5 min         | SEV2     | Could be a probe network blip. Email only.   |
| `/api/ready` 503, `/api/health` 200              | SEV2     | Degraded but live. Investigate next morning. |
| Sentry: error rate >5/min for 5 min              | SEV1     | Something is on fire.                        |
| Sentry: any payment.* error                      | SEV1     | Money is involved. Always page.              |
| Sentry: new error type (first seen)              | SEV2     | Worth knowing about, not worth a page.       |
| Sentry: error rate <1/min, recurring             | SEV3     | Ticket it. Don't page.                       |
| Uptime probe GitHub Actions fails                | SEV2     | Tells us our other probe provider is also down.|
| Deploy fails in CI                               | SEV3     | Slack/email; not a user-facing outage.       |
| DB connection pool >80% utilized (5 min)         | SEV2     | Predict Incident 3 before it happens.        |

## What we explicitly do NOT alert on

- **Every 5xx.** Group by route. A 1-off 500 on `/admin/foo` should not page.
- **CPU/memory spikes.** Right-size, don't page. We have one container; if it
  OOMs the readiness check catches it.
- **Latency p95 creeps up.** Track over weeks, fix when actionable.
- **User-reported bugs in chat.** These become tickets, not alerts.

## Escalation

There is no escalation. The founder is the entire on-call rotation until
engineer #2 is hired (see hiring plan). When that happens:

- Split on-call weekly.
- Add a 5-minute "no ack → secondary" rule on SEV1.
- Add a 24/7 channel via PagerDuty (or equivalent) so neither engineer is
  tethered to their laptop.

## Acknowledging alerts

- **Ack within 15 min** for SEV1. The alert service mutes repeat pages for
  30 min after ack — silence is a feature, not neglect.
- **Update the issue** within 1 hour for SEV2 — even if the update is
  "investigating, no mitigation yet." This is the audit trail.

## How the alert chain actually fires

1. **Sentry** watches error rate and first-seen errors. Its own alert rules
   live in the Sentry dashboard — see `Sentry → Alerts` for the configured
   rules (named `SEV1 — payments`, `SEV1 — error rate spike`, `SEV2 — first
   seen error`). Owned by the founder.
2. **Better Stack (or UptimeRobot)** probes `/api/ready` from 3 regions every
   60s. Alerts go to email + SMS. Owned by the founder.
3. **GitHub Actions** cron (`.github/workflows/uptime.yml`) probes `/api/ready`
   every 5 min as a backup. Failures appear in the Actions tab; the workflow
   also emails the founder. This is the "second probe" — if the SaaS probe
   provider is down we still see the failure.

## Audit trail

Every SEV1/SEV2 incident produces:

- A Sentry issue (linked from the GitHub issue).
- A GitHub issue with the postmortem template from `RUNBOOK.md` filled in.
- A status note (email to the user mailing list if any user impact ≥15 min).
- A line item in the weekly metrics review (p95 latency, error rate, uptime %).

Weekly review cadence: Friday afternoon, 30 min. Tracked as a recurring task.