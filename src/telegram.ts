export class TgError extends Error {
  constructor(public method: string, message: string, public code?: number) {
    super(message);
  }
}

export async function tg<T = any>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
  if (!j.ok) throw new TgError(method, j.description ?? 'telegram error', j.error_code);
  return j.result;
}
