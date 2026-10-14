function b64d(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64e(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function importKey(master: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64d(master), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(master: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(master), new TextEncoder().encode(plain)),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64e(out);
}

export async function decrypt(master: string, data: string): Promise<string> {
  const raw = b64d(data);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await importKey(master), raw.slice(12));
  return new TextDecoder().decode(pt);
}

export function randomHex(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
