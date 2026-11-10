// audio worklet: shifts pitch by semitones without changing tempo (phase vocoder, bernsee style).
// the <audio> element already handles speed (preservesPitch), this only moves the pitch.
// at 0 semitones it passes audio straight through, with no latency.

const N = 4096; // fft size: fine enough for low bass notes
const OSAMP = 8; // overlap: higher = smoother, less "phasey"
const STEP = N / OSAMP;
const HALF = N / 2;
const LATENCY = N - STEP; // samples between input and output while shifting
const TWO_PI = 2 * Math.PI;
const EXPECT = (TWO_PI * STEP) / N; // phase advance per hop for bin 1

// shared tables: hann window, twiddles, bit reversal
const WIN = new Float32Array(N);
for (let k = 0; k < N; k++) WIN[k] = 0.5 - 0.5 * Math.cos((TWO_PI * k) / N);
const COS = new Float64Array(HALF), SIN = new Float64Array(HALF);
for (let k = 0; k < HALF; k++) { COS[k] = Math.cos((TWO_PI * k) / N); SIN[k] = Math.sin((TWO_PI * k) / N); }
const REV = new Uint32Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  REV[i] = r;
}

// in-place radix-2 complex fft (inverse is unscaled)
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = COS[k], wi = sign * SIN[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// one channel of shifting state
class Channel {
  constructor() {
    this.inFifo = new Float32Array(N);
    this.outFifo = new Float32Array(N);
    this.accum = new Float32Array(2 * N);
    this.lastPhase = new Float64Array(HALF + 1);
    this.sumPhase = new Float64Array(HALF + 1);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.anaMag = new Float64Array(HALF + 1);
    this.anaFrq = new Float64Array(HALF + 1);
    this.synMag = new Float64Array(HALF + 1);
    this.synFrq = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF);
    this.rover = LATENCY;
  }

  // clear everything so a restart doesn't replay old audio
  reset() {
    for (const a of [this.inFifo, this.outFifo, this.accum, this.lastPhase, this.sumPhase]) a.fill(0);
    this.rover = LATENCY;
  }

  // run one block of samples through the shifter
  run(input, output, ratio, binHz) {
    for (let i = 0; i < input.length; i++) {
      this.inFifo[this.rover] = input[i];
      output[i] = this.outFifo[this.rover - LATENCY];
      if (++this.rover >= N) { this.rover = LATENCY; this.frame(ratio, binHz); }
    }
  }

  // analyse, move the bins, resynthesise one hop
  frame(ratio, binHz) {
    const { re, im, anaMag, anaFrq, synMag, synFrq, lastPhase, sumPhase, accum } = this;
    // synFrq holds the new phase per bin here, sumPhase the phases sent out last hop
    // windowed input -> spectrum
    for (let k = 0; k < N; k++) { re[k] = this.inFifo[k] * WIN[k]; im[k] = 0; }
    fft(re, im, false);

    // analysis: magnitude, phase and true frequency of each bin
    for (let k = 0; k <= HALF; k++) {
      const mag = 2 * Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      let d = phase - lastPhase[k] - k * EXPECT;
      lastPhase[k] = phase;
      d -= TWO_PI * Math.round(d / TWO_PI); // wrap into -pi..pi
      anaMag[k] = mag;
      anaFrq[k] = (k + (OSAMP * d) / TWO_PI) * binHz;
    }

    // peaks: local maxima, each owning the bins down to the valleys around it
    let top = 0;
    for (let k = 0; k <= HALF; k++) if (anaMag[k] > top) top = anaMag[k];
    const floor = top * 1e-5;
    let np = 0;
    for (let k = 1; k < HALF; k++) {
      const m = anaMag[k];
      if (m > floor && m > anaMag[k - 1] && m >= anaMag[k + 1]) this.peaks[np++] = k;
    }

    // shift each peak with its whole lobe (keeps the shape, so no level loss),
    // the peak's phase runs on at its new frequency, the lobe keeps its phase offsets to the peak
    synMag.fill(0);
    let lo = 0;
    for (let i = 0; i < np; i++) {
      const p = this.peaks[i];
      // region ends at the lowest bin before the next peak
      let hi = HALF;
      if (i + 1 < np) {
        hi = p;
        for (let k = p + 1; k < this.peaks[i + 1]; k++) if (anaMag[k] < anaMag[hi]) hi = k;
      }
      const jp = Math.round(p * ratio), off = jp - p;
      if (jp > HALF) break;
      const dev = (anaFrq[p] * ratio) / binHz - jp;
      let ph = sumPhase[jp] + (TWO_PI * dev) / OSAMP + jp * EXPECT;
      ph -= TWO_PI * Math.floor(ph / TWO_PI); // keep precision over long songs
      const peakPh = lastPhase[p];
      for (let k = lo; k <= hi; k++) {
        const j = k + off;
        if (j < 0 || j > HALF) continue;
        // where two lobes land on one bin the louder one sets the phase
        if (anaMag[k] > synMag[j]) synFrq[j] = ph + lastPhase[k] - peakPh;
        synMag[j] += anaMag[k];
      }
      lo = hi + 1;
    }

    // synthesis: spectrum from the shifted bins, remember phases for the next hop
    for (let k = 0; k <= HALF; k++) {
      const p = synMag[k] ? synFrq[k] : 0;
      sumPhase[k] = p;
      re[k] = synMag[k] * Math.cos(p);
      im[k] = synMag[k] * Math.sin(p);
    }
    for (let k = HALF + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
    fft(re, im, true);

    // overlap-add, hand out one hop, slide the buffers
    // hann squared overlap at 8x sums to 3; +1.5 db makes up for what shifting dense music loses
    const scale = (2 / (HALF * OSAMP) / 1.5) * 1.19;
    for (let k = 0; k < N; k++) accum[k] += WIN[k] * re[k] * scale;
    this.outFifo.set(accum.subarray(0, STEP));
    accum.copyWithin(0, STEP, 2 * N);
    accum.fill(0, 2 * N - STEP);
    this.inFifo.copyWithin(0, STEP);
  }
}

// the node: stereo in, stereo out, semitones set over the port
class PitchShift extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // start shifted when asked (offline export renders before any port message arrives)
    this.ratio = Math.pow(2, (Number(options?.processorOptions?.semitones) || 0) / 12);
    this.chans = [new Channel(), new Channel()];
    this.port.onmessage = (e) => {
      const ratio = Math.pow(2, (Number(e.data?.semitones) || 0) / 12);
      // turning it on starts from clean buffers
      if (this.ratio === 1 && ratio !== 1) this.chans.forEach((c) => c.reset());
      this.ratio = ratio;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    for (let c = 0; c < output.length; c++) {
      const src = input[c] || input[0], dst = output[c];
      // no input yet (element paused or not routed): stay silent
      if (!src) { dst.fill(0); continue; }
      if (this.ratio === 1) dst.set(src);
      else this.chans[c % 2].run(src, dst, this.ratio, sampleRate / N);
    }
    return true;
  }
}

registerProcessor("pitch-shift", PitchShift);
