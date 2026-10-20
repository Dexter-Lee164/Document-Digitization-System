'use strict';
const { badRequest } = require('./errors');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Inspect the actual bytes of an upload (never the extension or the client supplied MIME type).
 * Returns { type: 'png'|'jpeg', mime, ext, width, height }. Throws a 400 AppError otherwise.
 * Full decoding (corruption check) is performed afterwards by the CV service.
 */
function inspectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw badRequest('The uploaded file is empty.', undefined, 'empty_file');
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') throw badRequest('The PNG file is corrupted.', undefined, 'invalid_image');
    return { type: 'png', mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const dims = jpegSize(buf);
    if (!dims) throw badRequest('The JPEG file is corrupted or has no image dimensions.', undefined, 'invalid_image');
    return { type: 'jpeg', mime: 'image/jpeg', ext: 'jpg', ...dims };
  }
  throw badRequest('Unsupported file type. Please upload a JPG or PNG image.', undefined, 'unsupported_type');
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) { i += 1; marker = buf[i + 1]; } // fill bytes
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0x00) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS reached without a SOF
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

module.exports = { inspectImage };
