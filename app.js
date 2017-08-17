let audioCtx = null;
let masterGain;
let isPlaying = false;

// Orientation values
let xValue = 0;
let yValue = 0;
let rotation = 0;

// Effect nodes (simplified)
let compressor = null;
let masterReverb = null;
let reverbWet = null;
let reverbDry = null;

// Chord oscillators and mixer
let chordOscillators = null;
let chordMixer = null;

// Loopers array
let loopers = [];

// Parameter smoothing class
class ParameterSmoother {
    constructor(initialValue, smoothingFactor = 0.1) {
        this.currentValue = initialValue;
        this.targetValue = initialValue;
        this.smoothingFactor = smoothingFactor;
    }

    setTarget(newValue) {
        this.targetValue = newValue;
    }

    step() {
        this.currentValue += (this.targetValue - this.currentValue) * this.smoothingFactor;
        return this.currentValue;
    }
}

// Discrete playback speed steps (including reverse)
const PLAYBACK_SPEEDS = [-4, -2, -1.5, -1, -0.5, -0.25, 0.25, 0.5, 1, 1.5, 2, 4];

// Map normalized value (0-1) to discrete playback speed
function mapToSpeed(normalizedValue) {
    const index = Math.floor(normalizedValue * PLAYBACK_SPEEDS.length);
    return PLAYBACK_SPEEDS[Math.min(index, PLAYBACK_SPEEDS.length - 1)];
}

// Create smoothers for each looper parameter
let parameterSmoothers = {};

const startButton = document.getElementById("startButton");
const reverbSlider = document.getElementById("reverbSlider");
const reverbValueDisplay = document.getElementById("reverbValue");

// Allow localhost and local network IPs to use HTTP for development
const isLocal = location.hostname === "localhost" ||
                location.hostname === "127.0.0.1" ||
                location.hostname.startsWith("192.168.") ||
                location.hostname.startsWith("10.") ||
                location.hostname.startsWith("172.");

if (location.protocol != "https:" && !isLocal) {
  location.href = "https:" + window.location.href.substring(window.location.protocol.length);
}

// Gm7 chord frequencies
const GM7_CHORD = {
    G: 196,      // Root
    Bb: 233.08,  // Minor 3rd
    D: 293.66,   // Perfect 5th
    F: 349.23    // Minor 7th
};

// Create a single oscillator with LFO volume modulation
function createOscillatorWithLFO(frequency, lfoRate, lfoDepth) {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequency;

    const oscGain = audioCtx.createGain();
    oscGain.gain.value = 0.5; // Base volume (higher to ensure it's audible)

    // LFO setup for amplitude modulation
    const lfo = audioCtx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = lfoRate;

    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = lfoDepth * 0.3; // Reduced modulation depth to stay positive

    // Connect LFO to control oscillator gain (audio-rate modulation)
    // LFO outputs -1 to +1, multiplied by lfoGain, added to oscGain.gain
    // With oscGain=0.5 and lfoDepth*0.3 (max 0.18), range is 0.32 to 0.68
    lfo.connect(lfoGain);
    lfoGain.connect(oscGain.gain);

    osc.connect(oscGain);

    osc.start();
    lfo.start();

    console.log(`Oscillator ${frequency}Hz: base gain=0.5, LFO depth=${lfoDepth * 0.3}`);

    return { osc, oscGain, lfo, lfoGain };
}

// Create all 4 Gm7 chord oscillators with independent LFO swells
function createChordOscillators() {
    const chordMixer = audioCtx.createGain();
    chordMixer.gain.value = 1.0;

    const oscillators = [];
    const notes = [
        { name: 'G', freq: GM7_CHORD.G, lfoRate: 0.11, lfoDepth: 0.4 },
        { name: 'Bb', freq: GM7_CHORD.Bb, lfoRate: 0.17, lfoDepth: 0.5 },
        { name: 'D', freq: GM7_CHORD.D, lfoRate: 0.13, lfoDepth: 0.6 },
        { name: 'F', freq: GM7_CHORD.F, lfoRate: 0.19, lfoDepth: 0.45 }
    ];

    notes.forEach(note => {
        const oscObj = createOscillatorWithLFO(note.freq, note.lfoRate, note.lfoDepth);
        oscObj.oscGain.connect(chordMixer);
        oscillators.push(oscObj);
        console.log(`Created ${note.name} oscillator at ${note.freq}Hz with LFO rate ${note.lfoRate}Hz`);
    });

    return { oscillators, chordMixer };
}

