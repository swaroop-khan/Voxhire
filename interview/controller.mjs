import {
  startInterview,
  setQuestion,
  addAnswer,
  setDifficulty,
  endInterview,
  updatePerformance,
  setInsights,
} from "./state.mjs"

export function processInterviewDecision(state, decision) {
  if (!decision || typeof decision !== "object") {
    return state
  }

  if (decision.intent === "topic_selection" && decision.topic) {
    startInterview(state, decision.topic)
    return state
  }

  if (decision.intent === "answer") {
    if (decision.answer) {
      const evaluation = {
        assessment: decision.assessment ?? null,
        technicalKnowledge: decision.technicalKnowledge ?? null,
        reasoning: decision.reasoning ?? null,
        problemSolving: decision.problemSolving ?? null,
        communication: decision.communication ?? null,
        feedback: decision.feedback ?? null,
      }

      addAnswer(state, decision.answer, evaluation)
      updatePerformance(state)
    }

    if (decision.difficulty_action === "increase") {
      setDifficulty(state, state.difficulty + 1)
    }

    if (decision.difficulty_action === "decrease") {
      setDifficulty(state, state.difficulty - 1)
    }

    return state
  }

  if (decision.intent === "topic_change" && decision.topic) {
    state.topic = decision.topic
    return state
  }

  if (decision.intent === "end") {
    endInterview(state)
    return state
  }

  return state
}

export function recordQuestion(state, question) {
  setQuestion(state, question)
  return state
}

export function updateInterviewInsights(state, insights) {
  setInsights(state, insights)
  return state
}