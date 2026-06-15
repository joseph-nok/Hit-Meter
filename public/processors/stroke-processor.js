// public/processors/stroke-processor.js

class StrokeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lastMag = null;
    this.cooldownSamples = 0;
    
    // Auto-tuning states
    this.adaptiveNoiseFloor = 0.015;
    this.autoMode = true; // default: fully automated self-tuning
    this.ghostNotesEnabled = false; // default: false (multiplier is 2.5x to prevent talk/fan slop; true means 1.5x)
    this.targetBpm = 60; // used to compute auto echo filter
    
    // Manual fallbacks
    this.ghostNoteSensitivity = 2.8; 
    this.echoFilterMs = 25;   
    
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

    // 2. Calculate Mean Absolute Value (Energy) of the current block
    let currentMag = 0;
    for (let i = 0; i < bufferSize; i++) {
      currentMag += Math.abs(channel[i]);
    }
    currentMag /= bufferSize;

    if (this.lastMag === null) {
      this.lastMag = currentMag;
      return true;
    }

    // 3. Compute Transient Flux (The sudden positive rise velocity in energy)
    const flux = currentMag - this.lastMag;
    this.lastMag = currentMag;

    // 4. GHOST NOTE SENSITIVITY AUTOMATION (Adaptive Noise Floor Tracking with Quiescent Gate)
    // We only adapt and drift the noise floor up when the signal is relatively stable (low flux).
    // This blocks recurring drum strokes from artificially desensitizing the sensor.
    const isSteady = Math.abs(flux) < 0.003;
    if (isSteady) {
      this.adaptiveNoiseFloor = this.adaptiveNoiseFloor * 0.992 + currentMag * 0.008;
    } else {
      // If quiet but unsteady, we can still drift down slowly to recover sensitivity
      if (currentMag < this.adaptiveNoiseFloor) {
        this.adaptiveNoiseFloor = this.adaptiveNoiseFloor * 0.996 + currentMag * 0.004;
      }
    }
    // Safe bounds
    this.adaptiveNoiseFloor = Math.max(0.002, Math.min(0.08, this.adaptiveNoiseFloor));

    // 5. EVALUATE TRANSIENT HIT WITH SELF-TUNED ENGINES
    if (this.cooldownSamples <= 0 && flux > 0) {
      let threshold = 0.012;
      let usedEchoFilterMs = 25;

      if (this.autoMode) {
        // Auto Ghost Note Sensitivity: Multiplier of the tracking noise floor (1.5x in Ghost Note Mode, 2.5x normally)
        const multiplier = this.ghostNotesEnabled ? 1.4 : 2.5;
        threshold = Math.max(this.adaptiveNoiseFloor * multiplier, 0.008);
        
        // Auto Echo Filter: Lockout derived from target BPM interval divided by 8 (bounded between 12ms and 60ms)
        usedEchoFilterMs = Math.max(12, Math.min(60, (60000 / this.targetBpm) / 8));
      } else {
        // Advanced manual preset overrides (Using stable adaptive noise tracking as the base multiplier)
        threshold = Math.max(this.adaptiveNoiseFloor * this.ghostNoteSensitivity, 0.008);
        usedEchoFilterMs = this.echoFilterMs;
      }

      // Check peak rise against computed threshold - use dynamic fallback for soft strokes
      const minMagAllowed = Math.max(0.005, this.adaptiveNoiseFloor * 1.05);
      if (flux > threshold && currentMag > minMagAllowed) {
        // Trigger hit event back to the React scheduler thread
        const eventTime = typeof currentTime !== 'undefined' ? currentTime : (Date.now() / 1000);
        this.port.postMessage({ 
          type: 'STROKE_DETECTED', 
          timestamp: eventTime,
          autoEchoFilterApplied: usedEchoFilterMs,
          autoThresholdApplied: threshold
        });
        
        // Set exact sample-level cooldown lockout
        const sampleRateHz = typeof sampleRate !== 'undefined' ? sampleRate : 44100;
        this.cooldownSamples = (usedEchoFilterMs / 1000) * sampleRateHz;
      }
    }

    return true;
  }
}

registerProcessor('stroke-processor', StrokeProcessor);