// Looper implementation
function createLooper(index, sourceNode) {
    const looper = {
        index: index,
        // Recording
        scriptProcessor: null,
        recordBuffer: null,
        recordBufferData: null,
        writePosition: 0,
        recordedLength: 0,
        // Playback
        bufferSource: null,
        playbackGain: null,
        isRecording: false,
        isPlaying: false,
        // Glitch parameters
        glitchIntensity: 0,
        playbackRate: 1,
        targetPlaybackRate: 1, // Discrete speed target
        stutterRate: 0,
        feedbackAmount: 0
    };

    // Setup recording buffer (30 seconds max)
    const bufferLength = audioCtx.sampleRate * 30;
    looper.recordBuffer = audioCtx.createBuffer(1, bufferLength, audioCtx.sampleRate);
    looper.recordBufferData = looper.recordBuffer.getChannelData(0);

    // Setup ScriptProcessor for recording
    looper.scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    looper.scriptProcessor.onaudioprocess = (e) => {
        if (!looper.isRecording) return;
        const input = e.inputBuffer.getChannelData(0);
        const remaining = bufferLength - looper.writePosition;
        if (remaining <= 0) {
            stopRecording(index);
            return;
        }
        const copyLength = Math.min(input.length, remaining);
        for (let i = 0; i < copyLength; i++) {
            looper.recordBufferData[looper.writePosition++] = input[i];
        }
        looper.recordedLength = looper.writePosition;
    };

    // Connect for recording
    sourceNode.connect(looper.scriptProcessor);
    looper.scriptProcessor.connect(audioCtx.destination);

    // Setup playback gain
    looper.playbackGain = audioCtx.createGain();
    looper.playbackGain.gain.value = 1.0;

    return looper;
}

function startRecording(looperIndex) {
    const looper = loopers[looperIndex];
    if (looper.isPlaying) stopPlayback(looperIndex);

    looper.writePosition = 0;
    looper.recordedLength = 0;
    looper.isRecording = true;

    console.log(`Looper ${looperIndex} started recording`);

    // Update UI
    updateLooperUI(looperIndex, 'recording');
}

function stopRecording(looperIndex) {
    const looper = loopers[looperIndex];
    looper.isRecording = false;

    console.log(`Looper ${looperIndex} stopped recording (${looper.recordedLength} samples)`);

    // Update UI
    updateLooperUI(looperIndex, 'stopped');
}

function startPlayback(looperIndex) {
    const looper = loopers[looperIndex];
    if (looper.isRecording) stopRecording(looperIndex);
    if (looper.recordedLength === 0) {
        console.log(`Looper ${looperIndex} has no recorded content`);
        return;
    }

    // Create buffer source from recorded data
    looper.bufferSource = audioCtx.createBufferSource();

    // Create new buffer with exact recorded length
    const playBuffer = audioCtx.createBuffer(
        1,
        looper.recordedLength,
        audioCtx.sampleRate
    );
    const playData = playBuffer.getChannelData(0);
    for (let i = 0; i < looper.recordedLength; i++) {
        playData[i] = looper.recordBufferData[i];
    }

    looper.bufferSource.buffer = playBuffer;
    looper.bufferSource.loop = true;
    looper.bufferSource.playbackRate.value = looper.targetPlaybackRate;

    looper.bufferSource.connect(looper.playbackGain);
    looper.playbackGain.connect(compressor);

    looper.bufferSource.start();
    looper.isPlaying = true;

    console.log(`Looper ${looperIndex} started playback`);

    // Update UI
    updateLooperUI(looperIndex, 'playing');
}

function stopPlayback(looperIndex) {
    const looper = loopers[looperIndex];
    if (!looper.isPlaying) return;

    if (looper.bufferSource) {
        looper.bufferSource.stop();
        looper.bufferSource.disconnect();
        looper.bufferSource = null;
    }

    looper.isPlaying = false;

    console.log(`Looper ${looperIndex} stopped playback`);

    // Update UI
    updateLooperUI(looperIndex, 'stopped');
}

