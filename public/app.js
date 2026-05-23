const tabButtons = [...document.querySelectorAll("[data-tab]")];
const tabPanels = [...document.querySelectorAll(".tab-panel")];
const kitTabButtons = [...document.querySelectorAll("[data-kit-tab]")];
const kitSubpanels = [...document.querySelectorAll(".kit-subpanel")];
const topbarTitle = document.querySelector("#topbarTitle");
const topbarDescription = document.querySelector("#topbarDescription");
const resumeFileInput = document.querySelector("#resumeFileInput");
const resumeFileLabel = document.querySelector("#resumeFileLabel");
const resumeImportNote = document.querySelector("#resumeImportNote");
const jobUrlInput = document.querySelector("#jobUrlInput");
const companyNameInput = document.querySelector("#companyNameInput");
const jobTextInput = document.querySelector("#jobTextInput");
const writingToneSelect = document.querySelector("#writingToneSelect");
const generateKitButton = document.querySelector("#generateKitButton");
const manualPasteWarning = document.querySelector("#manualPasteWarning");
const analysisProgress = document.querySelector("#analysisProgress");
const progressLabel = document.querySelector("#progressLabel");
const progressPercent = document.querySelector("#progressPercent");
const progressBar = document.querySelector("#progressBar");
const kitEmpty = document.querySelector("#kitEmpty");
const kitOutput = document.querySelector("#kitOutput");
const outputJobTitle = document.querySelector("#outputJobTitle");
const outputJobMeta = document.querySelector("#outputJobMeta");
const outputSourceNote = document.querySelector("#outputSourceNote");
const fitScore = document.querySelector("#fitScore");
const fitSummary = document.querySelector("#fitSummary");
const strongMatchesList = document.querySelector("#strongMatchesList");
const gapsList = document.querySelector("#gapsList");
const applicationStrategy = document.querySelector("#applicationStrategy");
const companyResearchMeta = document.querySelector("#companyResearchMeta");
const companyResearchList = document.querySelector("#companyResearchList");
const resumeSuggestionsList = document.querySelector("#resumeSuggestionsList");
const coverLetterSubject = document.querySelector("#coverLetterSubject");
const coverLetterBody = document.querySelector("#coverLetterBody");
const applicationEmailSubject = document.querySelector("#applicationEmailSubject");
const applicationEmailBody = document.querySelector("#applicationEmailBody");
const saveKitButton = document.querySelector("#saveKitButton");
const savedList = document.querySelector("#savedList");
const toast = document.querySelector("#toast");

let activeKitPayload = null;
let savedKitCache = [];
let progressTimer = null;
let progressStageIndex = 0;
let progressValue = 0;

const progressStages = [
  { label: "Reading resume evidence...", target: 18 },
  { label: "Parsing job content...", target: 36 },
  { label: "Researching the company online...", target: 58 },
  { label: "Matching resume, role, and company context...", target: 78 },
  { label: "Writing cover letter and email...", target: 92 }
];

const tabCopy = {
  studio: {
    title: "Turn one job post into a sharper application",
    description:
      "Upload a resume, paste the role, and let AI produce fit analysis, resume revisions, a dedicated cover letter, and a recruiter-ready email."
  },
  kit: {
    title: "Review the generated application kit",
    description: "Move between analysis, resume revisions, cover letter, and email without losing the target role context."
  },
  tracker: {
    title: "Track saved application kits",
    description: "Keep generated application materials together for follow-up and final review."
  }
};

function switchTab(tabId) {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tabId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.id === tabId;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  const copy = tabCopy[tabId] || tabCopy.studio;
  topbarTitle.textContent = copy.title;
  topbarDescription.textContent = copy.description;
}

