/**
 * chat.ts — Pipeline de texto: Chrome STT → Gemini REST stream → Inworld TTS chunked
 * Ativado automaticamente quando o modelo selecionado NÃO é native-audio.
 */

import { GoogleGenAI } from '@google/genai';
import { modularTools, handleToolCall } from './tools';
import { speakChunked, stopSpeaking, DEFAULT_VOICE_ID } from './inworldTTS';
import type { TTSModel } from './inworldTTS';
import type { Message } from './live';

export interface ChatConfig {
  model: string;
  systemInstruction: string;
  thinkingMode: boolean;
  thinkingBudget: number;
  grounding: boolean;
  functionCalling: boolean;
  // Inworld TTS
  ttsEnabled: boolean;
  ttsSecretKey: string;
  ttsVoiceId: string;
  ttsModel: TTSModel;
  onMessage: (msg: Message) => void;
  onStatus: (status: string) => void;
}

function getAI(): GoogleGenAI {
  const apiKey =
    (import.meta as any).env?.VITE_GEMINI_API_KEY ||
    (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) ||
    '';
  return new GoogleGenAI({ apiKey });
}

// ─── TTS helpers ────────────────────────────────────────────

let _ttsEnabled = true;
let _ttsSecretKey = '';
let _ttsVoiceId = DEFAULT_VOICE_ID;
let _ttsModel: TTSModel = 'inworld-tts-1.5-mini';

export function setTTSEnabled(v: boolean) { _ttsEnabled = v; }
export function setTTSSecretKey(v: string) { _ttsSecretKey = v; }
export function setTTSVoiceId(v: string) { _ttsVoiceId = v; }
export function setTTSModel(v: TTSModel) { _ttsModel = v; }
export function cancelTTS() { stopSpeaking(); }
// compat alias — mantém exportação usada no App
export function setTTSRate(_v: number) { /* no-op: Inworld não usa rate */ }

function doSpeak(text: string, callbacks?: { onQueueComplete?: () => void; onCancelled?: () => void; onInterruptWindow?: () => void }) {
  if (!_ttsEnabled || !_ttsSecretKey) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  speakChunked(trimmed, _ttsSecretKey, _ttsVoiceId, _ttsModel, {
    onChunkStart: (i, total) => console.log(`[TTS] chunk ${i + 1}/${total}`),
    onQueueComplete: callbacks?.onQueueComplete,
    onCancelled: callbacks?.onCancelled,
    onInterruptWindow: callbacks?.onInterruptWindow,
  });
}

// ─── Chrome STT ─────────────────────────────────────────────

type STTCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError: (err: string) => void;
  onEnd: () => void;
};

export class ChromeSTT {
  private recognition: SpeechRecognition | null = null;
  private active = false;
  private muted = false;
  private callbacks: STTCallbacks | null = null;

  isSupported() { return !!(window.SpeechRecognition || (window as any).webkitSpeechRecognition); }

  start(callbacks: STTCallbacks) {
    if (!this.isSupported()) { callbacks.onError('SpeechRecognition não suportado neste browser.'); return; }
    this.callbacks = callbacks;
    const SR = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.recognition = new SR();
    const r = this.recognition!;
    r.lang = 'pt-BR';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = (event: SpeechRecognitionEvent) => {
      if (this.muted) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        this.callbacks?.onTranscript(result[0].transcript, result.isFinal);
      }
    };

    r.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return;
      this.callbacks?.onError(event.error);
    };

    r.onend = () => {
      if (this.active && !this.muted) { try { r.start(); } catch (_) {} }
      else this.callbacks?.onEnd();
    };

    this.active = true;
    r.start();
  }

  stop() { this.active = false; try { this.recognition?.stop(); } catch (_) {} this.recognition = null; }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) { try { this.recognition?.stop(); } catch (_) {} }
    else if (this.active && this.recognition) { try { this.recognition.start(); } catch (_) {} }
  }

  getMuted() { return this.muted; }
  isActive() { return this.active; }
}

// ─── Chat Session Manager ────────────────────────────────────

export class ChatSessionManager {
  private config: ChatConfig | null = null;
  private stt = new ChromeSTT();
  private conversationHistory: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  private isSending = false;
  private sttMuted = false;

  setConfig(config: ChatConfig) {
    this.config = config;
    setTTSEnabled(config.ttsEnabled);
    setTTSSecretKey(config.ttsSecretKey);
    setTTSVoiceId(config.ttsVoiceId || DEFAULT_VOICE_ID);
    setTTSModel(config.ttsModel || 'inworld-tts-1.5-mini');
  }

  isSTTSupported() { return this.stt.isSupported(); }