function clearLoop(looperIndex) {
    stopPlayback(looperIndex);
    stopRecording(looperIndex);

    const looper = loopers[looperIndex];
    looper.writePosition = 0;
    looper.recordedLength = 0;

    console.log(`Looper ${looperIndex} cleared`);

    // Update UI
    updateLooperUI(looperIndex, 'cleared');
}

// Parameter update loop
function updateLooperParameters() {
    loopers.forEach((looper, index) => {
        const smoothers = parameterSmoothers[`looper${index}`];

        // Glitch intensity is smooth
        const glitchIntensity = smoothers.glitchIntensity.step();

        // Playback rate snaps to discrete values
        const playbackRate = looper.targetPlaybackRate || 1;
        const stutterRate = smoothers.stutterRate.step();

        // Apply to looper
        looper.glitchIntensity = glitchIntensity;
        looper.playbackRate = playbackRate;
        looper.stutterRate = stutterRate;

        if (looper.bufferSource && looper.isPlaying) {
            looper.bufferSource.playbackRate.value = playbackRate;
        }

        // Update UI display
        updateLooperParameterDisplay(index, { glitchIntensity, playbackRate, stutterRate });
    });

    requestAnimationFrame(updateLooperParameters);
}

// UI update functions
function updateLooperUI(looperIndex, state) {
    const statusEl = document.getElementById(`status-${looperIndex}`);
    const panel = document.getElementById(`looper-panel-${looperIndex}`);

    if (!statusEl || !panel) return;

    // Remove all state classes
    panel.querySelectorAll('.looper-btn').forEach(btn => btn.classList.remove('active'));
    statusEl.classList.remove('recording', 'playing');

    switch(state) {
        case 'recording':
            statusEl.textContent = 'RECORDING';
            statusEl.classList.add('recording');
            panel.querySelector('.rec-btn').classList.add('active');
            break;
        case 'playing':
            statusEl.textContent = 'PLAYING';
            statusEl.classList.add('playing');
            panel.querySelector('.play-btn').classList.add('active');
            break;
        case 'stopped':
            statusEl.textContent = 'STOPPED';
            break;
        case 'cleared':
            statusEl.textContent = 'READY';
            break;
    }
}

function updateLooperParameterDisplay(looperIndex, params) {
    const glitchEl = document.getElementById(`glitch-${looperIndex}`);
    const speedEl = document.getElementById(`speed-${looperIndex}`);

    if (glitchEl && params.glitchIntensity !== undefined) {
        glitchEl.textContent = Math.round(params.glitchIntensity * 100) + '%';
    }

    if (speedEl && params.playbackRate !== undefined) {
        const rate = params.playbackRate;
        if (rate < 0) {
            speedEl.textContent = 'REV ' + Math.abs(rate) + 'x';
        } else {
            speedEl.textContent = rate + 'x';
        }
    }
}

// Initialize looper control event listeners
function initLooperControls() {
    // Record buttons
    document.querySelectorAll('.rec-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.looper);
            console.log(`Record button clicked for looper ${index}`);
            if (loopers && loopers[index]) {
                startRecording(index);
            }
        });
    });

    // Play buttons
    document.querySelectorAll('.play-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.looper);
            console.log(`Play button clicked for looper ${index}`);
            if (loopers && loopers[index]) {
                startPlayback(index);
            }
        });
    });

    // Stop buttons
    document.querySelectorAll('.stop-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.looper);
            console.log(`Stop button clicked for looper ${index}`);
            if (loopers && loopers[index]) {
                if (loopers[index].isPlaying) {
                    stopPlayback(index);
                } else if (loopers[index].isRecording) {
                    stopRecording(index);
                }
            }
        });
    });

    // Clear buttons
    document.querySelectorAll('.clear-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.looper);
            console.log(`Clear button clicked for looper ${index}`);
            if (loopers && loopers[index]) {
                if (confirm('Clear this loop?')) {
                    clearLoop(index);
                }
            }
        });
    });

    console.log("Looper controls initialized - found", document.querySelectorAll('.looper-btn').length, "buttons");
}

