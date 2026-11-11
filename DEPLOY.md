# Publicación de ViralCut AI — guía práctica

Esta carpeta contiene la aplicación **lista para configurar y desplegar**, pero **no constituye una web publicada**. Debes subir **los archivos descomprimidos** al repositorio GitHub y conectar un servidor compatible con Docker.

## 1. Requisitos

- Repositorio: `https://github.com/jverashdez2302/viralcut-ai`.
- Servidor Linux o servicio Docker con suficiente CPU, memoria y disco para FFmpeg. Para vídeos largos, evita planes gratuitos de muy pocos recursos.
- HTTPS y un dominio (o subdominio) para acceder desde el teléfono.
- Clave de API de OpenAI **con facturación habilitada**. ChatGPT Plus **no** incluye créditos de API. El coste depende del modelo y la duración de los vídeos.

## 2. Subir el código a GitHub

1. En una PC, descarga `viralcut-ai-v1.1.0.zip` desde el chat y descomprímelo.
2. Abre el repositorio `jverashdez2302/viralcut-ai` en GitHub.
3. Elimina el ZIP antiguo **solo cuando tengas una copia de seguridad**; no es necesario para ejecutar la aplicación.
4. En `Add file` → `Upload files`, sube los archivos y carpetas **del interior de `ai-viral-clip-generator/`** a la raíz del repositorio (incluidos `public/`, `server.js`, `package.json`, `Dockerfile`, etc.). No subas `.env`, `node_modules`, `uploads/` ni `outputs/` con vídeos privados.
5. Confirma los cambios (`Commit changes`). Verifica que `server.js` aparezca directamente en la raíz del repositorio, no dentro de una carpeta anidada.

**Importante:** GitHub no descomprime automáticamente un ZIP subido como archivo.

## 3. Variables de entorno en el servidor

Configura las siguientes variables **en el panel de secretos del proveedor**, no en GitHub:

```dotenv
NODE_ENV=production
PORT=3000
OPENAI_API_KEY=tu_clave_privada_de_api
APP_USERNAME=tu_usuario_privado
APP_PASSWORD=una_contrasena_larga_y_unica
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_VISION_MODEL=gpt-4o-mini
OPENAI_TTS_MODEL=tts-1
OPENAI_TTS_VOICE=alloy
MAX_UPLOAD_GB=2
MAX_CONCURRENT_JOBS=1
JOB_TTL_HOURS=24
```

No compartas tu clave ni contraseña en el chat, capturas, GitHub o vídeos. `NODE_ENV=production` exige usuario y contraseña para iniciar. La autenticación es HTTP Basic; **úsala únicamente detrás de HTTPS**. La sesión es para un solo administrador, no para una plataforma multiusuario.

## 4. Desplegar

**Opción VPS:** instala Docker y Docker Compose, configura un proxy inverso con HTTPS (Caddy/Nginx) y, en el servidor, ejecuta:

```bash
cp .env.example .env
# Rellena .env con tus secretos, APP_USERNAME, APP_PASSWORD y NODE_ENV=production
chmod 600 .env
docker compose up -d --build
```

El `docker-compose.yml` escucha solo en `127.0.0.1:3000` para no publicar directamente un puerto sin HTTPS. El proxy HTTPS debe apuntar a `127.0.0.1:3000`.

**Opción plataforma Docker administrada:** conecta el repositorio, elige Dockerfile, configura las variables anteriores y adjunta almacenamiento persistente a `/app/uploads` y `/app/outputs` si el proveedor lo permite. Si no tiene almacenamiento persistente, los archivos y vídeos pueden desaparecer al reiniciar o redeplegar. Consulta límites de subida, tiempos máximos de petición y almacenamiento del plan antes de usar vídeos grandes.

## 5. Verificar

1. Abre el dominio HTTPS del despliegue.
2. Introduce usuario y contraseña cuando el navegador los pida.
3. Comprueba que el estado indique «Sistema configurado».
4. Sube un vídeo **corto, propio y con audio** para una prueba inicial. El análisis real consume créditos de API.
5. Espera el resultado y descarga un MP4.

## Limitaciones de esta versión

- Sin seguimiento automático de rostros; el recorte es centrado.
- Los trabajos están en memoria: al reiniciar el servidor se pierden sus estados. Los archivos se conservan solo según el almacenamiento configurado y el plazo de limpieza.
- Los vídeos y resultados se eliminan automáticamente cuando vence la retención y el servidor está en ejecución (24 h por defecto); conserva tus descargas.
- No incluye registro de usuarios, colas distribuidas, antivirus, facturación, límites por cuenta ni recuperación automática de trabajos.
- Para ofrecer un servicio **público a múltiples clientes** hace falta una fase adicional de arquitectura y seguridad. **No elimines la autenticación** para compartirlo públicamente.
- La importación de YouTube solo es para contenido propio o autorizado y puede fallar por restricciones del proveedor.
