export function generateInterviewReport(state) {
  const scores = Object.values(state.performance).filter(
    (score) => typeof score === "number"
  )

  const overallScore =
    scores.length > 0
      ? Number(
          (
            scores.reduce((sum, score) => sum + score, 0) /
            scores.length
          ).toFixed(1)
        )
      : null

  return {
    topic: state.topic,
    questionCount: state.questionCount,
    overallScore,

    performance: {
      technicalKnowledge: state.performance.technicalKnowledge,
      reasoning: state.performance.reasoning,
      problemSolving: state.performance.problemSolving,
      communication: state.performance.communication,
    },

    insights: {
      strengths: state.insights.strengths,
      weaknesses: state.insights.weaknesses,
      knowledgeGaps: state.insights.knowledgeGaps,
      recommendations: state.insights.recommendations,
    },

    answers: state.answers,
  }
}