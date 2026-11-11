import "dotenv/config";
import express from "express";
import helmet from "helmet";
import multer from "multer";
import archiver from "archiver";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const YTDLP = process.env.YT_DLP_PATH || "yt-dlp";
const MAX_UPLOAD_GB = Number(process.env.MAX_UPLOAD_GB || 2);
const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1));
const JOB_TTL_HOURS = Math.max(1, Number(process.env.JOB_TTL_HOURS || 24));
const APP_USERNAME = process.env.APP_USERNAME || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
if (process.env.NODE_ENV === "production" && (!APP_USERNAME || !APP_PASSWORD)) {
  throw new Error("Por seguridad, configura APP_USERNAME y APP_PASSWORD antes de publicar.");
}
if (Boolean(APP_USERNAME) !== Boolean(APP_PASSWORD)) {
  throw new Error("Configura APP_USERNAME y APP_PASSWORD juntos.");
}
function secureEquals(a, b) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}
function authRequired(req, res, next) {
  if (!APP_USERNAME) return next(); // Solo desarrollo local; producción exige credenciales.
  const authorization = req.get("authorization") || "";
  let user = "", password = "";
  if (authorization.startsWith("Basic ")) {
    const raw = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = raw.indexOf(":");
    if (separator !== -1) { user = raw.slice(0, separator); password = raw.slice(separator + 1); }
  }
  if (secureEquals(user, APP_USERNAME) && secureEquals(password, APP_PASSWORD)) return next();
  res.set("WWW-Authenticate", 'Basic realm="ViralCut AI", charset="UTF-8"');
  res.status(401).send("Acceso restringido a ViralCut AI.");
}
function limitActiveJobs(_req, res, next) {
  const active = [...jobs.values()].filter(j => !["completed", "cancelled", "error"].includes(j.status));
  if (active.length >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: "El servidor está procesando otro video. Inténtalo cuando termine." });
  }
  next();
}
const jobs = new Map();
const activeProcesses = new Map();

await fsp.mkdir(UPLOAD_DIR, { recursive: true });
await fsp.mkdir(OUTPUT_DIR, { recursive: true });

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" }, contentSecurityPolicy: false }));
app.use(authRequired);
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch { /* Origin inválido */ }
  return res.status(403).json({ error: "Origen de solicitud no permitido." });
});
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/media", express.static(OUTPUT_DIR, { fallthrough: false, maxAge: "1h" }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".mp4").slice(0, 12) || ".mp4";
    cb(null, `${randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_GB * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(mp4|mov|m4v|avi|mkv|webm|mpeg|mpg|3gp)$/i.test(file.originalname || "");
    cb(allowed ? null : new Error("Formato no admitido. Usa MP4, MOV, AVI, MKV o WebM."), allowed);
  }
});

function updateJob(job, status, progress, message) {
  job.status = status;
  job.progress = Math.max(0, Math.min(100, progress));
  job.message = message;
  job.updatedAt = new Date().toISOString();
}

function run(command, args, { onStdout, onStderr, signal, jobId } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    if (jobId) activeProcesses.set(jobId, child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); onStdout?.(d.toString()); });
    child.stderr.on("data", d => { stderr += d.toString(); onStderr?.(d.toString()); });
    child.on("error", reject);
    child.on("close", code => {
      if (jobId && activeProcesses.get(jobId) === child) activeProcesses.delete(jobId);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} terminó con código ${code}: ${stderr.slice(-1600)}`));
    });
  });
}

async function probeVideo(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height",
    "-of", "json", file
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams?.find(s => s.codec_type === "video") || {};
  const audio = data.streams?.some(s => s.codec_type === "audio") || false;
  return {
    duration: Number(data.format?.duration || 0),
    size: Number(data.format?.size || 0),
    width: video.width || 0,
    height: video.height || 0,
    hasAudio: audio
  };
}

function apiConfig() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY en el archivo .env. Configura la clave del proveedor de IA y reinicia el servidor.");
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return { key, base };
}

