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
//! Out (stdout):
//!   {"event":"ready"}  {"event":"speech"}  {"event":"heard","text":"…"}
//!   {"event":"nothing"}  {"event":"audio","id":1,"rate":22050,"pcm":"<base64>"}
//!   {"event":"said","id":1}  {"event":"error","message":"…"}

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

const RATE: i32 = 16_000;
/// Few threads: the voice runs beside everything else on a laptop, often on battery.
const THREADS: i32 = 2;
/// The longest utterance kept, in seconds.
const MAX_SECONDS: usize = 30;

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Command {
    Listen,
    Audio { pcm: String },
    Stop,
    Cancel,
    Say { id: u64, text: String },
    Hush,
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
    /// Everything heard since "listen", kept for the recognizer.
    heard: Vec<f32>,
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
        Ok(Ear { vad, recognizer, heard: Vec::new(), listening: false, spoke: false })
    }

    fn start(&mut self) {
        self.vad.reset();
        self.heard.clear();
        self.listening = true;
        self.spoke = false;
    }

    /// Feeds samples; true when the person has said something and gone quiet.
    fn feed(&mut self, samples: &[f32], out: &Mutex<io::Stdout>) -> bool {
        if !self.listening {
            return false;
        }
        if self.heard.len() < MAX_SECONDS * RATE as usize {
            self.heard.extend_from_slice(samples);
        }
        self.vad.accept_waveform(samples);
        if self.vad.detected() && !self.spoke {
            self.spoke = true;
            emit(out, json!({"event": "speech"}));
        }
        // A whole segment came out of the detector: speech followed by enough silence.
        let finished = !self.vad.is_empty();
        finished || self.heard.len() >= MAX_SECONDS * RATE as usize
    }

    fn transcribe(&mut self) -> Option<String> {
        self.listening = false;
        self.vad.flush();
        let mut speech: Vec<f32> = Vec::new();
        while let Some(segment) = self.vad.front() {
            speech.extend_from_slice(segment.samples());
            self.vad.pop();
        }
        // Nothing the detector called speech: nothing to transcribe (no guessing from noise).
        if speech.len() < (RATE as usize) / 4 {
            return None;
        }
        let stream = self.recognizer.create_stream();
        // A little silence after the last word helps the end of the sentence come out.
        speech.extend(std::iter::repeat(0.0).take(RATE as usize / 2));
        stream.accept_waveform(RATE, &speech);
        self.recognizer.decode(&stream);
        let text = stream.get_result()?.text.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
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

    let mut ear = match Ear::load(&models) {
        Ok(ear) => ear,
        Err(message) => {
            emit(&out, json!({"event": "error", "message": message}));
            std::process::exit(1);
        }
    };
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
            Command::Listen => ear.start(),
            Command::Audio { pcm } => {
                if ear.feed(&decode_pcm(&pcm), &out) {
                    match ear.transcribe() {
                        Some(text) => emit(&out, json!({"event": "heard", "text": text})),
                        None => emit(&out, json!({"event": "nothing"})),
                    }
                }
            }
            Command::Stop => {
                if ear.listening {
                    match ear.transcribe() {
                        Some(text) => emit(&out, json!({"event": "heard", "text": text})),
                        None => emit(&out, json!({"event": "nothing"})),
                    }
                }
            }
            Command::Cancel => ear.listening = false,
            Command::Say { id, text } => {
                last_say = last_say.max(id);
                let _ = say_tx.send((id, text));
            }
            Command::Hush => hushed.store(last_say, Ordering::SeqCst),
        }
    }
}
