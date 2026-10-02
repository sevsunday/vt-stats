/* Weapon-effect audio. One-shot and looping clips from data/audio/.
 * SoundPerShot 0 loops the fire sound (machine guns); anything else plays
 * one instance per shot. Charge weapons ramp playbackRate while held.
 *
 * Clips played with a world position (`at`) go through a PannerNode so the
 * listener (the active camera, see setListener) hears a muzzle report up
 * close and the impact explosion far away. The ODFs carry no per-sound range,
 * so the rolloff is the AUDIO_* tunables below; clips played without a
 * position (lock tones, HUD cues) stay 2D like cockpit sounds.
 *
 * Every clip, positioned or 2D, ends in one master GainNode so the page's
 * volume slider (setVolume) scales sounds already playing as well as new ones.
 */
const AUDIO_BASE = '../data/audio/';
const AUDIO_GAIN = 0.6;            // base gain for every clip
const AUDIO_REF_DISTANCE = 15;     // metres at which a positioned clip plays at full gain
const AUDIO_ROLLOFF = 1.0;         // inverse-distance rolloff factor
const AUDIO_MAX_DISTANCE = 2000;

export function createAudio(opts) {
    const urls = (opts && opts.urls) || {};
    let ctx = null;
    let master = null;
    let volume = 1;
    const buffers = new Map();
    const raw = new Map();
    const loops = new Map();
    const listener = { pos: [0, 0, 0], fwd: [0, 0, -1], up: [0, 1, 0], dirty: true };

    function context() {
        if (!ctx) {
            ctx = new AudioContext();
            master = ctx.createGain();
            master.gain.value = volume;
            master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }

    /* Master volume, 0..1. 1 is the tuned AUDIO_GAIN loudness. */
    function setVolume(v) {
        const n = Number(v);
        volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
        if (master) master.gain.value = volume;
    }

    function getVolume() { return volume; }

    function stemKey(name) {
        return String(name || '').toLowerCase().replace(/\.wav$/, '');
    }

    /* Fetch only. Decoding waits until an AudioContext is running, which
     * the browser allows after a gesture. */
    function fetchBytes(key) {
        if (!key) return Promise.resolve(null);
        if (raw.has(key)) return raw.get(key);
        const pending = fetch(urls[key] || (AUDIO_BASE + key + '.wav'))
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null);
        raw.set(key, pending);
        return pending;
    }

    function decodeNow(key) {
        if (!key) return Promise.resolve(null);
        if (buffers.has(key)) return buffers.get(key);
        const pending = fetchBytes(key).then((buf) => {
            if (!buf) return null;
            return context().decodeAudioData(buf.slice(0));
        }).catch(() => null);
        buffers.set(key, pending);
        return pending;
    }

    function preload(names) {
        const keys = [];
        const push = (name) => {
            const key = stemKey(name);
            if (key) keys.push(key);
        };
        if (names && typeof names.forEach === 'function') names.forEach(push);
        keys.forEach(fetchBytes);
        if (ctx && ctx.state === 'running') return Promise.all(keys.map(decodeNow));
        return Promise.resolve();
    }

    function load(name) {
        const key = stemKey(name);
        if (!key) return Promise.resolve(null);
        if (buffers.has(key)) return buffers.get(key);
        return decodeNow(key);
    }

    function unlock() {
        const audio = context();
        raw.forEach((_, key) => { if (!buffers.has(key)) decodeNow(key); });
        return audio;
    }

    function applyListener() {
        if (!ctx || !listener.dirty) return;
        const l = ctx.listener;
        const p = listener.pos;
        const f = listener.fwd;
        const u = listener.up;
        if (l.positionX) {
            l.positionX.value = p[0]; l.positionY.value = p[1]; l.positionZ.value = p[2];
            l.forwardX.value = f[0]; l.forwardY.value = f[1]; l.forwardZ.value = f[2];
            l.upX.value = u[0]; l.upY.value = u[1]; l.upZ.value = u[2];
        } else {
            if (l.setPosition) l.setPosition(p[0], p[1], p[2]);
            if (l.setOrientation) l.setOrientation(f[0], f[1], f[2], u[0], u[1], u[2]);
        }
        listener.dirty = false;
    }

    /* Listener = the active camera. Call once per frame after the camera moves.
     * Forward is read straight off matrixWorld (a camera looks down its local
     * -Z) so this module needs no three.js import. */
    function setListener(camera) {
        if (!camera || !camera.matrixWorld) return;
        camera.updateMatrixWorld();
        const e = camera.matrixWorld.elements;
        const fx = -e[8];
        const fy = -e[9];
        const fz = -e[10];
        const fl = Math.hypot(fx, fy, fz) || 1;
        const up = camera.up || { x: 0, y: 1, z: 0 };
        listener.pos = [e[12], e[13], e[14]];
        listener.fwd = [fx / fl, fy / fl, fz / fl];
        listener.up = [up.x, up.y, up.z];
        listener.dirty = true;
        if (ctx) applyListener();
    }

    function placePanner(panner, at) {
        if (!panner || !at) return;
        if (panner.positionX) {
            panner.positionX.value = at.x;
            panner.positionY.value = at.y;
            panner.positionZ.value = at.z;
        } else if (panner.setPosition) panner.setPosition(at.x, at.y, at.z);
    }

    function play(name, opts) {
        const key = stemKey(name);
        if (!key) return { stop() {}, setPosition() {} };
        const loop = !!(opts && opts.loop);
        // A looping clip normally replaces an earlier loop of the same stem
        // (one machine gun, one loop). `multi` keeps independent loops per
        // caller: two ships idling on the same engine wav.
        const multi = !!(opts && opts.multi);
        const rate = opts && opts.rate ? opts.rate : 1;
        const at = opts && opts.at ? { x: opts.at.x, y: opts.at.y, z: opts.at.z } : null;
        const handle = {
            source: null,
            panner: null,
            rate,
            volume: opts && opts.volume != null ? opts.volume : 1,
            at,
            stop() { stopKey(loop && !multi ? key : null, this); },
            setPosition(v) {
                if (!v) return;
                this.at = { x: v.x, y: v.y, z: v.z };
                placePanner(this.panner, this.at);
            },
        };
        load(key).then((buffer) => {
            if (!buffer || handle.stopped) return;
            const audio = context();
            applyListener();
            const source = audio.createBufferSource();
            source.buffer = buffer;
            source.loop = loop;
            source.playbackRate.value = handle.rate;
            const gain = audio.createGain();
            gain.gain.value = (opts && opts.gain != null ? opts.gain : AUDIO_GAIN) * handle.volume;
            source.connect(gain);
            if (handle.at) {
                const panner = audio.createPanner();
                panner.panningModel = 'equalpower';
                panner.distanceModel = 'inverse';
                panner.refDistance = AUDIO_REF_DISTANCE;
                panner.rolloffFactor = AUDIO_ROLLOFF;
                panner.maxDistance = AUDIO_MAX_DISTANCE;
                placePanner(panner, handle.at);
                gain.connect(panner);
                panner.connect(master);
                handle.panner = panner;
            } else {
                gain.connect(master);
            }
            source.start();
            handle.source = source;
            handle.gain = gain;
            if (loop && !multi) {
                stopKey(key, loops.get(key));
                loops.set(key, handle);
            }
        });
        return handle;
    }

    function stopKey(key, handle) {
        if (!handle) return;
        handle.stopped = true;
        try { if (handle.source) handle.source.stop(); } catch (err) { /* already ended */ }
        if (key && loops.get(key) === handle) loops.delete(key);
    }

    function stopLoop(name) {
        const key = stemKey(name);
        stopKey(key, loops.get(key));
    }

    function setRate(handle, rate) {
        if (!handle) return;
        handle.rate = rate;
        if (handle.source) handle.source.playbackRate.value = rate;
    }

    function setGain(handle, volume) {
        if (!handle) return;
        handle.volume = volume;
        if (handle.gain) handle.gain.gain.value = AUDIO_GAIN * volume;
    }

    return { unlock: context, play, stopLoop, setRate, setGain, load, preload, setListener, setVolume, getVolume };
}

export { AUDIO_GAIN, AUDIO_REF_DISTANCE, AUDIO_ROLLOFF, AUDIO_MAX_DISTANCE };
