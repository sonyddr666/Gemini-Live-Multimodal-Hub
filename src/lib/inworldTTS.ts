/**
 * inworldTTS - Utilitário para síntese de voz via Inworld TTS API
 *
 * Features:
 * - AudioManager singleton com controle global
 * - TTS Chunked: divide texto em sentenças, gera áudio em paralelo (prefetch)
 * - Interrupt: cancela fila de chunks a qualquer momento
 * - stopSpeaking(): para tudo imediatamente
 */

const INWORLD_TTS_URL = 'https://apitts.ghost1.cloud';

export const DEFAULT_VOICE_ID = 'default--pb4bm1oowkem_r9ri2wiw__makoguren2';

export type TTSModel = 'inworld-tts-1.5-mini' | 'inworld-tts-1.5-max';

interface TTSRequest {
  chavesecreta: string;
  voz: string;
  texto: string;
  model?: TTSModel;
}

export interface VoiceInfo {
  voiceId: string;
  displayName: string;
  languageCode: string;
}

interface TTSResponse {
  ok: boolean;
  audioUrl?: string;
  error?: string;
}

export interface ChunkCallbacks {
  onChunkStart?: (chunkIndex: number, totalChunks: number) => void;
  onChunkEnd?: (chunkIndex: number, totalChunks: number) => void;
  onInterruptWindow?: () => void;
  onQueueComplete?: () => void;
  onCancelled?: () => void;
}

// ============================================================
// Text Splitting
// ============================================================

