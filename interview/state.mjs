export function createInterviewState() {
  return {
    topic: null,
    currentQuestion: null,
    difficulty: 1,
    questionCount: 0,
    answers: [],
    performance: {
      technicalKnowledge: null,
      reasoning: null,
      problemSolving: null,
      communication: null,
    },
    insights: {
      strengths: [],
      weaknesses: [],
      knowledgeGaps: [],
      recommendations: [],
    },
    status: "not_started",
  }
}

export function startInterview(state, topic) {
  state.topic = topic
  state.currentQuestion = null
  state.difficulty = 1
  state.questionCount = 0
  state.answers = []
  state.performance = {
  technicalKnowledge: null,
  reasoning: null,
  problemSolving: null,
  communication: null,
}

state.insights = {
  strengths: [],
  weaknesses: [],
  knowledgeGaps: [],
  recommendations: [],
}
  state.status = "interviewing"

  return state
}

export function setQuestion(state, question) {
  state.currentQuestion = question
  state.questionCount += 1

  return state
}

export function addAnswer(state, answer, evaluation = null) {
  state.answers.push({
    question: state.currentQuestion,
    answer,
    evaluation,
  })

  return state
}

export function setDifficulty(state, difficulty) {
  state.difficulty = Math.max(1, Math.min(5, difficulty))

  return state
}

export function endInterview(state) {
  state.status = "completed"

  return state
}

export function resetInterview(state) {
  Object.assign(state, createInterviewState())

  return state
}
export function updatePerformance(state) {
  const dimensions = [
    'technicalKnowledge',
    'reasoning',
    'problemSolving',
    'communication',
  ]

  for (const dimension of dimensions) {
    const scores = state.answers
      .map((answer) => answer.evaluation?.[dimension])
      .filter(
        (score) =>
          typeof score === 'number' &&
          Number.isFinite(score) &&
          score >= 0 &&
          score <= 10
      )

    if (scores.length === 0) {
      state.performance[dimension] = null
      continue
    }

    const average =
      scores.reduce((sum, score) => sum + score, 0) /
      scores.length

    state.performance[dimension] =
      Math.round(average * 10) / 10
  }

  return state
}
export function setInsights(state, insights) {
  state.insights = {
    strengths: insights?.strengths ?? [],
    weaknesses: insights?.weaknesses ?? [],
    knowledgeGaps: insights?.knowledgeGaps ?? [],
    recommendations: insights?.recommendations ?? [],
  }

  return state
}