// POST /api/listings/[id]/approve — flips a pending listing to approved.
import { NextResponse } from 'next/server';
import { applyModeration, refreshMetricsSnapshot } from '@/lib/moderation';
import { requireAdmin } from '@/lib/db';

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const admin = requireAdmin(req);
  const reason = (await req.formData().catch(() => null))?.get('reason')?.toString();

  const result = await applyModeration({
    listingId: params.id,
    action: 'approve',
    actor: admin,
    reason,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.statusCode });
  }

  // Best-effort snapshot refresh; failures shouldn't block the user-facing flow.
  await refreshMetricsSnapshot().catch(() => null);

  return NextResponse.redirect(new URL('/admin/listings?status=pending', req.url), 303);
}