function splitTextIntoChunks(
  text: string,
  firstChunkMaxChars = 120,
  maxCharsPerChunk = 250
): string[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  const sentenceRegex = /[^.!?\n;]+[.!?\n;]*/g;
  const rawSentences = cleaned.match(sentenceRegex) || [cleaned];
  const sentences = rawSentences.map(s => s.trim()).filter(s => s.length > 0);
  if (sentences.length === 0) return [cleaned];

  const chunks: string[] = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const maxChars = chunks.length === 0 ? firstChunkMaxChars : maxCharsPerChunk;
    if (currentChunk.length + sentence.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

// ============================================================
// AudioManager Singleton
// ============================================================

class AudioManager {
  private currentAudio: HTMLAudioElement | null = null;
  private currentAbortController: AbortController | null = null;
  private _isPlaying = false;
  private _isCancelled = false;
  private chunkQueue: string[] = [];
  private prefetchedAudio: Map<number, string> = new Map();
  private totalChunks = 0;
  private chunkCallbacks: ChunkCallbacks | null = null;
  private secretKey = '';
  private voiceId = '';
  private model: TTSModel = 'inworld-tts-1.5-mini';

  private audioCtx: AudioContext | null = null;
  private ttsGainNode: GainNode | null = null;
  private _isDucked = false;

  private getOrCreateContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext();
      this.ttsGainNode = this.audioCtx.createGain();
      this.ttsGainNode.connect(this.audioCtx.destination);
    }
    return this.audioCtx;
  }

  duckVolume(targetGain = 0.35, durationSec = 0.3): void {
    if (this._isDucked || !this.ttsGainNode || !this.audioCtx) return;
    this._isDucked = true;
    const ctx = this.audioCtx;
    this.ttsGainNode.gain.setValueAtTime(this.ttsGainNode.gain.value, ctx.currentTime);
    this.ttsGainNode.gain.exponentialRampToValueAtTime(
      Math.max(targetGain, 0.001),
      ctx.currentTime + durationSec
    );
  }

  restoreVolume(durationSec = 0.5): void {
    if (!this.ttsGainNode || !this.audioCtx) return;
    this._isDucked = false;
    const ctx = this.audioCtx;
    this.ttsGainNode.gain.setValueAtTime(this.ttsGainNode.gain.value, ctx.currentTime);
    this.ttsGainNode.gain.exponentialRampToValueAtTime(1.0, ctx.currentTime + durationSec);
  }

  resetDuckState(): void { this._isDucked = false; }

  stopSpeaking(): void {
    const hadActive =
      this._isPlaying || this.currentAudio !== null ||
      this.chunkQueue.length > 0 || this.prefetchedAudio.size > 0;

    this._isCancelled = true;
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        if (this.currentAudio.src?.startsWith('blob:')) URL.revokeObjectURL(this.currentAudio.src);
      } catch (e) { /* ignore */ }
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio = null;
    }
    for (const [, url] of this.prefetchedAudio) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
    this.prefetchedAudio.clear();
    this.chunkQueue = [];
    this._isPlaying = false;
    const callbacks = this.chunkCallbacks;
    this.chunkCallbacks = null;
    if (hadActive && callbacks?.onCancelled) callbacks.onCancelled();
  }

  isPlaying(): boolean { return this._isPlaying; }
  isCancelled(): boolean { return this._isCancelled; }

  private createAbortController(): AbortController {
    if (this.currentAbortController) this.currentAbortController.abort();
    this.currentAbortController = new AbortController();
    return this.currentAbortController;
  }

  private async fetchChunkAudio(text: string): Promise<string | null> {
    if (this._isCancelled) return null;
    const abortController = this.createAbortController();
    try {
      const response = await fetch(INWORLD_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chavesecreta: this.secretKey,
          voz: this.voiceId,
          texto: text.slice(0, 2000),
          model: this.model,
        } as TTSRequest),
        signal: abortController.signal,
      });
      if (!response.ok) { console.error('[TTS] HTTP', response.status); return null; }
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      console.error('[TTS] Fetch error:', error);
      return null;
    }
  }

  private playAudioUrl(audioUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._isCancelled) { URL.revokeObjectURL(audioUrl); resolve(); return; }
      const audio = new Audio(audioUrl);
      this.currentAudio = audio;
      this._isPlaying = true;
      try {
        const ctx = this.getOrCreateContext();
        if (ctx.state === 'suspended') ctx.resume();
        const source = ctx.createMediaElementSource(audio);
        source.connect(this.ttsGainNode!);
      } catch (e) {
        console.warn('[AudioManager] Fallback: tocando sem GainNode', e);
      }
      audio.onended = () => { URL.revokeObjectURL(audioUrl); this.currentAudio = null; this._isPlaying = false; resolve(); };
      audio.onerror = (e) => { URL.revokeObjectURL(audioUrl); this.currentAudio = null; this._isPlaying = false; reject(e); };
      audio.play().catch((err) => { this.currentAudio = null; URL.revokeObjectURL(audioUrl); this._isPlaying = false; reject(err); });
    });
  }

  private async prefetchNext(index: number): Promise<void> {
    if (index >= this.chunkQueue.length || this._isCancelled) return;
    if (this.prefetchedAudio.has(index)) return;
    const text = this.chunkQueue[index];
    if (!text) return;
    const audioUrl = await this.fetchChunkAudio(text);
    if (audioUrl && !this._isCancelled) this.prefetchedAudio.set(index, audioUrl);
  }

  async speakChunked(
    text: string,
    secretKey: string,
    voiceId: string = DEFAULT_VOICE_ID,
    model: TTSModel = 'inworld-tts-1.5-mini',
    callbacks?: ChunkCallbacks
  ): Promise<void> {
    this.stopSpeaking();
    this._isCancelled = false;
    this.secretKey = secretKey;
    this.voiceId = voiceId;
    this.model = model;
    this.chunkCallbacks = callbacks || null;

    this.chunkQueue = splitTextIntoChunks(text);
    this.totalChunks = this.chunkQueue.length;
    if (this.chunkQueue.length === 0) { callbacks?.onQueueComplete?.(); return; }

    console.log(`[AudioManager] TTS chunked: ${this.totalChunks} chunks`);

    for (let i = 0; i < this.chunkQueue.length; i++) {
      if (this._isCancelled) break;
      callbacks?.onChunkStart?.(i, this.totalChunks);

      let audioUrl: string | null = this.prefetchedAudio.get(i) || null;
      if (!audioUrl) audioUrl = await this.fetchChunkAudio(this.chunkQueue[i]!);
      this.prefetchedAudio.delete(i);

      if (!audioUrl || this._isCancelled) break;
      if (i + 1 < this.chunkQueue.length) this.prefetchNext(i + 1);

      try { await this.playAudioUrl(audioUrl); } catch (e) { console.warn('[AudioManager] Erro chunk', i, e); }

      if (this._isCancelled) break;
      callbacks?.onChunkEnd?.(i, this.totalChunks);

      if (i + 1 < this.chunkQueue.length && !this._isCancelled) {
        callbacks?.onInterruptWindow?.();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (this._isCancelled) break;
    }

    this._isPlaying = false;
    if (!this._isCancelled) {
      this.chunkCallbacks = null;
      callbacks?.onQueueComplete?.();
      console.log('[AudioManager] Fila completa');
    }
  }

  async playAudio(audioUrl: string, onEnd?: () => void): Promise<void> {
    this.stopSpeaking();
    this._isCancelled = false;
    try { await this.playAudioUrl(audioUrl); } catch (e) { console.warn('[AudioManager] Erro:', e); } finally { this._isPlaying = false; onEnd?.(); }
  }
}

