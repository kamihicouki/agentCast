/**
 * Utilities for handling Gemini TTS audio responses:
 * - Gemini 3.8 TTS unary calls return complete WAV files (starting with "RIFF")
 * - Gemini 2.5 / streaming TTS calls return raw 16-bit signed little-endian mono PCM (audio/L16;rate=24000)
 */

export function base64ToUint8Array(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isRiffWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 44 &&
    bytes[0] === 0x52 && // 'R'
    bytes[1] === 0x49 && // 'I'
    bytes[2] === 0x46 && // 'F'
    bytes[3] === 0x46 // 'F'
  );
}

export function wrapPcm16ToWav(
  pcmBytes: Uint8Array,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16
): Uint8Array {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBytes.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  const out = new Uint8Array(buffer);
  out.set(pcmBytes, 44);
  return out;
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function ensurePlayableAudioBlob(
  rawBytes: Uint8Array,
  mimeType = 'audio/L16;codec=pcm;rate=24000'
): { blob: Blob; durationSec: number; mimeType: string } {
  const lowerMime = mimeType.toLowerCase();

  if (lowerMime.includes('mpeg') || lowerMime.includes('mp3')) {
    // Approximate MP3 duration at ~128kbps if metadata not decoded yet
    const approxDuration = Math.max(1, Math.round(rawBytes.byteLength / 16000));
    return {
      blob: new Blob([toBlobPart(rawBytes)], { type: 'audio/mpeg' }),
      durationSec: approxDuration,
      mimeType: 'audio/mpeg',
    };
  }

  const rateMatch = /rate=(\d+)/i.exec(mimeType);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;

  if (isRiffWav(rawBytes)) {
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const wavSampleRate = view.getUint32(24, true) || sampleRate;
    const byteRate = view.getUint32(28, true) || wavSampleRate * 2;
    const payloadBytes = Math.max(0, rawBytes.byteLength - 44);
    const durationSec = Math.max(1, Math.round((payloadBytes / byteRate) * 10) / 10);
    return {
      blob: new Blob([toBlobPart(rawBytes)], { type: 'audio/wav' }),
      durationSec,
      mimeType: 'audio/wav',
    };
  }

  const wavBytes = wrapPcm16ToWav(rawBytes, sampleRate, 1, 16);
  const durationSec = Math.max(1, Math.round((rawBytes.byteLength / (sampleRate * 2)) * 10) / 10);
  return {
    blob: new Blob([toBlobPart(wavBytes)], { type: 'audio/wav' }),
    durationSec,
    mimeType: 'audio/wav',
  };
}

/**
 * Merges multiple chapter audio blobs into a single playable WAV (or MP3) file,
 * inserting a clean 0.6s silence pause between WAV chapters.
 */
export async function mergeAudioBlobs(
  blobs: Array<{ blob: Blob; mimeType: string }>
): Promise<{ blob: Blob; mimeType: string; ext: 'wav' | 'mp3' }> {
  if (blobs.length === 0) {
    throw new Error('結合可能な音声データがありません。');
  }

  const allMp3 = blobs.every((b) => b.mimeType.includes('mpeg') || b.mimeType.includes('mp3'));
  if (allMp3) {
    const parts = await Promise.all(blobs.map((b) => b.blob.arrayBuffer()));
    return {
      blob: new Blob(parts, { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      ext: 'mp3',
    };
  }

  let sampleRate = 24000;
  let numChannels = 1;
  let bitsPerSample = 16;
  const pcmSegments: Uint8Array[] = [];

  for (const item of blobs) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    if (isRiffWav(bytes)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      numChannels = view.getUint16(22, true) || 1;
      sampleRate = view.getUint32(24, true) || 24000;
      bitsPerSample = view.getUint16(34, true) || 16;

      // Locate the "data" subchunk safely (handles extended WAV headers)
      let offset = 12;
      let dataStart = 44;
      let dataLen = bytes.byteLength - 44;
      while (offset + 8 <= bytes.byteLength) {
        const chunkId = String.fromCharCode(
          bytes[offset],
          bytes[offset + 1],
          bytes[offset + 2],
          bytes[offset + 3]
        );
        const chunkSize = view.getUint32(offset + 4, true);
        if (chunkId === 'data') {
          dataStart = offset + 8;
          dataLen = Math.min(chunkSize, bytes.byteLength - dataStart);
          break;
        }
        offset += 8 + chunkSize + (chunkSize % 2);
      }
      pcmSegments.push(bytes.subarray(dataStart, dataStart + dataLen));
    } else {
      pcmSegments.push(bytes);
    }
  }

  const bytesPerSample = (bitsPerSample / 8) * numChannels;
  const gapBytes = Math.round(sampleRate * 0.6) * bytesPerSample;
  const totalPcmBytes =
    pcmSegments.reduce((sum, seg) => sum + seg.byteLength, 0) +
    Math.max(0, pcmSegments.length - 1) * gapBytes;

  const mergedPcm = new Uint8Array(totalPcmBytes);
  let cursor = 0;
  for (let i = 0; i < pcmSegments.length; i++) {
    mergedPcm.set(pcmSegments[i], cursor);
    cursor += pcmSegments[i].byteLength;
    if (i < pcmSegments.length - 1) {
      cursor += gapBytes; // Zero-filled Uint8Array produces clean digital silence
    }
  }

  const finalWav = wrapPcm16ToWav(mergedPcm, sampleRate, numChannels, bitsPerSample);
  return {
    blob: new Blob([toBlobPart(finalWav)], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    ext: 'wav',
  };
}
