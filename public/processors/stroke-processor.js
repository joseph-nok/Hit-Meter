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

    // 3. Mathematical Base Threshold (Lighter slider = lower threshold floor)
    let dynamicThreshold = this.noiseFloor * (1.2 + (sensitivitySetting * 10.0));

    // Metronome Attenuator: Pushes target threshold momentarily up only during tick window
    if (inMetronomeGating) {
      dynamicThreshold = dynamicThreshold * 4.0;
    }

    // 4. THE NOISE CANCELLATION CLASSIFIER (Isolates stick snaps)
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
      const minCrestRequired = sensitivitySetting < 0.2 ? 3.0 : 3.5;
      const minGrowthRequired = sensitivitySetting < 0.2 ? 2.0 : 2.5;

      const isSharpImpact = crestFactor > minCrestRequired && growthRatio > minGrowthRequired;
      
      // Voices have a Crest Factor < 3.0 and build up gradually (growthRatio < 1.8)
      const isVoiceOrBlowing = crestFactor < 3.0 || growthRatio < 1.8;

      if (isSharpImpact && !isVoiceOrBlowing && frameRMS > this.noiseFloor) {
        this.port.postMessage({
          type: 'STROKE_DETECTED',
          timestamp: curTimeSec,
          intensity: frameRMS
        });
        
        // Lock out frame evaluations for a custom lockout window (based on ms or default 24ms)
        const lockoutMs = this.echoFilterMs || 24;
        this.debounceTimer = (lockoutMs / 1000) * sampleRateHz; 
      }
    }

    return true;
  }
}

registerProcessor('stroke-processor', StrokeProcessor);
