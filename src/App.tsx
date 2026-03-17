import React, { useState, useEffect, useRef } from 'react';
import { Settings, Mic, MicOff, Send, AudioLines, Sparkles, Search, Code, Cpu, Edit2, Trash2, Plus, Eye, Download, Volume2, VolumeX, Radio } from 'lucide-react';
import { cn } from './lib/utils';
import { LiveSessionManager, Message } from './lib/live';
import ReactMarkdown from 'react-markdown';

interface Instruction {
  id: string;
  name: string;
  text: string;
}

interface SessionHistory {
  id: string;
  startedAt: string;
  endedAt?: string;
  instruction: string;
  model: string;
  voice: string;
  messages: Message[];
}

export default function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState('Disconnected');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');

  // Mic & Audio controls
  const [micMuted, setMicMuted] = useState(false);
  const [audioOutputMuted, setAudioOutputMuted] = useState(false);

  // Config State
  const [model, setModel] = useState('gemini-2.5-flash-native-audio-preview-12-2025');
  const [voice, setVoice] = useState('Zephyr');
  const [mediaResolution, setMediaResolution] = useState('258 tokens / image');
  const [turnCoverage, setTurnCoverage] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(0);
  const [affectiveDialog, setAffectiveDialog] = useState(false);
  const [proactiveAudio, setProactiveAudio] = useState(false);
  const [sessionContext, setSessionContext] = useState('');
  const [functionCalling, setFunctionCalling] = useState(true);
  const [autoFunctionResponse, setAutoFunctionResponse] = useState(true);
  const [groundingSearch, setGroundingSearch] = useState(false);
  const [playAudio, setPlayAudio] = useState(true);

  // Instructions State
  const [instructions, setInstructions] = useState<Instruction[]>(() => {
    const saved = localStorage.getItem('livego_instructions');
    if (saved) return JSON.parse(saved);
    return [
      { id: 'uuid1', name: 'Ator psicólogo', text: 'Você é um ator, psicólogo...' },
      { id: 'uuid2', name: 'Assistente padrão', text: 'Você é um assistente. Responda em português.' },
      { id: 'uuid3', name: 'Suporte técnico', text: 'Você é um especialista em suporte técnico...' }
    ];
  });
  const [activeInstructionId, setActiveInstructionId] = useState<string>(() => {
    return localStorage.getItem('livego_active_instruction') || 'uuid1';
  });

  // History State
  const [history, setHistory] = useState<SessionHistory[]>(() => {
    const saved = localStorage.getItem('livego_history');
    return saved ? JSON.parse(saved) : [];
  });
  const currentSessionRef = useRef<SessionHistory | null>(null);

  // Modals State
  const [editingInstruction, setEditingInstruction] = useState<Instruction | null>(null);
  const [viewingSession, setViewingSession] = useState<SessionHistory | null>(null);

  const sessionManagerRef = useRef<LiveSessionManager | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('livego_instructions', JSON.stringify(instructions));
  }, [instructions]);

  useEffect(() => {
    localStorage.setItem('livego_active_instruction', activeInstructionId);
  }, [activeInstructionId]);

  const persistHistory = (session: SessionHistory) => {
    setHistory(prev => {
      const newHistory = [...prev];
      const idx = newHistory.findIndex(s => s.id === session.id);
      if (idx >= 0) newHistory[idx] = session;
      else newHistory.unshift(session);
      localStorage.setItem('livego_history', JSON.stringify(newHistory));
      return newHistory;
    });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Sincroniza playAudio toggle com o player
  useEffect(() => {
    if (sessionManagerRef.current) {
      sessionManagerRef.current.setMuted(!playAudio);
    }
  }, [playAudio]);

  useEffect(() => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      sessionManagerRef.current = new LiveSessionManager(apiKey);
      sessionManagerRef.current.setCallbacks(
        (msg) => {
          setMessages((prev) => {
            let newMessages;
            if (prev.length === 0) {
              newMessages = [msg];
            } else if (msg.role === 'system' || msg.isToolCall) {
              newMessages = [...prev, msg];
            } else {
              let targetIndex = -1;
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].role !== msg.role) break;
                if (prev[i].isThinking === msg.isThinking && !prev[i].isToolCall) {
                  targetIndex = i;
                  break;
                }
              }
              if (targetIndex !== -1) {
                newMessages = [...prev];
                newMessages[targetIndex] = {
                  ...newMessages[targetIndex],
                  text: newMessages[targetIndex].text + msg.text
                };
              } else {
                newMessages = [...prev, msg];
              }
            }
            if (currentSessionRef.current) {
              currentSessionRef.current.messages = newMessages;
              persistHistory(currentSessionRef.current);
            }
            return newMessages;
          });
        },
        (newStatus) => {
          setStatus(newStatus);
          if (newStatus === 'Connected') setIsConnected(true);
          if (newStatus === 'Disconnected' || newStatus === 'Connection Failed') {
            setIsConnected(false);
            // Reset mic/audio states ao desconectar
            setMicMuted(false);
            setAudioOutputMuted(false);
          }
        }
      );
    }
    return () => {
      sessionManagerRef.current?.disconnect();
    };
  }, []);

  const toggleConnection = async () => {
    if (isConnected) {
      if (currentSessionRef.current) {
        currentSessionRef.current.endedAt = new Date().toISOString();
        persistHistory(currentSessionRef.current);
        currentSessionRef.current = null;
      }
      await sessionManagerRef.current?.disconnect();
    } else {
      setMessages([]);
      setMicMuted(false);
      setAudioOutputMuted(false);

      const activeInstruction = instructions.find(i => i.id === activeInstructionId);
      const systemInstruction = activeInstruction?.text || 'Você é um assistente. Responda em português.';

      currentSessionRef.current = {
        id: 'sess_' + Date.now(),
        startedAt: new Date().toISOString(),
        instruction: activeInstruction?.name || 'Unknown',
        model,
        voice,
        messages: []
      };
      persistHistory(currentSessionRef.current);

      await sessionManagerRef.current?.connect({
        voice,
        thinkingMode,
        grounding: groundingSearch,
        functionCalling,
        sessionContext,
        mediaResolution,
        turnCoverage,
        playAudio,
        systemInstruction,
      });
    }
  };

  // Toggle mute do microfone (entrada)
  const toggleMicMute = () => {
    if (!isConnected || !sessionManagerRef.current) return;
    const newMuted = !micMuted;
    setMicMuted(newMuted);
    sessionManagerRef.current.setMicMuted(newMuted);
  };

  // Toggle mute do audio de saida
  const toggleAudioOutputMute = () => {
    if (!sessionManagerRef.current) return;
    const newMuted = !audioOutputMuted;
    setAudioOutputMuted(newMuted);
    sessionManagerRef.current.setAudioOutputMuted(newMuted);
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !isConnected) return;
    await sessionManagerRef.current?.sendText(inputText);
    setInputText('');
  };

  return (
    <div className="flex h-screen bg-[#1e1e1e] text-gray-200 font-sans overflow-hidden">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Header */}
        <header className="h-14 border-b border-white/10 flex items-center justify-between px-4 bg-[#1e1e1e] z-10">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-400" />
            <h1 className="font-medium text-gray-100">Gemini Live Hub</h1>
            <span className={cn(
              "ml-3 px-2 py-0.5 rounded-full text-xs font-medium",
              isConnected ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
            )}>
              {status}
            </span>
          </div>
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors"
          >
            <Settings className="w-5 h-5 text-gray-400" />
          </button>
        </header>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className={cn("h-full flex flex-col items-center justify-center text-gray-500 space-y-4 chat-empty-hint", isConnected ? "hidden" : "")}>
              <AudioLines className="w-16 h-16 opacity-20" />
              <p>Connect and start speaking, or type a message.</p>
            </div>
          ) : (
            messages.map((msg, i) => {
              if (msg.role === 'system' || msg.isToolCall || msg.isThinking) {
                return (
                  <details key={i} className="mx-auto max-w-2xl bg-[#2a2a2a] border border-white/10 rounded-lg p-3 text-sm text-gray-300 group">
                    <summary className="cursor-pointer font-medium select-none text-gray-400 flex items-center justify-center gap-2 hover:text-gray-200 transition-colors">
                      <Cpu className="w-4 h-4" />
                      <span>{msg.isThinking ? 'THINKING...' : 'SYSTEM...'}</span>
                    </summary>
                    <div className="mt-3 text-left border-t border-white/10 pt-3">
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                      {msg.toolDetails && (
                        <pre className="mt-2 overflow-x-auto bg-black/20 rounded p-2 text-xs text-gray-400 whitespace-pre-wrap">
                          {JSON.stringify(msg.toolDetails, null, 2)}
                        </pre>
                      )}
                    </div>
                  </details>
                );
              }

              return (
                <div key={i} className={cn(
                  "max-w-[80%] rounded-2xl p-4",
                  msg.role === 'user'
                    ? "bg-blue-600/20 text-blue-100 ml-auto rounded-tr-sm"
                    : "bg-white/5 text-gray-200 mr-auto rounded-tl-sm"
                )}>
                  <div className="text-xs opacity-50 mb-1 uppercase tracking-wider font-semibold">
                    {msg.role === 'user' ? 'You' : 'Gemini'}
                  </div>
                  <div className="prose prose-invert prose-sm max-w-none">
                    <ReactMarkdown>{msg.text}</ReactMarkdown>
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-[#1e1e1e] border-t border-white/10">
          <form onSubmit={handleSendText} className="flex gap-2 max-w-4xl mx-auto items-center">

            {/* Botao conectar / desconectar */}
            <button
              type="button"
              onClick={toggleConnection}
              title={isConnected ? 'Desconectar' : 'Conectar e iniciar voz'}
              className={cn(
                "p-3 rounded-xl flex items-center justify-center transition-all shrink-0",
                isConnected
                  ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              )}
            >
              {isConnected ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {/* Botao mute do microfone — so aparece conectado */}
            {isConnected && (
              <button
                type="button"
                onClick={toggleMicMute}
                title={micMuted ? 'Desmutar microfone' : 'Mutar microfone'}
                className={cn(
                  "p-3 rounded-xl flex items-center justify-center transition-all shrink-0 relative",
                  micMuted
                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/40"
                    : "bg-white/5 text-gray-300 hover:bg-white/10"
                )}
              >
                {micMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                {/* Bolinha indicadora */}
                <span className={cn(
                  "absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full",
                  micMuted ? "bg-red-400" : "bg-green-400 animate-pulse"
                )} />
              </button>
            )}

            {/* Botao mute do audio de saida */}
            <button
              type="button"
              onClick={toggleAudioOutputMute}
              title={audioOutputMuted ? 'Desmutar audio de saida' : 'Mutar audio de saida'}
              className={cn(
                "p-3 rounded-xl flex items-center justify-center transition-all shrink-0",
                audioOutputMuted
                  ? "bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 ring-1 ring-orange-500/40"
                  : "bg-white/5 text-gray-300 hover:bg-white/10"
              )}
            >
              {audioOutputMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            {/* Input de texto */}
            <div className="flex-1 relative">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={isConnected ? 'Type a message...' : 'Connect to start chatting'}
                disabled={!isConnected}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || !isConnected}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>

          {/* Legenda dos botoes — so quando conectado */}
          {isConnected && (
            <div className="flex gap-2 max-w-4xl mx-auto mt-2 px-1">
              <span className="text-[10px] text-gray-600 w-[46px] text-center">desconectar</span>
              <span className="text-[10px] text-gray-600 w-[46px] text-center">
                {micMuted ? '🔴 mic off' : '🟢 mic on'}
              </span>
              <span className="text-[10px] text-gray-600 w-[46px] text-center">
                {audioOutputMuted ? '🔴 audio off' : '🟢 audio on'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Configuration Sidebar */}
      <div className={cn(
        "config-panel w-[340px] bg-[#1e1e1e] border-l border-white/10 overflow-y-auto transition-all duration-300 ease-in-out shrink-0 flex flex-col",
        isSidebarOpen ? "translate-x-0" : "translate-x-full hidden"
      )}>
        <div className="p-4 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
            <Settings className="w-4 h-4" />
            CONFIGURAÇÕES
          </h2>
        </div>

        <div className="p-4 space-y-2 flex-1 overflow-y-auto">

          {/* 1. MODELO */}
          <CollapsibleSection title="🤖 MODELO" defaultOpen>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-gray-400">Seletor de modelo</label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-[#2a2a2a] border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-200 appearance-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="gemini-2.5-flash-native-audio-preview-12-2025">gemini-2.5-flash-native-audio...</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                </select>
              </div>
              <ToggleRow label="Thinking mode" checked={thinkingMode} onChange={setThinkingMode} />
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-200">Thinking budget</span>
                  <span className="text-gray-400">{thinkingBudget}</span>
                </div>
                <input
                  type="range"
                  min="0" max="8000" step="100"
                  value={thinkingBudget}
                  onChange={(e) => setThinkingBudget(parseInt(e.target.value))}
                  className="w-full"
                  style={{ '--range-progress': `${(thinkingBudget / 8000) * 100}%` } as React.CSSProperties}
                />
              </div>
              <ToggleRow label="Affective dialog" checked={affectiveDialog} onChange={setAffectiveDialog} />
              <ToggleRow label="Proactive audio" checked={proactiveAudio} onChange={setProactiveAudio} />
              <ToggleRow label="Turn coverage" checked={turnCoverage} onChange={setTurnCoverage} />
              <div className="space-y-2">
                <label className="text-xs text-gray-400">Media resolution</label>
                <select
                  value={mediaResolution}
                  onChange={(e) => setMediaResolution(e.target.value)}
                  className="w-full bg-[#2a2a2a] border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-200 appearance-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="258 tokens / image">258 tokens / image</option>
                  <option value="High">High</option>
                </select>
              </div>
            </div>
          </CollapsibleSection>

          {/* 2. VOZ */}
          <CollapsibleSection title="🎙 VOZ" defaultOpen>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs text-gray-400">Seletor de voz</label>
                <div className="relative">
                  <select
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    className="w-full bg-[#2a2a2a] border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-200 appearance-none focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="Zephyr">Zephyr (Brilhante)</option>
                    <option value="Puck">Puck (Upbeat)</option>
                    <option value="Charon">Charon (Informativa)</option>
                    <option value="Kore">Kore (Firme)</option>
                    <option value="Fenrir">Fenrir (Excitável)</option>
                    <option value="Aoede">Aoede (Breezy)</option>
                    <option value="Enceladus">Enceladus (Breathy)</option>
                    <option value="Sulafat">Sulafat (Quente)</option>
                    <option value="Achird">Achird (Amigável)</option>
                    <option value="Sadaltager">Sadaltager (Conhecimento)</option>
                  </select>
                  <AudioLines className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
                </div>
              </div>
              <ToggleRow label="Play Audio (Mute)" checked={playAudio} onChange={setPlayAudio} />
            </div>
          </CollapsibleSection>

          {/* 3. INSTRUCTIONS */}
          <CollapsibleSection title="📋 INSTRUCTIONS" defaultOpen>
            <div className="space-y-3">
              <div className="space-y-2">
                {instructions.map(inst => (
                  <div key={inst.id} className="flex items-center justify-between group/item p-2 hover:bg-white/5 rounded-lg transition-colors">
                    <label className="flex items-center gap-3 cursor-pointer flex-1 min-w-0">
                      <input
                        type="radio"
                        name="instruction"
                        checked={activeInstructionId === inst.id}
                        onChange={() => setActiveInstructionId(inst.id)}
                        className="shrink-0"
                      />
                      <span className="text-sm text-gray-200 truncate">{inst.name}</span>
                    </label>
                    <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
                      <button
                        onClick={() => setEditingInstruction(inst)}
                        className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-400/10 rounded"
                        title="Editar"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setInstructions(prev => prev.filter(i => i.id !== inst.id))}
                        className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded"
                        title="Excluir"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setEditingInstruction({ id: 'uuid_' + Date.now(), name: 'Nova Instruction', text: '' })}
                className="w-full py-2 flex items-center justify-center gap-2 text-sm text-blue-400 hover:bg-blue-400/10 rounded-lg transition-colors border border-blue-400/20 border-dashed"
              >
                <Plus className="w-4 h-4" />
                Nova Instruction
              </button>
            </div>
          </CollapsibleSection>

          {/* 4. HISTÓRICO */}
          <CollapsibleSection title="🕓 HISTÓRICO" defaultOpen>
            <div className="space-y-3">
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {history.length === 0 ? (
                  <p className="empty-state text-center text-gray-500 text-xs py-4 italic">Nenhuma sessão salva.</p>
                ) : (
                  history.map(session => (
                    <div key={session.id} className="flex items-center justify-between group/item p-2 hover:bg-white/5 rounded-lg transition-colors text-xs">
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-gray-300 truncate">{new Date(session.startedAt).toLocaleString()}</span>
                        <span className="text-gray-500 truncate">{session.instruction}</span>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0 ml-2">
                        <button
                          onClick={() => setViewingSession(session)}
                          className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-400/10 rounded"
                          title="Ver"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setHistory(prev => prev.filter(s => s.id !== session.id))}
                          className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded"
                          title="Excluir"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {history.length > 0 && (
                <div className="flex gap-2 pt-2 border-t border-white/10">
                  <button
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' });
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = `livego_history_${Date.now()}.json`;
                      a.click();
                    }}
                    className="flex-1 py-1.5 flex items-center justify-center gap-1.5 text-xs text-gray-300 hover:bg-white/10 rounded transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> JSON
                  </button>
                  <button
                    onClick={() => {
                      let txt = '';
                      for (const sess of history) {
                        txt += `\n${'='.repeat(60)}\n`;
                        txt += `SESSÃO: ${sess.startedAt}\n`;
                        txt += `Modelo: ${sess.model} | Voz: ${sess.voice}\n`;
                        txt += `Instruction: ${sess.instruction}\n`;
                        txt += `${'='.repeat(60)}\n\n`;
                        for (const msg of sess.messages) {
                          if (msg.isThinking) continue;
                          txt += `[${new Date(parseInt(msg.id) || Date.now()).toISOString()}] ${msg.role.toUpperCase()}: ${msg.text}\n`;
                        }
                      }
                      const blob = new Blob([txt], { type: 'text/plain' });
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = `livego_history_${Date.now()}.txt`;
                      a.click();
                    }}
                    className="flex-1 py-1.5 flex items-center justify-center gap-1.5 text-xs text-gray-300 hover:bg-white/10 rounded transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> TXT
                  </button>
                  <button
                    onClick={() => {
                      if (confirm('Tem certeza que deseja limpar todo o histórico?')) {
                        setHistory([]);
                        localStorage.removeItem('livego_history');
                      }
                    }}
                    className="flex-1 py-1.5 flex items-center justify-center gap-1.5 text-xs text-red-400 hover:bg-red-400/10 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Limpar
                  </button>
                </div>
              )}
            </div>
          </CollapsibleSection>

        </div>
      </div>

      {/* Modal editar instruction */}
      {editingInstruction && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
              <h3 className="text-lg font-medium text-gray-200">
                {instructions.find(i => i.id === editingInstruction.id) ? 'Editar Instruction' : 'Nova Instruction'}
              </h3>
              <button onClick={() => setEditingInstruction(null)} className="text-gray-400 hover:text-gray-200">✕</button>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1">
              <div className="space-y-2">
                <label className="text-sm text-gray-400">Nome</label>
                <input
                  type="text"
                  value={editingInstruction.name}
                  onChange={e => setEditingInstruction({ ...editingInstruction, name: e.target.value })}
                  className="w-full bg-[#2a2a2a] border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Ex: Ator psicólogo"
                />
              </div>
              <div className="space-y-2 flex-1 flex flex-col">
                <label className="text-sm text-gray-400">System Instruction</label>
                <textarea
                  value={editingInstruction.text}
                  onChange={e => setEditingInstruction({ ...editingInstruction, text: e.target.value })}
                  className="w-full bg-[#2a2a2a] border border-white/5 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-[200px] flex-1 resize-none"
                  placeholder="Você é um assistente..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-white/10 flex justify-end gap-2 shrink-0">
              <button onClick={() => setEditingInstruction(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">Cancelar</button>
              <button
                onClick={() => {
                  setInstructions(prev => {
                    const exists = prev.find(i => i.id === editingInstruction.id);
                    if (exists) return prev.map(i => i.id === editingInstruction.id ? editingInstruction : i);
                    return [...prev, editingInstruction];
                  });
                  if (!activeInstructionId) setActiveInstructionId(editingInstruction.id);
                  setEditingInstruction(null);
                }}
                className="px-4 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal ver sessao */}
      {viewingSession && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e1e1e] border border-white/10 rounded-xl w-full max-w-3xl shadow-2xl flex flex-col h-[90vh]">
            <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-lg font-medium text-gray-200">Detalhes da Sessão</h3>
                <p className="text-xs text-gray-500 mt-1">
                  {new Date(viewingSession.startedAt).toLocaleString()} • {viewingSession.model} • {viewingSession.voice}
                </p>
                <p className="text-xs text-blue-400 mt-0.5">Instruction: {viewingSession.instruction}</p>
              </div>
              <button onClick={() => setViewingSession(null)} className="text-gray-400 hover:text-gray-200 p-2">✕</button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-4">
              {viewingSession.messages.map((msg, i) => (
                <div key={i} className={cn(
                  "p-3 rounded-lg max-w-[85%]",
                  msg.role === 'user' ? "bg-blue-500/10 ml-auto" : "bg-white/5",
                  msg.isThinking && "opacity-70 border border-dashed border-white/10"
                )}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                      {msg.role} {msg.isThinking && '(Thinking)'}
                    </span>
                    <span className="text-[10px] text-gray-600">
                      {new Date(parseInt(msg.id) || Date.now()).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className={cn(
                    "text-sm whitespace-pre-wrap",
                    msg.isThinking ? "text-gray-400 font-mono text-xs" : "text-gray-200"
                  )}>
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) {
  return (
    <details className="group border-b border-white/10 pb-2" open={defaultOpen}>
      <summary className="section-header list-none -mx-2 rounded-lg">
        <h3 className="text-sm font-medium text-gray-200 tracking-wide">{title}</h3>
        <span className="chevron">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </summary>
      <div className="pt-2 pb-4 space-y-4">
        {children}
      </div>
    </details>
  );
}

function Toggle({ checked, onChange }: { checked: boolean, onChange: (c: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "w-10 h-5 rounded-full transition-colors relative",
        checked ? "bg-[#7c5cfc]" : "bg-[#3a3a3a]"
      )}
    >
      <div className={cn(
        "absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform",
        checked ? "translate-x-5 bg-white" : "translate-x-0 bg-gray-400"
      )} />
    </button>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string, checked: boolean, onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-200">{label}</span>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
