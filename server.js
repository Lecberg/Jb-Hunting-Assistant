const http = require("node:http");
const dns = require("node:dns");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");
const { URL } = require("node:url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_BRAVE_SEARCH_API_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

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
const GENERATION_RATE_LIMIT_WINDOW_MS = Number(process.env.GENERATION_RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000);
const GENERATION_RATE_LIMIT_MAX = Number(process.env.GENERATION_RATE_LIMIT_MAX || 5);
const JOB_PAGE_FETCH_TIMEOUT_MS = Number(process.env.JOB_PAGE_FETCH_TIMEOUT_MS || 8000);
const JOB_PAGE_MAX_BYTES = Number(process.env.JOB_PAGE_MAX_BYTES || 750000);
const RESUME_UPLOAD_MAX_BYTES = Number(process.env.RESUME_UPLOAD_MAX_BYTES || 2_000_000);
const APPLICATION_REQUEST_MAX_BYTES = Number(process.env.APPLICATION_REQUEST_MAX_BYTES || RESUME_UPLOAD_MAX_BYTES + 1_000_000);
const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

const searchCache = new Map();
const rateLimitBuckets = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(Object.assign(new Error(`Request body too large. Maximum size is ${maxBytes} bytes.`), { statusCode: 413 }));
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
    throw Object.assign(new Error("Resume upload must use multipart/form-data."), { statusCode: 400 });
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

function pruneCache(map, ttlMs, maxEntries = 100) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.createdAt >= ttlMs) map.delete(key);
  }
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

function getClientIp(req) {
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp) return realIp;
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "local")
    .split(",")[0]
    .trim();
}

function consumeGenerationRateLimit(req) {
  const clientIp = getClientIp(req);
  const now = Date.now();

  if (rateLimitBuckets.size > 500) {
    for (const [ip, staleBucket] of rateLimitBuckets) {
      if (now > staleBucket.resetAt) rateLimitBuckets.delete(ip);
    }
  }

  const bucket = rateLimitBuckets.get(clientIp) || { count: 0, resetAt: now + GENERATION_RATE_LIMIT_WINDOW_MS };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + GENERATION_RATE_LIMIT_WINDOW_MS;
  }

  bucket.count += 1;
  rateLimitBuckets.set(clientIp, bucket);

  return {
    allowed: bucket.count <= GENERATION_RATE_LIMIT_MAX,
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
    throw Object.assign(new Error("DOCX file could not be read as a ZIP archive."), { statusCode: 422 });
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

    if (fileName === "word/document.xml") {
      let data;
      try {
        if (compressionMethod === 0) {
          data = compressed;
        } else if (compressionMethod === 8) {
          data = zlib.inflateRawSync(compressed, { maxOutputLength: 20_000_000 });
        } else {
          data = Buffer.alloc(0);
        }
      } catch {
        throw Object.assign(new Error("DOCX content is too large or corrupted to process."), { statusCode: 422 });
      }
      entries.set(fileName, data);
    }
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractDocxText(buffer) {
  const entries = extractZipEntries(buffer);
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) {
    throw Object.assign(new Error("DOCX file did not contain word/document.xml."), { statusCode: 422 });
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
      candidates.push(zlib.inflateSync(streamBuffer, { maxOutputLength: 20_000_000 }));
    } catch {}
    try {
      candidates.push(zlib.inflateRawSync(streamBuffer, { maxOutputLength: 20_000_000 }));
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
    throw Object.assign(
      new Error("Could not extract enough text from this PDF. Try exporting the resume as text-based PDF, DOCX, or TXT."),
      { statusCode: 422 }
    );
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

  throw Object.assign(new Error("Unsupported resume file type. Upload a PDF, DOCX, or TXT file."), { statusCode: 400 });
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
    throw Object.assign(new Error("LLM_API_KEY is not configured. Add it to .env before using resume analysis."), {
      statusCode: 500
    });
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
    console.error(`LLM resume analysis failed (${response.status}):`, detail.slice(0, 500));
    throw Object.assign(new Error(`LLM resume analysis failed (status ${response.status}).`), { statusCode: 502 });
  }

  const data = await response.json();
  const parsed = parseJsonFromLlmContent(data.choices?.[0]?.message?.content, "LLM response did not include profile JSON.");
  return coerceProfilePayload(parsed);
}

