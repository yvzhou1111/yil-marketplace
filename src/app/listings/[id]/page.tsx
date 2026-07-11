/**
 * Public listing detail — `/listings/[id]`.
 *
 * Server component. Fetches the listing by id (with gallery, categories,
 * and seller profile) and renders:
 *   - Image gallery (clickable thumbs, full-size image on top)
 *   - Title, price, location, categories
 *   - Description
 *   - Seller card with avatar, member-since, and the "Contact seller"
 *     mailto CTA
 *
 * 404s are handled inline: a missing id renders a graceful not-found
 * message rather than throwing — the Next.js `notFound()` helper is
 * appropriate here too but a custom message reads better and lets us
 * keep the layout consistent.
 *
 * YIL-7.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { findById } from "@/listings/repo";
import {
  formatMemberSince,
  formatMoney,
  formatRelativePostedAt,
} from "@/listings/format";
import styles from "./detail.module.css";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const listing = await findById(db, params.id);
  if (!listing) {
    // `notFound()` triggers the closest `not-found.tsx` boundary, which
    // we don't ship yet — fall through to a 404 with the default Next.js
    // page. The function returns `never`, which lets TS narrow.
    notFound();
  }

  const gallery = listing.gallery;
  const hero = gallery[0] ?? null;
  const subject = encodeURIComponent(
    `Inquiry about "${listing.title}" on YIL Marketplace`
  );
  const body = encodeURIComponent(
    `Hi ${listing.seller.displayName},\n\n` +
      `I'm interested in your listing "${listing.title}" ` +
      `(${formatMoney(listing.price.amountCents, listing.price.currency)}).\n\n` +
      `Listing: /listings/${listing.id}\n\n` +
      `Thanks!`
  );
  const contactHref = `mailto:${listing.seller.contactEmail}?subject=${subject}&body=${body}`;

  return (
    <main className={styles.page}>
      <nav className={styles.crumbs}>
        <Link href="/listings" className={styles.crumbLink}>
          ← All listings
        </Link>
      </nav>

      <div className={styles.layout}>
        <section className={styles.gallerySection}>
          {hero ? (
            <div className={styles.hero}>
              <img
                src={hero.url}
                alt={hero.altText || listing.title}
                className={styles.heroImg}
              />
            </div>
          ) : (
            <PlaceholderHero title={listing.title} />
          )}

          {gallery.length > 1 && (
            <ul className={styles.thumbs}>
              {gallery.map((img, idx) => (
                <li key={img.id} className={styles.thumbWrap}>
                  <a href={img.url} className={styles.thumb} target="_blank" rel="noopener">
                    <img
                      src={img.url}
                      alt={img.altText || `${listing.title} photo ${idx + 1}`}
                      loading="lazy"
                    />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.info}>
          <header className={styles.header}>
            {listing.categories.length > 0 && (
              <ul className={styles.tagList}>
                {listing.categories.map((c) => (
                  <li key={c.id} className={styles.tag}>
                    {c.name}
                  </li>
                ))}
              </ul>
            )}
            <h1 className={styles.title}>{listing.title}</h1>
            <div className={styles.price}>
              {formatMoney(listing.price.amountCents, listing.price.currency)}
            </div>
            <div className={styles.meta}>
              {listing.location && (
                <span className={styles.metaItem}>📍 {listing.location}</span>
              )}
              <span className={styles.metaItem}>
                · Posted {formatRelativePostedAt(listing.createdAt)}
              </span>
            </div>
          </header>

          <a className={styles.cta} href={contactHref}>
            <span className={styles.ctaPrimary}>Contact seller</span>
            <span className={styles.ctaSub}>
              Opens your mail app addressed to {listing.seller.displayName}
            </span>
          </a>

          <section className={styles.description}>
            <h2 className={styles.sectionTitle}>About this listing</h2>
            <p className={styles.descriptionBody}>
              {listing.description || "No description provided."}
            </p>
          </section>

          <SellerCard seller={listing.seller} />

          <p className={styles.disclaimer}>
            {/* TODO: when the marketplace contact_requests table ships (a future
                YIL issue), swap this `mailto:` for an in-app form so the
                seller's address isn't directly exposed. */}
            Listing ID: <code>{listing.id}</code>
          </p>
        </section>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Seller card                                                                */
/* -------------------------------------------------------------------------- */

function SellerCard({
  seller,
}: {
  seller: {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl: string | null;
    memberSince: string;
  };
}) {
  const initials = seller.displayName
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside className={styles.sellerCard}>
      <div className={styles.sellerAvatar}>
        {seller.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={seller.avatarUrl} alt={seller.displayName} />
        ) : (
          <span className={styles.sellerInitials}>{initials || "?"}</span>
        )}
      </div>
      <div className={styles.sellerBody}>
        <div className={styles.sellerName}>{seller.displayName}</div>
        <div className={styles.sellerMeta}>
          @{seller.handle} · Member since {formatMemberSince(seller.memberSince)}
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero placeholder (offline-safe gradient)                                   */
/* -------------------------------------------------------------------------- */

function PlaceholderHero({ title }: { title: string }) {
  const hash = Array.from(title).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const hue1 = hash % 360;
  const hue2 = (hash * 11) % 360;
  return (
    <div
      className={styles.heroPlaceholder}
      style={{
        background: `linear-gradient(135deg, hsl(${hue1} 55% 70%), hsl(${hue2} 50% 45%))`,
      }}
      aria-label={title}
      role="img"
    >
      <span className={styles.heroPlaceholderText}>{title.slice(0, 2).toUpperCase()}</span>
    </div>
  );
}