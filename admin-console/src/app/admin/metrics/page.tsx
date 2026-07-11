// /admin/metrics — basic dashboard. Reads from admin.metrics_snapshot which
// is refreshed on every moderation action. If the snapshot is stale (the
// server was bounced, or this is a fresh deploy), it is recomputed on read.
import { pool } from '@/lib/db';
import { refreshMetricsSnapshot } from '@/lib/moderation';

export const dynamic = 'force-dynamic';

type Snapshot = {
  captured_at: string;
  users_total: number;
  users_last_7d: number;
  listings_total: number;
  listings_pending: number;
  listings_approved: number;
  listings_rejected: number;
  gross_listings_value_cents: number;
};

async function getSnapshot(): Promise<Snapshot | null> {
  const cur = await pool.query<Snapshot>(
    `select * from admin.metrics_snapshot order by captured_at desc limit 1`,
  );
  if (cur.rowCount === 0) {
    await refreshMetricsSnapshot();
    const again = await pool.query<Snapshot>(
      `select * from admin.metrics_snapshot order by captured_at desc limit 1`,
    );
    return again.rows[0] ?? null;
  }
  const row = cur.rows[0];
  // If snapshot is older than 10 minutes, refresh in the background and keep
  // serving the existing one. Background refresh failure is non-fatal.
  const ageMs = Date.now() - new Date(row.captured_at).getTime();
  if (ageMs > 10 * 60 * 1000) {
    void refreshMetricsSnapshot().catch(() => null);
  }
  return row;
}

export default async function MetricsPage() {
  const snap = await getSnapshot();
  if (!snap) {
    return <p className="flash error">Metrics snapshot is unavailable.</p>;
  }

  const approvalRate = snap.listings_total > 0
    ? ((snap.listings_approved / snap.listings_total) * 100).toFixed(1)
    : '0.0';
  const captureAge = Math.round(
    (Date.now() - new Date(snap.captured_at).getTime()) / 1000,
  );

  return (
    <div>
      <h1>Metrics dashboard</h1>
      <p className="muted">
        Snapshot taken {new Date(snap.captured_at).toLocaleString()} ({captureAge}s ago).
        Refreshed automatically when moderation events occur.
      </p>

      <h2>Users</h2>
      <div className="metric-grid">
        <Metric label="Total users" value={snap.users_total.toLocaleString()} />
        <Metric label="New in last 7 days" value={snap.users_last_7d.toLocaleString()} />
      </div>

      <h2>Listings</h2>
      <div className="metric-grid">
        <Metric label="Total" value={snap.listings_total.toLocaleString()} />
        <Metric label="Pending review" value={snap.listings_pending.toLocaleString()} warn={snap.listings_pending > 10} />
        <Metric label="Approved" value={snap.listings_approved.toLocaleString()} />
        <Metric label="Rejected" value={snap.listings_rejected.toLocaleString()} />
        <Metric label="Approval rate" value={`${approvalRate}%`} />
      </div>

      <h2>Catalog value</h2>
      <div className="metric-grid">
        <Metric
          label="Approved listings gross"
          value={formatCents(snap.gross_listings_value_cents)}
        />
      </div>
    </div>
  );
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="metric">
      <div className="label">{label}</div>
      <div className="value" style={warn ? { color: 'var(--warn)' } : undefined}>
        {value}
      </div>
    </div>
  );
}

function formatCents(cents: number): string {
  return `USD ${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}