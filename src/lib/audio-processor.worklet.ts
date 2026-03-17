// AudioWorklet processor — roda numa thread separada
// Compilado pelo Vite junto com o bundle principal via ?url import
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input && input.length > 0) {
      // Envia os samples de volta para o main thread
      this.port.postMessage(input);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
