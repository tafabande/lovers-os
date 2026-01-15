'use client';

import { useEffect, useState, useRef } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { HLC } from '@/lib/hlc';
import { calculateResonance } from '@/lib/crdt';
import { EVENTS, Packet, UserProfile } from '@/lib/protocol';
import { sendPacketToMemory, subscribeToMemory, onAuthChange, getUserProfile } from '@/lib/firebase';
import { Battery, Zap, Heart, Image as ImageIcon, Hand, Send } from 'lucide-react';
import { useTheme } from './components/ThemeProvider';
import { Auth } from './components/Auth';
import { Navbar } from './components/Navbar';

const moodEmojis: { [key: number]: string } = {
  1: '😔', 2: '😐', 3: '🙂', 4: '😊', 5: '🥰'
};

export default function NervHQ() {
  const { socket, isConnected } = useSocket();
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { theme } = useTheme();
  
  // STATE
  const [user, setUser] = useState<UserProfile | null>(null);
  const [clock, setClock] = useState<HLC>(new HLC('unknown'));
  const [packets, setPackets] = useState<Packet[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  
  // METRICS
  const [myMood, setMyMood] = useState(3);
  const [partnerMood, setPartnerMood] = useState(3);
  const [battery, setBattery] = useState(100);
  const [partnerBattery, setPartnerBattery] = useState(100);
  const [latency, setLatency] = useState(0);
  const [resonance, setResonance] = useState(100);
  
  // PRESENCE
  const [isPartnerTyping, setIsPartnerTyping] = useState(false);
  const [typingTimer, setTypingTimer] = useState<NodeJS.Timeout | null>(null);
  const [showNudge, setShowNudge] = useState(false);

  // --- 1. BOOT ---
  useEffect(() => {
    const unsubscribe = onAuthChange(async (authUser) => {
      if (authUser) {
        const profile = await getUserProfile(authUser.uid);
        if (profile.exists()) {
          setUser({ id: authUser.uid, ...profile.data() } as UserProfile);
          setClock(new HLC(authUser.uid));
        }
      } else {
        setUser(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // --- 2. MEMORY STREAM ---
  useEffect(() => {
    if (!user) return;
    
    const unsub = subscribeToMemory((incoming: Packet[]) => {
      setPackets(incoming);
      
      if (incoming.length > 0) {
        const last = incoming[incoming.length - 1];
        setClock((prev: HLC) => prev.receive(HLC.fromString(last.hlc)));
      }

      const incomingCopy = [...incoming].reverse();
      
      const lastBatteryPkt = incomingCopy.find((p: Packet) => p.type === 'BATTERY' && p.sender !== user.id);
      if (lastBatteryPkt) setPartnerBattery(lastBatteryPkt.payload.level);

      const lastMoodPkt = incomingCopy.find((p: Packet) => p.type === 'MOOD' && p.sender !== user.id);
      if (lastMoodPkt) setPartnerMood(lastMoodPkt.payload.level);
    });

    return () => unsub();
  }, [user]);

  // Scroll on new message
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [packets]);

  // --- 3. REFLEX ARC & HEARTBEAT ---
  useEffect(() => {
    if (!socket) return;
    
    const pingInterval = setInterval(() => {
      socket.emit(EVENTS.PING, { start: Date.now() });
    }, 5000);

    socket.on(EVENTS.PONG, (payload: any) => setLatency(Date.now() - payload.start));

    socket.on(EVENTS.SIGNAL, (pkt: Packet) => {
       if (pkt.sender === user?.id) return;
       
       if (pkt.type === 'BATTERY') setPartnerBattery(pkt.payload.level);
       if (pkt.type === 'MOOD') setPartnerMood(pkt.payload.level);
       if (pkt.type === 'NUDGE') {
        setShowNudge(true);
        setTimeout(() => setShowNudge(false), 3000);
       }
    });

    socket.on(EVENTS.TYPING, () => {
      setIsPartnerTyping(true);
      if (typingTimer) clearTimeout(typingTimer);
      const t = setTimeout(() => setIsPartnerTyping(false), 3000);
      setTypingTimer(t);
    });

    return () => {
      clearInterval(pingInterval);
      if (typingTimer) clearTimeout(typingTimer);
      socket.off(EVENTS.PONG);
      socket.off(EVENTS.SIGNAL);
      socket.off(EVENTS.TYPING);
    };
  }, [socket, user, typingTimer]);

  // Update Resonance
  useEffect(() => {
    setResonance(calculateResonance(myMood, partnerMood, latency));
  }, [myMood, partnerMood, latency]);

  // --- ACTIONS ---
  const transmit = async (type: 'CHAT' | 'MOOD' | 'BATTERY' | 'IMAGE' | 'NUDGE', payload: any) => {
    if (!user) return;
    
    const newClock = clock.increment();
    setClock(newClock);

    const packet: Packet = {
      type, payload,
      hlc: newClock.toString(),
      sender: user.id,
      serverTimestamp: Date.now(),
    };
    if (socket) socket.emit(EVENTS.SIGNAL, packet);
    await sendPacketToMemory(packet);
    
    if (type === 'MOOD') setMyMood(payload.level);
    if (type === 'BATTERY') setBattery(payload.level);
    if (type === 'IMAGE') setImageFile(null);
    if (type === 'CHAT') setMessage('');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setImageFile(e.target.files[0]);
    }
  };

  const handleImageUpload = () => {
    if (!imageFile) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result;
      transmit('IMAGE', { image: base64 });
    };
    reader.readAsDataURL(imageFile);
  };

  // --- RENDER ---
  if (!user) return <Auth />;

  return (
    <div className={`min-h-screen flex flex-col font-mono bg-background text-foreground transition-colors duration-500 ${battery < 20 ? 'grayscale opacity-60' : ''}`}>
      <Navbar user={user} />
      
      {showNudge && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-5xl animate-ping text-primary">
          <Hand size={64} />
        </div>
      )}

      <main className="flex-1 flex flex-col p-4">
        {/* STATUS DECK */}
        <section className="grid grid-cols-2 gap-4 mb-4">
          <div className="bg-card border border-border rounded-lg p-4 glow-effect">
            <div className="flex justify-between items-center mb-2">
              <div className="text-sm font-bold text-blue-400">YOU</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Battery size={12} /> {battery}%
              </div>
            </div>
            <div className="text-4xl">{moodEmojis[myMood]}</div>
            <input type="range" min="0" max="100" value={battery} onChange={(e) => transmit('BATTERY', {level: Number(e.target.value)})} className="w-full mt-3 h-1 bg-muted rounded appearance-none" />
          </div>

          <div className="bg-card border border-border rounded-lg p-4 opacity-90 glow-effect">
            <div className="flex justify-between items-center mb-2">
              <div className="text-sm font-bold text-purple-400">PARTNER</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Zap size={12} className={partnerBattery < 20 ? 'text-red-500' : 'text-yellow-500'} /> {partnerBattery}%
              </div>
            </div>
            <div className="text-4xl">{moodEmojis[partnerMood]}</div>
            <div className="text-xs text-right mt-3 h-4 text-blue-400">
              {isPartnerTyping ? 'Typing...' : ''}
            </div>
          </div>
        </section>

        {/* MOOD & NUDGE CONTROL */}
        <div className="flex items-center gap-2 mb-4">
          <div className="grid grid-cols-5 gap-2 flex-1">
            {Object.entries(moodEmojis).map(([level, emoji]) => (
              <button key={level} onClick={() => transmit('MOOD', {level: Number(level)})} className={`py-3 rounded-lg border text-2xl transition-all duration-300 transform hover:scale-110 ${myMood===Number(level) ? 'bg-primary text-primary-foreground border-primary shadow-lg glow-effect' : 'border-border text-muted-foreground hover:bg-accent'}`}>{emoji}</button>
            ))}
          </div>
          <button onClick={() => transmit('NUDGE', {})} className="p-4 rounded-lg border border-border text-muted-foreground hover:bg-accent transition-colors transform hover:scale-110">
            <Hand size={28} />
          </button>
        </div>

        {/* FEED */}
        <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col relative shadow-inner glow-effect">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {packets.map((pkt: Packet) => (
              <div key={pkt.hlc} className={`flex flex-col ${pkt.sender===user.id ? 'items-end' : 'items-start'}`}>
                <div className={`flex items-end gap-2 max-w-[85%] ${pkt.sender === user.id ? 'flex-row-reverse' : 'flex-row'}`}>
                  <img src={pkt.sender === user.id ? user.avatar : 'https://api.dicebear.com/8.x/bottts/svg?seed=partner'} className="w-6 h-6 rounded-full" />
                  {pkt.type === 'CHAT' && (
                    <div className={`p-3 rounded-2xl text-sm ${pkt.sender===user.id ? 'bg-primary text-primary-foreground rounded-br-none' : 'bg-secondary text-secondary-foreground rounded-bl-none'}`}>
                      {pkt.payload.text}
                    </div>
                  )}
                  {pkt.type === 'IMAGE' && (
                    <img src={pkt.payload.image} alt="transmitted" className="max-w-full p-1 border border-border rounded-lg" />
                  )}
                  {pkt.type === 'NUDGE' && (
                    <div className="text-sm text-muted-foreground animate-pulse">
                      Nudge
                    </div>
                  )}
                </div>
                <div className={`text-[10px] text-muted-foreground mt-1 ${pkt.sender === user.id ? 'mr-8' : 'ml-8'}`}>
                  {new Date(pkt.serverTimestamp || 0).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
          
          <div className="p-2 bg-card border-t border-border flex items-center gap-2">
            <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
            <button onClick={() => fileInputRef.current?.click()} className="p-3 text-muted-foreground hover:text-foreground transition-colors">
              <ImageIcon size={20} />
            </button>
            <input 
              type="text" 
              placeholder="Transmit..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full bg-background border border-border rounded-lg p-3 text-sm text-foreground focus:border-primary outline-none transition-all duration-300 focus:shadow-lg focus:shadow-primary/20"
              onKeyDown={(e) => {
                if(e.key==='Enter') {
                  transmit('CHAT', {text: message});
                }
                socket?.emit(EVENTS.TYPING);
              }}
            />
            <button onClick={() => transmit('CHAT', {text: message})} className="p-3 bg-primary text-primary-foreground rounded-lg transform hover:scale-110 transition-transform">
              <Send size={20} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
