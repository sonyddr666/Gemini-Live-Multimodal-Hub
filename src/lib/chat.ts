/**
 * chat.ts — Pipeline de texto: Chrome STT → Gemini REST stream → speechSynthesis TTS
 * Ativado automaticamente quando o modelo selecionado NÃO é native-audio.
 */

import { GoogleGenAI } from '@google/genai';
import { modularTools, handleToolCall } from './tools';
import type { Message } from './live';

export interface ChatConfig {
  model: string;
  systemInstruction: string;
  thinkingMode: boolean;
  thinkingBudget: number;
  grounding: boolean;
  functionCalling: boolean;
  ttsEnabled: boolean;
  ttsRate?: number;
  ttsPitch?: number;
  onMessage: (msg: Message) => void;
  onStatus: (status: string) => void;
}

// Regex para detectar fim de frase — dispara TTS antes de terminar o stream
const SENTENCE_END = /[.!?\n।。！？]/;

function getAI(): GoogleGenAI {
  const apiKey =
    (import.meta as any).env?.VITE_GEMINI_API_KEY ||
    (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) ||
    '';
  return new GoogleGenAI({ apiKey });
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

let ttsEnabled = true;
let ttsRate = 1;
let ttsPitch = 1;

export function setTTSEnabled(v: boolean) { ttsEnabled = v; }
export function setTTSRate(v: number) { ttsRate = v; }
export function setTTSPitch(v: number) { ttsPitch = v; }
export function cancelTTS() { window.speechSynthesis?.cancel(); }

function speakFragment(text: string) {
  if (!ttsEnabled) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const utt = new SpeechSynthesisUtterance(trimmed);
  utt.lang = 'pt-BR';
  utt.rate = ttsRate;
  utt.pitch = ttsPitch;
  window.speechSynthesis.speak(utt);
}

// ─── STT ──────────────────────────────────────────────────────────────────────

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

  isSupported() {
    return !!(window.SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start(callbacks: STTCallbacks) {
    if (!this.isSupported()) {
      callbacks.onError('SpeechRecognition não suportado neste browser.');
      return;
    }
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
        const transcript = result[0].transcript;
        const isFinal = result.isFinal;
        this.callbacks?.onTranscript(transcript, isFinal);
      }
    };

    r.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'no-speech') return; // silêncio normal
      this.callbacks?.onError(event.error);
    };

    r.onend = () => {
      // Auto-restart enquanto ativo (Chrome para após silêncio)
      if (this.active && !this.muted) {
        try { r.start(); } catch (_) {}
      } else {
        this.callbacks?.onEnd();
      }
    };

    this.active = true;
    r.start();
  }

  stop() {
    this.active = false;
    try { this.recognition?.stop(); } catch (_) {}
    this.recognition = null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) {
      // Pausa sem destruir — restart quando desmutar
      try { this.recognition?.stop(); } catch (_) {}
    } else if (this.active && this.recognition) {
      try { this.recognition.start(); } catch (_) {}
    }
  }

  getMuted() { return this.muted; }
  isActive() { return this.active; }
}

// ─── CHAT SESSION ─────────────────────────────────────────────────────────────

export class ChatSessionManager {
  private config: ChatConfig | null = null;
  private stt = new ChromeSTT();
  private conversationHistory: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  private isSending = false;
  private sttMuted = false;

  setConfig(config: ChatConfig) {
    this.config = config;
    setTTSEnabled(config.ttsEnabled);
    if (config.ttsRate !== undefined) setTTSRate(config.ttsRate);
    if (config.ttsPitch !== undefined) setTTSPitch(config.ttsPitch);
  }

  isSTTSupported() { return this.stt.isSupported(); }

