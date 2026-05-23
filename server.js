const http = require("node:http");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");
const { URL } = require("node:url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_BRAVE_SEARCH_API_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const savedApplicationKits = [];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 15 * 60 * 1000);
const SEARCH_RATE_LIMIT_WINDOW_MS = Number(process.env.SEARCH_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const SEARCH_RATE_LIMIT_MAX = Number(process.env.SEARCH_RATE_LIMIT_MAX || 12);
const JOB_PAGE_FETCH_TIMEOUT_MS = Number(process.env.JOB_PAGE_FETCH_TIMEOUT_MS || 8000);
const JOB_PAGE_MAX_BYTES = Number(process.env.JOB_PAGE_MAX_BYTES || 750000);
const JOB_PARSE_CACHE_TTL_MS = Number(process.env.JOB_PARSE_CACHE_TTL_MS || 30 * 60 * 1000);
const RESUME_UPLOAD_MAX_BYTES = Number(process.env.RESUME_UPLOAD_MAX_BYTES || 2_000_000);
const APPLICATION_REQUEST_MAX_BYTES = Number(process.env.APPLICATION_REQUEST_MAX_BYTES || RESUME_UPLOAD_MAX_BYTES + 1_000_000);
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

const searchCache = new Map();
const jobParseCache = new Map();
const rateLimitBuckets = new Map();

const DIRECT_ATS_HOST_PATTERNS = [
  /(^|\.)greenhouse\.io$/i,
  /^jobs\.lever\.co$/i,
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)bamboohr\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)workable\.com$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)recruitee\.com$/i,
  /(^|\.)personio\.com$/i,
  /(^|\.)successfactors\.com$/i
];

const THIRD_PARTY_JOB_HOST_PATTERNS = [
  /(^|\.)linkedin\.com$/i,
  /(^|\.)indeed\.com$/i,
  /(^|\.)glassdoor\.com$/i,
  /(^|\.)ziprecruiter\.com$/i,
  /(^|\.)monster\.com$/i,
  /(^|\.)simplyhired\.com$/i,
  /(^|\.)jooble\.org$/i,
  /(^|\.)talent\.com$/i,
  /(^|\.)careerjet\./i,
  /(^|\.)reed\.co\.uk$/i,
  /(^|\.)totaljobs\.com$/i,
  /(^|\.)jobsdb\.com$/i
];

const GENERIC_SEARCH_HOST_PATTERNS = [
  /(^|\.)google\./i,
  /(^|\.)bing\.com$/i,
  /(^|\.)duckduckgo\.com$/i,
  /(^|\.)yahoo\.com$/i
];

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipartFormData(req, bodyBuffer) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error("Resume upload must use multipart/form-data.");
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const body = bodyBuffer.toString("binary");
  const parts = body.split(boundary).slice(1, -1);
  const files = [];
  const fields = {};

  for (const part of parts) {
    const trimmedPart = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const separatorIndex = trimmedPart.indexOf("\r\n\r\n");
    if (separatorIndex === -1) continue;

    const rawHeaders = trimmedPart.slice(0, separatorIndex);
    const rawContent = trimmedPart.slice(separatorIndex + 4);
    const headers = {};

    for (const headerLine of rawHeaders.split("\r\n")) {
      const colonIndex = headerLine.indexOf(":");
      if (colonIndex === -1) continue;
      headers[headerLine.slice(0, colonIndex).trim().toLowerCase()] = headerLine.slice(colonIndex + 1).trim();
    }

    const disposition = headers["content-disposition"] || "";
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    const content = Buffer.from(rawContent, "binary");

    if (filename) {
      files.push({
        name,
        filename: path.basename(filename),
        contentType: headers["content-type"] || "application/octet-stream",
        buffer: content
      });
    } else if (name) {
      fields[name] = content.toString("utf8");
    }
  }

  return { files, fields };
}

function unique(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return unique(value);
  }
  return unique(String(value || "").split(","));
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local")
    .split(",")[0]
    .trim();
}

function consumeSearchRateLimit(req) {
  const clientIp = getClientIp(req);
  const now = Date.now();
  const bucket = rateLimitBuckets.get(clientIp) || { count: 0, resetAt: now + SEARCH_RATE_LIMIT_WINDOW_MS };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + SEARCH_RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(clientIp, bucket);

  return {
    allowed: bucket.count <= SEARCH_RATE_LIMIT_MAX,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

function analyzeProfile(profile) {
  const targetRoles = normalizeList(profile.targetRoles);
  const targetRegions = normalizeList(profile.targetRegions);
  const targetIndustries = normalizeList(profile.targetIndustries);
  const technicalSkills = normalizeList(profile.technicalSkills);
  const domainSkills = normalizeList(profile.domainSkills);
  const projects = String(profile.projects || "");

  const strengths = [];
  if (technicalSkills.length) strengths.push(`Technical evidence in ${technicalSkills.slice(0, 4).join(", ")}`);
  if (domainSkills.length) strengths.push(`Domain focus around ${domainSkills.slice(0, 4).join(", ")}`);
  if (projects) strengths.push("Project evidence that can support application materials");
  if (targetRegions.length) strengths.push(`Clear regional targets: ${targetRegions.join(", ")}`);

  const gaps = [];
  if (!targetRoles.length) gaps.push("Add at least one target role.");
  if (!targetRegions.length) gaps.push("Add at least one target region.");
  if (technicalSkills.length < 3) gaps.push("Add more technical skills for better job matching.");
  if (!projects) gaps.push("Add one or two project examples to strengthen recommendation reasons.");

  return {
    positioning: targetRoles.length
      ? `Positioned for ${targetRoles.slice(0, 3).join(", ")} roles with a ${targetIndustries.join(" / ") || "career-focused"} direction.`
      : "Profile needs target roles before strong positioning can be generated.",
    strengths,
    gaps,
    completeness: Math.min(
      100,
      20 +
        targetRoles.length * 10 +
        targetRegions.length * 10 +
        targetIndustries.length * 5 +
        technicalSkills.length * 4 +
        domainSkills.length * 4 +
        (projects ? 15 : 0)
    )
  };
}

function cleanExtractedText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlToText(xml) {
  return decodeHtmlEntities(
    String(xml || "")
      .replace(/<w:tab\/>/g, " ")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

function extractZipEntries(buffer) {
  const entries = new Map();
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;

  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("DOCX file could not be read as a ZIP archive.");
  }

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;

    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.slice(cursor + 46, cursor + 46 + fileNameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);

    let data;
    if (compressionMethod === 0) {
      data = compressed;
    } else if (compressionMethod === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      data = Buffer.alloc(0);
    }

    entries.set(fileName, data);
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractDocxText(buffer) {
  const entries = extractZipEntries(buffer);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) {
    throw new Error("DOCX file did not contain word/document.xml.");
  }
  return cleanExtractedText(xmlToText(documentXml.toString("utf8")));
}

function extractPdfText(buffer) {
  const fragments = [];
  const latinText = buffer.toString("latin1");

  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of latinText.matchAll(streamPattern)) {
    const streamBuffer = Buffer.from(match[1], "latin1");
    const candidates = [streamBuffer];
    try {
      candidates.push(zlib.inflateSync(streamBuffer));
    } catch {}
    try {
      candidates.push(zlib.inflateRawSync(streamBuffer));
    } catch {}

    for (const candidate of candidates) {
      const text = candidate.toString("latin1");
      for (const stringMatch of text.matchAll(/\((?:\\.|[^\\)])*\)/g)) {
        fragments.push(
          stringMatch[0]
            .slice(1, -1)
            .replace(/\\\)/g, ")")
            .replace(/\\\(/g, "(")
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\n")
            .replace(/\\t/g, " ")
        );
      }
    }
  }

  for (const stringMatch of latinText.matchAll(/\((?:\\.|[^\\)]){8,}\)/g)) {
    fragments.push(stringMatch[0].slice(1, -1));
  }

  const cleaned = cleanExtractedText(fragments.join("\n"));
  if (cleaned.length < 80) {
    throw new Error("Could not extract enough text from this PDF. Try exporting the resume as text-based PDF, DOCX, or TXT.");
  }
  return cleaned;
}

