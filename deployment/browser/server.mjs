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

  $('btn').onclick = () =>
    ws?.readyState <= 1
      ? stop()
      : start()

  $('report-button').onclick =
    showInterviewReport

  $('log-toggle').onclick = () => {
    const hidden =
      document.body.classList.toggle(
        'no-side'
      )

    $('log-toggle').textContent =
      hidden ? 'Show' : 'Hide'
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
        'Difficulty',
        String(state.difficulty || 1),
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
    $('btn').disabled = true
    $('mic').disabled = true

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
        setStatus(
          'error',
          'could not mint a token, check the API key'
        )

        reset()
        return
      }

      const { token } =
        await res.json()

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
          'wss://agents.assemblyai.com/v1/ws'
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
              agent_id: AGENT.id,
            },
          })
        )

        logEvent(
          'up',
          'session.update',
          AGENT.id
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

            $('btn').disabled =
              false

            $('btn').textContent =
              'End call'

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
            setStatus(
              'error',
              msg.message ||
                'AssemblyAI session error'
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

      ws.onclose = () => {
        setStatus('idle')
        reset()

        // Do NOT reset interviewState here.
        // The report must remain available after the call ends.
      }

      ws.onerror = () => {
        setStatus(
          'error',
          'connection failed'
        )

        reset()
      }
    } catch (error) {
      setStatus(
        'error',
        error.message
      )

      reset()
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
      ws.send(
        JSON.stringify({
          type: 'session.end',
        })
      )

      logEvent(
        'up',
        'session.end'
      )

      const socket = ws

      setTimeout(() => {
        if (
          socket.readyState === 1
        ) {
          socket.close()
        }
      }, 3000)
    } else {
      ws?.close()
    }

    playback?.port.postMessage(
      'stop'
    )

    mic
      ?.getTracks()
      .forEach((track) =>
        track.stop()
      )

    captureCtx?.close()
    playbackCtx?.close()

    captureCtx =
      playbackCtx =
      playback =
      mic =
        null

    reset()
    setStatus('idle')
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

    $('btn').disabled = false
    $('mic').disabled = false

    $('btn').textContent =
      'Start call'

    $('btn').classList.remove(
      'live'
    )
  }

  function setStatus(
    state,
    detail
  ) {
    $('status').className =
      'status ' + state

    $('status-text').textContent =
      detail || state
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
    --page-bg: #fdfcf8;
    --surface: #fff;
    --surface-alt: #f5f3eb;
    --border: #dad7cb;
    --text: #4a4945;
    --text-dark: #1d1b16;
    --text-muted: #777673;
    --text-faint: #a5a4a2;
    --purple: #3923c7;
    --green: #01762f;
    --error: #f04438;
    --radius: 12px;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html,
  body {
    height: 100%;
  }

  body {
    font-family:
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;

    font-size: 16px;
    line-height: 1.3;

    color: var(--text);
    background: var(--page-bg);

    display: flex;
    flex-direction: column;
    align-items: center;

    padding: 24px 20px 20px;
  }

  main {
    width: 100%;
    max-width: 1088px;

    flex: 1;

    display: flex;
    flex-direction: column;

    min-height: 0;
    gap: 16px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 16px;

    padding-bottom: 16px;

    border-bottom:
      1px solid var(--border);
  }

  h1 {
    font-family: Georgia, serif;
    font-size: 28px;
    font-weight: 400;

    color: var(--text-dark);

    margin-right: auto;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;

    color: var(--text-muted);
  }

  .status::before {
    content: "";

    width: 7px;
    height: 7px;

    border-radius: 50%;

    background:
      currentColor;
  }

  .status.listening {
    color: var(--green);
  }

  .status.speaking {
    color: var(--purple);
  }

  .status.error {
    color: var(--error);
    font-size: 14px;
  }

  .meter {
    display: flex;
    gap: 10px;

    font-family: monospace;
    font-size: 12px;

    color: var(--text-faint);
  }

  #elapsed {
    min-width: 34px;
    text-align: right;
  }

  #cost {
    min-width: 48px;
    text-align: right;
  }

  .panes {
    flex: 1 1 0;
    min-height: 0;

    display: grid;

    grid-template-columns:
      minmax(0, 1fr)
      360px;

    gap: 16px;
  }

  .main-column {
    min-width: 0;
    min-height: 0;

    display: flex;
    flex-direction: column;
  }

  body.no-side .panes {
    grid-template-columns: 1fr;
  }

  body.no-side #side {
    display: none;
  }

  .pane {
    display: flex;
    flex-direction: column;

    min-height: 0;

    background:
      var(--surface);

    border:
      1px solid var(--border);

    border-radius:
      var(--radius);

    overflow: hidden;
  }

  .main-column > .pane {
    flex: 1 1 auto;
  }

  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;

    gap: 16px;

    padding: 10px 16px;

    background:
      var(--surface-alt);

    border-bottom:
      1px solid var(--border);

    color:
      var(--text-muted);
  }

  .pane-body {
    flex: 1;

    min-height: 0;

    overflow-y: auto;

    padding: 16px;
  }

  .empty {
    color:
      var(--text-faint);

    font-size: 14px;
  }

  #transcript {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .line {
    display: flex;
    gap: 12px;

    font-size: 16px;
    line-height: 1.4;
  }

  .who {
    width: 88px;
    flex-shrink: 0;

    color:
      var(--text-faint);

    padding-top: 3px;

    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .line.agent .said {
    color:
      var(--text-dark);
  }

  .line.partial .said {
    color:
      var(--text-muted);
  }

  .line.tool {
    font-family: monospace;
    font-size: 13px;

    color:
      var(--purple);
  }

  .line.tool .said {
    word-break: break-all;
  }

  .pane-foot {
    display: flex;
    gap: 8px;

    align-items: center;

    padding: 12px 16px;

    background:
      var(--surface-alt);

    border-top:
      1px solid var(--border);
  }

  button {
    height: 40px;

    padding: 0 24px;

    margin-left: auto;

    border: none;
    border-radius: 4px;

    background:
      var(--purple);

    color: white;

    font-family: monospace;
    font-size: 14px;

    letter-spacing: 1.2px;
    text-transform: uppercase;

    cursor: pointer;
  }

  button:hover:not(:disabled) {
    opacity: .85;
  }

  button:disabled {
    opacity: .55;
    cursor: default;
  }

  button.live {
    background:
      var(--error);
  }

  select {
    flex: 0 1 220px;
    min-width: 0;

    height: 40px;

    padding: 0 8px;

    font-family: inherit;
    font-size: 13px;

    color:
      var(--text-muted);

    background:
      var(--surface);

    border:
      1px solid var(--border);

    border-radius: 4px;
  }

  .report-actions {
    flex: 0 0 auto;

    display: flex;
    justify-content: flex-end;

    padding:
      14px 0 0;
  }

  #report-button {
    margin-left: 0;
  }

  #side {
    min-height: 0;
  }

  #events-body {
    font-family: monospace;
    font-size: 12px;
    line-height: 1.8;
  }

  .event {
    display: flex;
    gap: 8px;

    align-items: baseline;

    white-space: nowrap;
  }

  .event .at {
    color:
      var(--text-faint);

    min-width: 44px;

    text-align: right;
  }

  .event .dir,
  .event .count {
    color:
      var(--text-faint);
  }

  .event .count:empty,
  .event .detail:empty {
    display: none;
  }

  .event .type {
    color:
      var(--text-dark);
  }

  .event.up .type {
    color:
      var(--text-muted);
  }

  .event .detail {
    color:
      var(--text-faint);

    overflow: hidden;

    white-space: nowrap;

    text-overflow: ellipsis;
  }

  .ghost {
    height: auto;

    margin-left: 0;

    padding: 0;

    background:
      transparent;

    color:
      var(--text-faint);

    font-size: 12px;
  }

  .ghost:hover:not(:disabled) {
    background:
      transparent;

    color:
      var(--purple);
  }

  .tabs {
    display: flex;
    gap: 16px;
  }

  .tab.on {
    color:
      var(--text-dark);
  }

  #agent-body pre {
    font-family: monospace;
    font-size: 12px;
    line-height: 1.6;

    white-space: pre-wrap;
    word-break: break-word;
  }

  #report-dialog {
    width:
      min(900px, calc(100vw - 32px));

    max-height:
      calc(100vh - 48px);

    padding: 0;

    border:
      1px solid var(--border);

    border-radius:
      var(--radius);

    background:
      var(--surface);

    color:
      var(--text);

    box-shadow:
      0 24px 80px
      rgba(29, 27, 22, .22);

    overflow: hidden;
  }

  #report-dialog::backdrop {
    background:
      rgba(29, 27, 22, .42);
  }

  .report-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;

    gap: 16px;

    padding:
      18px 22px;

    background:
      var(--surface-alt);

    border-bottom:
      1px solid var(--border);
  }

  .report-dialog-head h2 {
    font-family: Georgia, serif;
    font-size: 24px;
    font-weight: 400;

    color:
      var(--text-dark);
  }

  .report-dialog-actions {
    display: flex;
    gap: 8px;
  }

  .report-dialog-actions button {
    margin-left: 0;
  }

  .report-close {
    background:
      var(--surface);

    color:
      var(--text-muted);

    border:
      1px solid var(--border);
  }

  #report-body {
    max-height:
      calc(100vh - 145px);

    overflow-y: auto;

    padding: 22px;
  }

  .report-overview {
    display: grid;

    grid-template-columns:
      repeat(4, minmax(0, 1fr));

    gap: 10px;

    margin-bottom: 22px;
  }

  .report-overview-item {
    display: flex;
    flex-direction: column;

    gap: 4px;

    padding: 14px;

    border:
      1px solid var(--border);

    border-radius: 8px;

    background:
      var(--surface-alt);
  }

  .report-meta-label {
    color:
      var(--text-faint);

    font-family: monospace;
    font-size: 11px;

    text-transform: uppercase;
    letter-spacing: .8px;
  }

  .report-overview-item strong {
    color:
      var(--text-dark);

    font-size: 15px;
  }

  .report-section {
    margin-top: 22px;
  }

  .report-section h3 {
    margin-bottom: 12px;

    color:
      var(--text-dark);

    font-size: 18px;
    font-weight: 500;
  }

  .report-score {
    margin-bottom: 12px;
  }

  .report-score-top {
    display: flex;
    justify-content: space-between;

    gap: 12px;

    margin-bottom: 6px;

    font-size: 14px;
  }

  .report-score-top strong {
    color:
      var(--text-dark);
  }

  .report-score-track {
    width: 100%;
    height: 8px;

    overflow: hidden;

    border-radius: 99px;

    background:
      var(--surface-alt);

    border:
      1px solid var(--border);
  }

  .report-score-fill {
    height: 100%;

    border-radius: inherit;

    background:
      var(--purple);

    transition:
      width .2s ease;
  }

  .report-insight-grid {
    display: grid;

    grid-template-columns:
      repeat(2, minmax(0, 1fr));

    gap: 14px;
  }

  .report-insight-group {
    padding: 14px;

    border:
      1px solid var(--border);

    border-radius: 8px;

    background:
      var(--surface);
  }

  .report-insight-group h4 {
    margin-bottom: 8px;

    color:
      var(--text-dark);

    font-size: 14px;
    font-weight: 600;
  }

  .report-list {
    padding-left: 18px;

    color:
      var(--text-muted);

    font-size: 14px;
  }

  .report-list li + li {
    margin-top: 5px;
  }

  .report-empty {
    list-style: none;

    margin-left: -18px;

    color:
      var(--text-faint);
  }

  .report-empty-large {
    color:
      var(--text-faint);

    font-size: 14px;
  }

  .report-answers {
    display: flex;
    flex-direction: column;

    gap: 14px;
  }

  .report-answer {
    padding: 16px;

    border:
      1px solid var(--border);

    border-radius: 8px;

    background:
      var(--surface);
  }

  .report-answer h4 {
    margin-bottom: 12px;

    color:
      var(--text-dark);

    font-size: 15px;
  }

  .report-answer-block {
    margin-top: 10px;
  }

  .report-answer-label {
    display: block;

    margin-bottom: 4px;

    color:
      var(--text-faint);

    font-family: monospace;
    font-size: 11px;

    text-transform: uppercase;
    letter-spacing: .7px;
  }

  .report-answer-block p {
    color:
      var(--text);

    font-size: 14px;

    white-space: pre-wrap;
    word-break: break-word;
  }

  .report-evaluation {
    margin-top: 14px;

    padding-top: 12px;

    border-top:
      1px solid var(--border);
  }

  .report-evaluation-item {
    display: flex;
    justify-content: space-between;

    gap: 16px;

    padding: 5px 0;

    font-size: 13px;
  }

  .report-evaluation-item span {
    color:
      var(--text-muted);
  }

  .report-evaluation-item strong {
    color:
      var(--text-dark);
  }

  [hidden] {
    display: none !important;
  }

  @media (max-width: 880px) {
    .panes {
      grid-template-columns: 1fr;

      grid-template-rows:
        minmax(420px, 1fr)
        176px;
    }

    body.no-side .panes {
      grid-template-rows:
        minmax(420px, 1fr);
    }

    .report-overview {
      grid-template-columns:
        repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 600px) {
    body {
      padding:
        16px 12px;
    }

    header {
      flex-wrap: wrap;
    }

    h1 {
      width: 100%;
      margin-right: 0;
    }

    .report-actions {
      justify-content: stretch;
    }

    #report-button {
      width: 100%;
    }

    .report-overview,
    .report-insight-grid {
      grid-template-columns: 1fr;
    }

    #report-dialog {
      width:
        calc(100vw - 20px);

      max-height:
        calc(100vh - 20px);
    }

    #report-body {
      max-height:
        calc(100vh - 120px);

      padding: 16px;
    }
  }