  start() {
    if (!this.config) return;
    this.conversationHistory = [];
    cancelTTS();

    if (!this.stt.isSupported()) {
      this.config.onStatus('Conectado (sem STT)');
      this.config.onMessage({
        id: Date.now().toString(),
        role: 'system',
        text: '⚠️ SpeechRecognition não suportado. Use o chat por texto.',
        isMicError: true,
      });
      return;
    }

    let interimBuffer = '';

    this.stt.start({
      onTranscript: (text, isFinal) => {
        if (!isFinal) {
          interimBuffer = text;
          return;
        }
        interimBuffer = '';
        const userText = text.trim();
        if (!userText || this.isSending) return;
        // Silencia mic durante geração + TTS
        this.stt.setMuted(true);
        this.sttMuted = true;
        this.sendMessage(userText).finally(() => {
          // Retoma mic após TTS terminar (espera fila de síntese zerar)
          const checkTTS = () => {
            if (window.speechSynthesis.speaking) {
              setTimeout(checkTTS, 200);
            } else {
              this.stt.setMuted(false);
              this.sttMuted = false;
            }
          };
          checkTTS();
        });
      },
      onError: (err) => {
        console.warn('[ChromeSTT] error:', err);
        this.config?.onMessage({
          id: Date.now().toString(),
          role: 'system',
          text: `⚠️ STT: ${err}. Use o chat por texto.`,
          isMicError: true,
        });
      },
      onEnd: () => {},
    });

    this.config.onStatus('Conectado (Texto + TTS)');
  }

  stop() {
    this.stt.stop();
    cancelTTS();
    this.isSending = false;
    this.config?.onStatus('Disconnected');
  }

  setMicMuted(muted: boolean) {
    this.stt.setMuted(muted);
    this.sttMuted = muted;
  }

  getMicMuted() { return this.sttMuted; }
  isActive() { return this.stt.isActive(); }

  setTTSEnabled(v: boolean) { setTTSEnabled(v); }
  cancelTTS() { cancelTTS(); }

  async sendMessage(text: string) {
    if (!this.config || this.isSending) return;
    this.isSending = true;

    // Mostra mensagem do usuário imediatamente
    this.config.onMessage({
      id: Date.now().toString(),
      role: 'user',
      text,
    });

    // Adiciona ao histórico
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
        config: {
          systemInstruction: this.config.systemInstruction,
          thinkingConfig,
          tools: tools.length > 0 ? tools : undefined,
        },
        contents: this.conversationHistory as any,
      });

      let fullText = '';
      let ttsBuffer = '';
      let thinkingText = '';
      const msgId = Date.now().toString();
      let thinkingId = (Date.now() + 1).toString();
      let firstChunk = true;

      for await (const chunk of response) {
        // Thinking parts
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if ((part as any).thought) {
              thinkingText += (part as any).text || '';
              this.config.onMessage({
                id: thinkingId,
                role: 'model',
                text: thinkingText,
                isThinking: true,
              });
            }
          }
        }

        const textChunk = chunk.text ?? '';
        if (!textChunk) continue;

        fullText += textChunk;
        ttsBuffer += textChunk;

        // Mostra na UI
        this.config.onMessage({
          id: msgId,
          role: 'model',
          text: fullText,
        });

        // TTS incremental — fala quando fecha uma frase
        if (SENTENCE_END.test(ttsBuffer)) {
          const sentences = ttsBuffer.split(SENTENCE_END);
          // Fala tudo menos o último fragmento (pode estar incompleto)
          for (let i = 0; i < sentences.length - 1; i++) {
            speakFragment(sentences[i]);
          }
          ttsBuffer = sentences[sentences.length - 1];
        }

        // Tool calls via streaming
        const toolCalls = chunk.candidates?.[0]?.content?.parts?.filter(
          (p: any) => p.functionCall
        );
        if (toolCalls?.length) {
          for (const part of toolCalls) {
            const call = (part as any).functionCall;
            this.config.onMessage({
              id: call.id || Date.now().toString(),
              role: 'system',
              text: `🔧 Calling tool: **${call.name}**`,
              isToolCall: true,
              toolDetails: { args: call.args },
            });
            const result = await handleToolCall(call.name, call.args);
            this.config.onMessage({
              id: (call.id || Date.now().toString()) + '_result',
              role: 'system',
              text: `🔧 Tool **${call.name}** completed.`,
              isToolCall: true,
              toolDetails: { args: call.args, result },
            });
          }
        }
      }

      // Fala o resto do buffer (última frase sem pontuação)
      speakFragment(ttsBuffer);

      // Adiciona resposta completa ao histórico
      if (fullText) {
        this.conversationHistory.push({ role: 'model', parts: [{ text: fullText }] });
      }

    } catch (error: any) {
      console.error('[ChatSessionManager] sendMessage error:', error);
      this.config.onMessage({
        id: Date.now().toString(),
        role: 'system',
        text: `❌ Erro: ${error?.message || 'Falha na requisição.'}`,
      });
    } finally {
      this.isSending = false;
    }
  }
}