function extractResumeText(file) {
  const extension = path.extname(file.filename || "").toLowerCase();
  const contentType = String(file.contentType || "").toLowerCase();

  if (extension === ".txt" || contentType.includes("text/plain")) {
    return cleanExtractedText(file.buffer.toString("utf8"));
  }
  if (extension === ".docx" || contentType.includes("wordprocessingml")) {
    return extractDocxText(file.buffer);
  }
  if (extension === ".pdf" || contentType.includes("pdf")) {
    return extractPdfText(file.buffer);
  }

  throw new Error("Unsupported resume file type. Upload a PDF, DOCX, or TXT file.");
}

function coerceProfilePayload(value) {
  const profile = value && typeof value === "object" ? value : {};
  return {
    name: String(profile.name || ""),
    educationLevel: String(profile.educationLevel || "Student"),
    remotePreference: String(profile.remotePreference || "Any"),
    targetRoles: normalizeList(profile.targetRoles),
    targetRegions: normalizeList(profile.targetRegions),
    targetIndustries: normalizeList(profile.targetIndustries),
    technicalSkills: normalizeList(profile.technicalSkills),
    domainSkills: normalizeList(profile.domainSkills),
    projects: String(profile.projects || ""),
    searchKeywords: normalizeList(profile.searchKeywords)
  };
}

async function analyzeResumeWithLlm(resumeText) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured. Add it to .env before using resume analysis.");
  }

  const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4.1-mini";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract structured career-profile data from resumes. Return only valid JSON with keys: name, educationLevel, targetRoles, targetRegions, targetIndustries, technicalSkills, domainSkills, projects, searchKeywords. Use arrays for all multi-value fields. Do not invent facts. Prefer concise values suitable for an application-analysis profile."
        },
        {
          role: "user",
          content: `Extract profile fields from this resume text:\n\n${resumeText.slice(0, 18000)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM resume analysis failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM response did not include profile JSON.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM response was not valid JSON.");
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  return coerceProfilePayload(parsed);
}

function parseJsonFromLlmContent(content, emptyMessage = "LLM response did not include JSON.") {
  if (!content) {
    throw new Error(emptyMessage);
  }

  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("LLM response was not valid JSON.");
    }
    return JSON.parse(jsonMatch[0]);
  }
}

function normalizeGeneratedText(value) {
  return String(value || "").trim();
}

function normalizeGeneratedList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeGeneratedText(item)).filter(Boolean);
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function coerceApplicationKitPayload(value) {
  const kit = value && typeof value === "object" ? value : {};
  const job = kit.job && typeof kit.job === "object" ? kit.job : {};
  const fitAnalysis = kit.fitAnalysis && typeof kit.fitAnalysis === "object" ? kit.fitAnalysis : {};
  const coverLetter = kit.coverLetter && typeof kit.coverLetter === "object" ? kit.coverLetter : {};
  const applicationEmail = kit.applicationEmail && typeof kit.applicationEmail === "object" ? kit.applicationEmail : {};
  const suggestions = Array.isArray(kit.resumeSuggestions) ? kit.resumeSuggestions : [];

  return {
    job: {
      title: normalizeGeneratedText(job.title) || "Untitled role",
      company: normalizeGeneratedText(job.company) || "Unknown company",
      location: normalizeGeneratedText(job.location) || "Not specified",
      summary: normalizeGeneratedText(job.summary),
      responsibilities: normalizeGeneratedList(job.responsibilities),
      requirements: normalizeGeneratedList(job.requirements),
      keywords: normalizeGeneratedList(job.keywords)
    },
    fitAnalysis: {
      overallScore: clampScore(fitAnalysis.overallScore),
      fitSummary: normalizeGeneratedText(fitAnalysis.fitSummary),
      strongMatches: normalizeGeneratedList(fitAnalysis.strongMatches),
      gaps: normalizeGeneratedList(fitAnalysis.gaps),
      applicationStrategy: normalizeGeneratedText(fitAnalysis.applicationStrategy)
    },
    resumeSuggestions: suggestions
      .map((suggestion) => {
        const item = suggestion && typeof suggestion === "object" ? suggestion : {};
        return {
          section: normalizeGeneratedText(item.section),
          problem: normalizeGeneratedText(item.problem),
          suggestedRevision: normalizeGeneratedText(item.suggestedRevision),
          reason: normalizeGeneratedText(item.reason)
        };
      })
      .filter((suggestion) => suggestion.section || suggestion.problem || suggestion.suggestedRevision || suggestion.reason),
    coverLetter: {
      subject: normalizeGeneratedText(coverLetter.subject),
      body: normalizeGeneratedText(coverLetter.body)
    },
    applicationEmail: {
      subject: normalizeGeneratedText(applicationEmail.subject),
      body: normalizeGeneratedText(applicationEmail.body)
    }
  };
}

function summarizeCompanyResearch(companyResearch) {
  if (!companyResearch || !Array.isArray(companyResearch.results) || !companyResearch.results.length) {
    return companyResearch?.warning || "No company search results were available.";
  }

  return companyResearch.results
    .map((result, index) => {
      return [
        `${index + 1}. ${result.title}`,
        result.url ? `URL: ${result.url}` : "",
        result.snippet ? `Snippet: ${result.snippet}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

async function callApplicationKitLlm({ resumeText, jobText, jobUrl, companyName, writingTone, companyResearch }) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured. Add it to .env before generating an application kit.");
  }

  const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4.1-mini";
  const tone = normalizeGeneratedText(writingTone) || "Bold Professional";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.62,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are an elite job-application strategist and writing partner.",
            "Return only valid JSON matching this exact shape: {\"job\":{\"title\":\"\",\"company\":\"\",\"location\":\"\",\"summary\":\"\",\"responsibilities\":[],\"requirements\":[],\"keywords\":[]},\"fitAnalysis\":{\"overallScore\":0,\"fitSummary\":\"\",\"strongMatches\":[],\"gaps\":[],\"applicationStrategy\":\"\"},\"resumeSuggestions\":[{\"section\":\"\",\"problem\":\"\",\"suggestedRevision\":\"\",\"reason\":\"\"}],\"coverLetter\":{\"subject\":\"\",\"body\":\"\"},\"applicationEmail\":{\"subject\":\"\",\"body\":\"\"}}.",
            "Do not invent resume facts, employers, metrics, degrees, awards, dates, publications, visa status, or certifications.",
            "Tie every analysis point, resume revision, cover-letter claim, and email hook to evidence in the resume, job content, and company research snippets.",
            "Use company research to understand the corporation's products, positioning, business priorities, and current public narrative, but do not cite or imply facts that are not supported by the snippets.",
            "Avoid generic application phrases including: I am writing to express my interest, fast-paced environment, perfect fit, passionate about, strong team player, and detail-oriented.",
            "For the cover letter and application email, do not open with quantitative indexes, project-performance numbers, or detailed project mechanics. Metrics can appear later only if they are natural, brief, and clearly connected to the role.",
            "Do not let one or two past projects dominate the cover letter or email. Use project evidence selectively as supporting proof, not as the main storyline. Prefer a balanced mix of company understanding, role requirements, candidate direction, and one concise evidence point.",
            "The cover letter must open with a concrete company-and-role hook: show that the candidate understands what the company is trying to do and why this role matters. Then bridge into the candidate's relevant strengths. Keep detailed project explanation for the middle paragraph, and limit it to one compact example unless the job clearly demands more.",
            "The application email must be concise, recruiter-friendly, and not project-heavy. Its first sentence should name the role and offer a polished reason for fit based on company/role alignment, not a metric. Include at most one short evidence sentence from the resume.",
            "Adapt tone without changing this structure: Bold Professional is confident and sharp, Warm Storytelling is human and reflective, Formal Executive is polished and restrained. None of the tones should sound like a project report.",
            "Prefer vivid, truthful phrasing over common cover-letter templates. If evidence is missing, name the gap and suggest how to strengthen it instead of fabricating."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            `Writing tone: ${tone}`,
            jobUrl ? `Job URL: ${jobUrl}` : "Job URL: not provided",
            companyName ? `User-provided company name: ${companyName}` : "User-provided company name: not provided",
            `Company research from configured search API:\n${summarizeCompanyResearch(companyResearch)}`,
            `Resume text:\n${resumeText.slice(0, 18000)}`,
            `Job content:\n${jobText.slice(0, 18000)}`
          ].join("\n\n")
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM application analysis failed (${response.status}): ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const parsed = parseJsonFromLlmContent(data.choices?.[0]?.message?.content, "LLM response did not include application-kit JSON.");
  return coerceApplicationKitPayload(parsed);
}

