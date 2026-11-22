//! The voice engine of the ANI-9 desktop app: understands what the person
//! says and answers aloud, with local models only (sherpa-onnx: Silero VAD,
//! Parakeet TDT v3 for speech, a Piper voice for Brazilian Portuguese). No
//! Apple speech model is used, and nothing leaves the Mac.
//!
//! The app's main process starts it on demand and talks to it with one JSON
//! object per line. The page captures the microphone and plays the voice;
//! this process only turns sound into text and text into sound.
//!
//! In (stdin):
//!   {"cmd":"listen"}                      start a new utterance
//!   {"cmd":"audio","pcm":"<base64>"}      16 kHz mono f32le samples of it
//!   {"cmd":"stop"}                        the person stopped: transcribe what there is
//!   {"cmd":"cancel"}                      drop the utterance
//!   {"cmd":"say","id":1,"text":"…"}       speak, sentence by sentence
//!   {"cmd":"hush"}                        stop speaking
//!   {"cmd":"wake","on":true}              listen for "Ei, Ani" in the audio sent between utterances
//! Out (stdout):
//!   {"event":"ready"}  {"event":"speech"}  {"event":"heard","text":"…"}
//!   {"event":"nothing"}  {"event":"audio","id":1,"rate":22050,"pcm":"<base64>"}
//!   {"event":"said","id":1}  {"event":"wake","text":"what came after the name"}
//!   {"event":"error","message":"…"}
//!
//! The speech model is big (about a gigabyte in memory): it is loaded on the
//! first utterance and let go after a few idle minutes. Listening for the
//! name keeps it loaded: each time someone speaks (the voice detector says
//! so; silence costs nothing), the first seconds are transcribed and checked
//! for "Ei, Ani" at the start.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use sherpa_onnx::{
    GenerationConfig, OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    OfflineTts, OfflineTtsConfig, OfflineTtsModelConfig, OfflineTtsVitsModelConfig, SileroVadModelConfig,
    VadModelConfig, VoiceActivityDetector,
};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const RATE: i32 = 16_000;
/// Few threads: the voice runs beside everything else on a laptop, often on battery.
const THREADS: i32 = 2;
/// The longest utterance kept, in seconds.
const MAX_SECONDS: usize = 30;
/** The speech model is let go after this long without an utterance. */
const EAR_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Command {
    Listen,
    Audio { pcm: String },
    Stop,
    Cancel,
    Say { id: u64, text: String },
    Hush,
    Wake { on: bool },
}

/// One line out; stdout is shared by both threads.
fn emit(out: &Mutex<io::Stdout>, value: serde_json::Value) {
    let mut out = out.lock().unwrap();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn path(p: &Path) -> Option<String> {
    Some(p.to_string_lossy().into_owned())
}

/// The first file in `dir` whose name ends with `suffix` (model files differ in name between releases).
fn find(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().ends_with(suffix)).unwrap_or(false))
        .collect();
    found.sort();
    found.into_iter().next()
}

fn decode_pcm(text: &str) -> Vec<f32> {
    let bytes = STANDARD.decode(text).unwrap_or_default();
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
}

fn encode_pcm(samples: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

/// Sentences, so the first one is heard while the next is made.
fn sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n' | ';' | ':') && current.trim().chars().count() > 1 {
            out.push(current.trim().to_string());
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        out.push(current.trim().to_string());
    }
    out
}

struct Ear {
    vad: VoiceActivityDetector,
    recognizer: OfflineRecognizer,
    /// The sound since the detector was last reset, kept raw for the recognizer: the
    /// detector's own segments clip the first syllable, so the words are cut from here.
    raw: Vec<f32>,
    /// Samples dropped from the front of `raw` (long waits for the name keep only the last seconds).
    dropped: usize,
    listening: bool,
    spoke: bool,
}

impl Ear {
    fn load(models: &Path) -> Result<Self, String> {
        let vad = VoiceActivityDetector::create(
            &VadModelConfig {
                silero_vad: SileroVadModelConfig {
                    model: path(&models.join("silero_vad.onnx")),
                    threshold: 0.5,
                    min_silence_duration: 0.7,
                    min_speech_duration: 0.25,
                    window_size: 512,
                    max_speech_duration: MAX_SECONDS as f32,
                },
                sample_rate: RATE,
                num_threads: 1,
                ..Default::default()
            },
            MAX_SECONDS as f32 + 5.0,
        )
        .ok_or("Não deu para carregar o detector de fala (silero_vad.onnx).")?;

        let asr = models.join("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8");
        let file = |suffix: &str| find(&asr, suffix).and_then(|p| path(&p));
        let mut config = OfflineRecognizerConfig::default();
        config.model_config = OfflineModelConfig {
            transducer: OfflineTransducerModelConfig {
                encoder: file("encoder.int8.onnx"),
                decoder: file("decoder.int8.onnx"),
                joiner: file("joiner.int8.onnx"),
            },
            tokens: file("tokens.txt"),
            model_type: Some("nemo_transducer".into()),
            num_threads: THREADS,
            ..Default::default()
        };
        config.decoding_method = Some("greedy_search".into());
        let recognizer = OfflineRecognizer::create(&config).ok_or("Não deu para carregar o modelo que entende a fala.")?;
        Ok(Ear { vad, recognizer, raw: Vec::new(), dropped: 0, listening: false, spoke: false })
    }

