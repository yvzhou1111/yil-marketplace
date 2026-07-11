// Root layout. Deliberately hand-rolled and simple. No design system, no
// external font — admin consoles should be readable, not pretty.
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'YIL Admin Console',
  description: 'Internal moderation, lookup, and metrics for the YIL marketplace.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">YIL Admin</div>
          <nav>
            <a href="/admin/listings">Listings</a>
            <a href="/admin/users">Users</a>
            <a href="/admin/metrics">Metrics</a>
          </nav>
        </header>
        <main className="main">{children}</main>
      </body>
    </html>
  );
}
