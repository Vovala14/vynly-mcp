// Bookings live in one private JSON blob. Writes use the blob's ETag so two
// simultaneous requests can't silently overwrite each other.
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const PATH = 'bookings.json';
const LOCAL = !process.env.VERCEL && !process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL_FILE = new URL('../.data/bookings.json', import.meta.url);

async function read() {
  if (LOCAL) {
    try {
      return { bookings: JSON.parse(await readFile(LOCAL_FILE, 'utf8')), etag: null };
    } catch {
      return { bookings: [], etag: null };
    }
  }
  const res = await get(PATH, { access: 'private', useCache: false });
  if (!res || res.statusCode !== 200) return { bookings: [], etag: null };
  const text = await new Response(res.stream).text();
  return { bookings: JSON.parse(text), etag: res.blob.etag };
}

async function write(bookings, etag) {
  const body = JSON.stringify(bookings);
  if (LOCAL) {
    await mkdir(new URL('.', LOCAL_FILE), { recursive: true });
    await writeFile(LOCAL_FILE, body);
    return;
  }
  await put(PATH, body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 60,
    ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
  });
}

export async function listBookings() {
  return (await read()).bookings;
}

/**
 * Read-modify-write. `fn` gets the current list and returns the new list
 * (or throws to abort). Retries when another request wrote in between.
 */
export async function mutate(fn) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { bookings, etag } = await read();
    const result = await fn(bookings);
    try {
      await write(result.bookings, etag);
      return result.value;
    } catch (err) {
      const conflict =
        err instanceof BlobPreconditionFailedError || (!etag && /already exists/i.test(err?.message || ''));
      if (!conflict) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
