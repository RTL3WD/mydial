let transcriber = null;
let transcriberName = "";

export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function resample(input, fromRate, toRate = 16000) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const mix = position - left;
    output[i] = input[left] * (1 - mix) + input[right] * mix;
  }
  return output;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

export async function transcribeLocal(samples, sampleRate, model, onStatus) {
  const audio = resample(samples, sampleRate, 16000);
  const chosen = model || "Xenova/whisper-tiny.en";
  if (!transcriber || transcriberName !== chosen) {
    onStatus?.(`Loading ${chosen.split("/").pop()} on this computer…`);
    const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    transcriber = await pipeline("automatic-speech-recognition", chosen, {
      progress_callback: (progress) => {
        if (progress.status === "progress" && progress.total) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          onStatus?.(`Downloading ${progress.file || "speech model"} ${pct}%`);
        }
      },
    });
    transcriberName = chosen;
  }
  onStatus?.("Transcribing on this computer");
  const result = await transcriber(audio);
  return String(result?.text || "").trim();
}

export async function attachMedia(media, { onClip, onStatus }) {
  const micStream = await media.mic;
  let tabStream = null;
  try {
    tabStream = await media.tab;
    if (tabStream instanceof Error || !tabStream?.getAudioTracks?.().length) tabStream = null;
  } catch {
    tabStream = null;
  }
  const context = new AudioContext();
  await context.audioWorklet.addModule("/vad-processor.js");
  const mute = context.createGain();
  mute.gain.value = 0;
  mute.connect(context.destination);
  const catchers = [];
  const addStream = async (stream, speaker) => {
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "capture-processor");
    const catcher = createCatcher(speaker, context.sampleRate, (clip) => onClip?.(clip));
    node.port.onmessage = (event) => catcher.push(event.data);
    source.connect(node);
    node.connect(mute);
    catchers.push({ stream, source, node, catcher });
  };
  await addStream(micStream, tabStream ? "Me" : "Prospect");
  if (tabStream) await addStream(tabStream, "Prospect");
  if (context.state === "suspended") await context.resume();
  onStatus?.(tabStream
    ? "Listening. Microphone is Me, shared tab audio is Prospect."
    : "Microphone only. Lines start as Prospect until you rename them.");
  return {
    mixed: !tabStream,
    stop() {
      for (const item of catchers) {
        item.catcher.flush();
        item.node.disconnect();
        item.source.disconnect();
        item.stream.getTracks().forEach((track) => track.stop());
      }
      context.close();
    },
  };
}

function createCatcher(speaker, sampleRate, onSpeech) {
  const chunks = [];
  let silenceMs = 0;
  let speaking = false;
  const flush = () => {
    if (!chunks.length) return;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    chunks.length = 0;
    const wasSpeaking = speaking;
    speaking = false;
    silenceMs = 0;
    if (!wasSpeaking || total < sampleRate * 0.45) return;
    onSpeech({ speaker, samples, sampleRate });
  };
  return {
    flush,
    push(frame) {
      let energy = 0;
      for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i];
      const rms = Math.sqrt(energy / frame.length);
      const frameMs = (frame.length / sampleRate) * 1000;
      if (rms > 0.02) {
        speaking = true;
        silenceMs = 0;
        chunks.push(frame);
      } else if (speaking) {
        chunks.push(frame);
        silenceMs += frameMs;
        if (silenceMs >= 850) flush();
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      if (total > sampleRate * 18) flush();
    },
  };
}
