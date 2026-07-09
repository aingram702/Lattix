// Lattix — message notification tones (generated with WebAudio, no assets).

let _enabled = localStorage.getItem("lattix.sounds") !== "0";
let _ctx = null;

function tone(freq, duration, type = "sine", gain = 0.06) {
  if (!_enabled) return;
  try {
    _ctx = _ctx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = _ctx.createOscillator();
    const amp = _ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(amp);
    amp.connect(_ctx.destination);
    const now = _ctx.currentTime;
    amp.gain.setValueAtTime(gain, now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.start(now);
    osc.stop(now + duration);
  } catch (_) {
    /* audio not available */
  }
}

// A short rising blip for outgoing, a softer two-note chime for incoming.
export function playSent() {
  tone(620, 0.12, "sine");
}
export function playReceived() {
  tone(880, 0.14, "triangle");
  setTimeout(() => tone(1170, 0.12, "triangle"), 90);
}

export function soundsEnabled() {
  return _enabled;
}
export function setSounds(on) {
  _enabled = !!on;
  localStorage.setItem("lattix.sounds", on ? "1" : "0");
}
