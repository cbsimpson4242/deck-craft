// Embedded cover art for the browser backend. Tags are parsed under explicit
// byte limits from local Blob slices; only sniffed JPEG/PNG within size and
// dimension limits is ever decoded, then reduced to a metadata-free PNG data
// URL. Linked or remote artwork is never fetched.

const MAX_ENCODED = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;
const MAX_TAG = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 16384;
const text = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const syncsafe = (b, o) => ((b[o] & 127) << 21) | ((b[o + 1] & 127) << 14) | ((b[o + 2] & 127) << 7) | (b[o + 3] & 127);

/** Sniffs magic bytes and header dimensions; the declared MIME type is never trusted. */
export function imageInfo(bytes) {
  if (!bytes || bytes.length < 24 || bytes.length > MAX_ENCODED) return null;
  if (bytes[0] === 0x89 && text(bytes, 1, 4) === 'PNG' && u32(bytes, 4) === 0x0d0a1a0a) {
    if (text(bytes, 12, 16) !== 'IHDR') return null;
    const width = u32(bytes, 16), height = u32(bytes, 20);
    return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { mime: 'image/png', width, height } : null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const height = (bytes[i + 5] << 8) | bytes[i + 6], width = (bytes[i + 7] << 8) | bytes[i + 8];
        return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { mime: 'image/jpeg', width, height } : null;
      }
      i += 2 + length;
    }
  }
  return null;
}

function undoUnsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) { out[n++] = bytes[i]; if (bytes[i] === 0xff && bytes[i + 1] === 0) i++; }
  return out.subarray(0, n);
}
function terminated(bytes, start, encoding) {
  const wide = encoding === 1 || encoding === 2;
  for (let i = start; i + (wide ? 1 : 0) < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) return i + (wide ? 2 : 1);
  }
  return -1;
}
function apic(body) {
  if (body.length < 8) return null;
  const encoding = body[0];
  let at = terminated(body, 1, 0);
  if (at < 0 || at >= body.length) return null;
  const type = body[at];
  at = terminated(body, at + 1, encoding);
  return at < 0 ? null : { type, data: body.subarray(at) };
}
/** First front-cover (else any) picture from an ID3v2.3/2.4 tag body. */
function id3Picture(tag, major, flags) {
  let body = tag, at = 0;
  if (major === 3 && flags & 0x80) body = undoUnsync(body);
  if (flags & 0x40 && body.length >= 6) at = major === 4 ? syncsafe(body, 0) : 4 + u32(body, 0);
  let fallback = null;
  while (at + 10 <= body.length && body[at] !== 0) {
    const id = text(body, at, at + 4), size = major === 4 ? syncsafe(body, at + 4) : u32(body, at + 4), frameFlags = body[at + 9];
    const start = at + 10, end = start + size;
    if (size < 0 || end > body.length) break;
    if (id === 'APIC') {
      let content = body.subarray(start, end);
      if (major === 4 && frameFlags & 0x02) content = undoUnsync(content);
      const picture = apic(content);
      if (picture && imageInfo(picture.data)) { if (picture.type === 3) return picture.data; fallback ||= picture.data; }
    }
    at = end;
  }
  return fallback;
}
function flacPicture(body) {
  if (body.length < 32) return null;
  let at = 4;
  const mimeLength = u32(body, at); at += 4 + mimeLength;
  if (at + 4 > body.length) return null;
  const descriptionLength = u32(body, at); at += 4 + descriptionLength + 16;
  if (at + 4 > body.length) return null;
  const length = u32(body, at); at += 4;
  return at + length <= body.length ? body.subarray(at, at + length) : null;
}
function mp4Cover(moov) {
  const walk = (start, end, path) => {
    let at = start;
    while (at + 8 <= end) {
      let size = u32(moov, at);
      const type = text(moov, at + 4, at + 8);
      if (size < 8 || at + size > end) return null;
      const next = at + size;
      if (path.length === 0 && type === 'udta') { const found = walk(at + 8, next, ['udta']); if (found) return found; }
      else if (path[0] === 'udta' && type === 'meta') { const found = walk(at + 12, next, ['meta']); if (found) return found; }
      else if (path[0] === 'meta' && type === 'ilst') { const found = walk(at + 8, next, ['ilst']); if (found) return found; }
      else if (path[0] === 'ilst' && type === 'covr') {
        let item = at + 8;
        while (item + 16 <= next) {
          const length = u32(moov, item);
          if (length < 16 || item + length > next) break;
          if (text(moov, item + 4, item + 8) === 'data') { const data = moov.subarray(item + 16, item + length); if (imageInfo(data)) return data; }
          item += length;
        }
      }
      at = next;
    }
    return null;
  };
  return walk(0, moov.length, []);
}

