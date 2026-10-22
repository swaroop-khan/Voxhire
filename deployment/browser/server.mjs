#!/usr/bin/env node
// VoxHire browser deployment for AssemblyAI Voice Agent API.
// Keeps the official starter's audio path intact and adds local interview state.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import {
  aai,
  loadEnv,
  publishAgent,
  readAgent,
  required,
  storedAgentId,
  voiceAgentWsUrl,
} from '../../lib.mjs'

loadEnv()

required(
  'ASSEMBLYAI_API_KEY',
  'get one at https://www.assemblyai.com/dashboard/api-keys'
)

const AGENT = await (async () => {
  const name = process.env.AGENT || 'minimal'
  const known = storedAgentId(name)

  if (known) {
    try {
      const agent = await aai(`/agents/${known}`)

      return {
        id: known,
        name: agent.name || 'Your agent',
      }
    } catch (error) {
      console.error(
        `Could not load agent ${known}: ${error.message}`
      )

      process.exit(1)
    }
  }

  const agent = readAgent(name)

  try {
    const { id, created } = await publishAgent(agent, {
      name,
      reuseByName: true,
    })

    console.log(
      `${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`
    )

    return {
      id,
      name: agent.name,
    }
  } catch (error) {
    console.error(
      `Could not publish agents/${name}.jsonc: ${error.message}`
    )

    process.exit(1)
  }
})()

console.log(`Agent: ${AGENT.id}`)
console.log(`Voice Agent WebSocket: ${voiceAgentWsUrl()}`)

// -----------------------------------------------------------------------------
// Browser client
// -----------------------------------------------------------------------------