function generateProfileJobSearchCriteria(profile) {
  const criteria = {
    targetJobTypes: normalizeList(profile.targetJobTypes),
    targetRegions: normalizeList(profile.targetRegions),
    targetRoles: normalizeList(profile.targetRoles),
    targetIndustries: normalizeList(profile.targetIndustries),
    searchKeywords: unique([
      ...normalizeList(profile.searchKeywords),
      ...normalizeList(profile.technicalSkills).slice(0, 4),
      ...normalizeList(profile.domainSkills).slice(0, 4)
    ]),
    excludedKeywords: normalizeList(profile.excludedKeywords),
    remotePreference: profile.remotePreference || "Any",
    experienceLevel: profile.experienceLevel || "Student",
    resultLimit: Number(profile.resultLimit || 20)
  };

  return criteria;
}

function generateQueries(criteria) {
  const roles = criteria.targetRoles.length ? criteria.targetRoles : ["Job"];
  const regions = criteria.targetRegions.length ? criteria.targetRegions : ["Remote"];
  const jobTypes = criteria.targetJobTypes.length ? criteria.targetJobTypes : ["Internship", "Graduate Role", "Full-time"];
  const keywords = criteria.searchKeywords.slice(0, 3).join(" ");
  const excluded = criteria.excludedKeywords.map((term) => `-${term}`).join(" ");
  const noisyExclusions = [
    "-site:linkedin.com",
    "-site:indeed.com",
    "-site:glassdoor.com",
    "-site:ziprecruiter.com",
    "-site:jooble.org",
    "-site:talent.com",
    "-salary",
    "-interview",
    "-template"
  ].join(" ");
  const directIntent = '(job OR careers OR "apply now" OR requisition)';
  const atsSites = [
    "site:greenhouse.io",
    "site:jobs.lever.co",
    "site:myworkdayjobs.com",
    "site:smartrecruiters.com",
    "site:ashbyhq.com",
    "site:bamboohr.com"
  ];

  const queries = [];
  for (const role of roles.slice(0, 4)) {
    for (const region of regions.slice(0, 3)) {
      for (const jobType of jobTypes.slice(0, 3)) {
        for (const site of atsSites) {
          queries.push(`${site} ${role} ${jobType} ${region} ${keywords} ${excluded}`.replace(/\s+/g, " ").trim());
        }
        const baseQuery = `${role} ${jobType} ${region} ${keywords} ${directIntent} ${noisyExclusions} ${excluded}`
          .replace(/\s+/g, " ")
          .trim();

        queries.push(baseQuery);
      }
    }
  }
  return unique(queries).slice(0, 12);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getHostname(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown source";
  }
}

