// public/processors/stroke-processor.js

class StrokeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastMag = null;
    this.cooldownSamples = 0;
    
    // Auto-tuning states
    this.adaptiveNoiseFloor = 0.005;
    this.autoMode = true; // default: fully automated self-tuning
    this.ghostNotesEnabled = false; 
    this.targetBpm = 60; 
    
    // Manual fallbacks
    this.ghostNoteSensitivity = 2.8; 
    this.echoFilterMs = 25;   
    
    // Metronome tick gate registry
    this.metronomeTicks = [];
    
    // Listen for real-time adjustments or mode toggles from React UI
    this.port.onmessage = (event) => {
      if (event.data.type === 'UPDATE_SETTINGS') {
        if (typeof event.data.autoMode === 'boolean') {
          this.autoMode = event.data.autoMode;
        }
        if (typeof event.data.ghostNotesEnabled === 'boolean') {
          this.ghostNotesEnabled = event.data.ghostNotesEnabled;
        }
        if (typeof event.data.targetBpm === 'number') {
          this.targetBpm = event.data.targetBpm;
        }
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

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0]; // Mono input channel
    const bufferSize = channel.length;

    // 1. ECHO FILTER BLOCK TIMING (Using actual physical samples processed)
    if (this.cooldownSamples > 0) {
      this.cooldownSamples -= bufferSize;
    }

    // 2. Calculate Root Mean Square (RMS) of the current block
    let frameRMS = 0;
    for (let i = 0; i < bufferSize; i++) {
      frameRMS += channel[i] * channel[i];
    }
    frameRMS = Math.sqrt(frameRMS / bufferSize);

    if (this.lastMag === null) {
      this.lastMag = frameRMS;
      return true;
    }

    // 3. Compute Transient Flux (The sudden positive rise velocity in energy)
    const flux = frameRMS - this.lastMag;
    this.lastMag = frameRMS;

    // 4. GHOST NOTE SENSITIVITY AUTOMATION (Adaptive Noise Floor Tracking with Quiescent Gate)
    // Tracks background environmental noise steadily (slow smoothing factor to ignore transient peak outliers)
    const smoothingFactor = 0.995;
    if (frameRMS < this.adaptiveNoiseFloor * 2.0) {
      this.adaptiveNoiseFloor = (this.adaptiveNoiseFloor * smoothingFactor) + (frameRMS * (1 - smoothingFactor));
    }
    // Safe bounds
    this.adaptiveNoiseFloor = Math.max(0.0015, Math.min(0.08, this.adaptiveNoiseFloor));

    // Determine current audio context time (in seconds)
    const curTimeSec = typeof currentTime !== 'undefined' ? currentTime : 0;

    // Check if within any scheduled metronome tick window
    let inMetronomeGating = false;
    if (this.metronomeTicks && this.metronomeTicks.length > 0) {
      // Clean up past ticks (duration + padding of 0.2s)
      this.metronomeTicks = this.metronomeTicks.filter(tick => curTimeSec < tick.time + tick.duration + 0.2);
      
      for (let i = 0; i < this.metronomeTicks.length; i++) {
        const tick = this.metronomeTicks[i];
        // Check if we are inside the tick window
        if (curTimeSec >= tick.time - 0.02 && curTimeSec <= tick.time + tick.duration) {
          inMetronomeGating = true;
          break;
        }
      }
    }

    // 5. EVALUATE TRANSIENT HIT
    if (this.cooldownSamples <= 0 && flux > 0) {
      // Calculate dynamic sensitivity threshold based on adaptive floor and sensitivity setting
      let threshold = Math.max(this.adaptiveNoiseFloor * this.ghostNoteSensitivity, 0.0035);
      let usedEchoFilterMs = this.echoFilterMs;

      // Metronome Attenuator: If the metronome plays, the threshold/gate is momentarily pushed up 
      // only for that micro-window, then drops back down instantly to catch soft hits.
      if (inMetronomeGating) {
        threshold = threshold * 5.0; // Spike transient requirement 5x during clicking to absorb speaker bleed
      }

      // Check peak rise against computed threshold - use dynamic fallback for soft strokes
      let minMagAllowed = Math.max(0.003, this.adaptiveNoiseFloor * 1.05);
      if (inMetronomeGating) {
        minMagAllowed = minMagAllowed * 4.0; // Raise overall magnitude floor as well during feedback window
      }

      if (flux > threshold && frameRMS > minMagAllowed) {
        // Trigger hit event back to the React scheduler thread
        const eventTime = typeof currentTime !== 'undefined' ? currentTime : (Date.now() / 1000);
        this.port.postMessage({ 
          type: 'STROKE_DETECTED', 
          timestamp: eventTime,
          autoEchoFilterApplied: usedEchoFilterMs,
          autoThresholdApplied: threshold
        });
        
        // Lock out the microphone cleanly to separate strokes (derived debounce / cooldown lockout)
        const sampleRateHz = typeof sampleRate !== 'undefined' ? sampleRate : 44100;
        this.cooldownSamples = (usedEchoFilterMs / 1000) * sampleRateHz;
      }
    }

    return true;
  }
}

registerProcessor('stroke-processor', StrokeProcessor);
