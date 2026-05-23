# CareerPilot AI Application Studio Prototype

This workspace includes a dependency-free MVP for resume-based job application analysis.

Users upload a resume, paste a job URL or the job hiring content, and generate:

- Job-fit analysis
- Resume revision suggestions
- A dedicated cover letter
- A concise application email
- Saved application kits for follow-up

## Run

Create a local `.env` file first:

```bash
LLM_API_KEY='your_llm_api_key_here'
LLM_BASE_URL='https://api.openai.com/v1'
LLM_MODEL='gpt-4.1-mini'
BRAVE_SEARCH_API_KEY='your_brave_search_api_key_here'
BRAVE_SEARCH_API_ENDPOINT='https://api.search.brave.com/res/v1/web/search'
SEARCH_CACHE_TTL_MS='900000'
RESUME_UPLOAD_MAX_BYTES='2000000'
APPLICATION_REQUEST_MAX_BYTES='3000000'
JOB_PAGE_FETCH_TIMEOUT_MS='8000'
JOB_PAGE_MAX_BYTES='750000'
JOB_PARSE_CACHE_TTL_MS='1800000'
```

Then start the app:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Deployment

This app needs backend API routes and secret environment variables, so it cannot be deployed as a static GitHub Pages site. Use Vercel or another Node-capable host.

On Vercel, configure these environment variables in the project settings before using the AI generation flow:

```text
LLM_API_KEY
LLM_BASE_URL
LLM_MODEL
BRAVE_SEARCH_API_KEY
BRAVE_SEARCH_API_ENDPOINT
SEARCH_CACHE_TTL_MS
RESUME_UPLOAD_MAX_BYTES
APPLICATION_REQUEST_MAX_BYTES
JOB_PAGE_FETCH_TIMEOUT_MS
JOB_PAGE_MAX_BYTES
JOB_PARSE_CACHE_TTL_MS
```

## What It Implements

- Resume upload for PDF, DOCX, and TXT
- Manual job URL input
- Manual pasted job-description input
- URL fetching with safe public-URL validation
- Company research through the configured Brave Search API
- Clear manual-paste fallback when a job URL cannot be read reliably
- Staged progress bar during analysis and generation
- OpenAI-compatible LLM generation through the backend
- Structured application kit rendering
- Saved application kit tracker

## API Endpoints

```text
POST /api/analyze-application
POST /api/save-application-kit
GET  /api/saved-application-kits
POST /api/analyze-resume
```

The old search endpoints are intentionally not part of the active product flow.

## Application Analysis Note

`POST /api/analyze-application` accepts `multipart/form-data`:

```text
resume      required file, PDF/DOCX/TXT
jobUrl      optional URL
companyName optional company name used to focus online company research
jobText     optional pasted job content
writingTone optional, defaults to Bold Professional
```

Manual pasted job content takes priority over fetched URL content. If the URL cannot be fetched or does not contain enough readable job text, the backend returns `422` with `needsManualPaste: true`.

Before calling the LLM, the backend searches online through `BRAVE_SEARCH_API_KEY` and passes company-background snippets into the application-analysis prompt. If `companyName` is provided, it is used as the research target; otherwise the backend falls back to inferring the company from the job URL or pasted content. If the search API is not configured or fails, generation can still continue, but the returned kit includes a company-research warning.

Uploaded resumes are processed in memory by this prototype and are not saved to disk.
