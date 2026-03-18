import { GoogleGenAI, LiveServerMessage, Modality, MediaResolution, TurnCoverage } from '@google/genai';
import { AudioRecorder, AudioPlayer } from './audio';
import { modularTools, handleToolCall } from './tools';

const DROPPED_SESSION_KEY = 'livego_dropped_session';
const ACTIVE_SESSION_KEY  = 'livego_active_session';

export interface DroppedSession {
  transcript: string;
  timestamp: number;
  startTime: number;
  closeCode: number;
  closeReason: string;
}

export interface LiveConfig {
  voice: string;
  thinkingMode: boolean;
  grounding: boolean;
  functionCalling: boolean;
  sessionContext: string;
  mediaResolution: string;
  turnCoverage: boolean;
  playAudio: boolean;
  systemInstruction?: string;
  useConversationContext?: boolean;
  onUnexpectedDisconnect?: (data: { transcript: string; closeCode: number; closeReason: string }) => void;
}

export type Message = {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  isToolCall?: boolean;
  toolDetails?: any;
  isThinking?: boolean;
  isMicError?: boolean;
};

export class LiveSessionManager {
  private ai: GoogleGenAI;
  private session: any = null;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private onMessageCallback: ((msg: Message) => void) | null = null;
  private onStatusCallback: ((status: string) => void) | null = null;
  private transcriptLines: string[] = [];
  private startTime = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const apiKey =
      (import.meta as any).env?.VITE_GEMINI_API_KEY ||
      (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) ||
      '';
    if (!apiKey) console.error('GEMINI_API_KEY nao encontrada. Configure VITE_GEMINI_API_KEY.');
    this.ai = new GoogleGenAI({ apiKey });
    this.recorder = new AudioRecorder();
    this.player = new AudioPlayer();
  }

  setCallbacks(
    onMessage: (msg: Message) => void,
    onStatus: (status: string) => void
  ) {
    this.onMessageCallback = onMessage;
    this.onStatusCallback = onStatus;
  }

  setMuted(muted: boolean) { this.player.setAudioMuted(muted); }
  setMicMuted(muted: boolean) { this.recorder.setMicMuted(muted); }
  getMicMuted() { return this.recorder.getMicMuted(); }
  setAudioOutputMuted(muted: boolean) { this.player.setAudioMuted(muted); }
  getAudioOutputMuted() { return this.player.getAudioMuted(); }
  isMicActive() { return this.recorder.isActive(); }

  private appendTranscript(role: 'user' | 'model', text: string) {
    this.transcriptLines.push(`${role === 'user' ? 'Você' : 'Gemini'}: ${text}`);
    // Debounce auto-save da sessao ativa
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      try {
        localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
          transcript: this.transcriptLines.join('\n'),
          timestamp: Date.now(),
          startTime: this.startTime,
        }));
      } catch (e) { /* ignore */ }
    }, 3000);
  }

  async connect(config: LiveConfig) {
    if (this.session) await this.disconnect();
    this.player.setAudioMuted(!config.playAudio);
    this.transcriptLines = [];
    this.startTime = Date.now();
    this.onStatusCallback?.('Connecting...');

    try {
      const tools: any[] = [];
      if (config.functionCalling) tools.push({ functionDeclarations: modularTools });
      if (config.grounding) tools.push({ googleSearch: {} });

      this.session = await this.ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          mediaResolution:
            config.mediaResolution === 'High'
              ? MediaResolution.MEDIA_RESOLUTION_HIGH
              : MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          realtimeInputConfig: config.turnCoverage
            ? { turnCoverage: TurnCoverage.TURN_INCLUDES_ALL_INPUT }
            : undefined,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
          },
          systemInstruction:
            config.systemInstruction ||
            config.sessionContext ||
            'You are a helpful, multimodal AI assistant.',
          tools: tools.length > 0 ? tools : undefined,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: async () => {
            this.onStatusCallback?.('Connected');
            try {
              await this.recorder.start((base64Data) => {
                this.session?.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
                });
              });
            } catch (micError: any) {
              console.error('Mic error:', micError);
              this.onStatusCallback?.('Conectado (sem microfone)');
              this.onMessageCallback?.({
                id: Date.now().toString(),
                role: 'system',
                text: `⚠️ ${micError?.message || 'Microfone bloqueado.'} O chat por texto continua funcionando normalmente.`,
                isMicError: true,
              });
            }
          },

          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) this.player.play(base64Audio);

            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.text) {
                  this.onMessageCallback?.({
                    id: Date.now().toString(),
                    role: 'model',
                    text: part.text,
                    isThinking: true,
                  });
                }
              }
            }

            const outputTranscription = (message.serverContent as any)?.outputTranscription?.text;
            if (outputTranscription) {
              this.appendTranscript('model', outputTranscription);
              this.onMessageCallback?.({
                id: Date.now().toString(),
                role: 'model',
                text: outputTranscription,
                isThinking: false,
              });
            }

            const inputTranscription = (message.serverContent as any)?.inputTranscription?.text;
            if (inputTranscription) {
              this.appendTranscript('user', inputTranscription);
              this.onMessageCallback?.({
                id: Date.now().toString(),
                role: 'user',
                text: inputTranscription,
              });
            }

            if (message.serverContent?.interrupted) this.player.stop();

            const functionCalls = message.toolCall?.functionCalls;
            if (functionCalls?.length) {
              this.onStatusCallback?.('Using tools...');
              const responses = await Promise.all(
                functionCalls.map(async (call) => {
                  this.onMessageCallback?.({
                    id: call.id,
                    role: 'system',
                    text: `🔧 Calling tool: **${call.name}**`,
                    isToolCall: true,
                    toolDetails: { args: call.args },
                  });
                  const result = await handleToolCall(call.name, call.args);
                  this.onMessageCallback?.({
                    id: call.id + '_result',
                    role: 'system',
                    text: `🔧 Tool **${call.name}** completed.`,
                    isToolCall: true,
                    toolDetails: { args: call.args, result },
                  });
                  return { id: call.id, name: call.name, response: result };
                })
              );
              this.session?.sendToolResponse({ functionResponses: responses });
              this.onStatusCallback?.('Connected');
            }
          },

          onerror: (error: any) => {
            console.error('Live API Error:', error);
            this.onStatusCallback?.('Error');
            this.disconnect();
          },

          onclose: (event: any) => {
            const code = event?.code ?? 0;
            const reason = event?.reason ?? '';
            console.log('[Live] onclose', code, reason);

            // Desconexao inesperada (nao foi o usuario quem fechou)
            if (code !== 1000 && config.onUnexpectedDisconnect) {
              config.onUnexpectedDisconnect({
                transcript: this.transcriptLines.join('\n'),
                closeCode: code,
                closeReason: reason,
              });
            }

            this.recorder.stop();
            this.session = null;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.onStatusCallback?.('Disconnected');
          },
        },
      });
    } catch (error) {
      console.error('Failed to connect:', error);
      this.onStatusCallback?.('Connection Failed');
    }
  }

  async sendText(text: string) {
    if (!this.session) return;
    try {
      this.appendTranscript('user', text);
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
      this.onMessageCallback?.({
        id: Date.now().toString(),
        role: 'user',
        text,
      });
    } catch (error) {
      console.error('Error sending text:', error);
    }
  }

  async disconnect() {
    this.recorder.stop();
    this.player.stop();
    this.session = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.onStatusCallback?.('Disconnected');
  }
}