function normalizeUrlForDedupe(value) {
  try {
    let url = new URL(value);
    const redirectTarget = ["url", "u", "q", "target"].map((key) => url.searchParams.get(key)).find((candidate) => {
      try {
        return candidate && /^https?:\/\//i.test(candidate) && new URL(candidate);
      } catch {
        return false;
      }
    });

    if (redirectTarget && GENERIC_SEARCH_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
      url = new URL(redirectTarget);
    }

    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    for (const key of [...url.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        [
          "fbclid",
          "gclid",
          "msclkid",
          "igshid",
          "ref",
          "ref_src",
          "source",
          "src",
          "campaign",
          "trk",
          "trackingId"
        ].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }

    const sortedParams = [...url.searchParams.entries()].sort(([keyA, valueA], [keyB, valueB]) =>
      `${keyA}=${valueA}`.localeCompare(`${keyB}=${valueB}`)
    );
    url.search = "";
    for (const [key, value] of sortedParams) {
      url.searchParams.append(key, value);
    }

    const normalized = url.toString().replace(/\/(?=\?|$)/, "");
    return normalized;
  } catch {
    return String(value || "").trim();
  }
}

function normalizeFingerprintTerm(value) {
  return stripHtml(value)
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\b(inc|ltd|limited|llc|plc|corp|corporation|company|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getDuplicateKey(result) {
  return [
    normalizeFingerprintTerm(result.title),
    normalizeFingerprintTerm(result.company),
    normalizeFingerprintTerm(result.location),
    normalizeFingerprintTerm(result.employmentType)
  ].join("|");
}

function hostMatches(hostname, patterns) {
  return patterns.some((pattern) => pattern.test(hostname));
}

function classifyJobSource(result) {
  const canonicalUrl = normalizeUrlForDedupe(result.sourceUrl);
  const hostname = getHostname(canonicalUrl).toLowerCase();
  const sourceUrl = canonicalUrl.toLowerCase();
  const haystack = `${result.title} ${result.snippet} ${sourceUrl}`.toLowerCase();
  const isDirectAts = hostMatches(hostname, DIRECT_ATS_HOST_PATTERNS);
  const isThirdParty = hostMatches(hostname, THIRD_PARTY_JOB_HOST_PATTERNS);
  const isGenericSearch = hostMatches(hostname, GENERIC_SEARCH_HOST_PATTERNS);
  const hasEmployerJobPath = /\/(job|jobs|careers|career|positions|openings|requisitions|vacanc|apply|boards|roles)\b/.test(sourceUrl);
  const hasNonJobIntent = /\b(blog|news|article|salary|salaries|interview questions|template|course|training)\b/.test(haystack);

  if (isGenericSearch) {
    return { sourceQuality: "generic-search", sourceLabel: "Filtered search result", sourceQualityScore: 0, canonicalUrl };
  }
  if (isThirdParty) {
    return { sourceQuality: "third-party-board", sourceLabel: "Third-party board", sourceQualityScore: 10, canonicalUrl };
  }
  if (hasNonJobIntent) {
    return { sourceQuality: "non-job-page", sourceLabel: "Filtered non-job page", sourceQualityScore: 10, canonicalUrl };
  }
  if (isDirectAts) {
    const sourceQualityScore = hasExactJobPostingPath(canonicalUrl) ? 92 : 58;
    return { sourceQuality: "direct-ats", sourceLabel: "Direct ATS", sourceQualityScore, canonicalUrl };
  }
  if (hasEmployerJobPath) {
    const sourceQualityScore = hasExactJobPostingPath(canonicalUrl) ? 76 : 52;
    return { sourceQuality: "employer-careers", sourceLabel: "Employer careers", sourceQualityScore, canonicalUrl };
  }

  return { sourceQuality: "uncertain", sourceLabel: "Needs validation", sourceQualityScore: 35, canonicalUrl };
}

function hasExactJobPostingPath(value) {
  try {
    const url = new URL(normalizeUrlForDedupe(value));
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase().replace(/\/+$/, "");
    const segments = pathname.split("/").filter(Boolean);

    if (!segments.length || url.searchParams.has("error") || segments.includes("thanks")) return false;

    if (/greenhouse\.io$/i.test(hostname)) return /\/jobs\/\d+/.test(pathname);
    if (hostname === "jobs.lever.co") return segments.length >= 2 && /^[a-f0-9-]{12,}$/i.test(segments[1]);
    if (/myworkdayjobs\.com$/i.test(hostname)) return segments.includes("job") && segments.length >= 4;
    if (/smartrecruiters\.com$/i.test(hostname)) return segments.includes("jobs") && /[a-z0-9-]{8,}/.test(segments.at(-1) || "");
    if (/ashbyhq\.com$/i.test(hostname)) return segments.includes("posting") || segments.includes("jobs");
    if (/bamboohr\.com$/i.test(hostname)) return segments.includes("careers") && (/\d/.test(pathname) || segments.length >= 3);

    const hasJobPath = segments.some((segment) => /^(job|jobs|careers|career|positions|openings|requisitions|vacancies|apply)$/.test(segment));
    const hasPostingLikeSegment = segments.some((segment) => /\d{3,}|[a-f0-9]{8,}-[a-f0-9-]{8,}|[a-z]+-[a-z0-9-]{8,}/i.test(segment));
    return hasJobPath && hasPostingLikeSegment;
  } catch {
    return false;
  }
}

function assessJobDetailEvidence(text, result) {
  const haystack = `${result.title} ${result.snippet} ${text}`.toLowerCase();
  const evidenceTerms = [
    "job description",
    "responsibilities",
    "requirements",
    "qualifications",
    "what you will do",
    "what you'll do",
    "apply now",
    "employment type",
    "job type",
    "requisition",
    "vacancy",
    "about the role",
    "the role"
  ];
  const matchedTerms = evidenceTerms.filter((term) => haystack.includes(term));
  const hasRoleTerm = /\b(intern|internship|graduate|analyst|consultant|engineer|planner|manager|associate|assistant|specialist|developer|designer)\b/.test(haystack);
  const hasApplyIntent = /\b(apply|application|submit your application|candidate|recruitment)\b/.test(haystack);
  const score = matchedTerms.length * 18 + (hasRoleTerm ? 16 : 0) + (hasApplyIntent ? 18 : 0);

  return {
    hasJobDetailEvidence: score >= 52,
    evidenceScore: Math.min(100, score),
    evidenceTerms: matchedTerms.slice(0, 5)
  };
}

function inferRegion(criteria, query) {
  return criteria.targetRegions.find((region) => query.toLowerCase().includes(region.toLowerCase())) ||
    criteria.targetRegions[0] ||
    "Not specified";
}

function inferEmploymentType(criteria, query) {
  return criteria.targetJobTypes.find((jobType) => query.toLowerCase().includes(jobType.toLowerCase())) ||
    criteria.targetJobTypes[0] ||
    "Not specified";
}

function scoreJobPageConfidence(result) {
  const sourceUrl = String(result.canonicalUrl || result.sourceUrl || "");
  const hostname = getHostname(sourceUrl);
  const haystack = `${result.title} ${result.snippet} ${sourceUrl}`.toLowerCase();
  const sourceClassification = classifyJobSource(result);
  let confidence = sourceClassification.sourceQualityScore || 30;

  if (/\b(job|jobs|career|careers|opening|intern|internship|graduate|apply|position|vacancy)\b/.test(haystack)) {
    confidence += 14;
  }
  if (/\/job|\/jobs|\/careers|\/positions|\/openings|\/requisitions|\/apply/.test(sourceUrl.toLowerCase())) {
    confidence += 10;
  }
  if (sourceClassification.sourceQuality === "third-party-board" || sourceClassification.sourceQuality === "generic-search") {
    confidence -= 35;
  }
  if (/\b(blog|news|article|salary|interview questions|template)\b/.test(haystack)) {
    confidence -= 30;
  }
  if (hostMatches(String(hostname).toLowerCase(), DIRECT_ATS_HOST_PATTERNS)) confidence += 10;

  return Math.max(0, Math.min(100, confidence));
}

function normalizeBraveResult(result, criteria, matchedQuery, index) {
  const sourceUrl = result.url || result.profile?.url || "";
  const hostname = getHostname(sourceUrl);
  const snippetParts = [result.description, ...(Array.isArray(result.extra_snippets) ? result.extra_snippets : [])];

  const normalized = {
    id: `brave_${Date.now()}_${index}`,
    title: stripHtml(result.title) || "Untitled job result",
    company: stripHtml(result.profile?.name) || hostname,
    location: inferRegion(criteria, matchedQuery),
    employmentType: inferEmploymentType(criteria, matchedQuery),
    sourceName: hostname,
    sourceUrl,
    snippet: stripHtml(snippetParts.filter(Boolean).join(" ")),
    postedAt: result.age || result.page_age || null,
    matchedQuery,
    jobPageConfidence: 0
  };

  Object.assign(normalized, classifyJobSource(normalized));
  normalized.duplicateKey = getDuplicateKey(normalized);
  normalized.jobPageConfidence = scoreJobPageConfidence(normalized);
  return normalized;
}

async function validateJobCandidate(result) {
  let candidate = {
    ...result,
    ...classifyJobSource(result)
  };
  candidate.duplicateKey = getDuplicateKey(candidate);
  candidate.jobPageConfidence = scoreJobPageConfidence(candidate);

  if (["generic-search", "third-party-board", "non-job-page"].includes(candidate.sourceQuality)) {
    return null;
  }

  try {
    const { finalUrl, html } = await fetchJobPageText(candidate.sourceUrl);
    const readableText = htmlToReadableText(html);
    const pageTitle = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    const metaDescription = extractMetaContent(html, "description") || extractMetaContent(html, "og:description");

    candidate = {
      ...candidate,
      sourceUrl: finalUrl,
      sourceName: getHostname(finalUrl),
      snippet: candidate.snippet || metaDescription || getMeaningfulLines(readableText).slice(0, 1).join(" "),
      title: candidate.title || pageTitle || "Untitled job result"
    };
    Object.assign(candidate, classifyJobSource(candidate));
    candidate.duplicateKey = getDuplicateKey(candidate);

    if (["generic-search", "third-party-board", "non-job-page"].includes(candidate.sourceQuality)) {
      return null;
    }

    const evidence = assessJobDetailEvidence(readableText, candidate);
    candidate.jobPageConfidence = Math.max(candidate.jobPageConfidence, candidate.sourceQualityScore + Math.round(evidence.evidenceScore / 5));
    candidate.validationEvidence = evidence.evidenceTerms;
    const exactPostingUrl = hasExactJobPostingPath(candidate.sourceUrl) || hasExactJobPostingPath(result.sourceUrl);

    if (evidence.hasJobDetailEvidence && exactPostingUrl) {
      return {
        ...candidate,
        validationStatus: "verified",
        sourceLabel: "Verified posting"
      };
    }

    return null;
  } catch (error) {
    const exactPostingUrl = hasExactJobPostingPath(candidate.sourceUrl);
    const hardFetchFailure = /404|410|did not return an HTML job page/i.test(error.message || "");

    if (!hardFetchFailure && exactPostingUrl && candidate.sourceQualityScore >= 86 && candidate.jobPageConfidence >= 82) {
      return {
        ...candidate,
        validationStatus: "trusted-direct-source",
        sourceLabel: candidate.sourceQuality === "direct-ats" ? "Direct ATS" : "Direct posting",
        validationMessage: `Could not pre-parse the page (${error.message || "fetch failed"}), but the URL is a high-confidence direct posting.`
      };
    }

    return null;
  }
}

async function validateAndDedupeJobCandidates(candidates, limit) {
  const validated = [];
  const seenUrls = new Set();
  const seenDuplicateKeys = new Set();

  for (const candidate of candidates) {
    const validatedCandidate = await validateJobCandidate(candidate);
    if (!validatedCandidate) continue;

    const canonicalUrl = normalizeUrlForDedupe(validatedCandidate.canonicalUrl || validatedCandidate.sourceUrl);
    const duplicateKey = getDuplicateKey(validatedCandidate);

    if (seenUrls.has(canonicalUrl) || seenDuplicateKeys.has(duplicateKey)) continue;

    seenUrls.add(canonicalUrl);
    seenDuplicateKeys.add(duplicateKey);
    validated.push({
      ...validatedCandidate,
      canonicalUrl,
      duplicateKey
    });

    if (validated.length >= limit) break;
  }

  return validated;
}

async function braveSearchProvider(criteria, generatedQueries) {
  const cacheKey = stableStringify({ provider: "brave", criteria, generatedQueries });
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) {
    return {
      ...cached.value,
      cacheHit: true
    };
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return {
      provider: "mock",
      results: fakeSearchProvider(criteria, generatedQueries),
      warning: "BRAVE_SEARCH_API_KEY is missing, so mock results were used."
    };
  }

  const limit = Math.max(1, Math.min(criteria.resultLimit || 20, 30));
  const rawCandidateLimit = Math.max(limit * 3, limit + 12);
  const queriesToRun = generatedQueries.slice(0, Math.min(8, generatedQueries.length));
  const countPerQuery = Math.max(3, Math.min(10, Math.ceil(limit / Math.max(queriesToRun.length, 1)) + 2));
  const seenUrls = new Set();
  const results = [];

  for (const query of queriesToRun) {
    const url = new URL(process.env.BRAVE_SEARCH_API_ENDPOINT || DEFAULT_BRAVE_SEARCH_API_ENDPOINT);
    url.search = new URLSearchParams({
      q: query,
      count: String(countPerQuery),
      country: "us",
      search_lang: "en",
      safesearch: "moderate",
      extra_snippets: "true"
    }).toString();

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Brave Search API failed (${response.status}): ${detail.slice(0, 240)}`);
    }

    const data = await response.json();
    const braveResults = data.web?.results || [];
    for (const braveResult of braveResults) {
      const sourceUrl = braveResult.url || braveResult.profile?.url;
      if (!sourceUrl || seenUrls.has(sourceUrl)) continue;
      seenUrls.add(sourceUrl);
      results.push(normalizeBraveResult(braveResult, criteria, query, results.length));
      if (results.length >= rawCandidateLimit) break;
    }

    if (results.length >= rawCandidateLimit) break;
  }

  const validatedResults = await validateAndDedupeJobCandidates(results, limit);

  const providerResult = {
    provider: "brave",
    results: validatedResults
  };
  searchCache.set(cacheKey, {
    createdAt: Date.now(),
    value: providerResult
  });
  return providerResult;
}

function fakeSearchProvider(criteria, generatedQueries) {
  const companies = ["Arup", "Mott MacDonald", "SYSTRA", "AECOM", "WSP", "Jacobs", "MVA", "AtkinsRealis"];
  const sources = ["Direct ATS", "Employer careers", "Verified posting", "Direct posting"];
  const roles = criteria.targetRoles.length ? criteria.targetRoles : ["Transport Planning"];
  const regions = criteria.targetRegions.length ? criteria.targetRegions : ["Hong Kong"];
  const jobTypes = criteria.targetJobTypes.length ? criteria.targetJobTypes : ["Internship", "Graduate Role", "Full-time"];
  const keywords = criteria.searchKeywords;
  const limit = Math.max(1, Math.min(criteria.resultLimit || 20, 30));

  return Array.from({ length: limit }, (_, index) => {
    const role = roles[index % roles.length];
    const region = regions[index % regions.length];
    const type = jobTypes[index % jobTypes.length];
    const company = companies[index % companies.length];
    const keyword = keywords[index % Math.max(keywords.length, 1)] || "analysis";
    const sourceName = sources[index % sources.length];
    const query = generatedQueries[index % generatedQueries.length] || `${role} ${type} ${region}`;
    const slug = `${company}-${role}-${type}-${region}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const sourceUrl = index % 2 === 0
      ? `https://jobs.lever.co/${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}/${slug}`
      : `https://${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com/careers/jobs/${slug}`;

    const result = {
      id: `result_${Date.now()}_${index}`,
      title: `${role} ${type}`,
      company,
      location: region,
      employmentType: type,
      sourceName,
      sourceUrl,
      snippet: `Public result candidate for ${role} in ${region}, mentioning ${keyword}, application support, project work, and analytical responsibilities.`,
      postedAt: index % 4 === 0 ? null : new Date(Date.now() - index * 86400000).toISOString().slice(0, 10),
      matchedQuery: query,
      validationStatus: "mock-validated",
      sourceQuality: index % 2 === 0 ? "direct-ats" : "employer-careers",
      sourceLabel: index % 2 === 0 ? "Direct ATS" : "Verified posting"
    };

    result.canonicalUrl = normalizeUrlForDedupe(result.sourceUrl);
    result.duplicateKey = getDuplicateKey(result);
    result.jobPageConfidence = scoreJobPageConfidence(result);
    return result;
  });
}

function rankJobSearchResults(criteria, results) {
  const positiveTerms = unique([
    ...criteria.targetRoles,
    ...criteria.targetRegions,
    ...criteria.targetIndustries,
    ...criteria.searchKeywords,
    ...criteria.targetJobTypes
  ]).map((term) => term.toLowerCase());
  const excludedTerms = criteria.excludedKeywords.map((term) => term.toLowerCase());

  return results
    .map((result) => {
      const haystack = `${result.title} ${result.company} ${result.location} ${result.employmentType} ${result.snippet}`.toLowerCase();
      const positiveMatches = positiveTerms.filter((term) => haystack.includes(term.toLowerCase()));
      const excludedMatches = excludedTerms.filter((term) => haystack.includes(term.toLowerCase()));
      const base = 52;
      const score = Math.max(15, Math.min(96, base + positiveMatches.length * 7 - excludedMatches.length * 18));
      const jobPageConfidence = Number(result.jobPageConfidence || 0);
      const validationBoost = result.validationStatus === "verified"
        ? 10
        : result.validationStatus === "trusted-direct-source" || result.validationStatus === "mock-validated"
          ? 6
          : -14;
      const sourceBoost = result.sourceQuality === "direct-ats"
        ? 8
        : result.sourceQuality === "employer-careers"
          ? 5
          : -18;
      const adjustedScore = Math.max(15, Math.min(98, score + Math.round((jobPageConfidence - 50) / 5) + validationBoost + sourceBoost));
      const reasonParts = [];

      if (positiveMatches.length) {
        reasonParts.push(`Matches ${unique(positiveMatches).slice(0, 5).join(", ")}.`);
      }
      if (result.validationStatus === "verified") {
        reasonParts.push("Verified as a job-detail posting before being shown.");
      } else if (result.validationStatus === "trusted-direct-source" || result.validationStatus === "mock-validated") {
        reasonParts.push("Comes from a direct employer or ATS source.");
      }
      if (criteria.remotePreference && criteria.remotePreference !== "Any") {
        reasonParts.push(`Remote preference is set to ${criteria.remotePreference}; verify details on the source page.`);
      }
      if (excludedMatches.length) {
        reasonParts.push(`Contains excluded term(s): ${excludedMatches.join(", ")}.`);
      }

      return {
        ...result,
        preliminaryScore: adjustedScore,
        recommendationReason: reasonParts.join(" ") || "Recommended because it aligns with your profile search criteria."
      };
    })
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore);
}

