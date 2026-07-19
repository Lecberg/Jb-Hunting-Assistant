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
const progressSteps = document.querySelector("#progressSteps");
const kitEmpty = document.querySelector("#kitEmpty");
const kitOutput = document.querySelector("#kitOutput");
const outputJobTitle = document.querySelector("#outputJobTitle");
const outputJobMeta = document.querySelector("#outputJobMeta");
const outputSourceNote = document.querySelector("#outputSourceNote");
const fitScore = document.querySelector("#fitScore");
const fitVisual = document.querySelector("#fitVisual");
const fitRingValue = document.querySelector("#fitRingValue");
const fitVerdict = document.querySelector("#fitVerdict");
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

const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "kit";

let activeKitPayload = null;
let savedKitCache = [];
let progressTimer = null;
let progressStageIndex = 0;
let progressValue = 0;

const progressStages = [
  { label: "Reading resume", target: 18 },
  { label: "Parsing job post", target: 36 },
  { label: "Researching company", target: 58 },
  { label: "Scoring fit against role", target: 78 },
  { label: "Writing cover letter & email", target: 92 }
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

async function parseJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Request failed (status ${response.status}).`);
  }
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
  return parseJsonResponse(response);
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

function renderProgressSteps(activeIndex, allDone = false) {
  [...progressSteps.children].forEach((step, index) => {
    step.dataset.state = allDone || index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
  });
}

function startProgress() {
  window.clearInterval(progressTimer);
  progressStageIndex = 0;
  analysisProgress.hidden = false;
  progressSteps.innerHTML = progressStages
    .map((stage) => `<li data-state="pending">${escapeHtml(stage.label)}</li>`)
    .join("");
  renderProgressSteps(0);
  setProgress(4, `${progressStages[0].label}...`);

  progressTimer = window.setInterval(() => {
    const stage = progressStages[progressStageIndex] || progressStages.at(-1);
    if (progressValue < stage.target) {
      setProgress(progressValue + Math.max(1, Math.round((stage.target - progressValue) / 5)), `${stage.label}...`);
      return;
    }
    if (progressStageIndex < progressStages.length - 1) {
      progressStageIndex += 1;
      renderProgressSteps(progressStageIndex);
      setProgress(progressValue + 1, `${progressStages[progressStageIndex].label}...`);
    }
  }, 520);
}

function finishProgress(label = "Application kit ready.") {
  window.clearInterval(progressTimer);
  renderProgressSteps(progressStages.length, true);
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
    : '<li class="chip-empty">No items generated.</li>';
}

const FIT_RING_CIRCUMFERENCE = 2 * Math.PI * 52;

function scoreBand(score) {
  if (score >= 75) return "strong";
  if (score >= 50) return "stretch";
  return "long";
}

const fitVerdicts = {
  strong: "Strong fit",
  stretch: "Stretch fit",
  long: "Long shot"
};

function animateNumber(target, finalValue, duration = 900) {
  const start = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    target.textContent = String(Math.round(finalValue * eased));
    if (progress < 1) window.requestAnimationFrame(frame);
  }
  window.requestAnimationFrame(frame);
  // rAF is suspended in hidden tabs; guarantee the final value regardless.
  window.setTimeout(() => {
    target.textContent = String(finalValue);
  }, duration + 150);
}

function setFitScore(score) {
  const safeScore = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const band = scoreBand(safeScore);
  fitVisual.dataset.band = band;
  fitVerdict.textContent = fitVerdicts[band];
  if (DEMO_MODE) {
    fitRingValue.style.transition = "none";
    fitRingValue.style.strokeDashoffset = String(FIT_RING_CIRCUMFERENCE * (1 - safeScore / 100));
    fitScore.textContent = String(safeScore);
    return;
  }
  fitRingValue.style.transition = "none";
  fitRingValue.style.strokeDashoffset = String(FIT_RING_CIRCUMFERENCE);
  void fitRingValue.getBoundingClientRect();
  fitRingValue.style.transition = "";
  animateNumber(fitScore, safeScore);
  window.setTimeout(() => {
    fitRingValue.style.strokeDashoffset = String(FIT_RING_CIRCUMFERENCE * (1 - safeScore / 100));
  }, 40);
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

function safeHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
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
        .map((result) => {
          const url = safeHttpUrl(result.url);
          return `
            <article class="company-research-item">
              <strong>${escapeHtml(result.title || "Untitled source")}</strong>
              ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a>` : ""}
              <p>${escapeHtml(result.snippet || "No snippet returned.")}</p>
            </article>
          `;
        })
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
  setFitScore(fit.overallScore);
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
  kitOutput.classList.remove("reveal");
  void kitOutput.offsetWidth;
  kitOutput.classList.add("reveal");
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

const SAVED_KITS_STORAGE_KEY = "careerpilot.savedKits.v1";
const SAVED_KITS_MAX = 30;

function readSavedKits() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_KITS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedKits(kits) {
  try {
    localStorage.setItem(SAVED_KITS_STORAGE_KEY, JSON.stringify(kits));
    return true;
  } catch {
    showToast("Browser storage is full. Older saved kits could not be kept.");
    return false;
  }
}

