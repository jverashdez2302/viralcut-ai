const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let selectedFile = null;
let currentJobId = null;
let pollTimer = null;
let currentClips = [];
let editingClipId = null;
let currentJob = null;
let previewObjectUrl = null;

function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.remove("hidden");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add("hidden"), 3200);
}
function showError(message, target = "#uploadError") {
  const el = $(target); el.textContent = message; el.classList.remove("hidden");
}
function clearError(target = "#uploadError") { $(target).classList.add("hidden"); }
function fmtTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 60)).padStart(2,"0")}:${String(n % 60).padStart(2,"0")}`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

$$(".source-tab").forEach(btn => btn.addEventListener("click", () => {
  $$(".source-tab").forEach(b => b.classList.toggle("active", b === btn));
  $("#uploadPanel").classList.toggle("hidden", btn.dataset.tab !== "upload");
  $("#youtubePanel").classList.toggle("hidden", btn.dataset.tab !== "youtube");
  validateStart();
}));
$("#videoFile").addEventListener("change", e => setFile(e.target.files[0]));
function setFile(file) {
  selectedFile = file || null;
  $("#fileName").textContent = selectedFile ? `${selectedFile.name} · ${(selectedFile.size / 1024 / 1024).toFixed(1)} MB` : "";
  const preview = $("#sourcePreview");
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  preview.classList.add("hidden");
  preview.removeAttribute("src");
  if (selectedFile && selectedFile.type.startsWith("video/")) {
    previewObjectUrl = URL.createObjectURL(selectedFile);
    preview.src = previewObjectUrl;
    preview.classList.remove("hidden");
  }
  validateStart();
}
["dragenter","dragover"].forEach(ev => $("#dropzone").addEventListener(ev, e => { e.preventDefault(); $("#dropzone").classList.add("dragover"); }));
["dragleave","drop"].forEach(ev => $("#dropzone").addEventListener(ev, e => { e.preventDefault(); $("#dropzone").classList.remove("dragover"); }));
$("#dropzone").addEventListener("drop", e => { const f = e.dataTransfer.files?.[0]; if (f) setFile(f); });
$("#youtubeUrl").addEventListener("input", validateStart);
$("#authorized").addEventListener("change", validateStart);

function activeTab() { return $(".source-tab.active")?.dataset.tab || "upload"; }
function validateStart() {
  const valid = activeTab() === "upload" ? !!selectedFile : !!$("#youtubeUrl").value.trim() && $("#authorized").checked;
  $("#startBtn").disabled = !valid;
}
$("#startBtn").addEventListener("click", startProcessing);

async function startProcessing() {
  clearError(); $("#startBtn").disabled = true;
  try {
    let response;
    $("#processing").classList.remove("hidden");
    $("#results").classList.add("hidden");
    $("#processing").scrollIntoView({ behavior: "smooth", block: "center" });
    let data;
    if (activeTab() === "upload") {
      data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const form = new FormData(); form.append("video", selectedFile);
        xhr.open("POST", "/api/jobs/upload");
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            $("#progressPercent").textContent = `${percent}%`;
            $("#progressBar").style.width = `${percent}%`;
            $("#processingTitle").textContent = "Subiendo tu video...";
            $("#processingMessage").textContent = `Transferencia del archivo: ${percent}%`;
            $("#processingStatus").textContent = "Subiendo archivo";
          }
        };
        xhr.onload = () => {
          let result = {};
          try { result = JSON.parse(xhr.responseText || "{}"); } catch {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(result);
          else reject(new Error(result.error || "No se pudo subir el video."));
        };
        xhr.onerror = () => reject(new Error("Se interrumpió la carga del archivo."));
        xhr.send(form);
      });
    } else {
      response = await fetch("/api/jobs/youtube", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: $("#youtubeUrl").value.trim(), authorized: $("#authorized").checked })
      });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo iniciar el proceso.");
    }
    currentJobId = data.jobId;
    pollJob();
  } catch (err) {
    showError(err.message);
    $("#processing").classList.add("hidden");
    $("#startBtn").disabled = false;
  }
}

async function pollJob() {
  clearInterval(pollTimer);
  const poll = async () => {
    if (!currentJobId) return;
    try {
      const response = await fetch(`/api/jobs/${currentJobId}`);
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || "No se pudo consultar el trabajo.");
      currentJob = job;
      renderProgress(job);
      if (job.status === "completed") {
        clearInterval(pollTimer);
        currentClips = job.clips || [];
        renderClips();
        $("#results").classList.remove("hidden");
        $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
        $("#startBtn").disabled = false;
      } else if (["error","cancelled"].includes(job.status)) {
        clearInterval(pollTimer);
        showError(job.error || job.message, "#uploadError");
        $("#startBtn").disabled = false;
      }
    } catch (err) { clearInterval(pollTimer); showError(err.message); $("#startBtn").disabled = false; }
  };
  await poll();
  if (currentJob && !["completed", "error", "cancelled"].includes(currentJob.status)) {
    pollTimer = setInterval(poll, 1800);
  }
}
function renderProgress(job) {
  $("#progressPercent").textContent = `${job.progress || 0}%`;
  $("#progressBar").style.width = `${job.progress || 0}%`;
  $("#processingMessage").textContent = job.message || "Procesando...";
  const names = { queued:"En cola", downloading:"Importando video", metadata:"Revisando archivo", extracting:"Preparando audio", transcribing:"Transcribiendo", analyzing:"Análisis inteligente", rendering:"Creando clips", completed:"Completado", error:"Error", cancelled:"Cancelado" };
  $("#processingStatus").textContent = names[job.status] || job.status;
  $("#processingTitle").textContent = job.status === "completed" ? "¡Tus clips están listos!" : job.status === "error" ? "No se pudo completar" : "Analizando tu contenido...";
  $("#cancelBtn").classList.toggle("hidden", ["completed","error","cancelled"].includes(job.status));
}
$("#cancelBtn").addEventListener("click", async () => {
  if (!currentJobId) return;
  await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
  toast("Se solicitó cancelar el proceso.");
});

function renderClips() {
  $("#clipCount").textContent = `${currentClips.length} clips generados`;
  $("#resultsSummary").textContent = `${currentJob?.sourceName || "Tu video"} · ${currentClips.length} momentos detectados y renderizados en formato vertical.`;
  $("#clipsGrid").innerHTML = currentClips.map((clip, i) => `
    <article class="clip-card">
      <div class="clip-thumb">
        <button class="thumb-play" data-preview="${clip.id}" aria-label="Previsualizar clip">▶</button>
        <span class="score">✦ ${clip.score}/100</span>
        <span class="duration">${fmtTime(clip.duration || clip.end - clip.start)}</span>
        <span class="platform-chip">${esc(clip.platform || "Reels")}</span>
      </div>
      <div class="clip-info">
        <h3 title="${esc(clip.title)}">${esc(clip.title)}</h3>
        <p>${esc(clip.description || clip.hook || "Momento seleccionado por análisis de IA.")}</p>
        <div class="clip-meta"><span>${fmtTime(clip.start)} – ${fmtTime(clip.end)}</span><span>${clip.rendered ? "✓ Renderizado" : "Pendiente"}</span></div>
        <div class="clip-actions">
          <button class="edit-btn" data-edit="${clip.id}">✎ Editar</button>
          <a href="${esc(clip.video || "#")}" ${clip.video ? `download="${esc(clip.fileName || "clip.mp4")}"` : ""} ${clip.video ? "" : "aria-disabled=true"}>↓ Descargar</a>
        </div>
      </div>
    </article>`).join("");
  $$("[data-edit]").forEach(b => b.addEventListener("click", () => openEditor(b.dataset.edit)));
  $$("[data-preview]").forEach(b => b.addEventListener("click", () => openEditor(b.dataset.preview, true)));
}
$("#downloadAll").addEventListener("click", async () => {
  if (!currentJobId) return;
  try {
    const response = await fetch(`/api/jobs/${currentJobId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipIds: currentClips.map(c => c.id) })
    });
    if (!response.ok) { const d = await response.json(); throw new Error(d.error || "No se pudo crear el ZIP."); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `viral-clips-${currentJobId.slice(0,8)}.zip`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) { toast(err.message); }
});