async function clientApp() {
  const $ = (id) =>
    document.getElementById(id)

  const WIRE_RATE = 24_000
  const AGENT = window.AGENT

  // These modules are served by this Node server below.
  const {
    createInterviewState,
    resetInterview,
    updatePerformance,
  } = await import('/interview/state.mjs')

  const {
    processInterviewDecision,
    recordQuestion,
  } = await import('/interview/controller.mjs')

  const interviewState =
    createInterviewState()

  // Last finalized candidate turn.
  //
  // This is deliberately kept separate from partial transcript text.
  // It is consumed when the agent calls update_interview_state for
  // an answer.
  let lastUserTranscript = ''

  // AssemblyAI requires tool results to be sent after reply.done.
  let pendingToolResults = []
  let insightsRequested = false
  // ---------------------------------------------------------------------------
  // Audio capture
  // ---------------------------------------------------------------------------

  const CAPTURE_WORKLET = `
    class CaptureProcessor extends AudioWorkletProcessor {
      constructor() {
        super()
        this._ratio = sampleRate / ${WIRE_RATE}
        this._pos = 0
        this._prev = 0
        this._src = null
        this._out = null
      }

      _toPcm(samples, len) {
        const pcm = new Int16Array(len)

        for (let i = 0; i < len; i++) {
          const s = Math.max(-1, Math.min(1, samples[i]))
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }

        return pcm
      }

      process(inputs) {
        const ch = inputs[0]?.[0]

        if (!ch) return true

        if (this._ratio === 1) {
          const pcm = this._toPcm(ch, ch.length)

          this.port.postMessage(
            pcm.buffer,
            [pcm.buffer]
          )

          return true
        }

        const n = ch.length

        if (!this._src || this._src.length < n + 1) {
          this._src = new Float32Array(n + 1)

          this._out = new Float32Array(
            Math.ceil((n + 1) / this._ratio) + 2
          )
        }

        const src = this._src
        const out = this._out

        src[0] = this._prev
        src.set(ch, 1)

        let outLen = 0
        let pos = this._pos

        while (pos < n) {
          const i = Math.floor(pos)
          const frac = pos - i

          out[outLen++] =
            src[i] +
            (src[i + 1] - src[i]) * frac

          pos += this._ratio
        }

        this._pos = pos - n
        this._prev = ch[n - 1]

        if (outLen) {
          const pcm =
            this._toPcm(out, outLen)

          this.port.postMessage(
            pcm.buffer,
            [pcm.buffer]
          )
        }

        return true
      }
    }

    registerProcessor(
      'capture',
      CaptureProcessor
    )
  `

  // ---------------------------------------------------------------------------
  // Audio playback
  // ---------------------------------------------------------------------------

  const PLAYBACK_WORKLET = `
    class PlaybackProcessor extends AudioWorkletProcessor {
      constructor() {
        super()

        this._ring =
          new Float32Array(sampleRate * 30)

        this._writePos = 0
        this._readPos = 0
        this._available = 0

        this._step =
          ${WIRE_RATE} / sampleRate

        this._rsPos = 0
        this._rsPrev = 0
        this._drained = false

        this.port.onmessage = (e) => {
          if (e.data === 'stop') {
            this._writePos = 0
            this._readPos = 0
            this._available = 0
            this._rsPos = 0
            this._rsPrev = 0
            this._drained = false
            return
          }

          const int16 =
            new Int16Array(e.data)

          if (!int16.length) return

          if (this._drained) {
            this._rsPrev = 0
            this._rsPos = 0
            this._drained = false
          }

          if (this._step === 1) {
            for (
              let i = 0;
              i < int16.length;
              i++
            ) {
              this._push(
                int16[i] / 32768
              )
            }

            return
          }

          const n = int16.length
          let pos = this._rsPos

          while (pos < n) {
            const i = Math.floor(pos)
            const frac = pos - i

            const a =
              i === 0
                ? this._rsPrev
                : int16[i - 1] / 32768

            const b =
              int16[i] / 32768

            this._push(
              a + (b - a) * frac
            )

            pos += this._step
          }

          this._rsPos = pos - n
          this._rsPrev =
            int16[n - 1] / 32768
        }
      }

      _push(v) {
        if (
          this._available <
          this._ring.length
        ) {
          this._ring[this._writePos] = v

          this._writePos =
            (this._writePos + 1) %
            this._ring.length

          this._available++
        }
      }

      process(inputs, outputs) {
        const output = outputs[0]
        const out = output[0]
        const cap = this._ring.length

        for (
          let i = 0;
          i < out.length;
          i++
        ) {
          if (this._available > 0) {
            out[i] =
              this._ring[this._readPos]

            this._readPos =
              (this._readPos + 1) %
              cap

            this._available--
          } else {
            out[i] = 0
            this._drained = true
          }
        }

        for (
          let ch = 1;
          ch < output.length;
          ch++
        ) {
          output[ch].set(out)
        }

        return true
      }
    }

    registerProcessor(
      'playback',
      PlaybackProcessor
    )
  `

  const blobUrl = (code) =>
    URL.createObjectURL(
      new Blob([code], {
        type: 'application/javascript',
      })
    )

  let ws
  let startingCall = false
  let captureCtx
  let playbackCtx
  let playback
  let mic
  let callStart
  let timer

  // ---------------------------------------------------------------------------
  // Microphone list
  // ---------------------------------------------------------------------------

  async function listMics() {
    if (
      !navigator.mediaDevices?.enumerateDevices
    ) {
      return
    }

    const devices =
      await navigator.mediaDevices.enumerateDevices()

    const inputs = devices
      .filter(
        (device) =>
          device.kind === 'audioinput'
      )
      .filter(
        (device) =>
          device.deviceId !== 'default' &&
          device.deviceId !== 'communications'
      )

    const select = $('mic')
    const chosen = select.value

    select.replaceChildren()

    const auto =
      document.createElement('option')

    auto.value = ''
    auto.textContent =
      'Default microphone'

    select.append(auto)

    inputs.forEach((device, i) => {
      const option =
        document.createElement('option')

      option.value = device.deviceId

      option.textContent =
        device.label ||
        `Microphone ${i + 1}`

      select.append(option)
    })

    if (
      chosen &&
      inputs.some(
        (device) =>
          device.deviceId === chosen
      )
    ) {
      select.value = chosen
    }
  }

  listMics()

  navigator.mediaDevices?.addEventListener?.(
    'devicechange',
    listMics
  )

  $('btn').onclick = () => {
    if (ws?.readyState === 1) {
      if (window.confirm('End this interview now? You can still review the report.')) stop()
      return
    }
    start()
  }

  $('start-interview').onclick = start

  $('retry-interview').onclick = start
  $('retry-interview-live').onclick = start

  $('report-button').onclick =
    showInterviewReport

  $('log-toggle').onclick = () => {
    const hidden =
      document.body.classList.toggle(
        'no-side'
      )

    $('log-toggle').textContent =
      hidden ? 'Show diagnostics' : 'Hide diagnostics'
    $('log-toggle').setAttribute('aria-expanded', String(!hidden))
  }

  $('return-home').onclick = () => {
    if (ws?.readyState === 1 && !window.confirm('End the interview and return to the start screen?')) return
    if (ws?.readyState === 1) stop()
    $('interview-screen').hidden = true
    $('landing').hidden = false
    $('start-interview').focus()
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  const REPORT_DIMENSIONS = [
    ['technicalKnowledge', 'Technical Knowledge'],
    ['reasoning', 'Reasoning'],
    ['problemSolving', 'Problem Solving'],
    ['communication', 'Communication'],
  ]

  function reportText(value) {
    if (
      value === null ||
      value === undefined ||
      value === ''
    ) {
      return 'Not available'
    }

    return String(value)
  }

  function makeReportHeading(text) {
    const heading =
      document.createElement('h3')

    heading.textContent = text

    return heading
  }

  function makeReportList(items, emptyText) {
    const list =
      document.createElement('ul')

    list.className = 'report-list'

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      const empty =
        document.createElement('li')

      empty.className = 'report-empty'
      empty.textContent = emptyText

      list.append(empty)

      return list
    }

    for (const item of items) {
      const li =
        document.createElement('li')

      li.textContent = reportText(item)

      list.append(li)
    }

    return list
  }

  function makeScoreRow(label, score) {
    const row =
      document.createElement('div')

    row.className = 'report-score'

    const top =
      document.createElement('div')

    top.className =
      'report-score-top'

    const name =
      document.createElement('span')

    name.textContent = label

    const value =
      document.createElement('strong')

    value.textContent =
      typeof score === 'number'
        ? `${score}/10`
        : '—'

    top.append(name, value)

    const track =
      document.createElement('div')

    track.className =
      'report-score-track'

    const fill =
      document.createElement('div')

    fill.className =
      'report-score-fill'

    if (typeof score === 'number') {
      fill.style.width =
        `${Math.max(
          0,
          Math.min(10, score)
        ) * 10}%`
    }

    track.append(fill)

    row.append(top, track)

    return row
  }

  function makeAnswerCard(answer, index) {
    const card =
      document.createElement('article')

    card.className =
      'report-answer'

    const title =
      document.createElement('h4')

    title.textContent =
      `Question ${index + 1}`

    card.append(title)

    const question =
      document.createElement('div')

    question.className =
      'report-answer-block'

    const questionLabel =
      document.createElement('span')

    questionLabel.className =
      'report-answer-label'

    questionLabel.textContent =
      'Question'

    const questionText =
      document.createElement('p')

    questionText.textContent =
      reportText(answer?.question)

    question.append(
      questionLabel,
      questionText
    )

    const response =
      document.createElement('div')

    response.className =
      'report-answer-block'

    const responseLabel =
      document.createElement('span')

    responseLabel.className =
      'report-answer-label'

    responseLabel.textContent =
      'Candidate answer'

    const responseText =
      document.createElement('p')

    responseText.textContent =
      reportText(answer?.answer)

    response.append(
      responseLabel,
      responseText
    )

    card.append(
      question,
      response
    )

    if (answer?.evaluation) {
      const evaluation =
        document.createElement('div')

      evaluation.className =
        'report-evaluation'

      const evaluationLabel =
        document.createElement('span')

      evaluationLabel.className =
        'report-answer-label'

      evaluationLabel.textContent =
        'Evaluation'

      evaluation.append(
        evaluationLabel
      )

      const entries =
        Object.entries(
          answer.evaluation
        )

      if (entries.length === 0) {
        const empty =
          document.createElement('p')

        empty.textContent =
          'No evaluation details recorded.'

        evaluation.append(empty)
      } else {
        for (
          const [key, value]
          of entries
        ) {
          const item =
            document.createElement('div')

          item.className =
            'report-evaluation-item'

          const keyEl =
            document.createElement('span')

          keyEl.textContent =
            key.replace(
              /([A-Z])/g,
              ' $1'
            )

          const valueEl =
            document.createElement('strong')

          valueEl.textContent =
            reportText(value)

          item.append(
            keyEl,
            valueEl
          )

          evaluation.append(item)
        }
      }

      card.append(evaluation)
    }

    return card
  }

  function showInterviewReport() {
    updatePerformance(interviewState)

    const body =
      $('report-body')

    body.replaceChildren()

    const state =
      interviewState

    const overview =
      document.createElement('div')

    overview.className =
      'report-overview'

    const overviewItems = [
      ['Topic', state.topic || 'Not selected'],
      ['Status', state.status || 'not_started'],
      [
        'Questions',
        String(state.questionCount || 0),
      ],
      [
        'Duration',
        $('elapsed').textContent || '0:00',
      ],
    ]

    for (
      const [label, value]
      of overviewItems
    ) {
      const item =
        document.createElement('div')

      item.className =
        'report-overview-item'

      const labelEl =
        document.createElement('span')

      labelEl.className =
        'report-meta-label'

      labelEl.textContent = label

      const valueEl =
        document.createElement('strong')

      valueEl.textContent = value

      item.append(
        labelEl,
        valueEl
      )

      overview.append(item)
    }

    body.append(overview)

    const scores = Object.values(state.performance || {})
      .filter(value => typeof value === 'number' && Number.isFinite(value))
    const overall = scores.length
      ? (scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(1)
      : null
    const assessment = document.createElement('section')
    assessment.className = 'report-section'
    assessment.append(makeReportHeading('Overall assessment'))
    const assessmentText = document.createElement('p')
    assessmentText.className = 'report-empty-large'
    assessmentText.textContent = overall === null
      ? 'No scored answers are available for an overall assessment yet.'
      : `Average across the available technical knowledge, reasoning, problem-solving, and communication scores: ${overall}/10. Scores reflect AI-generated feedback from your recorded answers.`
    assessment.append(assessmentText)
    body.append(assessment)

    // Performance
    const performanceSection =
      document.createElement('section')

    performanceSection.className =
      'report-section'

    performanceSection.append(
      makeReportHeading(
        'Performance'
      )
    )

    for (
      const [key, label]
      of REPORT_DIMENSIONS
    ) {
      performanceSection.append(
        makeScoreRow(
          label,
          state.performance?.[key]
        )
      )
    }

    body.append(
      performanceSection
    )

    
    const insightsSection = document.createElement('section')
    insightsSection.className = 'report-section'
    insightsSection.append(makeReportHeading('AI-generated feedback'))
    const insightGrid = document.createElement('div')
    insightGrid.className = 'report-insight-grid'
    const insightGroups = [
      ['Strengths', state.insights?.strengths, 'No strengths recorded.'],
      ['Areas to improve', state.insights?.weaknesses, 'No improvement areas recorded.'],
      ['Knowledge gaps', state.insights?.knowledgeGaps, 'No knowledge gaps recorded.'],
      ['Recommendations', state.insights?.recommendations, 'No recommendations recorded.'],
    ]
    for (const [title, items, emptyText] of insightGroups) {
      const group = document.createElement('div')
      group.className = 'report-insight-group'
      const heading = document.createElement('h4')
      heading.textContent = title
      group.append(heading, makeReportList(items, emptyText))
      insightGrid.append(group)
    }
    insightsSection.append(insightGrid)
    const disclosure = document.createElement('p')
    disclosure.className = 'report-empty-large'
    disclosure.textContent = 'Feedback is AI-generated from the interview and is not an objective certification or hiring decision.'
    insightsSection.append(disclosure)
    body.append(insightsSection)

    // Answers
    const answersSection =
      document.createElement('section')

    answersSection.className =
      'report-section'

    answersSection.append(
      makeReportHeading(
        'Answer Review'
      )
    )

    if (
      !Array.isArray(state.answers) ||
      state.answers.length === 0
    ) {
      const empty =
        document.createElement('p')

      empty.className =
        'report-empty-large'

      empty.textContent =
        'No completed candidate answers have been recorded yet.'

      answersSection.append(empty)
    } else {
      const answers =
        document.createElement('div')

      answers.className =
        'report-answers'

      state.answers.forEach(
        (answer, index) => {
          answers.append(
            makeAnswerCard(
              answer,
              index
            )
          )
        }
      )

      answersSection.append(answers)
    }

    body.append(
      answersSection
    )

    const dialog =
      $('report-dialog')

    if (!dialog.open) {
      dialog.showModal()
    }
  }

  // ---------------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------------

  let agentLoaded = false

  function showTab(name) {
    for (
      const tab of [
        'events',
        'agent',
      ]
    ) {
      $('tab-' + tab)
        .classList.toggle(
          'on',
          tab === name
        )

      $(tab + '-body').hidden =
        tab !== name
    }

    if (
      name === 'agent' &&
      !agentLoaded
    ) {
      agentLoaded = true

      fetch('/agent')
        .then((res) => res.json())
        .then((agent) => {
          $('agent-body')
            .replaceChildren()

          const pre =
            document.createElement('pre')

          pre.textContent =
            JSON.stringify(
              agent,
              null,
              2
            )

          $('agent-body').append(pre)
        })
        .catch(() => {
          agentLoaded = false

          $('agent-body').textContent =
            'Could not load the agent.'
        })
    }
  }

  $('tab-events').onclick =
    () => showTab('events')

  $('tab-agent').onclick =
    () => showTab('agent')

  async function addWorklet(
    ctx,
    code,
    name
  ) {
    const url = blobUrl(code)

    try {
      await ctx.audioWorklet.addModule(
        url
      )
    } finally {
      URL.revokeObjectURL(url)
    }

    return new AudioWorkletNode(
      ctx,
      name
    )
  }

  // ---------------------------------------------------------------------------
  // Start call
  // ---------------------------------------------------------------------------

  async function start() {
    if (startingCall) return
    startingCall = true
    if (ws) {
      const previous = ws
      ws = null
      previous.close()
      releaseAudio()
    }
    $('btn').disabled = true
    $('mic').disabled = true
    $('return-home').disabled = true
    $('start-interview').disabled = true
    $('retry-interview').disabled = true
    $('landing').hidden = true
    $('interview-screen').hidden = false
    $('connection-error').hidden = true
    $('connection-error-live').hidden = true
    $('session-hint').textContent = 'Preparing your interview…'

    setStatus('connecting')

    // A new call gets a fresh interview state.
    resetInterview(interviewState)

    lastUserTranscript = ''
    pendingToolResults = []
    insightsRequested = false
    try {
      const res =
        await fetch('/token')

      if (!res.ok) {
        showConnectionError('Could not prepare a secure voice session. Please try again.')
        setStatus(
          'error',
          'Could not connect'
        )

        reset()
        return
      }

      const { token } =
        await res.json()

      const agentResponse =
        await fetch('/agent')

      if (!agentResponse.ok) {
        showConnectionError('Could not load the interviewer configuration. Please try again.')
        setStatus(
          'error',
          'Could not connect'
        )

        reset()
        return
      }

      const agentConfig =
        await agentResponse.json()

      captureCtx =
        new AudioContext({
          sampleRate: WIRE_RATE,
        })

      playbackCtx =
        new AudioContext({
          sampleRate: WIRE_RATE,
        })

      await Promise.all([
        captureCtx.resume(),
        playbackCtx.resume(),
      ])

      playback =
        await addWorklet(
          playbackCtx,
          PLAYBACK_WORKLET,
          'playback'
        )

      playback.connect(
        playbackCtx.destination
      )

      const deviceId =
        $('mic').value

      mic =
        await navigator.mediaDevices.getUserMedia(
          {
            audio: {
              ...(deviceId
                ? { deviceId }
                : {}),
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: false,
              autoGainControl: false,
            },
          }
        )

      await listMics()

      const capture =
        await addWorklet(
          captureCtx,
          CAPTURE_WORKLET,
          'capture'
        )

      captureCtx
        .createMediaStreamSource(mic)
        .connect(capture)

      const url =
        new URL(
          AGENT.wsUrl
        )

      url.searchParams.set(
        'token',
        token
      )

      ws =
        new WebSocket(url)

      let ready = false

      // -----------------------------------------------------------------------
      // Microphone -> AssemblyAI
      // -----------------------------------------------------------------------

      capture.port.onmessage = ({
        data,
      }) => {
        if (
          !ready ||
          ws.readyState !== 1
        ) {
          return
        }

        const bytes =
          new Uint8Array(data)

        let binary = ''

        for (
          let i = 0;
          i < bytes.length;
          i += 0x8000
        ) {
          binary +=
            String.fromCharCode.apply(
              null,
              bytes.subarray(
                i,
                i + 0x8000
              )
            )
        }

        ws.send(
          JSON.stringify({
            type: 'input.audio',
            audio: btoa(binary),
          })
        )

        logEvent(
          'up',
          'input.audio'
        )
      }

      // -----------------------------------------------------------------------
      // WebSocket opened
      // -----------------------------------------------------------------------

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              system_prompt:
                agentConfig.system_prompt,
              greeting:
                agentConfig.greeting,
              output: {
                voice:
                  agentConfig.voice?.voice_id ||
                  'anna',
              },
            },
          })
        )

        logEvent(
          'up',
          'session.update',
          'inline published agent config'
        )
      }

      // -----------------------------------------------------------------------
      // AssemblyAI events
      // -----------------------------------------------------------------------

      ws.onmessage = ({
        data,
      }) => {
        let msg

        try {
          msg =
            JSON.parse(data)
        } catch {
          logEvent(
            'down',
            'invalid.json',
            String(data)
          )

          return
        }

        switch (msg.type) {
          // -------------------------------------------------------------------
          // Session ready
          // -------------------------------------------------------------------

          case 'session.ready': {
            ready = true
            callStart = Date.now()

            timer =
              setInterval(
                tick,
                1000
              )

            tick()

            setStatus(
              'listening'
            )
            $('session-hint').textContent = 'You’re connected. The interviewer will begin shortly.'

            $('btn').disabled =
              false
            $('btn').hidden = false

            $('btn').textContent =
              'End interview'

            $('btn').classList.add(
              'live'
            )

            logEvent(
              'down',
              msg.type,
              msg.session_id
            )

            // -----------------------------------------------------------------
            // Register the local VoxHire state tool.
            //
            // The tool exposes every evaluation field understood by the
            // existing controller.mjs.
            // -----------------------------------------------------------------

            ws.send(
              JSON.stringify({
                type: 'session.update',
                session: {
                  tools: [
                    {
                      type: 'function',

                      name:
                        'update_interview_state',

                      description:
                        'Update VoxHire interview state after a completed candidate turn. Use this after topic selection, a completed answer, a topic change, or a clear end request. Do not use it for partial speech. For every completed answer, include the candidate answer and evaluate technicalKnowledge, reasoning, problemSolving, and communication from 0 to 10, plus assessment and feedback.',

                      parameters: {
                        type: 'object',

                        properties: {
                          // ---------------------------------------------------
                          // What happened?
                          // ---------------------------------------------------

                          intent: {
                            type: 'string',

                            enum: [
                              'topic_selection',
                              'answer',
                              'clarification',
                              'topic_change',
                              'end',
                            ],
                          },

                          // ---------------------------------------------------
                          // Interview topic
                          // ---------------------------------------------------

                          topic: {
                            type: 'string',

                            description:
                              'The technical interview topic when selecting or changing topic.',
                          },

                          // ---------------------------------------------------
                          // Candidate answer
                          // ---------------------------------------------------

                          answer: {
                            type: 'string',

                            description:
                              'The complete candidate answer to the current interview question. Include this whenever intent is answer.',
                          },

                          // ---------------------------------------------------
                          // Overall assessment
                          // ---------------------------------------------------

                          assessment: {
                            type: 'string',

                            enum: [
                              'strong',
                              'adequate',
                              'weak',
                              'unclear',
                            ],
                          },

                          // ---------------------------------------------------
                          // Evaluation dimensions
                          // ---------------------------------------------------

                          technicalKnowledge: {
                            type: 'number',

                            minimum: 0,
                            maximum: 10,

                            description:
                              'Score the candidate technical knowledge from 0 to 10.',
                          },

                          reasoning: {
                            type: 'number',

                            minimum: 0,
                            maximum: 10,

                            description:
                              'Score the candidate reasoning ability from 0 to 10.',
                          },

                          problemSolving: {
                            type: 'number',

                            minimum: 0,
                            maximum: 10,

                            description:
                              'Score the candidate problem solving ability from 0 to 10.',
                          },

                          communication: {
                            type: 'number',

                            minimum: 0,
                            maximum: 10,

                            description:
                              'Score the candidate communication quality from 0 to 10.',
                          },

                          // ---------------------------------------------------
                          // Written feedback
                          // ---------------------------------------------------

                          feedback: {
                            type: 'string',

                            description:
                              'Concise feedback explaining the evaluation of the candidate answer.',
                          },

                          // ---------------------------------------------------
                          // Difficulty adjustment
                          // ---------------------------------------------------

                          difficulty_action: {
                            type: 'string',

                            enum: [
                              'increase',
                              'decrease',
                              'maintain',
                            ],
                          },
                        },

                        required: [
                          'intent',
                        ],
                      },
                    },
                  ],
                },
              })
            )

            logEvent(
              'up',
              'session.update',
              'registered update_interview_state'
            )

            break
          }

          // -------------------------------------------------------------------
          // Candidate starts speaking
          // -------------------------------------------------------------------

          case 'input.speech.started':
            playback?.port.postMessage(
              'stop'
            )

            setStatus(
              'listening'
            )
            $('session-hint').textContent = 'Listening to your response'

            logEvent(
              'down',
              msg.type
            )

            break

          // -------------------------------------------------------------------
          // Agent starts speaking
          // -------------------------------------------------------------------

          case 'reply.started':
            setStatus(
              'speaking'
            )
            $('session-hint').textContent = 'Your interviewer is speaking'

            logEvent(
              'down',
              msg.type
            )

            break

          // -------------------------------------------------------------------
          // Agent audio
          // -------------------------------------------------------------------

          case 'reply.audio': {
            if (!msg.data) break

            const raw =
              atob(msg.data)

            const bytes =
              new Uint8Array(
                raw.length
              )

            for (
              let i = 0;
              i < raw.length;
              i++
            ) {
              bytes[i] =
                raw.charCodeAt(i)
            }

            playback?.port.postMessage(
              bytes.buffer,
              [bytes.buffer]
            )

            logEvent(
              'down',
              msg.type
            )

            break
          }

          // -------------------------------------------------------------------
          // Agent finished a reply
          // -------------------------------------------------------------------

          case 'reply.done': {
            setStatus(
              'listening'
            )
            $('session-hint').textContent = 'Your turn — speak when you’re ready'

            if (
              msg.status ===
              'interrupted'
            ) {
              playback?.port.postMessage(
                'stop'
              )

              // Tool results from an interrupted reply must not be sent.
              pendingToolResults =
                []
            } else {
              // AssemblyAI expects tool.result after reply.done.
              for (
              const tool
              of pendingToolResults
            ) {
              if (
                !tool?.call_id
              ) {
                continue
              }

              ws.send(
                JSON.stringify({
                  type:
                    'tool.result',

                  call_id:
                    tool.call_id,

                  result:
                    JSON.stringify(
                      tool.result
                    ),
                })
              )

              logEvent(
                'up',
                'tool.result',
                tool.call_id
              )
            }

            // -----------------------------------------------------------------
            // If the interview has ended, give the model a fresh turn after
            // delivering the completed decision. This allows it to call
            // generate_interview_insights using the finalized interview state.
            // -----------------------------------------------------------------

            const interviewCompleted =
              pendingToolResults.some(
                tool =>
                  tool?.result?.status ===
                  'completed'
              )

            pendingToolResults =
              []

            if (
              interviewCompleted
            ) {
              ws.send(
                JSON.stringify({
                  type:
                    'response.create',

                  response: {
                    instructions:
                      'The interview is complete. Now immediately call generate_interview_insights using the completed interview evidence. Do not end the session before generating the insights.'
                  }
                })
              )

              logEvent(
                'up',
                'response.create',
                'generate_interview_insights after interview completion'
              )
            }
            }

            logEvent(
              'down',
              msg.type,
              msg.status
            )

            break
          }

          // -------------------------------------------------------------------
          // User partial transcript
          // -------------------------------------------------------------------

          case 'transcript.user.delta':
            partial(
              'you',
              msg.text
            )

            logEvent(
              'down',
              msg.type,
              msg.text
            )

            break

          // -------------------------------------------------------------------
          // Agent partial transcript
          // -------------------------------------------------------------------

          case 'transcript.agent.delta':
            logEvent(
              'down',
              msg.type,
              msg.delta
            )

            if (
              msg.reply_id &&
              msg.reply_id ===
                printedReply
            ) {
              break
            }

            if (
              msg.reply_id !==
              liveReply
            ) {
              liveReply =
                msg.reply_id

              dropPartial(
                'agent'
              )
            }

            partial(
              'agent',
              appendDelta(
                partialText.agent ||
                  '',
                msg.delta
              )
            )

            break

          // -------------------------------------------------------------------
          // Final user transcript
          // -------------------------------------------------------------------

          case 'transcript.user': {
            const transcript =
              String(
                msg.text || ''
              ).trim()

            lastUserTranscript =
              transcript

            setStatus('processing')
            $('session-hint').textContent = 'Response received. Preparing the next question…'

            addLine(
              'you',
              msg.text
            )

            logEvent(
              'down',
              msg.type,
              msg.text
            )

            break
          }

          // -------------------------------------------------------------------
          // Final agent transcript
          // -------------------------------------------------------------------

          case 'transcript.agent': {
            printedReply =
              msg.reply_id ?? 
              printedReply

            addLine(
              'agent',
              msg.text
            )

            // Record spoken questions.
            if (
              interviewState.status ===
                'interviewing' &&
              typeof msg.text ===
                'string' &&
              msg.text
                .trim()
                .endsWith('?')
            ) {
              recordQuestion(
                interviewState,
                msg.text.trim()
              )
            }

            break
          }

          // -------------------------------------------------------------------
          // Local VoxHire tool call
          // -------------------------------------------------------------------

          case 'tool.call': {
            const args =
              msg.arguments &&
              typeof msg.arguments ===
                'object' &&
              !Array.isArray(msg.arguments)
                ? msg.arguments
                : {}

            const argsText =
              JSON.stringify(args)

            addLine(
              'tool',
              `${msg.name}(${argsText})`
            )

            logEvent(
              'down',
              msg.type,
              `${msg.name} ${argsText}`
            )

            if (
              msg.name !==
              'update_interview_state'
            ) {
              // Unknown tools are intentionally not executed.
              // The published agent should only request tools that are
              // registered in this session.
              break
            }

            const decision = {
              ...args,
            }

            // -----------------------------------------------------------------
            // FIX:
            //
            // The previous implementation checked:
            //
            //   if (!lastUserTranscript) {
            //     decision.answer = lastUserTranscript
            //   }
            //
            // which could only assign an empty value.
            //
            // We now use the latest finalized candidate transcript only when
            // the model did not provide an explicit answer.
            // -----------------------------------------------------------------

            if (
              decision.intent ===
                'answer' &&
              !String(
                decision.answer || ''
              ).trim() &&
              lastUserTranscript
            ) {
              decision.answer =
                lastUserTranscript
            }

            // -----------------------------------------------------------------
            // Process the complete decision through the existing controller.
            // -----------------------------------------------------------------

            processInterviewDecision(
              interviewState,
              decision
            )
            if (
              decision.intent === 'end' &&
              interviewState.status === 'completed'
            ) {
              setStatus('completed')
              $('session-hint').textContent = 'Interview complete. Your report is ready.'
              insightsRequested = true

              console.log(
                '🔥 INTERVIEW COMPLETED — requesting final insights'
              )
            }

            // Keep performance synchronized with answer evaluations.
            updatePerformance(
              interviewState
            )

            // -----------------------------------------------------------------
            // Once an answer has been processed, consume the finalized
            // transcript so it cannot accidentally become the answer for a
            // subsequent tool call.
            // -----------------------------------------------------------------

            if (
              decision.intent ===
                'answer'
            ) {
              lastUserTranscript =
                ''
            }

            const snapshot = {
              topic:
                interviewState.topic,

              difficulty:
                interviewState.difficulty,

              questionCount:
                interviewState.questionCount,

              status:
                interviewState.status,

              answers:
                Array.isArray(
                  interviewState.answers
                )
                  ? interviewState.answers.length
                  : 0,

              performance:
                interviewState.performance,
            }

            logEvent(
              'down',
              'interview.state',
              JSON.stringify(
                snapshot
              )
            )

           if (msg.call_id) {
           pendingToolResults.push({
            call_id: msg.call_id,
            result:
              decision.intent === 'end'
                ? {
                    status: 'completed',
                    message:
                      'The interview is now complete. Immediately call generate_interview_insights using the completed interview evidence. Do not end the session before generating the insights.',
                  }
                : {
                    status: 'updated',
                  },
          });
          }

          break;
          }

          // -------------------------------------------------------------------
          // Session ended
          // -------------------------------------------------------------------

          case 'session.ended':
            if (interviewState.status === 'completed') {
              setStatus('completed')
              $('session-hint').textContent = 'Interview complete. Your report is ready.'
            }
            logEvent(
              'down',
              msg.type
            )

            ws.close()

            break

          // -------------------------------------------------------------------
          // API error
          // -------------------------------------------------------------------

          case 'session.error':
            showConnectionError('The voice session encountered a problem. You can retry the connection.')
            setStatus(
              'error',
              'Connection issue'
            )

            logEvent(
              'down',
              msg.type,
              `${msg.code || ''}: ${
                msg.message || ''
              }`
            )

            break

          default:
            logEvent(
              'down',
              msg.type
            )
        }
      }

      ws.onclose = (event) => {
        if (ws !== event.currentTarget) return
        ws = null
        releaseAudio()
        if ($('status').classList.contains('error')) {
          showConnectionError('The connection closed. Check your connection and try again.')
        } else if (interviewState.status !== 'completed') {
          setStatus('idle')
        }
        reset()

        // Do NOT reset interviewState here.
        // The report must remain available after the call ends.
      }

      ws.onerror = (event) => {
        if (ws !== event.currentTarget) return
        releaseAudio()
        showConnectionError('Could not reach the voice service. Check your connection and retry.')
        setStatus(
          'error',
          'Connection issue'
        )

        reset()
      }
    } catch (error) {
      releaseAudio()
      showConnectionError(error?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow microphone access in your browser, then try again.'
        : 'Could not start the interview. Check your microphone and connection, then try again.')
      setStatus(
        'error',
        'Could not connect'
      )

      reset()
    } finally {
      startingCall = false
    }
  }

  // ---------------------------------------------------------------------------
  // Stop call
  // ---------------------------------------------------------------------------

  function stop() {
    pendingToolResults = []

    if (
      ws?.readyState === 1
    ) {
      const socket = ws
      socket.send(
        JSON.stringify({
          type: 'session.end',
        })
      )

      logEvent(
        'up',
        'session.end'
      )

      ws = null

      setTimeout(() => {
        if (
          socket.readyState === 1
        ) {
          socket.close()
        }
      }, 3000)
    } else {
      const socket = ws
      ws = null
      socket?.close()
    }

    releaseAudio()
    reset()
    setStatus('idle')
    $('session-hint').textContent = 'Interview ended. Your report is ready to review.'
  }

  function releaseAudio() {
    playback?.port.postMessage('stop')
    mic?.getTracks().forEach(track => track.stop())
    captureCtx?.close()
    playbackCtx?.close()
    captureCtx = playbackCtx = playback = mic = null
  }

  // ---------------------------------------------------------------------------
  // UI reset
  // ---------------------------------------------------------------------------

  function reset() {
    clearInterval(timer)

    clearPartials()

    open.forEach((run) =>
      paint(run, true)
    )

    open.clear()

    $('btn').disabled = true
    $('mic').disabled = false
    $('return-home').disabled = false

    $('btn').textContent =
      'End interview'

    $('btn').classList.remove(
      'live'
    )
    $('btn').textContent = 'End interview'
    $('btn').disabled = true
    $('btn').hidden = true
    $('mic').disabled = false
    $('start-interview').disabled = false
    $('retry-interview').disabled = false
  }

  function setStatus(
    state,
    detail
  ) {
    $('status').className =
      'status ' + state

    $('status-text').textContent =
      detail || state
    $('voice-orb').dataset.state = state
    $('voice-state').textContent = ({
      idle: 'Ready when you are',
      connecting: 'Connecting to your interviewer…',
      listening: 'Listening',
      speaking: 'Interviewer speaking',
      processing: 'Thinking through your answer',
      error: detail || 'Connection issue',
      completed: 'Interview complete',
    })[state] || state
  }

  function showConnectionError(message) {
    $('connection-error').hidden = false
    $('connection-error-text').textContent = message
    $('connection-error-live').hidden = false
    $('connection-error-text-live').textContent = message
    $('session-hint').textContent = 'The voice session needs attention.'
  }

  const COST_PER_SECOND =
    4.5 / 3600

  function tick() {
    const seconds =
      Math.floor(
        (Date.now() - callStart) /
          1000
      )

    $('elapsed').textContent =
      Math.floor(
        seconds / 60
      ) +
      ':' +
      String(
        seconds % 60
      ).padStart(2, '0')
    $('elapsed-live').textContent = $('elapsed').textContent

    $('cost').textContent =
      '$' +
      (
        seconds *
        COST_PER_SECOND
      ).toFixed(3)
  }

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  const partialText = {}
  const partialEl = {}

  let liveReply = null
  let printedReply = null

  const ATTACHES_LEFT =
    /^[.,!?;:%°)\]}…'"’”]/

  const NO_SPACE_AFTER =
    /[([{$\-\/'"‘“]$/

  function appendDelta(
    text,
    delta
  ) {
    if (!delta) return text

    if (!text) return delta

    if (
      /^\s/.test(delta) ||
      /\s$/.test(text)
    ) {
      return text + delta
    }

    if (
      ATTACHES_LEFT.test(delta) ||
      NO_SPACE_AFTER.test(text)
    ) {
      return text + delta
    }

    return (
      text +
      ' ' +
      delta
    )
  }

  function dropPartial(who) {
    partialEl[who]?.remove()

    delete partialEl[who]
    delete partialText[who]
  }

  function transcriptLine(
    who,
    text,
    cls
  ) {
    const line =
      document.createElement('div')

    line.className =
      'line ' +
      who +
      (cls
        ? ' ' + cls
        : '')

    const label =
      document.createElement('span')

    label.className = 'who'

    label.textContent =
      who === 'agent'
        ? AGENT.name
        : who

    const body =
      document.createElement('span')

    body.className = 'said'
    body.textContent = text

    line.append(
      label,
      body
    )

    return line
  }

  function clearEmpty(el) {
    const empty =
      el.querySelector(
        '.empty'
      )

    if (empty) {
      empty.remove()
    }
  }

  function scroll(el) {
    el.scrollTop =
      el.scrollHeight
  }

  function partial(
    who,
    text
  ) {
    clearEmpty(
      $('transcript')
    )

    partialText[who] =
      text

    if (
      partialEl[who]
    ) {
      partialEl[who]
        .querySelector(
          '.said'
        )
        .textContent = text
    } else {
      partialEl[who] =
        transcriptLine(
          who,
          text,
          'partial'
        )

      $('transcript').append(
        partialEl[who]
      )
    }

    scroll(
      $('transcript')
    )
  }

  function addLine(
    who,
    text
  ) {
    clearEmpty(
      $('transcript')
    )

    dropPartial(who)

    $('transcript').append(
      transcriptLine(
        who,
        text
      )
    )

    scroll(
      $('transcript')
    )
  }

  function clearPartials() {
    for (
      const who of Object.keys(
        partialEl
      )
    ) {
      dropPartial(who)
    }

    liveReply =
      printedReply =
        null
  }

  // ---------------------------------------------------------------------------
  // Event log
  // ---------------------------------------------------------------------------

  const COALESCE =
    new Set([
      'input.audio',
      'reply.audio',
      'transcript.user.delta',
      'transcript.agent.delta',
    ])

  const open = new Map()

  function eventRow(
    direction,
    type,
    detail
  ) {
    const row =
      document.createElement('div')

    row.className =
      'event ' +
      direction

    const at =
      document.createElement('span')

    at.className = 'at'

    at.textContent =
      (
        callStart
          ? (
              (Date.now() -
                callStart) /
              1000
            )
          : 0
      ).toFixed(1) +
      's'

    const arrow =
      document.createElement('span')

    arrow.className = 'dir'

    arrow.textContent =
      direction === 'up'
        ? '↑'
        : '↓'

    const name =
      document.createElement('span')

    name.className = 'type'
    name.textContent = type

    const count =
      document.createElement('span')

    count.className = 'count'

    const info =
      document.createElement('span')

    info.className = 'detail'

    if (detail) {
      info.textContent =
        detail
    }

    row.append(
      at,
      arrow,
      name,
      count,
      info
    )

    return row
  }

  function paint(
    live,
    final
  ) {
    const now =
      performance.now()

    if (
      !final &&
      now - live.painted <
        100
    ) {
      return
    }

    live.painted = now

    live.row
      .querySelector(
        '.count'
      )
      .textContent =
      live.count > 1
        ? '×' + live.count
        : ''

    if (live.detail) {
      live.row
        .querySelector(
          '.detail'
        )
        .textContent =
        live.detail
    }
  }

  function logEvent(
    direction,
    type,
    detail
  ) {
    const log =
      $('events-body')

    clearEmpty(log)

    const key =
      direction +
      ' ' +
      type

    const live =
      open.get(key)

    if (live) {
      live.count++

      if (detail) {
        live.detail = detail
      }

      paint(live)

      return
    }

    if (
      !COALESCE.has(type)
    ) {
      open.forEach((run) =>
        paint(run, true)
      )

      open.clear()
    }

    const atBottom =
      log.scrollHeight -
        log.scrollTop -
        log.clientHeight <
      40

    const row =
      eventRow(
        direction,
        type,
        detail
      )

    log.append(row)

    while (
      log.children.length >
      400
    ) {
      log.firstChild.remove()
    }

    if (
      COALESCE.has(type)
    ) {
      open.set(key, {
        row,
        count: 1,
        detail,
        painted: 0,
      })
    }

    if (atBottom) {
      scroll(log)
    }
  }
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>VoxHire Interviewer</title>

<style>

  :root {
    color-scheme: dark;
    --page-bg: #080d19;
    --surface: #101827;
    --surface-raised: #151f31;
    --surface-soft: #0c1422;
    --border: #263349;
    --text: #dce5f3;
    --text-strong: #f4f7fc;
    --text-muted: #9caec5;
    --text-faint: #72839a;
    --accent: #8b9cff;
    --accent-strong: #aab5ff;
    --green: #67d7ae;
    --amber: #f3c879;
    --error: #ff8d98;
    --radius: 18px;
  }
  *,*::before,*::after {
    box-sizing: border-box;
  }
  html,body {
    min-height: 100%;
  }
  body {
    margin: 0;
    color: var(--text);
    background: radial-gradient(ellipse at 50% -20%,#1b2948 0,transparent 52%),var(--page-bg);
    font: 15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  button,select {
    font: inherit;
  }
  button {
    color: inherit;
  }
  button:focus-visible,select:focus-visible,summary:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  main {
    width: min(1120px,calc(100% - 48px));
    min-height: 100vh;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }
  header {
    height: 78px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid rgba(156,174,197,.15);
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 11px;
    color: var(--text-strong);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -.03em;
    margin-right: auto;
  }
  .brand-mark {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border: 1px solid #52628a;
    border-radius: 10px;
    color: var(--accent-strong);
    background: #1c2943;
  }
  .brand-mark svg {
    width: 19px;
    height: 19px;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .status::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .status.listening {
    color: var(--green);
  }
  .status.speaking {
    color: var(--accent-strong);
  }
  .status.connecting,.status.processing {
    color: var(--amber);
  }
  .status.error {
    color: var(--error);
  }
  .meter {
    display: flex;
    gap: 10px;
    color: var(--text-faint);
    font: 12px ui-monospace,monospace;
  }
  #cost {
    display: none;
  }
  button {
    min-height: 46px;
    padding: 0 20px;
    border: 1px solid transparent;
    border-radius: 12px;
    background: var(--accent);
    color: #101426;
    font-weight: 700;
    cursor: pointer;
    transition: background .18s ease,border-color .18s ease,transform .18s ease;
  }
  button:hover:not(:disabled) {
    background: var(--accent-strong);
    transform: translateY(-1px);
  }
  button:disabled {
    opacity: .58;
    cursor: wait;
  }
  button.secondary {
    background: transparent;
    color: var(--text);
    border-color: var(--border);
  }
  button.secondary:hover:not(:disabled) {
    background: var(--surface-raised);
  }
  button.danger {
    background: transparent;
    color: #ffabb1;
    border-color: #70434d;
  }
  button.danger:hover:not(:disabled) {
    background: #2c1b27;
  }
  select {
    min-height: 44px;
    max-width: 100%;
    padding: 0 12px;
    color: var(--text);
    background: var(--surface-soft);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .landing {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 48px 0 72px;
  }
  .landing-inner {
    width: min(890px,100%);
    display: grid;
    grid-template-columns: 1.05fr .95fr;
    align-items: center;
    gap: 64px;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 22px;
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .13em;
    text-transform: uppercase;
  }
  .eyebrow::before {
    content: "";
    width: 22px;
    height: 1px;
    background: currentColor;
  }
  h2,h3,h4,p {
    margin-top: 0;
  }
  .landing h2 {
    max-width: 520px;
    margin-bottom: 20px;
    color: var(--text-strong);
    font-size: clamp(42px,6vw,64px);
    line-height: 1.04;
    letter-spacing: -.055em;
  }
  .landing h2 span {
    color: var(--accent-strong);
  }
  .lead {
    max-width: 470px;
    margin-bottom: 30px;
    color: var(--text-muted);
    font-size: 17px;
  }
  .start-row {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .start-row button {
    min-width: 172px;
  }
  .mic-note {
    max-width: 195px;
    color: var(--text-faint);
    font-size: 12px;
  }
  .error-box {
    margin-top: 18px;
    padding: 14px 16px;
    border: 1px solid #70434d;
    border-radius: 12px;
    background: #251823;
    color: #ffd4d7;
  }
  .error-box p {
    margin: 0 0 10px;
  }
  .voice-art {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 350px;
    border: 1px solid rgba(156,174,197,.15);
    border-radius: 30px;
    background: linear-gradient(145deg,rgba(28,42,68,.88),rgba(13,21,35,.85));
    overflow: hidden;
  }
  .voice-art::before,.voice-art::after {
    content: "";
    position: absolute;
    width: 270px;
    height: 270px;
    border: 1px solid rgba(139,156,255,.12);
    border-radius: 50%;
  }
  .voice-art::after {
    width: 340px;
    height: 340px;
  }
  .art-core {
    z-index: 1;
    width: 148px;
    height: 148px;
    display: grid;
    place-items: center;
    border: 1px solid #6375ac;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 30%,#354878,#17233e 68%);
    box-shadow: 0 0 90px rgba(111,130,228,.18);
    color: #c4ceff;
  }
  .art-core svg {
    width: 74px;
    height: 74px;
  }
  .art-label {
    position: absolute;
    z-index: 2;
    bottom: 26px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .process {
    display: grid;
    grid-template-columns: repeat(3,1fr);
    gap: 12px;
    margin-top: 26px;
  }
  .process-step {
    padding: 14px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 12px;
  }
  .process-step strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text);
    font-size: 13px;
  }
  .interview-screen {
    flex: 1;
    padding: 34px 0 48px;
  }
  .interview-top {
    display: flex;
    align-items: center;
    gap: 18px;
    margin-bottom: 22px;
  }
  .interview-top h2 {
    margin: 0 auto 0 0;
    color: var(--text-strong);
    font-size: 22px;
    letter-spacing: -.03em;
  }
  .interview-grid {
    display: grid;
    grid-template-columns: minmax(0,1fr) 300px;
    gap: 18px;
    align-items: stretch;
    min-width: 0;
  }
  .voice-panel,.transcript-panel,.side-pane {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: rgba(16,24,39,.88);
  }
  .voice-panel {
    min-height: 365px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 30px;
    text-align: center;
  }
  .voice-orb {
    width: 122px;
    height: 122px;
    display: grid;
    place-items: center;
    margin-bottom: 21px;
    border: 1px solid #415177;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 32%,#354878,#17233e 72%);
    color: #c4ceff;
    transition: box-shadow .3s ease,transform .3s ease;
  }
  .voice-orb svg {
    width: 48px;
    height: 48px;
  }
  .voice-orb[data-state="speaking"] {
    box-shadow: 0 0 0 14px rgba(139,156,255,.08),0 0 58px rgba(139,156,255,.28);
  }
  .voice-orb[data-state="listening"] {
    box-shadow: 0 0 0 12px rgba(103,215,174,.07);
  }
  .voice-orb[data-state="error"] {
    border-color: #9b535c;
  }
  .voice-panel h3 {
    margin-bottom: 5px;
    color: var(--text-strong);
    font-size: 20px;
  }
  .voice-panel p {
    min-height: 25px;
    margin-bottom: 24px;
    color: var(--text-muted);
  }
  .session-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .mic-control {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .mic-control select {
    min-height: 34px;
    max-width: 190px;
    border: 0;
    background: transparent;
    font-size: 12px;
  }
  .transcript-panel {
    min-height: 320px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 15px 18px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-weight: 650;
  }
  .pane-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 18px;
  }
  #transcript {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .empty {
    color: var(--text-faint);
    font-size: 13px;
  }
  .line {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 14px;
    line-height: 1.55;
  }
  .who {
    color: var(--accent-strong);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .line.you .who {
    color: var(--green);
  }
  .line .said {
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line.partial .said {
    color: var(--text-muted);
  }
  .line.tool {
    padding-top: 10px;
    border-top: 1px solid var(--border);
    color: var(--text-faint);
    font: 11px/1.5 ui-monospace,monospace;
  }
  .line.tool .said {
    color: var(--text-faint);
    overflow-wrap: anywhere;
  }
  .pane-foot {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-top: 1px solid var(--border);
  }
  #report-button {
    margin-left: auto;
  }
  .side-pane {
    margin-top: 18px;
    overflow: hidden;
  }
  body.no-side #side {
    display: none;
  }
  .ghost {
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--text-faint);
    font-size: 12px;
  }
  .ghost:hover:not(:disabled) {
    background: transparent;
    color: var(--accent-strong);
  }
  .tabs {
    display: flex;
    gap: 10px;
  }
  .tab.on {
    color: var(--text-strong);
  }
  #events-body {
    font: 11px/1.8 ui-monospace,monospace;
  }
  .event {
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: nowrap;
  }
  .event .at,.event .dir,.event .count {
    color: var(--text-faint);
  }
  .event .type {
    color: var(--text);
  }
  .event.up .type {
    color: var(--text-muted);
  }
  .event .detail {
    overflow: hidden;
    color: var(--text-faint);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  #agent-body pre {
    font: 11px/1.6 ui-monospace,monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .report-actions {
    display: flex;
    justify-content: flex-end;
    padding: 16px 0 0;
  }
  #report-dialog {
    width: min(900px,calc(100vw - 32px));
    max-height: calc(100vh - 40px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 24px 80px rgba(0,0,0,.55);
    overflow: hidden;
  }
  #report-dialog::backdrop {
    background: rgba(4,8,16,.78);
  }
  .report-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 22px;
    background: var(--surface-raised);
    border-bottom: 1px solid var(--border);
  }
  .report-dialog-head h2 {
    margin: 0;
    color: var(--text-strong);
    font-size: 22px;
  }
  .report-dialog-actions {
    display: flex;
    gap: 8px;
  }
  .report-dialog-actions button {
    margin-left: 0;
  }
  .report-close {
    background: transparent;
    color: var(--text-muted);
    border-color: var(--border);
  }
  #report-body {
    max-height: calc(100vh - 125px);
    overflow: auto;
    padding: 24px;
  }
  .report-overview {
    display: grid;
    grid-template-columns: repeat(4,minmax(0,1fr));
    gap: 10px;
    margin-bottom: 22px;
  }
  .report-overview-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-raised);
  }
  .report-meta-label {
    color: var(--text-muted);
    font-size: 11px;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .report-overview-item strong {
    color: var(--text-strong);
    font-size: 15px;
  }
  .report-section {
    margin-top: 22px;
  }
  .report-section h3 {
    margin-bottom: 12px;
    color: var(--text-strong);
    font-size: 17px;
  }
  .report-score {
    margin-bottom: 12px;
  }
  .report-score-top {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
    font-size: 13px;
  }
  .report-score-top strong {
    color: var(--text-strong);
  }
  .report-score-track {
    width: 100%;
    height: 8px;
    overflow: hidden;
    border-radius: 99px;
    background: var(--surface-soft);
    border: 1px solid var(--border);
  }
  .report-score-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }
  .report-insight-grid {
    display: grid;
    grid-template-columns: repeat(2,minmax(0,1fr));
    gap: 12px;
  }
  .report-insight-group {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-raised);
  }
  .report-insight-group h4 {
    margin: 0 0 8px;
    color: var(--text-strong);
    font-size: 14px;
  }
  .report-list {
    padding-left: 18px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .report-list li+li {
    margin-top: 5px;
  }
  .report-empty {
    list-style: none;
    margin-left: -18px;
    color: var(--text-faint);
  }
  .report-empty-large {
    color: var(--text-muted);
    font-size: 13px;
  }
  .report-answers {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .report-answer {
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface-raised);
  }
  .report-answer h4 {
    margin: 0 0 12px;
    color: var(--text-strong);
    font-size: 14px;
  }
  .report-answer-block {
    margin-top: 10px;
  }
  .report-answer-label {
    display: block;
    margin-bottom: 4px;
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .report-answer-block p {
    margin: 0;
    color: var(--text);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .report-evaluation {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .report-evaluation-item {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 5px 0;
    font-size: 12px;
  }
  .report-evaluation-item span {
    color: var(--text-muted);
  }
  .report-evaluation-item strong {
    color: var(--text-strong);
  }
  [hidden] {
    display: none !important;
  }
  @media (max-width:880px) {
    .landing-inner {
      gap: 32px;
    }
    .interview-grid {
      grid-template-columns: minmax(0,1fr);
    }
    .transcript-panel {
      min-height: 260px;
    }
    .report-overview {
      grid-template-columns: repeat(2,minmax(0,1fr));
    }
  }
  @media (max-width:600px) {
    main {
      width: calc(100% - 32px);
    }
    header {
      height: 66px;
    }
    .brand {
      font-size: 16px;
    }
    .status {
      font-size: 11px;
    }
    .meter {
      display: none;
    }
    .landing {
      padding: 38px 0 52px;
    }
    .landing-inner {
      grid-template-columns: 1fr;
      gap: 28px;
    }
    .landing h2 {
      font-size: 44px;
    }
    .lead {
      font-size: 15px;
    }
    .voice-art {
      min-height: 230px;
      border-radius: 22px;
    }
    .voice-art::before {
      width: 190px;
      height: 190px;
    }
    .voice-art::after {
      width: 250px;
      height: 250px;
    }
    .art-core {
      width: 112px;
      height: 112px;
    }
    .art-core svg {
      width: 58px;
      height: 58px;
    }
    .process {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .process-step {
      padding: 10px 0;
    }
    .interview-screen {
      padding: 22px 0 36px;
    }
    .interview-top {
      flex-wrap: wrap;
      gap: 10px;
    }
    .interview-top h2 {
      width: 100%;
      order: -1;
      font-size: 19px;
    }
    .voice-panel {
      min-height: 310px;
      padding: 22px 16px;
    }
    .voice-orb {
      width: 100px;
      height: 100px;
    }
    .session-actions {
      width: 100%;
    }
    .session-actions>button {
      flex: 1;
    }
    .mic-control {
      width: 100%;
      justify-content: space-between;
    }
    .mic-control select {
      max-width: 62%;
    }
    .pane-foot {
      flex-wrap: wrap;
      padding: 12px;
    }
    #report-button {
      width: 100%;
      margin-left: 0;
    }
    .report-overview,.report-insight-grid {
      grid-template-columns: 1fr;
    }
    #report-dialog {
      width: calc(100vw - 20px);
      max-height: calc(100vh - 20px);
    }
    #report-body {
      max-height: calc(100vh - 115px);
      padding: 16px;
    }
  }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after {
      scroll-behavior: auto !important;
      transition: none !important;
      animation: none !important;
    }
  }
</style>

</head>

<body class="no-side">

<main>
<header>
  <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 10v4m4-8v12m4-15v18m4-13v8m4-5v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>VoxHire</div>
  <span class="status idle" id="status" aria-live="polite"><span id="status-text">Ready</span></span>
  <span class="meter" aria-label="Interview duration"><span id="elapsed">0:00</span><span id="cost">$0.000</span></span>
</header>
<section class="landing" id="landing" aria-labelledby="landing-title">
  <div class="landing-inner">
    <div>
      <span class="eyebrow">Adaptive voice interviews</span>
      <h2 id="landing-title">Meet your next <span>technical interviewer.</span></h2>
      <p class="lead">Practice a real technical conversation with an AI interviewer that listens, follows up, and adapts questions to your answers.</p>
      <div class="start-row"><button id="start-interview" type="button">Start interview <span aria-hidden="true">→</span></button><span class="mic-note">You’ll be asked to allow microphone access before the conversation begins.</span></div>
      <div class="error-box" id="connection-error" role="alert" hidden><p id="connection-error-text"></p><button class="secondary" id="retry-interview" type="button">Try again</button></div>
      <div class="process" aria-label="Interview steps"><div class="process-step"><strong>01 · Choose a topic</strong>Tell the interviewer what you want to practice.</div><div class="process-step"><strong>02 · Talk it through</strong>Answer aloud; questions adapt as you go.</div><div class="process-step"><strong>03 · Review feedback</strong>See your recorded answers and assessment.</div></div>
    </div>
    <div class="voice-art" aria-hidden="true"><div class="art-core"><svg viewBox="0 0 72 72" fill="none"><path d="M12 30v12m12-24v36m12-48v60m12-42v24m12-18v12" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg></div><div class="art-label">A focused space to think out loud</div></div>
  </div>
</section>
<section class="interview-screen" id="interview-screen" aria-labelledby="interview-title" hidden>
  <div class="interview-top"><h2 id="interview-title">Your interview</h2><span class="meter"><span id="elapsed-live">0:00</span></span><button class="secondary" id="return-home" type="button">Back to start</button></div>
  <div class="interview-grid">
    <section class="voice-panel" aria-label="Voice session controls">
      <div class="voice-orb" id="voice-orb" data-state="idle" aria-hidden="true"><svg viewBox="0 0 72 72" fill="none"><path d="M12 30v12m12-24v36m12-48v60m12-42v24m12-18v12" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg></div>
      <h3 id="voice-state" aria-live="polite">Ready when you are</h3><p id="session-hint">Choose Start interview when you’re ready.</p>
      <div class="error-box" id="connection-error-live" role="alert" hidden><p id="connection-error-text-live"></p><button class="secondary" id="retry-interview-live" type="button">Try again</button></div>
      <div class="session-actions"><label class="mic-control" for="mic">Microphone<select id="mic" aria-label="Select microphone"><option value="">Default microphone</option></select></label><button class="danger" id="btn" type="button" disabled hidden>End interview</button></div>
    </section>
    <section class="transcript-panel" aria-label="Live conversation transcript"><div class="pane-head"><span>Conversation</span><span class="empty">Live transcript</span></div><div class="pane-body" id="transcript" aria-live="polite" aria-relevant="additions text"><div class="empty">Your conversation will appear here as you speak.</div></div></section>
  </div>
  <div class="report-actions"><button class="secondary" id="report-button" type="button">View interview report</button></div>
  <section class="side-pane" id="side" aria-label="Technical diagnostics"><div class="pane-head"><span class="tabs"><button class="ghost tab on" id="tab-events" type="button">Connection events</button><button class="ghost tab" id="tab-agent" type="button">Agent config</button></span><button class="ghost" id="log-toggle" type="button" aria-expanded="false">Show diagnostics</button></div><div class="pane-body" id="events-body"><div class="empty">Connection events will appear here.</div></div><div class="pane-body" id="agent-body" hidden><div class="empty">Loading agent configuration…</div></div></section>
</section>
</main>

<dialog id="report-dialog">

  <div class="report-dialog-head">

    <h2>
      Interview Report
    </h2>

    <div class="report-dialog-actions">

      <button
        class="report-close"
        id="report-close"
        type="button"
      >
        Close
      </button>

    </div>

  </div>

  <div
    id="report-body"
  ></div>

</dialog>

<script>
window.AGENT =
${JSON.stringify({ ...AGENT, wsUrl: voiceAgentWsUrl() }).replace(
  /</g,
  '\\u003c'
)}
</script>

<script src="/app.js"></script>

<script>
document
  .getElementById('report-close')
  .addEventListener('click', () => {
    document
      .getElementById('report-dialog')
      .close()
  })
</script>

</body>
</html>`

// -----------------------------------------------------------------------------
// Server helpers
// -----------------------------------------------------------------------------

function publicAgent(agent) {
  const copy =
    structuredClone(agent)

  for (
    const tool of copy.tools ?? []
  ) {
    for (
      const header
      of tool.http?.headers ?? []
    ) {
      header.value =
        '<hidden>'
    }
  }

  for (
    const llm of copy.llm ?? []
  ) {
    delete llm.api_key
  }

  return copy
}

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------

const server =
  http.createServer(
    async (req, res) => {

      if (
        req.url === '/agent'
      ) {
        try {
          const agent =
            await aai(
              `/agents/${AGENT.id}`
            )

          res.writeHead(
            200,
            {
              'content-type':
                'application/json',
            }
          )

          res.end(
            JSON.stringify(
              publicAgent(agent)
            )
          )
        } catch (error) {
          console.error(
            error.message
          )

          res.writeHead(
            502,
            {
              'content-type':
                'application/json',
            }
          )

          res.end(
            JSON.stringify({
              error:
                'could not load the agent',
            })
          )
        }

        return
      }

      if (
        req.url === '/token'
      ) {
        try {
          const token =
            await aai(
              '/token?product=voice_agent&expires_in_seconds=60'
            )

          res.writeHead(
            200,
            {
              'content-type':
                'application/json',
            }
          )

          res.end(
            JSON.stringify(token)
          )
        } catch (error) {
          console.error(
            error.message
          )

          res.writeHead(
            502,
            {
              'content-type':
                'application/json',
            }
          )

          res.end(
            JSON.stringify({
              error:
                'token request failed',
            })
          )
        }

        return
      }

      if (
        req.url === '/app.js'
      ) {
        res.writeHead(
          200,
          {
            'content-type':
              'text/javascript; charset=utf-8',
          }
        )

        res.end(
          '(' +
            clientApp.toString() +
            ')();'
        )

        return
      }

      // -----------------------------------------------------------------------
      // Interview state module
      // -----------------------------------------------------------------------

      if (
        req.url ===
        '/interview/state.mjs'
      ) {
        try {
          const code =
            await readFile(
              new URL(
                '../../interview/state.mjs',
                import.meta.url
              ),
              'utf8'
            )

          res.writeHead(
            200,
            {
              'content-type':
                'text/javascript; charset=utf-8',

              'cache-control':
                'no-store',
            }
          )

          res.end(code)
        } catch (error) {
          console.error(
            error.message
          )

          res.writeHead(
            404,
            {
              'content-type':
                'text/plain',
            }
          )

          res.end(
            'interview/state.mjs not found'
          )
        }

        return
      }

      // -----------------------------------------------------------------------
      // Interview controller module
      // -----------------------------------------------------------------------

      if (
        req.url ===
        '/interview/controller.mjs'
      ) {
        try {
          const code =
            await readFile(
              new URL(
                '../../interview/controller.mjs',
                import.meta.url
              ),
              'utf8'
            )

          res.writeHead(
            200,
            {
              'content-type':
                'text/javascript; charset=utf-8',

              'cache-control':
                'no-store',
            }
          )

          res.end(code)
        } catch (error) {
          console.error(
            error.message
          )

          res.writeHead(
            404,
            {
              'content-type':
                'text/plain',
            }
          )

          res.end(
            'interview/controller.mjs not found'
          )
        }

        return
      }

      // -----------------------------------------------------------------------
      // Main HTML
      // -----------------------------------------------------------------------

      res.writeHead(
        200,
        {
          'content-type':
            'text/html; charset=utf-8',
        }
      )

      res.end(HTML)
    }
  )

// -----------------------------------------------------------------------------
// Port
// -----------------------------------------------------------------------------

let port =
  Number(process.env.PORT) ||
  3000

server.on(
  'error',
  (err) => {
    if (
      err.code === 'EADDRINUSE' &&
      !process.env.PORT &&
      port < 3010
    ) {
      port += 1

      server.listen(port, '0.0.0.0')

      return
    }

    throw err
  }
)

server.on(
  'listening',
  () => {
    console.log(
      `Talk to it: http://localhost:${port}`
    )
  }
)

server.listen(port, '0.0.0.0')
