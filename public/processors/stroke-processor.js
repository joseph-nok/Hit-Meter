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

    // 3. GHOST NOTE SENSITIVITY AUTOMATION (Adaptive Noise Floor Tracking)
    // If the sound is sustained and steady (like continuous desk fans, A/C, air blow, background talking),
    // we smoothly drift the noise floor up or down to absorb background energy.
    if (currentMag < this.adaptiveNoiseFloor) {
      // Smoothly drift down to match quiet environments
      this.adaptiveNoiseFloor = this.adaptiveNoiseFloor * 0.999 + currentMag * 0.001;
    } else {
      // Smoothly drift up to absorb continuous loud ambient noise
      this.adaptiveNoiseFloor = this.adaptiveNoiseFloor * 0.993 + currentMag * 0.007;
    }

    if (this.lastMag === null) {
      this.lastMag = currentMag;
      return true;
    }

    // 4. Compute Transient Flux (The sudden positive rise velocity in energy)
    const flux = currentMag - this.lastMag;
    this.lastMag = currentMag;

    // 5. EVALUATE TRANSIENT HIT WITH SELF-TUNED ENGINES
    if (this.cooldownSamples <= 0 && flux > 0) {
      let threshold = 0.012;
      let usedEchoFilterMs = 25;

      if (this.autoMode) {
        // Auto Ghost Note Sensitivity: Multiplier of the tracking noise floor (1.5x in Ghost Note Mode, 2.5x normally)
        const multiplier = this.ghostNotesEnabled ? 1.4 : 2.5;
        threshold = Math.max(this.adaptiveNoiseFloor * multiplier, 0.011);
        
        // Auto Echo Filter: Lockout derived from target BPM interval divided by 8 (bounded between 12ms and 60ms)
        usedEchoFilterMs = Math.max(12, Math.min(60, (60000 / this.targetBpm) / 8));
      } else {
        // Advanced manual preset overrides (Using stable adaptive noise tracking as the base multiplier)
        threshold = Math.max(this.adaptiveNoiseFloor * this.ghostNoteSensitivity, 0.011);
        usedEchoFilterMs = this.echoFilterMs;
      }

      // Check peak rise against computed threshold
      if (flux > threshold && currentMag > 0.012) {
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
