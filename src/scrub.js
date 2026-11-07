// Pure waveform gesture geometry and a bounded, latest-target native seek queue. No audio clock.
export const SCRUB_SLOP_PX=3;
export const SEEK_INTERVAL_MS=90;
export const INPUT_SEEK_LEAD_MS=40;
const scrubClamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function scrubGeometry(zoom,duration,width,scroll=false){
  const scale=Math.max(1,Math.min(32,Number.isFinite(zoom)?zoom:1));
  const total=Number.isFinite(duration)&&duration>0?duration:1;
  const window=total/scale;
  return {fit:scale===1&&!scroll,window,spp:window/Math.max(1,Number.isFinite(width)?width:1)};
}
export function scrollTarget(start,delta,spp,duration){return scrubClamp(start-delta*spp,0,duration);}
export function fitTarget(clientX,left,width,duration){return scrubClamp((clientX-left)/Math.max(1,width),0,1)*duration;}

const scrubClock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
/**
 * Latest-target-wins seek queue with one request in flight.
 * - `move(p)` records an interim target; it is sent at most once per `interval` and never while a request is open.
 * - `finish(p)` records the final target, bypasses the interval, and resolves true only when that exact request
 *   was acknowledged (false when superseded, cancelled or failed).
 * It is a rate limiter, not a clock: positions displayed afterwards come from native receipts.
 */
export class SeekPump {
  constructor({ send, current = () => true, onError = () => {}, interval = SEEK_INTERVAL_MS, lead = 0, clock = scrubClock }) {
    Object.assign(this, { send, current, onError, interval, lead, clock });
    this.queued = null;
    this.queuedAt = 0;
    this.inFlight = false;
    this.sending = null;
    this.lastStart = -Infinity;
    this.lastSent = null;
    this.lastOk = false;
    this.final = false;
    this.dead = false;
    this.timer = null;
    this.complete = null;
  }
  move(position) {
    if (this.dead || this.final || !Number.isFinite(position)) return;
    if (this.queued === null) this.queuedAt = this.clock.now();
    this.queued = position;
    this.drive();
  }
  finish(position) {
    if (this.dead || !Number.isFinite(position)) return Promise.resolve(false);
    if (this.final) return this.completion;
    this.final = true;
    this.completion = new Promise((resolve) => {
      this.complete = resolve;
    });
    if (this.inFlight && this.sending === position) this.queued = null;
    else if (!this.inFlight && this.lastOk && this.lastSent === position) {
      this.queued = null;
      this.settle(true);
      return this.completion;
    } else this.queued = position;
    this.drive();
    return this.completion;
  }
  cancel() {
    if (this.dead) return;
    this.dead = true;
    this.queued = null;
    this.stopTimer();
    this.settle(false);
  }
  stopTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
  settle(ok) {
    const complete = this.complete;
    this.complete = null;
    if (complete) complete(ok);
  }
  drive() {
    if (this.dead || this.inFlight || this.queued === null) return;
    const now = this.clock.now();
    const earliest = this.final ? now : Math.max(this.lastStart + this.interval, this.queuedAt + this.lead);
    const wait = earliest - now;
    if (wait > 0.5) {
      if (this.timer === null)
        this.timer = this.clock.setTimeout(() => {
          this.timer = null;
          this.drive();
        }, Math.ceil(wait));
      return;
    }
    this.stopTimer();
    if (!this.current()) {
      this.cancel();
      return;
    }
    const position = this.queued;
    this.queued = null;
    this.inFlight = true;
    this.sending = position;
    this.lastStart = now;
    let request;
    try {
      request = Promise.resolve(this.send(position));
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      () => {
        this.inFlight = false;
        this.lastSent = position;
        this.lastOk = true;
        if (this.dead) return;
        if (this.queued !== null) this.drive();
        else if (this.final) this.settle(true);
      },
      (error) => {
        this.inFlight = false;
        this.lastOk = false;
        const wasDead = this.dead;
        this.dead = true;
        this.queued = null;
        this.stopTimer();
        if (!wasDead) this.onError(error);
        this.settle(false);
      },
    );
  }
}