    fn reset(&mut self) {
        self.vad.reset();
        self.raw.clear();
        self.dropped = 0;
    }

    fn start(&mut self) {
        self.reset();
        self.listening = true;
        self.spoke = false;
    }

    fn push(&mut self, samples: &[f32]) {
        self.raw.extend_from_slice(samples);
        // Waiting for the name can last hours: only the last seconds are kept.
        let keep = (MAX_SECONDS + 5) * RATE as usize;
        if !self.listening && self.raw.len() > keep + RATE as usize * 5 {
            let extra = self.raw.len() - keep;
            self.raw.drain(..extra);
            self.dropped += extra;
        }
        self.vad.accept_waveform(samples);
    }

    /// The speech the detector found, from a little before it started to a little after it ended.
    fn speech(&mut self, limit: usize) -> Option<Vec<f32>> {
        let mut span: Option<(usize, usize)> = None;
        while let Some(segment) = self.vad.front() {
            let start = segment.start().max(0) as usize;
            let end = start + segment.n().max(0) as usize;
            span = Some(match span {
                Some((a, b)) => (a.min(start), b.max(end)),
                None => (start, end),
            });
            self.vad.pop();
        }
        let (start, end) = span?;
        if end - start < RATE as usize / 4 {
            return None;
        }
        let pad_before = RATE as usize * 2 / 5;
        let pad_after = RATE as usize * 3 / 10;
        let from = start.saturating_sub(pad_before).max(self.dropped) - self.dropped;
        let to = (end + pad_after).min(self.dropped + self.raw.len()) - self.dropped;
        let to = to.min(from + limit);
        let mut speech = self.raw[from..to].to_vec();
        // A little silence after the last word helps the end of the sentence come out.
        speech.extend(std::iter::repeat(0.0).take(RATE as usize / 2));
        Some(speech)
    }

    fn recognize(&self, speech: &[f32]) -> Option<String> {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(RATE, speech);
        self.recognizer.decode(&stream);
        let text = stream.get_result()?.text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    /// Feeds samples; true when the person has said something and gone quiet.
    fn feed(&mut self, samples: &[f32], out: &Mutex<io::Stdout>) -> bool {
        if !self.listening {
            return false;
        }
        if self.raw.len() < MAX_SECONDS * RATE as usize {
            self.push(samples);
        }
        if self.vad.detected() && !self.spoke {
            self.spoke = true;
            emit(out, json!({"event": "speech"}));
        }
        // A whole segment came out of the detector: speech followed by enough silence.
        !self.vad.is_empty() || self.raw.len() >= MAX_SECONDS * RATE as usize
    }

    fn transcribe(&mut self) -> Option<String> {
        self.listening = false;
        self.vad.flush();
        // Nothing the detector called speech: nothing to transcribe (no guessing from noise).
        let speech = self.speech(MAX_SECONDS * RATE as usize)?;
        self.recognize(&speech)
    }
}

/** Seconds of each utterance checked for the name, which comes first. */
const WAKE_SECONDS: usize = 6;

/** Lower case, no accents, no punctuation: how the name is compared. */
fn plain(text: &str) -> String {
    let mut out = String::new();
    for ch in text.to_lowercase().chars() {
        let base = match ch {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'è' | 'ë' => 'e',
            'í' | 'î' | 'ì' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ò' | 'ö' => 'o',
            'ú' | 'û' | 'ù' | 'ü' => 'u',
            'ç' => 'c',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        };
        out.push(base);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/** Letters to change to turn one word into the other. */
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut previous = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let here = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(previous + usize::from(a[i - 1] != b[j - 1]));
            previous = here;
        }
    }
    row[b.len()]
}

