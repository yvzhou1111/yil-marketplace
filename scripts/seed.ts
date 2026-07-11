/**
 * Seed the marketplace with realistic baseline data so a fresh `npm run dev`
 * has something to look at on the first page load, and so every later story
 * (seller CRUD, browse, search, payments, reviews) has fixtures to point at.
 *
 * Scope (YIL-5):
 *   - 8 categories spanning the core verticals of a used-goods marketplace.
 *   - 5 users (1 admin, 4 sellers). Auth fields are intentionally left null
 *     for now — YIL-4 will fill them in.
 *   - 12 listings spread across sellers, statuses, and categories.
 *   - 1–4 images per listing, with deterministic S3-shaped storage keys.
 *   - Each listing gets 1–2 categories via listing_categories.
 *
 * Idempotency: this script wipes the seedable tables before re-inserting.
 * It is intended for local dev and CI smoke. Never point it at prod.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import {
  categories,
  images,
  listingCategories,
  listings,
  users,
} from "../src/db/schema";

type SeedCategory = {
  slug: string;
  name: string;
  description: string;
  position: number;
};

type SeedUser = {
  handle: string;
  displayName: string;
  email: string;
  bio: string;
  avatarUrl: string | null;
  role: "buyer" | "seller" | "admin";
  emailVerified: boolean;
};

type SeedListing = {
  sellerHandle: string;
  title: string;
  description: string;
  amountCents: number;
  currency: string;
  status: "draft" | "published" | "sold" | "archived";
  location: string;
  categorySlugs: string[];
  images: Array<{ key: string; url: string; alt: string; w: number; h: number }>;
};

const CATEGORIES: SeedCategory[] = [
  {
    slug: "electronics",
    name: "Electronics",
    description: "Phones, computers, audio, and accessories.",
    position: 0,
  },
  {
    slug: "fashion",
    name: "Fashion",
    description: "Clothing, shoes, and accessories for every season.",
    position: 1,
  },
  {
    slug: "home",
    name: "Home & Kitchen",
    description: "Furniture, decor, and small appliances.",
    position: 2,
  },
  {
    slug: "books",
    name: "Books",
    description: "Fiction, non-fiction, and rare finds.",
    position: 3,
  },
  {
    slug: "sports",
    name: "Sports & Outdoors",
    description: "Gear for cycling, hiking, and the gym.",
    position: 4,
  },
  {
    slug: "music",
    name: "Musical Instruments",
    description: "Guitars, keys, and studio gear.",
    position: 5,
  },
  {
    slug: "art",
    name: "Art & Collectibles",
    description: "Prints, ceramics, and one-of-a-kind pieces.",
    position: 6,
  },
  {
    slug: "games",
    name: "Games & Toys",
    description: "Board games, vintage toys, and puzzles.",
    position: 7,
  },
];

const USERS: SeedUser[] = [
  {
    handle: "admin",
    email: "admin@seed.yil.local",
    displayName: "YIL Admin",
    bio: "Platform administrator.",
    avatarUrl: null,
    role: "admin",
    emailVerified: true,
  },
  {
    handle: "amelia-rivera",
    email: "amelia-rivera@seed.yil.local",
    displayName: "Amelia Rivera",
    bio: "Brooklyn-based seller of mid-century furniture and vinyl.",
    avatarUrl: "https://cdn.example.com/avatars/amelia-rivera.jpg",
    role: "seller",
    emailVerified: true,
  },
  {
    handle: "kenji-park",
    email: "kenji-park@seed.yil.local",
    displayName: "Kenji Park",
    bio: "Camera nerd. Selling my collection of film bodies and lenses.",
    avatarUrl: "https://cdn.example.com/avatars/kenji-park.jpg",
    role: "seller",
    emailVerified: true,
  },
  {
    handle: "priya-shah",
    email: "priya-shah@seed.yil.local",
    displayName: "Priya Shah",
    bio: "Re-selling kids' books and toys in great condition.",
    avatarUrl: "https://cdn.example.com/avatars/priya-shah.jpg",
    role: "seller",
    emailVerified: true,
  },
  {
    handle: "tomas-lindgren",
    email: "tomas-lindgren@seed.yil.local",
    displayName: "Tomas Lindgren",
    bio: "Bicycle mechanic. Bikes, parts, and accessories.",
    avatarUrl: "https://cdn.example.com/avatars/tomas-lindgren.jpg",
    role: "seller",
    emailVerified: false,
  },
];

const LISTINGS: SeedListing[] = [
  {
    sellerHandle: "amelia-rivera",
    title: "Mid-century walnut side table",
    description:
      "Solid walnut, original brass legs, light patina on the top. " +
      "Local pickup preferred in Brooklyn; can ship at cost.",
    amountCents: 24500,
    currency: "USD",
    status: "published",
    location: "Brooklyn, NY",
    categorySlugs: ["home"],
    images: [
      {
        key: "seed/amelia/side-table-1.jpg",
        url: "https://cdn.example.com/seed/amelia/side-table-1.jpg",
        alt: "Walnut side table at an angle",
        w: 1200,
        h: 900,
      },
      {
        key: "seed/amelia/side-table-2.jpg",
        url: "https://cdn.example.com/seed/amelia/side-table-2.jpg",
        alt: "Detail of brass leg",
        w: 1200,
        h: 900,
      },
    ],
  },
  {
    sellerHandle: "amelia-rivera",
    title: "Vinyl box set — Pink Floyd DSOTM (1973 UK 1st press)",
    description:
      "Played twice, vinyl NM, cover VG+. Includes the original postcards.",
    amountCents: 32000,
    currency: "USD",
    status: "published",
    location: "Brooklyn, NY",
    categorySlugs: ["music"],
    images: [
      {
        key: "seed/amelia/dsotm-cover.jpg",
        url: "https://cdn.example.com/seed/amelia/dsotm-cover.jpg",
        alt: "Dark Side of the Moon gatefold cover",
        w: 1000,
        h: 1000,
      },
    ],
  },
  {
    sellerHandle: "kenji-park",
    title: "Leica M6 (1990, black chrome)",
    description:
      "Body only. Recent CLA from YYE Camera. Light brassing on the " +
      "top plate. Comes with original strap.",
    amountCents: 295000,
    currency: "USD",
    status: "published",
    location: "Los Angeles, CA",
    categorySlugs: ["electronics"],
    images: [
      {
        key: "seed/kenji/leica-m6-front.jpg",
        url: "https://cdn.example.com/seed/kenji/leica-m6-front.jpg",
        alt: "Leica M6 front view",
        w: 1600,
        h: 1067,
      },
      {
        key: "seed/kenji/leica-m6-top.jpg",
        url: "https://cdn.example.com/seed/kenji/leica-m6-top.jpg",
        alt: "Leica M6 top plate",
        w: 1600,
        h: 1067,
      },
      {
        key: "seed/kenji/leica-m6-back.jpg",
        url: "https://cdn.example.com/seed/kenji/leica-m6-back.jpg",
        alt: "Leica M6 back with film door open",
        w: 1600,
        h: 1067,
      },
    ],
  },
  {
    sellerHandle: "kenji-park",
    title: "Voigtländer Nokton 35mm f/1.4 II (SC)",
    description: "Single-coated version. Mint glass, clean focus ring.",
    amountCents: 55000,
    currency: "USD",
    status: "published",
    location: "Los Angeles, CA",
    categorySlugs: ["electronics"],
    images: [
      {
        key: "seed/kenji/nokton-35.jpg",
        url: "https://cdn.example.com/seed/kenji/nokton-35.jpg",
        alt: "Voigtländer 35mm lens",
        w: 1400,
        h: 933,
      },
    ],
  },
  {
    sellerHandle: "priya-shah",
    title: "Children's picture books — lot of 12",
    description:
      "All in very good condition. Titles include The Snowy Day, " +
      "Where the Wild Things Are, and Harold and the Purple Crayon.",
    amountCents: 4500,
    currency: "USD",
    status: "published",
    location: "Austin, TX",
    categorySlugs: ["books"],
    images: [
      {
        key: "seed/priya/book-lot.jpg",
        url: "https://cdn.example.com/seed/priya/book-lot.jpg",
        alt: "Stack of children's picture books",
        w: 1200,
        h: 800,
      },
    ],
  },
  {
    sellerHandle: "priya-shah",
    title: "Melissa & Doug wooden puzzle set",
    description: "Three puzzles, ages 2–4. All pieces present.",
    amountCents: 1800,
    currency: "USD",
    status: "published",
    location: "Austin, TX",
    categorySlugs: ["games"],
    images: [
      {
        key: "seed/priya/puzzle.jpg",
        url: "https://cdn.example.com/seed/priya/puzzle.jpg",
        alt: "Wooden puzzle pieces",
        w: 1200,
        h: 800,
      },
      {
        key: "seed/priya/puzzle-box.jpg",
        url: "https://cdn.example.com/seed/priya/puzzle-box.jpg",
        alt: "Puzzle original box",
        w: 1200,
        h: 800,
      },
    ],
  },
  {
    sellerHandle: "tomas-lindgren",
    title: "Trek FX 3 hybrid bike (size M, 2022)",
    description:
      "Ridden one season. New chain and brake pads. Includes lock and " +
      "front light. Pickup only.",
    amountCents: 78000,
    currency: "USD",
    status: "published",
    location: "Portland, OR",
    categorySlugs: ["sports"],
    images: [
      {
        key: "seed/tomas/trek-fx3-1.jpg",
        url: "https://cdn.example.com/seed/tomas/trek-fx3-1.jpg",
        alt: "Trek FX 3 drivetrain side",
        w: 1600,
        h: 1067,
      },
      {
        key: "seed/tomas/trek-fx3-2.jpg",
        url: "https://cdn.example.com/seed/tomas/trek-fx3-2.jpg",
        alt: "Trek FX 3 cockpit",
        w: 1600,
        h: 1067,
      },
    ],
  },
  {
    sellerHandle: "tomas-lindgren",
    title: "Continental Gatorskin 700x32c (pair)",
    description: "Mounted for ~300 miles, plenty of tread left.",
    amountCents: 3500,
    currency: "USD",
    status: "published",
    location: "Portland, OR",
    categorySlugs: ["sports"],
    images: [
      {
        key: "seed/tomas/gatorskin.jpg",
        url: "https://cdn.example.com/seed/tomas/gatorskin.jpg",
        alt: "Pair of black bike tires",
        w: 1200,
        h: 800,
      },
    ],
  },
  {
    sellerHandle: "amelia-rivera",
    title: "Hand-thrown stoneware vase",
    description:
      "Local ceramicist, signed on the base. 9 inches tall, matte " +
      "sand glaze.",
    amountCents: 9500,
    currency: "USD",
    status: "draft",
    location: "Brooklyn, NY",
    categorySlugs: ["art", "home"],
    images: [
      {
        key: "seed/amelia/vase.jpg",
        url: "https://cdn.example.com/seed/amelia/vase.jpg",
        alt: "Stoneware vase on a wooden shelf",
        w: 1200,
        h: 1500,
      },
    ],
  },
  {
    sellerHandle: "kenji-park",
    title: "Contax T2 (titanium, 1991)",
    description: "Working perfectly. Light scratches on the body.",
    amountCents: 165000,
    currency: "USD",
    status: "sold",
    location: "Los Angeles, CA",
    categorySlugs: ["electronics"],
    images: [
      {
        key: "seed/kenji/contax-t2.jpg",
        url: "https://cdn.example.com/seed/kenji/contax-t2.jpg",
        alt: "Contax T2 front",
        w: 1400,
        h: 933,
      },
    ],
  },
  {
    sellerHandle: "priya-shah",
    title: "Wool winter coat, kids' size 6",
    description: "Navy, gently used. From a smoke-free home.",
    amountCents: 2200,
    currency: "USD",
    status: "archived",
    location: "Austin, TX",
    categorySlugs: ["fashion"],
    images: [
      {
        key: "seed/priya/wool-coat.jpg",
        url: "https://cdn.example.com/seed/priya/wool-coat.jpg",
        alt: "Navy wool coat on hanger",
        w: 1200,
        h: 1600,
      },
    ],
  },
  {
    sellerHandle: "tomas-lindgren",
    title: "Pearl Izumi cycling jersey (L)",
    description: "Black with reflective accents. New with tags.",
    amountCents: 4000,
    currency: "USD",
    status: "published",
    location: "Portland, OR",
    categorySlugs: ["fashion", "sports"],
    images: [
      {
        key: "seed/tomas/jersey.jpg",
        url: "https://cdn.example.com/seed/tomas/jersey.jpg",
        alt: "Cycling jersey laid flat",
        w: 1200,
        h: 1200,
      },
    ],
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  console.log("🌱 Wiping seedable tables…");
  // Order matters because of FKs.
  await db.execute(sql`DELETE FROM listing_categories`);
  await db.execute(sql`DELETE FROM images`);
  await db.execute(sql`DELETE FROM listings`);
  await db.execute(sql`DELETE FROM categories`);
  await db.execute(sql`DELETE FROM users`);

  console.log("🌱 Inserting categories…");
  const insertedCategories = await db
    .insert(categories)
    .values(CATEGORIES)
    .returning();
  const categoryBySlug = new Map(insertedCategories.map((c) => [c.slug, c]));

  console.log("🌱 Inserting users…");
  const insertedUsers = await db.insert(users).values(USERS).returning();
  const userByHandle = new Map(insertedUsers.map((u) => [u.handle, u]));

  console.log("🌱 Inserting listings, images, categories…");
  let imageCount = 0;
  let linkCount = 0;
  for (const seed of LISTINGS) {
    const seller = userByHandle.get(seed.sellerHandle);
    if (!seller) {
      throw new Error(`Unknown seller handle: ${seed.sellerHandle}`);
    }
    const [listing] = await db
      .insert(listings)
      .values({
        sellerId: seller.id,
        title: seed.title,
        description: seed.description,
        amountCents: seed.amountCents,
        currency: seed.currency,
        status: seed.status,
        location: seed.location,
      })
      .returning();

    if (seed.images.length > 0) {
      await db.insert(images).values(
        seed.images.map((img, i) => ({
          listingId: listing.id,
          storageKey: img.key,
          url: img.url,
          altText: img.alt,
          width: img.w,
          height: img.h,
          position: i,
        }))
      );
      imageCount += seed.images.length;
    }

    for (const slug of seed.categorySlugs) {
      const cat = categoryBySlug.get(slug);
      if (!cat) {
        throw new Error(`Unknown category slug: ${slug}`);
      }
      await db
        .insert(listingCategories)
        .values({ listingId: listing.id, categoryId: cat.id });
      linkCount++;
    }
  }

  console.log("");
  console.log("✅ Seed complete:");
  console.log(`   users:     ${insertedUsers.length}`);
  console.log(`   categories:${insertedCategories.length}`);
  console.log(`   listings:  ${LISTINGS.length}`);
  console.log(`   images:    ${imageCount}`);
  console.log(`   category links: ${linkCount}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});