function switchKitTab(tabId) {
  kitTabButtons.forEach((button) => {
    const isActive = button.dataset.kitTab === tabId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  kitSubpanels.forEach((panel) => {
    const isActive = panel.id === `kit-panel-${tabId}`;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}

function textToHtml(value) {
  const paragraphs = String(value || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (!paragraphs.length) return "<p>No copy generated.</p>";
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`).join("");
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.data = data;
    throw error;
  }
  return data;
}

async function postFormData(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    body: payload
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function setProgress(value, label) {
  const safeValue = Math.max(0, Math.min(100, Math.round(value)));
  progressValue = safeValue;
  progressLabel.textContent = label;
  progressPercent.textContent = `${safeValue}%`;
  progressBar.style.width = `${safeValue}%`;
}

function startProgress() {
  window.clearInterval(progressTimer);
  progressStageIndex = 0;
  analysisProgress.hidden = false;
  setProgress(4, progressStages[0].label);

  progressTimer = window.setInterval(() => {
    const stage = progressStages[progressStageIndex] || progressStages.at(-1);
    if (progressValue < stage.target) {
      setProgress(progressValue + Math.max(1, Math.round((stage.target - progressValue) / 5)), stage.label);
      return;
    }
    if (progressStageIndex < progressStages.length - 1) {
      progressStageIndex += 1;
      setProgress(progressValue + 1, progressStages[progressStageIndex].label);
    }
  }, 520);
}

function finishProgress(label = "Application kit ready.") {
  window.clearInterval(progressTimer);
  setProgress(100, label);
  window.setTimeout(() => {
    analysisProgress.hidden = true;
  }, 900);
}

function failProgress(label = "Generation stopped.") {
  window.clearInterval(progressTimer);
  setProgress(progressValue || 100, label);
}

function renderList(target, items) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  target.innerHTML = safeItems.length
    ? safeItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>No items generated.</li>";
}

function renderSuggestions(suggestions) {
  const safeSuggestions = Array.isArray(suggestions) ? suggestions : [];
  resumeSuggestionsList.innerHTML = safeSuggestions.length
    ? safeSuggestions
        .map(
          (suggestion) => `
            <article class="suggestion-card">
              <strong>${escapeHtml(suggestion.section || "Resume section")}</strong>
              <p>${escapeHtml(suggestion.problem || "No problem statement generated.")}</p>
              <div>${escapeHtml(suggestion.suggestedRevision || "No revision generated.")}</div>
              <small>${escapeHtml(suggestion.reason || "")}</small>
            </article>
          `
        )
        .join("")
    : '<p class="muted">No resume revisions generated.</p>';
}

function renderCompanyResearch(companyResearch) {
  const results = Array.isArray(companyResearch?.results) ? companyResearch.results : [];
  const warning = companyResearch?.warning;
  const query = companyResearch?.query;
  companyResearchMeta.textContent = warning
    ? `${warning}${query ? ` Query: ${query}` : ""}`
    : `Used ${results.length} ${companyResearch?.provider || "search"} result${results.length === 1 ? "" : "s"} for company context. Query: ${query || "not available"}`;

  companyResearchList.innerHTML = results.length
    ? results
        .map(
          (result) => `
            <article class="company-research-item">
              <strong>${escapeHtml(result.title || "Untitled source")}</strong>
              ${result.url ? `<a href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(result.url)}</a>` : ""}
              <p>${escapeHtml(result.snippet || "No snippet returned.")}</p>
            </article>
          `
        )
        .join("")
    : '<p class="muted">No company search snippets were available for this run.</p>';
}

function renderKit(payload) {
  const { kit, source, resume, companyResearch } = payload;
  const job = kit.job || {};
  const fit = kit.fitAnalysis || {};

  kitEmpty.style.display = "none";
  kitOutput.hidden = false;
  outputJobTitle.textContent = job.title || "Untitled role";
  outputJobMeta.textContent = `${job.company || "Unknown company"} - ${job.location || "Not specified"}`;
  outputSourceNote.textContent = `${source?.type === "manual" ? "Generated from pasted job content" : "Generated from job URL"}${
    resume?.filename ? ` using ${resume.filename}` : ""
  }. ${companyResearch?.results?.length ? `Company research used ${companyResearch.results.length} search results.` : companyResearch?.warning || ""}`.trim();
  fitScore.textContent = `${fit.overallScore || 0}/100`;
  fitSummary.textContent = fit.fitSummary || "No fit summary generated.";
  renderList(strongMatchesList, fit.strongMatches);
  renderList(gapsList, fit.gaps);
  applicationStrategy.textContent = fit.applicationStrategy || "No application strategy generated.";
  renderCompanyResearch(companyResearch);
  renderSuggestions(kit.resumeSuggestions);
  coverLetterSubject.textContent = kit.coverLetter?.subject || "Cover letter";
  coverLetterBody.innerHTML = textToHtml(kit.coverLetter?.body);
  applicationEmailSubject.textContent = kit.applicationEmail?.subject || "Application email";
  applicationEmailBody.innerHTML = textToHtml(kit.applicationEmail?.body);
  switchKitTab("analysis");
  switchTab("kit");
}

function openSavedKit(savedKit) {
  if (!savedKit?.kit) {
    showToast("Saved kit could not be opened.");
    return;
  }

  activeKitPayload = {
    kit: savedKit.kit,
    source: savedKit.source || null,
    resume: savedKit.resume || null,
    companyResearch: savedKit.companyResearch || null
  };
  saveKitButton.disabled = false;
  renderKit(activeKitPayload);
  showToast(`${savedKit.kit.job?.title || "Application kit"} opened.`);
}

async function generateApplicationKit() {
  const file = resumeFileInput.files[0];
  const jobUrl = jobUrlInput.value.trim();
  const companyName = companyNameInput.value.trim();
  const jobText = jobTextInput.value.trim();

  if (!file) {
    showToast("Upload a resume first.");
    resumeImportNote.textContent = "A resume is required before generating an application kit.";
    return;
  }
  if (!jobUrl && !jobText) {
    showToast("Paste a job URL or hiring content.");
    return;
  }

  const formData = new FormData();
  formData.append("resume", file);
  formData.append("jobUrl", jobUrl);
  formData.append("companyName", companyName);
  formData.append("jobText", jobText);
  formData.append("writingTone", writingToneSelect.value);

  generateKitButton.disabled = true;
  saveKitButton.disabled = true;
  manualPasteWarning.hidden = true;
  resumeImportNote.textContent = `Using ${file.name}. Generating application kit...`;
  startProgress();
  showToast("Generating application kit...");

  try {
    const data = await postFormData("/api/analyze-application", formData);
    activeKitPayload = data;
    renderKit(data);
    saveKitButton.disabled = false;
    resumeImportNote.textContent = `Generated from ${data.resume.filename}. Resume characters extracted: ${data.resume.extractedCharacters}.`;
    finishProgress("Application kit ready.");
    showToast("Application kit ready.");
  } catch (error) {
    if (error.data?.needsManualPaste) {
      manualPasteWarning.hidden = false;
    }
    failProgress(error.message);
    showToast(error.message);
  } finally {
    generateKitButton.disabled = false;
  }
}

async function saveApplicationKit() {
  if (!activeKitPayload) {
    showToast("Generate an application kit before saving.");
    return;
  }

  const data = await postJson("/api/save-application-kit", activeKitPayload);
  renderSavedKits(data.savedApplicationKits);
  switchTab("tracker");
  showToast(`${data.savedKit.kit.job.title} saved to tracker.`);
}

function renderSavedKits(savedKits) {
  savedKitCache = Array.isArray(savedKits) ? savedKits : [];
  if (!savedKits.length) {
    savedList.innerHTML = '<p class="muted">No saved application kits yet.</p>';
    return;
  }

  savedList.innerHTML = savedKitCache
    .map((savedKit, index) => {
      const kit = savedKit.kit || {};
      const job = kit.job || {};
      const fit = kit.fitAnalysis || {};
      return `
        <button type="button" class="saved-item" data-open-saved-kit="${index}">
          <strong>${escapeHtml(job.title || "Untitled role")}</strong>
          <span>${escapeHtml(job.company || "Unknown company")} - ${escapeHtml(job.location || "Not specified")} - ${escapeHtml(savedKit.status || "Saved")}</span>
          <small>${escapeHtml(fit.overallScore || 0)}/100 - ${escapeHtml(kit.applicationEmail?.subject || "Application email generated")}</small>
        </button>
      `;
    })
    .join("");

  savedList.querySelectorAll("[data-open-saved-kit]").forEach((button) => {
    button.addEventListener("click", () => {
      openSavedKit(savedKitCache[Number(button.dataset.openSavedKit)]);
    });
  });
}

async function loadSavedKits() {
  const response = await fetch("/api/saved-application-kits");
  const data = await response.json();
  renderSavedKits(data.savedApplicationKits || []);
}

resumeFileInput.addEventListener("change", () => {
  const file = resumeFileInput.files[0];
  resumeFileLabel.textContent = file ? file.name : "Choose resume file";
  resumeImportNote.textContent = file
    ? "Ready. Add a job URL or paste the job content."
    : "Choose a resume before generating the application kit.";
});

generateKitButton.addEventListener("click", () => {
  generateApplicationKit().catch((error) => showToast(error.message));
});

saveKitButton.addEventListener("click", () => {
  saveApplicationKit().catch((error) => showToast(error.message));
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

kitTabButtons.forEach((button) => {
  button.addEventListener("click", () => switchKitTab(button.dataset.kitTab));
});

loadSavedKits().catch(() => {
  savedList.innerHTML = '<p class="muted">Saved kits could not be loaded.</p>';
});