function isPrivateIp(hostname) {
  const ipVersion = net.isIP(hostname);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    const parts = hostname.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0
    );
  }

  const normalized = hostname.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80");
}

function validatePublicHttpUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS job URLs can be analyzed.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIp(hostname)) {
    throw new Error("Local and private-network URLs cannot be analyzed.");
  }

  return url;
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };

  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === "#") {
      const isHex = lower[1] === "x";
      const codePoint = Number.parseInt(lower.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return namedEntities[lower] || match;
  });
}

function extractMetaContent(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return decodeHtmlEntities(match?.[1] || match?.[2] || "");
}

function htmlToReadableText(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(h[1-6]|p|li|br|div|section|article|tr|td|th)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function fetchJobPageText(sourceUrl) {
  const url = validatePublicHttpUrl(sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_PAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "CareerPilotAI/1.0 (+local job parser)"
      }
    });

    if (!response.ok) {
      throw new Error(`Job page fetch failed (${response.status}).`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("The selected URL did not return an HTML job page.");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        finalUrl: response.url,
        html: await response.text()
      };
    }

    const chunks = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > JOB_PAGE_MAX_BYTES) {
        throw new Error("Job page is too large to parse safely.");
      }
      chunks.push(value);
    }

    return {
      finalUrl: response.url,
      html: Buffer.concat(chunks).toString("utf8")
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getMeaningfulLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 35 && line.length <= 260);
}

