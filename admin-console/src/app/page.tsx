// Root: bounce to the moderation queue — that's where admins live.
import { redirect } from 'next/navigation';
export default function Home() {
  redirect('/admin/listings');
}