</style>

</head>

<body>

<main>

<header>

  <h1>
    VoxHire Interviewer
  </h1>

  <span
    class="status idle"
    id="status"
  >
    <span id="status-text">
      idle
    </span>
  </span>

  <span class="meter">
    <span id="elapsed">
      0:00
    </span>

    <span id="cost">
      $0.000
    </span>
  </span>

</header>

<div class="panes">

  <div class="main-column">

    <section class="pane">

      <div class="pane-head">
        <span>
          Transcript
        </span>
      </div>

      <div
        class="pane-body"
        id="transcript"
      >
        <div class="empty">
          Start the call and talk.
          Partial transcripts appear
          as they stream.
        </div>
      </div>

      <div class="pane-foot">

        <select
          id="mic"
          aria-label="Microphone"
        >
          <option value="">
            Default microphone
          </option>
        </select>

        <button id="btn">
          Start call
        </button>

      </div>

    </section>

    <div class="report-actions">

      <button
        id="report-button"
        type="button"
      >
        View Interview Report
      </button>

    </div>

  </div>

  <section
    class="pane"
    id="side"
  >

    <div class="pane-head">

      <span class="tabs">

        <button
          class="ghost tab on"
          id="tab-events"
          type="button"
        >
          Events
        </button>

        <button
          class="ghost tab"
          id="tab-agent"
          type="button"
        >
          Agent
        </button>

      </span>

      <button
        class="ghost"
        id="log-toggle"
        type="button"
      >
        Hide
      </button>

    </div>

    <div
      class="pane-body"
      id="events-body"
    >
      <div class="empty">
        WebSocket events will appear here.
      </div>
    </div>

    <div
      class="pane-body"
      id="agent-body"
      hidden
    >
      <div class="empty">
        Loading the published agent.
      </div>
    </div>

  </section>

</div>

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
${JSON.stringify(AGENT).replace(
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

      server.listen(port)

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

server.listen(port)