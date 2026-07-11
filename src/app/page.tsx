/**
 * Marketplace landing — `/`.
 *
 * Static landing that links into the two top-level surfaces:
 *   - `/listings`  → public browse (YIL-7)
 *   - `/sell/...`  → seller area (YIL-6)
 *
 * YIL-7.
 */
import Link from "next/link";

export default function HomePage() {
  return (
    <main className="container">
      <h1>YIL Marketplace</h1>
      <p className="muted">
        A small, honest place to buy and sell from people nearby.
      </p>

      <section className="card">
        <h2>Browse</h2>
        <p>See what people are listing right now.</p>
        <p>
          <Link href="/listings" style={{ fontWeight: 600 }}>
            Browse listings →
          </Link>
        </p>
      </section>

      <section className="card">
        <h2>Sell</h2>
        <p>List something in minutes. Drafts stay private until you publish.</p>
        <p>
          <Link href="/sell/listings" style={{ fontWeight: 600 }}>
            Manage your listings →
          </Link>
        </p>
      </section>
    </main>
  );
}