/** "Ani" as speech recognition writes it: Ani, Annie, Any, Eni, Ane… (a vowel, then close to "ani"). */
fn is_name(word: &str) -> bool {
    let word = word.trim_end_matches('9');
    word.len() >= 3
        && word.len() <= 5
        && !["aia", "uma", "ana", "ene", "ani9"].contains(&word)
        && word.starts_with(['a', 'e', 'i', 'o', 'h'])
        && (distance(word, "ani") <= 1 || distance(word, "annie") <= 1 || ["aninha", "honey", "hani"].contains(&word))
}

/** What was said after the name, when the utterance starts with "Ei, Ani" (or the ways it is heard). */
fn after_name(text: &str) -> Option<String> {
    let words: Vec<String> = plain(text).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect();
    let greeting = ["ei", "hey", "hei", "oi", "e", "ai", "ah", "ok", "okay", "hi", "ey", "hay"];
    let first = words.first()?;
    // "eiani", "heyannie": the greeting and the name run together.
    for joined in ["ei", "hey", "hei", "oi", "e"] {
        if let Some(rest) = first.strip_prefix(joined) {
            if is_name(rest) {
                return Some(words[1..].join(" "));
            }
        }
    }
    if greeting.contains(&first.as_str()) {
        let second = words.get(1)?;
        // After a greeting the recognizer also writes the name as "Danny" or "Dani" ("ei, ani" runs together),
        // and "assistente" is accepted as the name too.
        let heard_as = ["danny", "dani", "dany", "deni", "assistente"];
        return (is_name(second) || heard_as.contains(&second.as_str())).then(|| words[2..].join(" "));
    }
    // The name alone, as the whole utterance.
    (words.len() == 1 && is_name(first)).then(String::new)
}

impl Ear {
    /** Between utterances: the sound goes to the detector; a finished utterance is checked for the name. */
    fn wake_feed(&mut self, samples: &[f32]) -> Option<String> {
        self.push(samples);
        if self.vad.is_empty() {
            return None;
        }
        let speech = self.speech(WAKE_SECONDS * RATE as usize)?;
        let text = self.recognize(&speech)?;
        if std::env::var_os("ANI9_VOZ_DEBUG").is_some() {
            eprintln!("acordar? {text:?}");
        }
        after_name(&text)
    }
}