  start() {
    if (!this.config) return;
    this.conversationHistory = [];
    stopSpeaking();

    if (!this.stt.isSupported()) {
      this.config.onStatus('Conectado (sem STT)');
      this.config.onMessage({ id: Date.now().toString(), role: 'system', text: '⚠️ SpeechRecognition não suportado. Use o chat por texto.', isMicError: true });
      return;
    }

    let interimBuffer = '';

    this.stt.start({
      onTranscript: (text, isFinal) => {
        if (!isFinal) { interimBuffer = text; return; }
        interimBuffer = '';
        const userText = text.trim();
        if (!userText || this.isSending) return;
        // Silencia mic durante TTS
        this.stt.setMuted(true);
        this.sttMuted = true;
        this.sendMessage(userText, {
          onTTSComplete: () => { this.stt.setMuted(false); this.sttMuted = false; },
          onTTSWindow: () => { /* janela de interrupção entre chunks */ },
        });
      },
      onError: (err) => {
        console.warn('[ChromeSTT]', err);
        this.config?.onMessage({ id: Date.now().toString(), role: 'system', text: `⚠️ STT: ${err}. Use o chat por texto.`, isMicError: true });
      },
      onEnd: () => {},
    });

    this.config.onStatus('Conectado (Texto + Inworld TTS)');
  }

  stop() { this.stt.stop(); stopSpeaking(); this.isSending = false; this.config?.onStatus('Disconnected'); }

  setMicMuted(muted: boolean) { this.stt.setMuted(muted); this.sttMuted = muted; }
  getMicMuted() { return this.sttMuted; }
  isActive() { return this.stt.isActive(); }
  setTTSEnabled(v: boolean) { setTTSEnabled(v); }
  cancelTTS() { stopSpeaking(); }

  async sendMessage(
    text: string,
    ttsCb?: { onTTSComplete?: () => void; onTTSWindow?: () => void }
  ) {
    if (!this.config || this.isSending) return;
    this.isSending = true;

    this.config.onMessage({ id: Date.now().toString(), role: 'user', text });
    this.conversationHistory.push({ role: 'user', parts: [{ text }] });

    try {
      const ai = getAI();
      const tools: any[] = [];
      if (this.config.functionCalling) tools.push({ functionDeclarations: modularTools });
      if (this.config.grounding) tools.push({ googleSearch: {} });

      const thinkingConfig = this.config.thinkingMode
        ? { thinkingBudget: this.config.thinkingBudget || 1024 }
        : { thinkingBudget: 0 };

      const response = await ai.models.generateContentStream({
        model: this.config.model,
        config: { systemInstruction: this.config.systemInstruction, thinkingConfig, tools: tools.length > 0 ? tools : undefined },
        contents: this.conversationHistory as any,
      });

      let fullText = '';
      let thinkingText = '';
      const msgId = Date.now().toString();
      const thinkingId = (Date.now() + 1).toString();

      for await (const chunk of response) {
        // Thinking parts
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if ((part as any).thought) {
              thinkingText += (part as any).text || '';
              this.config.onMessage({ id: thinkingId, role: 'model', text: thinkingText, isThinking: true });
            }
          }
        }

        const textChunk = chunk.text ?? '';
        if (!textChunk) continue;
        fullText += textChunk;
        this.config.onMessage({ id: msgId, role: 'model', text: fullText });

        // Tool calls
        const toolCalls = chunk.candidates?.[0]?.content?.parts?.filter((p: any) => p.functionCall);
        if (toolCalls?.length) {
          for (const part of toolCalls) {
            const call = (part as any).functionCall;
            this.config.onMessage({ id: call.id || Date.now().toString(), role: 'system', text: `🔧 Calling tool: **${call.name}**`, isToolCall: true, toolDetails: { args: call.args } });
            const result = await handleToolCall(call.name, call.args);
            this.config.onMessage({ id: (call.id || Date.now().toString()) + '_result', role: 'system', text: `🔧 Tool **${call.name}** completed.`, isToolCall: true, toolDetails: { args: call.args, result } });
          }
        }
      }

      if (fullText) this.conversationHistory.push({ role: 'model', parts: [{ text: fullText }] });

      // TTS após resposta completa
      if (fullText.trim()) {
        doSpeak(fullText, {
          onQueueComplete: () => { ttsCb?.onTTSComplete?.(); },
          onCancelled: () => { ttsCb?.onTTSComplete?.(); },
          onInterruptWindow: () => { ttsCb?.onTTSWindow?.(); },
        });
        if (!_ttsEnabled || !_ttsSecretKey) ttsCb?.onTTSComplete?.();
      } else {
        ttsCb?.onTTSComplete?.();
      }

    } catch (error: any) {
      console.error('[ChatSessionManager]', error);
      this.config.onMessage({ id: Date.now().toString(), role: 'system', text: `❌ Erro: ${error?.message || 'Falha na requisição.'}` });
      ttsCb?.onTTSComplete?.();
    } finally {
      this.isSending = false;
    }
  }
}