/**
 * Finds embedded art with bounded reads. `read(offset, length)` resolves a
 * Uint8Array and `size` is the file size. Returns {mime,width,height,data} or null.
 */
export async function findEmbeddedPicture(read, size) {
  let data = null;
  const head = await read(0, Math.min(size, 16));
  let offset = 0;
  if (text(head, 0, 3) === 'ID3' && head.length >= 10) {
    const major = head[3], flags = head[5], length = syncsafe(head, 6);
    if ((major === 3 || major === 4) && length > 0 && length <= MAX_TAG && 10 + length <= size) {
      data = id3Picture(await read(10, length), major, flags);
    }
    offset = 10 + length + (flags & 0x10 ? 10 : 0);
  }
  if (!data) {
    const marker = await read(offset, Math.min(Math.max(size - offset, 0), 12));
    if (text(marker, 0, 4) === 'fLaC') {
      let at = offset + 4;
      for (let blocks = 0; blocks < 128 && at + 4 <= size && !data; blocks++) {
        const header = await read(at, 4), last = header[0] & 0x80, type = header[0] & 0x7f, length = (header[1] << 16) | (header[2] << 8) | header[3];
        if (type === 6 && length <= MAX_TAG && at + 4 + length <= size) data = flacPicture(await read(at + 4, length));
        at += 4 + length;
        if (last) break;
      }
    } else if (text(marker, 4, 8) === 'ftyp') {
      let at = offset;
      for (let atoms = 0; atoms < 64 && at + 8 <= size && !data; atoms++) {
        const header = await read(at, 16);
        let length = u32(header, 0), headerSize = 8;
        if (length === 1) { if (u32(header, 8) !== 0) break; length = u32(header, 12); headerSize = 16; }
        if (length === 0) length = size - at;
        if (length < headerSize) break;
        if (text(header, 4, 8) === 'moov' && length - headerSize <= MAX_TAG && at + length <= size) data = mp4Cover(await read(at + headerSize, length - headerSize));
        at += length;
      }
    }
  }
  const info = data ? imageInfo(data) : null;
  return info ? { ...info, data } : null;
}

/** Reduces a validated picture to a metadata-free 64×64 PNG data URL (browser only), or null. */
export async function thumbnailFromPicture(picture, environment = globalThis) {
  try {
    const { createImageBitmap, document } = environment;
    if (!picture || !imageInfo(picture.data) || typeof createImageBitmap !== 'function' || !document) return null;
    const bitmap = await createImageBitmap(new Blob([picture.data], { type: picture.mime }));
    for (const edge of [64, 48]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = edge;
      const context = canvas.getContext('2d');
      context.fillStyle = '#000';
      context.fillRect(0, 0, edge, edge);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, edge, edge);
      const url = canvas.toDataURL('image/png');
      if (/^data:image\/png;base64,iVBOR[A-Za-z0-9+/]*={0,2}$/.test(url) && url.length <= 22000 && (url.length - 22) * 3 / 4 <= MAX_THUMBNAIL_BYTES + 3) { bitmap.close?.(); return url; }
    }
    bitmap.close?.();
  } catch { /* undecodable art is simply omitted */ }
  return null;
}
