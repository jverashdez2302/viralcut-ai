# AI Viral Clip Generator

Aplicación open source para convertir videos largos en clips verticales 9:16. Incluye una interfaz en español, carga de archivos, importación de enlaces de YouTube mediante `yt-dlp` (solo para contenido propio o autorizado), transcripción, selección semántica de momentos, renderizado con FFmpeg, subtítulos y exportación ZIP.

> **Importante:** no se incluyen resultados falsos. Para análisis automático real debes configurar `OPENAI_API_KEY`. El servicio de IA se ejecuta en el backend; la clave nunca se envía al navegador. La aplicación no garantiza viralidad: el puntaje es una estimación editorial basada en claridad, emoción, sorpresa, contexto y potencial de retención.

## Funciones implementadas

- Subir MP4, MOV, AVI, MKV, WebM y otros formatos compatibles con FFmpeg.
- Importar un video de YouTube con `yt-dlp`, sujeto a permisos, derechos y condiciones de la plataforma.
- Obtener metadatos con `ffprobe`.
- Transcribir audio con marcas de tiempo de palabras usando una API compatible con OpenAI.
- Muestrear fotogramas de referencia y cruzar escenas visuales con el contexto de la transcripción (requiere un modelo con visión).
- Analizar el contexto de la transcripción y proponer varios momentos con título, gancho, descripción, hashtags, plataforma y puntuación.
- Recortar cada momento y exportarlo como MP4 vertical 1080x1920, H.264/AAC.
- Subtítulos animados por palabras (ASS karaoke).
- Editor básico para ajustar inicio, final, título y subtítulos, y volver a renderizar.
- Generación opcional de voz en off mediante endpoint de audio compatible con OpenAI.
- Descarga individual y ZIP por lote.
- Estado de procesamiento y cancelación de trabajos.

## Requisitos

- Node.js 20+
- FFmpeg y FFprobe instalados y disponibles en PATH.
- `yt-dlp` para importación desde YouTube.
- Una clave de API compatible con OpenAI para transcripción, análisis y voz en off.

## Instalación local

```bash
cp .env.example .env
npm install
```

Edita `.env` y agrega `OPENAI_API_KEY`. Después:

```bash
npm start
```

Abre `http://localhost:3000`.

## Instalación con Docker

```bash
cp .env.example .env
# Edita .env y configura OPENAI_API_KEY
docker compose up --build
```

Abre `http://localhost:3000`.

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP (3000 por defecto) |
| `OPENAI_API_KEY` | Clave privada para la API |
| `OPENAI_BASE_URL` | Base URL de API compatible |
| `OPENAI_TRANSCRIPTION_MODEL` | Modelo de transcripción (por defecto `whisper-1`) |
| `OPENAI_CHAT_MODEL` | Modelo de análisis semántico (por defecto `gpt-4o-mini`) |
| `OPENAI_VISION_MODEL` | Modelo con capacidad de visión para revisar fotogramas (por defecto `gpt-4o-mini`) |
| `OPENAI_TTS_MODEL` | Modelo de voz (por defecto `tts-1`) |
| `OPENAI_TTS_VOICE` | Voz predeterminada |
| `MAX_UPLOAD_GB` | Tamaño máximo de carga |
| `YT_DLP_PATH` | Ruta del ejecutable `yt-dlp` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Rutas de FFmpeg/FFprobe |

## Flujo de trabajo

1. Sube un archivo o pega un enlace de YouTube que tengas derecho a procesar.
2. El servidor valida el origen y obtiene duración/resolución.
3. Extrae el audio y lo divide en fragmentos cuando hace falta.
4. Transcribe el audio con marcas de tiempo.
5. La IA propone clips basados en el contexto completo disponible de la transcripción.
6. FFmpeg genera los clips 9:16 y subtítulos.
7. Puedes ajustar los tiempos y volver a renderizar, o descargar los clips.

## Limitaciones técnicas transparentes

- **Detección de rostros/seguimiento:** esta primera versión centra el recorte vertical. No incorpora todavía seguimiento facial inteligente; se puede añadir después con OpenCV/MediaPipe.
- **Análisis visual:** se muestrean hasta 12 fotogramas de referencia y se envían al modelo con visión junto con la transcripción. No es un análisis exhaustivo de cada fotograma ni una detección precisa de acciones cuadro a cuadro.
- **Subtítulos:** se generan con marcas de tiempo de palabras del motor de transcripción. La calidad depende del audio y del modelo.
- **Viralidad:** ninguna IA puede predecir con certeza el rendimiento real. El puntaje es orientativo, no una promesa de alcance.
- **YouTube:** el servidor requiere `yt-dlp` y el procesamiento debe limitarse a videos propios, con licencia o con autorización. La aplicación no evade DRM, restricciones de acceso ni controles de la plataforma.
- **Tamaño de audio:** el servidor comprime y divide audios extensos para ajustarse a límites comunes de transcripción.
- **Almacenamiento:** los archivos quedan en `uploads/` y `outputs/` hasta que el administrador los elimine. Para producción, configura una política de limpieza, autenticación, límites y almacenamiento privado.

## API local

- `GET /api/health`
- `POST /api/jobs/upload` (multipart, campo `video`)
- `POST /api/jobs/youtube` (JSON `{ "url": "...", "authorized": true }`)
- `GET /api/jobs/:jobId`
- `POST /api/jobs/:jobId/cancel`
- `POST /api/jobs/:jobId/clips/:clipId/render`
- `POST /api/jobs/:jobId/export` (JSON `{ "clipIds": ["..."] }`)

## Seguridad antes de publicar

Esta versión es un punto de partida funcional. Antes de exponerla a internet, añade autenticación, autorización por usuario, rate limiting, escaneo de archivos, límites de concurrencia, HTTPS, almacenamiento privado, limpieza automática y protección CSRF según el despliegue. No publiques el puerto sin protegerlo.

## ViralCut AI v1.1.0 — preparación de publicación

Esta edición añade protección de acceso para despliegues de producción mediante `APP_USERNAME` y `APP_PASSWORD`, límite de trabajos simultáneos, eliminación programada de archivos vencidos, controles de origen para solicitudes de escritura, corrección del sondeo de estado en la interfaz y comprobaciones de duración al editar clips.

**Lee [DEPLOY.md](DEPLOY.md) antes de publicar.** No publiques el servicio sin HTTPS y credenciales. Los archivos no se publican automáticamente al cargar un ZIP a GitHub. ChatGPT Plus no incluye créditos de la API de OpenAI.
