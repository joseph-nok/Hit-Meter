import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Mic, 
  MicOff, 
  RefreshCw, 
  Plus, 
  Minus, 
  Settings, 
  SlidersHorizontal,
  Volume2, 
  CheckCircle, 
  AlertTriangle,
  Info
} from 'lucide-react';

export default function App() {
  // Mount state & SSR protection
  const [isMounted, setIsMounted] = useState(false);

  // Audio Engine Lifecycle
  const [isEngineReady, setIsEngineReady] = useState(false);
  const [micState, setMicState] = useState<'dormant' | 'active' | 'error'>('dormant');
  const [errorMessage, setErrorMessage] = useState('');

  // Calibration Settings (collapsible to keep layout clean and focused)
  const [showSettings, setShowSettings] = useState(false);
  const [sensitivity, setSensitivity] = useState(20); // 5 to 100
  const [cooldown, setCooldown] = useState(45); // 20ms to 150ms

  // Target BPM Setter
  const [targetBPM, setTargetBPM] = useState(60); // Default is 60 as requested
  const [tolerance, setTolerance] = useState(6); // ±6 BPM tolerance window

  // Live SPM Metrics
  const [liveSPM, setLiveSPM] = useState(0);
  const [strokeCount, setStrokeCount] = useState(0);

  // PWA Installation & Offline State triggers
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  // Web Audio refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);

  // Mutable refs for physics calculations (zero React state lag)
  const sensitivityRef = useRef(20);
  const cooldownRef = useRef(45);
  const lastHitTimeRef = useRef<number>(0);
  const strokeCountRef = useRef<number>(0);
  const hitTimestampsRef = useRef<number[]>([]);
  
  // Tap tempo detector list for manual target BPM configuration
  const tapTimesRef = useRef<number[]>([]);

  // Silent visual metronome state
  const [metronomeTick, setMetronomeTick] = useState(false);

  // Sync state variables to refs to ensure safe live audio thread updates
  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    cooldownRef.current = cooldown;
  }, [cooldown]);

  // Initial SSR bypass and mount callback
  useEffect(() => {
    setIsMounted(true);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setShowInstallBtn(false);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.addEventListener('appinstalled', handleAppInstalled);
    }

    // Load persisted configurations
    const savedBPM = localStorage.getItem('pad_target_bpm');
    if (savedBPM) {
      const parsed = parseInt(savedBPM, 10);
      if (!isNaN(parsed) && parsed >= 30 && parsed <= 300) {
        setTargetBPM(parsed);
      }
    }

    const savedSensitivity = localStorage.getItem('pad_sensitivity');
    if (savedSensitivity) {
      const parsed = parseInt(savedSensitivity, 10);
      if (!isNaN(parsed)) setSensitivity(parsed);
    }

    const savedCooldown = localStorage.getItem('pad_cooldown');
    if (savedCooldown) {
      const parsed = parseInt(savedCooldown, 10);
      if (!isNaN(parsed)) setCooldown(parsed);
    }

    return () => {
      cleanupAudio();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.removeEventListener('appinstalled', handleAppInstalled);
      }
    };
  }, []);

  // Update localStorage when configuration changes
  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('pad_target_bpm', targetBPM.toString());
    }
  }, [targetBPM, isMounted]);

  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('pad_sensitivity', sensitivity.toString());
    }
  }, [sensitivity, isMounted]);

  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('pad_cooldown', cooldown.toString());
    }
  }, [cooldown, isMounted]);

  // Silent Metronome visual timer look-up (pulses exactly to targeted BPM rate)
  useEffect(() => {
    if (targetBPM <= 0) return;

    const intervalMs = (60000 / targetBPM);
    const pulseInterval = setInterval(() => {
      setMetronomeTick(true);
      const timer = setTimeout(() => {
        setMetronomeTick(false);
      }, 100);
      return () => clearTimeout(timer);
    }, intervalMs);

    return () => clearInterval(pulseInterval);
  }, [targetBPM]);

  // Safe Audio feedback system
  const triggerTickTone = (freq = 900, duration = 0.05) => {
    if (!audioCtxRef.current) return;
    try {
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (e) {
      // Ignored safely
    }
  };

  // High Performance Live BPM speed calculator
  // Calculated from moving average interval of hits in the last 2 seconds
  useEffect(() => {
    const calculationInterval = setInterval(() => {
      const now = performance.now();
      const hits = hitTimestampsRef.current;

      // Filter out stamps older than 2.5 seconds
      const activeHits = hits.filter(timestamp => now - timestamp < 2500);
      hitTimestampsRef.current = activeHits;

      if (activeHits.length >= 2) {
        // Calculate interval space
        const intervals: number[] = [];
        for (let i = 1; i < activeHits.length; i++) {
          intervals.push(activeHits[i] - activeHits[i - 1]);
        }
        
        const averageInterval = intervals.reduce((sum, item) => sum + item, 0) / intervals.length;
        if (averageInterval > 40) { // Safety limit inside drum velocity bounds
          const calculatedSPM = Math.round(60000 / averageInterval);
          setLiveSPM(calculatedSPM);
        } else {
          setLiveSPM(0);
        }
      } else {
        // No rolling cadence
        setLiveSPM(0);
      }
    }, 120);

    return () => clearInterval(calculationInterval);
  }, []);

  // Sync state hits with React level to preserve fast tracking
  useEffect(() => {
    const handleHitRegistered = () => {
      setStrokeCount(strokeCountRef.current);
    };

    document.addEventListener('internal-pad-hit', handleHitRegistered);
    return () => {
      document.removeEventListener('internal-pad-hit', handleHitRegistered);
    };
  }, []);

  // Web Audio micro loop processing
  const startAudioEngine = async () => {
    try {
      setErrorMessage('');
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtxClass();
      audioCtxRef.current = ctx;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();

      // Ultra-short sample rate for transient tracking
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.05;

      source.connect(analyser);
      analyserRef.current = analyser;

      setIsEngineReady(true);
      setMicState('active');

      // Boot dynamic loop
      triggerTickTone(800, 0.1);
      setTimeout(() => triggerTickTone(1000, 0.05), 80);

      // Core real-time trigger loop
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const process = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(dataArray);

        // Calculate peak-to-peak amplitude deviation safely
        let peakDeviation = 0;
        for (let i = 0; i < bufferLength; i++) {
          const deviation = Math.abs(dataArray[i] - 128);
          if (deviation > peakDeviation) {
            peakDeviation = deviation;
          }
        }

        // Convert deviation value to percentage volume envelope
        const currentVolume = Math.min((peakDeviation / 128) * 100 * 1.5, 100);

        // Update raw DOM progress meter bypass style
        const rawMeter = document.getElementById('micro-volume-bar');
        if (rawMeter) {
          rawMeter.style.width = `${currentVolume}%`;
        }

        const now = performance.now();
        const physicalThreshold = sensitivityRef.current;
        const minimumCooldown = cooldownRef.current;

        if (currentVolume >= physicalThreshold) {
          if (now - lastHitTimeRef.current > minimumCooldown) {
            // Register real hit!
            lastHitTimeRef.current = now;
            strokeCountRef.current += 1;
            hitTimestampsRef.current.push(now);

            // Dispatch quick custom event
            document.dispatchEvent(new CustomEvent('internal-pad-hit'));

            // Visual feedback splash directly on DOM
            const bigRing = document.getElementById('timing-ring-indicator');
            if (bigRing) {
              bigRing.classList.add('scale-[1.03]');
              setTimeout(() => {
                bigRing.classList.remove('scale-[1.03]');
              }, 60);
            }
          }
        }

        animationFrameIdRef.current = requestAnimationFrame(process);
      };

      animationFrameIdRef.current = requestAnimationFrame(process);

    } catch (err: any) {
      console.error('Audio initialization failure', err);
      setMicState('error');
      setErrorMessage(
        err.name === 'NotAllowedError' 
          ? 'Microphone permission denied. App needs mic access to calculate stick impacts.' 
          : `Device audio system unavailable: ${err.message || err}`
      );
    }
  };

  const cleanupAudio = () => {
    if (animationFrameIdRef.current) {
      cancelAnimationFrame(animationFrameIdRef.current);
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    analyserRef.current = null;
    mediaStreamRef.current = null;
    audioCtxRef.current = null;
    setIsEngineReady(false);
    setMicState('dormant');
  };

  const handleInstallApp = async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('PWA installation accepted');
      }
    } catch (err) {
      console.warn('PWA prompt choice resolved with error', err);
    }
    setDeferredPrompt(null);
    setShowInstallBtn(false);
  };

  // Tap tempo detector to set customized target BPM on point taps
  const handleTapTempo = () => {
    const now = performance.now();
    let currentTaps = [...tapTimesRef.current, now];
    
    // Ignore ticks older than 2.5 seconds to start fresh
    currentTaps = currentTaps.filter(t => now - t < 2500);
    tapTimesRef.current = currentTaps;

    // Flash the metronome visual key and play feedback tone
    setMetronomeTick(true);
    setTimeout(() => setMetronomeTick(false), 90);
    triggerTickTone(1100, 0.04);

    if (currentTaps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < currentTaps.length; i++) {
        intervals.push(currentTaps[i] - currentTaps[i - 1]);
      }
      
      const averageInterval = intervals.reduce((sum, item) => sum + item, 0) / intervals.length;
      if (averageInterval > 160) { // Safety boundaries, keeps BPM under 375
        const calculatedBPM = Math.round(60000 / averageInterval);
        // Constrain safely between 30 and 300 BPM
        if (calculatedBPM >= 30 && calculatedBPM <= 300) {
          setTargetBPM(calculatedBPM);
        }
      }
    }
  };

  const handleReset = () => {
    strokeCountRef.current = 0;
    hitTimestampsRef.current = [];
    setStrokeCount(0);
    setLiveSPM(0);
    triggerTickTone(500, 0.08);
  };

  // Timing accuracy calculations
  // "turns red for me to know I am out of timing. If I come back to the accurate BPM it shows green"
  const isStroking = liveSPM > 0;
  const bpmDifference = Math.abs(liveSPM - targetBPM);
  const isWithinTiming = isStroking && bpmDifference <= tolerance;

  // Let's decide current display timing state:
  // - "dormant" : not playing/no strokes
  // - "sync" : active strokes matching set target BPM (GREEN)
  // - "out" : active strokes NOT matching set target BPM (RED)
  let timingState: 'dormant' | 'sync' | 'out' = 'dormant';
  if (isStroking) {
    if (isWithinTiming) {
      timingState = 'sync';
    } else {
      timingState = 'out';
    }
  }

  // SSR safety
  if (!isMounted) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center font-mono">
        <Activity className="animate-spin text-[#00ff88] mb-3" size={32} />
        <p className="text-sm">Calibrating Low-Latency Audio Elements...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#000000] text-white flex flex-col justify-between overflow-x-hidden selection:bg-[#ff0055] selection:text-white">
      
      {/* MINIMAL STREAMLINED HEADER */}
      <header className="border-b border-zinc-950 bg-black/90 py-3.5 px-4 sticky top-0 z-40">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Activity size={14} className="text-[#00ff88]" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider font-sans text-white">
                PAD <span className="text-[#ff0055]">STRIKER</span>
              </h1>
              <p className="text-[9px] font-mono text-zinc-500 leading-none">TIMING LOCK v2.0</p>
            </div>
          </div>

          {/* Engine status indicator badge */}
          <div className="flex items-center space-x-2">
            {micState === 'active' ? (
              <span className="flex items-center gap-1 text-[10px] uppercase font-mono text-[#00ff88] bg-[#00ff88]/10 border border-[#00ff88]/25 px-2 py-0.5 rounded-full">
                <span className="w-1 h-1 rounded-full bg-[#00ff88] animate-ping" />
                Mic Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] uppercase font-mono text-zinc-500 bg-zinc-900 border border-zinc-850 px-2 py-0.5 rounded-full">
                <span className="w-1 h-1 rounded-full bg-zinc-650" />
                MIC DORMANT
              </span>
            )}
          </div>
        </div>
      </header>

      {/* CORE TIMING LOCK INTERFACE */}
      <main className="max-w-2xl mx-auto w-full px-4 py-6 flex-grow flex flex-col justify-center gap-6">
        
        {/* Hardware Block error banner */}
        {errorMessage && (
          <div className="bg-[#ff0055]/10 border border-[#ff0055]/20 text-[#ff0055] p-3 text-xs font-mono rounded-lg flex items-start gap-2.5">
            <MicOff className="shrink-0 mt-0.5" size={14} />
            <div>
              <p className="font-semibold">Hardware Blocked</p>
              <p className="text-zinc-400 mt-0.5">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* METRONOME SILENT TARGET PULSER BAR */}
        <div className="bg-zinc-950 border border-zinc-900 rounded-lg p-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff0055] flex items-center justify-center">
              <span className="absolute inline-flex w-3 h-3 rounded-full bg-[#ff0055] opacity-20 animate-ping"></span>
            </div>
            <span className="text-xs font-mono text-zinc-400">Silent Metronome Guide:</span>
          </div>
          
          {/* Silent Blinking Indicator */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-zinc-500 mr-2">TEMPO TRACK</span>
            <div className="flex space-x-1.5 py-1 px-3 bg-black rounded border border-zinc-850">
              <div 
                className={`w-3.5 h-3.5 rounded-full transition-all duration-75 ${
                  metronomeTick 
                    ? 'bg-[#ff0055] scale-110 shadow-[0_0_12px_#ff0055]' 
                    : 'bg-zinc-850'
                }`}
              />
              <div 
                className={`w-3.5 h-3.5 rounded-full transition-all duration-75 ${
                  metronomeTick 
                    ? 'bg-[#ff0055] scale-110 shadow-[0_0_12px_#ff0055]' 
                    : 'bg-zinc-850'
                }`}
              />
            </div>
          </div>
        </div>

        {/* THE GIANT INTERACTIVE TIMING CIRCLE RING (THE HEART OF THE APP) */}
        <section className="flex justify-center py-2">
          <div 
            id="timing-ring-indicator"
            className={`w-72 h-72 md:w-80 md:h-80 rounded-full border-4 flex flex-col justify-center items-center p-6 relative transition-all duration-250 ${
              timingState === 'sync'
                ? 'border-[#00ff88] bg-black shadow-[0_0_40px_rgba(0,255,136,0.15)]' // Accurate Timing turns GREEN
                : timingState === 'out'
                ? 'border-[#ff0055] bg-black shadow-[0_0_40px_rgba(255,0,85,0.15)]' // Out of Timing turns RED
                : 'border-zinc-800 bg-[#070707]' // No strokes (Dormant)
            }`}
          >
            {/* Background Grid Pattern inside Ring */}
            <div className="absolute inset-0 rounded-full bg-[radial-gradient(#151515_1px,transparent_1px)] [background-size:12px_12px] opacity-20 pointer-events-none"></div>

            {/* Timing Status Badge */}
            <div className="absolute -top-3.5 px-4 py-1 rounded-full border text-[11px] font-mono font-bold tracking-widest shadow-md flex items-center gap-1.5 ${">
              {timingState === 'sync' ? (
                <div className="bg-[#00ff88]/15 border-[#00ff88]/30 text-[#00ff88] px-3.5 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle size={10} className="fill-[#00ff88]/10" />
                  TEMPO LOCK
                </div>
              ) : timingState === 'out' ? (
                <div className="bg-[#ff0055]/15 border-[#ff0055]/30 text-[#ff0055] px-3.5 py-0.5 rounded-full flex items-center gap-1">
                  <AlertTriangle size={10} className="fill-[#ff0055]/10 animate-bounce" />
                  TIMING DETUNED
                </div>
              ) : (
                <div className="bg-zinc-900 border-zinc-800 text-zinc-500 px-3.5 py-0.5 rounded-full">
                  AWAITING STROKES
                </div>
              )}
            </div>

            {/* Inner Ring components */}
            <div className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase">
              Total Strokes
            </div>
            
            {/* Master Stroke Counter display */}
            <div className="text-7xl font-black font-sans leading-none text-white tracking-tighter my-1.5 select-none transition-all duration-75">
              {strokeCount}
            </div>

            {/* Quick Reset Button directly below the stroke counter */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleReset();
              }}
              className="mb-3 px-3 py-1 rounded bg-zinc-900 hover:bg-zinc-850 hover:text-[#ff0055] border border-zinc-850 text-[10px] font-mono text-zinc-400 tracking-wider transition-all duration-150 active:scale-95 flex items-center gap-1 cursor-pointer"
              title="Reset stroke counter"
            >
              <RefreshCw size={10} className="animate-spin-once" />
              RESET COUNT
            </button>

            {/* Current speed stats */}
            <div className="flex flex-col items-center mt-1">
              <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                Current Speed
              </div>
              <div className={`text-2xl font-bold font-mono tracking-tight transition-colors duration-200 ${
                timingState === 'sync' ? 'text-[#00ff88]' : timingState === 'out' ? 'text-[#ff0055]' : 'text-zinc-400'
              }`}>
                {isStroking ? `${liveSPM} SPM` : '---'}
              </div>
            </div>

            {/* Accuracy context metrics overlay inside ring */}
            <div className="absolute bottom-6 font-mono text-[10px] text-center w-full px-6">
              {timingState === 'sync' ? (
                <p className="text-[#00ff88] font-bold">Excellent rhythm (+{bpmDifference} BPM tolerance)</p>
              ) : timingState === 'out' ? (
                <p className="text-[#ff0055]">
                  {liveSPM > targetBPM 
                    ? `FASTER BY +${liveSPM - targetBPM} BPM` 
                    : `SLOWER BY ${targetBPM - liveSPM} BPM`} 
                </p>
              ) : (
                <p className="text-zinc-600">Stroke now to align with {targetBPM} BPM</p>
              )}
            </div>
          </div>
        </section>

        {/* BPM METRONOME SETTER PANEL */}
        <section className="bg-[#111111] border border-zinc-900 rounded-xl p-5 shadow-lg select-none">
          <div className="flex items-center justify-between mb-3.5">
            <h2 className="text-xs font-bold font-mono tracking-widest text-[#00ff88] uppercase">
              METRONOME TEMPO TARGET
            </h2>
            <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-850 px-2 py-0.5 rounded">
              ±{tolerance} BPM Window
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 py-2">
            {/* Precision decrease button (-2 BPM interval) */}
            <div className="flex gap-1.5 shrink-0">
              <button 
                onClick={() => setTargetBPM(prev => Math.max(30, prev - 2))}
                className="w-14 h-12 rounded-lg bg-zinc-950 border border-zinc-850 hover:bg-zinc-900 hover:border-[#ff0055]/40 hover:text-white text-zinc-400 font-mono text-sm font-bold flex items-center justify-center gap-1 transition-all cursor-pointer select-none active:scale-95"
                title="Decrease 2 BPM"
              >
                <Minus size={11} className="text-[#ff0055]" />
                -2
              </button>
            </div>

            {/* Giant Target BPM Value readout (Click/Tap to Set Tempo) */}
            <button
              onClick={handleTapTempo}
              className="text-center flex-grow bg-black/60 hover:bg-zinc-900/80 border border-zinc-850 hover:border-[#00ff88]/30 py-3 px-4 rounded-xl transition-all active:scale-[0.98] group cursor-pointer relative overflow-hidden"
              title="Tap repeatedly to set custom BPM tempo"
            >
              {/* Tap feedback guide */}
              <div className="absolute top-1 right-2 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88] group-hover:animate-ping" />
                <span className="text-[7.5px] font-mono text-zinc-500 uppercase tracking-widest group-hover:text-[#00ff88]">TAP TEMPO</span>
              </div>

              <div className="text-4xl font-extrabold text-white tracking-tight leading-none font-sans group-hover:text-[#00ff88] transition-colors">
                {targetBPM}
              </div>
              <div className="text-[9px] font-mono text-zinc-500 uppercase tracking-wider mt-1 group-hover:text-zinc-400">
                Tap BPM Here to Set
              </div>
            </button>

            {/* Precision increase button (+2 BPM interval) */}
            <div className="flex gap-1.5 shrink-0">
              <button 
                onClick={() => setTargetBPM(prev => Math.min(300, prev + 2))}
                className="w-14 h-12 rounded-lg bg-zinc-950 border border-zinc-850 hover:bg-zinc-900 hover:border-[#00ff88]/45 hover:text-white text-zinc-400 font-mono text-sm font-bold flex items-center justify-center gap-1 transition-all cursor-pointer select-none active:scale-95"
                title="Increase 2 BPM"
              >
                <Plus size={11} className="text-[#00ff88]" />
                +2
              </button>
            </div>
          </div>

          {/* Quick slider metric */}
          <div className="mt-4">
            <input 
              type="range"
              min="40"
              max="240"
              step="2"
              value={targetBPM}
              onChange={(e) => setTargetBPM(Number(e.target.value))}
              className="w-full h-1.5 bg-zinc-950 rounded-lg appearance-none cursor-pointer accent-[#00ff88]"
            />
            <div className="flex justify-between text-[9px] font-mono text-zinc-650 mt-1.5">
              <span>40 BPM</span>
              <span>120 BPM</span>
              <span>240 BPM</span>
            </div>
          </div>
        </section>

        {/* ACCURACY TOLERANCE WINDOW CONTROLS */}
        <section className="bg-[#111111]/80 border border-zinc-900 rounded-xl p-4 flex flex-col md:flex-row justify-between items-center gap-3">
          <div className="flex items-center gap-2">
            <Info size={14} className="text-[#00ff88] shrink-0" />
            <span className="text-[11px] font-mono text-zinc-400">
              Alignment Rule: Your strokes are "In Sync" if they stay within ±{tolerance} BPM.
            </span>
          </div>

          {/* Tolerance selector */}
          <div className="flex items-center gap-1.5 self-end md:self-auto bg-black border border-zinc-850 py-1 px-1.5 rounded-lg">
            <span className="text-[10px] font-mono text-zinc-500 px-1">Tolerance:</span>
            {[3, 6, 10, 15].map((val) => (
              <button
                key={val}
                onClick={() => setTolerance(val)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
                  tolerance === val 
                    ? 'bg-zinc-900 border border-zinc-855 text-[#00ff88]' 
                    : 'text-zinc-500 hover:text-white'
                }`}
              >
                ±{val}
              </button>
            ))}
          </div>
        </section>

        {/* OFFLINE CAPABILITY & PWA INSTALL BANNER */}
        <section className="bg-gradient-to-r from-zinc-950 via-zinc-900/60 to-zinc-950 border border-zinc-900 rounded-xl p-4 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#00ff88]/5 border border-[#00ff88]/20 flex items-center justify-center shrink-0">
              <CheckCircle size={15} className="text-[#00ff88]" />
            </div>
            <div>
              <span className="text-xs font-bold text-white block">Offline & App Ready</span>
              <span className="text-[10px] font-mono text-zinc-500 block mt-0.5 leading-snug">
                Turn this page into an offline app. Runs 100% local, so you can practice drum pad strokes in deep soundproof basements or soundproof rooms without internet.
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
            {showInstallBtn ? (
              <button
                onClick={handleInstallApp}
                className="px-4 py-2 rounded-lg font-mono text-[11px] font-black text-black bg-[#00ff88] hover:bg-[#00e67a] active:scale-95 transition-all shadow-[0_4px_16px_rgba(0,255,136,0.25)] cursor-pointer"
              >
                INSTALL OFFLINE APP ↓
              </button>
            ) : (
              <div className="text-[10px] font-mono text-zinc-400 bg-zinc-900/80 border border-zinc-800 px-3 py-1.5 rounded-lg flex items-center gap-1.5 select-none">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88] animate-pulse" />
                OFFLINE RUNTIME ACTIVE
              </div>
            )}
          </div>
        </section>

        {/* COLLAPSIBLE HARDWARE CALIBRATION SETTINGS (Neat and hidden to focus layout) */}
        <section className="border border-zinc-900 bg-zinc-950/60 rounded-xl overflow-hidden shadow-md">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-full p-4 flex items-center justify-between text-xs font-mono font-bold hover:bg-zinc-900 text-zinc-300 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal size={14} className="text-[#ff0055]" />
              MIC SENSITIVITY & LAG CALIBRATION
            </span>
            <span className="text-[10px] text-zinc-500">{showSettings ? 'COLLAPSE ▲' : 'EXPAND ▼'}</span>
          </button>

          {showSettings && (
            <div className="p-4 border-t border-zinc-900 bg-black space-y-4">
              {/* Mic volume instant reading */}
              <div>
                <div className="flex justify-between items-center text-[10px] font-mono text-zinc-500 mb-1.5">
                  <span className="flex items-center gap-1">
                    <Volume2 size={11} className="text-zinc-400" /> Live Signal Amplitude:
                  </span>
                  <span>Threshold Line at {sensitivity}%</span>
                </div>
                <div className="h-2.5 bg-zinc-950 rounded relative overflow-hidden border border-zinc-900">
                  <div 
                    id="micro-volume-bar"
                    className="h-full w-[0%] bg-[#00ff88] transition-all duration-[20ms] ease-out rounded-r-sm"
                    style={{ width: '0%' }}
                  />
                  {/* Threshold mark */}
                  <div 
                    className="absolute top-0 bottom-0 w-[1.5px] bg-[#ff0055]"
                    style={{ left: `${sensitivity}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {/* Sensitivity metric */}
                <div>
                  <div className="flex justify-between text-[11px] font-mono mb-1.5">
                    <span className="text-zinc-300">Hit Sensitivity Profile</span>
                    <span className="text-[#00ff88] font-bold">{sensitivity}%</span>
                  </div>
                  <input 
                    type="range"
                    min="5"
                    max="100"
                    step="1"
                    value={sensitivity}
                    onChange={(e) => setSensitivity(Number(e.target.value))}
                    className="w-full h-1 bg-zinc-900 rounded appearance-none cursor-pointer accent-[#00ff88]"
                  />
                  <span className="text-[9px] font-mono text-zinc-500 block mt-1">Lower triggers on quiet taps</span>
                </div>

                {/* Cooldown speed metric */}
                <div>
                  <div className="flex justify-between text-[11px] font-mono mb-1.5">
                    <span className="text-zinc-300">Stick Bounce Refractory</span>
                    <span className="text-[#ff0055] font-bold">{cooldown}ms</span>
                  </div>
                  <input 
                    type="range"
                    min="20"
                    max="150"
                    step="5"
                    value={cooldown}
                    onChange={(e) => setCooldown(Number(e.target.value))}
                    className="w-full h-1 bg-zinc-900 rounded appearance-none cursor-pointer accent-[#ff0055]"
                  />
                  <span className="text-[9px] font-mono text-zinc-500 block mt-1">Higher prevents virtual echo ticks</span>
                </div>
              </div>

              {/* Hardware preset quick configs */}
              <div className="pt-3 border-t border-zinc-900 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-mono text-zinc-500">Fast Presets:</span>
                <button 
                  onClick={() => { setSensitivity(12); setCooldown(25); triggerTickTone(1020, 0.05); }}
                  className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-300 hover:border-[#00ff88]/30"
                >
                  Extreme Speed (Rolls)
                </button>
                <button 
                  onClick={() => { setSensitivity(22); setCooldown(45); triggerTickTone(820, 0.05); }}
                  className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-300 hover:border-zinc-700"
                >
                  Default Snare Pad
                </button>
                <button 
                  onClick={() => { setSensitivity(35); setCooldown(75); triggerTickTone(620, 0.05); }}
                  className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-300 hover:border-[#ff0055]/30"
                >
                  Soft Mesh (Heavy stick)
                </button>
              </div>
            </div>
          )}
        </section>

        {/* INTERACTION AREA CTA (Required in browser) */}
        {!isEngineReady && (
          <div className="bg-[#111111] border border-dashed border-zinc-800 p-5 rounded-xl text-center">
            <Mic className="mx-auto mb-2.5 text-[#ff0055] animate-bounce" size={24} />
            <h4 className="font-sans text-sm font-bold text-white mb-1">Audio Capture Interdicted</h4>
            <p className="text-[11px] text-zinc-500 max-w-sm mx-auto mb-4 leading-relaxed font-mono">
              Press key below to grant capture access and initialize the low-latency hardware engine.
            </p>
            <button
              onClick={startAudioEngine}
              className="px-5 py-2 rounded-lg font-mono text-xs font-bold text-black bg-[#00ff88] hover:bg-[#00e67a] active:scale-95 transition-all shadow-md cursor-pointer"
            >
              BOOT HARDAWRE STREAM
            </button>
          </div>
        )}

      </main>

      {/* CORE CONTROLLER FOOTER */}
      <footer className="max-w-2xl mx-auto w-full px-4 border-t border-zinc-950 py-4 flex items-center justify-between font-mono text-[10px] text-zinc-600">
        <div>
          <span>⚡ Metronome set point: {targetBPM} BPM.</span>
        </div>
        <div className="flex items-center gap-4">
          <button 
            onClick={handleReset}
            className="hover:text-[#ff0055] flex items-center gap-1 transition-all cursor-pointer"
          >
            <RefreshCw size={10} />
            RESET COUNTER
          </button>
          <span>//</span>
          {isEngineReady ? (
            <button 
              onClick={cleanupAudio}
              className="text-[#ff0055] hover:text-[#ff3c73] flex items-center gap-1 transition-all cursor-pointer"
            >
              <MicOff size={10} strokeWidth={2.5} />
              DISENGAGE MIC
            </button>
          ) : (
            <button 
              onClick={startAudioEngine}
              className="text-[#00ff88] hover:text-[#33ffa3] flex items-center gap-1 transition-all cursor-pointer"
            >
              <Mic size={10} strokeWidth={2.5} />
              CONNECT ENGINE
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
