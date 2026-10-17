class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let index = 0;
    while (index < channel.length) {
      const take = Math.min(this.buffer.length - this.offset, channel.length - index);
      this.buffer.set(channel.subarray(index, index + take), this.offset);
      this.offset += take;
      index += take;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
