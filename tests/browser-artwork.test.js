import test from 'node:test';
import assert from 'node:assert/strict';
import { findEmbeddedPicture, imageInfo, thumbnailFromPicture } from '../src/browser-artwork.js';

const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const syncsafe = n => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const ascii = s => [...s].map(c => c.charCodeAt(0));
const png = (w = 64, h = 64, extra = 0) => new Uint8Array([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...ascii('IHDR'), ...u32(w), ...u32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...new Array(extra).fill(0)]);
const jpeg = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const reader = bytes => async (offset, length) => bytes.subarray(offset, offset + length);
const find = bytes => findEmbeddedPicture(reader(bytes), bytes.length);
function id3(frames, { major = 3, flags = 0 } = {}) {
  const body = new Uint8Array(frames.flat());
  return new Uint8Array([...ascii('ID3'), major, 0, flags, ...syncsafe(body.length), ...body]);
}
function apic(image, { type = 3, mime = 'image/png', major = 3 } = {}) {
  const body = [0, ...ascii(mime), 0, type, 0, ...image];
  return [...ascii('APIC'), ...(major === 4 ? syncsafe(body.length) : u32(body.length)), 0, 0, ...body];
}

test('image sniffing ignores declared types and enforces size and dimension limits', () => {
  assert.deepEqual(imageInfo(png(64, 48)), { mime: 'image/png', width: 64, height: 48 });
  assert.deepEqual(imageInfo(jpeg(300, 200)), { mime: 'image/jpeg', width: 300, height: 200 });
  assert.equal(imageInfo(png(4096, 64)), null); assert.equal(imageInfo(png(64, 2049)), null); assert.equal(imageInfo(png(0, 10)), null);
  assert.equal(imageInfo(jpeg(2049, 10)), null);
  assert.equal(imageInfo(new Uint8Array(ascii('http://example.test/cover.png padded to the minimum header size'))), null);
  assert.equal(imageInfo(png(64, 64, 2 * 1024 * 1024)), null);
  assert.equal(imageInfo(new Uint8Array(40).fill(7)), null);
});

test('ID3 APIC pictures are found, preferring the front cover, for v2.3 and v2.4', async () => {
  for (const major of [3, 4]) {
    const picture = await find(id3([apic(png(10, 10), { type: 0, major }), apic(png(32, 32), { type: 3, major })], { major }));
    assert.equal(picture.width, 32); assert.equal(picture.mime, 'image/png');
  }
  assert.equal((await find(id3([apic(jpeg(40, 30), { mime: 'image/jpeg' })]))).mime, 'image/jpeg');
});

test('linked or non-image artwork is rejected, never fetched', async () => {
  assert.equal(await find(id3([apic(ascii('http://example.test/cover.png'), { mime: '-->' })])), null);
  assert.equal(await find(id3([apic(png(5000, 5000))])), null);
  assert.equal(await find(new Uint8Array(100)), null);
});

test('FLAC PICTURE blocks and MP4 covr atoms are found', async () => {
  const image = png(48, 48), mime = ascii('image/png');
  const picture = [...u32(3), ...u32(mime.length), ...mime, ...u32(0), ...u32(48), ...u32(48), ...u32(24), ...u32(0), ...u32(image.length), ...image];
  const streaminfo = new Array(34).fill(0);
  const flac = new Uint8Array([...ascii('fLaC'), 0, 0, 0, 34, ...streaminfo, 0x86, (picture.length >> 16) & 255, (picture.length >> 8) & 255, picture.length & 255, ...picture]);
  assert.equal((await find(flac)).width, 48);
  const data = [...u32(16 + image.length), ...ascii('data'), ...u32(14), ...u32(0), ...image];
  const covr = [...u32(8 + data.length), ...ascii('covr'), ...data], ilst = [...u32(8 + covr.length), ...ascii('ilst'), ...covr];
  const meta = [...u32(12 + ilst.length), ...ascii('meta'), 0, 0, 0, 0, ...ilst], udta = [...u32(8 + meta.length), ...ascii('udta'), ...meta];
  const moov = [...u32(8 + udta.length), ...ascii('moov'), ...udta], ftyp = [...u32(16), ...ascii('ftyp'), ...ascii('M4A '), 0, 0, 0, 0];
  const m4a = new Uint8Array([...ftyp, ...u32(8 + 24), ...ascii('mdat'), ...new Array(24).fill(1), ...moov]);
  assert.equal((await find(m4a)).width, 48);
});

test('thumbnails are metadata-free PNG data URLs within the registry limits or absent', async () => {
  const environment = { createImageBitmap: async () => ({ close() {} }), document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,iVBOR' + 'A'.repeat(900) }) } };
  const url = await thumbnailFromPicture({ ...(await find(id3([apic(png())]))) }, environment);
  assert.match(url, /^data:image\/png;base64,iVBOR/); assert.ok(url.length <= 22000);
  const huge = { ...environment, document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,iVBOR' + 'A'.repeat(30000) }) } };
  assert.equal(await thumbnailFromPicture({ mime: 'image/png', width: 64, height: 64, data: png() }, huge), null);
  assert.equal(await thumbnailFromPicture({ mime: 'image/png', width: 64, height: 64, data: new Uint8Array(30) }, environment), null);
  assert.equal(await thumbnailFromPicture(null, environment), null);
});
