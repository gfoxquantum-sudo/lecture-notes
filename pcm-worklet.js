// Downsamples microphone audio to 16 kHz mono 16-bit PCM and posts ~100 ms chunks.
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = (options.processorOptions && options.processorOptions.inRate || sampleRate) / 16000;
    this.phase = 0;
    this.acc = 0;
    this.cnt = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.sumSq = 0;
    this.sqCnt = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      this.sumSq += x * x;
      this.sqCnt++;
      this.acc += x;
      this.cnt++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let s = this.acc / this.cnt;
        this.acc = 0;
        this.cnt = 0;
        s = Math.max(-1, Math.min(1, s));
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.out.length) {
          const level = Math.sqrt(this.sumSq / Math.max(1, this.sqCnt));
          const buf = this.out.buffer;
          this.port.postMessage({ pcm: buf, level }, [buf]);
          this.out = new Int16Array(1600);
          this.n = 0;
          this.sumSq = 0;
          this.sqCnt = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16kProcessor);
