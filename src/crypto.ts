const KEY_STORAGE = "mega-sync.local-key.v1";

async function getOrCreateLocalKey(): Promise<CryptoKey> {
  const stored = localStorage.getItem(KEY_STORAGE);
  if (stored) {
    const raw = base64ToBytes(stored);
    return crypto.subtle.importKey(
      "raw",
      toArrayBuffer(raw),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  localStorage.setItem(KEY_STORAGE, bytesToBase64(raw));
  return key;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

export async function encryptString(plaintext: string): Promise<string> {
  const key = await getOrCreateLocalKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(data)),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return bytesToBase64(out);
}

export async function decryptString(payload: string): Promise<string> {
  const key = await getOrCreateLocalKey();
  const bytes = base64ToBytes(payload);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    toArrayBuffer(cipher),
  );
  return new TextDecoder().decode(plain);
}

export function clearLocalKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
