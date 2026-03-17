import { GoogleGenAI, LiveServerMessage, Modality, MediaResolution, TurnCoverage } from '@google/genai';
import { AudioRecorder, AudioPlayer } from './audio';
import { modularTools, handleToolCall } from './tools';

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
}

export type Message = {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  isToolCall?: boolean;
  toolDetails?: any;
  isThinking?: boolean;
};

// Busca a API key do servidor em runtime (nao fica no bundle)
async function getApiKey(): Promise<string> {
  // Em dev local, ainda pode usar .env via import.meta.env
  const devKey = (import.meta as any).env?.VITE_GEMINI_API_KEY;
  if (devKey) return devKey;

  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Nao foi possivel obter a API key do servidor');
  const data = await res.json();
  if (!data.apiKey) throw new Error('API key ausente na resposta do servidor');
  return data.apiKey;
}

export class LiveSessionManager {
  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private onMessageCallback: ((msg: Message) => void) | null = null;
  private onStatusCallback: ((status: string) => void) | null = null;
  private isMuted: boolean = false;

  constructor() {
    this.recorder = new AudioRecorder();
    this.player = new AudioPlayer();
  }

  setCallbacks(onMessage: (msg: Message) => void, onStatus: (status: string) => void) {
    this.onMessageCallback = onMessage;
    this.onStatusCallback = onStatus;
  }

  setMuted(muted: boolean) {
    this.isMuted = muted;
    this.player.setAudioMuted(muted);
  }

  setMicMuted(muted: boolean) {
    this.recorder.setMicMuted(muted);
  }

  getMicMuted(): boolean {
    return this.recorder.getMicMuted();
  }

  setAudioOutputMuted(muted: boolean) {
    this.player.setAudioMuted(muted);
  }

  getAudioOutputMuted(): boolean {
    return this.player.getAudioMuted();
  }

  isMicActive(): boolean {
    return this.recorder.isActive();
  }

  async connect(config: LiveConfig) {
    if (this.session) await this.disconnect();

    this.isMuted = !config.playAudio;
    this.player.setAudioMuted(!config.playAudio);
    this.onStatusCallback?.('Connecting...');

    try {
      const apiKey = await getApiKey();
      this.ai = new GoogleGenAI({ apiKey });

      const tools: any[] = [];
      if (config.functionCalling) tools.push({ functionDeclarations: modularTools });
      if (config.grounding) tools.push({ googleSearch: {} });

      const sessionPromise = this.ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          mediaResolution: config.mediaResolution === 'High'
            ? MediaResolution.MEDIA_RESOLUTION_HIGH
            : MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          realtimeInputConfig: config.turnCoverage
            ? { turnCoverage: TurnCoverage.TURN_INCLUDES_ALL_INPUT }
            : undefined,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
          },
          systemInstruction: config.systemInstruction || config.sessionContext || 'You are a helpful, multimodal AI assistant.',
          tools: tools.length > 0 ? tools : undefined,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            this.onStatusCallback?.('Connected');
            this.recorder.start((base64Data) => {
              sessionPromise.then((session) => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
                });
              });
            });
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
                    isThinking: true
                  });
                }
              }
            }

            const outputTranscriptionText = (message.serverContent as any)?.outputTranscription?.text;
            if (outputTranscriptionText) {
              this.onMessageCallback?.({
                id: Date.now().toString(),
                role: 'model',
                text: outputTranscriptionText,
                isThinking: false
              });
            }

            const inputTranscriptionText = (message.serverContent as any)?.inputTranscription?.text;
            if (inputTranscriptionText) {
              this.onMessageCallback?.({ id: Date.now().toString(), role: 'user', text: inputTranscriptionText });
            }

            if (message.serverContent?.interrupted) this.player.stop();

            const functionCalls = message.toolCall?.functionCalls;
            if (functionCalls && functionCalls.length > 0) {
              this.onStatusCallback?.('Using tools...');
              const responses = await Promise.all(
                functionCalls.map(async (call) => {
                  this.onMessageCallback?.({
                    id: call.id,
                    role: 'system',
                    text: `🔧 Calling tool: **${call.name}**`,
                    isToolCall: true,
                    toolDetails: { args: call.args }
                  });
                  const result = await handleToolCall(call.name, call.args);
                  this.onMessageCallback?.({
                    id: call.id + '_result',
                    role: 'system',
                    text: `🔧 Tool **${call.name}** completed.`,
                    isToolCall: true,
                    toolDetails: { args: call.args, result }
                  });
                  return { id: call.id, name: call.name, response: result };
                })
              );
              sessionPromise.then((session) => {
                session.sendToolResponse({ functionResponses: responses });
              });
              this.onStatusCallback?.('Connected');
            }
          },
          onerror: (error) => {
            console.error('Live API Error:', error);
            this.onStatusCallback?.('Error');
            this.disconnect();
          },
          onclose: () => {
            this.onStatusCallback?.('Disconnected');
            this.disconnect();
          },
        },
      });

      this.session = await sessionPromise;
    } catch (error) {
      console.error('Failed to connect:', error);
      this.onStatusCallback?.('Connection Failed');
    }
  }

  async sendText(text: string) {
    if (!this.session) return;
    try {
      await this.session.send({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      });
      this.onMessageCallback?.({ id: Date.now().toString(), role: 'user', text });
    } catch (error) {
      console.error('Error sending text:', error);
    }
  }

  async disconnect() {
    this.recorder.stop();
    this.player.stop();
    if (this.session) {
      try { this.session = null; } catch (e) { console.error(e); }
    }
    this.onStatusCallback?.('Disconnected');
  }
}