function startOscillators() {
    console.log("Starting oscillators...");

    if (isPlaying) {
        console.log("Already playing!");
        return;
    }

    // Create audio context on user interaction
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        console.log("Created new AudioContext");
    }

    console.log("Audio context state:", audioCtx.state);

    // Resume audio context (required on iOS)
    audioCtx.resume().then(() => {
        console.log("Audio context resumed, state:", audioCtx.state);

        masterGain = audioCtx.createGain();
        masterGain.gain.value = 0.5; // Set master volume

        // Create compressor (used by all modes) - extreme settings
        compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -20;  // Lower threshold to compress more
        compressor.knee.value = 5;          // Hard knee for aggressive compression
        compressor.ratio.value = 20;        // Maximum ratio for extreme squashing
        compressor.attack.value = 0.7;    // Very fast attack
        compressor.release.value = 0.1;     // Shorter release for pumping effect

        // Create master reverb (used by all modes)
        masterReverb = audioCtx.createConvolver();
        const masterReverbLength = audioCtx.sampleRate * 3; // 3 second reverb
        const masterReverbBuffer = audioCtx.createBuffer(2, masterReverbLength, audioCtx.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const channelData = masterReverbBuffer.getChannelData(channel);
            for (let i = 0; i < masterReverbLength; i++) {
                channelData[i] = (Math.random() * 2 - 1) * (1 - i / masterReverbLength) ** 2;
            }
        }
        masterReverb.buffer = masterReverbBuffer;

        // Create wet/dry gains for reverb mix
        reverbWet = audioCtx.createGain();
        reverbWet.gain.value = 0; // Start at 0% wet
        reverbDry = audioCtx.createGain();
        reverbDry.gain.value = 1; // Start at 100% dry

        // Wire reverb wet/dry split
        masterGain.connect(reverbDry);
        masterGain.connect(masterReverb);
        masterReverb.connect(reverbWet);

        reverbDry.connect(compressor);
        reverbWet.connect(compressor);

        // Create Gm7 chord oscillators with LFO swells
        const chordSystem = createChordOscillators();
        chordOscillators = chordSystem.oscillators;
        chordMixer = chordSystem.chordMixer;

        // Connect chord mixer to master gain
        chordMixer.connect(masterGain);

        // Create 4 loopers connected to master gain
        loopers = [];
        for (let i = 0; i < 4; i++) {
            loopers.push(createLooper(i, masterGain));
            console.log(`Created looper ${i}`);
        }

        // Initialize parameter smoothers for each looper
        parameterSmoothers = {};
        for (let i = 0; i < 4; i++) {
            parameterSmoothers[`looper${i}`] = {
                glitchIntensity: new ParameterSmoother(0, 0.15),
                stutterRate: new ParameterSmoother(0, 0.2)
            };
        }

        // Final connection: compressor → destination
        compressor.connect(audioCtx.destination);

        isPlaying = true;

        console.log("Audio graph: chordMixer → masterGain → [reverb wet/dry + loopers] → compressor → destination");

        console.log("Gm7 chord oscillators started with LFO swells");

        // Start parameter update loop
        updateLooperParameters();

        // Initialize looper control buttons
        initLooperControls();

        // Update UI to show it's playing
        startButton.textContent = '♪ PLAYING ♪';
        startButton.style.background = '#00ff00';
        startButton.style.boxShadow = '0 0 30px #00ff00';

        console.log("✓ Audio system fully initialized and playing!");
    }).catch(err => {
        console.error("Failed to resume audio context:", err);
        alert("Audio error: " + err.message);
    });
}

