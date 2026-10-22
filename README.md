# VoxHire — Adaptive AI Technical Interviewer

**VoxHire** is an AI-powered voice interview platform designed to simulate technical interviews through real-time voice interaction. Built with AssemblyAI's Voice Agent technology, it aims to make technical interview practice more interactive, conversational, and adaptive.

<p align="center">
  <a href="https://voice-agent-r3fb.onrender.com"><strong>🚀 Try the Live Demo</strong></a>
  &nbsp; | &nbsp;
  <a href="https://github.com/swaroop-khan/Voxhire"><strong>💻 Source Code</strong></a>
</p>

---

## ✨ Features

- **Real-Time Voice Interviews:** Interact with an AI interviewer through a browser-based voice interface.
- **Technical Interview Practice:** Designed around technical questions and interview-style conversations.
- **Adaptive Interview Flow:** Uses interview state and LLM-based reasoning to guide the conversation based on candidate responses.
- **Voice Agent Integration:** Powered by the AssemblyAI Voice Agent API for conversational audio interactions.
- **Web-Based Deployment:** Hosted on Render so users can access the application online.
- **Interview Evaluation Workflow:** Designed to support a structured interview experience and a final interview report.

## 🛠️ Tech Stack

| Technology | Purpose |
|---|---|
| JavaScript | Application and interview logic |
| Node.js | Server-side runtime |
| AssemblyAI Voice Agent API | Real-time voice interaction |
| WebSockets | Live communication |
| Render | Hosting and deployment |

## 🚀 Try VoxHire

**Live application:** [https://voice-agent-r3fb.onrender.com](https://voice-agent-r3fb.onrender.com)

1. Open the live application.
2. Allow microphone access when prompted.
3. Start a voice interview.
4. Respond to the interviewer's questions naturally and follow the conversation.

*Note: The initial page load may take longer if the hosted service has been idle.*

## 🧠 How It Works

1. **Interview Initialization:** The application initializes the voice interview session.
2. **Voice Interaction:** The candidate communicates with the AI interviewer through the browser.
3. **Interview Reasoning:** The interview logic uses the conversation state and LLM-based reasoning to guide the next steps.
4. **Interview Progression:** The interview proceeds according to the current interview state and candidate responses.
5. **Reporting:** The workflow is designed to support a final interview report.

## ⚙️ Run Locally

### Prerequisites

- Node.js 18 or later
- An AssemblyAI API key
- A modern browser with microphone access

### 1. Clone the repository

```bash
git clone https://github.com/swaroop-khan/Voxhire.git
cd Voxhire
```

### 2. Configure environment variables

Create a `.env` file in the project root and add your AssemblyAI API key:

```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key
```

Configure any additional environment variables required by your current deployment configuration. **Never commit API keys or other secrets to GitHub.**

### 3. Install dependencies

```bash
npm install
```

### 4. Start the application

```bash
npm start
```

Open the local URL printed by the server, or visit `http://localhost:3000` if the application is configured to use that port.

## ☁️ Deployment

VoxHire is deployed on [Render](https://render.com/).

The server hosts the web application and handles the creation of voice-agent sessions. The AssemblyAI API key should remain server-side and be configured through Render's environment settings.

- **Live Demo:** [VoxHire on Render](https://voice-agent-r3fb.onrender.com)
- **Repository:** [swaroop-khan/Voxhire](https://github.com/swaroop-khan/Voxhire)

## 📚 References

- [AssemblyAI Voice Agent API Documentation](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
- [Node.js Documentation](https://nodejs.org/en/docs)
- [Render Documentation](https://render.com/docs)

## 👨‍💻 Author

**Swaroop Khan**

- [GitHub](https://github.com/swaroop-khan)
- [LinkedIn](https://www.linkedin.com/in/swaroop-khan/)

---

*VoxHire — Making technical interview practice more interactive through AI-powered voice conversations.*