async function transcribeAudio(audioPath, offsetSeconds = 0) {
  const { key, base } = apiConfig();
  const form = new FormData();
  const bytes = await fsp.readFile(audioPath);
  form.append("file", new Blob([bytes]), path.basename(audioPath));
  form.append("model", process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error de transcripción (${response.status}): ${body.slice(0, 900)}`);
  }
  const data = await response.json();
  return {
    text: data.text || "",
    words: (data.words || []).map(w => ({
      word: w.word,
      start: Number(w.start || 0) + offsetSeconds,
      end: Number(w.end || w.start || 0) + offsetSeconds
    })),
    segments: (data.segments || []).map(s => ({
      text: s.text,
      start: Number(s.start || 0) + offsetSeconds,
      end: Number(s.end || s.start || 0) + offsetSeconds
    }))
  };
}

async function transcribeLongAudio(job, audioPath, duration) {
  const stat = await fsp.stat(audioPath);
  const maxBytes = 22 * 1024 * 1024;
  if (stat.size <= maxBytes) return transcribeAudio(audioPath, 0);

  const tempDir = path.join(UPLOAD_DIR, `chunks-${job.id}`);
  await fsp.mkdir(tempDir, { recursive: true });
  const chunkSeconds = 480;
  await run(FFMPEG, [
    "-y", "-i", audioPath, "-f", "segment", "-segment_time", String(chunkSeconds),
    "-c", "copy", path.join(tempDir, "part-%03d.mp3")
  ]);
  const names = (await fsp.readdir(tempDir)).filter(n => n.endsWith(".mp3")).sort();
  const all = { text: "", words: [], segments: [] };
  for (let i = 0; i < names.length; i++) {
    if (job.cancelled) throw new Error("Procesamiento cancelado.");
    updateJob(job, "transcribing", 18 + Math.round((i / names.length) * 25), `Transcribiendo audio: parte ${i + 1} de ${names.length}`);
    const result = await transcribeAudio(path.join(tempDir, names[i]), i * chunkSeconds);
    all.text += (all.text ? " " : "") + result.text;
    all.words.push(...result.words);
    all.segments.push(...result.segments);
  }
  await fsp.rm(tempDir, { recursive: true, force: true });
  return all;
}

function cleanJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}


async function extractVisualSamples(job) {
  const count = 12;
  const interval = Math.max(8, job.metadata.duration / count);
  const dir = path.join(UPLOAD_DIR, `frames-${job.id}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    await run(FFMPEG, [
      "-y", "-i", job.sourcePath, "-vf", `fps=1/${interval.toFixed(3)},scale=512:-2`,
      "-frames:v", String(count), "-q:v", "7", path.join(dir, "frame-%02d.jpg")
    ], { jobId: job.id });
    const names = (await fsp.readdir(dir)).filter(n => n.endsWith(".jpg")).sort();
    const samples = [];
    for (let i = 0; i < names.length; i++) {
      const file = path.join(dir, names[i]);
      const bytes = await fsp.readFile(file);
      samples.push({
        timestamp: Math.min(job.metadata.duration, i * interval),
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`
      });
    }
    return samples;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function analyzeTranscript(transcript, duration, visualSamples = []) {
  const { key, base } = apiConfig();
  if (!transcript.text.trim()) throw new Error("No se detectó diálogo suficiente para analizar el video.");
  const compact = transcript.segments.length
    ? transcript.segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n")
    : transcript.text;
  const prompt = `Eres editor senior de videos cortos y estratega de redes. Analiza la transcripción completa y los fotogramas de referencia de un video de ${duration.toFixed(1)} segundos. Usa los fotogramas para reconocer escenas, cambios visuales, personas, acciones y reacciones visibles; combina esa información con el diálogo y el contexto. No atribuyas emociones que no sean visibles o audibles. Encuentra hasta 12 fragmentos que funcionen de forma independiente y tengan alto potencial de retención. No inventes hechos ni exageres el contenido. Prioriza frases sorprendentes, emoción, humor, revelaciones, argumentos fuertes, noticias relevantes, historias y momentos útiles. Cada clip debe preservar el contexto y no empezar ni terminar a mitad de una idea. Duración ideal 18-60 segundos, acepta 10-90 si el momento lo justifica. Los tiempos deben basarse en las marcas de tiempo proporcionadas. Devuelve SOLO JSON válido con esta forma: {"clips":[{"start":12.3,"end":48.1,"title":"...","description":"...","hook":"...","platform":"TikTok, Instagram Reels, Facebook Reels o YouTube Shorts","hashtags":["#..."],"score":87,"reason":"..."}]}. Score de 0 a 100 como evaluación editorial orientativa, nunca garantía de viralidad. No inventes clips si no hay momentos útiles. Evita solapamientos importantes. Máximo 12 clips.`;
  const userContent = [{ type: "text", text: `${prompt}\n\nTRANSCRIPCIÓN CON MARCAS DE TIEMPO:\n${compact.slice(0, 85000)}\n\nFOTOGRAMAS DE REFERENCIA: cada imagen incluye un tiempo aproximado del video. Considera el contexto visual, pero basa los límites temporales principalmente en las marcas de tiempo de la transcripción.` }];
  for (const sample of visualSamples.slice(0, 12)) {
    userContent.push({ type: "text", text: `Fotograma aproximado en ${sample.timestamp.toFixed(1)} segundos:` });
    userContent.push({ type: "image_url", image_url: { url: sample.dataUrl, detail: "low" } });
  }
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Responde exclusivamente JSON válido. Los textos de salida deben estar en español." },
        { role: "user", content: userContent }
      ]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error de análisis IA (${response.status}): ${body.slice(0, 900)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("El proveedor de IA no devolvió un análisis.");
  const parsed = cleanJson(content);
  const clips = (parsed.clips || []).map(c => ({
    id: randomUUID(),
    start: Math.max(0, Number(c.start) || 0),
    end: Math.min(duration, Number(c.end) || 0),
    title: String(c.title || "Momento destacado").slice(0, 120),
    description: String(c.description || "").slice(0, 500),
    hook: String(c.hook || "").slice(0, 180),
    platform: String(c.platform || "Instagram Reels"),
    hashtags: Array.isArray(c.hashtags) ? c.hashtags.slice(0, 12).map(String) : [],
    score: Math.max(0, Math.min(100, Number(c.score) || 0)),
    reason: String(c.reason || "").slice(0, 350),
    video: null,
    rendered: false
  })).filter(c => c.end > c.start && c.end - c.start >= 8 && c.end - c.start <= 100)
    .sort((a, b) => b.score - a.score).slice(0, 12);
  return clips;
}

function assTime(seconds) {
  const cs = Math.max(0, Math.floor(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
function assEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/{/g, "\\{").replace(/}/g, "\\}").replace(/\n/g, " ");
}
async function createAss(job, clip, words, enabled = true) {
  const assPath = path.join(OUTPUT_DIR, `${job.id}-${clip.id}.ass`);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,68,&H00FFFFFF,&H0000D7FF,&H00101010,&H78000000,-1,0,1,5,2,2,70,70,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  if (!enabled || !words?.length) {
    await fsp.writeFile(assPath, header, "utf8");
    return assPath;
  }
  const selected = words.filter(w => w.end > clip.start && w.start < clip.end);
  const lines = [];
  for (let i = 0; i < selected.length; i += 5) {
    const group = selected.slice(i, i + 5);
    if (!group.length) continue;
    const start = Math.max(0, group[0].start - clip.start);
    const end = Math.max(start + 0.15, Math.min(clip.end - clip.start, group[group.length - 1].end - clip.start + 0.12));
    const text = group.map(w => {
      const duration = Math.max(8, Math.round((w.end - w.start) * 100));
      return `{\\kf${duration}}${assEscape(w.word)}`;
    }).join(" ");
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  await fsp.writeFile(assPath, header + lines.join("\n"), "utf8");
  return assPath;
}
function escapeFilterPath(file) {
  return file.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function renderClip(job, clip, options = {}) {
  if (job.cancelled) throw new Error("Procesamiento cancelado.");
  const start = Math.max(0, Number(options.start ?? clip.start));
  const end = Math.min(job.metadata.duration, Number(options.end ?? clip.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start) || end - start < 3 || end - start > 120) {
    throw new Error("Selecciona un intervalo válido de entre 3 y 120 segundos.");
  }
  clip.start = start;
  clip.end = end;
  if (typeof options.title === "string" && options.title.trim()) clip.title = options.title.trim().slice(0, 120);
  const filename = `${job.id}-${clip.id}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const assPath = await createAss(job, clip, job.transcript?.words || [], options.subtitles !== false);
  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,subtitles='${escapeFilterPath(assPath)}'`;
  const args = [
    "-y", "-ss", String(start), "-i", job.sourcePath, "-t", String(end - start),
    "-vf", vf, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outputPath
  ];
  updateJob(job, "rendering", job.progress, `Renderizando: ${clip.title}`);
  await run(FFMPEG, args, { jobId: job.id });
  let finalPath = outputPath;

  if (options.voiceoverText?.trim()) {
    const { key, base } = apiConfig();
    const ttsResponse = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "tts-1",
        voice: options.voice || process.env.OPENAI_TTS_VOICE || "alloy",
        input: String(options.voiceoverText).slice(0, 4000),
        response_format: "mp3",
        speed: Math.max(0.75, Math.min(1.25, Number(options.voiceSpeed) || 1))
      })
    });
    if (!ttsResponse.ok) throw new Error(`Error TTS (${ttsResponse.status}): ${(await ttsResponse.text()).slice(0, 600)}`);
    const voicePath = path.join(OUTPUT_DIR, `${job.id}-${clip.id}-voice.mp3`);
    await fsp.writeFile(voicePath, Buffer.from(await ttsResponse.arrayBuffer()));
    const mixedPath = path.join(OUTPUT_DIR, `${job.id}-${clip.id}-voiceover.mp4`);
    const audioMode = options.audioMode || "mix";
    const filter = audioMode === "replace"
      ? "[1:a]volume=1[a]"
      : "[0:a]volume=0.35[a0];[1:a]volume=1[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[a]";
    await run(FFMPEG, [
      "-y", "-i", outputPath, "-i", voicePath, "-filter_complex", filter,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
      "-shortest", mixedPath
    ]);
    finalPath = mixedPath;
  }

  clip.video = `/media/${path.basename(finalPath)}`;
  clip.fileName = path.basename(finalPath);
  clip.rendered = true;
  clip.duration = Number((end - start).toFixed(1));
  return clip;
}

async function processJob(job) {
  try {
    updateJob(job, "metadata", 5, "Revisando el video...");
    job.metadata = await probeVideo(job.sourcePath);
    if (!job.metadata.duration || !job.metadata.hasAudio) throw new Error("El video no tiene una pista de audio válida o no se pudo leer su duración.");
    if (job.metadata.duration > 6 * 60 * 60) throw new Error("Por seguridad, la duración máxima admitida es de 6 horas.");
    if (job.cancelled) throw new Error("Procesamiento cancelado.");

    updateJob(job, "extracting", 12, "Preparando audio para transcripción...");
    const audioPath = path.join(UPLOAD_DIR, `${job.id}-audio.mp3`);
    await run(FFMPEG, ["-y", "-i", job.sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audioPath], { jobId: job.id });
    updateJob(job, "transcribing", 18, "Transcribiendo el contenido...");
    job.transcript = await transcribeLongAudio(job, audioPath, job.metadata.duration);
    await fsp.rm(audioPath, { force: true });
    if (job.cancelled) throw new Error("Procesamiento cancelado.");

    updateJob(job, "analyzing", 45, "Analizando escenas y contexto visual...");
    try {
      job.visualSamples = await extractVisualSamples(job);
    } catch (visualError) {
      console.warn("No se pudieron extraer fotogramas; se continúa con el análisis de audio:", visualError.message);
      job.visualSamples = [];
    }
    updateJob(job, "analyzing", 50, "La IA está cruzando diálogo, contexto y escenas...");
    try {
      job.clips = await analyzeTranscript(job.transcript, job.metadata.duration, job.visualSamples);
    } finally {
      job.visualSamples = []; // No conservar fotogramas base64 en memoria.
    }
    if (!job.clips.length) throw new Error("La IA no encontró fragmentos adecuados. Prueba con otro video o revisa la calidad del audio.");

    for (let i = 0; i < job.clips.length; i++) {
      if (job.cancelled) throw new Error("Procesamiento cancelado.");
      await renderClip(job, job.clips[i]);
      updateJob(job, "rendering", 55 + Math.round(((i + 1) / job.clips.length) * 43), `Clip ${i + 1} de ${job.clips.length} listo`);
    }
    updateJob(job, "completed", 100, `${job.clips.length} clips listos para revisar y descargar.`);
  } catch (error) {
    if (job.cancelled) updateJob(job, "cancelled", job.progress, "Procesamiento cancelado por el usuario.");
    else {
      job.error = error.message;
      updateJob(job, "error", job.progress, error.message);
    }
  } finally {
    activeProcesses.delete(job.id);
  }
}

function publicJob(job) {
  return {
    id: job.id, status: job.status, progress: job.progress, message: job.message,
    error: job.error || null, metadata: job.metadata || null,
    sourceName: job.sourceName, clips: job.clips || [],
    createdAt: job.createdAt, updatedAt: job.updatedAt
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    ffmpegConfigured: true,
    youtubeImporterConfigured: true,
    authenticationEnabled: Boolean(APP_USERNAME)
  });
});

app.post("/api/jobs/upload", limitActiveJobs, upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Selecciona un video para subir." });
  const job = {
    id: randomUUID(), sourcePath: req.file.path, sourceName: req.file.originalname,
    status: "queued", progress: 1, message: "Video recibido. Preparando análisis...",
    clips: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelled: false
  };
  jobs.set(job.id, job);
  processJob(job);
  res.status(202).json({ jobId: job.id });
});

app.post("/api/jobs/youtube", limitActiveJobs, async (req, res) => {
  const url = String(req.body?.url || "").trim();
  const authorized = req.body?.authorized === true;
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Introduce un enlace válido de YouTube." }); }
  const allowedHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"];
  if (!allowedHosts.includes(parsed.hostname)) return res.status(400).json({ error: "El enlace debe pertenecer a YouTube." });
  if (!authorized) return res.status(400).json({ error: "Confirma que tienes derechos o autorización para procesar este video." });

  const job = {
    id: randomUUID(), sourcePath: path.join(UPLOAD_DIR, `${randomUUID()}.mp4`),
    sourceName: "Video de YouTube", status: "downloading", progress: 3,
    message: "Importando video autorizado desde YouTube...", clips: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelled: false
  };
  jobs.set(job.id, job);
  res.status(202).json({ jobId: job.id });
  (async () => {
    try {
      await run(YTDLP, ["--no-playlist", "--no-warnings", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", job.sourcePath, url], { jobId: job.id });
      if (job.cancelled) throw new Error("Procesamiento cancelado.");
      await processJob(job);
    } catch (error) {
      job.error = `No se pudo importar el video. Verifica que yt-dlp esté instalado y que el video sea accesible y autorizado. ${error.message}`;
      updateJob(job, job.cancelled ? "cancelled" : "error", job.progress, job.error);
    }
  })();
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  res.json(publicJob(job));
});

app.post("/api/jobs/:jobId/cancel", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  job.cancelled = true;
  const child = activeProcesses.get(job.id);
  child?.kill("SIGTERM");
  res.json({ ok: true });
});

app.post("/api/jobs/:jobId/clips/:clipId/render", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  const clip = job.clips?.find(c => c.id === req.params.clipId);
  if (!clip) return res.status(404).json({ error: "Clip no encontrado." });
  try {
    if (job.status !== "completed") return res.status(409).json({ error: "Espera a que finalice el procesamiento inicial." });
    const updated = await renderClip(job, clip, req.body || {});
    updateJob(job, "completed", 100, "Clip actualizado.");
    res.json({ clip: updated });
  } catch (error) {
    updateJob(job, "completed", 100, "No se pudo actualizar el clip; los demás siguen disponibles.");
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/jobs/:jobId/export", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Trabajo no encontrado." });
  const ids = Array.isArray(req.body?.clipIds) ? req.body.clipIds : [];
  const clips = job.clips.filter(c => c.rendered && c.fileName && (!ids.length || ids.includes(c.id)));
  if (!clips.length) return res.status(400).json({ error: "No hay clips renderizados para exportar." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="viral-clips-${job.id.slice(0, 8)}.zip"`);
  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.on("error", err => res.destroy(err));
  archive.pipe(res);
  for (const clip of clips) {
    const file = path.join(OUTPUT_DIR, clip.fileName);
    if (fs.existsSync(file)) archive.file(file, { name: `${clip.title.replace(/[^a-z0-9-_ ]/gi, "").trim().slice(0, 55) || "clip"}.mp4` });
  }
  await archive.finalize();
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err instanceof multer.MulterError || /Formato no admitido/.test(err.message || "") ? 400 : 500;
  res.status(status).json({ error: status === 400 ? err.message : "No se pudo procesar la solicitud." });
});

// Limpieza automática de archivos y trabajos vencidos (por defecto, 24 horas).
async function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!["completed", "error", "cancelled"].includes(job.status)) continue;
    if (now - Date.parse(job.updatedAt) < JOB_TTL_HOURS * 3600_000) continue;
    jobs.delete(id);
    if (job.sourcePath?.startsWith(UPLOAD_DIR + path.sep)) {
      await fsp.rm(job.sourcePath, { force: true }).catch(console.error);
    }
    const uploadFiles = await fsp.readdir(UPLOAD_DIR).catch(() => []);
    for (const name of uploadFiles.filter(n => n.startsWith(`${id}-`) || n === `chunks-${id}`)) {
      await fsp.rm(path.join(UPLOAD_DIR, name), { force: true, recursive: true }).catch(console.error);
    }
    const outputFiles = await fsp.readdir(OUTPUT_DIR).catch(() => []);
    for (const name of outputFiles.filter(n => n.startsWith(`${id}-`))) {
      await fsp.rm(path.join(OUTPUT_DIR, name), { force: true }).catch(console.error);
    }
  }
}
setInterval(() => cleanupExpiredJobs().catch(console.error), 15 * 60_000).unref();

app.listen(PORT, () => {
  console.log(`AI Viral Clip Generator disponible en http://localhost:${PORT}`);
});