function permission() {

    if (typeof (DeviceOrientationEvent) !== "undefined" && typeof (DeviceOrientationEvent.requestPermission) === "function") {
        console.log("Requesting iOS permission...");
        DeviceOrientationEvent.requestPermission()
            .then(response => {
                console.log("Permission response:", response);
                if (response === "granted") {
                  startOscillators()
                    window.addEventListener("deviceorientation", (event) => {
                        xValue = Math.round(event.gamma);
                        yValue = Math.round(event.beta);
                        rotation = Math.round(event.alpha);

                        document.getElementById("doTiltLR").innerHTML = Math.round(xValue);
                        document.getElementById("doTiltFB").innerHTML = Math.round(yValue);
                        document.getElementById("doDirection").innerHTML = Math.round(rotation);

                        // Normalize orientation values
                        const gamma = (event.gamma + 90) / 180; // -90 to 90 → 0 to 1
                        const beta = (event.beta + 180) / 360; // -180 to 180 → 0 to 1
                        const alpha = event.alpha / 360; // 0 to 360 → 0 to 1

                        // Map to looper parameters
                        // Looper 0: gamma → glitch, beta → playback
                        parameterSmoothers.looper0.glitchIntensity.setTarget(gamma);
                        loopers[0].targetPlaybackRate = mapToSpeed(beta);

                        // Looper 1: beta → glitch, alpha → playback
                        parameterSmoothers.looper1.glitchIntensity.setTarget(beta);
                        loopers[1].targetPlaybackRate = mapToSpeed(alpha);

                        // Looper 2: alpha → glitch, gamma → playback
                        parameterSmoothers.looper2.glitchIntensity.setTarget(alpha);
                        loopers[2].targetPlaybackRate = mapToSpeed(gamma);

                        // Looper 3: mix of all three
                        parameterSmoothers.looper3.glitchIntensity.setTarget((gamma + beta) / 2);
                        loopers[3].targetPlaybackRate = mapToSpeed(alpha);
                    }, true);
                }
            })
            .catch(err => {
                console.error("Permission error:", err);
                alert("Permission denied or error: " + err);
            });
    } else {
        // For non-iOS devices, start oscillators and add listener directly
        console.log("Non-iOS device detected, starting directly");
        startOscillators()
        window.addEventListener("deviceorientation", (event) => {
            xValue = Math.round(event.gamma);
            yValue = Math.round(event.beta);
            rotation = Math.round(event.alpha);

            document.getElementById("doTiltLR").innerHTML = Math.round(xValue);
            document.getElementById("doTiltFB").innerHTML = Math.round(yValue);
            document.getElementById("doDirection").innerHTML = Math.round(rotation);

            // Normalize orientation values
            const gamma = (event.gamma + 90) / 180; // -90 to 90 → 0 to 1
            const beta = (event.beta + 180) / 360; // -180 to 180 → 0 to 1
            const alpha = event.alpha / 360; // 0 to 360 → 0 to 1

            // Map to looper parameters
            // Looper 0: gamma → glitch, beta → playback
            parameterSmoothers.looper0.glitchIntensity.setTarget(gamma);
            loopers[0].targetPlaybackRate = mapToSpeed(beta);

            // Looper 1: beta → glitch, alpha → playback
            parameterSmoothers.looper1.glitchIntensity.setTarget(beta);
            loopers[1].targetPlaybackRate = mapToSpeed(alpha);

            // Looper 2: alpha → glitch, gamma → playback
            parameterSmoothers.looper2.glitchIntensity.setTarget(alpha);
            loopers[2].targetPlaybackRate = mapToSpeed(gamma);

            // Looper 3: mix of all three
            parameterSmoothers.looper3.glitchIntensity.setTarget((gamma + beta) / 2);
            loopers[3].targetPlaybackRate = mapToSpeed(alpha);
        }, true);
    }
}

startButton.addEventListener('click', () => {
    console.log("START BUTTON CLICKED!");
    startButton.textContent = "LOADING...";
    startButton.disabled = true;
    permission();
});

reverbSlider.addEventListener('input', function() {
    const reverbAmount = parseInt(this.value);
    reverbValueDisplay.textContent = reverbAmount + "%";

    if (reverbWet && reverbDry) {
        // Convert percentage to 0-1 range
        const wetGain = reverbAmount / 100;
        const dryGain = 1 - wetGain;

        reverbWet.gain.value = wetGain;
        reverbDry.gain.value = dryGain;
        console.log("Reverb updated to:", reverbAmount + "% (wet:", wetGain, "dry:", dryGain + ")");
    }
});

// Mode system removed - using simple fixed audio graph
