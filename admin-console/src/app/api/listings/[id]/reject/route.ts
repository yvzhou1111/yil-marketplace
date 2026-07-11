// POST /api/listings/[id]/reject — handles three intents:
//   - reject (default): pending -> rejected
//   - unreject: rejected -> pending
//   - remove: any -> removed (admin yank)
//
// The intent comes from either the form field `action` or the JSON body
// `action` so that the listings table can route all destructive actions
// through a single endpoint.
import { NextResponse } from 'next/server';
import { applyModeration, refreshMetricsSnapshot } from '@/lib/moderation';
import { requireAdmin } from '@/lib/db';

type Intent = 'reject' | 'unreject' | 'remove';
type Parsed = { action?: Intent; reason?: string };

const ALLOWED: ReadonlySet<Intent> = new Set(['reject', 'unreject', 'remove']);

async function readBody(req: Request): Promise<Parsed> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    return (await req.json().catch(() => ({}))) as Parsed;
  }
  const form = await req.formData().catch(() => null);
  const obj: Parsed = {};
  const a = form?.get('action')?.toString();
  const r = form?.get('reason')?.toString();
  if (a) obj.action = a as Intent;
  if (r) obj.reason = r;
  return obj;
}

function pickIntent(body: Parsed): Intent {
  const a = body.action ?? 'reject';
  return ALLOWED.has(a) ? a : 'reject';
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const admin = requireAdmin(req);
  const body = await readBody(req);
  const intent = pickIntent(body);

  const result = await applyModeration({
    listingId: params.id,
    action: intent,
    actor: admin,
    reason: body.reason,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.statusCode });
  }

  await refreshMetricsSnapshot().catch(() => null);

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('application/json')) {
    return NextResponse.json({ ok: true, status: result.newStatus });
  }
  const back = new URL('/admin/listings', req.url);
  back.searchParams.set('status', intent === 'reject' ? 'rejected' : 'pending');
  return NextResponse.redirect(back, 303);
}