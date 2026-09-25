// AudioWorklet module for the test-call page: mic capture → 16 kHz PCM16 frames, and a
// jitter-buffered player. See src/web/test-call.ts for the protocol.

// AudioWorkletGlobalScope (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const OUT_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz

class Capture extends AudioWorkletProcessor {
  step = sampleRate / OUT_RATE;
  t = 0; // read position in the current block; -1 = last sample of previous block
  last = 0;
  lp = 0;
  // one-pole low-pass at ~7 kHz before decimating (cheap anti-aliasing)
  alpha = 1 - Math.exp((-2 * Math.PI * 7000) / sampleRate);
  frame = new Int16Array(FRAME);
  n = 0;
  sumSq = 0;

  process(inputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const x = new Float32Array(input.length);
    for (let k = 0; k < input.length; k++) {
      this.lp += this.alpha * (input[k]! - this.lp);
      x[k] = this.lp;
    }
    while (this.t <= x.length - 1) {
      const i = Math.floor(this.t), f = this.t - i;
      const a = i < 0 ? this.last : x[i]!;
      const b = i + 1 < x.length ? x[i + 1]! : a;
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.sumSq += s * s;
      this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === FRAME) {
        this.port.postMessage({ pcm: this.frame.buffer, level: Math.sqrt(this.sumSq / FRAME) }, [this.frame.buffer]);
        this.frame = new Int16Array(FRAME);
        this.n = 0;
        this.sumSq = 0;
      }
      this.t += this.step;
    }
    this.t -= x.length;
    this.last = x[x.length - 1]!;
    return true;
  }
}

class Player extends AudioWorkletProcessor {
  q: Float32Array[] = [];
  cur: Float32Array | null = null;
  off = 0;
  queued = 0;
  primed = false;
  prebuffer = Math.round(sampleRate * 0.12); // 120 ms before (re)starting playback
  lastPush = 0;
  drain = false;
  lastOut = 0; // last sample played, faded out on an underrun instead of a click
  fadeIn = 0; // samples left to fade in after (re)starting
  FADE = Math.round(sampleRate * 0.004);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Float32Array | "clear" | "drain">) => {
      if (e.data === "clear") {
        this.q = [];
        this.cur = null;
        this.queued = 0;
        this.primed = false;
        this.lastPush = 0;
        return;
      }
      if (e.data === "drain") {
        this.drain = true;
        return;
      }
      this.q.push(e.data);
      this.queued += e.data.length;
      this.lastPush = currentTime;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0]![0]!;
    // Start once the prebuffer is full, or when audio has stopped arriving (an utterance's
    // tail shorter than the prebuffer would otherwise wait for the next utterance).
    if (!this.primed && this.queued > 0 && (this.queued >= this.prebuffer || this.drain || currentTime - this.lastPush > 0.1)) {
      this.primed = true;
      this.fadeIn = this.FADE;
    }
    if (this.drain && this.queued <= 0 && (!this.cur || this.off >= this.cur.length)) {
      this.drain = false;
      this.port.postMessage("drained");
    }
    let i = 0;
    if (this.primed) {
      while (i < out.length) {
        if (!this.cur || this.off >= this.cur.length) {
          this.cur = this.q.shift() || null;
          this.off = 0;
          if (!this.cur) {
            this.primed = false;
            // Ran dry mid-waveform: the next audio came too late (network or a busy page).
            const last = i > 0 ? out[i - 1]! : this.lastOut;
            if (Math.abs(last) > 0.002 && !this.drain) this.port.postMessage("underrun");
            break;
          }
        }
        const n = Math.min(out.length - i, this.cur.length - this.off);
        out.set(this.cur.subarray(this.off, this.off + n), i);
        i += n;
        this.off += n;
        this.queued -= n;
      }
      for (let k = 0; k < i && this.fadeIn > 0; k++, this.fadeIn--) out[k]! *= 1 - this.fadeIn / this.FADE;
      if (i > 0) this.lastOut = out[i - 1]!;
    }
    // Decay to silence from the last sample: a jump to zero mid-waveform is audible as a click.
    for (; i < out.length; i++) {
      this.lastOut *= 0.97;
      out[i] = this.lastOut;
    }
    return true;
  }
}

registerProcessor("capture", Capture);
registerProcessor("player", Player);
