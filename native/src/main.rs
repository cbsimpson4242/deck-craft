use deck_craft_audio::snapshot_interval;
use deck_craft_audio::{
    Command, Identity, Request, Waveform, analyze_waveform, base64, checked_file, deck_index, decode, detail_bin_count, read_frame,
    dsp::{DeckControls, Knob, Strip},
    stream::{Prepared, StreamState, prepare_tempo},
    validate,
};
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
struct Candidate {
    request_id: String,
    deck: usize,
    generation: u64,
    track_id: String,
    path: String,
    identity: Identity,
    prepared: Prepared,
    resume: bool,
    analyze: bool,
    rate: f64,
    pitch_lock: bool,
    sync_master: Option<(usize, u64, f64)>,
}
enum Message {
    Request(Request),
    Invalid(String),
    End,
    Candidate(Result<Candidate, (String, usize, &'static str)>),
    Analysis {
        deck: usize,
        generation: u64,
        track_id: String,
        metadata: Value,
    },
    Wave {
        deck: usize,
        generation: u64,
        track_id: String,
        waveform: Waveform,
    },
}
struct AudioDeck {
    player: Player,
    track_id: Option<String>,
    duration: f64,
    channels: u16,
    sample_rate: u32,
    level: f64,
    /// Gain/EQ/filter knobs and the fader gain. Owned by the deck, not by a loaded source, so
    /// settings survive load, seek and natural-end restart.
    controls: Arc<DeckControls>,
    side: deck_craft_audio::fullkill::Side,
    path: String,
    identity: Option<Identity>,
    generation: u64,
    ended: bool,
    stream: Option<Arc<StreamState>>,
    rate: f64,
    pitch_lock: bool,
    beat_grid: Option<deck_craft_audio::analysis::BeatGrid>,
    synced: bool,
}
/// Channel fader gain: 0.25 headroom times the 0..=100 level. The previous implementation
/// applied this as the Rodio player volume; it now lives in the strip so it is smoothed with
/// the other channel controls.
const MASTER_HEADROOM: f64 = 0.25;
struct Engine {
    output: Option<MixerDeviceSink>,
    failed: Arc<AtomicBool>,
    decks: Vec<AudioDeck>,
    crossfader: f64,
    tokens: Vec<Arc<AtomicU64>>,
    wave_tokens: Vec<Arc<AtomicU64>>,
    loading: [bool; 4],
    resources: Vec<Arc<StreamState>>,
    engine_id: String,
    sequence: u64,
    master: Option<usize>,
    sync_pending: [Option<(usize, u64, f64)>; 4],
}
impl AudioDeck {
    /// A paused or ended source is not polled by the device, so its smoothing cannot advance;
    /// ask it to adopt the new targets at once so resuming has no audible glide.
    fn sync_paused_controls(&self) {
        if self.track_id.is_none() || self.ended || self.player.is_paused() {
            self.controls.request_snap();
        }
    }
}
impl Engine {
    fn ready(&self) -> bool {
        self.output.is_some() && !self.failed.load(Ordering::Relaxed)
    }
    fn snapshot(&mut self) -> Value {
        let ready = self.ready();
        let loading = self.loading;
        let wave_tokens = &self.wave_tokens;
        let decks:Vec<Value>=self.decks.iter_mut().enumerate().map(|(i,d)|{
   let failed=d.stream.as_ref().is_some_and(|s|s.failed.load(Ordering::Acquire));if !ready||failed{d.player.pause();}
   if d.track_id.is_some()&&d.player.empty(){d.ended=true;}
   let position=d.stream.as_ref().map(|s|s.position_frames.load(Ordering::Relaxed)as f64/d.sample_rate as f64).unwrap_or(0.0).clamp(0.0,d.duration);
   let underruns=d.stream.as_ref().map(|s|s.underrun_samples.load(Ordering::Relaxed)).unwrap_or(0);
   let playing=ready&&!failed&&d.track_id.is_some()&&!d.player.is_paused()&&!d.ended;
   let meter=if playing {d.controls.meter()} else {(0.0,0.0)};
   json!({"id":(["A","B","C","D"][i]),"trackId":d.track_id,"duration":d.duration,"channels":d.channels,"sampleRate":d.sample_rate,"position":position,"playing":playing,"level":d.level,"assign":d.side.as_str(),"meter":{"l":meter.0,"r":meter.1},"gain":d.controls.get(Knob::Gain),"hi":d.controls.get(Knob::Hi),"mid":d.controls.get(Knob::Mid),"low":d.controls.get(Knob::Low),"filter":d.controls.get(Knob::Filter),"loadGeneration":d.generation,"waveGeneration":wave_tokens[i].load(Ordering::SeqCst),"loading":loading[i],"underrunSamples":underruns,"rate":d.rate,"pitchLock":d.pitch_lock,"synced":d.synced,"beatGrid":d.beat_grid,"error":if failed{Some("decoder_failed")}else{None}})
  }).collect();
        let output=self.output.as_ref().map(|o|json!({"sampleRate":o.config().sample_rate().get(),"channels":o.config().channel_count().get(),"backend":"ALSA default device"}));
        json!({"ready":ready,"output":output,"error":if ready{Value::Null}else{json!("audio_output_unavailable")},"decks":decks,"crossfader":self.crossfader,"master":self.master.map(|i|["A","B","C","D"][i]),"capabilities":{"channelEq":true,"channelMeters":true,"crossfaderAssign":true}})
    }
    /// Cadence for the next unsolicited snapshot, from the decks' current state.
    fn cadence(&self) -> Duration {
        let ready = self.ready();
        let playing = ready
            && self.decks.iter().any(|d| {
                d.track_id.is_some() && !d.ended && !d.player.is_paused() && !d.player.empty()
            });
        snapshot_interval(playing, self.loading.iter().any(|loading| *loading))
    }
    fn send(&mut self, kind: &str, mut payload: Value) {
        self.sequence += 1;
        payload["kind"] = json!(kind);
        payload["engineId"] = json!(self.engine_id);
        payload["seq"] = json!(self.sequence);
        let mut out = io::stdout().lock();
        let _ = serde_json::to_writer(&mut out, &payload);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
    fn reply(&mut self, id: &str, error: Option<&str>) {
        let snapshot = self.snapshot();
        self.send(
            "reply",
            json!({"id":id,"ok":error.is_none(),"error":error,"snapshot":snapshot}),
        );
    }
    fn levels(&self) {
        for d in &self.decks {
            d.controls.set_fader(d.level / 100.0);
            d.controls.set_output(deck_craft_audio::fullkill::side_gain(d.side,self.crossfader) as f64);
            d.sync_paused_controls();
        }
    }
    fn unsync_transport(&mut self, i: usize) {
        let master_moved = self.master == Some(i);
        for (j, deck) in self.decks.iter_mut().enumerate() {
            if j == i || master_moved {
                deck.synced = false;
            }
        }
    }
    fn knob(&mut self, id: &str, deck: &str, knob: Knob, value: f64) {
        let i = deck_index(deck).unwrap();
        self.decks[i].controls.set(knob, value);
        self.decks[i].sync_paused_controls();
        self.reply(id, None);
    }
    fn cancel(&mut self, i: usize) {
        self.tokens[i].fetch_add(1, Ordering::SeqCst);
    }
    fn stage(
        &mut self,
        id: String,
        i: usize,
        track_id: String,
        path: String,
        identity: Identity,
        position: f64,
        resume: bool,
        analyze: bool,
        tx: &mpsc::Sender<Message>,
    ) {
        let sync_master = self.sync_pending[i].take();
        if !self.ready() {
            self.reply(&id, Some("audio_output_unavailable"));
            return;
        }
        if self.loading[i] {
            self.reply(&id, Some("deck_loading"));
            return;
        }
        self.loading[i] = true;
        let generation = self.tokens[i].fetch_add(1, Ordering::SeqCst) + 1;
        let tx = tx.clone();
        let rate = self.decks[i].rate;
        let pitch_lock = self.decks[i].pitch_lock;
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                prepare_tempo(&path, &identity, position, rate, pitch_lock)
            }))
            .unwrap_or(Err("decoder_failed"));
            let result = result
                .map(|prepared| Candidate {
                    request_id: id.clone(),
                    deck: i,
                    generation,
                    track_id,
                    path,
                    identity,
                    prepared,
                    resume,
                    analyze,
                    rate,
                    pitch_lock,
                    sync_master,
                })
                .map_err(|e| (id, i, e));
            let _ = tx.send(Message::Candidate(result));
        });
    }
    fn apply(&mut self, request: Request, tx: &mpsc::Sender<Message>) -> bool {
        let id = request.id.clone();
        if !valid_id(&id) {
            self.reply("invalid", Some("invalid_request_id"));
            return true;
        }
        if let Err(error) = validate(&request.command) {
            self.reply(&id, Some(error));
            return true;
        }
        match request.command {
            Command::Status => self.reply(&id, None),
            Command::Shutdown => {
                for d in &self.decks {
                    d.player.pause();
                }
                self.reply(&id, None);
                return false;
            }
            Command::Load {
                deck,
                track_id,
                path,
                identity,
            } => {
                let i = deck_index(&deck).unwrap();
                self.unsync_transport(i);
                self.stage(id, i, track_id, path, identity, 0.0, false, true, tx);
            }
            Command::Pause { deck } => {
                let i = deck_index(&deck).unwrap();
                self.cancel(i);
                self.unsync_transport(i);
                self.decks[i].player.pause();
                self.decks[i].controls.reset_meter();
                self.reply(&id, None);
            }
            Command::Play { deck } => {
                let i = deck_index(&deck).unwrap();
                if !self.ready() {
                    self.reply(&id, Some("audio_output_unavailable"));
                } else if self.decks[i].track_id.is_none() {
                    self.reply(&id, Some("deck_unloaded"));
                } else if self.loading[i] {
                    self.reply(&id, Some("deck_loading"));
                } else if self.decks[i].ended {
                    let d = &self.decks[i];
                    let args = (
                        d.track_id.clone().unwrap(),
                        d.path.clone(),
                        d.identity.clone().unwrap(),
                    );
                    self.unsync_transport(i);
                    self.stage(id, i, args.0, args.1, args.2, 0.0, true, false, tx);
                } else {
                    if self.decks[i].player.is_paused() {
                        self.unsync_transport(i);
                    }
                    self.decks[i].player.play();
                    self.reply(&id, None);
                }
            }
            Command::Seek { deck, position } => {
                let i = deck_index(&deck).unwrap();
                let d = &self.decks[i];
                if d.track_id.is_none() {
                    self.reply(&id, Some("deck_unloaded"));
                } else if position > d.duration {
                    self.reply(&id, Some("invalid_position"));
                } else if self.loading[i] {
                    self.reply(&id, Some("deck_loading"));
                } else {
                    let resume = !d.player.is_paused() && !d.ended;
                    let args = (
                        d.track_id.clone().unwrap(),
                        d.path.clone(),
                        d.identity.clone().unwrap(),
                    );
                    self.unsync_transport(i);
                    self.decks[i].player.pause();
                    self.decks[i].controls.reset_meter();
                    self.stage(id, i, args.0, args.1, args.2, position, resume, false, tx);
                }
            }
            Command::Tempo {
                deck,
                rate,
                pitch_lock,
            } => {
                let i = deck_index(&deck).unwrap();
                if self.loading[i] {
                    self.reply(&id, Some("deck_loading"));
                    return true;
                }
                // Validate followers transactionally before changing the master.
                let mut updates = vec![(i, rate)];
                if self.master == Some(i) {
                    if let Some(g) = &self.decks[i].beat_grid {
                        for j in 0..4 {
                            if j != i && self.decks[j].synced {
                                if let Some(t) = &self.decks[j].beat_grid {
                                    let r = g.bpm * rate / t.bpm;
                                    if !(0.92..=1.08).contains(&r) {
                                        self.reply(&id, Some("sync_tempo_out_of_range"));
                                        return true;
                                    }
                                    updates.push((j, r));
                                }
                            }
                        }
                    }
                }
                for (j, r) in updates {
                    self.decks[j].rate = r;
                    if j == i {
                        self.decks[j].pitch_lock = pitch_lock;
                        self.decks[j].synced = false;
                    }
                    if let Some(st) = &self.decks[j].stream {
                        st.rate_bits.store(r.to_bits(), Ordering::Release);
                        if j == i {
                            st.pitch_lock.store(pitch_lock, Ordering::Release);
                        }
                    }
                }
                self.reply(&id, None);
            }
            Command::Master { deck } => {
                let i = deck_index(&deck).unwrap();
                self.master = Some(i);
                for d in &mut self.decks {
                    d.synced = false;
                }
                self.reply(&id, None);
            }
            Command::Sync { deck } => {
                let i = deck_index(&deck).unwrap();
                let Some(m) = self.master else {
                    self.reply(&id, Some("sync_master_required"));
                    return true;
                };
                if m == i {
                    self.reply(&id, Some("sync_same_deck"));
                    return true;
                }
                let d = &self.decks[i];
                let master = &self.decks[m];
                let (Some(grid), Some(mg)) = (&d.beat_grid, &master.beat_grid) else {
                    self.reply(&id, Some("beat_grid_unavailable"));
                    return true;
                };
                if d.track_id.is_none()
                    || master.track_id.is_none()
                    || self.loading[i]
                    || self.loading[m]
                {
                    self.reply(&id, Some("deck_loading"));
                    return true;
                }
                let rate = mg.bpm * master.rate / grid.bpm;
                if !(0.92..=1.08).contains(&rate) {
                    self.reply(&id, Some("sync_tempo_out_of_range"));
                    return true;
                }
                let mp = master
                    .stream
                    .as_ref()
                    .map(|v| {
                        v.position_frames.load(Ordering::Relaxed) as f64 / master.sample_rate as f64
                    })
                    .unwrap_or(0.0);
                let dp = d
                    .stream
                    .as_ref()
                    .map(|v| {
                        v.position_frames.load(Ordering::Relaxed) as f64 / d.sample_rate as f64
                    })
                    .unwrap_or(0.0);
                let period = 60.0 / grid.bpm;
                let phase = ((mp - mg.offset) * mg.bpm / 60.0).rem_euclid(1.0);
                let mut position =
                    grid.offset + ((dp - grid.offset) / period).floor() * period + phase * period;
                if position < 0.0 {
                    position += period;
                }
                if position >= d.duration {
                    self.reply(&id, Some("invalid_position"));
                    return true;
                }
                let args = (
                    d.track_id.clone().unwrap(),
                    d.path.clone(),
                    d.identity.clone().unwrap(),
                    !d.player.is_paused() && !d.ended,
                );
                self.sync_pending[i] = Some((m, self.tokens[m].load(Ordering::SeqCst), mp));
                let previous_rate = self.decks[i].rate;
                self.decks[i].rate = rate;
                self.decks[i].player.pause();
                self.decks[i].controls.reset_meter();
                self.stage(id, i, args.0, args.1, args.2, position, args.3, false, tx);
                self.decks[i].rate = previous_rate;
            }
            Command::Level { deck, value } => {
                let i = deck_index(&deck).unwrap();
                self.decks[i].level = value;
                self.levels();
                self.reply(&id, None);
            }
            Command::Assign {deck,side} => {
                let i=deck_index(&deck).unwrap();
                self.decks[i].side=deck_craft_audio::fullkill::Side::parse(&side).unwrap();
                self.levels(); self.reply(&id,None);
            }
            Command::Crossfader { value } => {
                self.crossfader = value;
                self.levels();
                self.reply(&id, None);
            }
            Command::Gain { deck, value } => self.knob(&id, &deck, Knob::Gain, value),
            Command::Hi { deck, value } => self.knob(&id, &deck, Knob::Hi, value),
            Command::Mid { deck, value } => self.knob(&id, &deck, Knob::Mid, value),
            Command::Low { deck, value } => self.knob(&id, &deck, Knob::Low, value),
            Command::Filter { deck, value } => self.knob(&id, &deck, Knob::Filter, value),
        }
        true
    }
    fn candidate(
        &mut self,
        result: Result<Candidate, (String, usize, &'static str)>,
        tx: &mpsc::Sender<Message>,
    ) {
        let mut c = match result {
            Ok(c) => c,
            Err((id, i, error)) => {
                self.loading[i] = false;
                self.reply(&id, Some(error));
                return;
            }
        };
        self.loading[c.deck] = false;
        self.resources.push(c.prepared.state.clone());
        if self.tokens[c.deck].load(Ordering::SeqCst) != c.generation {
            self.reply(&c.request_id, Some("load_cancelled"));
            return;
        }
        if !self.ready() {
            self.reply(&c.request_id, Some("audio_output_unavailable"));
            return;
        }
        if let Some((m, generation, old_position)) = c.sync_master {
            if self.master != Some(m)
                || self.tokens[m].load(Ordering::SeqCst) != generation
                || self.loading[m]
            {
                self.reply(&c.request_id, Some("sync_master_changed"));
                return;
            }
            let master = &self.decks[m];
            if let (Some(mg), Some(grid)) = (&master.beat_grid, &self.decks[c.deck].beat_grid) {
                if (mg.bpm * master.rate / grid.bpm - c.rate).abs() > 1e-8 {
                    self.reply(&c.request_id, Some("sync_master_changed"));
                    return;
                }
            }
            let now = master
                .stream
                .as_ref()
                .map(|v| {
                    v.position_frames.load(Ordering::Relaxed) as f64 / master.sample_rate as f64
                })
                .unwrap_or(old_position);
            // The prepared queue already contains tempo-processed PCM. Discard only
            // the elapsed master media interval on the control thread at commit.
            let target = c.prepared.state.position_frames.load(Ordering::Relaxed) as f64
                / c.prepared.sample_rate as f64
                + (now - old_position) * c.rate / master.rate;
            if !c.prepared.source.advance_to(target) {
                self.reply(&c.request_id, Some("sync_preparation_too_slow"));
                return;
            }
        }
        let prior_grid = if c.analyze {
            None
        } else {
            self.decks[c.deck].beat_grid.clone()
        };
        let Prepared {
            source,
            state,
            duration,
            channels,
            sample_rate,
        } = c.prepared;
        let i = c.deck;
        let controls = self.decks[i].controls.clone();
        let replacement = Player::connect_new(self.output.as_ref().unwrap().mixer());
        replacement.pause();
        replacement.append(Strip::new(source, controls.clone()));
        let level = self.decks[i].level;
        self.decks[i] = AudioDeck {
            player: replacement,
            track_id: Some(c.track_id.clone()),
            duration,
            channels,
            sample_rate,
            level,
            side:self.decks[i].side,
            controls,
            path: c.path.clone(),
            identity: Some(c.identity.clone()),
            generation: c.generation,
            ended: false,
            stream: Some(state),
            rate: c.rate,
            pitch_lock: c.pitch_lock,
            beat_grid: prior_grid,
            synced: c.sync_master.is_some(),
        };
        self.levels();
        if c.resume {
            self.decks[i].player.play();
        }
        // Waveform ownership follows source loads, not the stream preparations used by seek/replay.
        // Publish that identity in the load reply before the asynchronous analysis can finish.
        if c.analyze {
            self.wave_tokens[i].store(c.generation, Ordering::SeqCst);
        }
        self.reply(&c.request_id, None);
        if !c.analyze {
            return;
        }
        let token = self.wave_tokens[i].clone();
        let tx = tx.clone();
        thread::spawn(move || {
            if let Ok(metadata) =
                deck_craft_audio::analysis::inspect_with_cancel(&c.path, &c.identity, || {
                    token.load(Ordering::SeqCst) != c.generation
                })
            {
                let _ = tx.send(Message::Analysis {
                    deck: i,
                    generation: c.generation,
                    track_id: c.track_id.clone(),
                    metadata,
                });
            }
            let Ok(decoder) = checked_file(&c.path, &c.identity).and_then(decode) else {
                return;
            };
            let count = (duration * sample_rate as f64 * channels as f64).max(1.0);
            let cancelled = || token.load(Ordering::SeqCst) != c.generation;
            let Some(waveform) = analyze_waveform(decoder, count, detail_bin_count(duration), cancelled) else {
                return;
            };
            let _ = tx.send(Message::Wave {
                deck: i,
                generation: c.generation,
                track_id: c.track_id,
                waveform,
            });
        });
    }
    fn retire(&mut self) {
        self.resources.retain(|state| {
            if state.consumer_dropped.load(Ordering::Acquire) {
                state.release_producer.store(true, Ordering::Release);
                Arc::strong_count(state) > 1
            } else {
                true
            }
        });
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn main() {
    // Import metadata without opening an output device or touching any deck.
    // The privileged desktop supplies the same identity-bound load envelope.
    if std::env::args().nth(1).as_deref() == Some("--inspect") {
        let result = std::panic::catch_unwind(|| -> Result<Value, &'static str> {
            let frame = read_frame(&mut io::stdin().lock())
                .map_err(|_| "invalid_request")?
                .ok_or("invalid_request")?;
            let request: Request = serde_json::from_slice(&frame).map_err(|_| "invalid_request")?;
            validate(&request.command)?;
            if let Command::Load { path, identity, .. } = request.command {
                deck_craft_audio::analysis::inspect(&path, &identity)
            } else {
                Err("invalid_command")
            }
        })
        .unwrap_or(Err("decoder_failed"));
        let reply = match result {
            Ok(metadata) => json!({"ok":true,"metadata":metadata}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        println!("{}", reply);
        return;
    }
    let failed = Arc::new(AtomicBool::new(false));
    let error_flag = failed.clone();
    let output = DeviceSinkBuilder::from_default_device()
        .and_then(|b| {
            b.with_buffer_size(rodio::cpal::BufferSize::Fixed(512))
                .with_error_callback(move |error| {
                    if deck_craft_audio::fatal_output_error(error.kind()) {
                        error_flag.store(true, Ordering::Relaxed);
                    }
                })
                .open_stream()
        })
        .ok();
    let mixer = output
        .as_ref()
        .map(|o| o.mixer().clone())
        .unwrap_or_else(|| {
            rodio::mixer::mixer(
                rodio::ChannelCount::new(2).unwrap(),
                rodio::SampleRate::new(48000).unwrap(),
            )
            .0
        });
    let decks = (0..4)
        .map(|index| {
            let player = Player::connect_new(&mixer);
            player.pause();
            AudioDeck {
                player,
                track_id: None,
                duration: 0.0,
                channels: 0,
                sample_rate: 0,
                level: 78.0,
                side:[deck_craft_audio::fullkill::Side::Left,deck_craft_audio::fullkill::Side::Right,deck_craft_audio::fullkill::Side::Thru,deck_craft_audio::fullkill::Side::Thru][index],
                controls: DeckControls::new(MASTER_HEADROOM * 78.0 / 100.0),
                path: String::new(),
                identity: None,
                generation: 0,
                ended: false,
                stream: None,
                rate: 1.0,
                pitch_lock: true,
                beat_grid: None,
                synced: false,
            }
        })
        .collect();
    let engine_id = format!(
        "engine-{:x}-{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    );
    let mut engine = Engine {
        output,
        failed,
        decks,
        crossfader: 50.0,
        tokens: (0..4).map(|_| Arc::new(AtomicU64::new(0))).collect(),
        wave_tokens: (0..4).map(|_| Arc::new(AtomicU64::new(0))).collect(),
        loading: [false; 4],
        resources: Vec::new(),
        engine_id,
        sequence: 0,
        master: None,
        sync_pending: [None; 4],
    };
    engine.levels();
    let (tx, rx) = mpsc::channel();
    let input_tx = tx.clone();
    thread::spawn(move || {
        let mut reader = io::stdin().lock();
        loop {
            match read_frame(&mut reader) {
                Ok(Some(frame)) => match serde_json::from_slice::<Request>(&frame) {
                    Ok(r) => {
                        if input_tx.send(Message::Request(r)).is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        let id = serde_json::from_slice::<Value>(&frame)
                            .ok()
                            .and_then(|v| {
                                v.get("id")
                                    .and_then(Value::as_str)
                                    .filter(|s| valid_id(s))
                                    .map(String::from)
                            })
                            .unwrap_or_else(|| "invalid".into());
                        let _ = input_tx.send(Message::Invalid(id));
                    }
                },
                _ => {
                    let _ = input_tx.send(Message::End);
                    return;
                }
            }
        }
    });
    let snapshot = engine.snapshot();
    engine.send("state", json!({"snapshot":snapshot}));
    let mut last = Instant::now();
    loop {
        let wait = engine.cadence().saturating_sub(last.elapsed()).max(Duration::from_millis(1));
        match rx.recv_timeout(wait) {
            Ok(Message::Request(r)) => {
                if !engine.apply(r, &tx) {
                    break;
                }
            }
            Ok(Message::Candidate(c)) => engine.candidate(c, &tx),
            Ok(Message::Analysis {
                deck,
                generation,
                track_id,
                metadata,
            }) => {
                if engine.decks[deck].track_id.as_ref() == Some(&track_id)
                    && engine.wave_tokens[deck].load(Ordering::SeqCst) == generation
                {
                    engine.decks[deck].beat_grid =
                        serde_json::from_value(metadata["beatGrid"].clone()).ok();
                    engine.send("analysis",json!({"deck":(["A","B","C","D"][deck]),"trackId":track_id,"loadGeneration":generation,"metadata":metadata}));
                }
            }
            Ok(Message::Wave {
                deck,
                generation,
                track_id,
                waveform,
            }) => {
                if engine.decks[deck].track_id.as_ref() == Some(&track_id)
                    && engine.wave_tokens[deck].load(Ordering::SeqCst) == generation
                {
                    // `peaks` is the persisted 512-value summary; `detail` is a session-only finer
                    // peak/RMS envelope (8-bit, base64) measured from the same decoded PCM.
                    let detail=json!({"bins":waveform.detail_peak.len(),"peak":base64(&waveform.detail_peak),"rms":base64(&waveform.detail_rms)});
                    engine.send("waveform",json!({"deck":(["A","B","C","D"][deck]),"trackId":track_id,"loadGeneration":generation,"peaks":waveform.peaks,"detail":detail}));
                }
            }
            Ok(Message::Invalid(id)) => engine.reply(&id, Some("invalid_request")),
            Ok(Message::End) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        engine.retire();
        if last.elapsed() >= engine.cadence() {
            let snapshot = engine.snapshot();
            engine.send("state", json!({"snapshot":snapshot}));
            last = Instant::now();
        }
    }
    for d in &engine.decks {
        d.player.pause();
    }
}
