/* ClipAtlas auto-review: hands the tab's sound to the page, mixed to mono,
   only while a clip is being listened to. Nothing is stored here. */
class ClipAtlasRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = e => { this.on = !!(e.data && e.data.record); };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input.length && input[0].length) {
      const n = input[0].length, mono = new Float32Array(n);
      for (const channel of input) for (let i = 0; i < n; i++) mono[i] += channel[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('clipatlas-recorder', ClipAtlasRecorder);
