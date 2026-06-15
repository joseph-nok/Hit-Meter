// public/processors/stroke-processor.js

class StrokeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.historyBuffer = new Float32Array(512); // Short memory for lookahead transient checking
    this.bufferIndex = 0;
    this.noiseFloor = 0.0005;
    this.smoothingFactor = 0.995;
    this.debounceTimer = 0;
    
    // Default fallback values
    this.ghostNoteSensitivity = 0.5;
    this.echoFilterMs = 24;
    this.metronomeTicks = [];

    // Adaptive timing tracking for resting/tiredness compensation
    this.lastHitTime = 0;
    this.recentIntervals = [];
    this.stableInterval = 0;

    // Listen for messages from React thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'UPDATE_SETTINGS') {
        if (typeof event.data.ghostNoteSensitivity === 'number') {
          this.ghostNoteSensitivity = event.data.ghostNoteSensitivity;
        }
        if (typeof event.data.echoFilterMs === 'number') {
          this.echoFilterMs = event.data.echoFilterMs;
        }
      } else if (event.data.type === 'METRONOME_TICK') {
        this.metronomeTicks.push({
          time: event.data.time,
          duration: event.data.duration || 0.12
        });
        if (this.metronomeTicks.length > 30) {
          this.metronomeTicks.shift();
        }
      }
    };
  }

  static get parameterDescriptors() {
    return [{
      name: 'ghostNoteSensitivity',
      defaultValue: 0.5,
      minValue: 0.01,
      maxValue: 1.0
    }];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];

    // Determine sample rate and current context time (in seconds)
    const sampleRateHz = typeof sampleRate !== 'undefined' ? sampleRate : 44100;
    const curTimeSec = typeof currentTime !== 'undefined' ? currentTime : 0;

    // Use either the AudioParam or the direct message setting
    let sensitivitySetting = this.ghostNoteSensitivity;
    if (parameters.ghostNoteSensitivity && parameters.ghostNoteSensitivity.length > 0) {
      sensitivitySetting = parameters.ghostNoteSensitivity[0];
    }

    // 1. Calculate Block RMS and track peak variations
    let frameRMS = 0;
    let peakValue = 0;
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      frameRMS += sample * sample;
      const absSample = Math.abs(sample);
      if (absSample > peakValue) peakValue = absSample;
      
      // Save samples into history for lookahead transient checking if needed
      this.historyBuffer[this.bufferIndex] = sample;
      this.bufferIndex = (this.bufferIndex + 1) % this.historyBuffer.length;
    }
    frameRMS = Math.sqrt(frameRMS / channel.length);

    // 2. Continuous environmental room noise calibration
    if (frameRMS < this.noiseFloor * 2.0) {
      this.noiseFloor = (this.noiseFloor * this.smoothingFactor) + (frameRMS * (1.0 - this.smoothingFactor));
    }
    // Set a baseline minimum floor to avoid divide-by-zero or over-sensitivity in dead silent rooms
    this.noiseFloor = Math.max(0.0001, this.noiseFloor);

    if (this.debounceTimer > 0) {
      this.debounceTimer -= channel.length;
    }

    // Check if within any scheduled metronome tick window
    let inMetronomeGating = false;
    if (this.metronomeTicks && this.metronomeTicks.length > 0) {
      this.metronomeTicks = this.metronomeTicks.filter(tick => curTimeSec < tick.time + tick.duration + 0.2);
      
      for (let i = 0; i < this.metronomeTicks.length; i++) {
        const tick = this.metronomeTicks[i];
        if (curTimeSec >= tick.time - 0.02 && curTimeSec <= tick.time + tick.duration) {
          inMetronomeGating = true;
          break;
        }
      }
    }

    // 3. Adaptive Rhythm Gating (Identify if we are within the "Lock Down" expected timing window)
    let inLockDownWindow = false;
    let timingOffset = 999;
    
    // Check historical rhythm pattern of hits to see if tempo has been consistent
    if (this.stableInterval > 0 && this.lastHitTime > 0) {
      const timeSinceLastHit = curTimeSec - this.lastHitTime;
      const intervalMultiple = Math.round(timeSinceLastHit / this.stableInterval);
      
      if (intervalMultiple >= 1 && intervalMultiple <= 3) {
        const expectedNextTime = this.lastHitTime + (this.stableInterval * intervalMultiple);
        const expectedOffset = Math.abs(curTimeSec - expectedNextTime);
        // Window is 20% of stable BPS interval, up to ±130ms (generous enough for physical drift/exhaustion)
        const maxWindow = Math.min(0.13, this.stableInterval * 0.20);
        if (expectedOffset <= maxWindow) {
          inLockDownWindow = true;
          timingOffset = expectedOffset;
        }
      }
    }
    
    // Check metronome targets (if metronome is active, these are absolute grid indicators)
    if (!inLockDownWindow && this.metronomeTicks && this.metronomeTicks.length > 0) {
      for (let i = 0; i < this.metronomeTicks.length; i++) {
        const tick = this.metronomeTicks[i];
        const expectedOffset = Math.abs(curTimeSec - tick.time);
        if (expectedOffset <= 0.12) { // ±120ms around beat
          inLockDownWindow = true;
          timingOffset = Math.min(timingOffset, expectedOffset);
          break;
        }
      }
    }

    // 4. Mathematical Base Threshold (Lighter slider = lower threshold floor)
    let dynamicThreshold = this.noiseFloor * (1.2 + (sensitivitySetting * 10.0));

    // Adaptive Rhythm-Locking Compensation:
    // When the user has been consistently in time, tiredness shouldn't block softer hits.
    // We dramatically increase the capture sensitivity inside the countdown/rhythm timing window!
    if (inLockDownWindow) {
      // Scale down required threshold by up to 60% based on proximity to the perfect rhythm timing
      const adaptiveRatio = Math.max(0.40, 0.40 + (timingOffset / 0.13) * 0.60);
      dynamicThreshold = dynamicThreshold * adaptiveRatio;
    }

    // Metronome Attenuator: Pushes target threshold momentarily up only during acoustic click play window
    if (inMetronomeGating) {
      const gateMultiplier = inLockDownWindow ? 2.0 : 3.5;
      dynamicThreshold = dynamicThreshold * gateMultiplier;
    }

    // 5. THE NOISE CANCELLATION CLASSIFIER (Isolates stick snaps)
    if (frameRMS > dynamicThreshold && this.debounceTimer <= 0) {
      
      // A. Crest Factor Check (Measures the "peakiness" of the wave)
      // Voices/blowing air are dense (low crest factor). Stick hits are sharp spikes (high crest factor).
      const crestFactor = frameRMS > 0 ? (peakValue / frameRMS) : 0;

      // B. Attack Velocity Rise-Time Check
      // We look back at recent sub-chunks to see how fast the energy exploded.
      let halfLength = Math.floor(channel.length / 2);
      let earlyRMS = 0;
      let lateRMS = 0;
      
      for (let i = 0; i < halfLength; i++) {
        earlyRMS += channel[i] * channel[i];
        lateRMS += channel[i + halfLength] * channel[i + halfLength];
      }
      
      // Calculate how much the volume multiplied in just 1.5 milliseconds
      const growthRatio = earlyRMS > 0 ? (lateRMS / earlyRMS) : 10;

      // C. THE VETO FILTERING CRITERIA
      // Stick hits have a massive Crest Factor (> 3.5) and a blindingly fast rise speed (> 2.5)
      // We allow a slightly lower Crest Factor threshold during high sensitivity settings to retain arm's-length responsiveness
      let minCrestRequired = sensitivitySetting < 0.2 ? 3.0 : 3.5;
      let minGrowthRequired = sensitivitySetting < 0.2 ? 2.0 : 2.5;

      if (inLockDownWindow) {
        // Tiredness adaptation: lower requirements for crest factor and rise speed when playing in style.
        // Even slightly "mushier" or softer strokes will be counted!
        minCrestRequired = minCrestRequired * 0.58;  // e.g. 3.5 * 0.58 = ~2.0
        minGrowthRequired = minGrowthRequired * 0.58; // e.g. 2.5 * 0.58 = ~1.45
      }

      const isSharpImpact = crestFactor > minCrestRequired && growthRatio > minGrowthRequired;
      
      // Voices have a Crest Factor < 3.0 and build up gradually (growthRatio < 1.8)
      // When locked in tempo, we soften voice/blowing filters to make sure tired hits count
      const isVoiceOrBlowing = inLockDownWindow 
        ? (crestFactor < 1.8 || growthRatio < 1.1)
        : (crestFactor < 3.0 || growthRatio < 1.8);

      const minRMSRequired = inLockDownWindow ? (this.noiseFloor * 0.6) : this.noiseFloor;

      if (isSharpImpact && !isVoiceOrBlowing && frameRMS > minRMSRequired) {
        this.port.postMessage({
          type: 'STROKE_DETECTED',
          timestamp: curTimeSec,
          intensity: frameRMS
        });
        
        // Track the intervals for adaptive rhythm-locking tolerance
        if (this.lastHitTime > 0) {
          const interval = curTimeSec - this.lastHitTime;
          // Only track reasonable musical drumming intervals (e.g. 0.15s to 2.0s = 30 to 400 BPM)
          if (interval >= 0.15 && interval <= 2.0) {
            this.recentIntervals.push(interval);
            if (this.recentIntervals.length > 5) {
              this.recentIntervals.shift();
            }
            
            // Check if intervals are reasonably stable representing a rhythmic tempo
            const avg = this.recentIntervals.reduce((a, b) => a + b, 0) / this.recentIntervals.length;
            const isStable = this.recentIntervals.every(inv => Math.abs(inv - avg) < 0.080); // within 80ms deviation
            if (isStable) {
              this.stableInterval = avg;
            } else {
              this.stableInterval = 0;
            }
          } else {
            this.recentIntervals = [];
            this.stableInterval = 0;
          }
        }
        this.lastHitTime = curTimeSec;

        // Lock out frame evaluations for a custom lockout window (based on ms or default 24ms)
        const lockoutMs = this.echoFilterMs || 24;
        this.debounceTimer = (lockoutMs / 1000) * sampleRateHz; 
      }
    }

    return true;
  }
}

registerProcessor('stroke-processor', StrokeProcessor);
