/**
 * Minimal offline WAV recorder using Web Audio API (16 kHz mono 16-bit PCM).
 * Produces base64 WAV directly consumable by local `whisper-cli` with zero external libraries.
 */

export interface AudioRecordingSession {
  stop: () => Promise<{ audioBase64: string; durationMs: number }>;
  cancel: () => void;
}

function downsampleTo16k(samples: Float32Array, inputSampleRate: number): Int16Array {
  const targetRate = 16000;
  if (inputSampleRate <= targetRate) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / targetRate;
  const newLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.min(samples.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += samples[i];
      count++;
    }
    const avg = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, avg));
    out[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return out;
}

function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(offset, pcm[i], true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function startWavRecording(): Promise<AudioRecordingSession> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone recording is not available in this environment.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error('Web Audio API is unavailable for WAV recording.');
  }

  const audioCtx = new AudioCtx();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const startedAt = Date.now();
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const channelData = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(channelData));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);

  function cleanup() {
    stopped = true;
    processor.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) {
      track.stop();
    }
    void audioCtx.close().catch(() => undefined);
  }

  return {
    cancel() {
      cleanup();
    },
    async stop() {
      const sampleRate = audioCtx.sampleRate;
      const durationMs = Math.max(1, Date.now() - startedAt);
      cleanup();

      const totalSamples = chunks.reduce((sum, arr) => sum + arr.length, 0);
      const merged = new Float32Array(totalSamples);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      const pcm = downsampleTo16k(merged, sampleRate);
      const wavBytes = encodeWavPcm16(pcm, Math.min(sampleRate, 16000));
      return {
        audioBase64: bytesToBase64(wavBytes),
        durationMs,
      };
    },
  };
}