export const audioManager = new AudioManager();

// ============================================================
// Exported functions
// ============================================================

export async function synthesizeSpeech(
  text: string, secretKey: string, voiceId = DEFAULT_VOICE_ID, model: TTSModel = 'inworld-tts-1.5-mini'
): Promise<TTSResponse> {
  if (!secretKey) return { ok: false, error: 'Secret key não fornecida' };
  try {
    const response = await fetch(INWORLD_TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chavesecreta: secretKey, voz: voiceId, texto: text.slice(0, 2000), model } as TTSRequest),
    });
    if (!response.ok) { const err = await response.text(); return { ok: false, error: `HTTP ${response.status}: ${err}` }; }
    const audioBlob = await response.blob();
    return { ok: true, audioUrl: URL.createObjectURL(audioBlob) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listVoices(secretKey: string): Promise<VoiceInfo[] | null> {
  if (!secretKey) return null;
  try {
    const response = await fetch(`${INWORLD_TTS_URL}/vozes`, {
      method: 'GET',
      headers: { 'x-secret': secretKey },
    });
    if (!response.ok) { console.error('[TTS] Erro vozes:', response.status); return null; }
    const data = await response.json();
    return data.voices || data || [];
  } catch (error) {
    console.error('[TTS] Erro vozes:', error);
    return null;
  }
}

export function stopSpeaking(): void { audioManager.stopSpeaking(); }
export function isPlaying(): boolean { return audioManager.isPlaying(); }

export async function speakChunked(
  text: string, secretKey: string, voiceId = DEFAULT_VOICE_ID,
  model: TTSModel = 'inworld-tts-1.5-mini', callbacks?: ChunkCallbacks
): Promise<void> {
  return audioManager.speakChunked(text, secretKey, voiceId, model, callbacks);
}

export async function speakText(
  text: string, secretKey: string, voiceId = DEFAULT_VOICE_ID,
  model: TTSModel = 'inworld-tts-1.5-mini', onEnd?: () => void
): Promise<void> {
  const result = await synthesizeSpeech(text, secretKey, voiceId, model);
  if (!result.ok || !result.audioUrl) { onEnd?.(); throw new Error(result.error || 'Falha ao gerar áudio'); }
  await audioManager.playAudio(result.audioUrl, onEnd);
}

export function playAudio(audioUrl: string, onEnd?: () => void): Promise<void> {
  return audioManager.playAudio(audioUrl, onEnd);
}

export default { synthesizeSpeech, listVoices, playAudio, speakText, speakChunked, stopSpeaking, isPlaying, audioManager, DEFAULT_VOICE_ID };