function pickSectionLines(lines, sectionTerms, fallbackTerms) {
  const selected = [];
  let active = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (sectionTerms.some((term) => lower.includes(term))) {
      active = true;
      continue;
    }
    if (active && /^(benefits|about us|equal opportunity|location|salary|apply|company|what we offer)\b/i.test(line)) {
      active = false;
    }
    if (active || fallbackTerms.some((term) => lower.includes(term))) {
      selected.push(line);
    }
    if (selected.length >= 5) break;
  }

  return unique(selected).slice(0, 5);
}

function extractKeywords(text, seedTerms) {
  const skillTerms = [
    "python",
    "gis",
    "excel",
    "sql",
    "tableau",
    "power bi",
    "autocad",
    "anylogic",
    "sumo",
    "transport planning",
    "data analysis",
    "project management",
    "stakeholder",
    "research",
    "report writing",
    "consulting",
    "urban planning",
    "communication",
    "simulation",
    "modeling"
  ];
  const lower = String(text || "").toLowerCase();
  return unique([...seedTerms, ...skillTerms.filter((term) => lower.includes(term))]).slice(0, 12);
}

function fallbackParsedJob(result, parseStatus, parserMessage) {
  return {
    jobId: `job_${Date.now()}`,
    title: result.title,
    company: result.company,
    location: result.location,
    employmentType: result.employmentType,
    sourceUrl: result.sourceUrl,
    responsibilities: [
      "Support project research, analysis, and reporting.",
      "Prepare maps, tables, summaries, or technical inputs for the project team.",
      "Coordinate with consultants, clients, or internal stakeholders."
    ],
    requirements: [
      "Relevant academic or professional background.",
      "Strong analytical and written communication skills.",
      "Interest in the target industry and role."
    ],
    preferredSkills: ["GIS", "Python", "Excel", "transport planning", "data analysis"],
    keywords: ["analysis", "consulting", "planning", "report writing"],
    deadline: null,
    parserStatus: parseStatus,
    parserMessage,
    parsedFrom: "search-result-snippet"
  };
}