fn load_voice(models: &Path, voice: &str) -> Result<OfflineTts, String> {
    let dir = models.join(voice);
    let model = find(&dir, ".onnx").ok_or_else(|| format!("Voz não encontrada em {}.", dir.display()))?;
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            vits: OfflineTtsVitsModelConfig {
                model: path(&model),
                tokens: path(&dir.join("tokens.txt")),
                data_dir: path(&dir.join("espeak-ng-data")),
                noise_scale: 0.667,
                noise_scale_w: 0.8,
                length_scale: 1.0,
                ..Default::default()
            },
            num_threads: THREADS,
            debug: std::env::var_os("ANI9_VOZ_DEBUG").is_some(),
            ..Default::default()
        },
        max_num_sentences: 1,
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "Não deu para carregar a voz.".to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let models = PathBuf::from(arg("--modelos").unwrap_or_else(|| ".".into()));
    let voice = arg("--voz").unwrap_or_else(|| "vits-piper-pt_BR-faber-medium-int8".into());
    let out = Arc::new(Mutex::new(io::stdout()));

    // The voice speaks on its own thread, so "hush" and the microphone are handled while it talks.
    let hushed = Arc::new(AtomicU64::new(0));
    let speaking = Arc::new(AtomicBool::new(false));
    let (say_tx, say_rx) = mpsc::channel::<(u64, String)>();
    {
        let out = Arc::clone(&out);
        let hushed = Arc::clone(&hushed);
        let speaking = Arc::clone(&speaking);
        let models = models.clone();
        thread::spawn(move || {
            let tts = match load_voice(&models, &voice) {
                Ok(tts) => tts,
                Err(message) => {
                    emit(&out, json!({"event": "error", "message": message}));
                    return;
                }
            };
            let rate = tts.sample_rate();
            for (id, text) in say_rx {
                speaking.store(true, Ordering::SeqCst);
                for sentence in sentences(&text) {
                    if hushed.load(Ordering::SeqCst) >= id {
                        break;
                    }
                    let config = GenerationConfig { speed: 1.05, ..Default::default() };
                    let made = tts.generate_with_config::<fn(&[f32], f32) -> bool>(&sentence, &config, None);
                    if made.is_none() {
                        emit(&out, json!({"event": "error", "message": format!("A voz não conseguiu dizer: {sentence}")}));
                    }
                    if let Some(audio) = made {
                        if hushed.load(Ordering::SeqCst) >= id {
                            break;
                        }
                        emit(&out, json!({"event": "audio", "id": id, "rate": rate, "pcm": encode_pcm(audio.samples())}));
                    }
                }
                speaking.store(false, Ordering::SeqCst);
                emit(&out, json!({"event": "said", "id": id}));
            }
        });
    }

    // The speech model, loaded when the person first speaks and let go when idle.
    let mut ear: Option<Ear> = None;
    let mut ear_used = Instant::now();
    let mut waking = false;
    emit(&out, json!({"event": "ready"}));

    let mut last_say = 0u64;
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let command: Command = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                emit(&out, json!({"event": "error", "message": format!("Comando inválido: {error}")}));
                continue;
            }
        };
        match command {
            Command::Listen => {
                if ear.is_none() {
                    match Ear::load(&models) {
                        Ok(loaded) => ear = Some(loaded),
                        Err(message) => {
                            emit(&out, json!({"event": "error", "message": message}));
                            continue;
                        }
                    }
                }
                ear_used = Instant::now();
                ear.as_mut().unwrap().start();
            }
            Command::Audio { pcm } => {
                let samples = decode_pcm(&pcm);
                match ear.as_mut() {
                    Some(listening) if listening.listening => {
                        ear_used = Instant::now();
                        if listening.feed(&samples, &out) {
                            match listening.transcribe() {
                                Some(text) => emit(&out, json!({"event": "heard", "text": text})),
                                None => emit(&out, json!({"event": "nothing"})),
                            }
                        }
                    }
                    _ => {
                        // Between utterances: only the name is listened for, never while the voice speaks.
                        if waking && !speaking.load(Ordering::SeqCst) {
                            if let Some(waker) = ear.as_mut() {
                                if let Some(rest) = waker.wake_feed(&samples) {
                                    waker.reset();
                                    emit(&out, json!({"event": "wake", "text": rest}));
                                }
                            }
                        } else if ear.is_some() && !waking && ear_used.elapsed() > EAR_IDLE {
                            ear = None;
                        }
                    }
                }
            }
            Command::Stop => {
                if let Some(listening) = ear.as_mut().filter(|e| e.listening) {
                    match listening.transcribe() {
                        Some(text) => emit(&out, json!({"event": "heard", "text": text})),
                        None => emit(&out, json!({"event": "nothing"})),
                    }
                }
            }
            Command::Cancel => {
                if let Some(listening) = ear.as_mut() {
                    listening.listening = false;
                }
            }
            Command::Wake { on } => {
                waking = on;
                if on && ear.is_none() {
                    match Ear::load(&models) {
                        Ok(loaded) => ear = Some(loaded),
                        Err(message) => {
                            waking = false;
                            emit(&out, json!({"event": "error", "message": message}));
                        }
                    }
                }
                if let Some(waker) = ear.as_mut().filter(|e| !e.listening) {
                    waker.reset();
                }
            }
            Command::Say { id, text } => {
                last_say = last_say.max(id);
                let _ = say_tx.send((id, text));
            }
            Command::Hush => hushed.store(last_say, Ordering::SeqCst),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::after_name;

    #[test]
    fn hears_the_name_at_the_start_and_keeps_what_follows() {
        assert_eq!(after_name("Ei, Ani."), Some(String::new()));
        assert_eq!(after_name("Ei Ani, abre o chat."), Some("abre o chat".into()));
        assert_eq!(after_name("Hey Annie, cria um baralho"), Some("cria um baralho".into()));
        assert_eq!(after_name("Ani!"), Some(String::new()));
        assert_eq!(after_name("Oi, Aní, tudo bem?"), Some("tudo bem".into()));
        assert_eq!(after_name("Eni, abre o chat."), None);
        assert_eq!(after_name("Ei, Eni, abre o chat."), Some("abre o chat".into()));
        assert_eq!(after_name("Eiani mostra minha semana"), Some("mostra minha semana".into()));
        assert_eq!(after_name("Okay, Danny."), Some(String::new()));
        assert_eq!(after_name("E, Danny, mostra a minha semana."), Some("mostra a minha semana".into()));
        assert_eq!(after_name("Ei, assistente, abre o chat"), Some("abre o chat".into()));
    }

    #[test]
    fn ignores_the_name_elsewhere_and_other_talk() {
        assert_eq!(after_name("Ani, você viu isso?"), None);
        assert_eq!(after_name("Eu falei com a Ani ontem"), None);
        assert_eq!(after_name("Analisa a minha semana"), None);
        assert_eq!(after_name("Ei, tudo bem?"), None);
        assert_eq!(after_name("E aí, beleza?"), None);
        assert_eq!(after_name("Hey Tony"), None);
        assert_eq!(after_name("Danny, vem cá"), None);
        assert_eq!(after_name(""), None);
    }
}
