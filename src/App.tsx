import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Mic, 
  MicOff, 
  Plus, 
  Minus, 
  CheckCircle, 
  AlertTriangle,
  Info,
  Play,
  Pause,
  SlidersHorizontal,
  RefreshCw,
  Sparkles,
  Volume2
} from 'lucide-react';

export default function App() {
  // Mount state & SSR protection
  const [isMounted, setIsMounted] = useState(false);

  // Audio Engine Lifecycle
  const [isEngineReady, setIsEngineReady] = useState(false);
  const [micState, setMicState] = useState<'dormant' | 'active' | 'error'>('dormant');
  const [errorMessage, setErrorMessage] = useState('');

  // Zone 2 Metronome states
  const [targetBPM, setTargetBPM] = useState(120);
  const [isMetronomePlaying, setIsMetronomePlaying] = useState(false);

  // Zone 3 Presets & Auto Calibration Settings
  const [ghostNoteSetting, setGhostNoteSetting] = useState<'ghost' | 'standard' | 'noisy' | 'calibrated'>('standard');
  const [calibratedThresholdApplied, setCalibratedThresholdApplied] = useState<number>(2.8);
  const [echoFilterMode, setEchoFilterMode] = useState<'standard' | 'fast'>('standard');
  const [tolerance, setTolerance] = useState(8); // rhythm tolerance in BPM

  // Stroke Tracking stats
  const [strokeCount, setStrokeCount] = useState(0);
  const [liveSPM, setLiveSPM] = useState(0);

  // Calibration Progress Triggered by "Auto-Tune Mic"
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationSecondsLeft, setCalibrationSecondsLeft] = useState(2);
  const calibrationPeakRef = useRef<number>(0);

  // Advanced Config Drawer Collapsible state
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // PWA offline installation states
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  // Web Audio framework references
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const biquadFilterRef = useRef<BiquadFilterNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // High performance refs for zero React rendering latency
  const strokeCountRef = useRef<number>(0);
  const hitTimestampsRef = useRef<number[]>([]);
  const lastHitTimeRef = useRef<number>(0);
  const tapTimesRef = useRef<number[]>([]);
  const metronomeTimerRef = useRef<number | null>(null);
  const nextTickTimeRef = useRef<number>(0);
  const metronomeBpmRef = useRef<number>(120);

  // Keep ref synchronized with changing states
  useEffect(() => {
    metronomeBpmRef.current = targetBPM;
  }, [targetBPM]);

  // Compute ghost note sensitivity ratio based on user settings
  const getSensitivityMultiplier = () => {
    switch (ghostNoteSetting) {
      case 'ghost': return 1.8;
      case 'noisy': return 4.5;
      case 'calibrated': return calibratedThresholdApplied;
      case 'standard':
      default:
        return 2.8;
    }
  };

  // Auto-calculated Echo Filter (debounce) timing: 60000 / (BPM * 4) * 0.4
  // Tightens automatically as tempo increases!
  const getEchoFilterMs = () => {
    if (echoFilterMode === 'fast') {
      return 12; // Locked low for lightning fast rudiment rolls
    }
    // Proportional to the metronome grid:
    return Math.round(60000 / (targetBPM * 4) * 0.4);
  };

  // Sync settings dynamically straight down to AudioWorklet Node
  useEffect(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.postMessage({
        type: 'UPDATE_SETTINGS',
        autoMode: false, // Override internal DSP calculations with our musicians configuration
        ghostNotesEnabled: false,
        targetBpm: targetBPM,
        ghostNoteSensitivity: getSensitivityMultiplier(),
        echoFilterMs: getEchoFilterMs(),
      });
    }
  }, [ghostNoteSetting, targetBPM, echoFilterMode, calibratedThresholdApplied]);

  // Mount logic, PWA cues, and local persistence
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

    // Restore cached parameters
    const savedBPM = localStorage.getItem('pad_target_bpm');
    if (savedBPM) {
      const parsed = parseInt(savedBPM, 10);
      if (!isNaN(parsed) && parsed >= 30 && parsed <= 300) setTargetBPM(parsed);
    }

    const savedGhostSetting = localStorage.getItem('pad_ghost_setting');
    if (savedGhostSetting && ['ghost', 'standard', 'noisy', 'calibrated'].includes(savedGhostSetting)) {
      setGhostNoteSetting(savedGhostSetting as any);
    }

    const savedCalibrated = localStorage.getItem('pad_calibrated_threshold');
    if (savedCalibrated) {
      setCalibratedThresholdApplied(parseFloat(savedCalibrated));
    }

    const savedFilterMode = localStorage.getItem('pad_echo_filter_mode');
    if (savedFilterMode === 'fast' || savedFilterMode === 'standard') {
      setEchoFilterMode(savedFilterMode as any);
    }

    const savedTolerance = localStorage.getItem('pad_tolerance') || '8';
    setTolerance(parseInt(savedTolerance, 10));

    // Cleanup loop
    return () => {
      cleanupAudio();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.removeEventListener('appinstalled', handleAppInstalled);
      }
    };
  }, []);

  // Write changes back to Local Storage
  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('pad_target_bpm', targetBPM.toString());
      localStorage.setItem('pad_ghost_setting', ghostNoteSetting);
      localStorage.setItem('pad_calibrated_threshold', calibratedThresholdApplied.toString());
      localStorage.setItem('pad_echo_filter_mode', echoFilterMode);
      localStorage.setItem('pad_tolerance', tolerance.toString());
    }
  }, [targetBPM, ghostNoteSetting, calibratedThresholdApplied, echoFilterMode, tolerance, isMounted]);

  // Lazy constructor for absolute latency web audio ticks
  const getOrCreateAudioContext = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!audioCtxRef.current) {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new AudioCtxClass({ latencyCategory: 'interactive' });
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  };

  // High quality synthesized woodblock cues
  const triggerTickTone = (freq = 900, duration = 0.05) => {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(0.06, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (e) {}
  };

  // Manual fallback stroke triggers
  const triggerManualHit = () => {
    const ctx = getOrCreateAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const now = performance.now();
    const minCooldown = getEchoFilterMs();
    if (now - lastHitTimeRef.current >= minCooldown) {
      lastHitTimeRef.current = now;
      strokeCountRef.current += 1;
      hitTimestampsRef.current.push(now);

      // Low latency acoustic feedback
      triggerTickTone(540, 0.025);

      // Immediate visual pulse 
      const timingIndicator = document.getElementById('timing-ring-indicator');
      if (timingIndicator) {
        timingIndicator.style.transform = 'scale(0.975)';
        setTimeout(() => {
          timingIndicator.style.transform = 'none';
        }, 55);
      }

      setStrokeCount(strokeCountRef.current);
    }
  };

  // Keyboard Spacebar integration for tactile pads
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ([' ', 'd', 'f', 'j'].includes(e.key.toLowerCase())) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          return;
        }
        e.preventDefault();
        triggerManualHit();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [targetBPM, echoFilterMode]);

  // Precise Web Audio clock metronome scheduler loop
  useEffect(() => {
    if (!isMetronomePlaying) {
      if (metronomeTimerRef.current) {
        clearInterval(metronomeTimerRef.current);
        metronomeTimerRef.current = null;
      }
      return;
    }

    const ctx = getOrCreateAudioContext();
    if (!ctx) return;

    nextTickTimeRef.current = ctx.currentTime + 0.05;
    const scheduleAheadTime = 0.12;
    const lookahead = 30;

    const scheduleTick = (time: number) => {
      if (!audioCtxRef.current) return;
      try {
        const osc = audioCtxRef.current.createOscillator();
        const gain = audioCtxRef.current.createGain();
        osc.connect(gain);
        gain.connect(audioCtxRef.current.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(950, time);
        gain.gain.setValueAtTime(0.08, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
        osc.start(time);
        osc.stop(time + 0.035);
      } catch (err) {}
    };

    const scheduler = () => {
      while (nextTickTimeRef.current < ctx.currentTime + scheduleAheadTime) {
        scheduleTick(nextTickTimeRef.current);
        const secondsPerBeat = 60.0 / metronomeBpmRef.current;
        nextTickTimeRef.current += secondsPerBeat;
      }
    };

    metronomeTimerRef.current = window.setInterval(scheduler, lookahead);

    return () => {
      if (metronomeTimerRef.current) {
        clearInterval(metronomeTimerRef.current);
        metronomeTimerRef.current = null;
      }
    };
  }, [isMetronomePlaying]);

  // Rolling Strokes Per Minute Speed Calculator
  useEffect(() => {
    const calcInterval = setInterval(() => {
      const now = performance.now();
      const hits = hitTimestampsRef.current;

      // Filter to sliding 8-second window
      const activeHits = hits.filter(t => now - t < 8000);
      hitTimestampsRef.current = activeHits;

      const lastHit = activeHits[activeHits.length - 1];
      const idleTime = now - lastHit;

      if (activeHits.length >= 2 && idleTime < 4500) {
        const intervals: number[] = [];
        for (let i = 1; i < activeHits.length; i++) {
          intervals.push(activeHits[i] - activeHits[i - 1]);
        }
        const averageInterval = intervals.reduce((sum, item) => sum + item, 0) / intervals.length;
        if (averageInterval > 40) {
          const spm = Math.round(60000 / averageInterval);
          setLiveSPM(spm);
        } else {
          setLiveSPM(0);
        }
      } else {
        setLiveSPM(0);
      }
    }, 120);

    return () => clearInterval(calcInterval);
  }, []);

  // Background noise monitoring loop (Only active during calibration)
  useEffect(() => {
    let animationId: number;
    const monitorNoise = () => {
      if (isCalibrating && analyserRef.current && audioCtxRef.current) {
        const binCount = analyserRef.current.frequencyBinCount;
        const data = new Uint8Array(binCount);
        analyserRef.current.getByteFrequencyData(data);

        let maxSample = 0;
        for (let i = 0; i < binCount; i++) {
          if (data[i] > maxSample) maxSample = data[i];
        }
        // Save highest room noise peak
        if (maxSample > calibrationPeakRef.current) {
          calibrationPeakRef.current = maxSample;
        }
      }
      animationId = requestAnimationFrame(monitorNoise);
    };

    if (isMounted) {
      animationId = requestAnimationFrame(monitorNoise);
    }
    return () => cancelAnimationFrame(animationId);
  }, [isCalibrating, isMounted]);

  // Low latency Audio Worklet setup
  const startAudioEngine = async () => {
    try {
      setErrorMessage('');
      const restrictions: MediaStreamConstraints = {
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false
      };

      const stream = await navigator.mediaDevices.getUserMedia(restrictions);
      mediaStreamRef.current = stream;

      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtxClass({ latencyCategory: 'interactive' });
      audioCtxRef.current = ctx;

      if (ctx.state === 'suspended') {
        await ctx.resume();
      }

      const source = ctx.createMediaStreamSource(stream);

      // Clean 900 Hz highpass biquad to absorb background rumbling
      const hiPass = ctx.createBiquadFilter();
      hiPass.type = 'highpass';
      hiPass.frequency.setValueAtTime(900, ctx.currentTime);
      hiPass.Q.setValueAtTime(1.5, ctx.currentTime);
      biquadFilterRef.current = hiPass;

      // Fast analyzer node
      const r_analyser = ctx.createAnalyser();
      r_analyser.fftSize = 512;
      analyserRef.current = r_analyser;

      // Register worklet DSP thread
      await ctx.audioWorklet.addModule('/processors/stroke-processor.js');
      const workletNode = new AudioWorkletNode(ctx, 'stroke-processor');
      workletNodeRef.current = workletNode;

      // Sync initial config parameters
      workletNode.port.postMessage({
        type: 'UPDATE_SETTINGS',
        autoMode: false,
        ghostNotesEnabled: false,
        targetBpm: targetBPM,
        ghostNoteSensitivity: getSensitivityMultiplier(),
        echoFilterMs: getEchoFilterMs(),
      });

      // Thread stroke listener
      workletNode.port.onmessage = (event) => {
        if (event.data.type === 'STROKE_DETECTED') {
          const now = performance.now();
          strokeCountRef.current++;
          hitTimestampsRef.current.push(now);

          // Audio response
          triggerTickTone(540, 0.025);

          // Instant physical pulse inside Zone 1 ring
          const ring = document.getElementById('timing-ring-indicator');
          if (ring) {
            ring.classList.add('scale-[0.98]');
            setTimeout(() => {
              ring.classList.remove('scale-[0.98]');
            }, 60);
          }

          setStrokeCount(strokeCountRef.current);
        }
      };

      // Pipe chain: Source -> Biquad Filter -> Analyser -> Worklet -> Output
      source.connect(hiPass);
      hiPass.connect(r_analyser);
      r_analyser.connect(workletNode);
      workletNode.connect(ctx.destination);

      setIsEngineReady(true);
      setMicState('active');

      // Confirmation chime
      triggerTickTone(700, 0.08);
      setTimeout(() => triggerTickTone(1000, 0.04), 80);

    } catch (err: any) {
      console.error('Core audio configuration failed:', err);
      setMicState('error');
      setErrorMessage('Acoustic capture is blocked. Please run inside a standard browser tab and allow mic access.');
    }
  };

  // Disengage pipeline
  const cleanupAudio = () => {
    setIsMetronomePlaying(false);
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch(e){}
      workletNodeRef.current = null;
    }
    if (biquadFilterRef.current) {
      try { biquadFilterRef.current.disconnect(); } catch(e){}
      biquadFilterRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {});
    }
    mediaStreamRef.current = null;
    audioCtxRef.current = null;
    setIsEngineReady(false);
    setMicState('dormant');
  };

  // Noise automatic calibration setup
  const runAutoCalibration = () => {
    if (micState !== 'active') {
      startAudioEngine().then(() => {
        initiateCalibrationSequence();
      });
    } else {
      initiateCalibrationSequence();
    }
  };

  const initiateCalibrationSequence = () => {
    setIsCalibrating(true);
    setCalibrationSecondsLeft(2);
    calibrationPeakRef.current = 10;

    triggerTickTone(1000, 0.07);

    let sec = 2;
    const timer = setInterval(() => {
      sec--;
      setCalibrationSecondsLeft(sec);
      if (sec <= 0) {
        clearInterval(timer);
        setIsCalibrating(false);

        const noiseFloor = calibrationPeakRef.current;
        let mappedTightness = 2.8;
        let mappedSetting: typeof ghostNoteSetting = 'standard';

        if (noiseFloor < 30) {
          mappedTightness = 1.8;
          mappedSetting = 'ghost';
        } else if (noiseFloor < 80) {
          mappedTightness = 2.8;
          mappedSetting = 'standard';
        } else {
          mappedTightness = 4.5;
          mappedSetting = 'noisy';
        }

        setCalibratedThresholdApplied(mappedTightness);
        setGhostNoteSetting('calibrated');

        // Confirming beep
        triggerTickTone(1200, 0.08);
        setTimeout(() => triggerTickTone(1600, 0.05), 80);
      }
    }, 1000);
  };

  // Reset counters
  const handleReset = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation(); // Avoid double manual hits on parent ring
    }
    strokeCountRef.current = 0;
    hitTimestampsRef.current = [];
    setStrokeCount(0);
    setLiveSPM(0);
    triggerTickTone(450, 0.06);
  };

  // Tap tempo input handler
  const handleTapTempo = (e: React.MouseEvent) => {
    e.stopPropagation();
    const now = performance.now();
    let taps = [...tapTimesRef.current, now].filter(t => now - t < 2500);
    tapTimesRef.current = taps;

    triggerTickTone(1100, 0.35);

    if (taps.length >= 2) {
      const g_intervals: number[] = [];
      for (let i = 1; i < taps.length; i++) {
        g_intervals.push(taps[i] - taps[i - 1]);
      }
      const avg = g_intervals.reduce((a, b) => a + b, 0) / g_intervals.length;
      if (avg > 150) {
        const computedBPM = Math.round(60000 / avg);
        if (computedBPM >= 30 && computedBPM <= 300) {
          setTargetBPM(computedBPM);
        }
      }
    }
  };

  // PWA offline features
  const handleInstallApp = async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('User signed offline local setup');
      }
    } catch (_) {}
    setDeferredPrompt(null);
    setShowInstallBtn(false);
  };

  // Cadence timing states
  const isStroking = liveSPM > 0;
  const bpmDifference = Math.abs(liveSPM - targetBPM);
  const isWithinTiming = isStroking && bpmDifference <= tolerance;

  let cadenceLock: 'silent' | 'locked' | 'drift' = 'silent';
  if (isStroking) {
    cadenceLock = isWithinTiming ? 'locked' : 'drift';
  }

  if (!isMounted) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center font-mono">
        <Activity className="animate-spin text-emerald-400 mb-3" size={32} />
        <p className="text-xs tracking-widest uppercase">Initializing acoustics...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col justify-between selection:bg-rose-500 selection:text-white relative overflow-hidden">
      
      {/* Background Ambience Grid */}
      <div className="absolute inset-0 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:16px_16px] opacity-25 pointer-events-none" />

      {/* HEADER BAR */}
      <header className="border-b border-slate-900 bg-slate-950/80 backdrop-blur-md px-4 py-3 sticky top-0 z-40">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="p-1 rounded bg-slate-900 border border-slate-800 flex items-center justify-center">
              <Activity size={14} className="text-emerald-400" />
            </span>
            <div>
              <h1 className="text-xs font-black tracking-widest text-slate-100 uppercase">
                PAD STRIKER
              </h1>
              <p className="text-[8px] font-mono tracking-widest text-slate-500 font-bold">LOW LATENCY OFFLINE CADENCE</p>
            </div>
          </div>

          <div className="flex items-center space-x-1.5">
            {micState === 'active' ? (
              <span className="flex items-center gap-1 text-[9px] uppercase font-mono text-emerald-400 bg-emerald-500/5 border border-emerald-500/20 px-2 py-0.5 rounded-full font-bold">
                <span className="w-1 h-1 rounded-full bg-emerald-400 animate-ping" />
                DSPs ONLINE
              </span>
            ) : (
              <button 
                onClick={startAudioEngine}
                className="flex items-center gap-1 text-[9px] uppercase font-mono text-slate-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-full font-bold hover:text-white transition-all cursor-pointer"
              >
                <Mic size={10} />
                CONNECT MIC
              </button>
            )}
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-md mx-auto w-full px-4 py-4 flex-grow flex flex-col justify-center gap-3.5 z-10">

        {/* ERROR STATUS WRAPPER */}
        {errorMessage && (
          <div className="bg-rose-500/10 border border-rose-500/15 text-rose-400 p-2.5 text-xs font-mono rounded-lg flex items-start gap-2 animate-bounce">
            <MicOff className="shrink-0 mt-0.5" size={13} />
            <p className="leading-snug text-[11px]">{errorMessage}</p>
          </div>
        )}

        {/* ZONE 1: PRACTICE TARGET (VISUAL TIMING HERO) */}
        <section id="zone-1-practice-target" className="flex flex-col items-center py-1">
          <div 
            id="timing-ring-indicator"
            onClick={triggerManualHit}
            className={`w-64 h-64 rounded-full border-4 flex flex-col justify-center items-center p-4 relative transition-all duration-300 cursor-pointer select-none ring-offset-4 ring-offset-slate-950 active:scale-95 ${
              cadenceLock === 'locked'
                ? 'border-emerald-400 bg-slate-950/40 shadow-[0_0_35px_rgba(52,211,153,0.15)] ring-4 ring-emerald-400/20' 
                : cadenceLock === 'drift'
                ? 'border-rose-500 bg-slate-950/40 shadow-[0_0_35px_rgba(244,63,94,0.15)] ring-4 ring-rose-500/20' 
                : 'border-slate-800 bg-slate-900/10 hover:border-slate-700'
            }`}
          >
            {/* Absolute Status Badge */}
            <div className="absolute -top-3 px-3 py-0.5 rounded-full border text-[9px] font-mono font-black tracking-wider shadow-md bg-slate-950 border-slate-800">
              {cadenceLock === 'locked' ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle size={10} className="fill-emerald-500/10" /> TEMPO LOCK
                </span>
              ) : cadenceLock === 'drift' ? (
                <span className="text-rose-500 flex items-center gap-1 animate-pulse">
                  <AlertTriangle size={10} className="fill-rose-500/10" /> TEMPO DRIFT
                </span>
              ) : (
                <span className="text-slate-500">PRACTICE TARGET (TAP)</span>
              )}
            </div>

            <div className="text-[9px] font-mono tracking-widest text-slate-500 uppercase font-black">
              STROKES COUNTER
            </div>
            
            {/* Huge Readable Strokes Metric */}
            <div className="text-6xl font-black font-sans leading-none text-slate-100 tracking-tighter my-1.5 transition-all">
              {strokeCount}
            </div>

            {/* Quick Reset Counter */}
            <button
              onClick={handleReset}
              className="px-2.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[8px] font-mono text-slate-400 uppercase tracking-widest hover:text-white hover:border-slate-700 transition-all active:scale-90 flex items-center gap-1 shadow-sm cursor-pointer"
            >
              <RefreshCw size={9} /> Reset
            </button>

            {/* Live Cadence reporting */}
            <div className="mt-3.5 text-center flex flex-col items-center">
              <span className="text-[8px] font-mono tracking-widest text-slate-500 uppercase font-bold">Live Pace</span>
              <span className={`text-lg font-black font-mono leading-none tracking-tight mt-0.5 ${
                cadenceLock === 'locked' ? 'text-emerald-400' : cadenceLock === 'drift' ? 'text-rose-500' : 'text-slate-500'
              }`}>
                {isStroking ? `${liveSPM} SPM` : '---'}
              </span>
            </div>

            {/* Visual Instruction helper inside target */}
            <p className="absolute bottom-4 font-mono text-[8px] text-slate-600 text-center select-none w-full px-4">
              {cadenceLock === 'locked' ? (
                <strong className="text-emerald-400">Locked CADENCE (±{tolerance} BPM)</strong>
              ) : cadenceLock === 'drift' ? (
                <strong className="text-rose-400">
                  {liveSPM > targetBPM ? `FASTER BY +${liveSPM - targetBPM} BPM` : `SLOWER BY -${targetBPM - liveSPM} BPM`}
                </strong>
              ) : (
                <span>Spacebar or Pad click triggers hit sound</span>
              )}
            </p>
          </div>
        </section>


        {/* ZONE 2: THE METRONOME ENGINE & AUTO-CALCULATORS */}
        <section id="zone-2-metronome-engine" className="bg-slate-900/40 p-4 border border-slate-900 rounded-2xl flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] font-black font-mono tracking-widest text-slate-400 uppercase flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Metronome Grid
            </h2>
            <div className="flex items-center gap-1">
              <span className="text-[8px] font-mono text-slate-500">TOLERANCE:</span>
              <button 
                onClick={() => setTolerance(t => t === 4 ? 8 : t === 8 ? 12 : 4)}
                className="text-[9px] font-mono font-bold text-emerald-400 hover:text-emerald-300 bg-slate-950 border border-slate-800 px-2 py-0.5 rounded cursor-pointer select-none"
              >
                ±{tolerance} BPM
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            {/* Decrease tempo */}
            <button 
              onClick={() => setTargetBPM(b => Math.max(30, b - 2))}
              className="w-11 h-11 rounded-xl bg-slate-950 border border-slate-800 hover:bg-slate-900 text-slate-300 flex items-center justify-center active:scale-90 transition-all cursor-pointer font-mono font-black"
            >
              <Minus size={12} className="text-slate-500" />
            </button>

            {/* Clickable interactive BPM center to Tap Tempo */}
            <button
              onClick={handleTapTempo}
              className="flex-grow bg-slate-950/70 border border-slate-850 hover:border-slate-700 rounded-xl py-2 px-4 transition-all relative group cursor-pointer text-center"
              title="Click repeatedly to tap tempo"
            >
              <span className="absolute top-1 right-2 text-[7px] font-mono text-slate-600 font-bold uppercase tracking-wider group-hover:text-emerald-400">TAP METRONOME</span>
              <div className="text-2xl font-black font-sans leading-none text-slate-100 group-hover:text-emerald-400 transition-colors">
                {targetBPM} <span className="text-xs font-mono text-slate-500 font-normal">BPM</span>
              </div>
            </button>

            {/* Increase tempo */}
            <button 
              onClick={() => setTargetBPM(b => Math.min(300, b + 2))}
              className="w-11 h-11 rounded-xl bg-slate-950 border border-slate-800 hover:bg-slate-900 text-slate-300 flex items-center justify-center active:scale-90 transition-all cursor-pointer font-mono font-black"
            >
              <Plus size={12} className="text-emerald-500" />
            </button>
          </div>

          {/* Quick slider view */}
          <div className="px-1">
            <input 
              type="range"
              min="40"
              max="240"
              step="1"
              value={targetBPM}
              onChange={(e) => setTargetBPM(Number(e.target.value))}
              className="w-full h-1 bg-slate-850 roundedappearance-none cursor-pointer accent-emerald-400"
            />
          </div>

          {/* Audio CLICK trigger toggle button */}
          <button
            onClick={() => {
              getOrCreateAudioContext();
              setIsMetronomePlaying(!isMetronomePlaying);
              triggerTickTone(1050, 0.05);
            }}
            className={`w-full py-2.5 rounded-xl font-mono text-[10px] font-black tracking-widest flex items-center justify-center gap-1.5 transition-all text-center cursor-pointer active:scale-95 border uppercase ${
              isMetronomePlaying 
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.1)]' 
                : 'bg-slate-950 border-slate-850 text-slate-400 hover:border-slate-800'
            }`}
          >
            {isMetronomePlaying ? (
              <>
                <Pause size={10} className="animate-pulse" />
                METRONOME AUDIO ON (CLICK ACTIVE)
              </>
            ) : (
              <>
                <Play size={10} />
                PLAY METRONOME SOUND CLICK
              </>
            )}
          </button>
        </section>


        {/* ZONE 3: INTUITIVE GHOST NOTE SENSITIVITY AND ECHO FILTER PRESETS */}
        <section id="zone-3-presets" className="bg-slate-900/40 p-4 border border-slate-900 rounded-2xl flex flex-col gap-3.5">
          
          {/* Header row */}
          <div className="flex items-center justify-between">
            <h2 className="text-[10px] font-black font-mono tracking-widest text-slate-400 uppercase">
              Sensitivity & Noise Filters
            </h2>
            <button
              onClick={runAutoCalibration}
              disabled={isCalibrating}
              className={`px-3 py-1 text-[9px] font-mono font-black rounded-lg transition-all border flex items-center gap-1 cursor-pointer select-none active:scale-[0.93] ${
                isCalibrating
                  ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-rose-500/10 border-rose-500/20 text-rose-400 hover:bg-rose-500/15'
              }`}
            >
              <Sparkles size={9} />
              {isCalibrating ? 'LISTENING FILTERS...' : 'AUTO-TUNE MIC'}
            </button>
          </div>

          {/* Automatic Noise calibrating overlay */}
          {isCalibrating && (
            <div className="bg-rose-500/5 border border-rose-500/10 rounded-xl p-3 text-center space-y-1.5 animate-pulse">
              <p className="text-[9px] font-mono text-rose-400 font-bold uppercase tracking-wide">
                Analyzing Room Ambiance: DO NOT STRIKE THE PAD
              </p>
              <div className="h-1 bg-slate-950 rounded overflow-hidden max-w-xs mx-auto border border-slate-900">
                <div className="h-full bg-rose-500" style={{ width: `${(calibrationSecondsLeft / 2) * 100}%` }} />
              </div>
            </div>
          )}

          {/* Preset Buttons for Ghost Note Sensitivity */}
          <div className="space-y-1.5">
            <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest block">
              Ghost Note Sensitivity
            </span>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setGhostNoteSetting('ghost')}
                className={`py-2 rounded-xl text-[10px] border transition-all text-center cursor-pointer font-mono font-bold leading-tight ${
                  ghostNoteSetting === 'ghost'
                    ? 'border-emerald-400 bg-emerald-500/5 text-slate-100 font-black'
                    : 'border-slate-850 bg-slate-950 text-slate-400 hover:border-slate-800'
                }`}
              >
                🤫 SOFT PAD
              </button>
              <button
                onClick={() => setGhostNoteSetting('standard')}
                className={`py-2 rounded-xl text-[10px] border transition-all text-center cursor-pointer font-mono font-bold leading-tight ${
                  ghostNoteSetting === 'standard'
                    ? 'border-emerald-400 bg-emerald-500/5 text-slate-100 font-black'
                    : 'border-slate-850 bg-slate-950 text-slate-400 hover:border-slate-800'
                }`}
              >
                🥁 STANDARD
              </button>
              <button
                onClick={() => setGhostNoteSetting('noisy')}
                className={`py-2 rounded-xl text-[10px] border transition-all text-center cursor-pointer font-mono font-bold leading-tight ${
                  ghostNoteSetting === 'noisy'
                    ? 'border-emerald-400 bg-emerald-500/5 text-slate-100 font-black'
                    : 'border-slate-850 bg-slate-950 text-slate-400 hover:border-slate-800'
                }`}
              >
                💨 LOUD ROOM
              </button>
            </div>
            {ghostNoteSetting === 'calibrated' && (
              <p className="text-[8px] font-mono text-emerald-400 bg-emerald-500/5 border border-emerald-500/10 px-2 py-1 rounded-lg text-center font-bold">
                🔒 Custom Calibrated state is active (Multiplier: {calibratedThresholdApplied.toFixed(1)}x)
              </p>
            )}
          </div>

          {/* Secondary Echo Filter Lockout Preset */}
          <div className="space-y-1.5">
            <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest block">
              Echo Filter Lockout
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setEchoFilterMode('standard')}
                className={`py-2 px-2.5 rounded-xl border text-[10px] font-mono leading-tight text-center transition-all cursor-pointer font-bold ${
                  echoFilterMode === 'standard'
                    ? 'border-emerald-400 bg-emerald-500/5 text-slate-100 font-black'
                    : 'border-slate-850 bg-slate-950 text-slate-400 hover:border-slate-800'
                }`}
              >
                <div>🥁 Standard Accents</div>
                <div className="text-[7.5px] text-slate-500 mt-0.5 uppercase tracking-wide">Auto BPM Guard</div>
              </button>
              <button
                onClick={() => setEchoFilterMode('fast')}
                className={`py-2 px-2.5 rounded-xl border text-[10px] font-mono leading-tight text-center transition-all cursor-pointer font-bold ${
                  echoFilterMode === 'fast'
                    ? 'border-emerald-400 bg-emerald-500/5 text-slate-100 font-black'
                    : 'border-slate-850 bg-slate-950 text-slate-400 hover:border-slate-800'
                }`}
              >
                <div>⚡ Lightning Rolls</div>
                <div className="text-[7.5px] text-slate-500 mt-0.5 uppercase tracking-wide">Locked 12ms filter</div>
              </button>
            </div>
          </div>
        </section>


        {/* ACCORDION COLLAPSIBLE DRAWER: ADVANCED AUDIO DIAGNOSTICS */}
        <section id="advanced-diagnostics-drawer" className="border border-slate-900 bg-slate-950/70 rounded-2xl overflow-hidden shadow-sm">
          <button
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="w-full px-4 py-3 flex items-center justify-between text-[10px] font-mono font-black text-slate-400 bg-slate-950 hover:bg-slate-900 transition-colors cursor-pointer select-none border-b border-transparent"
          >
            <span className="flex items-center gap-1.5">
              <SlidersHorizontal size={11} className="text-emerald-400" />
              ADVANCED AUDIO DIAGNOSTICS
            </span>
            <span className="text-[9px] text-slate-600 font-bold">{showDiagnostics ? 'COLLAPSE ▲' : 'EXPAND VIEW ▼'}</span>
          </button>

          {showDiagnostics && (
            <div className="p-4 bg-slate-950 border-t border-slate-900 space-y-4 text-xs font-mono">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-slate-500 text-[9px] block">ECHO FILTER DELAY</span>
                  <div className="text-sm font-bold text-slate-100">
                    {getEchoFilterMs()} ms
                  </div>
                  <p className="text-[8px] text-slate-600 leading-snug">
                    Double trigger lockout gate calculated from target {targetBPM} BPM.
                  </p>
                </div>

                <div className="space-y-1">
                  <span className="text-slate-500 text-[9px] block">GHOST LIMIT MULTIPLIER</span>
                  <div className="text-sm font-bold text-slate-100">
                    {getSensitivityMultiplier().toFixed(1)}x
                  </div>
                  <p className="text-[8px] text-slate-600 leading-snug">
                    Constant multiplier against background floor level.
                  </p>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-900 space-y-1.5">
                <div className="flex justify-between items-center text-[9px]">
                  <span className="text-slate-500">BIQUAD HIGHPASS CUTOFF</span>
                  <span className="text-slate-100 font-bold">900 Hz</span>
                </div>
                <div className="h-1 bg-slate-900 rounded overflow-hidden">
                  <div className="h-full bg-emerald-400/40 w-[45%]" />
                </div>
                <span className="text-[8px] text-slate-600 block">
                  Hard cut filtering out low AC drafts or background talk hums. High pitch stick click hits are preserved locktight.
                </span>
              </div>

              <div className="pt-3 border-t border-slate-900 space-y-1.5">
                <div className="flex justify-between text-[10px] font-bold">
                  <span className="text-slate-400">Manual Tolerance Adjuster</span>
                  <span className="text-emerald-400">±{tolerance} BPM</span>
                </div>
                <div className="flex items-center gap-1 bg-slate-900/50 p-1 rounded-lg">
                  {[2, 4, 6, 8, 12, 16].map((it) => (
                    <button
                      key={it}
                      onClick={() => setTolerance(it)}
                      className={`flex-1 py-1 rounded text-[9px] transition-all cursor-pointer font-bold ${
                        tolerance === it 
                          ? 'bg-slate-800 border border-slate-700 text-emerald-400' 
                          : 'text-slate-500 hover:text-white'
                      }`}
                    >
                      ±{it}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* CONNECT CTA INACTIVE BANNER */}
        {!isEngineReady && (
          <div className="bg-slate-900/40 border border-dashed border-slate-800 p-4 rounded-2xl text-center space-y-2">
            <Mic className="mx-auto text-emerald-400 animate-bounce" size={20} />
            <h4 className="font-bold text-xs text-slate-100 uppercase tracking-widest">Connect Mic Capture</h4>
            <p className="text-[9px] text-slate-500 max-w-xs mx-auto leading-relaxed font-mono">
              Initialize our standard thread-isolated AudioWorklet DSP pipeline to track physical pad actions.
            </p>
            <button
              onClick={startAudioEngine}
              className="px-4 py-1.5 rounded-xl font-mono text-[10px] font-black text-slate-950 bg-emerald-400 hover:bg-emerald-300 active:scale-95 transition-all shadow-md cursor-pointer uppercase tracking-wider"
            >
              Start Acoustic Stream
            </button>
          </div>
        )}

      </main>

      {/* FOOTER METRIC CONTROLLER ACTIONS */}
      <footer className="max-w-md mx-auto w-full px-4 border-t border-slate-900 py-3.5 flex items-center justify-between font-mono text-[8px] text-slate-500 z-10 bg-slate-950/40">
        <div>
          <span>Target Metronome: {targetBPM} BPM</span>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => handleReset()}
            className="hover:text-rose-400 flex items-center gap-1 transition-all cursor-pointer font-black"
          >
            <RefreshCw size={9} /> RESET STATS
          </button>
          <span className="text-slate-800 font-bold">//</span>
          {isEngineReady ? (
            <button 
              onClick={cleanupAudio}
              className="text-rose-400 hover:text-rose-300 flex items-center gap-1 transition-all cursor-pointer font-black"
            >
              <MicOff size={9} /> DISCONNECT MIC
            </button>
          ) : (
            <button 
              onClick={startAudioEngine}
              className="text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-all cursor-pointer font-black"
            >
              <Mic size={9} /> CONNECT MIC
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
