/**
 * Byte-level metadata extraction, ported from back/src/media/media.service.ts.
 * Pure functions, no I/O — safe to duplicate without drift risk.
 */

export async function extractImageDimensions(buf: Buffer, mime: string): Promise<{ width: number | null; height: number | null }> {
  try {
    if (mime === 'image/png') {
      if (buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } else if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xFF) break;
        const marker = buf[i + 1];
        const len    = buf.readUInt16BE(i + 2);
        if ((marker >= 0xC0 && marker <= 0xC3) || marker === 0xC9 || marker === 0xCA) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    } else if (mime === 'image/webp') {
      if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8 ' && buf.length >= 30) {
          return { width: (buf[26] | (buf[27] << 8)) & 0x3FFF, height: (buf[28] | (buf[29] << 8)) & 0x3FFF };
        } else if (chunk === 'VP8L' && buf.length >= 25) {
          const bits = buf.readUInt32LE(21);
          return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
        }
      }
    }
  } catch { /* Non-fatal */ }
  return { width: null, height: null };
}

/** Locates a top-level MP4/ISO-BMFF box of the given type within [start, end), returning its content range (after the header). */
function findMp4Box(buf: Buffer, type: string, start: number, end: number): { start: number; end: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const boxType = buf.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    if (boxType === type) return { start: offset + headerSize, end: offset + size };
    offset += size;
  }
  return null;
}

export async function extractVideoMetadata(buf: Buffer, mime: string): Promise<{ width: number | null; height: number | null; durationSeconds: number | null }> {
  try {
    if (mime === 'video/mp4') {
      const moov = findMp4Box(buf, 'moov', 0, buf.length);
      const mvhd = moov && findMp4Box(buf, 'mvhd', moov.start, moov.end);
      if (mvhd) {
        const version = buf.readUInt8(mvhd.start);
        const timescale = version === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
        const duration  = version === 1 ? Number(buf.readBigUInt64BE(mvhd.start + 24)) : buf.readUInt32BE(mvhd.start + 16);
        if (timescale > 0) return { width: null, height: null, durationSeconds: Math.round(duration / timescale) };
      }
    }
  } catch { /* Non-fatal */ }
  return { width: null, height: null, durationSeconds: null };
}
