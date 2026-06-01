const { createApp, ref, reactive, onMounted, onUnmounted, watch } = Vue;

const App = {
  setup() {
    const isAudioReady = ref(false);
    const isLoading = ref(false);
    const isRecording = ref(false);
    const activeTab = ref('OSC');

    const presetName = ref('Hyperion Arp [Init]');
    const presetInput = ref(null);
    const sampleInputA = ref(null);
    const sampleInputB = ref(null);
    const sampleNameA = ref('Init Wave.wav');
    const sampleNameB = ref('Init Wave.wav');

    // --- SYNTH STATE ---
    const synthState = reactive({
      masterVol: -6,
      polyphony: 8,
      glide: 0,
      swellEnabled: true,
      masterFx: {
        compThresh: -12,
        limitThresh: -1
      },
      oscA: {
        on: true, type: 'Wavetable',
        wtPos: 50, warp: 0, fm: 0, phase: 0,
        coarse: 0, fine: 0,
        unison: 3, detune: 0.1, pan: 0, level: 80,
        granSize: 50, granDens: 50,
        specFormant: 0, specSmear: 20,
        sampStart: 0, sampEnd: 100,
        multiSpread: 50, multiCurve: 50
      },
      oscB: {
        on: false, type: 'Wavetable',
        wtPos: 20, warp: 10, fm: 0, phase: 180,
        coarse: -12, fine: 0,
        unison: 1, detune: 0.05, pan: 0, level: 0,
        granSize: 50, granDens: 50,
        specFormant: 0, specSmear: 20,
        sampStart: 0, sampEnd: 100,
        multiSpread: 50, multiCurve: 50
      },
      sub: { on: false, shape: 'sine', oct: -1, level: 50 },
      noise: { on: false, color: 'white', level: 0 },
      filter: {
        on: true, type: 'lowpass',
        cutoff: 2000, res: 2, drive: 0,
        envAmt: 50, keytrack: 50, pan: 0
      },
      env1: { a: 0.01, d: 0.3, s: 0.5, r: 0.8 },
      env2: { a: 0.1, d: 0.5, s: 0.2, r: 0.5 },
      lfo1: { rate: 2, depth: 50, shape: 'sine', delay: 0 },
      lfo2: { rate: 0.5, depth: 30, shape: 'triangle', delay: 0.5 },
      fx: {
        dstDrive: 0.5, dstTone: 0.8, dstWet: 0,
        choDepth: 0.5, choRate: 0.2, choWet: 0,
        dlyTime: 0.4, dlyFeed: 0.4, dlyCut: 2000, dlyWet: 0.1,
        revSize: 0.8, revDecay: 2.5, revDamp: 4000, revWet: 0.2
      }
    });

    const oscTypes = ['Wavetable', 'Multisample', 'Sample', 'Granular', 'Spectral'];
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const keyboardKeys = [];
    for (let oct = 3; oct <= 5; oct++) {
      notes.forEach(n => keyboardKeys.push({ note: n + oct, isBlack: n.includes('#') }));
    }

    const activeNotes = ref(new Set());
    const metersCanvas = ref(null);
    const oscAWaveCanvas = ref(null);
    const oscBWaveCanvas = ref(null);
    let drawFrame;

    // --- AUDIO ENGINE ---
    let polySynth, masterFilter, reverb, delay, dist, chorus;
    let fftAnalyzer, rmsMeter, masterRecorder, expressionNode;
    let masterLimiter, masterCompressor;
    
    // Expression tracking
    let isPlayingAnyNote = false;
    let globalMouseX = 0;
    let globalMouseY = 0;
    let activeKeyStartPos = null;
    let expressionVol = 0; 
    let expressionTarget = 0;

    const initAudio = async () => {
      isLoading.value = true;
      await Tone.start();

      // Master Dynamic Nodes
      masterLimiter = new Tone.Limiter(synthState.masterFx.limitThresh).connect(Tone.Destination);
      masterCompressor = new Tone.Compressor({
        threshold: synthState.masterFx.compThresh,
        ratio: 4,
        attack: 0.01,
        release: 0.1
      }).connect(masterLimiter);

      // Initialize Effects Chain (Connecting into Compressor -> Limiter)
      reverb = new Tone.Reverb(synthState.fx.revDecay).connect(masterCompressor);
      delay = new Tone.FeedbackDelay('8n', synthState.fx.dlyFeed).connect(reverb);
      chorus = new Tone.Chorus(4, 2.5, synthState.fx.choDepth).connect(delay).start();
      dist = new Tone.Distortion(synthState.fx.dstDrive).connect(chorus);
      
      masterFilter = new Tone.Filter(synthState.filter.cutoff, synthState.filter.type).connect(dist);
      masterFilter.Q.value = synthState.filter.res;

      // Expression Node (for dynamic piano roll volume control)
      expressionNode = new Tone.Volume(0).connect(masterFilter);

      fftAnalyzer = new Tone.FFT(64);
      rmsMeter = new Tone.Meter({ smoothing: 0.85 });
      masterRecorder = new Tone.Recorder();
      
      // Connect meters & recorder to master output post-limiter
      masterLimiter.connect(rmsMeter);
      masterLimiter.connect(fftAnalyzer);
      masterLimiter.connect(masterRecorder);

      polySynth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
        envelope: {
          attack: synthState.env1.a, decay: synthState.env1.d,
          sustain: synthState.env1.s, release: synthState.env1.r
        }
      }).connect(expressionNode);

      polySynth.volume.value = synthState.masterVol;
      updateFXMix();

      isAudioReady.value = true;
      isLoading.value = false;
      
      // Slight delay to ensure canvas refs are mounted before starting loop
      setTimeout(startVisualizer, 100);
    };

    const updateEngineParams = () => {
      if (!isAudioReady.value) return;
      
      polySynth.set({
        envelope: { attack: synthState.env1.a, decay: synthState.env1.d, sustain: synthState.env1.s, release: synthState.env1.r }
      });

      masterFilter.frequency.rampTo(synthState.filter.cutoff, 0.1);
      masterFilter.Q.value = synthState.filter.res;
      masterFilter.type = synthState.filter.type;
      
      if (masterCompressor) masterCompressor.threshold.value = synthState.masterFx.compThresh;
      if (masterLimiter) masterLimiter.threshold.value = synthState.masterFx.limitThresh;

      updateFXMix();

      let baseType = 'sawtooth';
      if (synthState.oscA.type === 'Wavetable') baseType = synthState.oscA.wtPos > 50 ? 'square' : 'sawtooth';
      if (synthState.oscA.type === 'Sample') baseType = 'sine';
      if (synthState.oscA.type === 'Granular') baseType = 'triangle';
      
      const typeStr = synthState.oscA.unison > 1 ? `fat${baseType}` : baseType;
      polySynth.set({ oscillator: { type: typeStr, count: synthState.oscA.unison, spread: synthState.oscA.detune * 100 } });
    };

    const updateFXMix = () => {
      if (!reverb) return;
      reverb.wet.value = synthState.fx.revWet;
      delay.wet.value = synthState.fx.dlyWet;
      dist.wet.value = synthState.fx.dstWet;
      chorus.wet.value = synthState.fx.choWet;
      dist.distortion = synthState.fx.dstDrive;
      reverb.decay = synthState.fx.revDecay;
      delay.feedback.value = synthState.fx.dlyFeed;
      polySynth.volume.value = synthState.masterVol;
    };

    watch(synthState, updateEngineParams, { deep: true });

    // --- KEYBOARD & EXPRESSION LOGIC ---
    const onGlobalMouseMove = (e) => {
       globalMouseX = e.clientX;
       globalMouseY = e.clientY;
    };

    const playNote = (e, note) => {
      if (!isAudioReady.value) return;
      activeNotes.value.add(note);
      isPlayingAnyNote = true;
      if (e) {
         activeKeyStartPos = { x: e.clientX, y: e.clientY };
         if (synthState.swellEnabled) {
             expressionTarget = -12; 
             expressionVol = -12;
             if(expressionNode) expressionNode.volume.value = expressionVol;
         } else {
             expressionTarget = 0;
             expressionVol = 0;
             if(expressionNode) expressionNode.volume.value = 0;
         }
      }
      polySynth.triggerAttack(note, Tone.now());
    };

    const releaseNote = (note) => {
      if (!isAudioReady.value) return;
      activeNotes.value.delete(note);
      if (activeNotes.value.size === 0) {
         isPlayingAnyNote = false;
         activeKeyStartPos = null;
      }
      polySynth.triggerRelease(note, Tone.now());
    };

    const onKeyMouseDown = (e, note) => playNote(e, note);
    const onKeyMouseUp = (note) => releaseNote(note);
    const onKeyMouseLeave = (note) => { if (activeNotes.value.has(note)) releaseNote(note); };
    const onKeyMouseEnter = (e, note) => { if (e.buttons === 1) playNote(e, note); };

    // --- RECORDING ---
    const toggleRecord = async () => {
      if (!isAudioReady.value) return;
      if (!isRecording.value) {
        masterRecorder.start();
        isRecording.value = true;
      } else {
        const recording = await masterRecorder.stop();
        const url = URL.createObjectURL(recording);
        const anchor = document.createElement("a");
        anchor.download = "BeatRoyale_Export.webm"; 
        anchor.href = url;
        anchor.click();
        URL.revokeObjectURL(url);
        isRecording.value = false;
      }
    };

    // --- METERS VISUALIZER ---
    const startVisualizer = () => {
      const canvas = metersCanvas.value;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      
      let peakDb = -60;
      let integratedLufs = -60;

      const draw = () => {
        if (!metersCanvas.value) {
           drawFrame = requestAnimationFrame(draw);
           return;
        }

        // High-DPI Scaling logic
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
            canvas.width = Math.floor(rect.width * dpr);
            canvas.height = Math.floor(rect.height * dpr);
        }
        
        const w = canvas.width;
        const h = canvas.height;
        
        ctx.clearRect(0, 0, w, h);

        // 1. Process Expression Logic (Vertical Mouse Delta)
        if (synthState.swellEnabled) {
            if (isPlayingAnyNote && activeKeyStartPos) {
               const deltaY = activeKeyStartPos.y - globalMouseY; // Positive when moving UP
               expressionTarget = -12 + (deltaY * 0.2); 
               if (expressionTarget > 6) expressionTarget = 6;
               if (expressionTarget < -40) expressionTarget = -40;
               
               expressionVol += (expressionTarget - expressionVol) * 0.15;
               if(expressionNode) expressionNode.volume.value = expressionVol;
            } else {
               expressionTarget = -40;
               expressionVol += (expressionTarget - expressionVol) * 0.2;
               if(expressionNode) expressionNode.volume.value = expressionVol;
            }
        } else {
            expressionVol = 0;
            expressionTarget = 0;
            if(expressionNode) expressionNode.volume.value = 0;
        }

        // 2. Read Audio Levels (safely)
        let currentRms = -60;
        let currentPeak = -60;
        let fftVals = null;
        
        try {
            if (rmsMeter) currentRms = rmsMeter.getValue();
            if (fftAnalyzer) {
                fftVals = fftAnalyzer.getValue();
                let max = -Infinity;
                for(let i=0; i<fftVals.length; i++) {
                   if(isFinite(fftVals[i]) && fftVals[i] > max) max = fftVals[i];
                }
                if (max > -60) currentPeak = max;
            }
        } catch(e) {}
        
        // Smooth peaks and LUFS
        if (currentPeak > peakDb) peakDb = currentPeak;
        else peakDb -= 0.8; 
        if (peakDb < -60) peakDb = -60;

        // Fake LUFS integration for visualization (averaged RMS + slight peak weighting)
        const targetLufs = currentRms > -50 ? currentRms + 3 : -60;
        integratedLufs += (targetLufs - integratedLufs) * 0.05;

        const rmsSmooth = isFinite(currentRms) ? Math.max(-60, Math.min(6, currentRms)) : -60;
        const peakSmooth = isFinite(peakDb) ? Math.max(-60, Math.min(6, peakDb)) : -60;
        const lufsSmooth = isFinite(integratedLufs) ? Math.max(-60, Math.min(6, integratedLufs)) : -60;

        // --- LAYOUT CONSTANTS ---
        const lufsCx = w * 0.16;
        const centerCx = w * 0.48;
        const peakCx = w * 0.78;
        const rmsCx = w * 0.90;
        const baseFont = 10 * dpr;

        // Unified Readout Fonts & Positioning
        const labelFont = `bold ${8 * dpr}px monospace`;
        const readoutFont = `bold ${16 * dpr}px monospace`;
        const labelY = h * 0.15;
        const readoutY = h * 0.32;

        const drawReadout = (x, val, label, color) => {
            ctx.fillStyle = '#737373';
            ctx.font = labelFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x, labelY);

            ctx.fillStyle = color;
            ctx.font = readoutFont;
            ctx.fillText(val.toFixed(1), x, readoutY);
        };

        // Draw Unified Digital Readouts
        drawReadout(lufsCx, lufsSmooth, 'LUFS INT', '#a855f7');
        drawReadout(centerCx, rmsSmooth, 'VU LEVEL', '#f87171');
        drawReadout(peakCx, peakSmooth, 'PEAK dB', '#3b82f6');
        drawReadout(rmsCx, rmsSmooth, 'RMS dB', '#10b981');

        // --- HELPER: CIRCULAR LED BARS ---
        const barMaxH = h * 0.45;
        const barBaseY = h * 0.90;
        
        const mapDbToHeight = (db) => {
            const normalized = (db + 60) / 66;
            return Math.max(0, Math.min(1, normalized)) * barMaxH;
        };

        const drawCircularLedBar = (cx, dbValue, type) => {
            const activeH = mapDbToHeight(dbValue);
            const segments = 16;
            const ledSpacing = 3 * dpr;
            const ledH = barMaxH / segments;
            const radius = Math.max(1, (ledH - ledSpacing) / 2);
            
            // Draw Dark Backing Slot
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(cx - radius - 4*dpr, barBaseY - barMaxH - 4*dpr, (radius*2) + 8*dpr, barMaxH + 8*dpr);

            for(let i=0; i<segments; i++) {
               const cy = barBaseY - (i * ledH) - radius - (ledSpacing/2);
               
               ctx.beginPath();
               ctx.arc(cx, cy, radius, 0, Math.PI*2);
               
               if ((i * ledH) < activeH) {
                  if (i >= segments - 3) ctx.fillStyle = '#ef4444'; // Red
                  else if (i >= segments - 6) ctx.fillStyle = '#eab308'; // Yellow
                  else ctx.fillStyle = type === 'peak' ? '#3b82f6' : (type === 'lufs' ? '#a855f7' : '#10b981'); 
                  
                  ctx.shadowBlur = 4 * dpr;
                  ctx.shadowColor = ctx.fillStyle;
               } else {
                  ctx.fillStyle = '#262626';
                  ctx.shadowBlur = 0;
               }
               ctx.fill();
            }
            ctx.shadowBlur = 0; // reset
        };

        // Draw LUFS and DB Bars
        drawCircularLedBar(lufsCx, lufsSmooth, 'lufs');
        drawCircularLedBar(peakCx, peakSmooth, 'peak');
        drawCircularLedBar(rmsCx, rmsSmooth, 'rms');

        // --- DRAW ANALOG VU METER (MIDDLE) ---
        const vuCy = h * 0.95;
        const vuRadius = Math.min(w * 0.18, h * 0.52);
        
        // Draw VU background arc
        ctx.beginPath();
        ctx.arc(centerCx, vuCy, vuRadius, Math.PI * 1.15, Math.PI * 1.85);
        ctx.lineWidth = 6 * dpr;
        ctx.strokeStyle = '#262626';
        ctx.stroke();

        // Draw VU Ticks & Text
        ctx.fillStyle = '#a3a3a3';
        ctx.font = `bold ${baseFont * 0.8}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        const tickValues = [-20, -10, -5, 0, 3];
        for (let i = 0; i < tickValues.length; i++) {
            const normalized = (tickValues[i] + 20) / 23; // -20 to +3 range
            const angle = Math.PI * 1.15 + (normalized * (Math.PI * 0.7));
            const isRed = tickValues[i] >= 0;
            
            // Tick
            ctx.beginPath();
            ctx.moveTo(centerCx + Math.cos(angle) * (vuRadius - 8 * dpr), vuCy + Math.sin(angle) * (vuRadius - 8 * dpr));
            ctx.lineTo(centerCx + Math.cos(angle) * (vuRadius + 8 * dpr), vuCy + Math.sin(angle) * (vuRadius + 8 * dpr));
            ctx.lineWidth = 2 * dpr;
            ctx.strokeStyle = isRed ? '#ef4444' : '#d4d4d4';
            ctx.stroke();

            // Text
            if(i % 2 === 0 || tickValues[i] === 0) {
               const txtX = centerCx + Math.cos(angle) * (vuRadius - 18 * dpr);
               const txtY = vuCy + Math.sin(angle) * (vuRadius - 18 * dpr);
               ctx.fillStyle = isRed ? '#ef4444' : '#a3a3a3';
               ctx.fillText(tickValues[i] > 0 ? `+${tickValues[i]}` : tickValues[i], txtX, txtY);
            }
        }

        // Calculate Needle Angle (-40dB to +6dB)
        const mapVuToAngle = (db) => {
           const clamped = Math.max(-25, Math.min(3, db));
           const normalized = (clamped + 25) / 28;
           return Math.PI * 1.15 + (normalized * Math.PI * 0.7);
        };
        const needleAngle = mapVuToAngle(rmsSmooth);

        // Draw Needle Drop Shadow
        ctx.beginPath();
        ctx.moveTo(centerCx + 4*dpr, vuCy + 4*dpr);
        ctx.lineTo(centerCx + 4*dpr + Math.cos(needleAngle) * (vuRadius * 1.05), vuCy + 4*dpr + Math.sin(needleAngle) * (vuRadius * 1.05));
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.stroke();

        // Draw Needle
        ctx.beginPath();
        ctx.moveTo(centerCx, vuCy);
        ctx.lineTo(centerCx + Math.cos(needleAngle) * (vuRadius * 1.05), vuCy + Math.sin(needleAngle) * (vuRadius * 1.05));
        ctx.lineWidth = 2.5 * dpr;
        ctx.strokeStyle = '#f87171'; // Bright red
        ctx.stroke();

        // Needle Base Pin
        ctx.beginPath();
        ctx.arc(centerCx, vuCy, 6 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#171717';
        ctx.fill();
        ctx.lineWidth = 1 * dpr;
        ctx.strokeStyle = '#404040';
        ctx.stroke();

        // --- Draw Mini Oscillators FFT (Safely) ---
        const drawMiniFFT = (cvsRef, color, isOn) => {
          if (!cvsRef.value || !fftVals) return;
          const cvs = cvsRef.value;
          
          if (cvs.width !== Math.floor(cvs.offsetWidth * dpr)) {
              cvs.width = Math.floor(cvs.offsetWidth * dpr);
              cvs.height = Math.floor(cvs.offsetHeight * dpr);
          }
          const mctx = cvs.getContext('2d');
          const mw = cvs.width, mh = cvs.height;
          mctx.clearRect(0,0,mw,mh);
          
          const mbw = mw / fftVals.length;
          mctx.fillStyle = color;
          for(let i=0; i<fftVals.length; i++) {
             let val = Math.max(0, (fftVals[i] + 100) / 100);
             if (!isOn || !isPlayingAnyNote) val = Math.random() * 0.05;
             const mbh = val * mh;
             mctx.fillRect(i * mbw, mh - mbh, mbw - 0.5, mbh);
          }
        };
        
        try {
            drawMiniFFT(oscAWaveCanvas, 'rgba(111, 138, 170, 0.8)', synthState.oscA.on);
            drawMiniFFT(oscBWaveCanvas, 'rgba(52, 211, 153, 0.8)', synthState.oscB.on);
        } catch(e) {}

        drawFrame = requestAnimationFrame(draw);
      };
      
      draw();
    };

    onMounted(() => {
      window.addEventListener('mousemove', onGlobalMouseMove);
    });

    onUnmounted(() => { 
        window.removeEventListener('mousemove', onGlobalMouseMove);
        if (drawFrame) cancelAnimationFrame(drawFrame); 
    });

    const savePreset = () => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(synthState));
      const downloadAnchorNode = document.createElement('a');
      downloadAnchorNode.setAttribute("href", dataStr);
      downloadAnchorNode.setAttribute("download", presetName.value + ".json");
      document.body.appendChild(downloadAnchorNode);
      downloadAnchorNode.click();
      downloadAnchorNode.remove();
    };

    const triggerLoadPreset = () => { if (presetInput.value) presetInput.value.click(); };
    const onPresetFile = (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const state = JSON.parse(e.target.result);
          Object.assign(synthState, state);
          presetName.value = file.name.replace('.json', '');
        } catch (err) {
          alert('Invalid preset file format.');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    };

    const triggerLoadSample = (osc) => {
      if (osc === 'A' && sampleInputA.value) sampleInputA.value.click();
      if (osc === 'B' && sampleInputB.value) sampleInputB.value.click();
    };

    const onSampleFile = (event, osc) => {
      const file = event.target.files[0];
      if (!file) return;
      if (osc === 'A') sampleNameA.value = file.name;
      if (osc === 'B') sampleNameB.value = file.name;
      
      const url = URL.createObjectURL(file);
      new Tone.ToneAudioBuffer(url, (buffer) => {
          console.log(`Loaded ${file.name} into memory buffer.`);
      });
      event.target.value = '';
    };

    return {
      isAudioReady, isLoading, isRecording, initAudio, activeTab, synthState, oscTypes,
      keyboardKeys, activeNotes, onKeyMouseDown, onKeyMouseUp, onKeyMouseLeave, onKeyMouseEnter,
      metersCanvas, oscAWaveCanvas, oscBWaveCanvas,
      presetName, presetInput, sampleInputA, sampleInputB, sampleNameA, sampleNameB,
      savePreset, triggerLoadPreset, onPresetFile, triggerLoadSample, onSampleFile, toggleRecord
    };
  }
};

createApp(App).mount('#app');