function openEditor(id, previewOnly = false) {
  const clip = currentClips.find(c => c.id === id); if (!clip) return;
  editingClipId = id;
  $("#editorTitle").textContent = previewOnly ? "Vista previa del clip" : "Editar clip";
  $("#editorVideo").src = clip.video || "";
  $("#editTitle").value = clip.title || "";
  $("#editStart").value = clip.start;
  $("#editEnd").value = clip.end;
  $("#editSubtitles").checked = true;
  $("#voiceText").value = "";
  $("#editorError").classList.add("hidden");
  $("#saveClip").classList.toggle("hidden", previewOnly);
  $("#editorModal").classList.remove("hidden");
}
function closeEditor() { $("#editorModal").classList.add("hidden"); $("#editorVideo").pause(); }
$("#closeEditor").addEventListener("click", closeEditor);
$(".modal-backdrop").addEventListener("click", closeEditor);
$("#saveClip").addEventListener("click", async () => {
  const clip = currentClips.find(c => c.id === editingClipId); if (!clip) return;
  const payload = {
    title: $("#editTitle").value,
    start: Number($("#editStart").value),
    end: Number($("#editEnd").value),
    subtitles: $("#editSubtitles").checked,
    voiceoverText: $("#voiceText").value,
    voice: $("#voiceSelect").value,
    audioMode: $("#audioMode").value
  };
  if (!(payload.end > payload.start)) return showError("El final debe ser mayor que el inicio.", "#editorError");
  $("#saveClip").disabled = true; $("#saveClip").textContent = "Renderizando...";
  try {
    const response = await fetch(`/api/jobs/${currentJobId}/clips/${editingClipId}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo volver a renderizar.");
    const index = currentClips.findIndex(c => c.id === editingClipId);
    currentClips[index] = data.clip;
    renderClips(); closeEditor(); toast("Clip actualizado correctamente.");
  } catch (err) { showError(err.message, "#editorError"); }
  finally { $("#saveClip").disabled = false; $("#saveClip").innerHTML = 'Guardar y volver a renderizar <span>→</span>'; }
});
$("#themeToggle").addEventListener("click", () => document.body.classList.toggle("light"));

fetch("/api/health").then(r => r.json()).then(h => {
  const status = $(".status-pill");
  if (status) status.lastChild.textContent = h.aiConfigured ? " Sistema configurado" : " Configuración pendiente";
  if (!h.aiConfigured) {
    const note = document.createElement("div");
    note.className = "field-note";
    note.style.margin = "12px 0 0";
    note.textContent = "Configuración pendiente: el administrador debe agregar OPENAI_API_KEY al archivo .env para habilitar transcripción y análisis reales.";
    $("#uploadPanel").append(note);
  }
}).catch(() => {});