function saveApplicationKit() {
  if (!activeKitPayload) {
    showToast("Generate an application kit before saving.");
    return;
  }

  const savedKit = {
    id: `kit_${Date.now()}`,
    kit: activeKitPayload.kit,
    source: activeKitPayload.source || null,
    resume: activeKitPayload.resume || null,
    companyResearch: activeKitPayload.companyResearch || null,
    savedAt: new Date().toISOString(),
    status: "Generated"
  };
  const savedKits = [savedKit, ...readSavedKits()].slice(0, SAVED_KITS_MAX);
  if (!writeSavedKits(savedKits)) return;
  renderSavedKits(savedKits);
  switchTab("tracker");
  showToast(`${savedKit.kit.job?.title || "Application kit"} saved to tracker.`);
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

saveKitButton.addEventListener("click", saveApplicationKit);

const copySources = {
  cover: () => [coverLetterSubject, coverLetterBody],
  email: () => [applicationEmailSubject, applicationEmailBody]
};

document.querySelectorAll("[data-copy-source]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (!activeKitPayload) {
      showToast("Generate an application kit first.");
      return;
    }
    const [subjectElement, bodyElement] = copySources[button.dataset.copySource]();
    const text = `${subjectElement.textContent}\n\n${bodyElement.innerText}`.trim();
    try {
      await navigator.clipboard.writeText(text);
      button.classList.add("copied");
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.classList.remove("copied");
        button.textContent = "Copy text";
      }, 1600);
    } catch {
      showToast("Copy failed. Select the text manually.");
    }
  });
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

kitTabButtons.forEach((button) => {
  button.addEventListener("click", () => switchKitTab(button.dataset.kitTab));
});

renderSavedKits(readSavedKits());

// Demo mode: /?demo=kit stages the kit view with sample data for screenshots.
if (DEMO_MODE) {
  activeKitPayload = {
    kit: {
      job: { title: "Senior Frontend Engineer", company: "Acme Infrastructure", location: "Remote (EU)" },
      fitAnalysis: {
        overallScore: 82,
        fitSummary:
          "Strong overlap on React, TypeScript, and design-system work. The resume shows direct experience with the component library migration this role owns, and the accessibility background matches a stated team priority.",
        strongMatches: ["React + TypeScript", "Design systems", "Accessibility (WCAG 2.2)", "Frontend performance"],
        gaps: ["No GraphQL on resume", "Kubernetes exposure unclear"],
        applicationStrategy:
          "Lead with the design-system migration story and quantify the performance wins. Address the GraphQL gap directly in the cover letter by pointing to comparable API-layer work."
      },
      resumeSuggestions: [
        {
          section: "Experience - Frontend Platform",
          problem: "The migration bullet lists tasks without outcomes.",
          suggestedRevision:
            "Led the migration of a 40-component design system to React 18 and TypeScript, cutting UI defect reports by 31% quarter over quarter.",
          reason: "Mirrors the role's core responsibility and adds a measurable result."
        },
        {
          section: "Skills",
          problem: "GraphQL is absent even though adjacent API experience exists.",
          suggestedRevision: "Add a line for API integration work: REST, tRPC, and schema-first design with OpenAPI.",
          reason: "Softens the GraphQL gap by showing comparable API-layer depth."
        }
      ],
      coverLetter: {
        subject: "Application for Senior Frontend Engineer - Acme Infrastructure",
        body: "Dear Acme Infrastructure team,\n\nYour posting for a Senior Frontend Engineer stood out because it centers on the exact work I have spent the last three years doing: moving a large product onto a modern design system without slowing feature delivery.\n\nAt my current company I led a 40-component migration to React 18 and TypeScript while the product kept shipping weekly. The result was a 31% drop in UI defects and a measurably faster onboarding path for new engineers. Accessibility was not an afterthought: the system ships WCAG 2.2 AA checks in CI.\n\nI would welcome the chance to bring that playbook to Acme's platform team.\n\nBest regards,\nJordan Reyes"
      },
      applicationEmail: {
        subject: "Senior Frontend Engineer application - Jordan Reyes",
        body: "Hi Acme Infrastructure recruiting team,\n\nI just submitted my application for the Senior Frontend Engineer role. My background centers on design-system migrations in React and TypeScript, with a strong accessibility track record that matches the priorities in your posting.\n\nMy resume and cover letter are attached. Happy to share more context whenever useful.\n\nThanks,\nJordan Reyes"
      }
    },
    source: { type: "manual" },
    resume: { filename: "resume.pdf" },
    companyResearch: {
      provider: "brave",
      query: "Acme Infrastructure company",
      results: [
        {
          title: "Acme Infrastructure raises Series C to expand European platform",
          url: "https://example.com/acme-series-c",
          snippet: "Acme Infrastructure announced a Series C round to grow its managed platform business across the EU."
        }
      ]
    }
  };
  saveKitButton.disabled = false;
  renderKit(activeKitPayload);
  // Skip the entrance animation so captures are deterministic.
  kitOutput.classList.remove("reveal");
}
