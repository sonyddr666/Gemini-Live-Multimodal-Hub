// @ts-ignore
import workletUrl from './audio-processor.worklet.ts?url';

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onDataCallback: ((data: string) => void) | null = null;
  private isMicMuted = false;

  async start(onData: (data: string) => void) {
    this.onDataCallback = onData;

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Microfone indisponivel: a pagina precisa estar em HTTPS para acessar o microfone.'
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      await this.audioContext.audioWorklet.addModule(workletUrl);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');

      this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.isMicMuted) return;
        const pcm16 = this.floatTo16BitPCM(e.data);
        const base64 = this.arrayBufferToBase64(pcm16);
        this.onDataCallback?.(base64);
      };

      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.source.connect(this.workletNode);
    } catch (error: any) {
      const name = error?.name || '';
      if (name === 'NotAllowedError') {
        throw new Error(
          'Permissao do microfone negada. Clique no cadeado da barra de endereco, libere o microfone e recarregue a pagina.'
        );
      }
      if (name === 'NotFoundError') {
        throw new Error('Nenhum microfone encontrado no dispositivo.');
      }
      throw error;
    }
  }

  setMicMuted(muted: boolean) {
    this.isMicMuted = muted;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }

  getMicMuted() { return this.isMicMuted; }
  isActive() { return !!this.stream; }

  stop() {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.onDataCallback = null;
    this.isMicMuted = false;
  }

  private floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
}

export class AudioPlayer {
  private audioContext: AudioContext;
  private gainNode: GainNode;
  private nextPlayTime = 0;
  private isAudioMuted = false;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
  }

  setAudioMuted(muted: boolean) {
    this.isAudioMuted = muted;
    this.gainNode.gain.setTargetAtTime(muted ? 0 : 1, this.audioContext.currentTime, 0.01);
  }

  getAudioMuted() { return this.isAudioMuted; }

  async play(base64Audio: string) {
    try {
      const arrayBuffer = this.base64ToArrayBuffer(base64Audio);
      const int16Array = new Int16Array(arrayBuffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) float32Array[i] = int16Array[i] / 32768.0;

      const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 24000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const now = this.audioContext.currentTime;
      if (this.nextPlayTime < now) this.nextPlayTime = now;
      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  stop() {
    this.audioContext.close();
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.isAudioMuted ? 0 : 1;
    this.gainNode.connect(this.audioContext.destination);
    this.nextPlayTime = 0;
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
  }
}
