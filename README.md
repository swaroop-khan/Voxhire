# VoxHire: Adaptive AI Technical Interviewer

VoxHire is a browser-based voice interviewer for technical interview practice. It uses the AssemblyAI Voice Agent API to conduct a spoken interview, adapt follow-up questions, evaluate answers, and show an interview report.

<p align="center">
  <a href="https://voice-agent-r3fb.onrender.com"><strong>🚀 Try the live demo</strong></a>
  &nbsp; | &nbsp;
  <a href="https://github.com/swaroop-khan/Voxhire"><strong>💻 View the source</strong></a>
</p>

## Features

- Browser-based, real-time voice interviews.
- Candidate-selected technical topics and adaptive follow-up questions.
- Answer evaluation across technical knowledge, reasoning, problem solving, and communication.
- Interview summary with scores, feedback, and recorded answers.
- Microphone selection and live transcript.

## How it works

1. The Node.js server publishes or loads the configured AssemblyAI agent and mints a short-lived session token.
2. The browser connects directly to AssemblyAI's Voice Agent WebSocket. The API key stays on the server.
3. The browser tracks interview state and evaluation results during the session and renders the report.

Interview state and reports are held in the browser for the current session; this project does not persist them to a database.

## Try the live demo

Open [VoxHire on Render](https://voice-agent-r3fb.onrender.com), allow microphone access, and select **Start call**. The page requires HTTPS or localhost for microphone access.

The demo is public: anyone with the link can start a session, and usage is billed to the AssemblyAI account configured for the service. The Render free plan may take about a minute to wake after 15 minutes without traffic. See [Render's free service limits](https://render.com/docs/free).

## Run locally

### Requirements

- Node.js 18 or later.
- An AssemblyAI API key.
- A modern browser with microphone access.

No `npm install` is needed; the app uses Node.js built-ins.

### 1. Clone the repository

```sh
git clone https://github.com/swaroop-khan/Voxhire.git
cd Voxhire
```

### 2. Configure the API key

Copy the example environment file and add your key:

```sh
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set `ASSEMBLYAI_API_KEY`. Keep this file private; `.env` is gitignored and must not be committed.

### 3. Start the app

```sh
npm start
```

On first startup, the server publishes `agents/minimal.jsonc` or reuses the matching agent in your AssemblyAI account. Open the local URL printed in the terminal, usually <http://localhost:3000>.

To publish explicitly before starting:

```sh
npm run publish
npm start
```

To select another agent file, set `AGENT` before publishing or starting. For example, in a Unix-like shell:

```sh
AGENT=keyterms npm run publish
AGENT=keyterms npm start
```

In Windows PowerShell:

```powershell
$env:AGENT = 'keyterms'
npm run publish
npm start
```

To import an existing dashboard agent into a local file, run `npm run import YOUR_AGENT_ID` and follow the command printed by the script. Some integrations also need credentials in `.env`; see the selected file under [`agents/`](agents/).

## Deploy on Render

This repository includes [`render.yaml`](render.yaml) for a Render web service. To create your own deployment, connect this GitHub repository in Render and deploy it as a Blueprint. Render prompts for `ASSEMBLYAI_API_KEY`; add it as a secret environment variable.

The Blueprint defaults are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT` | `minimal` | Selects `agents/minimal.jsonc`. |
| `AGENT_ID` | Empty | Optional. Leave empty to publish or reuse the agent by name. Only set an ID verified in the same AssemblyAI account and region. |
| `AGENTS_API_BASE` | `https://agents.assemblyai.com/v1` | AssemblyAI's US REST endpoint. The browser WebSocket URL follows this region. |

The local `.env` is not used by Render. A local agent ID is not automatically valid in production. If your AssemblyAI account is pinned to another region, set the matching REST endpoint in `AGENTS_API_BASE`.

When auto-deploy is enabled, pushes to the service's linked Git branch trigger a new deployment. See [Render's deploy guide](https://render.com/docs/deploys).

## Project layout

| Path | Purpose |
| --- | --- |
| `agents/` | Agent configurations, including the default `minimal.jsonc`. |
| `deployment/browser/server.mjs` | Node.js web server, browser client, and `/agent` and `/token` routes. |
| `interview/state.mjs` | In-memory interview state and score aggregation. |
| `interview/controller.mjs` | Applies interview decisions and records questions and answers. |
| `interview/report.mjs` | Standalone helper for generating report data. |
| `lib.mjs` | Environment loading, agent publishing, and AssemblyAI API calls. |

The browser's report UI is implemented in `deployment/browser/server.mjs`; it currently does not import `interview/report.mjs`.

## References

- [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [AssemblyAI browser integration](https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration)
- [Render documentation](https://render.com/docs)

## Author

**Swaroop Khan** · [GitHub](https://github.com/swaroop-khan) · [LinkedIn](https://www.linkedin.com/in/swaroop-khan/)