async function parseJobFromResult(result) {
  const sourceUrl = result.sourceUrl;
  if (!sourceUrl) {
    return fallbackParsedJob(result, "fallback", "No source URL was available for this result.");
  }

  const cacheKey = sourceUrl;
  const cached = jobParseCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < JOB_PARSE_CACHE_TTL_MS) {
    return {
      ...cached.value,
      cacheHit: true
    };
  }

  try {
    const { finalUrl, html } = await fetchJobPageText(sourceUrl);
    const readableText = htmlToReadableText(html);
    const lines = getMeaningfulLines(readableText);
    const pageTitle = decodeHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
    const metaDescription = extractMetaContent(html, "description") || extractMetaContent(html, "og:description");

    const responsibilities = pickSectionLines(
      lines,
      ["responsibilities", "what you will do", "what you'll do", "role overview", "the role"],
      ["support", "prepare", "coordinate", "analyze", "develop", "work with", "assist"]
    );
    const requirements = pickSectionLines(
      lines,
      ["requirements", "qualifications", "what you need", "what we're looking for", "about you"],
      ["experience", "degree", "skills", "proficiency", "knowledge", "ability", "eligible"]
    );
    const keywords = extractKeywords(readableText, [
      result.employmentType,
      result.location,
      ...(String(result.matchedQuery || "").split(/\s+/).filter((term) => term.length > 3).slice(0, 4))
    ]);

    const parsedJob = {
      jobId: `job_${Date.now()}`,
      title: result.title || pageTitle || "Untitled job",
      company: result.company || getHostname(finalUrl),
      location: result.location || "Not specified",
      employmentType: result.employmentType || "Not specified",
      sourceUrl: finalUrl,
      responsibilities: responsibilities.length ? responsibilities : ["Review the source page for detailed responsibilities."],
      requirements: requirements.length ? requirements : ["Review the source page for detailed requirements."],
      preferredSkills: keywords.slice(0, 8),
      keywords,
      deadline: null,
      parserStatus: "parsed",
      parserMessage: "Parsed from the selected job page.",
      parsedFrom: "source-url",
      summary: metaDescription || lines.slice(0, 2).join(" ")
    };

    jobParseCache.set(cacheKey, {
      createdAt: Date.now(),
      value: parsedJob
    });
    return parsedJob;
  } catch (error) {
    return fallbackParsedJob(
      result,
      "fallback",
      `${error.message || "Could not fetch the selected job page."} Used search result snippet instead.`
    );
  }
}

async function resolveApplicationJobContent({ jobUrl, jobText }) {
  const manualText = cleanExtractedText(jobText || "");
  if (manualText.length >= 160) {
    return {
      jobText: manualText,
      sourceType: "manual",
      sourceUrl: normalizeGeneratedText(jobUrl) || null
    };
  }

  const trimmedUrl = normalizeGeneratedText(jobUrl);
  if (!trimmedUrl) {
    throw Object.assign(new Error("Paste a job URL or the job hiring content before analysis."), {
      statusCode: 400
    });
  }

  try {
    const { finalUrl, html } = await fetchJobPageText(trimmedUrl);
    const extractedText = cleanExtractedText(htmlToReadableText(html));
    if (extractedText.length < 300) {
      throw new Error("The URL did not include enough readable job content.");
    }
    return {
      jobText: extractedText,
      sourceType: "url",
      sourceUrl: finalUrl
    };
  } catch (error) {
    throw Object.assign(
      new Error("Paste the job description manually. The job URL could not be read reliably."),
      {
        statusCode: 422,
        needsManualPaste: true,
        parserMessage: error.message || "The job URL could not be parsed."
      }
    );
  }
}

