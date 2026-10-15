import { decrypt } from './crypto';
import type { Env } from './types';

// token cache per isolate: tenantId -> { enc, token }
const cache = new Map<string, { enc: string; token: string }>();

export async function getToken(env: Env, tenantId: string, enc: string) {
  const hit = cache.get(tenantId);
  if (hit && hit.enc === enc) return hit.token;
  const token = await decrypt(env.MASTER_KEY, enc);
  cache.set(tenantId, { enc, token });
  return token;
}