function parseJsonFromLlmContent(content, emptyMessage = "LLM response did not include JSON.") {
  if (!content) {
    throw Object.assign(new Error(emptyMessage), { statusCode: 502 });
  }

  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw Object.assign(new Error("LLM response was not valid JSON."), { statusCode: 502 });
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      throw Object.assign(new Error("LLM response was not valid JSON."), { statusCode: 502 });
    }
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
    throw Object.assign(new Error("LLM_API_KEY is not configured. Add it to .env before generating an application kit."), {
      statusCode: 500
    });
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
    console.error(`LLM application analysis failed (${response.status}):`, detail.slice(0, 500));
    throw Object.assign(new Error(`LLM application analysis failed (status ${response.status}).`), { statusCode: 502 });
  }

  const data = await response.json();
  const parsed = parseJsonFromLlmContent(data.choices?.[0]?.message?.content, "LLM response did not include application-kit JSON.");
  return coerceApplicationKitPayload(parsed);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPrivateIp(hostname) {
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) so the IPv4 rules apply.
  let candidate = String(hostname || "").toLowerCase();
  const mapped = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) candidate = mapped[1];

  const ipVersion = net.isIP(candidate);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    const parts = candidate.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) ||
      parts[0] === 0
    );
  }

  return (
    candidate === "::1" ||
    candidate === "::" ||
    candidate.startsWith("::ffff:") ||
    candidate.startsWith("fc") ||
    candidate.startsWith("fd") ||
    candidate.startsWith("fe80")
  );
}

async function validatePublicHttpUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS job URLs can be analyzed.");
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateIp(hostname)) {
    throw new Error("Local and private-network URLs cannot be analyzed.");
  }

  if (!net.isIP(hostname)) {
    let addresses;
    try {
      addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("The job URL hostname could not be resolved.");
    }
    // Residual risk (accepted for this prototype): DNS could change between this
    // lookup and the fetch (rebinding). Defending that needs a pinned-IP agent.
    if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
      throw new Error("Local and private-network URLs cannot be analyzed.");
    }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_PAGE_FETCH_TIMEOUT_MS);

  try {
    let url = await validatePublicHttpUrl(sourceUrl);
    let response;

    // Follow redirects manually so every hop is re-validated against private hosts.
    for (let hop = 0; ; hop += 1) {
      response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "CareerPilotAI/1.0 (+local job parser)"
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`Job page fetch failed (${response.status}).`);
        }
        if (hop >= 4) {
          throw new Error("Too many redirects while fetching the job page.");
        }
        response.body?.cancel().catch(() => {});
        url = await validatePublicHttpUrl(new URL(location, url).toString());
        continue;
      }
      break;
    }

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
      console.error(`Brave Search API failed (${response.status}):`, detail.slice(0, 500));
      throw new Error(`Brave Search API failed (status ${response.status}).`);
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

    pruneCache(searchCache, SEARCH_CACHE_TTL_MS);
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

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
    if (req.method === "POST" && pathname === "/api/analyze-resume") {
      const rateLimit = consumeGenerationRateLimit(req);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
        return sendJson(res, 429, {
          error: `Too many generation requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds
        });
      }

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
      const rateLimit = consumeGenerationRateLimit(req);
      if (!rateLimit.allowed) {
        res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
        return sendJson(res, 429, {
          error: `Too many generation requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds
        });
      }

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
      return sendJson(res, 410, {
        error: "Saved kits are stored in your browser now. This endpoint has been retired."
      });
    }

    if (req.method === "POST" && pathname === "/api/save-job") {
      return sendJson(res, 410, {
        error: "This endpoint has been retired. Saved kits are stored in your browser now."
      });
    }

    if (req.method === "POST" && pathname === "/api/analyze-job") {
      return sendJson(res, 410, {
        error: "Single-job match analysis has moved to /api/analyze-application."
      });
    }

    if (req.method === "GET" && (pathname === "/api/saved-application-kits" || pathname === "/api/saved-jobs")) {
      return sendJson(res, 410, {
        error: "Saved kits are stored in your browser now. This endpoint has been retired."
      });
    }

    sendJson(res, 404, { error: "API route not found" });
  } catch (error) {
    if (!error.statusCode) {
      console.error("Unhandled API error:", error);
    }
    sendJson(res, error.statusCode || 500, {
      error: error.statusCode ? error.message || "Request failed." : "Unexpected server error.",
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