function titleCaseCompanySlug(value) {
  return String(value || "")
    .replace(/\.(com|org|net|io|co|ai|jobs|careers)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function buildCompanyBackgroundQuery(companyName) {
  const normalized = cleanExtractedText(companyName || "").replace(/[^\w\s&.'-]/g, " ").replace(/\s+/g, " ").trim();
  return normalized
    ? `"${normalized}" official website company background business news profile -jobs -job -careers -hiring -vacancy`
    : "";
}

function inferCompanySearchQuery({ jobText, jobUrl, companyName }) {
  const explicitCompanyQuery = buildCompanyBackgroundQuery(companyName);
  if (explicitCompanyQuery) return explicitCompanyQuery;

  const text = String(jobText || "").slice(0, 5000);
  const directPatterns = [
    /\bcompany\s*[:\-]\s*([A-Z][A-Za-z0-9&.,' -]{2,80})/i,
    /\bemployer\s*[:\-]\s*([A-Z][A-Za-z0-9&.,' -]{2,80})/i,
    /\borganization\s*[:\-]\s*([A-Z][A-Za-z0-9&.,' -]{2,80})/i,
    /\babout\s+([A-Z][A-Za-z0-9&.,' -]{2,80})\b/
  ];

  for (const pattern of directPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return buildCompanyBackgroundQuery(match[1]).slice(0, 220);
    }
  }

  try {
    if (jobUrl) {
      const parsedUrl = new URL(jobUrl);
      const hostname = parsedUrl.hostname.replace(/^www\./, "");
      const segments = parsedUrl.pathname.split("/").map((segment) => segment.trim()).filter(Boolean);
      const atsPathCompany = (() => {
        if (hostname === "jobs.lever.co" && segments[0]) return segments[0];
        if (/greenhouse\.io$/i.test(hostname) && segments[0]) return segments[0];
        if (/ashbyhq\.com$/i.test(hostname) && segments[0]) return segments[0];
        if (/workable\.com$/i.test(hostname) && segments[0]) return segments[0];
        return "";
      })();
      if (atsPathCompany) {
        const company = titleCaseCompanySlug(atsPathCompany);
        if (company) return buildCompanyBackgroundQuery(company);
      }

      const parts = hostname.split(".");
      const ignoredSubdomains = new Set(["jobs", "careers", "apply", "boards", "recruiting", "wd1", "wd3", "myworkdayjobs"]);
      const companyPart = parts.find((part) => part && !ignoredSubdomains.has(part)) || parts[0];
      const company = titleCaseCompanySlug(companyPart);
      if (company) return buildCompanyBackgroundQuery(company);
    }
  } catch {}

  const firstUsefulLine = text
    .split(/\n+/)
    .map((line) => cleanExtractedText(line))
    .find((line) => line.length >= 12 && line.length <= 120);

  return firstUsefulLine ? `${firstUsefulLine} company background business news -jobs -careers -hiring` : "";
}

async function searchCompanyContext({ jobText, jobUrl, companyName }) {
  const query = inferCompanySearchQuery({ jobText, jobUrl, companyName });
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!query) {
    return {
      provider: "brave",
      query: "",
      warning: "Could not infer a company search query from the job content.",
      results: []
    };
  }
  if (!apiKey) {
    return {
      provider: "brave",
      query,
      warning: "BRAVE_SEARCH_API_KEY is not configured, so company research was skipped.",
      results: []
    };
  }

  const cacheKey = stableStringify({ provider: "brave-company", query });
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < SEARCH_CACHE_TTL_MS) {
    return {
      ...cached.value,
      cacheHit: true
    };
  }

  const url = new URL(process.env.BRAVE_SEARCH_API_ENDPOINT || DEFAULT_BRAVE_SEARCH_API_ENDPOINT);
  url.search = new URLSearchParams({
    q: query,
    count: "5",
    country: "us",
    search_lang: "en",
    safesearch: "moderate",
    extra_snippets: "true"
  }).toString();

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey
      }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Brave Search API failed (${response.status}): ${detail.slice(0, 180)}`);
    }

    const data = await response.json();
    const results = (data.web?.results || []).slice(0, 5).map((result) => ({
      title: stripHtml(result.title) || "Untitled result",
      url: result.url || result.profile?.url || "",
      snippet: stripHtml([result.description, ...(result.extra_snippets || [])].filter(Boolean).join(" "))
    }));
    const providerResult = {
      provider: "brave",
      query,
      warning: results.length ? null : "Company search returned no usable results.",
      results
    };

    searchCache.set(cacheKey, {
      createdAt: Date.now(),
      value: providerResult
    });
    return providerResult;
  } catch (error) {
    return {
      provider: "brave",
      query,
      warning: error.message || "Company research search failed.",
      results: []
    };
  }
}

function handleStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const extension = path.extname(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "POST" && pathname === "/api/analyze-profile") {
      const body = await readRequestBody(req);
      return sendJson(res, 200, analyzeProfile(body.profile || body));
    }

    if (req.method === "POST" && pathname === "/api/analyze-resume") {
      const bodyBuffer = await readRequestBuffer(req, RESUME_UPLOAD_MAX_BYTES);
      const formData = parseMultipartFormData(req, bodyBuffer);
      const resumeFile = formData.files.find((file) => file.name === "resume") || formData.files[0];

      if (!resumeFile) {
        return sendJson(res, 400, { error: "Upload a resume file before analysis." });
      }

      const resumeText = extractResumeText(resumeFile);
      if (resumeText.length < 80) {
        return sendJson(res, 422, { error: "Could not extract enough resume text from this file." });
      }

      const profile = await analyzeResumeWithLlm(resumeText);
      const analysis = analyzeProfile(profile);

      return sendJson(res, 200, {
        profile,
        analysis,
        resume: {
          filename: resumeFile.filename,
          contentType: resumeFile.contentType,
          extractedCharacters: resumeText.length
        }
      });
    }

    if (req.method === "POST" && pathname === "/api/analyze-application") {
      if (!String(req.headers["content-type"] || "").includes("multipart/form-data")) {
        return sendJson(res, 400, { error: "Application analysis must use multipart/form-data." });
      }

      const bodyBuffer = await readRequestBuffer(req, APPLICATION_REQUEST_MAX_BYTES);
      const formData = parseMultipartFormData(req, bodyBuffer);
      const resumeFile = formData.files.find((file) => file.name === "resume") || formData.files[0];

      if (!resumeFile) {
        return sendJson(res, 400, { error: "Upload a resume before generating an application kit." });
      }

      const resumeText = extractResumeText(resumeFile);
      if (resumeText.length < 80) {
        return sendJson(res, 422, { error: "Could not extract enough resume text from this file." });
      }

      const resolvedJob = await resolveApplicationJobContent({
        jobUrl: formData.fields.jobUrl,
        jobText: formData.fields.jobText
      });
      const companyName = normalizeGeneratedText(formData.fields.companyName);
      const companyResearch = await searchCompanyContext({
        jobUrl: resolvedJob.sourceUrl || formData.fields.jobUrl,
        jobText: resolvedJob.jobText,
        companyName
      });
      const kit = await callApplicationKitLlm({
        resumeText,
        jobText: resolvedJob.jobText,
        jobUrl: resolvedJob.sourceUrl,
        companyName,
        writingTone: formData.fields.writingTone || "Bold Professional",
        companyResearch
      });

      return sendJson(res, 200, {
        kit,
        companyResearch,
        source: {
          type: resolvedJob.sourceType,
          url: resolvedJob.sourceUrl,
          companyName: companyName || null,
          jobCharacters: resolvedJob.jobText.length
        },
        resume: {
          filename: resumeFile.filename,
          contentType: resumeFile.contentType,
          extractedCharacters: resumeText.length
        }
      });
    }

    if (req.method === "POST" && pathname === "/api/profile-job-search") {
      return sendJson(res, 410, {
        error: "Job search has been removed. Use /api/analyze-application with a resume and job URL or pasted job content."
      });
    }

    if (req.method === "POST" && pathname === "/api/save-application-kit") {
      const body = await readRequestBody(req);
      const kit = coerceApplicationKitPayload(body.kit || {});
      const savedKit = {
        id: `kit_${Date.now()}`,
        kit,
        source: body.source || null,
        resume: body.resume || null,
        companyResearch: body.companyResearch || null,
        savedAt: new Date().toISOString(),
        status: "Generated"
      };
      savedApplicationKits.unshift(savedKit);
      return sendJson(res, 200, { savedKit, savedApplicationKits });
    }

    if (req.method === "POST" && pathname === "/api/save-job") {
      return sendJson(res, 410, {
        error: "Saved jobs have been replaced by saved application kits. Use /api/save-application-kit."
      });
    }

    if (req.method === "POST" && pathname === "/api/analyze-job") {
      return sendJson(res, 410, {
        error: "Single-job match analysis has moved to /api/analyze-application."
      });
    }

    if (req.method === "GET" && pathname === "/api/saved-application-kits") {
      return sendJson(res, 200, { savedApplicationKits });
    }

    if (req.method === "GET" && pathname === "/api/saved-jobs") {
      return sendJson(res, 200, { savedApplicationKits });
    }

    sendJson(res, 404, { error: "API route not found" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "Unexpected server error",
      ...(error.needsManualPaste
        ? {
            needsManualPaste: true,
            parserMessage: error.parserMessage || null
          }
        : {})
    });
  }
}

function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, requestUrl.pathname);
    return;
  }
  handleStatic(req, res, requestUrl.pathname);
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`CareerPilot AI prototype running at http://localhost:${PORT}`);
  });
}

module.exports = {
  handleRequest
};
